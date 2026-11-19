import { expect, it, vi } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { registerLimsEntityInsideTx, updateLimsEntityInsideTx } from './lims-engine-core';
import { queryLimsRegistrySummariesInDb } from './lims-registry-projection';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp' },
  dialog: { showErrorBox: vi.fn() },
}));

it('uses each accepted schema for native date queries and keeps an untouched imported legacy value', () => {
  const db = createTestDb();
  try {
    ensureSchema(db, ':memory:');
    const workspaceId = Number(
      db
        .prepare('INSERT INTO workspaces(name,path,created_at) VALUES(?,?,?)')
        .run('Dates', '/projects/dates', 1).lastInsertRowid
    );
    const schema = {
      schemaId: 'date-schema',
      schemaRevisionId: 'date-schema-v1',
      version: 1,
      name: 'date_record',
      displayName: 'Date record',
      baseKind: 'record',
      fields: [{ key: 'review', label: 'Review date', type: 'date' }],
    };
    const rows = ['2026-11-30', 'next Thursday', '2026-11-18'].map((review, index) =>
      db.transaction(() =>
        registerLimsEntityInsideTx(db, {
          kind: schema.name,
          name: `Review ${index}`,
          fields: { review },
          schemaSnapshot: schema,
          schemaRevisionId: schema.schemaRevisionId,
          workspaceId,
        })
      )()
    );
    const result = queryLimsRegistrySummariesInDb(db, {
      dateFilters: [
        { schemaId: schema.schemaId, fieldKey: 'review', mode: 'after', value: '2026-11-17' },
      ],
      dateSort: { schemaId: schema.schemaId, fieldKey: 'review', direction: 'asc' },
      limit: 1,
    });
    expect(result.totalCount).toBe(2);
    expect(result.summaries[0]).toMatchObject({ id: rows[2]!.id, workspaceId });
    db.transaction(() =>
      updateLimsEntityInsideTx(db, { id: rows[1]!.id, name: 'Renamed legacy record' })
    )();
    expect(
      JSON.parse(
        (
          db.prepare('SELECT fields FROM lims_entity WHERE id=?').get(rows[1]!.id) as {
            fields: string;
          }
        ).fields
      ).review
    ).toBe('next Thursday');
    expect(() =>
      db.transaction(() =>
        updateLimsEntityInsideTx(db, { id: rows[1]!.id, fields: { review: '2026-02-30' } })
      )()
    ).toThrow();
    expect(
      queryLimsRegistrySummariesInDb(db, {
        dateFilters: [{ schemaId: schema.schemaId, fieldKey: 'name', mode: 'missing' }],
      }).totalCount
    ).toBe(0);
  } finally {
    db.close();
  }
});
