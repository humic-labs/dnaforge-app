import { BUILTIN_TRACK_TYPES } from '@waypoint/genome-renderer';
import { TRACK_DEFAULT_COLORS } from '@waypoint/sequence-utils';

import type { IndexedGenomeVariantSourceState } from '../../shared/indexed-genome';
import type { ActiveStressDataset, Lane } from './lane-contract-store';

export function variantTrackId(source: IndexedGenomeVariantSourceState): string {
  return `variant:${source.sourceIdentity}`;
}

export function variantLaneDataset(source: IndexedGenomeVariantSourceState): ActiveStressDataset {
  return {
    trackId: variantTrackId(source),
    trackType: BUILTIN_TRACK_TYPES.variant,
    label: source.label || `${source.format.toUpperCase()} variants`,
    color: TRACK_DEFAULT_COLORS.variant,
    trackPx: 44,
    laneHeightPx: 12,
    maxLanes: 8,
    records: [],
    kind: 'variant',
  };
}

export function laneFromVariantSource(
  source: IndexedGenomeVariantSourceState,
  assemblyId: string,
  order = 0
): Lane {
  if (!source.admittedSource) {
    throw new Error('The saved variant source has no durable admission receipt.');
  }
  return {
    assemblyId,
    order,
    visible: true,
    dataset: variantLaneDataset(source),
    source: source.admittedSource,
  };
}
