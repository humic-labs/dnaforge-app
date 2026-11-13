// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest';

import type { Genome, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';
import type { FloatingAnnotationLabelDecision } from './floating-annotation-label-layout';
import { OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP } from './annotation-lod-policy';

type FloatingFrameReceipt = {
  contract: 'floating-annotation-label-frame.v3';
  pathMode: 'circular' | 'linear';
  preloadMarginPx: number;
  sourceFeatureCount: number;
  windowFeatureCount: number;
  assignmentBuildCount: number;
  assignmentZoomBandIndex: number | null;
  densityPoolCount: number;
  densityTargetCount: number;
  densitySelectedCount: number;
  assignmentCandidateCount: number;
  assignmentAssignedCount: number;
  assignmentSearchStepCount: number;
  assignmentSearchBudgetExhaustionCount: number;
  assignmentFingerprint: string;
  candidateCount: number;
  decisionCount: number;
  placedCount: number;
  fingerprint: string;
  decisions: readonly FloatingAnnotationLabelDecision[];
};

let AnnotationOverlayClass: typeof import('./sequence-annotation-overlay').SequenceAnnotationOverlay;

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
});

function state(viewOffset: number): RenderState {
  return {
    morph: 0,
    viewOffset,
    zoom: 1,
    width: 800,
    height: 400,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

function layout(): UnifiedLayout {
  return {
    compactScale: 1,
    sequenceVisible: false,
    sequenceRevealProgress: 0,
    annotationOffset: -14,
    annotationStep: 18,
    cdsBarOffset: -50,
    cdsLaneStep: 24,
  } as UnifiedLayout;
}

function path(viewStartBp: number, pixelsPerBp = 1, isArcMode = true): PathMapper {
  const y = 230;
  const point = (bp: number, offset: number) => ({
    x: (bp - viewStartBp) * pixelsPerBp,
    y: y + offset,
    angle: 0,
  });
  return {
    isArcMode,
    pixelsPerBp,
    viewStartBp,
    viewEndBp: viewStartBp + 800 / pixelsPerBp,
    sequenceVisible: false,
    sequenceOpacity: 0,
    rowHeight: 12,
    sequenceFontSize: 10,
    fwdStrandTop: y,
    fwdStrandBottom: y + 12,
    revStrandTop: y + 18,
    revStrandBottom: y + 30,
    cutLineTopY: y,
    cutLineBottomY: y + 30,
    cutLabelY: y + 40,
    scaleStroke: (width) => width,
    scaleNormalOffset: (offset) => offset,
    isNormalBandRenderable: () => true,
    bpLeftX: (bp) => (bp - viewStartBp) * pixelsPerBp,
    bpCenterX: (bp) => (bp - viewStartBp) * pixelsPerBp + pixelsPerBp / 2,
    featureLabelPosAt: point,
    featurePolygonAt: (startBp, endBp, offset, halfHeight = 7) => [
      point(startBp, offset).x,
      y + offset - halfHeight,
      point(endBp, offset).x,
      y + offset - halfHeight,
      point(endBp, offset).x,
      y + offset + halfHeight,
      point(startBp, offset).x,
      y + offset + halfHeight,
    ],
    featureQuadAt: (startBp, endBp, offset, halfHeight = 7) => [
      point(startBp, offset).x,
      y + offset - halfHeight,
      point(endBp, offset).x,
      y + offset - halfHeight,
      point(endBp, offset).x,
      y + offset + halfHeight,
      point(startBp, offset).x,
      y + offset + halfHeight,
    ],
    isFeatureVisible: (startBp, lengthBp) => {
      const xMin = (startBp - viewStartBp) * pixelsPerBp;
      const xMax = xMin + lengthBp * pixelsPerBp;
      return xMax >= -50 && xMin <= 850;
    },
    backboneAt: (bp) => point(bp, 0),
    fwdStrandAt: (bp) => point(bp, 0),
    revStrandAt: (bp) => point(bp, 18),
    cutLineTopAt: (bp) => point(bp, 0),
    cutLineConnectorAt: (bp) => point(bp, 15),
    cutLineBottomAt: (bp) => point(bp, 30),
    translationAt: (bp, lane) => point(bp, lane * 12),
    annotationAt: (bp, lane) => point(bp, -14 - lane * 18),
    rulerAt: (bp) => point(bp, 40),
    boundaryAt: (bp) => point(bp, 0),
    cutLabelAt: (bp) => point(bp, 40),
  };
}

function genome(): Genome {
  return {
    name: 'floating-label-current-frame-authority',
    length: 2_000,
    circular: true,
    features: Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      type: index % 2 === 0 ? 'gene' : 'CDS',
      start: 100 + index * 100,
      end: 112 + index * 100,
      direction: 'forward' as const,
      displayName: `visible annotation ${index + 1}`,
      color: 0x3b82f6,
      lane: 0,
      cdsLane: index % 2 === 0 ? undefined : 0,
    })),
  };
}

