// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  INTERNAL_CUT_SITE_STYLE,
  assignEnzymeColors,
  enzymeColorAt,
  hexToEnzymeColorInt,
} from '@waypoint/sequence-utils';
import type { CutSite } from '../../../biology/restriction-sites';
import { getStadiumDimensions, type StadiumDimensions } from '../../../geometry/stadium';
import type { RenderState } from '../../../types';
import { StadiumPathMapper, type PathMapper } from '../shared/path-mapper';

let ContainerClass: typeof import('pixi.js').Container;
let GraphicsClass: typeof import('pixi.js').Graphics;
let RestrictionTrackClass: typeof import('./restriction-track').RestrictionTrack;
let buildConnectorPolyline: typeof import('./restriction-track').buildCutSiteLabelConnectorPolyline;
let previewColor: number;

beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      measureText: (text: string) => ({ width: text.length * 7 }),
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;

  ({ Container: ContainerClass, Graphics: GraphicsClass } = await import('pixi.js'));
  ({
    RestrictionTrack: RestrictionTrackClass,
    buildCutSiteLabelConnectorPolyline: buildConnectorPolyline,
    PREVIEW_CUT_SITE_COLOR: previewColor,
  } = await import('./restriction-track'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createState(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 240,
    height: 120,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

function createPath(): PathMapper {
  const xFor = (bp: number) => bp * 4;
  return {
    isArcMode: false,
    pixelsPerBp: 4,
    rowHeight: 12,
    sequenceFontSize: 10,
    scaleStroke: (width: number) => width,
    backboneAt: (bp: number) => ({ x: xFor(bp), y: 50, angle: 0 }),
    cutLineTopAt: (bp: number) => ({ x: xFor(bp), y: 42 }),
    cutLineConnectorAt: (bp: number) => ({ x: xFor(bp), y: 50 }),
    cutLineBottomAt: (bp: number) => ({ x: xFor(bp), y: 58 }),
    boundaryAt: (bp: number, strand: 'fwdStrand' | 'revStrand') => ({
      x: xFor(bp),
      y: strand === 'fwdStrand' ? 46 : 56,
    }),
    cutLabelAt: (bp: number) => ({ x: xFor(bp), y: 72 }),
  } as unknown as PathMapper;
}

function createLowZoomPath(): PathMapper {
  return {
    ...createPath(),
    pixelsPerBp: 0.2,
  } as unknown as PathMapper;
}

function createArcPath(): PathMapper {
  const labelAt = (bp: number) =>
    bp < 20
      ? { x: 100, y: 60 + (bp - 15) * 4, angle: Math.PI / 2 }
      : { x: 100 - (bp - 25) * 4, y: 130, angle: Math.PI };

  return {
    isArcMode: true,
    pixelsPerBp: 4,
    rowHeight: 12,
    sequenceFontSize: 10,
    scaleStroke: (width: number) => width,
    backboneAt: labelAt,
    cutLineTopAt: (bp: number) => ({ x: 100, y: bp === 15 ? 44 : 74 }),
    cutLineConnectorAt: (bp: number) => ({ x: 100, y: bp === 15 ? 50 : 80 }),
    cutLineBottomAt: (bp: number) => ({ x: 100, y: bp === 15 ? 56 : 86 }),
    boundaryAt: (bp: number) => ({ x: 100 + bp * 0.1, y: 70 }),
    cutLabelAt: labelAt,
  } as unknown as PathMapper;
}

function createDenseArcPath(): PathMapper {
  const yFor = (bp: number) => 60 + (bp - 15) * 4;
  const at = (bp: number) => ({ x: 100, y: yFor(bp), angle: Math.PI / 2 });

  return {
    isArcMode: true,
    pixelsPerBp: 4,
    rowHeight: 12,
    sequenceFontSize: 10,
    scaleStroke: (width: number) => width,
    backboneAt: at,
    cutLineTopAt: (bp: number) => ({ x: 100, y: yFor(bp) - 16 }),
    cutLineConnectorAt: (bp: number) => ({ x: 100, y: yFor(bp) - 8 }),
    cutLineBottomAt: (bp: number) => ({ x: 100, y: yFor(bp) }),
    boundaryAt: (bp: number) => ({ x: 100, y: yFor(bp) }),
    cutLabelAt: (bp: number) => at(bp),
  } as unknown as PathMapper;
}

function createConstantAngleArcPath(angle: number): PathMapper {
  const pxPerBp = 4;
  const tx = Math.cos(angle);
  const ty = Math.sin(angle);
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  const at = (bp: number) => ({
    x: 40 + tx * bp * pxPerBp,
    y: 40 + ty * bp * pxPerBp,
    angle,
  });
  const offsetAt = (bp: number, offsetPx: number) => {
    const p = at(bp);
    return { x: p.x + nx * offsetPx, y: p.y + ny * offsetPx };
  };

  return {
    isArcMode: true,
    pixelsPerBp: pxPerBp,
    rowHeight: 12,
    sequenceFontSize: 10,
    scaleStroke: (width: number) => width,
    backboneAt: at,
    cutLineTopAt: (bp: number) => offsetAt(bp, -16),
    cutLineConnectorAt: (bp: number) => offsetAt(bp, -8),
    cutLineBottomAt: (bp: number) => offsetAt(bp, 0),
    boundaryAt: (bp: number) => offsetAt(bp, -6),
    cutLabelAt: (bp: number) => offsetAt(bp, 0),
  } as unknown as PathMapper;
}

function createBendingArcPath(): PathMapper {
  const radius = 40;
  const pxPerBp = 4;
  const bendStartBp = 20;
  const bendStartX = bendStartBp * pxPerBp;
  const bendStartY = 70;

  const at = (bp: number) => {
    if (bp <= bendStartBp) {
      return { x: bp * pxPerBp, y: bendStartY, angle: 0 };
    }
    const theta = Math.min(Math.PI / 2, ((bp - bendStartBp) * pxPerBp) / radius);
    return {
      x: bendStartX + radius * Math.sin(theta),
      y: bendStartY + radius * (1 - Math.cos(theta)),
      angle: theta,
    };
  };

  const offsetAt = (bp: number, offsetPx: number) => {
    const p = at(bp);
    const nx = -Math.sin(p.angle);
    const ny = Math.cos(p.angle);
    return { x: p.x + nx * offsetPx, y: p.y + ny * offsetPx };
  };

  return {
    isArcMode: true,
    pixelsPerBp: pxPerBp,
    rowHeight: 12,
    sequenceFontSize: 10,
    scaleStroke: (width: number) => width,
    backboneAt: at,
    cutLineTopAt: (bp: number) => offsetAt(bp, -16),
    cutLineConnectorAt: (bp: number) => offsetAt(bp, -8),
    cutLineBottomAt: (bp: number) => offsetAt(bp, 0),
    boundaryAt: (bp: number) => offsetAt(bp, -6),
    cutLabelAt: (bp: number) => offsetAt(bp, 0),
  } as unknown as PathMapper;
}

const ecoSite: CutSite = {
  enzyme: { name: 'EcoRI', recognition: 'GAATTC', cutTop: 1, cutBottom: 5 },
  position: 10,
  cutPositionTop: 11,
  cutPositionBottom: 15,
  recognitionEnd: 16,
  overhang: '5prime',
};

const arcSites: CutSite[] = [
  {
    enzyme: { name: 'ArcA', recognition: 'GAATTC', cutTop: 1, cutBottom: 5 },
    position: 10,
    cutPositionTop: 11,
    cutPositionBottom: 15,
    recognitionEnd: 16,
    overhang: '5prime',
  },
  {
    enzyme: { name: 'ArcB', recognition: 'GAATTC', cutTop: 1, cutBottom: 5 },
    position: 20,
    cutPositionTop: 21,
    cutPositionBottom: 25,
    recognitionEnd: 26,
    overhang: '5prime',
  },
];

const denseArcSites: CutSite[] = [
  {
    enzyme: { name: 'DenseA', recognition: 'GAATTC', cutTop: 1, cutBottom: 5 },
    position: 10,
    cutPositionTop: 11,
    cutPositionBottom: 15,
    recognitionEnd: 16,
    overhang: '5prime',
  },
  {
    enzyme: { name: 'DenseB', recognition: 'GAATTC', cutTop: 1, cutBottom: 5 },
    position: 11,
    cutPositionTop: 12,
    cutPositionBottom: 16,
    recognitionEnd: 17,
    overhang: '5prime',
  },
];

const bendingArcSite: CutSite = {
  enzyme: { name: 'BendingLong', recognition: 'GAATTC', cutTop: 1, cutBottom: 5 },
  position: 18,
  cutPositionTop: 19,
  cutPositionBottom: 23,
  recognitionEnd: 24,
  overhang: '5prime',
};

const PAJM_LENGTH = 3867;
const pajmAccIAciISites: CutSite[] = [
  {
    enzyme: { name: 'AciI', recognition: 'CCGC', cutTop: 1, cutBottom: 3 },
    position: 2056,
    cutPositionTop: 2057,
    cutPositionBottom: 2059,
    recognitionEnd: 2060,
    overhang: '5prime',
  },
  {
    enzyme: { name: 'AccI', recognition: 'GTMKAC', cutTop: 2, cutBottom: 4 },
    position: 2063,
    cutPositionTop: 2065,
    cutPositionBottom: 2067,
    recognitionEnd: 2069,
    overhang: '5prime',
  },
];

const crowdedSites: CutSite[] = Array.from({ length: 30 }, (_, index) => ({
  enzyme: { name: `Crowd${index}`, recognition: 'GAATTC', cutTop: 1, cutBottom: 5 },
  position: index * 2,
  cutPositionTop: index * 2 + 1,
  cutPositionBottom: index * 2 + 5,
  recognitionEnd: index * 2 + 6,
  overhang: '5prime',
}));

const locallyCrowdedSites: CutSite[] = Array.from({ length: 8 }, (_, index) => ({
  enzyme: { name: `Local${index}`, recognition: 'GAATTC', cutTop: 1, cutBottom: 5 },
  position: 10 + index,
  cutPositionTop: 11 + index,
  cutPositionBottom: 15 + index,
  recognitionEnd: 16 + index,
  overhang: '5prime',
}));

function normalizedViewOffsetFor(bp: number, normalizedScreenPosition: number): number {
  return (((bp / PAJM_LENGTH - normalizedScreenPosition) % 1) + 1) % 1;
}

function createPajmStadiumPath(
  normalizedScreenPosition: number,
  dims: StadiumDimensions = getStadiumDimensions(520, 160, 0, 0)
): PathMapper {
  return new StadiumPathMapper({
    genomeLength: PAJM_LENGTH,
    viewOffset: normalizedViewOffsetFor(2067, normalizedScreenPosition),
    zoom: 1,
    dims,
    ox: 40,
    oy: 30,
    stagePosX: 0,
    stagePosY: 0,
    bpPerPixel: 1,
    hasSequence: true,
    viewportWidth: 640,
    viewportHeight: 240,
  });
}

function toPairs(points: number[]): Array<{ x: number; y: number }> {
  const pairs: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < points.length; i += 2) {
    pairs.push({ x: points[i], y: points[i + 1] });
  }
  return pairs;
}

function topEdge(points: number[]): Array<{ x: number; y: number }> {
  const pairs = toPairs(points);
  return pairs.slice(0, Math.floor((pairs.length - 1) / 2));
}

function segmentLengths(points: Array<{ x: number; y: number }>): number[] {
  const lengths: number[] = [];
  for (let i = 1; i < points.length; i++) {
    lengths.push(Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return lengths;
}

function maxAngleJump(points: Array<{ x: number; y: number }>): number {
  const angles: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (length < 1) continue;
    angles.push(Math.atan2(points[i].y - points[i - 1].y, points[i].x - points[i - 1].x));
  }
  let maxJump = 0;
  for (let i = 1; i < angles.length; i++) {
    let delta = Math.abs(angles[i] - angles[i - 1]);
    while (delta > Math.PI) delta = Math.abs(delta - Math.PI * 2);
    maxJump = Math.max(maxJump, delta);
  }
  return maxJump;
}

function labelSeparationAlongAngle(
  labels: Array<{ text: string; x: number; y: number }>,
  angle: number
): number {
  const first = labels.find((label) => label.text === 'DenseA');
  const second = labels.find((label) => label.text === 'DenseB');
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  return (second!.x - first!.x) * Math.cos(angle) + (second!.y - first!.y) * Math.sin(angle);
}

describe('RestrictionTrack internal cut-site styling  #10)', () => {
  it('strokes internal cut sites in the shared error colour, not the enzyme palette', () => {
    const strokeSpy = vi.spyOn(GraphicsClass.prototype, 'setStrokeStyle');
    const track = new RestrictionTrackClass(new ContainerClass());
    const internalSite: CutSite = { ...ecoSite, isInternalCutSite: true };

    track.renderSites([internalSite], createPath(), true, createState());

    const colors = strokeSpy.mock.calls.map((call) => (call[0] as { color?: number }).color);
    expect(colors).toContain(INTERNAL_CUT_SITE_STYLE.colorPixi);

    track.destroy();
    strokeSpy.mockRestore();
  });

  it('keeps normal enzyme cut sites off the error colour', () => {
    const strokeSpy = vi.spyOn(GraphicsClass.prototype, 'setStrokeStyle');
    const track = new RestrictionTrackClass(new ContainerClass());

    track.renderSites([ecoSite], createPath(), true, createState());

    const colors = strokeSpy.mock.calls.map((call) => (call[0] as { color?: number }).color);
    expect(colors).not.toContain(INTERNAL_CUT_SITE_STYLE.colorPixi);

    track.destroy();
    strokeSpy.mockRestore();
  });

  it('fills the recognition box in the error colour for internal sites only', () => {
    const fillSpy = vi.spyOn(GraphicsClass.prototype, 'fill');
    const track = new RestrictionTrackClass(new ContainerClass());
    const internalSite: CutSite = { ...ecoSite, isInternalCutSite: true };

    track.renderSites([internalSite], createPath(), true, createState());
    const internalFills = fillSpy.mock.calls.map((call) => (call[0] as { color?: number }).color);
    expect(internalFills).toContain(INTERNAL_CUT_SITE_STYLE.colorPixi);
    fillSpy.mockClear();

    track.renderSites([ecoSite], createPath(), true, createState());
    const normalFills = fillSpy.mock.calls.map((call) => (call[0] as { color?: number }).color);
    expect(normalFills).not.toContain(INTERNAL_CUT_SITE_STYLE.colorPixi);

    track.destroy();
    fillSpy.mockRestore();
  });

  it('draws preview (scanned) cut sites in the gray preview colour — line + recognition box', () => {
    const strokeSpy = vi.spyOn(GraphicsClass.prototype, 'setStrokeStyle');
    const fillSpy = vi.spyOn(GraphicsClass.prototype, 'fill');
    const track = new RestrictionTrackClass(new ContainerClass());
    const previewSite: CutSite = { ...ecoSite, isPreview: true };

    track.renderSites([previewSite], createPath(), true, createState());
    const previewStrokes = strokeSpy.mock.calls.map(
      (call) => (call[0] as { color?: number }).color
    );
    const previewFills = fillSpy.mock.calls.map((call) => (call[0] as { color?: number }).color);
    expect(previewStrokes).toContain(previewColor);
    expect(previewFills).toContain(previewColor);
    strokeSpy.mockClear();
    fillSpy.mockClear();

    track.renderSites([ecoSite], createPath(), true, createState());
    const normalStrokes = strokeSpy.mock.calls.map((call) => (call[0] as { color?: number }).color);
    const normalFills = fillSpy.mock.calls.map((call) => (call[0] as { color?: number }).color);
    expect(normalStrokes).not.toContain(previewColor);
    expect(normalFills).not.toContain(previewColor);

    track.destroy();
    strokeSpy.mockRestore();
    fillSpy.mockRestore();
  });

  it('draws a visible `!` audit badge glyph for internal sites and none for normal sites', () => {
    const internalTrack = new RestrictionTrackClass(new ContainerClass());
    const internalSite: CutSite = { ...ecoSite, isInternalCutSite: true };
    internalTrack.renderSites([internalSite], createPath(), true, createState());
    const internalBadges = (
      internalTrack as unknown as { badgePool: Array<{ text: string; visible: boolean }> }
    ).badgePool.filter((b) => b.visible);
    expect(internalBadges).toHaveLength(1);
    expect(internalBadges[0].text).toBe(INTERNAL_CUT_SITE_STYLE.badgeChar);
    expect(
      (internalTrack as unknown as { badgeStyle: { fontSize: number; fill: number } }).badgeStyle
        .fontSize
    ).toBe(INTERNAL_CUT_SITE_STYLE.badgeFontSizePx);
    internalTrack.destroy();

    const normalTrack = new RestrictionTrackClass(new ContainerClass());
    normalTrack.renderSites([ecoSite], createPath(), true, createState());
    const normalBadges = (
      normalTrack as unknown as { badgePool: Array<{ text: string; visible: boolean }> }
    ).badgePool.filter((b) => b.visible);
    expect(normalBadges).toHaveLength(0);
    normalTrack.destroy();
  });

  it('hides pooled badge glyphs on reset (no stale `!` leaks between frames)', () => {
    const track = new RestrictionTrackClass(new ContainerClass());
    const internalSite: CutSite = { ...ecoSite, isInternalCutSite: true };

    track.renderSites([internalSite], createPath(), true, createState());
    expect(
      (track as unknown as { badgePool: Array<{ visible: boolean }> }).badgePool.filter(
        (b) => b.visible
      )
    ).toHaveLength(1);

    (track as unknown as { reset(): void }).reset();
    const visibleBadges = (
      track as unknown as { badgePool: Array<{ visible: boolean }> }
    ).badgePool.filter((b) => b.visible);
    expect(visibleBadges).toHaveLength(0);

    track.destroy();
  });
});

describe('RestrictionTrack label formatting matches the 2D/1D canvas  follow-up)', () => {
  type PooledLabel = {
    text: string;
    visible: boolean;
    tint: number;
    style: { fontSize: number; fontWeight: string; fontFamily: string | string[] };
  };
  const visibleLabels = (track: unknown): PooledLabel[] =>
    (track as unknown as { labelPool: PooledLabel[] }).labelPool.filter((l) => l.visible);

  it('colours label TEXT in the site colour via tint (not a fixed gray)', () => {
    const previewTrack = new RestrictionTrackClass(new ContainerClass());
    previewTrack.renderSites([{ ...ecoSite, isPreview: true }], createPath(), true, createState());
    const previewLabels = visibleLabels(previewTrack);
    expect(previewLabels).toHaveLength(1);
    expect(previewLabels[0].tint).toBe(previewColor);
    previewTrack.destroy();

    const internalTrack = new RestrictionTrackClass(new ContainerClass());
    internalTrack.renderSites(
      [{ ...ecoSite, isInternalCutSite: true }],
      createPath(),
      true,
      createState()
    );
    const internalLabels = visibleLabels(internalTrack);
    expect(internalLabels[0].tint).toBe(INTERNAL_CUT_SITE_STYLE.colorPixi);
    internalTrack.destroy();

    const normalTrack = new RestrictionTrackClass(new ContainerClass());
    normalTrack.renderSites([ecoSite], createPath(), true, createState());
    const normalLabels = visibleLabels(normalTrack);
    expect(normalLabels[0].tint).not.toBe(0x444444);
    expect(normalLabels[0].tint).not.toBe(0xffffff);
    normalTrack.destroy();
  });

  it('renders labels at size 10, weight 400 (700 on hover) — same as the canvas', () => {
    const track = new RestrictionTrackClass(new ContainerClass());
    track.renderSites([ecoSite], createPath(), true, createState());
    const label = visibleLabels(track)[0];
    expect(label.style.fontSize).toBe(10);
    expect(String(label.style.fontWeight)).toBe('400');
    const family = Array.isArray(label.style.fontFamily)
      ? label.style.fontFamily.join(', ')
      : label.style.fontFamily;
    expect(family).toContain('JetBrains Mono');
    expect(family).toContain('monospace');
    expect(family).not.toContain('Inter');
    track.destroy();

    const hoverTrack = new RestrictionTrackClass(new ContainerClass());
    const state = { ...createState(), hoveredCutSiteId: 'EcoRI:10' };
    hoverTrack.renderSites([ecoSite], createPath(), true, state);
    expect(String(visibleLabels(hoverTrack)[0].style.fontWeight)).toBe('700');
    hoverTrack.destroy();
  });

  it('strokes the label box at the unified 1.25 base width (matching canvas), not 2', () => {
    const strokeSpy = vi.spyOn(GraphicsClass.prototype, 'setStrokeStyle');
    const track = new RestrictionTrackClass(new ContainerClass());
    track.renderSites([ecoSite], createPath(), true, createState());
    const widths = strokeSpy.mock.calls.map((c) => (c[0] as { width?: number }).width);
    expect(widths).toContain(1.25);
    expect(widths).not.toContain(2);
    track.destroy();
    strokeSpy.mockRestore();
  });
});

describe('RestrictionTrack labels are density-governed, not zoom-gated  follow-up)', () => {
  it('still draws labels when the recognition-detail flag is OFF (density governs visibility)', () => {
    const track = new RestrictionTrackClass(new ContainerClass());
    track.renderSites([ecoSite], createPath(), false, createState());
    const labels = (
      track as unknown as { labelPool: Array<{ text: string; visible: boolean }> }
    ).labelPool.filter((l) => l.visible);
    expect(labels.some((l) => l.text === 'EcoRI')).toBe(true);
    track.destroy();
  });

  it('keeps at least the floor of labels visible even when extremely crowded', () => {
    const state = { ...createState(), width: 40 };
    const track = new RestrictionTrackClass(new ContainerClass());
    track.renderSites(crowdedSites, createLowZoomPath(), true, state);
    const labels = (
      track as unknown as { labelPool: Array<{ visible: boolean }> }
    ).labelPool.filter((l) => l.visible);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(labels.length).toBeLessThan(crowdedSites.length);
    track.destroy();
  });
});

describe('RestrictionTrack hit testing', () => {
  it('returns a typed cut-site target for rendered cut lines and labels', () => {
    const track = new RestrictionTrackClass(new ContainerClass());
    const state = createState();
    const path = createPath();

    track.renderSites([ecoSite], path, true, state);

    expect(track.hitTest(44, 46)).toMatchObject({
      kind: 'cut-site',
      payload: {
        id: 'EcoRI:10',
        enzymeName: 'EcoRI',
        recognitionStart: 10,
        recognitionEnd: 16,
      },
    });
    expect(track.hitTest(60, 80)).toMatchObject({
      kind: 'cut-site',
      payload: {
        id: 'EcoRI:10',
        enzymeName: 'EcoRI',
      },
    });
    expect(track.hitTest(2, 2)).toBeNull();

    track.destroy();
  });

  it('keeps arc labels attached to their lane path instead of resolving collisions in flat X', () => {
    const track = new RestrictionTrackClass(new ContainerClass());
    const state = createState();
    const path = createArcPath();

    track.renderSites(arcSites, path, true, state);

    const labels = (
      track as unknown as { labelPool: Array<{ text: string; x: number; y: number }> }
    ).labelPool;
    const arcA = labels.find((label) => label.text === 'ArcA');
    const arcB = labels.find((label) => label.text === 'ArcB');

    expect(arcA).toBeDefined();
    expect(arcB).toBeDefined();
    expect(arcA!.x).toBeCloseTo(92, 5);
    expect(arcA!.y).toBeCloseTo(60, 5);
    expect(arcB!.x).toBeCloseTo(100, 5);
    expect(arcB!.y).toBeCloseTo(122, 5);
    expect(track.hitTest(arcA!.x, arcA!.y)).toMatchObject({
      kind: 'cut-site',
      payload: { id: 'ArcA:10' },
    });

    track.destroy();
  });

  it('moves overlapping arc labels along the cut-label path and keeps hit testing attached', () => {
    const track = new RestrictionTrackClass(new ContainerClass());
    const state = createState();
    const path = createDenseArcPath();

    track.renderSites(denseArcSites, path, true, state);

    const labels = (
      track as unknown as { labelPool: Array<{ text: string; x: number; y: number }> }
    ).labelPool;
    const denseA = labels.find((label) => label.text === 'DenseA');
    const denseB = labels.find((label) => label.text === 'DenseB');

    expect(denseA).toBeDefined();
    expect(denseB).toBeDefined();
    expect(denseB!.x).toBeCloseTo(denseA!.x, 5);
    expect(denseB!.y).toBeGreaterThan(denseA!.y + 25);
    expect(track.hitTest(denseB!.x, denseB!.y)).toMatchObject({
      kind: 'cut-site',
      payload: { id: 'DenseB:11' },
    });

    track.destroy();
  });

  it('uses path-distance spacing consistently on straight and angled stadium label lanes', () => {
    const measureSeparation = (angle: number) => {
      const track = new RestrictionTrackClass(new ContainerClass());
      const state = { ...createState(), width: 240, height: 180 };

      track.renderSites(denseArcSites, createConstantAngleArcPath(angle), true, state);

      const labels = (
        track as unknown as { labelPool: Array<{ text: string; x: number; y: number }> }
      ).labelPool;
      const separation = labelSeparationAlongAngle(labels, angle);
      track.destroy();
      return separation;
    };

    const straightSeparation = measureSeparation(0);
    const angledSeparation = measureSeparation(Math.PI / 4);

    expect(straightSeparation).toBeGreaterThan(53);
    expect(angledSeparation).toBeCloseTo(straightSeparation, 1);
  });

  it('keeps circular label box geometry continuous through straight-to-curve transitions', () => {
    const polySpy = vi.spyOn(GraphicsClass.prototype, 'poly');
    const track = new RestrictionTrackClass(new ContainerClass());
    const state = createState();
    const path = createBendingArcPath();

    track.renderSites([bendingArcSite], path, true, state);

    const curvedBox = polySpy.mock.calls
      .map((call) => call[0])
      .find(
        (points): points is number[] =>
          Array.isArray(points) && typeof points[0] === 'number' && points.length > 20
      );

    expect(curvedBox).toBeDefined();
    const top = topEdge(curvedBox!);
    const distances = segmentLengths(top);
    const ys = curvedBox!.filter((_, index) => index % 2 === 1);

    expect(top.length).toBeGreaterThan(12);
    expect(Math.max(...distances)).toBeLessThan(8);
    expect(maxAngleJump(top)).toBeLessThan(0.22);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(20);

    track.destroy();
  });

  it('builds label connectors as path-aware polylines rather than plasmid-crossing chords', () => {
    const path = createBendingArcPath();
    const anchor = path.cutLineBottomAt(19);
    const points = buildConnectorPolyline(path, 16, anchor, 23, 42);
    const directDistance = Math.hypot(
      points[points.length - 1].x - points[0].x,
      points[points.length - 1].y - points[0].y
    );
    const pathLength = segmentLengths(points).reduce((sum, length) => sum + length, 0);
    const arcTraversalLengths = segmentLengths(points.slice(1));

    expect(points.length).toBeGreaterThan(8);
    expect(Math.max(...arcTraversalLengths)).toBeLessThan(12);
    expect(pathLength).toBeGreaterThan(directDistance * 1.05);
  });

  it('progressively hides crowded overview labels while preserving hovered labels', () => {
    const state = { ...createState(), width: 120 };
    const track = new RestrictionTrackClass(new ContainerClass());

    track.renderSites(crowdedSites, createLowZoomPath(), true, state);

    const labels = (
      track as unknown as { labelPool: Array<{ text: string; visible: boolean }> }
    ).labelPool.filter((label) => label.visible);
    expect(labels.length).toBeLessThan(crowdedSites.length);

    track.reset();
    state.hoveredCutSiteId = 'Crowd10:20';
    track.renderSites(crowdedSites, createLowZoomPath(), true, state);

    const labelsWithHover = (
      track as unknown as { labelPool: Array<{ text: string; visible: boolean }> }
    ).labelPool.filter((label) => label.visible);
    expect(labelsWithHover.some((label) => label.text === 'Crowd10')).toBe(true);

    track.destroy();
  });

  it.each(['linear', 'circular'])(
    'spreads a local %s cluster without dropping labels that fit the viewport budget',
    (mode) => {
      const state = { ...createState(), width: 800, height: 200 };
      const track = new RestrictionTrackClass(new ContainerClass());
      const path = mode === 'linear' ? createPath() : createDenseArcPath();

      track.renderSites(locallyCrowdedSites, path, true, state);

      const labels = (
        track as unknown as { labelPool: Array<{ text: string; visible: boolean }> }
      ).labelPool.filter((label) => label.visible);
      expect(labels.length).toBeGreaterThan(1);
      expect(labels.length).toBe(locallyCrowdedSites.length);

      track.reset();
      state.hoveredCutSiteId = 'Local7:17';
      track.renderSites(locallyCrowdedSites, path, true, state);

      const labelsWithHover = (
        track as unknown as { labelPool: Array<{ text: string; visible: boolean }> }
      ).labelPool.filter((label) => label.visible);
      expect(labelsWithHover.some((label) => label.text === 'Local7')).toBe(true);

      track.destroy();
    }
  );

  it('curves individual enzyme glyphs along the same lane as the box', () => {
    const track = new RestrictionTrackClass(new ContainerClass());
    track.renderSites(
      [{ ...ecoSite, cutPositionBottom: 24 }],
      createBendingArcPath(),
      true,
      createState()
    );
    const curved = (
      track as unknown as { curvedLabels?: { activeCount: number; activeRotations: number[] } }
    ).curvedLabels;
    expect(curved?.activeCount).toBe(ecoSite.enzyme.name.length);
    expect(new Set(curved?.activeRotations.map((angle) => angle.toFixed(3))).size).toBeGreaterThan(
      1
    );
    track.destroy();
  });

  it('separates labels on opposite sides of the circular origin', () => {
    const track = new RestrictionTrackClass(new ContainerClass());
    const at = (bp: number) => {
      const angle = (bp / 1000) * 2 * Math.PI;
      return { x: 140 + 100 * Math.sin(angle), y: 140 - 100 * Math.cos(angle), angle };
    };
    const path = {
      ...createPath(),
      isArcMode: true,
      pixelsPerBp: 0.628,
      backboneAt: at,
      cutLabelAt: at,
    } as PathMapper;
    const sites = [
      { ...ecoSite, position: 0, cutPositionTop: 1, cutPositionBottom: 5, recognitionEnd: 6 },
      {
        ...ecoSite,
        position: 984,
        cutPositionTop: 985,
        cutPositionBottom: 989,
        recognitionEnd: 990,
      },
    ];
    track.renderSites(sites, path, false, { ...createState(), width: 300, height: 300 }, 1000);
    const labels = (
      track as unknown as { labelPool: Array<{ x: number; y: number; visible: boolean }> }
    ).labelPool.filter((t) => t.visible);
    expect(labels).toHaveLength(2);
    expect(Math.hypot(labels[0].x - labels[1].x, labels[0].y - labels[1].y)).toBeGreaterThan(43);
    track.destroy();
  });

  it('keeps actual pAJM AccI/AciI labels path-based across stadium orientations', () => {
    const rectSpy = vi.spyOn(GraphicsClass.prototype, 'rect');
    const dims = getStadiumDimensions(520, 160, 0, 0);
    const topEnd = dims.straightLength / dims.totalLength;
    const rightCapEnd = (dims.straightLength + Math.PI * dims.radius) / dims.totalLength;
    const bottomEnd = (2 * dims.straightLength + Math.PI * dims.radius) / dims.totalLength;
    const orientations = [
      topEnd - 0.003,
      topEnd + 0.003,
      (topEnd + rightCapEnd) / 2,
      bottomEnd - 0.003,
      bottomEnd + 0.003,
      (bottomEnd + 1) / 2,
    ];

    for (const orientation of orientations) {
      const track = new RestrictionTrackClass(new ContainerClass());
      const state = { ...createState(), width: 640, height: 240 };

      track.renderSites(pajmAccIAciISites, createPajmStadiumPath(orientation, dims), true, state);

      const labels = (
        track as unknown as {
          labelPool: Array<{ text: string; x: number; y: number; rotation: number }>;
        }
      ).labelPool;
      const accI = labels.find((label) => label.text === 'AccI');
      expect(accI).toBeDefined();
      expect(Math.abs(accI!.rotation)).toBeLessThanOrEqual(Math.PI / 2);
      expect(track.hitTest(accI!.x, accI!.y)).toMatchObject({
        kind: 'cut-site',
        payload: { id: 'AccI:2063' },
      });

      track.destroy();
    }

    expect(rectSpy).not.toHaveBeenCalled();
  });
});

describe('Enzyme color authority — 2D and WebGL resolve identical color per enzyme ', () => {
  type PooledLabel = { text: string; visible: boolean; tint: number };
  const labelTintByEnzyme = (track: unknown): Map<string, number> => {
    const pool = (track as { labelPool: PooledLabel[] }).labelPool.filter((l) => l.visible);
    const m = new Map<string, number>();
    for (const l of pool) m.set(l.text, l.tint);
    return m;
  };

  const twoDColorHex = (orderedActive: string[]): Map<string, string> =>
    new Map([...assignEnzymeColors(orderedActive)].map(([name, c]) => [name, c.hex]));

  const siteFor = (
    name: string,
    recognition: string,
    position: number,
    color?: string
  ): CutSite => ({
    enzyme: { name, recognition, cutTop: 1, cutBottom: 5 },
    position,
    cutPositionTop: position + 1,
    cutPositionBottom: position + 5,
    recognitionEnd: position + 6,
    overhang: '5prime',
    color,
  });

  it('WebGL label tint equals the 2D authority hex→int for every enzyme, independent of render order', () => {
    const activeOrder = ['BamHI', 'EcoRI'];
    const hex = twoDColorHex(activeOrder);

    const sites: CutSite[] = [
      siteFor('EcoRI', 'GAATTC', 5, hex.get('EcoRI')),
      siteFor('BamHI', 'GGATCC', 30, hex.get('BamHI')),
    ];

    const track = new RestrictionTrackClass(new ContainerClass());
    track.renderSites(sites, createPath(), true, createState());
    const tint = labelTintByEnzyme(track);

    expect(tint.get('BamHI')).toBe(hexToEnzymeColorInt(hex.get('BamHI')!));
    expect(tint.get('EcoRI')).toBe(hexToEnzymeColorInt(hex.get('EcoRI')!));
    expect(tint.get('BamHI')).toBe(enzymeColorAt(0).int);
    expect(tint.get('EcoRI')).toBe(enzymeColorAt(1).int);

    track.destroy();
  });

  it('hex↔int equivalence: the hex the 2D canvas stamps converts to the int the WebGL track paints', () => {
    for (let i = 0; i < 20; i++) {
      const { hex, int } = enzymeColorAt(i);
      expect(hexToEnzymeColorInt(hex)).toBe(int);
    }
  });

  it('the color-less standalone path stays deterministic via the authority fallback', () => {
    const sites: CutSite[] = [siteFor('EcoRI', 'GAATTC', 5), siteFor('BamHI', 'GGATCC', 30)];
    const track = new RestrictionTrackClass(new ContainerClass());
    track.renderSites(sites, createPath(), true, createState());
    const tint = labelTintByEnzyme(track);
    expect(tint.get('EcoRI')).toBe(enzymeColorAt(0).int);
    expect(tint.get('BamHI')).toBe(enzymeColorAt(1).int);
    track.destroy();
  });
});
