export const RETAINED_SUBPIXEL_MIN_WIDTH_PX = 1.0;
export const RETAINED_SUBPIXEL_ALPHA_GAMMA = 0.22;
export const RETAINED_SUBPIXEL_MIN_ALPHA_SCALE = 0;

export interface RetainedSubpixelOpacityPolicy {
  minWidthPx: number;
  alphaGamma: number;
  minAlphaScale: number;
}

export type RetainedSubpixelSurfaceKind = 'discrete-mark' | 'continuous-fill';

const CONTINUOUS_FILL_SUBPIXEL_POLICY: RetainedSubpixelOpacityPolicy = {
  minWidthPx: 0,
  alphaGamma: 1,
  minAlphaScale: 1,
};

export function retainedSubpixelOpacityPolicy(
  surfaceKind: RetainedSubpixelSurfaceKind = 'discrete-mark'
): RetainedSubpixelOpacityPolicy {
  if (surfaceKind === 'continuous-fill') return CONTINUOUS_FILL_SUBPIXEL_POLICY;
  return {
    minWidthPx: RETAINED_SUBPIXEL_MIN_WIDTH_PX,
    alphaGamma: RETAINED_SUBPIXEL_ALPHA_GAMMA,
    minAlphaScale: RETAINED_SUBPIXEL_MIN_ALPHA_SCALE,
  };
}

export function retainedSubpixelAlphaScale(
  actualWidthPx: number,
  policy: RetainedSubpixelOpacityPolicy = retainedSubpixelOpacityPolicy()
): number {
  if (!Number.isFinite(actualWidthPx) || actualWidthPx <= 0) return 0;
  const minWidth = Math.max(0, policy.minWidthPx);
  if (actualWidthPx >= minWidth) return 1;
  const supportWidth = Math.max(actualWidthPx, minWidth, 1e-6);
  const coverage = Math.max(0, Math.min(1, actualWidthPx / supportWidth));
  const gamma = Math.max(0.01, policy.alphaGamma);
  const minAlpha = Math.max(0, Math.min(1, policy.minAlphaScale));
  return Math.min(1, Math.max(minAlpha, coverage ** gamma));
}

export interface RetainedSubpixelCompositeStyle {
  rgb: [number, number, number];
  alpha: number;
}

export function retainedSubpixelOpacityCompositeStyle(
  color: [number, number, number],
  baseAlpha: number,
  actualWidthPx: number,
  policy: RetainedSubpixelOpacityPolicy = retainedSubpixelOpacityPolicy()
): RetainedSubpixelCompositeStyle {
  const fullAlpha = clamp01(baseAlpha);
  return {
    rgb: color,
    alpha: fullAlpha * retainedSubpixelAlphaScale(actualWidthPx, policy),
  };
}

export function compositeOverBackground(
  style: RetainedSubpixelCompositeStyle,
  background: [number, number, number] = [1, 1, 1]
): [number, number, number] {
  return [
    style.rgb[0] * style.alpha + background[0] * (1 - style.alpha),
    style.rgb[1] * style.alpha + background[1] * (1 - style.alpha),
    style.rgb[2] * style.alpha + background[2] * (1 - style.alpha),
  ];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
