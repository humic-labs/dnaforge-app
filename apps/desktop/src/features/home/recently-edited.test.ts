import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fileTypes from '../../utils/fileTypes';

const mockFindEnclosingSequencePackageRoot = vi.fn();
vi.mock('../../db/sequence-package-io', () => ({
  findEnclosingSequencePackageRoot: (...args: unknown[]) =>
    mockFindEnclosingSequencePackageRoot(...args),
}));
beforeEach(() => {
  mockFindEnclosingSequencePackageRoot.mockReset().mockResolvedValue(null);
});

const mockSelect = vi.fn();
const mockFsExists = vi.fn();
vi.mock('../../platform', () => ({
  platform: () => ({
    db: { select: (...args: unknown[]) => mockSelect(...args) },
    fs: { exists: (...args: unknown[]) => mockFsExists(...args) },
  }),
}));

const mockGetRecentlyEditedCatalogEntities = vi.fn();
vi.mock('../../db/workspace-catalog', () => ({
  getRecentlyEditedCatalogEntities: (...args: unknown[]) =>
    mockGetRecentlyEditedCatalogEntities(...args),
}));

const mockGitRecentlyChangedFiles = vi.fn();
const mockGitRepoRootForDir = vi.fn();
vi.mock('../workspace/git', () => ({
  gitRecentlyChangedFiles: (...args: unknown[]) => mockGitRecentlyChangedFiles(...args),
  gitRepoRootForDir: (...args: unknown[]) => mockGitRepoRootForDir(...args),
}));

import {
  getRecentlyEditedPages,
  getRecentlyEditedThings,
  getRecentlyEditedGitFiles,
  getRecentlyEdited,
  peekRecentlyEditedSnapshot,
  publishRecentlyEditedSnapshot,
  refreshRecentlyEdited,
  resetRecentlyEditedSnapshotForTests,
  subscribeRecentlyEditedSnapshot,
} from './recently-edited';

