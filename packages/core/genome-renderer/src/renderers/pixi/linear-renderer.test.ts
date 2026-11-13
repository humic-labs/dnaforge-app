// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
vi.mock('./shared/canvas-middle-text', () => ({ canvasMiddleTextAnchorY: () => 0.5 }));
import { Application, Container, Graphics, Point } from 'pixi.js';
import { PixiLinearRenderer } from './linear-renderer';
import { canvasCdsMetrics } from '@waypoint/platform';
import { IndexedPixiLinearRenderer } from './indexed-linear-renderer';
import type { Genome, RenderState } from '../../types';
import {
  MAX_INDEXED_LINEAR_SEQUENCE_PIXELS_PER_BP,
  STABILITY_SEQUENCE_DETAIL_FRACTION,
  sequenceFullViewportPixelsPerBp,
  type UnifiedLayout,
} from './shared/track-layout';
import {
  getInteractionLaneEnvelope,
  resolveInteractionOverlayContract,
} from './shared/lane-contracts';
import { LINEAR_EDGE_OVERSCROLL_VIEWPORT_FRACTION } from './shared/linear-viewport';
import {
  PixiCytobandTrackRenderer,
  type PixiLinearTrackRenderer,
  type TrackPaintArgs,
} from './linear-tracks';
import {
  CYTOBAND_REQUIRED_TRACK_HEIGHT_PX,
  CYTOBAND_TYPE,
  GENERIC_INTERVAL_TYPE,
  type Track,
} from '../../tracks';
import type { Chromosome } from '../../chromosome';
import { AnnotationOverlay } from './overlays/annotation-overlay';
import type { CodonTrack } from './tracks/codon-track';

function codonDebugSnapshot(renderer: PixiLinearRenderer) {
  return (
    renderer.getRendererDebugSnapshot() as {
      codonTrack: ReturnType<CodonTrack['getDebugSnapshot']>;
    }
  ).codonTrack;
}

function createState(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 10,
    width: 800,
    height: 300,
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: [100, 200],
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

function createGenome(): Genome {
  return {
    name: 'linear-viewport-scrollbar-test',
    length: 1000,
    circular: false,
    features: [],
    sequence: 'A'.repeat(1000),
  };
}

function createGenomeWithPrimer(): Genome {
  return {
    ...createGenome(),
    primers: [
      {
        id: 'linear-primer',
        renderId: 1_000_000_010,
        name: 'Linear Primer',
        start: 100,
        end: 130,
        direction: 'forward',
        color: 0xd97706,
        bases: 'A'.repeat(30),
        mismatches: [],
      },
    ],
  };
}

function createChromosome(): Chromosome {
  return {
    id: 'chr-test',
    displayName: 'chr-test',
    length: 1000,
    cytobands: [],
  };
}

describe('PixiLinearRenderer render-loop guards  frozen-frame)', () => {
  it('keeps the lower edges of aligned nucleotide cells in their own DNA source', async () => {
    const state = createState();
    state.sequencePresentation = { alignedQuery: 'C'.repeat(1000) };
    const renderer = new PixiLinearRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      createGenome(),
      () => state
    );
    try {
      renderer.render(state);
      const layout = (renderer as unknown as { _overlayLayout: UnifiedLayout })._overlayLayout;
      Object.assign(renderer.sequenceTrack, {
        getLinearComparisonRowBounds: () => ({
          forward: { top: layout.fwdStrandTop + 3, bottom: layout.fwdStrandBottom + 3 },
          secondary: { top: layout.revStrandTop + 3, bottom: layout.revStrandBottom + 3 },
        }),
      });
      expect(renderer.getSequenceRowAt(layout.fwdStrandBottom + 1)).toBe('forward');
      expect(renderer.getSequenceRowAt(layout.revStrandBottom + 1)).toBe('secondary');
      expect(renderer.getSequenceRowAt(layout.fwdStrandTop + 1)).toBeNull();
    } finally {
      renderer.destroy();
    }
  });

  it('uses native sequence rows and invalidates layout when complement visibility changes', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      createGenome(),
      () => state
    );
    const sequenceSpy = vi.spyOn(renderer.sequenceTrack, 'renderLinear');
    state.sequencePresentation = { showReverseComplement: false };
    renderer.render(state);
    const single = (renderer as unknown as { _overlayLayout: UnifiedLayout })._overlayLayout;
    expect(single.revStrandBottom).toBe(single.fwdStrandBottom);
    expect(renderer.getSequenceRowAt(single.fwdStrandCenter)).toBe('forward');
    expect(renderer.getSequenceRowAt(single.revStrandCenter)).not.toBe('secondary');
    expect(sequenceSpy.mock.calls.at(-1)?.[4]).toBe(state.sequencePresentation);
    state.sequencePresentation = { showReverseComplement: false, alignedQuery: 'C'.repeat(1000) };
    renderer.render(state);
    const paired = (renderer as unknown as { _overlayLayout: UnifiedLayout })._overlayLayout;
    expect(paired.revStrandBottom).toBeGreaterThan(paired.fwdStrandBottom);
    expect(renderer.getSequenceRowAt(paired.revStrandCenter)).toBe('secondary');
    renderer.destroy();
  });

  it('translates ungapped resulting DNA through supplied columns and skips removed coding ghosts', async () => {
    const feature = {
      id: 0,
      type: 'CDS',
      start: 0,
      end: 6,
      direction: 'forward' as const,
      displayName: 'coding',
      color: 0x338855,
      lane: 0,
      cdsLane: 0,
    };
    const biologicalGenome: Genome = {
      name: 'result',
      length: 6,
      circular: false,
      sequence: 'ATGAAA',
      features: [feature],
    };
    const displayGenome: Genome = {
      ...biologicalGenome,
      length: 7,
      sequence: 'AT-GAAA',
      features: [{ ...feature, end: 7 }],
    };
    const columns = [0, 1, 3, 4, 5, 6];
    const state = {
      ...createState(),
      viewportRange: [0, 7] as [number, number],
      sequencePresentation: {
        alignedQuery: 'ATCGAAA',
        biologicalGenome,
        bioToColumn: (base: number) => columns[base] ?? null,
        columnToBio: (column: number) => {
          const base = columns.indexOf(column);
          return base < 0 ? null : base;
        },
      },
    };
    const renderer = new PixiLinearRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      displayGenome,
      () => state
    );
    const codonTrack = (
      renderer as unknown as { codonTrack: { renderCodons: (...args: unknown[]) => void } }
    ).codonTrack;
    const codonSpy = vi.spyOn(codonTrack, 'renderCodons');
    renderer.render(state);
    expect(codonSpy.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          startBp: 0,
          endBp: 2,
          codon: 'ATG',
          aa: 'M',
          codonStartBp: 0,
          codonEndBp: 3,
        }),
        expect.objectContaining({
          startBp: 3,
          endBp: 4,
          codon: 'ATG',
          aa: 'M',
          renderLetter: false,
        }),
      ])
    );
    codonSpy.mockClear();
    state.annotationChangeDecorations = new Map([[0, { kind: 'removed' as const }]]);
    renderer.render(state);
    expect(codonSpy).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it('uses source-coordinate labels in the native ruler and omits a display-only gap tick', async () => {
    const state = { ...createState(), viewportRange: [0, 6] as [number, number] };
    const genome: Genome = {
      name: 'comparison-ruler',
      length: 6,
      circular: false,
      features: [],
      sequence: 'AT-GAA',
      formatRulerLabel: (column) => (column === 2 ? null : `reference:${100 + column}`),
    };
    const renderer = new PixiLinearRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      genome,
      () => state
    );
    renderer.render(state);
    const topology = () =>
      (renderer as unknown as { rulerTickTopology: { labels: { text: string }[] } })
        .rulerTickTopology;
    expect(topology().labels.map((label) => label.text)).toContain('reference:100');
    expect(topology().labels.map((label) => label.text)).not.toContain('reference:102');
    renderer.loadGenome({ ...genome, formatRulerLabel: (column) => `updated:${column}` });
    renderer.render(state);
    expect(topology().labels.map((label) => label.text)).toContain('updated:0');
    renderer.destroy();
  });
  it('maps the terminal between-base boundary without clamping it to the final base', async () => {
    const state = { ...createState(), zoom: 1 };
    const renderer = new PixiLinearRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      createGenome(),
      () => state
    );
    expect(renderer.screenToBoundaryBp?.(800, 0, state)).toBe(1000);
    expect(renderer.screenToBoundaryBp?.(160, 0, state)).toBe(200);
    expect(renderer.screenToBp(800, 0, state)).toBe(999);
    renderer.destroy();
  });
  it('prepares registered track programs at renderer init and immediately after init', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const gpuRenderer = {};
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: gpuRenderer,
    } as unknown as Application;
    const prepareBeforeInit = vi.fn();
    const prepareAfterInit = vi.fn();
    const track = (type: string, prepareGpuPrograms: (renderer: never) => void) => ({
      type,
      prepareGpuPrograms,
      mount: () => new Container(),
      paint: () => undefined,
      unmount: () => undefined,
    });

    renderer.registerTrack(track('pre-init-program', prepareBeforeInit) as never);
    expect(prepareBeforeInit).not.toHaveBeenCalled();
    await renderer.init(app, createGenome(), () => state);
    expect(prepareBeforeInit).toHaveBeenCalledOnce();
    expect(prepareBeforeInit).toHaveBeenCalledWith(gpuRenderer);

    renderer.registerTrack(track('post-init-program', prepareAfterInit) as never);
    expect(prepareAfterInit).toHaveBeenCalledOnce();
    expect(prepareAfterInit).toHaveBeenCalledWith(gpuRenderer);
  });

  it('a genome-unset frame is a clean no-op, not a throw (no frozen/fatal-freeze)', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, createGenome(), () => state);
    renderer.render(state);

    (renderer as unknown as { genome: Genome | undefined }).genome = undefined;

    expect(() => renderer.render(state)).not.toThrow();
  });
});

