import type { PrimerDisplay } from '@waypoint/workspace-editor';
import { reverseComplement } from '@waypoint/sequence-utils';
import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import {
  productOverlapBioRangeForField,
  rowBoundaryColumnForBioCol,
} from './ProductOverlapPreviewContract';
import type { JunctionWorkbenchRow } from './model';
import { productOwnerForPoint, type WorkbenchPaintOwner } from './WorkbenchPaintingContract';

export interface GoldenGateOverhangLivePreview {
  kind: 'goldengate-overhang';
  startBioCol: number;
  endBioCol: number;
  spacerLength: number;
  overhang: string;
  leftCount: number;
  rightCount: number;
  spacerCount: number;
  productBasesByBioCol: ReadonlyMap<number, string>;
  productOwnersByBioCol: ReadonlyMap<number, WorkbenchPaintOwner>;
}

export function goldenGateOverhangLivePreviewForProductRow(
  productRow: JunctionWorkbenchRow,
  field: AssemblyWorkbenchEditableField,
  nextValue: number
): GoldenGateOverhangLivePreview | null {
  const range = productOverlapBioRangeForField(productRow, field, nextValue);
  if (!range || range.kind !== 'goldengate-overhang') return null;

  const productBasesByBioCol = new Map<number, string>();
  const productOwnersByBioCol = new Map<number, WorkbenchPaintOwner>();
  let overhang = '';
  let leftCount = 0;
  let rightCount = 0;
  let spacerCount = 0;

  const supportStartBioCol = Math.min(0, range.startBioCol);
  const supportEndBioCol = Math.max(range.spacerLength, range.endBioCol);
  for (let bioCol = supportStartBioCol; bioCol < supportEndBioCol; bioCol++) {
    const point = pointForBioCol(productRow, bioCol);
    if (!point) return null;
    const base = productRow.sequence[point.rowPosition];
    if (!base) return null;
    const owner = productOwnerForPoint(productRow, point);
    productBasesByBioCol.set(bioCol, base);
    productOwnersByBioCol.set(bioCol, owner);
    if (bioCol < range.startBioCol || bioCol >= range.endBioCol) continue;
    overhang += base;
    if (owner === 'left') leftCount++;
    else if (owner === 'right') rightCount++;
    else spacerCount++;
  }

  if (overhang.length !== 4) return null;
  return {
    kind: 'goldengate-overhang',
    startBioCol: range.startBioCol,
    endBioCol: range.endBioCol,
    spacerLength: range.spacerLength,
    overhang,
    leftCount,
    rightCount,
    spacerCount,
    productBasesByBioCol,
    productOwnersByBioCol,
  };
}

export function goldenGateOverhangLivePrimersForRow(
  row: JunctionWorkbenchRow,
  preview: GoldenGateOverhangLivePreview,
  junctionIndex: number | undefined
): PrimerDisplay[] | null {
  const primers = row.primers ?? [];
  if (primers.length === 0) return null;
  return primers.map((primer) =>
    goldenGateOverhangLivePrimerForRow(row, primer, preview, junctionIndex)
  );
}

export function goldenGateOverhangLivePrimerForRow(
  row: JunctionWorkbenchRow,
  primer: PrimerDisplay,
  preview: GoldenGateOverhangLivePreview,
  junctionIndex: number | undefined
): PrimerDisplay {
  if (!primerMatchesGoldenGateJunction(primer, junctionIndex)) return primer;
  const cut = primer.cutPositionInOverhang;
  const overhangLength = primer.overhangLength ?? 0;
  if (
    cut === undefined ||
    cut < 0 ||
    cut + 4 > overhangLength ||
    overhangLength > primer.bases.length
  ) {
    return primer;
  }

  const pbsLength = Math.max(0, primer.bases.length - overhangLength);
  const prefix = resizedBases(primer.bases.slice(0, cut), cut);
  if (primer.direction === 'forward') {
    return forwardGoldenGatePrimerForPreview(row, primer, preview, {
      cut,
      pbsLength,
      prefix,
    });
  }
  return reverseGoldenGatePrimerForPreview(row, primer, preview, {
    cut,
    pbsLength,
    prefix,
  });
}

