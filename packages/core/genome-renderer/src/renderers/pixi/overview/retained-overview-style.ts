import {
  resolveRetainedOverviewAnnotationStyle,
  type RetainedOverviewAnnotationStyle,
} from '../overlays/annotation-lod-policy';
import type { PathMapper, StadiumRetainedCameraParams } from '../shared/path-mapper';

type RetainedOverviewGlobal = typeof globalThis & {
  __WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS?: boolean;
  __WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE?: string;
  __WAYPOINT_WEBGL_GENOME_TILE_PYRAMID?: boolean;
  __WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES?: boolean;
};

export function retainedOverviewAnnotationsEnabled(): boolean {
  return (
    (globalThis as RetainedOverviewGlobal).__WAYPOINT_WEBGL_RETAINED_OVERVIEW_ANNOTATIONS !== false
  );
}

export function genomeTilePyramidEnabled(): boolean {
  return (globalThis as RetainedOverviewGlobal).__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID === true;
}

export function overviewGlyphTilesEnabled(): boolean {
  return (globalThis as RetainedOverviewGlobal).__WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES === true;
}

export function retainedOverviewAnnotationStyle(): RetainedOverviewAnnotationStyle {
  const style = (globalThis as RetainedOverviewGlobal).__WAYPOINT_WEBGL_OVERVIEW_ANNOTATION_STYLE;
  return resolveRetainedOverviewAnnotationStyle(style);
}

export function stadiumRetainedCameraParams(path: PathMapper): StadiumRetainedCameraParams | null {
  const maybe = path as PathMapper & {
    getRetainedCameraParams?: () => StadiumRetainedCameraParams;
  };
  return maybe.getRetainedCameraParams?.() ?? null;
}
