import { resolveAnnotationDisplayColor, type AnnotationColorMode } from '@waypoint/sequence-utils';

const colorParseCache = new Map<string, { r: number; g: number; b: number } | null>();

export function parseHexColor(color: string): { r: number; g: number; b: number } | null {
  const cached = colorParseCache.get(color);
  if (cached !== undefined) return cached;

  let hex = color.replace('#', '');
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }

  if (hex.length !== 6) {
    colorParseCache.set(color, null);
    return null;
  }

  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  if (isNaN(r) || isNaN(g) || isNaN(b)) {
    colorParseCache.set(color, null);
    return null;
  }

  const result = { r, g, b };
  colorParseCache.set(color, result);
  return result;
}

export function getDarkenedColor(
  color: string,
  darkenBy: number = 50,
  alpha: number = 0.4
): string {
  const parsed = parseHexColor(color);
  if (!parsed) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${Math.max(0, parsed.r - darkenBy)}, ${Math.max(0, parsed.g - darkenBy)}, ${Math.max(0, parsed.b - darkenBy)}, ${alpha})`;
}

export function getLightenedColor(
  color: string,
  lightenBy: number = 50,
  alpha: number = 0.95
): string {
  const parsed = parseHexColor(color);
  if (!parsed) return `rgba(255, 255, 255, ${alpha})`;
  return `rgba(${Math.min(255, parsed.r + lightenBy)}, ${Math.min(255, parsed.g + lightenBy)}, ${Math.min(255, parsed.b + lightenBy)}, ${alpha})`;
}

export function getEmphasizedColor(
  color: string,
  isDark: boolean,
  amount: number = 60,
  alpha: number = 0.95
): string {
  return isDark ? getLightenedColor(color, amount, alpha) : getDarkenedColor(color, amount, alpha);
}

export function parseAnyColorToRgb(color: string): { r: number; g: number; b: number } | null {
  const hex = parseHexColor(color);
  if (hex) return hex;

  const rgbaMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(color);
  if (rgbaMatch) {
    return {
      r: Math.min(255, parseInt(rgbaMatch[1], 10)),
      g: Math.min(255, parseInt(rgbaMatch[2], 10)),
      b: Math.min(255, parseInt(rgbaMatch[3], 10)),
    };
  }

  const hslMatch = /^hsl\(\s*(\d+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i.exec(color);
  if (hslMatch) {
    const h = parseFloat(hslMatch[1]) / 360;
    const s = parseFloat(hslMatch[2]) / 100;
    const l = parseFloat(hslMatch[3]) / 100;
    const hueToRgb = (p: number, q: number, t: number): number => {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };
    if (s === 0) {
      const v = Math.round(l * 255);
      return { r: v, g: v, b: v };
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
      g: Math.round(hueToRgb(p, q, h) * 255),
      b: Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
    };
  }

  return null;
}

export function getEmphasizedColorAny(
  color: string,
  isDark: boolean,
  amount: number = 60,
  alpha: number = 0.95
): string {
  const rgb = parseAnyColorToRgb(color);
  if (!rgb) {
    return isDark ? `rgba(255, 255, 255, ${alpha})` : `rgba(0, 0, 0, ${alpha})`;
  }
  if (isDark) {
    return `rgba(${Math.min(255, rgb.r + amount)}, ${Math.min(255, rgb.g + amount)}, ${Math.min(255, rgb.b + amount)}, ${alpha})`;
  }
  return `rgba(${Math.max(0, rgb.r - amount)}, ${Math.max(0, rgb.g - amount)}, ${Math.max(0, rgb.b - amount)}, ${alpha})`;
}

export function getOutlineAlphaStroke(isDark: boolean, alpha: number = 0.55): string {
  return isDark ? `rgba(255, 255, 255, ${alpha})` : `rgba(0, 0, 0, ${alpha})`;
}

export function getAnnotationDisplayColor(
  ann: { color?: string; type: string },
  options?: string | { annotationColorMode?: AnnotationColorMode }
): string {
  const annotationColorMode =
    typeof options === 'string' ? undefined : options?.annotationColorMode;
  return resolveAnnotationDisplayColor(ann, {
    profile: { colorMode: annotationColorMode },
  });
}

export function clearColorCache(): void {
  colorParseCache.clear();
}
