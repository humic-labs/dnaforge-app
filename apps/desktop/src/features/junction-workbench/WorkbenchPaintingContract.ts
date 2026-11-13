import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import type { SequenceExtraLane } from '@waypoint/workspace-editor';
import type { JunctionWorkbenchRow } from './model';

export const NON_CONTRIBUTING_COLOR = '#9ca3af';
export const NON_CONTRIBUTING_BACKGROUND_COLOR = 'rgba(156, 163, 175, 0.12)';
export const SPACER_COLOR = '#6b7280';
export const FALLBACK_LEFT_SOURCE_COLOR = '#38bdf8';
export const FALLBACK_RIGHT_SOURCE_COLOR = '#34d399';

export type WorkbenchPaintOwner = 'left' | 'right' | 'spacer';

export interface WorkbenchRowPaintingContract {
  borderColor: string;
  labelBackground: string;
  extraLanes: SequenceExtraLane[];
}

export function rowToSequence(
  row: JunctionWorkbenchRow,
  options: { annotations?: readonly Annotation[] } = {}
): AnnotatedSequence {
  return {
    id: row.id,
    name: row.label,
    sequence: row.sequence,
    length: row.sequence.length,
    annotations: [...(options.annotations ?? row.annotations)],
    circular: false,
  };
}

export function buildProductOwnerPreviewSequence(input: {
  productRow: JunctionWorkbenchRow;
  activeSourceRow: JunctionWorkbenchRow | null;
  owner: Extract<WorkbenchPaintOwner, 'left' | 'right'>;
  annotationMode?: 'preview' | 'settled';
}): AnnotatedSequence | null {
  const { productRow, activeSourceRow, owner } = input;
  if (productRow.productDragPreview?.owner === owner) {
    const annotations =
      input.annotationMode === 'settled'
        ? productRow.annotations
        : productRow.productDragPreview.annotations;
    return {
      id: `${productRow.id}-${owner}-preview`,
      name: productRow.label,
      sequence: productRow.productDragPreview.sequence,
      length: productRow.productDragPreview.sequence.length,
      annotations: [...annotations],
      circular: false,
    };
  }
  if (!activeSourceRow) return null;
  if (productRow.kind !== 'product') return null;
  if (activeSourceRow.kind !== 'left-source' && activeSourceRow.kind !== 'right-source') {
    return null;
  }

  const sourceRowPositionByBioCol = new Map<number, number>();
  for (const point of activeSourceRow.points) {
    sourceRowPositionByBioCol.set(point.bioCol, point.rowPosition);
  }

  const chars = productRow.sequence.split('');
  for (const point of productRow.points) {
    if (productOwnerForPoint(productRow, point) !== owner) continue;
    const sourceRowPosition = sourceRowPositionByBioCol.get(point.bioCol);
    if (sourceRowPosition === undefined) continue;
    chars[point.rowPosition] = activeSourceRow.sequence[sourceRowPosition] ?? ' ';
  }

  return {
    id: `${productRow.id}-${owner}-preview`,
    name: productRow.label,
    sequence: chars.join(''),
    length: chars.length,
    annotations: [...productRow.annotations],
    circular: false,
  };
}

export function primersForRow(
  row: JunctionWorkbenchRow
): NonNullable<JunctionWorkbenchRow['primers']> {
  const primers = row.primers ?? [];
  if (row.kind === 'product') {
    return primers.map((primer) => {
      if (primer.isScarMarkerOnly) return primer;
      const pbsProbe = primer.direction === 'forward' ? primer.end - 1 : primer.start;
      const overhangProbe = primer.direction === 'forward' ? primer.start : primer.end - 1;
      return {
        ...primer,
        pbsColor: colorForRowPosition(row, pbsProbe) ?? primer.pbsColor,
        overhangColor: colorForRowPosition(row, overhangProbe) ?? primer.overhangColor,
      };
    });
  }

  const sourceColor =
    row.fragmentColor ??
    (row.kind === 'right-source' ? FALLBACK_RIGHT_SOURCE_COLOR : FALLBACK_LEFT_SOURCE_COLOR);
  const partnerColor =
    row.partnerFragmentColor ??
    (row.kind === 'right-source' ? FALLBACK_LEFT_SOURCE_COLOR : FALLBACK_RIGHT_SOURCE_COLOR);
  return primers.map((primer) => ({
    ...primer,
    pbsColor: sourceColor,
    overhangColor: partnerColor,
  }));
}

export function colorForRowPosition(row: JunctionWorkbenchRow, rowPosition: number): string | null {
  const point = row.points.find((item) => item.rowPosition === rowPosition);
  if (!point) return null;
  if (row.kind === 'product') return productOwnerColor(row, productOwnerForPoint(row, point));
  if ((row.spacerColumns ?? []).includes(rowPosition)) return SPACER_COLOR;
  return (
    row.fragmentColor ??
    (row.kind === 'right-source' ? FALLBACK_RIGHT_SOURCE_COLOR : FALLBACK_LEFT_SOURCE_COLOR)
  );
}

export function productOwnerForPoint(
  row: JunctionWorkbenchRow,
  point: { rowPosition: number; bioCol?: number }
): WorkbenchPaintOwner {
  const owner = row.productOwners?.[point.rowPosition];
  if (owner) return owner;
  if ((row.spacerColumns ?? []).includes(point.rowPosition)) return 'spacer';
  return 'right';
}

export function productOwnerColor(row: JunctionWorkbenchRow, owner: WorkbenchPaintOwner): string {
  if (owner === 'left') return row.leftFragmentColor ?? FALLBACK_LEFT_SOURCE_COLOR;
  if (owner === 'right') return row.rightFragmentColor ?? FALLBACK_RIGHT_SOURCE_COLOR;
  return SPACER_COLOR;
}

export function provenanceForRow(row: JunctionWorkbenchRow): WorkbenchRowPaintingContract {
  if (row.kind === 'left-source' || row.kind === 'right-source') {
    const sourceColor =
      row.fragmentColor ??
      (row.kind === 'left-source' ? FALLBACK_LEFT_SOURCE_COLOR : FALLBACK_RIGHT_SOURCE_COLOR);
    return {
      borderColor: sourceColor,
      labelBackground: colorWash(sourceColor, 0.18),
      extraLanes: [],
    };
  }

  const leftColor = row.leftFragmentColor ?? FALLBACK_LEFT_SOURCE_COLOR;
  const rightColor = row.rightFragmentColor ?? FALLBACK_RIGHT_SOURCE_COLOR;

  return {
    borderColor: '#d1d5db',
    labelBackground: `linear-gradient(90deg, ${colorWash(leftColor, 0.18)}, ${colorWash(
      rightColor,
      0.18
    )})`,
    extraLanes: [],
  };
}

export function colorWash(hex: string, alpha: number): string {
  const normalized = hex.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return hex;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
