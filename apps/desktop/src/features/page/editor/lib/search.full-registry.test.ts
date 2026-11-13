import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  primers: vi.fn(),
  project: vi.fn(),
  roots: vi.fn(),
  registry: vi.fn(),
  folders: [] as Array<{ path: string }>,
  pages: {} as Record<string, { id: string; title: string; updatedAt: Date }>,
}));

vi.mock('../../../../db/primer-reference-search', () => ({
  searchPrimerReferencesByName: mocks.primers,
}));
vi.mock('../../../../db/project-reference-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../db/project-reference-search')>()),
  searchProjectReferencesByName: mocks.project,
}));
vi.mock('../../../../db/project-roots', () => ({
  listSearchableProjectRoots: mocks.roots,
}));
vi.mock('../../../lims/public/operations', () => ({
  queryLimsRegistrySummaries: mocks.registry,
}));
vi.mock('../../../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: mocks.folders }) },
}));
vi.mock('../../store', () => ({
  usePageStore: { getState: () => ({ pages: mocks.pages }) },
}));

function projectResult(candidates: unknown[], truncated = false) {
  return { candidates, truncated };
}

function projectCalls(entityType: string) {
  return mocks.project.mock.calls
    .map((call) => call[0])
    .filter((input) => input.entityTypes.includes(entityType));
}

import { groupSearchResults, searchEntities } from './search';

function summary(id: string, name: string, kind: string, registryId: string | null) {
  return { id, name, kind, registryId, schemaDisplayName: undefined };
}