function receipt(overlay: InstanceType<typeof AnnotationOverlayClass>): FloatingFrameReceipt {
  const debug = overlay.getDebugSnapshot() as ReturnType<typeof overlay.getDebugSnapshot> & {
    floatingLabelFrame?: FloatingFrameReceipt;
  };
  if (!debug.floatingLabelFrame) throw new Error('floating label frame receipt is missing');
  return debug.floatingLabelFrame;
}

describe('SequenceAnnotationOverlay floating annotation labels', () => {
  it('produces byte-identical label IDs and geometry after an A -> B -> A camera revisit', () => {
    const overlay = new AnnotationOverlayClass();
    overlay.loadGenome(genome());
    overlay.setLayout(layout());

    overlay.render(path(0), state(0), 0, 400);
    const firstA = receipt(overlay);
    overlay.render(path(50), state(0.025), 0, 400);
    overlay.render(path(0), state(0), 0, 400);
    const secondA = receipt(overlay);

    expect(secondA.fingerprint).toBe(firstA.fingerprint);
    expect(secondA.decisions).toStrictEqual(firstA.decisions);
    overlay.destroy();
  });

  it('resolves a hover on the label text to its annotation, but not on the leader line', () => {
    const overlay = new AnnotationOverlayClass();
    overlay.loadGenome(genome());
    overlay.setLayout(layout());
    const viewPath = path(0);
    const viewState = state(0);
    overlay.render(viewPath, viewState, 0, 400);

    const placed = receipt(overlay).decisions.find((decision) => decision.status === 'placed');
    if (!placed || placed.status !== 'placed') throw new Error('no placed label to hover');

    const labelHit = overlay.hitTest(
      (placed.bounds.xMin + placed.bounds.xMax) / 2,
      (placed.bounds.yMin + placed.bounds.yMax) / 2,
      viewPath,
      viewState
    );
    expect(labelHit?.kind).toBe('feature');
    expect((labelHit?.payload as { id: number } | undefined)?.id).toBe(placed.featureId);

    const { start, elbow, end } = placed.leader;
    const [from, to] =
      Math.hypot(elbow.x - start.x, elbow.y - start.y) > 2 ? [start, elbow] : [elbow, end];
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const insideLabel =
      midX >= placed.bounds.xMin &&
      midX <= placed.bounds.xMax &&
      midY >= placed.bounds.yMin &&
      midY <= placed.bounds.yMax;
    expect(insideLabel, 'leader midpoint must lie outside the label text box').toBe(false);
    const leaderHit = overlay.hitTest(midX, midY, viewPath, viewState);
    const leaderHitId = (leaderHit?.payload as { id: number } | undefined)?.id ?? null;
    expect(leaderHitId).not.toBe(placed.featureId);
    overlay.destroy();
  });

  it('accounts for every eligible candidate and renders all spaced candidates', () => {
    const overlay = new AnnotationOverlayClass();
    overlay.loadGenome(genome());
    overlay.setLayout(layout());
    overlay.render(path(0), state(0), 0, 400);

    const frame = receipt(overlay);
    expect(frame.candidateCount).toBe(6);
    expect(frame.windowFeatureCount).toBeLessThanOrEqual(frame.sourceFeatureCount);
    expect(frame.decisionCount).toBe(frame.candidateCount);
    expect(frame.placedCount).toBe(frame.candidateCount);
    expect(frame.decisions.every((decision) => decision.status === 'placed')).toBe(true);
    overlay.destroy();
  });

  it('does not rebuild or change genome-space slots while a circular camera pans', () => {
    const overlay = new AnnotationOverlayClass();
    overlay.loadGenome(genome());
    overlay.setLayout(layout());

    const frames = [0, 25, 50, 75].map((viewStartBp) => {
      overlay.render(path(viewStartBp), state(viewStartBp / 2_000), 0, 400);
      return receipt(overlay);
    });
    const slotMap = (frame: FloatingFrameReceipt) =>
      new Map(frame.decisions.map((decision) => [decision.featureId, decision.slot]));

    expect(new Set(frames.map((frame) => frame.assignmentBuildCount))).toStrictEqual(new Set([1]));
    expect(new Set(frames.map((frame) => frame.assignmentFingerprint)).size).toBe(1);
    for (let index = 1; index < frames.length; index += 1) {
      const first = slotMap(frames[0]);
      const current = slotMap(frames[index]);
      for (const [featureId, slot] of current) expect(slot).toStrictEqual(first.get(featureId));
    }
    overlay.destroy();
  });

  it('renders floating labels on linear sequences with stable slots and a half-viewport runway', () => {
    const overlay = new AnnotationOverlayClass();
    const source = genome();
    source.circular = false;
    overlay.loadGenome(source);
    overlay.setLayout(layout());

    overlay.render(path(0, 1, false), state(0), 0, 400);
    const first = receipt(overlay);
    overlay.render(path(50, 1, false), state(0.025), 0, 400);
    const second = receipt(overlay);

    expect(first.pathMode).toBe('linear');
    expect(first.preloadMarginPx).toBe(400);
    expect(first.candidateCount).toBeGreaterThan(0);
    expect(second.assignmentBuildCount).toBe(first.assignmentBuildCount);
    expect(second.assignmentFingerprint).toBe(first.assignmentFingerprint);
    overlay.destroy();
  });

  it('includes an offscreen candidate in the fixed preload runway', () => {
    const overlay = new AnnotationOverlayClass();
    const source = genome();
    source.features = [
      {
        id: 77,
        type: 'gene',
        start: 10,
        end: 22,
        direction: 'forward',
        displayName: 'preloaded annotation',
        color: 0x3b82f6,
        lane: 0,
      },
    ];
    overlay.loadGenome(source);
    overlay.setLayout(layout());
    overlay.render(path(70), state(0.035), 0, 400);

    expect(receipt(overlay)).toMatchObject({
      candidateCount: 1,
      decisionCount: 1,
      placedCount: 1,
    });
    overlay.destroy();
  });

  it('retains a nested spatial landmark subset for sub-two-pixel whole-genome features', () => {
    const overlay = new AnnotationOverlayClass();
    const source = genome();
    source.length = 4_641_652;
    source.features = Array.from({ length: 2_000 }, (_, index) => ({
      id: index + 1,
      type: 'gene',
      start: index * 2_000,
      end: index * 2_000 + 1_000,
      direction: 'forward' as const,
      displayName: `broad feature ${index + 1}`,
      color: 0x3b82f6,
      lane: 0,
    }));
    overlay.loadGenome(source);
    overlay.setLayout(layout());
    const broadPixelsPerBp = 2 ** -14;
    overlay.render(path(0, broadPixelsPerBp), { ...state(0), zoom: 1 }, 0, 400);
    const broad = receipt(overlay);
    overlay.render(path(0, broadPixelsPerBp * 1.5), { ...state(0), zoom: 1.5 }, 0, 400);
    const sameBand = receipt(overlay);
    overlay.render(path(0, broadPixelsPerBp * 2), { ...state(0), zoom: 2 }, 0, 400);
    const nextBand = receipt(overlay);

    expect(broad.densityPoolCount).toBe(2_000);
    expect(broad.densityTargetCount).toBeGreaterThan(0);
    expect(broad.densityTargetCount).toBeLessThan(broad.densityPoolCount);
    expect(broad.densitySelectedCount).toBe(broad.densityTargetCount);
    expect(broad.assignmentCandidateCount).toBe(broad.densitySelectedCount);
    expect(broad.candidateCount).toBeGreaterThan(0);
    expect(broad.placedCount).toBeGreaterThan(0);
    expect(broad.windowFeatureCount).toBe(broad.densitySelectedCount);

    expect(sameBand.assignmentZoomBandIndex).toBe(broad.assignmentZoomBandIndex);
    expect(sameBand.assignmentBuildCount).toBe(broad.assignmentBuildCount);
    expect(sameBand.assignmentFingerprint).toBe(broad.assignmentFingerprint);
    expect(nextBand.assignmentZoomBandIndex).toBe((broad.assignmentZoomBandIndex ?? 0) + 1);
    expect(nextBand.densitySelectedCount).toBeGreaterThan(broad.densitySelectedCount);
    const assignmentIds = (frame: FloatingFrameReceipt) =>
      new Set(
        frame.assignmentFingerprint
          .split('|')
          .filter(Boolean)
          .map((entry) => Number(entry.split(':')[0]))
      );
    const broadIds = assignmentIds(broad);
    const nextBandIds = assignmentIds(nextBand);
    expect([...broadIds].every((featureId) => nextBandIds.has(featureId))).toBe(true);
    overlay.destroy();
  });

  it('hands assembly-scale arc labels on at the exact rectangle-to-shape LOD boundary', () => {
    const overlay = new AnnotationOverlayClass();
    const source = genome();
    source.length = 3_088_269_832;
    source.features = [
      {
        id: 101,
        type: 'gene',
        start: 10_000,
        end: 11_000,
        direction: 'forward',
        displayName: 'assembly boundary label',
        color: 0x3b82f6,
        lane: 0,
      },
    ];
    overlay.loadGenome(source);
    overlay.setLayout(layout());

    const belowBoundary = OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP * 0.999;
    overlay.render(path(0, belowBoundary), { ...state(0), zoom: belowBoundary }, 0, 400);
    expect(receipt(overlay)).toMatchObject({
      candidateCount: 0,
      decisionCount: 0,
      assignmentCacheKey: null,
    });

    overlay.render(
      path(0, OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP),
      { ...state(0), zoom: OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP },
      0,
      400
    );
    expect(receipt(overlay)).toMatchObject({
      candidateCount: 1,
      decisionCount: 1,
      placedCount: 1,
    });
    overlay.destroy();
  });
});
