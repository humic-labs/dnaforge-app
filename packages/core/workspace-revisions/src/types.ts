import type {
  Brand,
  CanonicalJson,
  MemberId,
  OperationId,
  OperationReceiptId,
  RecoveryCandidateId,
  RefName,
  ResourceId,
  ResourcePath,
  ResourceRevisionId,
  ResourceStateHash,
  WorkspaceId,
  WorkspacePath,
  WorkspacePathRootId,
  WorkspaceResourceRootId,
  WorkspaceVersionId,
} from './identity';
import type { BlobRef } from './hash';

export type NonEmpty<Value> = readonly [Value, ...Value[]];

export type CanonicalScalar = null | boolean | string | number;
export type CanonicalValue =
  | CanonicalScalar
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };
export type CanonicalMap = Readonly<Record<string, CanonicalValue>>;

export type ResourceLayout = 'file' | 'directory';

export type WorkspaceLocator = Readonly<{
  workspaceId: WorkspaceId;
  versionId?: WorkspaceVersionId;
}>;

export type ResourceLocator = Readonly<{
  workspaceId: WorkspaceId;
  resourceId: ResourceId;
  revisionId?: ResourceRevisionId;
}>;

export interface ResourceMemberInput {
  readonly memberId: MemberId;
  readonly relativePath: ResourcePath;
  readonly mediaType: string;
  readonly blob: BlobRef;
  readonly materialMetadata?: CanonicalMap;
}

export type ResourceStateInput =
  | {
      readonly layout: 'file';
      readonly resourceKind: string;
      readonly mediaType: string;
      readonly blob: BlobRef;
      readonly materialMetadata?: CanonicalMap;
    }
  | {
      readonly layout: 'directory';
      readonly resourceKind: string;
      readonly format: string;
      readonly members: readonly ResourceMemberInput[];
      readonly materialMetadata?: CanonicalMap;
    };

export type ResourceState = Brand<Readonly<object>, 'ResourceState'>;
export type RevisionGraph = Brand<Readonly<object>, 'RevisionGraph'>;

export type ResourceOrigin =
  | { readonly kind: 'created' }
  | {
      readonly kind: 'derived';
      readonly relation: 'copy' | 'fork' | 'template' | 'split' | 'merge' | 'lossy-conversion';
      readonly sources: NonEmpty<ResourceRevisionId>;
    };

export type WorkspaceMutation =
  | {
      readonly kind: 'create-resource';
      readonly resourceId: ResourceId;
      readonly path: WorkspacePath;
      readonly state: ResourceState;
      readonly origin: ResourceOrigin;
    }
  | {
      readonly kind: 'edit-resource';
      readonly resourceId: ResourceId;
      readonly expectedRevision: ResourceRevisionId;
      readonly state: ResourceState;
    }
  | {
      readonly kind: 'revert-resource';
      readonly resourceId: ResourceId;
      readonly expectedRevision: ResourceRevisionId;
      readonly restoreFromRevision: ResourceRevisionId;
    }
  | {
      readonly kind: 'move-resource';
      readonly resourceId: ResourceId;
      readonly expectedPath: WorkspacePath;
      readonly destination: WorkspacePath;
    }
  | {
      readonly kind: 'edit-and-move-resource';
      readonly resourceId: ResourceId;
      readonly expectedRevision: ResourceRevisionId;
      readonly expectedPath: WorkspacePath;
      readonly state: ResourceState;
      readonly destination: WorkspacePath;
    }
  | {
      readonly kind: 'remove-membership';
      readonly resourceId: ResourceId;
      readonly expectedRevision: ResourceRevisionId;
      readonly expectedPath: WorkspacePath;
    }
  | {
      readonly kind: 'delete-resource';
      readonly resourceId: ResourceId;
      readonly expectedRevision: ResourceRevisionId;
      readonly expectedPath: WorkspacePath;
    }
  | {
      readonly kind: 'restore-resource';
      readonly resourceId: ResourceId;
      readonly expectedTombstoneRevision: ResourceRevisionId;
      readonly restoreFromRevision: ResourceRevisionId;
      readonly destination: WorkspacePath;
    }
  | {
      readonly kind: 'restore-and-edit-resource';
      readonly resourceId: ResourceId;
      readonly expectedTombstoneRevision: ResourceRevisionId;
      readonly restoreFromRevision: ResourceRevisionId;
      readonly destination: WorkspacePath;
      readonly state: ResourceState;
    };

