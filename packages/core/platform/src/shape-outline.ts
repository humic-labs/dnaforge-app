export interface OutlinePoint {
  x: number;
  y: number;
}

const EPSILON = 1e-7;
const cross = (a: OutlinePoint, b: OutlinePoint) => a.x * b.y - a.y * b.x;
const subtract = (a: OutlinePoint, b: OutlinePoint) => ({ x: a.x - b.x, y: a.y - b.y });
const samePoint = (a: OutlinePoint, b: OutlinePoint) =>
  Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
const signedArea = (points: readonly OutlinePoint[]) =>
  points.reduce((sum, p, i) => sum + cross(p, points[(i + 1) % points.length]), 0) / 2;

function onSegment(point: OutlinePoint, a: OutlinePoint, b: OutlinePoint): boolean {
  const edge = subtract(b, a);
  return (
    Math.abs(cross(edge, subtract(point, a))) <= EPSILON * Math.hypot(edge.x, edge.y) &&
    point.x >= Math.min(a.x, b.x) - EPSILON &&
    point.x <= Math.max(a.x, b.x) + EPSILON &&
    point.y >= Math.min(a.y, b.y) - EPSILON &&
    point.y <= Math.max(a.y, b.y) + EPSILON
  );
}

function coversEdge(a: OutlinePoint, b: OutlinePoint, polygon: readonly OutlinePoint[]): boolean {
  const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  let inside = false;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i],
      q = polygon[(i + 1) % polygon.length];
    if (onSegment(middle, p, q)) {
      return (b.x - a.x) * (q.x - p.x) + (b.y - a.y) * (q.y - p.y) < 0;
    }
    if (
      p.y > middle.y !== q.y > middle.y &&
      middle.x < p.x + ((middle.y - p.y) * (q.x - p.x)) / (q.y - p.y)
    )
      inside = !inside;
  }
  return inside;
}

