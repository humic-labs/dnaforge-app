import { retainedEntityMessage } from '../shared/workspace-file-trash';
import type { NativeWorkTaskFile } from './work-task-preparation';
import type Database from 'better-sqlite3';
import type { ScientificWorkspaceSubmission } from '@waypoint/domain-services';
export type { ScientificWorkspaceSubmission } from '@waypoint/domain-services';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  defineBlob,
  defineResourceState,
  hasOperationReceipt,
  listWorkspaceResources,
  inspectResourceRevision,
  inspectResourceState,
  parseOperationId,
  parseResourceId,
  parseResourceRevisionId,
  parseWorkspacePath,
  parseWorkspaceVersionId,
  type ApplyMutationResult,
  type BlobHash,
  type Result,
  type WorkspacePath,
  type WorkspaceMutation,
  type RevisionGraph,
  type ResourceRevisionId,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import { exportCanonicalClosure } from '@waypoint/workspace-revisions/codec';
import {
  compileScientificWorkspace,
  createScientificReader,
  compileScientificAssembly,
  defineScientificAssemblyDraft,
  snapshotScientificFile,
  defineScientificFile,
  parseScientificIdentityMap,
  parseUniqueJson,
  scientificIdentityPath,
  scientificIdentityResourceId,
  canonicalPayload,
  type ScientificFileEntry,
} from '@waypoint/scientific-objects';
import { assertScientificTaskCommandAuthority } from './scientific-work-task-slots';
import { ScientificObjectStore } from './scientific-object-store';
import { ensureScientificEnrollmentCheckpoint } from './scientific-migration-recovery';
import { scientificNativeCodecs } from './scientific-native-codecs';
import { expandScientificNativeEntries } from './scientific-native-workspace';
import {
  materializeScientificWorkspace,
  type ScientificMaterializationResult,
} from './scientific-object-materializer';
import { canonicalWorkspacePath } from './primer-artifact-files';
import {
  acquireWorkspaceSyncDatabaseFence,
  assertWorkspaceSyncDatabaseFence,
} from './workspace-sync-database-fence';
import {
  findKnownWorkspaceRoot,
  assertWorkspaceMutationLease,
  withDeclaredWorkspaceMutation,
} from './workspace-sync-mutation-lease';
import { withDeclaredRendererWorkspaceMutation } from './ipc/workspace-mutation-authority';
import { assertWorkspaceMigrationActionsSettled } from './workspace-migration-admission';
import {
  validateNewScientificSequencePackage,
  newScientificSequencePackagePublication,
} from './scientific-sequence-package';
import { scientificAssemblyPackagePublication } from './scientific-assembly-publication';
import { validateScientificSequenceProductCreation } from './scientific-sequence-product';
import { prepareScientificSequenceMetadata } from './scientific-sequence-metadata';
import { reconcileScientificNativeProjectionsInsideTx } from './scientific-native-projection';
import { projectAcceptedPrimerInsideTx } from './scientific-primer-projection';
import { assertLimsSafetyNotQuarantined } from './lims-safety-quarantine';
import {
  prepareScientificRelocation,
  prepareScientificRestoration,
  prepareScientificReversion,
  prepareScientificDeletion,
  prepareScientificCopy,
} from './scientific-resource-operations';

const executeFile = promisify(execFile);
const must = <T, E>(result: Result<T, E>): T => {
  if (!result.ok)
    throw new TypeError(`Invalid scientific submission: ${JSON.stringify(result.error)}`);
  return result.value;
};

