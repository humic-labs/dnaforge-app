export interface WrapScreenAnchor {
  unwrappedBp: number;
  viewportX: number;
  viewportY: number;
  backgroundParity: number;
  capacityBias: number;
  holdsLinearOrigin?: boolean;
}

export function linearWrapTopBp(
  anchorBp: number,
  column: number,
  charsPerRow: number,
  pinOrigin: boolean
): number {
  if (pinOrigin && anchorBp < column) return 0;
  const padding = (((column - anchorBp) % charsPerRow) + charsPerRow) % charsPerRow;
  return padding === 0 ? 0 : -padding;
}

export function wrapPrediction(width: number, margin: number, charWidth: number, reserveBy = 1) {
  const capacity = Math.max(10, (width - margin) / Math.max(0.001, charWidth));
  const current = Math.floor(capacity);
  const fraction = capacity - current;
  const reserve = Math.min(1, fraction / reserveBy);
  return { current, next: current + 1, progress: reserve * reserve * (3 - 2 * reserve) };
}

export function continuousWrapRowOffset(
  actualStart: number,
  rowIndex: number,
  anchorRowIndex: number,
  anchorBp: number,
  anchorX: number,
  marginLeft: number,
  charWidth: number,
  capacity: number
): number {
  return (
    (actualStart - anchorBp - (rowIndex - anchorRowIndex) * capacity) * charWidth +
    anchorX -
    marginLeft
  );
}

export interface WrapRowXPosition {
  start: number;
  length: number;
  offset: number;
  charWidth: number;
  marginLeft: number;
  circularLength: number;
}

export function sameWrapRowContent(previous: WrapRowXPosition, target: WrapRowXPosition): boolean {
  if (previous.length !== target.length) return false;
  const cycle = previous.circularLength;
  if (cycle > 0 && cycle === target.circularLength)
    return (previous.start - target.start) % cycle === 0;
  return previous.start === target.start;
}

export function sharedWrapRowXs(
  previous: WrapRowXPosition,
  target: WrapRowXPosition
): { previousX: number; targetX: number } | null {
  if (previous.length <= 0 || target.length <= 0) return null;
  const cycle = previous.circularLength > 0 ? previous.circularLength : 0;
  const targetStart =
    cycle > 0
      ? target.start + Math.round((previous.start - target.start) / cycle) * cycle
      : target.start;
  const sharedStart = Math.max(previous.start, targetStart);
  const sharedEnd = Math.min(previous.start + previous.length, targetStart + target.length);
  if (sharedEnd <= sharedStart) return null;
  const bp = (sharedStart + sharedEnd) / 2;
  return {
    previousX: previous.marginLeft + previous.offset + (bp - previous.start) * previous.charWidth,
    targetX: target.marginLeft + target.offset + (bp - targetStart) * target.charWidth,
  };
}

export function paintedWrapRowXOffset(
  fromOffset: number,
  targetOffset: number,
  startedAt: number,
  now: number,
  durationMs: number
): number {
  const progress = Math.max(0, Math.min(1, (now - startedAt) / Math.max(1, durationMs)));
  return fromOffset + (targetOffset - fromOffset) * progress;
}

export function morphRowHeights(current: Float64Array, next: Float64Array, progress: number) {
  const t = Math.max(0, Math.min(1, progress));
  return Float64Array.from(current, (height, i) => height + ((next[i] ?? height) - height) * t);
}

export function reserveTrackBands(
  current: readonly number[],
  future: readonly number[],
  progress: number
): number[] {
  const t = Math.max(0, Math.min(1, progress));
  const painted = [0];
  for (let i = 0; i < current.length - 1; i++) {
    const currentHeight = current[i + 1] - current[i];
    const futureHeight = future[i + 1] - future[i];
    painted.push(painted[i] + currentHeight + Math.max(0, futureHeight - currentHeight) * t);
  }
  return painted;
}

export interface RowMorphBands {
  natural: readonly number[];
  painted: readonly number[];
}

const TRACK_EDGE_TOLERANCE_PX = 0.000001;

export function trackBandAt(boundaries: readonly number[], coordinate: number): number {
  let band = 0;
  while (
    band < boundaries.length - 2 &&
    coordinate >= boundaries[band + 1] - TRACK_EDGE_TOLERANCE_PX
  )
    band++;
  return band;
}

