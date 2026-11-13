// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Application,
  Container,
  DynamicBitmapFont,
  GlProgram,
  Graphics,
  RendererType,
  Shader,
} from 'pixi.js';
import { PixiStadiumRenderer } from './stadium-renderer';
import { PixiLinearRenderer } from './linear-renderer';
import type { Genome, RenderState } from '../../types';
import {
  MAX_SEQUENCE_FONT_SIZE,
  MAX_SEQUENCE_PIXELS_PER_BP,
  type UnifiedLayout,
} from './shared/track-layout';
import { fullShapeVisualHeight, type StadiumCameraDebug } from './shared/stadium-camera';
import {
  getInteractionLaneEnvelope,
  type LaneStackBounds,
  resolveInteractionOverlayContract,
} from './shared/lane-contracts';
import {
  VIEWPORT_BRACKET_COLLAPSE_BELOW,
  VIEWPORT_BRACKET_COLLAPSED_ARM,
  VIEWPORT_BRACKET_COLLAPSED_WIDTH,
} from './shared/viewport-range-bracket-layout';

const RUN_STADIUM_CAMERA_STRESS = process.env.WAYPOINT_GENOME_RENDERER_STRESS === '1';

beforeAll(() => {
  if (typeof CanvasRenderingContext2D === 'undefined') {
    (globalThis as unknown as { CanvasRenderingContext2D: unknown }).CanvasRenderingContext2D =
      class CanvasRenderingContext2D {};
  }
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      measureText: (text: string) => ({ width: text.length * 7 }),
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

function createState(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 20,
    width: 800,
    height: 400,
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: null,
    highlightRange: [50, 70],
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

function topologyPreparationGpu() {
  const programs: GlProgram[] = [];
  const resourceKeys: string[][] = [];
  const bind = vi.fn((shader: Shader, _skipSync?: boolean) => {
    if (shader.glProgram) programs.push(shader.glProgram);
    resourceKeys.push(Object.keys(shader.resources));
  });
  const resetState = vi.fn();
  const initSource = vi.fn();
  const updateBuffer = vi.fn();
  return {
    programs,
    resourceKeys,
    bind,
    resetState,
    initSource,
    updateBuffer,
    renderer: {
      type: RendererType.WEBGL,
      resolution: 2,
      width: 800,
      height: 400,
      screen: { width: 800, height: 400 },
      shader: { bind, resetState },
      texture: { initSource },
      buffer: { updateBuffer },
    },
  };
}

describe('stadium topology program readiness', () => {
  it('prepares the shared nucleotide program on the live WebGL renderer before init resolves', async () => {
    const gpu = topologyPreparationGpu();
    const glyphAtlas = vi.spyOn(DynamicBitmapFont.prototype, 'ensureCharacters');
    const renderer = new PixiStadiumRenderer();
    const state = createState();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: gpu.renderer,
    } as unknown as Application;
    try {
      await renderer.init(app, createGenome(), () => state);

      expect(gpu.bind).toHaveBeenCalledExactlyOnceWith(expect.any(Shader), true);
      expect(gpu.programs).toHaveLength(1);
      expect(gpu.programs[0]).toBeInstanceOf(GlProgram);
      expect(gpu.programs[0].vertex).toContain(
        '#define SHADER_NAME retained-linear-nucleotide-instances-v1-vertex'
      );
      expect(gpu.programs[0].fragment).toContain(
        '#define SHADER_NAME retained-linear-nucleotide-instances-v1-fragment'
      );
      expect(gpu.resourceKeys).toEqual([[]]);
      expect(gpu.resetState).toHaveBeenCalledTimes(1);
      expect(gpu.resetState.mock.invocationCallOrder[0]).toBeGreaterThan(
        gpu.bind.mock.invocationCallOrder[0]
      );
      expect(glyphAtlas).not.toHaveBeenCalled();
      expect(gpu.initSource).not.toHaveBeenCalled();
      expect(gpu.updateBuffer).not.toHaveBeenCalled();
      expect(renderer.sequenceTrack.getDebugSnapshot()).toMatchObject({
        linearRenderOwner: null,
        linearMeshCount: 0,
        linearInstanceCount: 0,
        linearContentBuildCount: 0,
      });
      renderer.render(state);
      expect(renderer.getCurrentPathMapper()).not.toBeNull();
    } finally {
      renderer.destroy();
      glyphAtlas.mockRestore();
    }
  });

  it.each(['webgpu', 'missing-buffer', 'missing-texture', 'missing-renderer'] as const)(
    'preserves circular initialization without GPU preparation for %s',
    async (unsupported) => {
      const gpu = topologyPreparationGpu();
      const renderer = new PixiStadiumRenderer();
      const state = createState();
      const app = {
        stage: new Container(),
        canvas: document.createElement('canvas'),
        renderer:
          unsupported === 'missing-renderer'
            ? undefined
            : {
                ...gpu.renderer,
                type: unsupported === 'webgpu' ? RendererType.WEBGPU : RendererType.WEBGL,
                buffer: unsupported === 'missing-buffer' ? undefined : gpu.renderer.buffer,
                texture: unsupported === 'missing-texture' ? undefined : gpu.renderer.texture,
              },
      } as unknown as Application;
      try {
        await expect(renderer.init(app, createGenome(), () => state)).resolves.toBeUndefined();
        expect(gpu.bind).not.toHaveBeenCalled();
        expect(gpu.resetState).not.toHaveBeenCalled();
        expect(gpu.initSource).not.toHaveBeenCalled();
        expect(gpu.updateBuffer).not.toHaveBeenCalled();
        renderer.render(state);
        expect(renderer.getCurrentPathMapper()).not.toBeNull();
      } finally {
        renderer.destroy();
      }
    }
  );

  it('keeps circular initialization usable when eager nucleotide program preparation fails', async () => {
    const gpu = topologyPreparationGpu();
    gpu.bind.mockImplementationOnce(() => {
      throw new Error('GPU program preparation refused');
    });
    const renderer = new PixiStadiumRenderer();
    const state = createState();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: gpu.renderer,
    } as unknown as Application;
    try {
      await expect(renderer.init(app, createGenome(), () => state)).resolves.toBeUndefined();
      expect(gpu.bind).toHaveBeenCalledExactlyOnceWith(expect.any(Shader), true);
      expect(gpu.resetState).toHaveBeenCalledTimes(1);
      expect(gpu.initSource).not.toHaveBeenCalled();
      expect(gpu.updateBuffer).not.toHaveBeenCalled();
      renderer.render(state);
      expect(renderer.getCurrentPathMapper()).not.toBeNull();
      expect(state.morph).toBe(0);
    } finally {
      renderer.destroy();
    }
  });
});

describe('original Canvas CDS stadium geometry', () => {
  it('keeps extension layout bounds live when arbitrary interaction state changes', async () => {
    const state = createState();
    const renderer = new PixiStadiumRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      createMg1655ConcaveRegressionGenome(),
      () => state
    );
    renderer.getOverlayRegistry().register({
      id: 'interaction-sized-extension',
      displayName: 'Interaction-sized extension',
      position: 'above',
      sortOrder: 500,
      enabled: true,
      container: new Container(),
      computeHeight: (_genome, current) => (current.hoveredId === null ? 0 : 48),
      loadGenome: () => {},
      render: () => {},
      hitTest: () => null,
      destroy: () => {},
    });
    const measure = vi.spyOn(
      renderer as unknown as { computeFrameForState(state: RenderState, zoom?: number): unknown },
      'computeFrameForState'
    );
    renderer.getMinZoom(state);
    measure.mockClear();
    renderer.getMinZoom(state);
    expect(measure).toHaveBeenCalled();
    measure.mockClear();
    state.hoveredId = 1;
    renderer.getMinZoom(state);
    expect(measure).toHaveBeenCalled();
  });

  it('reuses the built-in minimum zoom across camera motion and invalidates layout changes', async () => {
    const state = { ...createState(), width: 330, height: 562, geometryHeight: 600, morph: 1 };
    const renderer = new PixiStadiumRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      createMg1655ConcaveRegressionGenome(),
      () => state
    );
    const measure = vi.spyOn(
      renderer as unknown as { computeFrameForState(state: RenderState, zoom?: number): unknown },
      'computeFrameForState'
    );
    const minimum = renderer.getMinZoom(state);
    expect(minimum).toBeGreaterThan(0);
    expect(measure).toHaveBeenCalled();
    measure.mockClear();
    for (const zoom of [0.5, 0.6, 0.65, 1]) {
      state.zoom = zoom;
      state.viewOffset += 0.01;
      expect(renderer.getMinZoom(state)).toBe(minimum);
    }
    expect(measure).not.toHaveBeenCalled();

    for (const invalidate of [
      () => {
        state.width += 20;
      },
      () => {
        state.height += 20;
      },
      () => {
        state.geometryHeight += 20;
      },
      () => {
        state.morph = 0.5;
      },
      () => {
        state.showResidueNumbers = !state.showResidueNumbers;
      },
      () => renderer.getOverlayRegistry().toggle('primers'),
      () => renderer.getOverlayRegistry().invalidateLayout(),
      () => renderer.setCutSites([]),
      () => renderer.setSequenceWindow(undefined),
    ]) {
      measure.mockClear();
      invalidate();
      const updated = renderer.getMinZoom(state);
      expect(measure).toHaveBeenCalled();
      measure.mockClear();
      expect(renderer.getMinZoom(state)).toBe(updated);
      expect(measure).not.toHaveBeenCalled();
    }
  });

  it('updates both nucleotide strands when an origin-spanning CDS hover moves into its intron', async () => {
    const state: RenderState = {
      ...createState(),
      width: 418,
      height: 688,
      geometryHeight: 600,
      morph: 1,
      highlightRange: null,
    };
    const genome: Genome = {
      name: 'origin-spanning-spliced-synthetic',
      length: 603,
      circular: true,
      sequence: 'a'.repeat(603),
      features: [
        {
          id: 0,
          type: 'source',
          start: 0,
          end: 603,
          direction: 'none',
          displayName: 'source',
          color: 0x9ca3af,
          lane: 0,
        },
        {
          id: 1,
          type: 'CDS',
          start: 450,
          end: 250,
          direction: 'forward',
          displayName: 'OriginSpanGene',
          color: 0x3b82f6,
          lane: 0,
          cdsLane: 0,
          segments: [
            { start: 451, end: 558 },
            { start: 101, end: 250 },
          ],
          qualifiers: { _locationString: 'join(451..558,101..250)' },
        },
      ],
    };
    const renderer = new PixiStadiumRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      genome,
      () => state
    );
    try {
      state.zoom = renderer.getMaxZoom(state);
      renderer.setViewCenterBp(500, state);
      renderer.render(state);
      const path = renderer.getCurrentPathMapper()!;
      const layout = (path as unknown as { inputs: { layout: UnifiedLayout } }).inputs.layout;
      const point = path.featureLabelPosAt(500, layout.cdsChevronOffset);
      const tracks = renderer as unknown as {
        codonTrack: {
          hitTest: (
            x: number,
            y: number
          ) => { featureId: number; start: number; end: number; strand: 1 | -1 } | null;
        };
        sequenceTrack: {
          fwdMap: Map<number, { text: string; visible: boolean; x: number; y: number }>;
          revMap: Map<number, { text: string; visible: boolean; x: number; y: number }>;
        };
      };
      const hit = tracks.codonTrack.hitTest(point.x, point.y);
      expect(hit).not.toBeNull();
      state.hoveredId = hit!.featureId;
      state.hoveredCodon = { start: hit!.start, end: hit!.end, strand: hit!.strand };
      renderer.render(state);

      renderer.setViewCenterBp(580, state);
      renderer.render(state);
      const nextPath = renderer.getCurrentPathMapper()!;
      for (const [map, expectedText, expectedPosition] of [
        [tracks.sequenceTrack.fwdMap, 'a', nextPath.fwdStrandAt(580)],
        [tracks.sequenceTrack.revMap, 't', nextPath.revStrandAt(580)],
      ] as const) {
        expect(map.get(580)).toMatchObject({ text: expectedText, visible: true });
        expect(map.get(580)!.x).toBeCloseTo(expectedPosition.x, 8);
        expect(map.get(580)!.y).toBeCloseTo(expectedPosition.y, 8);
      }
    } finally {
      renderer.destroy();
    }
  });

  it.each([false, true])(
    'contains tall codons with residue numbers %s and keeps the pill join flush',
    async (showResidueNumbers) => {
      const state = { ...createState(), height: 600, showResidueNumbers, highlightRange: null };
      const renderer = new PixiStadiumRenderer();
      await renderer.init(
        {
          stage: new Container(),
          canvas: document.createElement('canvas'),
        } as unknown as Application,
        createStackedLaneGenome(),
        () => state
      );
      try {
        state.zoom = renderer.getMaxZoom(state);
        renderer.setViewCenterBp(90, state);
        renderer.render(state);
        const path = renderer.getCurrentPathMapper()!;
        const layout = (path as unknown as { inputs: { layout: UnifiedLayout } }).inputs.layout;
        expect(path.pixelsPerBp).toBeCloseTo(14, 8);
        expect(path.cdsChevronHeight).toBeCloseTo(31.5, 8);
        expect(layout.cdsChevronOffset - 31.5 / 2).toBeCloseTo(layout.cdsBarOffset + 7, 8);
        expect(layout.cdsLaneStep).toBeCloseTo(14 + 31.5 + layout.cdsResidueRowHeight, 8);
        const codonBottom = layout.cdsChevronOffset + 31.5 / 2;
        const laneBottom = layout.cdsLaneOffset + layout.cdsLaneStep / 2;
        expect(codonBottom + layout.cdsResidueRowHeight).toBeCloseTo(laneBottom, 8);
        expect(laneBottom - layout.cdsLaneStep).toBeCloseTo(layout.cdsBarOffset - 7, 8);
        if (showResidueNumbers) {
          expect(layout.cdsResidueRowHeight).toBeGreaterThan(0);
          expect(layout.cdsResidueRowOffset - layout.cdsResidueRowHeight / 2).toBeCloseTo(
            codonBottom,
            8
          );
        }
        const track = (
          renderer as unknown as {
            codonTrack: { letterIndex: number; letterPool: Array<{ style: { fontSize: number } }> };
          }
        ).codonTrack;
        expect(track.letterIndex).toBeGreaterThan(0);
        expect(
          track.letterPool.slice(0, track.letterIndex).every((glyph) => glyph.style.fontSize === 24)
        ).toBe(true);
      } finally {
        renderer.destroy();
      }
    }
  );
});

