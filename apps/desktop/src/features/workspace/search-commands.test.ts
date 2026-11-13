import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ select: vi.fn(), rows: vi.fn() }));
vi.mock('../../platform', () => ({ platform: () => ({ db: { select: native.select } }) }));

import {
  searchWorkspace,
  workspaceSearchSchema,
  type WorkspaceSearchRequest,
  type WorkspaceSearchContext,
} from './search-commands';
import { searchMountedCatalogEntityPage } from '../../db/catalog-reference-search';

const projects = [
  { name: 'Alpha', path: '/ws/alpha' },
  { name: 'Beta', path: '/ws/beta' },
];
const row = (id: string, root: string, type = 'sequence') => ({
  entity_id: id,
  entity_type: type,
  name: 'Duplicate',
  storage_type: 'file',
  metadata: null,
  workspace_root: root,
  workspace_name: root.endsWith('alpha') ? 'Alpha' : 'Beta',
  updated_at: 100,
});

beforeEach(() => {
  native.rows.mockReset().mockResolvedValue([]);
  native.select.mockReset().mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('SELECT COUNT(*) AS match_count')) return [{ match_count: 2 }];
    return native.rows(sql, params);
  });
});

describe('shared workspace search command', () => {
  it('returns exact duplicate identities on bounded pages with a stable tie break', async () => {
    native.rows.mockResolvedValueOnce([row('alpha-1', '/ws/alpha'), row('beta-1', '/ws/beta')]);
    const first = await searchWorkspace({ query: 'Duplicate', limit: 1 }, () => ({ projects }));
    expect(first.results.map((result) => [result.entityId, result.workspaceRoot])).toEqual([
      ['alpha-1', '/ws/alpha'],
    ]);
    expect(first.nextCursor).toBeTruthy();
    native.rows.mockResolvedValueOnce([row('beta-1', '/ws/beta')]);
    const second = await searchWorkspace(
      { query: 'Duplicate', limit: 1, cursor: first.nextCursor! },
      () => ({ projects })
    );
    expect(second.results.map((result) => result.entityId)).toEqual(['beta-1']);
    expect(second.nextCursor).toBeNull();
    const [sql, params] = native.rows.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('e.id > ? OR (e.id = ? AND w.path > ?)');
    expect(sql).toContain('e.id ASC, w.path ASC LIMIT ?');
    expect(params.slice(-8)).toEqual([
      'Duplicate',
      'Duplicate',
      100,
      100,
      'alpha-1',
      'alpha-1',
      '/ws/alpha',
      2,
    ]);
  });

  it('binds continuations to query, admitted projects and type filters', async () => {
    native.rows.mockResolvedValueOnce([row('alpha-1', '/ws/alpha'), row('beta-1', '/ws/beta')]);
    const first = await searchWorkspace({ query: 'Duplicate', limit: 1 }, () => ({ projects }));
    for (const [request, currentProjects] of [
      [{ query: 'Other', cursor: first.nextCursor! }, projects],
      [{ query: 'Duplicate', cursor: first.nextCursor! }, projects.slice(0, 1)],
      [{ query: 'Duplicate', types: ['notebook'], cursor: first.nextCursor! }, projects],
    ] satisfies [WorkspaceSearchRequest, WorkspaceSearchContext['projects']][]) {
      await expect(
        searchWorkspace(request, () => ({ projects: currentProjects }))
      ).rejects.toMatchObject({
        code: 'SEARCH_CURSOR_INVALID',
      });
    }
    expect(native.select).toHaveBeenCalledTimes(2);
  });

  it('resolves a project only from admitted roots and excludes installation-wide rows', async () => {
    native.rows.mockResolvedValueOnce([row('beta-1', '/ws/beta'), row('foreign-1', '/ws/foreign')]);
    const result = await searchWorkspace(
      { query: 'Duplicate', project: 'Beta', types: ['sequence'] },
      () => ({ projects })
    );
    expect(result.projects).toEqual([{ name: 'Beta', root: '/ws/beta' }]);
    expect(result.results.map((entry) => entry.entityId)).toEqual(['beta-1']);
    const [sql, params] = native.rows.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('w.path IN (?)');
    expect(params).toContain('/ws/beta');
    expect(params).not.toContain('/ws/alpha');
    expect(sql).toContain("e.status = 'active'");
    expect(sql).toContain("f.status = 'current'");
    expect(sql).toContain('w.archived_at IS NULL');
    expect(sql).toContain('w.trashed_at IS NULL');
    await expect(
      searchWorkspace({ query: 'Duplicate', project: '/ws/foreign' }, () => ({ projects }))
    ).rejects.toMatchObject({ code: 'SEARCH_PROJECT_UNAVAILABLE' });
    expect(native.select).toHaveBeenCalledTimes(2);
  });

  it('keeps all existing searchable kinds and escapes literal wildcards', async () => {
    await searchWorkspace({ query: '100%_match', limit: 100 }, () => ({ projects }));
    const [, params] = native.rows.mock.calls[0] as [string, unknown[]];
    expect(params.slice(0, 17)).toEqual(
      expect.arrayContaining([
        'track-view',
        'molecular-document',
        'sequence',
        'primer',
        'notebook',
        'design',
        'alignment',
        'trace',
        'report',
        'construct',
        'sample',
        'record',
        'structure',
        'protein',
        'protocol',
        'protocol_run',
        'file',
      ])
    );
    expect(params).toContain('%100\\%\\_match%');
  });

  it('continues beyond filtered malformed rows without presenting a false final page', async () => {
    native.rows.mockResolvedValueOnce([
      row('invalid identity', '/ws/alpha'),
      row('second invalid identity', '/ws/alpha'),
    ]);
    const result = await searchMountedCatalogEntityPage({
      query: 'Duplicate',
      workspaceRoots: ['/ws/alpha'],
      limit: 1,
    });
    expect(result.results).toEqual([]);
    expect(result.nextPosition).toMatchObject({ entityId: 'second invalid identity' });
  });

  it('does not return a result after its admitted workspace closes during the query', async () => {
    let current = projects;
    native.rows.mockImplementationOnce(async () => {
      current = [];
      return [row('alpha-1', '/ws/alpha')];
    });
    await expect(
      searchWorkspace({ query: 'Duplicate' }, () => ({ projects: current }))
    ).rejects.toMatchObject({ code: 'SEARCH_SCOPE_CHANGED' });
  });

  it('rejects arbitrary root arguments, malformed continuations and oversized requests', async () => {
    expect(
      workspaceSearchSchema.safeParse({ query: 'Duplicate', workspaceRoots: ['/private'] }).success
    ).toBe(false);
    expect(workspaceSearchSchema.safeParse({ query: 'Duplicate', limit: 101 }).success).toBe(false);
    await expect(
      searchWorkspace({ query: 'Duplicate', cursor: '%bad' }, () => ({ projects }))
    ).rejects.toMatchObject({ code: 'SEARCH_CURSOR_INVALID' });
    expect(native.select).not.toHaveBeenCalled();
  });
});
