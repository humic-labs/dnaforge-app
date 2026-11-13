export function adaptColorForDark(hex: string, isDark: boolean): string {
  if (!isDark) return hex;

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

  let sPercent = sat * 100;
  let lPercent = lit * 100;

  if (lPercent >= 25 && lPercent <= 70 && sPercent >= 20) {
    return hex;
  }

  if (lPercent > 70) {
    lPercent = 55 + (lPercent - 70) * 0.15;
  }

  if (lPercent < 25) {
    lPercent = 40 + lPercent * 0.4;
  }

  if (sPercent < 20 && sPercent > 0) {
    sPercent = 35;
  }

  return hslToHex(hue * 360, sPercent, lPercent);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * Math.max(0, Math.min(1, color)))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
