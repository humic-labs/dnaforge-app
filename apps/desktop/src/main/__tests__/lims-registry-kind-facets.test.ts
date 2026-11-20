import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, dialog: { showErrorBox: vi.fn() }, app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() } }));
import type Database from 'better-sqlite3';
import { ensureSchema } from '../schema';
import { createTestDb } from './test-db';
import { seedOriginalProjectFixture } from './original-project-fixture';
import { queryLimsRegistrySummariesInDb, registerLimsEntityInDb } from '../lims';

let db: Database.Database;
let alpha: number;
let beta: number;
beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  alpha = seedOriginalProjectFixture(db).workspaceId;
  beta = Number(db.prepare('INSERT INTO workspaces (name,path,created_at) VALUES (?,?,?)').run('Beta', '/beta', 1).lastInsertRowid);
  registerLimsEntityInDb(db, { kind: 'strain', name: 'Alpha strain one', fields: {}, workspaceId: alpha });
  registerLimsEntityInDb(db, { kind: 'strain', name: 'Alpha strain two', fields: {}, workspaceId: alpha });
  registerLimsEntityInDb(db, { kind: 'oligo', name: 'Beta primer', fields: { sequence: { mode: 'inline', bases: 'ACGT', topology: 'linear', length: 4 } }, workspaceId: beta });
  const archived = registerLimsEntityInDb(db, { kind: 'protein', name: 'Archived protein', fields: {}, workspaceId: beta });
  db.prepare('UPDATE lims_entity SET tombstone=1 WHERE id=?').run(archived.id);
});
afterEach(() => db.close());

it('counts every eligible entity type before pagination, ignoring only the selected type filter', () => {
  const page = queryLimsRegistrySummariesInDb(db, { kinds: ['strain'], limit: 1, offset: 1 });
  expect(page.summaries).toHaveLength(1);
  expect(page.availableKinds).toEqual([{ kind: 'oligo', count: 1 }, { kind: 'strain', count: 2 }]);
});
it('respects the selected projects and non-type search criteria', () => {
  expect(queryLimsRegistrySummariesInDb(db, { workspaceIds: [alpha] }).availableKinds).toEqual([{ kind: 'strain', count: 2 }]);
  expect(queryLimsRegistrySummariesInDb(db, { workspaceIds: [beta], search: 'primer' }).availableKinds).toEqual([{ kind: 'oligo', count: 1 }]);
  expect(queryLimsRegistrySummariesInDb(db, { search: 'no matching records' }).availableKinds).toEqual([]);
});
it('includes archived types only when the caller includes archived records', () => {
  expect(queryLimsRegistrySummariesInDb(db, { workspaceIds: [beta], includeArchived: true }).availableKinds).toEqual([{ kind: 'oligo', count: 1 }, { kind: 'protein', count: 1 }]);
});
