import { useCallback, useMemo } from 'react';
import type { BackboneSegment, ParsedPlasmid } from '@waypoint/plasmid-viewer';
import {
  nucleicAcidOf,
  type AnnotatedSequence,
  type Annotation,
  type ColoredCutSite,
} from '@waypoint/sequence-utils';
import type {
  AnnotationStateIdentity,
  CoordinateSpace,
  MutationMarker,
  PrimerDisplay,
  RulerDecoration,
} from '@waypoint/workspace-editor';
import type { AnnotationDraft } from '../types';
import type { SequenceViewState } from './sequence-view-state';
import {
  buildSequenceViewProjection,
  projectAnnotationDraftToSource,
  projectAnnotationIdentityToSource,
  projectAnnotationIdentityToView,
  projectAnnotationToSource,
  projectBackboneSegmentsToView,
  projectCutSitesToView,
  projectMutationsToView,
  projectPlasmidToView,
  projectPrimerToSource,
  projectPrimersToView,
  projectAssemblyScaffoldDigestMarkers,
  projectRulerDecorationsToView,
  projectSelectionToSourceRange,
  projectSequenceToView,
  projectSourcePositionToView,
  projectSourceRangeToViewSelection,
  projectSourceSelectionToViewSelection,
  projectViewPositionToSource,
  projectViewSelectionToSourceSelection,
  type EndExclusiveRange,
  type InclusiveSelectionRange,
  type SequenceViewProjection,
} from './sequence-view-projection';

type CandidateOrf = { start: number; end: number; strand: '+' | '-' };
type ForcedAnnotationIdentity = {
  type: string;
  name: string;
  start: number;
  end: number;
  direction: number;
};

export interface ProjectedSequenceViewInput {
  sourceSequence: AnnotatedSequence;
  sourcePlasmid: ParsedPlasmid;
  circular: boolean;
  coordinateSpace?: CoordinateSpace;
  seqView: Pick<SequenceViewState, 'orientation' | 'originOffset'>;
  sourcePrimers?: PrimerDisplay[];
  sourceBackboneSegments?: BackboneSegment[];
  sourceScrollToPosition?: number | null;
  sourceHighlightRange?: InclusiveSelectionRange | null;
  sourceInternalCutSiteMarkers?: ColoredCutSite[];
  sourceMutations?: MutationMarker[];
  sourceRulerDecorations?: RulerDecoration[];
  sourceCandidateOrf?: CandidateOrf | null;
  sourceForcedSelectedAnnotation?: ForcedAnnotationIdentity | null;
}

export interface ProjectedSequenceView {
  projection: SequenceViewProjection;
  isTransformed: boolean;
  sourceSequenceLength: number;
  sequence: AnnotatedSequence;
  plasmid: ParsedPlasmid;
  primers?: PrimerDisplay[];
  scrollToPosition?: number | null;
  highlightRange?: InclusiveSelectionRange | null;
  backboneSegments?: BackboneSegment[];
  internalCutSiteMarkers?: ColoredCutSite[];
  mutations?: MutationMarker[];
  rulerDecorations?: RulerDecoration[];
  candidateOrf?: CandidateOrf | null;
  forcedSelectedAnnotation?: ForcedAnnotationIdentity | null;
  toSource: {
    position(position: number | null): number | null;
    selection(selection: InclusiveSelectionRange): InclusiveSelectionRange;
    selectionAsRange(selection: InclusiveSelectionRange): EndExclusiveRange;
    annotation(annotation: Annotation): Annotation;
    annotationIdentity<T extends { start: number; end: number; direction?: number }>(
      identity: T
    ): T;
    annotationDraft(draft: AnnotationDraft): AnnotationDraft;
    primer(primer: PrimerDisplay): PrimerDisplay;
  };
  toView: {
    position(position: number | null): number | null;
    selection(selection: InclusiveSelectionRange): InclusiveSelectionRange;
    annotationIdentity<
      T extends AnnotationStateIdentity | ForcedAnnotationIdentity | null | undefined,
    >(
      identity: T
    ): T;
  };
  copyOrientation(reverseComplementRequested: boolean): 'forward' | 'reverse-complement';
  originOffsetForViewPosition(viewPosition: number): number | null;
}

