// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { scrollOffsetForRow } from './scroll-into-view';

const ROW = 24;
const MARGIN = ROW * 2;

describe('scrollOffsetForRow  autoscroll math)', () => {
  it('scrolls a far-below target to a top anchor (rowTop - margin)', () => {
    expect(
      scrollOffsetForRow({
        rowTop: 6000,
        rowHeight: ROW,
        viewportHeight: 400,
        scrollTop: 0,
        margin: MARGIN,
      })
    ).toBe(6000 - MARGIN);
  });

  it('scrolls an above-viewport target up to a top anchor', () => {
    expect(
      scrollOffsetForRow({
        rowTop: 100,
        rowHeight: ROW,
        viewportHeight: 400,
        scrollTop: 2000,
        margin: MARGIN,
      })
    ).toBe(Math.max(0, 100 - MARGIN));
  });

  it('returns null when the row is already comfortably visible', () => {
    expect(
      scrollOffsetForRow({
        rowTop: 1100,
        rowHeight: ROW,
        viewportHeight: 400,
        scrollTop: 1000,
        margin: MARGIN,
      })
    ).toBeNull();
  });

  it('returns null for an unmeasured viewport (clientHeight 0 / pre-layout / jsdom)', () => {
    expect(
      scrollOffsetForRow({
        rowTop: 6000,
        rowHeight: ROW,
        viewportHeight: 0,
        scrollTop: 0,
        margin: MARGIN,
      })
    ).toBeNull();
  });

  it('clamps the anchor to >= 0 for an early row', () => {
    expect(
      scrollOffsetForRow({
        rowTop: 12,
        rowHeight: ROW,
        viewportHeight: 400,
        scrollTop: 500,
        margin: MARGIN,
      })
    ).toBe(0);
  });

  it('treats a row just inside the top margin as needing a small scroll-up', () => {
    const out = scrollOffsetForRow({
      rowTop: 1010,
      rowHeight: ROW,
      viewportHeight: 400,
      scrollTop: 1000,
      margin: MARGIN,
    });
    expect(out).toBe(Math.max(0, 1010 - MARGIN));
  });

  it('returns null when the computed anchor equals the current scrollTop (no-op)', () => {
    expect(
      scrollOffsetForRow({
        rowTop: 1000 + MARGIN,
        rowHeight: ROW,
        viewportHeight: 50,
        scrollTop: 1000,
        margin: MARGIN,
      })
    ).toBeNull();
  });
});
