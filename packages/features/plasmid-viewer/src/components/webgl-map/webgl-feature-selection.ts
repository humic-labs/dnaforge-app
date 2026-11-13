import type { ParsedPlasmid } from '../../types';
import type { Feature } from '@waypoint/genome-renderer';

type Primer = ParsedPlasmid['primers'][0];
type FeatureSelection = { start: number; end: number } | null;

export interface WebGLFeatureSelectionHandlers {
  onFeatureSelect?: (feature: FeatureSelection) => void;
  onPrimerClick?: (primer: Primer) => void;
}

export interface WebGLFeatureSelectionContext extends WebGLFeatureSelectionHandlers {
  featureId: number | null;
  featureById: ReadonlyMap<number, Feature>;
  primerByRenderId: ReadonlyMap<number, Primer>;
  genomeLength: number;
}

function inclusiveEnd(endExclusive: number, genomeLength: number): number {
  return genomeLength > 0
    ? (((endExclusive - 1) % genomeLength) + genomeLength) % genomeLength
    : endExclusive;
}

export function commitWebGLFeatureRange(ctx: WebGLFeatureSelectionContext): void {
  const { featureId, featureById, primerByRenderId, genomeLength, onFeatureSelect, onPrimerClick } =
    ctx;
  if (featureId == null) {
    onFeatureSelect?.(null);
    return;
  }

  const primer = primerByRenderId.get(featureId);
  if (primer) {
    if (onPrimerClick) {
      onPrimerClick(primer);
      return;
    }
    onFeatureSelect?.({ start: primer.start, end: inclusiveEnd(primer.end, genomeLength) });
    return;
  }

  const feat = featureById.get(featureId);
  if (feat) {
    onFeatureSelect?.({ start: feat.start, end: inclusiveEnd(feat.end, genomeLength) });
  }
}

export function focusWebGLFeature(ctx: WebGLFeatureSelectionContext): void {
  const { featureId, primerByRenderId, onFeatureSelect } = ctx;
  if (featureId == null) {
    onFeatureSelect?.(null);
    return;
  }

  if (primerByRenderId.has(featureId)) {
    commitWebGLFeatureRange(ctx);
    return;
  }

  onFeatureSelect?.(null);
}
