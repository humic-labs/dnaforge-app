import type { GoogleWorksheetSnapshot } from '../../shared/google-sheets';
import { createLimsImportPlan } from './ingress';
import { sheetSyncRowsFromImportPlan } from './sheet-sync-import';
import type { GoogleSyncSource } from './sheet-sync-connection';

export async function parseGoogleSyncSource(
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