describe('PixiLinearRenderer vertical track scrolling', () => {
  it('clamps the complete stack and changes no horizontal camera state', async () => {
    const state = { ...createState(), height: 120, viewOffset: 0.25 };
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const genome: Genome = {
      ...createGenome(),
      annotationLayout: { maxAnnotationLane: 19, maxCdsLane: -1 },
    };

    await renderer.init(app, genome, () => state);
    renderer.render(state);
    const initial = (renderer as unknown as { _overlayLayout: UnifiedLayout })._overlayLayout;

    expect(renderer.canScrollTracksVertically()).toBe(true);
    expect(initial.trackScrollTop).toBe(initial.maxTrackScrollTop);
    expect(renderer.scrollTracksBy(-40)).toBe(true);
    renderer.render(state);

    const scrolled = (renderer as unknown as { _overlayLayout: UnifiedLayout })._overlayLayout;
    expect(scrolled.trackScrollTop).toBe(initial.trackScrollTop - 40);
    expect(scrolled.fwdStrandTop).toBe(initial.fwdStrandTop + 40);
    expect(state.viewOffset).toBe(0.25);

    expect(renderer.scrollTracksBy(-1_000_000)).toBe(true);
    renderer.render(state);
    expect(renderer.scrollTracksBy(-1)).toBe(false);
    expect(
      (renderer as unknown as { _overlayLayout: UnifiedLayout })._overlayLayout.trackScrollTop
    ).toBe(0);
  });

  it('keeps an above-legacy cytoband pinned at viewport Y=0 while the stack scrolls', async () => {
    const state = { ...createState(), height: 120 };
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const genome: Genome = {
      ...createGenome(),
      annotationLayout: { maxAnnotationLane: 19, maxCdsLane: -1 },
    };
    const cytoband: Track = {
      id: 'cytoband-pinned',
      type: CYTOBAND_TYPE.type,
      order: 0,
      visible: true,
      assemblyId: 'test',
      zone: 'above-legacy',
      sizing: CYTOBAND_TYPE.defaultSizing,
    };

    await renderer.init(app, genome, () => state);
    renderer.setChromosome(createChromosome());
    renderer.registerTrack(new PixiCytobandTrackRenderer());
    renderer.setTrackInstances([cytoband]);
    renderer.render(state);
    expect(renderer.canScrollTracksVertically()).toBe(true);

    const before = renderer.getRendererDebugSnapshot() as {
      laneContract: {
        overlayLayout: { trackScrollTop: number; fwdStrandTop: number };
        trackScreenBounds: Record<string, { topPx: number }>;
      };
    };
    expect(before.laneContract.overlayLayout.trackScrollTop).toBe(0);
    expect(before.laneContract.trackScreenBounds[cytoband.id].topPx).toBe(0);
    expect(renderer.getPresentedTrackScrollReceipt()).toEqual({
      completedFrameEpoch: 1,
      trackScrollTop: 0,
    });

    expect(renderer.scrollTracksBy(40)).toBe(true);
    renderer.render(state);
    const after = renderer.getRendererDebugSnapshot() as typeof before;

    expect(after.laneContract.overlayLayout.trackScrollTop).toBe(40);
    expect(after.laneContract.overlayLayout.fwdStrandTop).toBe(
      before.laneContract.overlayLayout.fwdStrandTop - 40
    );
    expect(after.laneContract.trackScreenBounds[cytoband.id].topPx).toBe(0);
    expect(renderer.getPresentedTrackScrollReceipt()).toEqual({
      completedFrameEpoch: 2,
      trackScrollTop: 40,
    });
  });
});

describe('IndexedPixiLinearRenderer compiled annotation product routing', () => {
  it('forwards the manifest identity for per-type demand and targeted disposal', () => {
    const renderer = new IndexedPixiLinearRenderer();
    const overlay = Reflect.get(renderer, 'annotationOverlay') as AnnotationOverlay;
    const demandSpy = vi.spyOn(overlay, 'getCompiledBroadSurfaceDemand');
    const demandRefreshSpy = vi
      .spyOn(overlay, 'isCompiledBroadSurfaceDemandRefreshRequired')
      .mockReturnValue(true);
    const clearSpy = vi.spyOn(overlay, 'clearCompiledBroadSurfaceManifest');
    const policy = { isoformMode: 'canonical' as const, laneLimit: 12 };
    const fingerprint = 'f'.repeat(64);

    renderer.getCompiledBroadSurfaceDemand(policy, fingerprint);
    expect(demandSpy).toHaveBeenCalledWith(policy, fingerprint);
    expect(renderer.isCompiledBroadSurfaceDemandRefreshRequired(policy, fingerprint)).toBe(true);
    expect(demandRefreshSpy).toHaveBeenCalledWith(policy, fingerprint);

    renderer.clearCompiledBroadSurfaceManifest(fingerprint);
    expect(clearSpy).toHaveBeenCalledWith(fingerprint);
  });
});

