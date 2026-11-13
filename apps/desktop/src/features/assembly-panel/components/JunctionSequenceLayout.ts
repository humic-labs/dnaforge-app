export interface JunctionSequenceGeometry {
  pxBeforeJunction: number;
  pxTotal: number;
}

export interface AlignedJunctionSequenceLayout {
  alignOffsets: number[];
  sharedSvgWidth: number;
}

export function calculateAlignedJunctionSequenceLayout(
  rows: JunctionSequenceGeometry[],
  trailingPaddingPx = 20
): AlignedJunctionSequenceLayout {
  const maxBeforeJunction = Math.max(0, ...rows.map((row) => row.pxBeforeJunction));
  const alignOffsets = rows.map((row) => maxBeforeJunction - row.pxBeforeJunction);
  const sharedSvgWidth =
    Math.max(0, ...rows.map((row, index) => alignOffsets[index] + Math.max(0, row.pxTotal))) +
    trailingPaddingPx;

  return { alignOffsets, sharedSvgWidth };
}
