import { describe, expect, it } from 'vitest';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { OverviewAggregationCache } from './annotation-overview-cache';
import {
  syncRetainedLinearOverviewLayers,
  type RetainedLinearSyncHost,
} from './indexed-retained-linear-sync';

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 1,
    type: 'mRNA',
    start: 10,
    end: 40,
    direction: 'forward',
    color: 0x3366ff,
    lane: 0,
    displayName: 'tx',
    exons: [{ start: 11, end: 40 }],
    ...overrides,
  };
}

function renderState(overrides: Partial<RenderState> = {}): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 400,
    themeMode: 'light',
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
    ...overrides,
  };
}

function path(): PathMapper {
  return {
    isArcMode: false,
    pixelsPerBp: 1,
    viewStartBp: 0,
    viewEndBp: 800,
    bpLeftX: (bp: number) => bp,
    fwdStrandTop: 40,
  } as PathMapper;
}

function cache(overrides: Partial<OverviewAggregationCache> = {}): OverviewAggregationCache {
  return {
    key: 'bins-a',
    binBp: 10,
    atlasLevelCount: 1,
    bins: [],
    passthroughFeatures: [],
    diagnostics: {
      inputFeatureCount: 0,
      skippedMinVisibleFeatureCount: 0,
      passthroughFeatureCount: 0,
      aggregateWideFeatureCount: 0,
      aggregatedFeatureCount: 0,
      binContributionCount: 0,
    },
    ...overrides,
  };
}

function syncHost(overrides: Partial<RetainedLinearSyncHost> = {}): RetainedLinearSyncHost & {
  hidden: string[];
  featureSyncs: number;
  transcriptSyncs: number;
} {
  const host: RetainedLinearSyncHost & {
    hidden: string[];
    featureSyncs: number;
    transcriptSyncs: number;
  } = {
    hidden: [],
    featureSyncs: 0,
    transcriptSyncs: 0,
    features: [feature()],
    genomeLength: 1_000,
    maxAnnotationLane: 1,
    maxCdsLane: 0,
    retainedLinearTranscriptKey: '',
    retainedLinearTranscriptFeatureSet: null,
    retainedLinearTranscriptMembershipNeedsRebind: false,
    retainedLinearTranscriptVisibleFeatureCount: 0,
    retainedLinearTranscriptBlockCount: 0,
    retainedLinearTranscriptStaleHolds: 0,
    retainedLinearTranscriptBuilds: 0,
    retainedLinearTranscriptLastBuildCause: '',
    retainedLinearTranscriptPrevKeyParts: null,
    retainedLinearFullSetMeshResident: false,
    retainedLinearDataBuilds: 0,
    retainedOverviewDataBuilds: 0,
    retainedLinearBinCount: 0,
    retainedLinearFeatureLayer: {
      syncData() {
        host.featureSyncs += 1;
        return true;
      },
      updateCamera() {},
      setAlpha() {},
      hide() {
        host.hidden.push('feature');
      },
    },
    retainedLinearTranscriptLayer: {
      syncData() {
        host.transcriptSyncs += 1;
        return true;
      },
      updateCamera() {
        host.hidden.push('tx-camera');
      },
      hide() {
        host.hidden.push('transcript');
      },
    },
    ensureRetainedLinearFeatureLayer() {
      const layer = host.retainedLinearFeatureLayer;
      if (!layer) {
        throw new Error('expected retained linear feature layer');
      }
      return layer;
    },
    ensureRetainedLinearTranscriptLayer() {
      const layer = host.retainedLinearTranscriptLayer;
      if (!layer) {
        throw new Error('expected retained linear transcript layer');
      }
      return layer;
    },
    retainedLinearTranscriptFeatureKey: () => 'fs',
    retainedLinearTranscriptLayoutKey: () => 'layout',
    cdsDetailProgress: () => 0,
    featureEnvelope: () => ({ centerOffset: 0 }),
    scaledBarHeight: () => 8,
    runInvariantGuardAfterRetainedSync() {},
    ...overrides,
  };
  return host;
}

describe('indexed retained linear sync', () => {
  it('syncs non-empty overview bins onto the feature layer', () => {
    const host = syncHost();
    const bins = [{ startBp: 0, endBp: 10 }] as OverviewAggregationCache['bins'];
    expect(
      syncRetainedLinearOverviewLayers(host, path(), renderState(), cache({ bins }), [])
    ).toBeNull();
    expect(host.featureSyncs).toBe(1);
    expect(host.retainedLinearDataBuilds).toBe(1);
    expect(host.retainedOverviewDataBuilds).toBe(1);
    expect(host.retainedLinearBinCount).toBe(1);
    expect(host.hidden).toContain('transcript');
  });

  it('holds the last-good transcript mesh on an empty streaming publish', () => {
    const previous = new Set([feature()]);
    const host = syncHost({
      retainedLinearTranscriptBlockCount: 4,
      retainedLinearTranscriptFeatureSet: previous,
      retainedLinearTranscriptKey: 'keep-me',
    });
    expect(syncRetainedLinearOverviewLayers(host, path(), renderState(), cache(), [])).toBe(
      previous
    );
    expect(host.retainedLinearTranscriptStaleHolds).toBe(1);
    expect(host.retainedLinearTranscriptKey).toBe('keep-me');
    expect(host.retainedLinearTranscriptBlockCount).toBe(4);
    expect(host.hidden).toEqual(['feature', 'tx-camera']);
    expect(host.transcriptSyncs).toBe(0);

    const cold = syncHost({ retainedLinearTranscriptBlockCount: 0 });
    expect(syncRetainedLinearOverviewLayers(cold, path(), renderState(), cache(), [])).toBeNull();
    expect(cold.hidden).toContain('transcript');
    expect(cold.retainedLinearTranscriptBlockCount).toBe(0);
    expect(cold.retainedLinearTranscriptKey).toMatch(/^linear-tx\|/);
  });
});
