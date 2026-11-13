import { describe, expect, it } from 'vitest';
import {
  planSheetSync,
  sheetSyncMappedTarget,
  sheetSyncMergedFields,
  sheetSyncRecordKey,
  type SheetSyncCheckpoint,
  type SheetSyncRecord,
  type SheetSyncTarget,
} from './sheet-sync';

function record(name = 'Primer A', notes = 'source'): SheetSyncRecord {
  return {
    kind: 'oligo',
    name,
    fields: { notes, sequence: { mode: 'inline', bases: 'ATGCGTACGTAGCTAGCTAG' } },
  };
}
const checkpoint = (key: string, value = record()): SheetSyncCheckpoint => ({
  key,
  entityId: `entity-${key}`,
  artifactRelativePath: `primers/${key}.primer.json`,
  source: value,
  applied: value,
});
const target = (key: string, value = record()): SheetSyncTarget => ({
  entityId: `entity-${key}`,
  eventSeq: 12,
  record: value,
  archived: false,
});

describe('living spreadsheet pull reconciliation', () => {
  it('preserves stable identity after rows reorder and names change', () => {
    const changes = planSheetSync({
      sourceRows: [
        { key: '002', record: record('Renamed') },
        { key: '001', record: record() },
      ],
      checkpoints: [checkpoint('001'), checkpoint('002')],
      targets: [target('001'), target('002')],
    });
    expect(changes).toEqual([
      {
        kind: 'update',
        key: '002',
        entityId: 'entity-002',
        expectedEventSeq: 12,
        source: record('Renamed'),
      },
      { kind: 'unchanged', key: '001', entityId: 'entity-001' },
    ]);
  });

  it('distinguishes source-only, local-only, matching edits and conflicts', () => {
    const changes = planSheetSync({
      sourceRows: ['source', 'local', 'same', 'conflict'].map((key) => ({
        key,
        record: key === 'local' ? record() : record('Changed'),
      })),
      checkpoints: ['source', 'local', 'same', 'conflict'].map((key) => checkpoint(key)),
      targets: [
        target('source'),
        target('local', record('Local edit')),
        target('same', record('Changed')),
        target('conflict', record('Different local edit')),
      ],
    });
    expect(changes.map((change) => [change.key, change.kind])).toEqual([
      ['source', 'update'],
      ['local', 'local-edit'],
      ['same', 'adopt'],
      ['conflict', 'conflict'],
    ]);
    expect(changes[3]).toMatchObject({ reason: 'both-edited' });
  });

  it('reports missing source rows without generating deletion or archival', () => {
    expect(
      planSheetSync({ sourceRows: [], checkpoints: [checkpoint('001')], targets: [target('001')] })
    ).toEqual([{ kind: 'missing-source', key: '001', entityId: 'entity-001' }]);
  });

  it('reports a missing target version instead of inventing an optimistic update version', () => {
    const input = {
      sourceRows: [{ key: '001', record: record('Changed') }],
      checkpoints: [checkpoint('001')],
      targets: [{ ...target('001'), eventSeq: null }],
    };
    expect(planSheetSync(input)).toEqual([
      {
        kind: 'conflict',
        key: '001',
        entityId: 'entity-001',
        reason: 'missing-target-version',
      },
    ]);
    expect(planSheetSync({ ...input, sourceRows: [{ key: '001', record: record() }] })).toEqual([
      {
        kind: 'unchanged',
        key: '001',
        entityId: 'entity-001',
      },
    ]);
  });

  it('does not recreate a missing or archived local entity', () => {
    const rows = [{ key: '001', record: record('New') }];
    expect(
      planSheetSync({ sourceRows: rows, checkpoints: [checkpoint('001')], targets: [] })
    ).toEqual([{ kind: 'conflict', key: '001', entityId: 'entity-001', reason: 'missing-target' }]);
    expect(
      planSheetSync({
        sourceRows: rows,
        checkpoints: [checkpoint('001')],
        targets: [{ ...target('001'), archived: true }],
      })[0]
    ).toMatchObject({ reason: 'archived-target' });
  });

  it('refuses missing or duplicate row keys before any apply plan is returned', () => {
    expect(() =>
      planSheetSync({ sourceRows: [{ key: '', record: record() }], checkpoints: [], targets: [] })
    ).toThrow(/stable key/);
    expect(() =>
      planSheetSync({
        sourceRows: [
          { key: '001', record: record() },
          { key: '001', record: record('Other') },
        ],
        checkpoints: [],
        targets: [],
      })
    ).toThrow(/duplicated/);
  });

  it('rejects source kind changes rather than changing the entity schema', () => {
    expect(
      planSheetSync({
        sourceRows: [{ key: '001', record: { ...record(), kind: 'protein' } }],
        checkpoints: [checkpoint('001')],
        targets: [target('001')],
      })[0]
    ).toMatchObject({ kind: 'conflict', reason: 'entity-kind-changed' });
  });

  it('is stable across object key order and rejects nonfinite scientific values', () => {
    expect(sheetSyncRecordKey({ kind: 'oligo', name: 'A', fields: { b: 2, a: 1 } })).toBe(
      sheetSyncRecordKey({ kind: 'oligo', name: 'A', fields: { a: 1, b: 2 } })
    );
    expect(() => sheetSyncRecordKey({ ...record(), fields: { concentration: NaN } })).toThrow(
      /finite/
    );
  });

  it('becomes a no-op after the same source revision is applied and survives retry', () => {
    const updated = record('Changed');
    expect(
      planSheetSync({
        sourceRows: [{ key: '001', record: updated }],
        checkpoints: [checkpoint('001', updated)],
        targets: [target('001', updated)],
      })
    ).toEqual([{ kind: 'unchanged', key: '001', entityId: 'entity-001' }]);
  });
});

describe('spreadsheet mapped field ownership', () => {
  it('preserves fields owned by local workflows while updating and removing mapped fields', () => {
    const before = { kind: 'sample', name: 'Sample', fields: { notes: 'Old', location: 'A1' } };
    const source = { kind: 'sample', name: 'Sample', fields: { notes: 'New' } };
    const local = {
      kind: 'sample',
      name: 'Sample',
      fields: { ...before.fields, customTag: 'Keep me' },
    };
    expect(sheetSyncMappedTarget(before, local)).toEqual(before);
    expect(sheetSyncMergedFields(source, before, local.fields)).toEqual({
      notes: 'New',
      customTag: 'Keep me',
    });
  });

  it('rejects two durable row keys pointing at the same entity before producing updates', () => {
    expect(() =>
      planSheetSync({
        sourceRows: [],
        checkpoints: [checkpoint('a'), { ...checkpoint('b'), entityId: 'entity-a' }],
        targets: [],
      })
    ).toThrow('share a target identity');
  });
});
