import { mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { defineLimsSchemaInsideTx, registerLimsEntityInsideTx } from './lims-engine-core';
import { withAgentProjectScope } from './registered-project-authority';
import { queryWorkRecordDates } from './work-record-dates';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => join(tmpdir(), 'dnaforge-work-date-test') },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

it('projects only opted-in dates from readable records and preserves an ambiguous old value', async () => {
  const f = createFileTestDb('agenda-record');
  try {
    ensureSchema(f.db, f.dbPath);
    const root = join(await realpath(f.tmpDir), 'project');
    await mkdir(root);
    const workspace = Number(
      f.db
        .prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES (?,?,?,1)')
        .run('Dates', root, 'owner').lastInsertRowid
    );
    const entity = f.db.transaction(() => {
      const schema = defineLimsSchemaInsideTx(f.db, {
        kind: 'entity',
        name: 'certificate',
        baseKind: 'sample',
        displayName: 'Certificate',
        workspaceId: workspace,
        fields: [
          {
            key: 'renewal',
            type: 'date',
            label: 'Renew by',
            agenda: { role: 'deadline', zone: 'America/New_York' },
          },
          { key: 'recorded', type: 'date', label: 'Recorded' },
        ],
      });
      return registerLimsEntityInsideTx(f.db, {
        kind: 'certificate',
        name: 'Instrument certificate',
        fields: { renewal: '2028-02-29', recorded: '2028-02-02' },
        workspaceId: workspace,
        schemaRevisionId: schema.current_revision_id!,
      });
    })();
    const agenda = () => queryWorkRecordDates(f.db, { workspaceRoot: root });
    const observed = agenda();
    expect(observed.total).toBe(1);
    expect(observed.rows[0]).toMatchObject({
      entityId: entity.id,
      fieldKey: 'renewal',
      label: 'Renew by',
      role: 'deadline',
      status: 'resolved',
      value: { kind: 'day', date: '2028-02-29', zone: 'America/New_York' },
      revisionId: String(entity.eventSeq),
    });
    const legacy = JSON.stringify({ ...entity.fields, renewal: 'Spring' });
    f.db.prepare('UPDATE lims_entity SET fields=? WHERE id=?').run(legacy, entity.id);
    expect(agenda().rows[0]).toMatchObject({
      id: observed.rows[0].id,
      status: 'unresolved',
      raw: 'Spring',
      value: null,
    });
    expect(f.db.prepare('SELECT fields FROM lims_entity WHERE id=?').get(entity.id)).toEqual({
      fields: legacy,
    });
    expect(withAgentProjectScope({ kind: 'project-roots', roots: [] }, agenda).total).toBe(0);
  } finally {
    f.cleanup();
  }
});
