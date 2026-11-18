import type { DataColorScale } from '@waypoint/platform';

export interface ContactReference {
  readonly id: string;
  readonly chrom: string;
  readonly length: number;
  readonly label?: string;
}

export interface ContactCell {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly targetStart: number;
  readonly targetEnd: number;
  readonly value: number;
}

export interface ContactProjection {
  readonly kind: 'contact-matrix';
  readonly id: string;
  readonly xReference: ContactReference;
  readonly yReference: ContactReference;
  readonly cells: readonly ContactCell[];
  readonly colorScale: DataColorScale;
}

export interface ContactCamera {
  readonly projectionId: string;
  readonly xStart: number;
  readonly xEnd: number;
  readonly yStart: number;
  readonly yEnd: number;
}

export interface ContactInterval {
  readonly referenceId: string;
  readonly chrom: string;
  readonly start: number;
  readonly end: number;
}

export interface ContactHit {
  readonly projectionId: string;
  readonly cellId: string;
  readonly x: ContactInterval;
  readonly y: ContactInterval;
  readonly value: number;
}

export interface ContactPlotRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function assertContactProjection(projection: ContactProjection): void {
  const validText = (value: string) => typeof value === 'string' && value.trim().length > 0;
  if (projection.kind !== 'contact-matrix' || !validText(projection.id)) {
    throw new Error('A contact projection requires an identity.');
  }
  for (const reference of [projection.xReference, projection.yReference]) {
    if (
      !validText(reference.id) ||
      !validText(reference.chrom) ||
      !Number.isSafeInteger(reference.length) ||
      reference.length <= 0
    ) {
      throw new Error('A contact axis requires an exact reference and positive chromosome length.');
    }
  }
  const ids = new Set<string>();
  for (const cell of projection.cells) {
    if (!validText(cell.id) || ids.has(cell.id)) {
      throw new Error('Contact cells require unique identities.');
    }
    ids.add(cell.id);
    if (
      !Number.isSafeInteger(cell.start) ||
      !Number.isSafeInteger(cell.end) ||
      !Number.isSafeInteger(cell.targetStart) ||
      !Number.isSafeInteger(cell.targetEnd) ||
      cell.start < 0 ||
      cell.end <= cell.start ||
      cell.end > projection.xReference.length ||
      cell.targetStart < 0 ||
      cell.targetEnd <= cell.targetStart ||
      cell.targetEnd > projection.yReference.length
    ) {
      throw new Error('A contact cell interval is outside its axis reference.');
    }
    if (!Number.isFinite(cell.value) || cell.value < 0) {
      throw new Error('Contact counts must be finite and nonnegative.');
    }
  }
}

export function contactPlotRect(width: number, height: number): ContactPlotRect {
  const finiteWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const finiteHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  return {
    x: Math.min(72, finiteWidth),
    y: Math.min(32, finiteHeight),
    width: Math.max(0, finiteWidth - 92),
    height: Math.max(0, finiteHeight - 84),
  };
}

function clampAxis(start: number | undefined, end: number | undefined, length: number) {
  if (
    start === undefined ||
    end === undefined ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start
  ) {
    return { start: 0, end: length };
  }
  const span = Math.min(length, Math.max(1, end - start));
  const boundedStart = Math.max(0, Math.min(length - span, start));
  return { start: boundedStart, end: boundedStart + span };
}

export function resolveContactCamera(
  projection: ContactProjection,
  camera?: ContactCamera | null
): ContactCamera {
  const current = camera?.projectionId === projection.id ? camera : undefined;
  const x = clampAxis(current?.xStart, current?.xEnd, projection.xReference.length);
  const y = clampAxis(current?.yStart, current?.yEnd, projection.yReference.length);
  return {
    projectionId: projection.id,
    xStart: x.start,
    xEnd: x.end,
    yStart: y.start,
    yEnd: y.end,
  };
}

export function panContactCamera(
  projection: ContactProjection,
  camera: ContactCamera | null | undefined,
  deltaXpx: number,
  deltaYpx: number,
  rect: ContactPlotRect
): ContactCamera {
  const current = resolveContactCamera(projection, camera);
  if (rect.width <= 0 || rect.height <= 0) return current;
  const dx = Number.isFinite(deltaXpx)
    ? (deltaXpx / rect.width) * (current.xEnd - current.xStart)
    : 0;
  const dy = Number.isFinite(deltaYpx)
    ? (deltaYpx / rect.height) * (current.yEnd - current.yStart)
    : 0;
  return resolveContactCamera(projection, {
    projectionId: projection.id,
    xStart: current.xStart + dx,
    xEnd: current.xEnd + dx,
    yStart: current.yStart + dy,
    yEnd: current.yEnd + dy,
  });
}