export async function submitScientificWorkspace(input: {
  readonly db: Database.Database;
  readonly workspaceId: number;
  readonly request: ScientificWorkspaceSubmission;
  readonly renderer?: { readonly ownerId: number; readonly mutationToken?: string };

  readonly mutationLease?: () => void;
  readonly databaseFence?: () => void;
  readonly beforeAccept?: () => void;
  readonly workTaskCommand?: boolean;
  readonly archiveResourceId?: string;
  readonly workTaskSuccessor?: NativeWorkTaskFile;

  readonly publication?: {
    readonly mutations: readonly WorkspaceMutation[];
    readonly blobs: readonly Uint8Array[];
    readonly onAcceptedInsideTx: () => undefined;
    readonly workingFileHashes?: ReadonlyMap<WorkspacePath, BlobHash | null>;
  };
}): Promise<{
  readonly acceptance: ApplyMutationResult;
  readonly delivery: ScientificMaterializationResult | null;
  readonly currentHead: string | null;
}> {
  assertNoOpenTransaction(input.db);
  const operationId = must(parseOperationId(input.request.operationId));
  const expectedHead =
    input.request.expectedHead === null
      ? null
      : must(parseWorkspaceVersionId(input.request.expectedHead));
  const source = snapshotSource(input.request.source);
  if (source.kind === 'delete' && !input.archiveResourceId) throw new Error(retainedEntityMessage);
  const successor = input.workTaskSuccessor && structuredClone(input.workTaskSuccessor);
  if (
    successor &&
    (!input.workTaskCommand ||
      source.kind !== 'native-artifact' ||
      !source.expectedRevisionId ||
      source.entry.representation.format !== 'work-task-v1' ||
      successor.representation.format !== 'work-task-v1' ||
      successor.resourceId === source.entry.resourceId)
  )
    throw new Error('An additional work task requires an authorized series split.');

  const publication = input.publication && {
    mutations: Object.freeze(
      input.publication.mutations.map((mutation) => Object.freeze({ ...mutation }))
    ),
    blobs: input.publication.blobs.map((bytes) => new Uint8Array(bytes)),
    onAcceptedInsideTx: input.publication.onAcceptedInsideTx,
    workingFileHashes:
      input.publication.workingFileHashes && new Map(input.publication.workingFileHashes),
  };
  const store = new ScientificObjectStore(input.db, input.workspaceId);
  const root = store.workspaceRoot();
  const owningRoot = findKnownWorkspaceRoot(input.db, root);
  if (!owningRoot) throw new Error('Scientific workspace is not active.');
  const operation = async () => {
    await assertWorkspaceMigrationActionsSettled(owningRoot);
    assertNoOpenTransaction(input.db);
    if (input.databaseFence) {
      if (!input.mutationLease) throw new Error('WORKSPACE_MUTATION_LEASE_REQUIRED');
      assertWorkspaceSyncDatabaseFence(input.db, input.databaseFence);
    }
    const release = input.databaseFence ? null : await acquireWorkspaceSyncDatabaseFence(input.db);
    try {
      const { graph, reader } = store.read();
      const recovery = await materializeScientificWorkspace(store);
      if (recovery.kind === 'blocked' && !hasOperationReceipt(graph, operationId))
        throw new Error(`Scientific file delivery is pending: ${recovery.error}`);
      const workspaceIdentity = exportCanonicalClosure(graph).workspaceId;
      const replay = hasOperationReceipt(graph, operationId);
      const metadata =
        source.kind === 'sequence-metadata'
          ? await prepareScientificSequenceMetadata({
              db: input.db,
              store,
              graph,
              head: expectedHead,
              operationId,
              source,
            })
          : null;
      const relocation =
        source.kind === 'relocate'
          ? prepareScientificRelocation({
              store,
              graph,
              head: expectedHead,
              sourcePath: must(parseWorkspacePath(source.sourcePath)),
              destinationPath: must(parseWorkspacePath(source.destinationPath)),
            })
          : null;
      const reversion =
        source.kind === 'revert-record'
          ? prepareScientificReversion({
              store,
              graph,
              head: expectedHead,
              resourceId: must(parseResourceId(source.resourceId)),
            })
          : null;
      const restoration =
        reversion?.restoration ??
        (source.kind === 'restore-workspace' || source.kind === 'restore-record'
          ? prepareScientificRestoration({
              store,
              graph,
              head: expectedHead,
              ...(source.kind === 'restore-workspace'
                ? { version: must(parseWorkspaceVersionId(source.version)) }
                : { resourceId: must(parseResourceId(source.resourceId)) }),
            })
          : null);
      const deletion =
        reversion?.deletion ??
        (source.kind === 'delete'
          ? prepareScientificDeletion({
              store,
              graph,
              head: expectedHead,
              sourcePath: must(parseWorkspacePath(source.sourcePath)),
            })
          : null);
      const copy =
        source.kind === 'copy'
          ? prepareScientificCopy({
              store,
              graph,
              head: expectedHead,
              operationId,
              resourceId: must(parseResourceId(source.resourceId)),
              destinationPath: must(parseWorkspacePath(source.destinationPath)),
              copiedAt: source.copiedAt,
              ...(source.catalogNumber ? { catalogNumber: source.catalogNumber } : {}),
            })
          : null;
      if (copy && !replay && source.kind === 'copy') {
        await validateRelocationWorkingTree(
          owningRoot,
          {
            kind: 'relocate',
            sourcePath: copy.sourcePath,
            destinationPath: source.destinationPath,
          },
          copy.sourcePaths
        );
        for (const [path, expected] of copy.observed) {
          const bytes = await readWorkingFile(input.db, owningRoot, path, false);
          if (bytes === null || defineBlob(bytes).hash !== expected)
            throw new Error(
              `Save or submit the working changes before copying this record: ${path}`
            );
        }
      }
      if (deletion && !replay) {
        await validateAcceptedSourceTree(owningRoot, deletion.sourcePath, deletion.removedPaths);
        for (const [path, expected] of deletion.observed) {
          const bytes = await readWorkingFile(input.db, owningRoot, path, false);
          if (bytes === null || defineBlob(bytes).hash !== expected)
            throw new Error(
              `Save or submit the working changes before deleting this record: ${path}`
            );
        }
      }
      if (relocation && !replay && source.kind === 'relocate') {
        await validateRelocationWorkingTree(owningRoot, source, relocation.movedPaths);
        for (const [path, expected] of relocation.observed) {
          const bytes = await readWorkingFile(input.db, owningRoot, path, false);
          if (bytes === null || defineBlob(bytes).hash !== expected)
            throw new Error(
              `Save or submit the working changes before moving this record: ${path}`
            );
        }
      }
      const restoredWorkingFiles =
        source.kind === 'restore-workspace' ? new Map<WorkspacePath, BlobHash | null>() : null;
      if (restoration && !replay) {
        for (const [path, expected] of restoration.observed) {
          const bytes = await readWorkingFile(
            input.db,
            owningRoot,
            path,
            restoredWorkingFiles !== null
          );
          if (bytes === null && restoredWorkingFiles) {
            restoredWorkingFiles.set(path, null);
            continue;
          }
          if (bytes === null || defineBlob(bytes).hash !== expected)
            throw new Error(`Save or submit the working changes before restoring history: ${path}`);
        }
        if (restoredWorkingFiles)
          for (const path of restoration.paths) {
            if (restoration.observed.has(path)) continue;
            if ((await readWorkingFile(input.db, owningRoot, path, true)) === null)
              restoredWorkingFiles.set(path, null);
          }
      }
      const missingWorkingFiles = new Set<WorkspacePath>();
      if (source.kind === 'restore-workspace')
        for (const path of store.acceptedWorkingPaths()) {
          assertOwningPath(input.db, owningRoot, path);
          const canonical = await canonicalWorkspacePath({
            workspaceRoot: owningRoot,
            path: resolve(owningRoot, path),
            allowMissing: true,
            artifactNoun: 'scientific object',
          });
          try {
            await lstat(canonical.candidate);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            missingWorkingFiles.add(path);
          }
        }
      if (source.kind === 'native-artifact' && source.entry.representation.format === 'genbank-v1')
        validateScientificSequenceProductCreation({
          store,
          graph,
          productText: source.entry.representation.text,
          sequencePackageText: source.entry.sequencePackageText!,
        });
      const captured =
        source.kind === 'working-files' || source.kind === 'git-commit'
          ? await captureFiles(input.db, owningRoot, workspaceIdentity, source)
          : null;
      const nativeMetadata =
        source.kind === 'native-artifact'
          ? existingPrimerNamePlan(store, expectedHead, source)
          : null;
      const submittedEntries = nativeMetadata
        ? []
        : source.kind === 'native-artifact'
          ? nativeArtifactEntries(store, expectedHead, source, successor)
          : (metadata?.entries ??
            copy?.entries ??
            deletion?.entries ??
            restoration?.entries ??
            relocation?.entries ??
            captured?.entries ??
            (source.kind === 'documents' || source.kind === 'accepted-assembly'
              ? source.entries
              : []));
      const entries =
        nativeMetadata || (metadata && !metadata.productChanged)
          ? []
          : expandScientificNativeEntries({
              graph,
              head: expectedHead,
              entries: submittedEntries,
              readBlob: (blob) => store.readBlob(blob),
              ...(restoration ? { restores: restoration.restores } : {}),
            });
      for (const entry of entries)
        assertOwningPath(input.db, owningRoot, must(parseWorkspacePath(entry.path)));
      if (nativeMetadata) assertOwningPath(input.db, owningRoot, nativeMetadata.path);
      assertOwningPath(input.db, owningRoot, scientificIdentityPath);
      const scientificPlan = nativeMetadata
        ? nativeMetadata.plan
        : metadata && !metadata.productChanged
          ? unchangedScientificWorkspacePlan(graph, expectedHead)
          : source.kind === 'accepted-assembly'
            ? compileScientificAssembly({
                graph,
                head: expectedHead,
                entries,
                assembly: source.assembly,
                readBlob: (blob) => store.readBlob(blob),
                codecs: scientificNativeCodecs,
              })
            : compileScientificWorkspace({
                graph,
                head: expectedHead,
                entries,
                codecs: scientificNativeCodecs,
                ...(restoration ? { restores: restoration.restores } : {}),
              });
      const nativePackage =
        metadata ??
        (source.kind === 'native-artifact'
          ? newScientificSequencePackagePublication(source.entry)
          : source.kind === 'accepted-assembly'
            ? await scientificAssemblyPackagePublication({
                store,
                graph,
                head: expectedHead,
                source,
              })
            : { mutations: [], blobs: [] });
      const plan = {
        mutations: [
          ...scientificPlan.mutations.map((mutation): WorkspaceMutation => {
            const original = copy?.originals.get(mutation.resourceId);
            return mutation.kind === 'create-resource' && original
              ? { ...mutation, origin: { kind: 'derived', relation: 'copy', sources: [original] } }
              : mutation;
          }),
          ...nativePackage.mutations,
          ...(relocation?.mutations ?? []),
          ...(restoration?.mutations ?? []),
          ...(deletion?.mutations ?? []),
          ...(copy?.mutations ?? []),
          ...(publication?.mutations ?? []),
        ],
        blobs: [
          ...scientificPlan.blobs,
          ...nativePackage.blobs,
          ...(restoration?.blobs ?? []),
          ...(copy?.blobs ?? []),
          ...(publication?.blobs ?? []),
        ],
      };
      if (!input.workTaskCommand)
        assertScientificTaskCommandAuthority(graph, expectedHead, source, submittedEntries);
      if (
        source.kind === 'delete' &&
        !plan.mutations.some(
          (m) => m.kind === 'delete-resource' && m.resourceId === input.archiveResourceId
        )
      )
        throw new Error(retainedEntityMessage);
      for (const mutation of plan.mutations) {
        if (
          mutation.kind === 'delete-resource' &&
          source.kind !== 'restore-workspace' &&
          source.kind !== 'restore-record' &&
          source.kind !== 'revert-record'
        ) {
          const kind = reader.revision({
            resourceId: mutation.resourceId,
            revisionId: mutation.expectedRevision,
          })?.document.kind;
          const relationship =
            kind === 'primer-binding' || kind === 'strain-sequence' || kind === 'strain-descent';
          const partOfArchive =
            source.kind === 'delete' && (mutation.resourceId === input.archiveResourceId || !kind);
          if (!relationship && !partOfArchive) throw new Error(retainedEntityMessage);
        }
        const paths =
          mutation.kind === 'create-resource'
            ? [mutation.path]
            : mutation.kind === 'restore-resource' || mutation.kind === 'restore-and-edit-resource'
              ? [mutation.destination]
              : mutation.kind === 'edit-and-move-resource' || mutation.kind === 'move-resource'
                ? [mutation.expectedPath, mutation.destination]
                : mutation.kind === 'delete-resource'
                  ? [mutation.expectedPath]
                  : [];
        for (const path of paths) assertOwningPath(input.db, owningRoot, path);
      }
      await ensureScientificEnrollmentCheckpoint(input.db, input.workspaceId);
      if (captured) {
        if (expectedHead !== null && source.kind === 'working-files') {
          for (const slot of must(listWorkspaceResources(graph, expectedHead))) {
            if (slot.path && !captured.observedHashes.has(slot.path)) {
              const bytes = await readWorkingFile(input.db, owningRoot, slot.path, true);
              captured.hashes.set(slot.path, bytes === null ? null : defineBlob(bytes).hash);
              captured.observedHashes.set(
                slot.path,
                bytes === null ? null : defineBlob(bytes).hash
              );
            }
          }
        }

        for (const [path, expected] of captured.observedHashes) {
          const bytes = await readWorkingFile(input.db, owningRoot, path, true);
          if ((bytes === null ? null : defineBlob(bytes).hash) !== expected)
            throw new Error(`Scientific working file changed during submission: ${path}`);
        }
      }
      input.beforeAccept?.();
      const acceptance = store.submit(
        {
          operationId,
          expectedHead,
          ...plan,
          ...(restoredWorkingFiles ? { completeWorkspace: true } : {}),
          ...(missingWorkingFiles.size ? { missingWorkingFiles } : {}),
          ...(captured
            ? { workingFileHashes: captured.hashes }
            : metadata?.workingFileHashes
              ? { workingFileHashes: metadata.workingFileHashes }
              : restoredWorkingFiles
                ? { workingFileHashes: restoredWorkingFiles }
                : publication?.workingFileHashes
                  ? { workingFileHashes: publication.workingFileHashes }
                  : {}),
        },
        () => {
          input.beforeAccept?.();
          if (!replay && source.kind === 'restore-workspace')
            input.db
              .prepare(
                "UPDATE scientific_work_dispatch SET state='suspended',epoch=epoch+1 WHERE workspace_id=? AND state='local'"
              )
              .run(input.workspaceId);
          publication?.onAcceptedInsideTx();
          metadata?.onAcceptedInsideTx();

          if (nativeMetadata) {
            assertLimsSafetyNotQuarantined(input.db);
            const accepted = store.read();
            const snapshot = accepted.reader.current(nativeMetadata.resourceId);
            if (!snapshot) throw new Error('Accepted primer projection is unavailable.');
            projectAcceptedPrimerInsideTx({
              db: input.db,
              workspaceId: input.workspaceId,
              root: owningRoot,
              path: nativeMetadata.path,
              snapshot,
              reader: accepted.reader,
            });
          } else reconcileScientificNativeProjectionsInsideTx(input.db, input.workspaceId);
        }
      );
      const successful =
        acceptance.kind === 'changed' ||
        acceptance.kind === 'no-op' ||
        (acceptance.kind === 'replay' &&
          (acceptance.original.outcome === 'changed' || acceptance.original.outcome === 'no-op'));
      const resumedMetadata =
        successful && acceptance.kind === 'replay' && metadata?.workingFileHashes;
      if (successful && acceptance.kind === 'replay' && metadata?.workingFileHashes)
        store.acknowledgeReplayedMetadataWorkingFiles(operationId, metadata.workingFileHashes);
      return {
        acceptance,
        currentHead: store.read().head,
        delivery: successful
          ? recovery.kind === 'blocked' && !resumedMetadata
            ? recovery
            : await materializeScientificWorkspace(store)
          : null,
      };
    } finally {
      release?.();
    }
  };
  if (input.mutationLease) {
    assertWorkspaceMutationLease(input.mutationLease, root);
    return operation();
  }
  return input.renderer
    ? withDeclaredRendererWorkspaceMutation({
        db: input.db,
        ownerId: input.renderer.ownerId,
        workspaceRoot: root,
        ...(input.renderer.mutationToken ? { mutationToken: input.renderer.mutationToken } : {}),
        operation,
      })
    : withDeclaredWorkspaceMutation(input.db, root, [], operation);
}

