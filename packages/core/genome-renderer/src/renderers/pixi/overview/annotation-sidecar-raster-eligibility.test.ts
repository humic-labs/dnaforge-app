import { describe, expect, it } from 'vitest';
import { annotationSidecarRasterEligibility } from './annotation-sidecar-raster-eligibility';

describe('annotationSidecarRasterEligibility', () => {
  it('is eligible when resident and not magnified, above the fill threshold', () => {
    const result = annotationSidecarRasterEligibility({
      genomeLength: 3_088_269_832,
      visibleBp: 2_500_000_000,
      tileResident: true,
      texelsPerDevicePx: 1.2,
    });
    expect(result).toEqual({ eligible: true, reason: 'eligible' });
  });

  it('refuses when the tile is not yet resident', () => {
    const result = annotationSidecarRasterEligibility({
      genomeLength: 3_088_269_832,
      visibleBp: 2_500_000_000,
      tileResident: false,
      texelsPerDevicePx: 1.2,
    });
    expect(result).toEqual({ eligible: false, reason: 'unavailable' });
  });

  it('refuses magnification even when resident', () => {
    const result = annotationSidecarRasterEligibility({
      genomeLength: 3_088_269_832,
      visibleBp: 2_500_000_000,
      tileResident: true,
      texelsPerDevicePx: 0.6,
    });
    expect(result).toEqual({ eligible: false, reason: 'magnified' });
  });

  it('is eligible at exactly the never-magnify boundary (1.0)', () => {
    const result = annotationSidecarRasterEligibility({
      genomeLength: 3_088_269_832,
      visibleBp: 2_500_000_000,
      tileResident: true,
      texelsPerDevicePx: 1.0,
    });
    expect(result).toEqual({ eligible: true, reason: 'eligible' });
  });

  it('refuses an invalid viewport (zero or negative genome length)', () => {
    const result = annotationSidecarRasterEligibility({
      genomeLength: 0,
      visibleBp: 2_500_000_000,
      tileResident: true,
      texelsPerDevicePx: 1.2,
    });
    expect(result).toEqual({ eligible: false, reason: 'invalid-viewport' });
  });

  it('refuses an invalid viewport (zero or negative visible bp)', () => {
    const result = annotationSidecarRasterEligibility({
      genomeLength: 3_088_269_832,
      visibleBp: 0,
      tileResident: true,
      texelsPerDevicePx: 1.2,
    });
    expect(result).toEqual({ eligible: false, reason: 'invalid-viewport' });
  });

  it('checks residency and viewport validity before magnification (order matters for callers that branch on reason)', () => {
    const result = annotationSidecarRasterEligibility({
      genomeLength: 3_088_269_832,
      visibleBp: 2_500_000_000,
      tileResident: false,
      texelsPerDevicePx: 0.6,
    });
    expect(result).toEqual({ eligible: false, reason: 'unavailable' });
  });
});
