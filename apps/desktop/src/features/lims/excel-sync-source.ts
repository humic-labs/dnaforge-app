import { platform } from '../../platform';
import { createLimsImportPlan, type DryRunLimsImportInput } from './ingress';
import { sheetSyncRowsFromImportPlan } from './sheet-sync-import';

export interface ExcelSyncSource {
  path: string;
  sheetName: string;
  keyColumn: string;
  forcedKind: NonNullable<DryRunLimsImportInput['forcedKind']>;
  columnMappings: NonNullable<DryRunLimsImportInput['columnMappings']>;
}

export async function parseExcelSyncSource(source: ExcelSyncSource, input: Uint8Array) {
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

export async function readExcelSyncSource(source: ExcelSyncSource) {
  return parseExcelSyncSource(source, await platform().fs.readFile(source.path));
}
