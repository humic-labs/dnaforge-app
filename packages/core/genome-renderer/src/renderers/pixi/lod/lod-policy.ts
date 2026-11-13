export type TrackLod = 'detail' | 'aggregate';

export interface TrackLodOptions {
  pixelsPerBp: number;
  dataUnitBp: number;
  prev?: TrackLod;
  hysteresis?: number;
}

export function decideTrackLod({
  pixelsPerBp,
  dataUnitBp,
  prev,
  hysteresis = 0.25,
}: TrackLodOptions): TrackLod {
  const unitsPerPixel = pixelsPerBp * dataUnitBp;
  if (prev) {
    if (unitsPerPixel >= 1 + hysteresis) return 'detail';
    if (unitsPerPixel <= 1 - hysteresis) return 'aggregate';
    return prev;
  }
  return unitsPerPixel >= 1 ? 'detail' : 'aggregate';
}
