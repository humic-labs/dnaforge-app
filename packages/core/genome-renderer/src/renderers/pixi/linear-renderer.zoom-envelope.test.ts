import { describe, it, expect } from 'vitest';
import { Application, Container } from 'pixi.js';
import { PixiLinearRenderer } from './linear-renderer';
import type { UnifiedLayout } from './shared/track-layout';
import type { Genome, RenderState } from '../../types';

function state(zoom: number): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom,
    width: 800,
    height: 400,
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: [0, 1000],
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  } as unknown as RenderState;
}

function genome(): Genome {
  return {
    name: 'zoom-envelope',
    length: 1000,
    circular: false,
    features: [],
    sequence: 'ACGT'.repeat(250),
  } as unknown as Genome;
}

async function layoutAtZoom(
  zoom: number,
  configure?: (r: PixiLinearRenderer) => void
): Promise<UnifiedLayout> {
  const renderer = new PixiLinearRenderer();
  const app = {
    stage: new Container(),
    canvas: document.createElement('canvas'),
    renderer: {},
  } as unknown as Application;
  const s = state(zoom);
  await renderer.init(app, genome(), () => s);
  configure?.(renderer);
  renderer.render(s);
  return (renderer as unknown as { _overlayLayout: UnifiedLayout })._overlayLayout;
}

const slot = (l: UnifiedLayout) => l.revStrandBottom - l.fwdStrandTop;

