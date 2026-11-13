import { assertWorkspaceWriteAllowed } from '../workspace-write-admission';
import { dirname } from 'path';
import { retireSequenceEvidenceQuerySources } from '../sequence-evidence-query-attachments';
import { nativeDocuments } from '../features/native-documents';
import { SharedProjectViewOnlyError } from '../shared-project-write-access';
import { assertSafePath, withSafeWritablePath } from './path-allowlist';
import { createRegisteredSequencePackagePublicationContext } from '../sequence-package-registry-publication';
import {
  withDeclaredRendererWorkspaceMutation,
  withDeclaredRendererFilesystemMutation,
  assertUnversionedRendererFilesystemMutationAllowed,
} from './workspace-mutation-authority';
import { withRendererDatabaseStatement } from '../workspace-sync-database-fence';
import {
  acquireWorkspaceMutationShared,
  findKnownWorkspaceRoot,
} from '../workspace-sync-mutation-lease';
import type {
  SequenceDocumentSaveInput,
  SequenceDocumentSaveResult,
  SequenceDocumentHistoryInput,
  SequenceDocumentHistoryResult,
} from '../../shared/sequence-edit-lineage';
import { createNativeSequenceDocumentResolver } from '../native-sequence-document-resolver';
import { saveSequenceDocumentWithLineage } from '../sequence-document-save';
import { commitSequenceDocumentHistory } from '../sequence-document-history';
import { readLegacySequenceMetadataJournalInMain } from '../sequence-package-legacy-metadata-journal';
import { recoverLegacySequenceMetadataTransactionInMain } from '../sequence-package-legacy-metadata-recovery';
import {
  applySequenceRestoreInMain,
  previewSequenceRestoreInMain,
  publishAcceptedAssemblyRevisionInMain,
  publishSequenceMetadataRevisionInMain,
  publishSequenceUserAttachmentMutationInMain,
} from '../sequence-package-revision-publication';
import type {
  AcceptedAssemblyRevisionPublicationRequest,
  AcceptedAssemblyRevisionPublicationResult,
  SequenceRestoreApplyRequest,
  SequenceRestoreApplyResult,
  SequenceRestorePreviewRequest,
  SequenceRestorePreviewResult,
  SequenceMetadataRevisionRequest,
  SequenceUserAttachmentMutationRequest,
  SequenceUserAttachmentMutationResult,
} from '../../shared/sequence-package-revision';
import {
  activateSequenceEvidenceRunInMain,
  appendSequenceEvidenceStateInMain,
  completeSequenceEvidenceRunInMain,
  failSequenceEvidenceRunInMain,
  prepareSequenceEvidenceRunInMain,
} from '../sequence-package-evidence-publication';
import type {
  ActivateSequenceEvidenceRunRequest,
  AppendSequenceEvidenceStateRequest,
  AppendSequenceEvidenceStateResult,
  CompleteSequenceEvidenceRunRequest,
  CompleteSequenceEvidenceRunResult,
  FailSequenceEvidenceRunRequest,
  PrepareSequenceEvidenceRunRequest,
  PrepareSequenceEvidenceRunResult,
} from '../../shared/sequence-package-evidence';
import type { MainHandlersOf } from '../../shared/ipc-contract';
import type { fsContract } from '../../shared/ipc/fs.contract';
import {
  withSequencePackageOwner,
  assertWorkspaceContentPublicationWritable,
} from './workspace-content-publication';
export const sequencePackageFilesystemHandlers: Pick<
  MainHandlersOf<typeof fsContract>,
  | 'saveSequenceDocument'
  | 'commitSequenceDocumentHistory'
  | 'publishSequenceMetadataRevision'
  | 'recoverLegacySequenceMetadataTransaction'
  | 'publishAcceptedAssemblyRevision'
  | 'publishSequenceUserAttachmentMutation'
  | 'previewSequenceRestore'
  | 'applySequenceRestore'
  | 'prepareSequenceEvidenceRun'
  | 'activateSequenceEvidenceRun'
  | 'completeSequenceEvidenceRun'
  | 'failSequenceEvidenceRun'
  | 'appendSequenceEvidenceState'