describe('getRecentlyEditedPages', () => {
  beforeEach(() => mockSelect.mockReset());

  it('joins pages -> notebook catalog_entities -> workspaces for workspace attribution, sorted desc', async () => {
    mockSelect
      .mockResolvedValueOnce([
        { id: 'page-old', title: 'Old notes', updated_at: 1000 },
        { id: 'page-new', title: 'New notes', updated_at: 2000 },
      ])
      .mockResolvedValueOnce([
        { id: 'page-old', type: 'notebook', workspace_id: 1 },
        { id: 'page-new', type: 'notebook', workspace_id: 1 },
        { id: 'design-x', type: 'design', workspace_id: 1 },
      ])
      .mockResolvedValueOnce([{ id: 1, name: 'Lab', path: '/ws/lab' }]);

    const result = await getRecentlyEditedPages(10);

    expect(result).toEqual([
      {
        id: 'page-new',
        title: 'New notes',
        workspaceRoot: '/ws/lab',
        workspaceName: 'Lab',
        updatedAt: 2000,
        open: { kind: 'entity', tabType: 'page', entityId: 'page-new' },
      },
      {
        id: 'page-old',
        title: 'Old notes',
        workspaceRoot: '/ws/lab',
        workspaceName: 'Lab',
        updatedAt: 1000,
        open: { kind: 'entity', tabType: 'page', entityId: 'page-old' },
      },
    ]);
  });

  it('omits workspace attribution gracefully when no matching entity/workspace row exists', async () => {
    mockSelect
      .mockResolvedValueOnce([{ id: 'orphan-page', title: 'Orphan', updated_at: 500 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await getRecentlyEditedPages(10);
    expect(result).toEqual([
      {
        id: 'orphan-page',
        title: 'Orphan',
        workspaceRoot: null,
        workspaceName: null,
        updatedAt: 500,
        open: { kind: 'entity', tabType: 'page', entityId: 'orphan-page' },
      },
    ]);
  });

  it('truncates to limit AFTER sorting, not before', async () => {
    mockSelect
      .mockResolvedValueOnce([
        { id: 'p1', title: 'A', updated_at: 1000 },
        { id: 'p2', title: 'B', updated_at: 2000 },
        { id: 'p3', title: 'C', updated_at: 3000 },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await getRecentlyEditedPages(2);
    expect(result.map((r) => r.id)).toEqual(['p3', 'p2']);
  });

  it('excludes pages whose workspace has been archived or trashed', async () => {
    mockSelect
      .mockResolvedValueOnce([
        { id: 'page-active', title: 'Active notes', updated_at: 1000 },
        { id: 'page-archived', title: 'Archived notes', updated_at: 2000 },
        { id: 'page-trashed', title: 'Trashed notes', updated_at: 3000 },
      ])
      .mockResolvedValueOnce([
        { id: 'page-active', type: 'notebook', workspace_id: 1 },
        { id: 'page-archived', type: 'notebook', workspace_id: 2 },
        { id: 'page-trashed', type: 'notebook', workspace_id: 3 },
      ])
      .mockResolvedValueOnce([
        { id: 1, name: 'Active', path: '/ws/active', archived_at: null, trashed_at: null },
        { id: 2, name: 'Archived', path: '/ws/archived', archived_at: 1700, trashed_at: null },
        { id: 3, name: 'Trashed', path: '/ws/trashed', archived_at: null, trashed_at: 1700 },
      ]);

    const result = await getRecentlyEditedPages(10);
    expect(result.map((r) => r.id)).toEqual(['page-active']);
  });

  it('excludes pages owned by reference workspaces without classifying the page type', async () => {
    mockSelect
      .mockResolvedValueOnce([
        { id: 'page-writable', title: 'Experiment notes', updated_at: 1000 },
        { id: 'page-reference', title: 'Fixture notes', updated_at: 2000 },
      ])
      .mockResolvedValueOnce([
        { id: 'page-writable', type: 'notebook', workspace_id: 1 },
        { id: 'page-reference', type: 'notebook', workspace_id: 2 },
      ])
      .mockResolvedValueOnce([
        { id: 1, name: 'Lab', path: '/ws/lab', access_mode: 'writable' },
        { id: 2, name: 'References', path: '/ws/reference', access_mode: 'reference' },
      ]);

    const result = await getRecentlyEditedPages(10);

    expect(result.map((r) => r.id)).toEqual(['page-writable']);
  });
});

describe('getRecentlyEditedThings', () => {
  beforeEach(() => mockGetRecentlyEditedCatalogEntities.mockReset());

  it('maps a DATABASE-backed openable entity type (design) to an entity-kind open target', async () => {
    mockGetRecentlyEditedCatalogEntities.mockResolvedValueOnce([
      {
        id: 'design-1',
        type: 'design',
        name: 'Golden Gate',
        locator: 'entity://design/design-1',
        storage_type: 'database',
        workspace_path: '/ws/lab',
        workspace_name: 'Lab',
        updated_at: 2000,
      },
    ]);

    const result = await getRecentlyEditedThings(10);
    expect(result).toEqual([
      {
        id: 'design-1',
        title: 'Golden Gate',
        workspaceRoot: '/ws/lab',
        workspaceName: 'Lab',
        updatedAt: 2000,
        open: { kind: 'entity', tabType: 'design', entityId: 'design-1' },
      },
    ]);
  });

  it('maps a FILE-backed openable entity type (sequence) to a file-kind open target using its real path, never its database id', async () => {
    mockGetRecentlyEditedCatalogEntities.mockResolvedValueOnce([
      {
        id: 'a4e77bab-28ba-46e9-b2ee-3075d11df940',
        type: 'sequence',
        name: 'pUC19.gb',
        locator: 'file:///ws/lab/plasmids/pUC19.gb',
        storage_type: 'file',
        workspace_path: '/ws/lab',
        workspace_name: 'Lab',
        updated_at: 1500,
      },
    ]);

    const result = await getRecentlyEditedThings(10);
    expect(result).toEqual([
      {
        id: 'a4e77bab-28ba-46e9-b2ee-3075d11df940',
        title: 'pUC19.gb',
        workspaceRoot: '/ws/lab',
        workspaceName: 'Lab',
        updatedAt: 1500,
        open: { kind: 'file', path: '/ws/lab/plasmids/pUC19.gb', tabType: 'sequence' },
      },
    ]);
  });

  it('drops entity types with no direct tab (e.g. primer — LIMS-routed, not tab-openable)', async () => {
    mockGetRecentlyEditedCatalogEntities.mockResolvedValueOnce([
      {
        id: 'primer-1',
        type: 'primer',
        name: 'Fwd',
        locator: 'entity://primer/primer-1',
        storage_type: 'database',
        workspace_path: '/ws/lab',
        workspace_name: 'Lab',
        updated_at: 2000,
      },
    ]);

    expect(await getRecentlyEditedThings(10)).toEqual([]);
  });

  it('skips a storage_type:"file" entity whose locator does NOT start with "file://"', async () => {
    mockGetRecentlyEditedCatalogEntities.mockResolvedValueOnce([
      {
        id: 'seq-bad-locator',
        type: 'sequence',
        name: 'weird.gb',
        locator: '/ws/lab/weird.gb',
        storage_type: 'file',
        workspace_path: '/ws/lab',
        workspace_name: 'Lab',
        updated_at: 2000,
      },
    ]);

    expect(await getRecentlyEditedThings(10)).toEqual([]);
  });
});

describe('getRecentlyEditedGitFiles', () => {
  it('uses readable fallback copy for an unresolved generated UUID filename', async () => {
    mockGitRepoRootForDir.mockResolvedValueOnce('/ws/lab');
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      {
        path: 'primers/sheet-cf5f97c9-a32a-4330-9b28-164d09c7092f-row.primer.json',
        hash: 'primer-commit',
        date: '2026-11-09T00:00:00Z',
        relativeDate: 'now',
      },
    ]);
    const rows = await getRecentlyEditedGitFiles([{ path: '/ws/lab', name: 'Lab' }], 6);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Untitled file');
    expect(rows[0].open).toEqual({
      kind: 'file',
      path: '/ws/lab/primers/sheet-cf5f97c9-a32a-4330-9b28-164d09c7092f-row.primer.json',
      tabType: 'primer',
    });
  });

  beforeEach(() => {
    mockGitRecentlyChangedFiles.mockReset();
    mockGitRepoRootForDir.mockReset();

    mockFsExists.mockReset().mockResolvedValue(true);
  });

  it('keeps recovered scientific internals out of Home without crowding out user files', async () => {
    mockGitRepoRootForDir.mockResolvedValueOnce('/ws/lab');
    const internalPaths = [
      ...Array.from(
        { length: 205 },
        (_, index) => `.dnaforge/relationships/${String(index).padStart(64, '0')}.json`
      ),
      'assemblies/rescue/.forge/plasmid.json',
      'assemblies/rescue/.forge/assembly-working-copy.wpdesign.json',
      '.dnaforge/audit/2026-10.jsonl',
      '.gitignore',
      'sequence.waypoint.json',
      'assemblies\\rescue\\.forge\\manifest.json',
    ];
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      ...internalPaths.map((path) => ({
        path,
        hash: 'internal',
        date: '2026-10-27T10:00:00Z',
        relativeDate: 'now',
      })),
      {
        path: 'sequences/pUC19.gb',
        hash: 'sequence',
        date: '2026-10-26T11:00:00Z',
        relativeDate: 'yesterday',
      },
      {
        path: 'notes/plan.md',
        hash: 'notes',
        date: '2026-10-26T10:00:00Z',
        relativeDate: 'yesterday',
      },
    ]);

    const result = await getRecentlyEditedGitFiles([{ path: '/ws/lab', name: 'Lab' }], 6);

    expect(result.map((item) => item.open)).toEqual([
      expect.objectContaining({ kind: 'file', path: '/ws/lab/sequences/pUC19.gb' }),
      expect.objectContaining({ kind: 'file', path: '/ws/lab/notes/plan.md' }),
    ]);
    expect(mockFsExists.mock.calls).toEqual([
      ['/ws/lab/sequences/pUC19.gb'],
      ['/ws/lab/notes/plan.md'],
    ]);
  });

  it('opens one canonical sequence package for edits to its metadata, product and members', async () => {
    mockGitRepoRootForDir.mockResolvedValueOnce('/ws/lab');
    mockFindEnclosingSequencePackageRoot.mockImplementation(async (directory: string) =>
      directory.startsWith('/ws/lab/assemblies/rescue') ? '/ws/lab/assemblies/rescue' : null
    );
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      ...[
        'assemblies/rescue/.forge/plasmid.json',
        'assemblies/rescue/contents/assembly-working-copy.wpdesign.json',
        'assemblies/rescue/contents/sequence-snapshot.gb',
        'assemblies/rescue/contents/export.primers.csv',
        'assemblies/rescue/rescue.gb',
      ].map((path) => ({
        path,
        hash: 'package',
        date: '2026-10-27T10:00:00Z',
        relativeDate: 'now',
      })),
      {
        path: 'notes/plan.md',
        hash: 'notes',
        date: '2026-10-26T10:00:00Z',
        relativeDate: 'yesterday',
      },
    ]);

    const result = await getRecentlyEditedGitFiles([{ path: '/ws/lab', name: 'Lab' }], 6);

    expect(result.map((item) => item.open)).toEqual([
      { kind: 'file', path: '/ws/lab/assemblies/rescue', tabType: 'sequence' },
      expect.objectContaining({ kind: 'file', path: '/ws/lab/notes/plan.md' }),
    ]);
    expect(mockFsExists.mock.calls).toEqual([
      ['/ws/lab/assemblies/rescue'],
      ['/ws/lab/notes/plan.md'],
    ]);
  });

  it('does not guess a loose-file identity when package ownership cannot be read', async () => {
    mockGitRepoRootForDir.mockResolvedValueOnce('/ws/lab');
    mockFindEnclosingSequencePackageRoot.mockImplementation(async (directory: string) => {
      if (directory === '/ws/lab/blocked') throw new Error('unreadable package owner');
      return null;
    });
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      {
        path: 'blocked/member.gb',
        hash: 'blocked',
        date: '2026-10-27T10:00:00Z',
        relativeDate: 'now',
      },
      {
        path: 'notes/plan.md',
        hash: 'notes',
        date: '2026-10-26T10:00:00Z',
        relativeDate: 'yesterday',
      },
    ]);

    const result = await getRecentlyEditedGitFiles([{ path: '/ws/lab', name: 'Lab' }], 6);

    expect(result.map((item) => item.title)).toEqual(['plan.md']);
    expect(mockFsExists.mock.calls).toEqual([['/ws/lab/notes/plan.md']]);
  });

  it('resolves each git path to an absolute path + inferred TabType, when the workspace IS its own repo root', async () => {
    mockGitRepoRootForDir.mockResolvedValueOnce('/ws/lab');
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      {
        path: 'sequences/pUC19.gb',
        hash: 'abc',
        date: '2026-06-20T10:00:00Z',
        relativeDate: '2h ago',
      },
    ]);

    const result = await getRecentlyEditedGitFiles([{ path: '/ws/lab', name: 'Lab' }], 6);

    expect(result).toEqual([
      {
        id: '/ws/lab::sequences/pUC19.gb',
        title: 'pUC19.gb',
        workspaceRoot: '/ws/lab',
        workspaceName: 'Lab',
        updatedAt: new Date('2026-06-20T10:00:00Z').getTime(),
        open: { kind: 'file', path: '/ws/lab/sequences/pUC19.gb', tabType: 'sequence' },
      },
    ]);
    expect(mockGitRecentlyChangedFiles).toHaveBeenCalledWith('/ws/lab', 6);
  });

  it('joins git-reported paths against the REAL repo root, not the workspace path, when the workspace is a subdirectory of a larger repo', async () => {
    mockGitRepoRootForDir.mockResolvedValueOnce('/monorepo');
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      {
        path: 'test-fixtures/sequences/pUC19.gb',
        hash: 'abc',
        date: '2026-06-20T10:00:00Z',
        relativeDate: '2h ago',
      },
    ]);

    const result = await getRecentlyEditedGitFiles(
      [{ path: '/monorepo/test-fixtures', name: 'Test Fixtures' }],
      6
    );

    expect(result).toEqual([
      {
        id: '/monorepo/test-fixtures::test-fixtures/sequences/pUC19.gb',
        title: 'pUC19.gb',

        workspaceRoot: '/monorepo/test-fixtures',
        workspaceName: 'Test Fixtures',
        updatedAt: new Date('2026-06-20T10:00:00Z').getTime(),

        open: {
          kind: 'file',
          path: '/monorepo/test-fixtures/sequences/pUC19.gb',
          tabType: 'sequence',
        },
      },
    ]);
  });

  it('falls back to the workspace path itself when repo-root resolution fails (not a git repo at all)', async () => {
    mockGitRepoRootForDir.mockResolvedValueOnce(null);
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([]);

    const result = await getRecentlyEditedGitFiles([{ path: '/ws/not-a-repo', name: 'X' }], 6);
    expect(result).toEqual([]);
  });

  it('falls back to the workspace path for REAL files, not just the trivially-empty case', async () => {
    mockGitRepoRootForDir.mockResolvedValueOnce(null);
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      {
        path: 'seq/file.gb',
        hash: 'abc',
        date: '2026-06-20T10:00:00Z',
        relativeDate: '2h ago',
      },
    ]);

    const result = await getRecentlyEditedGitFiles([{ path: '/ws/not-a-repo', name: 'X' }], 6);
    expect(result).toEqual([
      {
        id: '/ws/not-a-repo::seq/file.gb',
        title: 'file.gb',
        workspaceRoot: '/ws/not-a-repo',
        workspaceName: 'X',
        updatedAt: new Date('2026-06-20T10:00:00Z').getTime(),
        open: { kind: 'file', path: '/ws/not-a-repo/seq/file.gb', tabType: 'sequence' },
      },
    ]);
  });

  it('trims a trailing slash off the join root instead of doubling the separator', async () => {
    mockGitRepoRootForDir.mockResolvedValueOnce(null);
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      {
        path: 'file.gb',
        hash: 'abc',
        date: '2026-06-20T10:00:00Z',
        relativeDate: '2h ago',
      },
    ]);

    const result = await getRecentlyEditedGitFiles([{ path: '/ws/lab/', name: 'Lab' }], 6);
    expect(result[0].open).toEqual({
      kind: 'file',
      path: '/ws/lab/file.gb',
      tabType: 'sequence',
    });
  });

  it("joins against a BACKSLASH workspace root (Windows) using backslash separators, converting git's forward-slash relative path", async () => {
    mockGitRepoRootForDir.mockResolvedValueOnce('C:\\Users\\foo\\Lab');
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      {
        path: 'seq/file.gb',
        hash: 'abc',
        date: '2026-06-20T10:00:00Z',
        relativeDate: '2h ago',
      },
    ]);

    const result = await getRecentlyEditedGitFiles(
      [{ path: 'C:\\Users\\foo\\Lab', name: 'Lab' }],
      6
    );
    expect(result[0].open).toEqual({
      kind: 'file',
      path: 'C:\\Users\\foo\\Lab\\seq\\file.gb',
      tabType: 'sequence',
    });
  });

  it('does not cross-apply results across concurrently-processed workspaces', async () => {
    mockGitRepoRootForDir.mockResolvedValueOnce('/repo-a').mockResolvedValueOnce('/repo-b');
    mockGitRecentlyChangedFiles
      .mockResolvedValueOnce([
        { path: 'a.gb', hash: 'h1', date: '2026-06-20T10:00:00Z', relativeDate: 'x' },
      ])
      .mockResolvedValueOnce([
        { path: 'b.gb', hash: 'h2', date: '2026-06-21T10:00:00Z', relativeDate: 'y' },
      ]);

    const result = await getRecentlyEditedGitFiles(
      [
        { path: '/repo-a', name: 'A' },
        { path: '/repo-b', name: 'B' },
      ],
      6
    );

    expect(result).toEqual([
      {
        id: '/repo-b::b.gb',
        title: 'b.gb',
        workspaceRoot: '/repo-b',
        workspaceName: 'B',
        updatedAt: new Date('2026-06-21T10:00:00Z').getTime(),
        open: { kind: 'file', path: '/repo-b/b.gb', tabType: 'sequence' },
      },
      {
        id: '/repo-a::a.gb',
        title: 'a.gb',
        workspaceRoot: '/repo-a',
        workspaceName: 'A',
        updatedAt: new Date('2026-06-20T10:00:00Z').getTime(),
        open: { kind: 'file', path: '/repo-a/a.gb', tabType: 'sequence' },
      },
    ]);
  });

  it('excludes a git-history entry whose resolved path no longer exists on disk (deleted since the commit)', async () => {
    mockGitRepoRootForDir.mockResolvedValueOnce('/ws/lab');
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      { path: 'kept.gb', hash: 'h1', date: '2026-06-20T10:00:00Z', relativeDate: 'x' },
      { path: 'deleted.gb', hash: 'h2', date: '2026-06-21T10:00:00Z', relativeDate: 'y' },
    ]);
    mockFsExists.mockImplementation(async (path: string) => path !== '/ws/lab/deleted.gb');

    const result = await getRecentlyEditedGitFiles([{ path: '/ws/lab', name: 'Lab' }], 6);

    expect(result.map((r) => r.id)).toEqual(['/ws/lab::kept.gb']);
  });

  it('treats an fs.exists error as non-existent rather than throwing', async () => {
    mockGitRepoRootForDir.mockResolvedValueOnce('/ws/lab');
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      { path: 'unreadable.gb', hash: 'h1', date: '2026-06-20T10:00:00Z', relativeDate: 'x' },
    ]);
    mockFsExists.mockRejectedValue(new Error('EACCES'));

    const result = await getRecentlyEditedGitFiles([{ path: '/ws/lab', name: 'Lab' }], 6);

    expect(result).toEqual([]);
  });

  it('limits path classification and existence checks to the newest candidates in a large commit', async () => {
    const classify = vi.spyOn(fileTypes, 'getTabTypeForFile');
    mockGitRepoRootForDir.mockResolvedValueOnce('/ws/lab');
    const manyEntries = Array.from({ length: 5000 }, (_, i) => ({
      path: `generated/file-${i}.txt`,
      hash: `h${i}`,
      date: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      relativeDate: 'x',
    }));
    mockGitRecentlyChangedFiles.mockResolvedValueOnce(manyEntries);

    const result = await getRecentlyEditedGitFiles([{ path: '/ws/lab', name: 'Lab' }], 30);

    expect(mockFsExists.mock.calls.length).toBeLessThan(5000);
    expect(mockFsExists.mock.calls.length).toBeGreaterThan(0);

    const keptIds = result.map((r) => r.id);
    expect(keptIds).toContain('/ws/lab::generated/file-4999.txt');
    expect(keptIds).not.toContain('/ws/lab::generated/file-0.txt');
    expect(classify).toHaveBeenCalledTimes(result.length);
    classify.mockRestore();
  });

  it.each([
    ['/ws/lab', '/ws/lab', '', '.dnaforge-workspace.json'],
    ['/repo/project/', '/repo', 'project/', 'project/.dnaforge-workspace.json'],
    ['C:\\Repo\\Lab\\', 'C:\\Repo', 'Lab/', 'lab/.DNAFORGE-WORKSPACE.JSON'],
    ['C:/Repo/Lab/', 'C:/Repo', 'Lab/', 'LAB\\.dnaforge-workspace.json'],
  ])(
    'excludes hidden managed-head paths while preserving visible files for %s',
    async (workspace, repo, prefix, markerPath) => {
      mockGitRepoRootForDir.mockResolvedValueOnce(repo);
      const hiddenPaths = [
        markerPath,
        prefix + 'nested/.dnaforge-workspace.json',
        prefix + '.analysis.md',
        prefix + '.dnaforge-workspace.json.bak',
      ];
      const visiblePaths = [prefix + 'report.csv', prefix + 'notes.md'];
      mockGitRecentlyChangedFiles.mockResolvedValueOnce(
        [...hiddenPaths, ...visiblePaths, prefix + 'report.csv'].map((path) => ({
          path,
          hash: 'h',
          date: '2026-06-20T10:00:00Z',
          relativeDate: 'x',
        }))
      );
      const result = await getRecentlyEditedGitFiles([{ path: workspace, name: 'Lab' }], 6);
      expect(result.map((item) => item.id)).toEqual(
        visiblePaths.map((path) => `${workspace}::${path}`)
      );
      expect(mockFsExists).toHaveBeenCalledTimes(visiblePaths.length);
    }
  );

  it('excludes hidden POSIX lookalikes while preserving visible case-distinct files', async () => {
    mockGitRepoRootForDir.mockResolvedValueOnce('/ws/lab');
    mockGitRecentlyChangedFiles.mockResolvedValueOnce(
      ['.DNAFORGE-WORKSPACE.JSON', 'report.csv', 'Report.csv'].map((path) => ({
        path,
        hash: 'h',
        date: '2026-06-20T10:00:00Z',
        relativeDate: 'x',
      }))
    );
    const result = await getRecentlyEditedGitFiles([{ path: '/ws/lab', name: 'Lab' }], 6);
    expect(result.map((item) => item.id)).toEqual(['/ws/lab::report.csv', '/ws/lab::Report.csv']);
    expect(mockFsExists).toHaveBeenCalledTimes(2);
  });

  it('filters the internal marker before the existing candidate cap without losing user entries', async () => {
    mockGitRepoRootForDir.mockResolvedValueOnce('/ws/lab');
    const userEntries = Array.from({ length: 200 }, (_, index) => ({
      path: `file-${index}.txt`,
      hash: 'h',
      date: new Date(Date.UTC(2026, 5, 20, 10, 0, index)).toISOString(),
      relativeDate: 'x',
    }));
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      {
        path: '.dnaforge-workspace.json',
        hash: 'h',
        date: '2099-01-01T00:00:00Z',
        relativeDate: 'x',
      },
      ...userEntries,
    ]);
    const result = await getRecentlyEditedGitFiles([{ path: '/ws/lab', name: 'Lab' }], 6);
    expect(result).toHaveLength(200);
    expect(result[0].id).toBe('/ws/lab::file-199.txt');
    expect(result.at(-1)?.id).toBe('/ws/lab::file-0.txt');
    expect(mockFsExists).toHaveBeenCalledTimes(200);
  });
});

