import type { SequenceDrawingContext } from './rendering/drawing-context';
import { RESIDUE_NUMBER_ROW_HEIGHT } from './layout-constants';

export type ResidueNumberCell = {
  residueIndex?: number;
  codonX: number;
  visibleWidth: number;
};

export function residueNumberStepForPixelsPerCodon(pixelsPerCodon: number): number {
  if (pixelsPerCodon >= 30) return 1;
  if (pixelsPerCodon >= 15) return 2;
  if (pixelsPerCodon >= 8) return 5;
  if (pixelsPerCodon >= 4) return 10;
  if (pixelsPerCodon >= 2) return 20;
  if (pixelsPerCodon >= 1) return 50;
  return 100;
}

export function intronBoundaryResidueIndices(
  renderData: readonly ResidueNumberCell[]
): Set<number> {
  const boundaryIndices = new Set<number>();
  const sortedByResidue = renderData
    .filter((rd) => rd.residueIndex !== undefined)
    .sort((a, b) => a.residueIndex! - b.residueIndex!);
  for (let i = 0; i < sortedByResidue.length - 1; i++) {
    const curr = sortedByResidue[i]!.residueIndex!;
    const next = sortedByResidue[i + 1]!.residueIndex!;
    if (next > curr + 1) {
      boundaryIndices.add(curr);
      boundaryIndices.add(next);
    }
  }
  return boundaryIndices;
}

export function paintCdsResidueNumbers(args: {
  ctx: SequenceDrawingContext;
  renderData: readonly ResidueNumberCell[];
  aaY: number;
  aaTrackHeight: number;
  charWidth: number;
  labelFontFamily: string;
  isDark: boolean;
}): void {
  const residueY = args.aaY + args.aaTrackHeight;
  const residueRowMidY = residueY + RESIDUE_NUMBER_ROW_HEIGHT / 2;
  const step = residueNumberStepForPixelsPerCodon(args.charWidth * 3);
  const boundaryIndices = intronBoundaryResidueIndices(args.renderData);
  args.ctx.save();
  args.ctx.font = `400 9px ${args.labelFontFamily}`;
  args.ctx.textAlign = 'center';
  args.ctx.textBaseline = 'middle';
  args.ctx.fillStyle = args.isDark ? 'rgba(200,200,200,0.55)' : 'rgba(0,0,0,0.4)';
  for (const rd of args.renderData) {
    if (rd.residueIndex === undefined) continue;
    const shouldRender =
      rd.residueIndex === 1 || rd.residueIndex % step === 0 || boundaryIndices.has(rd.residueIndex);
    if (!shouldRender) continue;
    args.ctx.fillText(String(rd.residueIndex), rd.codonX + rd.visibleWidth / 2, residueRowMidY);
  }
  args.ctx.restore();
}
