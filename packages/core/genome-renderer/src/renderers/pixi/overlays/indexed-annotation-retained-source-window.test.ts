import { afterEach, describe, expect, it } from 'vitest';
import type { Feature } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import {
  hashRetainedLinearTranscriptFeatureKey,
  RETAINED_TRANSCRIPT_KEY_CACHE_MIN_FEATURES,
  retainedLinearSourceFeaturesForViewport,
  type RetainedLinearSourceWindowHost,
} from './indexed-annotation-retained-source-window';

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 1,
    type: 'gene',
    start: 10,
    end: 40,
    direction: 'forward',
    color: 0x3366ff,
    lane: 0,
    displayName: 'gene',
    ...overrides,
  };
}

type FeatureKeyGlobals = {
  __webglFeatureKeyHit?: number;
  __webglFeatureKeyMiss?: number;
  __webglFeatureKeyMissN?: number;
};

afterEach(() => {
  const globals = globalThis as FeatureKeyGlobals;
  delete globals.__webglFeatureKeyHit;
  delete globals.__webglFeatureKeyMiss;
  delete globals.__webglFeatureKeyMissN;
});

describe('indexed annotation retained source window', () => {
  it('memoizes feature-set hashes only at the large-set threshold', () => {
    const host = {
      retainedLinearTranscriptFeatureKeyCache: new WeakMap<readonly Feature[], string>(),
    };
    const small = [feature()];
    const first = hashRetainedLinearTranscriptFeatureKey(host, small);
    expect(hashRetainedLinearTranscriptFeatureKey(host, small)).toBe(first);
    expect(host.retainedLinearTranscriptFeatureKeyCache.has(small)).toBe(false);

    const large = Array.from({ length: RETAINED_TRANSCRIPT_KEY_CACHE_MIN_FEATURES }, (_, id) =>
      feature({ id, start: id, end: id + 1 })
    );
    const miss = hashRetainedLinearTranscriptFeatureKey(host, large);
    expect((globalThis as FeatureKeyGlobals).__webglFeatureKeyMiss).toBeGreaterThanOrEqual(1);
    expect(hashRetainedLinearTranscriptFeatureKey(host, large)).toBe(miss);
    expect((globalThis as FeatureKeyGlobals).__webglFeatureKeyHit).toBe(1);
    expect(host.retainedLinearTranscriptFeatureKeyCache.get(large)).toBe(miss);
  });

  it('reuses a covering source window and rebuilds when the viewport leaves it', () => {
    const ranges: Array<[number, number]> = [];
    const windowFeatures = [feature({ id: 2, start: 100, end: 200 })];
    const host: RetainedLinearSourceWindowHost = {
      features: windowFeatures,
      genomeLength: 10_000_000,
      retainedLinearSourceWindow: null,
      retainedLinearTranscriptFeatureKeyCache: new WeakMap(),
      retainedLinearTranscriptFeatureKey() {
        return 'key-a';
      },
      featuresInRange(startBp, endBp) {
        ranges.push([startBp, endBp]);
        return windowFeatures;
      },
    };
    const path = { viewStartBp: 4_000_000, viewEndBp: 4_100_000 } as PathMapper;

    expect(retainedLinearSourceFeaturesForViewport(host, path)).toBe(windowFeatures);
    expect(ranges).toHaveLength(1);
    const retainedWindow = host.retainedLinearSourceWindow;
    expect(retainedWindow?.inputKey).toBe('key-a');
    expect(retainedWindow?.startBp).toBeLessThanOrEqual(4_000_000);
    expect(retainedWindow?.endBp).toBeGreaterThanOrEqual(4_100_000);

    expect(retainedLinearSourceFeaturesForViewport(host, path)).toBe(windowFeatures);
    expect(ranges).toHaveLength(1);

    expect(
      retainedLinearSourceFeaturesForViewport(host, {
        viewStartBp: 9_000_000,
        viewEndBp: 9_100_000,
      } as PathMapper)
    ).toBe(windowFeatures);
    expect(ranges).toHaveLength(2);
    expect(host.retainedLinearSourceWindow?.startBp).not.toBe(retainedWindow?.startBp);
  });
});
