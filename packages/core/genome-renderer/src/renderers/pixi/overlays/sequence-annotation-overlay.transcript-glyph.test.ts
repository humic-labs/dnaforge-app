// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { Graphics } from 'pixi.js';
import { genomeFeatures, type Feature, type Genome, type RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-types';
import type { UnifiedLayout } from '../shared/track-layout';
import { retainedAnnotationSectorOutline } from './annotation-mutation-sectors';

const GENOME_LENGTH = 1000;

let AnnotationOverlayClass: typeof import('./sequence-annotation-overlay').SequenceAnnotationOverlay;
let IndexedAnnotationOverlayClass: typeof import('./annotation-overlay').IndexedAnnotationOverlay;
let StadiumPathMapperClass: typeof import('../shared/path-mapper').StadiumPathMapper;
let LinearPathMapperClass: typeof import('../shared/path-mapper').LinearPathMapper;
let getStadiumDimensionsFn: typeof import('../../../geometry/stadium').getStadiumDimensions;

{
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

  ({ SequenceAnnotationOverlay: AnnotationOverlayClass } =
    await import('./sequence-annotation-overlay'));
  ({ IndexedAnnotationOverlay: IndexedAnnotationOverlayClass } =
    await import('./annotation-overlay'));
  ({ StadiumPathMapper: StadiumPathMapperClass, LinearPathMapper: LinearPathMapperClass } =
    await import('../shared/path-mapper'));
  ({ getStadiumDimensions: getStadiumDimensionsFn } = await import('../../../geometry/stadium'));
}

function createState(themeMode: 'light' | 'dark' = 'light'): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 400,
    themeMode,
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

describe.each(['sequence', 'indexed'] as const)('%s narrow annotation interactions', (owner) => {
  it('uses the retained body perimeter for a subpixel selected CDS', () => {
    const overlay =
      owner === 'indexed' ? new IndexedAnnotationOverlayClass() : new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'retained-premature-stop',
      length: GENOME_LENGTH,
      circular: false,
      features: [
        {
          id: 32,
          type: 'CDS',
          start: 400,
          end: 415,
          direction: 'forward',
          displayName: 'Premature stop · Mutant',
          color: 0xf44336,
          lane: 0,
          exons: [{ start: 401, end: 415 }],
          cds: [{ start: 401, end: 415 }],
        },
      ],
    };
    const state = createState();
    state.zoom = 0.02;
    state.selectedIds = new Set([32]);
    const path = createLinearPath(state, genome);
    overlay.loadGenome(genome);
    const feature = genomeFeatures(genome)[0];
    const retained = overlay.getRetainedLinearPresenterForTest();
    retained.retainedOverviewMode = 'retained';
    retained.retainedLinearTranscriptFeatureSet = new Set([feature]);
    const geometry = overlay as unknown as {
      featureOffset(feature: Feature): number;
      scaledBarHeight(): number;
      cdsDetailProgress(): number;
      renderInteractionOutlines(path: PathMapper, state: RenderState): void;
    };
    const expected = retainedAnnotationSectorOutline(
      feature,
      path,
      state,
      geometry.featureOffset(feature),
      geometry.scaledBarHeight() / 2,
      geometry.cdsDetailProgress()
    );
    const graphics =
      overlay instanceof IndexedAnnotationOverlayClass
        ? overlay.getInteractionOutlineControllerForTest().interactionGraphics
        : (overlay as unknown as { interactionGraphics: Graphics }).interactionGraphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    geometry.renderInteractionOutlines(path, state);

    expect(expected).toHaveLength(1);
    expect(polySpy).toHaveBeenCalledOnce();
    expect(polySpy).toHaveBeenLastCalledWith(expected[0].kind === 'poly' ? expected[0].pts : []);
    overlay.destroy();
  });

  it.each(
    (['CDS', 'misc_feature'] as const).flatMap((type) =>
      (['linear', 'circular'] as const).flatMap((mode) =>
        (['selected', 'hovered'] as const).map((interaction) => ({ type, mode, interaction }))
      )
    )
  )(
    'preserves the $type fill when $interaction in $mode overview',
    ({ type, mode, interaction }) => {
      const overlay =
        owner === 'indexed' ? new IndexedAnnotationOverlayClass() : new AnnotationOverlayClass();
      const genome: Genome = {
        name: 'narrow-mutation-annotation',
        length: GENOME_LENGTH,
        circular: mode === 'circular',
        features: [
          {
            id: 32,
            type,
            start: 400,
            end: 401,
            direction: 'forward',
            displayName: 'Premature stop',
            color: 0xf44336,
            lane: 0,
          },
        ],
      };
      const state = createState();
      state.morph = mode === 'circular' ? 1 : 0;
      state.selectedIds = new Set(interaction === 'selected' ? [32] : []);
      state.hoveredId = interaction === 'hovered' ? 32 : null;
      const path = mode === 'linear' ? createLinearPath(state, genome) : createPath(state, genome);
      const graphics =
        overlay instanceof IndexedAnnotationOverlayClass
          ? overlay.getInteractionOutlineControllerForTest().interactionGraphics
          : (overlay as unknown as { interactionGraphics: Graphics }).interactionGraphics;
      const styleSpy = vi.spyOn(graphics, 'setStrokeStyle');
      const strokeSpy = vi.spyOn(graphics, 'stroke');

      overlay.loadGenome(genome);
      overlay.render(path, state, 0, state.height);

      expect(strokeSpy).toHaveBeenCalledOnce();
      expect(styleSpy).toHaveBeenLastCalledWith({
        width: interaction === 'selected' ? 1 : 0.75,
        alignment: 0,
        color: 0x111827,
        alpha: interaction === 'selected' ? 0.85 : 0.55,
      });
      overlay.destroy();
    }
  );
});

