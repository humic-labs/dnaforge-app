import { createEntityReferenceInDb } from '../main/entity-reference-commands';
import { afterEach, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../main/__tests__/test-db';
import { molecularViewFixture } from '../test/fixtures/molecular-documents';
import { coordinateDigest } from '../shared/molecular-view';
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
    select: async (sql: string, params: unknown[]) => state.sqlite!.prepare(sql).all(...params),
    execute: async (sql: string, params: unknown[]) => state.sqlite!.prepare(sql).run(...params),
  }),
}));
import { createEntityReference, listSavedMolecularViews } from './entity-references';
afterEach(() => state.sqlite?.close());

it('lists bounded molecular-view metadata only in the current workspace', async () => {
  const privateText = 'large private bytes';
  const privateDigest = await coordinateDigest(privateText);
  state.sqlite = createTestDb();
  state.sqlite.exec(
    `CREATE TABLE entity_references (id TEXT PRIMARY KEY, entity_type TEXT, display_label TEXT, locator TEXT, deep_link_params TEXT, data TEXT, source TEXT, status TEXT, workspace_scope TEXT, workspace_root_path TEXT, created_at INTEGER, updated_at INTEGER)`
  );
  for (const [label, scope, kind] of [
    ['included', 'workspace-a', 'molecular-view'],
    ['other workspace', 'workspace-b', 'molecular-view'],
    ['other kind', 'workspace-a', 'selection'],
  ]) {
    await createEntityReference({
      entityType: 'structure',
      displayLabel: label,
      locator:
        kind === 'molecular-view'
          ? `entity://structure/saved-view:${crypto.randomUUID()}`
          : 'entity://structure/ordinary',
      deepLinkParams: null,
      data:
        kind === 'molecular-view'
          ? {
              ...(await molecularViewFixture()),
              coordinates: { format: 'pdb', text: privateText, sha256: privateDigest },
            }
          : { kind },
      source: 'inspection',
      workspaceScope: scope,
      workspaceRootPath: null,
    });
  }
  const rows = await listSavedMolecularViews('workspace-a');
  expect(rows).toHaveLength(1);
  expect(rows[0].display_label).toBe('included');
  expect(JSON.stringify(rows)).not.toContain('private bytes');
  expect(Object.keys(rows[0]).sort()).toEqual(['created_at', 'display_label', 'id']);
});
