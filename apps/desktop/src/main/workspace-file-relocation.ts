import {
  preparePrimerFileMove,
  rewritePreparedPrimerMove,
  finishPrimerFileMoveInTx,
  releasePrimerMove,
} from './primer-file-move-intent';
import {
  assertEnrolledPrimerPathMutationAllowed,
  assertEnrolledPrimerRelocationAllowed,
} from './primer-artifact-mutation-guard';
import { randomUUID } from 'node:crypto';
import { withUserMessage } from '@waypoint/user-messages';
import { ScientificObjectStore } from './scientific-object-store';
import { submitScientificWorkspace } from './scientific-workspace-service';
import type Database from 'better-sqlite3';
import type { NativeDocumentDispatcher } from './native-document-dispatcher';

import { cp, lstat, rename, rm } from 'fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'path';
import { withSafeWritablePaths } from './ipc/path-allowlist';
import {
  detectCatalogRelocationConflict,
  relocateWorkspaceFileRefsInDb,
} from './workspace-relocate';
import type {
  RelocateEntityFileInput,
  RelocateEntityFileResult,
} from '../shared/workspace-relocate-types';
import { relocateLimsEntityFileRefsInDb } from './lims-engine-core';
import { materializeLimsGitExportForWorkspaceIds } from './lims-export-sync';
import {
  restorePrimerArtifactBytes,
  rewriteAffectedPrimerArtifacts,
} from './relocate-primer-artifacts';
import { pathIsAtOrUnder } from '../shared/path-boundary';
import { createKeyedMutex } from './workspace-git/keyed-mutex';
import {
  withDeclaredWorkspaceMutation,
  withKnownWorkspacePathMutation,
  findKnownWorkspaceRoot,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';
import { withDeclaredRendererWorkspaceMutation } from './ipc/workspace-mutation-authority';
import { assertWorkspaceMigrationActionsSettled } from './workspace-migration-admission';
import { recoverNativeCatalogRecordPublications } from './native-catalog-record-mutations';
import { assertRendererDatabaseStatementAllowed } from './workspace-sync-database-fence';
import {
  beginNativeWorkspaceManifestMove,
  completeNativeWorkspaceManifestMove,
  prepareNativeWorkspaceDirectFileMove,
  restoreNativeWorkspaceManifestMove,
  writeMovedNativeWorkspaceManifest,
  type PreparedNativeWorkspaceManifestMove,
} from './native-workspace-manifest-mutations';

const relocateMutex = createKeyedMutex();

export function createWorkspaceFileRelocator(options: {
  db(): Database.Database;
  fileDocuments(): Pick<NativeDocumentDispatcher, 'withCleanPaths' | 'assertClean' | 'relocate'>;
}) {
  const getDb = options.db;

  async function withRelocationAuthority(
    input: RelocateEntityFileInput,
    rendererOwnerId: number | undefined,
    operation: (resolvedInput: RelocateEntityFileInput) => Promise<RelocateEntityFileResult>
  ): Promise<RelocateEntityFileResult> {
    const db = getDb();
    assertRendererDatabaseStatementAllowed(db, rendererOwnerId);
    if (db.inTransaction) throw new Error('Relocation cannot enter an open database transaction.');
    const fileDocuments = options.fileDocuments();
    if (input.mutationToken && !input.workspaceRoot)
      throw new Error('WORKSPACE_MUTATION_TOKEN_REQUIRES_WORKSPACE');
    if (input.mutationToken && rendererOwnerId === undefined)
      throw new Error('WORKSPACE_MUTATION_TOKEN_REQUIRES_RENDERER');
    const owner = findKnownWorkspaceRoot(db, input.workspaceRoot ?? input.oldPath);
    const rows = (
      db
        .prepare('SELECT path FROM workspaces WHERE archived_at IS NULL AND trashed_at IS NULL')
        .all() as Array<{ path: string }>
    ).filter((row) => workspaceMutationRootIdentity(row.path) === owner);
    if (rows.length > 1)
      throw new Error(
        'RELOCATE_AMBIGUOUS_WORKSPACE: multiple rows own the same physical workspace.'
      );
    if (input.workspaceRoot && !owner) throw new Error('WORKSPACE_MUTATION_UNKNOWN_WORKSPACE');
    const root = rows[0]?.path ?? null;
    const toStoredPath = (path: string) => {
      if (!root || !owner) return path;
      const physical = workspaceMutationRootIdentity(path);
      if (!pathIsAtOrUnder(physical, owner))
        throw new Error('WORKSPACE_MUTATION_DECLARED_ROOT_MISMATCH');
      const stored = join(root, relative(owner, physical));
      if (workspaceMutationRootIdentity(stored) !== physical)
        throw new Error('RELOCATE_WORKSPACE_ALIAS_CHANGED');
      return stored;
    };
    const resolvedInput = {
      ...input,
      workspaceRoot: root,
      oldPath: toStoredPath(input.oldPath),
      newPath: toStoredPath(input.newPath),
    };
    const paths = [resolvedInput.oldPath, resolvedInput.newPath];

    if (root && resolvedInput.oldPath !== resolvedInput.newPath) {
      const workspace = db.prepare('SELECT id FROM workspaces WHERE path = ?').get(root) as {
        id: number;
      };
      const accepted = new ScientificObjectStore(db, workspace.id).catalog();
      const sourcePath = relative(root, resolvedInput.oldPath).split('\\').join('/');
      const destinationPath = relative(root, resolvedInput.newPath).split('\\').join('/');
      if (
        accepted.head &&
        accepted.entries.some(
          (slot) =>
            !slot.tombstone &&
            slot.path &&
            (slot.path === sourcePath || slot.path.startsWith(`${sourcePath}/`))
        )
      ) {
        return relocateMutex(owner ?? '', () =>
          fileDocuments.withCleanPaths(paths, async () => {
            assertRelocationPathSpellings(db, resolvedInput);
            await fileDocuments.assertClean(resolvedInput.oldPath);
            await fileDocuments.assertClean(resolvedInput.newPath);
            let counts: RelocateEntityFileResult['counts'] | undefined;
            const result = await submitScientificWorkspace({
              db,
              workspaceId: workspace.id,
              request: {
                operationId: `scientific-relocate:${randomUUID()}`,
                expectedHead: accepted.head,
                source: { kind: 'relocate', sourcePath, destinationPath },
              },
              ...(rendererOwnerId === undefined
                ? {}
                : {
                    renderer: {
                      ownerId: rendererOwnerId,
                      ...(input.mutationToken ? { mutationToken: input.mutationToken } : {}),
                    },
                  }),
              publication: {
                mutations: [],
                blobs: [],
                onAcceptedInsideTx: () => {
                  counts = relocateWorkspaceFileRefsInDb(db, {
                    workspaceRoot: root,
                    oldPath: resolvedInput.oldPath,
                    newPath: resolvedInput.newPath,
                    actor: input.actor,
                  });
                  return undefined;
                },
              },
            });
            if (result.acceptance.kind !== 'changed' && result.acceptance.kind !== 'no-op')
              throw new Error(`Scientific relocation was not accepted: ${result.acceptance.kind}`);
            if (result.delivery?.kind !== 'complete')
              throw new Error(
                `Move accepted; file delivery remains pending: ${result.delivery?.kind === 'blocked' ? result.delivery.error : 'delivery unavailable'}`
              );
            if (!counts) throw new Error('Accepted relocation has no native reference projection.');
            try {
              await fileDocuments.relocate(resolvedInput.oldPath, resolvedInput.newPath);
              return { newPath: resolvedInput.newPath, counts };
            } catch (error) {
              return {
                newPath: resolvedInput.newPath,
                counts,
                warnings: [
                  `The file moved, but its document binding needs recovery: ${errorMessage(error)}`,
                ],
              };
            }
          })
        );
      }
    }

    const locked = () =>
      relocateMutex(owner ?? '', () =>
        fileDocuments.withCleanPaths(paths, async () => {
          assertRelocationPathSpellings(db, resolvedInput);
          await fileDocuments.assertClean(resolvedInput.oldPath);
          await fileDocuments.assertClean(resolvedInput.newPath);
          const result = await operation(resolvedInput);
          try {
            await fileDocuments.relocate(resolvedInput.oldPath, result.newPath);
          } catch (error) {
            return {
              ...result,
              warnings: [
                ...(result.warnings ?? []),
                `The file moved, but its document binding needs recovery: ${error instanceof Error ? error.message : String(error)}`,
              ],
            };
          }
          return result;
        })
      );
    if (root && rendererOwnerId !== undefined) {
      return withDeclaredRendererWorkspaceMutation({
        fileWrite: true,
        db,
        ownerId: rendererOwnerId,
        workspaceRoot: root,
        mutationPaths: paths,
        mutationToken: input.mutationToken,
        operation: locked,
      });
    }
    const recoverThenMove = async () => {
      if (root) {
        await assertWorkspaceMigrationActionsSettled(root);
        await recoverNativeCatalogRecordPublications({
          db,
          workspacePath: root,
          runDatabase: (run) => {
            assertRendererDatabaseStatementAllowed(db, rendererOwnerId);
            return run();
          },
        });
      }
      return locked();
    };
    return root
      ? withDeclaredWorkspaceMutation(db, root, paths, recoverThenMove)
      : withKnownWorkspacePathMutation(db, paths, recoverThenMove);
  }

  function assertRelocationPathSpellings(
    db: ReturnType<typeof getDb>,
    input: RelocateEntityFileInput
  ): void {
    if (!input.workspaceRoot) return;
    const root = workspaceMutationRootIdentity(input.workspaceRoot);
    const oldPhysical = workspaceMutationRootIdentity(input.oldPath);
    const newPhysical = workspaceMutationRootIdentity(input.newPath);
    const refs = db
      .prepare(
        `
    SELECT path FROM catalog_entity_files
    UNION SELECT path FROM indexed_files
    UNION SELECT substr(locator,8) AS path FROM catalog_entities WHERE locator LIKE 'file://%'
    UNION SELECT json_extract(fields,'$.sequence.relPath') AS path FROM lims_entity
      WHERE json_valid(fields) AND json_extract(fields,'$.sequence.mode')='file'
  `
      )
      .all() as Array<{ path: unknown }>;
    for (const ref of refs) {
      if (typeof ref.path !== 'string' || !isAbsolute(ref.path)) continue;
      const physical = workspaceMutationRootIdentity(ref.path);
      if (!pathIsAtOrUnder(physical, oldPhysical) && !pathIsAtOrUnder(physical, newPhysical))
        continue;
      const expected = join(input.workspaceRoot, relative(root, physical));
      if (resolve(ref.path) !== resolve(expected))
        throw new Error(
          'RELOCATE_MIXED_PATH_ALIASES: affected file references use different workspace paths; no files were moved.'
        );
    }
  }

  async function moveFile(src: string, dest: string): Promise<void> {
    try {
      await rename(src, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw err;
      }
      await cp(src, dest, { recursive: true, force: false, errorOnExist: true });
      await rm(src, { recursive: true, force: true });
    }
  }

  async function pathExists(p: string): Promise<boolean> {
    try {
      await lstat(p);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  function assertLimsRelocationOwnerUnique(input: RelocateEntityFileInput): void {
    const db = getDb();
    const ROLLBACK = new Error('__lims_relocate_preflight_rollback__');
    try {
      db.transaction(() => {
        relocateLimsEntityFileRefsInDb(db, {
          workspaceRoot: input.workspaceRoot ?? '',
          oldPath: input.oldPath,
          newPath: input.newPath,
          actor: input.actor,
        });
        throw ROLLBACK;
      })();
    } catch (err) {
      if (err !== ROLLBACK) {
        throw err;
      }
    }
  }

  async function relocateEntityFile(
    input: RelocateEntityFileInput,
    rendererOwnerId?: number
  ): Promise<RelocateEntityFileResult> {
    const requests = [
      { path: input.oldPath },
      { path: input.newPath },
      ...(input.workspaceRoot ? [{ path: input.workspaceRoot }] : []),
    ];
    return withSafeWritablePaths(requests, ([oldPath, newPath, canonicalWorkspaceRoot]) => {
      const canonicalInput: RelocateEntityFileInput = {
        ...input,
        oldPath,
        newPath,
        workspaceRoot: input.workspaceRoot ? canonicalWorkspaceRoot : null,
      };
      if (
        canonicalInput.workspaceRoot &&
        canonicalInput.oldPath !== canonicalInput.newPath &&
        !pathIsAtOrUnder(canonicalInput.newPath, canonicalInput.workspaceRoot)
      ) {
        throw new Error(
          `RELOCATE_CROSS_WORKSPACE: "${canonicalInput.newPath}" is outside its workspace ("${canonicalInput.workspaceRoot}"). ` +
            `Moving a registry file to a different workspace isn't supported yet.`
        );
      }

      return withRelocationAuthority(canonicalInput, rendererOwnerId, relocateEntityFileLocked);
    });
  }

  async function relocateEntityFileLocked(
    input: RelocateEntityFileInput
  ): Promise<RelocateEntityFileResult> {
    const { oldPath, newPath, workspaceRoot } = input;

    if (oldPath === newPath) {
      return {
        newPath,
        counts: {
          catalog: { updated: 0 },
          indexed: { indexedFilesMoved: 0, staleIndexedFilesMerged: 0, primerBindingsRepointed: 0 },
          lims: { rebasedEntityIds: [], workspaceIds: [] },
        },
      };
    }

    if (workspaceRoot && !pathIsAtOrUnder(newPath, workspaceRoot)) {
      throw new Error(
        `RELOCATE_CROSS_WORKSPACE: "${newPath}" is outside its workspace ("${workspaceRoot}"). ` +
          `Moving a registry file to a different workspace isn't supported yet.`
      );
    }

    if (!(await pathExists(oldPath))) {
      throw new Error(`RELOCATE_SOURCE_MISSING: nothing to move at "${oldPath}"`);
    }
    if (await pathExists(newPath)) {
      throw withUserMessage(
        new Error(
          `MOVE_EXISTS: an item named "${basename(newPath)}" already exists at the destination`
        ),
        'file.moveDestinationExists'
      );
    }

    const db = getDb();
    const catalogConflict = detectCatalogRelocationConflict(db, oldPath, newPath);
    if (catalogConflict) {
      throw new Error(
        `RELOCATE_CATALOG_CONFLICT: another registry file already occupies "${catalogConflict}"`
      );
    }

    assertLimsRelocationOwnerUnique(input);
    assertEnrolledPrimerRelocationAllowed(getDb(), input);

    const nativeManifestMove = workspaceRoot
      ? await prepareNativeWorkspaceDirectFileMove({
          db,
          workspaceRoot,
          oldPath,
          newPath,
        })
      : null;
    assertEnrolledPrimerRelocationAllowed(getDb(), input);
    if (nativeManifestMove) await beginNativeWorkspaceManifestMove(nativeManifestMove);
    const primerMove =
      workspaceRoot && !nativeManifestMove
        ? await preparePrimerFileMove(db, { workspaceRoot, oldPath, newPath, actor: input.actor })
        : null;
    try {
      try {
        await moveFile(oldPath, newPath);
      } catch (error) {
        if (nativeManifestMove) await completeNativeWorkspaceManifestMove(nativeManifestMove);
        throw error;
      }

      let primerRewrite: ReturnType<typeof rewriteAffectedPrimerArtifacts> | null = null;
      let manifestWritten = false;
      let counts: RelocateEntityFileResult['counts'];
      try {
        if (workspaceRoot) {
          primerRewrite = primerMove
            ? rewritePreparedPrimerMove(db, primerMove, {
                workspaceRoot,
                oldPath,
                newPath,
                actor: input.actor,
              })
            : rewriteAffectedPrimerArtifacts({
                db,
                workspaceRoot,
                oldAbs: oldPath,
                newAbs: newPath,
                assertWritable: (path) => assertEnrolledPrimerPathMutationAllowed(getDb(), [path]),
              });

          if (primerRewrite.failedPaths.length > 0) {
            throw new Error(
              `RELOCATE_PRIMER_WRITE_FAILED: ${primerRewrite.failedPaths.length} primer artifact(s) could ` +
                `not be rewritten (e.g. "${primerRewrite.failedPaths[0]}"); relocation aborted to avoid a stale reference.`
            );
          }
        }

        if (nativeManifestMove) {
          await writeMovedNativeWorkspaceManifest(nativeManifestMove);
          manifestWritten = true;
        }

        counts = db.transaction(() => {
          const result = relocateWorkspaceFileRefsInDb(db, {
            workspaceRoot,
            oldPath,
            newPath,
            actor: input.actor,
            savedPrimers: primerRewrite?.saved,
          });
          finishPrimerFileMoveInTx(db, primerMove);
          return result;
        })();
      } catch (err) {
        const failedPrimerRestores = primerRewrite
          ? restorePrimerArtifactBytes(primerRewrite.originalBytes, primerRewrite.writtenHashes)
          : [];
        let manifestRestoreError: unknown = null;
        if (nativeManifestMove && manifestWritten) {
          try {
            await restoreNativeWorkspaceManifestMove(nativeManifestMove);
          } catch (error) {
            manifestRestoreError = error;
          }
        }
        try {
          if (await pathExists(oldPath))
            throw new Error('The original location now has another occupant.');
          await moveFile(newPath, oldPath);
        } catch (reverseErr) {
          throw new Error(
            `RELOCATE_SPLIT_STATE: the reference update failed (${(err as Error).message}) AND the file ` +
              `could not be moved back from "${newPath}" to "${oldPath}" (${(reverseErr as Error).message}). ` +
              `The file is at the new path but its registry references were not updated — move it back manually.`
          );
        }
        if (nativeManifestMove && manifestRestoreError === null) {
          await completeNativeWorkspaceManifestMove(nativeManifestMove);
        }
        if (manifestRestoreError && nativeManifestMove) {
          throw nativeManifestSplitStateError(nativeManifestMove, err, manifestRestoreError);
        }
        if (failedPrimerRestores.length)
          throw new Error(
            `RELOCATE_PRIMER_RESTORE_FAILED: ${failedPrimerRestores.length} file(s) changed or could not be restored. Retained source versions were preserved. ${errorMessage(err)}`
          );
        throw err;
      }
      return finishCommittedMove(db, newPath, counts, nativeManifestMove);
    } finally {
      releasePrimerMove(primerMove);
    }
  }

  async function finishCommittedMove(
    db: Database.Database,
    newPath: string,
    counts: RelocateEntityFileResult['counts'],
    nativeManifestMove: PreparedNativeWorkspaceManifestMove | null
  ): Promise<RelocateEntityFileResult> {
    materializeLimsGitExportForWorkspaceIds(db, counts.lims.workspaceIds);
    if (nativeManifestMove) {
      try {
        await completeNativeWorkspaceManifestMove(nativeManifestMove);
      } catch (error) {
        return {
          newPath,
          counts,
          warnings: [
            `The move completed, but its recovery journal could not be cleared: ${errorMessage(error)}`,
          ],
        };
      }
    }
    return { newPath, counts };
  }

  function nativeManifestSplitStateError(
    move: PreparedNativeWorkspaceManifestMove,
    operationError: unknown,
    restoreError: unknown
  ): Error {
    return new Error(
      `NATIVE_MANIFEST_MOVE_RECOVERY_REQUIRED: relocation failed (${errorMessage(operationError)}) and ` +
        `the portable manifest could not be restored (${errorMessage(restoreError)}). ` +
        `Recovery record: ${move.recoveryPath}`
    );
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function relinkMovedEntityFile(
    input: RelocateEntityFileInput,
    rendererOwnerId?: number
  ): Promise<RelocateEntityFileResult> {
    const requests = [
      { path: input.oldPath },
      { path: input.newPath },
      ...(input.workspaceRoot ? [{ path: input.workspaceRoot }] : []),
    ];
    return withSafeWritablePaths(requests, ([oldPath, newPath, canonicalWorkspaceRoot]) => {
      const canonicalInput: RelocateEntityFileInput = {
        ...input,
        oldPath,
        newPath,
        workspaceRoot: input.workspaceRoot ? canonicalWorkspaceRoot : null,
      };
      if (
        canonicalInput.workspaceRoot &&
        canonicalInput.oldPath !== canonicalInput.newPath &&
        !pathIsAtOrUnder(canonicalInput.newPath, canonicalInput.workspaceRoot)
      ) {
        throw new Error(
          `RELOCATE_CROSS_WORKSPACE: "${canonicalInput.newPath}" is outside its workspace ("${canonicalInput.workspaceRoot}"). ` +
            `Moving a registry file to a different workspace isn't supported yet.`
        );
      }
      return withRelocationAuthority(canonicalInput, rendererOwnerId, relinkMovedEntityFileLocked);
    });
  }

  async function relinkMovedEntityFileLocked(
    input: RelocateEntityFileInput
  ): Promise<RelocateEntityFileResult> {
    const { oldPath, newPath, workspaceRoot } = input;

    if (oldPath === newPath) {
      return {
        newPath,
        counts: {
          catalog: { updated: 0 },
          indexed: { indexedFilesMoved: 0, staleIndexedFilesMerged: 0, primerBindingsRepointed: 0 },
          lims: { rebasedEntityIds: [], workspaceIds: [] },
        },
      };
    }

    if (workspaceRoot && !pathIsAtOrUnder(newPath, workspaceRoot)) {
      throw new Error(
        `RELOCATE_CROSS_WORKSPACE: "${newPath}" is outside its workspace ("${workspaceRoot}"). ` +
          `Relinking a registry file into a different workspace isn't supported yet.`
      );
    }

    if (!(await pathExists(newPath))) {
      throw new Error(`RELINK_TARGET_MISSING: nothing at "${newPath}" to relink to`);
    }
    if (await pathExists(oldPath)) {
      throw new Error(
        `RELINK_SOURCE_PRESENT: "${oldPath}" still exists — that is a copy, not a move; not relinking`
      );
    }

    const db = getDb();
    const catalogConflict = detectCatalogRelocationConflict(db, oldPath, newPath);
    if (catalogConflict) {
      throw new Error(
        `RELOCATE_CATALOG_CONFLICT: another registry file already occupies "${catalogConflict}"`
      );
    }

    assertLimsRelocationOwnerUnique(input);
    assertEnrolledPrimerRelocationAllowed(getDb(), input);

    const nativeManifestMove = workspaceRoot
      ? await prepareNativeWorkspaceDirectFileMove({
          db,
          workspaceRoot,
          oldPath,
          newPath,
        })
      : null;
    assertEnrolledPrimerRelocationAllowed(getDb(), input);
    if (nativeManifestMove) await beginNativeWorkspaceManifestMove(nativeManifestMove);

    let primerRewrite: ReturnType<typeof rewriteAffectedPrimerArtifacts> | null = null;
    let manifestWritten = false;
    let counts: RelocateEntityFileResult['counts'];
    try {
      if (workspaceRoot) {
        primerRewrite = rewriteAffectedPrimerArtifacts({
          db,
          workspaceRoot,
          oldAbs: oldPath,
          newAbs: newPath,
          assertWritable: (path) => assertEnrolledPrimerPathMutationAllowed(getDb(), [path]),
        });
        if (primerRewrite.failedPaths.length > 0) {
          throw new Error(
            `RELOCATE_PRIMER_WRITE_FAILED: ${primerRewrite.failedPaths.length} primer artifact(s) could ` +
              `not be rewritten (e.g. "${primerRewrite.failedPaths[0]}"); relink aborted to avoid a stale reference.`
          );
        }
      }

      if (nativeManifestMove) {
        await writeMovedNativeWorkspaceManifest(nativeManifestMove);
        manifestWritten = true;
      }

      counts = db.transaction(() =>
        relocateWorkspaceFileRefsInDb(db, {
          workspaceRoot,
          oldPath,
          newPath,
          actor: input.actor,
          savedPrimers: primerRewrite?.saved,
        })
      )();
    } catch (err) {
      const failedPrimerRestores = primerRewrite
        ? restorePrimerArtifactBytes(primerRewrite.originalBytes, primerRewrite.writtenHashes)
        : [];
      let manifestRestoreError: unknown = null;
      if (nativeManifestMove && manifestWritten) {
        try {
          await restoreNativeWorkspaceManifestMove(nativeManifestMove);
        } catch (error) {
          manifestRestoreError = error;
        }
      }
      if (nativeManifestMove && manifestRestoreError === null) {
        await completeNativeWorkspaceManifestMove(nativeManifestMove);
      }
      if (manifestRestoreError && nativeManifestMove) {
        throw nativeManifestSplitStateError(nativeManifestMove, err, manifestRestoreError);
      }
      if (failedPrimerRestores.length)
        throw new Error(
          `RELOCATE_PRIMER_RESTORE_FAILED: ${failedPrimerRestores.length} file(s) changed or could not be restored. Retained source versions were preserved. ${errorMessage(err)}`
        );
      throw err;
    }
    return finishCommittedMove(db, newPath, counts, nativeManifestMove);
  }

  return { relocateEntityFile, relinkMovedEntityFile };
}
