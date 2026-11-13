import type { CodonEdge } from './rendering';

interface CodonVisibility {
  startPos: number;
  endPos: number;
  visibleStart: number;
  visibleEnd: number;
}

export function computeCodonEdges(
  codon: CodonVisibility,
  idx: number,
  totalCodons: number,
  direction: 1 | -1,
  regionStart: number,
  regionEnd: number
): { leftEdge: CodonEdge; rightEdge: CodonEdge } {
  const isFirstInArray = idx === 0;
  const isLastInArray = idx === totalCodons - 1;

  const isLeftmostCodonOfRegion = codon.startPos === regionStart;
  const isRightmostCodonOfRegion = codon.endPos === regionEnd - 1;

  const isLeftmostOnScreen = direction === 1 ? isFirstInArray : isLastInArray;
  const isRightmostOnScreen = direction === 1 ? isLastInArray : isFirstInArray;

  const isPartialOnLeft = codon.visibleStart > codon.startPos;
  const isPartialOnRight = codon.visibleEnd < codon.endPos;

  let normalLeftEdge: CodonEdge;
  let normalRightEdge: CodonEdge;

  if (direction === 1) {
    normalRightEdge = 'chevron';
    if (isLeftmostCodonOfRegion) {
      normalLeftEdge = 'flat';
    } else if (isLeftmostOnScreen) {
      normalLeftEdge = 'flat';
    } else {
      normalLeftEdge = 'chevron';
    }
  } else {
    normalLeftEdge = 'chevron';
    if (isRightmostCodonOfRegion) {
      normalRightEdge = 'flat';
    } else if (isRightmostOnScreen) {
      normalRightEdge = 'flat';
    } else {
      normalRightEdge = 'chevron';
    }
  }

  return {
    leftEdge: isPartialOnLeft ? 'flat' : normalLeftEdge,
    rightEdge: isPartialOnRight ? 'flat' : normalRightEdge,
  };
}
