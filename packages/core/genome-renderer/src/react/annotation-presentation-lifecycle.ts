import type {
  AnnotationFlatPresentationSnapshot,
  AnnotationPresentationSnapshotApplyResult,
  AnnotationResidentPagePublication,
  AnnotationResidentPagePublicationApplyResult,
  Genome,
} from '@waypoint/genome-renderer';

export interface AnnotationPublicationRenderer {
  setAnnotationFlatPresentationSnapshot?: (
    snapshot: AnnotationFlatPresentationSnapshot
  ) => AnnotationPresentationSnapshotApplyResult;
  ingestAnnotationResidentPages?: (
    publication: AnnotationResidentPagePublication
  ) => AnnotationResidentPagePublicationApplyResult;
}

export function annotationFlatPresentationSnapshotMatchesGenome(
  snapshot: AnnotationFlatPresentationSnapshot | null | undefined,
  genome: Genome | null | undefined
): boolean {
  if (!snapshot || !genome) return false;
  return (
    snapshot.contract === 'annotation-presentation-snapshot.v1' &&
    !('pages' in snapshot) &&
    snapshot.sourceIdentity === (genome.sourceIdentity ?? genome.name) &&
    snapshot.genomeLengthBp === genome.length
  );
}

export function annotationResidentPagePublicationMatchesGenome(
  publication: AnnotationResidentPagePublication | null | undefined,
  genome: Genome | null | undefined
): boolean {
  if (!publication || !genome) return false;
  return (
    (publication.contract === 'annotation-resident-page-publication.v1' ||
      publication.contract === 'annotation-codon-carrier-page-publication.v1') &&
    !('features' in publication) &&
    !('layout' in publication) &&
    publication.sourceIdentity === (genome.sourceIdentity ?? genome.name) &&
    publication.genomeLengthBp === genome.length
  );
}

export function applyMatchingAnnotationFlatPresentationSnapshot(
  renderer: unknown,
  genome: Genome,
  snapshot: AnnotationFlatPresentationSnapshot | null | undefined
): AnnotationPresentationSnapshotApplyResult | null {
  const candidate = renderer as AnnotationPublicationRenderer;
  if (
    !snapshot ||
    !candidate.setAnnotationFlatPresentationSnapshot ||
    !annotationFlatPresentationSnapshotMatchesGenome(snapshot, genome)
  ) {
    return null;
  }
  return candidate.setAnnotationFlatPresentationSnapshot(snapshot);
}

export function ingestMatchingAnnotationResidentPages(
  renderer: unknown,
  genome: Genome,
  publication: AnnotationResidentPagePublication | null | undefined
): AnnotationResidentPagePublicationApplyResult | null {
  const candidate = renderer as AnnotationPublicationRenderer;
  if (
    !publication ||
    !candidate.ingestAnnotationResidentPages ||
    !annotationResidentPagePublicationMatchesGenome(publication, genome)
  ) {
    return null;
  }
  return candidate.ingestAnnotationResidentPages(publication);
}

export function invalidateAnnotationHoverAfterSnapshotApply(
  result: AnnotationPresentationSnapshotApplyResult | null,
  state: { hoveredId: number | null; hoverPosition?: number | null },
  onFeatureHover?: (featureId: number | null) => void,
  onHoverChange?: (hover: null) => void
): boolean {
  if (result?.status !== 'applied' || !result.invalidatedHover) return false;
  const hadHover = state.hoveredId !== null || state.hoverPosition !== null;
  state.hoveredId = null;
  state.hoverPosition = null;
  if (hadHover) {
    onFeatureHover?.(null);
    onHoverChange?.(null);
  }
  return hadHover;
}
