import {
  isHex,
  hexToRgb,
  rgbToHsl,
  hslToHex,
  tintedTextColor,
} from '@waypoint/sequence-utils/annotation-text-color';
export { tintedTextColor };

export function isLightColor(hexColor: string): boolean {
  if (!isHex(hexColor)) return false;
  const [r, g, b] = hexToRgb(hexColor);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6;
}

export function adaptColorForDark(hex: string, isDark: boolean): string {
  if (!isDark) return hex;
  if (!isHex(hex)) return hex;

  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);

  const lAdj = 22 + (l / 100) * 16;

  const sAdj = s * 0.5;

  return hslToHex(h, sAdj, lAdj);
}
