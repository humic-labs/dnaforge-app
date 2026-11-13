export { SEQUENCE_FONT_FAMILY } from './fonts';
export const SEQUENCE_LABEL_FONT_FAMILY = 'Inter, system-ui, -apple-system, sans-serif';
export const CODON_FONT_WEIGHT = '500';
export const codonFontSize = (sequenceFontSize: number): number =>
  Math.max(1, Math.round(sequenceFontSize * 1.15));
export const CODON_CHEVRON_DEPTH_RATIO = 0.17;
export const CODON_OUTLINE_WIDTH = 1.25;

export const SEQUENCE_SELECTION_FILL = {
  light: { color: 0xffffc8, alpha: 1 },
  dark: { color: 0xb4a032, alpha: 0.25 },
} as const;

export function sequenceSelectionFillCss(mode: 'light' | 'dark'): string {
  const { color, alpha } = SEQUENCE_SELECTION_FILL[mode];
  const rgb = `${(color >> 16) & 0xff}, ${(color >> 8) & 0xff}, ${color & 0xff}`;
  return alpha === 1 ? `rgb(${rgb})` : `rgba(${rgb}, ${alpha})`;
}

export const TRANSCRIPT_INTRON_STYLE = {
  heightRatio: 0.12,
  utrHeightRatio: 0.62,
  tickHalfWidth: 1.875,
  tickHalfHeight: 2.25,
  minTickSpacing: 50,
  minVisibleWidth: 12,
  fullOpacityWidth: 64,
} as const;

export function intronTickPitch(pxPerBp: number): number {
  if (!(pxPerBp > 0) || !Number.isFinite(pxPerBp)) return Infinity;
  const base = 1 << 20;
  return (
    base /
    2 **
      Math.max(0, Math.floor(Math.log2((base * pxPerBp) / TRANSCRIPT_INTRON_STYLE.minTickSpacing)))
  );
}

export function intronTickAlpha(widthPx: number): number {
  return (
    Math.max(
      0,
      Math.min(
        1,
        (widthPx - TRANSCRIPT_INTRON_STYLE.minVisibleWidth) /
          (TRANSCRIPT_INTRON_STYLE.fullOpacityWidth - TRANSCRIPT_INTRON_STYLE.minVisibleWidth)
      )
    ) * 0.8
  );
}
