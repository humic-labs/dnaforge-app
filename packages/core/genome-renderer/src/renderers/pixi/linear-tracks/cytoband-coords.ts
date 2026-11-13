export function bpToChromosomeScaleX(bp: number, chromLength: number, widthPx: number): number {
  return (bp / chromLength) * widthPx;
}

export function chromosomeScaleXToBp(localX: number, chromLength: number, widthPx: number): number {
  if (widthPx === 0) return 0;
  return (localX / widthPx) * chromLength;
}

export function acenChevronSide<TBand extends { stain: string }>(
  bands: ReadonlyArray<TBand>,
  index: number
): 'left' | 'right' {
  const prev = bands[index - 1];
  if (!prev || prev.stain !== 'acen') return 'left';
  return 'right';
}
