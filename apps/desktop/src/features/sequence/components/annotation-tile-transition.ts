import type { Feature } from '@waypoint/genome-renderer';

export interface TileTransitionInputs {
  current: ReadonlyMap<string, Feature>;
  previous: ReadonlyMap<string, Feature>;
  activeRange: { start: number; end: number } | null;
  identityOf: (f: Feature) => string | null;
}

export function mergeWithTransitionContinuity(inputs: TileTransitionInputs): Map<string, Feature> {
  const out = new Map<string, Feature>(inputs.current);
  const currentIdentities = new Set<string>();
  for (const f of inputs.current.values()) {
    const identity = inputs.identityOf(f);
    if (identity) currentIdentities.add(identity);
  }
  if (inputs.activeRange === null) return out;
  const { start: rangeStart, end: rangeEnd } = inputs.activeRange;
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) {
    return out;
  }
  for (const [identity, retained] of inputs.previous) {
    if (!identity) continue;
    if (currentIdentities.has(identity)) continue;
    if (retained.end <= rangeStart || retained.start >= rangeEnd) continue;
    const retentionKey = `retained|${identity}`;
    if (!out.has(retentionKey)) out.set(retentionKey, retained);
  }
  return out;
}

export function buildRetainedIdentityMap(
  features: Iterable<Feature>,
  activeRange: { start: number; end: number } | null,
  identityOf: (f: Feature) => string | null
): Map<string, Feature> {
  const out = new Map<string, Feature>();
  for (const f of features) {
    const identity = identityOf(f);
    if (!identity) continue;
    if (activeRange) {
      if (f.end <= activeRange.start) continue;
      if (f.start >= activeRange.end) continue;
    }
    out.set(identity, f);
  }
  return out;
}
