import type { SequenceDesign } from '../design/public/types';

export interface SourceRegionDelta {
  regionId: string;
  sourceStartBefore: number;
  sourceStartAfter: number;
  sourceEndBefore: number;
  sourceEndAfter: number;
  sequenceLengthBefore: number;
  sequenceLengthAfter: number;
}

export function sourceRegionDeltas(
  before: SequenceDesign,
  after: SequenceDesign
): SourceRegionDelta[] {
  const beforeById = new Map(before.regions.map((region) => [region.id, region]));
  return after.regions
    .map((region) => {
      const previous = beforeById.get(region.id);
      if (!previous) return null;
      if (
        previous.sourceStart === region.sourceStart &&
        previous.sourceEnd === region.sourceEnd &&
        previous.sequence.length === region.sequence.length
      ) {
        return null;
      }
      return {
        regionId: region.id,
        sourceStartBefore: previous.sourceStart,
        sourceStartAfter: region.sourceStart,
        sourceEndBefore: previous.sourceEnd,
        sourceEndAfter: region.sourceEnd,
        sequenceLengthBefore: previous.sequence.length,
        sequenceLengthAfter: region.sequence.length,
      };
    })
    .filter((delta): delta is SourceRegionDelta => delta !== null);
}