export type ImmutableRecordKind =
  | 'resource-state'
  | 'resource-revision'
  | 'workspace-version'
  | 'operation-receipt'
  | 'recovery-candidate'
  | 'workspace-resource-map-node'
  | 'workspace-path-map-node';

export interface ImmutableRecordWrite {
  readonly kind: ImmutableRecordKind;
  readonly id:
    | ResourceStateHash
    | ResourceRevisionId
    | WorkspaceVersionId
    | OperationReceiptId
    | RecoveryCandidateId
    | WorkspaceResourceRootId
    | WorkspacePathRootId;
  readonly canonicalJson: CanonicalJson;
}

export interface RefAdvance {
  readonly workspaceId: WorkspaceId;
  readonly refName: RefName;
  readonly expected: WorkspaceVersionId | null;
  readonly next: WorkspaceVersionId;
}

export interface PublicationPlan {
  readonly recordWrites: NonEmpty<ImmutableRecordWrite>;
  readonly refAdvance: RefAdvance;
}

export interface WorkspaceResourceSlotView {
  readonly resourceId: ResourceId;
  readonly revisionId: ResourceRevisionId;
  readonly path: WorkspacePath | null;
  readonly lastPath: WorkspacePath | null;
  readonly tombstone: boolean;
}

export interface WorkspaceVersionView {
  readonly id: WorkspaceVersionId;
  readonly parentIds: readonly WorkspaceVersionId[];
  readonly resourceRoot: WorkspaceResourceRootId | null;
  readonly materializedPathRoot: WorkspacePathRootId | null;
  readonly resourceCount: number;
  readonly materializedPathCount: number;
}

export interface MutationEffects {
  readonly resourceState: 'created' | 'reused' | 'none';
  readonly resourceRevision: 'created' | 'reused' | 'none';
  readonly workspaceVersion: 'created' | 'reused';
}

export type NoOpReason = 'state-unchanged' | 'already-at-destination' | 'membership-already-absent';
export type ReplayNoOpReason = NoOpReason | 'sources-already-converged';

export type ReplayView =
  | {
      readonly operationId: OperationId;
      readonly outcome: 'changed';
      readonly version: WorkspaceVersionView;
      readonly effects: MutationEffects;
      readonly publication: PublicationPlan;
    }
  | {
      readonly operationId: OperationId;
      readonly outcome: 'no-op';
      readonly head: WorkspaceVersionId | null;
      readonly reason: ReplayNoOpReason;
      readonly recordWrites: NonEmpty<ImmutableRecordWrite>;
    }
  | {
      readonly operationId: OperationId;
      readonly outcome: 'conflict';
      readonly conflicts: NonEmpty<Conflict>;
      readonly recordWrites: NonEmpty<ImmutableRecordWrite>;
    }
  | {
      readonly operationId: OperationId;
      readonly outcome: 'rejected';
      readonly error: MutationError | RecoveryError;
      readonly recordWrites: NonEmpty<ImmutableRecordWrite>;
    }
  | {
      readonly operationId: OperationId;
      readonly outcome: 'recovery-candidate';
      readonly candidate: RecoveryCandidateView;
      readonly recordWrites: NonEmpty<ImmutableRecordWrite>;
    };

