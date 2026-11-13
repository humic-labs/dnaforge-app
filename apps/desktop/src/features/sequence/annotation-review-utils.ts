import { draftsToCommittedAnnotations, type DraftAnnotation } from '../../shared/annotation-review';
import type { Annotation, AnnotatedSequence } from '@waypoint/sequence-utils';
export {
  calculateOverlapPercent,
  calculateReciprocalOverlap,
  createDraftAnnotations,
  detectDuplicate,
  draftsToCommittedAnnotations,
  getConfidenceLevel,
  strandsCompatible,
} from '../../shared/annotation-review';

export interface CommitReviewedAnnotationsDeps {
  sequence: AnnotatedSequence;
  documentId: string;
  acceptedDrafts: DraftAnnotation[];
  hasPendingSequenceEdits: boolean;
  mergeAnnotations: (documentId: string, annotations: Annotation[]) => void;
  exitReviewMode: (path: string) => void;
  save: () => Promise<boolean>;
}

export type CommitReviewedAnnotationsResult =
  | { status: 'saved' }
  | { status: 'save-failed' }
  | { status: 'blocked-pending-edits' };

export async function commitReviewedAnnotations(
  deps: CommitReviewedAnnotationsDeps
): Promise<CommitReviewedAnnotationsResult> {
  if (deps.hasPendingSequenceEdits) {
    return { status: 'blocked-pending-edits' };
  }
  const newAnnotations = draftsToCommittedAnnotations(
    deps.acceptedDrafts,
    deps.sequence.sequence.length
  );
  deps.mergeAnnotations(deps.documentId, newAnnotations);
  deps.exitReviewMode(deps.documentId);
  const saved = await deps.save();
  return { status: saved ? 'saved' : 'save-failed' };
}

export function resolveDraftForViewerAnnotation(
  drafts: ReadonlyArray<{ id: string; name: string; start: number; end: number }>,
  annotation: { name: string; start: number; end: number },
  committedAnnotations: ReadonlyArray<{ name: string; start: number; end: number }> = []
): { id: string; name: string; start: number; end: number } | null {
  if (drafts.length === 0) return null;
  const names = annotation.name.includes(' · ')
    ? annotation.name.split(' · ').map((part) => part.trim())
    : [annotation.name];

  const sameRange = (candidate: { name: string; start: number; end: number }) =>
    names.includes(candidate.name) &&
    candidate.start === annotation.start &&
    candidate.end === annotation.end;

  const matches = drafts.filter(sameRange);
  if (matches.length !== 1) return null;
  if (committedAnnotations.some(sameRange)) return null;
  return matches[0]!;
}
