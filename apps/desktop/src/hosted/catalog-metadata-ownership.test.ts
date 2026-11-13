// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostedMemoryDb } from './memory-db';
import { getCatalogWorkspaceRootForFilePath } from '../db/workspace-catalog';

const connection = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock('../platform', () => ({ platform: () => ({ db: connection }) }));

describe('hosted catalog metadata ownership', () => {
  beforeEach(() => {
    connection.select.mockReset();
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
