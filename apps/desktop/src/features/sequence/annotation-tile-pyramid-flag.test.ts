import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isAnnotationTilePyramidEnabled,
  syncAnnotationTilePyramidRendererFlag,
} from './annotation-tile-pyramid-flag';

describe('annotation-tile-pyramid-flag', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_ANNOTATION_TILE_PYRAMID', '');
    delete (globalThis as { __WAYPOINT_ANNOTATION_TILE_PYRAMID?: boolean })
      .__WAYPOINT_ANNOTATION_TILE_PYRAMID;
    delete (globalThis as { __WAYPOINT_WEBGL_GENOME_TILE_PYRAMID?: boolean })
      .__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID;
    delete (globalThis as { __WAYPOINT_TILE_ENGINE?: boolean }).__WAYPOINT_TILE_ENGINE;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as { __WAYPOINT_ANNOTATION_TILE_PYRAMID?: boolean })
      .__WAYPOINT_ANNOTATION_TILE_PYRAMID;
    delete (globalThis as { __WAYPOINT_WEBGL_GENOME_TILE_PYRAMID?: boolean })
      .__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID;
    delete (globalThis as { __WAYPOINT_TILE_ENGINE?: boolean }).__WAYPOINT_TILE_ENGINE;
  });

  it('defaults off so annotation ownership does not change during pileup gates', () => {
    expect(isAnnotationTilePyramidEnabled()).toBe(false);
  });

  it('does not treat the old pileup tile-engine global as an annotation switch', () => {
    (globalThis as { __WAYPOINT_TILE_ENGINE?: boolean }).__WAYPOINT_TILE_ENGINE = true;
    expect(isAnnotationTilePyramidEnabled()).toBe(false);
  });

  it('uses the annotation-specific runtime switch', () => {
    (
      globalThis as { __WAYPOINT_ANNOTATION_TILE_PYRAMID?: boolean }
    ).__WAYPOINT_ANNOTATION_TILE_PYRAMID = true;
    expect(isAnnotationTilePyramidEnabled()).toBe(true);
  });

  it('uses the annotation-specific Vite env switch', () => {
    vi.stubEnv('VITE_ANNOTATION_TILE_PYRAMID', '1');
    expect(isAnnotationTilePyramidEnabled()).toBe(true);
  });

  it('bridges the annotation switch onto the renderer-facing tile-pyramid global', () => {
    (
      globalThis as { __WAYPOINT_ANNOTATION_TILE_PYRAMID?: boolean }
    ).__WAYPOINT_ANNOTATION_TILE_PYRAMID = true;

    const cleanup = syncAnnotationTilePyramidRendererFlag();

    expect(
      (globalThis as { __WAYPOINT_WEBGL_GENOME_TILE_PYRAMID?: boolean })
        .__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID
    ).toBe(true);

    cleanup();

    expect(
      (globalThis as { __WAYPOINT_WEBGL_GENOME_TILE_PYRAMID?: boolean })
        .__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID
    ).toBeUndefined();
  });

  it('does not clear a renderer-facing tile-pyramid flag changed by a later owner', () => {
    (
      globalThis as { __WAYPOINT_ANNOTATION_TILE_PYRAMID?: boolean }
    ).__WAYPOINT_ANNOTATION_TILE_PYRAMID = false;

    const cleanup = syncAnnotationTilePyramidRendererFlag();
    (
      globalThis as { __WAYPOINT_WEBGL_GENOME_TILE_PYRAMID?: boolean }
    ).__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID = true;

    cleanup();

    expect(
      (globalThis as { __WAYPOINT_WEBGL_GENOME_TILE_PYRAMID?: boolean })
        .__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID
    ).toBe(true);
  });
});
