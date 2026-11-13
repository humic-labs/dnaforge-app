import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import type { CoordMappingConstraint } from './coord-mapping';
import type { JunctionFieldHandle } from './JunctionHandleOverlay';
import type { JunctionWorkbenchRow } from './model';

export interface ProductOverlapBioRange {
  kind: 'homology' | 'goldengate-overhang';
  startBioCol: number;
  endBioCol: number;
  spacerLength: number;
  leftHomologyLength: number;
  rightHomologyLength: number;
}

export interface ProductOverlapLivePreviewInput {
  row: JunctionWorkbenchRow;
  handle: JunctionFieldHandle;
  nextValue: number;
  scrollLeft: number;
  screenXForBioCol: (bioCol: number) => number;
}

export function productOverlapBioRangeForField(
  row: JunctionWorkbenchRow,
  field: AssemblyWorkbenchEditableField,
  nextValue: number = numericFieldValue(field) ?? 0
): ProductOverlapBioRange | null {
  if (row.kind !== 'product') return null;
  if (field.kind === 'goldenGateOverhang') {
    return productGoldenGateOverhangBioRangeForField(row, field, nextValue);
  }
  if (field.kind !== 'homologyArm') return null;
  const side = field.target.side;
  if (side !== 'left' && side !== 'right') return null;

  const constraint = row.constraints?.find((item) => item.kind === 'homology-width') ?? null;
  const spacerLength = productSpacerLength(row, field, constraint);
  const current = homologyLengthsForField(field, constraint, spacerLength);
  if (!current) return null;

  const snappedValue = Math.round(nextValue);
  const leftHomologyLength = side === 'left' ? snappedValue : current.onLeft;
  const rightHomologyLength = side === 'right' ? snappedValue : current.onRight;
  const range = homologyProductTailRangeForLengths({
    constraint,
    spacerLength,
    current,
    side,
    leftHomologyLength,
    rightHomologyLength,
  });
  return {
    kind: 'homology',
    startBioCol: range.startBioCol,
    endBioCol: range.endBioCol,
    spacerLength,
    leftHomologyLength,
    rightHomologyLength,
  };
}

export function productOverlapBoundaryBioColForField(
  row: JunctionWorkbenchRow,
  field: AssemblyWorkbenchEditableField,
  nextValue?: number
): number | null {
  const range = productOverlapBioRangeForField(row, field, nextValue);
  if (!range) return null;
  if (range.kind === 'goldengate-overhang') return (range.startBioCol + range.endBioCol) / 2;
  return field.target.side === 'left' ? range.startBioCol : range.endBioCol;
}

export function applyProductOverlapLivePreview(
  root: HTMLElement | null,
  input: ProductOverlapLivePreviewInput
): boolean {
  if (!root) return false;
  const range = productOverlapBioRangeForField(input.row, input.handle.field, input.nextValue);
  if (!range) return false;

  const startX = round2(input.screenXForBioCol(range.startBioCol) - input.scrollLeft);
  const endX = round2(input.screenXForBioCol(range.endBioCol) - input.scrollLeft);
  const startRowPosition = rowBoundaryColumnForBioCol(input.row, range.startBioCol);
  const endRowPosition = rowBoundaryColumnForBioCol(input.row, range.endBioCol);

  root.dataset.liveOverlapPreviewActive = 'true';
  root.dataset.liveOverlapKind = range.kind;
  root.dataset.liveOverlapStartBioCol = String(range.startBioCol);
  root.dataset.liveOverlapEndBioCol = String(range.endBioCol);
  root.dataset.liveOverlapStartRowPosition = String(startRowPosition);
  root.dataset.liveOverlapEndRowPosition = String(endRowPosition);
  root.dataset.liveOverlapCrossoverLength = String(range.endBioCol - range.startBioCol);
  root.dataset.liveOverlapSpacerLength = String(range.spacerLength);

  applyLiveBoundary(root, 'start', startX, range.startBioCol);
  applyLiveBoundary(root, 'end', endX, range.endBioCol);
  if (range.kind === 'homology') {
    applyLiveGibsonCut(root, {
      topBioCol: range.endBioCol,
      bottomBioCol: range.startBioCol,
      topX: endX,
      bottomX: startX,
      topRowPosition: endRowPosition,
      bottomRowPosition: startRowPosition,
    });
  }
  return true;
}