export function zoomContactCamera(
  projection: ContactProjection,
  camera: ContactCamera | null | undefined,
  factor: number,
  anchorXpx: number,
  anchorYpx: number,
  rect: ContactPlotRect
): ContactCamera {
  const current = resolveContactCamera(projection, camera);
  if (!Number.isFinite(factor) || factor <= 0 || rect.width <= 0 || rect.height <= 0) {
    return current;
  }
  const fraction = (anchor: number, origin: number, size: number) =>
    Number.isFinite(anchor) ? Math.max(0, Math.min(1, (anchor - origin) / size)) : 0.5;
  const fx = fraction(anchorXpx, rect.x, rect.width);
  const fy = fraction(anchorYpx, rect.y, rect.height);
  const xSpan = current.xEnd - current.xStart;
  const ySpan = current.yEnd - current.yStart;
  const nextXSpan = Math.max(1, Math.min(projection.xReference.length, xSpan / factor));
  const nextYSpan = Math.max(1, Math.min(projection.yReference.length, ySpan / factor));
  const nextXStart = current.xStart + fx * (xSpan - nextXSpan);
  const nextYStart = current.yStart + fy * (ySpan - nextYSpan);
  return resolveContactCamera(projection, {
    projectionId: projection.id,
    xStart: nextXStart,
    xEnd: nextXStart + nextXSpan,
    yStart: nextYStart,
    yEnd: nextYStart + nextYSpan,
  });
}

export function contactPointToLoci(
  projection: ContactProjection,
  camera: ContactCamera | null | undefined,
  rect: ContactPlotRect,
  x: number,
  y: number
): { readonly x: number; readonly y: number } | null {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    x < rect.x ||
    x >= rect.x + rect.width ||
    y < rect.y ||
    y >= rect.y + rect.height
  ) {
    return null;
  }
  const current = resolveContactCamera(projection, camera);
  return {
    x: current.xStart + ((x - rect.x) / rect.width) * (current.xEnd - current.xStart),
    y: current.yStart + ((y - rect.y) / rect.height) * (current.yEnd - current.yStart),
  };
}

export function hitTestContactCell(
  projection: ContactProjection,
  camera: ContactCamera | null | undefined,
  rect: ContactPlotRect,
  x: number,
  y: number
): ContactHit | null {
  const loci = contactPointToLoci(projection, camera, rect, x, y);
  if (!loci) return null;
  const cell = projection.cells.find(
    (candidate) =>
      loci.x >= candidate.start &&
      loci.x < candidate.end &&
      loci.y >= candidate.targetStart &&
      loci.y < candidate.targetEnd
  );
  return cell
    ? {
        projectionId: projection.id,
        cellId: cell.id,
        x: {
          referenceId: projection.xReference.id,
          chrom: projection.xReference.chrom,
          start: cell.start,
          end: cell.end,
        },
        y: {
          referenceId: projection.yReference.id,
          chrom: projection.yReference.chrom,
          start: cell.targetStart,
          end: cell.targetEnd,
        },
        value: cell.value,
      }
    : null;
}

export function contactCellRect(
  cell: ContactCell,
  camera: ContactCamera,
  rect: ContactPlotRect
): ContactPlotRect | null {
  const xSpan = camera.xEnd - camera.xStart;
  const ySpan = camera.yEnd - camera.yStart;
  const start = Math.max(cell.start, camera.xStart);
  const end = Math.min(cell.end, camera.xEnd);
  const targetStart = Math.max(cell.targetStart, camera.yStart);
  const targetEnd = Math.min(cell.targetEnd, camera.yEnd);
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    xSpan <= 0 ||
    ySpan <= 0 ||
    end <= start ||
    targetEnd <= targetStart
  ) {
    return null;
  }
  return {
    x: rect.x + ((start - camera.xStart) / xSpan) * rect.width,
    y: rect.y + ((targetStart - camera.yStart) / ySpan) * rect.height,
    width: ((end - start) / xSpan) * rect.width,
    height: ((targetEnd - targetStart) / ySpan) * rect.height,
  };
}