> = {
  saveSequenceDocument: async (
    event,
    input: SequenceDocumentSaveInput
  ): Promise<SequenceDocumentSaveResult> => {
    if (
      !input ||
      typeof input !== 'object' ||
      typeof input.documentId !== 'string' ||
      typeof input.sourcePath !== 'string'
    ) {
      throw new Error('The sequence save request is malformed.');
    }
    const { getDb } = await import('./database');
    const db = getDb();
    assertWorkspaceWriteAllowed(db, [input.sourcePath]);
    const entity = db
      .prepare('SELECT type,status FROM catalog_entities WHERE id=?')
      .get(input.documentId) as
      | {
          type: string;
          status: string;
        }
      | undefined;
    if (!entity) return { status: 'unbound' };
    if ((entity.type !== 'sequence' && entity.type !== 'construct') || entity.status !== 'active') {
      throw new Error('The sequence document has no active native catalog binding.');
    }
    const root = findKnownWorkspaceRoot(db, input.sourcePath);
    if (!root) throw new Error('The sequence document is outside an active workspace.');
    const resolveDocument = createNativeSequenceDocumentResolver({
      db: getDb,
      workspaceRoots: () => [root],
    });
    return saveSequenceDocumentWithLineage(input, {
      db,
      includeWriteReceipt: true,
      renderer: {
        ownerId: event.sender.id,
        ...(input.mutationToken ? { mutationToken: input.mutationToken } : {}),
      },
      resolve: (documentId) =>
        resolveDocument({ operationId: 'renderer-sequence-save', targetDocumentId: documentId }),
      runDatabase: (operation) => withRendererDatabaseStatement(db, event.sender, operation),
    });
  },
  commitSequenceDocumentHistory: async (
    event,
    input: SequenceDocumentHistoryInput
  ): Promise<SequenceDocumentHistoryResult> => {
    if (!input || typeof input.documentId !== 'string' || typeof input.sourcePath !== 'string')
      throw new Error('The sequence history request is malformed.');
    const { getDb } = await import('./database');
    const db = getDb();
    assertWorkspaceWriteAllowed(db, [input.sourcePath]);
    const root = findKnownWorkspaceRoot(db, input.sourcePath);
    if (!root) throw new Error('The sequence document is outside an active workspace.');
    const assertCurrent = () => assertWorkspaceContentPublicationWritable(db, event, root);
    assertCurrent();
    const resolveDocument = createNativeSequenceDocumentResolver({
      db: getDb,
      workspaceRoots: () => [root],
    });
    return withDeclaredRendererWorkspaceMutation({
      db,
      ownerId: event.sender.id,
      workspaceRoot: root,
      mutationPaths: [input.sourcePath],
      mutationToken: input.mutationToken,
      fileWrite: true,
      operation: (mutationLease) =>
        commitSequenceDocumentHistory(input, {
          db,
          assertCurrent,
          mutationLease,
          renderer: {
            ownerId: event.sender.id,
            ...(input.mutationToken ? { mutationToken: input.mutationToken } : {}),
          },
          resolve: (documentId) =>
            resolveDocument({ operationId: 'sequence-history', targetDocumentId: documentId }),
        }),
    });
  },
  publishSequenceMetadataRevision: async (event, input: SequenceMetadataRevisionRequest) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !input.document?.packageId ||
      !input.document?.packageRoot
    ) {
      throw new Error('The sequence metadata revision request is malformed.');
    }
    const { getDb } = await import('./database');
    const db = getDb();
    assertWorkspaceWriteAllowed(db, [input.document.packageRoot]);
    const root = findKnownWorkspaceRoot(db, input.document.packageRoot);
    if (!root) throw new Error('The sequence package is outside an active workspace.');
    assertWorkspaceContentPublicationWritable(db, event, root);
    const resolveDocument = createNativeSequenceDocumentResolver({
      db: getDb,
      workspaceRoots: () => [root],
    });
    const bound = await resolveDocument({
      operationId: input.operationId,
      targetDocumentId: input.document.packageId,
    });
    if (dirname(bound.sourcePath) !== input.document.packageRoot) {
      throw new Error('The requested package does not match the native document binding.');
    }
    const release = await acquireWorkspaceMutationShared(root);
    try {
      assertWorkspaceContentPublicationWritable(db, event, root);
      return await publishSequenceMetadataRevisionInMain(
        { workspaceRoot: root, request: input },
        createRegisteredSequencePackagePublicationContext({
          db,
          runDatabase: (work) => withRendererDatabaseStatement(db, event.sender, work),
        })
      );
    } finally {
      release();
    }
  },
  recoverLegacySequenceMetadataTransaction: async (
    event,
    packageRoot: string,
    mutationToken?: string
  ): Promise<void> => {
    const safePackageRoot = await assertSafePath(packageRoot, { requireAbsolute: true });
    const journal = await readLegacySequenceMetadataJournalInMain(safePackageRoot, safePackageRoot);
    if (!journal || journal.transaction.state === 'complete') return;
    const { getDb } = await import('./database');
    const db = getDb();
    const root = findKnownWorkspaceRoot(db, safePackageRoot);
    if (!root) throw new Error('Legacy sequence metadata recovery requires a writable workspace.');
    await withSafeWritablePath(safePackageRoot, (path) =>
      withDeclaredRendererFilesystemMutation({
        fileWrite: true,
        db,
        ownerId: event.sender.id,
        workspaceRoot: root,
        mutationPaths: [path],
        mutationToken,
        operation: () => recoverLegacySequenceMetadataTransactionInMain(root, path),
      })
    );
  },
  publishAcceptedAssemblyRevision: async (
    event,
    input: AcceptedAssemblyRevisionPublicationRequest
  ): Promise<AcceptedAssemblyRevisionPublicationResult> => {
    if (!input || typeof input !== 'object' || !input.packageRoot || !input.packageId) {
      throw new Error('The accepted assembly publication request is malformed.');
    }
    const { getDb } = await import('./database');
    const db = getDb();
    const root = findKnownWorkspaceRoot(db, input.packageRoot);
    if (!root || root !== findKnownWorkspaceRoot(db, input.workspaceRoot)) {
      throw new Error('The accepted assembly package is outside its declared workspace.');
    }
    assertWorkspaceContentPublicationWritable(db, event, root);
    return withDeclaredRendererWorkspaceMutation({
      fileWrite: true,
      db,
      ownerId: event.sender.id,
      workspaceRoot: root,
      mutationPaths: [input.packageRoot],
      mutationToken: input.mutationToken,
      operation: async () => {
        assertWorkspaceContentPublicationWritable(db, event, root);
        return publishAcceptedAssemblyRevisionInMain(
          { ...input, workspaceRoot: root },
          createRegisteredSequencePackagePublicationContext({
            db,
            runDatabase: (work) => withRendererDatabaseStatement(db, event.sender, work),
          })
        );
      },
    });
  },
  publishSequenceUserAttachmentMutation: async (
    event,
    input: SequenceUserAttachmentMutationRequest
  ): Promise<SequenceUserAttachmentMutationResult> => {
    if (
      !input ||
      typeof input !== 'object' ||
      !input.packageRoot ||
      !input.packageId ||
      !input.mutation
    ) {
      throw new Error('The user attachment revision request is malformed.');
    }
    const { getDb } = await import('./database');
    const db = getDb();
    const root = findKnownWorkspaceRoot(db, input.packageRoot);
    if (!root || root !== findKnownWorkspaceRoot(db, input.workspaceRoot)) {
      throw new Error('The user attachment package is outside its declared workspace.');
    }
    assertWorkspaceContentPublicationWritable(db, event, root);
    const resolveDocument = createNativeSequenceDocumentResolver({
      db: getDb,
      workspaceRoots: () => [root],
    });
    const bound = await resolveDocument({
      operationId: input.operationId,
      targetDocumentId: input.packageId,
    });
    if (dirname(bound.sourcePath) !== input.packageRoot) {
      throw new Error('The user attachment package does not match its native document binding.');
    }
    return withDeclaredRendererWorkspaceMutation({
      fileWrite: true,
      db,
      ownerId: event.sender.id,
      workspaceRoot: root,
      mutationPaths: [input.packageRoot],
      mutationToken: input.mutationToken,
      operation: (lease) =>
        withSequencePackageOwner(db, event.sender.id, root, input, lease, async () => {
          assertWorkspaceContentPublicationWritable(db, event, root);
          const receipt = await publishSequenceUserAttachmentMutationInMain(
            {
              ...input,
              workspaceRoot: root,
            },
            createRegisteredSequencePackagePublicationContext({
              db,
              runDatabase: (work) => withRendererDatabaseStatement(db, event.sender, work),
            })
          );
          return {
            revisionId: receipt.revisionId,
            alreadyPublished: receipt.alreadyPublished,
            snapshotPaths: receipt.snapshotPaths,
            assetPaths: receipt.assetPaths,
          };
        }),
    });
  },
  previewSequenceRestore: async (
    _event,
    input: SequenceRestorePreviewRequest
  ): Promise<SequenceRestorePreviewResult> => {
    if (!input || typeof input !== 'object' || !input.packageRoot) {
      throw new Error('Restore preview request is malformed.');
    }
    const { getDb } = await import('./database');
    const db = getDb();
    const root = findKnownWorkspaceRoot(db, input.packageRoot);
    if (!root || root !== findKnownWorkspaceRoot(db, input.workspaceRoot)) {
      throw new Error('Restore package is outside its declared workspace.');
    }
    return previewSequenceRestoreInMain({ ...input, workspaceRoot: root });
  },
  applySequenceRestore: async (
    event,
    input: SequenceRestoreApplyRequest
  ): Promise<SequenceRestoreApplyResult> => {
    if (!input || typeof input !== 'object' || !input.packageRoot) {
      throw new Error('Restore apply request is malformed.');
    }
    const { getDb } = await import('./database');
    const db = getDb();
    const root = findKnownWorkspaceRoot(db, input.packageRoot);
    if (!root || root !== findKnownWorkspaceRoot(db, input.workspaceRoot)) {
      throw new Error('Restore package is outside its declared workspace.');
    }
    assertWorkspaceContentPublicationWritable(db, event, root);
    return withDeclaredRendererWorkspaceMutation({
      fileWrite: true,
      db,
      ownerId: event.sender.id,
      workspaceRoot: root,
      mutationPaths: [input.packageRoot],
      mutationToken: input.mutationToken,
      operation: (lease) =>
        withSequencePackageOwner(db, event.sender.id, root, input, lease, async () => {
          assertWorkspaceContentPublicationWritable(db, event, root);
          return applySequenceRestoreInMain(
            { ...input, workspaceRoot: root },
            createRegisteredSequencePackagePublicationContext({
              db,
              runDatabase: (work) => withRendererDatabaseStatement(db, event.sender, work),
            })
          );
        }),
    });
  },
  prepareSequenceEvidenceRun: async (
    event,
    input: PrepareSequenceEvidenceRunRequest
  ): Promise<PrepareSequenceEvidenceRunResult> => {
    if (!input || typeof input !== 'object' || !input.packageRoot) {
      throw new Error('Evidence preparation request is malformed.');
    }
    const { getDb } = await import('./database');
    const db = getDb();
    const root = findKnownWorkspaceRoot(db, input.packageRoot);
    if (!root || root !== findKnownWorkspaceRoot(db, input.workspaceRoot)) {
      throw new Error('Evidence package is outside its declared workspace.');
    }
    assertWorkspaceContentPublicationWritable(db, event, root);
    if (!Array.isArray(input.queries)) throw new Error('Evidence queries are malformed.');
    const queryPaths = await Promise.all(
      input.queries.map(async (query) => {
        const path = await assertSafePath(query.path, {
          requireAbsolute: true,
          errorPrefix: 'sequence-evidence-query',
        });
        const owner = findKnownWorkspaceRoot(db, path);
        if (owner && owner !== root)
          throw new Error('The alignment query belongs to another project.');
        return { path, owned: owner === root };
      })
    );
    const assertCurrent = () => {
      assertWorkspaceContentPublicationWritable(db, event, root);
      for (const query of queryPaths) {
        const owner = findKnownWorkspaceRoot(db, query.path);
        if (owner !== root && (query.owned || owner !== null))
          throw new Error('The alignment query project owner changed.');
      }
    };
    return withDeclaredRendererWorkspaceMutation({
      fileWrite: true,
      db,
      ownerId: event.sender.id,
      workspaceRoot: root,
      mutationPaths: [
        input.packageRoot,
        ...queryPaths.filter((query) => query.owned).map((query) => query.path),
      ],
      mutationToken: input.mutationToken,
      operation: async (lease) => {
        const prepared = await withSequencePackageOwner(
          db,
          event.sender.id,
          root,
          input,
          lease,
          async () => {
            assertCurrent();
            return prepareSequenceEvidenceRunInMain(
              { ...input, workspaceRoot: root },
              undefined,
              (path) =>
                assertSafePath(path, {
                  requireAbsolute: true,
                  errorPrefix: 'sequence-evidence-query',
                }),
              assertCurrent
            );
          }
        );
        try {
          await retireSequenceEvidenceQuerySources({ ...input, workspaceRoot: root }, prepared, {
            db,
            renderer: {
              ownerId: event.sender.id,
              ...(input.mutationToken ? { mutationToken: input.mutationToken } : {}),
            },
            mutationLease: lease,
            assertCurrent,
            documents: nativeDocuments.fileDocuments,
            assertMutationAllowed: async (paths) => {
              assertCurrent();
              await assertUnversionedRendererFilesystemMutationAllowed(db, event.sender.id, paths);
            },
            runDatabase: (operation) => withRendererDatabaseStatement(db, event.sender, operation),
          });
        } catch (error) {
          if (!(error instanceof SharedProjectViewOnlyError)) throw error;
          return { ...prepared, sourceRetirement: { status: 'retained', reason: 'view-only' } };
        }
        return prepared;
      },
    });
  },
  activateSequenceEvidenceRun: async (event, input: ActivateSequenceEvidenceRunRequest) => {
    if (!input || typeof input !== 'object' || !input.packageRoot) {
      throw new Error('Evidence activation request is malformed.');
    }
    const { getDb } = await import('./database');
    const db = getDb();
    const root = findKnownWorkspaceRoot(db, input.packageRoot);
    if (!root || root !== findKnownWorkspaceRoot(db, input.workspaceRoot)) {
      throw new Error('Evidence package is outside its declared workspace.');
    }
    assertWorkspaceContentPublicationWritable(db, event, root);
    await withDeclaredRendererWorkspaceMutation({
      fileWrite: true,
      db,
      ownerId: event.sender.id,
      workspaceRoot: root,
      mutationPaths: [input.packageRoot],
      mutationToken: input.mutationToken,
      operation: (lease) =>
        withSequencePackageOwner(db, event.sender.id, root, input, lease, async () => {
          assertWorkspaceContentPublicationWritable(db, event, root);
          return activateSequenceEvidenceRunInMain({ ...input, workspaceRoot: root }, () =>
            assertWorkspaceContentPublicationWritable(db, event, root)
          );
        }),
    });
  },
  completeSequenceEvidenceRun: async (
    event,
    input: CompleteSequenceEvidenceRunRequest
  ): Promise<CompleteSequenceEvidenceRunResult> => {
    if (!input || typeof input !== 'object' || !input.packageRoot) {
      throw new Error('Evidence completion request is malformed.');
    }
    const { getDb } = await import('./database');
    const db = getDb();
    const root = findKnownWorkspaceRoot(db, input.packageRoot);
    if (!root || root !== findKnownWorkspaceRoot(db, input.workspaceRoot)) {
      throw new Error('Evidence package is outside its declared workspace.');
    }
    assertWorkspaceContentPublicationWritable(db, event, root);
    return withDeclaredRendererWorkspaceMutation({
      fileWrite: true,
      db,
      ownerId: event.sender.id,
      workspaceRoot: root,
      mutationPaths: [input.packageRoot],
      mutationToken: input.mutationToken,
      operation: (lease) =>
        withSequencePackageOwner(db, event.sender.id, root, input, lease, async () => {
          assertWorkspaceContentPublicationWritable(db, event, root);
          return completeSequenceEvidenceRunInMain({ ...input, workspaceRoot: root }, () =>
            assertWorkspaceContentPublicationWritable(db, event, root)
          );
        }),
    });
  },
  failSequenceEvidenceRun: async (event, input: FailSequenceEvidenceRunRequest): Promise<void> => {
    if (!input || typeof input !== 'object' || !input.packageRoot) {
      throw new Error('Evidence failure request is malformed.');
    }
    const { getDb } = await import('./database');
    const db = getDb();
    const root = findKnownWorkspaceRoot(db, input.packageRoot);
    if (!root || root !== findKnownWorkspaceRoot(db, input.workspaceRoot)) {
      throw new Error('Evidence package is outside its declared workspace.');
    }
    assertWorkspaceContentPublicationWritable(db, event, root);
    await withDeclaredRendererWorkspaceMutation({
      fileWrite: true,
      db,
      ownerId: event.sender.id,
      workspaceRoot: root,
      mutationPaths: [input.packageRoot],
      mutationToken: input.mutationToken,
      operation: (lease) =>
        withSequencePackageOwner(db, event.sender.id, root, input, lease, async () => {
          assertWorkspaceContentPublicationWritable(db, event, root);
          return failSequenceEvidenceRunInMain({ ...input, workspaceRoot: root }, () =>
            assertWorkspaceContentPublicationWritable(db, event, root)
          );
        }),
    });
  },
  appendSequenceEvidenceState: async (
    event,
    input: AppendSequenceEvidenceStateRequest
  ): Promise<AppendSequenceEvidenceStateResult> => {
    if (!input || typeof input !== 'object' || !input.packageRoot) {
      throw new Error('Evidence state request is malformed.');
    }
    const { getDb } = await import('./database');
    const db = getDb();
    const root = findKnownWorkspaceRoot(db, input.packageRoot);
    if (!root || root !== findKnownWorkspaceRoot(db, input.workspaceRoot)) {
      throw new Error('Evidence package is outside its declared workspace.');
    }
    assertWorkspaceContentPublicationWritable(db, event, root);
    return withDeclaredRendererWorkspaceMutation({
      fileWrite: true,
      db,
      ownerId: event.sender.id,
      workspaceRoot: root,
      mutationPaths: [input.packageRoot],
      mutationToken: input.mutationToken,
      operation: (lease) =>
        withSequencePackageOwner(db, event.sender.id, root, input, lease, async () => {
          assertWorkspaceContentPublicationWritable(db, event, root);
          return appendSequenceEvidenceStateInMain({ ...input, workspaceRoot: root }, () =>
            assertWorkspaceContentPublicationWritable(db, event, root)
          );
        }),
    });
  },
};
