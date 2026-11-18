// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Application, Container } from 'pixi.js';
import type { Genome, RenderState } from '../../types';
import type { Track } from '../../tracks';
import { PixiLinearRenderer } from './linear-renderer';
import type { PixiLinearTrackRenderer } from './linear-tracks';
import { SequenceAnnotationOverlay } from './overlays/sequence-annotation-overlay';
import type { FloatingAnnotationLabelFrameReceipt } from './overlays/floating-annotation-label-presenter';
import type { UnifiedLayout } from './shared/track-layout';

vi.mock('./shared/canvas-middle-text', () => ({ canvasMiddleTextAnchorY: () => 0.5 }));

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

function state(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 0.665,
    width: 1104,
    height: 607,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

function genome(): Genome {
  return {
    name: 'annotation-label-clearance',
    length: 17_000,
    circular: false,
    sequence: 'A'.repeat(17_000),
    features: Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      type: 'gene',
      start: 2000 + index * 1800,
      end: 2012 + index * 1800,
      direction: 'forward' as const,
      displayName: `gene${index + 1}`,
      color: 0x3b82f6,
      lane: 0,
    })),
  };
}

async function fixture(inputGenome = genome()) {
  const viewState = state();
  const overlay = new SequenceAnnotationOverlay();
  const renderer = new PixiLinearRenderer({ overlay });
  const track: Track = {
    id: 'measurements',
    type: 'test-measurements',
    order: 0,
    visible: true,
    assemblyId: 'test',
    zone: 'below-legacy',
    sizing: { kind: 'fixed', pixels: 190 },
  };
  const trackRenderer: PixiLinearTrackRenderer = {
    type: track.type,
    mount: () => new Container(),
    unmount: () => undefined,
    paint: () => undefined,
  };
  await renderer.init(
    {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application,
    inputGenome,
    () => viewState
  );
  renderer.setChromosome({
    id: 'reference',
    displayName: 'reference',
    length: inputGenome.length,
    cytobands: [],
  });
  renderer.registerTrack(trackRenderer);
  return { renderer, overlay, viewState, track };
}

function snapshot(renderer: PixiLinearRenderer) {
  return renderer.getRendererDebugSnapshot() as {
    annotationOverlay: { floatingLabelFrame: FloatingAnnotationLabelFrameReceipt };
    laneContract: {
      overlayLayout: UnifiedLayout;
      trackScreenBounds: Record<string, { topPx: number; heightPx: number; bottomPx: number }>;
    };
  };
}

describe('PixiLinearRenderer supplemental track annotation labels', () => {
  it('keeps the full floating label boxes on the canvas after a lower track is attached', async () => {
    const f = await fixture();
    try {
      f.renderer.render(f.viewState);
      const baseline = snapshot(f.renderer);
      const baselineLabels = baseline.annotationOverlay.floatingLabelFrame.decisions.filter(
        (decision) => decision.status === 'placed'
      );
      expect(baselineLabels).toHaveLength(6);
      expect(
        Math.min(...baselineLabels.map((decision) => decision.bounds.yMin))
      ).toBeGreaterThanOrEqual(0);

      f.renderer.setTrackInstances([f.track]);
      f.renderer.render(f.viewState);
      const attached = snapshot(f.renderer);
      const labels = attached.annotationOverlay.floatingLabelFrame.decisions.filter(
        (decision) => decision.status === 'placed'
      );

      expect(labels).toHaveLength(6);
      expect(Math.min(...labels.map((decision) => decision.bounds.yMin))).toBeGreaterThanOrEqual(0);
      const layout = attached.laneContract.overlayLayout;
      expect(layout.trackScrollTop).toBe(0);
      expect(layout.annotationTop).toBeGreaterThanOrEqual(f.overlay.floatingLabelTopReservePx());
      const bounds = attached.laneContract.trackScreenBounds[f.track.id];
      expect(bounds.topPx).toBeGreaterThan(layout.rulerY);
      expect(bounds.heightPx).toBe(190);
      expect(bounds.bottomPx).toBeLessThanOrEqual(f.viewState.height);
    } finally {
      f.renderer.destroy();
    }
  });

  it('keeps the lower track stationary across sequence reveal and scrolls the complete stack together', async () => {
    const f = await fixture();
    try {
      f.renderer.setTrackInstances([f.track]);
      f.renderer.render(f.viewState);
      const broad = snapshot(f.renderer);
      f.viewState.zoom = 200;
      f.renderer.render(f.viewState);
      const detail = snapshot(f.renderer);
      expect(detail.laneContract.trackScreenBounds[f.track.id].topPx).toBe(
        broad.laneContract.trackScreenBounds[f.track.id].topPx
      );

      f.viewState.height = 120;
      f.renderer.render(f.viewState);
      const beforeScroll = snapshot(f.renderer);
      expect(f.renderer.scrollTracksBy(30)).toBe(true);
      f.renderer.render(f.viewState);
      const afterScroll = snapshot(f.renderer);
      expect(afterScroll.laneContract.overlayLayout.trackScrollTop).toBe(30);
      expect(afterScroll.laneContract.overlayLayout.annotationTop).toBeCloseTo(
        beforeScroll.laneContract.overlayLayout.annotationTop - 30
      );
      expect(afterScroll.laneContract.trackScreenBounds[f.track.id].topPx).toBeCloseTo(
        beforeScroll.laneContract.trackScreenBounds[f.track.id].topPx - 30
      );
    } finally {
      f.renderer.destroy();
    }
  });

  it('keeps an empty reference with a companion gutter anchored at the top', async () => {
    const f = await fixture({ ...genome(), features: [] });
    try {
      f.renderer.setTrackStackEndReservePx(32);
      f.renderer.render(f.viewState);
      const layout = snapshot(f.renderer).laneContract.overlayLayout;
      expect(layout.offset).toBe(0);
      expect(layout.annotationTop).toBe(0);
      expect(layout.trackScrollTop).toBe(0);
    } finally {
      f.renderer.destroy();
    }
  });
});
