import {
  isUnknownRecord,
  type NotebookMarkdownAstNode,
  type NotebookRichBlockContract,
} from './notebook-content-extension';
import { isSourceFormulaMetadataValid } from './source-formula-result';
import { isTableCellContent, tableCellContentText } from './table-cell-content';

function spreadsheetColumnLabel(index: number): string {
  let remaining = index + 1;
  let label = '';
  while (remaining > 0) {
    const offset = (remaining - 1) % 26;
    label = String.fromCharCode(65 + offset) + label;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return label;
}

function cellValue(value: unknown): string {
  if (!isUnknownRecord(value)) return '';
  const raw = value.value;
  if (typeof raw === 'string') return raw;
  return typeof raw === 'number' ? String(raw) : '';
}

function escapeGfmCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n|\r|\n/g, '<br>');
}

function markdownCell(value: unknown): string {
  if (!isUnknownRecord(value) || !isTableCellContent(value.content))
    return escapeGfmCell(cellValue(value));
  return value.content
    .map((node) => {
      if (node.type === 'hardBreak') return '<br>';
      const raw = node.type === 'mention' ? node.attrs?.label : node.text;
      let text = escapeGfmCell(raw ?? '').replace(/([`*_[\]])/g, '\\$1');
      if (node.type === 'mention') {
        const href = (node.attrs?.referenceUri ?? '').replace(/[<>\r\n]/g, encodeURIComponent);
        text = `[${text}](<${href}>)`;
      }
      for (const mark of node.marks ?? []) {
        const marker = mark.type === 'bold' ? '**' : '*';
        text = text.replace(/^(\s*)(\S[\s\S]*?)(\s*)$/, `$1${marker}$2${marker}$3`);
      }
      return text;
    })
    .join('');
}

function dataRows(data: Readonly<Record<string, unknown>>): readonly unknown[][] {
  if (!Array.isArray(data.cells)) return [];
  return data.cells.filter(Array.isArray);
}

function positiveDimension(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || positiveDimension(value) > 0;
}

function isIndexedRecord(value: unknown, entryIsValid: (entry: unknown) => boolean): boolean {
  if (!isUnknownRecord(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) => /^(0|[1-9]\d*)$/.test(key) && entryIsValid(entry)
  );
}

function isCellFormat(value: unknown): boolean {
  if (!isUnknownRecord(value)) return false;
  const booleanKeys = ['bold', 'italic', 'underline', 'strikethrough', 'wrap'] as const;
  if (booleanKeys.some((key) => value[key] !== undefined && typeof value[key] !== 'boolean')) {
    return false;
  }
  if (
    value.align !== undefined &&
    value.align !== 'left' &&
    value.align !== 'center' &&
    value.align !== 'right'
  ) {
    return false;
  }
  return isOptionalString(value.textColor) && isOptionalString(value.bgColor);
}

function isCellReference(value: unknown): boolean {
  if (!isUnknownRecord(value)) return false;
  switch (value.kind) {
    case 'native-entity':
      return (
        typeof value.entityId === 'string' &&
        value.entityId.length > 0 &&
        isOptionalString(value.occurrenceId)
      );
    case 'migration-destination':
      return (
        typeof value.destinationTargetId === 'string' &&
        value.destinationTargetId.length > 0 &&
        isOptionalString(value.occurrenceId)
      );
    case 'external-url':
      return typeof value.href === 'string';
    default:
      return false;
  }
}

function isCellSpan(value: unknown): boolean {
  return (
    isUnknownRecord(value) && positiveDimension(value.rows) > 0 && positiveDimension(value.cols) > 0
  );
}

function isTableCell(value: unknown, requireType: boolean): boolean {
  if (!isUnknownRecord(value) || typeof value.value !== 'string') return false;
  if (!isSourceFormulaMetadataValid(value)) return false;
  if (
    value.content !== undefined &&
    (!isTableCellContent(value.content) || tableCellContentText(value.content) !== value.value)
  )
    return false;
  if (
    (requireType || value.type !== undefined) &&
    value.type !== 'text' &&
    value.type !== 'number' &&
    value.type !== 'formula'
  ) {
    return false;
  }
  if (
    value.computed !== undefined &&
    typeof value.computed !== 'string' &&
    !(typeof value.computed === 'number' && Number.isFinite(value.computed))
  ) {
    return false;
  }
  if (value.format !== undefined && !isCellFormat(value.format)) return false;
  if (value.reference !== undefined && !isCellReference(value.reference)) return false;
  if (value.span !== undefined && !isCellSpan(value.span)) return false;
  return value.covered === undefined || typeof value.covered === 'boolean';
}

function isTableCells(value: unknown): boolean {
  if (isUnknownRecord(value)) {
    return Object.entries(value).every(
      ([key, cell]) => /^[A-Z]+[1-9]\d*$/.test(key) && isTableCell(cell, false)
    );
  }
  if (!Array.isArray(value)) return false;
  const width = Array.isArray(value[0]) ? value[0].length : 0;
  return value.every(
    (row) =>
      Array.isArray(row) && row.length === width && row.every((cell) => isTableCell(cell, true))
  );
}

function tableDataValidationError(data: Readonly<Record<string, unknown>>): string | null {
  if (!isOptionalString(data.id) || !isOptionalString(data.name)) {
    return 'table id and name must be strings';
  }
  if (!isOptionalPositiveInteger(data.rows) || !isOptionalPositiveInteger(data.cols)) {
    return 'table rows and cols must be positive integers';
  }
  if (data.cells !== undefined && !isTableCells(data.cells)) {
    return 'table cells must be a rectangular array of valid cells';
  }
  if (
    data.columnLabels !== undefined &&
    (!Array.isArray(data.columnLabels) ||
      !data.columnLabels.every((label) => typeof label === 'string'))
  ) {
    return 'table columnLabels must contain only strings';
  }
  if (
    data.presentation !== undefined &&
    data.presentation !== 'spreadsheet' &&
    data.presentation !== 'document'
  ) {
    return 'table presentation is invalid';
  }
  if (
    data.sort !== undefined &&
    (!isUnknownRecord(data.sort) ||
      typeof data.sort.column !== 'number' ||
      !Number.isSafeInteger(data.sort.column) ||
      data.sort.column < 0 ||
      (data.sort.direction !== null &&
        data.sort.direction !== 'asc' &&
        data.sort.direction !== 'desc'))
  ) {
    return 'table sort is invalid';
  }
  if (
    data.filters !== undefined &&
    !isIndexedRecord(data.filters, (entry) => typeof entry === 'string')
  ) {
    return 'table filters are invalid';
  }
  const validSize = (entry: unknown): boolean =>
    typeof entry === 'number' && Number.isFinite(entry) && entry > 0;
  if (data.columnWidths !== undefined && !isIndexedRecord(data.columnWidths, validSize)) {
    return 'table columnWidths are invalid';
  }
  if (data.rowHeights !== undefined && !isIndexedRecord(data.rowHeights, validSize)) {
    return 'table rowHeights are invalid';
  }
  return null;
}

function markdownTable(input: {
  readonly refId: string;
  readonly data: Readonly<Record<string, unknown>>;
}): string {
  const rows = dataRows(input.data);
  const labels = Array.isArray(input.data.columnLabels)
    ? input.data.columnLabels.map((label) => (typeof label === 'string' ? label : ''))
    : [];
  const columnCount = Math.max(
    labels.length,
    positiveDimension(input.data.cols),
    ...rows.map((row) => row.length)
  );
  if (columnCount === 0) {
    const name =
      typeof input.data.name === 'string' && input.data.name.trim()
        ? input.data.name.trim()
        : input.refId;
    return `> DNAForge table: ${name}`;
  }

  const headers = Array.from({ length: columnCount }, (_, index) =>
    escapeGfmCell(labels[index] || spreadsheetColumnLabel(index))
  );
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`,
  ];
  for (const row of rows) {
    const values = Array.from({ length: columnCount }, (_, index) => markdownCell(row[index]));
    lines.push(`| ${values.join(' | ')} |`);
  }
  return lines.join('\n');
}

function astText(node: NotebookMarkdownAstNode): string {
  if (node.type === 'break') return '\n';
  if (node.type === 'html' && /^<br\s*\/?\s*>$/i.test(node.value ?? '')) return '\n';
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(astText).join('');
}

function tableRows(node: NotebookMarkdownAstNode): readonly NotebookMarkdownAstNode[][] {
  return (node.children ?? [])
    .filter((row) => row.type === 'tableRow')
    .map((row) => (row.children ?? []).filter((cell) => cell.type === 'tableCell'));
}

function alignmentFormat(
  alignment: 'left' | 'right' | 'center' | null | undefined
): Record<string, unknown> | undefined {
  return alignment ? { align: alignment } : undefined;
}

export const TABLE_NOTEBOOK_BLOCK = {
  kind: 'rich-block',
  type: 'table',
  currentVersion: 1,
  migrations: [],
  markdownNodeTypes: ['table'],
  parseData: (value) => {
    if (!isUnknownRecord(value)) {
      return { ok: false, reason: 'table data must be an object' };
    }
    const reason = tableDataValidationError(value);
    return reason ? { ok: false, reason } : { ok: true, data: value };
  },
  toMarkdown: markdownTable,
  fromMarkdown: ({ refId, node }) => {
    if (node.type !== 'table') return null;
    const rows = tableRows(node);
    if (rows.length === 0) return null;
    const header = rows[0] ?? [];
    const body = rows.slice(1);
    const cols = Math.max(header.length, ...body.map((row) => row.length));
    if (cols === 0) return null;
    const columnLabels = Array.from({ length: cols }, (_, index) => astText(header[index] ?? {}));
    const cells = body.map((row) =>
      Array.from({ length: cols }, (_, index) => {
        const value = astText(row[index] ?? {});
        const format = alignmentFormat(node.align?.[index]);
        return {
          value,
          type: value.startsWith('=') ? 'formula' : 'text',
          ...(format ? { format } : {}),
        };
      })
    );
    return {
      refId,
      data: { rows: cells.length, cols, columnLabels, cells },
    };
  },
} satisfies NotebookRichBlockContract;
