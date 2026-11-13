import type { Feature } from '@waypoint/genome-renderer';

type FeatureRange = Readonly<{ start: number; end: number }>;

function rangesEqual(
  left: ReadonlyArray<FeatureRange> | undefined,
  right: ReadonlyArray<FeatureRange> | undefined
): boolean {
  if (left === right) return true;
  if ((left?.length ?? 0) !== (right?.length ?? 0)) return false;
  if (!left || !right) return true;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].start !== right[index].start || left[index].end !== right[index].end) {
      return false;
    }
  }
  return true;
}

function qualifiersEqual(
  left: Readonly<Record<string, string | undefined>> | undefined,
  right: Readonly<Record<string, string | undefined>> | undefined
): boolean {
  if (left === right) return true;
  const leftKeys = left ? Object.keys(left) : [];
  const rightKeys = right ? Object.keys(right) : [];
  if (leftKeys.length !== rightKeys.length) return false;
  if (!left || !right) return true;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || left[key] !== right[key]) return false;
  }
  return true;
}

export function annotationFeaturesSemanticallyEqual(left: Feature, right: Feature): boolean {
  if (left === right) return true;
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.annotationTrackId === right.annotationTrackId &&
    left.annotationTrackLane === right.annotationTrackLane &&
    left.annotationTrackLaneCapacity === right.annotationTrackLaneCapacity &&
    left.start === right.start &&
    left.end === right.end &&
    left.direction === right.direction &&
    left.displayName === right.displayName &&
    left.color === right.color &&
    left.outlineOnly === right.outlineOnly &&
    left.lane === right.lane &&
    left.cdsLane === right.cdsLane &&
    left.transcriptId === right.transcriptId &&
    left.sourceId === right.sourceId &&
    left.canonicalIdentity === right.canonicalIdentity &&
    rangesEqual(left.segments, right.segments) &&
    rangesEqual(left.exons, right.exons) &&
    rangesEqual(left.cds, right.cds) &&
    qualifiersEqual(left.qualifiers, right.qualifiers)
  );
}

export function annotationFeatureArraysSemanticallyEqual(
  left: ReadonlyArray<Feature> | null | undefined,
  right: ReadonlyArray<Feature> | null | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!annotationFeaturesSemanticallyEqual(left[index], right[index])) return false;
  }
  return true;
}
