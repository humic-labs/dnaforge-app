import { describe, expect, it, vi } from 'vitest';
import { parseGoogleSyncSource } from './google-sync-source';
import type { GoogleSyncSource } from './sheet-sync-connection';
import type { GoogleSheetCell, GoogleWorksheetSnapshot } from '../../shared/google-sheets';
vi.mock('../../db', () => ({ ensureSequenceIdentity: vi.fn(async () => 1) }));
vi.mock('./operations', () => ({
  queryLimsEntities: vi.fn(async () => []),
  applyLimsImportBatch: vi.fn(),
}));
const source: GoogleSyncSource = {
  provider: 'google-sheets',
  spreadsheetId: 'source-id',
  sheetId: 17,
  keyColumn: 'Stable ID',
  forcedKind: 'oligo',
  columnMappings: [
    { sourceColumn: 'Name', mappingMode: 'mapped', mappedField: 'entity.name' },
    { sourceColumn: 'Sequence', mappingMode: 'mapped', mappedField: 'fields.sequence' },
    { sourceColumn: 'Ignored', mappingMode: 'ignored' },
  ],
};
const cell = (display: string): GoogleSheetCell => ({ kind: 'value', display, value: display });
function snapshot(): GoogleWorksheetSnapshot {
  return {
    spreadsheetId: 'source-id',
    sheetId: 17,
    sheetTitle: 'Primers',
    revision: `sha256:${'a'.repeat(64)}`,
    rows: [
      ['Stable ID', 'Name', 'Sequence', 'Ignored'].map(cell),
      ['001', 'Forward, "A"\nfirst', 'GTAAAACGACGGCCAGT', 'private ignored value'].map(cell),
      ['002', 'Forward B', 'GTAAAACGACGGCCAGT', 'other private'].map(cell),
    ],
  };
}
describe('Google worksheet through the canonical row importer', () => {
  it('preserves formatted keys, delimited quoting, identical scientific records and selected-column privacy', async () => {
    const input = snapshot();
    input.rows[1][0] = { kind: 'value', display: '001', value: 1 };
    const parsed = await parseGoogleSyncSource(source, input);
    expect(parsed.rows.map((row) => row.key)).toEqual(['001', '002']);
    expect(parsed.rows[0].record.name).toContain('Forward, "A"');
    expect(parsed.plan.selectedSheet).toBe('Primers');
    expect(JSON.stringify(parsed.rows)).not.toContain('private ignored value');
    expect((await parseGoogleSyncSource(source, { ...input, sheetTitle: 'Renamed' })).rows).toEqual(
      parsed.rows
    );
  });
  it('preserves table delimiters when a worksheet header contains semicolons', async () => {
    const input = snapshot();
    input.rows[0][3] = cell('Ignored;A;B;C;D;E');
    const parsed = await parseGoogleSyncSource(
      {
        ...source,
        columnMappings: [
          ...source.columnMappings.filter((mapping) => mapping.sourceColumn !== 'Ignored'),
          { sourceColumn: 'Ignored;A;B;C;D;E', mappingMode: 'ignored' },
        ],
      },
      input
    );
    expect(parsed.rows.map((row) => row.key)).toEqual(['001', '002']);
  });
  it('rejects wrong worksheet identity, duplicate keys, missing mapped columns and formula errors', async () => {
    await expect(parseGoogleSyncSource(source, { ...snapshot(), sheetId: 19 })).rejects.toThrow(
      'different worksheet'
    );
    const repeated = snapshot();
    repeated.rows[2][0] = cell('001');
    await expect(parseGoogleSyncSource(source, repeated)).rejects.toThrow('duplicated');
    const missing = snapshot();
    missing.rows = missing.rows.map((row) => [row[0], row[1], row[3]]);
    await expect(parseGoogleSyncSource(source, missing)).rejects.toThrow(
      'Mapped spreadsheet columns are missing'
    );
    const broken = snapshot();
    broken.rows[1][2] = { kind: 'error', display: '#N/A' };
    await expect(parseGoogleSyncSource(source, broken)).rejects.toThrow('formula errors');
  });
});
