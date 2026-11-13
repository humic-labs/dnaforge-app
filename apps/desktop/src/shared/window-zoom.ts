export const MIN_WINDOW_ZOOM_FACTOR = 0.25;
export const MAX_WINDOW_ZOOM_FACTOR = 5;
export function isWindowZoomFactor(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_WINDOW_ZOOM_FACTOR &&
    value <= MAX_WINDOW_ZOOM_FACTOR
  );
}
export function parseWindowZoomFactor(value: string | null): number | null {
  if (!value?.trim()) return null;
  const factor = Number(value);
  return isWindowZoomFactor(factor) ? factor : null;
}
export type WindowZoomResult =
  | { status: 'applied'; factor: number }
  | { status: 'refused'; reason: 'invalid_factor' | 'window_unavailable' }
  | { status: 'failed'; reason: 'apply_failed'; factor: number | null }
  | { status: 'unavailable' };