export function clearProductOverlapLivePreview(root: HTMLElement | null): void {
  if (!root) return;
  delete root.dataset.liveOverlapPreviewActive;
  delete root.dataset.liveOverlapKind;
  delete root.dataset.liveOverlapStartBioCol;
  delete root.dataset.liveOverlapEndBioCol;
  delete root.dataset.liveOverlapStartRowPosition;
  delete root.dataset.liveOverlapEndRowPosition;
  delete root.dataset.liveOverlapCrossoverLength;
  delete root.dataset.liveOverlapSpacerLength;

  root
    .querySelectorAll<HTMLElement>('[data-overlap-boundary-role][data-overlap-canonical-left-px]')
    .forEach((element) => {
      element.style.left = `${element.dataset.overlapCanonicalLeftPx}px`;
      delete element.dataset.liveOverlapBioCol;
      delete element.dataset.liveOverlapPreviewActive;
    });

  root
    .querySelectorAll<SVGPathElement>('[data-gibson-virtual-cut-id="gibson-resection"]')
    .forEach((path) => {
      restoreCanonicalPathAttribute(path, 'd', 'canonicalD');
      restoreCanonicalPathAttribute(path, 'data-top-bio-col', 'canonicalTopBioCol');
      restoreCanonicalPathAttribute(path, 'data-bottom-bio-col', 'canonicalBottomBioCol');
      restoreCanonicalPathAttribute(path, 'data-top-row-position', 'canonicalTopRowPosition');
      restoreCanonicalPathAttribute(path, 'data-bottom-row-position', 'canonicalBottomRowPosition');
      restoreCanonicalPathAttribute(path, 'data-overhang-direction', 'canonicalOverhangDirection');
      delete path.dataset.liveOverlapPreviewActive;
    });
}

function productGoldenGateOverhangBioRangeForField(
  row: JunctionWorkbenchRow,
  field: AssemblyWorkbenchEditableField,
  nextValue: number
): ProductOverlapBioRange | null {
  const constraint = row.constraints?.find((item) => item.kind === 'fixed-overhang') ?? null;
  const previewRange = goldenGatePreviewRangePayload(field);
  const baseStartBioCol = previewRange?.startBioCol ?? constraint?.startBioCol;
  const baseEndBioCol = previewRange?.endBioCol ?? constraint?.endBioCol;
  if (
    !isFiniteNumber(baseStartBioCol) ||
    !isFiniteNumber(baseEndBioCol) ||
    baseEndBioCol <= baseStartBioCol
  ) {
    return null;
  }
  const currentOffset = numericFieldValue(field);
  if (currentOffset === null) return null;
  const snappedOffset = Math.round(nextValue);
  const delta = snappedOffset - Math.round(currentOffset);
  const startBioCol = baseStartBioCol + delta;
  const endBioCol = baseEndBioCol + delta;
  return {
    kind: 'goldengate-overhang',
    startBioCol,
    endBioCol,
    spacerLength: previewRange?.spacerLength ?? row.spacerColumns?.length ?? 0,
    leftHomologyLength: 0,
    rightHomologyLength: 0,
  };
}

function goldenGatePreviewRangePayload(
  field: AssemblyWorkbenchEditableField
): { startBioCol: number; endBioCol: number; spacerLength: number } | null {
  const payload = field.command.payload as {
    previewRange?: {
      startBioCol?: unknown;
      endBioCol?: unknown;
      spacerLength?: unknown;
    };
  };
  const range = payload.previewRange;
  if (!range) return null;
  const startBioCol = typeof range.startBioCol === 'number' ? range.startBioCol : Number.NaN;
  const endBioCol = typeof range.endBioCol === 'number' ? range.endBioCol : Number.NaN;
  const spacerLength = typeof range.spacerLength === 'number' ? range.spacerLength : 0;
  if (!isFiniteNumber(startBioCol) || !isFiniteNumber(endBioCol)) return null;
  return {
    startBioCol,
    endBioCol,
    spacerLength: Math.max(0, Math.round(spacerLength)),
  };
}

