import type { OutlinePoint } from './shape-outline';

export function crossfadeUnderlayAlpha(progress: number, overlayAlpha: number): number {
  const p = Math.max(0, Math.min(1, progress));
  const covered = p * Math.max(0, Math.min(1, overlayAlpha));
  return covered >= 1 ? 0 : (1 - p) / (1 - covered);
}

export function retainedTopEdge(contour: OutlinePoint[], height: number): OutlinePoint[] {
  let top = Infinity;
  for (const point of contour) top = Math.min(top, point.y);
  let left: OutlinePoint | undefined;
  let right: OutlinePoint | undefined;
  for (const point of contour) {
    if (!(Math.abs(point.y - top) < 1e-7)) continue;

    if (!left || !(left.x < point.x)) left = point;
    if (!right || !(right.x > point.x)) right = point;
  }
  if (!left || !right) throw new TypeError('CDS band has no upper edge');
  const extend = (join: OutlinePoint) => {
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i],
        b = contour[(i + 1) % contour.length];
      const below = a === join ? b : b === join ? a : undefined;
      if (below && below.y > top + 1e-7)
        return join.x - (height * (below.x - join.x)) / (below.y - top);
    }
    return join.x;
  };
  const leftX = extend(left),
    rightX = extend(right);
  if (leftX > rightX) {
    const fraction = (right.x - left.x) / (leftX - left.x + right.x - rightX);
    return [{ x: left.x + (leftX - left.x) * fraction, y: top - height * fraction }, right, left];
  }
  return [{ x: leftX, y: top - height }, { x: rightX, y: top - height }, right, left];
}

export function morphBodyContour(
  from: OutlinePoint[],
  to: OutlinePoint[],
  progress: number
): OutlinePoint[] {
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  let top = Infinity;
  let bottom = -Infinity;
  for (const point of from) {
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  const height = bottom - top;
  const edgeAt = (contour: OutlinePoint[], y: number, side: 'left' | 'right') => {
    let left = Infinity;
    let right = -Infinity;
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i];
      const b = contour[(i + 1) % contour.length];
      if (y < Math.min(a.y, b.y) - 1e-7 || y > Math.max(a.y, b.y) + 1e-7) continue;
      if (Math.abs(a.y - b.y) < 1e-7) {
        left = Math.min(left, a.x, b.x);
        right = Math.max(right, a.x, b.x);
      } else {
        const x = a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    return side === 'left' ? left : right;
  };
  const at = (fraction: number, side: 'left' | 'right') => {
    const y = top + fraction * height;
    const x = edgeAt(from, y, side);
    return { x: x + (edgeAt(to, y, side) - x) * progress, y };
  };
  return [
    at(0, 'left'),
    at(0, 'right'),
    at(0.25, 'right'),
    at(0.5, 'right'),
    at(0.75, 'right'),
    at(1, 'right'),
    at(1, 'left'),
    at(0.75, 'left'),
    at(0.5, 'left'),
    at(0.25, 'left'),
  ];
}

type CodonEdge = 'flat' | 'chevron' | 'tip';

function codonEdgeShift(edge: CodonEdge, side: 'left' | 'right', direction: 1 | -1): number {
  if (edge === 'flat') return 0;
  return edge === 'tip' ? (side === 'left' ? -1 : 1) : direction;
}

export function buildChevronStripOuterPath(
  ctx: {
    beginPath(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    closePath(): void;
  },
  cells: ReadonlyArray<{
    codonX: number;
    visibleWidth: number;
    leftEdge: CodonEdge;
    rightEdge: CodonEdge;
    genomicStart?: number;
    genomicEnd?: number;
  }>,
  trackY: number,
  trackHeight: number,
  chevronDepth: number,
  direction: 1 | -1,
  shoulders?: { left: number; right: number }
): void {
  if (cells.length === 0) {
    ctx.beginPath();
    return;
  }
  const minima = [Infinity, Infinity, Infinity];
  const maxima = [-Infinity, -Infinity, -Infinity];
  let first = cells[0],
    last = cells[0];
  for (const cell of cells) {
    if (cell.codonX < first.codonX) first = cell;
    if (cell.codonX + cell.visibleWidth > last.codonX + last.visibleWidth) last = cell;
    const left = codonEdgeShift(cell.leftEdge, 'left', direction) + 1;
    const right = codonEdgeShift(cell.rightEdge, 'right', direction) + 1;
    minima[left] = Math.min(minima[left], cell.codonX);
    maxima[left] = Math.max(maxima[left], cell.codonX);
    minima[right] = Math.min(minima[right], cell.codonX + cell.visibleWidth);
    maxima[right] = Math.max(maxima[right], cell.codonX + cell.visibleWidth);
  }
  if (shoulders) {
    const left = codonEdgeShift(first.leftEdge, 'left', direction) + 1;
    const right = codonEdgeShift(last.rightEdge, 'right', direction) + 1;
    minima[left] = Math.min(minima[left], shoulders.left);
    maxima[right] = Math.max(maxima[right], shoulders.right);
  }
  const envelope = (shoulders: number[], minimum: boolean) => {
    const cuts = [0, 1];
    if (chevronDepth > 0)
      for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++) {
          const t = (shoulders[j] - shoulders[i]) / ((i - j) * chevronDepth);
          if (t > 0 && t < 1) cuts.push(t);
        }
    cuts.sort((a, b) => a - b);
    const points: { x: number; t: number }[] = [];
    for (const t of cuts) {
      const values = shoulders.map((x, i) => x + (i - 1) * chevronDepth * t);
      const x = minimum ? Math.min(...values) : Math.max(...values);
      if (points[points.length - 1]?.t === t) continue;
      while (points.length > 1) {
        const a = points[points.length - 2],
          b = points[points.length - 1];
        if (Math.abs((b.x - a.x) * (t - b.t) - (x - b.x) * (b.t - a.t)) > 1e-7) break;
        points.pop();
      }
      points.push({ x, t });
    }
    return points;
  };
  const left = envelope(minima, true),
    right = envelope(maxima, false);
  const half = trackHeight / 2;
  ctx.beginPath();
  ctx.moveTo(left[0].x, trackY);
  for (const p of right) ctx.lineTo(p.x, trackY + p.t * half);
  for (let i = right.length - 2; i >= 0; i--)
    ctx.lineTo(right[i].x, trackY + trackHeight - right[i].t * half);
  for (const p of left) ctx.lineTo(p.x, trackY + trackHeight - p.t * half);
  for (let i = left.length - 2; i > 0; i--) ctx.lineTo(left[i].x, trackY + left[i].t * half);
  ctx.closePath();
}
