export const ASSUMED_READ_LENGTH_BP = 150;
const READ_LOD_FADE_START_READ_PX = 0.6;
const READ_LOD_FADE_END_READ_PX = 3.6;
const READ_DETAIL_PREPARATION_START_READ_PX = 1.5;

export function pileupExactReadZoomAlpha(pixelsPerBp: number): number {
  if (!Number.isFinite(pixelsPerBp) || pixelsPerBp <= 0) return 0;
  return smoothstep(
    READ_LOD_FADE_START_READ_PX,
    READ_LOD_FADE_END_READ_PX,
    pixelsPerBp * ASSUMED_READ_LENGTH_BP
  );
}

export function pileupExactReadPreparationEligible(pixelsPerBp: number): boolean {
  return (
    Number.isFinite(pixelsPerBp) &&
    pixelsPerBp > 0 &&
    pixelsPerBp * ASSUMED_READ_LENGTH_BP >= READ_DETAIL_PREPARATION_START_READ_PX
  );
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
