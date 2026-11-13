interface AnnotationTilePyramidGlobal {
  __WAYPOINT_ANNOTATION_TILE_PYRAMID?: boolean;
  __WAYPOINT_WEBGL_GENOME_TILE_PYRAMID?: boolean;
}

export function isAnnotationTilePyramidEnabled(): boolean {
  if (typeof window !== 'undefined') {
    const w = window as AnnotationTilePyramidGlobal;
    if (typeof w.__WAYPOINT_ANNOTATION_TILE_PYRAMID === 'boolean') {
      return w.__WAYPOINT_ANNOTATION_TILE_PYRAMID;
    }
  }
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as AnnotationTilePyramidGlobal;
    if (typeof g.__WAYPOINT_ANNOTATION_TILE_PYRAMID === 'boolean') {
      return g.__WAYPOINT_ANNOTATION_TILE_PYRAMID;
    }
  }
  try {
    const v = import.meta.env?.VITE_ANNOTATION_TILE_PYRAMID;
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

export function syncAnnotationTilePyramidRendererFlag(): () => void {
  const g = globalThis as AnnotationTilePyramidGlobal;
  const enabled = isAnnotationTilePyramidEnabled();
  g.__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID = enabled;
  return () => {
    if (g.__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID === enabled) {
      delete g.__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID;
    }
  };
}
