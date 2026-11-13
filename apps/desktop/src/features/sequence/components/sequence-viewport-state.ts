import { MIN_ZOOM, MAX_ZOOM } from '@waypoint/workspace-editor/zoom-math';
import type { ViewportRange } from '@waypoint/workspace-editor';
import type { TabViewState } from '../../canvas/public/types';

const MAP_ONLY_RANGE_PADDING_FACTOR = 1.25;

export function normalizeSequenceViewportCenterBp(
  value: unknown,
  sequenceLength: number
): number | null {
  if (!Number.isFinite(sequenceLength) || sequenceLength <= 0) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(1, Math.min(sequenceLength, Math.round(value)));
}

export function normalizeSequenceViewportZoomLevel(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

export function viewportCenterBpFromRange(
  range: ViewportRange,
  sequenceLength: number,
  colToBio: (col: number) => number = (col) => col + 1
): number | null {
  if (!Number.isFinite(sequenceLength) || sequenceLength <= 0) return null;
  let midCol: number;
  if (range.wraps) {
    const lenInBases = sequenceLength - range.start + range.end;
    const offset = Math.floor(lenInBases / 2);
    midCol = (range.start + offset) % sequenceLength;
  } else {
    midCol = Math.floor((range.start + range.end) / 2);
  }
  return normalizeSequenceViewportCenterBp(colToBio(midCol), sequenceLength);
}

export function resolveMapOnlyNucleotideZoom(input: {
  mapVisible: boolean;
  sequenceVisible: boolean;
  zoomBounds: { min: number; max: number } | null;
}): number | null {
  if (!input.mapVisible || input.sequenceVisible) return null;
  const max = input.zoomBounds?.max;
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return null;
  return max;
}

export function resolveMapOnlyRangeFitZoom(input: {
  mapVisible: boolean;
  sequenceVisible: boolean;
  sequenceLength: number;
  range: { start: number; end: number; wraps?: boolean } | null;
  zoomBounds: { min: number; max: number } | null;
}): number | null {
  if (!input.mapVisible || input.sequenceVisible || input.range == null) return null;
  if (!Number.isFinite(input.sequenceLength) || input.sequenceLength <= 0) return null;

  const min = input.zoomBounds?.min;
  const max = input.zoomBounds?.max;
  if (
    typeof min !== 'number' ||
    !Number.isFinite(min) ||
    min <= 0 ||
    typeof max !== 'number' ||
    !Number.isFinite(max) ||
    max < min
  ) {
    return null;
  }

  const sequenceLength = Math.floor(input.sequenceLength);
  const start = Math.max(0, Math.min(sequenceLength - 1, Math.floor(input.range.start)));
  const end = Math.max(0, Math.min(sequenceLength - 1, Math.floor(input.range.end)));
  const wraps = input.range.wraps === true || end < start;
  const rangeLength = wraps ? sequenceLength - start + end + 1 : end - start + 1;
  const paddedRangeLength = Math.min(
    sequenceLength,
    Math.max(1, rangeLength * MAP_ONLY_RANGE_PADDING_FACTOR)
  );
  const fitZoom = sequenceLength / paddedRangeLength;

  return Math.max(min, Math.min(max, fitZoom));
}

export function navigationCenterBpFromRangeOrPosition(
  input: {
    position?: number | null;
    range?: { start: number; end: number; wraps?: boolean } | null;
  },
  sequenceLength: number
): number | null {
  if (input.range) {
    return viewportCenterBpFromRange(input.range, sequenceLength);
  }
  return normalizeSequenceViewportCenterBp(input.position, sequenceLength);
}

export function buildSequenceViewportPatch(
  input: {
    centerBp?: number | null;
    zoomLevel?: number | null;
  },
  sequenceLength: number
): Pick<TabViewState, 'sequenceViewportCenterBp' | 'sequenceViewportZoomLevel'> {
  return {
    sequenceViewportCenterBp: normalizeSequenceViewportCenterBp(input.centerBp, sequenceLength),
    sequenceViewportZoomLevel: normalizeSequenceViewportZoomLevel(input.zoomLevel),
  };
}
