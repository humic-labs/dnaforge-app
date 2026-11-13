import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { createLimsImportPlan } from './ingress';
import { sheetSyncRowsFromImportPlan } from './sheet-sync-import';
import { planSheetSync } from './sheet-sync';

vi.mock('../../db', () => ({ ensureSequenceIdentity: vi.fn(async () => 1) }));
vi.mock('./operations', () => ({
  queryLimsEntities: vi.fn(async () => []),
  applyLimsImportBatch: vi.fn(),
}));

async function workbook(rows: string[][], sheet = 'Primers') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([['Stable ID', 'Name', 'Sequence'], ...rows]),
    sheet
  );
  const arrayBuffer: ArrayBuffer = XLSX.write(book, { type: 'array', bookType: 'xlsx' });
  return createLimsImportPlan({
    fileName: 'master.xlsx',
    arrayBuffer,
    sheetName: sheet,
    forcedKind: 'oligo',
  });
}

const bases = 'GTAAAACGACGGCCAGT';

describe('spreadsheet import sync boundary', () => {
  it('reads durable text keys from an actual Excel workbook and ignores row-order provenance', async () => {
    const initial = sheetSyncRowsFromImportPlan(
      await workbook([
        ['001', 'First', bases],
        ['002', 'Second', 'ATGCGATCGTTAGCATG'],
      ]),
      'Stable ID'
    );
    const reordered = sheetSyncRowsFromImportPlan(
      await workbook([
        ['002', 'Renamed', 'ATGCGATCGTTAGCATG'],
        ['001', 'First', bases],
      ]),
      'Stable ID'
    );
    expect(initial.map((row) => row.key)).toEqual(['001', '002']);
    expect(initial[0].record.fields).not.toHaveProperty('sourceMetadata');
    const changes = planSheetSync({
      sourceRows: reordered,
      checkpoints: initial.map((row) => ({
        key: row.key,
        entityId: `entity-${row.key}`,
        artifactRelativePath: `${row.key}.primer.json`,
        source: row.record,
        applied: row.record,
      })),
      targets: initial.map((row) => ({
        entityId: `entity-${row.key}`,
        eventSeq: 1,
        archived: false,
        record: row.record,
      })),
    });
    expect(changes.map((change) => [change.key, change.kind])).toEqual([
      ['002', 'update'],
      ['001', 'unchanged'],
    ]);
  });

  it('rejects a removed key column and missing or duplicated row identities before writes', async () => {
    const plan = await workbook([['001', 'First', bases]]);
    expect(() => sheetSyncRowsFromImportPlan(plan, 'Deleted ID')).toThrow(
      'Stable key column is missing'
    );
    expect(() =>
      sheetSyncRowsFromImportPlan(
        {
          ...plan,
          records: [{ ...plan.records[0], source: { ...plan.records[0].source, 'Stable ID': '' } }],
        },
        'Stable ID'
      )
    ).toThrow('nonempty stable key');
    const duplicate = await workbook([
      ['001', 'First', bases],
      ['001', 'Second', 'ATGCGATCGTTAGCATG'],
    ]);
    expect(() => sheetSyncRowsFromImportPlan(duplicate, 'Stable ID')).toThrow('duplicated');
  });

  it('detects oligo chemistry edits even when the natural sequence is unchanged', async () => {
    const plain = sheetSyncRowsFromImportPlan(
      await workbook([['001', 'Primer', bases]]),
      'Stable ID'
    )[0];
    const modified = sheetSyncRowsFromImportPlan(
      await workbook([['001', 'Primer', `/5Phos/${bases}`]]),
      'Stable ID'
    )[0];
    expect(modified.record.fields.sequence).toEqual(plain.record.fields.sequence);
    expect(modified.record.oligoNotation).not.toEqual(plain.record.oligoNotation);
    expect(
      planSheetSync({
        sourceRows: [modified],
        checkpoints: [
          {
            key: '001',
            entityId: 'primer-id',
            artifactRelativePath: 'primers/one.primer.json',
            source: plain.record,
            applied: plain.record,
          },
        ],
        targets: [{ entityId: 'primer-id', eventSeq: 2, archived: false, record: plain.record }],
      })
    ).toMatchObject([{ kind: 'update', entityId: 'primer-id' }]);
  });

  it('rejects values that cannot roundtrip as JSON instead of silently losing them', async () => {
    const plan = await workbook([['001', 'First', bases]]);
    const invalid = {
      ...plan.records[0],
      entityDraft: {
        ...plan.records[0].entityDraft,
        fields: { collectionDate: new Date('2026-01-01') },
      },
    };
    expect(() => sheetSyncRowsFromImportPlan({ ...plan, records: [invalid] }, 'Stable ID')).toThrow(
      'finite JSON values'
    );
  });

  it('does not silently omit an unaccepted or invalid source row', async () => {
    const plan = await workbook([['001', 'First', bases]]);
    expect(() =>
      sheetSyncRowsFromImportPlan(
        { ...plan, records: [{ ...plan.records[0], accepted: false }] },
        'Stable ID'
      )
    ).toThrow('needs review');
    expect(() =>
      sheetSyncRowsFromImportPlan(
        { ...plan, records: [{ ...plan.records[0], errors: ['Invalid sequence'] }] },
        'Stable ID'
      )
    ).toThrow('needs review');
  });
});
