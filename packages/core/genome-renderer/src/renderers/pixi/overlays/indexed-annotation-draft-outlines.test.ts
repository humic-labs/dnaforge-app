import { describe, expect, it } from 'vitest';
import type { OutlineCommand } from './annotation-feature-geometry';
import {
  addFeatureOutline,
  interactionOutlineStrokeStyle,
  setFeatureOutline,
} from './indexed-annotation-draft-outlines';

describe('indexed annotation draft outlines', () => {
  it('drops a poly with fewer than 6 coords', () => {
    const cache = new Map<number, OutlineCommand[]>();
    setFeatureOutline(cache, 7, [
      { kind: 'poly', pts: [0, 0, 1, 1] },
      { kind: 'poly', pts: [0, 0, 1, 0, 1, 1] },
      { kind: 'polyline', pts: [0, 0] },
      { kind: 'roundRect', x: 0, y: 0, width: 2, height: 2, radius: 1 },
    ]);
    expect(cache.get(7)).toEqual([
      { kind: 'poly', pts: [0, 0, 1, 0, 1, 1] },
      { kind: 'roundRect', x: 0, y: 0, width: 2, height: 2, radius: 1 },
    ]);
  });

  it('appends outline commands onto an existing feature', () => {
    const cache = new Map<number, OutlineCommand[]>();
    const first: OutlineCommand = { kind: 'poly', pts: [0, 0, 1, 0, 1, 1] };
    const second: OutlineCommand = { kind: 'polyline', pts: [2, 2, 3, 3] };
    addFeatureOutline(cache, 3, first);
    addFeatureOutline(cache, 3, second);
    expect(cache.get(3)).toEqual([first, second]);
  });

  it.each<OutlineCommand>([
    { kind: 'poly', pts: [0, 0, 100, 0, 100, 14, 0, 14] },
    { kind: 'roundRect', x: 0, y: 0, width: 100, height: 14, radius: 3 },
    { kind: 'polyline', pts: [0, 0, 100, 0] },
  ])('preserves centered strokes for wide bodies and open connectors ($kind)', (command) => {
    const style = { width: 2, color: 0x111827, alpha: 0.85 };
    expect(interactionOutlineStrokeStyle(command, style)).toEqual({ ...style, alignment: 0.5 });
  });

  it.each<OutlineCommand>([
    { kind: 'poly', pts: [0, 0, 1, 0, 1, 14, 0, 14] },
    { kind: 'poly', pts: [0, 0, 0, 14, 1, 14, 1, 0] },
    { kind: 'poly', pts: [0, 0, 1, 1, 15, -13, 14, -14] },
    { kind: 'roundRect', x: 0, y: 0, width: 1, height: 14, radius: 0.5 },
  ])('keeps the same exterior stroke extent without covering narrow bodies ($kind)', (command) => {
    const style = { width: 2, color: 0x111827, alpha: 0.85 };
    const stroke = interactionOutlineStrokeStyle(command, style);
    expect(stroke).toEqual({ ...style, width: 1, alignment: 0 });
    expect(stroke.width * (1 - stroke.alignment)).toBe(style.width / 2);
    expect(stroke.width * stroke.alignment).toBe(0);
  });
});
