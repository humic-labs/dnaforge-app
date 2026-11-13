import { beforeEach, describe, expect, it, vi } from 'vitest';

const select = vi.hoisted(() => vi.fn());

vi.mock('../platform', () => ({
  platform: () => ({ db: { select } }),
}));

import { listSearchableProjectRoots, resolveProjectRoot } from './project-roots';

const projects = [
  { id: 1, path: '/lib/alpha/repo/', repo_uuid: 'repo-alpha', archived_at: null, trashed_at: null },
  { id: 2, path: '/lib/beta/repo', repo_uuid: 'repo-beta', archived_at: 1, trashed_at: null },
  { id: 3, path: '/lib/gamma/repo', repo_uuid: 'repo-gamma', archived_at: null, trashed_at: 1 },
  { id: 4, path: '/lib/delta/repo', repo_uuid: 'repo-delta', archived_at: null, trashed_at: null },
  { id: 5, path: '/samples/standard', repo_uuid: null, archived_at: null, trashed_at: null },
  {
    id: 6,
    path: '/lib/epsilon/repo',
    repo_uuid: 'repo-epsilon',
    archived_at: null,
    trashed_at: null,
  },
];

beforeEach(() => {
  select.mockReset().mockImplementation(async (sql: string) =>
    sql.includes('workspace_sync_restore_locks')
      ? [
          { workspace_id: 4, status: 'staged' },
          { workspace_id: 6, status: 'completed' },
        ]
      : projects
  );
});

describe('searchable projects', () => {
  it('lists every active library project plus the folders open in the sidebar', async () => {
    expect(await listSearchableProjectRoots(['/samples/standard', '/lib/alpha/repo'])).toEqual([
      '/lib/alpha/repo',
      '/lib/epsilon/repo',
      '/samples/standard',
    ]);
  });

  it('finds a project folder from the project id a link stores', async () => {
    expect(await resolveProjectRoot('repo-epsilon')).toBe('/lib/epsilon/repo');
    expect(await resolveProjectRoot('ws5')).toBe('/samples/standard');
  });

  it('does not resolve archived, trashed, restoring or unknown projects', async () => {
    for (const id of ['repo-beta', 'repo-gamma', 'repo-delta', 'repo-unknown', '']) {
      expect(await resolveProjectRoot(id)).toBeNull();
    }
  });
});
