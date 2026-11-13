export const PILEUP_READ_DENSITY_SUPERSAMPLE_X = 2;
export const PILEUP_MAX_COLUMN_BARS = 8192;

export function pileupDensitySampleColumnCount(viewportWidthPx: number): number {
  return Math.min(
    PILEUP_MAX_COLUMN_BARS,
    Math.max(1, Math.round(viewportWidthPx * PILEUP_READ_DENSITY_SUPERSAMPLE_X))
  );
}
