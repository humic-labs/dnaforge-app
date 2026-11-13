import type {
  CanonicalJson,
  OperationId,
  ResourceId,
  ResourceRevisionId,
  ResourceStateHash,
} from './identity';
import type {
  ImmutableRecordWrite,
  RecoveryCandidateView,
  ReplayView,
  ResourceOrigin,
  WorkspaceVersionView,
} from './types';
import type { WorkspaceIndexes } from './workspace-index';

export interface ResourceRevisionView {
  readonly id: ResourceRevisionId;
  readonly resourceId: ResourceId;
  readonly stateHash: ResourceStateHash | null;
  readonly parentIds: readonly ResourceRevisionId[];
  readonly origin: ResourceOrigin | null;
  readonly tombstone: boolean;
}

export interface ResourceRevisionRecord {
  readonly view: ResourceRevisionView;
  readonly canonicalJson: CanonicalJson;
}

export interface WorkspaceVersionRecord {
  readonly view: WorkspaceVersionView;
  readonly canonicalJson: CanonicalJson;
  readonly indexes: WorkspaceIndexes;
}

export interface OperationReceiptRecord {
  readonly operationId: OperationId;
  readonly requestCanonicalJson: CanonicalJson;
  readonly replay: ReplayView;
  readonly write: ImmutableRecordWrite;
}

export interface RecoveryCandidateRecord {
  readonly view: RecoveryCandidateView;
  readonly canonicalJson: CanonicalJson;
}
