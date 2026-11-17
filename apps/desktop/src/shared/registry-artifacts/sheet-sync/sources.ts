import type { GoogleWorksheetSnapshot, GoogleSheetsStatus } from '../../google-sheets';
import type { createLimsImportPlan, DryRunLimsImportInput } from '../ingress-core';
import { sheetSyncRowsFromImportPlan } from './import';
import type { GoogleSyncSource } from './persistence';
export interface ExcelSyncSource {
  path: string;
  sheetName: string;
  keyColumn: string;
  forcedKind: NonNullable<DryRunLimsImportInput['forcedKind']>;
  columnMappings: NonNullable<DryRunLimsImportInput['columnMappings']>;
}
export interface GoogleSheetsPort {
  status(): Promise<GoogleSheetsStatus>;
  worksheet(input: {
    grantId: string;
    spreadsheetId: string;
    sheetId: number;
  }): Promise<GoogleWorksheetSnapshot>;
}
export function googleWorksheetImportInput(snapshot: GoogleWorksheetSnapshot) {
  const text = snapshot.rows
    .map((row) =>
      row
        .map((cell) => {
          if (cell.kind === 'error')
            throw new Error('Fix worksheet formula errors before synchronizing.');
          return `"${cell.display.split('"').join('""')}"`;
        })
        .join('\t')
    )
    .join('\r\n');
  return { fileName: `${snapshot.spreadsheetId}-${snapshot.sheetId}.tsv`, text };
}
export function createSheetSyncSources(deps: {
  createLimsImportPlan(input: DryRunLimsImportInput): ReturnType<typeof createLimsImportPlan>;
  readFile(path: string): Promise<Uint8Array>;
}) {
  const { createLimsImportPlan, readFile } = deps;
  async function parseExcelSyncSource(source: ExcelSyncSource, input: Uint8Array) {
    if (!source.sheetName.trim()) throw new Error('Choose the worksheet to synchronize.');
    const bytes = Uint8Array.from(input);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const revision = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const fileName = source.path.split(/[\\/]/).pop() ?? '';
    const plan = await createLimsImportPlan({
      fileName,
      sourcePath: source.path,
      arrayBuffer: bytes.buffer,
      sheetName: source.sheetName,
      forcedKind: source.forcedKind,
      columnMappings: source.columnMappings,
      externalRowKeyColumn: source.keyColumn,
    });
    const columns = new Set(plan.columns.map((column) => column.sourceColumn.trim().toLowerCase()));
    const missing = source.columnMappings.filter(
      (mapping) =>
        mapping.mappingMode === 'mapped' && !columns.has(mapping.sourceColumn.trim().toLowerCase())
    );
    if (missing.length)
      throw new Error(
        `Mapped spreadsheet columns are missing: ${missing.map((mapping) => mapping.sourceColumn).join(', ')}`
      );
    if (plan.sourceKind !== 'xlsx' || plan.selectedSheet !== source.sheetName)
      throw new Error('The selected Excel worksheet is no longer available.');
    return { bytes, revision, plan, rows: sheetSyncRowsFromImportPlan(plan, source.keyColumn) };
  }

  async function readExcelSyncSource(source: ExcelSyncSource) {
    return parseExcelSyncSource(source, await readFile(source.path));
  }

  async function parseGoogleSyncSource(
    source: GoogleSyncSource,
    snapshot: GoogleWorksheetSnapshot
  ) {
    if (snapshot.spreadsheetId !== source.spreadsheetId || snapshot.sheetId !== source.sheetId)
      throw new Error('Google Sheets returned a different worksheet.');
    const plan = await createLimsImportPlan({
      ...googleWorksheetImportInput(snapshot),
      forcedKind: source.forcedKind,
      columnMappings: source.columnMappings,
      externalRowKeyColumn: source.keyColumn,
    });
    const columns = new Set(plan.columns.map((column) => column.sourceColumn.trim().toLowerCase()));
    const missing = source.columnMappings.filter(
      (mapping) =>
        mapping.mappingMode === 'mapped' && !columns.has(mapping.sourceColumn.trim().toLowerCase())
    );
    if (missing.length)
      throw new Error(
        `Mapped spreadsheet columns are missing: ${missing.map((mapping) => mapping.sourceColumn).join(', ')}`
      );
    return {
      revision: snapshot.revision,
      plan: { ...plan, selectedSheet: snapshot.sheetTitle },
      rows: sheetSyncRowsFromImportPlan(plan, source.keyColumn),
    };
  }
  return { parseExcelSyncSource, readExcelSyncSource, parseGoogleSyncSource };
}
export type SheetSyncSources = ReturnType<typeof createSheetSyncSources>;
