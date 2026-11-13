import { selectAssemblyBoundaryMap } from './assembly-boundaries';
import { getEffectiveDesignRegions } from './restriction-digest';
import type { SequenceDesign } from './types';

export interface ProductHighlight {
  position: number;
  start: number;
  end: number;
}

export function productHighlightForRegionIndex(
  design: SequenceDesign,
  regionIndex: number
): ProductHighlight | null {
  return productHighlightsByRegionIndex(design)[regionIndex] ?? null;
}

export function productHighlightsByRegionIndex(
  design: SequenceDesign
): (ProductHighlight | null)[] {
  const effectiveRegions = getEffectiveDesignRegions(design);
  const boundariesByJunction = selectAssemblyBoundaryMap(design);
  const highlights: (ProductHighlight | null)[] = [];
  let position = 0;

  for (let index = 0; index < effectiveRegions.length; index += 1) {
    const length = effectiveRegions[index].sequence.length;
    highlights.push(
      length <= 0 ? null : { position: position + 1, start: position, end: position + length - 1 }
    );
    position += length;
    position += boundariesByJunction.get(index)?.spacer?.sequence.length ?? 0;
  }

  return highlights;
}
