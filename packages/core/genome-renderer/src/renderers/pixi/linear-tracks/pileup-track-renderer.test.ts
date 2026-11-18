// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { PileupRecord, PileupTrackData } from '@waypoint/genome-data';

import { startWebGLRenderLoop, type WebGLRenderLoop } from '../../../react/webgl-render-loop';
import { webglThemeForMode, type WebGLRenderTheme } from '../shared/theme';
import * as readVertices from './annotation-record-vertices';
import { buildCoverageGpuAtlas } from './coverage-gpu-atlas';
import { PENDING_INTERVAL_BAND_HEIGHT_PX } from './pileup-pending-interval-layer';
import { PersistentRowLayout } from './pileup-row-layout';
import * as rowHeightField from './pileup-read-row-height-field';
import { TrackDataStore } from './track-data-store';
import {
  PileupReadDifferenceLayer,
  pileupReadBodyVerticalGeometry,
} from './pileup-read-glyph-layer';
import type { TrackMountArgs, TrackPaintArgs } from './types';
import {
  pileupExactReadPreparationEligible,
  pileupHistogramLoadingAnimationIndex,
  PixiPileupTrackRenderer,
  resolveCoverageCutoffDepth,
} from './pileup-track-renderer';

describe('resolveCoverageCutoffDepth', () => {
  it('uses each track payload threshold independently and treats zero as auto', () => {
    expect(resolveCoverageCutoffDepth(25, 90)).toBe(25);
    expect(resolveCoverageCutoffDepth(140, 90)).toBe(140);
    expect(resolveCoverageCutoffDepth(0, 90)).toBe(90);
    expect(resolveCoverageCutoffDepth(undefined, 90)).toBe(90);
  });
});

describe('exact-read representation authority', () => {
  it('uses one physical-size boundary for every exact-read preparation owner', () => {
    expect(pileupExactReadPreparationEligible(1.49 / 150)).toBe(false);
    expect(pileupExactReadPreparationEligible(1.5 / 150)).toBe(true);
    expect(pileupExactReadPreparationEligible(3.6 / 150)).toBe(true);
    expect(pileupExactReadPreparationEligible(0)).toBe(false);
    expect(pileupExactReadPreparationEligible(Number.NaN)).toBe(false);
  });
});

describe('experimental actual BigWig height-map handoff', () => {
  it.each([
    ['diagonal-scan', 4],
    ['read-pulse-trains', 4],
  ] as const)(
    'maps the %s setting to the masked diagonal shader mode %i',
    (animation, expectedIndex) => {
      expect(pileupHistogramLoadingAnimationIndex(animation)).toBe(expectedIndex);
    }
  );

  it.each([
    ['light', 0xa8ceff],
    ['dark', 0x1d4ed8],
  ] as const)(
    'paints the provisional BigWig with the exact %s-mode read-body color',
    (themeMode, expectedColor) => {
      const renderer = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 3,
        maxRows: 8,
      });
      const container = renderer.mount({
        ...mountArgs,
        theme: webglThemeForMode(themeMode),
      });
      const data: PileupTrackData = {
        dataAuthority: 'static',
        coverage: {
          startBp: 0,
          bins: [2, 1],
          binSize: 5,
          maxDepth: 2,
        },
        records: [],
        experimentalReadHandoff: {
          kind: 'bigwig-height-morph-to-reads',
          morphDurationMs: 160,
        },
      };

      renderer.paint(
        paintArgsZoom(
          container,
          data,
          10,
          { start: 0, end: 20 },
          200,
          60,
          webglThemeForMode(themeMode)
        )
      );

      expect(experimentalHybridCoverageColor(renderer, container)).toBe(expectedColor);
      expect(renderer.getDiagnostics(container)?.pairedReadColor).toBe(expectedColor);
      renderer.unmount(container);
    }
  );

  it('uses the real BigWig histogram, then completes a packing-aware height morph in 160 ms', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    try {
      const renderer = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 3,
        maxRows: 8,
      });
      const container = renderer.mount(mountArgs);
      const data: PileupTrackData = {
        dataAuthority: 'static',
        coverage: {
          startBp: 0,
          bins: [2, 1],
          binSize: 5,
          maxDepth: 2,
        },
        records: [read(0, 5, 'lower-short'), read(0, 10, 'upper-long')],
        readSource: { truncated: false, windowStartBp: 0, windowEndBp: 20 },
        experimentalReadHandoff: {
          kind: 'bigwig-height-morph-to-reads',
          morphDurationMs: 160,
        },
      };
      const args = () => paintArgsZoom(container, data, 10, { start: 0, end: 20 }, 200, 60);

      renderer.paint(args());
      const start = renderer.getDiagnostics(container)!;
      expect(start.experimentalHybridPhase).toBe('morph');
      expect(start.experimentalHybridMorphProgress).toBe(0);
      expect(start.experimentalHybridExactFrontAvailable).toBe(true);
      expect(start.aggregateDepthSource).toBe('coverage-signal');
      expect(start.coverageSignalMaxDepth).toBe(2);
      expect(start.readDensityMorph).toBe(0);
      expect(start.renderedReadRowsAlpha).toBe(0);
      expect(start.renderedReadDensityAlpha).toBe(1);
      expect(start.readDisplayMode).toBe('density');
      expect(renderer.hasPendingPaintWork(container)).toBe(true);

      now.mockReturnValue(1_080);
      renderer.paint(args());
      const middle = renderer.getDiagnostics(container)!;
      expect(middle.experimentalHybridPhase).toBe('morph');
      expect(middle.experimentalHybridMorphProgress).toBeCloseTo(0.5, 5);
      expect(middle.readDensityMorph).toBeCloseTo(0.5, 5);
      expect(middle.renderedReadDensityAlpha).toBeCloseTo(0.5, 5);
      expect(middle.renderedReadRowsAlpha).toBeCloseTo(0.5, 5);
      expect(middle.readDisplayMode).toBe('blend');

      now.mockReturnValue(1_160);
      renderer.paint(args());
      const reads = renderer.getDiagnostics(container)!;
      expect(reads.experimentalHybridPhase).toBe('reads');
      expect(reads.experimentalHybridMorphProgress).toBe(1);
      expect(reads.readDensityMorph).toBe(1);
      expect(reads.renderedReadDensityAlpha).toBe(0);
      expect(reads.renderedReadRowsAlpha).toBe(1);
      expect(reads.readDisplayMode).toBe('reads');
      expect(renderer.hasPendingPaintWork(container)).toBe(false);

      renderer.unmount(container);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps BigWig ownership while any visible read tile is still pending', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_500);
    try {
      const renderer = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 3,
        maxRows: 8,
        readRowsAssignRecordsPerFrame: 1,
        readRowsBuildRecordsPerFrame: 1,
      });
      const container = renderer.mount(mountArgs);
      const loading: PileupTrackData = {
        dataAuthority: 'static',
        coverage: {
          startBp: 0,
          bins: [2, 1, 2, 1, 2, 1, 2, 1],
          binSize: 5,
          maxDepth: 2,
        },
        records: [read(0, 14, 'first'), read(2, 18, 'second')],
        readSource: {
          truncated: false,
          windowStartBp: 0,
          windowEndBp: 40,
          sourceGenerationKey: 'same-bam',
        },
        referenceIntervals: [{ startBp: 0, endBp: 20, state: 'pending' }],
        experimentalReadHandoff: {
          kind: 'bigwig-height-morph-to-reads',
          morphDurationMs: 160,
        },
      };
      const args = (data: PileupTrackData) =>
        paintArgsZoom(container, data, 10, { start: 0, end: 20 }, 200, 60);

      for (let frame = 0; frame < 12; frame += 1) renderer.paint(args(loading));
      expect(renderer.getDiagnostics(container)).toMatchObject({
        rowsMeshRecordCount: 2,
        rowsAssignmentBuildInProgress: false,
        rowsMeshBuildInProgress: false,
        pendingIntervalCount: 0,
        experimentalHybridPhase: 'histogram',
        experimentalHybridMorphProgress: 0,
        experimentalHybridExactFrontAvailable: false,
        renderedReadRowsAlpha: 0,
        renderedReadDensityAlpha: 1,
        experimentalHybridHistogramLoadingMotion: true,
        pendingIntervalVisible: false,
      });
      expect(experimentalHybridLoadingUniform(renderer, container)).toBe(1);
      expect(experimentalHybridLoadingStyleUniform(renderer, container)).toBe(4);
      expect(renderer.hasPendingPaintWork(container)).toBe(true);

      now.mockReturnValue(1_580);
      renderer.paint(args(loading));
      expect(
        renderer.getDiagnostics(container)?.experimentalHybridHistogramLoadingPhase
      ).toBeCloseTo(0.1, 5);

      const settled = { ...loading, referenceIntervals: [] };
      renderer.paint(args(settled));
      expect(renderer.getDiagnostics(container)).toMatchObject({
        experimentalHybridPhase: 'morph',
        experimentalHybridMorphProgress: 0,
        experimentalHybridExactFrontAvailable: true,
        experimentalHybridHistogramLoadingMotion: false,
        pendingIntervalVisible: false,
      });
      expect(experimentalHybridLoadingUniform(renderer, container)).toBe(0);
      now.mockReturnValue(1_740);
      renderer.paint(args(settled));
      expect(renderer.getDiagnostics(container)).toMatchObject({
        experimentalHybridPhase: 'reads',
        experimentalHybridMorphProgress: 1,
        renderedReadRowsAlpha: 1,
        renderedReadDensityAlpha: 0,
      });

      renderer.unmount(container);
    } finally {
      now.mockRestore();
    }
  });

  it('animates the provisional BigWig itself before the first alignment publication', () => {
    const renderer = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 3,
      maxRows: 1,
      overflowBandHeightPx: 12,
    });
    const container = renderer.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      coverage: {
        startBp: 0,
        bins: [2, 1, 2, 1],
        binSize: 5,
        maxDepth: 2,
      },
      records: [],
      experimentalReadHandoff: {
        kind: 'bigwig-height-morph-to-reads',
        morphDurationMs: 160,
        readsLoading: true,
        loadingAnimation: 'diagonal-scan',
      },
    };

    renderer.paint(paintArgsZoom(container, data, 10, { start: 0, end: 20 }, 200, 60));

    expect(renderer.getDiagnostics(container)).toMatchObject({
      experimentalHybridPhase: 'histogram',
      experimentalHybridHistogramLoadingMotion: true,
      experimentalHybridHistogramLoadingAnimation: 'diagonal-scan',
      pendingIntervalCount: 0,
      pendingIntervalVisible: false,
    });
    expect(experimentalHybridLoadingUniform(renderer, container)).toBe(1);
    expect(experimentalHybridLoadingStyleUniform(renderer, container)).toBe(4);
    expect(experimentalHybridOverflowLoadingUniform(renderer, container)).toBe(1);
    expect(experimentalHybridOverflowLoadingStyleUniform(renderer, container)).toBe(4);
    expect(renderer.hasPendingPaintWork(container)).toBe(true);
    renderer.unmount(container);
  });

  it('keeps the BigWig moving after tile requests settle until the exact-read front publishes', () => {
    const renderer = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 3,
      maxRows: 8,
    });
    const container = renderer.mount(mountArgs);
    const betweenTileSettlementAndReadPublication: PileupTrackData = {
      dataAuthority: 'static',
      coverage: {
        startBp: 0,
        bins: [2, 1, 2, 1],
        binSize: 5,
        maxDepth: 2,
      },
      records: [],
      referenceIntervals: [],
      experimentalReadHandoff: {
        kind: 'bigwig-height-morph-to-reads',
        morphDurationMs: 160,
        readsLoading: false,
      },
    };

    renderer.paint(
      paintArgsZoom(
        container,
        betweenTileSettlementAndReadPublication,
        10,
        { start: 0, end: 20 },
        200,
        60
      )
    );

    expect(renderer.getDiagnostics(container)).toMatchObject({
      experimentalHybridPhase: 'histogram',
      experimentalHybridExactFrontAvailable: false,
      experimentalHybridHistogramLoadingMotion: true,
      pendingIntervalCount: 0,
      pendingIntervalVisible: false,
    });
    expect(experimentalHybridLoadingUniform(renderer, container)).toBe(1);
    expect(renderer.hasPendingPaintWork(container)).toBe(true);

    renderer.paint(
      paintArgsZoom(
        container,
        betweenTileSettlementAndReadPublication,
        1.49 / 150,
        { start: 0, end: 20 },
        200,
        60
      )
    );
    expect(renderer.getDiagnostics(container)).toMatchObject({
      experimentalHybridPhase: 'histogram',
      experimentalHybridHistogramLoadingMotion: false,
    });
    expect(experimentalHybridLoadingUniform(renderer, container)).toBe(0);
    renderer.unmount(container);
  });

  it('shows no read-loading treatment below the LOD where exact reads are prepared', () => {
    const renderer = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 3,
      maxRows: 8,
    });
    const container = renderer.mount(mountArgs);
    const broadLoadingPublication: PileupTrackData = {
      dataAuthority: 'static',
      coverage: {
        startBp: 0,
        bins: [2, 1, 2, 1],
        binSize: 5,
        maxDepth: 2,
      },
      records: [],
      referenceIntervals: [{ startBp: 0, endBp: 20, state: 'pending' }],
      experimentalReadHandoff: {
        kind: 'bigwig-height-morph-to-reads',
        morphDurationMs: 160,
        readsLoading: true,
      },
    };

    renderer.paint(
      paintArgsZoom(container, broadLoadingPublication, 1.49 / 150, { start: 0, end: 20 }, 200, 60)
    );

    expect(renderer.getDiagnostics(container)).toMatchObject({
      experimentalHybridPhase: 'histogram',
      experimentalHybridHistogramLoadingMotion: false,
      pendingIntervalCount: 0,
      pendingIntervalVisible: false,
    });
    expect(experimentalHybridLoadingUniform(renderer, container)).toBe(0);
    expect(renderer.hasPendingPaintWork(container)).toBe(false);
    renderer.unmount(container);
  });

  it('does not animate a broad histogram at a tile LOD that cannot publish read rows', () => {
    const renderer = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 3,
      maxRows: 8,
    });
    const container = renderer.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      coverage: {
        startBp: 0,
        bins: [2, 1, 2, 1],
        binSize: 5,
        maxDepth: 2,
      },
      records: [],
      experimentalReadHandoff: {
        kind: 'bigwig-height-morph-to-reads',
        morphDurationMs: 160,
        readsLoading: true,
      },
    };

    renderer.paint(paintArgsZoom(container, data, 0.045, { start: 0, end: 20 }, 200, 60));

    expect(renderer.getDiagnostics(container)).toMatchObject({
      experimentalHybridPhase: 'histogram',
      experimentalHybridHistogramLoadingMotion: false,
    });
    expect(experimentalHybridLoadingUniform(renderer, container)).toBe(0);
    renderer.unmount(container);
  });

  it.each([10, 0.045])(
    'marks missing signal with a loading rail at %s px/bp without requiring read LOD',
    (pixelsPerBp) => {
      const renderer = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 3,
        maxRows: 8,
      });
      const container = renderer.mount(mountArgs);
      const data: PileupTrackData = {
        dataAuthority: 'static',
        records: [],
        referenceIntervals: [{ startBp: 0, endBp: 20, state: 'pending' }],
        experimentalReadHandoff: {
          kind: 'bigwig-height-morph-to-reads',
          morphDurationMs: 160,
          readsLoading: true,
          histogramPendingIntervals: [{ startBp: 0, endBp: 20, state: 'pending' }],
        },
      };

      renderer.paint(paintArgsZoom(container, data, pixelsPerBp, { start: 0, end: 20 }, 200, 60));

      expect(renderer.getDiagnostics(container)).toMatchObject({
        experimentalHybridPhase: 'histogram',
        experimentalHybridHistogramLoadingMotion: false,
        pendingIntervalVisible: true,
        pendingIntervalAppearance: 'signal-pending',
        pendingIntervalBandTopPx: 56,
        pendingIntervalBandHeightPx: 4,
      });
      expect(renderer.hasPendingPaintWork(container)).toBe(true);
      renderer.unmount(container);
    }
  );

  it('does not mistake an empty loaded histogram for pending BigWig data', () => {
    const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
    const container = renderer.mount(mountArgs);
    renderer.paint(
      paintArgsZoom(
        container,
        {
          dataAuthority: 'static',
          records: [],
          referenceIntervals: [{ startBp: 0, endBp: 20, state: 'pending' }],
          experimentalReadHandoff: {
            kind: 'bigwig-height-morph-to-reads',
            morphDurationMs: 160,
            readsLoading: true,
            histogramPendingIntervals: [],
          },
        },
        10,
        { start: 0, end: 20 },
        200,
        60
      )
    );
    expect(renderer.getDiagnostics(container)).toMatchObject({
      pendingIntervalVisible: false,
      experimentalHybridHistogramLoadingMotion: false,
    });
    renderer.unmount(container);
  });

  it('never covers resident BigWig bars with a skeleton during a finer histogram fetch', () => {
    const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
    const container = renderer.mount(mountArgs);
    renderer.paint(
      paintArgsZoom(
        container,
        {
          dataAuthority: 'static',
          records: [],
          coverage: { startBp: 0, bins: [3, 4], binSize: 10, maxDepth: 4 },
          referenceIntervals: [{ startBp: 0, endBp: 20, state: 'pending' }],
          experimentalReadHandoff: {
            kind: 'bigwig-height-morph-to-reads',
            morphDurationMs: 160,
            readsLoading: true,
            histogramPendingIntervals: [{ startBp: 0, endBp: 20, state: 'pending' }],
          },
        },
        10,
        { start: 0, end: 20 },
        200,
        60
      )
    );
    expect(renderer.getDiagnostics(container)).toMatchObject({
      pendingIntervalVisible: false,
      experimentalHybridHistogramLoadingMotion: true,
      coverageSignalNonzeroBinCount: 2,
    });
    renderer.unmount(container);
  });

  it('morphs BigWig to a loaded empty pileup without another viewport event', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_700);
    try {
      const renderer = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 3,
        maxRows: 8,
      });
      const container = renderer.mount(mountArgs);
      const loadedEmpty: PileupTrackData = {
        dataAuthority: 'static',
        coverage: {
          startBp: 0,
          bins: [3, 2, 4, 1],
          binSize: 5,
          maxDepth: 4,
        },
        records: [],
        readSource: {
          truncated: false,
          windowStartBp: 0,
          windowEndBp: 40,
          sourceGenerationKey: 'same-bam',
        },
        referenceIntervals: [],
        experimentalReadHandoff: {
          kind: 'bigwig-height-morph-to-reads',
          morphDurationMs: 160,
        },
      };
      const args = () => paintArgsZoom(container, loadedEmpty, 10, { start: 0, end: 20 }, 200, 60);

      renderer.paint(args());
      expect(renderer.getDiagnostics(container)).toMatchObject({
        experimentalHybridPhase: 'morph',
        experimentalHybridMorphProgress: 0,
        experimentalHybridExactFrontAvailable: true,
        rowsMeshRecordCount: 0,
        renderedReadDensityAlpha: 1,
      });
      expect(renderer.hasPendingPaintWork(container)).toBe(true);

      now.mockReturnValue(1_780);
      renderer.paint(args());
      expect(renderer.getDiagnostics(container)).toMatchObject({
        experimentalHybridPhase: 'morph',
        experimentalHybridMorphProgress: 0.5,
        readDensityMorph: 0.5,
      });

      now.mockReturnValue(1_860);
      renderer.paint(args());
      expect(renderer.getDiagnostics(container)).toMatchObject({
        experimentalHybridPhase: 'reads',
        experimentalHybridMorphProgress: 1,
        experimentalHybridExactFrontAvailable: true,
        readDensityMorph: 1,
        readDensityMaxFill: 0,
        renderedReadRowsAlpha: 0,
        renderedReadDensityAlpha: 0,
        readDisplayMode: 'empty',
      });
      expect(renderer.hasPendingPaintWork(container)).toBe(false);
      renderer.unmount(container);
    } finally {
      now.mockRestore();
    }
  });

  it('does not re-arm BigWig for prefetch state or a continuous overlapping BAM swap', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(2_000);
    try {
      const renderer = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 3,
        maxRows: 8,
      });
      const container = renderer.mount(mountArgs);
      const coverage = {
        startBp: 0,
        bins: [2, 1, 1, 1],
        binSize: 5,
        maxDepth: 2,
      };
      const base: PileupTrackData = {
        dataAuthority: 'static',
        coverage,
        records: [read(0, 5, 'lower-short'), read(0, 20, 'upper-long')],
        readSource: {
          truncated: false,
          windowStartBp: 0,
          windowEndBp: 40,
          sourceGenerationKey: 'same-bam',
        },
        experimentalReadHandoff: {
          kind: 'bigwig-height-morph-to-reads',
          morphDurationMs: 160,
        },
      };
      const args = (data: PileupTrackData) =>
        paintArgsZoom(container, data, 10, { start: 0, end: 20 }, 200, 60);

      renderer.paint(args(base));
      now.mockReturnValue(2_160);
      renderer.paint(args(base));
      const settled = renderer.getDiagnostics(container)!;
      expect(settled.experimentalHybridPhase).toBe('reads');
      const firstFront = settled.rowsMeshGenerationKey;

      now.mockReturnValue(2_200);
      renderer.paint(
        args({
          ...base,
          referenceIntervals: [{ startBp: 20, endBp: 40, state: 'pending' }],
        })
      );
      const prefetch = renderer.getDiagnostics(container)!;
      expect(prefetch.rowsMeshViewportCoverageFraction).toBe(1);
      expect(prefetch.experimentalHybridPhase).toBe('reads');
      expect(prefetch.experimentalHybridMorphProgress).toBe(1);
      expect(prefetch.renderedReadDensityAlpha).toBe(0);

      const replacement: PileupTrackData = {
        ...base,
        records: [...base.records!, read(21, 30, 'prefetched-read')],
      };
      now.mockReturnValue(2_240);
      for (let frame = 0; frame < 8; frame += 1) renderer.paint(args(replacement));
      const swapped = renderer.getDiagnostics(container)!;
      expect(swapped.rowsMeshGenerationKey).not.toBe(firstFront);
      expect(swapped.rowsMeshViewportCoverageFraction).toBe(1);
      expect(swapped.experimentalHybridPhase).toBe('reads');
      expect(swapped.experimentalHybridMorphProgress).toBe(1);
      expect(swapped.renderedReadDensityAlpha).toBe(0);

      renderer.unmount(container);
    } finally {
      now.mockRestore();
    }
  });

  it('does not call an old covering mesh exact while a completed tile adds a read', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(2_500);
    try {
      const renderer = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 3,
        maxRows: 8,
        readRowsAssignRecordsPerFrame: 1,
        readRowsBuildRecordsPerFrame: 1,
      });
      const container = renderer.mount(mountArgs);
      const shared = read(10, 20, 'shared');
      const broad: PileupTrackData = {
        dataAuthority: 'tile-engine',
        coverage: { startBp: 0, bins: [2, 3, 2, 1], binSize: 10, maxDepth: 3 },
        records: [read(0, 15, 'old-flank'), shared, read(25, 35, 'right-flank')],
        readSource: {
          truncated: false,
          windowStartBp: 0,
          windowEndBp: 40,
          sourceGenerationKey: 'same-bam',
        },
        referenceIntervals: [],
        experimentalReadHandoff: {
          kind: 'bigwig-height-morph-to-reads',
          morphDurationMs: 160,
        },
      };
      const args = (data: PileupTrackData) =>
        paintArgsZoom(container, data, 10, { start: 10, end: 20 }, 200, 60);
      for (let frame = 0; frame < 12; frame += 1) renderer.paint(args(broad));
      now.mockReturnValue(2_660);
      renderer.paint(args(broad));
      expect(renderer.getDiagnostics(container)).toMatchObject({
        experimentalHybridPhase: 'reads',
        experimentalHybridExactFrontAvailable: true,
        rowsMeshRecordCount: 3,
      });

      const narrow: PileupTrackData = {
        ...broad,
        records: [shared, read(12, 22, 'late-tile-read')],
        readSource: {
          truncated: false,
          windowStartBp: 5,
          windowEndBp: 30,
          sourceGenerationKey: 'same-bam',
        },
      };
      now.mockReturnValue(2_700);
      renderer.paint(args(narrow));
      expect(renderer.getDiagnostics(container)).toMatchObject({
        rowsMeshRecordCount: 3,
        rowsAssignmentBuildInProgress: true,
        experimentalHybridPhase: 'reads',
        experimentalHybridExactFrontAvailable: false,
        experimentalHybridSpatialContinuityFallback: true,
      });
      let frame = 0;
      while (renderer.hasPendingPaintWork(container) && frame++ < 50) renderer.paint(args(narrow));
      expect(renderer.hasPendingPaintWork(container)).toBe(false);
      expect(renderer.getDiagnostics(container)).toMatchObject({
        rowsMeshRecordCount: 2,
        experimentalHybridPhase: 'reads',
        experimentalHybridExactFrontAvailable: true,
        experimentalHybridSpatialContinuityFallback: false,
      });
      renderer.unmount(container);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps BigWig visible while rebuilding a completed BAM window with no resident exact pixels', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(3_000);
    try {
      const renderer = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 3,
        maxRows: 8,
        readRowsAssignRecordsPerFrame: 1,
        readRowsBuildRecordsPerFrame: 1,
      });
      const container = renderer.mount(mountArgs);
      const handoff = {
        kind: 'bigwig-height-morph-to-reads' as const,
        morphDurationMs: 160,
      };
      const loaded: PileupTrackData = {
        dataAuthority: 'static',
        coverage: {
          startBp: 0,
          bins: [2, 1, 1, 1],
          binSize: 5,
          maxDepth: 2,
        },
        records: [read(0, 5, 'lower-short'), read(0, 20, 'upper-long')],
        readSource: {
          truncated: false,
          windowStartBp: 0,
          windowEndBp: 40,
          sourceGenerationKey: 'same-bam',
        },
        experimentalReadHandoff: handoff,
      };
      const loadedArgs = () => paintArgsZoom(container, loaded, 10, { start: 0, end: 20 }, 200, 60);

      for (let frame = 0; frame < 8; frame += 1) renderer.paint(loadedArgs());
      now.mockReturnValue(3_160);
      renderer.paint(loadedArgs());
      expect(renderer.getDiagnostics(container)?.experimentalHybridPhase).toBe('reads');

      const elsewhere: PileupTrackData = {
        ...loaded,
        records: [],
        readSource: {
          truncated: false,
          windowStartBp: 100,
          windowEndBp: 140,
          sourceGenerationKey: 'same-bam',
        },
      };
      now.mockReturnValue(3_200);
      for (let frame = 0; frame < 8; frame += 1) {
        renderer.paint(paintArgsZoom(container, elsewhere, 10, { start: 100, end: 120 }, 200, 60));
      }

      now.mockReturnValue(3_240);
      renderer.paint(loadedArgs());
      const revisit = renderer.getDiagnostics(container)!;
      expect(revisit.rowsMeshViewportCoverageFraction).toBeLessThan(1);
      expect(revisit.experimentalHybridExactFrontAvailable).toBe(false);
      expect(revisit.experimentalHybridPhase).toBe('reads');
      expect(revisit.experimentalHybridMorphProgress).toBe(1);
      expect(revisit.renderedReadDensityAlpha).toBeGreaterThan(0.95);
      expect(revisit.experimentalHybridSpatialContinuityFallback).toBe(true);
      expect(revisit.experimentalHybridDensityExclusionStartBp).toBeNull();
      expect(revisit.experimentalHybridDensityExclusionEndBp).toBeNull();

      now.mockReturnValue(3_280);
      for (let frame = 0; frame < 8; frame += 1) renderer.paint(loadedArgs());
      const rebuilt = renderer.getDiagnostics(container)!;
      expect(rebuilt.rowsMeshViewportCoverageFraction).toBe(1);
      expect(rebuilt.experimentalHybridPhase).toBe('reads');
      expect(rebuilt.experimentalHybridMorphProgress).toBe(1);
      expect(rebuilt.renderedReadDensityAlpha).toBe(0);
      expect(rebuilt.experimentalHybridSpatialContinuityFallback).toBe(false);

      now.mockReturnValue(3_320);
      renderer.paint(
        paintArgsZoom(
          container,
          {
            ...loaded,
            readSource: {
              ...loaded.readSource,
              sourceGenerationKey: 'different-bam',
            },
          },
          10,
          { start: 0, end: 20 },
          200,
          60
        )
      );
      const differentSource = renderer.getDiagnostics(container)!;
      expect(differentSource.experimentalHybridPhase).toBe('histogram');
      expect(differentSource.experimentalHybridMorphProgress).toBe(0);

      renderer.unmount(container);
    } finally {
      now.mockRestore();
    }
  });

  it('gives resident reads and BigWig disjoint spatial ownership during a partial revisit', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(4_000);
    try {
      const renderer = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 3,
        maxRows: 8,
        readRowsAssignRecordsPerFrame: 1,
        readRowsBuildRecordsPerFrame: 1,
      });
      const container = renderer.mount(mountArgs);
      const handoff = {
        kind: 'bigwig-height-morph-to-reads' as const,
        morphDurationMs: 160,
      };
      const coverage = {
        startBp: 0,
        bins: [2, 1, 1, 1, 2, 1, 1, 1],
        binSize: 5,
        maxDepth: 2,
      };
      const first: PileupTrackData = {
        dataAuthority: 'static',
        coverage,
        records: [read(0, 5, 'first-a'), read(0, 20, 'first-b')],
        readSource: {
          truncated: false,
          windowStartBp: 0,
          windowEndBp: 20,
          sourceGenerationKey: 'same-bam',
        },
        experimentalReadHandoff: handoff,
      };
      const second: PileupTrackData = {
        ...first,
        records: [read(20, 25, 'second-a'), read(20, 40, 'second-b')],
        readSource: {
          ...first.readSource!,
          windowStartBp: 20,
          windowEndBp: 40,
        },
      };
      const combined: PileupTrackData = {
        ...first,
        records: [...first.records!, ...second.records!],
        readSource: {
          ...first.readSource!,
          windowStartBp: 0,
          windowEndBp: 40,
        },
      };

      for (let frame = 0; frame < 8; frame += 1) {
        renderer.paint(paintArgsZoom(container, first, 10, { start: 0, end: 20 }, 200, 60));
      }
      now.mockReturnValue(4_160);
      renderer.paint(paintArgsZoom(container, first, 10, { start: 0, end: 20 }, 200, 60));
      for (let frame = 0; frame < 8; frame += 1) {
        renderer.paint(paintArgsZoom(container, second, 10, { start: 20, end: 40 }, 200, 60));
      }
      now.mockReturnValue(4_320);
      renderer.paint(paintArgsZoom(container, second, 10, { start: 20, end: 40 }, 200, 60));

      now.mockReturnValue(4_360);
      renderer.paint(paintArgsZoom(container, combined, 10, { start: 10, end: 30 }, 200, 60));
      const partial = renderer.getDiagnostics(container)!;
      expect(partial.rowsMeshViewportCoverageFraction).toBeCloseTo(0.5, 6);
      expect(partial.experimentalHybridSpatialContinuityFallback).toBe(true);
      expect(partial.renderedReadRowsAlpha).toBeGreaterThan(0.95);
      expect(partial.renderedReadDensityAlpha).toBeGreaterThan(0.95);
      expect(partial.experimentalHybridDensityExclusionStartBp).toBe(20);
      expect(partial.experimentalHybridDensityExclusionEndBp).toBe(30);

      renderer.unmount(container);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps a completed right-hand read chunk visible while the adjacent left chunk loads', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(5_000);
    try {
      const renderer = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 3,
        maxRows: 8,
        readRowsAssignRecordsPerFrame: 1,
        readRowsBuildRecordsPerFrame: 1,
      });
      const container = renderer.mount(mountArgs);
      const rightRecords = [read(22, 28, 'right-a'), read(24, 38, 'right-b')];
      const rightReadSource = {
        truncated: false,
        windowStartBp: 20,
        windowEndBp: 40,
        sourceGenerationKey: 'same-bam',
      };
      const loaded: PileupTrackData = {
        dataAuthority: 'static',
        coverage: {
          startBp: 0,
          bins: [2, 1, 1, 1, 2, 1, 1, 1],
          binSize: 5,
          maxDepth: 2,
        },
        records: rightRecords,
        readSource: rightReadSource,
        referenceIntervals: [],
        experimentalReadHandoff: {
          kind: 'bigwig-height-morph-to-reads',
          morphDurationMs: 160,
        },
      };
      const view = (data: PileupTrackData, start: number) => {
        const args = paintArgsZoom(container, data, 10, { start, end: start + 20 }, 200, 60);
        return {
          ...args,
          pathMapper: {
            ...args.pathMapper,
            bpLeftX: (bp: number) => (bp - start) * 10,
          },
        };
      };
      const right = () => view(loaded, 20);
      const loadingLeft: PileupTrackData = {
        ...loaded,
        referenceIntervals: [{ startBp: 10, endBp: 20, state: 'pending' }],
      };
      const straddling = (start: number) => view(loadingLeft, start);

      for (let frame = 0; frame < 8; frame += 1) renderer.paint(right());
      now.mockReturnValue(5_160);
      renderer.paint(right());
      expect(renderer.getDiagnostics(container)).toMatchObject({
        experimentalHybridPhase: 'reads',
        renderedReadRowsAlpha: 1,
      });

      for (const start of [15, 10, 5]) {
        now.mockReturnValue(5_200 + start);
        const args = straddling(start);
        renderer.paint(args);
        expect(renderer.getDiagnostics(container)).toMatchObject({
          rowsMeshViewportCoverageFraction: (start + 20 - 20) / 20,
          experimentalHybridPhase: 'reads',
          experimentalHybridSpatialContinuityFallback: true,
          experimentalHybridHistogramLoadingMotion: false,
          renderedReadRowsAlpha: 1,
          renderedReadDensityAlpha: 1,
          experimentalHybridDensityExclusionStartBp: 20,
          experimentalHybridDensityExclusionEndBp: start + 20,
        });
        expect(
          renderer.hitTestReadEvent(container, {
            trackId: 'bam-right',
            localX: (23 - start) * 10,
            localY: 1,
            screenX: (23 - start) * 10,
            screenY: 51,
            pathMapper: args.pathMapper,
            chromosomeGlobalStartBp: 0,
          })?.readId
        ).toBe('right-a');
      }

      now.mockReturnValue(5_240);
      renderer.paint(right());
      renderer.paint(straddling(10));
      expect(renderer.getDiagnostics(container)?.renderedReadRowsAlpha).toBe(1);
      expect(renderer.getDiagnostics(container)?.experimentalHybridPhase).toBe('reads');

      const bothReady: PileupTrackData = {
        ...loaded,
        records: [read(12, 18, 'left-a'), ...rightRecords],
        readSource: {
          ...rightReadSource,
          windowStartBp: 10,
        },
      };
      now.mockReturnValue(5_260);
      const combinedArgs = view(bothReady, 15);
      for (let frame = 0; frame < 30; frame += 1) {
        renderer.paint(combinedArgs);
        expect(renderer.getDiagnostics(container)?.renderedReadRowsAlpha).toBe(1);
        expect(renderer.getDiagnostics(container)?.experimentalHybridPhase).toBe('reads');
        expect(
          renderer.hitTestReadEvent(container, {
            trackId: 'bam-right',
            localX: 80,
            localY: 1,
            screenX: 80,
            screenY: 51,
            pathMapper: combinedArgs.pathMapper,
            chromosomeGlobalStartBp: 0,
          })?.readId
        ).toBe('right-a');
      }
      expect(renderer.getDiagnostics(container)?.rowsMeshRecordCount).toBe(3);
      renderer.unmount(container);
    } finally {
      now.mockRestore();
    }
  });

  it('settles a superseded multi-batch handoff without another camera event when continuation rAFs vanish', () => {
    vi.useFakeTimers({ now: 10_000 });
    let loop: WebGLRenderLoop | null = null;
    let renderer: PixiPileupTrackRenderer | null = null;
    let container: ReturnType<PixiPileupTrackRenderer['mount']> | null = null;
    try {
      let nextRafId = 0;
      const pendingRaf = new Map<number, FrameRequestCallback>();
      vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn((callback: FrameRequestCallback) => {
          const id = ++nextRafId;
          pendingRaf.set(id, callback);
          return id;
        })
      );
      vi.stubGlobal(
        'cancelAnimationFrame',
        vi.fn((id: number) => {
          pendingRaf.delete(id);
        })
      );

      renderer = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 3,
        maxRows: 8,
        readRowsAssignRecordsPerFrame: 1,
        readRowsBuildRecordsPerFrame: 1,
      });
      container = renderer.mount(mountArgs);
      const coverage = {
        startBp: 0,
        bins: [2, 4, 5, 3, 6, 2, 1, 3],
        binSize: 5,
        maxDepth: 6,
      };
      const handoff = {
        kind: 'bigwig-height-morph-to-reads' as const,
        morphDurationMs: 160,
      };
      let activeData: PileupTrackData = {
        dataAuthority: 'static',
        coverage,
        records: [],
        coverageCutoffDepth: 8,
        experimentalReadHandoff: handoff,
      };
      const finalRecords = Array.from({ length: 12 }, (_, index) =>
        read(index % 4, 14 + (index % 3), `final-${index}`)
      );
      const trace: Array<{
        phase: string;
        assignment: boolean;
        mesh: boolean;
        progress: number;
        recordCount: number;
      }> = [];
      const scheduledRenderer = {
        render: vi.fn(() => {
          renderer!.paint(
            paintArgsZoom(container!, activeData, 10, { start: 0, end: 20 }, 200, 60)
          );
          const diagnostics = renderer!.getDiagnostics(container!)!;
          trace.push({
            phase: diagnostics.experimentalHybridPhase,
            assignment: diagnostics.rowsAssignmentBuildInProgress,
            mesh: diagnostics.rowsMeshBuildInProgress,
            progress: diagnostics.experimentalHybridMorphProgress,
            recordCount: diagnostics.rowsMeshRecordCount,
          });
          return renderer!.hasPendingPaintWork(container!);
        }),
      };
      const rafRef = { current: null as number | null };
      const renderRevisionRef = { current: 1 };
      const renderState = {
        performanceMode: 'default',
        morph: 0,
        viewOffset: 0,
        zoom: 10,
        width: 200,
        height: 60,
        geometryHeight: 60,
        themeMode: 'light',
        selectedIds: new Set<number>(),
        hoveredId: null,
        viewportRange: null,
        highlightRange: null,
        digestFocusRange: null,
        residueLinkRange: null,
        cursorPosition: null,
        hoverPosition: null,
        hoveredCodon: null,
        selectedCodons: [],
        hoveredOrf: null,
        selectedOrf: null,
        hoveredCutSiteId: null,
        perfPanelVisible: false,
        showResidueNumbers: false,
      };
      loop = startWebGLRenderLoop({
        instanceId: 'real-superseded-hybrid-handoff',
        app: { render: vi.fn() },
        renderer: scheduledRenderer,
        interaction: { flushInteraction: vi.fn() },
        stateRef: { current: renderState },
        renderRevisionRef,
        visibleRef: { current: true },
        rafRef,
        frameCountRef: { current: 0 },
        lastFrameTRef: { current: 0 },
        presentedFrameListenersRef: { current: new Set() },
        postPresentWorkRef: { current: new Set() },
        isDestroyed: () => false,
        onFatalFrameError: vi.fn(),
      } as unknown as Parameters<typeof startWebGLRenderLoop>[0]);

      const runNextFrame = () => {
        const next = pendingRaf.entries().next().value as
          | [number, FrameRequestCallback]
          | undefined;
        expect(next).toBeDefined();
        pendingRaf.delete(next![0]);
        next![1](performance.now());
      };

      runNextFrame();
      expect(renderer.getDiagnostics(container)?.experimentalHybridPhase).toBe('histogram');

      activeData = {
        ...activeData,
        records: finalRecords.slice(0, 5),
        readSource: {
          truncated: false,
          windowStartBp: 0,
          windowEndBp: 40,
          sourceGenerationKey: 'same-bam',
        },
        referenceIntervals: [{ startBp: 20, endBp: 40, state: 'pending' }],
      };
      renderRevisionRef.current += 1;
      loop.wake();
      const discardedFirstBatchFrame = rafRef.current;
      expect(discardedFirstBatchFrame).not.toBeNull();
      pendingRaf.delete(discardedFirstBatchFrame!);
      vi.advanceTimersByTime(101);
      expect(rafRef.current).not.toBe(discardedFirstBatchFrame);
      runNextFrame();
      expect(renderer.getDiagnostics(container)?.rowsAssignmentBuildInProgress).toBe(true);

      activeData = {
        ...activeData,
        records: finalRecords,
        referenceIntervals: [],
      };
      renderRevisionRef.current += 1;
      loop.wake();
      runNextFrame();

      let discardedContinuationCount = 0;
      for (let frame = 0; frame < 100; frame += 1) {
        const diagnostics = renderer.getDiagnostics(container)!;
        const settled =
          diagnostics.experimentalHybridPhase === 'reads' &&
          diagnostics.experimentalHybridMorphProgress === 1 &&
          diagnostics.rowsMeshRecordCount === finalRecords.length &&
          !diagnostics.rowsAssignmentBuildInProgress &&
          !diagnostics.rowsRetainBuildInProgress &&
          !diagnostics.rowsMeshBuildInProgress &&
          !renderer.hasPendingPaintWork(container);
        if (settled) break;

        const discardedRafId = rafRef.current;
        expect(discardedRafId).not.toBeNull();
        pendingRaf.delete(discardedRafId!);
        vi.advanceTimersByTime(101);
        expect(rafRef.current).not.toBe(discardedRafId);
        discardedContinuationCount += 1;
        runNextFrame();
      }

      const settled = renderer.getDiagnostics(container)!;
      expect(discardedContinuationCount).toBeGreaterThan(10);
      expect(trace.some((frame) => frame.assignment)).toBe(true);
      expect(trace.some((frame) => frame.mesh)).toBe(true);
      expect(trace.some((frame) => frame.phase === 'morph' && frame.progress < 1)).toBe(true);
      expect(settled).toMatchObject({
        experimentalHybridPhase: 'reads',
        experimentalHybridMorphProgress: 1,
        experimentalHybridExactFrontAvailable: true,
        rowsMeshRecordCount: finalRecords.length,
        rowsAssignmentBuildInProgress: false,
        rowsRetainBuildInProgress: false,
        rowsMeshBuildInProgress: false,
        readSourceWindowCoverageFraction: 1,
        rowsMeshViewportCoverageFraction: 1,
        renderedReadRowsAlpha: 1,
        renderedReadDensityAlpha: 0,
        readDisplayMode: 'reads',
        pendingIntervalCount: 0,
      });
      expect(renderer.hasPendingPaintWork(container)).toBe(false);
      const finalPaintArgs = paintArgsZoom(
        container,
        activeData,
        10,
        { start: 0, end: 20 },
        200,
        60
      );
      expect(
        renderer.hitTestReadEvent(container, {
          trackId: 'hybrid-pileup',
          localX: 20,
          localY: 1,
          screenX: 20,
          screenY: 51,
          pathMapper: finalPaintArgs.pathMapper,
          chromosomeGlobalStartBp: 0,
        })
      ).toMatchObject({
        trackId: 'hybrid-pileup',
        sourceGenerationKey: 'same-bam',
        readId: 'final-0',
      });
    } finally {
      loop?.stop();
      if (renderer && container) renderer.unmount(container);
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe('pileup read-difference geometry', () => {
  it('matches the read body height and center while preserving the one-pixel row gap', () => {
    expect(pileupReadBodyVerticalGeometry(12, 3.4)).toEqual({
      topPx: 12.5,
      heightPx: 2.4,
    });
  });
});

describe('PixiPileupTrackRenderer GPU preparation', () => {
  it('links every reachable pileup presentation program before interaction', () => {
    const linkedProgramKeys: number[] = [];
    const renderer = {
      shader: {
        bind: vi.fn((shader: { glProgram: { _key: number } }, _skipSync?: boolean) => {
          linkedProgramKeys.push(shader.glProgram._key);
        }),
        resetState: vi.fn(),
      },
    };
    const pileup = new PixiPileupTrackRenderer({ type: 'pileup-test' });

    pileup.prepareGpuPrograms(renderer as never);

    expect(renderer.shader.bind).toHaveBeenCalledTimes(6);
    expect(renderer.shader.bind.mock.calls.every((call) => call[1] === true)).toBe(true);
    expect(new Set(linkedProgramKeys).size).toBe(6);
    expect(renderer.shader.resetState).toHaveBeenCalledTimes(1);
  });
});

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      fillStyle: '',
      textBaseline: '',
      scale: () => undefined,
      measureText: (text: string) => ({ width: text.length * 6 }),
      fillText: () => undefined,
      clearRect: () => undefined,
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

const CHROM = { id: 'chr7', displayName: 'chr7', length: 159_345_973, cytobands: [] };
const mountArgs: TrackMountArgs = { chromosome: CHROM, theme: webglThemeForMode('light') };
type PileupTrackDataFixture = Omit<PileupTrackData, 'dataAuthority'> & {
  dataAuthority?: PileupTrackData['dataAuthority'];
};

function read(
  start: number,
  end: number,
  id = `${start}-${end}`,
  overrides: Partial<PileupRecord> = {}
): PileupRecord {
  return { chrom: CHROM.id, start, end, readId: id, strand: '+', mapq: 60, ...overrides };
}

function oklch(color: number): { lightness: number; chroma: number; hue: number } {
  const srgb = [color >> 16, (color >> 8) & 0xff, color & 0xff].map(
    (channel) => (channel & 0xff) / 255
  );
  const [r, g, b] = srgb.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  const lRoot = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mRoot = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const sRoot = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot;
  const a = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot;
  const bAxis = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot;
  const hue = (Math.atan2(bAxis, a) * 180) / Math.PI;
  return {
    lightness,
    chroma: Math.hypot(a, bAxis),
    hue: hue < 0 ? hue + 360 : hue,
  };
}

function paintArgs(
  container: object,
  data: PileupTrackDataFixture
): TrackPaintArgs<PileupTrackData> {
  return paintArgsZoom(container, data, 0.01);
}

function paintArgsZoom(
  container: object,
  data: PileupTrackDataFixture,
  pixelsPerBp: number,
  viewportBpRange = { start: 0, end: 100_000 },
  viewportWidthPx = 800,
  layoutHeightPx = 240,
  theme: WebGLRenderTheme = webglThemeForMode('light')
): TrackPaintArgs<PileupTrackData> {
  const trackData: PileupTrackData = { dataAuthority: 'static', ...data };
  return {
    container,
    data: trackData,
    chromosome: CHROM,
    pathMapper: {
      viewStartBp: viewportBpRange.start,
      viewEndBp: viewportBpRange.end,
      pixelsPerBp,
      bpLeftX: (bp: number) => bp * pixelsPerBp,
    },
    viewportBpRange,
    viewportWidthPx,
    viewportHeightPx: 400,
    layoutEntry: {
      id: 'pileup-test',
      top: 50,
      height: layoutHeightPx,
      contentClipped: false,
      hidden: false,
    },
    containerTopPx: 50,
    renderer: undefined,
    theme,
  } as unknown as TrackPaintArgs<PileupTrackData>;
}

function paintCommittedReadFront(
  renderer: PixiPileupTrackRenderer,
  args: TrackPaintArgs<PileupTrackData>
): void {
  renderer.paint(args);
  for (let frame = 0; renderer.hasPendingPaintWork(args.container) && frame < 20; frame += 1) {
    renderer.paint(args);
  }
  expect(renderer.hasPendingPaintWork(args.container)).toBe(false);
}

function drawnDensityHeightStats(
  renderer: unknown,
  container: object,
  vertexCount: number,
  densityHeightPx: number
): { edgeCount: number; longestFlatRunColumns: number; stdDev: number } {
  const fills = drawnDensityProfile(renderer, container, vertexCount, densityHeightPx);
  const columns = fills.length;
  let sum = 0;
  let sumSq = 0;
  for (const fill of fills) {
    sum += fill;
    sumSq += fill * fill;
  }
  const mean = columns > 0 ? sum / columns : 0;
  const stdDev = columns > 0 ? Math.sqrt(Math.max(0, sumSq / columns - mean * mean)) : 0;
  const edgeThreshold = 0.03;
  let edgeCount = 0;
  let longestFlatRunColumns = columns > 0 ? 1 : 0;
  let run = columns > 0 ? 1 : 0;
  for (let c = 1; c < columns; c++) {
    if (Math.abs(fills[c] - fills[c - 1]) >= edgeThreshold) {
      edgeCount++;
      longestFlatRunColumns = Math.max(longestFlatRunColumns, run);
      run = 1;
    } else {
      run++;
    }
  }
  longestFlatRunColumns = Math.max(longestFlatRunColumns, run);
  return { edgeCount, longestFlatRunColumns, stdDev };
}

function experimentalHybridCoverageColor(renderer: unknown, container: object): number | null {
  const state = (
    renderer as {
      containerState: WeakMap<
        object,
        {
          densityRowsArrays: { color: Float32Array } | null;
          coverageSignalInstancedLayer: {
            shader: {
              resources: {
                coverageSignalUniforms: {
                  uniforms: { uCoverageColor: Float32Array };
                };
              };
            } | null;
          };
        }
      >;
    }
  ).containerState.get(container);
  const color =
    state?.coverageSignalInstancedLayer.shader?.resources.coverageSignalUniforms.uniforms
      .uCoverageColor ?? state?.densityRowsArrays?.color;
  if (!color) return null;
  const channel = (index: number) => Math.round((color[index] ?? 0) * 255);
  return (channel(0) << 16) | (channel(1) << 8) | channel(2);
}

function experimentalHybridLoadingUniform(renderer: unknown, container: object): number | null {
  const state = (
    renderer as {
      containerState: WeakMap<
        object,
        {
          densityRows: {
            shader: {
              resources: {
                annotationUniforms: { uniforms: { uLoadingMotionActive: number } };
              };
            };
          } | null;
        }
      >;
    }
  ).containerState.get(container);
  return (
    state?.densityRows?.shader.resources.annotationUniforms.uniforms.uLoadingMotionActive ?? null
  );
}

function experimentalHybridLoadingStyleUniform(
  renderer: unknown,
  container: object
): number | null {
  const state = (
    renderer as {
      containerState: WeakMap<
        object,
        {
          densityRows: {
            shader: {
              resources: {
                annotationUniforms: { uniforms: { uLoadingMotionStyle: number } };
              };
            };
          } | null;
        }
      >;
    }
  ).containerState.get(container);
  return (
    state?.densityRows?.shader.resources.annotationUniforms.uniforms.uLoadingMotionStyle ?? null
  );
}

function experimentalHybridOverflowLoadingUniform(
  renderer: unknown,
  container: object
): number | null {
  const state = (
    renderer as {
      containerState: WeakMap<
        object,
        {
          overflowRows: {
            shader: {
              resources: {
                annotationUniforms: { uniforms: { uLoadingMotionActive: number } };
              };
            };
          } | null;
        }
      >;
    }
  ).containerState.get(container);
  return (
    state?.overflowRows?.shader.resources.annotationUniforms.uniforms.uLoadingMotionActive ?? null
  );
}

function experimentalHybridOverflowLoadingStyleUniform(
  renderer: unknown,
  container: object
): number | null {
  const state = (
    renderer as {
      containerState: WeakMap<
        object,
        {
          overflowRows: {
            shader: {
              resources: {
                annotationUniforms: { uniforms: { uLoadingMotionStyle: number } };
              };
            };
          } | null;
        }
      >;
    }
  ).containerState.get(container);
  return (
    state?.overflowRows?.shader.resources.annotationUniforms.uniforms.uLoadingMotionStyle ?? null
  );
}

function drawnDensityProfile(
  renderer: unknown,
  container: object,
  vertexCount: number,
  densityHeightPx: number
): Float32Array {
  const state = (
    renderer as {
      containerState: WeakMap<
        object,
        {
          densityRows: { buffers: Array<{ data: Float32Array }> } | null;
          coverageSignalInstancedLayer: {
            data: Float32Array | null;
            instanceCount: number;
          };
        }
      >;
    }
  ).containerState.get(container);
  const instanced = state?.coverageSignalInstancedLayer;
  if (instanced?.data && instanced.instanceCount > 0) {
    const columns = Math.min(Math.floor(vertexCount / 6), instanced.instanceCount);
    const fills = new Float32Array(columns);
    for (let column = 0; column < columns; column += 1) {
      const offset = column * 6;
      const height = Math.max(instanced.data[offset + 4] ?? 0, instanced.data[offset + 5] ?? 0);
      fills[column] = densityHeightPx > 0 ? height / densityHeightPx : 0;
    }
    return fills;
  }
  const offsetCenter = state?.densityRows?.buffers[4]?.data;
  expect(offsetCenter).toBeInstanceOf(Float32Array);
  const columns = Math.floor(vertexCount / 6);
  const fills = new Float32Array(columns);
  for (let c = 0; c < columns; c++) {
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < 6; k++) {
      const y = offsetCenter![c * 6 + k] ?? 0;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const h = Math.max(0, maxY - minY);
    const fill = densityHeightPx > 0 ? h / densityHeightPx : 0;
    fills[c] = fill;
  }
  return fills;
}

function fillSummary(fills: Float32Array): { p50: number; p90: number; mean: number } {
  const sorted = Array.from(fills).sort((a, b) => a - b);
  const mean =
    sorted.length > 0 ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : 0;
  return { p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), mean };
}

