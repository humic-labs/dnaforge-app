import earcut from 'earcut';

export type Point = [number, number];
export type Transform = [number, number, number, number, number, number];
export type RGBA = [number, number, number, number];

const NAMED_COLORS: Record<string, string> = {
  transparent: '#00000000',
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  blue: '#0000ff',
  green: '#008000',
  yellow: '#ffff00',
  orange: '#ffa500',
  gray: '#808080',
  grey: '#808080',
  purple: '#800080',
  cyan: '#00ffff',
};

export function parseWebGLColor(value: string): RGBA {
  const text = value.trim().toLowerCase();
  if (NAMED_COLORS[text]) return parseWebGLColor(NAMED_COLORS[text]);
  if (text.startsWith('#')) {
    const short = text.slice(1);
    const hex = short.length <= 4 ? [...short].map((c) => c + c).join('') : short;
    if ((hex.length === 6 || hex.length === 8) && /^[\da-f]+$/.test(hex)) {
      return [
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255,
        hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      ];
    }
  }
  const match = /^(rgba?|hsla?)\((.*)\)$/.exec(text);
  if (match) {
    const components = match[2].trim().split(/[\s,/]+/);
    const alpha =
      components[3] === undefined
        ? 1
        : parseFloat(components[3]) / (components[3].endsWith('%') ? 100 : 1);
    if (match[1].startsWith('rgb')) {
      const rgb = components.slice(0, 3).map((c) => parseFloat(c) / (c.endsWith('%') ? 100 : 255));
      return [rgb[0], rgb[1], rgb[2], alpha];
    }
    const hue = (((parseFloat(components[0]) % 360) + 360) % 360) / 60;
    const saturation = parseFloat(components[1]) / 100;
    const lightness = parseFloat(components[2]) / 100;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const second = chroma * (1 - Math.abs((hue % 2) - 1));
    const offset = lightness - chroma / 2;
    const rgb =
      hue < 1
        ? [chroma, second, 0]
        : hue < 2
          ? [second, chroma, 0]
          : hue < 3
            ? [0, chroma, second]
            : hue < 4
              ? [0, second, chroma]
              : hue < 5
                ? [second, 0, chroma]
                : [chroma, 0, second];
    return [rgb[0] + offset, rgb[1] + offset, rgb[2] + offset, alpha];
  }
  throw new Error(`Unsupported sequence drawing color: ${value}`);
}

export function transformPoint(m: Transform, x: number, y: number): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function multiplyTransforms(a: Transform, b: Transform): Transform {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

const FORWARD_CODON_TRIANGLES = Object.freeze([5, 0, 1, 5, 1, 2, 5, 2, 3, 5, 3, 4]);
const REVERSE_CODON_TRIANGLES = Object.freeze([2, 3, 4, 2, 4, 5, 2, 5, 0, 2, 0, 1]);
const FORWARD_QUAD_TRIANGLES = Object.freeze([2, 3, 0, 0, 1, 2]);
const REVERSE_QUAD_TRIANGLES = Object.freeze([1, 0, 3, 3, 2, 1]);
const ANNOTATION_ARROW_TRIANGLES = Object.freeze([3, 4, 0, 0, 1, 2, 2, 3, 0]);

export function triangulatePath(points: readonly Point[], solidChevron = false): readonly number[] {
  if (points.length === 5) {
    const [a, b, c, d, e] = points;
    let finite = true;
    for (const point of points) {
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        finite = false;
        break;
      }
    }
    if (
      finite &&
      ((a[1] === b[1] &&
        d[1] === e[1] &&
        a[0] === e[0] &&
        b[0] === d[0] &&
        a[0] < b[0] &&
        b[0] < c[0] &&
        a[1] < c[1] &&
        c[1] < d[1]) ||
        (a[1] === b[1] &&
          c[1] === d[1] &&
          a[0] === d[0] &&
          b[0] === c[0] &&
          e[0] < a[0] &&
          a[0] < b[0] &&
          a[1] < e[1] &&
          e[1] < d[1]))
    ) {
      return ANNOTATION_ARROW_TRIANGLES;
    }
  }
  if (points.length === 4) {
    let winding = 0;
    for (let i = 0; i < 4; i++) {
      const a = points[i],
        b = points[(i + 1) % 4],
        c = points[(i + 2) % 4];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);

      if (!Number.isFinite(cross) || cross === 0 || (winding && cross > 0 !== winding > 0)) {
        winding = 0;
        break;
      }
      winding = cross;
    }
    if (winding) return winding > 0 ? FORWARD_QUAD_TRIANGLES : REVERSE_QUAD_TRIANGLES;
  }
  if (solidChevron && points.length === 6) {
    const [a, b, c, d, e, f] = points;
    const rightDepth = c[0] - b[0],
      leftDepth = f[0] - a[0];
    if (
      a[1] === b[1] &&
      d[1] === e[1] &&
      c[1] === f[1] &&
      a[0] === e[0] &&
      b[0] === d[0] &&
      b[0] > a[0] &&
      e[1] > a[1] &&
      Math.abs(c[1] - (a[1] + e[1]) / 2) < 1e-8 &&
      Math.abs(rightDepth - leftDepth) < 1e-8 &&
      Math.abs(rightDepth) > 1e-8
    ) {
      return rightDepth > 0 ? FORWARD_CODON_TRIANGLES : REVERSE_CODON_TRIANGLES;
    }
  }
  const coordinates: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    coordinates.push(point[0], point[1]);
  }
  return earcut(coordinates, undefined, 2);
}

