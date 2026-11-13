import { earcut, type Graphics } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import { buildTranscriptGlyphBlocks } from '../overview/transcript-glyph-vertices';
import { flatAnnotationSearchFocusBlockGeometry } from './indexed-annotation-search-focus-geometry';
import type { PathMapper } from '../shared/path-mapper';
import type { OutlineCommand } from './annotation-feature-geometry';
import type {
  AnnotationMutationPaint,
  AnnotationMutationSector,
} from './annotation-mutation-paint';

type Point = { x: number; y: number };
type SectorOutlineCommand = OutlineCommand & { genomicRange?: { start: number; end: number } };

export function retainedAnnotationSectorOutline(
  feature: Feature,
  path: PathMapper,
  state: RenderState,
  offset: number,
  halfHeight: number,
  cdsDetail: number
): OutlineCommand[] {
  return buildTranscriptGlyphBlocks([feature], {
    getOffset: () => offset,
    halfHeight,
    themeMode: state.themeMode,
    cdsDetail,
  })
    .filter((block) => block.role !== 'transcript:intron')
    .flatMap((block) => {
      const geometry = flatAnnotationSearchFocusBlockGeometry(path, state, block);
      return geometry
        ? [
            {
              kind: 'poly' as const,
              pts: geometry.points,
              genomicRange: { start: block.startBp, end: block.endBp },
            },
          ]
        : [];
    });
}

function pointsOf(points: readonly number[]): Point[] {
  const result: Point[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) result.push({ x: points[i], y: points[i + 1] });
  return result;
}

function clipPolygon(source: Point[], boundary: Point[], orientation: number): number[] {
  let clipped = source;
  for (let edge = 0; edge < boundary.length; edge++) {
    const p = boundary[edge],
      q = boundary[(edge + 1) % boundary.length];
    const distance = (a: Point) =>
      ((q.x - p.x) * (a.y - p.y) - (q.y - p.y) * (a.x - p.x)) * orientation;
    const next: Point[] = [];
    for (let i = 0; i < clipped.length; i++) {
      const a = clipped[i],
        b = clipped[(i + 1) % clipped.length];
      const da = distance(a),
        db = distance(b);
      if (da >= -1e-8) next.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        next.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    clipped = next;
  }
  const unique = clipped.filter((point, i) => {
    const previous = clipped[(i + clipped.length - 1) % clipped.length];
    return Math.hypot(point.x - previous.x, point.y - previous.y) > 1e-7;
  });
  return unique.length < 3 ? [] : unique.flatMap((point) => [point.x, point.y]);
}

function ribbonQuads(ribbon: Point[]): { points: Point[]; orientation: number }[] {
  const quads: { points: Point[]; orientation: number }[] = [];
  for (let step = 0; step + 1 < ribbon.length / 2; step++) {
    const points = [
      ribbon[step],
      ribbon[step + 1],
      ribbon[ribbon.length - 2 - step],
      ribbon[ribbon.length - 1 - step],
    ];
    const area = points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0);
    quads.push({ points, orientation: area >= 0 ? 1 : -1 });
  }
  return quads;
}

function hasPolygonArea(points: number[]): boolean {
  let area = 0;
  for (let index = 0; index < points.length; index += 2) {
    const next = (index + 2) % points.length;
    area += points[index] * points[next + 1] - points[next] * points[index + 1];
  }
  return Math.abs(area) > 1e-10;
}

