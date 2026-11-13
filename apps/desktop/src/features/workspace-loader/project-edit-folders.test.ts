import { beforeEach, describe, expect, it } from 'vitest';
import { platform } from '../../platform';
import { clearMockData } from '../../test/platform-mocks';
import { initializeTestSchema } from '../../test/initializeTestSchema';
import { listProjectEditFolders, mergeProjectEditFolders } from './project-edit-folders';
import { managedSequenceEditAccess } from '../lims/public/registry-record-edit-access';

describe('durable project editing availability', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
  });

  it('keeps an active legacy project editable without a sidebar folder or managed repo UUID', async () => {
    await platform().db.execute(
      'INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)',
      ['My sequences', '/projects/sequences', 1]
    );
    const folders = mergeProjectEditFolders(await listProjectEditFolders(), []);
    expect(managedSequenceEditAccess('/projects/sequences/pDEMO421', folders)).toEqual({
      canEdit: true,
      workspaceRoot: '/projects/sequences',
    });
  });

  it.each(['archived_at', 'trashed_at'] as const)(
    'requires restoration after %s even if an old sidebar entry is still writable',
    async (column) => {
      await platform().db.execute(
        `INSERT INTO workspaces (name, path, created_at, ${column}) VALUES (?, ?, ?, ?)`,
        ['My sequences', '/projects/sequences', 1, 2]
      );
      const folders = mergeProjectEditFolders(await listProjectEditFolders(), [
        { path: '/projects/sequences', pinned: false },
      ]);
      expect(managedSequenceEditAccess('/projects/sequences/pDEMO421', folders)).toMatchObject({
        canEdit: false,
        message: expect.stringContaining('Restore'),
      });
    }
  );

  it('preserves durable reference access when the sidebar was restored without its access flag', async () => {
    await platform().db.execute(
      'INSERT INTO workspaces (name, path, created_at, access_mode) VALUES (?, ?, ?, ?)',
      ['Reference sequences', '/projects/reference', 1, 'reference']
    );
    const folders = mergeProjectEditFolders(await listProjectEditFolders(), [
      { path: '/projects/reference/', name: 'Old name', pinned: false },
    ]);
    expect(folders).toHaveLength(1);
    expect(managedSequenceEditAccess('/projects/reference/pDEMO421', folders)).toMatchObject({
      canEdit: false,
      reason: 'reference',
      message: expect.stringContaining('Reference sequences'),
    });
  });
});
