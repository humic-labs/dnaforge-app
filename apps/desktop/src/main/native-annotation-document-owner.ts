import { captureNativeAnnotationWriteAuthority } from './native-annotation-write-authority';
import type Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { WorkspaceFilePublicationUncertainError } from './primer-artifact-files';
import type {
  ManagedDocumentOperationTarget,
  ManagedDocumentSelection,
} from '@waypoint/domain-services';
import {
  assertManagedAnnotationAuthority,
  type ManagedAnnotationInspection,
} from '../shared/annotation-managed-operation-contract';
import { NativeAnnotationDocumentActionClient } from './managed-annotation-document-client';
import {
  NativeAnnotationDocumentCommands,
  type NativeAnnotationDocument,
  type NativeAnnotationDocumentBarrier,
  type NativeAnnotationDocumentSaveOutcome,
} from './managed-annotation-document-command';
import { createNativeSequenceDocumentResolver } from './native-sequence-document-resolver';
import {
  prepareEnrolledNativeSequenceContent,
  saveEnrolledNativeSequenceEdit,
} from './scientific-sequence-save';
import { NativeDocumentRecoveryClient } from './native-document-recovery-client';
import {
  NativeAnnotationDocumentRecovery,
  observeNativeDocumentCheckpoint,
  type NativeDocumentRecoveryOutcome,
  type PendingNativeDocumentAction,
} from './native-document-recovery';
import type { SidecarFetch } from './sidecar-request-auth';
import {
  commitOwnedPathsIfDirty,
  flushManagedCommitDurably,
  resolveHeadCommit,
} from './workspace-git';
import {
  appendZeroCoordinateSequenceEditAdvance,
  resolveSequenceEditLineage,
} from './sequence-edit-lineage';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';

interface AdmittedAnnotationDocumentRequest {
  actionId: string;
  requestSha256: string;
  selection: ManagedDocumentSelection;
}

interface NativeAnnotationDocumentOwnerOptions {
  nativeOwnerInstanceId: string;
  db(): Database.Database;
  workspaceRoots(): readonly string[];
  fetch: SidecarFetch;
  prepare(
    actionId: string,
    document: NativeAnnotationDocument
  ): Promise<NativeAnnotationDocumentBarrier>;
}

type NativeActionOutcome = NativeAnnotationDocumentSaveOutcome | NativeDocumentRecoveryOutcome;

export class NativeAnnotationDocumentOwner {
  private readonly resolve: ReturnType<typeof createNativeSequenceDocumentResolver>;
  private readonly recoveryClient: NativeDocumentRecoveryClient;
  private readonly options: NativeAnnotationDocumentOwnerOptions;
  private readonly active = new Map<
    string,
    { key: string; promise: Promise<NativeActionOutcome> }
  >();
  private readonly inspections = new Set<Promise<ManagedAnnotationInspection>>();
  private closed = false;

  constructor(options: NativeAnnotationDocumentOwnerOptions) {
    this.options = { ...options };
    this.resolve = createNativeSequenceDocumentResolver(options);
    this.recoveryClient = new NativeDocumentRecoveryClient(options);
  }

  async inspect(
    input: ManagedDocumentOperationTarget,
    trustedAuthority: unknown
  ): Promise<ManagedAnnotationInspection> {
    this.assertOpen();
    if (this.inspections.size >= 8)
      throw new Error('The native document owner is at its active inspection limit.');
    const target = { ...input };
    const authority: unknown = structuredClone(trustedAuthority);
    assertManagedAnnotationAuthority(target, authority);
    const readOnly = async (): Promise<never> => {
      throw new Error('Inspection cannot perform a document write.');
    };
    const commands = new NativeAnnotationDocumentCommands({
      resolve: this.resolve,
      authorize: async () => authority,
      prepare: readOnly,
      checkpoint: readOnly,
      recordWriteIntent: readOnly,
      recordOutcome: readOnly,
      recordLineageAdvance: readOnly,
      resolveLineage: (lineage) =>
        resolveSequenceEditLineage({
          db: this.options.db(),
          entityId: lineage.documentId,
          currentFileSha256: lineage.currentFileSha256,
          analyzedInputRevision: lineage.analyzedInputRevision,
          currentInputRevision: lineage.currentInputRevision,
        }),
    });
    const inspection = commands.inspect(target).finally(() => {
      this.inspections.delete(inspection);
    });
    this.inspections.add(inspection);
    return inspection;
  }

