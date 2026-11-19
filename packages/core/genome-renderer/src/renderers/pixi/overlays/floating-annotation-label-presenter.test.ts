// @vitest-environment jsdom

import { Container } from 'pixi.js';
import { PILL_LABEL_EMPHASIS_STROKE_PX } from '../shared/label-pill';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { FloatingAnnotationLabelPresenterHost } from './floating-annotation-label-presenter';

type PresenterModule = typeof import('./floating-annotation-label-presenter');

let PresenterClass: PresenterModule['FloatingAnnotationLabelPresenter'];
let floatingLabelLeaderInteractionWidth: PresenterModule['floatingLabelLeaderInteractionWidth'];

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void,
    options?: { timeout?: number }
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const GENOME_LENGTH_BP = 4_000_000;
const FEATURE_COUNT = 8_000;
const FEATURE_PITCH_BP = 500;
const FEATURE_LENGTH_BP = 300;
const DEEP_PIXELS_PER_BP = 2 ** -8;
const DEEPER_PIXELS_PER_BP = 2 ** -7;
const OVERVIEW_PIXELS_PER_BP = 2 ** -14;

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
  ({ FloatingAnnotationLabelPresenter: PresenterClass, floatingLabelLeaderInteractionWidth } =
    await import('./floating-annotation-label-presenter'));
});

afterEach(() => {
  Reflect.deleteProperty(window, 'requestIdleCallback');
  Reflect.deleteProperty(window, 'cancelIdleCallback');
});

function installIdleScheduler(): void {
  const idleWindow = window as IdleWindow;
  idleWindow.requestIdleCallback = (callback) =>
    window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 8 }), 0);
  idleWindow.cancelIdleCallback = (handle) => window.clearTimeout(handle);
}

function features(count = FEATURE_COUNT): Feature[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    type: 'gene',
    start: index * FEATURE_PITCH_BP,
    end: index * FEATURE_PITCH_BP + FEATURE_LENGTH_BP,
    direction: 'forward' as const,
    displayName: `landmark ${index + 1}`,
    color: 0x3b82f6,
    lane: 0,
  }));
}

function state(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 400,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  } as RenderState;
}

function path(viewStartBp: number, pixelsPerBp: number): PathMapper {
  const y = 230;
  const point = (bp: number, offset: number) => ({
    x: (bp - viewStartBp) * pixelsPerBp,
    y: y + offset,
    angle: 0,
  });
  return {
    isArcMode: true,
    pixelsPerBp,
    viewStartBp,
    viewEndBp: viewStartBp + 800 / pixelsPerBp,
    sequenceVisible: false,
    scaleNormalOffset: (offset: number) => offset,
    featureLabelPosAt: point,
    featurePolygonAt: (startBp: number, endBp: number, offset: number, halfHeight = 7) => [
      point(startBp, offset).x,
      y + offset - halfHeight,
      point(endBp, offset).x,
      y + offset - halfHeight,
      point(endBp, offset).x,
      y + offset + halfHeight,
      point(startBp, offset).x,
      y + offset + halfHeight,
    ],
  } as unknown as PathMapper;
}

function createHost(
  source: readonly Feature[],
  requestFrame: () => void
): FloatingAnnotationLabelPresenterHost & { readonly windowQueries: () => number } {

  const inRange = (startBp: number, endBp: number): Feature[] => {
    let low = 0;
    let high = source.length;
    const lowBound = startBp - FEATURE_LENGTH_BP;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (source[middle].start < lowBound) low = middle + 1;
      else high = middle;
    }
    const out: Feature[] = [];
    for (let index = low; index < source.length; index += 1) {
      const feature = source[index];
      if (feature.start >= endBp) break;
      if (feature.end > startBp) out.push(feature);
    }
    return out;
  };
  let windowQueries = 0;
  return {
    container: new Container(),
    features: () => source,
    candidatesForPath: (viewPath, preloadMargin) => {
      windowQueries += 1;
      const marginBp = preloadMargin / viewPath.pixelsPerBp;
      return inRange(viewPath.viewStartBp - marginBp, viewPath.viewEndBp + marginBp);
    },
    featuresInRange: inRange,
    genomeLength: () => GENOME_LENGTH_BP,
    genomeCircular: () => true,
    featureOffset: () => -14,
    barHeight: () => 14,
    cdsDetailProgress: () => 0,
    shouldRenderFeatureText: () => true,
    overviewLabelAlpha: () => 1,
    clearCalloutRecords: () => undefined,
    bodyObstacles: () => [],
    labelObstacles: () => [],
    recordCallout: () => undefined,
    requestFrame,
    windowQueries: () => windowQueries,
  };
}

