import type { BackboneSegment, RenderState } from '../../../types';
import { webglAnnotationColorForMode } from './theme';

export interface BackboneSegmentRange {
  start: number;
  end: number;
  color: number;
  strokeWidth: number;
  alpha: number;
  regionId?: string;
  scaffold?: BackboneSegment['scaffold'];
  selected?: boolean;
}

function clampBp(value: number, genomeLength: number): number {
  return Math.max(0, Math.min(genomeLength, value));
}

export function normalizeBackboneSegmentRanges(
  segments: readonly BackboneSegment[] | undefined,
  genomeLength: number,
  state: RenderState
): BackboneSegmentRange[] {
  if (!segments?.length || genomeLength <= 0) return [];
  const ranges: BackboneSegmentRange[] = [];
  for (const segment of segments) {
    const start = clampBp(segment.start, genomeLength);
    const end = clampBp(segment.end, genomeLength);
    const color = segment.themeStableColor
      ? segment.color
      : webglAnnotationColorForMode(segment.color, state.themeMode);
    const strokeWidth = segment.strokeWidth ?? 4.5;
    const alpha = segment.alpha ?? 0.95;
    if (start === end) continue;
    if (end > start) {
      ranges.push({
        start,
        end,
        color,
        strokeWidth,
        alpha,
        ...(segment.regionId ? { regionId: segment.regionId } : {}),
        ...(segment.scaffold ? { scaffold: segment.scaffold } : {}),
        ...(segment.selected ? { selected: true } : {}),
      });
      continue;
    }
    ranges.push({
      start,
      end: genomeLength,
      color,
      strokeWidth,
      alpha,
      ...(segment.regionId ? { regionId: segment.regionId } : {}),
      ...(segment.scaffold ? { scaffold: segment.scaffold } : {}),
      ...(segment.selected ? { selected: true } : {}),
    });
    ranges.push({
      start: 0,
      end,
      color,
      strokeWidth,
      alpha,
      ...(segment.regionId ? { regionId: segment.regionId } : {}),
      ...(segment.scaffold ? { scaffold: segment.scaffold } : {}),
      ...(segment.selected ? { selected: true } : {}),
    });
  }
  return ranges;
}