describe('PixiLinearRenderer track diagnostics', () => {
  it('attaches the owning track bounds to hovered and re-anchored reads', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    let bodyTop = 0;
    const readHit = () => ({
      trackId: 'read-track',
      sourceGenerationKey: 'generation-1',
      readId: 'read-1',
      chrom: 'chr-test',
      referenceStart: 100,
      start: 100,
      end: 140,
      strand: '+' as const,
      mapq: 60,
      bodyRect: { left: 200, top: bodyTop, width: 120, height: 8 },
      screenX: 240,
      screenY: bodyTop + 4,
    });
    const trackRenderer = {
      type: 'read-hit-test',
      mount: () => new Container(),
      paint: () => undefined,
      unmount: () => undefined,
      hitTestReadEvent: vi.fn(() => readHit()),
      locateRead: vi.fn(() => readHit()),
    };
    const track: Track = {
      id: 'read-track',
      type: trackRenderer.type,
      order: 0,
      visible: true,
      assemblyId: 'test',
      zone: 'below-legacy',
      sizing: { kind: 'fixed', pixels: 40 },
    };

    await renderer.init(app, createGenome(), () => state);
    renderer.setChromosome(createChromosome());
    renderer.registerTrack(trackRenderer);
    renderer.setTrackInstances([track]);
    renderer.setTrackData(track.id, { records: [] });
    renderer.render(state);

    const bounds = renderer.getLaneScreenSnapshot().trackScreenBounds[track.id]!;
    bodyTop = bounds.topPx + 4;
    const hovered = renderer.hitTestReadEvent(240, bodyTop + 4);
    expect(hovered?.trackRect).toEqual({
      left: 0,
      top: bounds.topPx,
      width: state.width,
      height: bounds.heightPx,
    });
    expect(renderer.locateRead(hovered!)?.trackRect).toEqual(hovered?.trackRect);

    renderer.destroy();
  });

  it('reuses vertical geometry through broad camera motion and invalidates on semantic changes', async () => {
    const state = { ...createState(), zoom: 1, viewOffset: 0 };
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const genome: Genome = {
      ...createGenome(),
      length: 1_000_000_000,
      sequence: '',
      sequenceAvailable: true,
    };
    const internals = renderer as unknown as {
      unifiedLayoutComputeCount: number;
      _overlayLayout: UnifiedLayout;
    };

    await renderer.init(app, genome, () => state);
    renderer.render(state);
    const broadLayout = internals._overlayLayout;
    expect(internals.unifiedLayoutComputeCount).toBe(1);

    state.zoom = 10;
    state.viewOffset = 0.25;
    renderer.render(state);
    state.zoom = 100;
    state.viewOffset = 0.75;
    renderer.render(state);

    expect(internals.unifiedLayoutComputeCount).toBe(1);
    expect(internals._overlayLayout).toBe(broadLayout);

    state.showResidueNumbers = true;
    renderer.render(state);
    expect(internals.unifiedLayoutComputeCount).toBe(2);

    state.zoom = 50_000;
    renderer.render(state);
    expect(internals.unifiedLayoutComputeCount).toBe(3);
  });

  it('retains registered-track geometry across camera-only frames', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const track: Track = {
      id: 'retained-layout-track',
      type: 'retained-layout-track',
      order: 0,
      visible: true,
      assemblyId: 'test',
      sizing: { kind: 'fixed', pixels: 24 },
    };
    const internals = renderer as unknown as {
      registeredTrackLayoutComputeCount: number;
    };

    await renderer.init(app, createGenome(), () => state);
    renderer.setTrackInstances([track]);
    renderer.render(state);
    expect(internals.registeredTrackLayoutComputeCount).toBe(1);

    state.zoom = 20;
    state.viewOffset = 0.25;
    renderer.render(state);
    state.zoom = 5;
    state.viewOffset = 0.75;
    renderer.render(state);
    expect(internals.registeredTrackLayoutComputeCount).toBe(1);

    state.height += 1;
    renderer.render(state);
    expect(internals.registeredTrackLayoutComputeCount).toBe(2);

    renderer.setTrackInstances([{ ...track, order: 1 }]);
    renderer.render(state);
    expect(internals.registeredTrackLayoutComputeCount).toBe(3);
  });

  it('reorders data-track presentation without remounting containers or replacing data', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const mount = vi.fn(() => new Container());
    const unmount = vi.fn();
    const trackRenderer: PixiLinearTrackRenderer = {
      type: 'reorder-track',
      mount,
      paint: () => undefined,
      unmount,
    };
    const first: Track = {
      id: 'signal',
      type: trackRenderer.type,
      order: 0,
      visible: true,
      assemblyId: 'test',
      zone: 'below-legacy',
      sizing: { kind: 'fixed', pixels: 24 },
    };
    const second: Track = {
      ...first,
      id: 'interval',
      order: 1,
      sizing: { kind: 'fixed', pixels: 60 },
    };

    await renderer.init(app, createGenome(), () => state);
    renderer.setChromosome(createChromosome());
    renderer.registerTrack(trackRenderer);
    renderer.setTrackInstances([first, second]);
    renderer.setTrackData(first.id, { records: [{ value: 1 }] });
    renderer.setTrackData(second.id, { records: [{ value: 2 }] });
    renderer.render(state);
    const before = renderer.getLaneScreenSnapshot().trackScreenBounds;
    expect(before[first.id]!.topPx).toBeLessThan(before[second.id]!.topPx);
    expect(mount).toHaveBeenCalledTimes(2);

    expect(renderer.setTrackPresentationOrder([second.id, first.id])).toBe(true);
    renderer.render(state);
    const after = renderer.getLaneScreenSnapshot().trackScreenBounds;
    expect(after[second.id]!.topPx).toBeLessThan(after[first.id]!.topPx);
    expect(after[first.id]!.heightPx).toBe(24);
    expect(after[second.id]!.heightPx).toBe(60);
    expect(mount).toHaveBeenCalledTimes(2);
    expect(unmount).not.toHaveBeenCalled();
    expect(renderer.hasTrackData(first.id)).toBe(true);
    expect(renderer.hasTrackData(second.id)).toBe(true);

    expect(renderer.setTrackPresentationOrder([first.id])).toBe(false);
    expect(renderer.setTrackPresentationOrder([first.id, first.id])).toBe(false);
    renderer.render(state);
    expect(renderer.getLaneScreenSnapshot().trackScreenBounds[second.id]!.topPx).toBe(
      after[second.id]!.topPx
    );
  });

  it('routes track pointer movement and exit through the renderer hover contract', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const mounted = new Container();
    const updateHover = vi.fn();
    const clearHover = vi.fn();
    const trackRenderer = {
      type: 'hover-track',
      mount: () => mounted,
      paint: () => undefined,
      updateHover,
      clearHover,
      unmount: () => undefined,
    } as unknown as PixiLinearTrackRenderer;
    const track: Track = {
      id: 'hover-track-1',
      type: trackRenderer.type,
      order: 0,
      visible: true,
      assemblyId: 'test',
      zone: 'above-legacy',
      sizing: { kind: 'fixed', pixels: 32 },
    };

    await renderer.init(app, createGenome(), () => state);
    renderer.setChromosome(createChromosome());
    renderer.registerTrack(trackRenderer);
    renderer.setTrackInstances([track]);
    renderer.render(state);

    mounted.emit('pointermove', { global: new Point(123, 5) } as never);
    expect(updateHover).toHaveBeenCalledOnce();
    expect(updateHover).toHaveBeenCalledWith(
      expect.objectContaining({
        container: mounted,
        localX: 123,
        localY: 5,
        viewportWidthPx: 800,
        viewportBpRange: expect.objectContaining({
          start: expect.any(Number),
          end: expect.any(Number),
        }),
      })
    );

    mounted.emit('pointerout', {} as never);
    expect(clearHover).toHaveBeenCalledOnce();
    expect(clearHover).toHaveBeenCalledWith(mounted);
  });

  it('unmounts every mounted registered track when the renderer is destroyed', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const mountedContainers = [new Container(), new Container()];
    const mount = vi
      .fn<() => Container>()
      .mockReturnValueOnce(mountedContainers[0])
      .mockReturnValueOnce(mountedContainers[1]);
    const unmount = vi.fn((container: Container) => container.destroy({ children: true }));
    const trackRenderer: PixiLinearTrackRenderer = {
      type: 'destroy-track',
      mount,
      paint: () => undefined,
      unmount,
    };
    const first: Track = {
      id: 'destroy-track-1',
      type: trackRenderer.type,
      order: 0,
      visible: true,
      assemblyId: 'test',
      zone: 'below-legacy',
      sizing: { kind: 'fixed', pixels: 24 },
    };
    const second: Track = { ...first, id: 'destroy-track-2', order: 1 };

    await renderer.init(app, createGenome(), () => state);
    renderer.setChromosome(createChromosome());
    renderer.registerTrack(trackRenderer);
    renderer.setTrackInstances([first, second]);
    renderer.render(state);
    expect(mount).toHaveBeenCalledTimes(2);
    expect(mountedContainers.every((container) => container.parent === app.stage)).toBe(true);

    renderer.destroy();

    expect(unmount).toHaveBeenCalledTimes(2);
    expect(unmount).toHaveBeenCalledWith(mountedContainers[0]);
    expect(unmount).toHaveBeenCalledWith(mountedContainers[1]);
    expect(mountedContainers.every((container) => container.parent === null)).toBe(true);
    expect(app.stage.children).toHaveLength(0);
  });

  it('releases every registered track before reporting multiple teardown failures', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const mountedContainers = [new Container(), new Container()];
    const firstFailure = new Error('first teardown failed');
    const secondFailure = new Error('second teardown failed');
    const unmount = vi
      .fn<(container: Container) => void>()
      .mockImplementationOnce(() => {
        throw firstFailure;
      })
      .mockImplementationOnce(() => {
        throw secondFailure;
      });
    const trackRenderer: PixiLinearTrackRenderer = {
      type: 'failing-destroy-track',
      mount: vi
        .fn<() => Container>()
        .mockReturnValueOnce(mountedContainers[0])
        .mockReturnValueOnce(mountedContainers[1]),
      paint: () => undefined,
      unmount,
    };
    const first: Track = {
      id: 'failing-destroy-track-1',
      type: trackRenderer.type,
      order: 0,
      visible: true,
      assemblyId: 'test',
      zone: 'below-legacy',
      sizing: { kind: 'fixed', pixels: 24 },
    };
    const second: Track = { ...first, id: 'failing-destroy-track-2', order: 1 };

    await renderer.init(app, createGenome(), () => state);
    renderer.setChromosome(createChromosome());
    renderer.registerTrack(trackRenderer);
    renderer.setTrackInstances([first, second]);
    renderer.render(state);

    let thrown: unknown;
    try {
      renderer.destroy();
    } catch (error) {
      thrown = error;
    }

    expect(unmount).toHaveBeenCalledTimes(2);
    expect(mountedContainers.every((container) => container.destroyed)).toBe(true);
    expect(mountedContainers.every((container) => container.parent === null)).toBe(true);
    expect(thrown).toMatchObject({
      message: 'PixiLinearRenderer: multiple registered track teardowns failed',
      errors: [firstFailure, secondFailure],
    });
  });

  it('sizes fit-content tracks from shared renderer presentation and invalidates on data change', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const trackRenderer: PixiLinearTrackRenderer = {
      type: 'measured-track',
      mount: () => new Container(),
      measureContentHeight: (args) =>
        ((args.data as { rows?: number } | null)?.rows ?? 0) * (args.presentation.rowHeightPx ?? 8),
      paint: () => undefined,
      unmount: () => undefined,
    };
    const track: Track = {
      id: 'measured-track-1',
      type: trackRenderer.type,
      order: 0,
      visible: true,
      assemblyId: 'test',
      zone: 'below-legacy',
      sizing: { kind: 'fitContent', minHeight: 18, maxHeight: 192 },
      rowHeightPx: 8,
      maxRows: 32,
      color: '#2563eb',
    };

    await renderer.init(app, createGenome(), () => state);
    renderer.setChromosome(createChromosome());
    renderer.registerTrack(trackRenderer);
    renderer.setTrackInstances([track]);
    renderer.setTrackData(track.id, { rows: 3 });
    renderer.render(state);

    expect(renderer.getLaneScreenSnapshot().trackScreenBounds[track.id]?.heightPx).toBe(24);

    renderer.setTrackData(track.id, { rows: 1 });
    renderer.render(state);
    expect(renderer.getLaneScreenSnapshot().trackScreenBounds[track.id]?.heightPx).toBe(18);
  });

  it('presents a sparse managed interval at the shared interactive-row minimum', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const trackRenderer: PixiLinearTrackRenderer = {
      type: GENERIC_INTERVAL_TYPE.type,
      mount: () => new Container(),
      measureContentHeight: () => 18,
      paint: () => undefined,
      unmount: () => undefined,
    };
    const track: Track = {
      id: 'cpg-islands',
      type: GENERIC_INTERVAL_TYPE.type,
      order: 0,
      visible: true,
      assemblyId: 'grch38',
      zone: 'below-legacy',
      sizing: GENERIC_INTERVAL_TYPE.defaultSizing,
      color: '#2563eb',
    };

    await renderer.init(app, createGenome(), () => state);
    renderer.setChromosome(createChromosome());
    renderer.registerTrack(trackRenderer);
    renderer.setTrackInstances([track]);
    renderer.setTrackData(track.id, { records: [{ chrom: 'chr1', start: 10, end: 20 }] });
    renderer.render(state);

    expect(renderer.getLaneScreenSnapshot().trackScreenBounds[track.id]?.heightPx).toBe(60);
  });

  it('removes whole-height alternate guides when their BAM track is hidden', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const track: Track = {
      id: 'pileup-guides',
      type: 'pileup-test',
      order: 0,
      visible: true,
      assemblyId: 'test',
      sizing: { kind: 'fixed', pixels: 24 },
    };
    const alternateColumn = {
      pos: 144,
      kind: 'sub' as const,
      length: 1,
      refBase: 'C',
      readBase: 'T',
      coveringReadCount: 10,
      supportingReadCount: 4,
      weightedDepth: 9.8,
      weightedSupport: 3.9,
      weightedFraction: 0.398,
    };

    await renderer.init(app, createGenome(), () => state);
    renderer.setTrackInstances([track]);
    renderer.setTrackData(track.id, { records: [], alternateColumns: [alternateColumn] });
    renderer.render(state);
    expect(renderer.getPileupGlobalGuideDiagnostics().columnCount).toBe(1);

    renderer.setTrackInstances([{ ...track, visible: false }]);
    renderer.render(state);
    expect(renderer.getPileupGlobalGuideDiagnostics().columnCount).toBe(0);
    expect(renderer.getPileupGlobalGuideDiagnostics().visible).toBe(false);

    renderer.destroy();
  });

  it('clips mutation guides below the chromosome overview', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const cytoband: Track = {
      id: 'cytoband-mutation-guide-boundary',
      type: CYTOBAND_TYPE.type,
      order: 0,
      visible: true,
      assemblyId: 'test',
      zone: 'above-legacy',
      sizing: CYTOBAND_TYPE.defaultSizing,
    };
    const pileup: Track = {
      id: 'pileup-mutation-guide-boundary',
      type: 'pileup-test',
      order: 1,
      visible: true,
      assemblyId: 'test',
      zone: 'below-legacy',
      sizing: { kind: 'fixed', pixels: 24 },
    };

    await renderer.init(app, createGenome(), () => state);
    renderer.setChromosome(createChromosome());
    renderer.registerTrack(new PixiCytobandTrackRenderer());
    renderer.setTrackInstances([cytoband, pileup]);
    renderer.setTrackData(pileup.id, {
      records: [],
      alternateColumns: [
        {
          pos: 144,
          kind: 'sub',
          length: 1,
          refBase: 'C',
          readBase: 'T',
          coveringReadCount: 10,
          supportingReadCount: 4,
          weightedDepth: 9.8,
          weightedSupport: 3.9,
          weightedFraction: 0.398,
        },
      ],
    });
    renderer.render(state);

    expect(renderer.getPileupGlobalGuideDiagnostics()).toMatchObject({
      visible: true,
      topPx: CYTOBAND_REQUIRED_TRACK_HEIGHT_PX,
      bottomPx: state.height,
    });

    renderer.destroy();
  });

  it('exposes allocation-free lane membership behind a monotonic revision', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const track: Track = {
      id: 'revision-track-1',
      type: 'revision-track',
      order: 0,
      visible: true,
      assemblyId: 'test',
      sizing: { kind: 'fixed', pixels: 24 },
    };

    await renderer.init(app, createGenome(), () => state);
    expect(renderer.getLaneContractRevision()).toBe(0);
    expect(renderer.hasTrackInstance(track.id)).toBe(false);
    expect(renderer.hasTrackData(track.id)).toBe(false);

    renderer.setTrackInstances([track]);
    expect(renderer.getLaneContractRevision()).toBe(1);
    expect(renderer.hasTrackInstance(track.id)).toBe(true);

    renderer.setTrackData(track.id, { records: [] });
    expect(renderer.getLaneContractRevision()).toBe(2);
    expect(renderer.hasTrackData(track.id)).toBe(true);

    let prior: { records: unknown[]; cutoff?: number } | null = null;
    expect(
      renderer.updateTrackData<{ records: unknown[]; cutoff?: number }>(track.id, (current) => {
        prior = current;
        return { ...current, cutoff: 125 };
      })
    ).toBe(true);
    expect(prior).toEqual({ records: [] });
    expect(renderer.getLaneContractRevision()).toBe(3);
  });

  it('exposes one mounted track diagnostic without requiring the full renderer snapshot', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const trackRenderer: PixiLinearTrackRenderer & {
      paintCalls: number;
      getDiagnostics: (container: Container) => object | null;
    } = {
      type: 'diagnostic-track',
      paintCalls: 0,
      mount: () => new Container(),
      unmount: () => undefined,
      paint(args: TrackPaintArgs) {
        this.paintCalls += 1;
        args.container.label = 'diagnostic-mounted';
      },
      getDiagnostics(container: Container) {
        return { paintCalls: this.paintCalls, containerLabel: container.label };
      },
    };
    const track: Track = {
      id: 'diagnostic-track-1',
      type: 'diagnostic-track',
      order: 0,
      visible: true,
      assemblyId: 'test',
      zone: 'below-legacy',
      sizing: { kind: 'fixed', pixels: 24 },
    };

    await renderer.init(app, createGenome(), () => state);
    renderer.setChromosome(createChromosome());
    renderer.registerTrack(trackRenderer);
    renderer.setTrackInstances([track]);
    renderer.render(state);

    expect(renderer.getTrackDiagnostics('diagnostic-track-1')).toEqual({
      paintCalls: 1,
      containerLabel: 'diagnostic-mounted',
    });
    expect(renderer.getTrackDiagnostics('missing-track')).toBeNull();
  });

  it('keeps the complete cytoband label box above annotations across camera changes', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const genome: Genome = {
      ...createGenome(),
      annotationLayout: { maxAnnotationLane: 0, maxCdsLane: -1 },
    };
    const track: Track = {
      id: 'cytoband-clearance',
      type: CYTOBAND_TYPE.type,
      order: 0,
      visible: true,
      assemblyId: 'test',
      zone: 'above-legacy',
      sizing: CYTOBAND_TYPE.defaultSizing,
    };

    await renderer.init(app, genome, () => state);
    renderer.setChromosome(createChromosome());
    renderer.registerTrack(new PixiCytobandTrackRenderer());
    renderer.setTrackInstances([track]);

    const assertClearance = () => {
      renderer.render(state);
      const snapshot = renderer.getRendererDebugSnapshot() as {
        laneContract: {
          trackScreenBounds: Record<string, { topPx: number; heightPx: number; bottomPx: number }>;
        };
      };
      const diagnostics = renderer.getTrackDiagnostics(track.id) as {
        labelTopPx: number;
        labelBottomPx: number;
        contentBottomPx: number;
        overflowPx: number;
        labelsFit: boolean;
      };
      const layout = (renderer as unknown as { _overlayLayout: UnifiedLayout | null })
        ._overlayLayout;
      const bounds = snapshot.laneContract.trackScreenBounds[track.id];

      expect(diagnostics).toMatchObject({
        labelTopPx: 16,
        labelBottomPx: 30,
        contentBottomPx: CYTOBAND_REQUIRED_TRACK_HEIGHT_PX,
        overflowPx: 0,
        labelsFit: true,
      });
      expect(bounds).toEqual({
        topPx: 0,
        heightPx: CYTOBAND_REQUIRED_TRACK_HEIGHT_PX,
        bottomPx: CYTOBAND_REQUIRED_TRACK_HEIGHT_PX,
        scrollsVertically: false,
      });
      expect(layout).not.toBeNull();
      expect(layout!.annotationTop).toBeGreaterThanOrEqual(
        bounds.topPx + diagnostics.contentBottomPx
      );
    };

    assertClearance();
    state.zoom = 2;
    state.viewOffset = 0.35;
    assertClearance();
  });

  it('does not move below-legacy tracks when a sequence window becomes resident', async () => {
    const state = createState();
    state.zoom = 10;
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const trackRenderer: PixiLinearTrackRenderer = {
      type: 'sequence-stability-track',
      mount: () => new Container(),
      unmount: () => undefined,
      paint: () => undefined,
    };
    const track: Track = {
      id: 'sequence-stability-track-1',
      type: 'sequence-stability-track',
      order: 0,
      visible: true,
      assemblyId: 'test',
      zone: 'below-legacy',
      sizing: { kind: 'fixed', pixels: 24 },
    };
    const genome: Genome = {
      name: 'indexed-sequence-capability-test',
      length: 1000,
      circular: false,
      features: [],
      sequenceAvailable: true,
    };

    await renderer.init(app, genome, () => state);
    renderer.setChromosome(createChromosome());
    renderer.registerTrack(trackRenderer);
    renderer.setTrackInstances([track]);
    renderer.render(state);
    const before = renderer.getRendererDebugSnapshot() as {
      laneContract: {
        trackScreenBounds: Record<string, { topPx: number }>;
      };
    };

    renderer.setSequenceWindow({ startBp: 0, bases: 'A'.repeat(1000) });
    renderer.render(state);
    const after = renderer.getRendererDebugSnapshot() as {
      laneContract: {
        trackScreenBounds: Record<string, { topPx: number }>;
      };
    };

    expect(before.laneContract.trackScreenBounds[track.id]?.topPx).toBeDefined();
    expect(after.laneContract.trackScreenBounds[track.id]?.topPx).toBe(
      before.laneContract.trackScreenBounds[track.id]!.topPx
    );
  });

  it('does not move below-legacy tracks when zoom crosses the sequence reveal boundary', async () => {
    const state = createState();
    state.zoom = 0.05;
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const trackRenderer: PixiLinearTrackRenderer = {
      type: 'sequence-zoom-stability-track',
      mount: () => new Container(),
      unmount: () => undefined,
      paint: () => undefined,
    };
    const track: Track = {
      id: 'sequence-zoom-stability-track-1',
      type: 'sequence-zoom-stability-track',
      order: 0,
      visible: true,
      assemblyId: 'test',
      zone: 'below-legacy',
      sizing: { kind: 'fixed', pixels: 24 },
    };
    const genome: Genome = {
      name: 'indexed-sequence-zoom-capability-test',
      length: 1000,
      circular: false,
      features: [],
      sequenceAvailable: true,
    };

    await renderer.init(app, genome, () => state);
    renderer.setChromosome(createChromosome());
    renderer.registerTrack(trackRenderer);
    renderer.setTrackInstances([track]);
    renderer.render(state);
    const before = renderer.getRendererDebugSnapshot() as {
      laneContract: {
        trackScreenBounds: Record<string, { topPx: number }>;
      };
    };

    state.zoom = 10;
    renderer.render(state);
    const after = renderer.getRendererDebugSnapshot() as {
      laneContract: {
        trackScreenBounds: Record<string, { topPx: number }>;
      };
    };

    expect(before.laneContract.trackScreenBounds[track.id]?.topPx).toBeDefined();
    expect(after.laneContract.trackScreenBounds[track.id]?.topPx).toBe(
      before.laneContract.trackScreenBounds[track.id]!.topPx
    );
  });
});

