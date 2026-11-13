import { assignFeatureLanes } from '@waypoint/genome-renderer';
import type { GenomeFeature } from '@waypoint/genome-data';

import { annotationLayerType } from '../annotation-layer-identity';

export const LANE_ASSIGNMENT_VERSION = 1;

export type LaneLimit = number | null;

export interface StableLaneAssignmentInput {
  features: ReadonlyArray<GenomeFeature>;
  sourceFingerprint: string;
  chrom: string;
  length: number;
  visibleTypes: ReadonlySet<string>;
  laneLimit: LaneLimit;
}

export interface StableLaneAssignmentResult {
  laneEpoch: string;
  laneByFeatureKey: Map<string, number>;
  droppedCount: number;
  typeFilteredCount: number;
}

export function computeStableLaneAssignment(
  input: StableLaneAssignmentInput
): StableLaneAssignmentResult {
  const laneEpoch = computeLaneEpoch({
    sourceFingerprint: input.sourceFingerprint,
    chrom: input.chrom,
    visibleTypes: input.visibleTypes,
    laneLimit: input.laneLimit,
  });

  const filtered: Array<{ feature: GenomeFeature; index: number }> = [];
  for (let i = 0; i < input.features.length; i += 1) {
    const f = input.features[i];
    if (f.chrom !== input.chrom) continue;
    if (!input.visibleTypes.has(annotationLayerType(f))) continue;
    filtered.push({ feature: f, index: i });
  }

  const { laneAssignments, droppedCount } = assignFeatureLanes(
    filtered.map(({ feature }) => ({ start: feature.start, end: feature.end })),
    input.length,
    input.laneLimit === null ? undefined : { maxLanes: input.laneLimit }
  );

  const laneByFeatureKey = new Map<string, number>();
  for (let i = 0; i < filtered.length; i += 1) {
    const lane = laneAssignments.get(i);
    if (lane == null) continue;
    const key = stableFeatureKey(filtered[i].feature);
    if (!laneByFeatureKey.has(key)) {
      laneByFeatureKey.set(key, lane);
    }
  }

  return {
    laneEpoch,
    laneByFeatureKey,
    droppedCount,
    typeFilteredCount: filtered.length,
  };
}

export function computeLaneEpoch(input: {
  sourceFingerprint: string;
  chrom: string;
  visibleTypes: ReadonlySet<string>;
  laneLimit: LaneLimit;
}): string {
  const visibleTypesHash = hashVisibleTypes(input.visibleTypes);
  const laneLimitToken = input.laneLimit === null ? 'all' : String(input.laneLimit);
  return [
    input.sourceFingerprint,
    input.chrom,
    `lane-v${LANE_ASSIGNMENT_VERSION}`,
    visibleTypesHash,
    laneLimitToken,
  ].join(':');
}

export function stableFeatureKey(feature: GenomeFeature): string {
  const id =
    feature.attributes.ID?.[0] ??
    feature.attributes.transcript_id?.[0] ??
    feature.attributes.Name?.[0] ??
    '';
  return [feature.type, id, feature.chrom, feature.start, feature.end, feature.strand].join('|');
}

function hashVisibleTypes(visibleTypes: ReadonlySet<string>): string {
  return [...visibleTypes].sort((a, b) => a.localeCompare(b)).join(',');
}
