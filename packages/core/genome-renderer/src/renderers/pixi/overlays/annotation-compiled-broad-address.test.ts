import { describe, expect, it } from 'vitest';

import {
  compiledBroadSurfaceDemandAddress,
  compiledBroadSurfaceGlobalStandbyLevelIndicesV2,
  compiledBroadSurfaceInteractionRunwayLevelsV2,
  compiledBroadSurfaceOwnedCellKey,
  compiledBroadSurfaceRequirementOwnsCamera,
  parseCompiledBroadSurfaceTileId,
  compiledBroadSurfaceResidentTileXs,
  compiledBroadSurfaceZoomOutSuccessorCoverageV1,
  compiledBroadSurfaceZoomOutTransitionViewportV1,
} from './annotation-compiled-broad-address';
import {
  buildCompiledBroadSurfaceManifestV2,
  type CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';

function minimalManifest(
  overrides: Partial<CompiledBroadSurfaceManifestV2> = {}
): CompiledBroadSurfaceManifestV2 {
  return {
    manifestFingerprint: 'fp-test',
    genomeLengthBp: 1000,
    prefetchRing: 1,
    levels: [
      {
        level: 0,
        tileSpanBp: 100,
        tileCount: 10,
      },
    ],
    ...overrides,
  } as CompiledBroadSurfaceManifestV2;
}

describe('annotation-compiled-broad-address', () => {
  it('reuses one immutable demand address per manifest cell', async () => {
    const manifest = await buildCompiledBroadSurfaceManifestV2({
      artifactKey: 'bounded-annotation-artifact.v1:mrna',
      trackId: 'mrna',
      genomeLengthBp: 3_088_269_832,
      broadCorridorFinestSpanBp: 16_000_000,
      broadTilePhysicalWidthPx: 512,
      broadTileXGuardPhysicalPx: 1,
      prefetchRing: 1,
      maxQualifiedRasterMagnificationX: 1.75,
      rasterDevicePixelRatio: 2,
      laneSlabRowCount: 8,
      laneRowCssHeightPx: 16,
      laneRowTextureStridePx: 32,
      laneRowTransparentTailGutterPx: 4,
      laneRowCounts: { canonical: 12, expanded: 70 },
    });
    const first = compiledBroadSurfaceDemandAddress(manifest, 'canonical', 2, 7, 0);
    const second = compiledBroadSurfaceDemandAddress(manifest, 'canonical', 2, 7, 0);

    expect(second).toBe(first);
  });

  it('builds a stable owned cell key', () => {
    expect(compiledBroadSurfaceOwnedCellKey('mf', 'cell-1')).toBe('mf\u0000cell-1');
  });

  it('parses L:X tile ids and rejects garbage', () => {
    expect(parseCompiledBroadSurfaceTileId('L2:X17')).toEqual({ level: 2, tileX: 17 });
    expect(() => parseCompiledBroadSurfaceTileId('tile-2-17')).toThrow(/invalid/);
  });

  it('lists resident tile Xs including prefetch ring', () => {
    const xs = compiledBroadSurfaceResidentTileXs(minimalManifest(), 0, 250, 350);
    expect(xs).toEqual([1, 2, 3, 4]);
  });

  it('projects a bounded coarser runway for every zoom anchor plus lateral motion', () => {
    const manifest = minimalManifest({
      levels: [10, 5, 3, 2].map((tileCount, level) => ({
        level,
        tileSpanBp: 100 * 2 ** level,
        tileCount,
      })),
    });

    const runway = compiledBroadSurfaceInteractionRunwayLevelsV2({
      manifest,
      activeLevelIndices: [0],
      viewportStartBp: 400,
      viewportEndBp: 500,
      finerLookaheadLevels: 3,
      coarserLookaheadLevels: 2,
      motionHaloViewports: 1,
      submittedLaneSlabCount: 1,
    });

    expect(runway.map(({ level, role }) => ({ level, role }))).toEqual([
      { level: 0, role: 'active-motion' },
      { level: 1, role: 'coarser-lookahead' },
      { level: 2, role: 'coarser-lookahead' },
    ]);
    expect(runway[0]!.tileXs).toEqual([2, 3, 4, 5, 6]);
    expect(runway[1]!.tileXs).toEqual([0, 1, 2, 3, 4]);
    expect(runway[2]!.tileXs).toEqual([0, 1, 2]);
  });

  it('bounds a whole-genome finer runway by physical GPU cells across lane slabs', () => {
    const manifest = minimalManifest({
      levels: [64, 32, 16, 8, 4, 2, 1].map((tileCount, level) => ({
        level,
        tileSpanBp: 100 * 2 ** level,
        tileCount,
      })),
    });

    const runway = compiledBroadSurfaceInteractionRunwayLevelsV2({
      manifest,
      activeLevelIndices: [6],
      viewportStartBp: 0,
      viewportEndBp: manifest.genomeLengthBp,
      finerLookaheadLevels: manifest.levels.length,
      coarserLookaheadLevels: 3,
      motionHaloViewports: 2,
      submittedLaneSlabCount: 2,
      maximumCellCount: 32,
    });

    expect(runway.reduce((count, level) => count + level.tileXs.length * 2, 0)).toBeLessThanOrEqual(
      32
    );
    expect(runway.map(({ level }) => level)).toEqual([6, 5, 4, 3, 2]);
    expect(runway.some(({ level }) => level === 1)).toBe(false);
  });

  it('derives a memory-bounded path-independent coarse standby suffix', () => {
    const manifest = minimalManifest({
      levels: [194, 97, 49, 25, 13, 7, 4, 2, 1].map((tileCount, level) => ({
        level,
        tileSpanBp: 16_000_000 * 2 ** level,
        tileCount,
      })),
    });

    expect(compiledBroadSurfaceGlobalStandbyLevelIndicesV2(manifest, 1)).toEqual([
      2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(compiledBroadSurfaceGlobalStandbyLevelIndicesV2(manifest, 2)).toEqual([
      3, 4, 5, 6, 7, 8,
    ]);
    expect(() => compiledBroadSurfaceGlobalStandbyLevelIndicesV2(manifest, 0)).toThrow(/budget/);
  });

  it('delegates requirement owns-camera to viewport ownership math', () => {
    const requirement = { genomeLengthBp: 3_088_269_832, broadCorridorFinestSpanBp: 50_000_000 };
    expect(
      compiledBroadSurfaceRequirementOwnsCamera({
        requirement,
        viewportStartBp: 0,
        viewportEndBp: 3_088_269_832,
        viewportCssWidthPx: 1200,
        devicePixelRatio: 2,
      })
    ).toBe(true);
    expect(
      compiledBroadSurfaceRequirementOwnsCamera({
        requirement,
        viewportStartBp: 0,
        viewportEndBp: 1_000,
        viewportCssWidthPx: 1200,
        devicePixelRatio: 2,
      })
    ).toBe(false);
  });

  it('uses the exact current detail-owner interval as the zoom-out successor envelope', () => {
    const coverage = compiledBroadSurfaceZoomOutSuccessorCoverageV1({
      manifest: minimalManifest({
        broadCorridorFinestSpanBp: 100,
        broadTilePhysicalWidthPx: 100,
      }),
      viewportStartBp: 400,
      viewportEndBp: 420,
      viewportCssWidthPx: 100,
      devicePixelRatio: 1,
      authenticatedDetailCorridorCoverage: { startBp: 300, endBp: 700 },
    });

    expect(coverage).toEqual({
      startBp: 300,
      endBp: 700,
      source: 'authenticated-detail-corridor',
    });
  });

  it('derives the first broad handoff camera from the canonical pixel contract', () => {
    const manifest = minimalManifest({
      genomeLengthBp: 1000,
      broadCorridorFinestSpanBp: 512,
      broadTilePhysicalWidthPx: 512,
    });
    const transition = compiledBroadSurfaceZoomOutTransitionViewportV1({
      manifest,
      viewportCssWidthPx: 120,
      devicePixelRatio: 2,
      successorCoverage: { startBp: 300, endBp: 700 },
    });

    expect(transition).toEqual({ startBp: 380, endBp: 620, spanBp: 240 });
    expect(
      compiledBroadSurfaceRequirementOwnsCamera({
        requirement: manifest,
        viewportStartBp: transition.startBp,
        viewportEndBp: transition.endBp,
        viewportCssWidthPx: 120,
        devicePixelRatio: 2,
      })
    ).toBe(true);
  });

  it('uses the authenticated pointer-anchored handoff instead of the cache midpoint', () => {
    const manifest = minimalManifest({
      genomeLengthBp: 1000,
      broadCorridorFinestSpanBp: 512,
      broadTilePhysicalWidthPx: 512,
    });
    const transition = compiledBroadSurfaceZoomOutTransitionViewportV1({
      manifest,
      viewportCssWidthPx: 120,
      devicePixelRatio: 2,
      successorCoverage: { startBp: 200, endBp: 900 },
      authenticatedDetailHandoffViewport: { startBp: 210, endBp: 450 },
    });

    expect(transition).toEqual({ startBp: 210, endBp: 450, spanBp: 240 });
    expect((transition.startBp + transition.endBp) / 2).not.toBe(550);
    expect(
      compiledBroadSurfaceRequirementOwnsCamera({
        requirement: manifest,
        viewportStartBp: transition.startBp,
        viewportEndBp: transition.endBp,
        viewportCssWidthPx: 120,
        devicePixelRatio: 2,
      })
    ).toBe(true);
  });

  it('rejects an authenticated handoff outside its packet coverage', () => {
    expect(() =>
      compiledBroadSurfaceZoomOutTransitionViewportV1({
        manifest: minimalManifest({
          genomeLengthBp: 1000,
          broadCorridorFinestSpanBp: 512,
          broadTilePhysicalWidthPx: 512,
        }),
        viewportCssWidthPx: 120,
        devicePixelRatio: 2,
        successorCoverage: { startBp: 300, endBp: 700 },
        authenticatedDetailHandoffViewport: { startBp: 250, endBp: 490 },
      })
    ).toThrow(/authenticated compiled broad handoff viewport/);
  });

  it('covers every possible first broad viewport anchor when no detail interval exists', () => {
    const coverage = compiledBroadSurfaceZoomOutSuccessorCoverageV1({
      manifest: minimalManifest({
        broadCorridorFinestSpanBp: 100,
        broadTilePhysicalWidthPx: 100,
      }),
      viewportStartBp: 400,
      viewportEndBp: 420,
      viewportCssWidthPx: 100,
      devicePixelRatio: 1,
    });

    expect(coverage).toEqual({
      startBp: 320,
      endBp: 500,
      source: 'camera-transition-envelope',
    });
  });
});
