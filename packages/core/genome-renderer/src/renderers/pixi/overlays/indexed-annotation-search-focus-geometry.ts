import type { RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { ARROW_HEIGHT_RATIO, ARROW_MAX_WIDTH } from '../shared/theme';
import { RETAINED_SUBPIXEL_MIN_WIDTH_PX } from '../overview/retained-subpixel-aa';

export type DirectionalSearchFocusBlock = {
  startBp: number;
  endBp: number;
  offsetCenter: number;
  halfH: number;
  dirSign: number;
};

export function flatAnnotationSearchFocusBlockGeometry(
  path: PathMapper,
  state: RenderState,
  block: DirectionalSearchFocusBlock
): { points: number[]; actualWidthPx: number } | null {
  let xMin = path.bpLeftX(block.startBp);
  let xMax = path.bpLeftX(block.endBp);
  if (xMax < xMin) {
    const swap = xMin;
    xMin = xMax;
    xMax = swap;
  }
  const actualWidthPx = Math.max(0, xMax - xMin);
  if (actualWidthPx < RETAINED_SUBPIXEL_MIN_WIDTH_PX) {
    const midpoint = (xMin + xMax) / 2;
    xMin = midpoint - RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2;
    xMax = midpoint + RETAINED_SUBPIXEL_MIN_WIDTH_PX / 2;
  }
  if (xMax < 0 || xMin > state.width) return null;

  const centerY = path.fwdStrandTop + block.offsetCenter;
  let arrowWidth = 0;
  if (block.dirSign !== 0) {
    const candidate = Math.min(
      2 * block.halfH * ARROW_HEIGHT_RATIO,
      actualWidthPx * 0.3,
      ARROW_MAX_WIDTH
    );
    if (actualWidthPx > candidate * 2) arrowWidth = candidate;
  }
  const points =
    block.dirSign < 0
      ? [
          xMin + arrowWidth,
          centerY - block.halfH,
          xMax,
          centerY - block.halfH,
          xMax,
          centerY + block.halfH,
          xMin + arrowWidth,
          centerY + block.halfH,
          xMin,
          centerY,
        ]
      : [
          xMin,
          centerY - block.halfH,
          xMax - arrowWidth,
          centerY - block.halfH,
          xMax,
          centerY,
          xMax - arrowWidth,
          centerY + block.halfH,
          xMin,
          centerY + block.halfH,
        ];
  return { points, actualWidthPx };
}