describe('PixiLinearRenderer viewport range', () => {
  it('reserves and cleans up one frame-local search lane without changing the durable annotation envelope', async () => {
    const state = createState();
    const bodyFeature = {
      id: 31,
      type: 'mRNA',
      annotationTrackId: 'mRNA',
      canonicalIdentity: 'canonical-body',
      start: 100,
      end: 200,
      direction: 'forward' as const,
      displayName: 'BODY',
      color: 0x3b82f6,
      lane: 0,
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 1,
      exons: [{ start: 101, end: 200 }],
      cds: [],
    };
    const filteredFeature = {
      ...bodyFeature,
      id: 32,
      canonicalIdentity: 'canonical-filtered',
      displayName: 'FILTERED',
      start: 300,
      end: 400,
      lane: 5,
      annotationTrackLane: 5,
      annotationTrackLaneCapacity: 6,
      exons: [{ start: 301, end: 400 }],
    };
    const genome: Genome = {
      ...createGenome(),
      features: [bodyFeature],
      annotationLayerTypes: ['mRNA'],
      annotationLayout: { maxAnnotationLane: 0, maxCdsLane: -1 },
    };
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genome, () => state);
    const annotationOverlay = (
      renderer as unknown as {
        annotationOverlay: {
          annotationSearchFocusDurableVisibility: (
            focus: RenderState['annotationSearchFocus']
          ) => 'visible' | 'filtered' | 'unavailable';
        };
      }
    ).annotationOverlay;
    const durableVisibility = vi.spyOn(annotationOverlay, 'annotationSearchFocusDurableVisibility');

    renderer.render(state);
    const before = renderer.getRendererDebugSnapshot() as {
      laneContract: {
        maxAnnotationLane: number;
        overlayLayout: { annotationHeight: number };
      };
      annotationOverlay: {
        featureCount: number;
        annotationSearchFocusPresentationLane: number | null;
      };
    };
    const durableCarriers = (renderer as unknown as { annotationFeatures: ReadonlyArray<unknown> })
      .annotationFeatures;

    state.annotationSearchFocus = {
      trackId: 'mRNA',
      canonicalIdentity: bodyFeature.canonicalIdentity,
      presentation: 'temporary-additional-lane',
    };
    state.annotationSearchFocusFeature = bodyFeature;
    durableVisibility.mockReturnValue('unavailable');
    renderer.render(state);
    const durablyVisibleFocus = renderer.getRendererDebugSnapshot() as typeof before;

    expect(durablyVisibleFocus.laneContract.maxAnnotationLane).toBe(0);
    expect(durablyVisibleFocus.laneContract.overlayLayout.annotationHeight).toBe(
      before.laneContract.overlayLayout.annotationHeight
    );
    expect(durablyVisibleFocus.annotationOverlay).toMatchObject({
      featureCount: before.annotationOverlay.featureCount,
      annotationSearchFocusPresentationLane: null,
    });

    state.annotationSearchFocus = {
      trackId: 'mRNA',
      canonicalIdentity: filteredFeature.canonicalIdentity,
      presentation: 'temporary-additional-lane',
    };
    state.annotationSearchFocusFeature = filteredFeature;
    durableVisibility.mockReturnValue('filtered');
    renderer.render(state);
    const focused = renderer.getRendererDebugSnapshot() as typeof before;
    const focusedLaneScreen = renderer.getLaneScreenSnapshot();

    expect(focused.laneContract.maxAnnotationLane).toBe(0);
    expect(focused.laneContract.overlayLayout.annotationHeight).toBe(
      before.laneContract.overlayLayout.annotationHeight * 2
    );
    expect(focused.annotationOverlay).toMatchObject({
      featureCount: before.annotationOverlay.featureCount,
      annotationSearchFocusPresentationLane: 1,
    });
    expect(focusedLaneScreen.annotationOverlay).toEqual({
      annotationSearchFocusResolvedTrackId: 'mRNA',
      annotationSearchFocusResolvedCanonicalIdentity: filteredFeature.canonicalIdentity,
      annotationSearchFocusPresentationLane: 1,
    });
    expect(
      (renderer as unknown as { annotationFeatures: ReadonlyArray<unknown> }).annotationFeatures
    ).toBe(durableCarriers);

    state.annotationSearchFocus = null;
    state.annotationSearchFocusFeature = null;
    durableVisibility.mockReturnValue('unavailable');
    renderer.render(state);
    const cleaned = renderer.getRendererDebugSnapshot() as typeof before;
    const cleanedLaneScreen = renderer.getLaneScreenSnapshot();

    expect(cleaned.laneContract.maxAnnotationLane).toBe(0);
    expect(cleaned.laneContract.overlayLayout.annotationHeight).toBe(
      before.laneContract.overlayLayout.annotationHeight
    );
    expect(cleaned.annotationOverlay).toMatchObject({
      featureCount: before.annotationOverlay.featureCount,
      annotationSearchFocusPresentationLane: null,
    });
    expect(cleanedLaneScreen.annotationOverlay).toEqual({
      annotationSearchFocusResolvedTrackId: null,
      annotationSearchFocusResolvedCanonicalIdentity: null,
      annotationSearchFocusPresentationLane: null,
    });
    expect(
      (renderer as unknown as { annotationFeatures: ReadonlyArray<unknown> }).annotationFeatures
    ).toBe(durableCarriers);
  });

  it('keeps selection wash behind annotation layers and interaction handles above them', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const layers = renderer as unknown as {
      selectionLayer: Container;
      annotationOverlay: { container: Container };
      primerOverlay: { container: Container };
      interactionLayer: Container;
    };
    const stageChildren = app.stage.children;

    expect(stageChildren.indexOf(layers.selectionLayer)).toBeLessThan(
      stageChildren.indexOf(layers.annotationOverlay.container)
    );
    expect(stageChildren.indexOf(layers.selectionLayer)).toBeLessThan(
      stageChildren.indexOf(layers.primerOverlay.container)
    );
    expect(stageChildren.indexOf(layers.interactionLayer)).toBeGreaterThan(
      stageChildren.indexOf(layers.annotationOverlay.container)
    );
  });

  it('keeps the whole-height mutation guide behind scientific tracks and interaction handles', async () => {
    const state = createState();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const mountedTrack = new Container();
    const trackRenderer: PixiLinearTrackRenderer = {
      type: 'guide-order-track',
      mount: () => mountedTrack,
      unmount: () => undefined,
      paint: () => undefined,
    };
    const track: Track = {
      id: 'guide-order-track-1',
      type: trackRenderer.type,
      order: 0,
      visible: true,
      assemblyId: 'test',
      zone: 'below-legacy',
      sizing: { kind: 'fixed', pixels: 24 },
    };

    await renderer.init(app, createGenome(), () => state);
    renderer.setChromosome(createChromosome());
    renderer.registerTrack(trackRenderer);
    renderer.setTrackInstances([track]);
    renderer.render(state);

    const layers = renderer as unknown as {
      pileupGlobalGuideLayer: { container: Container };
      interactionLayer: Container;
    };
    const guideIndex = app.stage.children.indexOf(layers.pileupGlobalGuideLayer.container);
    const trackIndex = app.stage.children.indexOf(mountedTrack);
    const interactionIndex = app.stage.children.indexOf(layers.interactionLayer);

    expect(guideIndex).toBe(0);
    expect(guideIndex).toBeLessThan(trackIndex);
    expect(trackIndex).toBeLessThan(interactionIndex);

    renderer.destroy();
  });

  it.each([
    { mode: 'light' as const, color: 0xffffc8, alpha: 1, stroke: 0x000000 },
    { mode: 'dark' as const, color: 0xb4a032, alpha: 0.25, stroke: 0xf5e58a },
  ])(
    'draws the wrapped $mode selection fill behind foreground edge handles',
    async ({ mode, color, alpha, stroke }) => {
      const state = createState();
      state.themeMode = mode;
      state.zoom = 40;
      state.viewportRange = null;
      state.highlightRange = [10, 14];
      const renderer = new PixiLinearRenderer();
      const app = {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application;

      await renderer.init(app, createGenome(), () => state);
      const graphics = renderer as unknown as {
        selectionGraphics: {
          rect: (x: number, y: number, width: number, height: number) => unknown;
          fill: (opts: { color: number; alpha: number }) => unknown;
        };
        interactionGraphics: {
          fill: (opts: { color: number; alpha: number }) => unknown;
          setStrokeStyle: (opts: { width: number; color: number; alpha: number }) => unknown;
        };
      };
      const selectionFillSpy = vi.spyOn(graphics.selectionGraphics, 'fill');
      const interactionFillSpy = vi.spyOn(graphics.interactionGraphics, 'fill');
      const interactionStrokeSpy = vi.spyOn(graphics.interactionGraphics, 'setStrokeStyle');

      renderer.render(state);

      expect(selectionFillSpy).toHaveBeenCalledWith({ color, alpha });
      expect(interactionFillSpy).not.toHaveBeenCalledWith({ color, alpha });
      expect(interactionStrokeSpy).toHaveBeenCalledWith({ width: 2, color: stroke, alpha: 1 });
      renderer.destroy();
    }
  );

  it('draws an origin-wrapped selection as two short terminal segments', async () => {
    const state = createState();
    state.zoom = 1;
    state.viewOffset = 0;
    state.viewportRange = null;
    state.highlightRange = [996, 1];
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const selectionGraphics = (
      renderer as unknown as {
        selectionGraphics: {
          rect: (x: number, y: number, width: number, height: number) => unknown;
        };
      }
    ).selectionGraphics;
    const rectSpy = vi.spyOn(selectionGraphics, 'rect');

    renderer.render(state);

    expect(rectSpy).toHaveBeenCalledTimes(2);
    expect(rectSpy.mock.calls.map(([, , width]) => width)).toEqual(
      expect.arrayContaining([expect.any(Number), expect.any(Number)])
    );
    expect(rectSpy.mock.calls.every(([, , width]) => width < state.width / 10)).toBe(true);
  });

  it('draws selected-range edge bars across the full canvas height', async () => {
    const state = createState();
    state.zoom = 40;
    state.viewportRange = null;
    state.highlightRange = [10, 14];
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const interactionGraphics = (
      renderer as unknown as {
        interactionGraphics: {
          moveTo: (x: number, y: number) => unknown;
          lineTo: (x: number, y: number) => unknown;
        };
      }
    ).interactionGraphics;
    const moveToSpy = vi.spyOn(interactionGraphics, 'moveTo');
    const lineToSpy = vi.spyOn(interactionGraphics, 'lineTo');

    renderer.render(state);

    expect(moveToSpy.mock.calls.map(([, y]) => y)).toEqual([0, 0]);
    expect(lineToSpy.mock.calls.map(([, y]) => y)).toEqual([state.height, state.height]);
  });

  it('paints splice-junction peptide codons as exact disjoint segments without the intron', async () => {
    const state = createState();
    state.zoom = 40;
    state.viewportRange = null;
    state.highlightRange = null;
    state.proteinSearchHighlightRanges = [
      [10, 15],
      [30, 40],
    ];
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const selectionGraphics = (
      renderer as unknown as {
        selectionGraphics: {
          rect: (x: number, y: number, width: number, height: number) => unknown;
        };
      }
    ).selectionGraphics;
    const rectSpy = vi.spyOn(selectionGraphics, 'rect');

    renderer.render(state);

    expect(rectSpy).toHaveBeenCalledTimes(2);
    const [firstX, , firstWidth] = rectSpy.mock.calls[0];
    const [secondX] = rectSpy.mock.calls[1];
    expect(firstX + firstWidth).toBeLessThan(secondX);
  });

  it('can imperatively center the camera on a biological position', async () => {
    const state = createState();
    state.zoom = 5;
    state.viewportRange = null;
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    renderer.setViewCenterBp(500, state);

    expect(renderer.getViewCenterBp(state)).toBeCloseTo(500, 0);
  });

  it.each([
    { width: 622, start: 0, span: 2_199_999_999 },
    { width: 800, start: 100_000_000, span: 155 },
    { width: 622, start: 100_000_000.25, span: 155 },
  ])(
    'preserves the rendered fractional center at $width CSS pixels ($span bp)',
    async ({ width, start, span }) => {
      const genome = { ...createGenome(), length: 3_088_269_832, sequence: '' };
      const state = {
        ...createState(),
        width,
        zoom: genome.length / span,
        viewportRange: null,
      };
      const renderer = new PixiLinearRenderer();
      await renderer.init(
        {
          stage: new Container(),
          canvas: document.createElement('canvas'),
        } as unknown as Application,
        genome,
        () => state
      );
      const center = start + span / 2;
      renderer.setViewCenterBp(center, state);

      const actualCenter = renderer.getViewCenterBp(state);
      const actualSpan = genome.length / state.zoom;
      expect(actualCenter).toBeCloseTo(center, 6);
      expect(actualCenter - actualSpan / 2).toBeCloseTo(start, 6);
      expect(actualCenter + actualSpan / 2).toBeCloseTo(start + span, 6);
      expect(renderer.screenToBp(width / 2, 0, state)).toBe(Math.round(center));
      expect(renderer.screenToBoundaryBp(width / 2, 0, state)).toBe(Math.round(center));
      renderer.destroy();
    }
  );

  it('setViewCenterBp at zoom=1 can place the LAST bp at viewport center (overscroll=0.5 lets camera reach there)', async () => {
    const state = createState();
    state.zoom = 1;
    state.viewOffset = 0;
    state.viewportRange = null;
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const lastBp = 999;
    renderer.setViewCenterBp(lastBp, state);

    expect(state.viewOffset).toBeCloseTo(0.5, 2);
  });

  it('centers the ruler baseline for a zoomed-out linear sequence', async () => {
    const state = createState();
    state.zoom = 0.5;
    state.viewportRange = null;
    const genome = createGenome();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);
    const rulerGraphics = (
      renderer as unknown as {
        rulerGraphics: Graphics;
      }
    ).rulerGraphics;
    renderer.render(state);

    const bpPerPixel = genome.length / (state.width * state.zoom);
    const genomePixelWidth = genome.length / bpPerPixel;
    const expectedStartX = (state.width - genomePixelWidth) / 2;
    expect(rulerGraphics.position.x).toBeCloseTo(expectedStartX, 5);
    expect(rulerGraphics.scale.x).toBeCloseTo(genomePixelWidth, 5);
    expect(rulerGraphics.position.x + rulerGraphics.scale.x).toBeLessThan(state.width);
  });

  it('retains ruler tick geometry across camera-only frames', async () => {
    const state = createState();
    state.zoom = 4;
    state.viewOffset = 0.001;
    state.viewportRange = null;
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const internals = renderer as unknown as {
      rulerTickGraphics: Graphics[];
      rulerPrimitiveBuildCount: number;
      rulerTickTopologyBuildCount: number;
      rulerTickTopology: object;
    };

    renderer.render(state);
    const tickCount = internals.rulerTickGraphics.length;
    const buildCount = internals.rulerPrimitiveBuildCount;
    const tickIdentities = [...internals.rulerTickGraphics];
    const topologyBuildCount = internals.rulerTickTopologyBuildCount;
    const topologyIdentity = internals.rulerTickTopology;

    state.viewOffset = 0.002;
    renderer.render(state);

    expect(tickCount).toBeGreaterThan(2);
    expect(internals.rulerTickGraphics).toEqual(tickIdentities);
    expect(internals.rulerPrimitiveBuildCount).toBe(buildCount);
    expect(internals.rulerTickTopologyBuildCount).toBe(topologyBuildCount);
    expect(internals.rulerTickTopology).toBe(topologyIdentity);

    state.viewOffset = 0.061;
    renderer.render(state);
    expect(internals.rulerTickTopologyBuildCount).toBe(topologyBuildCount + 1);

    state.width = 300;
    renderer.render(state);
    expect(internals.rulerTickTopologyBuildCount).toBe(topologyBuildCount + 2);
  });

  it('keeps the entire linear sequence in the culling window when fully zoomed out and panned', async () => {
    const state = createState();
    state.zoom = 0.5;
    state.viewOffset = 0.2;
    state.viewportRange = null;
    const genome = createGenome();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    expect(path).not.toBeNull();
    expect(path!.viewStartBp).toBeLessThanOrEqual(0);
    expect(path!.viewEndBp).toBeGreaterThanOrEqual(genome.length);
  });

  it('updates primer graphics and hit records when zooming from detail to feature LOD', async () => {
    const state = createState();
    state.zoom = 10;
    state.viewportRange = null;
    const genome = createGenomeWithPrimer();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);
    renderer.render(state);
    expect(renderer.getPrimerDebugSnapshot()).toMatchObject({
      drawnPrimers: 1,
      hitRecords: 1,
      sequenceVisible: true,
    });

    state.zoom = 0.2;
    renderer.render(state);

    expect(renderer.getPrimerDebugSnapshot()).toMatchObject({
      drawnPrimers: 1,
      hitRecords: 1,
      culledByLod: 0,
      sequenceVisible: false,
    });
    expect(renderer.getPrimerDebugSnapshot().firstDrawnPrimer).not.toBeNull();
  });

  it('allows a small blank gutter before the start of a zoomed-in linear sequence', async () => {
    const state = createState();
    state.zoom = 20;
    state.viewOffset = -1;
    state.viewportRange = null;
    const genome = createGenome();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);
    const rulerGraphics = (renderer as unknown as { rulerGraphics: Graphics }).rulerGraphics;
    renderer.render(state);

    expect(state.viewOffset).toBeCloseTo(-LINEAR_EDGE_OVERSCROLL_VIEWPORT_FRACTION / state.zoom, 5);
    expect(rulerGraphics.position.x).toBeCloseTo(
      state.width * LINEAR_EDGE_OVERSCROLL_VIEWPORT_FRACTION,
      5
    );
  });

  it('allows a small blank gutter after the end of a zoomed-in linear sequence', async () => {
    const state = createState();
    state.zoom = 20;
    state.viewOffset = 1;
    state.viewportRange = null;
    const genome = createGenome();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);
    const rulerGraphics = (renderer as unknown as { rulerGraphics: Graphics }).rulerGraphics;
    renderer.render(state);

    expect(state.viewOffset).toBeCloseTo(
      1 - 1 / state.zoom + LINEAR_EDGE_OVERSCROLL_VIEWPORT_FRACTION / state.zoom,
      5
    );
    expect(rulerGraphics.position.x + rulerGraphics.scale.x).toBeCloseTo(
      state.width * (1 - LINEAR_EDGE_OVERSCROLL_VIEWPORT_FRACTION),
      5
    );
  });
});