function forwardGoldenGatePrimerForPreview(
  row: JunctionWorkbenchRow,
  primer: PrimerDisplay,
  preview: GoldenGateOverhangLivePreview,
  input: { cut: number; pbsLength: number; prefix: string }
): PrimerDisplay {
  const literalStart = preview.endBioCol;
  const literalEnd = Math.max(preview.endBioCol, preview.spacerLength);
  const literalExtra =
    literalEnd > literalStart ? productPreviewSequence(preview, literalStart, literalEnd) : '';
  if (literalExtra === null) return primer;
  const pbsStartBioCol = Math.max(preview.spacerLength, preview.endBioCol);
  const pbsEndBioCol = pbsStartBioCol + input.pbsLength;
  const pbsBases =
    rowSequenceForBioRange(row, pbsStartBioCol, pbsEndBioCol) ??
    resizedBases(primer.bases.slice(primer.overhangLength ?? 0), input.pbsLength);
  const nextOverhangLength = input.cut + 4 + literalExtra.length;
  const pbsStart = rowBoundaryColumnForBioCol(row, pbsStartBioCol);
  const nextBases = input.prefix + preview.overhang + literalExtra + pbsBases;

  if (nextBases.length !== nextOverhangLength + input.pbsLength) return primer;
  return {
    ...primer,
    start: pbsStart - nextOverhangLength,
    end: pbsStart + input.pbsLength,
    bases: nextBases,
    overhangLength: nextOverhangLength,
    scarAbsolutePosition: rowBoundaryColumnForBioCol(row, preview.startBioCol),
    cognate4bpLength: preview.rightCount,
    synthetic4bpSpacerLength: preview.spacerCount > 0 ? preview.spacerCount : undefined,
    spacerLength:
      countProductOwners(preview, literalStart, literalEnd, 'spacer') > 0
        ? countProductOwners(preview, literalStart, literalEnd, 'spacer')
        : undefined,
  };
}

function reverseGoldenGatePrimerForPreview(
  row: JunctionWorkbenchRow,
  primer: PrimerDisplay,
  preview: GoldenGateOverhangLivePreview,
  input: { cut: number; pbsLength: number; prefix: string }
): PrimerDisplay {
  const literalStart = 0;
  const literalEnd = Math.max(0, preview.startBioCol);
  const literalForward =
    literalEnd > literalStart ? productPreviewSequence(preview, literalStart, literalEnd) : '';
  if (literalForward === null) return primer;
  const literalExtra = reverseComplement(literalForward);
  const pbsEndBioCol = Math.min(0, preview.startBioCol);
  const pbsStartBioCol = pbsEndBioCol - input.pbsLength;
  const pbsTemplate =
    rowSequenceForBioRange(row, pbsStartBioCol, pbsEndBioCol) ??
    reverseComplement(
      resizedBases(primer.bases.slice(primer.overhangLength ?? 0), input.pbsLength)
    );
  const pbsBases = reverseComplement(pbsTemplate);
  const nextOverhangLength = input.cut + 4 + literalExtra.length;
  const pbsStart = rowBoundaryColumnForBioCol(row, pbsStartBioCol);
  const pbsEnd = rowBoundaryColumnForBioCol(row, pbsEndBioCol);
  const nextBases = input.prefix + reverseComplement(preview.overhang) + literalExtra + pbsBases;

  if (nextBases.length !== nextOverhangLength + input.pbsLength) return primer;
  return {
    ...primer,
    start: pbsStart,
    end: pbsEnd + nextOverhangLength,
    bases: nextBases,
    overhangLength: nextOverhangLength,
    scarAbsolutePosition: rowBoundaryColumnForBioCol(row, preview.startBioCol),
    cognate4bpLength: preview.leftCount,
    synthetic4bpSpacerLength: preview.spacerCount > 0 ? preview.spacerCount : undefined,
    spacerLength:
      countProductOwners(preview, literalStart, literalEnd, 'spacer') > 0
        ? countProductOwners(preview, literalStart, literalEnd, 'spacer')
        : undefined,
  };
}

function primerMatchesGoldenGateJunction(
  primer: PrimerDisplay,
  junctionIndex: number | undefined
): boolean {
  if (primer.isScarMarkerOnly) return false;
  if (primer.cutPositionInOverhang === undefined) return false;
  if (junctionIndex === undefined) return true;
  return primer.junctionIndex === junctionIndex;
}

function productPreviewSequence(
  preview: GoldenGateOverhangLivePreview,
  startBioCol: number,
  endBioCol: number
): string | null {
  let sequence = '';
  for (let bioCol = startBioCol; bioCol < endBioCol; bioCol++) {
    const base = preview.productBasesByBioCol.get(bioCol);
    if (!base) return null;
    sequence += base;
  }
  return sequence;
}

function rowSequenceForBioRange(
  row: JunctionWorkbenchRow,
  startBioCol: number,
  endBioCol: number
): string | null {
  const start = rowBoundaryColumnForBioCol(row, startBioCol);
  const end = rowBoundaryColumnForBioCol(row, endBioCol);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || end > row.sequence.length) return null;
  return row.sequence.slice(start, end);
}

function countProductOwners(
  preview: GoldenGateOverhangLivePreview,
  startBioCol: number,
  endBioCol: number,
  owner: WorkbenchPaintOwner
): number {
  let count = 0;
  for (let bioCol = startBioCol; bioCol < endBioCol; bioCol++) {
    if (preview.productOwnersByBioCol.get(bioCol) === owner) count++;
  }
  return count;
}

function pointForBioCol(
  row: JunctionWorkbenchRow,
  bioCol: number
): { bioCol: number; rowPosition: number } | null {
  return row.points.find((point) => point.bioCol === bioCol) ?? null;
}

function resizedBases(bases: string, length: number): string {
  if (length <= 0) return '';
  if (bases.length === length) return bases;
  if (bases.length > length) return bases.slice(0, length);
  return bases + 'N'.repeat(length - bases.length);
}