describe('PixiLinearRenderer — dsDNA slot follows zoom in a plain linear view', () => {
  it('sizes the dsDNA slot differently at different zoom levels', async () => {
    const zoomedOut = await layoutAtZoom(2);
    const zoomedIn = await layoutAtZoom(40);

    expect(slot(zoomedIn)).toBeGreaterThan(slot(zoomedOut));
  });

  it('keeps fwd and rev strands height-normalized at both zooms', async () => {
    for (const zoom of [2, 40]) {
      const l = await layoutAtZoom(zoom);
      const fwd = l.fwdStrandBottom - l.fwdStrandTop;
      const rev = l.revStrandBottom - l.revStrandTop;
      expect(rev).toBeCloseTo(fwd, 6);
      expect(l.revStrandTop).toBeCloseTo(l.fwdStrandBottom, 6);
    }
  });

  it('keeps the indexed outer layout fixed while gutter-reserved visible rows follow zoom', async () => {
    const zoomedOut = await layoutAtZoom(2, (r) => r.setTrackStackEndReservePx(24));
    const zoomedIn = await layoutAtZoom(40, (r) => r.setTrackStackEndReservePx(24));

    expect(slot(zoomedIn)).toBeGreaterThan(slot(zoomedOut));
    expect((zoomedOut.fwdStrandTop + zoomedOut.revStrandBottom) / 2).toBeCloseTo(
      (zoomedIn.fwdStrandTop + zoomedIn.revStrandBottom) / 2,
      6
    );
    expect(zoomedOut.strandEnvelopeTop).toBeCloseTo(zoomedIn.strandEnvelopeTop, 6);
    expect(zoomedOut.strandEnvelopeBottom).toBeCloseTo(zoomedIn.strandEnvelopeBottom, 6);
    expect(zoomedOut.totalHeight).toBeCloseTo(zoomedIn.totalHeight, 6);
    expect(zoomedOut.rulerY).toBeLessThan(zoomedIn.rulerY);
    expect(zoomedOut.rulerY).toBeGreaterThan(zoomedOut.revStrandBottom);
    expect(zoomedOut.rulerY).toBeLessThan(zoomedOut.strandEnvelopeBottom);
    expect(zoomedOut.maxTrackScrollTop).toBeCloseTo(zoomedIn.maxTrackScrollTop, 6);
  });

  it('keeps registered-track outer layout fixed while visible rows follow zoom', async () => {
    const withTracks = (r: PixiLinearRenderer) => {
      r.registerTrack({
        type: 'zoom-envelope-probe-track',
        mount: () => new Container(),
        unmount: () => undefined,
        paint: () => undefined,
      } as never);
      r.setTrackInstances([
        {
          id: 'zoom-envelope-probe-track-1',
          type: 'zoom-envelope-probe-track',
          order: 0,
          visible: true,
          assemblyId: 'test',
          zone: 'below-legacy',
          sizing: { kind: 'fixed', pixels: 24 },
        },
      ] as never);
    };

    const zoomedOut = await layoutAtZoom(2, withTracks);
    const zoomedIn = await layoutAtZoom(40, withTracks);

    expect(slot(zoomedIn)).toBeGreaterThan(slot(zoomedOut));
    expect((zoomedOut.fwdStrandTop + zoomedOut.revStrandBottom) / 2).toBeCloseTo(
      (zoomedIn.fwdStrandTop + zoomedIn.revStrandBottom) / 2,
      6
    );
    expect(zoomedOut.strandEnvelopeTop).toBeCloseTo(zoomedIn.strandEnvelopeTop, 6);
    expect(zoomedOut.strandEnvelopeBottom).toBeCloseTo(zoomedIn.strandEnvelopeBottom, 6);
    expect(zoomedOut.totalHeight).toBeCloseTo(zoomedIn.totalHeight, 6);
    expect(zoomedOut.rulerY).toBeLessThan(zoomedIn.rulerY);
    expect(zoomedOut.rulerY).toBeGreaterThan(zoomedOut.revStrandBottom);
    expect(zoomedOut.rulerY).toBeLessThan(zoomedOut.strandEnvelopeBottom);
  });

  it('reports stable gutter allocation and zoom-responsive visible rows from one renderer', async () => {
    const renderer = new PixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
      renderer: {},
    } as unknown as Application;
    let currentState = state(2);
    await renderer.init(app, genome(), () => currentState);
    renderer.setTrackStackEndReservePx(24);
    renderer.render(currentState);

    const coarseLane = renderer.getLaneScreenSnapshot().overlayLayout;
    const coarseCanvasHeight = renderer.getLaneScreenSnapshot().canvasContentHeightPx;
    expect(coarseLane).not.toBeNull();
    expect(coarseCanvasHeight).toBeGreaterThan(0);
    expect(coarseCanvasHeight).toBeLessThan(currentState.height);
    if (!coarseLane) throw new Error('coarse lane-screen layout missing');
    const coarseDebug = renderer.getRendererDebugSnapshot() as {
      laneContract: {
        overlayLayout: {
          strandEnvelopeTop: number;
          strandEnvelopeBottom: number;
          fwdStrandTop: number;
          fwdStrandCenter: number;
          fwdStrandBottom: number;
          revStrandTop: number;
          revStrandCenter: number;
          revStrandBottom: number;
        };
      };
    };

    currentState = state(40);
    renderer.render(currentState);
    const detailLane = renderer.getLaneScreenSnapshot().overlayLayout;
    const detailCanvasHeight = renderer.getLaneScreenSnapshot().canvasContentHeightPx;
    expect(detailLane).not.toBeNull();
    expect(detailCanvasHeight).toBe(coarseCanvasHeight);
    if (!detailLane) throw new Error('detail lane-screen layout missing');
    const detailDebug = renderer.getRendererDebugSnapshot() as typeof coarseDebug;
    const coarse = coarseDebug.laneContract.overlayLayout;
    const detail = detailDebug.laneContract.overlayLayout;

    expect(coarseLane.strandEnvelopeTop).toBeCloseTo(detailLane.strandEnvelopeTop, 6);
    expect(coarseLane.strandEnvelopeBottom).toBeCloseTo(detailLane.strandEnvelopeBottom, 6);
    expect(detail.revStrandCenter - detail.fwdStrandCenter).toBeGreaterThan(
      coarse.revStrandCenter - coarse.fwdStrandCenter
    );
    expect(coarse.fwdStrandBottom).toBeCloseTo(coarse.revStrandTop, 6);
    expect(detail.fwdStrandBottom).toBeCloseTo(detail.revStrandTop, 6);
    expect(coarse.strandEnvelopeTop).toBeCloseTo(coarseLane.strandEnvelopeTop, 6);
    expect(detail.strandEnvelopeBottom).toBeCloseTo(detailLane.strandEnvelopeBottom, 6);
  });
});