function quantile(sorted: ReadonlyArray<number>, q: number): number {
  if (sorted.length === 0) return 0;
  const clamped = Math.max(0, Math.min(1, q));
  const pos = (sorted.length - 1) * clamped;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo] ?? 0;
  const t = pos - lo;
  return (sorted[lo] ?? 0) * (1 - t) + (sorted[hi] ?? 0) * t;
}

function observeIndexedBinReads(source: ReadonlyArray<number>): {
  bins: ReadonlyArray<number>;
  indexedReads: () => number;
  reset: () => void;
} {
  let indexedReadCount = 0;
  const bins = new Proxy([...source], {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
        indexedReadCount += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    bins,
    indexedReads: () => indexedReadCount,
    reset: () => {
      indexedReadCount = 0;
    },
  };
}

describe('PixiPileupTrackRenderer.getDiagnostics', () => {
  it('does not duplicate the drawer-owned track label on the canvas', () => {
    const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const container = renderer.mount(mountArgs);

    expect(container.children.map((child) => child.label)).toEqual([
      'pileup-histogram-alternate-guides',
      'pileup-pending-reference-motion',
    ]);
    expect(container.children.some((child) => child.label === 'Drawer label')).toBe(false);
  });

  it('hit-tests a sparse visible read-difference mark with composite BAM identity', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const container = renderer.mount(mountArgs);
    const record = read(100, 110, 'duplicate-qname', {
      flag: 99,
      pair: { paired: true, properPair: true, readNumber: 1, mateStart: 150 },
      mismatches: [{ pos: 104, kind: 'sub', refBase: 'A', readBase: 'T' }],
    });
    const args = paintArgsZoom(
      container,
      { records: [record], readSource: { truncated: false } },
      8,
      { start: 90, end: 190 },
      800
    );

    paintCommittedReadFront(renderer, args);

    expect(
      renderer.hitTestReadEvent(container, {
        trackId: 'tumor-bam',
        localX: 104 * 8 + 1,
        localY: 1,
        screenX: 104 * 8 + 1,
        screenY: 51,
        pathMapper: args.pathMapper,
        chromosomeGlobalStartBp: 0,
      })
    ).toEqual({
      trackId: 'tumor-bam',
      sourceGenerationKey: '',
      readId: 'duplicate-qname',
      chrom: 'chr7',
      referenceStart: 100,
      start: 100,
      end: 110,
      flag: 99,
      strand: '+',
      mapq: 60,
      pair: record.pair,
      event: record.mismatches?.[0],
      bodyRect: { left: 800, top: 50.5, width: 80, height: 2 },
      hitRect: { left: 800, top: 50, width: 80, height: 3 },
      screenX: 833,
      screenY: 51,
    });
    expect(renderer.getDiagnostics(container)?.readDifferenceHitTestCandidateCount).toBe(1);
  });

  it.each(['replace', 'cancel-source'] as const)(
    'keeps read bodies and difference hits atomic during held preparation: %s',
    (mode) => {
      const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test' });
      const container = renderer.mount(mountArgs);
      const initial = read(100, 110, 'initial', {
        mismatches: [{ pos: 104, kind: 'sub', refBase: 'A', readBase: 'T' }],
      });
      const replacement = read(100, 110, 'replacement', {
        mismatches: [{ pos: 106, kind: 'sub', refBase: 'C', readBase: 'G' }],
      });
      const newest = read(100, 110, 'newest', {
        mismatches: [{ pos: 108, kind: 'sub', refBase: 'G', readBase: 'A' }],
      });
      const args = (record: PileupRecord, generation: string) =>
        paintArgsZoom(
          container,
          {
            dataAuthority: 'tile-engine',
            records: [record],
            readSource: {
              truncated: false,
              windowStartBp: 90,
              windowEndBp: 190,
              sourceGenerationKey: generation,
            },
          },
          4,
          { start: 90, end: 190 },
          800,
          240
        );
      const initialArgs = args(initial, 'source-a');
      const replacementArgs = args(replacement, mode === 'replace' ? 'source-a' : 'source-b');
      const newestArgs = args(newest, 'source-c');
      const hit = (position: number, paint: TrackPaintArgs<PileupTrackData>, row = 0) =>
        renderer.hitTestReadEvent(container, {
          trackId: 'test-bam',
          localX: position * 4 + 1,
          localY: row * (renderer.getDiagnostics(container)?.effectiveRowHeightPx ?? 3) + 1,
          screenX: position * 4 + 1,
          screenY: 51 + row * (renderer.getDiagnostics(container)?.effectiveRowHeightPx ?? 3),
          pathMapper: paint.pathMapper,
          chromosomeGlobalStartBp: 0,
        });
      let restore = () => {};
      try {
        renderer.paint(initialArgs);
        for (let count = 0; renderer.hasPendingPaintWork(container) && count < 20; count++) {
          renderer.paint(initialArgs);
        }
        const before = renderer.getDiagnostics(container)!;
        expect(before.readDifferenceMarkCount).toBe(1);
        expect(hit(104, initialArgs)).toMatchObject({ readId: 'initial', event: { pos: 104 } });

        let hold = true;
        const original = PileupReadDifferenceLayer.prototype.advancePreparation;
        const preparation = vi
          .spyOn(PileupReadDifferenceLayer.prototype, 'advancePreparation')
          .mockImplementation(function (
            this: PileupReadDifferenceLayer,
            ...parameters: Parameters<typeof original>
          ) {
            return hold ? 0 : original.apply(this, parameters);
          });
        restore = () => preparation.mockRestore();
        for (let count = 0; count < 3; count++) renderer.paint(replacementArgs);
        expect(renderer.hasPendingPaintWork(container)).toBe(true);
        const pending = renderer.getDiagnostics(container)!;
        expect(pending.readDifferenceBuildCount).toBe(before.readDifferenceBuildCount);
        if (mode === 'replace') {
          expect(renderer.getReadPresentationSnapshot(container)?.kind).toBe('pending');
          expect(pending.rowsMeshGenerationKey).toBe(before.rowsMeshGenerationKey);
          expect(hit(104, replacementArgs)).toMatchObject({
            readId: 'initial',
            event: { pos: 104 },
          });
        } else {
          expect(pending.readDifferenceLayerVisible).toBe(false);
          expect(hit(104, replacementArgs)).toBeNull();
          for (let count = 0; count < 3; count++) renderer.paint(newestArgs);
          expect(renderer.getDiagnostics(container)?.readDifferenceLayerVisible).toBe(false);
        }

        hold = false;
        const finalArgs = mode === 'replace' ? replacementArgs : newestArgs;
        for (let count = 0; renderer.hasPendingPaintWork(container) && count < 20; count++) {
          renderer.paint(finalArgs);
        }
        expect(renderer.hasPendingPaintWork(container)).toBe(false);
        expect(renderer.getDiagnostics(container)).toMatchObject({
          readDifferenceMarkCount: 1,
          readDifferenceInstanceCount: 1,
          readDifferenceLayerVisible: true,
        });
        const position = mode === 'replace' ? 106 : 108;
        const committedRow = mode === 'replace' ? 1 : 0;
        expect(hit(position, finalArgs, committedRow)).toMatchObject({
          readId: mode === 'replace' ? 'replacement' : 'newest',
          sourceGenerationKey: mode === 'replace' ? 'source-a' : 'source-c',
          event: { pos: position },
        });
        expect(hit(mode === 'replace' ? 104 : 106, finalArgs, committedRow)?.event).toBeUndefined();
      } finally {
        restore();
        renderer.unmount(container);
      }
    }
  );

  it.each(['offscreen', 'visible'] as const)(
    'arbitrates a pending read body against newer %s data',
    (addition) => {
      const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test' });
      const container = renderer.mount(mountArgs);
      const initial = read(100, 110, 'initial', {
        mismatches: [{ pos: 104, kind: 'sub', readBase: 'T' }],
      });
      const staged = read(150, 160, 'staged', {
        mismatches: [{ pos: 154, kind: 'sub', readBase: 'G' }],
      });
      const late =
        addition === 'offscreen'
          ? read(220, 230, 'late')
          : read(170, 180, 'late', {
              mismatches: [{ pos: 174, kind: 'sub', readBase: 'C' }],
            });
      const nextRecords = [staged, late];
      const args = (records: PileupRecord[], end: number) =>
        paintArgsZoom(
          container,
          {
            dataAuthority: 'tile-engine',
            records,
            readSource: {
              truncated: false,
              windowStartBp: 90,
              windowEndBp: end,
              sourceGenerationKey: 'source-a',
            },
          },
          4,
          { start: 90, end: 190 },
          800,
          240
        );
      const initialArgs = args([initial], 190);
      const stagedArgs = args([staged], 190);
      const nextArgs = args(nextRecords, 290);
      const hit = (position: number) =>
        renderer.hitTestReadEvent(container, {
          trackId: 'test-bam',
          localX: position * 4 + 1,
          localY: 1,
          screenX: position * 4 + 1,
          screenY: 51,
          pathMapper: nextArgs.pathMapper,
          chromosomeGlobalStartBp: 0,
        });
      let restorePreparation = () => {};
      let restoreAssignment = () => {};
      try {
        renderer.paint(initialArgs);
        for (let frame = 0; renderer.hasPendingPaintWork(container) && frame < 20; frame++) {
          renderer.paint(initialArgs);
        }
        expect(hit(104)?.readId).toBe('initial');
        let hold = true;
        const advance = PileupReadDifferenceLayer.prototype.advancePreparation;
        const preparation = vi
          .spyOn(PileupReadDifferenceLayer.prototype, 'advancePreparation')
          .mockImplementation(function (
            this: PileupReadDifferenceLayer,
            ...parameters: Parameters<typeof advance>
          ) {
            return hold ? 0 : advance.apply(this, parameters);
          });
        restorePreparation = () => preparation.mockRestore();
        for (let frame = 0; frame < 3; frame++) renderer.paint(stagedArgs);
        expect(renderer.hasPendingPaintWork(container)).toBe(true);
        let newerAssignmentBeforeCommit = false;
        const begin = PersistentRowLayout.prototype.beginAssignment;
        const assignment = vi
          .spyOn(PersistentRowLayout.prototype, 'beginAssignment')
          .mockImplementation(function (
            this: PersistentRowLayout,
            ...parameters: Parameters<typeof begin>
          ) {
            if (parameters[0] === nextRecords && hit(154)?.readId !== 'staged') {
              newerAssignmentBeforeCommit = true;
            }
            return begin.apply(this, parameters);
          });
        restoreAssignment = () => assignment.mockRestore();
        renderer.paint(nextArgs);
        if (addition === 'offscreen') expect(newerAssignmentBeforeCommit).toBe(false);
        expect(renderer.getReadPresentationSnapshot(container)?.kind).toBe('pending');
        hold = false;
        for (let frame = 0; frame < 100; frame++) {
          renderer.paint(nextArgs);
          if (
            renderer.getReadPresentationSnapshot(container)?.kind === 'reads' &&
            !renderer.hasPendingPaintWork(container)
          )
            break;
        }
        if (addition === 'offscreen') expect(newerAssignmentBeforeCommit).toBe(false);
        expect(renderer.getReadPresentationSnapshot(container)?.kind).toBe('reads');
        expect(hit(154)?.readId).toBe('staged');
        if (addition === 'visible') expect(hit(174)?.readId).toBe('late');
      } finally {
        restoreAssignment();
        restorePreparation();
        renderer.unmount(container);
      }
    }
  );

  it.each(['replace', 'cancel-source'] as const)(
    'keeps read fronts and hits paired while height preparation is held: %s',
    (mode) => {
      const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test' });
      const container = renderer.mount(mountArgs);
      const initial = read(100, 110, 'initial', {
        mismatches: [{ pos: 104, kind: 'sub', refBase: 'A', readBase: 'T' }],
      });
      const replacement = read(100, 110, 'replacement', {
        mismatches: [{ pos: 106, kind: 'sub', refBase: 'C', readBase: 'G' }],
      });
      const newest = read(100, 110, 'newest', {
        mismatches: [{ pos: 108, kind: 'sub', refBase: 'G', readBase: 'A' }],
      });
      const args = (record: PileupRecord, generation: string) =>
        paintArgsZoom(
          container,
          {
            dataAuthority: 'tile-engine',
            records: [record],
            readSource: {
              truncated: false,
              windowStartBp: 90,
              windowEndBp: 190,
              sourceGenerationKey: generation,
            },
          },
          4,
          { start: 90, end: 190 },
          800,
          240
        );
      const initialArgs = args(initial, 'source-a');
      const replacementArgs = args(replacement, mode === 'replace' ? 'source-a' : 'source-b');
      const newestArgs = args(newest, 'source-c');
      const hit = (position: number, paint: TrackPaintArgs<PileupTrackData>, row = 0) =>
        renderer.hitTestReadEvent(container, {
          trackId: 'test-bam',
          localX: position * 4 + 1,
          localY: row * (renderer.getDiagnostics(container)?.effectiveRowHeightPx ?? 3) + 1,
          screenX: position * 4 + 1,
          screenY: 51 + row * (renderer.getDiagnostics(container)?.effectiveRowHeightPx ?? 3),
          pathMapper: paint.pathMapper,
          chromosomeGlobalStartBp: 0,
        });
      let restore = () => {};
      try {
        renderer.paint(initialArgs);
        for (let count = 0; renderer.hasPendingPaintWork(container) && count < 20; count++) {
          renderer.paint(initialArgs);
        }
        const before = renderer.getDiagnostics(container)!;
        expect(before.readDifferenceMarkCount).toBe(1);
        expect(hit(104, initialArgs)).toMatchObject({ readId: 'initial', event: { pos: 104 } });

        let hold = true;
        const original = rowHeightField.advanceReadRowHeightFieldJob;
        const preparation = vi
          .spyOn(rowHeightField, 'advanceReadRowHeightFieldJob')
          .mockImplementation((...parameters: Parameters<typeof original>) =>
            hold ? 0 : original(...parameters)
          );
        restore = () => preparation.mockRestore();
        for (let count = 0; count < 3; count++) renderer.paint(replacementArgs);
        expect(renderer.hasPendingPaintWork(container)).toBe(true);
        const pending = renderer.getDiagnostics(container)!;
        expect(pending.readDifferenceBuildCount).toBe(before.readDifferenceBuildCount);
        if (mode === 'replace') {
          expect(renderer.getReadPresentationSnapshot(container)?.kind).toBe('pending');
          expect(pending.rowsMeshGenerationKey).toBe(before.rowsMeshGenerationKey);
          expect(hit(104, replacementArgs)).toMatchObject({
            readId: 'initial',
            event: { pos: 104 },
          });
        } else {
          expect(pending.readDifferenceLayerVisible).toBe(false);
          expect(hit(104, replacementArgs)).toBeNull();
          for (let count = 0; count < 3; count++) renderer.paint(newestArgs);
          expect(renderer.getDiagnostics(container)?.readDifferenceLayerVisible).toBe(false);
        }

        hold = false;
        const finalArgs = mode === 'replace' ? replacementArgs : newestArgs;
        for (let count = 0; renderer.hasPendingPaintWork(container) && count < 20; count++) {
          renderer.paint(finalArgs);
        }
        expect(renderer.hasPendingPaintWork(container)).toBe(false);
        expect(renderer.getDiagnostics(container)).toMatchObject({
          readDifferenceMarkCount: 1,
          readDifferenceInstanceCount: 1,
          readDifferenceLayerVisible: true,
        });
        const position = mode === 'replace' ? 106 : 108;
        const committedRow = mode === 'replace' ? 1 : 0;
        expect(hit(position, finalArgs, committedRow)).toMatchObject({
          readId: mode === 'replace' ? 'replacement' : 'newest',
          sourceGenerationKey: mode === 'replace' ? 'source-a' : 'source-c',
          event: { pos: position },
        });
        expect(hit(mode === 'replace' ? 104 : 106, finalArgs, committedRow)?.event).toBeUndefined();
      } finally {
        restore();
        renderer.unmount(container);
      }
    }
  );

  it.each([
    {
      name: 'highest matching coordinate',
      events: [
        { pos: 105, kind: 'ins' as const, readBase: 'AA' },
        { pos: 102, kind: 'del' as const, length: 6 },
        { pos: 104, kind: 'sub' as const, readBase: 'T' },
        { pos: 104, kind: 'del' as const, length: 2 },
      ],
      expectedIndex: 0,
    },
    {
      name: 'stable event order at one coordinate',
      events: [
        { pos: 104, kind: 'sub' as const, readBase: 'T' },
        { pos: 104, kind: 'ins' as const, readBase: 'AA' },
      ],
      expectedIndex: 1,
    },
  ])('preserves difference-hit priority for $name', ({ events, expectedIndex }) => {
    const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const container = renderer.mount(mountArgs);
    const record = read(100, 110, 'overlapping-events', { mismatches: events });
    const args = paintArgsZoom(container, { records: [record] }, 4, { start: 90, end: 190 }, 800);
    try {
      paintCommittedReadFront(renderer, args);
      const hit = renderer.hitTestReadEvent(container, {
        trackId: 'test-bam',
        localX: 104 * 4 + 1,
        localY: 1,
        screenX: 104 * 4 + 1,
        screenY: 51,
        pathMapper: args.pathMapper,
        chromosomeGlobalStartBp: 0,
      });
      expect(hit?.event).toBe(events[expectedIndex]);
    } finally {
      renderer.unmount(container);
    }
  });

  it('hit-tests the whole committed read body and distinguishes paired alignments with one QNAME', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test', rowHeightPx: 8 });
    const container = renderer.mount(mountArgs);
    const first = read(100, 110, 'paired-qname', {
      flag: 99,
      pair: { paired: true, properPair: true, readNumber: 1, mateStart: 100 },
    });
    const second = read(100, 110, 'paired-qname', {
      flag: 147,
      strand: '-',
      mapq: 42,
      pair: { paired: true, properPair: true, readNumber: 2, mateStart: 100 },
    });
    const args = paintArgsZoom(
      container,
      {
        records: [first, second],
        readSource: {
          truncated: false,
          sourceGenerationKey: 'alignment-generation-7',
        },
      },
      8,
      { start: 90, end: 190 },
      800
    );

    paintCommittedReadFront(renderer, args);

    expect(
      renderer.hitTestReadEvent(container, {
        trackId: 'tumor-bam',
        localX: 105 * 8,
        localY: 10,
        screenX: 105 * 8,
        screenY: 60,
        pathMapper: args.pathMapper,
        chromosomeGlobalStartBp: 0,
      })
    ).toEqual({
      trackId: 'tumor-bam',
      sourceGenerationKey: 'alignment-generation-7',
      readId: 'paired-qname',
      chrom: 'chr7',
      referenceStart: 100,
      start: 100,
      end: 110,
      flag: 147,
      strand: '-',
      mapq: 42,
      pair: second.pair,
      bodyRect: { left: 800, top: 58.5, width: 80, height: 7 },
      hitRect: { left: 800, top: 58, width: 80, height: 8 },
      screenX: 840,
      screenY: 60,
    });

    const hitAtLocalY = (localY: number) =>
      renderer.hitTestReadEvent(container, {
        trackId: 'tumor-bam',
        localX: 105 * 8,
        localY,
        screenX: 105 * 8,
        screenY: 50 + localY,
        pathMapper: args.pathMapper,
        chromosomeGlobalStartBp: 0,
      });

    expect(hitAtLocalY(0.49)).toBeNull();
    expect(hitAtLocalY(0.5)?.flag).toBe(99);
    expect(hitAtLocalY(7.49)?.flag).toBe(99);
    expect(hitAtLocalY(7.5)?.flag).toBe(99);
    expect(hitAtLocalY(7.99)?.flag).toBe(99);
    expect(hitAtLocalY(8)?.flag).toBe(147);
    expect(hitAtLocalY(8.49)?.flag).toBe(147);
    expect(hitAtLocalY(8.5)?.flag).toBe(147);
  });

  it('uses the complete BAM alignment start when a later exon block is clicked', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test', rowHeightPx: 8 });
    const container = renderer.mount(mountArgs);
    const laterExon = read(220, 230, 'spliced-read', {
      flag: 99,
      pair: { paired: true, readNumber: 1 },
    });
    laterExon.alignmentStart = 100;
    const args = paintArgsZoom(
      container,
      {
        records: [laterExon],
        readSource: { truncated: false, sourceGenerationKey: 'alignment-generation-7' },
      },
      8,
      { start: 200, end: 300 },
      800
    );

    paintCommittedReadFront(renderer, args);

    expect(
      renderer.hitTestReadEvent(container, {
        trackId: 'hybrid-pileup',
        localX: 225 * 8,
        localY: 1,
        screenX: 225 * 8,
        screenY: 51,
        pathMapper: args.pathMapper,
        chromosomeGlobalStartBp: 0,
      })
    ).toMatchObject({
      trackId: 'hybrid-pileup',
      readId: 'spliced-read',
      referenceStart: 100,
      referenceBlockStart: 220,
      start: 220,
      end: 230,
    });
    renderer.unmount(container);
  });

  it('reanchors a pinned exact read only while its committed row remains visible', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test', rowHeightPx: 8 });
    const container = renderer.mount(mountArgs);
    const record = read(100, 110, 'pinned-read', { flag: 0 });
    const data = {
      records: [record],
      readSource: { truncated: false, sourceGenerationKey: 'alignment-generation-7' },
    };
    const exactArgs = paintArgsZoom(container, data, 8, { start: 90, end: 190 }, 800);
    paintCommittedReadFront(renderer, exactArgs);
    const hit = renderer.hitTestReadEvent(container, {
      trackId: 'tumor-bam',
      localX: 105 * 8,
      localY: 2,
      screenX: 105 * 8,
      screenY: 52,
      pathMapper: exactArgs.pathMapper,
      chromosomeGlobalStartBp: 0,
    });

    expect(hit).not.toBeNull();
    expect(
      renderer.locateRead(container, hit!, {
        trackId: 'tumor-bam',
        pathMapper: exactArgs.pathMapper,
        containerTopPx: 50,
        chromosomeGlobalStartBp: 0,
      })
    ).toMatchObject({
      readId: 'pinned-read',
      bodyRect: { left: 800, top: 50.5, width: 80, height: 7 },
    });

    const densityArgs = paintArgsZoom(container, data, 0.009, { start: 0, end: 100_000 }, 800);
    renderer.paint(densityArgs);
    expect(
      renderer.locateRead(container, hit!, {
        trackId: 'tumor-bam',
        pathMapper: densityArgs.pathMapper,
        containerTopPx: 50,
        chromosomeGlobalStartBp: 0,
      })
    ).toBeNull();
  });

  it('keeps hit testing on the committed front rows while a replacement mesh is incomplete', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const renderer = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 8,
      readRowsBuildRecordsPerFrame: 1,
    });
    const container = renderer.mount(mountArgs);
    const committed = read(100, 120, 'committed');
    const initial = paintArgsZoom(
      container,
      {
        records: [committed],
        readSource: { truncated: false, sourceGenerationKey: 'generation-1' },
      },
      8,
      { start: 90, end: 190 },
      800
    );
    paintCommittedReadFront(renderer, initial);

    const replacement = [read(110, 130, 'incoming-a'), read(140, 160, 'incoming-b')];
    renderer.paint({
      ...initial,
      data: {
        ...initial.data!,
        records: replacement,
        readSource: { truncated: false, sourceGenerationKey: 'generation-2' },
      },
    });

    const hit = (x: number) =>
      renderer.hitTestReadEvent(container, {
        trackId: 'tumor-bam',
        localX: x,
        localY: 2,
        screenX: x,
        screenY: 52,
        pathMapper: initial.pathMapper,
        chromosomeGlobalStartBp: 0,
      });
    expect(hit(105 * 8)?.readId).toBe('committed');
    expect(hit(145 * 8)).toBeNull();
  });

  it('does not hit-test truncated or overflowed read rows', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const renderer = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      maxRows: 1,
    });
    const container = renderer.mount(mountArgs);
    const first = read(100, 120, 'first', {
      mismatches: [{ pos: 110, kind: 'sub', refBase: 'A', readBase: 'T', baseQ: 40 }],
    });
    const overflow = read(105, 115, 'overflow');
    const args = paintArgsZoom(
      container,
      { records: [first, overflow], readSource: { truncated: false } },
      8,
      { start: 90, end: 190 },
      800
    );
    paintCommittedReadFront(renderer, args);
    const hitArgs = {
      trackId: 'tumor-bam',
      localX: 110 * 8,
      localY: 1,
      screenX: 880,
      screenY: 51,
      pathMapper: args.pathMapper,
      chromosomeGlobalStartBp: 0,
    };

    expect(renderer.hitTestReadEvent(container, hitArgs)?.readId).toBe('first');

    renderer.paint({
      ...args,
      data: { ...args.data!, readSource: { truncated: true } },
    });
    expect(renderer.hitTestReadEvent(container, hitArgs)).toBeNull();
  });

  it('does not expose aggregate density as an exact read hit', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const container = renderer.mount(mountArgs);
    const args = paintArgsZoom(
      container,
      {
        records: [read(100, 120, 'density-only')],
        readSource: { truncated: false, sourceGenerationKey: 'generation-1' },
      },
      0.009,
      { start: 0, end: 100_000 },
      800
    );
    renderer.paint(args);

    expect(
      renderer.hitTestReadEvent(container, {
        trackId: 'tumor-bam',
        localX: 1,
        localY: 1,
        screenX: 1,
        screenY: 51,
        pathMapper: args.pathMapper,
        chromosomeGlobalStartBp: 0,
      })
    ).toBeNull();
  });

  it('routes broad source-keyed coverage through one retained atlas resource and hands off atomically', () => {
    const atlasBinSize = 32_768;
    const atlas = buildCoverageGpuAtlas({
      sourceIdentity: 'bam-source',
      assemblyFingerprint: 'chr11-assembly',
      statistic: 'fixed-base-peak-mean-v1',
      payloadRevision: 'immutable-revision',
      assemblyEndBp: CHROM.length,
      baseBinSizeBp: atlasBinSize,
      depthPercentiles: { p50: 20, p90: 35, p95: 40, p99: 50, max: 100 },
      layers: [
        {
          chrom: CHROM.id,
          globalStartBp: 0,
          globalEndBp: CHROM.length,
          binSizeBp: atlasBinSize,
          bins: new Float32Array(Math.ceil(CHROM.length / atlasBinSize)).map(
            (_, index) => 20 + (index % 31)
          ),
        },
      ],
    });
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    const broadData: PileupTrackData = {
      dataAuthority: 'tile-engine',
      records: [],
      coverageGpuAtlas: atlas,
      coverageGpuAtlasPresentation: 'active',
    };
    r.paint(paintArgsZoom(c, broadData, 800 / 100_000_000, { start: 0, end: 100_000_000 }));
    r.paint(
      paintArgsZoom(c, broadData, 800 / 100_000_000, { start: 10_000_000, end: 110_000_000 })
    );
    const broad = r.getDiagnostics(c)!;
    expect(broad.coverageGpuAtlasActive).toBe(true);
    expect(broad.coverageGpuAtlasDepthMax).toBe(100);
    expect(broad.coverageGpuAtlasTextureResourceCreateCount).toBe(1);
    expect(broad.coverageGpuAtlasGpuTextureResourceCreateCount).toBe(0);
    expect(broad.coverageGpuAtlasGpuTextureUploadCount).toBe(0);
    expect(broad.coverageGpuAtlasGpuTextureUploadComplete).toBe(false);
    expect(broad.coverageGpuAtlasTextureResourceUid).toEqual(expect.any(Number));
    expect(broad.coverageGpuAtlasShaderTextureResourceUid).toBe(
      broad.coverageGpuAtlasTextureResourceUid
    );
    expect(broad.coverageGpuAtlasShaderTextureResourceBound).toBe(true);
    expect(broad.coverageGpuAtlasRenderOwner).toBe('coverage-gpu-atlas-fill');
    expect(broad.coverageGpuAtlasShaderProgramName).toBe('coverage-gpu-atlas-fill-fragment');
    expect(broad.coverageGpuAtlasGeometryBuildCount).toBe(1);
    expect(broad.coverageGpuAtlasCameraUniformUpdateCount).toBe(2);
    expect(broad.coverageSamplePassCount).toBe(0);
    expect(broad.coverageGeometryBuildCount).toBe(0);
    expect(broad.coverageBufferUploadCount).toBe(0);

    const exactCoverage = {
      bins: new Array(800).fill(30),
      binSize: 16_384,
      maxDepth: 30,
      startBp: 20_000_000,
      coverageRevision: 'exact-revision',
      provenance: {
        exact: true,
        source: 'tile-engine' as const,
        method: 'resolution-ranked-source-merge',
      },
    };
    r.paint(
      paintArgsZoom(
        c,
        {
          dataAuthority: 'tile-engine',
          records: [],
          coverageGpuAtlas: atlas,
          coverageGpuAtlasPresentation: 'standby',
          coverage: exactCoverage,
          coverageLod: {
            role: 'current-lod',
            level: 14,
            targetLevel: 14,
            binSize: 16_384,
            provenanceExact: true,
          },
        },
        800 / (800 * 16_384),
        { start: 20_000_000, end: 20_000_000 + 800 * 16_384 }
      )
    );
    const exact = r.getDiagnostics(c)!;
    expect(exact.coverageGpuAtlasActive).toBe(false);
    expect(exact.coverageGpuAtlasTextureResourceCreateCount).toBe(1);
    expect(exact.coverageGpuAtlasGeometryBuildCount).toBe(1);
    expect(exact.coverageGeometryBuildCount).toBe(1);
    expect(exact.coverageBufferUploadCount).toBeGreaterThan(0);
  });

  it('keeps the lighter read body separate from the shared rich Phred palette', async () => {
    const { pileupReadQualityColorNumber } = await import('./pileup-read-quality-palette');
    const {
      DARK_PILEUP_PAIRED_READ_COLOR,
      DEFAULT_PILEUP_PAIRED_READ_COLOR,
      pileupReadDisplayColor,
    } = await import('./pileup-track-renderer');

    expect(DEFAULT_PILEUP_PAIRED_READ_COLOR).toBe(0xa8ceff);
    expect(DARK_PILEUP_PAIRED_READ_COLOR).toBe(0x1d4ed8);
    expect(pileupReadQualityColorNumber(40, 'light')).toBe(DARK_PILEUP_PAIRED_READ_COLOR);
    expect(pileupReadQualityColorNumber(40, 'dark')).toBe(DARK_PILEUP_PAIRED_READ_COLOR);

    const light = oklch(DEFAULT_PILEUP_PAIRED_READ_COLOR);
    const dark = oklch(DARK_PILEUP_PAIRED_READ_COLOR);
    expect(light.lightness).toBeGreaterThan(dark.lightness);
    expect(DEFAULT_PILEUP_PAIRED_READ_COLOR & 0xff).toBe(0xff);

    expect(pileupReadDisplayColor(read(0, 50, 'fwd'))).toBe(DEFAULT_PILEUP_PAIRED_READ_COLOR);
    expect(pileupReadDisplayColor(read(0, 50, 'rev', { strand: '-' }))).toBe(
      DEFAULT_PILEUP_PAIRED_READ_COLOR
    );
    expect(
      pileupReadDisplayColor(
        read(0, 50, 'paired-fwd', {
          pair: { paired: true, properPair: true, mateUnmapped: false },
        })
      )
    ).toBe(DEFAULT_PILEUP_PAIRED_READ_COLOR);
    expect(
      pileupReadDisplayColor(
        read(0, 50, 'paired-rev', {
          strand: '-',
          pair: { paired: true, properPair: true, mateUnmapped: false },
        })
      )
    ).toBe(DEFAULT_PILEUP_PAIRED_READ_COLOR);
  });

  it('applies an exact per-track read color in light mode without overriding dark mode', async () => {
    const { PixiPileupTrackRenderer, DARK_PILEUP_PAIRED_READ_COLOR } =
      await import('./pileup-track-renderer');
    const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const container = renderer.mount(mountArgs);
    const lightArgs = paintArgs(container, { records: [read(100, 200, 'custom-color')] });
    lightArgs.presentation = { color: '#35c9a4' };

    renderer.paint(lightArgs);
    expect(renderer.getDiagnostics(container)?.pairedReadColor).toBe(0x35c9a4);

    renderer.paint({
      ...lightArgs,
      theme: webglThemeForMode('dark'),
    });
    expect(renderer.getDiagnostics(container)?.pairedReadColor).toBe(DARK_PILEUP_PAIRED_READ_COLOR);
  });

  it('uses one dark-mode read-body color so only nucleotide differences carry biological color', async () => {
    const { DARK_PILEUP_PAIRED_READ_COLOR, pileupReadDisplayColor } =
      await import('./pileup-track-renderer');

    expect(pileupReadDisplayColor(read(0, 50, 'fwd'), undefined, 'dark')).toBe(
      DARK_PILEUP_PAIRED_READ_COLOR
    );
    expect(pileupReadDisplayColor(read(0, 50, 'rev', { strand: '-' }), undefined, 'dark')).toBe(
      DARK_PILEUP_PAIRED_READ_COLOR
    );
    expect(
      pileupReadDisplayColor(
        read(0, 50, 'paired-fwd', {
          pair: { paired: true, properPair: true, mateUnmapped: false },
        }),
        undefined,
        'dark'
      )
    ).toBe(DARK_PILEUP_PAIRED_READ_COLOR);
    expect(
      pileupReadDisplayColor(
        read(0, 50, 'paired-rev', {
          strand: '-',
          pair: { paired: true, properPair: true, mateUnmapped: false },
        }),
        undefined,
        'dark'
      )
    ).toBe(DARK_PILEUP_PAIRED_READ_COLOR);
  });

  it.each([0x4a90d9, 0x426de6, 0x2f80ed])(
    'normalizes retained built-in blue %# to the perceptually matched royal blue for each theme',
    async (retainedColor) => {
      const {
        DARK_PILEUP_PAIRED_READ_COLOR,
        DEFAULT_PILEUP_PAIRED_READ_COLOR,
        pileupReadDisplayColor,
      } = await import('./pileup-track-renderer');

      expect(pileupReadDisplayColor(read(0, 50, 'hot-reload'), retainedColor, 'light')).toBe(
        DEFAULT_PILEUP_PAIRED_READ_COLOR
      );
      expect(pileupReadDisplayColor(read(0, 50, 'hot-reload'), retainedColor, 'dark')).toBe(
        DARK_PILEUP_PAIRED_READ_COLOR
      );
    }
  );

  it('returns null for an unmounted container', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const { Container } = await import('pixi.js');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    expect(r.getDiagnostics(new Container())).toBeNull();
    expect(r.getColdGestureDiagnostics(new Container())).toBeNull();
  });

  it('exposes a bounded cold-gesture receipt without copying forensic read maps', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    r.paint(
      paintArgsZoom(
        c,
        {
          records: [read(100, 150, 'cold-a'), read(120, 170, 'cold-b')],
        },
        10,
        { start: 100, end: 170 }
      )
    );

    const cold = r.getColdGestureDiagnostics(c)!;
    const coverageDepth = r.getCoverageDepthSnapshot(c)!;
    const full = r.getDiagnostics(c)!;
    expect(cold).not.toHaveProperty('rowAssignments');
    expect(cold).not.toHaveProperty('visibleReadSamples');
    expect(coverageDepth).toEqual({
      coverageDepthP99: full.coverageDepthP99,
      coverageDepthMax: full.coverageDepthMax,
    });
    for (const [key, value] of Object.entries(cold)) {
      expect(full[key as keyof typeof full]).toEqual(value);
    }
  });

  it('reports only committed visible read geometry while replacement work remains pending', () => {
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      readRowsAssignRecordsPerFrame: 1,
      readRowsBuildRecordsPerFrame: 1,
    });
    const c = r.mount(mountArgs);
    const source = {
      truncated: false,
      windowStartBp: 0,
      windowEndBp: 1_000,
      sourceGenerationKey: 'generation-a',
      presentationOwnerKey: 'owner-a',
    };
    const records = [read(100, 150, 'a'), read(160, 200, 'b')];
    let viewport = { start: 100, end: 200 };
    const paint = (data: PileupTrackDataFixture) => r.paint(paintArgsZoom(c, data, 10, viewport));
    paint({ dataAuthority: 'tile-engine', records, readSource: source });
    expect(r.getReadPresentationSnapshot(c)?.kind).toBe('pending');
    let frames = 0;
    while (r.getDiagnostics(c)?.rowsMeshRecordCount !== records.length && frames++ < 20) {
      paint({ dataAuthority: 'tile-engine', records, readSource: source });
    }
    expect(r.getReadPresentationSnapshot(c)).toMatchObject({
      kind: 'reads',
      sourceGenerationKey: 'generation-a',
      presentationOwnerKey: 'owner-a',
      viewStartBp: 100,
      viewEndBp: 200,
      sourceCoversViewport: true,
      meshCoverageFraction: 1,
      truncated: false,
      visible: true,
      recordCount: 2,
    });
    paint({
      dataAuthority: 'tile-engine',
      records: [...records, read(600, 650, 'offscreen')],
      readSource: source,
    });
    expect(r.getDiagnostics(c)?.rowsAssignmentBuildInProgress).toBe(false);
    expect(r.getDiagnostics(c)?.rowsMeshRecordCount).toBe(2);
    expect(r.getReadPresentationSnapshot(c)?.kind).toBe('reads');
    viewport = { start: 800, end: 1_200 };
    paint({
      dataAuthority: 'tile-engine',
      records: [...records, read(900, 950, 'new-visible')],
      readSource: { ...source, windowEndBp: 2_000 },
    });
    expect(r.getReadPresentationSnapshot(c)).toMatchObject({
      kind: 'pending',
      meshCoverageFraction: 0.5,
      sourceCoversViewport: true,
    });
    viewport = { start: 100, end: 200 };
    paint({ dataAuthority: 'tile-engine', records, readSource: { ...source, truncated: true } });
    expect(r.getReadPresentationSnapshot(c)?.kind).toBe('pending');
    paint({
      dataAuthority: 'tile-engine',
      records,
      readSource: { ...source, presentationOwnerKey: 'owner-b' },
    });
    expect(r.getReadPresentationSnapshot(c)).toMatchObject({
      kind: 'pending',
      presentationOwnerKey: 'owner-b',
      visible: false,
    });
    paint({ dataAuthority: 'tile-engine', records: [], readSource: source });
    expect(r.getReadPresentationSnapshot(c)).toMatchObject({
      kind: 'empty',
      recordCount: 0,
      visible: false,
      sourceCoversViewport: true,
    });
    r.unmount(c);
  });

  it('reports zero state for a mounted track before paint', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 60 });
    const c = r.mount(mountArgs);
    const d = r.getDiagnostics(c)!;
    expect(d.recordCount).toBe(0);
    expect(d.rowsUsed).toBe(0);
    expect(d.hiddenReadCount).toBe(0);
    expect(d.bandBinCount).toBe(0);
    expect(d.maxRows).toBe(60);
    expect(d.effectiveMaxRows).toBe(60);
    expect(d.collapsed).toBe(false);
    expect(d.readRowsTopPx).toBe(0);
    expect(d.readRowsBottomPx).toBe(60 * 3);
    expect(d.overflowBandHeightPx).toBe(0);
    expect(d.overflowRowsVertexCount).toBe(0);
  });

  it('owns pending tile motion in the pileup scene and reserves pixels below the read rows', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 60 });
    const container = renderer.mount(mountArgs);
    const data = {
      records: [],
      referenceIntervals: [
        { startBp: 100, endBp: 200, state: 'pending' as const },
        { startBp: 200, endBp: 300, state: 'pending' as const },
        { startBp: 300, endBp: 400, state: 'empty' as const },
      ],
    };
    const layoutHeightPx = 60 * 3 + PENDING_INTERVAL_BAND_HEIGHT_PX;
    const first = paintArgsZoom(container, data, 2, { start: 50, end: 450 }, 800, layoutHeightPx);
    Object.assign(first.pathMapper, {
      bpLeftX: (bp: number) => (bp - 50) * 2,
    });
    renderer.paint(first);

    expect(renderer.getDiagnostics(container)).toMatchObject({
      effectiveMaxRows: 60,
      pendingIntervalCount: 2,
      pendingIntervalGeometryBuildCount: 1,
      pendingIntervalBufferUploadCount: 1,
      pendingIntervalBandTopPx: 50 + 60 * 3,
      pendingIntervalBandHeightPx: PENDING_INTERVAL_BAND_HEIGHT_PX,
      pendingIntervalVisible: true,
      pendingIntervals: [
        { startBp: 100, endBp: 200 },
        { startBp: 200, endBp: 300 },
      ],
      pendingIntervalProjectedIntervalsPx: [
        { left: 100, right: 300 },
        { left: 300, right: 500 },
      ],
    });
    expect(renderer.hasPendingPaintWork(container)).toBe(true);

    const panned = paintArgsZoom(container, data, 2, { start: 100, end: 500 }, 800, layoutHeightPx);
    Object.assign(panned.pathMapper, {
      bpLeftX: (bp: number) => (bp - 100) * 2,
    });
    renderer.paint(panned);
    expect(renderer.getDiagnostics(container)).toMatchObject({
      pendingIntervalGeometryBuildCount: 1,
      pendingIntervalBufferUploadCount: 1,
      pendingIntervalCameraUniformUpdateCount: 2,
      pendingIntervalProjectedIntervalsPx: [
        { left: 0, right: 200 },
        { left: 200, right: 400 },
      ],
    });
  });

  it('keeps row geometry fixed and renders sparse differences through one retained mesh', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const renderer = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      maxRows: 60,
    });
    const container = renderer.mount(mountArgs);
    const record = read(100, 106, 'nucleotide-read', {
      mismatches: [
        { pos: 102, kind: 'sub', refBase: 'A', readBase: 'T' },
        { pos: 104, kind: 'ins', readBase: 'GG' },
        { pos: 105, kind: 'del', refBase: 'C' },
      ],
    });
    const data = { records: [record] };
    const args = paintArgsZoom(container, data, 10, { start: 100, end: 106 }, 60, 240);
    Object.assign(args.pathMapper, {
      sequenceOpacity: 1,
      sequenceFontSize: 11,
      rowHeight: 13,
      fwdStrandTop: 20,
    });
    renderer.paint(args);
    const diagnostics = renderer.getDiagnostics(container)!;
    expect(diagnostics.readGlyphCount).toBe(0);
    expect(diagnostics.readGlyphContract).toBe('reference-sequence-text-v1');
    expect(diagnostics.readGlyphRasterSize).toBe(16);
    expect(diagnostics.readDifferenceMarkCount).toBe(3);
    expect(diagnostics.readDifferenceInstanceCount).toBe(3);
    expect(diagnostics.readDifferenceLayerVisible).toBe(true);
    expect(diagnostics.readDifferenceLayerAlpha).toBe(1);
    expect(diagnostics.readDifferenceBuildCount).toBe(1);
    expect(diagnostics.readDifferenceScreenTopPx).toBe(args.containerTopPx);
    expect(diagnostics.effectiveRowHeightPx).toBe(3);
    expect(diagnostics.readRowsBottomPx).toBe(180);

    const cameraOnlyArgs = paintArgsZoom(container, data, 10, { start: 101, end: 107 }, 60, 240);
    Object.assign(cameraOnlyArgs.pathMapper, {
      sequenceOpacity: 1,
      sequenceFontSize: 11,
      rowHeight: 13,
      fwdStrandTop: 20,
    });
    renderer.paint(cameraOnlyArgs);
    expect(renderer.getDiagnostics(container)?.readDifferenceBuildCount).toBe(1);

    const fadingArgs = paintArgsZoom(container, data, 0.012, { start: 101, end: 107 }, 60, 240);
    renderer.paint(fadingArgs);
    const fadingDiagnostics = renderer.getDiagnostics(container)!;
    expect(fadingDiagnostics.readDifferenceLayerVisible).toBe(true);
    expect(fadingDiagnostics.readDifferenceLayerAlpha).toBeGreaterThan(0);
    expect(fadingDiagnostics.readDifferenceLayerAlpha).toBeLessThan(1);
    expect(fadingDiagnostics.readDifferenceBuildCount).toBe(1);
  });

  it('renders coverage through the blue aggregate, never the deprecated gray band', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    r.paint(paintArgs(c, { coverage: { bins: [0, 5, 10, 0, 8], binSize: 100, maxDepth: 10 } }));
    const d = r.getDiagnostics(c)!;
    expect(d.bandBinCount).toBe(0);
    expect(d.bandVertexCount).toBe(0);
    expect(d.readAggregateSource).toBe('collapsed-pileup');
    expect(d.readDisplayMode).toBe('density');
    expect(d.densityRowsVertexCount).toBeGreaterThan(0);
  });

  it('binds every annotation-shader track-color uniform used by pileup bars', () => {
    const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const container = renderer.mount(mountArgs);
    renderer.paint(
      paintArgs(container, {
        coverage: { bins: [0, 5, 10, 0, 8], binSize: 100, maxDepth: 10 },
      })
    );
    const densityMesh = container.children.find(
      (child) => child.label === 'pileup-read-density'
    ) as { shader?: { resources: Record<string, unknown> } } | undefined;
    const annotationUniforms = densityMesh?.shader?.resources.annotationUniforms as
      | { uniforms?: Record<string, unknown> }
      | undefined;

    expect(annotationUniforms?.uniforms?.uTrackColor).toEqual(new Float32Array([1, 1, 1]));
    expect(annotationUniforms?.uniforms?.uUseTrackColor).toBe(0);
  });

  it('budgets read rows and reports overflow as hiddenReadCount (real paint)', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 2 });
    const c = r.mount(mountArgs);
    r.paint(paintArgs(c, { records: [read(100, 500), read(150, 600), read(200, 700)] }));
    const d = r.getDiagnostics(c)!;
    expect(d.recordCount).toBe(3);
    expect(d.rowsUsed).toBe(2);
    expect(d.hiddenReadCount).toBe(1);
  });

  it('renders a compressed overflow strip for loaded reads beyond the row budget', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 2,
      overflowBandHeightPx: 20,
    });
    const c = r.mount(mountArgs);
    const overflowData: PileupTrackData = {
      dataAuthority: 'tile-engine',
      coverage: {
        bins: [3, 3, 3, 3],
        binSize: 250,
        maxDepth: 3,
        provenance: { exact: true, method: 'test', source: 'tile-engine' },
      },
      records: [read(0, 1000, 'a'), read(0, 1000, 'b'), read(0, 1000, 'c')],
      readSource: { truncated: false, windowStartBp: 0, windowEndBp: 1000 },
    };
    r.paint(
      paintArgsZoom(
        c,
        overflowData,
        4.0 / 150,
        { start: 100, end: 900 },
        120,
        40 + PENDING_INTERVAL_BAND_HEIGHT_PX
      )
    );

    const d = r.getDiagnostics(c)!;
    expect(d.maxRows).toBe(2);
    expect(d.effectiveMaxRows).toBe(2);
    expect(d.rowsUsed).toBe(2);
    expect(d.hiddenReadCount).toBe(1);
    expect(d.readRowsBottomPx).toBe(20);
    expect(d.overflowBandTopPx).toBe(20);
    expect(d.overflowBandBottomPx).toBe(40);
    expect(d.overflowRowsVertexCount).toBeGreaterThan(0);
    expect(d.overflowColumnCoverage).toBeGreaterThan(0.95);
    expect(d.overflowMaxHiddenReads).toBe(1);
    expect(d.renderedOverflowRowsAlpha).toBeGreaterThan(0.95);
    expect(d.overflowRowsMeshVisible).toBe(true);

    const state = (
      r as unknown as {
        containerState: WeakMap<
          object,
          {
            overflowRows: {
              surfaceKind: string;
              buffers: Array<{ data: Float32Array }>;
              shader: {
                resources: {
                  annotationUniforms: {
                    uniforms: {
                      uSubpixelMinWidthPx: number;
                      uSubpixelMinAlphaScale: number;
                    };
                  };
                };
              };
            } | null;
          }
        >;
      }
    ).containerState.get(c);
    const overflowRows = state?.overflowRows;
    expect(overflowRows?.surfaceKind).toBe('continuous-fill');
    expect(overflowRows?.shader.resources.annotationUniforms.uniforms.uSubpixelMinWidthPx).toBe(0);
    expect(overflowRows?.shader.resources.annotationUniforms.uniforms.uSubpixelMinAlphaScale).toBe(
      1
    );
    const overflowOffsetY = overflowRows?.buffers[4]?.data;
    expect(overflowOffsetY).toBeInstanceOf(Float32Array);
    expect(overflowOffsetY![1]).toBeGreaterThan(overflowOffsetY![0]);
  });

  it('static (non-streaming) reads stay fully visible when the viewport is WIDER than the read extent ', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 16,
    });
    const c = r.mount(mountArgs);
    r.paint(
      paintArgsZoom(
        c,
        { records: [read(5000, 6000, 'a'), read(5000, 6000, 'b'), read(5000, 6000, 'c')] },
        4.0 / 150,
        { start: 4000, end: 7000 },
        120,
        80
      )
    );
    const d = r.getDiagnostics(c)!;
    expect(d.recordCount).toBe(3);
    expect(d.rowsUsed).toBeGreaterThan(0);
    expect(d.rowsVertexCount).toBeGreaterThan(0);
    expect(d.renderedReadRowsAlpha).toBeGreaterThan(0.95);
    expect(d.rowsMeshVisible).toBe(true);
    expect(d.readDisplayMode).toBe('reads');
  });

  describe('chunked read-rows mesh build  bounded per-frame build work)', () => {
    const makeWindowReads = (n: number, windowEnd: number) =>
      Array.from({ length: n }, (_, i) => {
        const start = 100 + i * 6;
        return read(start, start + 5, `r${i}`);
      }).filter((r) => r.end < windowEnd);

    const readPaint = (
      c: object,
      records: PileupRecord[],
      windowEnd = 100_000
    ): TrackPaintArgs<PileupTrackData> =>
      paintArgsZoom(
        c,
        {
          dataAuthority: 'tile-engine',
          records,
          readSource: { truncated: false, windowStartBp: 0, windowEndBp: windowEnd },
        },
        4.0 / 150,
        { start: 0, end: windowEnd },
        800,
        240
      );

    it.each([
      { authority: 'static', count: 4, withMarks: false, firstVertices: 24 },
      { authority: 'static', count: 5, withMarks: false, firstVertices: 0 },
      { authority: 'tile-engine', count: 4, withMarks: false, firstVertices: 0 },
      { authority: 'static', count: 4, withMarks: true, firstVertices: 0 },
    ] as const)(
      'publishes a prepared first mesh for $count $authority reads with marks=$withMarks',
      ({ authority, count, withMarks, firstVertices }) => {
        const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test' });
        const container = renderer.mount(mountArgs);
        const records = makeWindowReads(count, 1_000);
        if (withMarks) {
          records[0] = { ...records[0], mismatches: [{ pos: 102, kind: 'sub', readBase: 'T' }] };
        }
        const args = readPaint(container, records, 1_000);
        const paint = { ...args, data: { ...args.data, dataAuthority: authority } };
        let time = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
        const begin = PileupReadDifferenceLayer.prototype.beginPreparation;
        const setup = vi.spyOn(PileupReadDifferenceLayer.prototype, 'beginPreparation');
        try {
          setup.mockImplementationOnce(function (this: PileupReadDifferenceLayer, input) {
            time += 3;
            return begin.call(this, input);
          });
          renderer.paint(paint);
          const first = renderer.getDiagnostics(container)!;
          expect(first.rowsUsed).toBeGreaterThan(0);
          expect(first.rowsVertexCount).toBe(firstVertices);
          renderer.paint(paint);
          expect(renderer.getDiagnostics(container)!.rowsVertexCount).toBe(count * 6);
        } finally {
          setup.mockRestore();
          clock.mockRestore();
        }
      }
    );

    it.each([
      { name: 'a small static input', count: 3, expectedVertices: 18 },
      { name: 'a fifth record', count: 5, expectedVertices: 0 },
      { name: 'tile input', count: 3, tiled: true, expectedVertices: 0 },
      { name: 'mismatch marks', count: 3, marked: true, expectedVertices: 0 },
      { name: 'a wide height field', count: 3, recordEnd: 100_000, expectedVertices: 0 },
      { name: 'a wide aggregate field', count: 3, windowEnd: 100_000, expectedVertices: 0 },
      { name: 'a shorter elapsed budget', count: 3, budgetMs: 0.25, expectedVertices: 0 },
    ])(
      'handles $name when the first row assignment starts after its deadline',
      ({ count, expectedVertices, tiled, marked, recordEnd, windowEnd, budgetMs }) => {
        const renderer = new PixiPileupTrackRenderer({
          type: 'pileup-test',
          maxRows: 16,
          readRowsAssignWorkBudgetMs: budgetMs,
        });
        const container = renderer.mount(mountArgs);
        const records = makeWindowReads(count, 1_000);
        if (marked) records[0].mismatches = [{ pos: 102, kind: 'sub', readBase: 'T' }];
        if (recordEnd) records[0].end = recordEnd;
        const args = readPaint(container, records, windowEnd ?? 1_000);
        const data: PileupTrackData = {
          ...args.data,
          dataAuthority: tiled ? 'tile-engine' : 'static',
        };
        if (!windowEnd) delete data.readSource;
        let time = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
        const begin = PersistentRowLayout.prototype.beginAssignment;
        const setup = vi.spyOn(PersistentRowLayout.prototype, 'beginAssignment');
        try {
          setup.mockImplementationOnce(function (this: PersistentRowLayout, ...args) {
            time += 3;
            return begin.apply(this, args);
          });
          renderer.paint({ ...args, data });
          const first = renderer.getDiagnostics(container)!;
          expect(first.rowsVertexCount).toBe(expectedVertices);
          expect(first.rowsUsed > 0).toBe(expectedVertices > 0);
          renderer.paint({ ...args, data });
          expect(renderer.getDiagnostics(container)!.rowsVertexCount).toBe(count * 6);
        } finally {
          setup.mockRestore();
          clock.mockRestore();
        }
      }
    );

    it('shares the elapsed allowance with height finalization before publishing new reads', () => {
      const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test' });
      const container = renderer.mount(mountArgs);
      const initial = [read(100, 105, 'initial')];
      const initialPaint = readPaint(container, initial);
      let clock = 0;
      let derivedWork = false;
      const records = makeWindowReads(1_500, 110_000).map((record) => {
        const { start, end } = record;
        Object.defineProperties(record, {
          start: {
            get: () => {
              if (derivedWork) clock += 0.005;
              return start;
            },
          },
          end: {
            get: () => {
              if (derivedWork) clock += 0.005;
              return end;
            },
          },
        });
        return record;
      });
      const advance = PersistentRowLayout.prototype.advanceAssignmentWithinBudget;
      let assignment: ReturnType<typeof vi.spyOn> | undefined;
      let timer: ReturnType<typeof vi.spyOn> | undefined;
      try {
        renderer.paint(initialPaint);
        for (let frame = 0; renderer.hasPendingPaintWork(container) && frame < 20; frame++) {
          renderer.paint(initialPaint);
        }
        const before = renderer.getDiagnostics(container)!;
        expect(before.rowsMeshRecordCount).toBe(1);
        assignment = vi
          .spyOn(PersistentRowLayout.prototype, 'advanceAssignmentWithinBudget')
          .mockImplementation(function (this: PersistentRowLayout, job, ...args) {
            const processed = advance.call(this, job, ...args);
            if (job.complete) derivedWork = true;
            return processed;
          });
        timer = vi.spyOn(performance, 'now').mockImplementation(() => clock);
        const replacement = readPaint(container, records, 110_000);
        renderer.paint(replacement);

        expect(clock).toBeLessThanOrEqual(2.25);
        expect(renderer.hasPendingPaintWork(container)).toBe(true);
        expect(renderer.getDiagnostics(container)?.rowsMeshRecordCount).toBe(1);
        for (let frame = 0; renderer.hasPendingPaintWork(container) && frame < 400; frame++) {
          const started = clock;
          renderer.paint(replacement);
          expect(clock - started).toBeLessThanOrEqual(2.25);
        }
        expect(renderer.hasPendingPaintWork(container)).toBe(false);
        expect(renderer.getDiagnostics(container)?.rowsMeshRecordCount).toBe(records.length);
      } finally {
        timer?.mockRestore();
        assignment?.mockRestore();
        renderer.unmount(container);
      }
    });

    it.each(['all overlap', 'touches the left boundary', 'touches the right boundary'] as const)(
      'counts drawable rows for a source window when the input %s',
      (bounds) => {
        const renderer = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 3 });
        const container = renderer.mount(mountArgs);
        const assigned = vi.spyOn(PersistentRowLayout.prototype, 'finishAssignment');
        const vertices = vi.spyOn(readVertices, 'beginAnnotationRecordVerticesJob');
        const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
        try {
          let boundsReadsBeforeVertices = 0;
          const interior = read(155, 170, 'interior');
          Object.defineProperty(interior, 'end', {
            get() {
              if (assigned.mock.calls.length > 0 && vertices.mock.calls.length === 0) {
                boundsReadsBeforeVertices++;
              }
              return 170;
            },
          });
          const records = [
            read(90, 111, 'crosses-left'),
            read(122, 135, 'first-row'),
            read(122, 136, 'second-row'),
            read(122, 137, 'third-row'),
            read(123, 138, 'hidden'),
            interior,
            read(190, 210, 'crosses-right'),
          ];
          if (bounds === 'touches the left boundary') records.unshift(read(80, 100));
          if (bounds === 'touches the right boundary') records.push(read(200, 215));
          const args = paintArgsZoom(
            container,
            {
              dataAuthority: 'tile-engine',
              coverage: {
                bins: [4, 4],
                binSize: 100,
                maxDepth: 4,
                provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
              },
              records,
              readSource: { truncated: false, windowStartBp: 100, windowEndBp: 200 },
            },
            4 / 150,
            { start: 100, end: 200 }
          );
          paintCommittedReadFront(renderer, args);
          expect(renderer.getDiagnostics(container)).toMatchObject({
            rowsMeshVisible: true,
            rowsUsed: 3,
            rowsMeshRecordCount: 7,
            rowsVertexCount: 36,
            hiddenReadCount: 1,
          });
          expect(assigned).toHaveBeenCalledOnce();
          expect(vertices).toHaveBeenCalledOnce();
          if (bounds === 'all overlap') expect(boundsReadsBeforeVertices).toBe(0);
        } finally {
          assigned.mockRestore();
          vertices.mockRestore();
          clock.mockRestore();
          renderer.unmount(container);
        }
      }
    );

    it('uses remaining preparation time for drawing when assignment finishes', () => {
      const renderer = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        readRowsAssignRecordsPerFrame: 512,
        readRowsBuildRecordsPerFrame: 8,
      });
      const container = renderer.mount(mountArgs);
      const records = makeWindowReads(513, 100_000);
      const clock = vi.spyOn(performance, 'now').mockReturnValue(1_000);
      try {
        renderer.paint(readPaint(container, records));
        expect(renderer.getDiagnostics(container)?.rowsAssignmentBuildInProgress).toBe(true);
        expect(renderer.getDiagnostics(container)?.rowsAssignmentBuildRecordsLastFrame).toBe(512);

        renderer.paint(readPaint(container, records));

        const joining = renderer.getDiagnostics(container)!;
        expect(joining.rowsAssignmentBuildInProgress).toBe(false);
        expect(joining.rowsMeshBuildInProgress).toBe(true);
        expect(joining.rowsMeshBuildRecordCursor).toBe(8);
        expect(joining.rowsMeshBuildRecordsLastFrame).toBe(8);
        expect(renderer.getReadPresentationSnapshot(container)?.kind).toBe('pending');
        for (let frame = 0; renderer.hasPendingPaintWork(container) && frame < 100; frame++) {
          renderer.paint(readPaint(container, records));
          expect(
            renderer.getDiagnostics(container)?.rowsMeshBuildRecordsLastFrame
          ).toBeLessThanOrEqual(8);
        }
        expect(renderer.hasPendingPaintWork(container)).toBe(false);
        expect(renderer.getDiagnostics(container)?.rowsMeshRecordCount).toBe(records.length);
        expect(renderer.getReadPresentationSnapshot(container)?.kind).toBe('reads');
      } finally {
        clock.mockRestore();
        renderer.unmount(container);
      }
    });

    function idleAssignmentClock() {
      const callbacks: IdleRequestCallback[] = [];
      vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) =>
        callbacks.push(callback)
      );
      const cancel = vi.fn();
      vi.stubGlobal('cancelIdleCallback', cancel);
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
      const advance = PersistentRowLayout.prototype.advanceAssignmentWithinBudget;
      const slices = vi
        .spyOn(PersistentRowLayout.prototype, 'advanceAssignmentWithinBudget')
        .mockImplementation(function (this: PersistentRowLayout, job, cap, ms) {
          let now = 0;
          return advance.call(this, job, cap, ms, () => now++ * 2);
        });
      return {
        callbacks,
        cancel,
        slices,
        restore() {
          slices.mockRestore();
          clock.mockRestore();
          vi.unstubAllGlobals();
        },
      };
    }

    it.each([[0.75, 0.75], [15, 2]])(
      'advances dense rows within %d ms of spare time and publishes them on paint',
      (availableMs, expectedBudgetMs) => {
        const { callbacks, slices, restore } = idleAssignmentClock();
        const r = new PixiPileupTrackRenderer({ type: 'pileup', readRowsAssignRecordsPerFrame: 10 });
        const c = r.mount(mountArgs);
        const records = makeWindowReads(12, 100_000);
        try {
          r.paint(readPaint(c, records));
          expect(callbacks).toHaveLength(1);
          const job = slices.mock.calls[0][0];
          expect(job.processedCount).toBe(4);
          callbacks[0]({ didTimeout: false, timeRemaining: () => availableMs });
          expect(slices.mock.lastCall).toEqual([job, 6, expectedBudgetMs]);
          expect(job.processedCount).toBe(8);
          expect(r.getReadPresentationSnapshot(c)?.kind).toBe('pending');
          r.paint(readPaint(c, records));
          expect(r.getReadPresentationSnapshot(c)?.kind).toBe('reads');
          expect(callbacks).toHaveLength(1);
        } finally {
          r.unmount(c);
          restore();
        }
      }
    );

    it('skips exhausted idle deadlines and discards work on replacement or unmount', () => {
      const { callbacks, cancel, slices, restore } = idleAssignmentClock();
      const r = new PixiPileupTrackRenderer({ type: 'pileup' });
      const c = r.mount(mountArgs);
      const records = makeWindowReads(100, 100_000);
      let mounted = true;
      try {
        r.paint(readPaint(c, records));
        expect(callbacks).toHaveLength(1);
        callbacks[0]({ didTimeout: false, timeRemaining: () => 0 });
        expect(slices).toHaveBeenCalledTimes(1);
        r.paint(readPaint(c, records));
        const original = slices.mock.lastCall![0];
        r.paint(readPaint(c, records.slice(1)));
        expect(cancel).toHaveBeenCalledWith(2);
        expect(slices.mock.lastCall![0]).not.toBe(original);
        const afterReplacement = slices.mock.calls.length;
        callbacks[1]({ didTimeout: false, timeRemaining: () => 10 });
        expect(slices).toHaveBeenCalledTimes(afterReplacement);
        r.unmount(c);
        mounted = false;
        expect(cancel).toHaveBeenCalledWith(3);
        callbacks[2]({ didTimeout: false, timeRemaining: () => 10 });
        expect(slices).toHaveBeenCalledTimes(afterReplacement);
      } finally {
        if (mounted) r.unmount(c);
        restore();
      }
    });

    it('prioritizes a missing read front within the urgent elapsed-work budget', () => {
      const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
      const c = r.mount(mountArgs);
      const records = makeWindowReads(5_500, 100_000);
      const msPerRecord = 0.001;
      const recordsPerBudgetCheck = 4;
      let clockReads = 0;
      const clock = vi
        .spyOn(performance, 'now')
        .mockImplementation(() => ++clockReads * recordsPerBudgetCheck * msPerRecord);
      const assignment = vi.spyOn(PersistentRowLayout.prototype, 'advanceAssignmentWithinBudget');
      try {
        r.paint(readPaint(c, records));
        expect(assignment.mock.lastCall?.[1]).toBe(4_096);
        expect(assignment.mock.lastCall?.[2]).toBeGreaterThan(0);
        expect(assignment.mock.lastCall?.[2]).toBeLessThanOrEqual(2);
        let d = r.getDiagnostics(c)!;
        const expectedRecords = Math.floor(assignment.mock.lastCall![2] / msPerRecord);
        expect(d.rowsAssignmentBuildRecordsLastFrame).toBeGreaterThanOrEqual(expectedRecords);
        expect(d.rowsAssignmentBuildRecordsLastFrame).toBeLessThanOrEqual(
          expectedRecords + recordsPerBudgetCheck
        );
        expect(d.rowsAssignmentBuildInProgress).toBe(true);
        for (let frame = 0; d.rowsAssignmentBuildInProgress && frame < 100; frame++) {
          r.paint(readPaint(c, records));
          d = r.getDiagnostics(c)!;
        }
        expect(d.rowsAssignmentBuildInProgress).toBe(false);
        let mesh = d;
        for (let frame = 0; mesh.rowsMeshBuildRecordsLastFrame === 0 && frame < 100; frame++) {
          expect(r.hasPendingPaintWork(c)).toBe(true);
          r.paint(readPaint(c, records));
          mesh = r.getDiagnostics(c)!;
        }
        expect(mesh.rowsMeshBuildRecordsLastFrame).toBeGreaterThan(0);
        expect(mesh.rowsMeshBuildRecordsLastFrame).toBeLessThan(records.length);
        expect(mesh.rowsMeshBuildInProgress).toBe(true);
      } finally {
        clock.mockRestore();
        assignment.mockRestore();
        r.unmount(c);
      }
    });

    it('reuses the visible empty read set when new reads remain offscreen', () => {
      const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
      const c = r.mount(mountArgs);
      const paint = (records: PileupRecord[], end: number) =>
        r.paint(
          paintArgsZoom(
            c,
            {
              dataAuthority: 'tile-engine',
              records,
              readSource: { truncated: false, windowStartBp: 0, windowEndBp: end },
            },
            4 / 150,
            { start: 40_000, end: 60_000 },
            800,
            240
          )
        );
      paint([read(100, 150, 'front')], 100_000);
      const advance = PersistentRowLayout.prototype.advanceAssignmentWithinBudget;
      const assignment = vi
        .spyOn(PersistentRowLayout.prototype, 'advanceAssignmentWithinBudget')
        .mockImplementation(function (this: PersistentRowLayout, job, maxRecords, budgetMs) {
          return advance.call(this, job, maxRecords, budgetMs, () => 0);
        });
      try {
        const records = makeWindowReads(5_500, 110_000);
        paint(records, 110_000);
        for (let frame = 0; r.hasPendingPaintWork(c) && frame < 100; frame++) {
          paint(records, 110_000);
        }
        expect(assignment).not.toHaveBeenCalled();
        expect(r.hasPendingPaintWork(c)).toBe(false);
        expect(r.getDiagnostics(c)?.rowsMeshRecordCount).toBe(1);
      } finally {
        assignment.mockRestore();
        r.unmount(c);
      }
    });

    it('keeps an exact aggregate bridge visible while an urgent WGS handoff yields', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 4000,
        readRowsAssignRecordsPerFrame: 512,
      });
      const c = r.mount(mountArgs);
      const frontRecords = makeWindowReads(100, 2_048);
      const paintWindow = (
        records: PileupRecord[],
        windowStartBp: number,
        windowEndBp: number,
        viewportStartBp: number,
        viewportEndBp: number
      ) =>
        paintArgsZoom(
          c,
          {
            dataAuthority: 'tile-engine',
            coverage: {
              bins: Array.from({ length: 64 }, (_, index) => (index % 5) + 20),
              binSize: Math.max(1, Math.ceil((windowEndBp - windowStartBp) / 64)),
              maxDepth: 24,
              provenance: {
                exact: true,
                method: 'resampled-reads-plus-coverage',
                source: 'tile-engine',
              },
            },
            records,
            readSource: { truncated: false, windowStartBp, windowEndBp },
          },
          4.0 / 150,
          { start: viewportStartBp, end: viewportEndBp },
          800,
          240
        );
      r.paint(paintWindow(frontRecords, 0, 2_048, 512, 1_024));
      while (r.hasPendingPaintWork(c)) {
        r.paint(paintWindow(frontRecords, 0, 2_048, 512, 1_024));
      }

      const records = Array.from({ length: 1_500 }, (_, index) => {
        const start = 1_024 + Math.floor(index / 10) * 2;
        return read(start, start + 150, `handoff-${index}`);
      });
      r.paint(paintWindow(records, 1_024, 4_096, 2_500, 3_012));
      let d = r.getDiagnostics(c)!;

      expect(d.rowsAssignmentBuildInProgress).toBe(true);
      expect(d.densityRowsMeshVisible).toBe(true);
      expect(d.renderedReadDensityAlpha).toBeGreaterThan(0);
      let frames = 1;
      while (r.hasPendingPaintWork(c) && frames < 200) {
        r.paint(paintWindow(records, 1_024, 4_096, 2_500, 3_012));
        d = r.getDiagnostics(c)!;
        frames++;
      }

      expect(d.rowsAssignmentBuildInProgress).toBe(false);
      expect(d.rowsMeshBuildInProgress).toBe(false);
      expect(d.rowsMeshRecordCount).toBe(records.length);
      expect(d.rowsMeshViewportCoverageFraction).toBeCloseTo(1, 6);
      expect(frames).toBeGreaterThan(1);
    });

    it('cancels unfinished lane assignment when broad coverage becomes the sole owner', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 4000,
        readRowsAssignRecordsPerFrame: 1,
        readRowsBuildRecordsPerFrame: 1,
      });
      const c = r.mount(mountArgs);
      const records = makeWindowReads(200, 100_000);

      r.paint(readPaint(c, records));
      const detail = r.getDiagnostics(c)!;
      expect(detail.rowsAssignmentBuildInProgress).toBe(true);
      expect(detail.rowsAssignmentBuildRecordsLastFrame).toBeGreaterThan(0);
      expect(detail.rowsRetainedPlacementCount).toBe(0);

      r.paint(
        paintArgsZoom(
          c,
          {
            dataAuthority: 'tile-engine',
            coverage: {
              bins: [8, 12, 9, 14],
              binSize: 25_000,
              maxDepth: 14,
              provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
            },
            records: [],
          },
          0.1 / 150,
          { start: 0, end: 100_000 },
          800,
          240
        )
      );
      const broad = r.getDiagnostics(c)!;
      expect(broad.rowsAssignmentBuildInProgress).toBe(false);
      expect(broad.rowsMeshBuildInProgress).toBe(false);
      expect(broad.rowsRetainedPlacementCount).toBe(0);
      expect(broad.rowsRetainedIntervalCount).toBe(0);
      expect(r.hasPendingPaintWork(c)).toBe(false);
    });

    it('cancels an unfinished exact-read back buffer instead of completing it off LOD', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 4000,
        readRowsAssignRecordsPerFrame: 10_000,
        readRowsAssignWorkBudgetMs: 1_000,
        readRowsBuildRecordsPerFrame: 1,
      });
      const c = r.mount(mountArgs);
      const records = makeWindowReads(200, 100_000);

      r.paint(readPaint(c, records));
      const detail = r.getDiagnostics(c)!;
      expect(detail.rowsAssignmentBuildInProgress).toBe(false);
      expect(detail.rowsMeshBuildInProgress).toBe(true);
      expect(detail.rowsRetainedPlacementCount).toBe(records.length);

      r.paint(
        paintArgsZoom(
          c,
          {
            dataAuthority: 'tile-engine',
            coverage: {
              bins: [8, 12, 9, 14],
              binSize: 25_000,
              maxDepth: 14,
              provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
            },
            records: [],
          },
          0.1 / 150,
          { start: 0, end: 100_000 },
          800,
          240
        )
      );
      const broad = r.getDiagnostics(c)!;
      expect(broad.rowsMeshBuildInProgress).toBe(false);
      expect(broad.rowsRetainedPlacementCount).toBe(0);
      expect(broad.rowsRetainedIntervalCount).toBe(0);
      expect(r.hasPendingPaintWork(c)).toBe(false);
    });

    it.each([
      {
        label: 'a wide forward viewport',
        frontStart: 0,
        frontEnd: 100_000,
        nextStart: 16_000,
        nextEnd: 116_000,
        viewStart: 88_000,
        viewEnd: 95_000,
      },
      {
        label: 'a narrow reverse viewport with a full next band already loaded',
        frontStart: 100_005_888,
        frontEnd: 100_022_272,
        nextStart: 100_001_792,
        nextEnd: 100_018_176,
        viewStart: 100_008_625,
        viewEnd: 100_009_137,
      },
    ])(
      'accelerates the next WGS handoff for $label',
      async ({ frontStart, frontEnd, nextStart, nextEnd, viewStart, viewEnd }) => {
        const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
        const NORMAL_CAP = 512;
        const URGENT_CAP = 4_096;
        const r = new PixiPileupTrackRenderer({
          type: 'pileup-test',
          rowHeightPx: 4,
          maxRows: 4000,
          readRowsAssignWorkBudgetMs: 1_000,
        });
        const c = r.mount(mountArgs);
        const paintWindow = (
          records: PileupRecord[],
          windowStartBp: number,
          windowEndBp: number,
          viewportStartBp: number,
          viewportEndBp: number
        ) =>
          paintArgsZoom(
            c,
            {
              dataAuthority: 'tile-engine',
              records,
              readSource: { truncated: false, windowStartBp, windowEndBp },
            },
            4.0 / 150,
            { start: viewportStartBp, end: viewportEndBp },
            800,
            240
          );

        const frontRecords = makeWindowReads(100, frontEnd - frontStart).map((record) => ({
          ...record,
          start: record.start + frontStart,
          end: record.end + frontStart,
        }));
        const frontPaint = () =>
          paintWindow(frontRecords, frontStart, frontEnd, viewStart, viewEnd);
        r.paint(frontPaint());
        while (r.hasPendingPaintWork(c)) r.paint(frontPaint());

        const visibleStart = Math.max(viewStart, nextStart);
        const visibleEnd = Math.min(viewEnd, nextEnd);
        const step = Math.max(
          1,
          Math.min(120, Math.floor((visibleEnd - visibleStart - 150) / 125))
        );
        const nextRecords = Array.from({ length: 10_000 }, (_, index) => {
          const start = visibleStart + Math.floor(index / 80) * step;
          return read(start, start + 150, `next-${index}`);
        });
        r.paint(paintWindow(nextRecords, nextStart, nextEnd, viewStart, viewEnd));
        const d = r.getDiagnostics(c)!;

        expect(d.rowsMeshViewportCoverageFraction).toBeCloseTo(1, 6);
        expect(d.rowsAssignmentBuildInProgress).toBe(true);
        expect(d.rowsAssignmentBuildRecordsLastFrame).toBeGreaterThan(NORMAL_CAP);
        expect(d.rowsAssignmentBuildRecordsLastFrame).toBeLessThanOrEqual(URGENT_CAP);
      }
    );

    it('finishes a usable read assignment while newer overlapping bands keep arriving', async () => {
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 80,
        readRowsAssignRecordsPerFrame: 8,
        readRowsAssignWorkBudgetMs: 1_000,
        readRowsBuildRecordsPerFrame: 128,
      });
      const c = r.mount(mountArgs);
      const records = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, index) =>
          read(12_000 + index * 2, 12_150 + index * 2, `${prefix}-${index}`)
        );
      const paint = (reads: PileupRecord[], start: number, generation = 'same-file') =>
        r.paint(
          paintArgsZoom(
            c,
            {
              dataAuthority: 'tile-engine',
              records: reads,
              readSource: {
                truncated: false,
                windowStartBp: start,
                windowEndBp: start + 16_384,
                sourceGenerationKey: generation,
              },
            },
            4 / 150,
            { start: 12_000, end: 12_512 },
            800,
            480
          )
        );
      const intermediate = records('intermediate', 128);
      const front = intermediate.slice(0, 8);
      paint(front, 0);
      while (r.hasPendingPaintWork(c)) paint(front, 0);
      const latest = [
        ...intermediate,
        ...Array.from({ length: 16 }, (_, index) =>
          read(20_000 + index * 2, 20_150 + index * 2, `latest-offscreen-${index}`)
        ),
      ];
      paint(intermediate, 4_096);
      let intermediatePublished = false;
      for (let frame = 0; frame < 24; frame += 1) {
        paint(latest, frame % 2 === 0 ? 8_192 : 8_704);
        const d = r.getDiagnostics(c)!;
        intermediatePublished ||= d.rowsMeshStartBp === 4_096;
        expect(d.rowsMeshViewportCoverageFraction).toBe(1);
        expect(d.renderedReadRowsAlpha).toBe(1);
      }
      expect(intermediatePublished).toBe(true);

      paint(latest, 8_192, 'replacement-file');
      while (r.hasPendingPaintWork(c)) paint(latest, 8_192, 'replacement-file');
      const final = r.getDiagnostics(c)!;
      expect(final.rowsMeshStartBp).toBe(8_192);
      expect(final.rowsMeshGenerationKey).toContain('replacement-file');
      r.unmount(c);
    });

    it('keeps a broader resident read generation when the feed narrows to its subset', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 4000,
      });
      const c = r.mount(mountArgs);
      const broadRecords = makeWindowReads(240, 2_048);
      const broadPaint = () =>
        paintArgsZoom(
          c,
          {
            dataAuthority: 'tile-engine',
            records: broadRecords,
            readSource: { truncated: false, windowStartBp: 0, windowEndBp: 2_048 },
          },
          4.0 / 150,
          { start: 1_100, end: 1_612 },
          800,
          240
        );
      r.paint(broadPaint());
      while (r.hasPendingPaintWork(c)) r.paint(broadPaint());
      const broad = r.getDiagnostics(c)!;
      const broadGeneration = broad.rowsMeshGenerationKey;
      const broadBuildCount = broad.rowsMeshBuildChunkCount;

      const narrowRecords = broadRecords.filter((record) => record.start >= 1_024);
      r.paint(
        paintArgsZoom(
          c,
          {
            dataAuthority: 'tile-engine',
            records: narrowRecords,
            readSource: { truncated: false, windowStartBp: 1_024, windowEndBp: 2_048 },
          },
          4.0 / 150,
          { start: 1_100, end: 1_612 },
          800,
          240
        )
      );
      const narrow = r.getDiagnostics(c)!;

      expect(r.hasPendingPaintWork(c)).toBe(false);
      expect(narrow.rowsMeshGenerationKey).toBe(broadGeneration);
      expect(narrow.rowsMeshStartBp).toBe(0);
      expect(narrow.rowsMeshEndBp).toBe(2_048);
      expect(narrow.rowsMeshBuildChunkCount).toBe(broadBuildCount);
    });

    it.each(['adds', 'removes'] as const)(
      'rebuilds a broader resident when a narrower feed %s a visible read',
      async (change) => {
        const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
        const r = new PixiPileupTrackRenderer({
          type: 'pileup-test',
          rowHeightPx: 4,
          maxRows: 4000,
        });
        const c = r.mount(mountArgs);
        const broadRecords = makeWindowReads(240, 2_048);
        const paintWindow = (records: PileupRecord[], startBp: number) =>
          paintArgsZoom(
            c,
            {
              dataAuthority: 'tile-engine',
              records,
              readSource: {
                truncated: false,
                windowStartBp: startBp,
                windowEndBp: 2_048,
                sourceGenerationKey: 'same-alignment-file',
              },
            },
            4.0 / 150,
            { start: 1_100, end: 1_612 },
            800,
            240
          );

        r.paint(paintWindow(broadRecords, 0));
        while (r.hasPendingPaintWork(c)) r.paint(paintWindow(broadRecords, 0));
        const broad = r.getDiagnostics(c)!;
        expect(broad.rowsMeshRecordCount).toBe(broadRecords.length);

        const removedReadId = broadRecords.find((record) => record.start === 1_300)!.readId;
        const narrowRecords = broadRecords.filter(
          (record) =>
            record.start >= 1_024 && (change !== 'removes' || record.readId !== removedReadId)
        );
        if (change === 'adds') narrowRecords.push(read(1_300, 1_450, 'late-tile-read'));
        narrowRecords.sort((left, right) => left.start - right.start || left.end - right.end);
        expect(narrowRecords.length).toBeLessThan(broadRecords.length);
        const debug = globalThis as { __dna119ExposePileupRows?: boolean };
        debug.__dna119ExposePileupRows = true;
        try {
          r.paint(paintWindow(narrowRecords, 1_024));
          let frames = 0;
          while (r.hasPendingPaintWork(c) && frames++ < 100) {
            r.paint(paintWindow(narrowRecords, 1_024));
          }
          const settled = r.getDiagnostics(c)!;

          expect(r.hasPendingPaintWork(c)).toBe(false);
          expect(settled.rowsMeshGenerationKey).not.toBe(broad.rowsMeshGenerationKey);
          expect(settled.rowsMeshRecordCount).toBe(narrowRecords.length);
          expect(r.getReadPresentationSnapshot(c)?.kind).toBe('reads');
          if (change === 'adds') {
            expect(
              settled.visibleReadSamples?.some((sample) => sample.readId === 'late-tile-read')
            ).toBe(true);
          } else {
            expect(
              settled.visibleReadSamples?.some((sample) => sample.readId === removedReadId)
            ).toBe(false);
          }
        } finally {
          debug.__dna119ExposePileupRows = false;
          r.unmount(c);
        }
      }
    );

    it('replaces an interior read even when count and sampled identity reads are unchanged', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const r = new PixiPileupTrackRenderer({ type: 'pileup-test', rowHeightPx: 4, maxRows: 4000 });
      const c = r.mount(mountArgs);
      const records = Array.from({ length: 21 }, (_, index) =>
        read(100 + index * 200, 250 + index * 200, `read-${index}`)
      );
      const args = (next: PileupRecord[]) =>
        paintArgsZoom(
          c,
          {
            dataAuthority: 'tile-engine',
            records: next,
            readSource: {
              truncated: false,
              windowStartBp: 0,
              windowEndBp: 8_192,
              sourceGenerationKey: 'same-alignment-file',
            },
          },
          4.0 / 150,
          { start: 0, end: 8_192 },
          800,
          240
        );
      const debug = globalThis as { __dna119ExposePileupRows?: boolean };
      debug.__dna119ExposePileupRows = true;
      try {
        r.paint(args(records));
        while (r.hasPendingPaintWork(c)) r.paint(args(records));
        const before = r.getDiagnostics(c)!;
        expect(before.visibleReadSamples?.some((sample) => sample.readId === 'read-5')).toBe(true);

        const replacement = records.map((record) => ({ ...record }));
        replacement[5] = { ...replacement[5]!, readId: 'replacement-5' };
        r.paint(args(replacement));
        let frames = 0;
        while (r.hasPendingPaintWork(c) && frames++ < 100) r.paint(args(replacement));
        const after = r.getDiagnostics(c)!;
        expect(r.hasPendingPaintWork(c)).toBe(false);
        expect(after.rowsMeshGenerationKey).not.toBe(before.rowsMeshGenerationKey);
        expect(after.visibleReadSamples?.some((sample) => sample.readId === 'replacement-5')).toBe(
          true
        );
        expect(after.visibleReadSamples?.some((sample) => sample.readId === 'read-5')).toBe(false);
      } finally {
        debug.__dna119ExposePileupRows = false;
        r.unmount(c);
      }
    });

    it('bounds a normal 80× tile-engine read window across frames under the default budget', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const DEFAULT_URGENT_CHUNK_CAP = 4_096;
      const DEFAULT_URGENT_MESH_CHUNK_CAP = 8_192;
      const DEFAULT_RETAIN_CHUNK_CAP = 512;
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 8000,
      });
      const c = r.mount(mountArgs);
      const records = makeWindowReads(7_000, 100_000);

      r.paint(readPaint(c, records));
      let d = r.getDiagnostics(c)!;

      expect(d.rowsAssignmentBuildInProgress).toBe(true);
      expect(d.rowsAssignmentBuildRecordsLastFrame).toBeLessThanOrEqual(DEFAULT_URGENT_CHUNK_CAP);
      expect(d.rowsMeshBuildInProgress).toBe(false);

      let frames = 1;
      while (
        (d.rowsAssignmentBuildInProgress ||
          d.rowsMeshBuildInProgress ||
          d.rowsRetainBuildInProgress) &&
        frames < 100
      ) {
        r.paint(readPaint(c, records));
        d = r.getDiagnostics(c)!;
        expect(d.rowsAssignmentBuildRecordsLastFrame).toBeLessThanOrEqual(DEFAULT_URGENT_CHUNK_CAP);
        expect(d.rowsMeshBuildRecordsLastFrame).toBeLessThanOrEqual(DEFAULT_URGENT_MESH_CHUNK_CAP);
        expect(d.rowsRetainBuildRecordsLastFrame).toBeLessThanOrEqual(DEFAULT_RETAIN_CHUNK_CAP);
        frames++;
      }

      expect(frames).toBeGreaterThan(1);
      expect(frames).toBeLessThan(100);
      expect(d.rowsAssignmentBuildInProgress).toBe(false);
      expect(d.rowsMeshBuildInProgress).toBe(false);
      expect(d.rowsRetainBuildInProgress).toBe(false);
      expect(d.rowsMeshRecordCount).toBe(records.length);
      expect(d.rowsMeshViewportCoverageFraction).toBeCloseTo(1, 6);
      expect(d.renderedReadRowsAlpha).toBeGreaterThan(0.95);
    });

    it('builds a large window across multiple frames, bounded per frame, and completes', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const CAP = 10;
      const N = 55;
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 4000,
        readRowsBuildRecordsPerFrame: CAP,
      });
      const c = r.mount(mountArgs);
      const records = makeWindowReads(N, 100_000);
      const expected = records.length;
      const advanceAssignment = PersistentRowLayout.prototype.advanceAssignmentWithinBudget;
      let clock = 0;
      const assignmentClock = vi
        .spyOn(PersistentRowLayout.prototype, 'advanceAssignmentWithinBudget')
        .mockImplementation(function (this: PersistentRowLayout, job, maxRecords, budgetMs) {
          return advanceAssignment.call(this, job, maxRecords, budgetMs, () => ++clock);
        });
      try {
        r.paint(readPaint(c, records));
        let d = r.getDiagnostics(c)!;
        expect(d.rowsAssignmentBuildInProgress).toBe(true);
        expect(d.rowsAssignmentBuildRecordsLastFrame).toBeGreaterThan(0);
        expect(d.rowsAssignmentBuildRecordsLastFrame).toBeLessThan(N);
        expect(d.rowsMeshBuildInProgress).toBe(false);
        expect(d.rowsMeshBuildRecordsLastFrame).toBe(0);
        expect(r.hasPendingPaintWork(c)).toBe(true);
        let assignmentFrames = 1;
        while (d.rowsAssignmentBuildInProgress && assignmentFrames < 50) {
          r.paint(readPaint(c, records));
          d = r.getDiagnostics(c)!;
          expect(d.rowsAssignmentBuildRecordsLastFrame).toBeGreaterThan(0);
          expect(d.rowsAssignmentBuildRecordsLastFrame).toBeLessThan(N);
          expect(d.rowsMeshBuildRecordsLastFrame).toBeLessThanOrEqual(CAP);
          if (d.rowsAssignmentBuildInProgress) {
            expect(d.rowsMeshBuildRecordsLastFrame).toBe(0);
          }
          expect(r.hasPendingPaintWork(c)).toBe(true);
          assignmentFrames++;
        }
        expect(d.rowsAssignmentBuildInProgress).toBe(false);
        expect(assignmentFrames).toBeLessThan(50);
        expect(
          assignmentClock.mock.calls.every(([, , budgetMs]) => budgetMs > 0 && budgetMs <= 2)
        ).toBe(true);

        expect(d.rowsMeshBuildInProgress).toBe(true);
        expect(d.rowsMeshBuildRecordsLastFrame).toBeLessThanOrEqual(CAP);
        expect(d.rowsMeshBuildRecordsLastFrame).toBeGreaterThan(0);
        expect(r.hasPendingPaintWork(c)).toBe(true);

        let frames = 1;
        while (r.getDiagnostics(c)!.rowsMeshBuildInProgress && frames < 50) {
          r.paint(readPaint(c, records));
          const dd = r.getDiagnostics(c)!;
          expect(dd.rowsMeshBuildRecordsLastFrame).toBeLessThanOrEqual(CAP);
          frames++;
        }
        d = r.getDiagnostics(c)!;
        expect(d.rowsMeshBuildInProgress).toBe(false);
        expect(r.hasPendingPaintWork(c)).toBe(false);
        expect(d.rowsMeshRecordCount).toBe(expected);
        expect(d.rowsVertexCount).toBe(expected * 6);
        expect(d.rowsMeshVisible).toBe(true);
        expect(frames).toBeGreaterThanOrEqual(Math.ceil(N / CAP));
      } finally {
        assignmentClock.mockRestore();
        r.unmount(c);
      }
    });

    it('keeps tile-engine coverage density visible at read zoom while the first exact-row mesh is pending', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const CAP = 1;
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 4000,
        readRowsBuildRecordsPerFrame: CAP,
        readRowsAssignRecordsPerFrame: CAP,
      });
      const c = r.mount(mountArgs);
      const records = makeWindowReads(20, 100_000);

      r.paint(
        paintArgsZoom(
          c,
          {
            dataAuthority: 'tile-engine',
            coverage: {
              bins: Array.from({ length: 100 }, (_, i) => (i % 7) + 2),
              binSize: 1_000,
              maxDepth: 8,
              provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
            },
            records,
            readSource: { truncated: false, windowStartBp: 0, windowEndBp: 100_000 },
          },
          4.0 / 150,
          { start: 0, end: 100_000 },
          800,
          240
        )
      );

      const d = r.getDiagnostics(c)!;
      expect(d.rowsAssignmentBuildInProgress).toBe(true);
      expect(d.rowsAssignmentBuildRecordsLastFrame).toBeLessThanOrEqual(CAP);
      expect(d.rowsMeshBuildInProgress).toBe(false);
      expect(d.rowsVertexCount).toBe(0);
      expect(d.recordsCommitTiming?.assignmentPending).toBe(true);
      expect(d.recordsCommitTiming?.exactDerivedBuilt).toBe(false);
      expect(d.aggregateDepthSource).toBe('tile-engine-coverage');
      expect(d.densityRowsVertexCount).toBeGreaterThan(0);
      expect(d.renderedReadRowsAlpha).toBe(0);
      expect(d.renderedReadDensityAlpha).toBeGreaterThan(0.95);
      expect(d.densityRowsMeshVisible).toBe(true);
      expect(d.readDisplayMode).toBe('density');
    });

    it('chunks exact-read row assignment before publishing exact-row geometry', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const ASSIGN_CAP = 5;
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 4000,
        readRowsAssignRecordsPerFrame: ASSIGN_CAP,
        readRowsAssignWorkBudgetMs: 1_000,
        readRowsBuildRecordsPerFrame: 1_000,
      });
      const c = r.mount(mountArgs);
      const records = makeWindowReads(21, 100_000);
      const paint = () =>
        paintArgsZoom(
          c,
          {
            dataAuthority: 'tile-engine',
            coverage: {
              bins: Array.from({ length: 100 }, (_, i) => (i % 7) + 2),
              binSize: 1_000,
              maxDepth: 8,
              provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
            },
            records,
            readSource: { truncated: false, windowStartBp: 0, windowEndBp: 100_000 },
          },
          4.0 / 150,
          { start: 0, end: 100_000 },
          800,
          240
        );

      r.paint(paint());
      let d = r.getDiagnostics(c)!;
      expect(d.rowsAssignmentBuildInProgress).toBe(true);
      expect(d.rowsAssignmentBuildRecordsLastFrame).toBeLessThanOrEqual(ASSIGN_CAP);
      expect(d.rowsMeshBuildInProgress).toBe(false);
      expect(d.rowsVertexCount).toBe(0);

      let frames = 1;
      while (d.rowsAssignmentBuildInProgress && frames < 20) {
        r.paint(paint());
        d = r.getDiagnostics(c)!;
        expect(d.rowsAssignmentBuildRecordsLastFrame).toBeLessThanOrEqual(ASSIGN_CAP);
        frames++;
      }

      expect(frames).toBeGreaterThanOrEqual(Math.ceil(records.length / ASSIGN_CAP));
      expect(d.rowsAssignmentBuildInProgress).toBe(false);
      expect(d.recordsCommitTiming?.assignmentPending).toBe(false);
      expect(d.recordsCommitTiming?.exactDerivedBuilt).toBe(true);
      expect(d.rowsUsed).toBeGreaterThan(0);
      expect(d.rowsMeshBuildInProgress).toBe(false);
      expect(d.rowsMeshBuildRecordsLastFrame).toBe(records.length);
      expect(r.hasPendingPaintWork(c)).toBe(false);
      expect(d.rowsVertexCount).toBe(records.length * 6);
      expect(d.rowsAssignmentBuildChunkCount).toBeGreaterThanOrEqual(
        Math.ceil(records.length / ASSIGN_CAP)
      );
    });

    it('starts a completed replacement mesh immediately near the retained read edge', () => {
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 80,
        readRowsAssignRecordsPerFrame: 4,
        readRowsAssignWorkBudgetMs: 1_000,
        readRowsBuildRecordsPerFrame: 2,
      });
      const c = r.mount(mountArgs);
      const paint = (records: PileupRecord[], windowStartBp: number) =>
        r.paint(
          paintArgsZoom(
            c,
            {
              dataAuthority: 'tile-engine',
              records,
              readSource: { truncated: false, windowStartBp, windowEndBp: windowStartBp + 16_384 },
            },
            4 / 150,
            { start: 10_512, end: 11_024 },
            800,
            240
          )
        );
      const front = [read(10_512, 10_662, 'old-0'), read(10_532, 10_682, 'old-1')];
      paint(front, 10_000);
      while (r.hasPendingPaintWork(c)) paint(front, 10_000);
      const oldGeneration = r.getDiagnostics(c)!.rowsMeshGenerationKey;
      const next = Array.from({ length: 8 }, (_, i) =>
        read(10_512 + i * 2, 10_662 + i * 2, `new-${i}`)
      );
      paint(next, 5_904);
      paint(next, 5_904);
      const building = r.getDiagnostics(c)!;
      expect(building.rowsAssignmentBuildInProgress).toBe(false);
      expect(building.rowsMeshBuildInProgress).toBe(true);
      expect(building.rowsMeshBuildRecordCursor).toBe(2);
      expect(building.rowsMeshGenerationKey).toBe(oldGeneration);
      expect(building.renderedReadRowsAlpha).toBe(1);
      while (r.hasPendingPaintWork(c)) paint(next, 5_904);
      expect(r.getDiagnostics(c)!.rowsMeshRecordCount).toBe(next.length);
      r.unmount(c);
    });

    it('continues chunked row assignment when an equivalent read window is re-emitted', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const ASSIGN_CAP = 5;
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 4000,
        readRowsAssignRecordsPerFrame: ASSIGN_CAP,
        readRowsAssignWorkBudgetMs: 1_000,
        readRowsBuildRecordsPerFrame: 1_000,
      });
      const c = r.mount(mountArgs);
      const records = makeWindowReads(21, 100_000);
      const dataFor = (rs: PileupRecord[]): PileupTrackDataFixture => ({
        dataAuthority: 'tile-engine',
        coverage: {
          bins: Array.from({ length: 100 }, (_, i) => (i % 7) + 2),
          binSize: 1_000,
          maxDepth: 8,
          provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
        },
        records: rs,
        readSource: { truncated: false, windowStartBp: 0, windowEndBp: 100_000 },
      });

      r.paint(paintArgsZoom(c, dataFor(records), 4.0 / 150, { start: 0, end: 100_000 }, 800, 240));
      const first = r.getDiagnostics(c)!;
      expect(first.rowsAssignmentBuildInProgress).toBe(true);
      expect(first.recordsCommitTiming?.assignRecordsProcessed).toBe(ASSIGN_CAP);

      const equivalentRecords = records.map((record) => ({ ...record }));
      r.paint(
        paintArgsZoom(
          c,
          dataFor(equivalentRecords),
          4.0 / 150,
          { start: 0, end: 100_000 },
          800,
          240
        )
      );
      const second = r.getDiagnostics(c)!;
      expect(second.rowsAssignmentBuildInProgress).toBe(true);
      expect(second.recordsCommitTiming?.assignRecordsProcessed).toBe(ASSIGN_CAP);
      expect(second.rowsAssignmentBuildChunkCount).toBe(first.rowsAssignmentBuildChunkCount + 1);

      let d = second;
      let guard = 0;
      while (d.rowsAssignmentBuildInProgress && guard < 20) {
        r.paint(
          paintArgsZoom(
            c,
            dataFor(records.map((record) => ({ ...record }))),
            4.0 / 150,
            { start: 0, end: 100_000 },
            800,
            240
          )
        );
        d = r.getDiagnostics(c)!;
        guard++;
      }
      expect(d.rowsAssignmentBuildInProgress).toBe(false);
      expect(d.rowsMeshBuildInProgress).toBe(false);
      expect(r.hasPendingPaintWork(c)).toBe(false);
      expect(d.rowsVertexCount).toBe(records.length * 6);
      expect(r.getReadPresentationSnapshot(c)?.kind).toBe('reads');
    });

    it('commits a current-only row layout without scheduling redundant retain work', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const RETAIN_CAP = 1;
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 4000,
        readRowsAssignRecordsPerFrame: 1_000,
        readRowsAssignWorkBudgetMs: 1_000,
        readRowsBuildRecordsPerFrame: 1_000,
        readRowsRetainRecordsPerFrame: RETAIN_CAP,
      });
      const c = r.mount(mountArgs);
      const coverage = {
        bins: Array.from({ length: 100 }, (_, i) => (i % 7) + 2),
        binSize: 1_000,
        maxDepth: 8,
        provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
      };
      const paintWindow = (records: PileupRecord[], start: number, end: number) =>
        paintArgsZoom(
          c,
          {
            dataAuthority: 'tile-engine',
            coverage,
            records,
            readSource: { truncated: false, windowStartBp: start, windowEndBp: end },
          },
          4.0 / 150,
          { start, end },
          800,
          240
        );

      const aRecords = makeWindowReads(8, 60_000);
      r.paint(paintWindow(aRecords, 0, 60_000));
      let d = r.getDiagnostics(c)!;
      let guard = 0;
      while ((d.rowsMeshBuildInProgress || d.rowsRetainBuildInProgress) && guard < 50) {
        r.paint(paintWindow(aRecords, 0, 60_000));
        d = r.getDiagnostics(c)!;
        guard++;
      }
      expect(guard).toBeLessThan(50);

      const bRecords = Array.from({ length: 20 }, (_, i) =>
        read(20_000 + i * 12, 20_150 + i * 12, `b${i}`)
      );
      r.paint(paintWindow(bRecords, 20_000, 100_000));
      d = r.getDiagnostics(c)!;

      expect(d.recordsCommitTiming?.exactDerivedBuilt).toBe(true);
      expect(d.recordsCommitTiming?.retainScheduled).toBe(false);
      expect(d.recordsCommitTiming?.beginRetainMs).toBe(0);
      expect(d.rowsRetainBuildInProgress).toBe(false);
      expect(d.rowsRetainBuildRecordsLastFrame).toBe(0);
      expect(d.rowsRetainedPlacementCount).toBe(bRecords.length);
      expect(d.rowsRetainedIntervalCount).toBe(bRecords.length);
      expect(d.paintTiming?.retainMs).toBeGreaterThanOrEqual(0);
      expect(d.rowsVertexCount).toBe(bRecords.length * 6);
      r.unmount(c);
    });

    it('does not clone the complete retained row map for an overlapping handoff', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const clone = vi.spyOn(PersistentRowLayout.prototype, 'clone');
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        maxRows: 80,
        readRowsAssignRecordsPerFrame: 1_000,
        readRowsBuildRecordsPerFrame: 1_000,
      });
      const c = r.mount(mountArgs);
      const paintWindow = (records: PileupRecord[], start: number, end: number) =>
        paintArgsZoom(
          c,
          {
            dataAuthority: 'tile-engine',
            records,
            readSource: { truncated: false, windowStartBp: start, windowEndBp: end },
          },
          4 / 150,
          { start: start + 20_000, end: start + 30_000 },
          800,
          240
        );
      const first = makeWindowReads(40, 60_000);
      r.paint(paintWindow(first, 0, 60_000));
      while (r.hasPendingPaintWork(c)) r.paint(paintWindow(first, 0, 60_000));

      clone.mockClear();
      const second = [
        ...first.filter((record) => record.end > 20_000),
        ...Array.from({ length: 12 }, (_, i) =>
          read(60_000 + i * 20, 60_150 + i * 20, `incoming-${i}`)
        ),
      ];
      r.paint(paintWindow(second, 20_000, 80_000));

      expect(
        clone,
        'the old front mesh is already the atomic display owner; duplicating the full row map only creates GC pressure'
      ).not.toHaveBeenCalled();
      clone.mockRestore();
    });

    it('rejects old-source read pixels when an empty reset and replacement feed coalesce before paint', () => {
      const renderer = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        maxRows: 80,
        readRowsAssignRecordsPerFrame: 1,
        readRowsBuildRecordsPerFrame: 1,
      });
      const container = renderer.mount(mountArgs);
      const data = new TrackDataStore();
      const trackId = 'generation-replacement';
      const payload = (sourceGenerationKey: string, count: number): PileupTrackData => ({
        dataAuthority: 'tile-engine',
        records: Array.from({ length: count }, (_, index) =>
          read(100 + index * 200, 250 + index * 200, `${sourceGenerationKey}-${index}`)
        ),
        readSource: {
          truncated: false,
          windowStartBp: 0,
          windowEndBp: 8_192,
          sourceGenerationKey,
        },
        coverage: { startBp: 0, binSize: 128, bins: new Array(64).fill(8), maxDepth: 8 },
      });
      const paint = () =>
        renderer.paint(
          paintArgsZoom(
            container,
            data.get<PileupTrackData>(trackId)!,
            4 / 150,
            { start: 0, end: 8_192 },
            800,
            240
          )
        );
      try {
        data.set(trackId, payload('old-bam', 8));
        let frames = 0;
        do {
          paint();
        } while (renderer.hasPendingPaintWork(container) && frames++ < 100);
        expect(renderer.hasPendingPaintWork(container)).toBe(false);
        expect(renderer.getDiagnostics(container)?.renderedReadRowsAlpha).toBe(1);

        data.set(trackId, { dataAuthority: 'tile-engine', records: [] });
        data.set(trackId, payload('replacement-bam', 32));
        paint();

        const state = (
          renderer as unknown as {
            containerState: WeakMap<
              object,
              { rowsMeshSourceGenerationKey: string; readSourceGenerationKey: string }
            >;
          }
        ).containerState.get(container)!;
        const during = renderer.getDiagnostics(container)!;
        expect(state.readSourceGenerationKey).toBe('replacement-bam');
        expect(during.rowsAssignmentBuildInProgress).toBe(true);
        if (state.rowsMeshSourceGenerationKey !== state.readSourceGenerationKey) {
          expect(
            during.renderedReadRowsAlpha,
            'a committed mesh from another BAM generation must not remain visible'
          ).toBe(0);
        }

        frames = 0;
        while (renderer.hasPendingPaintWork(container) && frames++ < 200) paint();
        expect(renderer.hasPendingPaintWork(container)).toBe(false);
        expect(state.rowsMeshSourceGenerationKey).toBe('replacement-bam');
        expect(renderer.getDiagnostics(container)?.rowsMeshRecordCount).toBe(32);
        expect(renderer.getDiagnostics(container)?.renderedReadRowsAlpha).toBe(1);
      } finally {
        renderer.unmount(container);
      }
    });

    it.each(['same-file-generation', ''])(
      'retires another presentation owner while preserving raw generation %j for read hits',
      (sourceGenerationKey) => {
        const renderer = new PixiPileupTrackRenderer({
          type: 'pileup-test',
          maxRows: 80,
          readRowsAssignRecordsPerFrame: 1,
          readRowsBuildRecordsPerFrame: 1,
        });
        const container = renderer.mount(mountArgs);
        const payload = (presentationOwnerKey: string, count: number): PileupTrackData => {
          const readSource = {
            truncated: false,
            windowStartBp: 0,
            windowEndBp: 8_192,
            sourceGenerationKey,
            presentationOwnerKey,
          };
          return {
            dataAuthority: 'tile-engine',
            readSource,
            records: Array.from({ length: count }, (_, index) =>
              read(100 + index * 200, 250 + index * 200, `same-read-${index}`)
            ),
            coverage: { startBp: 0, binSize: 128, bins: new Array(64).fill(8), maxDepth: 8 },
          };
        };
        const args = (data: PileupTrackData) =>
          paintArgsZoom(container, data, 4 / 150, { start: 0, end: 8_192 }, 800, 240);
        const paint = (data: PileupTrackData) => renderer.paint(args(data));
        try {
          const old = payload('old-reference-or-locator', 8);
          let frames = 0;
          do {
            paint(old);
          } while (renderer.hasPendingPaintWork(container) && frames++ < 100);
          expect(renderer.hasPendingPaintWork(container)).toBe(false);
          expect(renderer.getDiagnostics(container)?.renderedReadRowsAlpha).toBe(1);
          const locateArgs = {
            trackId: 'presentation-owner',
            pathMapper: args(old).pathMapper,
            containerTopPx: 50,
            chromosomeGlobalStartBp: 0,
          };
          const pointer = {
            ...locateArgs,
            localX: (175 * 4) / 150,
            localY: 1.5,
            screenX: (175 * 4) / 150,
            screenY: 51.5,
          };
          const oldHit = renderer.hitTestReadEvent(container, pointer);
          if (!oldHit) throw new Error('The original painted read must be selectable.');
          expect(renderer.locateRead(container, oldHit, locateArgs)).not.toBeNull();
          const replacement = payload('current-reference-or-locator', 32);
          paint(replacement);
          const during = renderer.getDiagnostics(container)!;
          expect(
            during.renderedReadRowsAlpha,
            'equal raw file generations do not authorize another locator or reference surface'
          ).toBe(0);
          frames = 0;
          while (renderer.hasPendingPaintWork(container) && frames++ < 200) paint(replacement);
          expect(renderer.hasPendingPaintWork(container)).toBe(false);
          expect(renderer.getDiagnostics(container)?.rowsMeshRecordCount).toBe(32);
          expect(renderer.getDiagnostics(container)?.renderedReadRowsAlpha).toBe(1);
          const state = (
            renderer as unknown as {
              containerState: WeakMap<object, { rowsMeshSourceGenerationKey: string }>;
            }
          ).containerState.get(container)!;
          expect(state.rowsMeshSourceGenerationKey).toBe(sourceGenerationKey);
          expect(
            renderer.locateRead(container, oldHit, locateArgs),
            'a pinned read from the retired owner must not migrate to the same read ID in another source'
          ).toBeNull();
          const currentHit = renderer.hitTestReadEvent(container, pointer);
          if (!currentHit) throw new Error('The replacement painted read must be selectable.');
          expect(currentHit).toMatchObject({
            sourceGenerationKey,
            presentationOwnerKey: 'current-reference-or-locator',
          });
          expect(renderer.locateRead(container, currentHit, locateArgs)).not.toBeNull();
        } finally {
          renderer.unmount(container);
        }
      }
    );

    it('NEVER-BLANK: the OLD mesh stays RESIDENT while a NEW window builds, then swaps atomically', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const CAP = 8;
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 4000,
        readRowsAssignRecordsPerFrame: CAP,
        readRowsBuildRecordsPerFrame: CAP,
      });
      const c = r.mount(mountArgs);

      const aRecords = makeWindowReads(5, 60_000);
      const aPaint = () =>
        paintArgsZoom(
          c,
          {
            records: aRecords,
            readSource: { truncated: false, windowStartBp: 0, windowEndBp: 60_000 },
          },
          4.0 / 150,
          { start: 0, end: 60_000 },
          800,
          240
        );
      r.paint(aPaint());
      let dA = r.getDiagnostics(c)!;
      let seedFrames = 0;
      while (r.hasPendingPaintWork(c) && seedFrames < 60) {
        r.paint(aPaint());
        dA = r.getDiagnostics(c)!;
        seedFrames++;
      }
      const aVertexCount = dA.rowsVertexCount;
      const aRecordCount = dA.rowsMeshRecordCount;
      expect(aRecordCount).toBe(aRecords.length);
      expect(aVertexCount).toBe(aRecords.length * 6);

      const bRecords = Array.from({ length: 40 }, (_, i) =>
        read(20_000 + i * 6, 20_005 + i * 6, `b${i}`)
      );
      const bPaint = () =>
        paintArgsZoom(
          c,
          {
            records: bRecords,
            readSource: { truncated: false, windowStartBp: 20_000, windowEndBp: 100_000 },
          },
          4.0 / 150,
          { start: 20_000, end: 100_000 },
          800,
          240
        );

      let guard = 0;
      r.paint(bPaint());
      let dMid = r.getDiagnostics(c)!;
      while (!dMid.rowsMeshBuildInProgress && r.hasPendingPaintWork(c) && guard < 60) {
        expect(dMid.rowsMeshRecordCount).toBe(aRecordCount);
        expect(dMid.rowsVertexCount).toBe(aVertexCount);
        r.paint(bPaint());
        dMid = r.getDiagnostics(c)!;
        guard++;
      }
      expect(dMid.rowsMeshBuildInProgress).toBe(true);
      expect(dMid.rowsMeshRecordCount).toBe(aRecordCount);
      expect(dMid.rowsVertexCount).toBe(aVertexCount);
      expect(dMid.rowsMeshBuildRecordsLastFrame).toBeLessThanOrEqual(CAP);

      let dB = r.getDiagnostics(c)!;
      while (dB.rowsMeshBuildInProgress && guard < 60) {
        r.paint(bPaint());
        const inFlight = r.getDiagnostics(c)!;
        if (inFlight.rowsMeshBuildInProgress) {
          expect(inFlight.rowsMeshRecordCount).toBe(aRecordCount);
          expect(inFlight.rowsVertexCount).toBe(aVertexCount);
          expect(inFlight.rowsMeshBuildRecordsLastFrame).toBeLessThanOrEqual(CAP);
        }
        dB = inFlight;
        guard++;
      }
      expect(dB.rowsMeshBuildInProgress).toBe(false);
      expect(dB.rowsMeshRecordCount).toBe(bRecords.length);
      expect(dB.rowsVertexCount).toBe(bRecords.length * 6);
      expect(dB.rowsMeshVisible).toBe(true);
    });

    it('keeps the committed front mesh through a disjoint source-window handoff', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const CAP = 4;
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 4000,
        readRowsAssignRecordsPerFrame: CAP,
        readRowsBuildRecordsPerFrame: CAP,
      });
      const c = r.mount(mountArgs);
      const paintWindow = (
        records: PileupRecord[],
        windowStartBp: number,
        windowEndBp: number,
        viewport = { start: windowStartBp, end: windowEndBp }
      ) =>
        paintArgsZoom(
          c,
          {
            dataAuthority: 'tile-engine',
            records,
            readSource: { truncated: false, windowStartBp, windowEndBp },
          },
          4.0 / 150,
          viewport,
          800,
          240
        );

      const aRecords = Array.from({ length: 8 }, (_, i) =>
        read(10_000 + i * 20, 10_010 + i * 20, `a${i}`)
      );
      let d = r.getDiagnostics(c)!;
      for (let guard = 0; guard < 40; guard += 1) {
        r.paint(paintWindow(aRecords, 0, 20_000));
        d = r.getDiagnostics(c)!;
        if (!d.rowsAssignmentBuildInProgress && !d.rowsMeshBuildInProgress) break;
      }
      expect(d.rowsMeshRecordCount).toBe(aRecords.length);
      const aGeneration = d.rowsMeshGenerationKey;
      const aVertices = d.rowsVertexCount;

      const bRecords = Array.from({ length: 32 }, (_, i) =>
        read(40_000 + i * 20, 40_010 + i * 20, `b${i}`)
      );
      r.paint(paintWindow(bRecords, 30_000, 50_000));
      d = r.getDiagnostics(c)!;
      expect(d.rowsAssignmentBuildInProgress).toBe(true);
      expect(d.rowsMeshGenerationKey).toBe(aGeneration);
      expect(d.rowsMeshRecordCount).toBe(aRecords.length);
      expect(d.rowsVertexCount).toBe(aVertices);

      let guard = 0;
      while ((d.rowsAssignmentBuildInProgress || d.rowsMeshBuildInProgress) && guard < 80) {
        r.paint(paintWindow(bRecords, 30_000, 50_000));
        d = r.getDiagnostics(c)!;
        if (d.rowsAssignmentBuildInProgress || d.rowsMeshBuildInProgress) {
          expect(d.rowsMeshGenerationKey).toBe(aGeneration);
          expect(d.rowsMeshRecordCount).toBe(aRecords.length);
          expect(d.rowsVertexCount).toBe(aVertices);
        }
        guard += 1;
      }
      expect(d.rowsAssignmentBuildInProgress).toBe(false);
      expect(d.rowsMeshBuildInProgress).toBe(false);
      expect(d.rowsMeshRecordCount).toBe(bRecords.length);
      expect(d.rowsMeshGenerationKey).not.toBe(aGeneration);
      expect(d.rowsMeshVisible).toBe(true);
    });

    it('keeps overflow on the same committed read generation through a side-scroll swap', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 2,
        overflowBandHeightPx: 20,
        readRowsAssignRecordsPerFrame: 1_000,
        readRowsBuildRecordsPerFrame: 2,
      });
      const c = r.mount(mountArgs);
      const windowData = (
        records: PileupRecord[],
        windowStartBp: number,
        windowEndBp: number
      ): PileupTrackData => ({
        dataAuthority: 'tile-engine',
        records,
        readSource: { truncated: false, windowStartBp, windowEndBp },
      });
      const paintWindow = (records: PileupRecord[], windowStartBp: number, windowEndBp: number) =>
        paintArgsZoom(
          c,
          windowData(records, windowStartBp, windowEndBp),
          4.0 / 150,
          { start: windowStartBp, end: windowEndBp },
          800,
          240
        );
      const aRecords = Array.from({ length: 6 }, (_, i) =>
        read(10_000 + i, 50_000 + i, `a${i}`, {
          mismatches: [{ pos: 20_000 + i, kind: 'sub', refBase: 'A', readBase: 'G' }],
        })
      );
      const bRecords = [
        ...aRecords,
        ...Array.from({ length: 4 }, (_, i) =>
          read(30_000 + i, 90_000 + i, `b${i}`, {
            mismatches: [{ pos: 40_000 + i, kind: 'sub', refBase: 'C', readBase: 'T' }],
          })
        ),
      ];

      let a = r.getDiagnostics(c)!;
      for (let guard = 0; guard < 30; guard += 1) {
        r.paint(paintWindow(aRecords, 0, 60_000));
        a = r.getDiagnostics(c)!;
        if (!a.rowsAssignmentBuildInProgress && !a.rowsMeshBuildInProgress) break;
      }
      expect(a.rowsMeshRecordCount).toBe(aRecords.length);
      expect(a.overflowRowsVertexCount).toBeGreaterThan(0);
      expect(a.rowsMeshGenerationKey).not.toBe('');
      expect(a.overflowGenerationKey).toBe(a.rowsMeshGenerationKey);
      const aOverflowBuilds = a.overflowGeometryBuildCount;
      const aDifferenceBuilds = a.readDifferenceBuildCount;
      expect(aDifferenceBuilds).toBeGreaterThan(0);

      r.paint(paintWindow(bRecords, 20_000, 100_000));
      let inFlight = r.getDiagnostics(c)!;
      expect(inFlight.rowsMeshBuildInProgress).toBe(true);
      expect(inFlight.rowsMeshRecordCount).toBe(aRecords.length);
      expect(inFlight.rowsMeshGenerationKey).toBe(a.rowsMeshGenerationKey);
      expect(inFlight.overflowGenerationKey).toBe(inFlight.rowsMeshGenerationKey);
      expect(inFlight.overflowGeometryBuildCount).toBe(aOverflowBuilds);
      expect(inFlight.readDifferenceBuildCount).toBe(aDifferenceBuilds);

      let guard = 0;
      while (inFlight.rowsMeshBuildInProgress && guard < 30) {
        r.paint(paintWindow(bRecords, 20_000, 100_000));
        inFlight = r.getDiagnostics(c)!;
        if (inFlight.rowsMeshBuildInProgress) {
          expect(inFlight.rowsMeshGenerationKey).toBe(a.rowsMeshGenerationKey);
          expect(inFlight.overflowGenerationKey).toBe(inFlight.rowsMeshGenerationKey);
          expect(inFlight.overflowGeometryBuildCount).toBe(aOverflowBuilds);
          expect(inFlight.readDifferenceBuildCount).toBe(aDifferenceBuilds);
        }
        guard += 1;
      }

      expect(inFlight.rowsMeshBuildInProgress).toBe(false);
      expect(inFlight.rowsMeshRecordCount).toBe(bRecords.length);
      expect(inFlight.rowsMeshGenerationKey).not.toBe(a.rowsMeshGenerationKey);
      expect(inFlight.overflowGenerationKey).toBe(inFlight.rowsMeshGenerationKey);
      expect(inFlight.overflowGeometryBuildCount).toBe(aOverflowBuilds + 1);
      expect(inFlight.readDifferenceBuildCount).toBe(aDifferenceBuilds + 1);
    });

    it('finishes the next usable read mesh when a newer BAM window arrives mid-build', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 4000,
        readRowsAssignRecordsPerFrame: 4,
        readRowsBuildRecordsPerFrame: 2,
      });
      const c = r.mount(mountArgs);
      const viewport = { start: 45_000, end: 50_000 };
      const paintWindow = (records: PileupRecord[], windowStartBp: number, windowEndBp: number) =>
        paintArgsZoom(
          c,
          {
            dataAuthority: 'tile-engine',
            records,
            readSource: { truncated: false, windowStartBp, windowEndBp },
          },
          4.0 / 150,
          viewport,
          800,
          240
        );

      const aRecords = Array.from({ length: 2 }, (_, i) =>
        read(45_000 + i * 20, 45_010 + i * 20, `a${i}`)
      );
      let d = r.getDiagnostics(c)!;
      for (let guard = 0; guard < 20; guard += 1) {
        r.paint(paintWindow(aRecords, 0, 60_000));
        d = r.getDiagnostics(c)!;
        if (!d.rowsAssignmentBuildInProgress && !d.rowsMeshBuildInProgress) break;
      }
      const aGeneration = d.rowsMeshGenerationKey;
      expect(d.rowsMeshRecordCount).toBe(aRecords.length);

      const bRecords = Array.from({ length: 8 }, (_, i) =>
        read(45_000 + i * 20, 45_010 + i * 20, `b${i}`)
      );
      r.paint(paintWindow(bRecords, 20_000, 100_000));
      r.paint(paintWindow(bRecords, 20_000, 100_000));
      const bBuilding = r.getDiagnostics(c)!;
      expect(bBuilding.rowsMeshBuildInProgress).toBe(true);
      expect(bBuilding.rowsMeshBuildRecordCursor).toBe(2);
      expect(bBuilding.rowsMeshGenerationKey).toBe(aGeneration);

      const cRecords = [
        ...bRecords,
        ...Array.from({ length: 4 }, (_, i) =>
          read(70_000 + i * 20, 70_010 + i * 20, `c-offscreen-${i}`)
        ),
      ];
      r.paint(paintWindow(cRecords, 40_000, 120_000));
      const cAssigning = r.getDiagnostics(c)!;
      expect(cAssigning.rowsAssignmentBuildInProgress).toBe(false);
      expect(cAssigning.rowsMeshBuildInProgress).toBe(true);
      expect(
        cAssigning.rowsMeshBuildRecordCursor,
        'the already-started B mesh must progress before offscreen C work'
      ).toBeGreaterThan(bBuilding.rowsMeshBuildRecordCursor);

      for (let guard = 0; guard < 2; guard += 1) {
        r.paint(paintWindow(cRecords, 40_000, 120_000));
      }
      r.paint(paintWindow(cRecords, 40_000, 120_000));
      const bCommitted = r.getDiagnostics(c)!;
      expect(bCommitted.rowsMeshRecordCount).toBe(bRecords.length);
      expect(bCommitted.rowsMeshGenerationKey).not.toBe(aGeneration);
    });

    it('ZERO per-swap buffer allocation: a sustained OVERLAPPING fast-pan does NOT grow the pool after warmup ', async () => {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 4,
        maxRows: 4000,
        readRowsAssignRecordsPerFrame: 16,
      });
      const c = r.mount(mountArgs);

      const WIN = 80_000;
      const N = 200;
      const swapToWindow = (winStart: number) => {
        const winEnd = winStart + WIN;
        const recs = Array.from({ length: N }, (_, i) => {
          const s = winStart + Math.floor(((WIN - 10) * i) / N);
          return read(s, s + 5, `w${winStart}-${i}`);
        });
        const paint = () =>
          paintArgsZoom(
            c,
            {
              records: recs,
              readSource: { truncated: false, windowStartBp: winStart, windowEndBp: winEnd },
            },
            4.0 / 150,
            { start: winStart, end: winEnd },
            800,
            240
          );
        let diagnostics = r.getDiagnostics(c)!;
        for (let f = 0; f < 50; f++) {
          r.paint(paint());
          diagnostics = r.getDiagnostics(c)!;
          if (
            !diagnostics.rowsAssignmentBuildInProgress &&
            !diagnostics.rowsMeshBuildInProgress &&
            diagnostics.rowsMeshStartBp === winStart &&
            diagnostics.rowsMeshEndBp === winEnd
          ) {
            break;
          }
        }
        expect(diagnostics.rowsAssignmentBuildInProgress).toBe(false);
        expect(diagnostics.rowsMeshBuildInProgress).toBe(false);
        expect(diagnostics.rowsMeshStartBp).toBe(winStart);
        expect(diagnostics.rowsMeshEndBp).toBe(winEnd);
        return diagnostics;
      };

      let win = 0;
      swapToWindow(win);
      win += WIN / 4;
      const dWarm = swapToWindow(win);
      expect(dWarm.rowsMeshRecordCount).toBe(N);
      const allocAfterWarmup = dWarm.rowsMeshBufferAllocCount;
      expect(allocAfterWarmup).toBeGreaterThan(0);

      for (let s = 0; s < 24; s++) {
        win += WIN / 4;
        const d = swapToWindow(win);
        expect(d.rowsMeshRecordCount).toBe(N);
        expect(d.rowsMeshVisible).toBe(true);
        expect(d.rowsMeshBufferAllocCount).toBe(allocAfterWarmup);
      }

      expect(r.getDiagnostics(c)!.rowsMeshBufferAllocCount).toBe(allocAfterWarmup);
    });
  });

  it('keeps resident streaming rows opaque while the next source window is prepared', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 16,
    });
    const c = r.mount(mountArgs);
    r.paint(
      paintArgsZoom(
        c,
        {
          records: [read(5000, 6000, 'a'), read(5000, 6000, 'b')],
          readSource: { truncated: false, windowStartBp: 5000, windowEndBp: 6000 },
        },
        4.0 / 150,
        { start: 4000, end: 7000 },
        120,
        80
      )
    );
    const d = r.getDiagnostics(c)!;
    expect(d.readSourceWindowCoversViewport).toBe(false);
    expect(d.readSourceWindowCoverageFraction).toBeCloseTo(1 / 3, 6);
    expect(d.rowsMeshViewportCoverageFraction).toBeCloseTo(1 / 3, 6);
    expect(d.renderedReadRowsAlpha).toBeCloseTo(1, 6);
    expect(d.renderedReadDensityAlpha).toBeGreaterThan(0.5);
    expect(d.rowsMeshVisible).toBe(true);
  });

  it('does not let incoming source metadata authorize a stale resident read mesh', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 16,
      readRowsBuildRecordsPerFrame: 1,
    });
    const c = r.mount(mountArgs);

    r.paint(
      paintArgsZoom(
        c,
        {
          records: [read(0, 1000, 'old')],
          readSource: { truncated: false, windowStartBp: 0, windowEndBp: 1000 },
          coverage: { bins: Array.from({ length: 10 }, () => 8), binSize: 100, maxDepth: 8 },
        },
        4.0 / 150,
        { start: 0, end: 1000 },
        120,
        80
      )
    );
    expect(r.getDiagnostics(c)!.renderedReadRowsAlpha).toBeGreaterThan(0.95);

    r.paint(
      paintArgsZoom(
        c,
        {
          records: [read(900, 1100, 'new-a'), read(1100, 1900, 'new-b')],
          readSource: { truncated: false, windowStartBp: 900, windowEndBp: 1900 },
          coverage: { bins: Array.from({ length: 10 }, () => 8), binSize: 100, maxDepth: 8 },
        },
        4.0 / 150,
        { start: 900, end: 1900 },
        120,
        80
      )
    );
    const d = r.getDiagnostics(c)!;
    expect(d.readSourceWindowCoversViewport).toBe(true);
    expect(d.rowsMeshBuildInProgress).toBe(true);
    expect(d.rowsMeshStartBp).toBe(0);
    expect(d.rowsMeshEndBp).toBe(1000);
    expect(d.renderedReadRowsAlpha).toBeGreaterThan(0.99);
    expect(d.renderedReadDensityAlpha).toBeGreaterThan(0.7);
  });

  it('renders the aggregate density when zoomed OUT past a localized read field ', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 6,
      maxRows: 40,
    });
    const c = r.mount(mountArgs);
    const records = Array.from({ length: 30 }, (_, i) => read(5000, 6000, 'r' + i));
    r.paint(paintArgsZoom(c, { records }, 0.001, { start: 0, end: 800_000 }, 800, 120));
    const d = r.getDiagnostics(c)!;
    expect(d.readDisplayMode).toBe('density');
    expect(d.densityRowsMeshVisible).toBe(true);
    expect(d.renderedReadDensityAlpha).toBeGreaterThan(0.5);
    expect(d.densityRowsVertexCount).toBeGreaterThan(0);
  });

  it('does not render overflow when every loaded read fits in exact rows', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 4,
      overflowBandHeightPx: 20,
    });
    const c = r.mount(mountArgs);
    r.paint(
      paintArgsZoom(
        c,
        {
          records: [read(0, 1000, 'a'), read(0, 1000, 'b')],
          readSource: { truncated: false, windowStartBp: 0, windowEndBp: 1000 },
        },
        4.0 / 150,
        { start: 100, end: 900 },
        120,
        60
      )
    );

    const d = r.getDiagnostics(c)!;
    expect(d.hiddenReadCount).toBe(0);
    expect(d.overflowRowsVertexCount).toBe(0);
    expect(d.overflowColumnCoverage).toBe(0);
    expect(d.renderedOverflowRowsAlpha).toBe(0);
    expect(d.overflowRowsMeshVisible).toBe(false);
  });

  it('reports forward, reverse, and paired read counts for live visual probes', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
    const c = r.mount(mountArgs);

    r.paint(
      paintArgs(c, {
        records: [
          read(100, 180, 'forward'),
          read(200, 280, 'reverse', { strand: '-' }),
          read(300, 380, 'paired-forward', {
            pair: { paired: true, properPair: true, mateUnmapped: false },
          }),
          read(400, 480, 'paired-reverse', {
            strand: '-',
            pair: { paired: true, properPair: true, mateUnmapped: false },
          }),
        ],
      })
    );

    const d = r.getDiagnostics(c)!;
    expect(d.recordCount).toBe(4);
    expect(d.forwardReadCount).toBe(2);
    expect(d.reverseReadCount).toBe(2);
    expect(d.pairedReadCount).toBe(2);
  });

  it('writes forward, reverse, and paired colors into the exact-read row mesh', async () => {
    const {
      DEFAULT_PILEUP_FORWARD_READ_COLOR,
      DEFAULT_PILEUP_PAIRED_READ_COLOR,
      DEFAULT_PILEUP_REVERSE_READ_COLOR,
      PixiPileupTrackRenderer,
    } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
    const c = r.mount(mountArgs);
    r.paint(
      paintArgs(c, {
        records: [
          read(100, 180, 'forward'),
          read(220, 300, 'reverse', { strand: '-' }),
          read(340, 420, 'paired', {
            strand: '-',
            pair: { paired: true, properPair: true, mateUnmapped: false },
          }),
        ],
      })
    );

    const state = (
      r as unknown as {
        containerState: WeakMap<
          object,
          { rows: { buffers: Array<{ data: Float32Array }> } | null }
        >;
      }
    ).containerState.get(c);
    const colors = state?.rows?.buffers[8]?.data;
    expect(colors).toBeInstanceOf(Float32Array);
    const rgbAtRecord = (recordIndex: number) => {
      const i = recordIndex * 6 * 4;
      return [
        Math.round(colors![i] * 255),
        Math.round(colors![i + 1] * 255),
        Math.round(colors![i + 2] * 255),
      ];
    };
    const rgb = (color: number) => [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];

    expect(rgbAtRecord(0)).toEqual(rgb(DEFAULT_PILEUP_FORWARD_READ_COLOR));
    expect(rgbAtRecord(1)).toEqual(rgb(DEFAULT_PILEUP_REVERSE_READ_COLOR));
    expect(rgbAtRecord(2)).toEqual(rgb(DEFAULT_PILEUP_PAIRED_READ_COLOR));
  });

  it('uses the dark read blue immediately through the exact-row shader after a theme switch', async () => {
    const {
      DARK_PILEUP_FORWARD_READ_COLOR,
      DARK_PILEUP_PAIRED_READ_COLOR,
      DARK_PILEUP_REVERSE_READ_COLOR,
      DEFAULT_PILEUP_FORWARD_READ_COLOR,
      PixiPileupTrackRenderer,
    } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
    const c = r.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      records: [
        read(100, 180, 'forward'),
        read(220, 300, 'reverse', { strand: '-' }),
        read(340, 420, 'paired', {
          strand: '-',
          pair: { paired: true, properPair: true, mateUnmapped: false },
        }),
      ],
    };
    r.paint(paintArgs(c, data));
    r.paint(
      paintArgsZoom(c, data, 0.01, { start: 0, end: 100_000 }, 800, 240, webglThemeForMode('dark'))
    );

    const state = (
      r as unknown as {
        containerState: WeakMap<
          object,
          {
            rows: {
              shader: {
                resources: {
                  annotationUniforms: {
                    uniforms: { uTrackColor: Float32Array; uUseTrackColor: number };
                  };
                };
              };
            } | null;
          }
        >;
      }
    ).containerState.get(c);
    const uniforms = state?.rows?.shader.resources.annotationUniforms.uniforms;
    expect(uniforms?.uUseTrackColor).toBe(1);
    expect(uniforms?.uTrackColor[0]).toBeCloseTo(
      ((DARK_PILEUP_FORWARD_READ_COLOR >> 16) & 0xff) / 255,
      6
    );
    expect(uniforms?.uTrackColor[1]).toBeCloseTo(
      ((DARK_PILEUP_REVERSE_READ_COLOR >> 8) & 0xff) / 255,
      6
    );
    expect(uniforms?.uTrackColor[2]).toBeCloseTo((DARK_PILEUP_PAIRED_READ_COLOR & 0xff) / 255, 6);
    expect(DARK_PILEUP_FORWARD_READ_COLOR).not.toBe(DEFAULT_PILEUP_FORWARD_READ_COLOR);

    const diagnostics = r.getDiagnostics(c)!;
    expect(diagnostics.themeMode).toBe('dark');
    expect(diagnostics.forwardReadColor).toBe(DARK_PILEUP_FORWARD_READ_COLOR);
    expect(diagnostics.reverseReadColor).toBe(DARK_PILEUP_REVERSE_READ_COLOR);
    expect(diagnostics.pairedReadColor).toBe(DARK_PILEUP_PAIRED_READ_COLOR);
  });

  it('recolors committed exact rows in one paint without rebuilding their geometry', async () => {
    const { DARK_PILEUP_PAIRED_READ_COLOR, PixiPileupTrackRenderer } =
      await import('./pileup-track-renderer');
    const renderer = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      maxRows: 16,
      readRowsBuildRecordsPerFrame: 1,
    });
    const container = renderer.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      records: Array.from({ length: 8 }, (_, index) =>
        read(100 + index * 100, 180 + index * 100, `theme-${index}`)
      ),
    };
    const lightArgs = paintArgs(container, data);
    lightArgs.presentation = { color: '#a8ceff' };
    renderer.paint(lightArgs);
    while (renderer.getDiagnostics(container)!.rowsMeshBuildInProgress) {
      renderer.paint(lightArgs);
    }

    const state = (
      renderer as unknown as {
        containerState: WeakMap<
          object,
          {
            rows: {
              shader: {
                resources: {
                  annotationUniforms: {
                    uniforms: { uTrackColor: Float32Array; uUseTrackColor: number };
                  };
                };
              };
            } | null;
          }
        >;
      }
    ).containerState.get(container)!;
    const committedRows = state.rows;
    const buildsBefore = renderer.getDiagnostics(container)!.rowsMeshBuildChunkCount;

    renderer.paint({ ...lightArgs, theme: webglThemeForMode('dark') });

    const diagnostics = renderer.getDiagnostics(container)!;
    const uniforms = state.rows!.shader.resources.annotationUniforms.uniforms;
    expect(state.rows).toBe(committedRows);
    expect(diagnostics.rowsMeshBuildInProgress).toBe(false);
    expect(diagnostics.rowsMeshBuildChunkCount).toBe(buildsBefore);
    expect(uniforms.uUseTrackColor).toBe(1);
    expect(uniforms.uTrackColor[0]).toBeCloseTo(
      ((DARK_PILEUP_PAIRED_READ_COLOR >> 16) & 0xff) / 255,
      6
    );
    expect(uniforms.uTrackColor[1]).toBeCloseTo(
      ((DARK_PILEUP_PAIRED_READ_COLOR >> 8) & 0xff) / 255,
      6
    );
    expect(uniforms.uTrackColor[2]).toBeCloseTo((DARK_PILEUP_PAIRED_READ_COLOR & 0xff) / 255, 6);
  });

  it('reports debug-only visible read column coverage when enabled', async () => {
    const g = globalThis as { __dna119MeasurePileupCoverage?: boolean };
    g.__dna119MeasurePileupCoverage = true;
    try {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
      const c = r.mount(mountArgs);
      r.paint(paintArgsZoom(c, { records: [read(0, 50, 'left'), read(500, 550, 'middle')] }, 1));
      const d = r.getDiagnostics(c)!;
      expect(d.visibleReadColumnCoverage).toBeGreaterThan(0);
      expect(d.visibleReadColumnCoverage).toBeLessThan(0.2);
    } finally {
      g.__dna119MeasurePileupCoverage = false;
    }
  });

  it('does not compute visible read column coverage unless the live gate enables it', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    r.paint(paintArgs(c, { records: [read(100, 200, 'X')] }));
    expect(r.getDiagnostics(c)!.visibleReadColumnCoverage).toBeNull();
  });

  it('renders coverage data through the collapsed-pileup aggregate when exact reads are unavailable', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      coverage: { bins: Array.from({ length: 500 }, () => 30), binSize: 200, maxDepth: 30 },
    };

    r.paint(paintArgsZoom(c, data, 0.001, { start: 0, end: 100_000 }, 800));
    const d = r.getDiagnostics(c)!;
    expect(d.readAggregateSource).toBe('collapsed-pileup');
    expect(d.readDisplayMode).toBe('density');
    expect(d.densityRowsVertexCount).toBeGreaterThan(0);
    expect(d.readDensityColumnCoverage).toBe(1);
    expect(d.rowsVertexCount).toBe(0);
  });

  it('reuses coverage sampling and density geometry for the same coverage reference at a fixed camera', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    const observedBins = observeIndexedBinReads(
      Array.from({ length: 1024 }, (_, i) => 20 + (i % 17))
    );
    const coverage: NonNullable<PileupTrackData['coverage']> = {
      coverageRevision: 'test-producer:1',
      startBp: 0,
      bins: observedBins.bins,
      binSize: 128,
      maxDepth: 36,
      provenance: { exact: true, method: 'native-target', source: 'tile-engine' },
    };
    const data: PileupTrackData = {
      dataAuthority: 'tile-engine',
      coverage,
      coverageLod: {
        role: 'current-lod',
        level: 7,
        targetLevel: 7,
        binSize: 128,
        authority: 'native-target',
        provenanceExact: true,
        provenanceMethod: 'native-target',
        provenanceSource: 'tile-engine',
      },
      records: [],
    };
    const paint = () => paintArgsZoom(c, data, 0.01, { start: 0, end: 100_000 }, 800);

    r.paint(paint());
    observedBins.reset();
    const before = r.getDiagnostics(c)!;

    r.paint(paint());
    const after = r.getDiagnostics(c)!;

    expect({
      indexedBinReads: observedBins.indexedReads(),
      geometryBuilds: after.coverageGeometryBuildCount - before.coverageGeometryBuildCount,
      geometryBufferUpdates: after.coverageBufferUploadCount - before.coverageBufferUploadCount,
    }).toEqual({ indexedBinReads: 0, geometryBuilds: 0, geometryBufferUpdates: 0 });
  });

  it('keeps broad exact coverage GPU-resident through the full-genome to 150 Mb gesture corridor', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    const genomeLength = 3_088_269_832;
    const viewportWidthPx = 1600;
    const percentiles = { p50: 28, p90: 36, p95: 42, p99: 58, max: 130 };
    const makeCoverage = (revision: string, startBp: number, endBp: number, binSize: number) => {
      const binCount = Math.ceil((endBp - startBp) / binSize);
      const observed = observeIndexedBinReads(
        Array.from({ length: binCount }, (_, i) => 20 + ((i * 17) % 23))
      );
      return {
        observed,
        signal: {
          coverageRevision: revision,
          startBp,
          bins: observed.bins,
          binSize,
          maxDepth: 42,
          depthPercentiles: percentiles,
          provenance: {
            exact: true,
            method: 'resolution-ranked-source-merge',
            source: 'tile-engine',
          },
        } satisfies NonNullable<PileupTrackData['coverage']>,
      };
    };
    const wholeGenome = makeCoverage('broad:whole', 0, genomeLength, 524_288);
    const midBand = makeCoverage('broad:500m', 402_653_184, 2_549_805_056, 262_144);
    const fineBand = makeCoverage('broad:150m', 939_524_096, 2_013_265_920, 65_536);
    const paint = (
      coverage: NonNullable<PileupTrackData['coverage']>,
      range: { start: number; end: number }
    ) =>
      paintArgsZoom(
        c,
        {
          dataAuthority: 'tile-engine',
          coverage,
          coverageLod: {
            role: 'current-lod',
            level: Math.round(Math.log2(coverage.binSize)),
            targetLevel: Math.round(Math.log2(coverage.binSize)),
            binSize: coverage.binSize,
            authority: 'native-target',
            provenanceExact: true,
            provenanceMethod: coverage.provenance!.method,
            provenanceSource: 'tile-engine',
          },
          records: [],
        },
        viewportWidthPx / (range.end - range.start),
        range,
        viewportWidthPx,
        276
      );

    r.paint(paint(wholeGenome.signal, { start: 0, end: genomeLength }));
    const perfCounters = () => {
      const diagnostics = r.getDiagnostics(c)!;
      return {
        samplePasses: diagnostics.coverageSamplePassCount,
        geometryBuilds: diagnostics.coverageGeometryBuildCount,
        bufferUploads: diagnostics.coverageBufferUploadCount,
      };
    };
    expect(r.getDiagnostics(c)?.coverageSampledColumnCount).toBe(wholeGenome.signal.bins.length);
    expect(perfCounters()).toEqual({ samplePasses: 1, geometryBuilds: 1, bufferUploads: 1 });
    wholeGenome.observed.reset();

    for (const range of [
      { start: 444_134_916, end: 2_644_134_916 },
      { start: 894_134_916, end: 2_194_134_916 },
    ]) {
      r.paint(paint(wholeGenome.signal, range));
    }
    expect(wholeGenome.observed.indexedReads(), 'whole-genome resident camera reads').toBe(0);
    expect(perfCounters(), 'whole-genome camera-only counters').toEqual({
      samplePasses: 1,
      geometryBuilds: 1,
      bufferUploads: 1,
    });

    r.paint(paint(midBand.signal, { start: 976_000_000, end: 1_476_000_000 }));
    expect(
      midBand.observed.indexedReads(),
      'new 500 Mb authority is consumed once'
    ).toBeGreaterThan(0);
    expect(r.getDiagnostics(c)?.coverageSampledColumnCount).toBe(midBand.signal.bins.length);
    expect(perfCounters(), 'one build/upload for the new 500 Mb authority').toEqual({
      samplePasses: 2,
      geometryBuilds: 2,
      bufferUploads: 2,
    });
    midBand.observed.reset();
    r.paint(paint(midBand.signal, { start: 1_126_000_000, end: 1_626_000_000 }));
    expect(midBand.observed.indexedReads(), '500 Mb resident pan reads').toBe(0);
    expect(perfCounters(), '500 Mb camera-only counters').toEqual({
      samplePasses: 2,
      geometryBuilds: 2,
      bufferUploads: 2,
    });

    r.paint(paint(fineBand.signal, { start: 1_236_000_000, end: 1_386_000_000 }));
    expect(
      fineBand.observed.indexedReads(),
      'new 150 Mb authority is consumed once'
    ).toBeGreaterThan(0);
    expect(r.getDiagnostics(c)?.coverageSampledColumnCount).toBe(fineBand.signal.bins.length);
    expect(r.getDiagnostics(c)?.coverageSampledNonzeroColumnCount).toBe(
      fineBand.signal.bins.length
    );
    expect(r.getDiagnostics(c)?.densityRowsVertexCount).toBe(fineBand.signal.bins.length * 6);
    expect(perfCounters(), 'one build/upload for the new 150 Mb authority').toEqual({
      samplePasses: 3,
      geometryBuilds: 3,
      bufferUploads: 3,
    });
    fineBand.observed.reset();
    for (const range of [
      { start: 1_386_000_000, end: 1_536_000_000 },
      { start: 1_536_000_000, end: 1_686_000_000 },
      { start: 1_236_000_000, end: 1_386_000_000 },
    ]) {
      r.paint(paint(fineBand.signal, range));
      expect(r.getDiagnostics(c)?.densityRowsMeshVisible).toBe(true);
    }
    expect(fineBand.observed.indexedReads(), 'multi-tile 150 Mb resident pan reads').toBe(0);
    expect(perfCounters(), '150 Mb multi-tile pan counters').toEqual({
      samplePasses: 3,
      geometryBuilds: 3,
      bufferUploads: 3,
    });
  });

  it('keeps an ordinary histogram-LOD coverage band GPU-resident during side-pan', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    const viewportWidthPx = 1600;
    const bandStartBp = 1_500_000_000;
    const binSize = 1024;
    const observed = observeIndexedBinReads(
      Array.from({ length: 16_384 }, (_, i) => 20 + ((i * 17) % 23))
    );
    const coverage: NonNullable<PileupTrackData['coverage']> = {
      coverageRevision: 'ordinary-histogram-band:1',
      startBp: bandStartBp,
      bins: observed.bins,
      binSize,
      maxDepth: 42,
      depthPercentiles: { p50: 28, p90: 36, p95: 42, p99: 58, max: 130 },
      provenance: {
        exact: true,
        method: 'resolution-ranked-source-merge',
        source: 'tile-engine',
      },
    };
    const data: PileupTrackData = {
      dataAuthority: 'tile-engine',
      coverage,
      coverageLod: {
        role: 'current-lod',
        level: 10,
        targetLevel: 10,
        binSize,
        authority: 'native-target',
        provenanceExact: true,
        provenanceMethod: coverage.provenance!.method,
        provenanceSource: 'tile-engine',
      },
      records: [],
    };
    const paint = (range: { start: number; end: number }) =>
      paintArgsZoom(
        c,
        data,
        viewportWidthPx / (range.end - range.start),
        range,
        viewportWidthPx,
        276
      );
    const first = { start: bandStartBp + 4_000_000, end: bandStartBp + 9_000_000 };

    r.paint(paint(first));
    const firstDiagnostics = r.getDiagnostics(c)!;
    expect(firstDiagnostics.coverageSampledColumnCount).toBe(coverage.bins.length);
    const before = {
      samplePasses: firstDiagnostics.coverageSamplePassCount,
      geometryBuilds: firstDiagnostics.coverageGeometryBuildCount,
      bufferUploads: firstDiagnostics.coverageBufferUploadCount,
    };
    expect(before).toEqual({ samplePasses: 1, geometryBuilds: 1, bufferUploads: 1 });
    observed.reset();

    for (const delta of [250_000, 500_000, 750_000]) {
      r.paint(paint({ start: first.start + delta, end: first.end + delta }));
      expect(r.getDiagnostics(c)?.densityRowsMeshVisible).toBe(true);
    }

    const after = r.getDiagnostics(c)!;
    expect(observed.indexedReads(), 'camera-only pan does not resample the retained signal').toBe(
      0
    );
    expect({
      samplePasses: after.coverageSamplePassCount,
      geometryBuilds: after.coverageGeometryBuildCount,
      bufferUploads: after.coverageBufferUploadCount,
    }).toEqual(before);
  });

  it('reuses coverage sampling and density geometry for a semantically identical coverage clone at a fixed camera', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    const coverage: NonNullable<PileupTrackData['coverage']> = {
      coverageRevision: 'test-producer:1',
      startBp: 0,
      bins: Array.from({ length: 1024 }, (_, i) => 20 + (i % 17)),
      binSize: 128,
      maxDepth: 36,
      provenance: { exact: true, method: 'native-target', source: 'tile-engine' },
    };
    const coverageLod: NonNullable<PileupTrackData['coverageLod']> = {
      role: 'current-lod',
      level: 7,
      targetLevel: 7,
      binSize: 128,
      authority: 'native-target',
      provenanceExact: true,
      provenanceMethod: 'native-target',
      provenanceSource: 'tile-engine',
    };
    const paint = (nextCoverage: NonNullable<PileupTrackData['coverage']>) =>
      paintArgsZoom(
        c,
        {
          dataAuthority: 'tile-engine',
          coverage: nextCoverage,
          coverageLod,
          records: [],
        },
        0.01,
        { start: 0, end: 100_000 },
        800
      );

    r.paint(paint(coverage));
    const before = r.getDiagnostics(c)!;
    const observedCloneBins = observeIndexedBinReads(coverage.bins);
    const clonedCoverage: NonNullable<PileupTrackData['coverage']> = {
      ...coverage,
      bins: observedCloneBins.bins,
      provenance: coverage.provenance ? { ...coverage.provenance } : undefined,
    };

    r.paint(paint(clonedCoverage));
    const after = r.getDiagnostics(c)!;

    expect({
      indexedBinReads: observedCloneBins.indexedReads(),
      geometryBuilds: after.coverageGeometryBuildCount - before.coverageGeometryBuildCount,
      geometryBufferUpdates: after.coverageBufferUploadCount - before.coverageBufferUploadCount,
    }).toEqual({ indexedBinReads: 0, geometryBuilds: 0, geometryBufferUpdates: 0 });
  });

  it('rebuilds coverage geometry for a changed revision or an unrevisioned clone', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    const baseCoverage: NonNullable<PileupTrackData['coverage']> = {
      coverageRevision: 'test-producer:1',
      startBp: 0,
      bins: Array.from({ length: 1024 }, (_, i) => 20 + (i % 17)),
      binSize: 128,
      maxDepth: 36,
      provenance: { exact: true, method: 'native-target', source: 'tile-engine' },
    };
    const coverageLod: NonNullable<PileupTrackData['coverageLod']> = {
      role: 'current-lod',
      level: 7,
      targetLevel: 7,
      binSize: 128,
      authority: 'native-target',
      provenanceExact: true,
      provenanceMethod: 'native-target',
      provenanceSource: 'tile-engine',
    };
    const paint = (
      coverage: NonNullable<PileupTrackData['coverage']>,
      dataAuthority: PileupTrackData['dataAuthority'] = 'tile-engine'
    ) =>
      paintArgsZoom(
        c,
        { dataAuthority, coverage, coverageLod, records: [] },
        0.01,
        { start: 0, end: 100_000 },
        800
      );

    r.paint(paint(baseCoverage));
    let before = r.getDiagnostics(c)!;

    const changedAuthorityBins = observeIndexedBinReads(baseCoverage.bins);
    r.paint(paint({ ...baseCoverage, bins: changedAuthorityBins.bins }, 'static'));
    let after = r.getDiagnostics(c)!;
    expect(changedAuthorityBins.indexedReads()).toBeGreaterThan(0);
    expect(after.coverageGeometryBuildCount).toBeGreaterThan(before.coverageGeometryBuildCount);
    expect(after.coverageBufferUploadCount).toBeGreaterThan(before.coverageBufferUploadCount);

    before = after;
    const changedBins = observeIndexedBinReads(baseCoverage.bins);
    r.paint(
      paint({
        ...baseCoverage,
        coverageRevision: 'test-producer:2',
        bins: changedBins.bins,
      })
    );
    after = r.getDiagnostics(c)!;
    expect(changedBins.indexedReads()).toBeGreaterThan(0);
    expect(after.coverageGeometryBuildCount).toBeGreaterThan(before.coverageGeometryBuildCount);
    expect(after.coverageBufferUploadCount).toBeGreaterThan(before.coverageBufferUploadCount);

    before = after;
    const unrevisionedBins = observeIndexedBinReads(baseCoverage.bins);
    const { coverageRevision: _ignored, ...unrevisioned } = baseCoverage;
    r.paint(paint({ ...unrevisioned, bins: unrevisionedBins.bins }));
    after = r.getDiagnostics(c)!;
    expect(unrevisionedBins.indexedReads()).toBeGreaterThan(0);
    expect(after.coverageGeometryBuildCount).toBeGreaterThan(before.coverageGeometryBuildCount);
    expect(after.coverageBufferUploadCount).toBeGreaterThan(before.coverageBufferUploadCount);
  });

  it('retains the accepted frame when the same revision becomes rejected then presentable again', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    const coverage: NonNullable<PileupTrackData['coverage']> = {
      coverageRevision: 'test-producer:stable',
      startBp: 0,
      bins: Array.from({ length: 1024 }, (_, i) => 20 + (i % 17)),
      binSize: 128,
      maxDepth: 36,
      provenance: { exact: true, method: 'native-target', source: 'tile-engine' },
    };
    const validLod: NonNullable<PileupTrackData['coverageLod']> = {
      role: 'current-lod',
      level: 7,
      targetLevel: 7,
      binSize: 128,
      authority: 'native-target',
      provenanceExact: true,
      provenanceMethod: 'native-target',
      provenanceSource: 'tile-engine',
    };
    const paint = (
      nextCoverage: NonNullable<PileupTrackData['coverage']>,
      coverageLod: NonNullable<PileupTrackData['coverageLod']>
    ) =>
      paintArgsZoom(
        c,
        {
          dataAuthority: 'tile-engine',
          coverage: nextCoverage,
          coverageLod,
          records: [],
        },
        0.01,
        { start: 0, end: 100_000 },
        800
      );

    r.paint(paint(coverage, validLod));
    expect(r.getDiagnostics(c)?.densityRowsMeshVisible).toBe(true);
    r.paint(paint(coverage, { ...validLod, binSize: 256 }));
    expect(r.getDiagnostics(c)?.densityRowsMeshVisible).toBe(true);
    expect(r.getDiagnostics(c)?.coverageLodProvenanceExact).toBe(true);

    const observedBins = observeIndexedBinReads(coverage.bins);
    r.paint(paint({ ...coverage, bins: observedBins.bins }, validLod));
    expect(observedBins.indexedReads()).toBe(0);
    expect(r.getDiagnostics(c)?.densityRowsMeshVisible).toBe(true);
  });

  it('samples offset coverage signals at their genomic start instead of assuming genome-zero bins', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    const data = {
      coverage: {
        startBp: 1_500_000_000,
        bins: Array.from({ length: 100 }, (_, i) => (i % 11) + 1),
        binSize: 100,
        maxDepth: 11,
      },
    } as unknown as PileupTrackData;

    r.paint(paintArgsZoom(c, data, 0.01, { start: 1_500_000_000, end: 1_500_010_000 }, 800));
    const d = r.getDiagnostics(c)!;

    expect(d.readAggregateSource).toBe('collapsed-pileup');
    expect(d.readDisplayMode).toBe('density');
    expect(d.readDensityColumnCoverage).toBeGreaterThan(0.95);
    expect(d.activeCoverageBinSize).toBe(100);
  });

  it('does NOT sample non-exact parent-fill coverage during side-pan  reset)', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    const bins = Array.from({ length: 2048 }, (_, i) => 80 + (i % 37));
    const data: PileupTrackData = {
      dataAuthority: 'tile-engine',
      coverage: {
        startBp: 1_547_173_888,
        bins,
        binSize: 512,
        maxDepth: Math.max(...bins),
        provenance: { exact: false, method: 'target-grid-parent-fill', source: 'tile-engine' },
      },
      coverageLod: {
        role: 'mixed-resident-fill',
        level: 9,
        targetLevel: 9,
        binSize: 512,
        residentLevel: 11,
        residentBinSize: 2048,
        currentCoveredFraction: 0.8,
      },
      records: [],
    };
    const view = { start: 1_547_360_852, end: 1_548_188_016 };

    r.paint(paintArgsZoom(c, data, 0.003, view, 1338, 276));
    const d = r.getDiagnostics(c)!;

    expect(d.coverageLodRole).toBeNull();
    expect(d.coverageLodProvenanceExact).toBeNull();
    expect(d.activeCoverageBinSize).toBe(0);
    expect(d.aggregateDepthSource).toBe('none');
    expect(d.densityRowsVertexCount).toBe(0);
  });

  it('retains the last exact histogram frame when a mixed non-exact update arrives during motion', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    const view = { start: 1_547_360_852, end: 1_548_188_016 };
    const exactBins = Array.from({ length: 2048 }, (_, i) => 80 + (i % 37));
    const exact: PileupTrackData = {
      dataAuthority: 'tile-engine',
      coverage: {
        startBp: 1_547_173_888,
        bins: exactBins,
        binSize: 512,
        maxDepth: Math.max(...exactBins),
        provenance: { exact: true, method: 'native-target', source: 'tile-engine' },
      },
      coverageLod: {
        role: 'current-lod',
        level: 9,
        targetLevel: 9,
        binSize: 512,
        authority: 'native-target',
        provenanceExact: true,
        provenanceMethod: 'native-target',
        provenanceSource: 'tile-engine',
      },
      records: [],
    };
    const rejectedMixed: PileupTrackData = {
      dataAuthority: 'tile-engine',
      coverage: {
        startBp: 1_547_173_888,
        bins: Array.from({ length: 2048 }, (_, i) => 40 + (i % 19)),
        binSize: 512,
        maxDepth: 58,
        provenance: {
          exact: false,
          method: 'resolution-ranked-source-merge',
          source: 'tile-engine',
        },
      },
      coverageLod: {
        role: 'current-lod',
        level: 9,
        targetLevel: 9,
        binSize: 512,
        authority: 'native-target',
        provenanceExact: false,
        provenanceMethod: 'resolution-ranked-source-merge',
        provenanceSource: 'tile-engine',
      },
      records: [],
    };

    r.paint(paintArgsZoom(c, exact, 0.003, view, 1338, 276));
    const before = r.getDiagnostics(c)!;
    expect(before.densityRowsMeshVisible).toBe(true);
    expect(before.activeCoverageBinSize).toBe(512);
    expect(before.aggregateDepthSource).toBe('tile-engine-coverage');

    r.paint(paintArgsZoom(c, rejectedMixed, 0.003, view, 1338, 276));
    const after = r.getDiagnostics(c)!;

    expect(after.coverageLodProvenanceExact).toBe(true);
    expect(after.activeCoverageBinSize).toBe(512);
    expect(after.aggregateDepthSource).toBe('tile-engine-coverage');
    expect(after.densityRowsVertexCount).toBeGreaterThan(0);
    expect(after.densityRowsMeshVisible).toBe(true);
  });

  it('accepts exact target coverage derived from a finer resident surface', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'tile-engine',
      coverage: {
        startBp: 1_547_173_888,
        bins: Array.from({ length: 2048 }, (_, i) => 40 + (i % 23)),
        binSize: 512,
        maxDepth: 62,
        provenance: {
          exact: true,
          method: 'target-grid-derived-from-finer',
          source: 'tile-engine',
        },
      },
      coverageLod: {
        role: 'current-lod',
        level: 9,
        targetLevel: 9,
        binSize: 512,
      },
      records: [],
    };

    r.paint(paintArgsZoom(c, data, 0.003, { start: 1_547_360_852, end: 1_548_188_016 }, 1338, 276));
    const d = r.getDiagnostics(c)!;

    expect(d.coverageLodRole).toBe('current-lod');
    expect(d.coverageLodResidentLevel).toBeNull();
    expect(d.coverageLodResidentBinSize).toBeNull();
    expect(d.readDisplayMode).toBe('density');
    expect(d.readDensityColumnCoverage).toBeGreaterThan(0.95);
    expect(d.densityRowsVertexCount).toBeGreaterThan(0);
  });

  it('renders coverage-backed collapsed-pileup as the same continuous area mesh', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
    const c = r.mount(mountArgs);
    const viewportWidthPx = 120;
    const data: PileupTrackData = {
      dataAuthority: 'static',
      coverage: {
        bins: Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? 4 : 80)),
        binSize: 10,
        maxDepth: 80,
      },
    };

    r.paint(paintArgsZoom(c, data, 0.001, { start: 0, end: 800 }, viewportWidthPx, 80));
    const d = r.getDiagnostics(c)!;

    expect(d.readAggregateSource).toBe('collapsed-pileup');
    expect(d.readDisplayMode).toBe('density');
    expect(d.densityRowsVertexCount).toBe(viewportWidthPx * 2 * 6);
    expect(d.readDensityColumnCoverage).toBe(1);
    const state = (
      r as unknown as {
        containerState: WeakMap<
          object,
          { densityRows: { buffers: Array<{ data: Float32Array }> } | null }
        >;
      }
    ).containerState.get(c);
    const halfH = state?.densityRows?.buffers[5]?.data;
    const ySide = state?.densityRows?.buffers[7]?.data;
    expect(halfH).toBeInstanceOf(Float32Array);
    expect(ySide).toBeInstanceOf(Float32Array);
    expect(Array.from(halfH!.slice(0, d.densityRowsVertexCount)).every((v) => v === 0)).toBe(true);
    expect(Array.from(ySide!.slice(0, d.densityRowsVertexCount)).every((v) => v === 0)).toBe(true);
  });

  it('scales coverage-backed collapsed-pileup diagnostics without clipping typical depth variation', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 3,
      maxRows: 80,
    });
    const c = r.mount(mountArgs);
    const depths = [25, 30, 33, 38, 48, 61, 34, 29, 44, 52];
    const data: PileupTrackData = {
      dataAuthority: 'static',
      coverage: {
        bins: Array.from({ length: 40 }, (_, i) => depths[i % depths.length]),
        binSize: 100,
        maxDepth: 61,
      },
    };

    r.paint(paintArgsZoom(c, data, 0.01, { start: 0, end: 4000 }, 800, 160));
    const d = r.getDiagnostics(c)!;

    expect(d.readAggregateSource).toBe('collapsed-pileup');
    expect(d.readDisplayMode).toBe('density');
    expect(d.readDensityColumnCoverage).toBeGreaterThan(0.95);
    expect(d.readDensityMeanFill).toBeGreaterThan(0.5);
    expect(d.readDensityMeanFill).toBeLessThan(0.7);
    expect(d.readDensityMaxFill).toBeGreaterThan(0.65);
    expect(d.readDensityMaxFill).toBeLessThan(0.7);
    expect(d.readDensityFillStdDev).toBeGreaterThan(0.04);
    expect(d.readDensityClippedColumnFraction).toBe(0);
  });

  it('does not flatten real-like level-10 WGS coverage variation into a drawn slab', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 3,
      maxRows: 96,
    });
    const c = r.mount(mountArgs);
    const depths = Array.from({ length: 1024 }, (_, i) => {
      const wave = 100 + 8 * Math.sin(i * 0.19) + 6 * Math.sin(i * 0.047);
      const jitter = ((i * 48271) % 23) - 11;
      const excursion = i % 251 === 0 ? 48 : i % 173 === 0 ? -24 : 0;
      return Math.max(1, Math.round(wave + jitter + excursion));
    });
    const data: PileupTrackData = {
      dataAuthority: 'static',
      coverage: {
        startBp: 0,
        bins: depths,
        binSize: 1024,
        maxDepth: Math.max(...depths),
      },
    };

    r.paint(paintArgsZoom(c, data, 0.001, { start: 0, end: 827_000 }, 1338, 276));
    const d = r.getDiagnostics(c)!;
    const stats = drawnDensityHeightStats(
      r,
      c,
      d.densityRowsVertexCount,
      d.readRowsBottomPx - d.readRowsTopPx
    );

    expect(d.readAggregateSource).toBe('collapsed-pileup');
    expect(d.readDensityColumnCoverage).toBeGreaterThan(0.95);
    expect(d.readDensityFillStdDev).toBeGreaterThanOrEqual(0.03);
    expect(stats.stdDev).toBeGreaterThanOrEqual(0.03);
    expect(stats.edgeCount).toBeGreaterThanOrEqual(100);
    expect(stats.longestFlatRunColumns).toBeLessThanOrEqual(Math.ceil((1338 * 2) / 5));
  });

  it('does not render broad tile-engine WGS coverage as a saturated plateau', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 3,
      maxRows: 96,
    });
    const c = r.mount(mountArgs);
    const depths = Array.from({ length: 2048 }, (_, i) => {
      const baseline = 96 + 3 * Math.sin(i * 0.31) + 2 * Math.sin(i * 0.073);
      const deterministicNoise = ((i * 1103515245 + 12345) >>> 8) % 5;
      const spike = i % 241 === 0 ? 55 : i % 157 === 0 ? 31 : 0;
      return Math.max(1, Math.round(baseline + deterministicNoise - 2 + spike));
    });
    const data: PileupTrackData = {
      dataAuthority: 'tile-engine',
      coverage: {
        startBp: 0,
        bins: depths,
        binSize: 32_768,
        maxDepth: Math.max(...depths),
        provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
      },
      coverageLod: {
        role: 'current-lod',
        level: 15,
        targetLevel: 15,
        binSize: 32_768,
      },
    };

    r.paint(paintArgsZoom(c, data, 1 / 23_450, { start: 0, end: 62_756_174 }, 1338, 276));
    const d = r.getDiagnostics(c)!;
    const stats = drawnDensityHeightStats(
      r,
      c,
      d.densityRowsVertexCount,
      d.readRowsBottomPx - d.readRowsTopPx
    );

    expect(d.readAggregateSource).toBe('collapsed-pileup');
    expect(d.readDensityColumnCoverage).toBeGreaterThan(0.95);
    expect(d.readDensityFillStdDev).toBeGreaterThanOrEqual(0.05);
    expect(stats.stdDev).toBeGreaterThanOrEqual(0.05);
    expect(stats.edgeCount).toBeGreaterThanOrEqual(180);
    expect(stats.longestFlatRunColumns).toBeLessThanOrEqual(120);
  });

  it('uses robust tile-engine coverage contrast when rare outliers would flatten WGS baseline variation', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 3,
      maxRows: 96,
    });
    const c = r.mount(mountArgs);
    const depths = Array.from({ length: 2048 }, (_, i) => {
      const baseline = 132 + 7 * Math.sin(i * 0.19) + 5 * Math.sin(i * 0.047);
      const deterministicNoise = ((i * 48271) % 11) - 5;
      const moderateSpike = i % 73 === 0 ? 185 : 0;
      const extremeOutlier = i === 1024 ? 12_000 : 0;
      return Math.max(
        1,
        Math.round(baseline + deterministicNoise + moderateSpike + extremeOutlier)
      );
    });
    const data: PileupTrackData = {
      dataAuthority: 'tile-engine',
      coverage: {
        startBp: 0,
        bins: depths,
        binSize: 32_768,
        maxDepth: Math.max(...depths),
        provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
      },
      coverageLod: {
        role: 'current-lod',
        level: 15,
        targetLevel: 15,
        binSize: 32_768,
      },
    };

    r.paint(paintArgsZoom(c, data, 1 / 23_450, { start: 0, end: 62_756_174 }, 1338, 276));
    const d = r.getDiagnostics(c)!;
    const stats = drawnDensityHeightStats(
      r,
      c,
      d.densityRowsVertexCount,
      d.readRowsBottomPx - d.readRowsTopPx
    );

    expect(d.readAggregateSource).toBe('collapsed-pileup');
    expect(d.readDensityColumnCoverage).toBeGreaterThan(0.95);
    expect(d.readDensitySourceDepthCv).toBeGreaterThan(1);
    expect(d.readDensitySourceDepthP50).toBeGreaterThan(120);
    expect(d.readDensitySourceDepthP90).toBeLessThan(160);
    expect(d.readDensitySourceDepthP99).toBeGreaterThan(180);
    expect(d.readDensitySourceDepthEdgeCount).toBeGreaterThan(1_000);
    expect(d.readDensityFillStdDev).toBeGreaterThanOrEqual(0.08);
    expect(stats.stdDev).toBeGreaterThanOrEqual(0.08);
    expect(stats.edgeCount).toBeGreaterThanOrEqual(100);
    expect(stats.longestFlatRunColumns).toBeLessThanOrEqual(Math.ceil((1338 * 2) / 5));
  });

  it('keeps tile-engine coverage height stable across adjacent LOD distributions', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 3,
      maxRows: 96,
    });
    const c = r.mount(mountArgs);
    const broadDepths = Array.from({ length: 2048 }, (_, i) => {
      const baseline = 128 + 7 * Math.sin(i * 0.19) + 5 * Math.sin(i * 0.047);
      const deterministicNoise = ((i * 48271) % 11) - 5;
      const spike = i % 19 === 0 ? 110 : i % 67 === 0 ? 45 : 0;
      return Math.max(1, Math.round(baseline + deterministicNoise + spike));
    });
    const refinedDepths = Array.from({ length: 2048 }, (_, i) => {
      const baseline = 126 + 6 * Math.sin(i * 0.19) + 4 * Math.sin(i * 0.047);
      const deterministicNoise = ((i * 48271) % 11) - 5;
      const spike = i % 211 === 0 ? 90 : i % 67 === 0 ? 32 : 0;
      return Math.max(1, Math.round(baseline + deterministicNoise + spike));
    });
    const render = (bins: number[], level: number, binSize: number, span: number): Float32Array => {
      r.paint(
        paintArgsZoom(
          c,
          {
            dataAuthority: 'tile-engine',
            coverage: {
              startBp: 0,
              bins,
              binSize,
              maxDepth: Math.max(...bins),
              provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
            },
            coverageLod: {
              role: 'current-lod',
              level,
              targetLevel: level,
              binSize,
            },
          },
          1338 / span,
          { start: 0, end: span },
          1338,
          276
        )
      );
      const d = r.getDiagnostics(c)!;
      expect(d.readAggregateSource).toBe('collapsed-pileup');
      expect(d.readDensityColumnCoverage).toBeGreaterThan(0.95);
      return drawnDensityProfile(
        r,
        c,
        d.densityRowsVertexCount,
        d.readRowsBottomPx - d.readRowsTopPx
      );
    };

    const broad = render(broadDepths, 14, 16_384, 26_402_399);
    const refined = render(refinedDepths, 13, 8_192, 17_125_248);
    const broadSummary = fillSummary(broad);
    const refinedSummary = fillSummary(refined);

    expect(Math.abs(refinedSummary.p50 - broadSummary.p50)).toBeLessThanOrEqual(0.035);
    expect(Math.abs(refinedSummary.p90 - broadSummary.p90)).toBeLessThanOrEqual(0.06);
    expect(Math.abs(refinedSummary.mean - broadSummary.mean)).toBeLessThanOrEqual(0.05);
  });

  it('uses one blue aggregate layer during the simple read fade', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 4,
    });
    const c = r.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      coverage: { bins: Array.from({ length: 20 }, () => 60), binSize: 100, maxDepth: 60 },
      records: [read(0, 400, 'exact-a'), read(20, 420, 'exact-b')],
      readSource: { truncated: false, windowStartBp: 0, windowEndBp: 2000 },
    };
    const view = { start: 100, end: 350 };

    r.paint(paintArgsZoom(c, data, 1.6 / 150, view, 200, 90));
    const stacked = r.getDiagnostics(c)!;
    expect(stacked.readAggregateSource).toBe('collapsed-pileup');
    expect(stacked.readDisplayMode).toBe('blend');
    expect(stacked.rowsMeshVisible).toBe(true);
    expect(stacked.morphRowsMeshVisible).toBe(false);
    expect(stacked.densityRowsVertexCount).toBeGreaterThan(0);
    expect(stacked.densityRowsMeshVisible).toBe(true);
    expect(stacked.readDensityAlpha).toBeGreaterThan(0.6);
    expect(stacked.renderedReadDensityAlpha).toBe(stacked.readDensityAlpha);

    r.paint(paintArgsZoom(c, data, 2.1 / 150, view, 200, 90));
    const mid = r.getDiagnostics(c)!;
    expect(mid.readAggregateSource).toBe('collapsed-pileup');
    expect(mid.morphRowsVertexCount).toBe(0);
    expect(mid.densityRowsVertexCount).toBeGreaterThan(0);
    expect(mid.readDensityColumnCoverage).toBeGreaterThan(0.95);
    expect(mid.renderedReadRowsAlpha + mid.renderedReadDensityAlpha).toBeCloseTo(1, 2);
  });

  it('uses the collapsed exact pileup field, not coverage, for aggregate endpoint probes', async () => {
    const g = globalThis as {
      __dna119PileupProbe?: { hideExactRows?: boolean };
    };
    try {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        rowHeightPx: 10,
        maxRows: 4,
      });
      const c = r.mount(mountArgs);
      g.__dna119PileupProbe = { hideExactRows: true };
      r.paint(
        paintArgsZoom(
          c,
          {
            records: [read(0, 100, 'a'), read(0, 100, 'b'), read(400, 1000, 'c')],
            readSource: { truncated: false, windowStartBp: 0, windowEndBp: 1000 },
          },
          0.3 / 150,
          { start: 0, end: 1000 },
          100,
          80
        )
      );

      const d = r.getDiagnostics(c)!;
      expect(d.readAggregateSource).toBe('collapsed-pileup');
      expect(d.densityRowsVertexCount).toBeGreaterThan(0);
      expect(d.densityRowsMeshVisible).toBe(true);
      expect(d.readDensityMorph).toBe(1);
      expect(d.collapsedPileupFieldBinCount).toBeGreaterThan(0);
      expect(d.collapsedPileupMaxVisibleRows).toBe(2);
      expect(d.readDensityMaxFill).toBeCloseTo(0.45, 2);
    } finally {
      g.__dna119PileupProbe = undefined;
    }
  });

  it('uses exact-collapsed aggregate as the no-coverage broad fallback', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 4,
    });
    const c = r.mount(mountArgs);
    r.paint(
      paintArgsZoom(
        c,
        {
          records: [read(0, 100, 'a'), read(0, 100, 'b'), read(400, 1000, 'c')],
          readSource: { truncated: false, windowStartBp: 0, windowEndBp: 1000 },
        },
        0.3 / 150,
        { start: 0, end: 1000 },
        100,
        80
      )
    );

    const d = r.getDiagnostics(c)!;
    expect(d.readAggregateSource).toBe('collapsed-pileup');
    expect(d.readDisplayMode).toBe('density');
    expect(d.morphRowsVertexCount).toBe(0);
    expect(d.densityRowsVertexCount).toBeGreaterThan(0);
    expect(d.renderedReadMorphRowsAlpha).toBe(0);
    expect(d.renderedReadDensityAlpha).toBeGreaterThan(0.97);
    expect(d.readDensityMorph).toBe(1);
    expect(d.collapsedPileupMaxVisibleRows).toBeGreaterThan(0);
  });

  it('does not use exact-collapsed aggregate as a tile-engine no-coverage fallback', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 4,
    });
    const c = r.mount(mountArgs);
    r.paint(
      paintArgsZoom(
        c,
        {
          dataAuthority: 'tile-engine',
          records: [read(0, 100, 'a'), read(0, 100, 'b'), read(400, 1000, 'c')],
          readSource: { truncated: false, windowStartBp: 0, windowEndBp: 1000 },
        },
        0.3 / 150,
        { start: 0, end: 1000 },
        100,
        80
      )
    );

    const d = r.getDiagnostics(c)!;
    expect(d.collapsedPileupFieldBinCount).toBe(0);
    expect(d.readAggregateSource).toBe('none');
    expect(d.readDisplayMode).toBe('empty');
    expect(d.densityRowsVertexCount).toBe(0);
    expect(d.activeCoverageBinSize).toBe(0);
    expect(d.recordsCommitTiming?.metadataOnly).toBe(true);
    expect(d.recordsCommitTiming?.exactDerivedBuilt).toBe(false);
  });

  it('clears prior tile-engine aggregate density when the next feed has no coverage', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 4,
    });
    const c = r.mount(mountArgs);
    const view = { start: 0, end: 1000 };

    r.paint(
      paintArgsZoom(
        c,
        {
          dataAuthority: 'tile-engine',
          coverage: {
            bins: [4, 8, 4, 2],
            binSize: 250,
            maxDepth: 8,
            provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
          },
          records: [],
        },
        0.3 / 150,
        view,
        100,
        80
      )
    );
    const withCoverage = r.getDiagnostics(c)!;
    expect(withCoverage.aggregateDepthSource).toBe('tile-engine-coverage');
    expect(withCoverage.readAggregateSource).toBe('collapsed-pileup');
    expect(withCoverage.densityRowsMeshVisible).toBe(true);
    expect(withCoverage.activeCoverageBinSize).toBe(250);

    r.paint(
      paintArgsZoom(
        c,
        {
          dataAuthority: 'tile-engine',
          records: [],
        },
        0.3 / 150,
        view,
        100,
        80
      )
    );
    const withoutCoverage = r.getDiagnostics(c)!;
    expect(withoutCoverage.aggregateDepthSource).toBe('none');
    expect(withoutCoverage.readAggregateSource).toBe('none');
    expect(withoutCoverage.readDisplayMode).toBe('empty');
    expect(withoutCoverage.densityRowsVertexCount).toBe(0);
    expect(withoutCoverage.densityRowsMeshVisible).toBe(false);
    expect(withoutCoverage.activeCoverageBinSize).toBe(0);
  });

  it('rejects tile-engine coverage without presentable tile-engine provenance', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 4,
    });
    const c = r.mount(mountArgs);
    r.paint(
      paintArgsZoom(
        c,
        {
          dataAuthority: 'tile-engine',
          coverage: { bins: [1], binSize: 500, maxDepth: 1 },
          records: [],
        },
        0.3 / 150,
        { start: 0, end: 1000 },
        100,
        80
      )
    );

    const d = r.getDiagnostics(c)!;
    expect(d.aggregateDepthSource).toBe('none');
    expect(d.readAggregateSource).toBe('none');
    expect(d.densityRowsVertexCount).toBe(0);
    expect(d.activeCoverageBinSize).toBe(0);
  });

  it.each([
    ['missing LOD metadata', { coverageLod: undefined }],
    ['wrong role', { coverageLod: { role: 'current-lod' as const } }],
    ['LOD bin does not match coverage bin', { coverageLod: { binSize: 1024 } }],
    [
      'coverage bin is not target grid bin',
      { coverage: { binSize: 1024 }, coverageLod: { binSize: 1024 } },
    ],
    [
      'resident level matches target level',
      { coverageLod: { residentLevel: 9, residentBinSize: 512 } },
    ],
    ['resident bin does not match resident level', { coverageLod: { residentBinSize: 4096 } }],
    ['coverage fraction is missing', { coverageLod: { currentCoveredFraction: undefined } }],
    ['coverage fraction is out of range', { coverageLod: { currentCoveredFraction: 1.2 } }],
  ])('rejects target-grid parent fill with incoherent metadata: %s', async (_name, patch) => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 4,
    });
    const c = r.mount(mountArgs);
    const baseCoverage: NonNullable<PileupTrackData['coverage']> = {
      bins: [3, 6, 9, 12],
      binSize: 512,
      maxDepth: 12,
      provenance: { exact: false, method: 'target-grid-parent-fill', source: 'tile-engine' },
    };
    const baseCoverageLod: NonNullable<PileupTrackData['coverageLod']> = {
      role: 'mixed-resident-fill',
      level: 9,
      targetLevel: 9,
      binSize: 512,
      residentLevel: 11,
      residentBinSize: 2048,
      currentCoveredFraction: 0.25,
    };
    const coveragePatch = 'coverage' in patch ? patch.coverage : {};
    const coverageLodPatch = patch.coverageLod;
    const data: PileupTrackData = {
      dataAuthority: 'tile-engine',
      coverage: { ...baseCoverage, ...coveragePatch },
      ...(coverageLodPatch === undefined
        ? {}
        : { coverageLod: { ...baseCoverageLod, ...coverageLodPatch } }),
      records: [],
    };

    r.paint(paintArgsZoom(c, data, 0.3 / 150, { start: 0, end: 1000 }, 100, 80));

    const d = r.getDiagnostics(c)!;
    expect(d.aggregateDepthSource).toBe('none');
    expect(d.readAggregateSource).toBe('none');
    expect(d.densityRowsVertexCount).toBe(0);
    expect(d.activeCoverageBinSize).toBe(0);
  });

  it('rejects exact tile-engine coverage with incoherent explicit LOD metadata', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 4,
    });
    const c = r.mount(mountArgs);
    r.paint(
      paintArgsZoom(
        c,
        {
          dataAuthority: 'tile-engine',
          coverage: {
            bins: [1, 2, 3, 4],
            binSize: 512,
            maxDepth: 4,
            provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
          },
          coverageLod: {
            role: 'current-lod',
            level: 10,
            targetLevel: 10,
            binSize: 512,
          },
          records: [],
        },
        0.3 / 150,
        { start: 0, end: 1000 },
        100,
        80
      )
    );

    const d = r.getDiagnostics(c)!;
    expect(d.aggregateDepthSource).toBe('none');
    expect(d.readAggregateSource).toBe('none');
    expect(d.densityRowsVertexCount).toBe(0);
    expect(d.activeCoverageBinSize).toBe(0);
  });

  it('does not let exact reads override tile-engine coverage when coverage exists', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 12,
    });
    const c = r.mount(mountArgs);
    const records = Array.from({ length: 8 }, (_, i) => read(100, 900, `deep-${i}`));

    r.paint(
      paintArgsZoom(
        c,
        {
          dataAuthority: 'tile-engine',
          coverage: {
            bins: [1, 1],
            binSize: 500,
            maxDepth: 100,
            provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
          },
          records,
          readSource: { truncated: false, windowStartBp: 0, windowEndBp: 1000 },
        },
        0.3 / 150,
        { start: 0, end: 1000 },
        100,
        160
      )
    );

    const d = r.getDiagnostics(c)!;
    expect(d.collapsedPileupFieldBinCount).toBe(0);
    expect(d.rowsUsed).toBe(0);
    expect(d.readAggregateSource).toBe('collapsed-pileup');
    expect(d.aggregateDepthSource).toBe('tile-engine-coverage');
    expect(d.activeCoverageBinSize).toBe(500);
    expect(d.readDensityMaxFill).toBeLessThan(0.2);
    expect(d.recordsCommitTiming?.metadataOnly).toBe(true);
    expect(d.recordsCommitTiming?.exactDerivedBuilt).toBe(false);
  });

  it('skips exact-read decomposition for tile-engine density-only frames', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 12,
    });
    const c = r.mount(mountArgs);
    const records = Array.from({ length: 24 }, (_, i) =>
      read(i * 40, i * 40 + 150, `streamed-${i}`)
    );

    r.paint(
      paintArgsZoom(
        c,
        {
          dataAuthority: 'tile-engine',
          coverage: {
            bins: Array.from({ length: 8 }, (_, i) => 12 + i),
            binSize: 500,
            maxDepth: 19,
            provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
          },
          records,
          readSource: { truncated: false, windowStartBp: 0, windowEndBp: 1200 },
        },
        0.3 / 150,
        { start: 0, end: 1200 },
        160,
        160
      )
    );

    const d = r.getDiagnostics(c)!;
    expect(d.recordCount).toBe(records.length);
    expect(d.readDisplayMode).toBe('density');
    expect(d.aggregateDepthSource).toBe('tile-engine-coverage');
    expect(d.readAggregateSource).toBe('collapsed-pileup');
    expect(d.rowsUsed).toBe(0);
    expect(d.hiddenReadCount).toBe(0);
    expect(d.rowsVertexCount).toBe(0);
    expect(d.collapsedPileupFieldBinCount).toBe(0);
    expect(d.loadedStartBp).toBe(0);
    expect(d.loadedEndBp).toBe(1200);
    expect(d.recordExtentCoversViewport).toBe(true);
    expect(d.recordsCommitTiming).not.toBeNull();
    expect(d.recordsCommitTiming!.assignMs).toBe(0);
    expect(d.recordsCommitTiming!.rowHeightFieldMs).toBe(0);
    expect(d.recordsCommitTiming!.collapsedFieldMs).toBe(0);
  });

  it('does not morph tile-engine histogram geometry toward exact read rows at read zoom', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 12,
    });
    const c = r.mount(mountArgs);
    const records = Array.from({ length: 8 }, (_, i) => read(100, 900, `deep-${i}`));

    r.paint(
      paintArgsZoom(
        c,
        {
          dataAuthority: 'tile-engine',
          coverage: {
            bins: [1, 1],
            binSize: 500,
            maxDepth: 100,
            provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
          },
          records,
          readSource: { truncated: false, windowStartBp: 0, windowEndBp: 1000 },
        },
        4.0 / 150,
        { start: 0, end: 1000 },
        100,
        160
      )
    );

    const d = r.getDiagnostics(c)!;
    expect(d.aggregateDepthSource).toBe('tile-engine-coverage');
    expect(d.activeCoverageBinSize).toBe(500);
    expect(d.readDensityMorph).toBe(0);
    expect(d.readDensityMaxFill).toBeLessThan(0.2);
  });

  it('keeps the collapsed exact endpoint registered to the requested read window, not read extents', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 4,
    });
    const c = r.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      records: [read(200, 260, 'middle-a'), read(420, 480, 'middle-b')],
      readSource: { truncated: false, windowStartBp: 0, windowEndBp: 1000 },
      coverage: { bins: Array.from({ length: 10 }, () => 80), binSize: 100, maxDepth: 80 },
    };

    r.paint(paintArgsZoom(c, data, 0.3 / 150, { start: 0, end: 1000 }, 100, 80));
    const fullWindow = r.getDiagnostics(c)!;
    expect(fullWindow.readAggregateSource).toBe('collapsed-pileup');
    expect(fullWindow.readDisplayMode).toBe('density');
    expect(fullWindow.densityRowsVertexCount).toBeGreaterThan(0);
    expect(fullWindow.renderedReadDensityAlpha).toBeGreaterThan(0.95);

    r.paint(paintArgsZoom(c, data, 0.3 / 150, { start: 0, end: 120 }, 100, 80));
    const zeroDepthEdge = r.getDiagnostics(c)!;
    expect(zeroDepthEdge.readAggregateSource).toBe('collapsed-pileup');
    expect(zeroDepthEdge.readDensityColumnCoverage).toBeGreaterThan(0.95);
    expect(zeroDepthEdge.renderedReadDensityAlpha).toBeGreaterThan(0.95);
  });

  it('renders the collapsed exact endpoint as a continuous area mesh, not independent bars', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 4,
    });
    const c = r.mount(mountArgs);
    r.paint(
      paintArgsZoom(
        c,
        {
          records: [read(0, 100, 'a'), read(0, 100, 'b'), read(400, 1000, 'c')],
          readSource: { truncated: false, windowStartBp: 0, windowEndBp: 1000 },
        },
        0.3 / 150,
        { start: 0, end: 1000 },
        100,
        80
      )
    );

    const d = r.getDiagnostics(c)!;
    expect(d.readAggregateSource).toBe('collapsed-pileup');
    expect(d.densityRowsVertexCount).toBeGreaterThan(0);
    const state = (
      r as unknown as {
        containerState: WeakMap<
          object,
          { densityRows: { buffers: Array<{ data: Float32Array }> } | null }
        >;
      }
    ).containerState.get(c);
    const offsetY = state?.densityRows?.buffers[4]?.data;
    const halfH = state?.densityRows?.buffers[5]?.data;
    const ySide = state?.densityRows?.buffers[7]?.data;
    expect(offsetY).toBeInstanceOf(Float32Array);
    expect(halfH).toBeInstanceOf(Float32Array);
    expect(ySide).toBeInstanceOf(Float32Array);

    const liveVertexCount = d.densityRowsVertexCount;
    expect(Array.from(halfH!.slice(0, liveVertexCount)).every((v) => v === 0)).toBe(true);
    expect(Array.from(ySide!.slice(0, liveVertexCount)).every((v) => v === 0)).toBe(true);
    expect(Math.max(...Array.from(offsetY!.slice(0, liveVertexCount)))).toBeGreaterThan(0);
    for (let column = 0; column < liveVertexCount / 6; column += 1) {
      const base = column * 6;
      expect(offsetY![base]).toBe(0);
      expect(offsetY![base + 3]).toBe(0);
      expect(offsetY![base + 5]).toBe(0);
    }
    expect(
      Array.from({ length: liveVertexCount / 6 }, (_, column) => offsetY![column * 6 + 1]).some(
        (silhouetteY) => silhouetteY > 0
      )
    ).toBe(true);
  });

  it('uses simple complementary alpha for exact rows and aggregate density', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 4,
    });
    const c = r.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      records: [read(0, 100, 'a'), read(0, 100, 'b'), read(400, 1000, 'c')],
      readSource: { truncated: false, windowStartBp: 0, windowEndBp: 1000 },
    };

    let partial: NonNullable<ReturnType<typeof r.getDiagnostics>> | null = null;
    for (const zoom of [1.5, 1.35, 1.2, 1.05, 0.9, 0.75]) {
      r.paint(paintArgsZoom(c, data, zoom / 150, { start: 0, end: 1000 }, 100, 80));
      const d = r.getDiagnostics(c)!;
      if (
        d.readAggregateSource === 'collapsed-pileup' &&
        d.renderedReadRowsAlpha > 0.05 &&
        d.renderedReadDensityAlpha > 0.05
      ) {
        partial = d;
        break;
      }
    }

    expect(partial).not.toBeNull();
    expect(partial!.readDisplayMode).toBe('blend');
    expect(partial!.renderedReadDensityAlpha).toBeCloseTo(partial!.readDensityAlpha, 6);
    expect(partial!.renderedReadRowsAlpha + partial!.renderedReadDensityAlpha).toBeCloseTo(1, 2);
  });

  it('retires the exact overflow strip with exact rows at density-only zoom', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 2,
      overflowBandHeightPx: 20,
    });
    const c = r.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      records: [read(0, 1000, 'row-0'), read(0, 100, 'row-1'), read(0, 1000, 'hidden')],
      readSource: { truncated: false, windowStartBp: 0, windowEndBp: 1000 },
    };

    const layoutHeightPx = 40 + PENDING_INTERVAL_BAND_HEIGHT_PX;
    r.paint(paintArgsZoom(c, data, 4.0 / 150, { start: 0, end: 1000 }, 100, layoutHeightPx));
    const source = r.getDiagnostics(c)!;
    expect(source.hiddenReadCount).toBe(1);
    expect(source.overflowMaxHiddenReads).toBe(1);
    expect(source.overflowMorph).toBeLessThan(0.03);
    expect(source.overflowBaseMinPx).toBe(20);
    expect(source.overflowBaseMaxPx).toBe(20);

    r.paint(paintArgsZoom(c, data, 0.3 / 150, { start: 0, end: 1000 }, 100, layoutHeightPx));
    const collapsed = r.getDiagnostics(c)!;
    expect(collapsed.overflowMorph).toBe(0);
    expect(collapsed.rowsMeshVisible).toBe(false);
    expect(collapsed.overflowRowsMeshVisible).toBe(false);
    expect(collapsed.renderedOverflowRowsAlpha).toBe(0);
    expect(collapsed.overflowMaxHiddenReads).toBe(0);
    expect(collapsed.overflowColumnCoverage).toBe(0);
    expect(collapsed.overflowMeanFill).toBe(0);
  });

  it('keeps coverage density visible at read zoom until exact rows are drawable', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
    const c = r.mount(mountArgs);
    const coverage = {
      bins: Array.from({ length: 20 }, () => 12),
      binSize: 100,
      maxDepth: 12,
      provenance: { exact: true, method: 'test-read-density-handoff', source: 'tile-engine' },
    } as const;
    const densityOnlyData: PileupTrackData = {
      dataAuthority: 'tile-engine',
      coverage,
      records: [],
    };
    const detail: PileupTrackData = {
      dataAuthority: 'tile-engine',
      coverage,
      records: [read(0, 400, 'exact-a'), read(20, 420, 'exact-b')],
      readSource: { truncated: false, windowStartBp: 0, windowEndBp: 2000 },
    };

    r.paint(paintArgsZoom(c, densityOnlyData, 4.0 / 150, { start: 100, end: 350 }, 800));
    const beforeRows = r.getDiagnostics(c)!;
    expect(beforeRows.renderedReadRowsAlpha).toBe(0);
    expect(beforeRows.readAggregateSource).toBe('collapsed-pileup');
    expect(beforeRows.densityRowsVertexCount).toBeGreaterThan(0);
    expect(beforeRows.readDensityAlpha).toBe(1);
    expect(beforeRows.renderedReadDensityAlpha).toBe(1);
    expect(beforeRows.densityRowsMeshVisible).toBe(true);
    expect(beforeRows.readDisplayMode).toBe('density');

    r.paint(paintArgsZoom(c, detail, 4.0 / 150, { start: 100, end: 350 }, 800));
    const firstRowsFrame = r.getDiagnostics(c)!;
    expect(firstRowsFrame.readRowsAlpha).toBe(1);
    expect(firstRowsFrame.readDensityAlpha).toBe(0);
    expect(firstRowsFrame.renderedReadRowsAlpha).toBe(firstRowsFrame.readRowsAlpha);
    expect(firstRowsFrame.renderedReadDensityAlpha).toBe(firstRowsFrame.readDensityAlpha);
  });

  it('uses exact read rows at detailed zoom even when the loaded extent starts at chromosome 0', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
    const c = r.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      coverage: { bins: [12], binSize: 200, maxDepth: 12 },
      records: [read(0, 150, 'origin-a'), read(20, 170, 'origin-b')],
    };

    r.paint(paintArgsZoom(c, data, 0.02, { start: 0, end: 170 }, 800));
    const d = r.getDiagnostics(c)!;
    expect(d.loadedStartBp).toBe(0);
    expect(['reads', 'blend']).toContain(d.readDisplayMode);
    expect(d.rowsVertexCount).toBeGreaterThan(0);
  });

  it('fades the aggregate density out when exact reads are active', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
    const c = r.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      coverage: { bins: Array.from({ length: 20 }, () => 12), binSize: 100, maxDepth: 12 },
      records: [read(0, 400, 'exact-a'), read(20, 420, 'exact-b')],
      readSource: { truncated: false, windowStartBp: 0, windowEndBp: 2000 },
    };

    r.paint(paintArgsZoom(c, data, 4.0 / 150, { start: 100, end: 350 }, 800));
    const d = r.getDiagnostics(c)!;
    expect(d.readDisplayMode).toBe('reads');
    expect(d.readAggregateSource).toBe('collapsed-pileup');
    expect(d.readRowsAlpha).toBeGreaterThan(0.95);
    expect(d.readDensityAlpha).toBeLessThan(0.03);
  });

  it('does not rebuild invisible coverage while exact read rows move', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
    const c = r.mount(mountArgs);
    const records = [
      read(0, 400, 'exact-a', {
        mismatches: [{ pos: 120, kind: 'sub', refBase: 'A', readBase: 'G' }],
      }),
      read(20, 420, 'exact-b'),
    ];
    const exactData = (revision: number): PileupTrackData => ({
      dataAuthority: 'tile-engine',
      coverage: {
        coverageRevision: `exact-camera:${revision}`,
        startBp: 0,
        bins: Array.from({ length: 20 }, () => 12),
        binSize: 128,
        maxDepth: 12,
        provenance: { exact: true, method: 'native-target', source: 'tile-engine' },
      },
      coverageLod: {
        role: 'current-lod',
        level: 7,
        targetLevel: 7,
        binSize: 128,
        authority: 'native-target',
        provenanceExact: true,
        provenanceMethod: 'native-target',
        provenanceSource: 'tile-engine',
      },
      records,
      readSource: { truncated: false, windowStartBp: 0, windowEndBp: 2000 },
    });

    r.paint(paintArgsZoom(c, exactData(0), 4.0 / 150, { start: 100, end: 350 }, 800));
    const settled = r.getDiagnostics(c)!;
    const settledCoverageWork = {
      samplePasses: settled.coverageSamplePassCount,
      geometryBuilds: settled.coverageGeometryBuildCount,
      bufferUploads: settled.coverageBufferUploadCount,
    };
    expect(settledCoverageWork.samplePasses).toBe(1);
    expect(settledCoverageWork.geometryBuilds).toBe(1);
    expect(settledCoverageWork.bufferUploads).toBeGreaterThan(0);

    for (let revision = 1; revision < 20; revision += 1) {
      r.paint(
        paintArgsZoom(
          c,
          exactData(revision),
          4.0 / 150,
          { start: 100 + revision, end: 350 + revision },
          800
        )
      );
    }

    const exact = r.getDiagnostics(c)!;
    expect(exact.readDisplayMode).toBe('reads');
    expect(exact.renderedReadRowsAlpha).toBeGreaterThan(0.95);
    expect(exact.renderedReadDensityAlpha).toBeLessThan(0.03);
    expect(exact.readDifferenceMarkCount).toBe(1);
    expect({
      samplePasses: exact.coverageSamplePassCount,
      geometryBuilds: exact.coverageGeometryBuildCount,
      bufferUploads: exact.coverageBufferUploadCount,
    }).toEqual(settledCoverageWork);

    r.paint(
      paintArgsZoom(
        c,
        {
          dataAuthority: 'static',
          coverage: {
            coverageRevision: 'visible-density',
            startBp: 0,
            bins: Array.from({ length: 20 }, () => 12),
            binSize: 128,
            maxDepth: 12,
          },
          records: [],
        },
        0.001,
        { start: 0, end: 2000 },
        800
      )
    );
    const density = r.getDiagnostics(c)!;
    expect(density.renderedReadDensityAlpha).toBeGreaterThan(0.95);
    expect(density.coverageSamplePassCount).toBe(settledCoverageWork.samplePasses + 1);
    expect(density.coverageGeometryBuildCount).toBe(settledCoverageWork.geometryBuilds + 1);
    expect(density.coverageBufferUploadCount).toBeGreaterThan(settledCoverageWork.bufferUploads);
  });

  it('keeps the shared pileup shader program alive when exact rows retire into density', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
    const c = r.mount(mountArgs);
    const coverage = {
      bins: Array.from({ length: 20 }, () => 12),
      binSize: 100,
      maxDepth: 12,
    };
    const view = { start: 100, end: 350 };

    r.paint(
      paintArgsZoom(
        c,
        {
          coverage,
          records: [read(0, 400, 'exact-a'), read(20, 420, 'exact-b')],
          readSource: { truncated: false, windowStartBp: 0, windowEndBp: 2000 },
        },
        4.0 / 150,
        view,
        800
      )
    );
    const state = (
      r as unknown as {
        containerState: WeakMap<
          object,
          {
            rows: { shader: { glProgram: { _attributeData: unknown } } } | null;
            densityRows: { shader: { glProgram: { _attributeData: unknown } } } | null;
          }
        >;
      }
    ).containerState.get(c)!;
    expect(state.rows).not.toBeNull();
    expect(state.densityRows).not.toBeNull();
    const sharedProgram = state.densityRows!.shader.glProgram;
    expect(state.rows!.shader.glProgram).toBe(sharedProgram);

    r.paint(
      paintArgsZoom(
        c,
        {
          coverage,
          records: [],
          readSource: { truncated: false, windowStartBp: 0, windowEndBp: 2000 },
        },
        0.3 / 150,
        view,
        800
      )
    );

    expect(state.rows).toBeNull();
    expect(state.densityRows).not.toBeNull();
    expect(state.densityRows!.shader.glProgram).toBe(sharedProgram);
    expect(sharedProgram._attributeData).not.toBeNull();
  });

  it('does not build read-decomposition morph meshes in the simple transition', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
    const c = r.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      coverage: { bins: Array.from({ length: 20 }, () => 12), binSize: 100, maxDepth: 12 },
      records: [read(0, 400, 'exact-a'), read(20, 420, 'exact-b')],
      readSource: { truncated: false, windowStartBp: 0, windowEndBp: 2000 },
    };

    r.paint(paintArgsZoom(c, data, 2.1 / 150, { start: 100, end: 350 }, 800));
    const d = r.getDiagnostics(c)!;
    expect(d.readAggregateSource).toBe('collapsed-pileup');
    expect(d.morphRowsVertexCount).toBe(0);
    expect(d.morphRowsMeshVisible).toBe(false);
    expect(d.renderedReadMorphRowsAlpha).toBe(0);
    expect(d.renderedReadRowsAlpha + d.renderedReadDensityAlpha).toBeCloseTo(1, 2);
  });

  it('prepares row heights only when the same exact reads switch from tiled to static coverage', () => {
    const renderer = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 8,
    });
    const container = renderer.mount(mountArgs);
    const tiled: PileupTrackData = {
      dataAuthority: 'tile-engine',
      coverage: {
        bins: Array(20).fill(12),
        binSize: 100,
        maxDepth: 120,
        provenance: { exact: true, method: 'pyramid-maxpool', source: 'tile-engine' },
      },
      records: [read(0, 400, 'first'), read(20, 420, 'second')],
      readSource: {
        truncated: false,
        windowStartBp: 0,
        windowEndBp: 2000,
        sourceGenerationKey: 'same-bam',
      },
    };
    const prepare = vi.spyOn(rowHeightField, 'beginReadRowHeightFieldJob');
    const paint = (data: PileupTrackData) => {
      const args = paintArgsZoom(container, data, 4 / 150, { start: 100, end: 350 });
      renderer.paint(args);
      for (let i = 0; renderer.hasPendingPaintWork(container) && i < 20; i++) renderer.paint(args);
      expect(renderer.hasPendingPaintWork(container)).toBe(false);
      const diagnostics = renderer.getDiagnostics(container)!;
      expect(diagnostics.rowsMeshVisible).toBe(true);
      for (const [row, readId] of ['first', 'second'].entries()) {
        const localX = args.pathMapper.bpLeftX(200);
        const localY = diagnostics.readRowsTopPx + diagnostics.effectiveRowHeightPx * (row + 0.5);
        expect(
          renderer.hitTestReadEvent(container, {
            trackId: 'test-bam',
            localX,
            localY,
            screenX: localX,
            screenY: args.containerTopPx + localY,
            pathMapper: args.pathMapper,
            chromosomeGlobalStartBp: 0,
          })
        ).toMatchObject({ readId, sourceGenerationKey: 'same-bam' });
      }
      return diagnostics;
    };
    try {
      const native = paint(tiled);
      expect(native.aggregateDepthSource).toBe('tile-engine-coverage');
      expect(native.readDensityMorph).toBe(0);
      const tiledPreparationCount = prepare.mock.calls.length;
      const legacy = paint({ ...tiled, dataAuthority: 'static' });
      expect(legacy.readDensityMorph).toBeGreaterThan(0.95);
      expect(legacy.readDensityRowStackMaxFill).toBeGreaterThan(0);
      expect(legacy.readDensityMaxFill).toBeCloseTo(legacy.readDensityRowStackMaxFill, 2);
      expect(tiledPreparationCount).toBe(0);
    } finally {
      prepare.mockRestore();
      renderer.unmount(container);
    }
  });

  it('morphs aggregate height from coverage depth toward lane-packed row height', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      rowHeightPx: 10,
      maxRows: 8,
    });
    const c = r.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      coverage: { bins: Array.from({ length: 20 }, () => 12), binSize: 100, maxDepth: 120 },
      records: [read(0, 400, 'exact-a'), read(20, 420, 'exact-b')],
      readSource: { truncated: false, windowStartBp: 0, windowEndBp: 2000 },
    };
    const view = { start: 100, end: 350 };

    r.paint(paintArgsZoom(c, data, 0.3 / 150, view, 800));
    const coverageHeight = r.getDiagnostics(c)!;
    expect(coverageHeight.readDensityMorph).toBe(0);
    expect(coverageHeight.readDensityRowStackMaxFill).toBe(0);

    r.paint(paintArgsZoom(c, data, 4.0 / 150, view, 800));
    const rowHeight = r.getDiagnostics(c)!;
    expect(rowHeight.readDensityMorph).toBeGreaterThan(0.95);
    expect(rowHeight.readDensityRowStackMaxFill).toBeGreaterThan(0);
    expect(rowHeight.readDensityMaxFill).toBeCloseTo(rowHeight.readDensityRowStackMaxFill, 2);
    expect(rowHeight.readDensityMaxFill).not.toBeCloseTo(coverageHeight.readDensityMaxFill, 2);
  });

  it('keeps exact rows visible at source-window edges and only fades after real overlap loss', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
    const c = r.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      coverage: { bins: Array.from({ length: 40 }, () => 40), binSize: 6250, maxDepth: 40 },
      records: [read(0, 250_000, 'long-a'), read(10, 249_990, 'long-b')],
      readSource: { truncated: false, windowStartBp: 0, windowEndBp: 250_000 },
    };

    r.paint(paintArgsZoom(c, data, 2.0 / 150, { start: 25_000, end: 225_000 }, 800, 120));
    const safelyInside = r.getDiagnostics(c)!;
    expect(safelyInside.rowsVertexCount).toBeGreaterThan(0);
    expect(safelyInside.morphRowsVertexCount).toBe(0);
    expect(safelyInside.readRowsAlpha).toBeGreaterThan(0.4);
    expect(safelyInside.renderedReadRowsAlpha).toBeGreaterThan(0.4);
    expect(safelyInside.readDensityAlpha).toBeGreaterThan(0.4);
    expect(safelyInside.readAggregateSource).toBe('collapsed-pileup');

    r.paint(paintArgsZoom(c, data, 1.7 / 150, { start: 5_000, end: 245_000 }, 800, 120));
    const nearBoundary = r.getDiagnostics(c)!;
    expect(nearBoundary.rowsVertexCount).toBeGreaterThan(0);
    expect(nearBoundary.readRowsAlpha).toBeGreaterThan(0.25);
    expect(nearBoundary.renderedReadRowsAlpha).toBeGreaterThan(0.25);
    expect(nearBoundary.readDensityAlpha).toBeGreaterThan(0.5);
    expect(nearBoundary.readAggregateSource).toBe('collapsed-pileup');

    r.paint(paintArgsZoom(c, data, 1.6 / 150, { start: 0, end: 250_000 }, 800, 120));
    const atBoundary = r.getDiagnostics(c)!;
    expect(atBoundary.rowsVertexCount).toBeGreaterThan(0);
    expect(atBoundary.readRowsAlpha).toBeGreaterThan(0.2);
    expect(atBoundary.renderedReadRowsAlpha).toBe(atBoundary.readRowsAlpha);
    expect(atBoundary.morphRowsMeshVisible).toBe(false);
    expect(atBoundary.rowsMeshVisible).toBe(true);
    expect(atBoundary.readDensityAlpha).toBeGreaterThan(0.6);

    r.paint(paintArgsZoom(c, data, 1.6 / 150, { start: 10_000, end: 260_000 }, 800, 120));
    const tinyEdgeMiss = r.getDiagnostics(c)!;
    expect(tinyEdgeMiss.readRowsAlpha).toBeGreaterThan(0.1);
    expect(tinyEdgeMiss.renderedReadRowsAlpha).toBeGreaterThan(0.1);
    expect(tinyEdgeMiss.renderedReadDensityAlpha).toBeGreaterThan(0.6);

    r.paint(paintArgsZoom(c, data, 1.6 / 150, { start: 240_000, end: 490_000 }, 800, 120));
    const mostlyOutside = r.getDiagnostics(c)!;
    expect(mostlyOutside.readSourceWindowCoversViewport).toBe(false);
    expect(mostlyOutside.rowsMeshViewportCoverageFraction).toBeCloseTo(0.04, 2);
    expect(mostlyOutside.readRowsAlpha).toBeGreaterThan(0.2);
    expect(mostlyOutside.renderedReadRowsAlpha).toBe(mostlyOutside.readRowsAlpha);
    expect(mostlyOutside.morphRowsMeshVisible).toBe(false);
    expect(mostlyOutside.readAggregateSource).toBe('collapsed-pileup');
    expect(mostlyOutside.readDensityAlpha).toBeGreaterThan(0.95);
    expect(mostlyOutside.readDensityMorph).toBeGreaterThan(0.2);

    r.paint(paintArgsZoom(c, data, 1.6 / 150, { start: 260_000, end: 510_000 }, 800, 120));
    const noOverlap = r.getDiagnostics(c)!;
    expect(noOverlap.readRowsAlpha).toBe(0);
    expect(noOverlap.renderedReadRowsAlpha).toBe(0);
    expect(noOverlap.rowsMeshVisible).toBe(false);
  });

  it('probe-only layer controls hide actual meshes without changing target LOD alphas', async () => {
    const g = globalThis as {
      __dna119PileupProbe?: {
        hideExactRows?: boolean;
        hideReadDensity?: boolean;
        densityColor?: number;
      };
    };
    try {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const data: PileupTrackData = {
        dataAuthority: 'static',
        coverage: { bins: Array.from({ length: 20 }, () => 12), binSize: 100, maxDepth: 12 },
        records: [read(0, 400, 'exact-a'), read(20, 420, 'exact-b')],
        readSource: { truncated: false, windowStartBp: 0, windowEndBp: 2000 },
      };
      const view = { start: 100, end: 350 };

      g.__dna119PileupProbe = { hideReadDensity: true };
      const densityRenderer = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        maxRows: 8,
      });
      const densityContainer = densityRenderer.mount(mountArgs);
      densityRenderer.paint(paintArgsZoom(densityContainer, data, 1.6 / 150, view, 800));
      const densityHidden = densityRenderer.getDiagnostics(densityContainer)!;
      expect(densityHidden.readAggregateSource).toBe('collapsed-pileup');
      expect(densityHidden.readRowsAlpha).toBeGreaterThan(0.2);
      expect(densityHidden.renderedReadRowsAlpha).toBeGreaterThan(0.2);
      expect(densityHidden.readDensityAlpha).toBeGreaterThan(0.6);
      expect(densityHidden.renderedReadDensityAlpha).toBe(0);
      expect(densityHidden.morphRowsMeshVisible).toBe(false);
      expect(densityHidden.densityRowsMeshVisible).toBe(false);

      g.__dna119PileupProbe = {
        hideExactRows: true,
        densityColor: 0xff9900,
      };
      const exactRenderer = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        maxRows: 8,
      });
      const exactContainer = exactRenderer.mount(mountArgs);
      exactRenderer.paint(paintArgsZoom(exactContainer, data, 0.3 / 150, view, 800));
      const exactHidden = exactRenderer.getDiagnostics(exactContainer)!;
      expect(exactHidden.readAggregateSource).toBe('collapsed-pileup');
      expect(exactHidden.renderedReadRowsAlpha).toBe(0);
      expect(exactHidden.rowsMeshVisible).toBe(false);
      expect(exactHidden.morphRowsMeshVisible).toBe(false);
      expect(exactHidden.readDensityAlpha).toBe(1);
      expect(exactHidden.densityRowsMeshVisible).toBe(true);
    } finally {
      g.__dna119PileupProbe = undefined;
    }
  });

  it('surfaces truncated read sources so sampled reads cannot masquerade as exact rows', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
    const c = r.mount(mountArgs);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      coverage: { bins: Array.from({ length: 10 }, () => 12), binSize: 200, maxDepth: 12 },
      records: [],
      readSource: { truncated: true, windowStartBp: 1000, windowEndBp: 5000 },
    };

    r.paint(paintArgsZoom(c, data, 0.02, { start: 1200, end: 1500 }, 800));
    const d = r.getDiagnostics(c)!;
    expect(d.readSourceTruncated).toBe(true);
    expect(d.readSourceWindowStartBp).toBe(1000);
    expect(d.readSourceWindowEndBp).toBe(5000);
    expect(d.rowsVertexCount).toBe(0);
    expect(d.readDisplayMode).toBe('density');
    expect(d.readAggregateSource).toBe('collapsed-pileup');
  });

  it('keeps the deprecated gray band off while honoring the engine-owned coverage LOD', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);

    const baseBins = Array.from({ length: 5000 }, (_, i) => (i % 50) + 1);
    const data: PileupTrackData = {
      dataAuthority: 'static',
      coverage: { bins: baseBins, binSize: 256, maxDepth: 50 },
    };

    r.paint(paintArgsZoom(c, data, 0.01));
    const zoomedIn = r.getDiagnostics(c)!;
    expect(zoomedIn.bandBinCount).toBe(0);
    expect(zoomedIn.bandVertexCount).toBe(0);
    expect(zoomedIn.readAggregateSource).toBe('collapsed-pileup');
    expect(zoomedIn.densityRowsVertexCount).toBeGreaterThan(0);
    expect(zoomedIn.activeCoverageBinSize).toBe(256);

    r.paint(paintArgsZoom(c, data, 0.00002, { start: 0, end: 20_000_000 }, 800));
    const zoomedOut = r.getDiagnostics(c)!;
    expect(zoomedOut.bandBinCount).toBe(0);
    expect(zoomedOut.bandVertexCount).toBe(0);
    expect(zoomedOut.readAggregateSource).toBe('collapsed-pileup');
    expect(zoomedOut.densityRowsVertexCount).toBeGreaterThan(0);
    expect(zoomedOut.activeCoverageBinSize).toBe(256);

    r.paint(paintArgsZoom(c, data, 0.01));
    const zoomedBackIn = r.getDiagnostics(c)!;
    expect(zoomedBackIn.bandBinCount).toBe(0);
    expect(zoomedBackIn.activeCoverageBinSize).toBe(256);
  });

  it('DEV coarse-smear fault quantizes a fine signal into visibly wide presentation steps', async () => {
    const g = globalThis as { __dna708ForceCoverageLevel?: number };
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    const binSize = 128;
    const bins = Array.from({ length: Math.ceil(500_000 / binSize) }, (_, index) => {
      const coarseRegion = Math.floor((index * binSize) / 65_536);
      return [12, 36, 20, 52, 28, 44, 16, 60][coarseRegion % 8]! + ((index * 37) % 23);
    });
    const coverage = { bins, binSize, maxDepth: 64 };
    const data = { dataAuthority: 'static' as const, coverage };

    try {
      delete g.__dna708ForceCoverageLevel;
      r.paint(paintArgsZoom(c, data, 0.01, { start: 0, end: 500_000 }, 800));
      const fine = r.getDiagnostics(c)!;

      g.__dna708ForceCoverageLevel = 16;
      r.paint(paintArgsZoom(c, data, 0.01, { start: 0, end: 500_000 }, 800));
      const forced = r.getDiagnostics(c)!;

      delete g.__dna708ForceCoverageLevel;
      r.paint(paintArgsZoom(c, data, 0.01, { start: 0, end: 500_000 }, 800));
      const recovered = r.getDiagnostics(c)!;

      expect(fine.readDensitySourceDepthLongestFlatRunColumns).toBeLessThan(64);
      expect(forced.readDensitySourceDepthLongestFlatRunColumns).toBeGreaterThan(80);
      expect(forced.readDensitySourceDepthEdgeCount).toBeLessThan(40);
      expect(forced.coverageGeometryBuildCount).toBe(fine.coverageGeometryBuildCount + 1);
      expect(recovered.coverageGeometryBuildCount).toBe(forced.coverageGeometryBuildCount + 1);
      expect(recovered.readDensitySourceDepthLongestFlatRunColumns).toBe(
        fine.readDensitySourceDepthLongestFlatRunColumns
      );
    } finally {
      delete g.__dna708ForceCoverageLevel;
    }
  });

  it('persistent strategy (L1): surviving reads keep their row across a record-set refetch', async () => {
    const g = globalThis as { __dna119ExposePileupRows?: boolean };
    g.__dna119ExposePileupRows = true;
    try {
      const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
      const r = new PixiPileupTrackRenderer({
        type: 'pileup-test',
        maxRows: 32,
      });
      const c = r.mount(mountArgs);
      r.paint(paintArgs(c, { records: [read(100, 200, 'X'), read(150, 250, 'Y')] }));
      const a = r.getDiagnostics(c)!.rowAssignments!;
      expect(a.X).toBe(0);
      expect(a.Y).toBe(1);
      r.paint(
        paintArgs(c, { records: [read(50, 120, 'Z'), read(100, 200, 'X'), read(150, 250, 'Y')] })
      );
      const b = r.getDiagnostics(c)!.rowAssignments!;
      expect(b.X).toBe(0);
      expect(b.Y).toBe(1);
    } finally {
      g.__dna119ExposePileupRows = false;
    }
  });

  it('rowAssignments is undefined unless the debug global is set (no snapshot bloat)', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test' });
    const c = r.mount(mountArgs);
    r.paint(paintArgs(c, { records: [read(100, 200, 'X')] }));
    expect(r.getDiagnostics(c)!.rowAssignments).toBeUndefined();
    expect(r.getDiagnostics(c)!.visibleReadSamples).toBeUndefined();
  });

  it('reports opt-in visible read samples with predicted screen coordinates', async () => {
    const g = globalThis as { __dna119ExposePileupRows?: boolean };
    g.__dna119ExposePileupRows = true;
    try {
      const { PixiPileupTrackRenderer, DEFAULT_PILEUP_FORWARD_READ_COLOR } =
        await import('./pileup-track-renderer');
      const r = new PixiPileupTrackRenderer({ type: 'pileup-test', maxRows: 8 });
      const c = r.mount(mountArgs);
      r.paint(
        paintArgsZoom(
          c,
          {
            records: [read(100, 200, 'X')],
            readSource: { truncated: false, windowStartBp: 0, windowEndBp: 1000 },
          },
          0.1,
          { start: 0, end: 1000 },
          800
        )
      );
      const d = r.getDiagnostics(c)!;
      expect(d.recordExtentCoversViewport).toBe(false);
      expect(d.readSourceWindowCoversViewport).toBe(true);
      expect(d.visibleReadSamples).toHaveLength(1);
      expect(d.visibleReadSamples![0]).toMatchObject({
        readId: 'X',
        row: 0,
        color: DEFAULT_PILEUP_FORWARD_READ_COLOR,
        x0Px: 10,
        x1Px: 20,
        yPx: 51.5,
      });
    } finally {
      g.__dna119ExposePileupRows = false;
    }
  });

  it('reflects setCollapsed', async () => {
    const { PixiPileupTrackRenderer } = await import('./pileup-track-renderer');
    const r = new PixiPileupTrackRenderer({ type: 'pileup-test', collapsed: true });
    const c = r.mount(mountArgs);
    expect(r.getDiagnostics(c)!.collapsed).toBe(true);
    r.setCollapsed(false);
    expect(r.getDiagnostics(c)!.collapsed).toBe(false);
  });
});
