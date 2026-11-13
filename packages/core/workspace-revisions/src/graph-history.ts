import type {
  OperationReceiptRecord,
  RecoveryCandidateRecord,
  ResourceRevisionRecord,
  WorkspaceVersionRecord,
} from './graph-records';
import type {
  OperationId,
  RecoveryCandidateId,
  ResourceRevisionId,
  ResourceStateHash,
  WorkspaceVersionId,
} from './identity';
import { PersistentIndex, persistentIndexFrom } from './persistent-index';
import type { ResourceStateRecord } from './resource-state';

export interface RevisionHistoryIndexes {
  readonly resourceStates: PersistentIndex<ResourceStateHash, ResourceStateRecord>;
  readonly resourceRevisions: PersistentIndex<ResourceRevisionId, ResourceRevisionRecord>;
  readonly workspaceVersions: PersistentIndex<WorkspaceVersionId, WorkspaceVersionRecord>;
  readonly operationReceipts: PersistentIndex<OperationId, OperationReceiptRecord>;
  readonly recoveryCandidates: PersistentIndex<RecoveryCandidateId, RecoveryCandidateRecord>;
}

export function emptyRevisionHistoryIndexes(): RevisionHistoryIndexes {
  return {
    resourceStates: PersistentIndex.empty('resource-states', (record) => record.hash),
    resourceRevisions: PersistentIndex.empty('resource-revisions', (record) => record.view.id),
    workspaceVersions: PersistentIndex.empty('workspace-versions', (record) => record.view.id),
    operationReceipts: PersistentIndex.empty('operation-receipts', (record) => record.write.id),
    recoveryCandidates: PersistentIndex.empty('recovery-candidates', (record) => record.view.id),
  };
}

export function revisionHistoryIndexesFrom(input: {
  readonly resourceStates: Iterable<readonly [ResourceStateHash, ResourceStateRecord]>;
  readonly resourceRevisions: Iterable<readonly [ResourceRevisionId, ResourceRevisionRecord]>;
  readonly workspaceVersions: Iterable<readonly [WorkspaceVersionId, WorkspaceVersionRecord]>;
  readonly operationReceipts: Iterable<readonly [OperationId, OperationReceiptRecord]>;
  readonly recoveryCandidates: Iterable<readonly [RecoveryCandidateId, RecoveryCandidateRecord]>;
}): RevisionHistoryIndexes {
  return {
    resourceStates: persistentIndexFrom({
      domainName: 'resource-states',
      valueIdentity: (record) => record.hash,
      entries: input.resourceStates,
    }),
    resourceRevisions: persistentIndexFrom({
      domainName: 'resource-revisions',
      valueIdentity: (record) => record.view.id,
      entries: input.resourceRevisions,
    }),
    workspaceVersions: persistentIndexFrom({
      domainName: 'workspace-versions',
      valueIdentity: (record) => record.view.id,
      entries: input.workspaceVersions,
    }),
    operationReceipts: persistentIndexFrom({
      domainName: 'operation-receipts',
      valueIdentity: (record) => record.write.id,
      entries: input.operationReceipts,
    }),
    recoveryCandidates: persistentIndexFrom({
      domainName: 'recovery-candidates',
      valueIdentity: (record) => record.view.id,
      entries: input.recoveryCandidates,
    }),
  };
}
