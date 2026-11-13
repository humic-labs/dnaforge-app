export interface ImageSize {
  width: number;
  height: number;
}
export type ImageZoom = 'fit' | number;
export const IMAGE_ZOOM_PRESETS = [25, 50, 100, 200] as const;
export const IMAGE_MIN_ZOOM = 0.25;
export const IMAGE_MAX_ZOOM = 2;

export function imageFitScale(natural: ImageSize | null, viewport: ImageSize): number | null {
  if (
    !natural ||
    ![natural.width, natural.height, viewport.width, viewport.height].every(
      (value) => Number.isFinite(value) && value > 0
    )
  )
    return null;
  return Math.min(1, viewport.width / natural.width, viewport.height / natural.height);
}

export function stepImageScale(current: number, direction: 1 | -1): number {
  if (!Number.isFinite(current) || current <= 0) return current;
  const scales = IMAGE_ZOOM_PRESETS.map((value) => value / 100);
  if (direction > 0) {
    if (current >= IMAGE_MAX_ZOOM) return current;
    return scales.find((value) => value > current + 1e-9) ?? IMAGE_MAX_ZOOM;
  }
  if (current <= IMAGE_MIN_ZOOM) return current;
  return [...scales].reverse().find((value) => value < current - 1e-9) ?? IMAGE_MIN_ZOOM;
}