interface MorphRow {
  y: number;
  xOffset?: number;
  heightScale?: number;
  trackMorph?: RowMorphBands;
}

export function morphBandY(
  source: readonly number[],
  target: readonly number[],
  y: number
): number {
  if (y <= source[0]) return target[0] + y - source[0];
  const last = source.length - 1;
  if (y >= source[last]) return target[last] + y - source[last];
  const band = trackBandAt(source, y);
  const span = source[band + 1] - source[band];
  const scale = span > 0 ? (target[band + 1] - target[band]) / span : 1;
  return target[band] + (y - source[band]) * scale;
}
export function rowPaintY(row: MorphRow, naturalY: number): number {
  if (row.trackMorph) {
    const { natural, painted } = row.trackMorph;
    const localY = naturalY - row.y;
    const band = trackBandAt(natural, localY);
    return naturalY + painted[band] - natural[band];
  }
  return row.y + (naturalY - row.y) * (row.heightScale ?? 1);
}
export function rowHitY(row: MorphRow, paintedY: number): number {
  if (row.trackMorph) {
    const { natural, painted } = row.trackMorph;
    const localY = paintedY - row.y;
    const band = trackBandAt(painted, localY);
    const offset = localY - painted[band];
    if (offset >= natural[band + 1] - natural[band] && localY < painted[band + 1])
      return Number.POSITIVE_INFINITY;
    return paintedY + natural[band] - painted[band];
  }
  return row.y + (paintedY - row.y) / (row.heightScale ?? 1);
}

export function morphSpanAffine(
  bands: RowMorphBands,
  minY: number,
  maxY: number,
  tolerance = TRACK_EDGE_TOLERANCE_PX
): { start: number; end: number; target: number; targetEnd: number; scale: number } | null {
  const center = (minY + maxY) / 2;
  const band = trackBandAt(bands.natural, center);
  const start = bands.natural[band],
    end = bands.natural[band + 1];
  if (end <= start || minY < start - tolerance || maxY > end + tolerance) return null;
  return {
    start,
    end,
    target: bands.painted[band],
    targetEnd: bands.painted[band + 1],
    scale: (bands.painted[band + 1] - bands.painted[band]) / (end - start),
  };
}

export function rowPaintBounds(
  row: MorphRow,
  y: number,
  height: number,
  tolerance = TRACK_EDGE_TOLERANCE_PX
): { y: number; height: number } {
  const affine =
    row.trackMorph && morphSpanAffine(row.trackMorph, y - row.y, y + height - row.y, tolerance);
  if (affine) {
    const top = y + affine.target - affine.start;
    if (affine.scale >= 1) return { y: top, height };
    const clippedTop = Math.max(top, row.y + affine.target - 2);
    const clippedBottom = Math.min(top + height, row.y + affine.targetEnd);
    return { y: clippedTop, height: Math.max(0, clippedBottom - clippedTop) };
  }
  if (row.trackMorph) {
    const { natural, painted } = row.trackMorph;
    const top = row.y + morphBandY(natural, painted, y - row.y);
    return { y: top, height: row.y + morphBandY(natural, painted, y + height - row.y) - top };
  }
  return { y: rowPaintY(row, y), height: rowPaintY(row, y + height) - rowPaintY(row, y) };
}

export function withRowMorph(
  ctx: Pick<CanvasRenderingContext2D, 'save' | 'restore' | 'translate' | 'scale'> & {
    setRowMorphBands?: (bands: RowMorphBands, origin: number) => void;
  },
  row: MorphRow,
  scrollTop: number,
  paint: () => void
): void {
  if (row.xOffset) {
    ctx.save();
    ctx.translate(row.xOffset, 0);
    try {
      withRowMorph(ctx, { ...row, xOffset: 0 }, scrollTop, paint);
    } finally {
      ctx.restore();
    }
    return;
  }
  if (row.trackMorph && ctx.setRowMorphBands) {
    ctx.save();
    ctx.setRowMorphBands(row.trackMorph, row.y - scrollTop);
    try {
      paint();
    } finally {
      ctx.restore();
    }
    return;
  }
  if (!row.heightScale || row.heightScale === 1) {
    paint();
    return;
  }
  const origin = row.y - scrollTop;
  ctx.save();
  ctx.translate(0, origin);
  ctx.scale(1, row.heightScale);
  ctx.translate(0, -origin);
  try {
    paint();
  } finally {
    ctx.restore();
  }
}
