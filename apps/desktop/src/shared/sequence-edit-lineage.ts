import type {
  AnnotatedSequence,
  SequenceEditMarkerRange,
  SequenceEditSubstitutionRange,
  SequenceEditTransition,
} from '@waypoint/sequence-utils';
import type { ScientificAcceptedDocumentRevision } from '@waypoint/domain-services';

export const SEQUENCE_SAVE_PRIMER_PUBLICATION_EVENT_TYPE = 'sequence_save_primer_publication_v1';

export const SEQUENCE_EDIT_TRANSITION_EVENT_TYPE = 'sequence_edit_transition_v1';
export const SEQUENCE_EDIT_TRANSITION_SCHEMA = 'dnaforge.sequence-edit-transition.v1';

export interface SequenceDocumentSaveCaptureInput {
  sequence: AnnotatedSequence;
  draftBaseline: {
    sequence: string;
    length: number;
    circular: boolean;
  };
  draftSequence: string;
  insertedRanges: SequenceEditMarkerRange[];
  deletedRanges: SequenceEditMarkerRange[];
  substitutedRanges: SequenceEditSubstitutionRange[];
  draftLineageId: string;
}

export interface SequenceDocumentSaveInput {
  documentId: string;
  sourcePath: string;
  mutationToken?: string;
  capture: SequenceDocumentSaveCaptureInput;

  sequencingEvidenceRunId?: string;
  accepted?: {
    operationId: string;

    createdAt?: string;
    expectedHead: string;
    expectedRevisionId: string;
    parentEventId: string | null;
    baseline?: { head: string; revisionId: string };
    replacementEventId?: string | null;
  };
}

export interface AcceptedSequenceSave extends ScientificAcceptedDocumentRevision {
  operationId: string;
}

export interface SequenceDocumentSavePublication {
  readonly kind: 'accepted-object' | 'native-capture';
  readonly repositoryRoot: string | null;
  readonly history?: {
    readonly receipt: SequenceDocumentWriteReceipt;
    readonly result: SequenceDocumentHistoryResult;
  };
}

export type SequenceDocumentSaveResult =
  | { status: 'unbound' }
  | {
      status: 'saved';
      fileSha256: string;
      eventId: string | null;
      lineage: 'recorded' | 'unavailable';
      managedAnnotationIds?: string[];
      accepted?: AcceptedSequenceSave;

      publicationPaths?: readonly string[];
      writeReceipt?: SequenceDocumentWriteReceipt;
    }
  | {
      status: 'accepted-pending';
      reason: string;
      superseded?: true;
      eventId: string;
      lineage: 'recorded';
      accepted: AcceptedSequenceSave;
      managedAnnotationIds?: string[];
      publicationPaths?: readonly string[];
    };

export interface SequenceDocumentWriteReceipt {
  nativeActionId: string;
  revisionId: string | null;
  contentSha256: string;
  wrote: boolean;
  accepted?: AcceptedSequenceSave;
  primerPublicationIds?: readonly string[];
}

export interface SequenceDocumentHistoryInput extends SequenceDocumentWriteReceipt {
  documentId: string;
  sourcePath: string;
  message: string;
  mutationToken?: string;
}

export interface SequenceDocumentHistoryResult {
  status:
    | 'committed'
    | 'already-committed'
    | 'not-a-repository'
    | 'revision-changed'
    | 'unavailable'
    | 'failed';
  nativeActionId: string;
}

export interface SequenceEditTransitionEventV1 {
  schema: typeof SEQUENCE_EDIT_TRANSITION_SCHEMA;
  parentEventId: string | null;
  draftLineageId: string;
  beforeFileSha256: string;
  afterFileSha256: string;
  beforeTargetDocumentRevision: string;
  afterTargetDocumentRevision: string;
  beforeInputRevision: string;
  afterInputRevision: string;
  beforeTopology: 'linear' | 'circular';
  afterTopology: 'linear' | 'circular';
  transition: SequenceEditTransition;
}