describe('Canvas viewport brackets', () => {
  it.each([
    {
      rendererClass: PixiStadiumRenderer,
      circular: true,
      morph: 0,
      themeMode: 'light' as const,
      color: 0x000000,
    },
    {
      rendererClass: PixiStadiumRenderer,
      circular: true,
      morph: 0.5,
      themeMode: 'light' as const,
      color: 0x000000,
    },
    {
      rendererClass: PixiStadiumRenderer,
      circular: true,
      morph: 1,
      themeMode: 'dark' as const,
      color: 0xeee8dd,
    },
    {
      rendererClass: PixiLinearRenderer,
      circular: true,
      morph: 0,
      themeMode: 'light' as const,
      color: 0x000000,
    },
    {
      rendererClass: PixiLinearRenderer,
      circular: false,
      morph: 0,
      themeMode: 'light' as const,
      color: 0x000000,
    },
    {
      rendererClass: PixiLinearRenderer,
      circular: false,
      morph: 0,
      themeMode: 'dark' as const,
      color: 0xeee8dd,
    },
  ])(
    '$rendererClass.name draws identical brackets for circular=$circular, morph=$morph, $themeMode',
    async ({ rendererClass, circular, morph, themeMode, color }) => {
      const range: [number, number] = circular ? [980, 20] : [0, 1000];
      const state = {
        ...createState(),
        morph,
        themeMode,
        highlightRange: null,
        viewportIndicatorVisible: true,
        viewportRange: range,
      };
      const renderer = new rendererClass();
      const app = {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application;
      await renderer.init(app, { ...createGenome(), circular }, () => state);
      const graphics = (renderer as unknown as { interactionGraphics: Graphics })
        .interactionGraphics;
      const fill = vi.spyOn(graphics, 'fill');
      const move = vi.spyOn(graphics, 'moveTo');
      const line = vi.spyOn(graphics, 'lineTo');
      const stroke = vi.spyOn(graphics, 'setStrokeStyle');
      renderer.render(state);
      expect(fill).not.toHaveBeenCalled();
      expect(move).toHaveBeenCalledTimes(2);
      expect(line).toHaveBeenCalledTimes(6);
      for (const [style] of stroke.mock.calls) {
        expect(style).toEqual(expect.objectContaining({ width: 1.875, alpha: 1, color }));
      }
      const path = renderer.getCurrentPathMapper()!;
      for (const [index, bp] of range.entries()) {
        const p = path.rulerAt(bp - 0.5);
        const corners = line.mock.calls.slice(index * 3, index * 3 + 2);
        const tip = move.mock.calls[index];
        expect(Math.hypot(tip[0] - corners[0][0], tip[1] - corners[0][1])).toBeCloseTo(3);
        expect(
          Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1])
        ).toBeCloseTo(8.4);
        expect((corners[0][0] + corners[1][0]) / 2).toBeCloseTo(p.x);
        expect((corners[0][1] + corners[1][1]) / 2).toBeCloseTo(p.y);
      }
      state.viewportIndicatorVisible = false;
      renderer.render(state);
      expect(renderer.getViewportDebugSnapshot().pathSegmentsDrawn).toBe(0);
      expect(renderer.getViewportDebugSnapshot().range).toBeNull();
      expect(state.viewportRange).toEqual(range);
      renderer.destroy();
    }
  );

  it('does not draw a retained Canvas range unless explicitly enabled', async () => {
    const state = { ...createState(), viewportRange: [10, 200] as [number, number] };
    const renderer = new PixiStadiumRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      createGenome(),
      () => state
    );
    renderer.render(state);
    expect(renderer.getViewportDebugSnapshot().pathSegmentsDrawn).toBe(0);
    renderer.destroy();
  });

  it.each([{ rendererClass: PixiStadiumRenderer }, { rendererClass: PixiLinearRenderer }])(
    '$rendererClass.name collapses a tiny Canvas window to a midpoint chip',
    async ({ rendererClass }) => {
      const state = {
        ...createState(),
        highlightRange: null,
        viewportIndicatorVisible: true,
        viewportRange: [500, 700] as [number, number],
      };
      const renderer = new rendererClass();
      await renderer.init(
        {
          stage: new Container(),
          canvas: document.createElement('canvas'),
        } as unknown as Application,
        createGenome(),
        () => state
      );
      renderer.render(state);
      const path = renderer.getCurrentPathMapper()!;
      const spanBp = VIEWPORT_BRACKET_COLLAPSE_BELOW / 4 / Math.max(path.pixelsPerBp, 1e-9);
      const start = 500;
      const end = 500 + spanBp;
      state.viewportRange = [start, end];
      const graphics = (renderer as unknown as { interactionGraphics: Graphics })
        .interactionGraphics;
      const fill = vi.spyOn(graphics, 'fill');
      const move = vi.spyOn(graphics, 'moveTo');
      const line = vi.spyOn(graphics, 'lineTo');
      renderer.render(state);
      const snapshot = renderer.getViewportDebugSnapshot();
      expect(snapshot.kind).toBe('collapsed');
      expect(fill).not.toHaveBeenCalled();
      expect(move).toHaveBeenCalledTimes(2);
      expect(line).toHaveBeenCalledTimes(6);
      const mid = path.rulerAt((start + end) / 2 - 0.5);
      const leftSpine = {
        x: (line.mock.calls[0][0] + line.mock.calls[1][0]) / 2,
        y: (line.mock.calls[0][1] + line.mock.calls[1][1]) / 2,
      };
      const rightSpine = {
        x: (line.mock.calls[3][0] + line.mock.calls[4][0]) / 2,
        y: (line.mock.calls[3][1] + line.mock.calls[4][1]) / 2,
      };
      expect(Math.hypot(rightSpine.x - leftSpine.x, rightSpine.y - leftSpine.y)).toBeCloseTo(
        VIEWPORT_BRACKET_COLLAPSED_WIDTH
      );
      expect((leftSpine.x + rightSpine.x) / 2).toBeCloseTo(mid.x);
      expect((leftSpine.y + rightSpine.y) / 2).toBeCloseTo(mid.y);
      const leftTip = move.mock.calls[0];
      expect(
        Math.hypot(leftTip[0] - line.mock.calls[0][0], leftTip[1] - line.mock.calls[0][1])
      ).toBeCloseTo(VIEWPORT_BRACKET_COLLAPSED_ARM);
      renderer.destroy();
    }
  );
});

function createGenome(): Genome {
  return {
    name: 'circular-selection-boundary-test',
    length: 1000,
    circular: true,
    features: [],
    sequence: 'A'.repeat(1000),
  };
}

describe('circular ruler rotation', () => {
  it.each([0, 0.5, 1])(
    'retains tick and label membership through a full rotation at morph %s',
    async (morph) => {
      const state = {
        ...createState(),
        width: 330,
        height: 200,
        geometryHeight: 200,
        morph,
        highlightRange: null,
      };
      const renderer = new PixiStadiumRenderer();
      await renderer.init(
        {
          stage: new Container(),
          canvas: document.createElement('canvas'),
        } as unknown as Application,
        { ...createGenome(), length: 2686, sequence: 'A'.repeat(2686) },
        () => state
      );
      state.zoom = Math.max(1, renderer.getMinZoom(state));
      const graphics = (renderer as unknown as { rulerGraphics: Graphics }).rulerGraphics;
      const lineTo = vi.spyOn(graphics, 'lineTo');
      let initialLabels: string[] | undefined;
      let initialTickCount: number | undefined;
      try {
        for (let phase = 0; phase <= 80; phase++) {
          state.viewOffset = phase / 80;
          lineTo.mockClear();
          renderer.render(state);
          const path = renderer.getCurrentPathMapper();
          expect(path).not.toBeNull();
          if (!path) throw new Error('Circular ruler path is missing');
          for (let bp = 0; bp < 2686; bp += 100) {
            const position = path.rulerAt(bp);
            expect(position.x).toBeGreaterThanOrEqual(0);
            expect(position.x).toBeLessThanOrEqual(state.width);
            expect(position.y).toBeGreaterThanOrEqual(0);
            expect(position.y).toBeLessThanOrEqual(state.height);
          }
          const labels = renderer.rulerLabelsMeta.map((label) => label.text).sort();
          const tickCount = lineTo.mock.calls.length - renderer.rulerLineSegmentsDrawn;
          initialLabels ??= labels;
          initialTickCount ??= tickCount;
          expect(labels.length).toBeGreaterThan(1);
          expect(labels, `phase=${phase}/80`).toEqual(initialLabels);
          expect(tickCount, `phase=${phase}/80`).toBe(initialTickCount);
        }
      } finally {
        renderer.destroy();
      }
    }
  );
});

function createSingleAnnotationGenome(): Genome {
  return {
    name: 'single-readable-annotation-lane-test',
    length: 5000,
    circular: true,
    features: [
      {
        id: 1,
        type: 'gene',
        start: 200,
        end: 1500,
        direction: 'forward',
        displayName: 'Readable annotation',
        color: 0x22c55e,
        lane: 0,
      },
    ],
    sequence: 'A'.repeat(5000),
  };
}

function createStackedLaneGenome(): Genome {
  return {
    name: 'circular-vertical-lane-stack-test',
    length: 1000,
    circular: true,
    features: [
      {
        id: 1,
        type: 'CDS',
        start: 10,
        end: 180,
        direction: 'forward',
        displayName: 'CDS 1',
        color: 0x3b82f6,
        lane: 0,
      },
      {
        id: 2,
        type: 'CDS',
        start: 10,
        end: 180,
        direction: 'forward',
        displayName: 'CDS 2',
        color: 0x3b82f6,
        lane: 0,
      },
      {
        id: 3,
        type: 'CDS',
        start: 10,
        end: 180,
        direction: 'forward',
        displayName: 'CDS 3',
        color: 0x3b82f6,
        lane: 0,
      },
    ],
    primers: [
      {
        id: 'primer-a',
        renderId: 10_001,
        name: 'primer-a',
        start: 20,
        end: 80,
        direction: 'forward',
        color: 0xf59e0b,
        bases: 'A'.repeat(60),
      },
      {
        id: 'primer-b',
        renderId: 10_002,
        name: 'primer-b',
        start: 20,
        end: 80,
        direction: 'forward',
        color: 0xf59e0b,
        bases: 'A'.repeat(60),
      },
    ],
    sequence: 'A'.repeat(1000),
  };
}

function createDenseNucleotideVisualCompletenessGenome(): Genome {
  const length = 12_000;
  const features: Genome['features'] = [];
  for (let id = 1; id <= 30; id++) {
    const start = (id - 1) * 390 + 30;
    features.push({
      id,
      type: 'CDS',
      start,
      end: start + 300,
      direction: 'forward',
      displayName: `Dense CDS ${id}`,
      color: 0x3b82f6,
      lane: 0,
    });
  }

  return {
    name: 'dense-nucleotide-visual-completeness-regression',
    length,
    circular: true,
    features,
    sequence: 'ATG'.repeat(length / 3),
  };
}

function createLargeStackedLaneGenome(): Genome {
  const genome = createStackedLaneGenome();
  return {
    ...genome,
    name: 'large-circular-vertical-lane-stack-test',
    length: 100_000,
    sequence: 'A'.repeat(100_000),
  };
}

function createMg1655ConcaveRegressionGenome(): Genome {
  const features = Array.from({ length: 16 }, (_, idx) => ({
    id: idx + 1,
    type: idx % 2 === 0 ? 'CDS' : 'gene',
    start: 1000,
    end: 80_000,
    direction: idx % 3 === 0 ? 'reverse' : 'forward',
    displayName: `stacked-feature-${idx + 1}`,
    color: idx % 2 === 0 ? 0x3b82f6 : 0x22c55e,
    lane: 0,
  })) satisfies Genome['features'];

  return {
    name: 'MG1655-concave-cap-regression',
    length: 4_641_652,
    circular: true,
    features,
    primers: [],
    sequence: 'A'.repeat(1000),
  };
}

function circularBpDistance(a: number, b: number, length: number): number {
  const delta = Math.abs(a - b) % length;
  return Math.min(delta, length - delta);
}

function topMidBpForFrame(
  dims: { straightLength: number; totalLength: number },
  genomeLength: number
): number {
  return (dims.straightLength / dims.totalLength / 2) * genomeLength;
}

function bottomMidBpForFrame(
  dims: { straightLength: number; totalLength: number; radius: number },
  genomeLength: number
): number {
  const capLength = Math.PI * dims.radius;
  return (
    ((dims.straightLength + capLength + dims.straightLength / 2) / dims.totalLength) * genomeLength
  );
}

function rightMidBpForFrame(
  dims: { straightLength: number; totalLength: number; radius: number },
  genomeLength: number
): number {
  const capLength = Math.PI * dims.radius;
  return ((dims.straightLength + capLength / 2) / dims.totalLength) * genomeLength;
}

function leftMidBpForFrame(
  dims: { straightLength: number; totalLength: number; radius: number },
  genomeLength: number
): number {
  const capLength = Math.PI * dims.radius;
  return ((dims.straightLength * 2 + capLength + capLength / 2) / dims.totalLength) * genomeLength;
}

function physicalLaneStackYBounds(
  path: NonNullable<ReturnType<PixiStadiumRenderer['getCurrentPathMapper']>>,
  dims: { straightLength: number; totalLength: number; radius: number },
  laneStackBounds: LaneStackBounds,
  genomeLength: number,
  overviewLaneScale = 1
): { top: number; bottom: number; center: number } {
  const minOffset = rawLaneOffsetForPath(laneStackBounds.minOffset, overviewLaneScale);
  const maxOffset = rawLaneOffsetForPath(laneStackBounds.maxOffset, overviewLaneScale);
  const sampleBps = [
    topMidBpForFrame(dims, genomeLength),
    rightMidBpForFrame(dims, genomeLength),
    bottomMidBpForFrame(dims, genomeLength),
    leftMidBpForFrame(dims, genomeLength),
  ];
  const ys = sampleBps.flatMap((bp) => [
    path.featureLabelPosAt(bp, minOffset).y,
    path.featureLabelPosAt(bp, maxOffset).y,
  ]);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return { top, bottom, center: (top + bottom) / 2 };
}

function rawLaneOffsetForPath(scaledOffset: number, overviewLaneScale: number): number {
  return overviewLaneScale > 1e-6 ? scaledOffset / overviewLaneScale : 0;
}

