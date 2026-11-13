import type { AnnotationFeature } from '@waypoint/api-client/models';
import { getFeatureColor, type Annotation } from '@waypoint/sequence-utils';

export type PlannotateFeature = AnnotationFeature;
export type DbSource = AnnotationFeature['db_source'];
export type DuplicateReason = 'exact' | 'overlap' | 'position';

export interface DuplicateStatus {
  isDuplicate: boolean;
  reason?: DuplicateReason;
  existingAnnotationName?: string;
}

export interface DraftAnnotation extends PlannotateFeature {
  id: string;
  confidence: number;
  accepted: boolean;
  duplicateStatus: DuplicateStatus;
  savedSubstitutionOverlap?: boolean;
}

export const CONFIDENCE_THRESHOLDS = {
  HIGH: 95,
  MEDIUM: 80,
  AUTO_ACCEPT: 80,
} as const;

export function getConfidenceLevel(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= CONFIDENCE_THRESHOLDS.HIGH) return 'high';
  if (confidence >= CONFIDENCE_THRESHOLDS.MEDIUM) return 'medium';
  return 'low';
}

export function calculateOverlapPercent(
  a: { start: number; end: number },
  b: { start: number; end: number }
): number {
  const overlapStart = Math.max(a.start, b.start);
  const overlapEnd = Math.min(a.end, b.end);
  if (overlapStart >= overlapEnd) return 0;
  const overlapLength = overlapEnd - overlapStart + 1;
  const aLength = a.end - a.start + 1;
  return (overlapLength / aLength) * 100;
}

export function calculateReciprocalOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number }
): { aToB: number; bToA: number; min: number } {
  const aToB = calculateOverlapPercent(a, b);
  const bToA = calculateOverlapPercent(b, a);
  return { aToB, bToA, min: Math.min(aToB, bToA) };
}

export function strandsCompatible(
  draftStrand: number,
  existingStrand: number | undefined
): boolean {
  if (existingStrand === undefined) return true;
  if (draftStrand === 0 || existingStrand === 0) return true;
  return draftStrand === existingStrand;
}

export function detectDuplicate(
  draft: PlannotateFeature,
  existingAnnotations: Array<{
    name: string;
    type?: string;
    start: number;
    end: number;
    strand?: number;
  }>
): DuplicateStatus {
  for (const existing of existingAnnotations) {
    if (!strandsCompatible(draft.strand, existing.strand)) continue;

    const reciprocal = calculateReciprocalOverlap(draft, existing);
    if (existing.name.toLowerCase() === draft.name.toLowerCase() && reciprocal.min > 50) {
      return { isDuplicate: true, reason: 'exact', existingAnnotationName: existing.name };
    }

    const draftLength = draft.end - draft.start + 1;
    const existingLength = existing.end - existing.start + 1;
    const positionTolerance = Math.max(5, Math.max(draftLength, existingLength) * 0.05);
    const typesCompatible = existing.type === undefined || existing.type === draft.type;
    if (
      Math.abs(existing.start - draft.start) <= positionTolerance &&
      Math.abs(existing.end - draft.end) <= positionTolerance &&
      typesCompatible
    ) {
      return { isDuplicate: true, reason: 'position', existingAnnotationName: existing.name };
    }
    if (typesCompatible && reciprocal.min > 80) {
      return { isDuplicate: true, reason: 'overlap', existingAnnotationName: existing.name };
    }
  }
  return { isDuplicate: false };
}

export function createDraftAnnotations(
  features: PlannotateFeature[],
  existingAnnotations: Array<{
    name: string;
    type?: string;
    start: number;
    end: number;
    strand?: number;
  }>
): DraftAnnotation[] {
  return features.map((feature, index) => {
    const confidence = (feature.identity * feature.coverage) / 100;
    const duplicateStatus = detectDuplicate(feature, existingAnnotations);
    return {
      ...feature,
      id: `draft-${index}-${Date.now()}`,
      confidence,
      accepted: !duplicateStatus.isDuplicate && confidence >= CONFIDENCE_THRESHOLDS.AUTO_ACCEPT,
      duplicateStatus,
    };
  });
}

export function draftsToCommittedAnnotations(
  drafts: DraftAnnotation[],
  sequenceLength?: number
): Annotation[] {
  return drafts.map((draft) => {
    const type = draft.type || 'misc_feature';
    const direction = (draft.strand === 1 ? 1 : draft.strand === -1 ? -1 : 0) as 1 | -1 | 0;
    const qualifiers: Record<string, string[]> = {
      description: [draft.description || ''],
      identity: [draft.identity.toFixed(1)],
      coverage: [draft.coverage.toFixed(1)],
      source: ['pLannotate'],
    };
    if (draft.start > draft.end && sequenceLength && sequenceLength > 0) {
      const inner = `join(${draft.start}..${sequenceLength},1..${draft.end})`;
      qualifiers._locationString = [direction === -1 ? `complement(${inner})` : inner];
    }
    return {
      name: draft.name,
      start: draft.start,
      end: draft.end,
      direction,
      type,
      color: getFeatureColor(type),
      qualifiers,
    };
  });
}
