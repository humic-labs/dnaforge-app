const LABEL_BOUNDARY_GUTTER_PX = 2;

export interface CytobandLabelLayoutInput {
  readonly chromosomeId: string;
  readonly text: string;
  readonly textWidthPx: number;
  readonly leftPx: number;
  readonly rightPx: number;
}

export interface CytobandLabelLayout {
  readonly chromosomeId: string;
  readonly text: string;
  readonly visible: boolean;
  readonly memberLeftPx: number;
  readonly memberRightPx: number;
  readonly labelLeftPx: number | null;
  readonly labelRightPx: number | null;
}

export function compactCytobandLabel(displayName: string): string {
  const match = /^chr(\d+|[XYM])$/i.exec(displayName.trim());
  return match ? match[1].toUpperCase() : displayName;
}

export function estimateCytobandLabelWidthPx(text: string): number {
  return [...text].reduce(
    (widthPx, character) => widthPx + (/^[\x20-\x7e]$/.test(character) ? 7 : 10),
    0
  );
}

export function layoutCytobandLabels(
  inputs: ReadonlyArray<CytobandLabelLayoutInput>
): CytobandLabelLayout[] {
  let previousVisibleRightPx = Number.NEGATIVE_INFINITY;

  return inputs.map(({ chromosomeId, text, textWidthPx, leftPx, rightPx }) => {
    const hasValidGeometry =
      text.length > 0 &&
      Number.isFinite(textWidthPx) &&
      Number.isFinite(leftPx) &&
      Number.isFinite(rightPx) &&
      textWidthPx >= 0 &&
      rightPx > leftPx;
    const availableWidthPx = rightPx - leftPx - LABEL_BOUNDARY_GUTTER_PX * 2;
    const centeredLeftPx = leftPx + (rightPx - leftPx - textWidthPx) / 2;
    const centeredRightPx = centeredLeftPx + textWidthPx;
    const fitsMember =
      hasValidGeometry &&
      textWidthPx <= availableWidthPx &&
      centeredLeftPx >= leftPx + LABEL_BOUNDARY_GUTTER_PX &&
      centeredRightPx <= rightPx - LABEL_BOUNDARY_GUTTER_PX;
    const doesNotOverlapPrevious =
      centeredLeftPx >= previousVisibleRightPx + LABEL_BOUNDARY_GUTTER_PX;
    const visible = fitsMember && doesNotOverlapPrevious;

    if (visible) previousVisibleRightPx = centeredRightPx;

    return {
      chromosomeId,
      text,
      visible,
      memberLeftPx: leftPx,
      memberRightPx: rightPx,
      labelLeftPx: visible ? centeredLeftPx : null,
      labelRightPx: visible ? centeredRightPx : null,
    };
  });
}

export function findCytobandLabelIndexAtX(
  layouts: ReadonlyArray<CytobandLabelLayout>,
  x: number,
  horizontalPaddingPx = 0
): number {
  if (!Number.isFinite(x)) return -1;
  const paddingPx = Number.isFinite(horizontalPaddingPx) ? Math.max(0, horizontalPaddingPx) : 0;

  return layouts.findIndex(
    ({ visible, memberLeftPx, memberRightPx, labelLeftPx, labelRightPx }) =>
      visible &&
      labelLeftPx !== null &&
      labelRightPx !== null &&
      x >= Math.max(memberLeftPx, labelLeftPx - paddingPx) &&
      x <= Math.min(memberRightPx, labelRightPx + paddingPx)
  );
}
