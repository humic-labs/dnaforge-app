import type { Feature } from '@waypoint/genome-renderer/pure';

function shiftRanges(
  ranges: ReadonlyArray<{ start: number; end: number }> | undefined,
  offsetBp: number
): Array<{ start: number; end: number }> | undefined {
  if (!ranges) return ranges;
  return ranges.map((r) => ({ start: r.start + offsetBp, end: r.end + offsetBp }));
}

function joinLocationString(ranges: ReadonlyArray<{ start: number; end: number }>): string {
  return `join(${ranges.map((r) => `${r.start}..${r.end}`).join(',')})`;
}

function shiftJoinQualifier(
  qualifiers: Feature['qualifiers'],
  shiftedSegments: ReadonlyArray<{ start: number; end: number }> | undefined
): Feature['qualifiers'] {
  const current = qualifiers?._locationString;
  if (!qualifiers || !shiftedSegments || shiftedSegments.length <= 1 || !current) {
    return qualifiers;
  }
  if (!/join\s*\(/i.test(current)) return qualifiers;
  const shiftedJoin = joinLocationString(shiftedSegments);
  return {
    ...qualifiers,
    _locationString: /^complement\s*\(/i.test(current) ? `complement(${shiftedJoin})` : shiftedJoin,
  };
}

export function offsetFeatureToGlobal(feature: Feature, offsetBp: number): Feature {
  if (offsetBp === 0) return feature;
  const shiftedSegments = shiftRanges(feature.segments, offsetBp);
  const shiftedQualifiers = shiftJoinQualifier(feature.qualifiers, shiftedSegments);
  return {
    ...feature,
    start: feature.start + offsetBp,
    end: feature.end + offsetBp,
    ...(shiftedSegments ? { segments: shiftedSegments } : {}),
    ...(feature.exons ? { exons: shiftRanges(feature.exons, offsetBp) } : {}),
    ...(feature.cds ? { cds: shiftRanges(feature.cds, offsetBp) } : {}),
    ...(shiftedQualifiers !== feature.qualifiers ? { qualifiers: shiftedQualifiers } : {}),
  };
}

export function offsetFeaturesToGlobal(
  features: ReadonlyArray<Feature>,
  offsetBp: number
): Feature[] {
  if (offsetBp === 0) return features as Feature[];
  return features.map((f) => offsetFeatureToGlobal(f, offsetBp));
}

export function offsetSequenceWindowToGlobal<T extends { startBp: number; endBp: number }>(
  window: T,
  offsetBp: number
): T {
  if (offsetBp === 0) return window;
  return { ...window, startBp: window.startBp + offsetBp, endBp: window.endBp + offsetBp };
}
