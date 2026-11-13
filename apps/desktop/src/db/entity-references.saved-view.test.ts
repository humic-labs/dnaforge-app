import { createEntityReferenceInDb } from '../main/entity-reference-commands';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../main/__tests__/test-db';
import { molecularViewFixture } from '../test/fixtures/molecular-documents';

const state = vi.hoisted(() => ({ sqlite: null as Database.Database | null }));
vi.mock('./index', () => ({
  getConnection: async () => ({
    createEntityReference: async (row: Parameters<typeof createEntityReferenceInDb>[1]) =>
      createEntityReferenceInDb(state.sqlite!, row),
    updateEntityReference: async (
      id: string,
      updates: Parameters<typeof updateEntityReferenceInDb>[2]
    ) => updateEntityReferenceInDb(state.sqlite!, id, updates),
    deleteEntityReference: async (id: string) => deleteEntityReferenceInDb(state.sqlite!, id),
    execute: async (sql: string, params: unknown[] = []) =>
      state.sqlite!.prepare(sql).run(...params),
    select: async (sql: string, params: unknown[] = []) =>
      state.sqlite!.prepare(sql).all(...params),
  }),
}));
import { createEntityReference, getEntityReferenceByLocator } from './entity-references';

describe('saved view locator resolution with real SQLite', () => {
  beforeEach(() => {
    state.sqlite = createTestDb();
    state.sqlite.exec(`CREATE TABLE entity_references (
      id TEXT PRIMARY KEY, entity_type TEXT, display_label TEXT, locator TEXT,
      deep_link_params TEXT, data TEXT, source TEXT, status TEXT,
      workspace_scope TEXT, workspace_root_path TEXT, created_at INTEGER, updated_at INTEGER
    )`);
  });
  afterEach(() => state.sqlite?.close());

  it('retains saved bytes behind newer whole-view and selection chat attachments', async () => {
    const params = {
      entityType: 'structure',
      displayLabel: 'Saved view',
      locator: 'entity://structure/saved-view:chat-context',
      deepLinkParams: null,
      source: 'user',
      workspaceScope: null,
      workspaceRootPath: null,
    };
    const saved = await createEntityReference({
      ...params,
      data: await molecularViewFixture(),
    });
    const insertHistorical = state.sqlite!.prepare(`INSERT INTO entity_references
      (id, entity_type, display_label, locator, deep_link_params, data, source, status,
       workspace_scope, workspace_root_path, created_at, updated_at)
      VALUES (@id, @entity_type, @display_label, @locator, @deep_link_params, @data,
        @source, @status, @workspace_scope, @workspace_root_path, @created_at, @updated_at)`);
    for (const [index, data] of [
      null,
      JSON.stringify({ kind: 'structure', measured: { residueCount: 2 } }),
    ].entries())
      insertHistorical.run({
        ...saved,
        id: crypto.randomUUID(),
        data,
        created_at: saved.created_at + index + 1,
      });
    expect((await getEntityReferenceByLocator(params.locator))?.id).toBe(saved.id);
    expect(await getEntityReferenceByLocator('entity://structure/saved-view:missing')).toBeNull();
  });
});
