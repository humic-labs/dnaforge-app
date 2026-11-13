import { describe, expect, it } from 'vitest';
import {
  codonFontSize,
  intronTickAlpha,
  intronTickPitch,
  SEQUENCE_FONT_FAMILY,
} from './sequence-style';
describe('sequence surface styling', () => {
  it('pins the Canvas font stack and amino-acid size', () => {
    expect(SEQUENCE_FONT_FAMILY).toBe('"JetBrains Mono", "SF Mono", "Fira Code", monospace');
    expect(codonFontSize(11)).toBe(13);
  });
  it('interleaves intron ticks on zoom without moving existing base positions', () => {
    for (const scale of [0.01, 0.1, 1, 7, 20]) {
      const current = intronTickPitch(scale);
      const next = intronTickPitch(scale * 2);
      expect(current).toBe(next * 2);
      expect(current * scale).toBeGreaterThanOrEqual(50);
      expect(current * scale).toBeLessThan(100);
    }
    expect(intronTickAlpha(12)).toBe(0);
    expect(intronTickAlpha(64)).toBe(0.8);
  });
});
