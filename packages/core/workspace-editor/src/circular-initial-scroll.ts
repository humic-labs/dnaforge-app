export interface CircularInitialScrollInput {
  circular: boolean;
  isZoomCommit?: boolean;
  realRowsStartY: number | undefined;
  currentScrollTop: number;
  lastAppliedRealRowsStartY: number | null;
}

const SCROLL_EPSILON_PX = 1;

export function resolveCircularInitialScrollTop(input: CircularInitialScrollInput): number | null {
  const {
    circular,
    isZoomCommit = false,
    realRowsStartY,
    currentScrollTop,
    lastAppliedRealRowsStartY,
  } = input;

  if (!circular || isZoomCommit || !realRowsStartY) return null;

  if (lastAppliedRealRowsStartY === null) return realRowsStartY;

  if (Math.abs(currentScrollTop - lastAppliedRealRowsStartY) > SCROLL_EPSILON_PX) {
    return null;
  }

  if (Math.abs(lastAppliedRealRowsStartY - realRowsStartY) <= SCROLL_EPSILON_PX) {
    return null;
  }

  return realRowsStartY;
}
