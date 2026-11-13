import { describe, expect, it } from 'vitest';

import { decideTrackLod } from './lod-policy';

describe('decideTrackLod', () => {
  it('detail when a data unit spans >= 1 screen pixel', () => {
    expect(decideTrackLod({ pixelsPerBp: 0.01, dataUnitBp: 256 })).toBe('detail');
  });

  it('aggregate when a data unit is sub-pixel (zoomed out)', () => {
    expect(decideTrackLod({ pixelsPerBp: 0.0001, dataUnitBp: 256 })).toBe('aggregate');
  });

  it('crosses exactly at 1 unit-per-pixel with no prior state', () => {
    expect(decideTrackLod({ pixelsPerBp: 1, dataUnitBp: 1 })).toBe('detail');
    expect(decideTrackLod({ pixelsPerBp: 0.9, dataUnitBp: 1 })).toBe('aggregate');
  });

  it('hysteresis keeps the previous decision within the band (no flapping)', () => {
    expect(decideTrackLod({ pixelsPerBp: 0.9, dataUnitBp: 1, prev: 'detail' })).toBe('detail');
    expect(decideTrackLod({ pixelsPerBp: 1.1, dataUnitBp: 1, prev: 'aggregate' })).toBe(
      'aggregate'
    );
    expect(decideTrackLod({ pixelsPerBp: 1.5, dataUnitBp: 1, prev: 'aggregate' })).toBe('detail');
    expect(decideTrackLod({ pixelsPerBp: 0.5, dataUnitBp: 1, prev: 'detail' })).toBe('aggregate');
  });
});
