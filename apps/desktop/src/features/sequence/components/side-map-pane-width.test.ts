// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIDE_MAP_PANE_WIDTH,
  MIN_SIDE_MAP_PANE_WIDTH,
  SIDE_MAP_RESIZE_HANDLE_WIDTH,
  clampSideMapPaneWidth,
  defaultSideMapPaneWidth,
  usableSideSplitWidth,
} from './side-map-pane-width';

describe('clampSideMapPaneWidth — containment (the map may never leave its box)', () => {
  it('never exceeds a measured container, even below the map floor', () => {
    expect(clampSideMapPaneWidth(DEFAULT_SIDE_MAP_PANE_WIDTH, 202)).toBe(202);
  });

  it('collapses with a container that has almost nothing left', () => {
    expect(clampSideMapPaneWidth(defaultSideMapPaneWidth(2), 2)).toBe(2);
  });

  it('holds for every container narrower than the map floor', () => {
    for (let total = 1; total <= MIN_SIDE_MAP_PANE_WIDTH; total += 1) {
      expect(clampSideMapPaneWidth(DEFAULT_SIDE_MAP_PANE_WIDTH, total)).toBe(total);
    }
  });

  it('is never wider than its container across the whole range', () => {
    for (let total = 1; total <= 2400; total += 7) {
      for (const requested of [0, 1, 120, 280, 520, 972, 4000, Number.NaN]) {
        expect(clampSideMapPaneWidth(requested, total)).toBeLessThanOrEqual(total);
      }
    }
  });
});

describe('clampSideMapPaneWidth — preferences, unchanged', () => {
  it('opens a roomy split balanced', () => {
    expect(clampSideMapPaneWidth(defaultSideMapPaneWidth(1944), 1944)).toBe(972);
  });

  it('raises a too-narrow request to the map floor when there is room for it', () => {
    expect(clampSideMapPaneWidth(50, 1000)).toBe(MIN_SIDE_MAP_PANE_WIDTH);
  });

  it('leaves the sequence pane its floor when there is room for both', () => {
    expect(clampSideMapPaneWidth(900, 1000)).toBe(680);
  });

  it('still prefers the map at the break-even width, without overflowing', () => {
    expect(clampSideMapPaneWidth(999, 600)).toBe(MIN_SIDE_MAP_PANE_WIDTH);
    expect(clampSideMapPaneWidth(999, 402)).toBe(MIN_SIDE_MAP_PANE_WIDTH);
  });

  it('keeps the map floor while the container is still unmeasured', () => {
    for (const unmeasured of [null, Number.NaN]) {
      expect(clampSideMapPaneWidth(10, unmeasured)).toBe(MIN_SIDE_MAP_PANE_WIDTH);
    }
  });
});

describe('clampSideMapPaneWidth — a real zero is not "unmeasured"', () => {
  it('takes zero when the container genuinely has no room', () => {
    expect(clampSideMapPaneWidth(DEFAULT_SIDE_MAP_PANE_WIDTH, 0)).toBe(0);
  });

  it('treats a negative measurement as no room, not as unmeasured', () => {
    expect(clampSideMapPaneWidth(DEFAULT_SIDE_MAP_PANE_WIDTH, -12)).toBe(0);
  });
});

describe('usableSideSplitWidth — the drag handle is an occupant too', () => {
  it('reserves the handle when the split is showing one', () => {
    expect(usableSideSplitWidth(202, true)).toBe(202 - SIDE_MAP_RESIZE_HANDLE_WIDTH);
  });

  it('reserves nothing when there is no handle', () => {
    expect(usableSideSplitWidth(202, false)).toBe(202);
  });

  it('never goes negative', () => {
    expect(usableSideSplitWidth(2, true)).toBe(0);
    expect(usableSideSplitWidth(0, true)).toBe(0);
  });

  it('passes an unmeasured container straight through', () => {
    expect(usableSideSplitWidth(null, true)).toBeNull();
    expect(usableSideSplitWidth(Number.NaN, true)).toBeNull();
  });

  it('composes with the clamp so map + handle fit the real container', () => {
    const container = 202;
    const usable = usableSideSplitWidth(container, true);
    const map = clampSideMapPaneWidth(DEFAULT_SIDE_MAP_PANE_WIDTH, usable);
    expect(map + SIDE_MAP_RESIZE_HANDLE_WIDTH).toBeLessThanOrEqual(container);
  });
});

describe('defaultSideMapPaneWidth', () => {
  it('halves a measured container', () => {
    expect(defaultSideMapPaneWidth(1944)).toBe(972);
    expect(defaultSideMapPaneWidth(403)).toBe(202);
  });

  it('falls back when the container is unmeasured', () => {
    for (const unmeasured of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(defaultSideMapPaneWidth(unmeasured)).toBe(DEFAULT_SIDE_MAP_PANE_WIDTH);
    }
  });
});
