// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostedMemoryDb } from './memory-db';
import {
  getCatalogIconContextsForPaths,
  getCatalogWorkspaceRootForFilePath,
} from '../db/workspace-catalog';

const connection = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock('../platform', () => ({ platform: () => ({ db: connection }) }));

describe('hosted catalog metadata ownership', () => {
  beforeEach(() => {
    connection.select.mockReset();
  });

  it('projects raw artifact kinds from bounded current bindings after restoring hosted memory', async () => {
    const db = createHostedMemoryDb();
    const root = '/hosted/owner';
    await db.execute('INSERT INTO workspaces (id,name,path) VALUES (?,?,?)', [1, 'Project', root]);
    for (const [id, kind, name] of [
      ['rna', 'rna_oligo', 'RNA.primer.json'],
      ['protein', 'protein', 'Protein.entity.json'],
    ]) {
      await db.execute(
        'INSERT INTO catalog_entities (id,type,name,status,workspace_id,metadata) VALUES (?,?,?,?,?,?)',
        [id, 'record', name, 'active', 1, null]
      );
      await db.execute(
        'INSERT INTO catalog_entity_files (id,entity_id,workspace_id,path,status) VALUES (?,?,?,?,?)',
        [id, id, 1, `${root}/${name}`, 'current']
      );
      await db.execute('INSERT INTO lims_entity (id,kind) VALUES (?,?)', [id, kind]);
    }
    const restored = createHostedMemoryDb(db.snapshot());
    connection.select.mockImplementation(restored.select);
    const contexts = await getCatalogIconContextsForPaths(root, [
      `${root}/RNA.primer.json`,
      `${root}/Protein.entity.json`,
      `${root}/missing.entity.json`,
      '/hosted/other/secret.entity.json',
    ]);
    expect([...contexts.keys()]).toEqual([
      `${root}/RNA.primer.json`,
      `${root}/Protein.entity.json`,
    ]);
    expect(contexts.get(`${root}/RNA.primer.json`)).toMatchObject({ kind: 'rna_oligo' });
    expect(contexts.get(`${root}/Protein.entity.json`)).toMatchObject({ kind: 'protein' });
    await restored.execute('UPDATE catalog_entity_files SET status = ? WHERE id = ?', [
      'historical',
      'protein',
    ]);
    expect((await getCatalogIconContextsForPaths(root, [`${root}/Protein.entity.json`])).size).toBe(
      0
    );
  });

  it('resolves the exact saved oligo project after restoring the hosted database', async () => {
    const db = createHostedMemoryDb();
    await db.execute('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)', [
      1,
      'Project',
      '/hosted/other',
    ]);
    await db.execute('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)', [
      2,
      'Project',
      '/hosted/owner',
    ]);
    const path = '/hosted/owner/primers/saved.primer.json';
    await db.execute('INSERT INTO catalog_entity_files (path, workspace_id) VALUES (?, ?)', [
      path,
      2,
    ]);
    const restored = createHostedMemoryDb(db.snapshot());
    connection.select.mockImplementation(restored.select);

    await expect(getCatalogWorkspaceRootForFilePath(path)).resolves.toBe('/hosted/owner');
    await expect(getCatalogWorkspaceRootForFilePath(`${path}.missing`)).resolves.toBeNull();

    await restored.execute('DELETE FROM workspaces WHERE id = ?', [2]);
    await expect(getCatalogWorkspaceRootForFilePath(path)).resolves.toBeNull();
  });
});
