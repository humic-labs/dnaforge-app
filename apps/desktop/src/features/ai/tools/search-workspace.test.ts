import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  select: vi.fn(),
  folders: [{ name: 'Admitted', path: '/ws/admitted', addedAt: 0 }],
}));
vi.mock('../../../platform', () => ({ platform: () => ({ db: { select: native.select } }) }));
vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: native.folders }) },
}));
vi.mock('../../design/public/store', () => ({
  useDesignStore: { getState: () => ({ designs: {} }) },
}));

import { createSearchWorkspaceTool, searchWorkspaceSchema } from './search-workspace';

const options = { toolCallId: 'workspace-search', messages: [] };
const execute = (input: unknown) =>
  createSearchWorkspaceTool([{ name: 'Admitted', path: '/ws/admitted', addedAt: 0 }]).execute!(
    searchWorkspaceSchema.parse(input),
    options
  );

beforeEach(() => {
  native.select
    .mockReset()
    .mockImplementation(async (sql: string) =>
      sql.includes('AS match_count') ? [{ match_count: 0 }] : []
    );
  native.folders = [{ name: 'Admitted', path: '/ws/admitted', addedAt: 0 }];
});

describe('search_workspace adapter', () => {
  it('returns the advertised identity fields for files that have sidebar icons', async () => {
    native.select.mockImplementation(async (sql: string) =>
      sql.includes('AS match_count') ? [{ match_count: 1 }] : [{
        entity_id: 'sample-file', entity_type: 'file', name: 'Sample',
        workspace_root: '/ws/admitted', workspace_name: 'Admitted',
        storage_type: 'file', icon_kind: 'text', icon_path: 'notes/sample.txt',
        metadata: null, updated_at: 1,
      }]
    );
    const result = await execute({ query: 'sample' });
    expect(result).toEqual({
      ok: true, query: 'sample', projects: [{ name: 'Admitted', root: '/ws/admitted' }],
      nextCursor: null, results: [{
        entityId: 'sample-file', entityType: 'file', name: 'Sample',
        workspaceRoot: '/ws/admitted', workspaceName: 'Admitted',
      }],
    });
  });

  it('uses the current admitted mounted roots and returns explicit read-only outcomes', async () => {
    native.folders.push({ name: 'Other', path: '/ws/other', addedAt: 0 });
    expect(await execute({ query: 'sample' })).toMatchObject({
      ok: true,
      results: [],
      projects: [{ name: 'Admitted', root: '/ws/admitted' }],
    });
    expect(native.select.mock.calls.flatMap(([, params]) => params ?? [])).not.toContain(
      '/ws/other'
    );
    expect(await execute({ query: 'sample', project: 'Other' })).toMatchObject({
      ok: false,
      code: 'SEARCH_PROJECT_UNAVAILABLE',
      stateChanged: false,
    });
  });

  it('does not retain access to a project closed after tool construction', async () => {
    const tool = createSearchWorkspaceTool(native.folders);
    native.folders = [];
    expect(
      await tool.execute!(searchWorkspaceSchema.parse({ query: 'sample' }), options)
    ).toMatchObject({ ok: true, projects: [], results: [] });
    expect(native.select).not.toHaveBeenCalled();
  });
});
