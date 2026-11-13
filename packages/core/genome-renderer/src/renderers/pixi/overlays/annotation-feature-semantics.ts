import type { Feature } from '../../../types';
import { featureTypeColor, isTranscriptSourceType } from '../../../feature-colors';
import { webglAnnotationColorForMode, type WebGLThemeMode } from '../shared/theme';

const DRAFT_OUTLINE_SOURCES = new Set([
  'pLannotate-draft',
  'annotation-draft',
  'orf-candidate-cds',
]);

export function getColor(feature: Feature): number {
  return feature.color || featureTypeColor(feature.type);
}

export function getThemedColor(feature: Feature, mode: WebGLThemeMode | undefined): number {
  return webglAnnotationColorForMode(getColor(feature), mode);
}

export function isOutlineOnlyFeature(feature: Feature): boolean {
  if (feature.outlineOnly === true) return true;
  const isPlannotateDraft = feature.qualifiers?.source === 'pLannotate-draft';
  const isAccepted = feature.qualifiers?.status === 'accepted';
  return isPlannotateDraft && !isAccepted;
}

export function hasDraftOutline(feature: Feature): boolean {
  const source = feature.qualifiers?.source;
  return source ? DRAFT_OUTLINE_SOURCES.has(source) : false;
}

const SPLICE_CONTAINER_TYPES: ReadonlySet<string> = new Set(['CDS', 'mRNA', 'transcript']);

export function isSplicedFeature(feature: Feature): boolean {
  return (
    SPLICE_CONTAINER_TYPES.has(feature.type) &&
    !!feature.segments &&
    feature.segments.length > 1 &&
    /join\s*\(/i.test(feature.qualifiers?._locationString ?? '')
  );
}

export function isCompositeFeature(feature: Feature): boolean {
  if (!Array.isArray(feature.exons) || feature.exons.length === 0) return false;
  return (
    feature.compositeKind !== undefined ||
    (Array.isArray(feature.cds) && feature.cds.length > 0) ||
    isTranscriptSourceType(feature.type)
  );
}

export function isTranscript(feature: Feature): boolean {
  return feature.type !== 'CDS' && isCompositeFeature(feature);
}

export function stableSourceLane(feature: Feature): number | null {
  const raw = feature.qualifiers?._lane;
  if (raw === undefined || raw === 'overflow') return null;
  const lane = Number.parseInt(raw, 10);
  return Number.isFinite(lane) && lane >= 0 ? lane : null;
}

export function stableSourceLaneAssignments(features: Feature[]): Map<number, number> | null {
  if (features.length === 0) return new Map();
  const assignments = new Map<number, number>();
  for (let i = 0; i < features.length; i++) {
    const lane = stableSourceLane(features[i]);
    if (lane === null) return null;
    assignments.set(i, lane);
  }
  return assignments;
}

export function normalizeAnnotationLayerTypes(layerTypes: readonly string[]): string[] {
  return [...new Set(layerTypes.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
