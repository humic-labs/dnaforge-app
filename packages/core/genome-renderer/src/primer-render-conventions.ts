export const PRIMER_RENDER_ID_OFFSET = 1_000_000_000;

export const PRIMER_COLOR = 0xd97706;

export function primerRenderIdAt(index: number): number {
  return PRIMER_RENDER_ID_OFFSET + index;
}

export function primerIndexFromRenderId(renderId: number): number | null {
  return renderId >= PRIMER_RENDER_ID_OFFSET ? renderId - PRIMER_RENDER_ID_OFFSET : null;
}