describe('getRecentlyEdited (merge)', () => {
  beforeEach(() => {
    mockSelect.mockReset();
    mockGetRecentlyEditedCatalogEntities.mockReset();
    mockGitRecentlyChangedFiles.mockReset();
    mockGitRepoRootForDir.mockReset();
    mockFsExists.mockReset().mockResolvedValue(true);
  });

  it('merges all 3 sources, sorts by recency, dedupes by open target, and caps at the limit', async () => {
    mockSelect
      .mockResolvedValueOnce([
        {
          id: 1,
          name: 'Lab',
          path: '/ws/lab',
          last_opened_at: 900,
          archived_at: null,
          trashed_at: null,
        },
      ])

      .mockResolvedValueOnce([
        { id: 'page-1', title: 'Notes', updated_at: Date.parse('2026-06-21T00:00:00Z') },
      ])
      .mockResolvedValueOnce([{ id: 'page-1', type: 'notebook', workspace_id: 1 }])
      .mockResolvedValueOnce([{ id: 1, name: 'Lab', path: '/ws/lab' }]);
    mockGetRecentlyEditedCatalogEntities.mockResolvedValueOnce([
      {
        id: 'design-1',
        type: 'design',
        name: 'Assembly A',
        locator: 'entity://design/design-1',
        storage_type: 'database',
        workspace_path: '/ws/lab',
        workspace_name: 'Lab',
        updated_at: Date.parse('2026-06-19T00:00:00Z'),
      },
    ]);
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      { path: 'seq.gb', hash: 'h1', date: '2026-01-01T00:00:00Z', relativeDate: 'long ago' },
    ]);

    const result = await getRecentlyEdited(2);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('page-1');
    expect(result[1].id).toBe('design-1');
  });

  it('retains canonical RNA metadata when newer Git history supplies its row timestamp', async () => {
    const relativePath = 'primers/sheet-cf5f97c9-a32a-4330-9b28-164d09c7092f-row.primer.json';
    const path = `/ws/lab/${relativePath}`;
    mockSelect
      .mockResolvedValueOnce([{ id: 1, name: 'Lab', path: '/ws/lab', last_opened_at: 900 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockGetRecentlyEditedCatalogEntities.mockResolvedValueOnce([
      {
        id: 'primer-readable',
        type: 'primer',
        iconContext: { kind: 'rna_oligo' },
        name: 'Excel Forward A',
        locator: 'waypoint://primer/primer-readable',
        storage_type: 'file',
        current_file_path: path,
        workspace_id: 1,
        workspace_path: '/ws/lab',
        workspace_name: 'Lab',
        updated_at: 1000,
      },
    ]);
    mockGitRepoRootForDir.mockResolvedValueOnce('/ws/lab');
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      {
        path: relativePath,
        hash: 'primer-commit',
        date: '2026-11-09T00:00:00Z',
        relativeDate: 'now',
      },
    ]);
    expect(await getRecentlyEdited(8)).toEqual([
      expect.objectContaining({
        title: 'Excel Forward A',
        iconContext: { kind: 'rna_oligo' },
        updatedAt: Date.parse('2026-11-09T00:00:00Z'),
        workspaceRoot: '/ws/lab',
        open: { kind: 'file', path, tabType: 'primer' },
      }),
    ]);
  });

  it('keeps a primer catalog name when newer Git history supplies its timestamp and file target', async () => {
    const relativePath = 'primers/sheet-cf5f97c9-a32a-4330-9b28-164d09c7092f-row.primer.json';
    const path = `/ws/lab/${relativePath}`;
    mockSelect
      .mockResolvedValueOnce([{ id: 1, name: 'Lab', path: '/ws/lab', last_opened_at: 900 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockGetRecentlyEditedCatalogEntities.mockResolvedValueOnce([
      {
        id: 'primer-readable',
        type: 'primer',
        name: 'Excel Forward A',
        locator: 'waypoint://primer/primer-readable',
        storage_type: 'file',
        current_file_path: path,
        workspace_id: 1,
        workspace_path: '/ws/lab',
        workspace_name: 'Lab',
        updated_at: 1000,
      },
    ]);
    mockGitRepoRootForDir.mockResolvedValueOnce('/ws/lab');
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      {
        path: relativePath,
        hash: 'primer-commit',
        date: '2026-11-09T00:00:00Z',
        relativeDate: 'now',
      },
    ]);
    expect(await getRecentlyEdited(8)).toEqual([
      expect.objectContaining({
        title: 'Excel Forward A',
        updatedAt: Date.parse('2026-11-09T00:00:00Z'),
        workspaceRoot: '/ws/lab',
        open: { kind: 'file', path, tabType: 'primer' },
      }),
    ]);
  });

  it('dedupes a file surfaced by BOTH the catalog and git history, keeping the FRESHER timestamp', async () => {
    mockSelect
      .mockResolvedValueOnce([
        {
          id: 1,
          name: 'Lab',
          path: '/ws/lab',
          last_opened_at: 900,
          archived_at: null,
          trashed_at: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockGetRecentlyEditedCatalogEntities.mockResolvedValueOnce([
      {
        id: 'seq-1',
        type: 'sequence',
        name: 'pUC19.gb',
        locator: 'file:///ws/lab/pUC19.gb',
        storage_type: 'file',
        workspace_path: '/ws/lab',
        workspace_name: 'Lab',
        updated_at: Date.parse('2026-06-10T00:00:00Z'),
      },
    ]);
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      {
        path: 'pUC19.gb',
        hash: 'abc',
        date: '2026-06-20T10:00:00Z',
        relativeDate: '2h ago',
      },
    ]);

    const result = await getRecentlyEdited(8);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      workspaceRoot: '/ws/lab',
      updatedAt: new Date('2026-06-20T10:00:00Z').getTime(),
      open: { kind: 'file', path: '/ws/lab/pUC19.gb', tabType: 'sequence' },
    });
  });

  it('excludes archived/trashed workspaces from the git scan, even when more recently opened than an active workspace', async () => {
    mockSelect
      .mockResolvedValueOnce([
        {
          id: 1,
          name: 'Lab',
          path: '/ws/lab',
          last_opened_at: 900,
          archived_at: null,
          trashed_at: null,
        },
        {
          id: 2,
          name: 'OldLab',
          path: '/ws/old',
          last_opened_at: 950,
          archived_at: 500,
          trashed_at: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockGetRecentlyEditedCatalogEntities.mockResolvedValueOnce([]);
    mockGitRecentlyChangedFiles.mockResolvedValue([]);

    await getRecentlyEdited(8);

    expect(mockGitRecentlyChangedFiles).toHaveBeenCalledTimes(1);
    expect(mockGitRecentlyChangedFiles).toHaveBeenCalledWith('/ws/lab', 30);
  });

  it('filters reference workspaces before scanning while preserving unknown future file types in writable workspaces', async () => {
    mockSelect
      .mockResolvedValueOnce([
        {
          id: 1,
          name: 'Lab',
          path: '/ws/lab',
          access_mode: 'writable',
          last_opened_at: 900,
          archived_at: null,
          trashed_at: null,
        },
        {
          id: 2,
          name: 'Reference fixtures',
          path: '/ws/reference',
          access_mode: 'reference',
          last_opened_at: 1000,
          archived_at: null,
          trashed_at: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockGetRecentlyEditedCatalogEntities.mockResolvedValueOnce([]);
    mockGitRepoRootForDir.mockResolvedValueOnce('/ws/lab');
    mockGitRecentlyChangedFiles.mockResolvedValueOnce([
      {
        path: 'results/run-7.future-dnaforge-artifact',
        hash: 'future-format',
        date: '2026-09-15T10:00:00Z',
        relativeDate: 'now',
      },
    ]);

    const result = await getRecentlyEdited(8);

    expect(mockGitRecentlyChangedFiles).toHaveBeenCalledTimes(1);
    expect(mockGitRecentlyChangedFiles).toHaveBeenCalledWith('/ws/lab', 30);
    expect(result).toEqual([
      expect.objectContaining({
        title: 'run-7.future-dnaforge-artifact',
        workspaceRoot: '/ws/lab',
        open: expect.objectContaining({
          kind: 'file',
          path: '/ws/lab/results/run-7.future-dnaforge-artifact',
        }),
      }),
    ]);
  });

  it('scans only the top RECENT_WORKSPACE_SCAN_LIMIT (5) most-recently-opened active workspaces', async () => {
    const workspaceRows = [1, 2, 3, 4, 5, 6].map((id) => ({
      id,
      name: `WS${id}`,
      path: `/ws/${id}`,
      last_opened_at: id * 100,
      archived_at: null,
      trashed_at: null,
    }));
    mockSelect
      .mockResolvedValueOnce(workspaceRows)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockGetRecentlyEditedCatalogEntities.mockResolvedValueOnce([]);
    mockGitRecentlyChangedFiles.mockResolvedValue([]);

    await getRecentlyEdited(8);

    expect(mockGitRecentlyChangedFiles).toHaveBeenCalledTimes(5);
    const scannedPaths = mockGitRecentlyChangedFiles.mock.calls.map((call) => call[0]);
    expect(scannedPaths).not.toContain('/ws/1');
    expect(scannedPaths).toEqual(
      expect.arrayContaining(['/ws/2', '/ws/3', '/ws/4', '/ws/5', '/ws/6'])
    );
  });

  it('sorts a workspace with a null/undefined last_opened_at to the BOTTOM, not the top', async () => {
    const explicit = [2, 3, 4, 5, 6].map((id) => ({
      id,
      name: `WS${id}`,
      path: `/ws/${id}`,
      last_opened_at: id * 100,
      archived_at: null,
      trashed_at: null,
    }));
    const undated = {
      id: 1,
      name: 'Undated',
      path: '/ws/undated',
      last_opened_at: undefined,
      archived_at: null,
      trashed_at: null,
    };
    mockSelect
      .mockResolvedValueOnce([...explicit, undated])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockGetRecentlyEditedCatalogEntities.mockResolvedValueOnce([]);
    mockGitRecentlyChangedFiles.mockResolvedValue([]);

    await getRecentlyEdited(8);

    expect(mockGitRecentlyChangedFiles).toHaveBeenCalledTimes(5);
    const scannedPaths = mockGitRecentlyChangedFiles.mock.calls.map((call) => call[0]);
    expect(scannedPaths).not.toContain('/ws/undated');
  });
});

describe('recently edited snapshot ', () => {
  beforeEach(() => resetRecentlyEditedSnapshotForTests());

  it('keeps published items after the subscriber unsubscribes', () => {
    const item = {
      id: 'page-1',
      title: 'Lab notes',
      workspaceRoot: '/ws/lab',
      workspaceName: 'Lab',
      updatedAt: 1000,
      open: { kind: 'entity' as const, tabType: 'page' as const, entityId: 'page-1' },
    };
    const stop = subscribeRecentlyEditedSnapshot(() => {});
    publishRecentlyEditedSnapshot([item]);
    stop();
    expect(peekRecentlyEditedSnapshot()).toEqual([item]);

    const seen: number[] = [];
    const stop2 = subscribeRecentlyEditedSnapshot((items) => seen.push(items.length));
    expect(seen[0]).toBe(1);
    stop2();
  });

  it('does not clear the snapshot when a refresh is started', () => {
    const item = {
      id: 'page-1',
      title: 'Lab notes',
      workspaceRoot: '/ws/lab',
      workspaceName: 'Lab',
      updatedAt: 1000,
      open: { kind: 'entity' as const, tabType: 'page' as const, entityId: 'page-1' },
    };
    publishRecentlyEditedSnapshot([item]);
    mockSelect.mockReturnValue(new Promise(() => {}));
    void refreshRecentlyEdited(8);
    expect(peekRecentlyEditedSnapshot()).toEqual([item]);
  });

  it('coalesces overlapping refreshes into one in-flight scan, then reruns once if more were requested', async () => {
    mockSelect.mockReset();
    mockGetRecentlyEditedCatalogEntities.mockReset();
    mockGitRecentlyChangedFiles.mockReset();
    mockGitRepoRootForDir.mockReset();
    mockFsExists.mockReset().mockResolvedValue(true);
    let releaseFirst: (rows: unknown) => void = () => {};
    mockSelect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        })
    );
    const first = refreshRecentlyEdited(8);
    const second = refreshRecentlyEdited(8);
    expect(second).toBe(first);
    expect(mockSelect).toHaveBeenCalledTimes(1);

    mockSelect
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockGetRecentlyEditedCatalogEntities.mockResolvedValue([]);
    mockGitRecentlyChangedFiles.mockResolvedValue([]);
    mockGitRepoRootForDir.mockResolvedValue(null);
    mockFsExists.mockResolvedValue(true);
    releaseFirst([]);
    await expect(first).resolves.toEqual([]);
    expect(mockGetRecentlyEditedCatalogEntities.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the snapshot and still runs a later refresh when getRecentlyEdited rejects', async () => {
    const item = {
      id: 'page-1',
      title: 'Lab notes',
      workspaceRoot: '/ws/lab',
      workspaceName: 'Lab',
      updatedAt: 1000,
      open: { kind: 'entity' as const, tabType: 'page' as const, entityId: 'page-1' },
    };
    publishRecentlyEditedSnapshot([item]);
    mockSelect.mockRejectedValueOnce(new Error('sidecar not ready'));
    await expect(refreshRecentlyEdited(8)).rejects.toThrow('sidecar not ready');
    expect(peekRecentlyEditedSnapshot()).toEqual([item]);

    mockSelect
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockGetRecentlyEditedCatalogEntities.mockResolvedValueOnce([]);
    mockGitRecentlyChangedFiles.mockResolvedValue([]);
    mockGitRepoRootForDir.mockResolvedValue(null);
    mockFsExists.mockResolvedValue(true);
    await expect(refreshRecentlyEdited(8)).resolves.toEqual([]);
    expect(peekRecentlyEditedSnapshot()).toEqual([]);
  });
});
