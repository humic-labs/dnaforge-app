export const MAP_PANE_BORDER_WIDTH = 1;
export const DEFAULT_SIDE_MAP_PANE_WIDTH = 520;
export const MIN_SIDE_MAP_PANE_WIDTH = 280;
export const MIN_SIDE_SEQUENCE_PANE_WIDTH = 320;
export const SIDE_MAP_RESIZE_HANDLE_WIDTH = 4;

export function usableSideSplitWidth(
  containerWidth: number | null,
  handleVisible: boolean
): number | null {
  if (containerWidth === null) return null;
  if (!Number.isFinite(containerWidth)) return null;
  const handle = handleVisible ? SIDE_MAP_RESIZE_HANDLE_WIDTH : 0;
  return Math.max(0, containerWidth - handle);
}

export function defaultSideMapPaneWidth(totalWidth: number | null): number {
  if (totalWidth === null || !Number.isFinite(totalWidth) || totalWidth <= 0) {
    return DEFAULT_SIDE_MAP_PANE_WIDTH;
  }
  return Math.round(totalWidth / 2);
}

export function clampSideMapPaneWidth(width: number, totalWidth: number | null): number {
  const finiteWidth = Number.isFinite(width) ? width : DEFAULT_SIDE_MAP_PANE_WIDTH;
  if (totalWidth === null || !Number.isFinite(totalWidth)) {
    return Math.max(MIN_SIDE_MAP_PANE_WIDTH, finiteWidth);
  }
  if (totalWidth <= 0) {
    return 0;
  }
  const preferredMax = Math.max(MIN_SIDE_MAP_PANE_WIDTH, totalWidth - MIN_SIDE_SEQUENCE_PANE_WIDTH);
  const preferred = Math.max(MIN_SIDE_MAP_PANE_WIDTH, Math.min(preferredMax, finiteWidth));
  return Math.min(totalWidth, preferred);
}
