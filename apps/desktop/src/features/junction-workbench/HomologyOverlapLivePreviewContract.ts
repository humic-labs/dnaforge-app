import { reverseComplement } from '@waypoint/sequence-utils';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import {
  productOverlapBioRangeForField,
  rowBoundaryColumnForBioCol,
} from './ProductOverlapPreviewContract';
import type { JunctionWorkbenchRow } from './model';

export interface HomologyOverlapLivePreview {
  kind: 'homology';
  startBioCol: number;
  endBioCol: number;
  spacerLength: number;
  leftHomologyLength: number;
  rightHomologyLength: number;
  currentStartBioCol: number;
  currentEndBioCol: number;
  currentLeftHomologyLength: number;
  currentRightHomologyLength: number;
  forwardOverhang: string;
  forwardSpacerLength: number;
  reverseOverhang: string;
  reverseSpacerLength: number;
  productSequence: string;
  productAnchorRowPosition: number;
}

export function homologyOverlapLivePreviewForProductRow(
  productRow: JunctionWorkbenchRow,
  field: AssemblyWorkbenchEditableField,
  nextValue: number
): HomologyOverlapLivePreview | null {
  const range = productOverlapBioRangeForField(productRow, field, nextValue);
  if (!range || range.kind !== 'homology') return null;
  const currentRange = productOverlapBioRangeForField(productRow, field);
  if (!currentRange || currentRange.kind !== 'homology') return null;

  const forwardOverhangEndBioCol = range.spacerLength;
  const reverseOverhangStartBioCol = 0;
  const forwardOverhang = rowSequenceForOptionalBioRange(
    productRow,
    range.startBioCol,
    forwardOverhangEndBioCol
  );
  const reverseTemplate = rowSequenceForOptionalBioRange(
    productRow,
    reverseOverhangStartBioCol,
    range.endBioCol
  );
  if (forwardOverhang === null || reverseTemplate === null) return null;

  return {
    kind: 'homology',
    startBioCol: range.startBioCol,
    endBioCol: range.endBioCol,
    spacerLength: range.spacerLength,
    leftHomologyLength: range.leftHomologyLength,
    rightHomologyLength: range.rightHomologyLength,
    currentStartBioCol: currentRange.startBioCol,
    currentEndBioCol: currentRange.endBioCol,
    currentLeftHomologyLength: currentRange.leftHomologyLength,
    currentRightHomologyLength: currentRange.rightHomologyLength,
    forwardOverhang,
    forwardSpacerLength: spacerBasesInBioRange(
      range.startBioCol,
      forwardOverhangEndBioCol,
      range.spacerLength
    ),
    reverseOverhang: reverseComplement(reverseTemplate),
    reverseSpacerLength: spacerBasesInBioRange(
      reverseOverhangStartBioCol,
      range.endBioCol,
      range.spacerLength
    ),
    productSequence: productRow.sequence,
    productAnchorRowPosition: productRow.anchorRowPosition,
  };
}

export function homologyOverlapLivePrimersForRow(
  row: JunctionWorkbenchRow,
  preview: HomologyOverlapLivePreview,
  junctionIndex: number | undefined
): PrimerDisplay[] | null {
  const primers = row.primers ?? [];
  if (primers.length === 0) return null;
  return primers.map((primer) =>
    homologyOverlapLivePrimerForRow(row, primer, preview, junctionIndex)
  );
}

export function homologyOverlapLivePrimerForRow(
  row: JunctionWorkbenchRow,
  primer: PrimerDisplay,
  preview: HomologyOverlapLivePreview,
  junctionIndex: number | undefined
): PrimerDisplay {
  if (!primerMatchesHomologyJunction(primer, junctionIndex)) return primer;
  const currentOverhangLength = clampLength(primer.overhangLength ?? 0, primer.bases.length);
  const currentPbsBases = primer.bases.slice(currentOverhangLength);
  if (primer.direction === 'forward') {
    const currentPbsStartBioCol = forwardPbsStartBioCol(row, primer, currentPbsBases.length);
    const basePbsStartBioCol = forwardBasePbsStartBioCol(preview, currentPbsStartBioCol);
    const nextPbsStartBioCol = Math.max(preview.startBioCol, basePbsStartBioCol);
    const overhangEndBioCol = basePbsStartBioCol;
    const nextOverhang = productSequenceForPreviewRange(
      preview,
      preview.startBioCol,
      overhangEndBioCol
    );
    const nextPbsBases = adjustForwardPbsBases(
      preview,
      currentPbsBases,
      currentPbsStartBioCol,
      nextPbsStartBioCol
    );
    return livePrimerForHomologyParts(
      primer,
      nextOverhang,
      nextPbsBases,
      spacerBasesInBioRange(preview.startBioCol, overhangEndBioCol, preview.spacerLength)
    );
  }

  const productEndBioCol = preview.spacerLength + preview.rightHomologyLength;
  const currentPbsEndBioCol = reversePbsEndBioCol(row, primer, currentPbsBases.length);
  const basePbsEndBioCol = reverseBasePbsEndBioCol(preview, currentPbsEndBioCol);
  const nextPbsEndBioCol = Math.min(productEndBioCol, basePbsEndBioCol);
  const overhangStartBioCol = basePbsEndBioCol;
  const nextOverhang = reverseComplement(
    productSequenceForPreviewRange(preview, overhangStartBioCol, preview.endBioCol)
  );
  const nextPbsBases = adjustReversePbsBases(
    preview,
    currentPbsBases,
    currentPbsEndBioCol,
    nextPbsEndBioCol
  );
  return livePrimerForHomologyParts(
    primer,
    nextOverhang,
    nextPbsBases,
    spacerBasesInBioRange(overhangStartBioCol, preview.endBioCol, preview.spacerLength)
  );
}