function applyLiveBoundary(
  root: HTMLElement,
  role: 'start' | 'end',
  leftPx: number,
  bioCol: number
): void {
  const boundary = root.querySelector<HTMLElement>(`[data-overlap-boundary-role="${role}"]`);
  if (!boundary) return;
  boundary.style.left = `${leftPx}px`;
  boundary.dataset.liveOverlapBioCol = String(bioCol);
  boundary.dataset.liveOverlapPreviewActive = 'true';
}

function applyLiveGibsonCut(
  root: HTMLElement,
  input: {
    topBioCol: number;
    bottomBioCol: number;
    topX: number;
    bottomX: number;
    topRowPosition: number;
    bottomRowPosition: number;
  }
): void {
  const path = root.querySelector<SVGPathElement>(
    '[data-gibson-virtual-cut-id="gibson-resection"]'
  );
  if (!path) return;
  const topY = numberData(path, 'topY');
  const strandBoundaryY = numberData(path, 'strandBoundaryY');
  const bottomY = numberData(path, 'bottomY');
  if (topY === null || strandBoundaryY === null || bottomY === null) return;

  const connector = input.topX === input.bottomX ? '' : ` L ${input.bottomX} ${strandBoundaryY}`;
  const d = `M ${input.topX} ${topY} L ${input.topX} ${strandBoundaryY}${connector} L ${input.bottomX} ${bottomY}`;
  path.setAttribute('d', d);
  path.setAttribute('data-top-bio-col', String(input.topBioCol));
  path.setAttribute('data-bottom-bio-col', String(input.bottomBioCol));
  path.setAttribute('data-top-row-position', String(input.topRowPosition));
  path.setAttribute('data-bottom-row-position', String(input.bottomRowPosition));
  path.setAttribute(
    'data-overhang-direction',
    input.topBioCol > input.bottomBioCol ? 'three-prime' : 'five-prime'
  );
  path.dataset.liveOverlapPreviewActive = 'true';
}

function restoreCanonicalPathAttribute(
  path: SVGPathElement,
  attr: string,
  datasetKey: keyof DOMStringMap
): void {
  const value = path.dataset[datasetKey];
  if (value !== undefined) path.setAttribute(attr, value);
}

function homologyLengthsForField(
  field: AssemblyWorkbenchEditableField,
  constraint: { startBioCol: number; endBioCol: number } | null,
  spacerLength: number
): { onLeft: number; onRight: number } | null {
  const encoding = homologyEncodingPayload(field);
  let onLeft = encoding?.onLeft;
  let onRight = encoding?.onRight;
  const fieldValue = numericFieldValue(field);
  if (field.target.side === 'left' && fieldValue !== null) onLeft = fieldValue;
  if (field.target.side === 'right' && fieldValue !== null) onRight = fieldValue;
  if (!isFiniteNumber(onLeft) && constraint) {
    onLeft = Math.max(0, spacerLength - constraint.startBioCol);
  }
  if (!isFiniteNumber(onRight) && constraint) {
    onRight = Math.max(0, constraint.endBioCol - spacerLength);
  }
  if (!isFiniteNumber(onLeft) || !isFiniteNumber(onRight)) return null;
  return {
    onLeft: Math.round(onLeft),
    onRight: Math.round(onRight),
  };
}

