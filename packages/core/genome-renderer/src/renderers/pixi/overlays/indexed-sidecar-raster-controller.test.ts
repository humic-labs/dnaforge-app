import { describe, expect, it } from 'vitest';
import { IndexedSidecarRasterController } from './indexed-sidecar-raster-controller';

describe('IndexedSidecarRasterController', () => {
  it('defaults to the Slice 1 single-category behavior', () => {
    const sidecar = new IndexedSidecarRasterController();
    expect(sidecar.getVisibleTypes()).toEqual(['mRNA']);
  });

  it('setVisibleTypes replaces the filter', () => {
    const sidecar = new IndexedSidecarRasterController();
    sidecar.setVisibleTypes(['gene', 'lncRNA']);
    expect(sidecar.getVisibleTypes()).toEqual(['gene', 'lncRNA']);
  });

  it('rejects an empty array', () => {
    const sidecar = new IndexedSidecarRasterController();
    sidecar.setVisibleTypes(['gene']);
    sidecar.setVisibleTypes([]);
    expect(sidecar.getVisibleTypes()).toEqual(['gene']);
  });

  it('defaults to the Slice 1 single-band lane cap', () => {
    const sidecar = new IndexedSidecarRasterController();
    expect(sidecar.getLaneLimit()).toBe(1);
  });

  it('setLaneLimit replaces the cap and rejects invalid values', () => {
    const sidecar = new IndexedSidecarRasterController();
    sidecar.setLaneLimit(4);
    sidecar.setLaneLimit(0);
    sidecar.setLaneLimit(-3);
    sidecar.setLaneLimit(Number.NaN);
    sidecar.setLaneLimit(Number.POSITIVE_INFINITY);
    expect(sidecar.getLaneLimit()).toBe(4);
    sidecar.setLaneLimit(3.7);
    expect(sidecar.getLaneLimit()).toBe(3);
  });

  it('returns empty available types when no source is installed', () => {
    const sidecar = new IndexedSidecarRasterController();
    expect(sidecar.getAvailableTypes()).toEqual([]);
  });
});