export function unionOuterContours(shapes: readonly (readonly OutlinePoint[])[]): OutlinePoint[][] {
  const polygons = shapes.flatMap((shape) => {
    const distinct = shape.filter(
      (p, i) => !samePoint(p, shape[(i + shape.length - 1) % shape.length])
    );
    const points = distinct.filter((p, i) => {
      const before = subtract(p, distinct[(i + distinct.length - 1) % distinct.length]);
      const after = subtract(distinct[(i + 1) % distinct.length], p);
      return (
        Math.abs(cross(before, after)) > EPSILON * Math.hypot(before.x, before.y) ||
        before.x * after.x + before.y * after.y < 0
      );
    });
    const area = signedArea(points);
    return Math.abs(area) <= EPSILON ? [] : [area > 0 ? points : [...points].reverse()];
  });
  const edges = polygons.flatMap((polygon, owner) =>
    polygon.map((a, i) => ({
      a,
      b: polygon[(i + 1) % polygon.length],
      owner,
      cuts: [0, 1],
    }))
  );
  const addCut = (cuts: number[], t: number) => {
    if (t >= -EPSILON && t <= 1 + EPSILON) cuts.push(Math.max(0, Math.min(1, t)));
  };
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i],
      r = subtract(a.b, a.a);
    const rLength = Math.hypot(r.x, r.y);
    for (let j = i + 1; j < edges.length; j++) {
      const b = edges[j];
      if (a.owner === b.owner) continue;
      const s = subtract(b.b, b.a),
        offset = subtract(b.a, a.a);
      const divisor = cross(r, s);
      if (Math.abs(divisor) > EPSILON * rLength * Math.hypot(s.x, s.y)) {
        const t = cross(offset, s) / divisor,
          u = cross(offset, r) / divisor;
        if (t >= -EPSILON && t <= 1 + EPSILON && u >= -EPSILON && u <= 1 + EPSILON) {
          addCut(a.cuts, t);
          addCut(b.cuts, u);
        }
      } else if (Math.abs(cross(r, offset)) <= EPSILON * rLength) {
        const project = (p: OutlinePoint, origin: OutlinePoint, d: OutlinePoint) =>
          ((p.x - origin.x) * d.x + (p.y - origin.y) * d.y) / (d.x * d.x + d.y * d.y);
        addCut(a.cuts, project(b.a, a.a, r));
        addCut(a.cuts, project(b.b, a.a, r));
        addCut(b.cuts, project(a.a, b.a, s));
        addCut(b.cuts, project(a.b, b.a, s));
      }
    }
  }

  const vertices: OutlinePoint[] = [];
  const vertex = (point: OutlinePoint) => {
    const existing = vertices.findIndex((p) => samePoint(p, point));
    return existing >= 0 ? existing : vertices.push(point) - 1;
  };
  const boundary = new Map<string, { start: number; end: number }>();
  for (const edge of edges) {
    const cuts = edge.cuts.sort((a, b) => a - b);
    const at = (t: number) => ({
      x: edge.a.x + (edge.b.x - edge.a.x) * t,
      y: edge.a.y + (edge.b.y - edge.a.y) * t,
    });
    for (let i = 1; i < cuts.length; i++) {
      const a = at(cuts[i - 1]),
        b = at(cuts[i]);
      if (
        samePoint(a, b) ||
        polygons.some((p, owner) => owner !== edge.owner && coversEdge(a, b, p))
      )
        continue;
      const start = vertex(a),
        end = vertex(b);
      boundary.set(`${start}:${end}`, { start, end });
    }
  }
  const outgoing = new Map<number, number[]>();
  for (const { start, end } of boundary.values()) {
    const ends = outgoing.get(start) ?? [];
    ends.push(end);
    outgoing.set(start, ends);
  }
  const contours: OutlinePoint[][] = [];
  for (const first of boundary.values()) {
    const contour: OutlinePoint[] = [];
    let { start, end } = first;
    while (boundary.delete(`${start}:${end}`)) {
      contour.push(vertices[start]);
      if (end === first.start) {
        if (signedArea(contour) > EPSILON) contours.push(contour);
        break;
      }
      const incoming = subtract(vertices[end], vertices[start]);
      const next = (outgoing.get(end) ?? [])
        .filter((v) => boundary.has(`${end}:${v}`))
        .sort((a, b) => {
          const turn = (v: number) => {
            const d = subtract(vertices[v], vertices[end]);
            return Math.atan2(cross(incoming, d), incoming.x * d.x + incoming.y * d.y);
          };
          return turn(b) - turn(a);
        })[0];
      if (next === undefined) break;
      start = end;
      end = next;
    }
  }
  return contours;
}

export function rectangleContour(
  x: number,
  y: number,
  width: number,
  height: number
): OutlinePoint[] {
  if (width <= 0 || height <= 0) return [];
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

export function roundedRectangleContour(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number | readonly [number, number, number, number]
): OutlinePoint[] {
  if (width <= 0 || height <= 0) return [];
  const [topLeft, topRight, bottomRight, bottomLeft] = (
    typeof radius === 'number' ? [radius, radius, radius, radius] : radius
  ).map((r) => Math.max(0, Math.min(r, width / 2, height / 2)));
  if (topLeft + topRight + bottomRight + bottomLeft <= 0)
    return rectangleContour(x, y, width, height);
  const points: OutlinePoint[] = [];
  const corners = [
    [x + width - topRight, y + topRight, topRight],
    [x + width - bottomRight, y + height - bottomRight, bottomRight],
    [x + bottomLeft, y + height - bottomLeft, bottomLeft],
    [x + topLeft, y + topLeft, topLeft],
  ];
  corners.forEach(([cx, cy, r], corner) => {
    if (r <= 0) {
      points.push({ x: cx, y: cy });
      return;
    }
    for (let step = 0; step <= 8; step++) {
      const angle = ((corner - 1 + step / 8) * Math.PI) / 2;
      points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    }
  });
  return points;
}
