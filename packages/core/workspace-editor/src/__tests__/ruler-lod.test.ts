import { describe, expect, it } from 'vitest';
import { getEffectiveRulerInterval } from '../canvas-drawing';
import { DEFAULT_EDITOR_CONFIG } from '../types';

describe('ruler LOD tick interval', () => {
  it('uses the configured interval at detail zoom', () => {
    expect(getEffectiveRulerInterval(DEFAULT_EDITOR_CONFIG)).toBe(
      DEFAULT_EDITOR_CONFIG.rulerInterval
    );
  });

  it('raises the interval at ultra-low zoom so ticks are interval-driven', () => {
    const interval = getEffectiveRulerInterval({
      ...DEFAULT_EDITOR_CONFIG,
      charWidth: DEFAULT_EDITOR_CONFIG.charWidth * 0.002,
    });

    expect(interval).toBeGreaterThan(1000);
  });
});