describe('PixiLinearRenderer text selection boundaries', () => {
  it('hit-tests the end selection bar after the last selected nucleotide', async () => {
    const state = createState();
    state.zoom = 40;
    state.highlightRange = [10, 14];
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    renderer.render(state);

    const layout = (renderer as unknown as { _overlayLayout: UnifiedLayout })._overlayLayout;
    const bpPerPixel = createGenome().length / (state.width * state.zoom);
    const boundaryAfterLastBaseX = 15 / bpPerPixel;
    const interiorSelectionX = 13 / bpPerPixel;
    const interactionContract = resolveInteractionOverlayContract({ layout, mode: 'linear' });
    const band = getInteractionLaneEnvelope(interactionContract, 'selection-band');
    const y = band
      ? layout.fwdStrandTop + (band.minOffset + band.maxOffset) / 2
      : (layout.annotationTop + layout.rulerY) / 2;

    expect(renderer.hitTestSelectionHandle(boundaryAfterLastBaseX, y, state)).toBe('end');
    expect(renderer.hitTestSelectionHandle(interiorSelectionX, y, state)).toBeNull();
  });

  it('draws the vertical cursor on a text boundary', async () => {
    const state = createState();
    state.zoom = 40;
    state.viewportRange = null;
    state.cursorPosition = 15;
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const interactionGraphics = (
      renderer as unknown as { interactionGraphics: { moveTo: (x: number, y: number) => unknown } }
    ).interactionGraphics;
    const moveToSpy = vi.spyOn(interactionGraphics, 'moveTo');
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    expect(path).not.toBeNull();
    if (!path) return;
    const bpPerPixel = createGenome().length / (state.width * state.zoom);
    const expectedCursorX = 15 / bpPerPixel;
    const oldBaseRegisterX = 14.5 / bpPerPixel;
    const [actualX] = moveToSpy.mock.calls[0];

    expect(actualX).toBeCloseTo(expectedCursorX, 5);
    expect(Math.abs(actualX - oldBaseRegisterX)).toBeCloseTo(path.pixelsPerBp / 2, 1);
  });

  it('draws the transient hover guide on a text boundary', async () => {
    const state = createState();
    state.zoom = 40;
    state.viewportRange = null;
    state.hoverPosition = 15;
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const interactionGraphics = (
      renderer as unknown as { interactionGraphics: { moveTo: (x: number, y: number) => unknown } }
    ).interactionGraphics;
    const moveToSpy = vi.spyOn(interactionGraphics, 'moveTo');
    renderer.render(state);

    const bpPerPixel = createGenome().length / (state.width * state.zoom);
    const expectedCursorX = 15 / bpPerPixel;
    const [actualX] = moveToSpy.mock.calls[0];

    expect(actualX).toBeCloseTo(expectedCursorX, 5);
  });

  it('draws the transient dashed hover guide across the full canvas height without an overview', async () => {
    const state = createState();
    state.zoom = 40;
    state.viewportRange = null;
    state.hoverPosition = 15;
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const interactionGraphics = (
      renderer as unknown as {
        interactionGraphics: {
          moveTo: (x: number, y: number) => unknown;
          lineTo: (x: number, y: number) => unknown;
        };
      }
    ).interactionGraphics;
    const moveToSpy = vi.spyOn(interactionGraphics, 'moveTo');
    const lineToSpy = vi.spyOn(interactionGraphics, 'lineTo');

    renderer.render(state);

    const guideYs = [...moveToSpy.mock.calls, ...lineToSpy.mock.calls].map(([, y]) => y);
    expect(Math.min(...guideYs)).toBeCloseTo(0, 5);
    expect(Math.max(...guideYs)).toBeCloseTo(state.height, 5);
  });

  it.each([
    {
      guide: 'selection edge',
      apply: (state: RenderState) => {
        state.highlightRange = [10, 14];
      },
    },
    {
      guide: 'protein-search edge',
      apply: (state: RenderState) => {
        state.proteinSearchHighlightRanges = [[10, 15]];
      },
    },
    {
      guide: 'cursor',
      apply: (state: RenderState) => {
        state.cursorPosition = 15;
      },
    },
    {
      guide: 'hover',
      apply: (state: RenderState) => {
        state.hoverPosition = 15;
      },
    },
  ])('clips the $guide below the pinned chromosome overview', async ({ apply }) => {
    const state = createState();
    state.zoom = 40;
    state.viewportRange = null;
    apply(state);
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    const cytoband: Track = {
      id: 'cytoband-guide-boundary',
      type: CYTOBAND_TYPE.type,
      order: 0,
      visible: true,
      assemblyId: 'test',
      zone: 'above-legacy',
      sizing: CYTOBAND_TYPE.defaultSizing,
    };

    await renderer.init(app, createGenome(), () => state);
    renderer.setChromosome(createChromosome());
    renderer.registerTrack(new PixiCytobandTrackRenderer());
    renderer.setTrackInstances([cytoband]);
    const interactionGraphics = (
      renderer as unknown as {
        interactionGraphics: {
          moveTo: (x: number, y: number) => unknown;
          lineTo: (x: number, y: number) => unknown;
        };
      }
    ).interactionGraphics;
    const moveToSpy = vi.spyOn(interactionGraphics, 'moveTo');
    const lineToSpy = vi.spyOn(interactionGraphics, 'lineTo');

    renderer.render(state);

    const guideYs = [...moveToSpy.mock.calls, ...lineToSpy.mock.calls].map(([, y]) => y);
    expect(Math.min(...guideYs)).toBeCloseTo(CYTOBAND_REQUIRED_TRACK_HEIGHT_PX, 5);
    expect(Math.max(...guideYs)).toBeGreaterThan(state.height - 4);
    expect(Math.max(...guideYs)).toBeLessThanOrEqual(state.height);
    expect(renderer.hitTestPositionGuideSurface(100, 31, state)).toBe(false);
    expect(renderer.hitTestPositionGuideSurface(100, 32, state)).toBe(true);
  });

  it('draws hovered codon background over the matching sequence row', async () => {
    const state = createState();
    state.zoom = 40;
    state.viewportRange = null;
    state.hoveredCodon = { start: 10, end: 12, strand: -1 };
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const interactionGraphics = (
      renderer as unknown as {
        interactionGraphics: {
          rect: (x: number, y: number, width: number, height: number) => unknown;
          fill: (opts: { color: number; alpha: number }) => unknown;
        };
      }
    ).interactionGraphics;
    const rectSpy = vi.spyOn(interactionGraphics, 'rect');
    const fillSpy = vi.spyOn(interactionGraphics, 'fill');
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    const layout = (renderer as unknown as { _overlayLayout: UnifiedLayout })._overlayLayout;
    expect(path).not.toBeNull();
    if (!path) return;

    expect(rectSpy).toHaveBeenCalled();
    const [x, y, width, height] = rectSpy.mock.calls[0];
    expect(x).toBeCloseTo(path.bpLeftX(10), 5);
    expect(y).toBeCloseTo(layout.revStrandTop, 5);
    expect(width).toBeCloseTo(path.bpLeftX(13) - path.bpLeftX(10), 5);
    expect(height).toBeCloseTo(layout.revStrandBottom - layout.revStrandTop, 5);
    expect(fillSpy).toHaveBeenCalledWith({ color: 0x8c8c8c, alpha: 0.25 });
  });

  it('hit-tests visible nucleotide text rows for text cursor affordance', async () => {
    const state = createState();
    state.zoom = 40;
    state.viewportRange = null;
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    const layout = (renderer as unknown as { _overlayLayout: UnifiedLayout })._overlayLayout;
    expect(path).not.toBeNull();
    if (!path) return;

    expect(renderer.hitTestNucleotideText(path.bpCenterX(10), layout.fwdStrandCenter, state)).toBe(
      true
    );
    expect(renderer.hitTestNucleotideText(path.bpCenterX(10), layout.rulerY, state)).toBe(false);
  });

  it('caps high-zoom nucleotide spacing before letters stretch apart', async () => {
    const state = createState();
    state.zoom = 50_000;
    state.viewportRange = null;
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const maxZoom = renderer.getMaxZoom(state);
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    expect(path).not.toBeNull();
    if (!path) return;

    expect(state.zoom).toBeLessThanOrEqual(maxZoom);
    expect(path.pixelsPerBp).toBeLessThanOrEqual(MAX_INDEXED_LINEAR_SEQUENCE_PIXELS_PER_BP + 0.01);
  });

  it('caps stability-mode zoom before nucleotide detail on large genomes', async () => {
    const state = createState();
    state.performanceMode = 'stability';
    state.zoom = 50_000;
    state.viewportRange = null;
    const largeGenome: Genome = {
      ...createGenome(),
      length: 1_000_000,
      sequence: 'A'.repeat(1_000_000),
    };
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, largeGenome, () => state);
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    expect(path).not.toBeNull();
    if (!path) return;

    const maxPixelsPerBp =
      sequenceFullViewportPixelsPerBp(state.width) * STABILITY_SEQUENCE_DETAIL_FRACTION;
    expect(path.pixelsPerBp).toBeLessThanOrEqual(maxPixelsPerBp + 0.01);
  });

  it('does not draw a vertical cursor while a highlight selection is active', async () => {
    const state = createState();
    state.zoom = 40;
    state.viewportRange = null;
    state.highlightRange = [10, 14];
    state.cursorPosition = 15;
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const interactionGraphics = (
      renderer as unknown as { interactionGraphics: { moveTo: (x: number, y: number) => unknown } }
    ).interactionGraphics;
    const moveToSpy = vi.spyOn(interactionGraphics, 'moveTo');
    renderer.render(state);

    expect(moveToSpy).toHaveBeenCalledTimes(2);
  });

  it('anchors linear zoom around the provided canvas-local mouse x', async () => {
    const state = createState();
    state.zoom = 1;
    state.viewOffset = 0.1;
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);

    renderer.adjustViewOffsetForZoom(1, 2, state, 200);

    expect(state.viewOffset).toBeCloseTo(0.225, 5);
  });

  it('anchors zoom at the cursor when zooming in from a whole-sequence linear view', async () => {
    const state = createState();
    state.zoom = 0.5;
    state.viewOffset = 0;
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);

    renderer.adjustViewOffsetForZoom(0.5, 2, state, 300);

    expect(state.viewOffset).toBeCloseTo(0.0625, 5);
  });

  it('anchors blank-space zoom at the visible genome endpoint instead of pulling the endpoint under the pointer', async () => {
    const state = createState();
    state.zoom = 2;
    state.viewOffset = 0.75;
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);

    renderer.adjustViewOffsetForZoom(2, 4, state, 680);
    expect(state.viewOffset).toBeCloseTo(0.875, 5);

    state.zoom = 2;
    state.viewOffset = -0.25;
    renderer.adjustViewOffsetForZoom(2, 4, state, 100);
    expect(state.viewOffset).toBeCloseTo(-0.125, 5);
  });

  it('keeps comparison colors on the ruler when nucleotide letters are hidden', async () => {
    const state = createState();
    state.zoom = 1;
    const genome = createGenome();
    state.sequencePresentation = {
      alignedQuery: 'A'.repeat(genome.length),
      nucleotideChanges: [{ start: 100, end: 101, kind: 'deletion', color: 0xef4444 }],
    };
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genome, () => state);
    renderer.render(state);
    const internals = renderer as unknown as {
      rulerSegmentGraphics: Graphics[];
      rulerSegmentStyles: Array<{ color: number; strokeWidth: number; alpha: number }>;
    };
    expect(renderer.getRendererDebugSnapshot()).toMatchObject({ sequenceTrack: { fwdVisible: 0 } });
    expect(internals.rulerSegmentGraphics[0]?.visible).toBe(true);
    expect(internals.rulerSegmentGraphics[0]?.scale.x).toBeGreaterThanOrEqual(2);
    expect(internals.rulerSegmentStyles[0]).toEqual({ color: 0xf44336, strokeWidth: 4, alpha: 1 });
    state.sequencePresentation = undefined;
    renderer.render(state);
    expect(internals.rulerSegmentGraphics[0]?.visible).toBe(false);
  });

  it('draws backbone segments from render state without reloading the genome', async () => {
    const state = createState();
    state.zoom = 4;
    state.backboneSegments = [
      { start: 100, end: 200, color: 0x12abcd, strokeWidth: 7, alpha: 0.64 },
    ];
    const genome = createGenome();
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);
    const loadGenomeSpy = vi.spyOn(renderer, 'loadGenome');
    const internals = renderer as unknown as {
      rulerPrimitiveBuildCount: number;
      rulerSegmentStyles: Array<{
        color: number;
        strokeWidth: number;
        alpha: number;
      } | null>;
    };

    renderer.render(state);
    expect(internals.rulerSegmentStyles[0]).toEqual({
      color: 0x12abcd,
      strokeWidth: 7,
      alpha: 0.64,
    });
    expect(renderer.getRendererDebugSnapshot()).toMatchObject({
      backboneSegmentCount: 1,
      backbonePathSegmentsDrawn: 1,
    });
    const initialPrimitiveBuildCount = internals.rulerPrimitiveBuildCount;

    state.viewOffset = 0.25;
    renderer.render(state);
    expect(internals.rulerPrimitiveBuildCount).toBe(initialPrimitiveBuildCount);

    state.viewOffset = 0;
    state.backboneSegments = [{ start: 120, end: 160, color: 0xff00aa, strokeWidth: 5 }];
    renderer.render(state);

    expect(loadGenomeSpy).not.toHaveBeenCalled();
    expect(renderer.getRendererDebugSnapshot()).toMatchObject({
      backboneSegmentCount: 1,
      backbonePathSegmentsDrawn: 1,
    });
    expect(internals.rulerSegmentStyles[0]).toEqual({
      color: 0xff00aa,
      strokeWidth: 5,
      alpha: 0.95,
    });
    expect(internals.rulerPrimitiveBuildCount).toBe(initialPrimitiveBuildCount + 1);
  });

  it('projects colored assembly segments through retained ruler primitives', () => {
    const state = createState();
    state.backboneSegments = [{ start: 100, end: 200, color: 0x12abcd, strokeWidth: 7 }];
    const renderer = new PixiLinearRenderer();
    const internals = renderer as unknown as {
      genome: Genome;
      rulerSegmentLayer: Container;
      rulerSegmentGraphics: Graphics[];
      drawBackboneSegments: (
        renderState: RenderState,
        viewStartBp: number,
        viewEndBp: number,
        bpPerPixel: number,
        y: number
      ) => void;
    };
    internals.genome = createGenome();
    internals.drawBackboneSegments(state, 50, 400, 2, 96);

    expect(internals.rulerSegmentGraphics[0].position.x).toBe(25);
    expect(internals.rulerSegmentGraphics[0].position.y).toBe(96);
    expect(internals.rulerSegmentGraphics[0].scale.x).toBe(50);
  });
});

