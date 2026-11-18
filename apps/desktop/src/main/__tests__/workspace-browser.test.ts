import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { ensureSchema } from '../schema';
import { createTestDb } from './test-db';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: vi.fn() } }));
vi.mock('../ipc/path-allowlist', () => ({
  assertSafePath: vi.fn(async (path: string) => path),
}));

import { listWorkspaceChildren } from '../ipc/workspace-browser';

describe('workspace:listChildren', () => {
  let db: Database.Database;
  let root: string;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    root = mkdtempSync(join(tmpdir(), 'workspace-browser-'));
    mkdirSync(join(root, 'Strains'));
    writeFileSync(join(root, 'Strains', 'notes.txt'), 'notes');
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_opened_at)
       VALUES (1, 'Lab', ?, 0, 0)`
    ).run(root);
    db.prepare(
      `INSERT INTO catalog_entities
         (id, type, name, locator, storage_type, status, workspace_id, created_at, updated_at)
       VALUES ('strain-1', 'sample', 'Strain A', 'entity://lims/strain-1', 'database',
               'active', 1, 0, 0)`
    ).run();
    db.prepare(
      `INSERT INTO catalog_workspace_placements
         (entity_id, workspace_id, parent_relative_path, display_name,
          normalized_sibling_name, presentation_kind, status, created_at, updated_at)
       VALUES ('strain-1', 1, 'Strains', 'Strain A', 'strain a', 'strain', 'active', 0, 0)`
    ).run();
    db.prepare(
      `INSERT INTO catalog_provider_bindings
         (id, provider, stable_object_id, object_class, entity_id, binding_kind,
          evidence_json, created_at, updated_at)
       VALUES ('binding-1', 'benchling', 'bfi_STRAINAA', 'registry_item', 'strain-1',
               'observed', '{}', 0, 0)`
    ).run();
  });

  afterEach(() => db.close());

  it('merges filesystem children with exact-parent catalog placements', async () => {
    const result = await listWorkspaceChildren(db, {
      workspaceRoot: root,
      parentRelativePath: 'Strains',
    });

    expect(result.partialError).toBeNull();
    expect(result.entries).toEqual([
      expect.objectContaining({
        kind: 'filesystem',
        entryId: `filesystem:${join(root, 'Strains', 'notes.txt')}`,
        path: join(root, 'Strains', 'notes.txt'),
      }),
      {
        kind: 'catalog',
        entryId: 'catalog:strain-1',
        workspaceId: 1,
        entityId: 'strain-1',
        sourceRecordId: 'bfi_STRAINAA',
        name: 'Strain A',
        parentRelativePath: 'Strains',
        presentationKind: 'strain',
      },
    ]);
  });

  it('returns filesystem children with a structured partial error when catalog listing fails', async () => {
    db.exec('DROP TABLE catalog_workspace_placements');

    const result = await listWorkspaceChildren(db, {
      workspaceRoot: root,
      parentRelativePath: 'Strains',
    });

    expect(result.entries).toEqual([
      expect.objectContaining({ kind: 'filesystem', name: 'notes.txt' }),
    ]);
    expect(result.partialError).toMatchObject({
      source: 'catalog',
      code: 'catalog_listing_failed',
    });
  });

  it('projects native artifact kinds from current bindings in the requested workspace', async () => {
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_opened_at)
       VALUES (2, 'Other', ?, 0, 0)`
    ).run(join(root, 'Other'));
    db.prepare(
      `INSERT INTO lims_schema
         (id, kind, name, display_name, fields, created_at, updated_at)
       VALUES ('icon-schema', 'entity', 'icon-test', 'Icon test', '[]', 0, 0)`
    ).run();
    db.prepare(
      `INSERT INTO lims_schema_revision (id, schema_id, version, fields, created_at)
       VALUES ('icon-revision', 'icon-schema', 1, '[]', 0)`
    ).run();

    for (const artifact of [
      { id: 'native-protein', type: 'record', workspaceId: 1, status: 'current', metadata: {} },
      {
        id: 'rna-primer',
        type: 'primer',
        workspaceId: 1,
        status: 'current',
        metadata: { entitySchema: { name: 'rna_oligo' } },
      },
      { id: 'other-workspace', type: 'protein', workspaceId: 2, status: 'current', metadata: {} },
      { id: 'historical', type: 'protein', workspaceId: 1, status: 'historical', metadata: {} },
    ]) {
      const path = join(root, 'Strains', `${artifact.id}.entity.json`);
      writeFileSync(path, '{}');
      db.prepare(
        `INSERT INTO catalog_entities
           (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'file', 'active', ?, ?, 0, 0)`
      ).run(
        artifact.id,
        artifact.type,
        artifact.id,
        `entity://test/${artifact.id}`,
        artifact.workspaceId,
        JSON.stringify(artifact.metadata)
      );
      db.prepare(
        `INSERT INTO catalog_entity_files
           (id, entity_id, workspace_id, path, file_kind, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'entity-record', ?, 0, 0)`
      ).run(artifact.id, artifact.id, artifact.workspaceId, path, artifact.status);
    }
    db.prepare(
      `INSERT INTO lims_entity
         (id, kind, schema_revision_id, name, fields, registration_status, created_at, updated_at)
       VALUES ('native-protein', 'protein', 'icon-revision', 'Protein', '{}', 'tracked', 0, 0)`
    ).run();

    const result = await listWorkspaceChildren(db, {
      workspaceRoot: root,
      parentRelativePath: 'Strains',
    });
    expect(result.partialError).toBeNull();
    const contexts = new Map(
      result.entries
        .filter((entry) => entry.kind === 'filesystem')
        .map((entry) => [entry.name, entry.iconContext])
    );
    expect(contexts.get('native-protein.entity.json')).toMatchObject({ kind: 'protein' });
    expect(contexts.get('rna-primer.entity.json')).toMatchObject({ kind: 'rna_oligo' });
    expect(contexts.get('other-workspace.entity.json')).toBeUndefined();
    expect(contexts.get('historical.entity.json')).toBeUndefined();
    expect(contexts.get('notes.txt')).toBeUndefined();
  });

  it('lists an unregistered developer source without querying file bindings', async () => {
    const sourceRoot = join(root, 'Strains');
    db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,0)').run(
      'developer-import-source-roots',
      JSON.stringify([sourceRoot])
    );
    db.exec('DROP TABLE catalog_entity_files');

    const result = await listWorkspaceChildren(db, {
      workspaceRoot: sourceRoot,
      parentRelativePath: '',
    });
    expect(result.workspaceId).toBeNull();
    expect(result.partialError).toBeNull();
    expect(result.entries).toEqual([
      expect.objectContaining({ kind: 'filesystem', name: 'notes.txt' }),
    ]);
  });

  it('rejects unsafe parents and inactive workspace rows before listing', async () => {
    await expect(
      listWorkspaceChildren(db, { workspaceRoot: root, parentRelativePath: '../outside' })
    ).rejects.toThrow('WORKSPACE_BROWSER_UNSAFE_PARENT');

    db.prepare('UPDATE workspaces SET archived_at = 1 WHERE id = 1').run();
    await expect(
      listWorkspaceChildren(db, { workspaceRoot: root, parentRelativePath: '' })
    ).rejects.toThrow('WORKSPACE_BROWSER_NOT_MOUNTED');
  });

  it('browses an explicit developer source without creating a project or catalog record', async () => {
    const sourceRoot = join(root, 'Strains');
    db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,0)').run(
      'developer-import-source-roots',
      JSON.stringify([sourceRoot])
    );
    const before = db.prepare('SELECT * FROM workspaces').all();
    const catalogBefore = db.prepare('SELECT * FROM catalog_entities').all();
    const result = await listWorkspaceChildren(db, {
      workspaceRoot: sourceRoot,
      parentRelativePath: '',
    });
    expect(result).toMatchObject({ workspaceId: null, partialError: null });
    expect(result.entries).toEqual([
      expect.objectContaining({ kind: 'filesystem', name: 'notes.txt' }),
    ]);
    expect(db.prepare('SELECT * FROM workspaces').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM catalog_entities').all()).toEqual(catalogBefore);
  });
});