function createPath(state: RenderState, genome: Genome) {
  const dims = getStadiumDimensionsFn(state.width, state.height, state.morph, 80);
  const pixelsPerBp = (dims.totalLength * state.zoom) / genome.length;
  return new StadiumPathMapperClass({
    genomeLength: genome.length,
    viewOffset: state.viewOffset,
    zoom: state.zoom,
    dims,
    ox: 80,
    oy: 80,
    stagePosX: 0,
    stagePosY: 0,
    bpPerPixel: 1 / pixelsPerBp,
    hasSequence: !!genome.sequence,
    viewportWidth: state.width,
    viewportHeight: state.height,
  });
}

function createLinearPath(
  state: RenderState,
  genome: Genome,
  viewStartBp = 0,
  viewEndBp = genome.length
) {
  const bpPerPixel = (viewEndBp - viewStartBp) / (state.width * state.zoom);
  return new LinearPathMapperClass({
    viewportWidth: state.width,
    viewportHeight: state.height,
    bpPerPixel,
    viewStartBp,
    viewEndBp,
    annotationLanes: 3,
    translationLanes: 1,
    hasSequence: !!genome.sequence,
  });
}

function makeTranscriptGenome(feature: Partial<Feature> = {}): Genome {
  return {
    name: 'transcript-glyph-test',
    length: GENOME_LENGTH,
    circular: false,
    features: [
      {
        id: 1,
        type: 'mRNA',
        start: 99,
        end: 1000,
        direction: 'forward',
        displayName: 'HBB',
        color: 0x3b82f6,
        lane: 0,
        exons: [
          { start: 100, end: 200 },
          { start: 400, end: 500 },
          { start: 800, end: 1000 },
        ],
        cds: [
          { start: 150, end: 200 },
          { start: 400, end: 500 },
          { start: 800, end: 950 },
        ],
        transcriptId: 'HBB.mrna.1',
        ...feature,
      },
    ],
    sequence: 'A'.repeat(GENOME_LENGTH),
  };
}

function polyPoints(call: unknown[]): number[] {
  const first = call[0];
  return Array.isArray(first) ? (first as number[]) : [];
}

