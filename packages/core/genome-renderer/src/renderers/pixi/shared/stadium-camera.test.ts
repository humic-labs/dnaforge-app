import { describe, expect, it } from 'vitest';
import type { StadiumDimensions } from '../../../geometry/stadium';
import type { LaneStackBounds } from './lane-contracts';
import { DEFAULT_STADIUM_CAMERA_TUNING, solveStadiumCamera } from './stadium-camera';

const viewportHeight = 400;
const marginTop = 10;
const marginBottom = 10;
const availableHeight = viewportHeight - marginTop - marginBottom;

const circularDims: StadiumDimensions = {
  width: 260,
  height: 260,
  radius: 130,
  straightLength: 0,
  totalLength: 2 * Math.PI * 130,
};

const laneStackBounds: LaneStackBounds = {
  id: 'camera-test-lanes',
  minOffset: -42,
  maxOffset: 68,
  outwardExtent: 68,
  inwardExtent: 42,
};

function zoomForFitRatio(fitRatio: number): number {
  return (fitRatio * availableHeight - 2 * laneStackBounds.outwardExtent) / circularDims.height;
}

function solveAtFitRatio(fitRatio: number) {
  return solveStadiumCamera({
    viewportWidth: 800,
    viewportHeight,
    dims: circularDims,
    ox: 0,
    oy: 0,
    zoom: zoomForFitRatio(fitRatio),
    laneStackBounds,
    marginTop,
    marginBottom,
  });
}

function topLaneStackCenterY(result: ReturnType<typeof solveStadiumCamera>): number {
  return result.backboneTargetY + result.debug.topLaneStackCenterOffset;
}

describe('solveStadiumCamera', () => {
  it('uses the locked gradual handoff tuning', () => {
    expect(DEFAULT_STADIUM_CAMERA_TUNING).toEqual({
      startFitRatio: 1,
      transitionSpan: 1.4,
      easingPower: 2.4,
    });
  });

  it('keeps the full circular lane stack centered before the tuned handoff starts', () => {
    for (const fitRatio of [0.65, 0.72, DEFAULT_STADIUM_CAMERA_TUNING.startFitRatio]) {
      const result = solveAtFitRatio(fitRatio);

      expect(result.debug.transitionStartFitRatio).toBe(
        DEFAULT_STADIUM_CAMERA_TUNING.startFitRatio
      );
      expect(result.debug.fitRatio).toBeCloseTo(fitRatio, 6);
      expect(result.debug.transitionProgress).toBe(0);
      expect(result.backboneTargetY).toBeCloseTo(result.debug.overviewBackboneTargetY, 6);
    }
  });

  it('centers the visible shape with room for floating labels above it', () => {
    const input = {
      viewportWidth: 800,
      viewportHeight,
      dims: circularDims,
      ox: 0,
      oy: 0,
      zoom: zoomForFitRatio(0.65),
      laneStackBounds,
      marginTop,
      marginBottom,
    };
    const withoutLabels = solveStadiumCamera(input);
    const withLabels = solveStadiumCamera({ ...input, floatingLabelTopReservePx: 72 });

    expect(withLabels.backboneTargetY - withoutLabels.backboneTargetY).toBeCloseTo(36, 6);
    expect(withLabels.debug.fullShapeVisualHeight).toBeCloseTo(
      withoutLabels.debug.fullShapeVisualHeight + 72,
      6
    );
  });

  it.each([
    [220, 562, 0],
    [456, 562, 0],
    [706, 0, 1],
  ])(
    'centers the map overview in a %ipx pane with a %ipx straight segment',
    (paneHeight, straightLength, morph) => {
      const radius = 74.6;
      const input = {
        viewportWidth: 842,
        viewportHeight: paneHeight,
        dims: {
          width: straightLength + 2 * radius,
          height: 2 * radius,
          radius,
          straightLength,
          totalLength: 2 * straightLength + 2 * Math.PI * radius,
        },
        ox: 0,
        oy: 0,
        zoom: 1,
        laneStackBounds,
        floatingLabelTopReservePx: 72,
        centerStadiumOverview: true,
        morph,
      };
      const overview = solveStadiumCamera(input);
      expect(overview.backboneTargetY + radius).toBeCloseTo(paneHeight / 2);

      for (const zoom of [2, 8]) {
        const detail = solveStadiumCamera({ ...input, zoom });
        const standalone = solveStadiumCamera({ ...input, zoom, centerStadiumOverview: false });
        expect(detail.backboneTargetY).toBeCloseTo(standalone.backboneTargetY);
      }
    }
  );

  it('holds the full-shape overview until the shape overflows, then eases to the detail regime', () => {
    const stillFitsLow = solveAtFitRatio(0.9);
    const stillFitsHigh = solveAtFitRatio(0.99);
    const firstOverflow = solveAtFitRatio(1.02);
    const laterOverflow = solveAtFitRatio(1.12);
    const settledOverflow = solveAtFitRatio(2.75);
    const viewportCenterY = viewportHeight / 2;

    expect(stillFitsLow.debug.transitionProgress).toBe(0);
    expect(stillFitsHigh.debug.transitionProgress).toBe(0);
    expect(stillFitsHigh.backboneTargetY).toBeCloseTo(
      stillFitsHigh.debug.overviewBackboneTargetY,
      6
    );

    expect(firstOverflow.debug.transitionProgress).toBeGreaterThan(0);
    expect(firstOverflow.debug.backboneTargetY).not.toBeCloseTo(
      firstOverflow.debug.overviewBackboneTargetY,
      6
    );
    expect(laterOverflow.debug.transitionProgress).toBeGreaterThan(
      firstOverflow.debug.transitionProgress
    );

    expect(settledOverflow.debug.transitionProgress).toBeGreaterThan(0.99);
    expect(topLaneStackCenterY(settledOverflow)).toBeCloseTo(viewportCenterY, 1);
  });
});
