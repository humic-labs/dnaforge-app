import { normalizedPosToPoint, type StadiumDimensions } from '../../../geometry/stadium';
import type { LaneStackBounds } from './lane-contracts';

const DEFAULT_MARGIN_TOP = 10;
const DEFAULT_MARGIN_BOTTOM = 10;
const CAMERA_TRANSITION_START_FIT_RATIO = 1;
const BASE_TRANSITION_FIT_RATIO_SPAN = 1.4;
const CAMERA_TRANSITION_EASING_POWER = 2.4;
const REFERENCE_CAMERA_TRAVEL_PX = 160;
const MAX_TRAVEL_NORMALIZATION_SCALE = 1.4;

export type StadiumCameraTuning = {
  startFitRatio: number;
  transitionSpan: number;
  easingPower: number;
};

export const DEFAULT_STADIUM_CAMERA_TUNING: StadiumCameraTuning = {
  startFitRatio: CAMERA_TRANSITION_START_FIT_RATIO,
  transitionSpan: BASE_TRANSITION_FIT_RATIO_SPAN,
  easingPower: CAMERA_TRANSITION_EASING_POWER,
};

export type StadiumCameraDebug = {
  overviewBackboneTargetY: number;
  transitionAnchorBackboneTargetY: number;
  detailBackboneTargetY: number;
  backboneTargetY: number;
  targetTravelPx: number;
  plannedTransitionTravelPx: number;
  fitRatio: number;
  transitionStartFitRatio: number;
  transitionEndFitRatio: number;
  transitionBaseSpan: number;
  transitionEasingPower: number;
  transitionProgress: number;
  progress: number;
  fullShapeVisualHeight: number;
  floatingLabelTopReservePx: number;
  availableHeight: number;
  topVisibleBackboneTargetMin: number;
  bottomVisibleBackboneTargetMax: number;
  hardTopVisibleBackboneTargetMin: number;
  hardBottomVisibleBackboneTargetMax: number;
  canHonorVisibleMargins: boolean;
  canHonorHardVisibility: boolean;
  isLaneStackTallerThanViewport: boolean;
  effectiveMarginTop: number;
  effectiveMarginBottom: number;
  topLaneStackCenterOffset: number;
};

export type StadiumCameraInputs = {
  viewportWidth: number;
  viewportHeight: number;
  dims: StadiumDimensions;
  ox: number;
  oy: number;
  zoom: number;
  centerStadiumOverview?: boolean;
  morph?: number;
  laneStackBounds: LaneStackBounds;
  visualLaneStackBounds?: LaneStackBounds;
  floatingLabelTopReservePx?: number;
  marginTop?: number;
  marginBottom?: number;
};