function bboxOfPts(pts: number[]): { xMin: number; xMax: number; yMin: number; yMax: number } {
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    xMin = Math.min(xMin, pts[i]);
    xMax = Math.max(xMax, pts[i]);
    yMin = Math.min(yMin, pts[i + 1]);
    yMax = Math.max(yMax, pts[i + 1]);
  }
  return { xMin, xMax, yMin, yMax };
}

describe('drawTranscriptGlyph dispatch (DNA-TG1)', () => {
  it.each([
    ['sequence', 'linear'],
    ['indexed', 'linear'],
    ['sequence', 'circular'],
    ['indexed', 'circular'],
  ] as const)(
    'keeps CDS and non-CDS mutation sectors visible through the %s %s zoom transition',
    (owner, pathMode) => {
      const Overlay = owner === 'sequence' ? AnnotationOverlayClass : IndexedAnnotationOverlayClass;
      const overlay = new Overlay();
      const genome = makeTranscriptGenome({ type: 'CDS' });
      genome.features = [
        ...genome.features!,
        {
          id: 2,
          type: 'misc_feature',
          start: 50,
          end: 700,
          direction: 'none',
          displayName: 'regulatory region',
          color: 0x123456,
          lane: 1,
        },
      ];
      const state = createState();
      const path =
        pathMode === 'linear' ? createLinearPath(state, genome) : createPath(state, genome);
      state.sequencePresentation = {
        cdsComparisonLayout: 'diff',
        annotationColors: new Map([
          [1, 0xff00cc],
          [2, 0x00ccff],
        ]),
        nucleotideChanges: [{ start: 155, end: 156, kind: 'substitution', color: 0x00ccff }],
        codingFeatures: new Map([
          [
            1,
            {
              source: 'query',
              introns: [],
              codons: [
                {
                  startBp: 155,
                  endBp: 158,
                  codon: 'AAA',
                  aa: 'K',
                  isStop: false,
                  isStart: false,
                  mutation: {
                    kind: 'substitution',
                    frameShifted: false,
                    prematureStop: false,
                    stopLost: false,
                    referenceCodons: [],
                  },
                },
              ],
            },
          ],
        ]),
      };
      overlay.loadGenome(genome);
      for (const detail of [0, 0.25, 0.5, 0.75, 1]) {
        overlay.setLayout({
          compactScale: 1,
          sequenceVisible: detail > 0,
          sequenceRevealProgress: detail,
          annotationOffset: 0,
          annotationStep: 16,
          cdsBarOffset: -20,
          cdsLaneStep: 30,
        } as UnifiedLayout);
        overlay.render(path, state, 0, state.height);
        const snapshot = overlay.getDebugSnapshot() as unknown as {
          annotationMutationSectors: {
            samples: { featureId: number; color: number; alpha: number }[];
          };
        };
        const samples = snapshot.annotationMutationSectors.samples;
        expect(samples.find((sample) => sample.featureId === 2)).toMatchObject({
          color: 0x00ccff,
          alpha: 1,
        });
        if (detail < 1)
          expect(samples.find((sample) => sample.featureId === 1)).toMatchObject({
            color: 0xffc800,
            alpha: 1 - detail,
          });
        else expect(samples.some((sample) => sample.featureId === 1)).toBe(false);
      }
      overlay.destroy();
    }
  );
  it.each(['sequence', 'indexed'] as const)(
    'applies resolved colors to %s transcript bodies and restores the source palette',
    (owner) => {
      const Overlay = owner === 'sequence' ? AnnotationOverlayClass : IndexedAnnotationOverlayClass;
      const overlay = new Overlay();
      const genome = makeTranscriptGenome();
      const source = structuredClone(genome);
      const state = createState();
      const path = createLinearPath(state, genome);
      type Paint = { fill: (...args: unknown[]) => unknown };
      const drawing = overlay as unknown as {
        graphics?: Paint;
        immediateDraw?: { graphics: Paint };
      };
      const graphics = drawing.graphics ?? drawing.immediateDraw!.graphics;
      const fill = vi.spyOn(graphics, 'fill');
      overlay.loadGenome(genome);
      overlay.render(path, state, 0, state.height);
      const original = fill.mock.calls.map(([style]) => style);
      expect(original.length).toBeGreaterThan(0);

      fill.mockClear();
      state.sequencePresentation = { annotationColors: new Map([[1, 0xff00cc]]) };
      overlay.render(path, state, 0, state.height);
      expect(fill.mock.calls.length).toBeGreaterThan(0);
      expect(
        fill.mock.calls.every(([style]) => (style as { color: number }).color === 0xff00cc)
      ).toBe(true);

      fill.mockClear();
      state.sequencePresentation = undefined;
      overlay.render(path, state, 0, state.height);
      expect(fill.mock.calls.map(([style]) => style)).toEqual(original);
      expect(genome).toEqual(source);
      overlay.destroy();
    }
  );

  it('recolors retained transcript buffers without replacing geometry or repacking it', async () => {
    const { RetainedLinearTranscriptLayer, getRetainedLinearTranscriptPackDebugSnapshot } =
      await import('../overview/retained-linear-transcript-layer');
    const layer = new RetainedLinearTranscriptLayer();
    const block = {
      featureId: 17,
      startBp: 1,
      endBp: 10,
      offsetCenter: -10,
      halfH: 4,
      color: 0x123456,
      role: 'source:123456' as const,
      alpha: 0.7,
      cdsFade: 0,
      dirSign: 1 as const,
    };
    layer.syncData('geometry', [block, { ...block, featureId: 18, startBp: 20, endBp: 30 }]);
    const mesh = layer.container.children[0] as import('pixi.js').Mesh;
    const geometry = mesh.geometry;
    const positions = geometry.getBuffer('aBpStartDelta');
    const colors = geometry.getBuffer('aColor');
    const original = new Float32Array(colors.data as Float32Array);
    const count = getRetainedLinearTranscriptPackDebugSnapshot().count;
    layer.setFeatureColors(new Map([[17, 0xff00cc]]));
    expect(mesh.geometry).toBe(geometry);
    expect(geometry.getBuffer('aBpStartDelta')).toBe(positions);
    expect(getRetainedLinearTranscriptPackDebugSnapshot().count).toBe(count);
    const mapped = colors.data as Float32Array;
    expect(Array.from(mapped.slice(0, 3))).toEqual([1, 0, expect.closeTo(0.8)]);
    expect(mapped[3]).toBe(original[3]);
    expect(Array.from(mapped.slice(36))).toEqual(Array.from(original.slice(36)));
    layer.setFeatureColors(undefined);
    expect(Array.from(colors.data)).toEqual(Array.from(original));
    layer.destroy();
  });

  it('fires the composite-glyph path when feature.exons[] is populated', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = makeTranscriptGenome();
    const state = createState();
    const path = createPath(state, genome);
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(polySpy.mock.calls.length).toBeGreaterThanOrEqual(6);

    overlay.destroy();
  });

  it('does NOT draw the thick CDS overlay for non-coding transcripts (cds=[], type=ncRNA)', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'lncrna-test',
      length: GENOME_LENGTH,
      circular: false,
      features: [
        {
          id: 1,
          type: 'ncRNA',
          start: 99,
          end: 500,
          direction: 'forward',
          displayName: 'lnc-1',
          color: 0xa855f7,
          lane: 0,
          exons: [
            { start: 100, end: 200 },
            { start: 400, end: 500 },
          ],
          cds: [],
        },
      ],
      sequence: 'A'.repeat(GENOME_LENGTH),
    };
    const state = createState();
    const path = createPath(state, genome);
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(polySpy.mock.calls.length).toBeLessThan(7);
    expect(polySpy.mock.calls.length).toBeGreaterThanOrEqual(3);

    overlay.destroy();
  });

  it('handles single-exon transcript (yeast / bacterial-promoted) without intron line', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'single-exon-test',
      length: GENOME_LENGTH,
      circular: false,
      features: [
        {
          id: 1,
          type: 'mRNA',
          start: 99,
          end: 500,
          direction: 'forward',
          displayName: 'YAL001C',
          color: 0x3b82f6,
          lane: 0,
          exons: [{ start: 100, end: 500 }],
          cds: [{ start: 100, end: 500 }],
        },
      ],
      sequence: 'A'.repeat(GENOME_LENGTH),
    };
    const state = createState();
    const path = createPath(state, genome);
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(polySpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(polySpy.mock.calls.length).toBeLessThanOrEqual(2);

    overlay.destroy();
  });

  it('renders a curved gene label on the stadium when arc-mode is active (DNA-TG1 Phase 4)', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = makeTranscriptGenome();
    const state = createState();
    const path = createPath(state, genome);

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const snap = overlay.getDebugSnapshot();

    expect(snap.curvedGlyphCount).toBeGreaterThanOrEqual(3);

    overlay.destroy();
  });

  it('draws IGV-style intron direction chevrons on multi-exon linear transcripts', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'igv-intron-chevron-test',
      length: GENOME_LENGTH,
      circular: false,
      features: [
        {
          id: 1,
          type: 'mRNA',
          start: 99,
          end: 1000,
          direction: 'forward',
          displayName: 'INTRONIC',
          color: 0x3b82f6,
          lane: 0,

          exons: [
            { start: 100, end: 200 },
            { start: 800, end: 1000 },
          ],
          cds: [
            { start: 150, end: 200 },
            { start: 800, end: 950 },
          ],
        },
      ],
      sequence: 'A'.repeat(GENOME_LENGTH),
    };
    const state = createState();

    const path = createLinearPath(state, genome);
    const graphics = overlay as unknown as {
      graphics: { stroke: (...a: unknown[]) => unknown; moveTo: (...a: unknown[]) => unknown };
    };
    const strokeSpy = vi.spyOn(graphics.graphics, 'stroke');
    const moveToSpy = vi.spyOn(graphics.graphics, 'moveTo');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(moveToSpy.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(moveToSpy.mock.calls.length).toBeLessThanOrEqual(30);

    expect(strokeSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(strokeSpy.mock.calls.length).toBeLessThanOrEqual(moveToSpy.mock.calls.length);

    overlay.destroy();
  });

  it.each([
    { type: 'mRNA', compositeKind: 'transcript' as const, label: 'human transcript' },
    { type: 'CDS', compositeKind: 'compound-cds' as const, label: 'bacterial compound CDS' },
  ])('keeps the $label label inside the selected visible exon', ({ type, compositeKind }) => {
    const overlay = new AnnotationOverlayClass();
    const genome = makeTranscriptGenome({ type, compositeKind, displayName: 'BLOCK_LABEL' });
    const state = createState();
    const path = createLinearPath(state, genome, 700, 1_000);

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const labels = (
      overlay as unknown as {
        labelPool: Array<{ text: string; x: number; visible: boolean }>;
      }
    ).labelPool;
    const label = labels.find((candidate) => candidate.text === 'BLOCK_LABEL');
    const visibleExonStartX = path.bpLeftX(799);
    const visibleExonEndX = path.bpLeftX(1_000);
    expect(label).toBeDefined();
    expect(label?.x).toBeGreaterThanOrEqual(visibleExonStartX);
    expect(label?.x).toBeLessThanOrEqual(visibleExonEndX);

    overlay.destroy();
  });

  it('does not float a transcript label over an intron-only viewport', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = makeTranscriptGenome({ displayName: 'NO_INTRON_LABEL' });
    const state = createState();
    const path = createLinearPath(state, genome, 550, 750);

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const labels = (
      overlay as unknown as {
        labelPool: Array<{ text: string; visible: boolean }>;
      }
    ).labelPool;
    expect(labels.some((candidate) => candidate.text === 'NO_INTRON_LABEL')).toBe(false);

    overlay.destroy();
  });

  it('intron chevrons fade smoothly across the LOD boundary instead of popping', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'chevron-fade-test',
      length: GENOME_LENGTH,
      circular: false,
      features: [
        {
          id: 42,
          type: 'mRNA',
          start: 99,
          end: 1000,
          direction: 'forward',
          displayName: 'FADETEST',
          color: 0x3b82f6,
          lane: 0,

          exons: [
            { start: 100, end: 130 },
            { start: 161, end: 200 },
            { start: 231, end: 260 },
            { start: 261, end: 1000 },
          ],
          cds: [],
        },
      ],
      sequence: 'A'.repeat(GENOME_LENGTH),
    };
    const state = createState();
    const path = createLinearPath(state, genome);
    const graphics = overlay as unknown as {
      graphics: {
        setStrokeStyle: (...a: unknown[]) => unknown;
        stroke: (...a: unknown[]) => unknown;
      };
    };
    const styleSpy = vi.spyOn(graphics.graphics, 'setStrokeStyle');
    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const chevronAlphas = styleSpy.mock.calls
      .map((call) => call[0] as { color?: number; alpha?: number; width?: number })
      .filter((s) => s && s.color === 0x6b7280)
      .map((s) => s.alpha ?? 0);

    expect(chevronAlphas.length).toBeGreaterThan(0);
    const baseAlpha = 0.85 * 0.8;
    for (const a of chevronAlphas) {
      expect(a).toBeGreaterThan(0);
      expect(a).toBeLessThanOrEqual(baseAlpha + 1e-9);
    }

    overlay.destroy();
  });

  it('draws transcript backbone only in intron gaps, never under exon/CDS bodies', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = makeTranscriptGenome();
    const state = createState();
    const path = createLinearPath(state, genome);
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    const thinPolys = polySpy.mock.calls
      .map((call) => polyPoints(call))
      .filter((pts) => pts.length >= 8)
      .map((pts) => ({ pts, bbox: bboxOfPts(pts) }))
      .filter(({ bbox }) => bbox.yMax - bbox.yMin < 3);

    expect(thinPolys).toHaveLength(2);
    const expectedRanges = [
      [path.bpLeftX(200), path.bpLeftX(399)],
      [path.bpLeftX(500), path.bpLeftX(799)],
    ];
    for (let i = 0; i < expectedRanges.length; i++) {
      expect(thinPolys[i].bbox.xMin).toBeCloseTo(expectedRanges[i][0], 6);
      expect(thinPolys[i].bbox.xMax).toBeCloseTo(expectedRanges[i][1], 6);
    }
    for (const { bbox } of thinPolys) {
      expect(bbox.xMin).toBeGreaterThan(path.bpLeftX(99));
      expect(bbox.xMax).toBeLessThan(path.bpLeftX(1000));
    }

    overlay.destroy();
  });

  it('uses exact transcript body polygons plus intron centerlines for cache-hit hover outlines', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = makeTranscriptGenome();
    const state = createState();
    const path = createLinearPath(state, genome);

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);
    (overlay as unknown as { outlineCache: Map<number, unknown[]> }).outlineCache.clear();

    state.hoveredId = 1;
    overlay.render(path, state, 0, state.height);

    expect(overlay.getDebugSnapshot().lastRenderMode).toBe('cache-hit');
    const outlineCache = (
      overlay as unknown as { outlineCache: Map<number, Array<{ kind: string; pts?: number[] }>> }
    ).outlineCache;
    const commands = outlineCache.get(1) ?? [];
    const bodyPolys = commands.filter((command) => command.kind === 'poly');
    const intronLines = commands.filter((command) => command.kind === 'polyline');

    expect(bodyPolys).toHaveLength(5);
    expect(intronLines).toHaveLength(2);
    expect(bodyPolys.some((command) => (command.pts?.length ?? 0) > 8)).toBe(true);
    expect(commands.every((command) => command.kind !== 'roundRect')).toBe(true);

    overlay.destroy();
  });

  it('hit-tests the thin intron connector with a tight vertical tolerance, not the full bar height', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = makeTranscriptGenome();
    const state = createState();
    const path = createLinearPath(state, genome);
    const feature = genomeFeatures(genome)[0];

    overlay.loadGenome(genome);
    const retained = overlay.getRetainedLinearPresenterForTest();
    retained.retainedOverviewMode = 'retained';
    retained.retainedLinearTranscriptFeatureSet = new Set([feature]);

    const intronPoint = path.featureLabelPosAt(300, -14);
    const centerHit = overlay.hitTest(intronPoint.x, intronPoint.y, path, state);

    const nearHit = overlay.hitTest(intronPoint.x, intronPoint.y + 3, path, state);

    const bodyHeightMiss = overlay.hitTest(intronPoint.x, intronPoint.y + 7, path, state);
    const outsideLaneMiss = overlay.hitTest(intronPoint.x, intronPoint.y + 12, path, state);

    expect(centerHit).toMatchObject({ kind: 'feature', payload: { id: 1 } });
    expect(nearHit).toMatchObject({ kind: 'feature', payload: { id: 1 } });
    expect(bodyHeightMiss).toBeNull();
    expect(outsideLaneMiss).toBeNull();

    overlay.destroy();
  });

  it('rebuilds retained transcript hover outlines with the current camera each frame', () => {
    const overlay = new AnnotationOverlayClass();
    const genome = makeTranscriptGenome();
    const state = createState();
    const path = createLinearPath(state, genome);
    const zoomedState = { ...state, zoom: 2 };
    const zoomedPath = createLinearPath(zoomedState, genome);
    const feature = genomeFeatures(genome)[0];

    overlay.loadGenome(genome);
    const retained = overlay.getRetainedLinearPresenterForTest();
    retained.retainedOverviewMode = 'retained';
    retained.retainedLinearTranscriptFeatureSet = new Set([feature]);
    state.hoveredId = 1;
    zoomedState.hoveredId = 1;

    (
      overlay as unknown as {
        renderInteractionOutlines: (path: PathMapper, state: RenderState) => void;
      }
    ).renderInteractionOutlines(path, state);
    const firstCommands = [
      ...((
        overlay as unknown as { outlineCache: Map<number, Array<{ kind: string; pts?: number[] }>> }
      ).outlineCache.get(1) ?? []),
    ];
    const firstIntron = firstCommands.find((command) => command.kind === 'polyline');

    (
      overlay as unknown as {
        renderInteractionOutlines: (path: PathMapper, state: RenderState) => void;
      }
    ).renderInteractionOutlines(zoomedPath, zoomedState);
    const secondCommands =
      (
        overlay as unknown as { outlineCache: Map<number, Array<{ kind: string; pts?: number[] }>> }
      ).outlineCache.get(1) ?? [];
    const secondIntron = secondCommands.find((command) => command.kind === 'polyline');

    expect(firstIntron?.pts?.[2]).toBeCloseTo(path.bpLeftX(399), 6);
    expect(secondIntron?.pts?.[2]).toBeCloseTo(zoomedPath.bpLeftX(399), 6);
    expect(secondIntron?.pts?.[2]).not.toBeCloseTo(firstIntron?.pts?.[2] ?? 0, 6);

    overlay.destroy();
  });

  it('legacy features (no exons[]) still flow through the original drawStandard path', () => {
    const overlay = new AnnotationOverlayClass();
    const genome: Genome = {
      name: 'legacy-cds-test',
      length: GENOME_LENGTH,
      circular: false,
      features: [
        {
          id: 1,
          type: 'CDS',
          start: 99,
          end: 500,
          direction: 'forward',
          displayName: 'Legacy CDS',
          color: 0x3b82f6,
          lane: 0,
        },
      ],
      sequence: 'A'.repeat(GENOME_LENGTH),
    };
    const state = createState();
    const path = createPath(state, genome);
    const graphics = (overlay as unknown as { graphics: { poly: (...args: unknown[]) => unknown } })
      .graphics;
    const polySpy = vi.spyOn(graphics, 'poly');

    overlay.loadGenome(genome);
    overlay.render(path, state, 0, state.height);

    expect(polySpy.mock.calls.length).toBeLessThanOrEqual(2);

    overlay.destroy();
  });
});