describe('ordinary sequence presentation parity', () => {
  it.each([
    ['sequence', PixiLinearRenderer],
    ['indexed', IndexedPixiLinearRenderer],
  ] as const)('uses one compound CDS border in the %s comparison renderer', async (_, Renderer) => {
    const state = createState();
    const feature = {
      id: 1,
      type: 'CDS',
      start: 100,
      end: 106,
      direction: 'forward' as const,
      displayName: 'Mutant',
      color: 0x2563eb,
      lane: 0,
      cdsLane: 0,
      codingSource: 'query' as const,
      qualifiers: { _lane: '0' },
    };
    const codons = [
      { startBp: 100, endBp: 103, codon: 'ATG', aa: 'M', isStop: false, isStart: true },
      { startBp: 103, endBp: 106, codon: 'TAA', aa: '*', isStop: true, isStart: false },
    ];
    const genome = {
      ...createGenome(),
      features: [feature],
      sequence: 'A'.repeat(100) + 'ATGTAA' + 'A'.repeat(894),
    };
    state.selectedIds.add(feature.id);
    state.sequencePresentation = {
      cdsComparisonLayout: 'rows',
      codingFeatures: new Map([[feature.id, { source: 'query' as const, codons, introns: [] }]]),
    };
    const renderer = new Renderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      genome,
      () => state
    );
    try {
      renderer.render(state);
      const graphics = (renderer as unknown as { codonTrack: { graphics: Graphics } }).codonTrack
        .graphics;
      expect(
        graphics.context.instructions.filter(
          (instruction) => instruction.action === 'stroke' && instruction.data.style.width >= 2
        )
      ).toEqual([]);
      expect(renderer.getRendererDebugSnapshot()).toMatchObject({
        annotationOverlay: { lastInteractionOutlineCommandCount: 1 },
      });
      expect(codonDebugSnapshot(renderer).codingRows[0].letters).toEqual(['M', '*']);
    } finally {
      renderer.destroy();
    }
  });
  it('draws the computed mutant CDS itself and retains a separately identifiable original', async () => {
    const state = createState();
    const reference = {
      id: 0,
      type: 'CDS',
      start: 100,
      end: 112,
      direction: 'forward' as const,
      displayName: 'Original',
      color: 0x8b95a5,
      lane: 1,
      cdsLane: 1,
      codingSource: 'reference' as const,
      qualifiers: { _lane: '1' },
    };
    const query = {
      ...reference,
      id: 1,
      end: 106,
      displayName: 'Mutant',
      lane: 0,
      cdsLane: 0,
      codingSource: 'query' as const,
      qualifiers: { _lane: '0' },
    };
    const codons = [
      {
        startBp: 100,
        endBp: 103,
        codon: 'ATG',
        aa: 'M',
        isStop: false,
        isStart: true,
        residueIndex: 1,
      },
      {
        startBp: 103,
        endBp: 106,
        codon: 'TAA',
        aa: '*',
        isStop: true,
        isStart: false,
        residueIndex: 2,
      },
    ];
    const genome = { ...createGenome(), features: [reference, query] };
    state.sequencePresentation = {
      codingFeatures: new Map([[1, { source: 'query' as const, codons, introns: [] }]]),
    };
    const renderer = new PixiLinearRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      genome,
      () => state
    );
    renderer.render(state);
    const row = codonDebugSnapshot(renderer).codingRows.find((row) => row.source === 'query');
    expect(row).toMatchObject({ start: 100, end: 106, letters: ['M', '*'] });
    expect(renderer.hitTestCodon(0, 0)).toBeNull();
    renderer.destroy();
  });
  it('shares the physical minimum with wheel zoom while preserving the default indexed minimum', async () => {
    const state = createState();
    const genome = createGenome();
    const renderer = new PixiLinearRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      genome,
      () => state
    );
    state.sequencePresentation = { minSequencePixelsPerBp: 0.016 };
    expect((renderer.getMinZoom(state) * state.width) / genome.length).toBeCloseTo(0.016);
    state.sequencePresentation = undefined;
    expect(renderer.getMinZoom(state)).toBe(0.5);
    renderer.destroy();
  });
  it('honors the existing Translation toggle and clears codon hit targets while hidden', async () => {
    const state = createState();
    const genome = {
      ...createGenome(),
      features: [
        {
          id: 0,
          type: 'CDS',
          start: 100,
          end: 250,
          direction: 'forward' as const,
          displayName: 'CDS',
          color: 0x2563eb,
          lane: 0,
        },
      ],
    };
    const renderer = new PixiLinearRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      genome,
      () => state
    );
    renderer.render(state);
    expect(codonDebugSnapshot(renderer).letterCount).toBeGreaterThan(0);
    state.sequencePresentation = { showTranslation: false };
    renderer.render(state);
    expect(codonDebugSnapshot(renderer).letterCount).toBe(0);
    expect(codonDebugSnapshot(renderer).hitCount).toBe(0);
    state.sequencePresentation = { showTranslation: true };
    renderer.render(state);
    expect(codonDebugSnapshot(renderer).letterCount).toBeGreaterThan(0);
    renderer.destroy();
  });
  it('uses the sequence pane physical zoom limit without changing the default indexed cap', async () => {
    const state = createState();
    const genome = createGenome();
    const renderer = new PixiLinearRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      genome,
      () => state
    );
    const indexedMax = renderer.getMaxZoom(state);
    state.sequencePresentation = { maxSequencePixelsPerBp: 9.6 };
    expect((renderer.getMaxZoom(state) * state.width) / genome.length).toBeCloseTo(9.6);
    state.sequencePresentation = undefined;
    expect(renderer.getMaxZoom(state)).toBe(indexedMax);
    renderer.destroy();
  });

  it('reserves and projects Canvas CDS height from the same physical density', async () => {
    const state = { ...createState(), sequencePresentation: { cdsSizing: 'canvas' as const } };
    const genome = {
      ...createGenome(),
      features: [
        {
          id: 0,
          type: 'CDS',
          start: 100,
          end: 250,
          direction: 'forward' as const,
          displayName: 'CDS',
          color: 0x2563eb,
          lane: 0,
        },
      ],
    };
    const renderer = new PixiLinearRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      genome,
      () => state
    );
    renderer.render(state);
    const path = renderer.getCurrentPathMapper()!;
    const expected = canvasCdsMetrics(path.pixelsPerBp).aaHeight;
    expect(path.cdsChevronHeight).toBeCloseTo(expected);
    const layout = (renderer as unknown as { _overlayLayout: UnifiedLayout })._overlayLayout;
    expect(layout.cdsChevronHeight).toBeCloseTo(expected);
    expect(layout.translationLaneHeight).toBeGreaterThanOrEqual(expected);
    renderer.destroy();
  });
});
