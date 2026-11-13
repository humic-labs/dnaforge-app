import { expect, it, vi } from 'vitest';
import { resolveBenchlingMigrationWorkspace } from './migration-workspace-target';

const row = {
  id: 7,
  repo_uuid: null,
  name: 'Ordinary workspace',
  path: '/lab',
  archived_at: null,
  trashed_at: null,
};
function db(rows: unknown[], locks: unknown[] = []) {
  return {
    select: vi.fn(
      async <T>(sql: string): Promise<T> => (sql.includes('restore_locks') ? locks : rows) as T
    ),
  };
}

it('resolves an ordinary or null-UUID workspace by its durable row scope', async () => {
  expect(await resolveBenchlingMigrationWorkspace('ws7', db([row]))).toEqual({
    workspaceDbId: 7,
    repoPath: '/lab',
    name: 'Ordinary workspace',
  });
});
it('keeps repository UUID identity for managed workspaces', async () => {
  expect(
    await resolveBenchlingMigrationWorkspace('uuid-a', db([{ ...row, repo_uuid: 'uuid-a' }]))
  ).toMatchObject({ workspaceDbId: 7 });
  expect(
    await resolveBenchlingMigrationWorkspace('ws7', db([{ ...row, repo_uuid: 'uuid-a' }]))
  ).toBeNull();
});
it.each([{ archived_at: 1 }, { trashed_at: 1 }, { id: 8 }])(
  'does not open an unavailable or different workspace: %j',
  async (override) => {
    expect(
      await resolveBenchlingMigrationWorkspace('ws7', db([{ ...row, ...override }]))
    ).toBeNull();
  }
);
it('rejects incomplete restore shells and ambiguous scopes', async () => {
  expect(
    await resolveBenchlingMigrationWorkspace(
      'ws7',
      db([row], [{ workspace_id: 7, status: 'restoring' }])
    )
  ).toBeNull();
  expect(
    await resolveBenchlingMigrationWorkspace('ws7', db([row, { ...row, id: 8, repo_uuid: 'ws7' }]))
  ).toBeNull();
});