export function useProjectedSequenceView({
  sourceSequence,
  sourcePlasmid,
  circular,
  coordinateSpace,
  seqView,
  sourcePrimers,
  sourceBackboneSegments,
  sourceScrollToPosition,
  sourceHighlightRange,
  sourceInternalCutSiteMarkers,
  sourceMutations,
  sourceRulerDecorations,
  sourceCandidateOrf,
  sourceForcedSelectedAnnotation,
}: ProjectedSequenceViewInput): ProjectedSequenceView {
  const sourceSequenceLength = sourceSequence.sequence.length;
  const projection = useMemo(
    () =>
      buildSequenceViewProjection({
        sequenceLength: sourceSequenceLength,
        circular,
        orientation: coordinateSpace ? 'forward' : seqView.orientation,
        originOffset: coordinateSpace ? 0 : seqView.originOffset,
        backboneSegments: sourceBackboneSegments,
        nucleicAcid: nucleicAcidOf(sourceSequence),
      }),
    [
      sourceSequence.molecule,
      circular,
      coordinateSpace,
      seqView.orientation,
      seqView.originOffset,
      sourceSequenceLength,
      sourceBackboneSegments,
    ]
  );

  const sequence = useMemo(
    () => projectSequenceToView(sourceSequence, projection),
    [sourceSequence, projection]
  );
  const plasmid = useMemo(
    () => projectPlasmidToView(sourcePlasmid, projection),
    [sourcePlasmid, projection]
  );
  const primers = useMemo(() => {
    const projected = projectPrimersToView(sourcePrimers, projection);
    const ends = projectAssemblyScaffoldDigestMarkers(projection);
    return ends.length ? [...(projected ?? []), ...ends] : projected;
  }, [sourcePrimers, projection]);
  const scrollToPosition = useMemo(() => {
    if (sourceScrollToPosition == null) return sourceScrollToPosition;
    const viewed = projectSourcePositionToView(sourceScrollToPosition - 1, projection);
    return viewed == null ? sourceScrollToPosition : viewed + 1;
  }, [sourceScrollToPosition, projection]);
  const highlightRange = useMemo(
    () =>
      sourceHighlightRange
        ? projectSourceRangeToViewSelection(sourceHighlightRange, projection)
        : sourceHighlightRange,
    [sourceHighlightRange, projection]
  );
  const backboneSegments = useMemo(
    () => projectBackboneSegmentsToView(sourceBackboneSegments, projection),
    [sourceBackboneSegments, projection]
  );
  const internalCutSiteMarkers = useMemo(
    () => projectCutSitesToView(sourceInternalCutSiteMarkers, projection),
    [sourceInternalCutSiteMarkers, projection]
  );
  const mutations = useMemo(
    () => projectMutationsToView(sourceMutations, projection),
    [sourceMutations, projection]
  );
  const rulerDecorations = useMemo(
    () => projectRulerDecorationsToView(sourceRulerDecorations, projection),
    [sourceRulerDecorations, projection]
  );
  const candidateOrf = useMemo(() => {
    if (!sourceCandidateOrf || projection.isIdentity) return sourceCandidateOrf;
    const viewed = projectSourceSelectionToViewSelection(
      { start: sourceCandidateOrf.start, end: sourceCandidateOrf.end },
      projection
    );
    return {
      ...sourceCandidateOrf,
      start: viewed.start,
      end: viewed.end,
      strand:
        projection.orientation === 'reverse-complement'
          ? sourceCandidateOrf.strand === '+'
            ? '-'
            : '+'
          : sourceCandidateOrf.strand,
    };
  }, [sourceCandidateOrf, projection]);
  const forcedSelectedAnnotation = useMemo(
    () => projectAnnotationIdentityToView(sourceForcedSelectedAnnotation, projection),
    [sourceForcedSelectedAnnotation, projection]
  );

  const positionToSource = useCallback(
    (position: number | null) => projectViewPositionToSource(position, projection),
    [projection]
  );
  const selectionToSource = useCallback(
    (selection: InclusiveSelectionRange) =>
      projectViewSelectionToSourceSelection(selection, projection),
    [projection]
  );
  const selectionAsSourceRange = useCallback(
    (selection: InclusiveSelectionRange) => projectSelectionToSourceRange(selection, projection),
    [projection]
  );
  const annotationToSource = useCallback(
    (annotation: Annotation) => projectAnnotationToSource(annotation, projection),
    [projection]
  );
  const annotationIdentityToSource = useCallback(
    <T extends { start: number; end: number; direction?: number }>(identity: T): T =>
      projectAnnotationIdentityToSource(identity, projection),
    [projection]
  );
  const annotationDraftToSource = useCallback(
    (draft: AnnotationDraft) => projectAnnotationDraftToSource(draft, projection),
    [projection]
  );
  const primerToSource = useCallback(
    (primer: PrimerDisplay) => projectPrimerToSource(primer, projection),
    [projection]
  );
  const positionToView = useCallback(
    (position: number | null) => projectSourcePositionToView(position, projection),
    [projection]
  );
  const selectionToView = useCallback(
    (selection: InclusiveSelectionRange) =>
      projectSourceSelectionToViewSelection(selection, projection),
    [projection]
  );
  const annotationIdentityToView = useCallback(
    <T extends AnnotationStateIdentity | ForcedAnnotationIdentity | null | undefined>(
      identity: T
    ): T => projectAnnotationIdentityToView(identity, projection) as T,
    [projection]
  );
  const copyOrientation = useCallback(
    (reverseComplementRequested: boolean): 'forward' | 'reverse-complement' => {
      if (reverseComplementRequested) {
        return projection.orientation === 'reverse-complement' ? 'forward' : 'reverse-complement';
      }
      return projection.orientation === 'reverse-complement' ? 'reverse-complement' : 'forward';
    },
    [projection.orientation]
  );
  const originOffsetForViewPosition = useCallback(
    (viewPosition: number): number | null => {
      if (!circular || sourceSequenceLength <= 0) return null;
      const sourcePosition = projection.viewIndexToSource(viewPosition);
      return projection.orientation === 'reverse-complement'
        ? (sourcePosition + 1) % sourceSequenceLength
        : sourcePosition;
    },
    [circular, projection, sourceSequenceLength]
  );
  const toSource = useMemo(
    () => ({
      position: positionToSource,
      selection: selectionToSource,
      selectionAsRange: selectionAsSourceRange,
      annotation: annotationToSource,
      annotationIdentity: annotationIdentityToSource,
      annotationDraft: annotationDraftToSource,
      primer: primerToSource,
    }),
    [
      annotationDraftToSource,
      annotationIdentityToSource,
      annotationToSource,
      positionToSource,
      primerToSource,
      selectionAsSourceRange,
      selectionToSource,
    ]
  );
  const toView = useMemo(
    () => ({
      position: positionToView,
      selection: selectionToView,
      annotationIdentity: annotationIdentityToView,
    }),
    [annotationIdentityToView, positionToView, selectionToView]
  );

  return {
    projection,
    isTransformed: !projection.isIdentity,
    sourceSequenceLength,
    sequence,
    plasmid,
    primers,
    scrollToPosition,
    highlightRange,
    backboneSegments,
    internalCutSiteMarkers,
    mutations,
    rulerDecorations,
    candidateOrf,
    forcedSelectedAnnotation,
    toSource,
    toView,
    copyOrientation,
    originOffsetForViewPosition,
  };
}
