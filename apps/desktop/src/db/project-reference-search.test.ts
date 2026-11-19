import { beforeEach, describe, expect, it, vi } from 'vitest';

const select = vi.hoisted(() => vi.fn());

vi.mock('../platform', () => ({
  platform: () => ({
    db: {
      select: (sql: string, params: unknown[]) =>
        sql.includes('AS match_count')
          ? Promise.resolve([{ match_count: 0 }])
          : select(sql, params),
    },
  }),
}));

import { searchProjectReferencesByName } from './project-reference-search';

function row(overrides: Record<string, unknown>) {
  return {
    entity_id: 'ent',
    entity_type: 'structure',
    name: 'name',
    path: '/lib/alpha/repo/structures/1BNA.pdb',
    relative_path: 'structures/1BNA.pdb',
    content_hash: null,
    object_uuid: null,
    file_kind: 'pdb',
    project_workspace_id: 1,
    project_repo_uuid: 'repo-alpha',
    project_root: '/lib/alpha/repo',
    project_name: 'Alpha lab',
    ...overrides,
  };
}

beforeEach(() => {
  select.mockReset().mockResolvedValue([]);
});

describe('project reference search', () => {
  it('retains canonical RNA classification beside a generic sequence transport type', async () => {
    select.mockResolvedValue([
      row({
        entity_type: 'sequence',
        icon_kind: 'rna_sequence',
        metadata: JSON.stringify({ classificationDecision: { molecule: 'rna' } }),
        path: '/lib/alpha/repo/transcript.gb',
        relative_path: 'transcript.gb',
      }),
    ]);
    const result = await searchProjectReferencesByName({
      query: '',
      entityTypes: ['sequence'],
      workspaceRoots: ['/lib/alpha/repo'],
    });
    expect(result.candidates[0]).toMatchObject({
      iconContext: { kind: 'rna_sequence', molecule: 'rna' },
    });
  });

  it('queries every given project in one statement and ranks the preferred project first', async () => {
    await searchProjectReferencesByName({
      query: '1BNA',
      entityTypes: ['structure', 'file'],
      workspaceRoots: ['/lib/alpha/repo/', '/lib/beta/repo'],
      preferredRoot: '/lib/beta/repo',
      limit: 10,
    });

    expect(select).toHaveBeenCalledOnce();
    const [sql, params] = select.mock.calls[0];
    expect(sql).toContain('w.path IN (?, ?)');
    expect(sql).toContain('ORDER BY (w.path = ?) DESC');
    expect(params).toEqual([
      'structure',
      'file',
      '/lib/alpha/repo',
      '/lib/beta/repo',
      '%1BNA%',
      '"1BNA"',
      '/lib/beta/repo',
      11,
    ]);
  });

  it('returns each item with its own project path, id and name', async () => {
    select.mockResolvedValue([
      row({ entity_id: 'ent-a', name: '1BNA.pdb' }),
      row({
        entity_id: 'ent-b',
        entity_type: 'file',
        name: 'pAAV.dnaforge-sequence',
        file_kind: 'waypoint-sequence',
        path: '/samples/standard/pAAV.dnaforge-sequence',
        relative_path: null,
        project_workspace_id: 5,
        project_repo_uuid: null,
        project_root: '/samples/standard',
        project_name: 'Samples',
      }),
      row({ entity_id: 'ent-c', path: '/elsewhere/1BNA.pdb', relative_path: null }),
    ]);

    const result = await searchProjectReferencesByName({
      query: '',
      entityTypes: ['sequence', 'structure'],
      workspaceRoots: ['/lib/alpha/repo', '/samples/standard'],
    });

    expect(result).toEqual({
      truncated: false,
      candidates: [
        expect.objectContaining({
          entityId: 'ent-a',
          entityType: 'structure',
          workspaceRelativePath: 'structures/1BNA.pdb',
          projectId: 'repo-alpha',
          projectRoot: '/lib/alpha/repo',
          projectName: 'Alpha lab',
        }),
        expect.objectContaining({
          entityId: 'ent-b',
          entityType: 'sequence',
          workspaceRelativePath: 'pAAV.dnaforge-sequence',
          projectId: 'ws5',
          projectName: 'Samples',
        }),
      ],
    });
  });

  it('reports when more matches exist than the limit returned', async () => {
    select.mockResolvedValue([row({ entity_id: 'a' }), row({ entity_id: 'b' })]);

    const result = await searchProjectReferencesByName({
      query: '',
      entityTypes: ['structure'],
      workspaceRoots: ['/lib/alpha/repo'],
      limit: 1,
    });

    expect(result.candidates.map((candidate) => candidate.entityId)).toEqual(['a']);
    expect(result.truncated).toBe(true);
  });

  it('skips the query when there is no project to search', async () => {
    expect(
      await searchProjectReferencesByName({
        query: 'x',
        entityTypes: ['structure'],
        workspaceRoots: [],
      })
    ).toEqual({ candidates: [], truncated: false });
    expect(select).not.toHaveBeenCalled();
  });
});