async function validateRelocationWorkingTree(
  root: string,
  source: Extract<ScientificWorkspaceSubmission['source'], { kind: 'relocate' }>,
  acceptedPaths: ReadonlySet<WorkspacePath>
): Promise<void> {
  const destination = await canonicalWorkspacePath({
    workspaceRoot: root,
    path: resolve(root, source.destinationPath),
    allowMissing: true,
  });
  try {
    await lstat(destination.candidate);
    throw new Error('MOVE_EXISTS: an item already exists at the destination.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await validateAcceptedSourceTree(root, source.sourcePath, acceptedPaths);
}

async function validateAcceptedSourceTree(
  root: string,
  sourcePath: string,
  acceptedPaths: ReadonlySet<WorkspacePath>
): Promise<void> {
  const oldPath = await canonicalWorkspacePath({
    workspaceRoot: root,
    path: resolve(root, sourcePath),
    allowMissing: false,
  });
  const visit = async (absolute: string, path: string): Promise<void> => {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink())
      throw new Error('Accepted records cannot move through symbolic links.');
    if (stat.isDirectory()) {
      for (const child of await readdir(absolute))
        await visit(resolve(absolute, child), `${path}/${child}`);
    } else {
      const portable = must(parseWorkspacePath(path));
      if (!stat.isFile() || !acceptedPaths.has(portable))
        throw new Error(`Save or submit unaccepted files before moving this folder: ${path}`);
    }
  };
  await visit(oldPath.candidate, sourcePath);
}

function snapshotSource(
  source: ScientificWorkspaceSubmission['source']
): ScientificWorkspaceSubmission['source'] & { readonly entries?: readonly ScientificFileEntry[] } {
  if (source.kind === 'sequence-metadata') {
    if (typeof source.metadataText !== 'string')
      throw new TypeError('Sequence metadata requires native text.');
    return Object.freeze({
      ...structuredClone(source),
      resourceId: must(parseResourceId(source.resourceId)),
      expectedRevisionId: must(parseResourceRevisionId(source.expectedRevisionId)),
      expectedPackageRevisionId: must(parseResourceRevisionId(source.expectedPackageRevisionId)),
    });
  }
  if (source.kind === 'relocate')
    return Object.freeze({
      kind: 'relocate',
      sourcePath: must(parseWorkspacePath(source.sourcePath)),
      destinationPath: must(parseWorkspacePath(source.destinationPath)),
    });
  if (source.kind === 'restore-workspace')
    return Object.freeze({
      kind: 'restore-workspace',
      version: must(parseWorkspaceVersionId(source.version)),
    });
  if (source.kind === 'delete')
    return Object.freeze({
      kind: 'delete',
      sourcePath: must(parseWorkspacePath(source.sourcePath)),
    });
  if (source.kind === 'restore-record' || source.kind === 'revert-record')
    return Object.freeze({
      kind: source.kind,
      resourceId: must(parseResourceId(source.resourceId)),
    });
  if (source.kind === 'copy') {
    if (
      typeof source.copiedAt !== 'string' ||
      new Date(source.copiedAt).toISOString() !== source.copiedAt
    )
      throw new TypeError('Scientific copies require an exact creation timestamp.');
    if (
      source.catalogNumber !== undefined &&
      (typeof source.catalogNumber !== 'string' || !source.catalogNumber.trim())
    )
      throw new TypeError('A copied primer catalog number must be non-empty.');
    return Object.freeze({
      kind: 'copy',
      resourceId: must(parseResourceId(source.resourceId)),
      destinationPath: must(parseWorkspacePath(source.destinationPath)),
      copiedAt: source.copiedAt,
      ...(source.catalogNumber === undefined ? {} : { catalogNumber: source.catalogNumber }),
    });
  }
  if (source.kind === 'native-artifact') {
    const content = snapshotScientificFile(source.entry, scientificNativeCodecs);
    const representation = content.representation;
    if (
      !representation ||
      (representation.format !== 'primer-v2' &&
        representation.format !== 'strain-entity-v1' &&
        representation.format !== 'genbank-v1' &&
        representation.format !== 'work-task-v1')
    )
      throw new TypeError('Unsupported native scientific artifact representation.');
    validateNewScientificSequencePackage(source.entry);
    if (representation.format === 'genbank-v1' && source.expectedRevisionId !== null)
      throw new Error(
        'Existing accepted sequences require the sequence Save operation with its edit history.'
      );
    return Object.freeze({
      kind: 'native-artifact',
      expectedRevisionId:
        source.expectedRevisionId === null
          ? null
          : must(parseResourceRevisionId(source.expectedRevisionId)),
      entry: Object.freeze({
        resourceId: must(parseResourceId(source.entry.resourceId)),
        path: must(parseWorkspacePath(source.entry.path)),
        representation: Object.freeze({ format: representation.format, text: representation.text }),
        ...(source.entry.sequencePackageText === undefined
          ? {}
          : { sequencePackageText: source.entry.sequencePackageText }),
      }),
    });
  }
  if (source.kind === 'documents' || source.kind === 'accepted-assembly') {
    const entries = Object.freeze(
      source.entries.map((entry) =>
        Object.freeze({
          resourceId: must(parseResourceId(entry.resourceId)),
          path: must(parseWorkspacePath(entry.path)),
          ...snapshotScientificFile(entry, scientificNativeCodecs),
        })
      )
    );
    return source.kind === 'accepted-assembly'
      ? Object.freeze({
          kind: 'accepted-assembly',
          assembly: defineScientificAssemblyDraft(source.assembly),
          entries,
          ...(source.nativePackage
            ? { nativePackage: Object.freeze({ ...source.nativePackage }) }
            : {}),
        })
      : Object.freeze({ kind: 'documents', entries });
  }
  if (source.kind === 'working-files') return Object.freeze({ kind: 'working-files' });
  if (source.kind !== 'git-commit' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(source.commit))
    throw new TypeError('Scientific Git input requires an immutable full commit ID.');
  return Object.freeze({ kind: 'git-commit', commit: source.commit });
}

function existingPrimerNamePlan(
  store: ScientificObjectStore,
  head: WorkspaceVersionId | null,
  source: Extract<ScientificWorkspaceSubmission['source'], { kind: 'native-artifact' }>
) {
  if (
    !head ||
    source.expectedRevisionId === null ||
    source.entry.representation.format !== 'primer-v2'
  )
    return null;
  const { graph } = store.read();
  const reader = createScientificReader({
    graph,
    head,
    readBlob: (blob) => store.readBlob(blob),
    codecs: scientificNativeCodecs,
  });
  const resourceId = must(parseResourceId(source.entry.resourceId));
  const prior = reader.current(resourceId);
  const slot = must(listWorkspaceResources(graph, head)).find(
    (value) => value.resourceId === resourceId
  );
  if (
    !prior ||
    prior.revisionId !== source.expectedRevisionId ||
    slot?.tombstone ||
    slot?.path !== source.entry.path ||
    prior.representation?.format !== 'primer-v2'
  )
    return null;
  const defined = defineScientificFile(source.entry, scientificNativeCodecs);
  if (
    defined.nativeResourceId !== resourceId ||
    defined.document.kind !== 'primer' ||
    prior.document.kind !== 'primer' ||
    defined.bindingInputHash !== prior.bindingInputHash ||
    canonicalPayload({ ...defined.document, name: prior.document.name }) !==
      canonicalPayload(prior.document)
  )
    return null;
  const oldRaw = parseUniqueJson(prior.representation.text) as Record<string, unknown>;
  const newRaw = parseUniqueJson(defined.text) as Record<string, unknown>;
  if (canonicalPayload(oldRaw.bindings ?? null) !== canonicalPayload(newRaw.bindings ?? null))
    return null;
  const plan = unchangedScientificWorkspacePlan(graph, head);
  const mutations = plan.mutations.map((mutation) =>
    mutation.resourceId === resourceId && mutation.kind === 'edit-resource'
      ? { ...mutation, state: defined.state }
      : mutation
  );
  return {
    resourceId,
    path: must(parseWorkspacePath(source.entry.path)),
    plan: { mutations, blobs: [...plan.blobs, new TextEncoder().encode(defined.text)] },
  };
}

function nativeArtifactEntries(
  store: ScientificObjectStore,
  head: ReturnType<typeof store.read>['head'],
  source: Extract<ScientificWorkspaceSubmission['source'], { kind: 'native-artifact' }>,
  successor?: NativeWorkTaskFile
): readonly ScientificFileEntry[] {
  if (head === null)
    throw new Error('Enroll the scientific workspace before creating native artifacts.');
  const { graph } = store.read();
  const reader = createScientificReader({
    graph,
    head,
    readBlob: (blob) => store.readBlob(blob),
    codecs: scientificNativeCodecs,
  });
  const resourceId = must(parseResourceId(source.entry.resourceId));
  const slots = must(listWorkspaceResources(graph, head));
  const extra = successor
    ? {
        resourceId: must(parseResourceId(successor.resourceId)),
        path: must(parseWorkspacePath(successor.path)),
        representation: successor.representation,
      }
    : null;
  if (extra && slots.some((s) => s.resourceId === extra.resourceId))
    throw new Error('The work series successor identity already exists.');
  const existing = slots.find((slot) => slot.resourceId === resourceId);
  const snapshot = reader.current(resourceId);
  if (source.expectedRevisionId === null) {
    if (existing)
      throw new Error(
        'The native artifact identity already exists; edit or restore it explicitly.'
      );
  } else if (
    !snapshot ||
    snapshot.revisionId !== source.expectedRevisionId ||
    existing?.tombstone
  ) {
    throw new Error('The native artifact revision does not match the captured accepted baseline.');
  }
  if (existing && existing.path !== source.entry.path)
    throw new Error('The native artifact path does not match its captured identity.');
  const entries: ScientificFileEntry[] = slots.flatMap((slot) => {
    if (!slot.path || slot.tombstone || slot.resourceId === resourceId) return [];
    const snapshot = reader.current(slot.resourceId);
    if (!snapshot) return [];
    return [
      {
        resourceId: slot.resourceId,
        path: slot.path,
        ...(snapshot.representation
          ? { representation: snapshot.representation }
          : { document: snapshot.document }),
      },
    ];
  });
  return [
    ...entries,
    ...(extra ? [extra] : []),
    { ...source.entry, resourceId, path: must(parseWorkspacePath(source.entry.path)) },
  ];
}

async function captureFiles(
  db: Database.Database,
  root: string,
  workspaceIdentity: string,
  source: Extract<ScientificWorkspaceSubmission['source'], { kind: 'working-files' | 'git-commit' }>
) {
  const hashes = new Map<WorkspacePath, BlobHash | null>(),
    observedHashes = new Map<WorkspacePath, BlobHash | null>();
  const read = async (path: WorkspacePath): Promise<Uint8Array> => {
    const working = await readWorkingFile(db, root, path, source.kind === 'git-commit');
    const observed = working === null ? null : defineBlob(working).hash;
    observedHashes.set(path, observed);
    if (source.kind === 'working-files') {
      if (!working) throw new Error(`Scientific working file is missing: ${path}`);
      hashes.set(path, observed);
      return working;
    }
    assertOwningPath(db, root, path);

    const mode = await executeFile(
      'git',
      ['--literal-pathspecs', 'ls-tree', '-z', source.commit, '--', path],
      { cwd: root, encoding: 'utf8' }
    );
    const records = mode.stdout.split('\0').filter(Boolean);
    if (records.length !== 1 || !/^(100644|100755) blob [0-9a-f]+\t/u.test(records[0]))
      throw new Error(`Scientific Git entry is not an ordinary file: ${path}`);
    const { stdout } = await executeFile('git', ['cat-file', 'blob', `${source.commit}:${path}`], {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    });

    if (observed === defineBlob(stdout).hash) hashes.set(path, observed);
    return stdout;
  };
  if (source.kind === 'git-commit') {
    const { stdout } = await executeFile(
      'git',
      ['rev-parse', '--verify', `${source.commit}^{commit}`],
      { cwd: root, encoding: 'utf8' }
    );
    if (stdout.trim() !== source.commit) throw new Error('Scientific Git commit is unavailable.');
  }
  const manifest = parseScientificIdentityMap(
    decode(await read(scientificIdentityPath)),
    workspaceIdentity
  );
  const entries: ScientificFileEntry[] = [];
  for (const row of manifest.entries) {
    const text = decode(await read(row.path));
    entries.push({
      resourceId: row.resourceId,
      path: row.path,
      ...(row.format && row.format !== 'scientific-json-v1'
        ? { representation: { format: row.format, text } }
        : { document: parseUniqueJson(text, { maxDepth: 64 }) }),
    });
  }
  return { entries, hashes, observedHashes };
}

function assertOwningPath(db: Database.Database, root: string, path: WorkspacePath): void {
  if (findKnownWorkspaceRoot(db, resolve(root, path)) !== root)
    throw new Error('Scientific path belongs to another workspace root.');
}
async function readWorkingFile(
  db: Database.Database,
  root: string,
  path: WorkspacePath,
  allowMissing: boolean
): Promise<Uint8Array | null> {
  assertOwningPath(db, root, path);
  const canonical = await canonicalWorkspacePath({
    workspaceRoot: root,
    path: resolve(root, path),
    allowMissing,
    artifactNoun: 'scientific object',
  });
  try {
    return await readFile(canonical.candidate);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function unchangedScientificWorkspacePlan(
  graph: RevisionGraph,
  head: WorkspaceVersionId | null
): {
  mutations: readonly WorkspaceMutation[];
  blobs: readonly Uint8Array[];
} {
  if (!head) throw new Error('Metadata Save has no accepted scientific workspace.');
  const mutations: WorkspaceMutation[] = [];
  const entries: { resourceId: string; path: string; format?: string }[] = [];
  let identityRevision: ResourceRevisionId | undefined;
  for (const slot of must(listWorkspaceResources(graph, head))) {
    if (slot.tombstone || !slot.path) continue;
    const revision = must(inspectResourceRevision(graph, slot.revisionId));
    if (!revision.stateHash) throw new Error('Metadata Save has no accepted resource state.');
    const state = must(inspectResourceState(graph, revision.stateHash));
    if (slot.resourceId === scientificIdentityResourceId) {
      if (
        state.resourceKind !== 'dnaforge.scientific-identity-map' ||
        slot.path !== scientificIdentityPath
      )
        throw new Error('Metadata Save has an invalid scientific identity map.');
      identityRevision = slot.revisionId;
    } else if (state.resourceKind.startsWith('dnaforge.scientific.')) {
      const mutation: WorkspaceMutation = {
        kind: 'edit-resource',
        resourceId: slot.resourceId,
        expectedRevision: slot.revisionId,
        state: must(defineResourceState(state)),
      };
      mutations.push(mutation);
      const format = state.materialMetadata?.representation;
      if (format !== undefined && typeof format !== 'string')
        throw new Error('Metadata Save has an invalid native representation.');
      entries.push({
        resourceId: slot.resourceId,
        path: slot.path,
        ...(format !== undefined ? { format } : {}),
      });
    }
  }
  mutations.sort((a, b) =>
    a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0
  );
  if (!identityRevision) throw new Error('Metadata Save has no accepted scientific identity map.');
  entries.sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0));
  const native = entries.some((entry) => entry.format !== undefined);
  const bytes = new TextEncoder().encode(
    `${canonicalPayload({
      formatVersion: native ? 2 : 1,
      workspaceId: exportCanonicalClosure(graph).workspaceId,
      entries: entries.map(({ resourceId, path, format }) => ({
        resourceId,
        path,
        ...(native ? { format: format ?? 'scientific-json-v1' } : {}),
      })),
    })}\n`
  );
  if (bytes.byteLength > 1024 * 1024) throw new Error('Scientific identity map exceeds 1 MiB.');
  const identity: WorkspaceMutation = {
    kind: 'edit-resource',
    resourceId: scientificIdentityResourceId,
    expectedRevision: identityRevision,
    state: must(
      defineResourceState({
        layout: 'file',
        resourceKind: 'dnaforge.scientific-identity-map',
        mediaType: 'application/json',
        blob: defineBlob(bytes),
      })
    ),
  };
  return { mutations: [...mutations, identity], blobs: [bytes] };
}
function assertNoOpenTransaction(db: Database.Database): void {
  if (db.inTransaction)
    throw new Error('Scientific workspace commands cannot enter an open database transaction.');
}
