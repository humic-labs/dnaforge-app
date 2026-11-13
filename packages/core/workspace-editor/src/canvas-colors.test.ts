import { describe, it, expect } from 'vitest';
import { adaptColorForDark, tintedTextColor } from './canvas-colors';

function hexToHsl(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let hue = 0;
  let sat = 0;
  const lit = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    sat = lit > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) hue = ((b - r) / d + 2) / 6;
    else hue = ((r - g) / d + 4) / 6;
  }
  return [hue * 360, sat * 100, lit * 100];
}

describe('adaptColorForDark', () => {
  it('returns color unchanged when isDark is false', () => {
    expect(adaptColorForDark('#FFF3B0', false)).toBe('#FFF3B0');
    expect(adaptColorForDark('#1a1a2e', false)).toBe('#1a1a2e');
    expect(adaptColorForDark('#3b82f6', false)).toBe('#3b82f6');
  });

  it('maps lightness into muted 22-38 range', () => {
    const light = adaptColorForDark('#FFF3B0', true);
    const dark = adaptColorForDark('#1a1a2e', true);
    const [, , lLight] = hexToHsl(light);
    const [, , lDark] = hexToHsl(dark);
    expect(lLight).toBeLessThanOrEqual(38);
    expect(lLight).toBeGreaterThanOrEqual(22);
    expect(lDark).toBeLessThanOrEqual(38);
    expect(lDark).toBeGreaterThanOrEqual(22);
  });

  it('preserves relative lightness ordering between colors', () => {
    const lighter = adaptColorForDark('#cccccc', true);
    const darker = adaptColorForDark('#666666', true);
    const [, , lLighter] = hexToHsl(lighter);
    const [, , lDarker] = hexToHsl(darker);
    expect(lLighter).toBeGreaterThan(lDarker);
  });

  it('reduces saturation proportionally in dark mode', () => {
    const result = adaptColorForDark('#3b82f6', true);
    const [, satOrig] = hexToHsl('#3b82f6');
    const [, satResult] = hexToHsl(result);
    expect(satResult).toBeLessThan(satOrig);
  });

  it('returns non-hex strings unchanged', () => {
    expect(adaptColorForDark('rgb(100, 200, 50)', true)).toBe('rgb(100, 200, 50)');
    expect(adaptColorForDark('hsl(120, 50%, 50%)', true)).toBe('hsl(120, 50%, 50%)');
    expect(adaptColorForDark('red', true)).toBe('red');
  });

  it('handles 3-digit hex', () => {
    const result = adaptColorForDark('#fff', true);
    const [, , lightness] = hexToHsl(result);
    expect(lightness).toBeLessThan(60);
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('preserves hue across all adjustments', () => {
    const input = '#1a5c2e';
    const [inputHue] = hexToHsl(input);
    const result = adaptColorForDark(input, true);
    const [resultHue] = hexToHsl(result);
    expect(Math.abs(inputHue - resultHue)).toBeLessThan(2);
  });
});

describe('tintedTextColor', () => {
  it('returns dark tinted color in light mode', () => {
    const result = tintedTextColor('#3b82f6', false);
    const [, , lightness] = hexToHsl(result);
    expect(lightness).toBeLessThan(40);
  });

  it('returns light tinted color in dark mode', () => {
    const result = tintedTextColor('#3b82f6', true);
    const [, , lightness] = hexToHsl(result);
    expect(lightness).toBeGreaterThan(60);
  });

  it('falls back to plain muted for gray/desaturated annotation colors', () => {
    const lightResult = tintedTextColor('#808080', false);
    const darkResult = tintedTextColor('#808080', true);
    expect(lightResult).toBe('#4b5563');
    expect(darkResult).toBe('#9ca3af');
  });

  it('falls back gracefully for non-hex input', () => {
    expect(tintedTextColor('rgb(100, 200, 50)', false)).toBe('#4b5563');
    expect(tintedTextColor('rgb(100, 200, 50)', true)).toBe('#9ca3af');
  });

  it('preserves annotation hue in the tinted output', () => {
    const annotationHex = '#e74c3c';
    const [inputHue] = hexToHsl(annotationHex);
    const result = tintedTextColor(annotationHex, false);
    const [resultHue] = hexToHsl(result);
    expect(Math.abs(inputHue - resultHue)).toBeLessThan(3);
  });
});
