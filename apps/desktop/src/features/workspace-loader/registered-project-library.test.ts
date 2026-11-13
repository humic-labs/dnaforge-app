import { beforeEach, expect, it } from 'vitest';
import { clearMockData } from '../../test/platform-mocks';
import { initializeTestSchema } from '../../test/initializeTestSchema';
import { platform } from '../../platform';
import {
  archiveWorkspaceByPath,
  listWorkspaceLibrary,
  restoreFromTrash,
  restoreWorkspace,
  trashWorkspaceByPath,
} from './workspace-library';

beforeEach(async () => {
  clearMockData();
  await initializeTestSchema();
});

it('keeps untracked writable projects discoverable and recoverable across library refreshes', async () => {
  const repoPath = '/Users/me/Track views';
  await platform().db.ensureWorkspaceOwner(repoPath, 'writable', {
    name: 'Track views',
    recordOpen: true,
  });
  await platform().db.ensureWorkspaceOwner('/fixtures', 'reference');
  const original = (await listWorkspaceLibrary()).active;
  expect(original).toHaveLength(1);
  expect(original[0]).toMatchObject({ repoPath, repoUuid: null, name: 'Track views' });
  expect(await archiveWorkspaceByPath(repoPath)).toBe(1);
  let library = await listWorkspaceLibrary();
  expect(library.active).toEqual([]);
  expect(library.archived).toHaveLength(1);
  expect(await restoreWorkspace(library.archived[0])).toBe(1);
  expect(await trashWorkspaceByPath(repoPath)).toBe(1);
  library = await listWorkspaceLibrary();
  expect(library.active).toEqual([]);
  expect(library.trashed).toHaveLength(1);
  expect(await restoreFromTrash(library.trashed[0])).toBe(1);
  expect((await listWorkspaceLibrary()).active).toEqual(original);
});
