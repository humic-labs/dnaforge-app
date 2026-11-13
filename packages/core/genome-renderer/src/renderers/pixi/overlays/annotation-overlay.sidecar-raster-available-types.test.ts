import { describe, expect, it } from 'vitest';
import { AnnotationOverlay } from './annotation-overlay';

describe('AnnotationOverlay sidecar raster available-types accumulator', () => {
  it('returns empty when no sidecar raster source has ever been installed', () => {
    const overlay = new AnnotationOverlay();
    expect(overlay.getSidecarRasterAvailableTypes()).toEqual([]);
  });
});