export type StadiumCameraResult = {
  stagePosX: number;
  stagePosY: number;
  backboneTargetY: number;
  topWorldX: number;
  topWorldY: number;
  debug: StadiumCameraDebug;
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function centeredOverviewWeight(
  centerStadiumOverview: boolean | undefined,
  zoom: number,
  morph: number
): number {
  return centerStadiumOverview ? (1 - clamp01(morph)) * clamp01(2 - zoom) : 0;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeOutPower(t: number, power: number): number {
  const clamped = clamp01(t);
  return 1 - Math.pow(1 - clamped, power);
}

export function fullShapeVisualHeight(
  dims: StadiumDimensions,
  zoom: number,
  laneStackBounds: LaneStackBounds
): number {
  return dims.height * zoom + 2 * laneStackBounds.outwardExtent;
}

function transitionEndFitRatio(targetTravelPx: number, tuning: StadiumCameraTuning): number {
  const extraTravel = Math.max(0, targetTravelPx - REFERENCE_CAMERA_TRAVEL_PX);
  const travelScale =
    1 +
    (MAX_TRAVEL_NORMALIZATION_SCALE - 1) *
      (extraTravel / (extraTravel + REFERENCE_CAMERA_TRAVEL_PX));
  return tuning.startFitRatio + tuning.transitionSpan * travelScale;
}

export function solveStadiumCamera(inputs: StadiumCameraInputs): StadiumCameraResult {
  const {
    viewportWidth,
    viewportHeight,
    dims,
    ox,
    oy,
    zoom,
    laneStackBounds,
    visualLaneStackBounds = laneStackBounds,
    floatingLabelTopReservePx = 0,
    marginTop = DEFAULT_MARGIN_TOP,
    marginBottom = DEFAULT_MARGIN_BOTTOM,
  } = inputs;
  const cx = viewportWidth / 2;
  const topMidFrac = dims.straightLength > 0 ? dims.straightLength / dims.totalLength / 2 : 0;
  const topPt = normalizedPosToPoint(topMidFrac, dims);
  const topWorldX = ox + topPt.x;
  const topWorldY = oy + topPt.y;
  const outerExtent = laneStackBounds.outwardExtent;
  const labelTopReserve = Number.isFinite(floatingLabelTopReservePx)
    ? Math.max(0, floatingLabelTopReservePx)
    : 0;
  const visualHeight = fullShapeVisualHeight(dims, zoom, laneStackBounds) + labelTopReserve;
  const availableHeight = Math.max(1, viewportHeight - marginTop - marginBottom);
  const overviewBackboneTargetY =
    marginTop + (availableHeight - visualHeight) / 2 + outerExtent + labelTopReserve;
  const laneStackHeight = visualLaneStackBounds.maxOffset - visualLaneStackBounds.minOffset;
  const effectiveVerticalMargin = Math.min(
    marginTop,
    marginBottom,
    Math.max(0, (viewportHeight - laneStackHeight) / 2)
  );
  const topVisibleBackboneTargetMin =
    effectiveVerticalMargin - visualLaneStackBounds.minOffset + labelTopReserve;
  const bottomVisibleBackboneTargetMax =
    viewportHeight - effectiveVerticalMargin - visualLaneStackBounds.maxOffset;
  const hardTopVisibleBackboneTargetMin = -visualLaneStackBounds.minOffset + labelTopReserve;
  const hardBottomVisibleBackboneTargetMax = viewportHeight - visualLaneStackBounds.maxOffset;
  const canHonorVisibleMargins = topVisibleBackboneTargetMin <= bottomVisibleBackboneTargetMax;
  const canHonorHardVisibility =
    hardTopVisibleBackboneTargetMin <= hardBottomVisibleBackboneTargetMax;
  const isLaneStackTallerThanViewport = !canHonorHardVisibility;
  const topLaneStackCenterOffset =
    (visualLaneStackBounds.minOffset - labelTopReserve + visualLaneStackBounds.maxOffset) / 2;
  const centeredDetailTargetY = viewportHeight / 2 - topLaneStackCenterOffset;
  const detailBackboneTargetY = canHonorVisibleMargins
    ? Math.max(
        topVisibleBackboneTargetMin,
        Math.min(bottomVisibleBackboneTargetMax, centeredDetailTargetY)
      )
    : canHonorHardVisibility
      ? Math.max(
          hardTopVisibleBackboneTargetMin,
          Math.min(hardBottomVisibleBackboneTargetMax, centeredDetailTargetY)
        )
      : hardBottomVisibleBackboneTargetMax;

  const fitRatio = visualHeight / availableHeight;
  const transitionAnchorBackboneTargetY = detailBackboneTargetY;
  const targetTravelPx = Math.abs(detailBackboneTargetY - overviewBackboneTargetY);
  const plannedTransitionTravelPx = Math.max(targetTravelPx, viewportHeight * 0.25);
  const tuning = DEFAULT_STADIUM_CAMERA_TUNING;
  const transitionStart = tuning.startFitRatio;
  const transitionEnd = transitionEndFitRatio(plannedTransitionTravelPx, tuning);
  const transitionT = (fitRatio - transitionStart) / (transitionEnd - transitionStart);
  const rawTransitionProgress = easeOutPower(transitionT, tuning.easingPower);
  const transitionProgress = rawTransitionProgress >= 0.999 ? 1 : rawTransitionProgress;
  const rawBackboneTargetY = lerp(
    overviewBackboneTargetY,
    detailBackboneTargetY,
    transitionProgress
  );
  const laneTargetY = canHonorHardVisibility
    ? Math.max(
        hardTopVisibleBackboneTargetMin,
        Math.min(hardBottomVisibleBackboneTargetMax, rawBackboneTargetY)
      )
    : hardBottomVisibleBackboneTargetMax;

  const centeredTargetY = viewportHeight / 2 - (dims.height * zoom) / 2;
  const backboneTargetY = lerp(
    laneTargetY,
    centeredTargetY,
    centeredOverviewWeight(inputs.centerStadiumOverview, zoom, inputs.morph ?? 0)
  );

  const debug: StadiumCameraDebug = {
    overviewBackboneTargetY,
    transitionAnchorBackboneTargetY,
    detailBackboneTargetY,
    backboneTargetY,
    targetTravelPx,
    plannedTransitionTravelPx,
    fitRatio,
    transitionStartFitRatio: transitionStart,
    transitionEndFitRatio: transitionEnd,
    transitionBaseSpan: tuning.transitionSpan,
    transitionEasingPower: tuning.easingPower,
    transitionProgress,
    progress: transitionProgress,
    fullShapeVisualHeight: visualHeight,
    floatingLabelTopReservePx: labelTopReserve,
    availableHeight,
    topVisibleBackboneTargetMin,
    bottomVisibleBackboneTargetMax,
    hardTopVisibleBackboneTargetMin,
    hardBottomVisibleBackboneTargetMax,
    canHonorVisibleMargins,
    canHonorHardVisibility,
    isLaneStackTallerThanViewport,
    effectiveMarginTop: effectiveVerticalMargin,
    effectiveMarginBottom: effectiveVerticalMargin,
    topLaneStackCenterOffset,
  };

  return {
    stagePosX: cx - topWorldX * zoom,
    stagePosY: backboneTargetY - topWorldY * zoom,
    backboneTargetY,
    topWorldX,
    topWorldY,
    debug,
  };
}
