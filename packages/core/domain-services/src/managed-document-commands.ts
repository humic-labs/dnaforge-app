export interface ManagedDocumentOperationTarget {
  readonly operationId: string;
  readonly targetDocumentId: string;
}

export interface ManagedDocumentSelection extends ManagedDocumentOperationTarget {
  readonly expectedOperationVersion: number;
  readonly expectedResultSha256: string;
  readonly expectedTargetDocumentRevision: string;
  readonly selectedCandidateIds: readonly string[];
}

export interface ManagedDocumentInspection<Candidate> extends ManagedDocumentOperationTarget {
  readonly operationVersion: number;
  readonly resultSha256: string;
  readonly targetDocumentRevision: string;
  readonly analyzedInputRevision: string;
  readonly candidates: readonly Candidate[];
  readonly applicable: boolean;
  readonly blockReason?: string;
}

export type DocumentCheckpointOutcome =
  | { readonly status: 'committed'; readonly commit: string }
  | { readonly status: 'not-required' }
  | { readonly status: 'failed'; readonly reason: string };

export type ManagedDocumentSaveOutcome =
  | {
      readonly status: 'saved';
      readonly targetDocumentRevision: string;
      readonly checkpoint: DocumentCheckpointOutcome;
    }
  | {
      readonly status: 'blocked' | 'save-failed';
      readonly reason: string;
      readonly targetDocumentRevision?: string;
    }
  | {
      readonly status: 'outcome-unresolved';
      readonly reason: string;
      readonly actionId: string;
    };