export function annotationSectorPolygons(
  commands: readonly OutlineCommand[],
  sector: AnnotationMutationSector,
  path: PathMapper,
  offset: number,
  halfHeight: number,
  supportLimits?: Readonly<{ start: number; end: number }>
): number[][] {
  const width = Math.max(sector.end - sector.start, 1.5 / Math.max(path.pixelsPerBp, 1e-8));
  const middle = (sector.start + sector.end) / 2;
  const start = Math.max(middle - width / 2, supportLimits?.start ?? -Infinity),
    end = Math.min(middle + width / 2, supportLimits?.end ?? Infinity);
  if (end <= start) return [];
  const sourcePolygons = commands.flatMap((command) => {
    if (command.kind !== 'poly') return [];
    const range = (command as SectorOutlineCommand).genomicRange;
    if (range && (range.end <= sector.start || range.start >= sector.end)) return [];
    return [command.pts];
  });
  if (!path.isArcMode) {
    const left = path.bpLeftX(start),
      right = path.bpLeftX(end);
    const boundary = [
      { x: left, y: -1e9 },
      { x: right, y: -1e9 },
      { x: right, y: 1e9 },
      { x: left, y: 1e9 },
    ];
    const actualLeft = path.bpLeftX(sector.start),
      actualRight = path.bpLeftX(sector.end);
    return sourcePolygons.flatMap((source) => {
      const xs = source.filter((_, index) => index % 2 === 0);
      if (Math.max(...xs) <= actualLeft || Math.min(...xs) >= actualRight) return [];
      const clipped = clipPolygon(pointsOf(source), boundary, 1);
      return clipped.length ? [clipped] : [];
    });
  }
  const quads = ribbonQuads(pointsOf(path.featurePolygonAt(start, end, offset, halfHeight)));
  const actualQuads = ribbonQuads(
    pointsOf(path.featurePolygonAt(sector.start, sector.end, offset, halfHeight))
  );
  const polygons: number[][] = [];
  for (const source of sourcePolygons) {
    const indices = earcut(source);
    const triangles: Point[][] = [];
    for (let i = 0; i < indices.length; i += 3) {
      triangles.push(
        [indices[i], indices[i + 1], indices[i + 2]].map((index) => ({
          x: source[index * 2],
          y: source[index * 2 + 1],
        }))
      );
    }
    if (
      !triangles.some((triangle) =>
        actualQuads.some((quad) =>
          hasPolygonArea(clipPolygon(triangle, quad.points, quad.orientation))
        )
      )
    )
      continue;
    for (const triangle of triangles) {
      for (const quad of quads) {
        const clipped = clipPolygon(triangle, quad.points, quad.orientation);
        if (clipped.length) polygons.push(clipped);
      }
    }
  }
  return polygons;
}

export interface AnnotationMutationSectorHost {
  featureById: ReadonlyMap<number, Feature>;
  featureOffset(feature: Feature): number;
  halfHeight: number;
  outlineFor(feature: Feature): readonly OutlineCommand[];
}

export function renderAnnotationMutationSectors(
  host: AnnotationMutationSectorHost,
  graphics: Graphics,
  path: PathMapper,
  paints: ReadonlyMap<number, AnnotationMutationPaint>,
  cdsDetail: number
) {
  graphics.clear();
  const samples: {
    featureId: number;
    start: number;
    end: number;
    color: number;
    alpha: number;
    polygons: number[][];
  }[] = [];
  for (const [featureId, paint] of paints) {
    const alpha = paint.coding ? Math.max(0, 1 - cdsDetail) : 1;
    const feature = host.featureById.get(featureId);
    if (!feature || !paint.sectors.length || alpha <= 0) continue;
    const offset = host.featureOffset(feature);
    const commands = host.outlineFor(feature);
    for (let index = 0; index < paint.sectors.length; index++) {
      const sector = paint.sectors[index];
      const previous = paint.sectors[index - 1];
      const next = paint.sectors[index + 1];
      if (!path.isFeatureVisible(sector.start, sector.end - sector.start, offset, host.halfHeight))
        continue;
      const polygons = annotationSectorPolygons(commands, sector, path, offset, host.halfHeight, {
        start: previous ? (previous.end + sector.start) / 2 : -Infinity,
        end: next ? (sector.end + next.start) / 2 : Infinity,
      });
      if (!polygons.length) continue;
      for (const polygon of polygons) graphics.poly(polygon);
      graphics.fill({ color: sector.color, alpha });
      samples.push({ featureId, ...sector, alpha, polygons });
    }
  }
  graphics.visible = samples.length > 0;
  return { sectorCount: samples.length, samples: samples.slice(0, 256) };
}