function productSpacerLength(
  row: JunctionWorkbenchRow,
  field: AssemblyWorkbenchEditableField,
  constraint: CoordMappingConstraint | null
): number {
  if (constraint?.kind === 'homology-width' && isFiniteNumber(constraint.spacerLength)) {
    return Math.max(0, Math.round(constraint.spacerLength));
  }
  const encoding = homologyEncodingPayload(field);
  if (constraint && isFiniteNumber(encoding?.onRight)) {
    return Math.max(0, constraint.endBioCol - Math.round(encoding.onRight));
  }
  const visibleSpacerLength = row.spacerColumns?.length ?? 0;
  if (visibleSpacerLength > 0) return visibleSpacerLength;
  return 0;
}

function homologyProductTailRangeForLengths(input: {
  constraint: CoordMappingConstraint | null;
  spacerLength: number;
  current: { onLeft: number; onRight: number };
  side: 'left' | 'right';
  leftHomologyLength: number;
  rightHomologyLength: number;
}): { startBioCol: number; endBioCol: number } {
  const { constraint, spacerLength, current, side, leftHomologyLength, rightHomologyLength } =
    input;
  if (constraint?.kind === 'homology-width' && homologyConstraintHasTailGeometry(constraint)) {
    const leftHomologyEndBioCol = constraint.leftHomologyEndBioCol ?? spacerLength;
    const rightHomologyStartBioCol = constraint.rightHomologyStartBioCol ?? spacerLength;
    const leftTailPresent = constraint.leftTailPresent !== false;
    const rightTailPresent = constraint.rightTailPresent !== false;

    if (leftTailPresent && rightTailPresent) {
      return {
        startBioCol: leftHomologyEndBioCol - leftHomologyLength,
        endBioCol: rightHomologyStartBioCol + rightHomologyLength,
      };
    }
    if (leftTailPresent) {
      return {
        startBioCol: leftHomologyEndBioCol - leftHomologyLength,
        endBioCol: leftHomologyEndBioCol,
      };
    }
    if (rightTailPresent) {
      return {
        startBioCol: rightHomologyStartBioCol,
        endBioCol: rightHomologyStartBioCol + rightHomologyLength,
      };
    }
  }

  if (constraint && current.onLeft >= 0 && current.onRight >= 0) {
    const currentLeftHomologyEndBioCol = constraint.startBioCol + current.onLeft;
    const currentRightHomologyStartBioCol = constraint.endBioCol - current.onRight;
    return {
      startBioCol:
        side === 'left'
          ? currentLeftHomologyEndBioCol - leftHomologyLength
          : constraint.startBioCol,
      endBioCol:
        side === 'right'
          ? currentRightHomologyStartBioCol + rightHomologyLength
          : constraint.endBioCol,
    };
  }

  return {
    startBioCol: spacerLength - leftHomologyLength,
    endBioCol: spacerLength + rightHomologyLength,
  };
}

function homologyConstraintHasTailGeometry(
  constraint: Extract<CoordMappingConstraint, { kind: 'homology-width' }>
): boolean {
  return (
    isFiniteNumber(constraint.leftHomologyEndBioCol) ||
    isFiniteNumber(constraint.rightHomologyStartBioCol) ||
    isFiniteNumber(constraint.leftTailEndBioCol) ||
    isFiniteNumber(constraint.rightTailStartBioCol)
  );
}

function homologyEncodingPayload(
  field: AssemblyWorkbenchEditableField
): { onLeft?: number; onRight?: number } | null {
  const payload = field.command.payload as {
    encoding?: { onLeft?: unknown; onRight?: unknown };
  };
  const encoding = payload.encoding;
  if (!encoding) return null;
  return {
    onLeft: typeof encoding.onLeft === 'number' ? encoding.onLeft : undefined,
    onRight: typeof encoding.onRight === 'number' ? encoding.onRight : undefined,
  };
}

function numericFieldValue(field: AssemblyWorkbenchEditableField): number | null {
  return typeof field.value === 'number' && Number.isFinite(field.value) ? field.value : null;
}

export function rowBoundaryColumnForBioCol(row: JunctionWorkbenchRow, bioCol: number): number {
  return row.anchorRowPosition + bioCol;
}

function numberData(element: HTMLElement | SVGElement, key: keyof DOMStringMap): number | null {
  const value = element.dataset[key];
  if (value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
