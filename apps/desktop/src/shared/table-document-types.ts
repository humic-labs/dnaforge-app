import type { SourceFormulaMetadata } from './source-formula-result';
import type { JSONContent } from '@tiptap/core';

export type CellType = 'text' | 'number' | 'formula';

export type TextAlign = 'left' | 'center' | 'right';

export interface CellFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  align?: TextAlign;
  textColor?: string;
  bgColor?: string;
  wrap?: boolean;
}

export interface NativeEntityCellReference {
  kind: 'native-entity';
  occurrenceId?: string;
  entityId: string;
}

export interface LegacyMigrationDestinationCellReference {
  kind: 'migration-destination';
  occurrenceId?: string;
  destinationTargetId: string;
}

export interface ExternalUrlCellReference {
  kind: 'external-url';
  href: string;
}

export type TableCellReference =
  | NativeEntityCellReference
  | LegacyMigrationDestinationCellReference
  | ExternalUrlCellReference;

export interface CellSpan {
  rows: number;
  cols: number;
}

export interface Cell extends SourceFormulaMetadata {
  value: string;
  type: CellType;
  content?: JSONContent[];
  computed?: string | number;
  format?: CellFormat;
  reference?: TableCellReference;
  span?: CellSpan;
  covered?: boolean;
}

export interface CellPosition {
  row: number;
  col: number;
}

export type SortDirection = 'asc' | 'desc' | null;

export interface ColumnSort {
  column: number;
  direction: SortDirection;
}

export interface TableData {
  id?: string;
  name?: string;
  rows?: number;
  cols?: number;
  cells?: Cell[][];
  sort?: ColumnSort;
  filters?: Record<number, string>;
  columnWidths?: Record<number, number>;
  rowHeights?: Record<number, number>;
  columnLabels?: string[];
  presentation?: 'spreadsheet' | 'document';
  [key: string]: unknown;
}

export type FormulaCategory = 'aggregate' | 'math' | 'text' | 'logical';

export interface CellRange {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

export interface SelectionRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}