function shortMiterStroke(points: Point[], half: number, cap: CanvasLineCap): Point[] | null {
  if (points.length < 2 || points.length > 3 || cap === 'round') return null;
  const directions: Point[] = [];
  const lengths: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1][0] - points[i][0];
    const dy = points[i + 1][1] - points[i][1];
    const length = Math.hypot(dx, dy);
    lengths.push(length);
    directions.push([dx / length, dy / length]);
  }
  let middle: Point | undefined;
  if (points.length === 3) {
    const [a, b] = directions;
    const denominator = 1 + a[0] * b[0] + a[1] * b[1];
    if (denominator < 1e-6) return null;
    middle = [(-(a[1] + b[1]) * half) / denominator, ((a[0] + b[0]) * half) / denominator];
    const extension = (half * Math.abs(a[0] * b[1] - a[1] * b[0])) / denominator;
    if (Math.hypot(...middle) > half * 10 || lengths.some((length) => length <= extension))
      return null;
  }
  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const direction = directions[i === 0 ? 0 : directions.length - 1];
    const offset = i === 1 && middle ? middle : [-direction[1] * half, direction[0] * half];
    const extension =
      cap === 'square' && (i === 0 || i === points.length - 1) ? half * (i === 0 ? -1 : 1) : 0;
    const x = p[0] + direction[0] * extension;
    const y = p[1] + direction[1] * extension;
    left.push([x + offset[0], y + offset[1]]);
    right.push([x - offset[0], y - offset[1]]);
  }
  const triangles: Point[] = [];
  for (let i = 0; i < points.length - 1; i++)
    triangles.push(left[i], right[i], right[i + 1], left[i], right[i + 1], left[i + 1]);
  return triangles;
}

