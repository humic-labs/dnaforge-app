import { DEFAULT_EDITOR_CONFIG } from '../types';
import type { LaneLodTier } from './types';

export const LANE_LOD_WIDE_MAX_PX_PER_COLUMN = 1;
export const LANE_LOD_CLOSE_MIN_PX_PER_COLUMN = Math.max(8, DEFAULT_EDITOR_CONFIG.charWidth);

export function getLaneLodTier(pxPerColumn: number): LaneLodTier {
  if (pxPerColumn < LANE_LOD_WIDE_MAX_PX_PER_COLUMN) return 'wide';
  if (pxPerColumn < LANE_LOD_CLOSE_MIN_PX_PER_COLUMN) return 'medium';
  return 'close';
}
