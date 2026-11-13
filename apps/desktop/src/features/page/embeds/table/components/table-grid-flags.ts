export function tableGridColumnCount(cells: unknown[][]): number {
  return cells[0]?.length || 0;
}

export function tableGridShouldShowFormulaBar(
  showFormulaBar: boolean | undefined,
  readOnly: boolean
): boolean {
  return showFormulaBar ?? !readOnly;
}

export function tableGridCanEditColumnLabels(
  readOnly: boolean,
  onColumnLabelChange: unknown
): boolean {
  return !readOnly && !!onColumnLabelChange;
}

export function tableGridShouldShowColumnLabels(
  showColumnLabels: boolean | undefined,
  columnLabels: unknown[] | undefined
): boolean {
  return showColumnLabels ?? (columnLabels !== undefined && columnLabels.length > 0);
}

export function tableGridTotalCount(showGhost: boolean, count: number, ghostCount: number): number {
  return showGhost ? count + ghostCount : count;
}

export function tableGridRenderedRowCount(
  searchActive: boolean,
  searchedCount: number,
  totalRows: number
): number {
  return searchActive ? searchedCount : totalRows;
}

export function tableGridIsEmpty(rows: number, cols: number): boolean {
  return rows === 0 || cols === 0;
}

export function tableGridWhenWritable<T>(readOnly: boolean, value: T, fallback: T): T {
  return readOnly ? fallback : value;
}

export function tableGridFocusedCellRawValue(
  focusedCell: { row: number; col: number } | null,
  cells: Array<Array<{ value?: string } | undefined> | undefined>
): string {
  return focusedCell ? (cells[focusedCell.row]?.[focusedCell.col]?.value ?? '') : '';
}

export function tableGridFocusedCellAddress(
  focusedCell: { row: number; col: number } | null,
  columnIndexToLetter: (col: number) => string
): string {
  return focusedCell ? `${columnIndexToLetter(focusedCell.col)}${focusedCell.row + 1}` : '';
}

export function tableGridFormulaBarValue(
  editingValue: string | undefined,
  focusedCellRawValue: string
): string {
  return editingValue ?? focusedCellRawValue;
}

export function tableGridOverflowX(overflowsX: boolean): {
  dataOverflowX: 'auto' | 'none';
  className: string | undefined;
} {
  return overflowsX
    ? { dataOverflowX: 'auto', className: 'overflow-x-auto overflow-y-clip' }
    : { dataOverflowX: 'none', className: undefined };
}

export function tableGridLabelOnlySelection(args: {
  hasLabelSelection: boolean;
  activeKind: string;
  selectionStartRow: number | undefined;
  selectionEndRow: number | undefined;
  columnLabelSelectionRow: number;
}): boolean {
  return (
    args.hasLabelSelection &&
    (args.activeKind === 'column-labels' ||
      (args.selectionStartRow === args.columnLabelSelectionRow &&
        args.selectionEndRow === args.columnLabelSelectionRow))
  );
}

export function tableGridLabelSelectionExtendsIntoCells(
  hasLabelSelection: boolean,
  selectionEndRow: number | undefined
): boolean {
  return hasLabelSelection && selectionEndRow !== undefined && selectionEndRow >= 0;
}

export function tableGridFilterStatusVisible(filterCount: number, searchActive: boolean): boolean {
  return filterCount > 0 || searchActive;
}

export function tableGridDataCellClasses(isGhost: boolean): string {
  return [
    'h-px p-0 min-w-[80px] cursor-cell',
    isGhost ? 'bg-bg-muted/20 border-r border-border/30' : 'border-r border-border',
  ].join(' ');
}
