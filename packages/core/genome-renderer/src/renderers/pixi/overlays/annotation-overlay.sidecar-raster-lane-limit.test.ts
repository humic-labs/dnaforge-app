import { describe, expect, it } from 'vitest';
import { AnnotationOverlay } from './annotation-overlay';

describe('AnnotationOverlay sidecar raster lane-limit cap', () => {
  it('defaults to the Slice 1 single-band behavior', () => {
    const overlay = new AnnotationOverlay();
    expect(overlay.getSidecarRasterLaneLimit()).toBe(1);
  });

  it('setSidecarRasterLaneLimit replaces the cap', () => {
    const overlay = new AnnotationOverlay();
    overlay.setSidecarRasterLaneLimit(4);
    expect(overlay.getSidecarRasterLaneLimit()).toBe(4);
  });

  it('rejects values below 1 (never a raster with zero or negative lanes)', () => {
    const overlay = new AnnotationOverlay();
    overlay.setSidecarRasterLaneLimit(4);
    overlay.setSidecarRasterLaneLimit(0);
    overlay.setSidecarRasterLaneLimit(-3);
    expect(overlay.getSidecarRasterLaneLimit()).toBe(4);
  });

  it('rejects non-finite values', () => {
    const overlay = new AnnotationOverlay();
    overlay.setSidecarRasterLaneLimit(4);
    overlay.setSidecarRasterLaneLimit(Number.NaN);
    overlay.setSidecarRasterLaneLimit(Number.POSITIVE_INFINITY);
    expect(overlay.getSidecarRasterLaneLimit()).toBe(4);
  });

  it('truncates a fractional value', () => {
    const overlay = new AnnotationOverlay();
    overlay.setSidecarRasterLaneLimit(3.7);
    expect(overlay.getSidecarRasterLaneLimit()).toBe(3);
  });
});