function wrapBp(bp: number, genomeLength: number): number {
  return ((bp % genomeLength) + genomeLength) % genomeLength;
}

function visibleBpAt(normalizedBp: number, genomeLength: number, viewOffset: number): number {
  return wrapBp(normalizedBp + viewOffset * genomeLength, genomeLength);
}

function topVisibleMidBpForFrame(
  dims: { straightLength: number; totalLength: number },
  genomeLength: number,
  viewOffset: number
): number {
  return visibleBpAt(topMidBpForFrame(dims, genomeLength), genomeLength, viewOffset);
}

function physicalLaneStackYBoundsForView(
  path: NonNullable<ReturnType<PixiStadiumRenderer['getCurrentPathMapper']>>,
  dims: { straightLength: number; totalLength: number; radius: number },
  laneStackBounds: LaneStackBounds,
  genomeLength: number,
  viewOffset: number,
  overviewLaneScale = 1
): { top: number; bottom: number; center: number } {
  const minOffset = rawLaneOffsetForPath(laneStackBounds.minOffset, overviewLaneScale);
  const maxOffset = rawLaneOffsetForPath(laneStackBounds.maxOffset, overviewLaneScale);
  const sampleBps = [
    topMidBpForFrame(dims, genomeLength),
    rightMidBpForFrame(dims, genomeLength),
    bottomMidBpForFrame(dims, genomeLength),
    leftMidBpForFrame(dims, genomeLength),
  ].map((bp) => visibleBpAt(bp, genomeLength, viewOffset));
  const ys = sampleBps.flatMap((bp) => [
    path.featureLabelPosAt(bp, minOffset).y,
    path.featureLabelPosAt(bp, maxOffset).y,
  ]);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return { top, bottom, center: (top + bottom) / 2 };
}

type StadiumCameraTraceSample = {
  zoom: number;
  topStackTopY: number;
  topStackBottomY: number;
  topStackCenterY: number;
  fullStackTopY: number;
  fullStackBottomY: number;
  rulerY: number;
  overviewLaneScale: number;
  sequenceRevealProgress: number;
  sequenceVisible: boolean;
  cameraProgress: number;
  cameraTargetTravelPx: number;
  cameraTransitionEndFitRatio: number;
  cameraFitRatio: number;
};

type StadiumCameraTraceConfig = {
  paneHeight: number;
  geometryHeight: number;
  morph: number;
  viewOffset: number;
};

function zoomTraceValues(minZoom: number, maxZoom: number): number[] {
  const values: number[] = [];
  let zoom = Math.max(minZoom, 0.01);
  while (zoom < maxZoom) {
    values.push(zoom);
    zoom *= zoom < 8 ? 1.006 : zoom < 120 ? 1.035 : 1.06;
  }
  values.push(maxZoom);
  return values;
}

async function collectStadiumCameraTrace(
  renderer: PixiStadiumRenderer,
  genome: Genome,
  config: StadiumCameraTraceConfig
): Promise<StadiumCameraTraceSample[]> {
  const state = createState();
  state.width = 1327;
  state.height = config.paneHeight;
  state.geometryHeight = config.geometryHeight;
  state.morph = config.morph;
  state.viewOffset = config.viewOffset;
  state.highlightRange = null;

  const app = {
    stage: new Container(),
    canvas: document.createElement('canvas'),
  } as unknown as Application;
  await renderer.init(app, genome, () => state);

  const minZoom = Math.max(0.01, renderer.getMinZoom(state));
  const zooms = zoomTraceValues(minZoom, 6000);
  const samples: StadiumCameraTraceSample[] = [];

  for (const zoom of zooms) {
    state.zoom = zoom;
    renderer.render(state);
    const path = renderer.getCurrentPathMapper();
    expect(path).not.toBeNull();
    if (!path) return samples;
    const frame = computeTestFrame(renderer, state);
    const visualLaneStackBounds = frame.rawLaneStackBounds;
    const minOffset = visualLaneStackBounds.minOffset;
    const maxOffset = visualLaneStackBounds.maxOffset;
    const topMidBp = topVisibleMidBpForFrame(frame.dims, genome.length, state.viewOffset);
    const topOuter = path.featureLabelPosAt(topMidBp, minOffset);
    const topInner = path.featureLabelPosAt(topMidBp, maxOffset);
    const fullBounds = physicalLaneStackYBoundsForView(
      path,
      frame.dims,
      visualLaneStackBounds,
      genome.length,
      state.viewOffset,
      1
    );

    samples.push({
      zoom,
      topStackTopY: Math.min(topOuter.y, topInner.y),
      topStackBottomY: Math.max(topOuter.y, topInner.y),
      topStackCenterY: (topOuter.y + topInner.y) / 2,
      fullStackTopY: fullBounds.top,
      fullStackBottomY: fullBounds.bottom,
      rulerY: path.rulerAt(topMidBp).y,
      overviewLaneScale: frame.layout.overviewLaneScale,
      sequenceRevealProgress: frame.layout.sequenceRevealProgress,
      sequenceVisible: frame.layout.sequenceVisible,
      cameraProgress: frame.cameraDebug.progress,
      cameraTargetTravelPx: frame.cameraDebug.targetTravelPx,
      cameraTransitionEndFitRatio: frame.cameraDebug.transitionEndFitRatio,
      cameraFitRatio: frame.cameraDebug.fitRatio,
    });
  }

  return samples;
}

function significantReversals(values: number[], thresholdPx: number): number[] {
  const reversals: number[] = [];
  for (let i = 2; i < values.length; i++) {
    const prev = values[i - 1] - values[i - 2];
    const next = values[i] - values[i - 1];
    if (prev === 0 || next === 0 || Math.sign(prev) === Math.sign(next)) continue;
    if (Math.abs(prev) + Math.abs(next) >= thresholdPx) reversals.push(i - 1);
  }
  return reversals;
}

function maxAdjacentDelta(values: number[]): number {
  let max = 0;
  for (let i = 1; i < values.length; i++) {
    max = Math.max(max, Math.abs(values[i] - values[i - 1]));
  }
  return max;
}

function maxAdjacentStep<T>(
  samples: T[],
  read: (sample: T) => number
): { index: number; delta: number; prev: T | null; current: T | null } {
  let index = 0;
  let delta = 0;
  for (let i = 1; i < samples.length; i++) {
    const step = read(samples[i]) - read(samples[i - 1]);
    if (Math.abs(step) > Math.abs(delta)) {
      index = i;
      delta = step;
    }
  }
  return {
    index,
    delta,
    prev: index > 0 ? samples[index - 1] : null,
    current: index > 0 ? samples[index] : null,
  };
}

function computeTestFrame(
  renderer: PixiStadiumRenderer,
  state: RenderState
): {
  dims: {
    width: number;
    height: number;
    straightLength: number;
    totalLength: number;
    radius: number;
  };
  ox: number;
  oy: number;
  stagePosY: number;
  laneStackBounds: LaneStackBounds;
  rawLaneStackBounds: LaneStackBounds;
  layout: UnifiedLayout;
  cameraDebug: StadiumCameraDebug;
} {
  return (
    renderer as unknown as {
      computeFrameForState: (state: RenderState) => {
        dims: {
          width: number;
          height: number;
          straightLength: number;
          totalLength: number;
          radius: number;
        };
        ox: number;
        oy: number;
        stagePosY: number;
        laneStackBounds: LaneStackBounds;
        rawLaneStackBounds: LaneStackBounds;
        layout: UnifiedLayout;
        cameraDebug: StadiumCameraDebug;
      };
    }
  ).computeFrameForState(state);
}

function expectValidCapGeometry(renderer: PixiStadiumRenderer, state: RenderState): void {
  const frame = computeTestFrame(renderer, state);
  const capRadiusPx = frame.dims.radius * state.zoom;
  const maxLaneOffsetPx = Math.max(
    frame.laneStackBounds.outwardExtent,
    frame.laneStackBounds.inwardExtent
  );

  expect(capRadiusPx).toBeGreaterThan(maxLaneOffsetPx + 4);
}

function topLaneStackBoundsAtTopMid(
  path: NonNullable<ReturnType<PixiStadiumRenderer['getCurrentPathMapper']>>,
  frame: {
    dims: { straightLength: number; totalLength: number; radius: number };
    laneStackBounds: LaneStackBounds;
    rawLaneStackBounds?: LaneStackBounds;
    layout: UnifiedLayout;
  },
  genomeLength: number
): { top: number; bottom: number; center: number } {
  const topMidBp = topMidBpForFrame(frame.dims, genomeLength);
  const visualLaneStackBounds = frame.rawLaneStackBounds ?? frame.laneStackBounds;
  const minOffset = visualLaneStackBounds.minOffset;
  const maxOffset = visualLaneStackBounds.maxOffset;
  const y0 = path.featureLabelPosAt(topMidBp, minOffset).y;
  const y1 = path.featureLabelPosAt(topMidBp, maxOffset).y;
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  return { top, bottom, center: (top + bottom) / 2 };
}

function topLaneStackTopY(
  path: NonNullable<ReturnType<PixiStadiumRenderer['getCurrentPathMapper']>>,
  frame: {
    dims: { straightLength: number; totalLength: number; radius: number };
    laneStackBounds: LaneStackBounds;
    rawLaneStackBounds?: LaneStackBounds;
    layout: UnifiedLayout;
  },
  genomeLength: number
): number {
  const topMidBp = topMidBpForFrame(frame.dims, genomeLength);
  const visualLaneStackBounds = frame.rawLaneStackBounds ?? frame.laneStackBounds;
  const minOffset = visualLaneStackBounds.minOffset;
  return path.featureLabelPosAt(topMidBp, minOffset).y;
}

function cameraBlendProgressForFrame(frame: ReturnType<typeof computeTestFrame>): number {
  return frame.cameraDebug.progress;
}

