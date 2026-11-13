import { describe, expect, it } from 'vitest';
import { materializeViewportRange } from '../useSequenceLayout';

describe('useSequenceLayout viewportRange forwarding', () => {
  it('preserves sparse-line and approximate-height options through the memo boundary', () => {
    expect(
      materializeViewportRange({
        firstRowIndex: 3,
        lastRowIndex: 4,
        approximateOffscreenRowHeight: 17,
        emitOnlyViewportLines: true,
      })
    ).toEqual({
      firstRowIndex: 3,
      lastRowIndex: 4,
      approximateOffscreenRowHeight: 17,
      emitOnlyViewportLines: true,
    });
  });

  it('does not activate viewport scoping until both bounds are defined', () => {
    expect(materializeViewportRange({ firstRowIndex: 3 })).toBeUndefined();
    expect(materializeViewportRange({ lastRowIndex: 4 })).toBeUndefined();
  });
});
