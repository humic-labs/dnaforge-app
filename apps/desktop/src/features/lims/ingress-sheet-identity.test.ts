import { describe, expect, it, vi } from 'vitest';
import { createLimsImportPlan, type DryRunLimsImportInput } from './ingress';
vi.mock('../../db', () => ({ ensureSequenceIdentity: vi.fn(async () => 1) }));
vi.mock('./operations', () => ({
  queryLimsEntities: vi.fn(async () => []),
  applyLimsImportBatch: vi.fn(),
}));
const table = 'ID,Name,Sequence\n001,Same,GTAAAACGACGGCCAGT\n002,Same,GTAAAACGACGGCCAGT';
describe('external spreadsheet row identity', () => {
  it('keeps distinct durable rows with matching content while ordinary import keeps its duplicate behavior', async () => {
    const input = {
      fileName: 'sheet.csv',
      text: table,
      forcedKind: 'oligo',
      columnMappings: [
        { sourceColumn: 'ID', mappingMode: 'source_only' },
        { sourceColumn: 'Name', mappedField: 'entity.name', mappingMode: 'mapped' },
      ],
    } satisfies DryRunLimsImportInput;
    const ordinary = await createLimsImportPlan(input);
    expect(ordinary.records.map((row) => row.accepted)).toEqual([true, false]);
    const sync = await createLimsImportPlan({ ...input, externalRowKeyColumn: 'ID' });
    expect(sync.records.map((row) => [row.externalRowId, row.accepted])).toEqual([
      ['001', true],
      ['002', true],
    ]);
    expect(sync.canApply).toBe(true);
    expect(sync.records.map((row) => row.entityDraft.name)).toEqual(['Same', 'Same']);
  });
  it('rejects missing, duplicated and whitespace-changing stable keys', async () => {
    for (const text of [
      table.replace('002,', '001,'),
      table.replace('002,', ','),
      table.replace('002,', ' 002,'),
    ]) {
      await expect(
        createLimsImportPlan({
          fileName: 'sheet.csv',
          text,
          forcedKind: 'oligo',
          externalRowKeyColumn: 'ID',
        })
      ).rejects.toThrow(/stable key|row key/);
    }
    await expect(
      createLimsImportPlan({
        fileName: 'sheet.csv',
        text: table,
        forcedKind: 'oligo',
        externalRowKeyColumn: 'Deleted ID',
      })
    ).rejects.toThrow('stable-key column');
  });
  it('retains scientific validation failures for keyed rows', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'sheet.csv',
      text: 'ID,Name,Sequence\n001,Bad,???',
      forcedKind: 'oligo',
      externalRowKeyColumn: 'ID',
    });
    expect(plan.records[0].accepted).toBe(false);
    expect(plan.records[0].errors.length).toBeGreaterThan(0);
  });
});