describe('PixiStadiumRenderer text selection boundaries', () => {
  it('removes every owned stage child when destroyed', async () => {
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => createState());
    expect(app.stage.children.length).toBeGreaterThan(0);

    renderer.destroy();

    expect(app.stage.children).toHaveLength(0);
  });

  it('keeps selection wash behind annotation layers and interaction handles above them', async () => {
    const state = createState();
    const renderer = new PixiStadiumRenderer();
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

  it.each([
    { mode: 'light' as const, color: 0xffffc8, alpha: 1, stroke: 0x000000 },
    { mode: 'dark' as const, color: 0xb4a032, alpha: 0.25, stroke: 0xf5e58a },
  ])(
    'draws the wrapped $mode selection fill behind foreground edge handles',
    async ({ mode, color, alpha, stroke }) => {
      const state = createState();
      state.themeMode = mode;
      const renderer = new PixiStadiumRenderer();
      const app = {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application;

      await renderer.init(app, createGenome(), () => state);
      const graphics = renderer as unknown as {
        selectionGraphics: {
          poly: (points: number[]) => unknown;
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

  it('can imperatively center the camera on a biological position', async () => {
    const state = createState();
    state.zoom = 3;
    state.morph = 0.5;
    state.highlightRange = null;
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    renderer.setViewCenterBp(420, state);

    expect(renderer.getViewCenterBp(state)).toBeCloseTo(420, 0);
  });

  it('hit-tests the end selection bar at the nucleotide boundary', async () => {
    const state = createState();
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    expect(path).not.toBeNull();
    if (!path) return;
    const boundaryAfterLastBase = path.boundaryAt(71, 'backbone');
    const distantBaseRegister = path.backboneAt(73);

    expect(
      renderer.hitTestSelectionHandle(boundaryAfterLastBase.x, boundaryAfterLastBase.y, state)
    ).toBe('end');
    expect(
      renderer.hitTestSelectionHandle(distantBaseRegister.x, distantBaseRegister.y, state)
    ).toBeNull();
  });

  it('draws the vertical cursor on a text boundary', async () => {
    const state = createState();
    state.highlightRange = null;
    state.cursorPosition = 71;
    const renderer = new PixiStadiumRenderer();
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
    const layout = (path as unknown as { inputs: { layout: UnifiedLayout } }).inputs.layout;
    const contract = resolveInteractionOverlayContract({ layout, mode: 'stadium' });
    const band = getInteractionLaneEnvelope(contract, 'cursor-line');
    const outerOffset = band?.minOffset ?? layout.annotationTop - layout.fwdStrandTop;
    const expectedOuter = path.featureLabelPosAt(70.5, outerOffset);
    const oldBaseRegister = path.featureLabelPosAt(71, outerOffset);
    const [actualX, actualY] = moveToSpy.mock.calls[0];

    expect(actualX).toBeCloseTo(expectedOuter.x, 5);
    expect(actualY).toBeCloseTo(expectedOuter.y, 5);
    expect(Math.hypot(actualX - oldBaseRegister.x, actualY - oldBaseRegister.y)).toBeCloseTo(
      path.pixelsPerBp / 2,
      1
    );
  });

  it('blinks an editing cursor without redrawing the interaction layer', async () => {
    vi.useFakeTimers();
    const state = createState();
    state.highlightRange = null;
    state.cursorPosition = 71;
    state.cursorBlinking = true;
    const presentRetainedStage = vi.fn();
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      render: presentRetainedStage,
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    renderer.render(state);

    const graphics = renderer as unknown as {
      editingCursorGraphics: Graphics;
      interactionGraphics: Graphics;
    };
    const cursorClearSpy = vi.spyOn(graphics.editingCursorGraphics, 'clear');
    const interactionClearSpy = vi.spyOn(graphics.interactionGraphics, 'clear');
    expect(graphics.editingCursorGraphics.visible).toBe(true);

    await vi.advanceTimersByTimeAsync(540);
    expect(graphics.editingCursorGraphics.visible).toBe(false);
    expect(presentRetainedStage).toHaveBeenCalledOnce();
    expect(cursorClearSpy).not.toHaveBeenCalled();
    expect(interactionClearSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(540);
    expect(graphics.editingCursorGraphics.visible).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    state.cursorPosition = 72;
    renderer.render(state);
    expect(graphics.editingCursorGraphics.visible).toBe(true);
    await vi.advanceTimersByTimeAsync(40);
    expect(graphics.editingCursorGraphics.visible).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(graphics.editingCursorGraphics.visible).toBe(false);

    renderer.destroy();
    const presentationsBeforeDestroyedClock = presentRetainedStage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(presentRetainedStage).toHaveBeenCalledTimes(presentationsBeforeDestroyedClock);
    vi.useRealTimers();
  });

  it('draws the transient hover guide on a text boundary', async () => {
    const state = createState();
    state.highlightRange = null;
    state.hoverPosition = 71;
    const renderer = new PixiStadiumRenderer();
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
    const layout = (path as unknown as { inputs: { layout: UnifiedLayout } }).inputs.layout;
    const contract = resolveInteractionOverlayContract({ layout, mode: 'stadium' });
    const band = getInteractionLaneEnvelope(contract, 'cursor-line');
    const outerOffset = band?.minOffset ?? layout.annotationTop - layout.fwdStrandTop;
    const expectedOuter = path.featureLabelPosAt(70.5, outerOffset);
    const [actualX, actualY] = moveToSpy.mock.calls[0];

    expect(actualX).toBeCloseTo(expectedOuter.x, 5);
    expect(actualY).toBeCloseTo(expectedOuter.y, 5);
  });

  it('publishes lane contract diagnostics after render', async () => {
    const state = createState();
    state.highlightRange = null;
    state.zoom = 2;
    state.height = 120;
    state.geometryHeight = 120;
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createStackedLaneGenome(), () => state);
    renderer.render(state);

    const snapshot = renderer.getRendererDebugSnapshot() as {
      frameContract?: {
        mode: string;
        semanticLod: string;
        tracks?: Array<{ trackId: string }>;
        fitEnvelope?: { height: number; laneStackBounds: LaneStackBounds };
        visualEnvelope?: { height: number; laneStackBounds: LaneStackBounds };
        diagnostics?: {
          fitEnvelopeMatchesCamera: boolean;
          laneGeometryScale: number;
          overviewLaneScale: number;
          laneScaleMismatch: boolean;
        };
        camera?: { debug?: StadiumCameraDebug };
      } | null;
      laneContracts?: {
        contracts?: Array<{ trackId: string }>;
        physicalStackBounds?: LaneStackBounds;
        gaps?: Array<{ id: string; gap: number }>;
      } | null;
      camera?: {
        laneStackBounds?: LaneStackBounds;
        rawLaneStackBounds?: LaneStackBounds;
        overviewLaneScale?: number;
      } | null;
    };

    expect(snapshot.laneContracts?.contracts?.map((contract) => contract.trackId)).toEqual([
      'annotations',
      'orfs',
      'primers',
      'sequence',
      'ruler',
      'cut-sites',
      'interactions',
    ]);
    expect(snapshot.laneContracts?.physicalStackBounds?.minOffset).toBeLessThan(0);
    expect(snapshot.laneContracts?.physicalStackBounds?.maxOffset).toBeGreaterThan(0);
    expect(snapshot.laneContracts?.gaps?.[0]).toEqual(
      expect.objectContaining({ id: 'nearest-track-to-ruler' })
    );
    expect(snapshot.camera?.rawLaneStackBounds?.maxOffset).toBeGreaterThan(0);
    expect(snapshot.camera?.laneStackBounds?.maxOffset).toBeGreaterThan(0);
    expect(snapshot.camera?.overviewLaneScale).toBeGreaterThanOrEqual(0);
    expect(snapshot.frameContract?.mode).toBe('stadium');
    expect(['overview', 'sequence-transition', 'nucleotide']).toContain(
      snapshot.frameContract?.semanticLod
    );
    expect(snapshot.frameContract?.tracks?.map((contract) => contract.trackId)).toEqual([
      'annotations',
      'orfs',
      'primers',
      'sequence',
      'ruler',
      'cut-sites',
    ]);
    expect(snapshot.frameContract?.fitEnvelope?.laneStackBounds).toEqual(
      snapshot.camera?.laneStackBounds
    );
    expect(snapshot.frameContract?.visualEnvelope?.laneStackBounds).toEqual(
      snapshot.camera?.rawLaneStackBounds
    );
    expect(snapshot.frameContract?.diagnostics?.fitEnvelopeMatchesCamera).toBe(true);
    expect(snapshot.frameContract?.fitEnvelope?.height).toBeCloseTo(
      snapshot.frameContract?.camera?.debug?.fullShapeVisualHeight ?? 0,
      5
    );
  });

  it('keeps full lane contract diagnostics out of the render hot path', async () => {
    const state = createState();
    state.highlightRange = null;
    state.zoom = 2;
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createStackedLaneGenome(), () => state);
    const buildSnapshotSpy = vi.spyOn(
      renderer as unknown as { buildLaneContractSnapshot: () => unknown },
      'buildLaneContractSnapshot'
    );

    renderer.render(state);
    renderer.render({ ...state, hoveredId: 1 });

    expect(buildSnapshotSpy).not.toHaveBeenCalled();

    const snapshot = renderer.getRendererDebugSnapshot() as {
      laneContracts?: { contracts?: Array<{ trackId: string }> } | null;
    };
    expect(buildSnapshotSpy).toHaveBeenCalledTimes(1);
    expect(snapshot.laneContracts?.contracts?.some((contract) => contract.trackId === 'orfs')).toBe(
      true
    );
  });

  it('keeps annotation and CDS codon hit geometry alive whenever nucleotide text is visible', async () => {
    const genome = createDenseNucleotideVisualCompletenessGenome();
    const state = createState();
    state.width = 1000;
    state.height = 260;
    state.geometryHeight = 220;
    state.morph = 1;
    state.zoom = 80;
    state.highlightRange = null;
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);

    for (const viewOffset of [0, 0.11, 0.29, 0.47, 0.73]) {
      state.viewOffset = viewOffset;
      renderer.render(state);
      const path = renderer.getCurrentPathMapper();
      expect(path).not.toBeNull();
      if (!path) continue;

      const snapshot = renderer.getRendererDebugSnapshot() as {
        sequenceTrack?: { fwdVisible?: number } | null;
        annotationOverlay?: { hitRecords?: number } | null;
        codonTrack?: { hitCount?: number } | null;
      };

      expect(path.sequenceVisible, `viewOffset=${viewOffset}`).toBe(true);
      expect(snapshot.sequenceTrack?.fwdVisible ?? 0, `viewOffset=${viewOffset}`).toBeGreaterThan(
        0
      );
      expect(
        snapshot.annotationOverlay?.hitRecords ?? 0,
        `viewOffset=${viewOffset}`
      ).toBeGreaterThan(0);
      expect(snapshot.codonTrack?.hitCount ?? 0, `viewOffset=${viewOffset}`).toBeGreaterThan(0);
    }
  });

  it('keeps the stadium ruler line bounded to the visible window during MG1655 zoom transitions', async () => {
    const genome = createMg1655ConcaveRegressionGenome();
    const state = createState();
    state.width = 1328;
    state.height = 300;
    state.geometryHeight = 300;
    state.morph = 0;
    state.highlightRange = null;
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);

    for (const zoom of [198, 2591, 5151, 20_315]) {
      state.zoom = zoom;
      renderer.render(state);
      const snapshot = renderer.getRendererDebugSnapshot() as {
        ruler?: { lineSegmentsDrawn?: number };
        visibleWorkBudget?: { violations?: string[]; metrics?: { rulerLineSegments?: number } };
      };
      const segments = snapshot.ruler?.lineSegmentsDrawn ?? 0;
      expect(segments, `zoom=${zoom}`).toBeGreaterThan(0);
      expect(segments, `zoom=${zoom}`).toBeLessThanOrEqual(2300);
      expect(snapshot.visibleWorkBudget?.metrics?.rulerLineSegments, `zoom=${zoom}`).toBe(segments);
      expect(snapshot.visibleWorkBudget?.violations, `zoom=${zoom}`).toEqual([]);
    }
  });

  it('draws a full circular ruler with an analytic circle instead of polygon chords', async () => {
    const state = createState();
    state.width = 800;
    state.height = 420;
    state.geometryHeight = 420;
    state.morph = 1;
    state.zoom = 1;
    state.highlightRange = null;
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    const rulerGraphics = (renderer as unknown as { rulerGraphics: Graphics }).rulerGraphics;
    const circleSpy = vi.spyOn(rulerGraphics, 'circle');

    await renderer.init(app, createGenome(), () => state);
    renderer.render(state);

    const snapshot = renderer.getRendererDebugSnapshot() as {
      ruler?: { lineSegmentsDrawn?: number; usedAnalyticCircle?: boolean };
    };
    expect(snapshot.ruler?.usedAnalyticCircle).toBe(true);
    expect(snapshot.ruler?.lineSegmentsDrawn).toBe(0);
    expect(circleSpy).toHaveBeenCalled();
  });

  it('keeps stadium ruler labels phase-stable across the circular origin  ①)', async () => {
    const genome = createMg1655ConcaveRegressionGenome();
    const state = createState();
    state.width = 1328;
    state.height = 300;
    state.geometryHeight = 300;
    state.morph = 0;
    state.highlightRange = null;
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);

    const readWindow = () =>
      (
        renderer.getRendererDebugSnapshot() as {
          ruler?: {
            window?: {
              step: number;
              centerBp: number;
              windowBp: number;
              circular: boolean;
            } | null;
          };
        }
      ).ruler?.window ?? null;

    const parseRulerLabel = (t: string): number => {
      if (t.endsWith('M')) return Math.round(parseFloat(t) * 1_000_000);
      if (t.endsWith('K')) return Math.round(parseFloat(t) * 1_000);
      return Math.round(parseFloat(t.replace(/,/g, '')));
    };

    const windowWraps = (win: { centerBp: number; windowBp: number }): boolean => {
      const span = Math.min(genome.length, win.windowBp);
      const start =
        (((win.centerBp - win.windowBp / 2) % genome.length) + genome.length) % genome.length;
      return start + span > genome.length;
    };

    let sawSeamWithLabels = false;
    let sawPostOriginLabel = false;

    for (const zoom of [198, 2591, 5151, 20_315]) {
      state.zoom = zoom;

      state.viewOffset = 0;
      renderer.render(state);
      const probe = readWindow();
      expect(probe, `zoom=${zoom} probe`).toBeTruthy();
      if (!probe) continue;
      state.viewOffset = (((1 - probe.centerBp / genome.length) % 1) + 1) % 1;

      renderer.render(state);
      const win = readWindow();
      expect(win, `zoom=${zoom} seam`).toBeTruthy();
      if (!win || !windowWraps(win) || renderer.rulerLabelsMeta.length === 0) continue;
      sawSeamWithLabels = true;

      for (const meta of renderer.rulerLabelsMeta) {
        const bp = parseRulerLabel(meta.text);

        expect(bp % win.step, `zoom=${zoom} drifted label "${meta.text}" → bp ${bp}`).toBe(0);
        expect(bp, `zoom=${zoom} label "${meta.text}"`).toBeGreaterThanOrEqual(0);
        expect(bp, `zoom=${zoom} label "${meta.text}"`).toBeLessThan(genome.length);

        if (bp <= win.step * 3) sawPostOriginLabel = true;
      }
    }

    expect(sawSeamWithLabels, 'no origin-straddling ruler window with labels was exercised').toBe(
      true
    );
    expect(sawPostOriginLabel, 'post-origin (seam) half never rendered a tick label').toBe(true);
  });

  it('draws hovered codon background as an arc-following sequence row band', async () => {
    const state = createState();
    state.highlightRange = null;
    state.hoveredCodon = { start: 10, end: 12, strand: 1 };
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const interactionGraphics = (
      renderer as unknown as {
        interactionGraphics: {
          poly: (points: number[]) => unknown;
          fill: (opts: { color: number; alpha: number }) => unknown;
        };
      }
    ).interactionGraphics;
    const polySpy = vi.spyOn(interactionGraphics, 'poly');
    const fillSpy = vi.spyOn(interactionGraphics, 'fill');
    renderer.render(state);

    expect(polySpy).toHaveBeenCalled();
    expect(fillSpy).toHaveBeenCalledWith({ color: 0x8c8c8c, alpha: 0.25 });
  });

  describe('residue-link wash (cross-surface, zoom-gated)', () => {
    const RESIDUE_LINK_FILL = 0xfbbf24;
    const RESIDUE_LINK_FILL_ALPHA = 0.45;

    function spyInteractionGraphics(renderer: PixiStadiumRenderer) {
      const interactionGraphics = (
        renderer as unknown as {
          interactionGraphics: {
            poly: (points: number[]) => unknown;
            fill: (opts: { color: number; alpha: number }) => unknown;
          };
        }
      ).interactionGraphics;
      return {
        poly: vi.spyOn(interactionGraphics, 'poly'),
        fill: vi.spyOn(interactionGraphics, 'fill'),
      };
    }

    it('paints amber arc-band poly+fill when residueLinkRange is set and sequence-LOD is active', async () => {
      const state = createState();

      state.highlightRange = null;
      state.viewportRange = null;
      state.hoveredCodon = null;
      state.cursorPosition = null;
      state.hoverPosition = null;
      state.residueLinkRange = [100, 102];

      const renderer = new PixiStadiumRenderer();
      const app = {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application;
      await renderer.init(app, createGenome(), () => state);
      const spies = spyInteractionGraphics(renderer);
      renderer.render(state);

      const path = renderer.getCurrentPathMapper();
      expect(path).not.toBeNull();

      const layout = (path as unknown as { inputs: { layout: UnifiedLayout } }).inputs.layout;
      expect(layout.sequenceVisible).toBe(true);

      expect(spies.poly).toHaveBeenCalled();

      expect(spies.fill).toHaveBeenCalledWith({
        color: RESIDUE_LINK_FILL,
        alpha: RESIDUE_LINK_FILL_ALPHA,
      });
    });

    it('does NOT paint when sequence-LOD is inactive (zoomed out, bp-per-pixel ≥ 5)', async () => {
      const state = createState();
      state.highlightRange = null;
      state.viewportRange = null;
      state.hoveredCodon = null;
      state.cursorPosition = null;
      state.hoverPosition = null;
      state.residueLinkRange = [100, 102];

      const longGenome: Genome = {
        name: 'residue-link-zoom-gate-test',
        length: 50_000,
        circular: true,
        features: [],
        sequence: 'A'.repeat(50_000),
      };
      state.zoom = 1;

      const renderer = new PixiStadiumRenderer();
      const app = {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application;
      await renderer.init(app, longGenome, () => state);
      const spies = spyInteractionGraphics(renderer);
      renderer.render(state);

      const path = renderer.getCurrentPathMapper();
      expect(path).not.toBeNull();
      const layout = (path as unknown as { inputs: { layout: UnifiedLayout } }).inputs.layout;
      expect(layout.sequenceVisible).toBe(false);

      const ourFills = spies.fill.mock.calls.filter(
        ([opts]) => opts && opts.color === RESIDUE_LINK_FILL
      );
      expect(ourFills).toHaveLength(0);
    });

    it('does NOT paint when residueLinkRange is null', async () => {
      const state = createState();
      state.highlightRange = null;
      state.viewportRange = null;
      state.hoveredCodon = null;
      state.cursorPosition = null;
      state.hoverPosition = null;
      state.residueLinkRange = null;

      const renderer = new PixiStadiumRenderer();
      const app = {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application;
      await renderer.init(app, createGenome(), () => state);
      const spies = spyInteractionGraphics(renderer);
      renderer.render(state);

      const ourFills = spies.fill.mock.calls.filter(
        ([opts]) => opts && opts.color === RESIDUE_LINK_FILL
      );
      expect(ourFills).toHaveLength(0);
    });

    it('handles wrapped circular ranges by emitting two arc segments', async () => {
      const state = createState();
      state.highlightRange = null;
      state.viewportRange = null;
      state.hoveredCodon = null;
      state.cursorPosition = null;
      state.hoverPosition = null;

      state.residueLinkRange = [998, 0];

      const renderer = new PixiStadiumRenderer();
      const app = {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application;
      await renderer.init(app, createGenome(), () => state);
      const spies = spyInteractionGraphics(renderer);
      renderer.render(state);

      const ourFills = spies.fill.mock.calls.filter(
        ([opts]) => opts && opts.color === RESIDUE_LINK_FILL
      );
      expect(ourFills).toHaveLength(2);
    });
  });

  it('hit-tests visible arc nucleotide rows for text cursor affordance', async () => {
    const state = createState();
    state.highlightRange = null;
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    expect(path).not.toBeNull();
    if (!path) return;
    const fwd = path.fwdStrandAt(50);

    expect(renderer.hitTestNucleotideText(fwd.x, fwd.y, state)).toBe(true);
    expect(renderer.hitTestNucleotideText(fwd.x, fwd.y + 100, state)).toBe(false);
  });

  it('keeps a side-arc bp under the cursor when zooming circular mode', async () => {
    const state = createState();
    state.morph = 1;
    state.zoom = 1;
    state.highlightRange = null;
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    expect(path).not.toBeNull();
    if (!path) return;
    const anchorBp = 250;
    const cursor = path.backboneAt(anchorBp);

    renderer.adjustViewOffsetForZoom(state.zoom, 4, state, cursor.x, cursor.y);
    state.zoom = 4;

    const bpBeforeRender = renderer.screenToBp(cursor.x, cursor.y, state);
    expect(circularBpDistance(bpBeforeRender, anchorBp, createGenome().length)).toBeLessThanOrEqual(
      1
    );

    renderer.render(state);

    const bpAfterZoom = renderer.screenToBp(cursor.x, cursor.y, state);
    expect(circularBpDistance(bpAfterZoom, anchorBp, createGenome().length)).toBeLessThanOrEqual(1);
  });

  it('round-trips a rendered between-base boundary without a one-base drift', async () => {
    const state = createState();
    state.highlightRange = null;
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    expect(path).not.toBeNull();
    if (!path) return;
    const boundary = 250;
    const point = path.backboneAt(boundary - 0.5);

    expect(renderer.screenToBoundaryBp(point.x, point.y, state)).toBe(boundary);
  });

  it('only allows cursor-anchored zoom inside the lane deck hitbox', async () => {
    const state = createState();
    state.morph = 1;
    state.zoom = 1;
    state.highlightRange = null;
    const genome = createStackedLaneGenome();
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    expect(path).not.toBeNull();
    if (!path) return;
    const frame = computeTestFrame(renderer, state);
    const layout = (path as unknown as { inputs: { layout: UnifiedLayout } }).inputs.layout;
    const interactionContract = resolveInteractionOverlayContract({ layout, mode: 'stadium' });
    const band = getInteractionLaneEnvelope(interactionContract, 'cursor-line');
    expect(band).not.toBeNull();
    if (!band) return;

    const topMidBp = topMidBpForFrame(frame.dims, genome.length);
    const outer = path.featureLabelPosAt(topMidBp - 0.5, band.minOffset);
    const inner = path.featureLabelPosAt(topMidBp - 0.5, band.maxOffset);
    const deckMid = { x: (outer.x + inner.x) / 2, y: (outer.y + inner.y) / 2 };

    expect(renderer.hitTestZoomAnchor(deckMid.x, deckMid.y, state)).toBe(true);
    expect(renderer.hitTestZoomAnchor(deckMid.x, Math.min(outer.y, inner.y) - 20, state)).toBe(
      false
    );
  });

  it('fits the full physical lane stack vertically instead of only non-CDS annotation lanes', async () => {
    const state = createState();
    state.zoom = 1;
    state.highlightRange = null;
    const genome = createStackedLaneGenome();
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);

    state.geometryHeight = state.height;
    state.height += computeTestFrame(renderer, state).cameraDebug.floatingLabelTopReservePx;
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    expect(path).not.toBeNull();
    if (!path) return;
    const frame = computeTestFrame(renderer, state);
    expect(frame.laneStackBounds.outwardExtent).toBeGreaterThan(40);
    const topOffset = rawLaneOffsetForPath(
      frame.laneStackBounds.minOffset,
      frame.layout.overviewLaneScale
    );

    const topOuter = path.featureLabelPosAt(topMidBpForFrame(frame.dims, genome.length), topOffset);
    const bottomOuter = path.featureLabelPosAt(
      bottomMidBpForFrame(frame.dims, genome.length),
      topOffset
    );

    expect(topOuter.y).toBeGreaterThanOrEqual(9.5);
    expect(bottomOuter.y).toBeLessThanOrEqual(state.height - 9.5);
  });

  it('keeps stadium geometry stable when the pane height changes but geometryHeight is fixed', async () => {
    const state = createState();
    state.zoom = 1;
    state.height = 260;
    state.geometryHeight = 420;
    state.highlightRange = null;
    const genome = createStackedLaneGenome();
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);
    const computeFrame = (
      renderer as unknown as {
        computeFrameForState: (state: RenderState) => {
          dims: { height: number; radius: number; straightLength: number; totalLength: number };
          pixelsPerBp: number;
          layout: UnifiedLayout;
          stagePosY: number;
        };
      }
    ).computeFrameForState.bind(renderer);

    const shortPaneFrame = computeFrame(state);
    const tallPaneFrame = computeFrame({ ...state, height: 560 });

    expect(shortPaneFrame.dims.height).toBeCloseTo(tallPaneFrame.dims.height, 5);
    expect(shortPaneFrame.dims.radius).toBeCloseTo(tallPaneFrame.dims.radius, 5);
    expect(shortPaneFrame.dims.straightLength).toBeCloseTo(tallPaneFrame.dims.straightLength, 5);
    expect(shortPaneFrame.dims.totalLength).toBeCloseTo(tallPaneFrame.dims.totalLength, 5);
    expect(shortPaneFrame.pixelsPerBp).toBeCloseTo(tallPaneFrame.pixelsPerBp, 5);
    expect(shortPaneFrame.layout.compactScale).toBeCloseTo(tallPaneFrame.layout.compactScale, 5);
  });

  it('centers floating labels and the physical lane stack in an oversized pane', async () => {
    const genome = createStackedLaneGenome();
    for (const morph of [0, 0.5, 1]) {
      const state = createState();
      state.morph = morph;
      state.zoom = 1;
      state.height = 600;
      state.geometryHeight = 260;
      state.highlightRange = null;
      const renderer = new PixiStadiumRenderer();
      const app = {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application;

      await renderer.init(app, genome, () => state);
      renderer.render(state);

      const path = renderer.getCurrentPathMapper();
      expect(path).not.toBeNull();
      if (!path) return;
      const frame = computeTestFrame(renderer, state);
      const bounds = physicalLaneStackYBounds(
        path,
        frame.dims,
        frame.laneStackBounds,
        genome.length,
        frame.layout.overviewLaneScale
      );

      const visibleCenter = bounds.center - frame.cameraDebug.floatingLabelTopReservePx / 2;
      expect(visibleCenter).toBeCloseTo(state.height / 2, 0);
    }
  });

  it(
    'keeps fitting lane stacks visible and bottom-pins oversized stacks through the camera transition sweep',
    async () => {
      const genome = createStackedLaneGenome();
      const renderer = new PixiStadiumRenderer();
      const state = createState();
      state.highlightRange = null;
      const app = {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application;
      await renderer.init(app, genome, () => state);

      const zooms = RUN_STADIUM_CAMERA_STRESS ? [1, 1.25, 1.5, 2, 2.5, 3, 4, 6, 8] : [1, 2, 4, 8];
      for (const geometryHeight of [undefined, 260]) {
        state.geometryHeight = geometryHeight;
        for (const morph of [0, 0.5, 1]) {
          for (const height of [260, 420, 600]) {
            for (const zoom of zooms) {
              state.morph = morph;
              state.height = height;
              state.zoom = zoom;
              renderer.render(state);
              const path = renderer.getCurrentPathMapper();
              expect(
                path,
                `path exists for geometryHeight=${geometryHeight ?? 'pane'} morph=${morph} height=${height} zoom=${zoom}`
              ).not.toBeNull();
              if (!path) return;
              const frame = computeTestFrame(renderer, state);
              const topY = topLaneStackTopY(path, frame, genome.length);
              const drawnBounds = topLaneStackBoundsAtTopMid(path, frame, genome.length);
              const drawnHeight = drawnBounds.bottom - drawnBounds.top;
              const description = `geometryHeight=${geometryHeight ?? 'pane'} morph=${morph} height=${height} zoom=${zoom}`;
              if (drawnHeight <= height) {
                expect(topY, description).toBeGreaterThanOrEqual(-0.5);
              } else {
                expect(drawnHeight, description).toBeGreaterThan(height);
                expect(drawnBounds.bottom, description).toBeCloseTo(height, 5);
                expect(topY, description).toBeCloseTo(height - drawnHeight, 5);
                const ruler = path.rulerAt(topMidBpForFrame(frame.dims, genome.length));
                expect(ruler.y, description).toBeGreaterThanOrEqual(0);
                expect(ruler.y, description).toBeLessThanOrEqual(height);
              }
            }
          }
        }
      }
    },
    RUN_STADIUM_CAMERA_STRESS ? 30_000 : 10_000
  );

  it('keeps small-pane stadium overview visible with a clipped camera lane deck', async () => {
    const genome = createMg1655ConcaveRegressionGenome();
    const renderer = new PixiStadiumRenderer();
    const state = createState();
    state.width = 1327;
    state.height = 220;
    state.geometryHeight = 180;
    state.highlightRange = null;
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genome, () => state);

    for (const morph of [0, 0.5, 1]) {
      state.morph = morph;
      state.zoom = renderer.getMinZoom(state);

      expect(state.zoom, `morph=${morph}`).toBeLessThanOrEqual(1);
      expectValidCapGeometry(renderer, state);
      renderer.render(state);
      const path = renderer.getCurrentPathMapper();
      expect(path).not.toBeNull();
      if (!path) return;
      const frame = computeTestFrame(renderer, state);
      const bounds = physicalLaneStackYBounds(
        path,
        frame.dims,
        frame.laneStackBounds,
        genome.length,
        1
      );

      expect(frame.layout.overviewLaneScale, `morph=${morph}`).toBeLessThan(1);
      expect(frame.layout.laneGeometryScale, `morph=${morph}`).toBe(1);
      expect(bounds.top, `morph=${morph}`).toBeGreaterThanOrEqual(9.5);
      expect(bounds.bottom, `morph=${morph}`).toBeLessThanOrEqual(state.height - 9.5);
    }
  });

  it('keeps zoom 4 and valid caps in a narrow full-circle genome pane', async () => {
    const genome = createMg1655ConcaveRegressionGenome();
    const renderer = new PixiStadiumRenderer();
    const state: RenderState = {
      ...createState(),
      width: 418,
      height: 688,
      geometryHeight: 600,
      morph: 1,
      zoom: 4,
      viewOffset: 0.5,
      highlightRange: null,
    };
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genome, () => state);

    const frame = computeTestFrame(renderer, state);
    expect
      .soft(frame.dims.radius, 'the circular backbone has a positive radius')
      .toBeGreaterThan(0);
    expect
      .soft(renderer.getMinZoom(state), 'the supported range includes the requested zoom')
      .toBeLessThanOrEqual(4);
    renderer.render(state);
    expect.soft(state.zoom, 'rendering preserves the requested camera zoom').toBe(4);
    expect(state.viewOffset).toBe(0.5);
    expectValidCapGeometry(renderer, state);
  });

  it('lets the stadium zoom floor go below the old fixed floor when the contract-fit view requires it', async () => {
    const genome = createMg1655ConcaveRegressionGenome();
    const renderer = new PixiStadiumRenderer();
    const state = createState();
    state.width = 1327;
    state.height = 120;
    state.geometryHeight = 1200;
    state.morph = 0;
    state.highlightRange = null;
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genome, () => state);

    const minZoom = renderer.getMinZoom(state);
    const frame = computeTestFrame(renderer, { ...state, zoom: minZoom });

    expect(minZoom).toBeLessThan(0.05);
    expect(fullShapeVisualHeight(frame.dims, minZoom, frame.laneStackBounds)).toBeLessThanOrEqual(
      frame.cameraDebug.availableHeight + 0.5
    );
    expectValidCapGeometry(renderer, { ...state, zoom: minZoom });
  });

  it('allows useful overview zoom-out when physical lanes fit but labels need more space', async () => {
    const genome = createMg1655ConcaveRegressionGenome();
    const renderer = new PixiStadiumRenderer();
    const state = createState();
    state.width = 1327;
    state.height = 180;
    state.geometryHeight = 180;
    state.morph = 0;
    state.highlightRange = null;
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genome, () => state);

    const frameAtOne = computeTestFrame(renderer, { ...state, zoom: 1 });
    const minZoom = renderer.getMinZoom(state);
    const frameAtMin = computeTestFrame(renderer, { ...state, zoom: minZoom });

    expect(
      frameAtOne.cameraDebug.fullShapeVisualHeight -
        frameAtOne.cameraDebug.floatingLabelTopReservePx
    ).toBeLessThanOrEqual(frameAtOne.cameraDebug.availableHeight + 0.5);
    expect(frameAtMin.cameraDebug.fullShapeVisualHeight).toBeLessThanOrEqual(
      frameAtMin.cameraDebug.availableHeight + 0.5
    );
    expect(minZoom).toBeLessThan(1);
    expect(minZoom).toBeLessThanOrEqual(0.2);
    expect(frameAtMin.dims.width * minZoom).toBeLessThan(frameAtOne.dims.width);
    expect(
      frameAtMin.dims.width * minZoom + 2 * frameAtMin.rawLaneStackBounds.outwardExtent
    ).toBeLessThanOrEqual(state.width - 24 + 0.5);
    expectValidCapGeometry(renderer, { ...state, zoom: minZoom });
  });

  it('keeps annotation lanes readable at the minimum supported stadium height', async () => {
    const genome = createSingleAnnotationGenome();
    const renderer = new PixiStadiumRenderer();
    const state = createState();
    state.width = 1327;
    state.height = 180;
    state.geometryHeight = 180;
    state.morph = 0;
    state.highlightRange = null;
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genome, () => state);

    state.zoom = renderer.getMinZoom(state);
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    expect(path).not.toBeNull();
    if (!path) return;
    const frame = computeTestFrame(renderer, state);
    const pts = path.featurePolygonAt(200, 1500, frame.layout.annotationOffset, 7);
    const firstOuterX = pts[0];
    const firstOuterY = pts[1];
    const firstInnerX = pts[pts.length - 2];
    const firstInnerY = pts[pts.length - 1];
    const renderedThickness = Math.hypot(firstOuterX - firstInnerX, firstOuterY - firstInnerY);

    expect(frame.layout.laneGeometryScale).toBe(1);
    expect(renderedThickness).toBeGreaterThanOrEqual(13.5);
  });

  it(
    'keeps the stadium camera stable across pane heights and circularity morphs',
    async () => {
      const genome = createMg1655ConcaveRegressionGenome();
      const configs: StadiumCameraTraceConfig[] = RUN_STADIUM_CAMERA_STRESS
        ? []
        : [
            { paneHeight: 180, geometryHeight: 180, morph: 0, viewOffset: 0 },
            { paneHeight: 220, geometryHeight: 180, morph: 0.5, viewOffset: 0.25 },
            { paneHeight: 360, geometryHeight: 260, morph: 1, viewOffset: 0 },
            { paneHeight: 520, geometryHeight: 260, morph: 0.5, viewOffset: 0.25 },
          ];

      if (RUN_STADIUM_CAMERA_STRESS) {
        for (const paneHeight of [180, 220, 360, 520]) {
          for (const morph of [0, 0.5, 1]) {
            for (const viewOffset of [0, 0.25]) {
              configs.push({
                paneHeight,
                geometryHeight: paneHeight <= 220 ? 180 : 260,
                morph,
                viewOffset,
              });
            }
          }
        }
      }

      for (const config of configs) {
        const label =
          `pane=${config.paneHeight} geometry=${config.geometryHeight} ` +
          `morph=${config.morph} viewOffset=${config.viewOffset}`;
        const renderer = new PixiStadiumRenderer();
        const samples = await collectStadiumCameraTrace(renderer, genome, config);

        expect(samples.length, label).toBeGreaterThan(80);

        for (const sample of samples) {
          const stackHeight = sample.topStackBottomY - sample.topStackTopY;
          if (stackHeight <= config.paneHeight + 1) {
            expect(sample.topStackTopY, `${label} zoom=${sample.zoom}`).toBeGreaterThanOrEqual(
              -0.5
            );
            expect(sample.topStackBottomY, `${label} zoom=${sample.zoom}`).toBeLessThanOrEqual(
              config.paneHeight + 0.5
            );
          } else if (sample.cameraProgress >= 0.999) {
            expect(sample.topStackBottomY, `${label} zoom=${sample.zoom}`).toBeLessThanOrEqual(
              config.paneHeight + 0.5
            );
            expect(sample.topStackTopY, `${label} zoom=${sample.zoom}`).toBeLessThan(0);
          }
          if (stackHeight <= config.paneHeight + 1) {
            expect(sample.rulerY, `${label} zoom=${sample.zoom}`).toBeGreaterThanOrEqual(0);
            expect(sample.rulerY, `${label} zoom=${sample.zoom}`).toBeLessThanOrEqual(
              config.paneHeight
            );
          }
        }

        const fittedSamples = samples.filter(
          (sample) => sample.topStackBottomY - sample.topStackTopY <= config.paneHeight + 1
        );
        const stabilitySamples = fittedSamples.length > 8 ? fittedSamples : samples;
        const centers = stabilitySamples.map((sample) => sample.topStackCenterY);
        const rulers = stabilitySamples.map((sample) => sample.rulerY);
        const centerReversals = significantReversals(centers, 7);
        const rulerReversals = significantReversals(rulers, 7);
        const maxCenterStep = maxAdjacentStep(stabilitySamples, (sample) => sample.topStackCenterY);
        const maxRulerStep = maxAdjacentStep(stabilitySamples, (sample) => sample.rulerY);

        expect(stabilitySamples.length, `${label} should have camera samples`).toBeGreaterThan(8);
        expect(
          maxAdjacentDelta(centers),
          `${label} top stack center should not jump between adjacent zoom samples; ` +
            `maxStep=${JSON.stringify(maxCenterStep)}`
        ).toBeLessThanOrEqual(14);
        expect(
          maxAdjacentDelta(rulers),
          `${label} ruler should not jump between adjacent zoom samples; ` +
            `maxStep=${JSON.stringify(maxRulerStep)}`
        ).toBeLessThanOrEqual(14);
        expect(
          centerReversals,
          `${label} top stack center had visible V-shaped reversals at indices ${centerReversals.join(', ')}; ` +
            `windows=${JSON.stringify(
              centerReversals.map((index) => fittedSamples.slice(Math.max(0, index - 2), index + 3))
            )}`
        ).toEqual([]);
        expect(
          rulerReversals,
          `${label} ruler had visible V-shaped reversals at indices ${rulerReversals.join(', ')}`
        ).toEqual([]);
      }
    },
    RUN_STADIUM_CAMERA_STRESS ? 60_000 : 20_000
  );

  it('does not allow the stadium zoom floor to make cap lane geometry concave', async () => {
    const state = createState();
    state.width = 1327;
    state.height = 287;
    state.geometryHeight = 180;
    state.morph = 0;
    state.highlightRange = null;
    const genome = createMg1655ConcaveRegressionGenome();
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);

    const minZoom = renderer.getMinZoom(state);
    expect(minZoom).toBeLessThanOrEqual(1);
    expectValidCapGeometry(renderer, { ...state, zoom: minZoom });

    state.zoom = 0.05;
    renderer.render(state);

    expect(state.zoom).toBeGreaterThan(0.05);
    expect(state.zoom).toBeLessThanOrEqual(1);
    expect(computeTestFrame(renderer, state).layout.overviewLaneScale).toBeLessThan(1);
    expectValidCapGeometry(renderer, state);
  });

  it('computes compact stadium overview frames without redundant layout passes', async () => {
    const state = createState();
    state.width = 1327;
    state.height = 220;
    state.geometryHeight = 180;
    state.morph = 0;
    state.highlightRange = null;
    const genome = createMg1655ConcaveRegressionGenome();
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);
    const minZoom = renderer.getMinZoom(state);

    const rendererForBench = renderer as unknown as {
      computeFrameForState: (state: RenderState, zoom?: number) => unknown;
      computeLayoutForFrame: (...args: unknown[]) => UnifiedLayout;
    };
    const originalComputeLayout = rendererForBench.computeLayoutForFrame.bind(renderer);
    const layoutCallsByZoom: Array<{ zoom: number; calls: number }> = [];
    rendererForBench.computeLayoutForFrame = (...args: unknown[]) => {
      layoutCallsByZoom[layoutCallsByZoom.length - 1].calls += 1;
      return originalComputeLayout(...args);
    };

    try {
      for (const zoom of [minZoom, minZoom * 1.15, minZoom * 1.35, minZoom * 1.7, 1]) {
        layoutCallsByZoom.push({ zoom, calls: 0 });
        rendererForBench.computeFrameForState({ ...state, zoom }, zoom);
      }
    } finally {
      rendererForBench.computeLayoutForFrame = originalComputeLayout;
    }

    expect(layoutCallsByZoom.length).toBeGreaterThan(0);
    for (const sample of layoutCallsByZoom) {
      expect(
        sample.calls,
        `zoom=${sample.zoom} should compute layout at most once per padding iteration`
      ).toBeLessThanOrEqual(5);
    }
  });

  it('keeps overview lane compaction smooth across the affected zoom band', async () => {
    const state = createState();
    state.width = 1327;
    state.height = 220;
    state.geometryHeight = 180;
    state.morph = 0;
    state.highlightRange = null;
    const genome = createMg1655ConcaveRegressionGenome();
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);

    const minZoom = renderer.getMinZoom(state);
    let fullScaleZoom = 1;
    while (
      fullScaleZoom < 32 &&
      computeTestFrame(renderer, { ...state, zoom: fullScaleZoom }).layout.overviewLaneScale < 1
    ) {
      fullScaleZoom *= 1.5;
    }
    const zooms = Array.from(
      { length: 64 },
      (_, idx) => minZoom + (idx / 63) * (fullScaleZoom - minZoom)
    );
    const scales = zooms.map(
      (zoom) => computeTestFrame(renderer, { ...state, zoom }).layout.overviewLaneScale
    );

    for (let i = 1; i < scales.length; i++) {
      expect(
        scales[i],
        `scale should be monotonic while zoom increases at index ${i}`
      ).toBeGreaterThanOrEqual(scales[i - 1] - 1e-6);
      expect(
        Math.abs(scales[i] - scales[i - 1]),
        `scale step should stay gradual at index ${i}`
      ).toBeLessThanOrEqual(0.08);
    }
    expect(scales[0]).toBeLessThan(1);
    expect(scales[scales.length - 1]).toBeCloseTo(1, 5);
  });

  it('eases between the full-shape overview and top-lane detail camera regimes', async () => {
    const state = createState();
    state.morph = 1;
    state.height = 420;
    state.geometryHeight = 260;
    state.highlightRange = null;
    const genome = createStackedLaneGenome();
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);

    const sampleCameraProgress = (zoom: number): number => {
      state.zoom = zoom;
      renderer.render(state);
      const frame = computeTestFrame(renderer, state);
      return cameraBlendProgressForFrame(frame);
    };

    const overviewProgress = sampleCameraProgress(1);
    const transitionProgresses: number[] = [];

    const easeMinZoom = Math.max(0.01, renderer.getMinZoom(state));
    const easeMaxZoom = 6000;
    const easeSamples = 200;
    for (let i = 0; i < easeSamples; i++) {
      const zoom = easeMinZoom * Math.pow(easeMaxZoom / easeMinZoom, i / (easeSamples - 1));
      transitionProgresses.push(sampleCameraProgress(zoom));
    }
    const partialTransitionProgress = transitionProgresses.find(
      (progress) => progress > 0 && progress < 1
    );
    const detailProgress = transitionProgresses[transitionProgresses.length - 1];

    expect(overviewProgress).toBeLessThan(0.01);
    expect(partialTransitionProgress).toBeDefined();
    for (let i = 1; i < transitionProgresses.length; i++) {
      expect(transitionProgresses[i]).toBeGreaterThanOrEqual(transitionProgresses[i - 1] - 1e-6);
    }
    expect(detailProgress).toBeCloseTo(1, 5);
  });

  it('biases the circular camera toward the top lane stack immediately during slow zoom', async () => {
    const state = createState();
    state.morph = 1;
    state.height = 420;
    state.geometryHeight = 260;
    state.highlightRange = null;
    const genome = createLargeStackedLaneGenome();
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);

    const minZoom = Math.max(0.01, renderer.getMinZoom(state));
    const samples: Array<{
      zoom: number;
      fitRatio: number;
      progress: number;
      centerY: number;
      centerError: number;
      stackHeight: number;
      detailDistanceRatio: number;
    }> = [];

    let fittedSampleCount = 0;
    let detailSampleCount = 0;
    let zoom = minZoom;
    for (let i = 0; i < 2000 && zoom <= 6000; i++) {
      state.zoom = zoom;
      renderer.render(state);
      const path = renderer.getCurrentPathMapper();
      expect(path).not.toBeNull();
      if (!path) return;
      const frame = computeTestFrame(renderer, state);
      const bounds = topLaneStackBoundsAtTopMid(path, frame, genome.length);
      const detailDistance = Math.abs(
        frame.cameraDebug.backboneTargetY - frame.cameraDebug.detailBackboneTargetY
      );
      const overviewDistance = Math.max(
        1,
        Math.abs(
          frame.cameraDebug.overviewBackboneTargetY - frame.cameraDebug.detailBackboneTargetY
        )
      );
      samples.push({
        zoom,
        fitRatio: frame.cameraDebug.fitRatio,
        progress: frame.cameraDebug.progress,
        centerY: bounds.center - frame.cameraDebug.floatingLabelTopReservePx / 2,
        centerError:
          bounds.center - frame.cameraDebug.floatingLabelTopReservePx / 2 - state.height / 2,
        stackHeight: bounds.bottom - bounds.top + frame.cameraDebug.floatingLabelTopReservePx,
        detailDistanceRatio: detailDistance / overviewDistance,
      });
      if (frame.cameraDebug.fitRatio >= 1.02 && bounds.bottom - bounds.top <= state.height + 1) {
        fittedSampleCount += 1;
        if (frame.cameraDebug.progress >= 0.99) detailSampleCount += 1;
      }
      if (fittedSampleCount >= 24 && detailSampleCount >= 12) break;
      zoom *= 1.006;
    }

    const fittedZoomSamples = samples.filter(
      (sample) => sample.fitRatio >= 1.02 && sample.stackHeight <= state.height + 1
    );
    expect(fittedZoomSamples.length).toBeGreaterThan(12);

    const firstOverflow = fittedZoomSamples[0];
    const lastFullyFitted = samples.filter((sample) => sample.fitRatio <= 1).at(-1);
    expect(lastFullyFitted).toBeDefined();
    if (!lastFullyFitted) return;

    expect(
      firstOverflow.progress,
      `camera should start moving toward the top lane stack as soon as overflow begins: ${JSON.stringify(
        firstOverflow
      )}`
    ).toBeGreaterThan(0.01);
    expect(
      firstOverflow.detailDistanceRatio,
      `first overflowing zoom sample should move away from pure overview toward detail: ${JSON.stringify(
        { lastFullyFitted, firstOverflow }
      )}`
    ).toBeLessThan(1);

    const detailSamples = fittedZoomSamples.filter((sample) => sample.progress >= 0.99);
    expect(detailSamples.length).toBeGreaterThan(8);
    const firstDetailSample = detailSamples[0];
    expect(
      Math.abs(firstDetailSample.centerError),
      `top lane stack should be centered once the detail camera regime is reached: ${JSON.stringify(
        firstDetailSample
      )}`
    ).toBeLessThanOrEqual(10);
    expect(
      firstOverflow.detailDistanceRatio,
      `camera target should materially move toward detail by first overflowing sample: ${JSON.stringify(
        firstOverflow
      )}`
    ).toBeLessThanOrEqual(0.99);

    for (const sample of detailSamples) {
      expect(
        Math.abs(sample.centerError),
        `top lane stack drifted from viewport center in detail camera regime: ${JSON.stringify(
          sample
        )}`
      ).toBeLessThanOrEqual(10);
    }

    expect(
      maxAdjacentDelta(fittedZoomSamples.map((sample) => sample.centerY)),
      `top lane stack center should not move in visible steps: ${JSON.stringify(
        maxAdjacentStep(fittedZoomSamples, (sample) => sample.centerY)
      )}`
    ).toBeLessThanOrEqual(6);
    expect(
      significantReversals(
        fittedZoomSamples.map((sample) => sample.centerY),
        2
      )
    ).toEqual([]);
  });

  it('centers floating labels and the top lane stack after the overview regime', async () => {
    const genome = createLargeStackedLaneGenome();
    for (const morph of [0, 0.5, 1]) {
      const state = createState();
      state.morph = morph;
      state.height = 420;
      state.geometryHeight = 260;
      state.highlightRange = null;
      const renderer = new PixiStadiumRenderer();
      const app = {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application;

      await renderer.init(app, genome, () => state);
      for (const zoom of [20, 40, 80, 160, 320]) {
        state.zoom = zoom;
        renderer.render(state);
        const frame = computeTestFrame(renderer, state);
        if (frame.cameraDebug.progress >= 0.999) break;
      }

      const path = renderer.getCurrentPathMapper();
      expect(path).not.toBeNull();
      if (!path) return;
      const frame = computeTestFrame(renderer, state);
      const topStackBounds = topLaneStackBoundsAtTopMid(path, frame, genome.length);

      expect(frame.cameraDebug.progress).toBeGreaterThanOrEqual(0.999);
      if (frame.cameraDebug.isLaneStackTallerThanViewport) {
        expect(topStackBounds.bottom).toBeLessThanOrEqual(state.height + 0.5);
        expect(topStackBounds.top).toBeLessThan(0);
      } else {
        const visibleCenter =
          topStackBounds.center - frame.cameraDebug.floatingLabelTopReservePx / 2;
        expect(visibleCenter).toBeCloseTo(state.height / 2, 0);
      }
    }
  });

  it('keeps nucleotide and ruler lanes inside the bottom edge when high-zoom lanes are too tall', async () => {
    const genome = createStackedLaneGenome();
    const state = createState();
    state.morph = 1;
    state.zoom = 320;
    state.height = 220;
    state.geometryHeight = 180;
    state.highlightRange = null;
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, genome, () => state);
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    expect(path).not.toBeNull();
    if (!path) return;

    const frame = computeTestFrame(renderer, state);
    const topMidBp = topMidBpForFrame(frame.dims, genome.length);
    const topStackBounds = topLaneStackBoundsAtTopMid(path, frame, genome.length);

    expect(frame.layout.sequenceVisible).toBe(true);
    expect(frame.cameraDebug.isLaneStackTallerThanViewport).toBe(true);
    expect(topStackBounds.bottom).toBeLessThanOrEqual(state.height + 0.5);
    expect(topStackBounds.top).toBeLessThan(0);
    expect(path.fwdStrandAt(topMidBp).y).toBeLessThanOrEqual(state.height);
    expect(path.revStrandAt(topMidBp).y).toBeLessThanOrEqual(state.height);
    expect(path.rulerAt(topMidBp).y).toBeLessThanOrEqual(state.height);
  });

  it('caps extreme high-zoom nucleotide rows so they stay visible with a bounded ruler gap', async () => {
    const genome: Genome = {
      name: 'small-plasmid-extreme-zoom-regression',
      length: 3867,
      circular: true,
      features: [],
      sequence: 'A'.repeat(3867),
    };

    for (const morph of [0, 1]) {
      const state = createState();
      state.morph = morph;
      state.zoom = 50_000;
      state.height = 200;
      state.geometryHeight = 180;
      state.highlightRange = null;
      const renderer = new PixiStadiumRenderer();
      const app = {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application;

      await renderer.init(app, genome, () => state);
      renderer.render(state);

      const path = renderer.getCurrentPathMapper();
      expect(path).not.toBeNull();
      if (!path) return;

      const frame = computeTestFrame(renderer, state);
      const topMidBp = topMidBpForFrame(frame.dims, genome.length);
      const fwd = path.fwdStrandAt(topMidBp);
      const rev = path.revStrandAt(topMidBp);
      const ruler = path.rulerAt(topMidBp);
      const halfRow = frame.layout.rowHeight / 2;

      expect(frame.layout.sequenceVisible, `morph=${morph}`).toBe(true);
      expect(frame.layout.sequenceFontSize, `morph=${morph}`).toBeLessThanOrEqual(
        MAX_SEQUENCE_FONT_SIZE
      );
      expect(path.pixelsPerBp, `morph=${morph} readable nucleotide zoom`).toBeLessThanOrEqual(
        MAX_SEQUENCE_PIXELS_PER_BP + 0.01
      );
      expect(fwd.y - halfRow, `morph=${morph} fwd row top`).toBeGreaterThanOrEqual(-0.5);
      expect(rev.y - halfRow, `morph=${morph} rev row top`).toBeGreaterThanOrEqual(-0.5);
      expect(fwd.y + halfRow, `morph=${morph} fwd row bottom`).toBeLessThanOrEqual(
        state.height + 0.5
      );
      expect(rev.y + halfRow, `morph=${morph} rev row bottom`).toBeLessThanOrEqual(
        state.height + 0.5
      );
      expect(ruler.y, `morph=${morph} ruler y`).toBeGreaterThanOrEqual(0);
      expect(ruler.y, `morph=${morph} ruler y`).toBeLessThanOrEqual(state.height);
      expect(ruler.y - rev.y, `morph=${morph} ruler gap`).toBeLessThanOrEqual(
        frame.layout.rowHeight + 20
      );
    }
  });

  it.each([0, 1])(
    'preserves the live camera while its viewport is collapsed to %s pixels',
    async (size) => {
      const state = { ...createState(), zoom: 4, viewOffset: 0.5, highlightRange: null };
      const renderer = new PixiStadiumRenderer();
      await renderer.init(
        {
          stage: new Container(),
          canvas: document.createElement('canvas'),
        } as unknown as Application,
        createMg1655ConcaveRegressionGenome(),
        () => state
      );
      try {
        renderer.render(state);
        expect(state.zoom).toBe(4);
        const visiblePath = renderer.getCurrentPathMapper();
        state.width = size;
        state.height = size;
        renderer.render(state);
        expect(state.zoom).toBe(4);
        expect(state.viewOffset).toBe(0.5);
        expect(renderer.getCurrentPathMapper()).toBe(visiblePath);
        state.width = 800;
        state.height = 400;
        renderer.render(state);
        expect(state.zoom).toBe(4);
        expect(state.viewOffset).toBe(0.5);
        expect(renderer.getCurrentPathMapper()).not.toBeNull();
      } finally {
        renderer.destroy();
      }
    }
  );

  it('keeps padded MG1655 geometry valid in a tall narrow map pane', async () => {
    const state = {
      ...createState(),
      width: 330,
      height: 562,
      geometryHeight: 600,
      morph: 1,
      zoom: 4,
      highlightRange: null,
    };
    const renderer = new PixiStadiumRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      createMg1655ConcaveRegressionGenome(),
      () => state
    );
    try {
      const maxZoom = renderer.getMaxZoom(state);
      expect(maxZoom).toBeGreaterThan(4);
      const minZoom = renderer.getMinZoom(state);
      expect(minZoom).toBeLessThan(maxZoom);
      state.zoom = Math.max(4, minZoom);
      const acceptedZoom = state.zoom;
      renderer.render(state);
      expect(state.zoom).toBe(acceptedZoom);
      const frame = computeTestFrame(renderer, state);
      expect(frame.dims.width).toBeGreaterThan(0);
      expect(frame.dims.radius).toBeGreaterThan(0);
      expect(frame.dims.totalLength).toBeGreaterThan(0);
    } finally {
      renderer.destroy();
    }
  });

  it('computes the readable nucleotide zoom cap independently of current zoom', async () => {
    const genome = createMg1655ConcaveRegressionGenome();
    const appA = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    const appB = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    const lowZoomState = createState();
    lowZoomState.zoom = 1;
    lowZoomState.height = 220;
    lowZoomState.geometryHeight = 180;
    lowZoomState.highlightRange = null;
    const highZoomState = { ...lowZoomState, zoom: 50_000 };
    const lowZoomRenderer = new PixiStadiumRenderer();
    const highZoomRenderer = new PixiStadiumRenderer();

    await lowZoomRenderer.init(appA, genome, () => lowZoomState);
    await highZoomRenderer.init(appB, genome, () => highZoomState);

    expect(lowZoomRenderer.getMaxZoom(lowZoomState)).toBeCloseTo(
      highZoomRenderer.getMaxZoom(highZoomState),
      2
    );
  });

  it('keeps nucleotide rows inside a short visible pane when stadium geometry is tall', async () => {
    const genome = createStackedLaneGenome();

    for (const morph of [0, 0.5, 1]) {
      for (const viewOffset of [0, 0.125, 0.25, 0.5, 0.875]) {
        const state = createState();
        state.morph = morph;
        state.viewOffset = viewOffset;
        state.zoom = 50_000;
        state.height = 180;
        state.geometryHeight = 600;
        state.highlightRange = null;
        const renderer = new PixiStadiumRenderer();
        const app = {
          stage: new Container(),
          canvas: document.createElement('canvas'),
        } as unknown as Application;

        await renderer.init(app, genome, () => state);
        const maxZoom = renderer.getMaxZoom(state);
        renderer.render(state);

        const path = renderer.getCurrentPathMapper();
        expect(path).not.toBeNull();
        if (!path) return;

        const frame = computeTestFrame(renderer, state);
        const topMidBp = topVisibleMidBpForFrame(frame.dims, genome.length, state.viewOffset);
        const halfRow = frame.layout.rowHeight / 2;
        const fwd = path.fwdStrandAt(topMidBp);
        const rev = path.revStrandAt(topMidBp);
        const ruler = path.rulerAt(topMidBp);
        const sequenceTrack = (
          renderer as unknown as {
            sequenceTrack: {
              fwdMap: Map<number, { visible: boolean; x: number; y: number; height: number }>;
              revMap: Map<number, { visible: boolean; x: number; y: number; height: number }>;
            };
          }
        ).sequenceTrack;
        const textBottom = Math.max(
          ...[...sequenceTrack.fwdMap.values(), ...sequenceTrack.revMap.values()]
            .filter((text) => text.visible && text.x >= -halfRow && text.x <= state.width + halfRow)
            .map((text) => text.y + text.height / 2)
        );
        const label = `morph=${morph} viewOffset=${viewOffset}`;

        expect(state.zoom, `${label} clamped zoom`).toBeLessThanOrEqual(maxZoom);
        expect(frame.layout.sequenceVisible, label).toBe(true);
        expect(fwd.y - halfRow, `${label} fwd row top`).toBeGreaterThanOrEqual(-0.5);
        expect(fwd.y + halfRow, `${label} fwd row bottom`).toBeLessThanOrEqual(state.height + 0.5);
        expect(rev.y - halfRow, `${label} rev row top`).toBeGreaterThanOrEqual(-0.5);
        expect(rev.y + halfRow, `${label} rev row bottom`).toBeLessThanOrEqual(state.height + 0.5);
        expect(ruler.y, `${label} ruler y`).toBeLessThanOrEqual(state.height);
        expect(textBottom, `${label} actual nucleotide text bottom`).toBeLessThanOrEqual(
          state.height + 0.5
        );
      }
    }
  });

  it('renders all on-screen circular nucleotide letters when curved ends are still visible', async () => {
    const genome: Genome = {
      name: 'small-circular-visible-sequence-window-regression',
      length: 3867,
      circular: true,
      features: [],
      sequence: 'A'.repeat(3867),
    };
    const configs = [
      { morph: 0.75, height: 260, geometryHeight: 220 },
      { morph: 1, height: 260, geometryHeight: 220 },
      { morph: 1, height: 420, geometryHeight: 320 },
    ];

    for (const config of configs) {
      const state = createState();
      state.width = 1000;
      state.height = config.height;
      state.geometryHeight = config.geometryHeight;
      state.morph = config.morph;
      state.highlightRange = null;
      const renderer = new PixiStadiumRenderer();
      const app = {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application;

      await renderer.init(app, genome, () => state);
      const minZoom = renderer.getMinZoom(state);
      const maxZoom = renderer.getMaxZoom(state);
      let checkedVisibleSequenceSamples = 0;
      for (const viewOffset of [0, 0.125, 0.25, 0.375, 0.5]) {
        state.viewOffset = viewOffset;
        for (const zoom of [minZoom, minZoom * 1.5, minZoom * 2, maxZoom * 0.35, maxZoom * 0.55]) {
          state.zoom = Math.min(maxZoom, Math.max(minZoom, zoom));
          renderer.render(state);
          const path = renderer.getCurrentPathMapper();
          expect(path).not.toBeNull();
          if (!path || !path.sequenceVisible) continue;
          checkedVisibleSequenceSamples += 1;

          const sequenceTrack = (
            renderer as unknown as {
              sequenceTrack: {
                fwdMap: Map<number, { visible: boolean }>;
              };
            }
          ).sequenceTrack;
          const renderedBp = new Set<number>();
          for (const [bp, text] of sequenceTrack.fwdMap.entries()) {
            if (text.visible)
              renderedBp.add(((bp % genome.length) + genome.length) % genome.length);
          }

          const missingVisibleBps: number[] = [];
          const pad = Math.max(4, path.sequenceFontSize);
          for (let bp = 0; bp < genome.length; bp++) {
            const pos = path.fwdStrandAt(bp);
            if (
              pos.x >= -pad &&
              pos.x <= state.width + pad &&
              pos.y >= -pad &&
              pos.y <= state.height + pad &&
              !renderedBp.has(bp)
            ) {
              missingVisibleBps.push(bp);
              if (missingVisibleBps.length >= 8) break;
            }
          }

          expect(
            missingVisibleBps,
            `morph=${config.morph} height=${config.height} viewOffset=${viewOffset} zoom=${state.zoom.toFixed(2)} ppp=${path.pixelsPerBp.toFixed(2)}`
          ).toEqual([]);
        }
      }
      expect(
        checkedVisibleSequenceSamples,
        `morph=${config.morph} height=${config.height} should exercise visible sequence samples`
      ).toBeGreaterThan(0);
    }
  });

  it('does not draw a vertical cursor while a highlight selection is active', async () => {
    const state = createState();
    state.highlightRange = [50, 70];
    state.cursorPosition = 71;
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const drawCursorSpy = vi.spyOn(
      renderer as unknown as { drawCursor: (bp: number) => void },
      'drawCursor'
    );
    renderer.render(state);

    expect(drawCursorSpy).not.toHaveBeenCalled();
  });

  it('draws wrapped backbone segments from render state', async () => {
    const state = createState();
    state.zoom = 4;
    state.backboneSegments = [
      { start: 900, end: 100, color: 0x22c55e, strokeWidth: 6, alpha: 0.63 },
    ];
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const rulerGraphics = (
      renderer as unknown as {
        rulerGraphics: {
          setStrokeStyle: (style: { color: number; width: number }) => unknown;
        };
      }
    ).rulerGraphics;
    const strokeSpy = vi.spyOn(rulerGraphics, 'setStrokeStyle');

    renderer.render(state);

    expect(strokeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ color: 0x22c55e, width: 6, alpha: 0.63 })
    );
    expect(renderer.getRendererDebugSnapshot()).toMatchObject({
      backboneSegmentCount: 1,
      backbonePathSegmentsDrawn: 2,
    });
  });

  it('draws and hit-tests selected provenance boundaries at between-base coordinates', async () => {
    const state = createState();
    state.zoom = 4;
    state.highlightRange = null;
    state.backboneBoundaryHandles = [
      {
        regionId: 'middle-pcr',
        side: 'upstream',
        rangeStart: 100,
        rangeEnd: 200,
        boundaryBp: 100,
        color: 0x22c55e,
      },
      {
        regionId: 'middle-pcr',
        side: 'downstream',
        rangeStart: 100,
        rangeEnd: 200,
        boundaryBp: 200,
        color: 0x22c55e,
      },
    ];
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    expect(path).not.toBeNull();
    const upstreamPoint = path!.rulerAt(99.5);
    const downstreamPoint = path!.rulerAt(199.5);
    expect(renderer.hitTestBackboneBoundaryHandle(upstreamPoint.x, upstreamPoint.y)).toEqual({
      kind: 'backbone-boundary-handle',
      payload: expect.objectContaining({
        regionId: 'middle-pcr',
        side: 'upstream',
        boundaryBp: 100,
      }),
    });
    expect(renderer.hitTestBackboneBoundaryHandle(downstreamPoint.x, downstreamPoint.y)).toEqual({
      kind: 'backbone-boundary-handle',
      payload: expect.objectContaining({
        regionId: 'middle-pcr',
        side: 'downstream',
        boundaryBp: 200,
      }),
    });
    expect(renderer.getRendererDebugSnapshot()).toMatchObject({
      backboneBoundaryHandleCount: 2,
    });
  });

  it('previews the exact provisional part order without replacing the selected arc hit target', async () => {
    const state = createState();
    state.zoom = 4;
    state.highlightRange = null;
    state.backboneSegments = [
      {
        regionId: 'part-a',
        start: 0,
        end: 100,
        color: 0x3b82f6,
        strokeWidth: 6,
      },
      {
        regionId: 'part-b',
        start: 100,
        end: 220,
        color: 0x22c55e,
        strokeWidth: 6,
        selected: true,
      },
    ];
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    renderer.render(state);

    const path = renderer.getCurrentPathMapper();
    expect(path).not.toBeNull();
    const selectedArcPoint = path!.rulerAt(129.5);
    expect(renderer.hitTestBackbonePart(selectedArcPoint.x, selectedArcPoint.y)).toEqual({
      kind: 'backbone-part',
      payload: {
        regionId: 'part-b',
        rangeStart: 100,
        rangeEnd: 220,
      },
    });

    const debug = renderer.getBackbonePartInteractionDebugSnapshot();
    expect(
      renderer.setBackbonePartInsertionPreview(debug.parts[1].payload, 245, {
        ranges: [
          { regionId: 'part-b', rangeStart: 0, rangeEnd: 120 },
          { regionId: 'part-a', rangeStart: 120, rangeEnd: 220 },
        ],
      })
    ).toBe(true);
    renderer.render(state);
    const preview = renderer.getBackbonePartInteractionDebugSnapshot();
    expect(preview.insertionBoundaryBp).toBe(245);
    expect(preview.parts.map((part) => part.payload)).toEqual([
      { regionId: 'part-b', rangeStart: 0, rangeEnd: 120 },
      { regionId: 'part-a', rangeStart: 120, rangeEnd: 220 },
    ]);
    expect(preview.previewRegionOrder).toEqual(['part-b', 'part-a']);
    const movedPartPoint = preview.parts[0].points[Math.floor(preview.parts[0].points.length / 2)];
    expect(renderer.hitTestBackbonePart(movedPartPoint.x, movedPartPoint.y)).toMatchObject({
      kind: 'backbone-part',
      payload: { regionId: 'part-b', rangeStart: 0, rangeEnd: 120 },
    });
    renderer.clearBackbonePartInsertionPreview();
    expect(renderer.getBackbonePartInteractionDebugSnapshot().insertionBoundaryBp).toBeNull();
  });

  it('hit-tests the nearest provenance arc with stroke-derived radial bounds', async () => {
    const state = createState();
    state.zoom = 4;
    state.highlightRange = null;
    state.backboneSegments = [
      {
        regionId: 'part-a',
        start: 0,
        end: 100,
        color: 0x3b82f6,
        strokeWidth: 6,
      },
      {
        regionId: 'part-b',
        start: 100,
        end: 220,
        color: 0x22c55e,
        strokeWidth: 6,
      },
    ];
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    renderer.render(state);

    const snapshot = renderer.getBackbonePartInteractionDebugSnapshot();
    const partA = snapshot.parts.find((part) => part.payload.regionId === 'part-a');
    const partB = snapshot.parts.find((part) => part.payload.regionId === 'part-b');
    expect(partA).toBeDefined();
    expect(partB).toBeDefined();
    if (!partA || !partB) return;

    const interiorNearBoundary = partA.points[partA.points.length - 2];
    expect(renderer.hitTestBackbonePart(interiorNearBoundary.x, interiorNearBoundary.y)).toEqual({
      kind: 'backbone-part',
      payload: partA.payload,
    });

    const exactBoundary = partB.points[0];
    expect(renderer.hitTestBackbonePart(exactBoundary.x, exactBoundary.y)).toEqual({
      kind: 'backbone-part',
      payload: partB.payload,
    });

    const middleIndex = Math.floor(partA.points.length / 2);
    const middle = partA.points[middleIndex];
    const next = partA.points[middleIndex + 1];
    const tangentLength = Math.hypot(next.x - middle.x, next.y - middle.y);
    const normal = {
      x: -(next.y - middle.y) / tangentLength,
      y: (next.x - middle.x) / tangentLength,
    };
    const expectedRadius = 6 / 2 + 2;
    const inside = {
      x: middle.x + normal.x * (expectedRadius - 0.1),
      y: middle.y + normal.y * (expectedRadius - 0.1),
    };
    const outside = {
      x: middle.x + normal.x * (expectedRadius + 0.1),
      y: middle.y + normal.y * (expectedRadius + 0.1),
    };

    expect(renderer.hitTestBackbonePart(inside.x, inside.y)).toMatchObject({
      kind: 'backbone-part',
      payload: { regionId: 'part-a' },
    });
    expect(renderer.hitTestBackbonePart(outside.x, outside.y)).toBeNull();
  });

  it('uses part-derived outlines for every hovered arc', async () => {
    const state = createState();
    state.zoom = 4;
    state.highlightRange = null;
    state.themeMode = 'light';
    state.backboneSegments = [
      {
        regionId: 'part-a',
        start: 0,
        end: 100,
        color: 0x3b82f6,
        strokeWidth: 6,
      },
      {
        regionId: 'part-b',
        start: 100,
        end: 220,
        color: 0x22c55e,
        strokeWidth: 6,
        selected: true,
      },
    ];
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    expect(renderer.setHoveredBackbonePart('part-a')).toBe(true);
    expect(renderer.setHoveredBackbonePart('part-a')).toBe(false);
    renderer.render(state);

    expect(renderer.getBackbonePartInteractionDebugSnapshot()).toMatchObject({
      hoveredRegionId: 'part-a',
      hoverOutline: {
        regionId: 'part-a',
        alpha: 0.9,
        width: 10,
      },
      selectedOutlineRegionId: 'part-b',
    });
    const partAHover = renderer.getBackbonePartInteractionDebugSnapshot();
    expect(partAHover.hoverOutline?.color).not.toBe(0x111827);
    expect(partAHover.hoverOutline?.color).not.toBe(0xf8fafc);

    expect(renderer.setHoveredBackbonePart('part-b')).toBe(true);
    renderer.render(state);
    expect(renderer.getBackbonePartInteractionDebugSnapshot()).toMatchObject({
      hoveredRegionId: 'part-b',
      hoverOutline: {
        regionId: 'part-b',
        alpha: 0.9,
        width: 11,
      },
      selectedOutlineRegionId: 'part-b',
    });

    expect(renderer.setHoveredBackbonePart(null)).toBe(true);
    renderer.render(state);
    expect(renderer.getBackbonePartInteractionDebugSnapshot()).toMatchObject({
      hoveredRegionId: null,
      hoverOutline: null,
      selectedOutlineRegionId: 'part-b',
    });
  });

  it('draws virtual digest focus masking as coordinate complement polygons', async () => {
    const state = createState();
    state.zoom = 4;
    state.highlightRange = null;
    state.digestFocusRange = [100, 200];
    const renderer = new PixiStadiumRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;

    await renderer.init(app, createGenome(), () => state);
    const interactionGraphics = (
      renderer as unknown as {
        interactionGraphics: {
          fill: (style: { color: number; alpha: number }) => unknown;
        };
      }
    ).interactionGraphics;
    const fillSpy = vi.spyOn(interactionGraphics, 'fill');

    renderer.render(state);

    expect(fillSpy).toHaveBeenCalledWith(expect.objectContaining({ color: 0xffffff, alpha: 0.62 }));
    const digestMaskFills = fillSpy.mock.calls.filter(
      ([style]) => style?.color === 0xffffff && style?.alpha === 0.62
    );
    expect(digestMaskFills).toHaveLength(2);
  });

  it('draws colored assembly segments on the ruler backbone path, not a separate sequence path', () => {
    const state = createState();
    state.backboneSegments = [{ start: 100, end: 200, color: 0x22c55e, strokeWidth: 6 }];
    const renderer = new PixiStadiumRenderer();
    (
      renderer as unknown as {
        genome: Genome;
        rulerGraphics: {
          setStrokeStyle: (style: { color: number; width: number }) => unknown;
          moveTo: (x: number, y: number) => unknown;
          lineTo: (x: number, y: number) => unknown;
          stroke: () => unknown;
        };
      }
    ).genome = createGenome();
    const rulerGraphics = (
      renderer as unknown as {
        rulerGraphics: {
          setStrokeStyle: (style: { color: number; width: number }) => unknown;
          moveTo: (x: number, y: number) => unknown;
          lineTo: (x: number, y: number) => unknown;
          stroke: () => unknown;
        };
      }
    ).rulerGraphics;
    const moveToSpy = vi.spyOn(rulerGraphics, 'moveTo');
    const lineToSpy = vi.spyOn(rulerGraphics, 'lineTo');
    const backboneAt = vi.fn((bp: number) => ({ x: bp, y: 12, angle: 0 }));
    const rulerAt = vi.fn((bp: number) => ({ x: bp, y: 96, angle: 0 }));

    (
      renderer as unknown as {
        drawBackboneSegments: (
          path: { backboneAt: typeof backboneAt; rulerAt: typeof rulerAt },
          renderState: RenderState,
          arcSteps: number
        ) => void;
      }
    ).drawBackboneSegments({ backboneAt, rulerAt }, state, 1);

    expect(rulerAt).toHaveBeenCalled();
    expect(backboneAt).not.toHaveBeenCalled();
    expect(moveToSpy).toHaveBeenCalledWith(99.5, 96);
    expect(lineToSpy).toHaveBeenCalledWith(199.5, 96);
  });
});