function primerMatchesHomologyJunction(
  primer: PrimerDisplay,
  junctionIndex: number | undefined
): boolean {
  if (primer.isScarMarkerOnly) return false;
  if (primer.cutPositionInOverhang !== undefined) return false;
  if (junctionIndex === undefined) return true;
  return primer.junctionIndex === junctionIndex;
}

function forwardBasePbsStartBioCol(
  preview: HomologyOverlapLivePreview,
  currentPbsStartBioCol: number
): number {
  const currentSignedDerived =
    preview.currentLeftHomologyLength < 0 && currentPbsStartBioCol === preview.currentStartBioCol;
  return currentSignedDerived ? preview.spacerLength : currentPbsStartBioCol;
}

function reverseBasePbsEndBioCol(
  preview: HomologyOverlapLivePreview,
  currentPbsEndBioCol: number
): number {
  const currentProductEndBioCol = preview.spacerLength + preview.currentRightHomologyLength;
  const currentSignedDerived =
    currentProductEndBioCol < 0 && currentPbsEndBioCol === preview.currentEndBioCol;
  return currentSignedDerived ? 0 : currentPbsEndBioCol;
}

function livePrimerForHomologyParts(
  primer: PrimerDisplay,
  overhangBases: string,
  pbsBases: string,
  spacerLength: number
): PrimerDisplay {
  const nextOverhangLength = overhangBases.length;
  const pbsLength = pbsBases.length;

  if (primer.direction === 'forward') {
    return {
      ...primer,
      start: primer.end - pbsLength - nextOverhangLength,
      overhangLength: nextOverhangLength,
      spacerLength: normalizedSpacerLength(spacerLength, nextOverhangLength),
      bases: overhangBases + pbsBases,
    };
  }

  return {
    ...primer,
    end: primer.start + pbsLength + nextOverhangLength,
    overhangLength: nextOverhangLength,
    spacerLength: normalizedSpacerLength(spacerLength, nextOverhangLength),
    bases: overhangBases + pbsBases,
  };
}

function rowSequenceForOptionalBioRange(
  row: JunctionWorkbenchRow,
  startBioCol: number,
  endBioCol: number
): string | null {
  if (endBioCol <= startBioCol) return '';
  const start = rowBoundaryColumnForBioCol(row, startBioCol);
  const end = rowBoundaryColumnForBioCol(row, endBioCol);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || end > row.sequence.length) return null;
  return row.sequence.slice(start, end);
}

function productSequenceForPreviewRange(
  preview: HomologyOverlapLivePreview,
  startBioCol: number,
  endBioCol: number
): string {
  const start = preview.productAnchorRowPosition + startBioCol;
  const end = preview.productAnchorRowPosition + endBioCol;
  if (start < 0 || end < start || end > preview.productSequence.length) return '';
  return preview.productSequence.slice(start, end);
}

function forwardPbsStartBioCol(
  row: JunctionWorkbenchRow,
  primer: PrimerDisplay,
  pbsLength: number
): number {
  return primer.end - pbsLength - row.anchorRowPosition;
}

function reversePbsEndBioCol(
  row: JunctionWorkbenchRow,
  primer: PrimerDisplay,
  pbsLength: number
): number {
  return primer.start + pbsLength - row.anchorRowPosition;
}

function adjustForwardPbsBases(
  preview: HomologyOverlapLivePreview,
  currentPbsBases: string,
  currentPbsStartBioCol: number,
  nextPbsStartBioCol: number
): string {
  const delta = Math.round(nextPbsStartBioCol - currentPbsStartBioCol);
  if (delta === 0) return currentPbsBases;
  if (delta > 0) return currentPbsBases.slice(delta);
  return (
    productSequenceForPreviewRange(preview, nextPbsStartBioCol, currentPbsStartBioCol) +
    currentPbsBases
  );
}

function adjustReversePbsBases(
  preview: HomologyOverlapLivePreview,
  currentPbsBases: string,
  currentPbsEndBioCol: number,
  nextPbsEndBioCol: number
): string {
  const delta = Math.round(currentPbsEndBioCol - nextPbsEndBioCol);
  if (delta === 0) return currentPbsBases;
  if (delta > 0) return currentPbsBases.slice(delta);
  return (
    reverseComplement(
      productSequenceForPreviewRange(preview, currentPbsEndBioCol, nextPbsEndBioCol)
    ) + currentPbsBases
  );
}

function spacerBasesInBioRange(
  startBioCol: number,
  endBioCol: number,
  spacerLength: number
): number {
  return Math.max(0, Math.min(endBioCol, spacerLength) - Math.max(startBioCol, 0));
}

function normalizedSpacerLength(spacerLength: number, overhangLength: number): number | undefined {
  const clamped = Math.max(0, Math.min(Math.round(spacerLength), overhangLength));
  return clamped > 0 ? clamped : undefined;
}

function clampLength(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.round(value)));
}
