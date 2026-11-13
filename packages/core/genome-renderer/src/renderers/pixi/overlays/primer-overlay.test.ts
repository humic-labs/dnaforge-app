// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GOLDEN_GATE_JUNCTION_VISUAL } from '@waypoint/sequence-utils';
import { PrimerOverlay } from './primer-overlay';
import { LinearPathMapper, StadiumPathMapper } from '../shared/path-mapper';
import { computeUnifiedLayout } from '../shared/track-layout';
import { getStadiumDimensions } from '../../../geometry/stadium';
import type { Genome, RenderState } from '../../../types';
import { labelBoxPolygonAtPath } from '../shared/cut-site-label';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: '',
    measureText: (text: string) => ({ width: text.length * 6 }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

function createRenderState(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 200,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

function renderOverlay(overlay: PrimerOverlay, genome: Genome, pixelsPerBp: number) {
  const state = createRenderState();
  const layout = computeUnifiedLayout({
    overlays: [overlay],
    genome,
    state,
    pixelsPerBp,
    viewportHeight: state.height,
    hasSequence: !!genome.sequence,
    translationLanes: 0,
    annotationLanes: 0,
    cdsLanes: 0,
  });
  overlay.setLayout(layout);
  const path = LinearPathMapper.fromUnifiedLayout(
    layout,
    state.width,
    1 / pixelsPerBp,
    0,
    genome.length,
    0,
    0,
    state.height
  );
  const slot = layout.below.find((candidate) => candidate.overlay.id === overlay.id);
  overlay.render(path, state, slot?.yOffset ?? 0, slot?.height ?? 0);
  return { path, state };
}

function renderCircularOverlay(overlay: PrimerOverlay, genome: Genome, zoom: number, morph = 0) {
  const state = createRenderState();
  state.width = 800;
  state.height = 400;
  state.zoom = zoom;
  state.morph = morph;
  const dims = getStadiumDimensions(state.width, state.height, state.morph, 80);
  const pixelsPerBp = (dims.totalLength * zoom) / genome.length;
  const layout = computeUnifiedLayout({
    overlays: [overlay],
    genome,
    state,
    pixelsPerBp,
    viewportHeight: state.height,
    hasSequence: !!genome.sequence,
    sequenceViewportSpanPx: (state.width + state.height) * 2,
    translationLanes: 0,
    annotationLanes: 0,
    cdsLanes: 0,
  });
  overlay.setLayout(layout);
  const path = new StadiumPathMapper({
    genomeLength: genome.length,
    viewOffset: state.viewOffset,
    zoom,
    dims,
    ox: 0,
    oy: 0,
    stagePosX: 0,
    stagePosY: 0,
    bpPerPixel: 1 / pixelsPerBp,
    hasSequence: !!genome.sequence,
    viewportWidth: state.width,
    viewportHeight: state.height,
    layout,
  });
  const slot = [...layout.on, ...layout.below].find(
    (candidate) => candidate.overlay.id === overlay.id
  );
  overlay.render(path, state, slot?.yOffset ?? 0, slot?.height ?? 0);
  return { path, state };
}

function centerOfFirstPrimer(overlay: PrimerOverlay): { x: number; y: number } {
  const first = overlay.lastRenderStats.firstDrawnPrimer;
  if (!first) throw new Error('expected primer to render');
  return {
    x: (first.bbox.xMin + first.bbox.xMax) / 2,
    y: (first.bbox.yMin + first.bbox.yMax) / 2,
  };
}

function primerHitRecords(overlay: PrimerOverlay) {
  return (
    overlay as unknown as {
      hitCache: Array<{
        id: number;
        xMin: number;
        xMax: number;
        yMin: number;
        yMax: number;
      }>;
    }
  ).hitCache;
}

function overlapAmount(
  a: { xMin: number; xMax: number; yMin: number; yMax: number },
  b: { xMin: number; xMax: number; yMin: number; yMax: number }
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(a.xMax, b.xMax) - Math.max(a.xMin, b.xMin)),
    y: Math.max(0, Math.min(a.yMax, b.yMax) - Math.max(a.yMin, b.yMin)),
  };
}