  apply(input: AdmittedAnnotationDocumentRequest): Promise<NativeAnnotationDocumentSaveOutcome> {
    const request = {
      ...input,
      selection: {
        ...input.selection,
        selectedCandidateIds: [...input.selection.selectedCandidateIds],
      },
    };
    const key = JSON.stringify([
      'apply',
      request.requestSha256,
      request.selection.operationId,
      request.selection.targetDocumentId,
      request.selection.expectedOperationVersion,
      request.selection.expectedResultSha256,
      request.selection.expectedTargetDocumentRevision,
      [...request.selection.selectedCandidateIds].sort(),
    ]);
    return this.run(request.actionId, key, async () => {
      const client = new NativeAnnotationDocumentActionClient({
        ...request,
        fetch: this.options.fetch,
      });
      let expectedHead: string | null = null;
      let acceptedPublicationPaths: readonly string[] | null = null;
      let assertAcceptanceAuthority: (() => void) | null = null;
      const createdAt = new Date().toISOString();
      const commands = new NativeAnnotationDocumentCommands({
        resolve: this.resolve,
        authorize: client.authorize,
        recordWriteIntent: client.recordWriteIntent,
        recordOutcome: async (settlement) => {
          await client.settle(settlement);
        },
        recordLineageAdvance: async (lineage) => {
          if (acceptedPublicationPaths) return;
          const db = this.options.db();
          const releaseDatabase = await acquireWorkspaceSyncDatabaseFence(db);
          try {
            appendZeroCoordinateSequenceEditAdvance({
              db,
              entityId: lineage.documentId,
              ...lineage,
            });
          } finally {
            releaseDatabase();
          }
        },
        resolveLineage: (lineage) =>
          resolveSequenceEditLineage({
            db: this.options.db(),
            entityId: lineage.documentId,
            currentFileSha256: lineage.currentFileSha256,
            analyzedInputRevision: lineage.analyzedInputRevision,
            currentInputRevision: lineage.currentInputRevision,
          }),
        prepare: async (document) => {
          const writeAuthority = await captureNativeAnnotationWriteAuthority({
            db: this.options.db,
            resolve: this.resolve,
            target: request.selection,
            document,
          });
          assertAcceptanceAuthority = writeAuthority.assertAcceptanceCurrent;
          const original = await this.options.prepare(request.actionId, document);
          const barrier: NativeAnnotationDocumentBarrier = {
            assertCurrent() {
              writeAuthority.assertCurrent();
              original.assertCurrent();
            },
            finish: () => original.finish(),
            abort: (disposition) => original.abort(disposition),
          };
          try {
            expectedHead = await resolveHeadCommit(document.workspaceRoot);
            barrier.assertCurrent();
            return barrier;
          } catch (error) {
            barrier.abort('unchanged');
            throw error;
          }
        },
        prepareContentForSave: async (document, content, actionId) =>
          prepareEnrolledNativeSequenceContent({
            db: this.options.db(),
            document,
            content,
            operationId: `native-annotation-apply:${actionId}`,
          }),
        publishEnrolled: async ({
          document,
          content,
          expectedContentHash,
          actionId,
          mutationLease,
          assertCurrent,
        }) => {
          const acceptanceAuthority = assertAcceptanceAuthority;
          if (!acceptanceAuthority)
            throw new Error('The annotation write authority was not captured before publication.');
          assertCurrent();
          const result = await saveEnrolledNativeSequenceEdit({
            db: this.options.db(),
            document,
            content,
            expectedContentHash,
            operationId: `native-annotation-apply:${actionId}`,
            createdAt,
            mutationLease,
            beforeAccept: acceptanceAuthority,
          });
          if (!result) return false;
          if (result.status === 'unbound')
            throw new Error('The accepted annotation publication lost its document binding.');
          acceptedPublicationPaths = result.publicationPaths ?? [document.sourcePath];
          if (result.status === 'accepted-pending')
            throw new WorkspaceFilePublicationUncertainError(
              `Annotation Apply accepted; ${result.reason}`
            );
          return true;
        },
        checkpoint: async (document) => {
          const paths = acceptedPublicationPaths
            ? acceptedPublicationPaths.map((path) => resolve(document.workspaceRoot, path))
            : [document.sourcePath];
          const commit = await commitOwnedPathsIfDirty(
            document.workspaceRoot,
            'Apply retained annotations',
            { expectedHead, paths }
          );
          if (!commit)
            return { status: 'failed', reason: 'The saved file produced no new Git checkpoint.' };
          await flushManagedCommitDurably(document.workspaceRoot, commit, paths);
          return { status: 'committed', commit };
        },
      });
      return commands.apply(request.selection, request.actionId);
    });
  }

  async pending(afterActionId?: string) {
    this.assertOpen();
    return this.recoveryClient.pending(afterActionId);
  }

  recover(action: PendingNativeDocumentAction): Promise<NativeDocumentRecoveryOutcome> {
    const snapshot = structuredClone(action);
    return this.run(snapshot.id, JSON.stringify({ kind: 'recover', action: snapshot }), () => {
      const recovery = new NativeAnnotationDocumentRecovery({
        nativeOwnerInstanceId: this.options.nativeOwnerInstanceId,
        resolve: this.resolve,
        prepare: (document) => this.options.prepare(snapshot.id, document),
        observeCheckpoint: observeNativeDocumentCheckpoint,
        recordObservation: (current, settlement) =>
          this.recoveryClient.recover(current, settlement),
      });
      return recovery.recover(snapshot);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([
      ...[...this.active.values()].map((entry) => entry.promise),
      ...this.inspections,
    ]);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('The native document owner has stopped accepting commands.');
  }

  private run<T extends NativeActionOutcome>(
    id: string,
    key: string,
    operation: () => Promise<T>
  ): Promise<T> {
    this.assertOpen();
    const existing = this.active.get(id);
    if (existing) {
      if (existing.key !== key)
        throw new Error('This action is already running with a different request.');

      return existing.promise as Promise<T>;
    }
    if (this.active.size >= 8)
      throw new Error('The native document owner is at its active action limit.');
    const promise = Promise.resolve()
      .then(operation)
      .finally(() => {
        this.active.delete(id);
      });
    this.active.set(id, { key, promise });
    return promise;
  }
}
