export function formatRulerLabel(bp: number, step: number): string {
  if (step >= 10_000 && bp >= 1_000_000) {
    const decimals = step >= 100_000 ? 1 : 2;
    return `${(bp / 1_000_000).toFixed(decimals)}M`;
  }
  if (step >= 10 && bp >= 1_000) {
    const decimals = step >= 1_000 ? 0 : step >= 100 ? 1 : 2;
    return `${(bp / 1_000).toFixed(decimals)}K`;
  }
  return bp.toLocaleString('en-US');
}

export function truncateLabel(
  name: string,
  availablePixels: number,
  charWidth: number = 6.5,
  minChars: number = 4
): string | null {
  const maxChars = Math.floor(availablePixels / charWidth);
  if (maxChars >= name.length) return name;
  if (maxChars >= minChars) return name.slice(0, maxChars - 1) + '\u2026';
  return null;
}
