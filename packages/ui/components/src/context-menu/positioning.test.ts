import { describe, expect, it } from 'vitest';
import { clampFixedMenuPosition } from './positioning';

describe('clampFixedMenuPosition', () => {
  it('keeps a menu above the bottom viewport edge', () => {
    expect(
      clampFixedMenuPosition({
        x: 100,
        y: 760,
        menuWidth: 220,
        menuHeight: 180,
        viewportWidth: 1024,
        viewportHeight: 800,
        padding: 10,
      })
    ).toEqual({ x: 100, y: 610 });
  });

  it('keeps a menu inside the right viewport edge', () => {
    expect(
      clampFixedMenuPosition({
        x: 980,
        y: 100,
        menuWidth: 220,
        menuHeight: 180,
        viewportWidth: 1024,
        viewportHeight: 800,
        padding: 10,
      })
    ).toEqual({ x: 794, y: 100 });
  });

  it('anchors oversized menus at the viewport padding instead of allowing negative positions', () => {
    expect(
      clampFixedMenuPosition({
        x: 40,
        y: 40,
        menuWidth: 220,
        menuHeight: 900,
        viewportWidth: 1024,
        viewportHeight: 800,
        padding: 10,
      })
    ).toEqual({ x: 40, y: 0 });
  });
});
