export function validateTraceQuality(
  quality: ReadonlyArray<number> | undefined,
  peakCount: number
): void {
  if (
    quality !== undefined &&
    (!Array.isArray(quality) || (quality.length !== 0 && quality.length !== peakCount))
  ) {
    throw new Error('Quality values do not match the called bases.');
  }
  for (const value of quality ?? []) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error('Quality values do not match the called bases.');
    }
  }
}
