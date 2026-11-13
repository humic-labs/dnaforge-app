import { describe, expect, it } from 'vitest';

import {
  CYTOBAND_REQUIRED_TRACK_HEIGHT_PX,
  computeCytobandVerticalLayout,
} from './cytoband-vertical-layout';

describe('cytoband vertical layout', () => {
  it('reserves the complete band, label line box, and bottom gutter', () => {
    expect(CYTOBAND_REQUIRED_TRACK_HEIGHT_PX).toBe(32);
    expect(computeCytobandVerticalLayout(32)).toEqual({
      allocatedHeightPx: 32,
      bandHeightPx: 14,
      labelTopPx: 16,
      labelBottomPx: 30,
      contentBottomPx: 32,
      requiredTrackHeightPx: 32,
      overflowPx: 0,
      labelsFit: true,
    });
  });

  it('reports the exact overflow instead of pretending a clipped slot is safe', () => {
    expect(computeCytobandVerticalLayout(26)).toMatchObject({ overflowPx: 6, labelsFit: false });
    expect(computeCytobandVerticalLayout(14)).toMatchObject({ overflowPx: 18, labelsFit: false });
  });

  it('fails closed on invalid allocation', () => {
    expect(() => computeCytobandVerticalLayout(Number.NaN)).toThrow();
    expect(() => computeCytobandVerticalLayout(-1)).toThrow();
  });
});
