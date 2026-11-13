import type Database from 'better-sqlite3';
import type { SequenceDocumentWriteReceipt } from '../shared/sequence-edit-lineage';
import { ScientificObjectStore } from './scientific-object-store';
import { scientificWorkspaceIdForRoot } from './scientific-workspace-identity';
import { retainSequenceSavePrimerPublication } from './sequence-save-primer-publications';
import { createPrimerBindingOwnershipStore } from '../shared/primer-artifacts/primer-binding-ownership';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { createPrimerRepository } from '../shared/primer-artifacts/primer-repository';
import {
  persistRichPastePrimerBindings,
  type PersistRichPastePrimerBindingsInput,
} from '../shared/primer-artifacts/persist-primer-bindings-core';
import type { ImportSetPersistenceDependencies } from '../shared/registry-artifacts/import-set-core';
import { createNativePrimerArtifactWriter } from './native-import-writers';
import { createNativeCatalogDatabase } from './native-catalog-repository';
import { createNativeSequenceDocumentResolver } from './native-sequence-document-resolver';
import {
  writeWorkspaceTextFileAtomicInMain,
  writeWorkspaceBinaryFileAtomicInMain,
} from './primer-artifact-files';
import { commitPathsIfDirty, isGitRepo } from './workspace-git';
import {
  withKnownWorkspacePathsMutationAcrossWorkspaces,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';
import { assertKnownWorkspaceContentWritable } from './workspace-content-write-access';
import {
  acquireWorkspaceSyncDatabaseFence,
  assertWorkspaceSyncDatabaseFence,
} from './workspace-sync-database-fence';
import { assertNativeSequenceContentWritable } from './native-sequence-content-access';

export async function persistRichPastePrimerBindingsInMain(
  input: PersistRichPastePrimerBindingsInput,
  options: {
    db: Database.Database;
    workspaceRoots(): readonly string[];
    assertCurrent(): void;
    expectedTargetContentHash: string;
    onBindingsChanged?(sequenceId: number): void;
    sequenceSave?: { receipt: SequenceDocumentWriteReceipt; onPublication(id: string): void };
  }
): Promise<void> {
  const root = input.targetWorkspaceRoot;
  const assertCurrent = () => {
    options.assertCurrent();
    if (
      !options
        .workspaceRoots()
        .some(
          (entry) => workspaceMutationRootIdentity(entry) === workspaceMutationRootIdentity(root)
        )
    )
      throw new Error('Primer target project is no longer admitted.');
  };
  const persistence: ImportSetPersistenceDependencies = {
    fs: {
      exists: async (path) => {
        try {
          const file = await open(path, 'r');
          await file.close();
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      },
      readFile: async (path) => new Uint8Array(await readFile(path)),
      readTextFile: (path) => readFile(path, 'utf8'),
      sha256File: async (path) =>
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      writeWorkspaceTextFileAtomic: (request) =>
        writeWorkspaceTextFileAtomicInMain(request, { beforePublish: assertCurrent }),
      writeWorkspaceBinaryFileAtomic: (request) =>
        writeWorkspaceBinaryFileAtomicInMain(request, { beforePublish: assertCurrent }),
    },
    isGitRepo: async (path) => isGitRepo(path),
    commitPaths: async (path, message, paths) => {
      await commitPathsIfDirty(path, message, { paths });
    },
  };
  await withKnownWorkspacePathsMutationAcrossWorkspaces(options.db, [root], async (leases) => {
    assertCurrent();
    assertKnownWorkspaceContentWritable(options.db, root);
    const resolved = await createNativeSequenceDocumentResolver({
      db: () => options.db,
      workspaceRoots: options.workspaceRoots,
    })({
      operationId: 'native-rich-paste-primer-bindings',
      targetDocumentId: input.targetDocumentId,
    });
    const expected = options.expectedTargetContentHash.replace(/^sha256:/, '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected))
      throw new Error('A valid published target hash is required for pasted primer bindings.');
    const checkTarget = async () => {
      assertCurrent();
      if (`sha256:${await persistence.fs.sha256File(resolved.sourcePath)}` !== `sha256:${expected}`)
        throw new Error('The published target changed before pasted primer bindings settled.');
      if (resolved.sourcePath !== input.targetFilePath)
        throw new Error('Pasted primer target path differs from its current native document.');
    };
    await checkTarget();
    const release = await acquireWorkspaceSyncDatabaseFence(options.db);
    try {
      const assertFencedCurrent = () => {
        assertWorkspaceSyncDatabaseFence(options.db, release);
        assertCurrent();
      };
      assertFencedCurrent();
      assertNativeSequenceContentWritable(options.db, input.targetDocumentId, root, release);
      const native = createNativePrimerArtifactWriter({
        db: options.db,
        workspaceRoot: root,
        workspaceRoots: options.workspaceRoots,
        persistence,
        assertCurrent: assertFencedCurrent,
        operationId: 'native-rich-paste-primer-bindings',
        publicationAuthority: {
          mutationLease: leases.get(workspaceMutationRootIdentity(root))!,
          databaseFence: release,
        },
      });
      const current = await native.database.select<Array<{ id: number }>>(
        'SELECT id FROM sequences WHERE document_id=? ORDER BY id LIMIT 1',
        [input.targetDocumentId]
      );
      if (current[0]?.id !== input.targetSequenceId)
        throw new Error('Pasted primer target sequence identity changed.');
      const legacy = createPrimerRepository({
        database: native.database,
        primerTmCalculationService: native.tm,
        generateCatalogNumber: async (id) => {
          const { allocatePrimerCatalogNumberInDb } = await import('./primer-projection');
          return allocatePrimerCatalogNumberInDb(options.db, id);
        },
      });
      const sequenceSave = options.sequenceSave;
      const workspaceId = sequenceSave?.receipt.accepted
        ? scientificWorkspaceIdForRoot(options.db, root)
        : null;
      let publicationHead = sequenceSave?.receipt.accepted?.workspaceVersionId;
      if (sequenceSave && sequenceSave.receipt.contentSha256 !== expected)
        throw new Error('The copied primer Save receipt does not match its published target.');
      await persistRichPastePrimerBindings(
        input,
        {
          listLegacyBoundPrimers: legacy.listBoundPrimers,
          getPrimer: legacy.getPrimerById,
          readSavedTarget: native.owner.readSavedPrimerBindingTarget,
          persistOwnedArtifactBindings: async (request) => {
            const baseVersionId = publicationHead;
            if (sequenceSave?.receipt.accepted) {
              if (
                workspaceId === null ||
                !baseVersionId ||
                new ScientificObjectStore(options.db, workspaceId).read().head !== baseVersionId
              )
                throw new Error('Unrelated accepted work changed the copied primer Save context.');
            }
            const saved = await native.owner.persistOwnedPrimerArtifactBindings(request, {
              retainAcceptedHistoryPending: Boolean(sequenceSave?.receipt.accepted),
            });
            if (sequenceSave?.receipt.accepted && saved.acceptedRevision) {
              if (workspaceId === null || !baseVersionId)
                throw new Error('The copied primer publication lost its captured workspace.');
              const id = retainSequenceSavePrimerPublication({
                db: options.db,
                databaseFence: release,
                assertCurrent: assertFencedCurrent,
                workspaceId,
                documentId: input.targetDocumentId,
                draftLineageId: input.draftLineageId,
                receipt: sequenceSave.receipt,
                baseVersionId,
                saved,
                ownedBindingIds: request.ownedBindingIds,
                bindingIds: saved.bindingMutations.map((mutation) => mutation.bindingId),
              });
              publicationHead = saved.acceptedRevision.workspaceVersionId;
              sequenceSave.onPublication(id);
            }
            return saved;
          },
          persistOwnedLegacyBinding: legacy.persistOwnedPrimerBinding,
          deleteLegacyBinding: legacy.deleteBinding,
          notifyBindingsChanged: (id) => options.onBindingsChanged?.(id),
        },
        createPrimerBindingOwnershipStore(() =>
          createNativeCatalogDatabase(options.db, { assertCurrent: assertFencedCurrent })
        )
      );
      await checkTarget();
    } finally {
      release();
    }
  });
}