describe('notebook @ search covers the whole Registry and project', () => {
  beforeEach(() => {
    mocks.primers.mockReset().mockResolvedValue([]);
    mocks.project.mockReset().mockResolvedValue(projectResult([]));
    mocks.roots.mockReset().mockResolvedValue(['/ws/alpha', '/ws/beta', '/ws/gamma']);
    mocks.folders.splice(0, mocks.folders.length, { path: '/ws/beta' });
    mocks.registry.mockReset().mockResolvedValue({ summaries: [], totalCount: 0 });
    for (const key of Object.keys(mocks.pages)) delete mocks.pages[key];
  });

  it('searches every Registry kind with the typed text and keeps the record kind and ID', async () => {
    mocks.registry.mockResolvedValue({
      summaries: [
        summary('ent-strain', 'BL21(DE3)', 'strain', 's000012'),
        summary('ent-plasmid', 'pET-28a', 'plasmid', 'p000003'),
        summary('ent-guide', 'sgRNA-lacZ', 'guide_rna', null),
      ],
      totalCount: 3,
    });

    const results = await searchEntities('  BL21 ', '/ws/beta');

    expect(mocks.registry).toHaveBeenCalledWith(expect.objectContaining({ search: 'BL21' }));
    expect(results.registry.map((item) => [item.type, item.registryKind, item.registryId])).toEqual(
      [
        ['registry', 'strain', 's000012'],
        ['registry', 'plasmid', 'p000003'],
        ['registry', 'guide_rna', null],
      ]
    );
    expect(results.registry.map((item) => item.kindLabel)).toEqual([
      'Strain',
      'Plasmid',
      'Guide RNA',
    ]);
  });

  it('lists recent Registry records when nothing has been typed yet', async () => {
    await searchEntities('', '/ws/beta');

    expect(mocks.registry).toHaveBeenCalledWith(expect.not.objectContaining({ search: '' }));
    expect(mocks.registry.mock.calls[0][0]).not.toHaveProperty('search');
  });

  it('searches the Registry and every project even when the notebook has no owning project', async () => {
    mocks.registry.mockResolvedValue({
      summaries: [summary('ent-strain', 'MG1655', 'strain', 's000001')],
      totalCount: 1,
    });

    const results = await searchEntities('MG', null);

    expect(results.registry).toHaveLength(1);
    expect(projectCalls('structure')).toEqual([
      expect.objectContaining({
        workspaceRoots: ['/ws/alpha', '/ws/beta', '/ws/gamma'],
        preferredRoot: null,
      }),
    ]);
  });

  it('searches sequences and project items in every project, preferring the notebook project', async () => {
    await searchEntities('pUC', '/ws/beta');

    expect(mocks.roots).toHaveBeenCalledWith(['/ws/beta']);
    for (const kind of ['sequence', 'structure']) {
      expect(projectCalls(kind)).toEqual([
        expect.objectContaining({
          query: 'pUC',
          workspaceRoots: ['/ws/alpha', '/ws/beta', '/ws/gamma'],
          preferredRoot: '/ws/beta',
        }),
      ]);
    }
    expect(projectCalls('sequence')[0].entityTypes).toEqual(['sequence']);
    expect(projectCalls('structure')[0].entityTypes).not.toContain('sequence');
  });

  it('returns items from other projects with their project and portable record', async () => {
    mocks.project.mockImplementation(async ({ entityTypes }: { entityTypes: string[] }) =>
      entityTypes.includes('sequence')
        ? projectResult([
            {
              entityId: 'ent-seq',
              entityType: 'sequence',
              name: 'pAAV-hSyn',
              workspaceRelativePath: 'vectors/pAAV-hSyn.gb',
              contentHash: 'sha256:seq',
              objectUuid: null,
              projectId: 'repo-alpha',
              projectRoot: '/ws/alpha',
              projectName: 'Alpha lab',
            },
          ])
        : projectResult([
            {
              entityId: 'ent-structure',
              entityType: 'structure',
              name: '1ABC',
              workspaceRelativePath: 'structures/1ABC.cif',
              contentHash: 'sha256:abc',
              objectUuid: 'uuid-1',
              projectId: 'repo-gamma',
              projectRoot: '/ws/gamma',
              projectName: 'Gamma lab',
            },
            {
              entityId: 'ent-protocol',
              entityType: 'protocol',
              name: 'Miniprep',
              workspaceRelativePath: 'protocols/miniprep.dnaforge-protocol.json',
              contentHash: null,
              objectUuid: null,
              projectId: 'repo-beta',
              projectRoot: '/ws/beta',
              projectName: 'Beta lab',
            },
          ])
    );

    const results = await searchEntities('a', '/ws/beta');

    expect(results.sequences).toEqual([
      expect.objectContaining({
        id: 'ent-seq',
        type: 'sequence',
        path: 'vectors/pAAV-hSyn.gb',
        projectId: 'repo-alpha',
        projectName: 'Alpha lab',
      }),
    ]);
    expect(results.project).toEqual([
      expect.objectContaining({
        id: 'ent-structure',
        type: 'structure',
        path: 'structures/1ABC.cif',
        contentHash: 'sha256:abc',
        objectUuid: 'uuid-1',
        projectId: 'repo-gamma',
        projectName: 'Gamma lab',
      }),
      expect.objectContaining({ id: 'ent-protocol', type: 'protocol', projectId: 'repo-beta' }),
    ]);
  });

  it('flags a project kind as partial when its search filled the limit', async () => {
    mocks.project.mockImplementation(async ({ entityTypes }: { entityTypes: string[] }) =>
      entityTypes.includes('sequence')
        ? projectResult(
            [
              {
                entityId: 'ent-seq',
                entityType: 'sequence',
                name: 'pUC19',
                workspaceRelativePath: 'pUC19.gb',
                contentHash: null,
                objectUuid: null,
                projectId: 'repo-alpha',
                projectRoot: '/ws/alpha',
                projectName: 'Alpha lab',
              },
            ],
            true
          )
        : projectResult([])
    );

    const groups = groupSearchResults(await searchEntities('pUC', '/ws/beta'), 'pUC');

    expect(groups.find((group) => group.key === 'sequence')?.partial).toBe(true);
  });

  it('drops notebook and duplicate Registry rows already offered from the project', async () => {
    mocks.pages['page-1'] = { id: 'page-1', title: 'Cloning log', updatedAt: new Date() };
    mocks.project.mockImplementation(async ({ entityTypes }: { entityTypes: string[] }) =>
      entityTypes.includes('sequence')
        ? projectResult([
            {
              entityId: 'ws-scope::pkg-1',
              entityType: 'sequence',
              name: 'pUC19',
              workspaceRelativePath: 'pUC19.dnaforge-sequence',
              contentHash: null,
              objectUuid: null,
              projectId: 'ws-scope',
              projectRoot: '/ws/beta',
              projectName: 'Beta lab',
            },
          ])
        : projectResult([])
    );
    mocks.registry.mockResolvedValue({
      summaries: [
        summary('page-1', 'Cloning log', 'notebook', 'n000001'),
        summary('pkg-1', 'pUC19', 'sequence', 'd000001'),
        summary('ent-strain', 'DH5a', 'strain', 's000002'),
      ],
      totalCount: 3,
    });

    const results = await searchEntities('', '/ws/beta');

    expect(results.registry.map((item) => item.id)).toEqual(['ent-strain']);
  });

  it('groups results by kind, puts the closest match first and flags truncated Registry results', async () => {
    mocks.pages['page-1'] = { id: 'page-1', title: 'BL21 growth notes', updatedAt: new Date() };
    mocks.registry.mockResolvedValue({
      summaries: [
        summary('ent-plasmid', 'pBL21-helper', 'plasmid', 'p000009'),
        summary('ent-strain-2', 'BL21-AI', 'strain', 's000013'),
        summary('ent-strain', 'BL21', 'strain', 's000012'),
      ],
      totalCount: 240,
    });

    const groups = groupSearchResults(await searchEntities('bl21', '/ws/beta'), 'bl21');

    expect(groups.map((group) => [group.key, group.label, group.source])).toEqual([
      ['registry:strain', 'Strain', 'registry'],
      ['page', 'Notebook', 'project'],
      ['registry:plasmid', 'Plasmid', 'registry'],
    ]);
    expect(groups[0].items.map((item) => item.name)).toEqual(['BL21', 'BL21-AI']);
    expect(groups.filter((group) => group.partial).map((group) => group.key)).toEqual([
      'registry:strain',
      'registry:plasmid',
    ]);
  });

  it('matches a typed Registry ID exactly', async () => {
    mocks.registry.mockResolvedValue({
      summaries: [
        summary('ent-a', 'Cas9 donor', 'plasmid', 'p000044'),
        summary('ent-b', 'p000044 notes', 'fragment', 'f000001'),
      ],
      totalCount: 2,
    });

    const groups = groupSearchResults(await searchEntities('P000044', '/ws/beta'), 'P000044');

    expect(groups[0].key).toBe('registry:plasmid');
  });
});
