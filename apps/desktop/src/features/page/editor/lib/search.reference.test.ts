import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const { mockCatalogSearch, mockPrimerSearch, mockProjectRoots } = vi.hoisted(() => ({
  mockCatalogSearch: vi.fn(),
  mockPrimerSearch: vi.fn(),
  mockProjectRoots: vi.fn(),
}));

vi.mock('../../../../db/project-reference-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../db/project-reference-search')>()),
  searchProjectReferencesByName: async (input: { entityTypes: string[] }) => ({
    candidates: input.entityTypes.includes('sequence') ? await mockCatalogSearch(input) : [],
    truncated: false,
  }),
}));
vi.mock('../../../../db/project-roots', () => ({
  listSearchableProjectRoots: mockProjectRoots,
}));
vi.mock('../../../../db/primer-reference-search', () => ({
  searchPrimerReferencesByName: mockPrimerSearch,
}));
vi.mock('../../../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: [{ path: '/ws/beta' }] }) },
}));
vi.mock('../../../lims/public/operations', () => ({
  queryLimsRegistrySummaries: vi.fn().mockResolvedValue({ summaries: [], totalCount: 0 }),
}));
vi.mock('../../store', () => ({
  usePageStore: { getState: () => ({ pages: {} }) },
}));

import { getEntityIcon, searchEntities } from './search';

describe('@ search carries a portable path', () => {
  beforeEach(() => {
    mockCatalogSearch.mockReset();
    mockPrimerSearch.mockReset();
    mockProjectRoots.mockReset().mockResolvedValue(['/ws/alpha', '/ws/beta']);
    mockCatalogSearch.mockResolvedValue([]);
    mockPrimerSearch.mockResolvedValue([]);
  });

  it('uses an existing file path to color a code result', () => {
    const { container } = render(getEntityIcon({ type: 'file', path: 'analysis.py' }));
    expect(container.querySelector('svg')).toHaveAttribute('data-entity-color-family', 'code');
  });

  it('retains canonical RNA kind from a primer search result into its menu icon', async () => {
    mockPrimerSearch.mockResolvedValue([
      {
        primerId: 'rna-primer',
        name: 'RNA primer',
        workspaceRelativePath: 'primer.primer.json',
        localOnly: false,
        iconContext: { kind: 'rna_oligo' },
      },
    ]);
    const result = await searchEntities('RNA', '/ws/beta');
    const { container } = render(getEntityIcon(result.primers[0]));
    expect(container.querySelector('svg')).toHaveAttribute('data-entity-color-family', 'rna');
    expect(result.primers[0].registryKind).toBe('rna_oligo');
  });

  it('returns a sequence item carrying its workspace-relative path', async () => {
    mockCatalogSearch.mockResolvedValue([
      {
        entityId: 'ent-1',
        entityType: 'sequence',
        name: 'pUC19',
        workspaceRelativePath: 'sequences/pUC19.gb',
        contentHash: `sha256:${'a'.repeat(64)}`,
        objectUuid: null,
        projectId: 'repo-beta',
        projectRoot: '/ws/beta',
        projectName: 'Beta',
      },
    ]);

    const results = await searchEntities('pUC', '/ws/beta');

    expect(results.sequences).toHaveLength(1);
    expect(results.sequences[0].path).toBe('sequences/pUC19.gb');
    expect(results.sequences[0].contentHash).toBe(`sha256:${'a'.repeat(64)}`);
  });

  it('searches sequences in every project, preferring the OWNING root', async () => {
    await searchEntities('pUC', '/ws/beta');

    expect(mockCatalogSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoots: ['/ws/alpha', '/ws/beta'],
        preferredRoot: '/ws/beta',
        entityTypes: ['sequence'],
      })
    );
  });

  it('returns a primer item carrying its artifact path', async () => {
    mockPrimerSearch.mockResolvedValue([
      {
        primerId: 'p1',
        name: 'M13-fwd',
        sequence: 'GTAAAACGACGGCCAGT',
        length: 17,
        catalogNumber: null,
        workspaceRelativePath: 'primers/M13-fwd.primer.json',
        localOnly: false,
      },
    ]);

    const results = await searchEntities('M13', '/ws/beta');

    expect(results.primers[0].path).toBe('primers/M13-fwd.primer.json');
    expect(results.primers[0].localOnly).toBe(false);
  });

  it('marks a file-less primer local-only instead of inventing a path', async () => {
    mockPrimerSearch.mockResolvedValue([
      {
        primerId: 'p2',
        name: 'hand-entered',
        sequence: 'ACGT',
        length: 4,
        catalogNumber: null,
        workspaceRelativePath: null,
        localOnly: true,
      },
    ]);

    const results = await searchEntities('hand', '/ws/beta');

    expect(results.primers[0].path).toBeNull();
    expect(results.primers[0].localOnly).toBe(true);
    expect(results.primers[0].id).toBe('p2');
  });

  it('never emits a seq_<n> id when a workspace root is known', async () => {
    mockCatalogSearch.mockResolvedValue([
      {
        entityId: 'ent-1',
        entityType: 'sequence',
        name: 'pUC19',
        workspaceRelativePath: 'a.gb',
        contentHash: null,
        objectUuid: null,
        projectId: 'repo-beta',
        projectRoot: '/ws/beta',
        projectName: 'Beta',
      },
    ]);

    const results = await searchEntities('pUC', '/ws/beta');

    for (const item of results.sequences) {
      expect(item.id).not.toMatch(/^seq_/);
    }
  });

  it('still returns sequences with no workspace root, each with its own project path', async () => {
    mockCatalogSearch.mockResolvedValue([
      {
        entityId: 'ent-7',
        entityType: 'sequence',
        name: 'legacy',
        workspaceRelativePath: 'legacy.gb',
        contentHash: null,
        objectUuid: null,
        projectId: 'repo-alpha',
        projectRoot: '/ws/alpha',
        projectName: 'Alpha',
      },
    ]);

    const results = await searchEntities('leg', null);

    expect(results.sequences).toHaveLength(1);
    expect(results.sequences[0].path).toBe('legacy.gb');
    expect(results.sequences[0].projectId).toBe('repo-alpha');
    expect(results.sequences[0].id).not.toMatch(/^seq_/);
  });
});
