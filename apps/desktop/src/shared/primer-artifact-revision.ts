import type { LimsEntity } from './lims';
import type {
  PrimerArtifactV1,
  PrimerArtifactBindingV1,
  PrimerArtifactContentRevisionInput,
} from './primers/primer-artifact';
import type { Primer } from './primers/types';

export type PrimerArtifactRevisionChange =
  | {
      type: 'content';
      content: Omit<
        PrimerArtifactContentRevisionInput,
        'actor' | 'entitySchema' | 'entityState'
      > & {
        status?: Primer['status'];
      };
    }
  | {
      type: 'bindings_replace_owned';
      ownedBindingIds: string[];
      targetDocumentId: string;
      bindings: PrimerArtifactBindingV1[];
    }
  | { type: 'binding_add'; binding: PrimerArtifactBindingV1 }
  | { type: 'binding_update'; bindingId: string; binding: PrimerArtifactBindingV1 }
  | { type: 'binding_remove'; bindingId: string }
  | { type: 'archive' }
  | { type: 'restore'; status: Exclude<Primer['status'], 'archived'> };
export interface PrimerArtifactRevisionRequest {
  entityId: string;
  operationId: string;
  expectedEventSeq: number;
  expectedContentHash: string;
  change: PrimerArtifactRevisionChange;
}

export interface PrimerArtifactRevisionResult {
  entity: LimsEntity;
  artifact: PrimerArtifactV1;
  replayed: boolean;
  changed: boolean;
  unchangedReason?: 'duplicate_binding' | 'missing_binding' | 'unchanged_owned_bindings';
  bindingId?: string;
}

export interface PrimerArtifactRevisionStateRequest {
  entityId: string;
  mutationToken?: string;
}
export type PrimerArtifactRevisionCommand = PrimerArtifactRevisionRequest & {
  mutationToken?: string;
};
export interface PrimerArtifactPublicationResumeRequest extends PrimerArtifactRevisionStateRequest {
  operationId: string;
}
export type PrimerArtifactRevisionState =
  | { state: 'not_enrolled' }
  | {
      state: 'ready';
      entity: LimsEntity;
      artifact: PrimerArtifactV1;
      expectedEventSeq: number;
      expectedContentHash: string;
      workspaceId: number;
      relativePath: string;
    }
  | {
      state: 'pending';
      operationId: string;
      entityId: string;
      workspaceId: number;
      relativePath: string;
      name: string;
      artifactRevision: number;
    };
