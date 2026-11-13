import { sourceBaseInIntervals } from './coordinates';
import type { ValidatedSourceProvenanceProjection } from './types';

export function validateSourceProvenance(
  projection: Omit<ValidatedSourceProvenanceProjection, 'validation'>
): ValidatedSourceProvenanceProjection {
  for (const base of projection.bases) {
    const expectedOwner =
      base.sourceBase === null
        ? 'unavailable'
        : sourceBaseInIntervals(
              base.sourceBase,
              projection.intervals.assembledContributionIntervals
            )
          ? 'contributing'
          : 'muted';
    if (base.owner !== expectedOwner) {
      throw new Error(
        `Invalid source provenance owner for ${projection.rowId} row ${base.rowPosition}: expected ${expectedOwner}, got ${base.owner}`
      );
    }
  }

  return {
    ...projection,
    validation: {
      valid: true,
      schemaVersion: 1,
      inputHash: sourceProjectionInputHash(projection),
    },
  };
}

function sourceProjectionInputHash(
  projection: Omit<ValidatedSourceProvenanceProjection, 'validation'>
): string {
  return [
    projection.rowId,
    projection.side,
    projection.regionId,
    projection.sourceRef.id,
    projection.sourceLength,
    projection.circular ? 'circular' : 'linear',
    projection.intervals.physicalSourceInterval.start,
    projection.intervals.physicalSourceInterval.end,
    projection.intervals.assembledContributionIntervals
      .map((interval) => `${interval.start}-${interval.end}`)
      .join(','),
    projection.intervals.visibleContextInterval.start,
    projection.intervals.visibleContextInterval.end,
    projection.bases.length,
  ].join('|');
}
