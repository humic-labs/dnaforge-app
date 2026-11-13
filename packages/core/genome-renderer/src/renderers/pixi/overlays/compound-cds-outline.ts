import { roundedRectangleContour, unionOuterContours, type OutlinePoint } from '@waypoint/platform';
import type { OutlineCommand } from './annotation-feature-geometry';

export function compoundCdsOutlineCommands(
  commands: readonly OutlineCommand[],
  codons: readonly number[][]
): OutlineCommand[] {
  const points = (flat: readonly number[]): OutlinePoint[] => {
    const result: OutlinePoint[] = [];
    for (let i = 0; i < flat.length; i += 2) result.push({ x: flat[i], y: flat[i + 1] });
    return result;
  };
  const shapes = commands.flatMap((command) => {
    if (command.kind === 'poly') return [points(command.pts)];
    if (command.kind === 'roundRect')
      return [
        roundedRectangleContour(
          command.x,
          command.y,
          command.width,
          command.height,
          command.radius
        ),
      ];
    const line = points(command.pts);
    return line.slice(1).flatMap((b, i) => {
      const a = line[i],
        dx = b.x - a.x,
        dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length <= 1e-7) return [];
      const nx = -dy / length / 2,
        ny = dx / length / 2;
      return [
        [
          { x: a.x + nx, y: a.y + ny },
          { x: b.x + nx, y: b.y + ny },
          { x: b.x - nx, y: b.y - ny },
          { x: a.x - nx, y: a.y - ny },
        ],
      ];
    });
  });
  return unionOuterContours([...shapes, ...codons.map(points)]).map((contour) => ({
    kind: 'poly',
    pts: contour.flatMap(({ x, y }) => [x, y]),
  }));
}
