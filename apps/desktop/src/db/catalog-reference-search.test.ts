import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSelect } = vi.hoisted(() => ({
  mockSelect: vi.fn().mockResolvedValue([]),
}));

vi.mock('../platform', () => ({
  platform: () => ({
    db: {
      select: (sql: string, params: unknown[]) =>
        sql.includes('AS match_count')
          ? Promise.resolve([{ match_count: 0 }])
          : mockSelect(sql, params),
      execute: vi.fn(),
    },
  }),
}));

import {
  searchCatalogReferencesByName,
  searchCatalogSequencePackagesByIds,
  searchMountedCatalogEntitiesByName,
} from './catalog-reference-search';

describe('searchMountedCatalogEntitiesByName ', () => {
  beforeEach(() => {
    mockSelect.mockClear();
    mockSelect.mockResolvedValue([]);
  });

  it('finds named openable entities across the exact mounted workspace roots', async () => {
    mockSelect.mockResolvedValue([
      {
        entity_id: 'repo-beta::puc19',
        entity_type: 'sequence',
        name: 'pUC19',
        workspace_root: '/ws/beta',
        workspace_name: 'Beta',
      },
      {
        entity_id: 'repo-alpha::assembly-1',
        entity_type: 'design',
        name: 'Golden Gate assembly',
        workspace_root: '/ws/alpha',
        workspace_name: 'Alpha',
      },
    ]);

    await expect(
      searchMountedCatalogEntitiesByName({
        query: 'gate',
        workspaceRoots: ['/ws/alpha/', '/ws/beta'],
      })
    ).resolves.toEqual([
      {
        entityId: 'repo-beta::puc19',
        entityType: 'sequence',
        name: 'pUC19',
        workspaceRoot: '/ws/beta',
        workspaceName: 'Beta',
      },
      {
        entityId: 'repo-alpha::assembly-1',
        entityType: 'design',
        name: 'Golden Gate assembly',
        workspaceRoot: '/ws/alpha',
        workspaceName: 'Alpha',
      },
    ]);

    const [sql, params] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('JOIN workspaces w ON w.id = e.workspace_id');
    expect(sql).toContain('w.path IN (?, ?)');
    expect(sql).toContain("e.status = 'active'");
    expect(sql).toContain("f.status = 'current'");
    expect(sql).toContain("e.locator = 'entity://lims/' || e.id");
    expect(params).toContain('/ws/alpha');
    expect(params).toContain('/ws/beta');
    expect(params).not.toContain('folder');
    expect(params).not.toContain('selection');
  });

  it('escapes wildcard characters and searches by the visible entity name', async () => {
    await searchMountedCatalogEntitiesByName({
      query: '100%_match',
      workspaceRoots: ['/ws/beta'],
    });

    const [sql, params] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("e.name LIKE ? ESCAPE '\\'");
    expect(params).toContain('%100\\%\\_match%');
  });

  it('uses the same sequence display name for loose files and imported packages', async () => {
    mockSelect.mockResolvedValue([
      {
        entity_id: 'repo-alpha::sequence',
        entity_type: 'sequence',
        name: 'Shared sequence.gb',
        workspace_root: '/ws/alpha',
        workspace_name: 'Alpha',
      },
      {
        entity_id: 'repo-beta::sequence',
        entity_type: 'sequence',
        name: 'Shared sequence',
        workspace_root: '/ws/beta',
        workspace_name: 'Beta',
      },
      {
        entity_id: 'repo-beta::file',
        entity_type: 'file',
        name: 'Shared sequence.gb',
        workspace_root: '/ws/beta',
        workspace_name: 'Beta',
      },
    ]);
    const results = await searchMountedCatalogEntitiesByName({
      query: 'Shared sequence',
      workspaceRoots: ['/ws/alpha', '/ws/beta'],
    });
    expect(results.map(({ name }) => name)).toEqual([
      'Shared sequence',
      'Shared sequence',
      'Shared sequence.gb',
    ]);
    expect(results.map(({ entityId }) => entityId)).toEqual([
      'repo-alpha::sequence',
      'repo-beta::sequence',
      'repo-beta::file',
    ]);
  });

  it('keeps an owned database-only notebook searchable while it awaits file migration', async () => {
    mockSelect.mockResolvedValue([
      {
        entity_id: 'repo-beta::legacy-notes',
        entity_type: 'notebook',
        name: 'Legacy notes',
        workspace_root: '/ws/beta',
        workspace_name: 'Beta',
      },
    ]);

    await expect(
      searchMountedCatalogEntitiesByName({ query: 'legacy', workspaceRoots: ['/ws/beta'] })
    ).resolves.toEqual([
      {
        entityId: 'repo-beta::legacy-notes',
        entityType: 'notebook',
        name: 'Legacy notes',
        workspaceRoot: '/ws/beta',
        workspaceName: 'Beta',
      },
    ]);

    const [sql] = mockSelect.mock.calls[0] as [string];
    expect(sql).toContain("e.type = 'notebook'");
    expect(sql).toContain("e.locator = 'entity://page/' || e.id");
    expect(sql).toContain('FROM pages p');
  });

  it('does not query the installation-wide catalog when no workspace is mounted', async () => {
    await expect(
      searchMountedCatalogEntitiesByName({ query: 'pUC19', workspaceRoots: [] })
    ).resolves.toEqual([]);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('drops malformed non-portable catalog identities instead of rendering dead results', async () => {
    mockSelect.mockResolvedValue([
      {
        entity_id: 'repo-beta::not portable',
        entity_type: 'sequence',
        name: 'Broken result',
        workspace_root: '/ws/beta',
        workspace_name: 'Beta',
      },
    ]);

    await expect(
      searchMountedCatalogEntitiesByName({ query: 'broken', workspaceRoots: ['/ws/beta'] })
    ).resolves.toEqual([]);
  });

  it('excludes stale local-storage design pointers but keeps loaded designs searchable', async () => {
    mockSelect.mockResolvedValue([
      {
        entity_id: 'repo-beta::loaded-design',
        entity_type: 'design',
        name: 'Loaded design',
        storage_type: 'localStorage',
        metadata: JSON.stringify({ embeddedDesignAvailable: false }),
        workspace_root: '/ws/beta',
        workspace_name: 'Beta',
      },
      {
        entity_id: 'repo-beta::stale-design',
        entity_type: 'design',
        name: 'Stale design',
        storage_type: 'localStorage',
        metadata: JSON.stringify({ embeddedDesignAvailable: false }),
        workspace_root: '/ws/beta',
        workspace_name: 'Beta',
      },
    ]);

    await expect(
      searchMountedCatalogEntitiesByName({
        query: 'design',
        workspaceRoots: ['/ws/beta'],
        openLocalDesignIds: ['repo-beta::loaded-design'],
      })
    ).resolves.toEqual([
      {
        entityId: 'repo-beta::loaded-design',
        entityType: 'design',
        name: 'Loaded design',
        workspaceRoot: '/ws/beta',
        workspaceName: 'Beta',
      },
    ]);

    const [sql, params] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("e.storage_type <> 'localStorage'");
    expect(sql).toContain('json_valid(e.metadata)');
    expect(sql).toContain("json_extract(e.metadata, '$.embeddedDesignAvailable') IS NOT 0");
    expect(sql).toContain('e.id IN (?)');
    expect(params).toContain('repo-beta::loaded-design');
  });

  it('does not admit any local-storage design pointer when no design is loaded', async () => {
    mockSelect.mockResolvedValue([
      {
        entity_id: 'repo-beta::stale-design',
        entity_type: 'design',
        name: 'Fixture Design',
        storage_type: 'localStorage',
        metadata: JSON.stringify({ embeddedDesignAvailable: false }),
        workspace_root: '/ws/beta',
        workspace_name: 'Beta',
      },
    ]);

    await expect(
      searchMountedCatalogEntitiesByName({
        query: 'Fixture Design',
        workspaceRoots: ['/ws/beta'],
        openLocalDesignIds: [],
      })
    ).resolves.toEqual([]);

    const [sql] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("e.storage_type <> 'localStorage'");
    expect(sql).not.toContain('e.id IN (');
  });
});

describe('searchCatalogReferencesByName', () => {
  beforeEach(() => {
    mockSelect.mockClear();
    mockSelect.mockResolvedValue([]);
  });

  it('joins entities to their files so a path comes back with the name', async () => {
    await searchCatalogReferencesByName({
      query: 'pUC',
      entityType: 'sequence',
      workspaceRoot: '/ws/beta',
    });

    const [sql] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('catalog_entities');
    expect(sql).toContain('catalog_entity_files');
    expect(sql).toContain('JOIN');
  });

  it('scopes results to the OWNING workspace root', async () => {
    await searchCatalogReferencesByName({
      query: 'pUC',
      entityType: 'sequence',
      workspaceRoot: '/ws/beta',
    });

    const [sql, params] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('JOIN workspaces w ON w.id = f.workspace_id');
    expect(sql).toContain('w.path = ?');
    expect(sql).toMatch(/f\.path LIKE \?/);
    expect(params.filter((value) => value === '/ws/beta')).toHaveLength(2);
    expect(params).toContain('/ws/beta/%');
  });

  it('returns only CURRENT file bindings', async () => {
    await searchCatalogReferencesByName({
      query: 'x',
      entityType: 'sequence',
      workspaceRoot: '/ws/beta',
    });

    const [sql] = mockSelect.mock.calls[0] as [string];
    expect(sql).toContain("f.status = 'current'");
  });

  it('excludes archived and missing entities', async () => {
    await searchCatalogReferencesByName({
      query: 'x',
      entityType: 'sequence',
      workspaceRoot: '/ws/beta',
    });

    const [sql] = mockSelect.mock.calls[0] as [string];
    expect(sql).toContain("e.status = 'active'");
  });

  it('filters by the requested entity type', async () => {
    await searchCatalogReferencesByName({
      query: 'x',
      entityType: 'sequence',
      workspaceRoot: '/ws/beta',
    });

    const [, params] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(params).toContain('sequence');
  });

  it('lists recent entries when the query is empty rather than matching everything', async () => {
    await searchCatalogReferencesByName({
      query: '   ',
      entityType: 'sequence',
      workspaceRoot: '/ws/beta',
    });

    const [sql, params] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('e.name LIKE');
    expect(params).not.toContain('%   %');
  });

  it('escapes LIKE wildcards in the query so a literal % does not match everything', async () => {
    await searchCatalogReferencesByName({
      query: '100%',
      entityType: 'sequence',
      workspaceRoot: '/ws/beta',
    });

    const [sql, params] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ESCAPE '\\'");
    expect(params).toContain('%100\\%%');
  });

  it('maps rows into a portable record shape', async () => {
    mockSelect.mockResolvedValue([
      {
        entity_id: 'ent-1',
        name: 'pUC19',
        path: '/ws/beta/sequences/pUC19.gb',
        relative_path: 'sequences/pUC19.gb',
        content_hash: 'sha256:abc',
        object_uuid: 'obj-1',
        size_bytes: 2_686,
        file_kind: 'genbank',
      },
    ]);

    const rows = await searchCatalogReferencesByName({
      query: 'pUC',
      entityType: 'sequence',
      workspaceRoot: '/ws/beta',
    });

    expect(rows).toEqual([
      {
        entityId: 'ent-1',
        name: 'pUC19',
        absolutePath: '/ws/beta/sequences/pUC19.gb',
        workspaceRelativePath: 'sequences/pUC19.gb',
        contentHash: 'sha256:abc',
        objectUuid: 'obj-1',
        sizeBytes: 2_686,
        sequenceDocument: { kind: 'catalog-sequence', entityId: 'ent-1' },
      },
    ]);
  });

  it('returns a package-root binding as managed sequence identity', async () => {
    mockSelect.mockResolvedValue([
      {
        entity_id: 'package-rbs',
        name: 'B0034m_BC',
        path: '/ws/beta/sequences/B0034m_BC',
        relative_path: 'sequences/B0034m_BC',
        content_hash: null,
        object_uuid: 'package-object',
        size_bytes: null,
        file_kind: 'waypoint-sequence',
      },
    ]);

    const [row] = await searchCatalogReferencesByName({
      query: 'B0034',
      entityType: 'sequence',
      workspaceRoot: '/ws/beta',
    });

    expect(row).toMatchObject({
      entityId: 'package-rbs',
      name: 'B0034m_BC',
      absolutePath: '/ws/beta/sequences/B0034m_BC',
      workspaceRelativePath: 'sequences/B0034m_BC',
      sequenceDocument: {
        kind: 'managed-sequence',
        packageId: 'package-rbs',
        packageRoot: '/ws/beta/sequences/B0034m_BC',
      },
    });
  });

  it('keeps a package that is itself the workspace root searchable', async () => {
    mockSelect.mockResolvedValue([
      {
        entity_id: 'package-root',
        name: 'pUC19',
        path: '/ws/beta',
        relative_path: '',
        content_hash: null,
        object_uuid: null,
        size_bytes: null,
        file_kind: 'waypoint-sequence',
      },
    ]);

    const [row] = await searchCatalogReferencesByName({
      query: 'pUC19',
      entityType: 'sequence',
      workspaceRoot: '/ws/beta',
    });

    expect(row.workspaceRelativePath).toBe('.');
    expect(row.sequenceDocument).toEqual({
      kind: 'managed-sequence',
      packageId: 'package-root',
      packageRoot: '/ws/beta',
    });
  });

  it('derives a relative path when the row has none', async () => {
    mockSelect.mockResolvedValue([
      {
        entity_id: 'ent-2',
        name: 'x',
        path: '/ws/beta/a/b.gb',
        relative_path: null,
        content_hash: null,
        object_uuid: null,
        size_bytes: null,
      },
    ]);

    const [row] = await searchCatalogReferencesByName({
      query: 'x',
      entityType: 'sequence',
      workspaceRoot: '/ws/beta',
    });

    expect(row?.workspaceRelativePath).toBe('a/b.gb');
  });

  it('drops a row whose path escapes the owning root instead of returning it', async () => {
    mockSelect.mockResolvedValue([
      {
        entity_id: 'e',
        name: 'x',
        path: '/ws/beta-archive/a.gb',
        relative_path: null,
        content_hash: null,
      },
    ]);

    const rows = await searchCatalogReferencesByName({
      query: 'x',
      entityType: 'sequence',
      workspaceRoot: '/ws/beta',
    });

    expect(rows).toEqual([]);
  });

  it('drops an escaping row even when it already carries a relative_path', async () => {
    mockSelect.mockResolvedValue([
      {
        entity_id: 'e',
        name: 'x',
        path: '/ws/beta-archive/a.gb',
        relative_path: 'a.gb',
        content_hash: null,
      },
    ]);

    const rows = await searchCatalogReferencesByName({
      query: 'x',
      entityType: 'sequence',
      workspaceRoot: '/ws/beta',
    });

    expect(rows).toEqual([]);
  });

  it('returns nothing when there is no owning root', async () => {
    const rows = await searchCatalogReferencesByName({
      query: 'x',
      entityType: 'sequence',
      workspaceRoot: null,
    });

    expect(rows).toEqual([]);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

describe('searchCatalogSequencePackagesByIds', () => {
  beforeEach(() => {
    mockSelect.mockClear();
    mockSelect.mockResolvedValue([]);
  });

  it('loads declared package identities directly instead of relying on the recent-entity window', async () => {
    await searchCatalogSequencePackagesByIds({
      sequencePackageIds: ['package-old', 'package-new'],
      workspaceRoot: '/ws/beta',
    });

    const [sql, params] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('e.id IN (?, ?)');
    expect(sql).toContain('JOIN workspaces w ON w.id = f.workspace_id');
    expect(sql).toContain('w.path = ?');
    expect(sql).not.toContain('LIMIT');
    expect(params).toEqual(
      expect.arrayContaining(['package-old', 'package-new', '/ws/beta', '/ws/beta/%'])
    );
  });
});
