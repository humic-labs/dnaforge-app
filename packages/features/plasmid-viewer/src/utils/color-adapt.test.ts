import { describe, it, expect } from 'vitest';
import { adaptColorForDark } from './color-adapt';

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}

describe('adaptColorForDark', () => {
  it('returns color unchanged when isDark is false', () => {
    expect(adaptColorForDark('#FFF3B0', false)).toBe('#FFF3B0');
  });

  it('darkens very light colors for dark backgrounds', () => {
    const result = adaptColorForDark('#FFF3B0', true);
    expect(result).not.toBe('#FFF3B0');
    const hue = hexToHsl(result)[0];
    expect(hue).toBeGreaterThan(40);
    expect(hue).toBeLessThan(65);
  });

  it('leaves already-saturated medium colors alone', () => {
    expect(adaptColorForDark('#3b82f6', true)).toBe('#3b82f6');
  });

  it('boosts very desaturated colors', () => {
    const result = adaptColorForDark('#b0b0c0', true);
    expect(result).not.toBe('#b0b0c0');
  });

  it('handles 3-digit hex', () => {
    expect(adaptColorForDark('#fff', true)).not.toBe('#fff');
  });

  it('preserves hue for standard feature colors', () => {
    const blue = adaptColorForDark('#3b82f6', true);
    const orange = adaptColorForDark('#f97316', true);
    expect(blue).toMatch(/^#[0-9a-f]{6}$/i);
    expect(orange).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('boosts very dark colors for dark backgrounds', () => {
    const result = adaptColorForDark('#1a1a2e', true);
    const [, , lightness] = hexToHsl(result);
    expect(lightness).toBeGreaterThan(35);
  });
});