export type Conflict =
  | {
      readonly kind: 'ref-head-mismatch';
      readonly expected: WorkspaceVersionId | null;
      readonly actual: WorkspaceVersionId | null;
    }
  | {
      readonly kind: 'resource-conflict';
      readonly resourceId: ResourceId;
      readonly reason:
        | 'edit-edit'
        | 'rename-rename'
        | 'delete-edit'
        | 'move-delete'
        | 'membership-remove-edit'
        | 'identity-conflict';
    }
  | {
      readonly kind: 'path-conflict';
      readonly paths: NonEmpty<WorkspacePath>;
    };

export type MutationError =
  | { readonly kind: 'operation-id-reused'; readonly operationId: OperationId }
  | { readonly kind: 'invalid-mutation'; readonly reason: string };

export type ApplyMutationResult =
  | {
      readonly kind: 'changed';
      readonly graph: RevisionGraph;
      readonly version: WorkspaceVersionView;
      readonly effects: MutationEffects;
      readonly publication: PublicationPlan;
    }
  | {
      readonly kind: 'no-op';
      readonly graph: RevisionGraph;
      readonly head: WorkspaceVersionId | null;
      readonly reason: NoOpReason;
      readonly recordWrites: NonEmpty<ImmutableRecordWrite>;
    }
  | {
      readonly kind: 'replay';
      readonly graph: RevisionGraph;
      readonly original: ReplayView;
    }
  | {
      readonly kind: 'conflict';
      readonly graph: RevisionGraph;
      readonly conflicts: NonEmpty<Conflict>;
      readonly recordWrites: NonEmpty<ImmutableRecordWrite>;
    }
  | {
      readonly kind: 'rejected';
      readonly graph: RevisionGraph;
      readonly error: MutationError;
      readonly recordWrites: readonly ImmutableRecordWrite[];
    };

export interface RecoveryCandidateView {
  readonly id: RecoveryCandidateId;
  readonly workspaceId: WorkspaceId;
  readonly operationId: OperationId;
  readonly status: 'valid-unaccepted' | 'invalid';
}

export interface RecoveryPayload {
  readonly role: 'observed-bytes' | 'supporting-file';
  readonly mediaType: string;
  readonly blob: BlobRef;
}

export type RecoveryFailure =
  | { readonly kind: 'parse-failed'; readonly code: string }
  | { readonly kind: 'identity-conflict'; readonly code: string }
  | { readonly kind: 'materialization-conflict'; readonly code: string };

export type RecoveryCandidateInput =
  | {
      readonly kind: 'invalid-working-state';
      readonly workspaceId: WorkspaceId;
      readonly claimedResourceId: ResourceId | null;
      readonly baseRevisionId: ResourceRevisionId | null;
      readonly observedPath: WorkspacePath;
      readonly payloads: NonEmpty<RecoveryPayload>;
      readonly failure: RecoveryFailure;
      readonly expiresAtEpochMs: number;
    }
  | {
      readonly kind: 'divergent-workspace';
      readonly workspaceId: WorkspaceId;
      readonly baseVersionId: WorkspaceVersionId;
      readonly candidateVersionId: WorkspaceVersionId;
      readonly acceptedVersionId: WorkspaceVersionId;
      readonly expiresAtEpochMs: number;
    };

export interface RecoveryInput {
  readonly graph: RevisionGraph;
  readonly operationId: OperationId;
  readonly candidate: RecoveryCandidateInput;
}

export type RecoveryError =
  | { readonly kind: 'operation-id-reused'; readonly operationId: OperationId }
  | { readonly kind: 'workspace-mismatch' }
  | { readonly kind: 'invalid-expiry' }
  | { readonly kind: 'invalid-payload' }
  | { readonly kind: 'invalid-recovery-reference' };

export type CaptureRecoveryResult =
  | {
      readonly kind: 'captured';
      readonly graph: RevisionGraph;
      readonly candidate: RecoveryCandidateView;
      readonly recordWrites: NonEmpty<ImmutableRecordWrite>;
    }
  | {
      readonly kind: 'replay';
      readonly graph: RevisionGraph;
      readonly original: ReplayView;
    }
  | {
      readonly kind: 'rejected';
      readonly graph: RevisionGraph;
      readonly error: RecoveryError;
    };