async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition did not become true in time');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('FloatingAnnotationLabelPresenter', () => {
  it('walks only the features near the viewport when the density pool is the larger set', () => {
    const host = createHost(features(), () => undefined);
    const presenter = new PresenterClass(host);
    presenter.setLayoutKey('layout');
    presenter.loadGenome();

    presenter.render(path(0, DEEP_PIXELS_PER_BP), state());
    const frame = presenter.frame;

    expect(frame.densitySelectedCount * 4).toBeLessThan(FEATURE_COUNT);
    expect(frame.windowFeatureCount).toBeGreaterThan(0);
    expect(frame.windowFeatureCount).toBeLessThan(frame.densitySelectedCount);
    expect(frame.windowFeatureCount).toBeLessThanOrEqual(900);
    expect(host.windowQueries()).toBe(1);
    expect(frame.candidateCount).toBeGreaterThan(0);
    expect(frame.placedCount).toBeGreaterThan(0);
    presenter.destroy();
  });

  it('walks the density pool instead of every feature when the whole genome is visible', () => {
    const host = createHost(features(), () => undefined);
    const presenter = new PresenterClass(host);
    presenter.setLayoutKey('layout');
    presenter.loadGenome();

    presenter.render(path(0, OVERVIEW_PIXELS_PER_BP), state());
    const frame = presenter.frame;

    expect(frame.densitySelectedCount).toBeLessThan(100);
    expect(frame.windowFeatureCount).toBe(frame.densitySelectedCount);
    expect(host.windowQueries()).toBe(0);
    presenter.destroy();
  });

  it('never builds a missing zoom band on an interaction frame once any plan exists', async () => {
    installIdleScheduler();
    const requestFrame = vi.fn();
    const host = createHost(features(), requestFrame);
    const presenter = new PresenterClass(host);
    presenter.setLayoutKey('layout');
    presenter.loadGenome();

    presenter.render(path(0, DEEP_PIXELS_PER_BP), state());
    const first = presenter.frame;
    expect(first.assignmentBuildCount).toBe(1);
    expect(first.assignmentZoomBandIndex).toBe(-8);
    expect(first.requestedZoomBandIndex).toBe(-8);
    expect(first.assignmentSubstituted).toBe(false);

    presenter.render(path(0, DEEPER_PIXELS_PER_BP), state());
    const standIn = presenter.frame;
    expect(standIn.assignmentBuildCount).toBe(1);
    expect(standIn.requestedZoomBandIndex).toBe(-7);
    expect(standIn.assignmentZoomBandIndex).toBe(-8);
    expect(standIn.assignmentSubstituted).toBe(true);
    expect(standIn.candidateCount).toBeGreaterThan(0);
    expect(standIn.placedCount).toBeGreaterThan(0);
    expect(requestFrame).not.toHaveBeenCalled();

    await until(() => requestFrame.mock.calls.length > 0, 5_000);
    presenter.render(path(0, DEEPER_PIXELS_PER_BP), state());
    const converged = presenter.frame;
    expect(converged.assignmentBuildCount).toBe(1);
    expect(converged.assignmentPrewarmBuildCount).toBeGreaterThanOrEqual(1);
    expect(converged.requestedZoomBandIndex).toBe(-7);
    expect(converged.assignmentZoomBandIndex).toBe(-7);
    expect(converged.assignmentSubstituted).toBe(false);
    expect(converged.assignmentPlanRevision).toBe(1);

    await until(() => presenter.frame.assignmentCacheEntryCount >= 4, 5_000);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    presenter.destroy();
  });

  it('packs every band of a small sequence synchronously so band crossings never show a stand-in', () => {
    installIdleScheduler();
    const requestFrame = vi.fn();
    const host = createHost(features(40), requestFrame);
    const presenter = new PresenterClass(host);
    presenter.setLayoutKey('layout');
    presenter.loadGenome();

    presenter.render(path(0, DEEP_PIXELS_PER_BP), state());
    presenter.render(path(0, DEEPER_PIXELS_PER_BP), state());
    const frame = presenter.frame;
    expect(frame.assignmentBuildCount).toBe(2);
    expect(frame.assignmentZoomBandIndex).toBe(-7);
    expect(frame.assignmentSubstituted).toBe(false);
    expect(requestFrame).not.toHaveBeenCalled();
    presenter.destroy();
  });

  it('draws the hovered leader from the presented frame', () => {
    const host = createHost(features(), () => undefined);
    const presenter = new PresenterClass(host);
    presenter.setLayoutKey('layout');
    presenter.loadGenome();

    presenter.render(path(0, DEEP_PIXELS_PER_BP), state());
    const frame = presenter.frame;
    const placed = frame.decisions.filter((decision) => decision.status === 'placed');
    expect(placed.length).toBeGreaterThan(0);

    const hovered = placed[0].featureId;
    expect(presenter.hoveredLeaderSegments(hovered).length).toBeGreaterThan(0);
    expect(
      presenter.hoveredLeaderSegments(hovered).every((segment) => segment.featureId === hovered)
    ).toBe(true);
    expect(presenter.hoveredLeaderSegments(-1)).toHaveLength(0);
    presenter.renderHoverLeader({ ...state(), hoveredId: hovered });
    presenter.renderHoverLeader({ ...state(), hoveredId: null });
    presenter.destroy();
  });

  it('keeps each feature on the same label object across the per-frame clear', () => {
    const host = createHost(features(), () => undefined);
    const presenter = new PresenterClass(host);
    presenter.setLayoutKey('layout');
    presenter.loadGenome();
    const pools = presenter as unknown as {
      bitmapLabelsByFeature: Map<number, { text: string; visible: boolean }>;
      textLabelsByFeature: Map<number, { text: string; visible: boolean }>;
    };

    presenter.render(path(0, DEEP_PIXELS_PER_BP), state());
    const placedBefore = presenter.frame.decisions.filter(
      (decision) => decision.status === 'placed'
    );
    expect(placedBefore.length).toBeGreaterThan(0);
    const objectsBefore = new Map<number, unknown>();
    for (const decision of placedBefore) {
      const label =
        pools.bitmapLabelsByFeature.get(decision.featureId) ??
        pools.textLabelsByFeature.get(decision.featureId);
      expect(label, `label object for ${decision.featureId}`).toBeDefined();
      objectsBefore.set(decision.featureId, label);
    }

    presenter.clear();
    for (const label of objectsBefore.values()) {
      expect((label as { visible: boolean }).visible).toBe(false);
    }
    const textSets: string[] = [];
    for (const label of objectsBefore.values()) {
      const target = label as { text: string };
      const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'text');
      if (!original?.set) continue;
      Object.defineProperty(target, 'text', {
        configurable: true,
        get: original.get,
        set(value: string) {
          textSets.push(value);
          original.set?.call(this, value);
        },
      });
    }

    presenter.render(path(0, DEEP_PIXELS_PER_BP), state());
    const placedAfter = presenter.frame.decisions.filter(
      (decision) => decision.status === 'placed'
    );
    expect(placedAfter.map((decision) => decision.featureId)).toStrictEqual(
      placedBefore.map((decision) => decision.featureId)
    );
    for (const decision of placedAfter) {
      const label =
        pools.bitmapLabelsByFeature.get(decision.featureId) ??
        pools.textLabelsByFeature.get(decision.featureId);
      expect(label, `same object for ${decision.featureId}`).toBe(
        objectsBefore.get(decision.featureId)
      );
      expect((label as { visible: boolean }).visible).toBe(true);
    }

    expect(textSets).toStrictEqual([]);
    presenter.destroy();
  });

  it('thickens leaders by interaction state and emphasizes their label letters', () => {
    expect(floatingLabelLeaderInteractionWidth(false, false)).toBeNull();
    expect(floatingLabelLeaderInteractionWidth(true, false)).toBe(1.5);
    expect(floatingLabelLeaderInteractionWidth(false, true)).toBe(1.5);
    expect(floatingLabelLeaderInteractionWidth(true, true)).toBe(1.5);

    const host = createHost(features(), () => undefined);
    const presenter = new PresenterClass(host);
    presenter.setLayoutKey('layout');
    presenter.loadGenome();
    presenter.render(path(0, DEEP_PIXELS_PER_BP), state());
    const placed = presenter.frame.decisions.filter((decision) => decision.status === 'placed');
    expect(placed.length).toBeGreaterThan(1);
    const selected = placed[0].featureId;
    const hovered = placed[1].featureId;
    const graphics = (
      presenter as unknown as { hoverLeaderGraphics: { stroke: (...args: unknown[]) => unknown } }
    ).hoverLeaderGraphics;
    const strokeSpy = vi.spyOn(graphics, 'stroke');

    presenter.renderInteractionLeaders({
      ...state(),
      hoveredId: hovered,
      selectedIds: new Set([selected]),
    });
    const widths = strokeSpy.mock.calls.map((call) => (call[0] as { width: number }).width);
    expect(widths).toStrictEqual([1.5, 1.5]);

    strokeSpy.mockClear();
    presenter.renderInteractionLeaders({
      ...state(),
      hoveredId: selected,
      selectedIds: new Set([selected]),
    });
    expect(strokeSpy.mock.calls.map((call) => (call[0] as { width: number }).width)).toStrictEqual([
      1.5,
    ]);

    strokeSpy.mockClear();
    presenter.renderInteractionLeaders(state());
    expect(strokeSpy).not.toHaveBeenCalled();

    const pools = presenter as unknown as {
      textLabelsByFeature: Map<number, { style: { stroke: { width?: number } | null } }>;
    };
    const strokeWidthOf = (featureId: number): number | null => {
      const label = pools.textLabelsByFeature.get(featureId);
      if (!label) throw new Error(`no text label for ${featureId}`);
      return label.style.stroke?.width ?? null;
    };
    presenter.render(path(0, DEEP_PIXELS_PER_BP), {
      ...state(),
      hoveredId: hovered,
      selectedIds: new Set([selected]),
    });
    expect(strokeWidthOf(hovered)).toBe(PILL_LABEL_EMPHASIS_STROKE_PX);
    expect(strokeWidthOf(selected)).toBe(PILL_LABEL_EMPHASIS_STROKE_PX);
    const plain = placed.find(
      (decision) => decision.featureId !== hovered && decision.featureId !== selected
    );
    if (plain) expect(strokeWidthOf(plain.featureId)).toBeNull();
    presenter.render(path(0, DEEP_PIXELS_PER_BP), state());
    expect(strokeWidthOf(hovered)).toBeNull();
    expect(strokeWidthOf(selected)).toBeNull();

    presenter.renderInteractionLeaders({ ...state(), selectedIds: new Set([selected]) });
    expect(strokeWidthOf(selected)).toBe(PILL_LABEL_EMPHASIS_STROKE_PX);
    expect(strokeWidthOf(hovered)).toBeNull();
    presenter.renderInteractionLeaders(state());
    expect(strokeWidthOf(selected)).toBeNull();
    presenter.destroy();
  });

  it('recolors existing annotation names on a palette edit without moving the camera', () => {
    const presenter = new PresenterClass(createHost(features(), () => undefined));
    presenter.setLayoutKey('layout');
    presenter.loadGenome();
    presenter.render(path(0, DEEP_PIXELS_PER_BP), state());
    const placed = presenter.frame.decisions.find((decision) => decision.status === 'placed')!;
    const pools = presenter as unknown as {
      textLabelsByFeature: Map<number, { style: { fill: number } }>;
    };
    const label = pools.textLabelsByFeature.get(placed.featureId)!;
    presenter.renderInteractionLeaders({
      ...state(),
      sequencePresentation: { annotationColors: new Map([[placed.featureId, 0xc03aca]]) },
    });
    expect(label.style.fill).toBe(0xc03aca);
    presenter.renderInteractionLeaders({
      ...state(),
      sequencePresentation: { annotationColors: new Map([[placed.featureId, 0x26a7d0]]) },
    });
    expect(label.style.fill).toBe(0x26a7d0);
    presenter.destroy();
  });

  it('still builds the very first plan synchronously so the first paint has labels', () => {
    installIdleScheduler();
    const host = createHost(features(), () => undefined);
    const presenter = new PresenterClass(host);
    presenter.setLayoutKey('layout');
    presenter.loadGenome();

    presenter.render(path(0, DEEPER_PIXELS_PER_BP), state());
    const frame = presenter.frame;
    expect(frame.assignmentBuildCount).toBe(1);
    expect(frame.assignmentSubstituted).toBe(false);
    expect(frame.placedCount).toBeGreaterThan(0);
    presenter.destroy();
  });
});
