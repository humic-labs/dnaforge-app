import {
  createEntityReferenceInDb,
  updateEntityReferenceInDb,
  deleteEntityReferenceInDb,
} from '../main/entity-reference-commands';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../main/__tests__/test-db';
import { molecularViewFixture } from '../test/fixtures/molecular-documents';
import { molecularViewTargetLocator } from '../shared/molecular-reference';
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
import {
  createEntityReference,
  deleteEntityReference,
  getEntityReference,
  linkReferenceToMessage,
  updateEntityReference,
  type DBEntityReference,
} from './entity-references';

beforeEach(() => {
  state.sqlite = createTestDb();
  state.sqlite.exec(`CREATE TABLE entity_references (
    id TEXT PRIMARY KEY, entity_type TEXT, display_label TEXT, locator TEXT,
    deep_link_params TEXT, data TEXT, source TEXT, status TEXT,
    workspace_scope TEXT, workspace_root_path TEXT, created_at INTEGER, updated_at INTEGER
  ); CREATE TABLE message_references (message_id TEXT, reference_id TEXT, position INTEGER)`);
});
afterEach(() => state.sqlite?.close());

async function reference(kind: string | null): Promise<DBEntityReference> {
  const snapshot = kind === 'molecular-view-target' ? await reference('molecular-view') : null;
  const target = snapshot
    ? {
        kind: 'molecular-view-target' as const,
        version: 1 as const,
        viewReferenceId: snapshot.id,
        snapshotIndex: 0,
      }
    : null;
  return createEntityReference({
    entityType: kind ? 'structure' : 'external',
    displayLabel: 'Original result',
    locator: target
      ? molecularViewTargetLocator(target)
      : kind
        ? `entity://structure/saved-view:${crypto.randomUUID()}`
        : 'https://example.org/ordinary',
    deepLinkParams: null,
    data: target ?? (kind ? await molecularViewFixture() : null),
    source: 'ai',
    workspaceScope: null,
    workspaceRootPath: null,
  });
}

describe('immutable molecular result persistence', () => {
  it('rejects rewriting pinned content, locator or status through generic reference updates', async () => {
    const saved = await reference('molecular-view');
    await expect(
      updateEntityReference(saved.id, { data: { kind: 'molecular-view', scene: 'replacement' } })
    ).rejects.toThrow(/immutable/i);
    await expect(
      updateEntityReference(saved.id, { locator: 'entity://structure/replacement' })
    ).rejects.toThrow(/immutable/i);
    await expect(updateEntityReference(saved.id, { status: 'deleted' })).rejects.toThrow(
      /immutable/i
    );
    expect((await getEntityReference(saved.id))?.data).toBe(saved.data);
  });

  it('preserves snapshots and exact named-view targets used by historical messages', async () => {
    for (const kind of ['molecular-view', 'molecular-view-target']) {
      const saved = await reference(kind);
      await linkReferenceToMessage(crypto.randomUUID(), saved.id, 0);
      await expect(deleteEntityReference(saved.id)).rejects.toThrow(/immutable|referenced/i);
      expect(await getEntityReference(saved.id)).not.toBeNull();
    }
  });

  it('leaves ordinary reference updates and deletion unchanged', async () => {
    const ordinary = await reference(null);
    await updateEntityReference(ordinary.id, { displayLabel: 'Renamed', status: 'updated' });
    expect((await getEntityReference(ordinary.id))?.display_label).toBe('Renamed');
    await deleteEntityReference(ordinary.id);
    expect(await getEntityReference(ordinary.id)).toBeNull();
  });
});
