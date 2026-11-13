import { describe, expect, it } from 'vitest';
import { retainedOverviewAnnotationStyle } from '../overview/retained-overview-style';
import {
  resetRetainedOverviewDebug,
  type RetainedOverviewResetHost,
} from './indexed-retained-overview-reset';

function resetHost(overrides: Partial<RetainedOverviewResetHost> = {}): RetainedOverviewResetHost {
  return {
    retainedOverviewMode: 'retained',
    retainedOverviewDataBuilds: 4,
    retainedLinearDataBuilds: 3,
    retainedLinearBinCount: 8,
    retainedLinearTranscriptBuilds: 2,
    retainedLinearTranscriptBlockCount: 6,
    retainedLinearTranscriptVisibleFeatureCount: 5,
    retainedLinearTranscriptKey: 'linear-tx|keep',
    retainedLinearTranscriptFeatureSet: new Set(['tx']),
    retainedLinearTranscriptMembershipNeedsRebind: true,
    retainedLinearSourceWindow: { startBp: 1, endBp: 2 },
    retainedTranscriptDecorationBuilds: 9,
    decorationCacheKey: 'dec',
    decorationCacheAnchorViewStartBp: 10,
    decorationCacheAnchorPpb: 0.5,
    decorationCacheBuiltLoBp: 1,
    decorationCacheBuiltHiBp: 99,
    retainedTranscriptDecorationGraphics: { position: { x: 12 } },
    retainedOverviewCameraUpdates: 7,
    retainedOverviewInteractionUpdates: 2,
    retainedOverviewFallbackRenders: 1,
    retainedOverviewFallbackReason: 'dirty-data',
    retainedOverviewStyle: 'full-shapes',
    retainedOverviewInstanceCount: 3,
    retainedOverviewVisibleInstanceCount: 2,
    immediateDrawStateClearedForRetained: true,
    retainedDrawStateClean: true,
    ...overrides,
  };
}

describe('indexed retained overview reset', () => {
  it('clears overview counters, decoration cache, and the transcript mesh', () => {
    const host = resetHost();
    resetRetainedOverviewDebug(host);
    expect(host.retainedOverviewMode).toBe('inactive');
    expect(host.retainedOverviewDataBuilds).toBe(0);
    expect(host.retainedLinearDataBuilds).toBe(0);
    expect(host.retainedLinearBinCount).toBe(0);
    expect(host.retainedLinearTranscriptBuilds).toBe(0);
    expect(host.retainedLinearTranscriptBlockCount).toBe(0);
    expect(host.retainedLinearTranscriptVisibleFeatureCount).toBe(0);
    expect(host.retainedLinearTranscriptKey).toBe('');
    expect(host.retainedLinearTranscriptFeatureSet).toBeNull();
    expect(host.retainedLinearTranscriptMembershipNeedsRebind).toBe(false);
    expect(host.retainedLinearSourceWindow).toBeNull();
    expect(host.decorationCacheKey).toBe('');
    expect(host.retainedTranscriptDecorationGraphics.position.x).toBe(0);
    expect(host.retainedOverviewFallbackReason).toBeNull();
    expect(host.retainedOverviewStyle).toEqual(retainedOverviewAnnotationStyle());
    expect(host.immediateDrawStateClearedForRetained).toBe(false);
    expect(host.retainedDrawStateClean).toBe(false);
  });

  it('keeps the resident transcript mesh when asked to preserve it', () => {
    const featureSet = new Set(['tx']);
    const host = resetHost({
      retainedLinearTranscriptFeatureSet: featureSet,
      retainedLinearTranscriptKey: 'keep',
      retainedLinearTranscriptBlockCount: 6,
      retainedLinearTranscriptBuilds: 2,
      retainedLinearTranscriptVisibleFeatureCount: 5,
      retainedLinearTranscriptMembershipNeedsRebind: true,
    });
    resetRetainedOverviewDebug(host, { preserveTranscriptMesh: true });
    expect(host.retainedLinearTranscriptKey).toBe('keep');
    expect(host.retainedLinearTranscriptFeatureSet).toBe(featureSet);
    expect(host.retainedLinearTranscriptBlockCount).toBe(6);
    expect(host.retainedLinearTranscriptBuilds).toBe(2);
    expect(host.retainedLinearTranscriptVisibleFeatureCount).toBe(5);
    expect(host.retainedLinearTranscriptMembershipNeedsRebind).toBe(true);
    expect(host.retainedLinearSourceWindow).toBeNull();
    expect(host.retainedOverviewMode).toBe('inactive');
  });
});
