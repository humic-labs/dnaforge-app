import type { CSSProperties } from 'react';
import type { Cell, CellFormat, CellPosition } from '../types';
import { tableCellValue } from '../utils/cell-value';
import {
  readSavedFormulaResult,
  savedFormulaResultExplanation,
} from '../../../../../shared/source-formula-result';

export type TableCellGridBounds = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};

export type TableCellEdgeMask = {
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
};

const EMPTY_EDGES: TableCellEdgeMask = {
  top: false,
  bottom: false,
  left: false,
  right: false,
};

export function tableCellEdgeMask(
  active: boolean,
  position: CellPosition,
  bounds: TableCellGridBounds | null | undefined
): TableCellEdgeMask {
  if (!active || !bounds) return EMPTY_EDGES;
  return {
    top: position.row === bounds.startRow,
    bottom: position.row === bounds.endRow,
    left: position.col === bounds.startCol,
    right: position.col === bounds.endCol,
  };
}

export function tableCellHasSelectionEdge(
  isSelected: boolean,
  isFocused: boolean,
  edges: TableCellEdgeMask
): boolean {
  return isSelected && !isFocused && (edges.top || edges.bottom || edges.left || edges.right);
}

export function tableCellCutBorderStyle(isCut: boolean, edges: TableCellEdgeMask): CSSProperties {
  if (!isCut) return {};
  const style: CSSProperties = {};
  if (edges.top) {
    style.borderTopWidth = '1.5px';
    style.borderTopStyle = 'dashed';
    style.borderTopColor = 'var(--color-fg-muted)';
  }
  if (edges.bottom) {
    style.borderBottomWidth = '1.5px';
    style.borderBottomStyle = 'dashed';
    style.borderBottomColor = 'var(--color-fg-muted)';
  }
  if (edges.left) {
    style.borderLeftWidth = '1.5px';
    style.borderLeftStyle = 'dashed';
    style.borderLeftColor = 'var(--color-fg-muted)';
  }
  if (edges.right) {
    style.borderRightWidth = '1.5px';
    style.borderRightStyle = 'dashed';
    style.borderRightColor = 'var(--color-fg-muted)';
  }
  return style;
}

export function tableCellDisplayValue(cell: Cell): string {
  return String(tableCellValue(cell));
}

export function tableCellIsError(cell: Cell): boolean {
  return (
    cell.type === 'formula' && typeof cell.computed === 'string' && cell.computed.startsWith('#')
  );
}

export function tableCellNativeEntityId(cell: Cell): string | null {
  if (cell.reference?.kind === 'native-entity') return cell.reference.entityId;
  if (cell.reference?.kind === 'migration-destination') return cell.reference.destinationTargetId;
  return null;
}

export function tableCellAlignClass(format?: CellFormat): string {
  if (format?.align === 'center') return 'text-center';
  if (format?.align === 'right') return 'text-right';
  return 'text-left';
}

export function tableCellTitle(cell: Cell, isGhost: boolean): string | undefined {
  if (isGhost) return 'Type here to expand the table';
  const savedResult = readSavedFormulaResult(cell);
  const explanation = savedResult ? savedFormulaResultExplanation(savedResult) : undefined;
  if (explanation) return explanation;
  if (cell.type === 'formula') return `Formula: ${cell.value}`;
  return undefined;
}

export function tableCellWrapperClasses(args: {
  isFocused: boolean;
  isSelected: boolean;
  isCut: boolean;
  isGhost: boolean;
  hasSelectionEdge: boolean;
  hasBgColor: boolean;
}): string {
  return [
    'relative w-full h-full min-h-[22px] cursor-cell outline-none transition-none',
    args.isFocused || args.hasSelectionEdge ? 'z-10' : '',
    args.isCut && !args.isSelected ? 'bg-fg/[0.04]' : '',
    !args.hasBgColor && !args.isFocused && !args.isSelected && !args.isCut ? 'wp-interactive' : '',
    args.isGhost && !args.isFocused && !args.isSelected ? 'bg-transparent' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function tableCellSelectionEdgeOverlayClasses(
  hasSelectionEdge: boolean,
  edges: TableCellEdgeMask
): string {
  if (!hasSelectionEdge) return '';
  return [
    'pointer-events-none absolute -inset-x-px -inset-y-[2px] border-accent/70',
    edges.top ? 'border-t-[1.5px]' : '',
    edges.bottom ? 'border-b-[1.5px]' : '',
    edges.left ? 'border-l-[1.5px]' : '',
    edges.right ? 'border-r-[1.5px]' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function tableCellDisplayClasses(args: {
  cell: Cell;
  isError: boolean;
  isGhost: boolean;
  isFocused: boolean;
}): string {
  const savedResult = readSavedFormulaResult(args.cell);
  return [
    'w-full px-1.5 py-0.5 text-xs',
    savedResult ? '' : 'h-full',
    args.cell.format?.wrap
      ? 'whitespace-pre-wrap break-words overflow-visible leading-4'
      : 'truncate',
    tableCellAlignClass(args.cell.format),
    args.cell.format?.bold ? 'font-bold' : '',
    args.cell.format?.italic ? 'italic' : '',
    args.cell.format?.underline ? 'underline' : '',
    args.cell.format?.strikethrough ? 'line-through' : '',
    args.isError ? 'text-red-500' : '',
    args.isGhost && !args.isFocused ? 'text-fg-muted/30' : '',
  ]
    .filter(Boolean)
    .join(' ');
}
