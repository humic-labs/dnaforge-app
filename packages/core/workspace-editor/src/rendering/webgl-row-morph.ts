export type MorphVertex = [x: number, y: number, u: number, v: number];

export function clipMorphPolygon(
  vertices: MorphVertex[],
  top: number,
  bottom: number
): MorphVertex[] {
  for (const [edge, lower] of [
    [top, true],
    [bottom, false],
  ] as const) {
    if (!vertices.length) break;
    const clipped: MorphVertex[] = [];
    let previous = vertices[vertices.length - 1];
    let previousInside = lower ? previous[1] >= edge : previous[1] <= edge;
    for (const current of vertices) {
      const inside = lower ? current[1] >= edge : current[1] <= edge;
      if (inside !== previousInside) {
        const progress = (edge - previous[1]) / (current[1] - previous[1]);
        clipped.push([
          previous[0] + (current[0] - previous[0]) * progress,
          edge,
          previous[2] + (current[2] - previous[2]) * progress,
          previous[3] + (current[3] - previous[3]) * progress,
        ]);
      }
      if (inside) clipped.push(current);
      previous = current;
      previousInside = inside;
    }
    vertices = clipped;
  }
  return vertices;
}