export function strokePathTriangles(
  source: readonly Point[],
  width: number,
  closed = false,
  cap: CanvasLineCap = 'butt',
  join: CanvasLineJoin = 'miter'
): Point[] {
  const points = source.filter(
    (p, i) => i === 0 || Math.hypot(p[0] - source[i - 1][0], p[1] - source[i - 1][1]) > 1e-8
  );
  if (
    closed &&
    points.length > 1 &&
    Math.hypot(
      points[0][0] - points[points.length - 1][0],
      points[0][1] - points[points.length - 1][1]
    ) < 1e-8
  )
    points.pop();
  if (points.length < 2 || width <= 0) return [];
  const half = width / 2;
  if (!closed && join === 'miter') {
    const ribbon = shortMiterStroke(points, half, cap);
    if (ribbon) return ribbon;
  }
  const directions = points.slice(0, closed ? points.length : -1).map((p, i): Point => {
    const q = points[(i + 1) % points.length];
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    return [(q[0] - p[0]) / length, (q[1] - p[1]) / length];
  });
  const arc = (p: Point, start: number, sweep: number): Point[] => {
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) * Math.sqrt(Math.max(1, half) * 2)));
    return Array.from({ length: steps + 1 }, (_, i): Point => {
      const a = start + (sweep * i) / steps;
      return [p[0] + Math.cos(a) * half, p[1] + Math.sin(a) * half];
    });
  };
  const boundary = (side: number): Point[] =>
    points.flatMap((p, i): Point[] => {
      if (!closed && (i === 0 || i === points.length - 1)) {
        const d = directions[i === 0 ? 0 : directions.length - 1];
        const extension = cap === 'square' ? half * (i === 0 ? -1 : 1) : 0;
        return [
          [
            p[0] - d[1] * side * half + d[0] * extension,
            p[1] + d[0] * side * half + d[1] * extension,
          ],
        ];
      }
      const a = directions[(i - 1 + directions.length) % directions.length],
        b = directions[i];
      const cross = a[0] * b[1] - a[1] * b[0];
      const dot = a[0] * b[0] + a[1] * b[1];
      const previous: Point = [p[0] - a[1] * side * half, p[1] + a[0] * side * half];
      const next: Point = [p[0] - b[1] * side * half, p[1] + b[0] * side * half];
      if (dot < -0.999999) return [previous, next];
      const miter: Point = [
        p[0] - ((a[1] + b[1]) * side * half) / (1 + dot),
        p[1] + ((a[0] + b[0]) * side * half) / (1 + dot),
      ];
      const outer = cross * side < 0;
      if (!outer || (join === 'miter' && Math.hypot(miter[0] - p[0], miter[1] - p[1]) <= half * 10))
        return [miter];
      if (join !== 'round') return [previous, next];
      const start = Math.atan2(previous[1] - p[1], previous[0] - p[0]);
      const end = Math.atan2(next[1] - p[1], next[0] - p[0]);
      let sweep = end - start;
      if (cross > 0 && sweep < 0) sweep += Math.PI * 2;
      if (cross < 0 && sweep > 0) sweep -= Math.PI * 2;
      return arc(p, start, sweep);
    });
  const left = boundary(1),
    right = boundary(-1);
  let vertices: Point[];
  let holes: number[] | undefined;
  if (closed) {
    const area = (path: Point[]): number =>
      Math.abs(
        path.reduce((sum, p, i) => {
          const q = path[(i + 1) % path.length];
          return sum + p[0] * q[1] - q[0] * p[1];
        }, 0)
      );
    const [outer, inner] = area(left) > area(right) ? [left, right] : [right, left];
    vertices = [...outer, ...inner];
    holes = [outer.length];
  } else {
    const end = points[points.length - 1],
      endDirection = directions[directions.length - 1];
    const start = points[0],
      startDirection = directions[0];
    const endCap =
      cap === 'round' ? arc(end, Math.atan2(endDirection[0], -endDirection[1]), -Math.PI) : [];
    const startCap =
      cap === 'round'
        ? arc(start, Math.atan2(-startDirection[0], startDirection[1]), -Math.PI)
        : [];
    vertices = [...left, ...endCap, ...right.reverse(), ...startCap];
  }
  return earcut(vertices.flat(), holes, 2).map((index) => vertices[index]);
}

export class WebGLLinearGradient implements CanvasGradient {
  readonly stops: Array<{ offset: number; color: RGBA }> = [];
  constructor(
    readonly start: Point,
    readonly end: Point
  ) {}
  addColorStop(offset: number, color: string): void {
    if (offset < 0 || offset > 1)
      throw new RangeError('Gradient offset must be between zero and one');
    this.stops.push({ offset, color: parseWebGLColor(color) });
    this.stops.sort((a, b) => a.offset - b.offset);
  }
  colorAt(x: number, y: number): RGBA {
    if (this.stops.length === 0) return [0, 0, 0, 0];
    const dx = this.end[0] - this.start[0],
      dy = this.end[1] - this.start[1];
    const progress =
      ((x - this.start[0]) * dx + (y - this.start[1]) * dy) / (dx * dx + dy * dy || 1);
    const right = this.stops.findIndex((stop) => stop.offset >= progress);
    if (right === 0) return this.stops[0].color;
    if (right < 0) return this.stops[this.stops.length - 1].color;
    const a = this.stops[right - 1],
      b = this.stops[right];
    const t = (progress - a.offset) / (b.offset - a.offset || 1);
    return a.color.map((v, i) => v + (b.color[i] - v) * t) as RGBA;
  }
}