describe('PrimerOverlay', () => {
  it('bounds arbitrary primer text styles with LRU reuse', () => {
    const overlay = new PrimerOverlay();
    const debug = overlay as unknown as {
      getTextStyle: (color: number, bold: boolean, fontSize: number) => object;
      textStyleCache: Map<string, object>;
    };
    const first = debug.getTextStyle(0, false, 8);
    for (let color = 1; color < 64; color++) {
      debug.getTextStyle(color, false, 8);
    }
    expect(debug.getTextStyle(0, false, 8)).toBe(first);
    debug.getTextStyle(64, false, 8);

    expect(debug.textStyleCache.size).toBe(64);
    expect(debug.getTextStyle(1, false, 8)).not.toBe(first);
    expect(debug.getTextStyle(0, false, 8)).toBe(first);
    overlay.destroy();
  });

  it('reserves the same primer bands for a streamed-sequence genome as for an in-memory one', () => {
    const stacked = (id: string, start: number) => ({
      id,
      renderId: 1_000_000_000 + start,
      name: id,
      start,
      end: start + 20,
      direction: 'forward' as const,
      color: 0xd97706,
      bases: 'A'.repeat(20),
      mismatches: [],
    });
    const primers = [stacked('p1', 10), stacked('p2', 15), stacked('p3', 20)];
    const inMemory: Genome = {
      name: 'in-memory',
      length: 100,
      circular: false,
      features: [],
      primers,
      sequence: 'A'.repeat(100),
    };
    const streamed: Genome = {
      ...inMemory,
      name: 'streamed',
      sequence: '',
      sequenceAvailable: true,
    };
    const state = createRenderState();
    const bandsFor = (genome: Genome) => {
      const overlay = new PrimerOverlay();
      overlay.loadGenome(genome);
      return overlay.computeLayoutBands(genome, state, 10);
    };

    expect(bandsFor(streamed)).toEqual(bandsFor(inMemory));
    expect(bandsFor(streamed).aboveSequenceHeight).toBeGreaterThan(0);
  });

  it('sizes primer bands from the primers near the view when a view range is set', () => {
    const primer = (id: string, start: number, direction: 'forward' | 'reverse') => ({
      id,
      renderId: 1_000_000_000 + start,
      name: id,
      start,
      end: start + 20,
      direction,
      color: 0xd97706,
      bases: 'A'.repeat(20),
      mismatches: [],
    });
    const genome: Genome = {
      name: 'streamed',
      length: 10_000,
      circular: false,
      features: [],
      primers: [],
      sequence: '',
      sequenceAvailable: true,
    };
    const overlay = new PrimerOverlay();
    overlay.loadGenome(genome);
    overlay.setPrimers([
      primer('f1', 1_000, 'forward'),
      primer('f2', 1_005, 'forward'),
      primer('r1', 1_010, 'reverse'),
    ]);
    const state = createRenderState();

    const all = overlay.computeLayoutBands(genome, state, 10);
    expect(all.aboveSequenceHeight).toBeGreaterThan(0);
    expect(all.belowSequenceHeight).toBeGreaterThan(0);

    overlay.setVisibleRange(8_000, 8_100);
    const away = overlay.computeLayoutBands(genome, state, 10);
    expect(away.aboveSequenceHeight ?? 0).toBe(0);
    expect(away.belowSequenceHeight ?? 0).toBe(0);

    overlay.setVisibleRange(950, 1_100);
    expect(overlay.computeLayoutBands(genome, state, 10)).toEqual(all);
    expect(overlay.layoutCacheKey(genome, state, 10)).not.toEqual(
      (overlay.setVisibleRange(8_000, 8_100), overlay.layoutCacheKey(genome, state, 10))
    );
  });

  it('recomputes the bands when primers are replaced without a genome load', () => {
    const genome: Genome = {
      name: 'streamed',
      length: 100,
      circular: false,
      features: [],
      primers: [],
      sequence: '',
      sequenceAvailable: true,
    };
    const primer = (id: string, start: number) => ({
      id,
      renderId: 1_000_000_000 + start,
      name: id,
      start,
      end: start + 20,
      direction: 'forward' as const,
      color: 0xd97706,
      bases: 'A'.repeat(20),
      mismatches: [],
    });
    const overlay = new PrimerOverlay();
    overlay.loadGenome(genome);
    const state = createRenderState();
    overlay.setPrimers([primer('p1', 10)]);
    const oneLane = overlay.computeLayoutBands(genome, state, 10).aboveSequenceHeight ?? 0;
    overlay.setPrimers([primer('p1', 10), primer('p2', 15)]);
    const twoLanes = overlay.computeLayoutBands(genome, state, 10).aboveSequenceHeight ?? 0;
    expect(twoLanes).toBeGreaterThan(oneLane);
  });

  it('renders a hit-testable primer when the genome contains primers', () => {
    const overlay = new PrimerOverlay();
    const genome: Genome = {
      name: 'primer-regression',
      length: 100,
      circular: false,
      features: [],
      primers: [
        {
          id: 'primer-a',
          renderId: 1_000_000_000,
          name: 'Primer A',
          start: 10,
          end: 30,
          direction: 'forward',
          color: 0xd97706,
          bases: 'A'.repeat(20),
          mismatches: [],
        },
      ],
      sequence: 'A'.repeat(100),
    };

    overlay.loadGenome(genome);
    const { path, state } = renderOverlay(overlay, genome, 10);
    const hitPoint = centerOfFirstPrimer(overlay);

    const hit = overlay.hitTest(hitPoint.x, hitPoint.y, path, state);
    expect(hit).toMatchObject({
      kind: 'feature',
      payload: { id: 1_000_000_000, start: 10, end: 30 },
    });
    expect(overlay.lastRenderStats).toMatchObject({
      loadedPrimers: 1,
      drawnPrimers: 1,
      hitRecords: 1,
      contractLod: 'sequence',
      firstDrawnPrimer: {
        id: 'primer-a',
        renderId: 1_000_000_000,
        start: 10,
        end: 30,
      },
    });

    overlay.destroy();
  });

  it.each([
    {
      surface: 'linear' as const,
      direction: 'forward' as const,
      start: 10,
      end: 30,
      anchorBp: 30,
    },
    {
      surface: 'linear' as const,
      direction: 'reverse' as const,
      start: 40,
      end: 60,
      anchorBp: 40,
    },
    {
      surface: 'stadium' as const,
      direction: 'forward' as const,
      start: 10,
      end: 30,
      anchorBp: 30,
    },
    {
      surface: 'stadium' as const,
      direction: 'reverse' as const,
      start: 40,
      end: 60,
      anchorBp: 40,
    },
  ])('draws a typed PBS endpoint handle on an editable $direction primer in $surface', (primer) => {
    const overlay = new PrimerOverlay();
    const graphics = (
      overlay as unknown as {
        graphics: {
          circle: (...args: unknown[]) => unknown;
          fill: (...args: unknown[]) => unknown;
          getTransform: () => { tx: number; ty: number };
          roundRect: (
            x: number,
            y: number,
            width: number,
            height: number,
            radius: number
          ) => unknown;
          setStrokeStyle: (...args: unknown[]) => unknown;
          stroke: (...args: unknown[]) => unknown;
        };
      }
    ).graphics;
    const circleSpy = vi.spyOn(graphics, 'circle');
    const fillSpy = vi.spyOn(graphics, 'fill');
    const roundRectTransforms: Array<{
      width: number;
      height: number;
      tx: number;
      ty: number;
    }> = [];
    const originalRoundRect = graphics.roundRect.bind(graphics);
    const roundRectSpy = vi
      .spyOn(graphics, 'roundRect')
      .mockImplementation((x, y, width, height, radius) => {
        const transform = graphics.getTransform();
        roundRectTransforms.push({
          width,
          height,
          tx: transform.tx,
          ty: transform.ty,
        });
        return originalRoundRect(x, y, width, height, radius);
      });
    const setStrokeStyleSpy = vi.spyOn(graphics, 'setStrokeStyle');
    const strokeSpy = vi.spyOn(graphics, 'stroke');
    const genome: Genome = {
      name: `editable-${primer.direction}-primer`,
      length: 100,
      circular: false,
      features: [],
      primers: [
        {
          id: `primer-${primer.direction}`,
          renderId: 1_000_000_010,
          name: `${primer.direction} primer`,
          start: primer.start,
          end: primer.end,
          direction: primer.direction,
          color: 0xd97706,
          bases: 'A'.repeat(20),
          overhangLength: 4,
          editablePbsEndpoint: true,
        },
      ],
      sequence: 'A'.repeat(100),
    };

    overlay.loadGenome(genome);
    const { path, state } =
      primer.surface === 'stadium'
        ? renderCircularOverlay(overlay, genome, 2)
        : renderOverlay(overlay, genome, 10);
    const handle = overlay.lastRenderStats.firstDrawnPrimer?.pbsHandle;
    expect(handle).toMatchObject({
      anchorBp: primer.anchorBp,
      visual: {
        contractId: 'assembly-primer-handle-v1',
        hitWidthPx: 28,
        hitHeightPx: 22,
        gripWidthPx: 16,
        gripHeightPx: 7,
        gripRadiusPx: 5,
        gripFillColor: 0xc4c3c2,
        gripBorderColor: 0x757471,
        gripBorderWidthPx: 1,
        guideColor: 0xa8a6a2,
        guideWidthPx: 1,
        guideDashPx: 2,
        guideGapPx: 3,
      },
    });
    if (!handle) throw new Error('expected editable primer handle geometry');

    expect(circleSpy).not.toHaveBeenCalled();
    expect(roundRectSpy).toHaveBeenCalledWith(-8, -3.5, 16, 7, 5);
    const gripTransform = roundRectTransforms.find(
      (transform) => transform.width === 16 && transform.height === 7
    );
    expect(gripTransform).toBeDefined();
    expect(gripTransform?.tx).toBeCloseTo(handle.x, 6);
    expect(gripTransform?.ty).toBeCloseTo(handle.y, 6);
    expect(setStrokeStyleSpy).toHaveBeenCalledWith({
      color: 0xa8a6a2,
      width: 1,
      alpha: 1,
    });
    expect(fillSpy).toHaveBeenCalledWith({ color: 0xc4c3c2, alpha: 1 });
    expect(strokeSpy).toHaveBeenCalledWith({ color: 0x757471, width: 1, alpha: 1 });

    expect(overlay.hitTest(handle.x, handle.y, path, state)).toEqual({
      kind: 'primer-handle',
      payload: {
        id: 1_000_000_010,
        primerId: `primer-${primer.direction}`,
        start: primer.start,
        end: primer.end,
        direction: primer.direction,
        overhangLength: 4,
        anchorBp: primer.anchorBp,
      },
    });
    expect(overlay.lastRenderStats.pbsHandles).toBe(1);

    overlay.destroy();
  });

  it.each([
    { direction: 'forward' as const, start: 20, end: 40, previewBoundary: 47 },
    { direction: 'reverse' as const, start: 40, end: 60, previewBoundary: 33 },
  ])(
    'previews an editable $direction PBS endpoint without changing loaded primer state',
    (primer) => {
      const overlay = new PrimerOverlay();
      const genome: Genome = {
        name: `preview-${primer.direction}-primer`,
        length: 100,
        circular: false,
        features: [],
        primers: [
          {
            id: `primer-${primer.direction}`,
            renderId: 1_000_000_011,
            name: `${primer.direction} primer`,
            start: primer.start,
            end: primer.end,
            direction: primer.direction,
            color: 0xd97706,
            bases: 'A'.repeat(20),
            overhangLength: 4,
            editablePbsEndpoint: true,
          },
        ],
        sequence: 'A'.repeat(100),
      };

      overlay.loadGenome(genome);
      overlay.setPbsEndpointPreview(1_000_000_011, primer.previewBoundary);
      renderOverlay(overlay, genome, 10);

      expect(overlay.lastRenderStats.firstDrawnPrimer?.pbsHandle?.anchorBp).toBe(
        primer.previewBoundary
      );
      expect(genome.primers?.[0]).toMatchObject({ start: primer.start, end: primer.end });

      overlay.loadGenome(genome);
      renderOverlay(overlay, genome, 10);
      expect(overlay.lastRenderStats.firstDrawnPrimer?.pbsHandle?.anchorBp).toBe(
        primer.direction === 'forward' ? primer.end : primer.start
      );

      overlay.destroy();
    }
  );

  it('clears a provisional PBS endpoint without reloading the genome', () => {
    const overlay = new PrimerOverlay();
    const genome: Genome = {
      name: 'clear-preview-primer',
      length: 100,
      circular: false,
      features: [],
      primers: [
        {
          id: 'primer-forward',
          renderId: 1_000_000_013,
          name: 'forward primer',
          start: 20,
          end: 40,
          direction: 'forward',
          color: 0xd97706,
          bases: 'A'.repeat(20),
          editablePbsEndpoint: true,
        },
      ],
      sequence: 'A'.repeat(100),
    };

    overlay.loadGenome(genome);
    expect(overlay.setPbsEndpointPreview(1_000_000_013, 47)).toBe(true);
    renderOverlay(overlay, genome, 10);
    expect(overlay.lastRenderStats.firstDrawnPrimer?.pbsHandle?.anchorBp).toBe(47);

    expect(overlay.clearPbsEndpointPreview(1_000_000_013)).toBe(true);
    renderOverlay(overlay, genome, 10);
    expect(overlay.lastRenderStats.firstDrawnPrimer?.pbsHandle?.anchorBp).toBe(40);
    expect(overlay.clearPbsEndpointPreview(1_000_000_013)).toBe(false);

    overlay.destroy();
  });

  it.each([
    { direction: 'forward' as const, start: 20, end: 40, previewStart: 20, previewEnd: 42 },
    { direction: 'reverse' as const, start: 40, end: 60, previewStart: 38, previewEnd: 60 },
  ])('renders every provisional $direction primer base before commit', (primer) => {
    const overlay = new PrimerOverlay();
    const canonicalBases = 'aCgT'.repeat(5);
    const provisionalBases = `${canonicalBases}rY`;
    const genome: Genome = {
      name: `provisional-${primer.direction}-primer`,
      length: 100,
      circular: false,
      features: [],
      primers: [
        {
          id: `primer-${primer.direction}`,
          renderId: 1_000_000_012,
          name: `${primer.direction} primer`,
          start: primer.start,
          end: primer.end,
          direction: primer.direction,
          color: 0xd97706,
          bases: canonicalBases,
          editablePbsEndpoint: true,
        },
      ],
      sequence: 'A'.repeat(100),
    };

    overlay.loadGenome(genome);
    renderOverlay(overlay, genome, 10);
    expect(overlay.lastRenderStats.textGlyphs).toBe(canonicalBases.length);
    const canonicalPrimer = genome.primers?.[0];
    if (!canonicalPrimer) throw new Error('Primer fixture was not created.');

    expect(
      overlay.setPbsEndpointPreview(1_000_000_012, {
        boundaryBp: primer.direction === 'forward' ? primer.previewEnd : primer.previewStart,
        bases: provisionalBases,
        tm: 61,
        gc: 50,
      })
    ).toBe(true);
    renderOverlay(overlay, genome, 10);

    const visibleText = (
      overlay as unknown as {
        textPool: Array<{ visible: boolean; text: string }>;
      }
    ).textPool
      .filter((glyph) => glyph.visible)
      .map((glyph) => glyph.text)
      .join('');
    expect(overlay.lastRenderStats.textGlyphs).toBe(provisionalBases.length);
    expect(visibleText).toBe(
      primer.direction === 'forward'
        ? provisionalBases
        : provisionalBases.split('').reverse().join('')
    );
    expect(genome.primers?.[0]).toMatchObject({
      start: primer.start,
      end: primer.end,
      bases: canonicalBases,
    });

    overlay.destroy();
  });

  it('renders unsaved primers with a dashed outline and excludes them from hit testing', () => {
    const overlay = new PrimerOverlay();
    const genome: Genome = {
      name: 'unsaved-primer-regression',
      length: 100,
      circular: false,
      features: [],
      primers: [
        {
          id: 'candidate-primer',
          renderId: 1_000_000_004,
          name: 'Candidate Primer',
          start: 10,
          end: 30,
          direction: 'forward',
          color: 0xd97706,
          bases: 'A'.repeat(20),
          mismatches: [],
          isCandidate: true,
        },
      ],
      sequence: 'A'.repeat(100),
    };
    const graphics = (
      overlay as unknown as { graphics: { moveTo: (...args: unknown[]) => unknown } }
    ).graphics;
    const moveToSpy = vi.spyOn(graphics, 'moveTo');

    overlay.loadGenome(genome);
    const { path, state } = renderOverlay(overlay, genome, 10);
    const hitPoint = centerOfFirstPrimer(overlay);

    expect(moveToSpy).toHaveBeenCalled();
    expect(overlay.lastRenderStats).toMatchObject({
      loadedPrimers: 1,
      drawnPrimers: 1,
      hitRecords: 0,
      unsavedPrimerOutlines: 1,
    });
    expect(overlay.hitTest(hitPoint.x, hitPoint.y, path, state)).toBeNull();

    overlay.destroy();
  });

  it('clears primer hit records immediately when primers are removed from the genome', () => {
    const overlay = new PrimerOverlay();
    const genome: Genome = {
      name: 'primer-hit-cleanup-regression',
      length: 100,
      circular: false,
      features: [],
      primers: [
        {
          id: 'primer-to-remove',
          renderId: 1_000_000_005,
          name: 'Primer To Remove',
          start: 10,
          end: 30,
          direction: 'forward',
          color: 0xd97706,
          bases: 'A'.repeat(20),
          mismatches: [],
        },
      ],
      sequence: 'A'.repeat(100),
    };
    const emptyGenome: Genome = { ...genome, primers: [] };

    overlay.loadGenome(genome);
    const { path, state } = renderOverlay(overlay, genome, 10);
    const hitPoint = centerOfFirstPrimer(overlay);
    expect(overlay.hitTest(hitPoint.x, hitPoint.y, path, state)).toMatchObject({
      kind: 'feature',
      payload: { id: 1_000_000_005 },
    });

    overlay.loadGenome(emptyGenome);

    expect(overlay.lastRenderStats).toMatchObject({ loadedPrimers: 0, hitRecords: 0 });
    expect(overlay.hitTest(hitPoint.x, hitPoint.y, path, state)).toBeNull();

    overlay.destroy();
  });

  it('renders a feature-level primer visual before nucleotide-detail LOD', () => {
    const overlay = new PrimerOverlay();
    const genome: Genome = {
      name: 'tiny-primer-regression',
      length: 1000,
      circular: false,
      features: [],
      primers: [
        {
          id: 'primer-tiny',
          renderId: 1_000_000_001,
          name: 'Tiny Primer',
          start: 100,
          end: 120,
          direction: 'forward',
          color: 0xd97706,
          bases: 'A'.repeat(20),
          mismatches: [],
        },
      ],
      sequence: 'A'.repeat(1000),
    };

    overlay.loadGenome(genome);
    const { path, state } = renderOverlay(overlay, genome, 0.1);

    expect(path.sequenceVisible).toBe(false);
    expect(overlay.lastRenderStats).toMatchObject({
      loadedPrimers: 1,
      drawnPrimers: 1,
      hitRecords: 1,
      culledByLod: 0,
      contractLod: 'shape',
    });
    const first = overlay.lastRenderStats.firstDrawnPrimer;
    expect(first).not.toBeNull();
    expect(first!.bbox.xMax - first!.bbox.xMin).toBeGreaterThanOrEqual(6);
    const hitPoint = centerOfFirstPrimer(overlay);
    expect(overlay.hitTest(hitPoint.x, hitPoint.y, path, state)).toMatchObject({
      kind: 'feature',
      payload: { id: 1_000_000_001 },
    });

    overlay.destroy();
  });

  it('scales compact feature-level primer drawing and lane provision together', () => {
    const overlay = new PrimerOverlay();
    const genome: Genome = {
      name: 'primer-feature-lane-scale-regression',
      length: 1000,
      circular: false,
      features: [],
      primers: [
        {
          id: 'feature-lane-primer',
          renderId: 1_000_000_013,
          name: 'Feature Lane Primer',
          start: 100,
          end: 900,
          direction: 'forward',
          color: 0xd97706,
          bases: 'A'.repeat(800),
          mismatches: [],
        },
      ],
      sequence: 'A'.repeat(1000),
    };

    overlay.loadGenome(genome);
    renderOverlay(overlay, genome, 0.02);
    const zoomedOut = overlay.lastRenderStats.firstDrawnPrimer;
    renderOverlay(overlay, genome, 0.157);
    const featureLevel = overlay.lastRenderStats.firstDrawnPrimer;

    expect(zoomedOut).not.toBeNull();
    expect(featureLevel).not.toBeNull();
    expect(zoomedOut!.contract).not.toBeNull();
    expect(featureLevel!.contract).not.toBeNull();
    expect(zoomedOut!.bbox.yMax - zoomedOut!.bbox.yMin).toBeLessThan(
      featureLevel!.bbox.yMax - featureLevel!.bbox.yMin
    );
    expect(zoomedOut!.contract!.maxOffset - zoomedOut!.contract!.minOffset).toBeLessThan(
      featureLevel!.contract!.maxOffset - featureLevel!.contract!.minOffset
    );
    expect(
      Math.abs(
        zoomedOut!.bbox.yMax -
          zoomedOut!.bbox.yMin -
          (zoomedOut!.contract!.maxOffset - zoomedOut!.contract!.minOffset)
      )
    ).toBeLessThan(0.15);
    expect(
      Math.abs(
        featureLevel!.bbox.yMax -
          featureLevel!.bbox.yMin -
          (featureLevel!.contract!.maxOffset - featureLevel!.contract!.minOffset)
      )
    ).toBeLessThan(0.15);

    overlay.destroy();
  });

  it('keeps primer geometry continuous through the feature-to-detail reveal threshold', () => {
    const overlay = new PrimerOverlay();
    const genome: Genome = {
      name: 'primer-shape-height-regression',
      length: 1000,
      circular: false,
      features: [],
      primers: [
        {
          id: 'primer-shape',
          renderId: 1_000_000_002,
          name: 'Shape Primer',
          start: 100,
          end: 180,
          direction: 'forward',
          color: 0xd97706,
          bases: 'A'.repeat(80),
          mismatches: [],
        },
      ],
      sequence: 'A'.repeat(1000),
    };

    overlay.loadGenome(genome);
    renderOverlay(overlay, genome, 0.35);
    const before = overlay.lastRenderStats.firstDrawnPrimer;
    const beforeStats = overlay.lastRenderStats;
    renderOverlay(overlay, genome, 0.36);
    const after = overlay.lastRenderStats.firstDrawnPrimer;
    const afterStats = overlay.lastRenderStats;

    expect(beforeStats.sequenceVisible).toBe(false);
    expect(afterStats.sequenceVisible).toBe(true);
    expect(beforeStats.drawnPrimers).toBe(1);
    expect(afterStats.drawnPrimers).toBe(1);
    expect(beforeStats.hitRecords).toBe(1);
    expect(afterStats.hitRecords).toBe(1);
    expect(beforeStats.contractLod).toBe('shape');
    expect(afterStats.contractLod).toBe('sequence');
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    const beforeHeight = before!.bbox.yMax - before!.bbox.yMin;
    const afterHeight = after!.bbox.yMax - after!.bbox.yMin;
    expect(Math.abs(afterHeight - beforeHeight)).toBeLessThan(2);

    overlay.destroy();
  });

  it('keeps overlapping forward and reverse primers in separate visual lanes during zoom transitions', () => {
    const primers: NonNullable<Genome['primers']> = [
      {
        id: 'forward-overlap',
        renderId: 1_000_000_008,
        name: 'Forward Overlap',
        start: 100,
        end: 180,
        direction: 'forward',
        color: 0xd97706,
        bases: 'A'.repeat(80),
        mismatches: [],
      },
      {
        id: 'reverse-overlap',
        renderId: 1_000_000_009,
        name: 'Reverse Overlap',
        start: 110,
        end: 190,
        direction: 'reverse',
        color: 0x2563eb,
        bases: 'T'.repeat(80),
        mismatches: [],
      },
    ];

    for (const orderedPrimers of [primers, [...primers].reverse()]) {
      const overlay = new PrimerOverlay();
      const genome: Genome = {
        name: 'primer-transition-lane-overlap-regression',
        length: 1000,
        circular: false,
        features: [],
        primers: orderedPrimers,
        sequence: 'A'.repeat(1000),
      };

      overlay.loadGenome(genome);
      const snapshots = [0.157, 0.16, 0.18, 0.2, 0.25, 0.35].map((pixelsPerBp) => {
        renderOverlay(overlay, genome, pixelsPerBp);
        const [first, second] = primerHitRecords(overlay);
        const overlap = overlapAmount(first, second);
        return {
          pixelsPerBp,
          contractLod: overlay.lastRenderStats.contractLod,
          first: {
            yMin: +first.yMin.toFixed(3),
            yMax: +first.yMax.toFixed(3),
          },
          second: {
            yMin: +second.yMin.toFixed(3),
            yMax: +second.yMax.toFixed(3),
          },
          overlap: {
            x: +overlap.x.toFixed(3),
            y: +overlap.y.toFixed(3),
          },
        };
      });

      expect(snapshots).toEqual(
        snapshots.map((snapshot) => ({
          ...snapshot,
          overlap: {
            x: snapshot.overlap.x,
            y: 0,
          },
        }))
      );

      overlay.destroy();
    }
  });

  it('keeps forward and reverse primer lane domains separate after nucleotide rows disappear', () => {
    const primers: NonNullable<Genome['primers']> = [
      {
        id: 'forward-domain',
        renderId: 1_000_000_010,
        name: 'Forward Domain',
        start: 100,
        end: 180,
        direction: 'forward',
        color: 0xd97706,
        bases: 'A'.repeat(80),
        mismatches: [],
      },
      {
        id: 'reverse-domain',
        renderId: 1_000_000_011,
        name: 'Reverse Domain',
        start: 300,
        end: 380,
        direction: 'reverse',
        color: 0x2563eb,
        bases: 'T'.repeat(80),
        mismatches: [],
      },
    ];

    for (const orderedPrimers of [primers, [...primers].reverse()]) {
      const overlay = new PrimerOverlay();
      const genome: Genome = {
        name: 'primer-direction-domain-regression',
        length: 1000,
        circular: false,
        features: [],
        primers: orderedPrimers,
        sequence: 'A'.repeat(1000),
      };

      overlay.loadGenome(genome);
      const snapshots = [0.05, 0.157, 0.16, 0.18, 0.2, 0.25, 0.35, 0.5].map((pixelsPerBp) => {
        renderOverlay(overlay, genome, pixelsPerBp);
        const records = new Map(primerHitRecords(overlay).map((record) => [record.id, record]));
        const forward = records.get(1_000_000_010);
        const reverse = records.get(1_000_000_011);
        expect(forward, `forward primer rendered at pixelsPerBp=${pixelsPerBp}`).toBeDefined();
        expect(reverse, `reverse primer rendered at pixelsPerBp=${pixelsPerBp}`).toBeDefined();
        const overlap = overlapAmount(forward!, reverse!);
        return {
          pixelsPerBp,
          contractLod: overlay.lastRenderStats.contractLod,
          forward: {
            yMin: +forward!.yMin.toFixed(3),
            yMax: +forward!.yMax.toFixed(3),
          },
          reverse: {
            yMin: +reverse!.yMin.toFixed(3),
            yMax: +reverse!.yMax.toFixed(3),
          },
          verticalOverlap: +overlap.y.toFixed(3),
          forwardAboveReverse: forward!.yMax <= reverse!.yMin,
        };
      });

      expect(snapshots).toEqual(
        snapshots.map((snapshot) => ({
          ...snapshot,
          verticalOverlap: 0,
          forwardAboveReverse: true,
        }))
      );

      overlay.destroy();
    }
  });

  it('fills zoomed-out compound primer roles without outline-only styling', () => {
    const overlay = new PrimerOverlay();
    const genome: Genome = {
      name: 'primer-overview-fill-regression',
      length: 1000,
      circular: false,
      features: [],
      primers: [
        {
          id: 'compound-overview-primer',
          renderId: 1_000_000_012,
          name: 'Compound Overview Primer',
          start: 100,
          end: 180,
          direction: 'forward',
          color: 0xd97706,
          pbsColor: 0x22c55e,
          overhangColor: 0x7c3aed,
          bases: 'A'.repeat(80),
          overhangLength: 30,
          spacerLength: 4,
          mismatches: [],
        },
      ],
      sequence: 'A'.repeat(1000),
    };
    const graphics = (
      overlay as unknown as {
        graphics: {
          setStrokeStyle: (...args: unknown[]) => unknown;
          fill: (...args: unknown[]) => unknown;
        };
      }
    ).graphics;
    const setStrokeStyleSpy = vi.spyOn(graphics, 'setStrokeStyle');
    const fillSpy = vi.spyOn(graphics, 'fill');

    overlay.loadGenome(genome);
    renderOverlay(overlay, genome, 0.2);

    expect(overlay.lastRenderStats.sequenceVisible).toBe(false);
    expect(overlay.lastRenderStats.contractLod).toBe('shape');
    expect(setStrokeStyleSpy).not.toHaveBeenCalled();
    const fillCalls = fillSpy.mock.calls
      .map(([style]) => style)
      .filter((style): style is { alpha?: number; color?: number } => typeof style === 'object');
    expect(fillCalls.length).toBeGreaterThan(1);
    expect(fillCalls.every((style) => (style.alpha ?? 0) >= 0.6)).toBe(true);

    overlay.destroy();
  });

  it('uses base boundaries for circular nucleotide-level primer outline edges', () => {
    const overlay = new PrimerOverlay();
    const genome: Genome = {
      name: 'circular-primer-boundary-regression',
      length: 1000,
      circular: true,
      features: [],
      primers: [
        {
          id: 'primer-circular',
          renderId: 1_000_000_003,
          name: 'Circular Primer',
          start: 50,
          end: 70,
          direction: 'forward',
          color: 0xd97706,
          bases: 'A'.repeat(20),
          mismatches: [],
        },
      ],
      sequence: 'A'.repeat(1000),
    };

    overlay.loadGenome(genome);
    const { path } = renderCircularOverlay(overlay, genome, 2);
    const first = overlay.lastRenderStats.firstDrawnPrimer;
    const startBoundary = path.boundaryAt(50, 'backbone');
    const endBoundary = path.boundaryAt(70, 'backbone');

    expect(first).not.toBeNull();
    expect(overlay.lastRenderStats.contractLod).toBe('sequence');
    expect(first!.bbox.xMin).toBeCloseTo(Math.min(startBoundary.x, endBoundary.x), 0);
    expect(first!.bbox.xMax).toBeCloseTo(Math.max(startBoundary.x, endBoundary.x), 0);

    overlay.destroy();
  });

  it('excludes marker-only primers from the visual and interaction passes', () => {
    const overlay = new PrimerOverlay();
    const genome: Genome = {
      name: 'golden-gate-role-debug-regression',
      length: 100,
      circular: false,
      features: [],
      primers: [
        {
          id: 'gg-primer',
          renderId: 1_000_000_006,
          name: 'Golden Gate Primer',
          start: 10,
          end: 34,
          direction: 'forward',
          color: 0xd97706,
          bases: 'A'.repeat(24),
          overhangLength: 14,
          cutPositionInOverhang: 4,
          recognitionStart: 1,
          recognitionEnd: 3,
          cognate4bpLength: 2,
          synthetic4bpSpacerLength: 1,
          spacerLength: 2,
        },
        {
          id: 'scar-marker',
          renderId: 1_000_000_007,
          name: 'Scar Marker',
          start: 50,
          end: 54,
          direction: 'forward',
          color: 0xd97706,
          bases: 'A'.repeat(4),
          editablePbsEndpoint: true,
          isScarMarkerOnly: true,
        },
      ],
      sequence: 'A'.repeat(100),
    };

    overlay.loadGenome(genome);
    const { path, state } = renderOverlay(overlay, genome, 10);

    expect(overlay.lastRenderStats.roleCounts).toMatchObject({
      cleaved: 1,
      'scar-synthetic': 1,
      'scar-synthetic-spacer': 1,
      'scar-cognate': 1,
      tail: 1,
      spacer: 1,
      pbs: 1,
    });
    expect(overlay.lastRenderStats.drawnPrimers).toBe(1);
    expect(overlay.lastRenderStats.textGlyphs).toBe(24);
    expect(overlay.lastRenderStats.roleCounts['scar-marker']).toBeUndefined();
    expect(overlay.lastRenderStats.roleCounts['enzyme-site']).toBeUndefined();
    expect(overlay.lastRenderStats.hitRecords).toBe(1);
    expect(overlay.lastRenderStats.pbsHandles).toBe(0);
    expect(overlay.setPbsEndpointPreview(1_000_000_007, 56)).toBe(false);
    expect(
      overlay.hitTest(path.bpLeftX(52), path.featureLabelPosAt(52, 0).y, path, state)
    ).toBeNull();

    overlay.destroy();
  });

  it('aligns circular Golden Gate product highlights to nucleotide boundaries', () => {
    const overlay = new PrimerOverlay();
    const graphics = (
      overlay as unknown as {
        graphics: {
          poly: (points: number[]) => void;
        };
      }
    ).graphics;
    const polySpy = vi.spyOn(graphics, 'poly');
    const genome: Genome = {
      name: 'golden-gate-junction-boundary-contract',
      length: 100,
      circular: true,
      features: [],
      primers: [
        {
          id: 'scar-marker',
          renderId: 1_000_000_009,
          name: 'BsaI junction 1',
          start: 20,
          end: 24,
          direction: 'forward',
          color: 0xd97706,
          bases: 'AATG',
          overhangLength: 4,
          cutPositionInOverhang: 1,
          scarAbsolutePosition: 20,
          enzymeName: 'BsaI',
          junctionIndex: 0,
          isScarMarkerOnly: true,
        },
      ],
      sequence: 'A'.repeat(100),
    };

    overlay.loadGenome(genome);
    const { path } = renderCircularOverlay(overlay, genome, 2, 1);

    const scarPolygon = polySpy.mock.calls[0]?.[0];
    expect(scarPolygon).toBeDefined();
    if (!scarPolygon) throw new Error('expected Golden Gate scar polygon');
    const topStart = path.boundaryAt(20, 'cutTop');
    const topEnd = path.boundaryAt(24, 'cutTop');
    const bottomStart = path.boundaryAt(20, 'cutBottom');
    const topEndIndex = scarPolygon.length / 2 - 2;

    expect(scarPolygon[0]).toBeCloseTo(topStart.x, 5);
    expect(scarPolygon[1]).toBeCloseTo(topStart.y, 5);
    expect(scarPolygon[topEndIndex]).toBeCloseTo(topEnd.x, 5);
    expect(scarPolygon[topEndIndex + 1]).toBeCloseTo(topEnd.y, 5);
    expect(scarPolygon.at(-2)).toBeCloseTo(bottomStart.x, 5);
    expect(scarPolygon.at(-1)).toBeCloseTo(bottomStart.y, 5);

    const identityBox = polySpy.mock.calls[1]?.[0];
    expect(identityBox?.length).toBeGreaterThan(8);
    const visual = GOLDEN_GATE_JUNCTION_VISUAL.identityLabel;
    expect(identityBox).toEqual(
      labelBoxPolygonAtPath(
        path,
        21.5,
        'BsaI J1'.length * visual.fontSizePx * visual.monospaceCharacterWidthEm +
          visual.horizontalPaddingPx * 2,
        visual.fontSizePx + visual.verticalPaddingPx * 2
      )
    );
    const curved = (
      overlay as unknown as {
        curvedJunctionLabels?: { activeCount: number; activeRotations: number[] };
      }
    ).curvedJunctionLabels;
    expect(curved?.activeCount).toBe('BsaI J1'.length);
    expect(new Set(curved?.activeRotations.map((angle) => angle.toFixed(4))).size).toBeGreaterThan(
      1
    );

    overlay.destroy();
  });

  it('draws the shared Golden Gate product highlight, staggered cut, and identity box', () => {
    const overlay = new PrimerOverlay();
    const graphics = (
      overlay as unknown as {
        graphics: {
          fill: (style: { color: number; alpha: number }) => void;
        };
      }
    ).graphics;
    const fillSpy = vi.spyOn(graphics, 'fill');
    const genome: Genome = {
      name: 'golden-gate-junction-visual-contract',
      length: 100,
      circular: false,
      features: [],
      primers: [
        {
          id: 'scar-marker',
          renderId: 1_000_000_008,
          name: 'BsaI junction 1',
          start: 18,
          end: 22,
          direction: 'forward',
          color: 0xd97706,
          bases: 'AATG',
          overhangLength: 4,
          cutPositionInOverhang: 1,
          scarAbsolutePosition: 20,
          enzymeName: 'BsaI',
          junctionIndex: 0,
          isScarMarkerOnly: true,
        },
      ],
      sequence: 'A'.repeat(100),
    };

    overlay.loadGenome(genome);
    renderOverlay(overlay, genome, 10);

    expect(fillSpy).toHaveBeenCalledWith({
      color: GOLDEN_GATE_JUNCTION_VISUAL.productScar.fillColorPixi,
      alpha: GOLDEN_GATE_JUNCTION_VISUAL.productScar.fillAlpha,
    });
    expect(overlay.lastRenderStats).toMatchObject({
      junctionScarHighlights: 1,
      junctionCutIndicators: 1,
      junctionIdentityLabels: 1,
      firstJunction: {
        primerId: 'scar-marker',
        scarStart: 20,
        scarEnd: 24,
        identityLabel: 'BsaI J1',
      },
      drawnJunctions: [
        {
          primerId: 'scar-marker',
          scarStart: 20,
          scarEnd: 24,
          identityLabel: 'BsaI J1',
        },
      ],
    });
    const visibleLabels = (
      overlay as unknown as {
        junctionLabelPool: Array<{ visible: boolean; text: string }>;
      }
    ).junctionLabelPool.filter((label) => label.visible);
    expect(visibleLabels.map((label) => label.text)).toEqual(['BsaI J1']);

    overlay.destroy();
  });
});