describe('stadium frame in a narrow, tall map pane', () => {
  it('keeps positive ring geometry at every zoom when lane padding is large', async () => {
    const length = 6000;
    const features = Array.from({ length: 60 }, (_, index) => ({
      id: index + 1,
      name: `feature-${index + 1}`,
      type: 'CDS',
      start: 1 + (index % 6) * 900,
      end: 1 + (index % 6) * 900 + 1800,
      strand: (index % 2 === 0 ? 1 : -1) as 1 | -1,
    }));
    const genome = {
      name: 'narrow-pane',
      length,
      circular: true,
      sequence: 'ACGT'.repeat(length / 4),
      features,
    } as unknown as Genome;
    const state: RenderState = {
      ...createState(),
      morph: 1,
      width: 418,
      height: 688,
      geometryHeight: 600,
      zoom: 1,
    };
    const renderer = new PixiStadiumRenderer();
    await renderer.init(
      {
        stage: new Container(),
        canvas: document.createElement('canvas'),
      } as unknown as Application,
      genome,
      () => state
    );
    try {
      const maxZoom = renderer.getMaxZoom(state);
      for (const zoom of [1, Math.sqrt(maxZoom), maxZoom * 0.98]) {
        const frame = computeTestFrame(renderer, { ...state, zoom });
        expect(frame.dims.width, `ring width at zoom ${zoom}`).toBeGreaterThan(0);
        expect(frame.dims.radius, `ring radius at zoom ${zoom}`).toBeGreaterThan(0);
      }
    } finally {
      renderer.destroy();
    }
  });
});
