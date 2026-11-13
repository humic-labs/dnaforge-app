import { describe, expect, it } from 'vitest';
import { AnnotationOverlay } from './annotation-overlay';

describe('AnnotationOverlay sidecar raster visible-types filter', () => {
  it('defaults to the Slice 1 single-category behavior', () => {
    const overlay = new AnnotationOverlay();
    expect(overlay.getSidecarRasterVisibleTypes()).toEqual(['mRNA']);
  });

  it('setSidecarRasterVisibleTypes replaces the filter', () => {
    const overlay = new AnnotationOverlay();
    overlay.setSidecarRasterVisibleTypes(['gene', 'lncRNA']);
    expect(overlay.getSidecarRasterVisibleTypes()).toEqual(['gene', 'lncRNA']);
  });

  it('rejects an empty array (never rasters nothing via an accidental empty filter)', () => {
    const overlay = new AnnotationOverlay();
    overlay.setSidecarRasterVisibleTypes(['gene']);
    overlay.setSidecarRasterVisibleTypes([]);
    expect(overlay.getSidecarRasterVisibleTypes()).toEqual(['gene']);
  });
});
