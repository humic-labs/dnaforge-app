// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest';
import type { Feature, Genome, RenderState } from '../../../types';

let AnnotationOverlayClass: typeof import('./sequence-annotation-overlay').SequenceAnnotationOverlay;
let LinearPathMapperClass: typeof import('../shared/path-mapper').LinearPathMapper;

beforeAll(async () => {
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
  ({ LinearPathMapper: LinearPathMapperClass } = await import('../shared/path-mapper'));
});

const GENOME_LENGTH = 2_000_000;

function createState(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 400,
    themeMode: 'light',
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

function linearPath(state: RenderState, viewStartBp: number, viewEndBp: number) {
  const span = viewEndBp - viewStartBp;
  return new LinearPathMapperClass({
    viewportWidth: state.width,
    viewportHeight: state.height,
    bpPerPixel: span / state.width,
    viewStartBp,
    viewEndBp,
    annotationLanes: 3,
    translationLanes: 1,
    hasSequence: false,
  });
}

function makeGenome(): Genome {
  return {
    name: 'chevron-cache-test',
    length: GENOME_LENGTH,
    circular: false,
    features: [
      {
        id: 1,
        type: 'mRNA',
        start: 99_999,
        end: 130_000,
        direction: 'forward',
        displayName: 'CACHED',
        color: 0x3b82f6,
        lane: 0,
        exons: [
          { start: 100_000, end: 100_500 },
          { start: 120_000, end: 120_500 },
          { start: 129_000, end: 130_000 },
        ],
        cds: [],
      } as Feature,
    ],
    sequence: '',
  };
}

interface DecorationHarness {
  overlay: import('./sequence-annotation-overlay').SequenceAnnotationOverlay;
  draw(viewStartBp: number, viewEndBp: number): { builds: number; posX: number; moveXs: number[] };
}

function makeHarness(): DecorationHarness {
  const overlay = new AnnotationOverlayClass();
  const genome = makeGenome();
  overlay.loadGenome(genome);
  const feature = genome.features![0] as Feature;
  const batched = new Set<Feature>([feature]);
  const retained = overlay.getRetainedLinearPresenterForTest();
  retained.retainedLinearTranscriptFeatureSet = batched;
  retained.retainedLinearTranscriptKey = 'chevron-cache-test-key';

  const g = (
    overlay as unknown as {
      retainedTranscriptDecorationGraphics: {
        moveTo: (x: number, y: number) => unknown;
        position: { x: number };
      };
    }
  ).retainedTranscriptDecorationGraphics;

  return {
    overlay,
    draw(viewStartBp, viewEndBp) {
      const state = createState();
      const path = linearPath(state, viewStartBp, viewEndBp);
      const moveXs: number[] = [];
      const realMoveTo = g.moveTo.bind(g);
      g.moveTo = (x: number, y: number) => {
        moveXs.push(x);
        return realMoveTo(x, y);
      };
      (
        overlay as unknown as {
          renderRetainedTranscriptDecorations: (
            set: ReadonlySet<Feature>,
            path: unknown,
            state: RenderState
          ) => void;
        }
      ).renderRetainedTranscriptDecorations(batched, path, state);
      g.moveTo = realMoveTo;
      const builds = overlay.getDebugSnapshot().retainedTranscriptDecorationBuilds;
      return { builds, posX: g.position.x, moveXs };
    },
  };
}

const SPAN = 60_000;
const CENTER = 110_000;

describe(' chevron decoration translation cache', () => {
  it('builds the chevron tessellation ONCE entering the band, then Δ0 across pans at the same zoom', () => {
    const h = makeHarness();
    const a = h.draw(CENTER - SPAN / 2, CENTER + SPAN / 2);
    expect(a.builds).toBe(1);
    expect(a.moveXs.length).toBeGreaterThan(0);

    let prevBuilds = a.builds;
    for (const shift of [10_000, -5_000, 7_500, -12_000]) {
      const r = h.draw(CENTER - SPAN / 2 + shift, CENTER + SPAN / 2 + shift);
      expect(r.builds).toBe(prevBuilds);
      prevBuilds = r.builds;
    }
    h.overlay.destroy();
  });

  it('rebuilds when the zoom (pixelsPerBp) changes', () => {
    const h = makeHarness();
    const a = h.draw(CENTER - SPAN / 2, CENTER + SPAN / 2);
    expect(a.builds).toBe(1);
    const b = h.draw(CENTER - SPAN / 4, CENTER + SPAN / 4);
    expect(b.builds).toBe(2);
    h.overlay.destroy();
  });

  it('rebuilds when a pan scrolls past the built ±margin window', () => {
    const h = makeHarness();
    const a = h.draw(CENTER - SPAN / 2, CENTER + SPAN / 2);
    expect(a.builds).toBe(1);
    const farShift = SPAN * 3;
    const r = h.draw(CENTER - SPAN / 2 + farShift, CENTER + SPAN / 2 + farShift);
    expect(r.builds).toBe(2);
    h.overlay.destroy();
  });

  it('PIXEL-IDENTITY: translated chevron X equals a fresh redraw at the panned camera', () => {
    const h = makeHarness();
    const shift = 8_000;
    const aStart = CENTER - SPAN / 2;
    const a = h.draw(aStart, aStart + SPAN);
    expect(a.builds).toBe(1);
    const b = h.draw(aStart + shift, aStart + shift + SPAN);
    expect(b.builds).toBe(1);
    const effectiveX = a.moveXs.map((x) => x + b.posX);

    const gt = makeHarness();
    const truth = gt.draw(aStart + shift, aStart + shift + SPAN);
    expect(truth.builds).toBe(1);
    const truthX = truth.moveXs.map((x) => x + truth.posX);

    const W = 800;
    const visibleEffective = effectiveX.filter((x) => x >= -1 && x <= W + 1).sort((p, q) => p - q);
    const visibleTruth = truthX.filter((x) => x >= -1 && x <= W + 1).sort((p, q) => p - q);
    expect(visibleEffective.length).toBe(visibleTruth.length);
    for (let i = 0; i < visibleTruth.length; i++) {
      expect(visibleEffective[i]).toBeCloseTo(visibleTruth[i], 6);
    }
    h.overlay.destroy();
    gt.overlay.destroy();
  });

  it('drops the cache (chevronBuilds frozen) and hides when LOD fades decorations off', () => {
    const h = makeHarness();
    const a = h.draw(CENTER - SPAN / 2, CENTER + SPAN / 2);
    expect(a.builds).toBe(1);
    const wide = h.draw(0, GENOME_LENGTH);
    expect(wide.builds).toBe(1);
    expect(wide.moveXs.length).toBe(0);
    h.overlay.destroy();
  });
});
