import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/analytics', () => ({ trackRendererEvent: vi.fn() }));

import {
  clearMockData,
  getMockFileContent,
  MockFsModule,
  setMockFileContent,
} from '../test/platform-mocks';
import { initializeTestSchema } from '../test/initializeTestSchema';
import {
  bindCatalogEntityToFile,
  getCatalogEventsForEntity,
  getCatalogEntity,
  getCatalogFilesForEntity,
  rebindCatalogFilePath,
  registerCatalogEntity,
  resolveWorkspaceScope,
} from './workspace-catalog';
import { scopedProjectionId } from '../shared/workspace-scoped-identity';
import {
  createDesignArtifactFile,
  createNotebookArtifactFile,
  migrateDatabaseOnlyNotebooksForWorkspace,
  normalizeWorkspaceArtifactFileName,
  parseWorkspaceArtifact,
  planWorkspaceArtifactRepair,
  recordWorkspaceArtifactFileRenameInProjectMemory,
  renameDesignArtifactFile,
  renameNotebookArtifactFile,
  resolveNotebookArtifactWorkspaceOwner,
  resolveArtifactFile,
  workspaceArtifactSourcesMatch,
  applyAcceptedWorkspaceArtifactRepair,
  writeDesignArtifactSnapshot,
  writeNotebookArtifactSnapshot,
} from './workspace-artifacts';
import { readProjectMemory } from './project-memory';
import { platform } from '../platform';
import { trackRendererEvent } from '../lib/analytics';
import { contentFingerprint } from './entity-substrate/adapter';
import { serializeNotebookMarkdown } from './notebook-markdown-codec';

describe('workspace artifacts', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearMockData();
    await initializeTestSchema();
    vi.spyOn(platform().workspace, 'relocateEntityFile').mockImplementation(
      async ({ oldPath, newPath, workspaceRoot, mutationToken }) => {
        await platform().fs.rename(oldPath, newPath, mutationToken);
        await rebindCatalogFilePath({ oldPath, newPath, workspaceRoot });
        return {
          newPath,
          counts: {
            catalog: { updated: 1 },
            indexed: {
              indexedFilesMoved: 0,
              staleIndexedFilesMerged: 0,
              primerBindingsRepointed: 0,
            },
            lims: { rebasedEntityIds: [], workspaceIds: [] },
          },
        };
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes notebook artifact files inside the selected folder and records provenance', async () => {
    const entity = await registerCatalogEntity({
      id: 'page-1',
      type: 'notebook',
      name: 'Untitled',
      locator: 'entity://page/page-1',
      storageType: 'database',
      workspaceRoot: '/lab',
    });

    const artifact = await createNotebookArtifactFile({
      entityId: entity.id,
      pageId: 'page-1',
      title: 'Untitled',
      content: { type: 'doc', content: [] },
      workspaceRoot: '/lab',
      context: {
        targetPath: '/lab/experiments',
        targetKind: 'folder',
        parentPath: '/lab/experiments',
        workspaceRoot: '/lab',
      },
    });

    expect(artifact).toMatchObject({
      path: '/lab/experiments/Untitled',
      name: 'Untitled',
      fileKind: 'waypoint-notebook',
    });
    const document = JSON.parse(
      getMockFileContent('/lab/experiments/Untitled/.forge/notebook.json') ?? '{}'
    );
    expect(document).toMatchObject({
      schema: 'waypoint.notebook.v1',
      kind: 'notebook',
      formatVersion: 2,
      id: 'page-1',
      authority: { type: 'markdown', path: 'Untitled.md' },
    });
    expect(document).not.toHaveProperty('content');
    expect(document).not.toHaveProperty('storage');

    expect(await getCatalogFilesForEntity(entity.id)).toEqual([
      expect.objectContaining({
        path: '/lab/experiments/Untitled',
        relative_path: 'experiments/Untitled',
        file_kind: 'waypoint-notebook',
      }),
    ]);
    expect(await getCatalogEventsForEntity(entity.id)).toEqual([
      expect.objectContaining({
        event_type: 'artifact_created',
        summary: 'Created notebook package',
      }),
    ]);
    expect(await platform().lims.queryEntities({ id: entity.id })).toEqual([
      expect.objectContaining({
        id: entity.id,
        kind: 'notebook',
        name: 'Untitled',
        fields: { packagePath: '/lab/experiments/Untitled' },
      }),
    ]);

    await expect(readProjectMemory('/lab')).resolves.toMatchObject({
      events: [expect.objectContaining({ eventType: 'artifact_created' })],
      entities: [
        expect.objectContaining({
          id: entity.id,
          kind: 'notebook',
          displayName: 'Untitled',
        }),
      ],
      files: [
        expect.objectContaining({
          entityId: entity.id,
          path: 'experiments/Untitled',
          fileKind: 'notebook',
          status: 'current',
        }),
      ],
    });

    await expect(resolveNotebookArtifactWorkspaceOwner(entity.id)).resolves.toEqual({
      status: 'bound',
      workspaceRoot: '/lab',
    });
  });

  it.each([
    { workspaceRoot: 'C:\\Lab projects', path: 'C:\\Lab projects\\Windows Save proof' },
    {
      workspaceRoot: 'C:\\Lab projects',
      path: 'C:\\Lab projects\\Experiments/Windows Save proof',
    },
    { workspaceRoot: 'C:\\', path: 'C:\\Windows Save proof' },
    {
      workspaceRoot: '\\\\server\\Lab projects',
      path: '\\\\server\\Lab projects\\Windows Save proof',
    },
    { workspaceRoot: '/', path: '/Windows Save proof' },
  ])(
    'resolves the catalog owner of $path without changing root bytes',
    async ({ workspaceRoot, path }) => {
      const entity = await registerCatalogEntity({
        id: 'page-native-owner',
        type: 'notebook',
        name: 'Windows Save proof',
        locator: 'entity://page/page-native-owner',
        storageType: 'database',
        workspaceRoot,
      });
      await bindCatalogEntityToFile({
        entityId: entity.id,
        path,
        fileKind: 'waypoint-notebook',
        workspaceRoot,
        status: 'current',
      });

      await expect(resolveNotebookArtifactWorkspaceOwner(entity.id)).resolves.toEqual({
        status: 'bound',
        workspaceRoot,
      });
    }
  );

  it('distinguishes an unbound page from an unusable notebook binding', async () => {
    await expect(resolveNotebookArtifactWorkspaceOwner('db-only-page')).resolves.toEqual({
      status: 'unbound',
    });

    const entity = await registerCatalogEntity({
      id: 'page-invalid-owner',
      type: 'notebook',
      name: 'Invalid owner',
      locator: 'entity://page/page-invalid-owner',
      storageType: 'database',
      workspaceRoot: null,
    });
    await bindCatalogEntityToFile({
      entityId: entity.id,
      path: '/lab/Invalid owner',
      fileKind: 'waypoint-notebook',
      workspaceRoot: null,
      status: 'current',
    });

    await expect(resolveNotebookArtifactWorkspaceOwner(entity.id)).resolves.toEqual({
      status: 'invalid-binding',
      path: '/lab/Invalid owner',
    });
  });

  it('materializes an owned DB-only page with a portable on-disk ID', async () => {
    const scope = await resolveWorkspaceScope('/lab');
    const scopedId = scopedProjectionId(scope, 'db-only-raw');
    await registerCatalogEntity({
      id: scopedId,
      type: 'notebook',
      name: 'Recovered Notes',
      locator: `entity://page/${scopedId}`,
      storageType: 'database',
      workspaceRoot: '/lab',
    });
    const now = Date.now();
    await platform().db.execute(
      'INSERT INTO pages (id, title, content, date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        scopedId,
        'Recovered Notes',
        JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }),
        null,
        now,
        now,
      ]
    );

    const report = await migrateDatabaseOnlyNotebooksForWorkspace('/lab');

    expect(report).toEqual({ migrated: [scopedId], recovered: [], failed: [] });
    const metadata = JSON.parse(
      getMockFileContent('/lab/Recovered Notes/.forge/notebook.json') ?? '{}'
    );
    expect(metadata).toMatchObject({ id: 'db-only-raw', formatVersion: 2 });
    expect(await getCatalogFilesForEntity(scopedId)).toEqual([
      expect.objectContaining({ path: '/lab/Recovered Notes', status: 'current' }),
    ]);
    const migrationEvents = vi
      .mocked(trackRendererEvent)
      .mock.calls.filter(([event]) => event === 'notebook_migration_result');
    expect(migrationEvents).toEqual([
      [
        'notebook_migration_result',
        {
          feature_area: 'reliability',
          workflow_status: 'started',
          version: '2',
          source: 'database-only',
          outcome: 'started',
        },
      ],
      [
        'notebook_migration_result',
        {
          feature_area: 'reliability',
          workflow_status: 'success',
          version: '2',
          source: 'database-only',
          outcome: 'success',
          success: true,
        },
      ],
    ]);
    const serializedTelemetry = JSON.stringify(migrationEvents);
    for (const sentinel of ['Recovered Notes', '/lab', scopedId, 'db-only-raw']) {
      expect(serializedTelemetry).not.toContain(sentinel);
    }
  });

  it('converges after a legacy unscoped migration published its scoped package before retiring the source projection', async () => {
    const rawId = 'db-only-restart-raw';
    const scope = await resolveWorkspaceScope('/lab');
    const scopedId = scopedProjectionId(scope, rawId);
    await registerCatalogEntity({
      id: rawId,
      type: 'notebook',
      name: 'Restart recovery',
      locator: `entity://page/${rawId}`,
      storageType: 'database',
      workspaceRoot: '/lab',
    });
    const now = Date.now();
    const content = { type: 'doc', content: [{ type: 'paragraph' }] };
    await platform().db.execute(
      'INSERT INTO pages (id, title, content, date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [rawId, 'Restart recovery', JSON.stringify(content), null, now, now]
    );

    await createNotebookArtifactFile({
      entityId: scopedId,
      pageId: rawId,
      title: 'Restart recovery',
      content,
      workspaceRoot: '/lab',
    });

    await expect(migrateDatabaseOnlyNotebooksForWorkspace('/lab')).resolves.toEqual({
      migrated: [],
      recovered: [rawId],
      failed: [],
    });
    await expect(getCatalogEntity(rawId)).resolves.toMatchObject({ status: 'archived' });
    await expect(getCatalogEntity(scopedId)).resolves.toMatchObject({ status: 'active' });
    expect(await getCatalogFilesForEntity(scopedId)).toEqual([
      expect.objectContaining({ path: '/lab/Restart recovery', status: 'current' }),
    ]);
    const preservedSourceRows = await platform().db.select<Array<{ content: string }>>(
      'SELECT content FROM pages WHERE id = ?',
      [rawId]
    );
    expect(preservedSourceRows).toHaveLength(1);
    expect(preservedSourceRows[0]).toMatchObject({ content: JSON.stringify(content) });

    await expect(migrateDatabaseOnlyNotebooksForWorkspace('/lab')).resolves.toEqual({
      migrated: [],
      recovered: [],
      failed: [],
    });
  });

  it('does not recover a current-workspace package for an entity already scoped elsewhere', async () => {
    const rawId = 'workspace-bound-recovery';
    const labScope = await resolveWorkspaceScope('/lab');
    const otherScope = await resolveWorkspaceScope('/other');
    await createNotebookArtifactFile({
      entityId: scopedProjectionId(labScope, rawId),
      pageId: rawId,
      title: 'Workspace-bound recovery',
      content: { type: 'doc', content: [] },
      workspaceRoot: '/lab',
    });

    await expect(
      createNotebookArtifactFile({
        entityId: scopedProjectionId(otherScope, rawId),
        pageId: rawId,
        title: 'Workspace-bound recovery',
        content: { type: 'doc', content: [] },
        workspaceRoot: '/lab',
      })
    ).rejects.toThrow('belongs to another entity');
  });

  it('preserves workspace-less DB-only pages without assigning them to the active workspace', async () => {
    const now = Date.now();
    await platform().db.execute(
      'INSERT INTO pages (id, title, content, date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        'unowned-page',
        'Choose my workspace',
        JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }),
        null,
        now,
        now,
      ]
    );

    expect(await migrateDatabaseOnlyNotebooksForWorkspace('/lab')).toEqual({
      migrated: [],
      recovered: [],
      failed: [],
    });
    expect(
      await platform().db.select<Array<{ id: string; content: string }>>(
        'SELECT id, content FROM pages WHERE id = ?',
        ['unowned-page']
      )
    ).toEqual([
      expect.objectContaining({
        id: 'unowned-page',
        content: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }),
      }),
    ]);
    expect(getMockFileContent('/lab/Choose my workspace/.forge/notebook.json')).toBeNull();
  });

  it('honors an explicit notebook package name after pending create commit', async () => {
    const entity = await registerCatalogEntity({
      id: 'page-named',
      type: 'notebook',
      name: 'Experiment 7',
      locator: 'entity://page/page-named',
      storageType: 'database',
      workspaceRoot: '/lab',
    });

    const artifact = await createNotebookArtifactFile({
      entityId: entity.id,
      pageId: 'page-named',
      title: 'Experiment 7',
      fileName: 'Experiment 7',
      workspaceRoot: '/lab',
      context: {
        targetPath: '/lab',
        targetKind: 'folder',
        parentPath: '/lab',
        workspaceRoot: '/lab',
      },
    });

    expect(artifact).toMatchObject({
      path: '/lab/Experiment 7',
      name: 'Experiment 7',
      fileKind: 'waypoint-notebook',
    });
    expect(getMockFileContent('/lab/Experiment 7/.forge/notebook.json')).toBeTruthy();
    expect(getMockFileContent('/lab/Experiment 7/Experiment 7.md')).toBeTruthy();
  });

  it('normalizes pending artifact names (notebook package stem; design compound extension)', () => {
    expect(
      normalizeWorkspaceArtifactFileName({
        fileName: 'Experiment 7',
        type: 'notebook',
      })
    ).toEqual({
      fileName: 'Experiment 7',
      stem: 'Experiment 7',
    });
    expect(
      normalizeWorkspaceArtifactFileName({
        fileName: 'Experiment 7.wpnote.json',
        type: 'notebook',
      })
    ).toEqual({
      fileName: 'Experiment 7',
      stem: 'Experiment 7',
    });
    expect(
      normalizeWorkspaceArtifactFileName({
        fileName: 'Bad/Design?.wpdesign.json',
        type: 'design',
      })
    ).toEqual({
      fileName: 'Bad-Design-.wpdesign.json',
      stem: 'Bad-Design-',
    });
  });

  it('writes design artifacts beside file targets and chooses unique names', async () => {
    setMockFileContent('/lab/experiments/New Design.wpdesign.json', '{}');
    const writeTextFile = vi.spyOn(platform().fs, 'writeTextFile');
    const mkdir = vi.spyOn(platform().fs, 'mkdir');
    const entity = await registerCatalogEntity({
      id: 'design-1',
      type: 'design',
      name: 'New Design',
      locator: 'entity://design/design-1',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });

    const artifact = await createDesignArtifactFile({
      entityId: entity.id,
      designId: 'design-1',
      name: 'New Design',
      design: null,
      workspaceRoot: '/lab',
      context: {
        targetPath: '/lab/experiments/result.txt',
        targetKind: 'file',
        parentPath: '/lab/experiments',
        workspaceRoot: '/lab',
      },
      mutationToken: 'design-create-token',
    });

    expect(artifact).toMatchObject({
      path: '/lab/experiments/New Design 2.wpdesign.json',
      name: 'New Design 2.wpdesign.json',
      fileKind: 'waypoint-design',
    });
    const document = JSON.parse(getMockFileContent(artifact!.path) ?? '{}');
    expect(document).toMatchObject({
      schema: 'waypoint.design.v1',
      kind: 'assembly-design',
      id: 'design-1',
      plannedOutputs: [{ format: 'genbank', status: 'pending-sequence' }],
    });
    expect(writeTextFile).toHaveBeenCalledWith(
      '/lab/experiments/New Design 2.wpdesign.json',
      expect.any(String),
      undefined,
      'design-create-token'
    );
    expect(mkdir).toHaveBeenCalledWith(
      '/lab/.waypoint',
      { recursive: true },
      'design-create-token'
    );
  });

  it('writes Project Memory before catalog projection when creating a native artifact', async () => {
    await registerCatalogEntity({
      id: 'design-catalog-fails',
      type: 'design',
      name: 'Catalog Fails',
      locator: 'entity://design/design-catalog-fails',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    const originalBind = platform().db.bindCatalogEntityFile.bind(platform().db);
    vi.spyOn(platform().db, 'bindCatalogEntityFile').mockImplementation(async (input, token) => {
      if (input.path === '/lab/Catalog Fails.wpdesign.json') {
        throw new Error('catalog projection write failed');
      }
      return originalBind(input, token);
    });

    await expect(
      createDesignArtifactFile({
        entityId: 'design-catalog-fails',
        designId: 'design-catalog-fails',
        name: 'Catalog Fails',
        design: null,
        workspaceRoot: '/lab',
        context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
      })
    ).rejects.toThrow(/catalog projection write failed/);

    expect(getMockFileContent('/lab/Catalog Fails.wpdesign.json')).toContain(
      '"id": "design-catalog-fails"'
    );
    await expect(readProjectMemory('/lab')).resolves.toMatchObject({
      events: [expect.objectContaining({ eventType: 'artifact_created' })],
      files: [expect.objectContaining({ path: 'Catalog Fails.wpdesign.json' })],
    });
    expect(await getCatalogFilesForEntity('design-catalog-fails')).toEqual([]);
  });

  it('does not create catalog projection when Project Memory create write fails', async () => {
    await registerCatalogEntity({
      id: 'design-memory-fails',
      type: 'design',
      name: 'Memory Fails',
      locator: 'entity://design/design-memory-fails',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    const originalWriteTextFile = MockFsModule.writeTextFile.bind(MockFsModule);
    vi.spyOn(MockFsModule, 'writeTextFile').mockImplementation(async (path, contents) => {
      if (path === '/lab/.waypoint/project-memory/events.jsonl') {
        throw new Error('project memory write failed');
      }
      return originalWriteTextFile(path, contents);
    });

    await expect(
      createDesignArtifactFile({
        entityId: 'design-memory-fails',
        designId: 'design-memory-fails',
        name: 'Memory Fails',
        design: null,
        workspaceRoot: '/lab',
        context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
      })
    ).rejects.toThrow(/project memory write failed/);

    expect(getMockFileContent('/lab/Memory Fails.wpdesign.json')).toContain(
      '"id": "design-memory-fails"'
    );
    expect(await getCatalogFilesForEntity('design-memory-fails')).toEqual([]);
    expect(await getCatalogEventsForEntity('design-memory-fails')).toEqual([]);
  });

  it('parses and rejects DNAForge artifact files', () => {
    expect(
      parseWorkspaceArtifact(
        JSON.stringify({
          schema: 'waypoint.notebook.v1',
          kind: 'notebook',
          id: 'page-1',
          title: 'Recovered',
          content: { type: 'doc', content: [] },
        })
      )
    ).toMatchObject({ kind: 'notebook', id: 'page-1', title: 'Recovered' });

    expect(() => parseWorkspaceArtifact('{nope')).toThrow(/Invalid DNAForge artifact JSON/);
    expect(() =>
      parseWorkspaceArtifact(JSON.stringify({ schema: 'unknown', kind: 'x', id: '1' }))
    ).toThrow(/Unsupported DNAForge artifact schema/);

    expect(
      parseWorkspaceArtifact(
        JSON.stringify({
          schema: 'waypoint.notebook.v1',
          kind: 'notebook',
          id: 'ws7::page-scoped',
          title: 'Scoped',
          content: { type: 'doc', content: [] },
        })
      )
    ).toMatchObject({ kind: 'notebook', id: 'page-scoped', title: 'Scoped' });
  });

  it('resolves a vault-shaped notebook package with an empty catalog and repairs the binding', async () => {
    const packageRoot = '/lab/recovered/Recovered Package';
    setMockFileContent(
      `${packageRoot}/.forge/notebook.json`,
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'page-package-recovered',
        title: 'Recovered Package',
        content: { type: 'doc', content: [] },
      })
    );
    setMockFileContent(`${packageRoot}/Recovered Package.md`, '# Recovered Package\n');

    const resolved = await resolveArtifactFile({
      path: packageRoot,
      workspaceRoot: '/lab',
      catalogMetadata: {
        placement: {
          kind: 'package',
          rootRelativePath: 'recovered/Recovered Package',
          primaryRelativePath: 'recovered/Recovered Package/.forge/notebook.json',
          fileKind: 'waypoint-notebook',
        },
        migrationSource: {
          historyRunId: 'run-copied-v2',
          sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
          sourceObjectId: 'etr_NOTEBOOKA',
        },
      },
    });

    const scopedId = scopedProjectionId(
      await resolveWorkspaceScope('/lab'),
      'page-package-recovered'
    );
    expect(scopedId).toMatch(/::page-package-recovered$/);
    expect(resolved.repaired).toBe(true);
    expect(resolved.authorityFingerprint).toBe(
      contentFingerprint(getMockFileContent(`${packageRoot}/Recovered Package.md`) ?? '')
    );
    expect(resolved.entity).toMatchObject({
      id: scopedId,
      type: 'notebook',
      locator: `entity://page/${scopedId}`,
    });
    expect(JSON.parse(resolved.entity.metadata ?? '{}')).toMatchObject({
      placement: { kind: 'package' },
      migrationSource: {
        historyRunId: 'run-copied-v2',
        sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
        sourceObjectId: 'etr_NOTEBOOKA',
      },
    });
    const reopened = await resolveArtifactFile({ path: packageRoot, workspaceRoot: '/lab' });
    expect(JSON.parse(reopened.entity.metadata ?? '{}')).toMatchObject({
      placement: { kind: 'package' },
      migrationSource: {
        historyRunId: 'run-copied-v2',
        sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
        sourceObjectId: 'etr_NOTEBOOKA',
      },
    });
    expect(await getCatalogFilesForEntity(scopedId)).toEqual([
      expect.objectContaining({
        path: packageRoot,
        relative_path: 'recovered/Recovered Package',
        status: 'current',
        file_kind: 'waypoint-notebook',
      }),
    ]);
    const otherId = scopedProjectionId(
      await resolveWorkspaceScope('/other'),
      'page-package-recovered'
    );
    const other = await createNotebookArtifactFile({
      entityId: otherId,
      pageId: 'page-package-recovered',
      title: 'Other notebook',
      content: { type: 'doc', content: [] },
      workspaceRoot: '/other',
      context: { targetPath: '/other', targetKind: 'folder', parentPath: '/other' },
    });
    const otherResolved = await resolveArtifactFile({ path: other.path, workspaceRoot: '/other' });
    expect(otherResolved.entity.id).toBe(otherId);
    expect(JSON.parse(otherResolved.entity.metadata ?? '{}')).not.toHaveProperty('migrationSource');
    const replaced = await resolveArtifactFile({
      path: packageRoot,
      workspaceRoot: '/lab',
      catalogMetadata: {},
    });
    expect(JSON.parse(replaced.entity.metadata ?? '{}')).not.toHaveProperty('migrationSource');
  });

  it('does not treat a newly created notebook package as an external edit on first save', async () => {
    const pageId = scopedProjectionId(await resolveWorkspaceScope('/lab'), 'page-first-save');
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First saved revision' }] }],
    };

    const artifact = await writeNotebookArtifactSnapshot({
      pageId,
      title: 'First save',
      content,
      workspaceRoot: '/lab',
      expectedProjectionContent: { type: 'doc', content: [] },
    });

    expect(artifact).toMatchObject({
      path: '/lab/First save',
      fileKind: 'waypoint-notebook',
    });
    const resolved = await resolveArtifactFile({
      path: '/lab/First save',
      workspaceRoot: '/lab',
    });
    expect(resolved.artifact).toMatchObject({
      id: 'page-first-save',
      content,
    });
  });

  it('does not overwrite an external edit that lands during first-save registration', async () => {
    const markdownPath = '/lab/First save race/First save race.md';
    const writeTextFile = platform().fs.writeTextFile.bind(platform().fs);
    let injected = false;
    vi.spyOn(platform().fs, 'writeTextFile').mockImplementation(
      async (path, content, options, mutationToken) => {
        const result = await writeTextFile(path, content, options, mutationToken);
        if (!injected && path === '/lab/.waypoint/project-memory/manifest.json') {
          injected = true;
          setMockFileContent(
            markdownPath,
            (getMockFileContent(markdownPath) ?? '').replace(
              'First saved revision',
              'External revision'
            )
          );
        }
        return result;
      }
    );

    await expect(
      writeNotebookArtifactSnapshot({
        pageId: 'page-first-save-race',
        title: 'First save race',
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'First saved revision' }] },
          ],
        },
        workspaceRoot: '/lab',
        expectedProjectionContent: { type: 'doc', content: [] },
      })
    ).rejects.toMatchObject({ code: 'NOTEBOOK_EXTERNAL_CONFLICT' });

    expect(injected).toBe(true);
    expect(getMockFileContent(markdownPath)).toContain('External revision');
    expect(getMockFileContent(markdownPath)).not.toContain('First saved revision');
  });

  it('propagates the exact logical mutation token through notebook filesystem writes', async () => {
    const mkdir = vi.spyOn(platform().fs, 'mkdir');
    const writeTextFile = vi.spyOn(platform().fs, 'writeTextFile');
    const atomicWrite = vi.spyOn(platform().fs, 'writeWorkspaceTextFileAtomic');
    const mutationToken = 'workspace-mutation-token';

    await createNotebookArtifactFile({
      entityId: 'page-token',
      pageId: 'page-token',
      title: 'Token notebook',
      content: { type: 'doc', content: [] },
      workspaceRoot: '/lab',
      mutationToken,
    });

    expect(mkdir).toHaveBeenCalledWith('/lab/Token notebook', { recursive: true }, mutationToken);
    expect(atomicWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: '/lab',
        path: '/lab/Token notebook/Token notebook.md',
        mutationToken,
      })
    );
    expect(mkdir).toHaveBeenCalledWith('/lab/.waypoint', { recursive: true }, mutationToken);
    expect(mkdir).toHaveBeenCalledWith(
      '/lab/.waypoint/project-memory',
      { recursive: true },
      mutationToken
    );
    expect(writeTextFile).toHaveBeenCalledWith(
      '/lab/.waypoint/project-memory/manifest.json',
      expect.any(String),
      undefined,
      mutationToken
    );
    expect(writeTextFile).toHaveBeenCalledWith(
      '/lab/.waypoint/project-memory/events.jsonl',
      expect.any(String),
      undefined,
      mutationToken
    );
  });

  it('resolves a legacy .wpnote.json with an empty catalog and repairs the binding', async () => {
    const path = '/lab/recovered/Recovered.wpnote.json';
    setMockFileContent(
      path,
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'page-recovered',
        title: 'Recovered',
        content: { type: 'doc', content: [] },
      })
    );

    const resolved = await resolveArtifactFile({ path, workspaceRoot: '/lab' });

    const scopedId = scopedProjectionId(await resolveWorkspaceScope('/lab'), 'page-recovered');
    expect(scopedId).toMatch(/::page-recovered$/);
    expect(resolved.repaired).toBe(true);
    expect(resolved.entity).toMatchObject({
      id: scopedId,
      type: 'notebook',
      locator: `entity://page/${scopedId}`,
    });
    expect(await getCatalogFilesForEntity(scopedId)).toEqual([
      expect.objectContaining({
        path,
        relative_path: 'recovered/Recovered.wpnote.json',
        status: 'current',
      }),
    ]);
  });

  it('waits for workspace admission before creating and binding a design artifact', async () => {
    const entity = await registerCatalogEntity({
      id: 'design-admission',
      type: 'design',
      name: 'Leased Design',
      locator: 'entity://design/design-admission',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    let admit!: (token: string) => void;
    const admission = new Promise<string>((resolve) => {
      admit = resolve;
    });
    const begin = vi.spyOn(platform().fs, 'beginWorkspaceMutation').mockReturnValue(admission);
    const end = vi.spyOn(platform().fs, 'endWorkspaceMutation');
    const write = vi.spyOn(platform().fs, 'writeTextFile');
    const bind = vi.spyOn(platform().db, 'bindCatalogEntityFile');
    const creation = createDesignArtifactFile({
      entityId: entity.id,
      designId: entity.id,
      name: 'Leased Design',
      design: null,
      workspaceRoot: '/lab',
      fileName: 'Leased Design.wpdesign.json',
    });
    try {
      await vi.waitFor(() =>
        expect(begin.mock.calls.length + write.mock.calls.length).toBeGreaterThan(0)
      );
      expect(write).not.toHaveBeenCalled();
      expect(bind).not.toHaveBeenCalled();
    } finally {
      admit('design-creation-token');
    }
    await expect(creation).resolves.toMatchObject({ path: '/lab/Leased Design.wpdesign.json' });
    expect(write).toHaveBeenCalledWith(
      '/lab/Leased Design.wpdesign.json',
      expect.any(String),
      undefined,
      'design-creation-token'
    );
    expect(bind).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: entity.id, path: '/lab/Leased Design.wpdesign.json' }),
      'design-creation-token'
    );
    expect(end).toHaveBeenCalledWith('design-creation-token');
    expect(await getCatalogFilesForEntity(entity.id)).toEqual([
      expect.objectContaining({ path: '/lab/Leased Design.wpdesign.json', status: 'current' }),
    ]);
  });

  it('releases design creation access when the file write fails', async () => {
    const entity = await registerCatalogEntity({
      id: 'design-write-failure',
      type: 'design',
      name: 'Failed Design',
      locator: 'entity://design/design-write-failure',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    vi.spyOn(platform().fs, 'beginWorkspaceMutation').mockResolvedValue('failed-design-token');
    const end = vi.spyOn(platform().fs, 'endWorkspaceMutation');
    vi.spyOn(platform().fs, 'writeTextFile').mockRejectedValueOnce(
      new Error('design write failed')
    );
    await expect(
      createDesignArtifactFile({
        entityId: entity.id,
        designId: entity.id,
        name: 'Failed Design',
        design: null,
        workspaceRoot: '/lab',
      })
    ).rejects.toThrow('design write failed');
    expect(end).toHaveBeenCalledWith('failed-design-token');
    expect(await getCatalogFilesForEntity(entity.id)).toEqual([]);
  });

  it('repairs a moved native artifact without leaving duplicate current catalog bindings', async () => {
    await registerCatalogEntity({
      id: 'design-moved',
      type: 'design',
      name: 'Moved Design',
      locator: 'entity://design/design-moved',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    await createDesignArtifactFile({
      entityId: 'design-moved',
      designId: 'design-moved',
      name: 'Moved Design',
      design: null,
      workspaceRoot: '/lab',
      context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
    });

    await platform().fs.rename(
      '/lab/Moved Design.wpdesign.json',
      '/lab/subdir/Moved Design.wpdesign.json'
    );

    const resolved = await resolveArtifactFile({
      path: '/lab/subdir/Moved Design.wpdesign.json',
      workspaceRoot: '/lab',
      recordProjectMemoryRepair: true,
    });

    expect(resolved).toMatchObject({ repaired: true, entity: { id: 'design-moved' } });
    expect(await getCatalogFilesForEntity('design-moved')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/lab/Moved Design.wpdesign.json',
          status: 'historical',
        }),
        expect.objectContaining({
          path: '/lab/subdir/Moved Design.wpdesign.json',
          status: 'current',
        }),
      ])
    );
    const currentBindings = (await getCatalogFilesForEntity('design-moved')).filter(
      (file) => file.status === 'current'
    );
    expect(currentBindings).toHaveLength(1);

    const projectMemory = await readProjectMemory('/lab');
    expect(projectMemory.events.map((event) => event.eventType)).toEqual([
      'artifact_created',
      'file_binding_repaired',
    ]);
    expect(projectMemory.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'Moved Design.wpdesign.json', status: 'historical' }),
        expect.objectContaining({
          path: 'subdir/Moved Design.wpdesign.json',
          status: 'current',
        }),
      ])
    );
  });

  it('plans native artifact binding repairs without mutating catalog or Project Memory', async () => {
    await registerCatalogEntity({
      id: 'design-plan-repair',
      type: 'design',
      name: 'Plan Repair',
      locator: 'entity://design/design-plan-repair',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    await createDesignArtifactFile({
      entityId: 'design-plan-repair',
      designId: 'design-plan-repair',
      name: 'Plan Repair',
      design: null,
      workspaceRoot: '/lab',
      context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
    });

    await platform().fs.rename(
      '/lab/Plan Repair.wpdesign.json',
      '/lab/subdir/Plan Repair.wpdesign.json'
    );

    const plan = await planWorkspaceArtifactRepair({
      path: '/lab/subdir/Plan Repair.wpdesign.json',
      workspaceRoot: '/lab',
    });

    expect(plan).toMatchObject({
      kind: 'file-binding-repair',
      entityId: 'design-plan-repair',
      beforePath: '/lab/Plan Repair.wpdesign.json',
      afterPath: '/lab/subdir/Plan Repair.wpdesign.json',
      confidence: 'confirmed',
    });
    expect(await getCatalogFilesForEntity('design-plan-repair')).toEqual([
      expect.objectContaining({
        path: '/lab/Plan Repair.wpdesign.json',
        status: 'current',
      }),
    ]);
    await expect(readProjectMemory('/lab')).resolves.toMatchObject({
      events: [expect.objectContaining({ eventType: 'artifact_created' })],
      files: [
        expect.objectContaining({
          path: 'Plan Repair.wpdesign.json',
          status: 'current',
        }),
      ],
    });
  });

  it('applies accepted native artifact binding repairs and records Project Memory history', async () => {
    await registerCatalogEntity({
      id: 'design-apply-repair',
      type: 'design',
      name: 'Apply Repair',
      locator: 'entity://design/design-apply-repair',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    await createDesignArtifactFile({
      entityId: 'design-apply-repair',
      designId: 'design-apply-repair',
      name: 'Apply Repair',
      design: null,
      workspaceRoot: '/lab',
      context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
    });
    await platform().fs.rename(
      '/lab/Apply Repair.wpdesign.json',
      '/lab/subdir/Apply Repair.wpdesign.json'
    );

    const plan = await planWorkspaceArtifactRepair({
      path: '/lab/subdir/Apply Repair.wpdesign.json',
      workspaceRoot: '/lab',
    });
    const resolved = await applyAcceptedWorkspaceArtifactRepair(plan);

    expect(resolved).toMatchObject({ repaired: true, entity: { id: 'design-apply-repair' } });
    expect(await getCatalogFilesForEntity('design-apply-repair')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/lab/Apply Repair.wpdesign.json',
          status: 'historical',
        }),
        expect.objectContaining({
          path: '/lab/subdir/Apply Repair.wpdesign.json',
          status: 'current',
        }),
      ])
    );
    const currentBindings = (await getCatalogFilesForEntity('design-apply-repair')).filter(
      (file) => file.status === 'current'
    );
    expect(currentBindings).toHaveLength(1);
    await expect(readProjectMemory('/lab')).resolves.toMatchObject({
      events: [
        expect.objectContaining({ eventType: 'artifact_created' }),
        expect.objectContaining({ eventType: 'file_binding_repaired' }),
      ],
      files: [
        expect.objectContaining({ path: 'Apply Repair.wpdesign.json', status: 'historical' }),
        expect.objectContaining({
          path: 'subdir/Apply Repair.wpdesign.json',
          status: 'current',
        }),
      ],
    });
  });

  it('plans native artifact catalog recovery without mutating catalog or Project Memory', async () => {
    const path = '/lab/recovered/Recovered Design.wpdesign.json';
    setMockFileContent(
      path,
      JSON.stringify({
        schema: 'waypoint.design.v1',
        kind: 'assembly-design',
        id: 'design-recovered-plan',
        name: 'Recovered Design',
        design: null,
      })
    );

    const plan = await planWorkspaceArtifactRepair({ path, workspaceRoot: '/lab' });

    expect(plan).toMatchObject({
      kind: 'catalog-recovery',
      entityId: 'design-recovered-plan',
      afterPath: path,
      confidence: 'confirmed',
    });
    expect(await getCatalogEntity('design-recovered-plan')).toBeNull();
    expect(await getCatalogFilesForEntity('design-recovered-plan')).toEqual([]);
    await expect(readProjectMemory('/lab')).resolves.toMatchObject({
      events: [],
      files: [],
    });
  });

  it('rejects accepted repairs when a path is bound to a different catalog entity', async () => {
    const path = '/lab/conflict/Conflicting.wpdesign.json';
    await registerCatalogEntity({
      id: 'design-conflict-file',
      type: 'design',
      name: 'Conflicting',
      locator: 'entity://design/design-conflict-file',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    await registerCatalogEntity({
      id: 'design-existing-path-owner',
      type: 'design',
      name: 'Existing Path Owner',
      locator: 'entity://design/design-existing-path-owner',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    setMockFileContent(
      path,
      JSON.stringify({
        schema: 'waypoint.design.v1',
        kind: 'assembly-design',
        id: 'design-conflict-file',
        name: 'Conflicting',
        design: null,
      })
    );
    await bindCatalogEntityToFile({
      entityId: 'design-existing-path-owner',
      path,
      fileKind: 'waypoint-design',
      workspaceRoot: '/lab',
    });

    const plan = await planWorkspaceArtifactRepair({ path, workspaceRoot: '/lab' });

    expect(plan).toMatchObject({
      kind: 'conflict',
      entityId: 'design-conflict-file',
      conflictingEntityId: 'design-existing-path-owner',
      reason: 'path-bound-to-different-entity',
    });
    await expect(applyAcceptedWorkspaceArtifactRepair(plan)).rejects.toThrow(
      /Cannot apply conflicting artifact repair/
    );
  });

  it('mirrors notebook and design snapshots to current artifact files', async () => {
    await registerCatalogEntity({
      id: 'page-snapshot',
      type: 'notebook',
      name: 'Snapshot',
      locator: 'entity://page/page-snapshot',
      storageType: 'database',
      workspaceRoot: '/lab',
    });
    await createNotebookArtifactFile({
      entityId: 'page-snapshot',
      pageId: 'page-snapshot',
      title: 'Snapshot',
      workspaceRoot: '/lab',
      context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
    });

    await writeNotebookArtifactSnapshot({
      pageId: 'page-snapshot',
      title: 'Snapshot Updated',
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });

    const notebookDoc = JSON.parse(
      getMockFileContent('/lab/Snapshot/.forge/notebook.json') ?? '{}'
    );
    expect(notebookDoc).toMatchObject({
      id: 'page-snapshot',
      title: 'Snapshot Updated',
      provenance: [
        expect.objectContaining({
          event: 'created',
          source: 'file-explorer-new-menu',
        }),
      ],
    });
    expect(getMockFileContent('/lab/Snapshot/Snapshot.md')).toBeTruthy();

    await registerCatalogEntity({
      id: 'design-snapshot',
      type: 'design',
      name: 'Design Snapshot',
      locator: 'entity://design/design-snapshot',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    await createDesignArtifactFile({
      entityId: 'design-snapshot',
      designId: 'design-snapshot',
      name: 'Design Snapshot',
      design: null,
      workspaceRoot: '/lab',
      context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
    });

    const beginMutation = vi.spyOn(platform().fs, 'beginWorkspaceMutation');
    const endMutation = vi.spyOn(platform().fs, 'endWorkspaceMutation');
    const atomicWrite = vi.spyOn(platform().fs, 'writeWorkspaceTextFileAtomic');
    await writeDesignArtifactSnapshot({
      designId: 'design-snapshot',
      name: 'Design Snapshot Updated',
      design: null,
    });

    const designDoc = JSON.parse(getMockFileContent('/lab/Design Snapshot.wpdesign.json') ?? '{}');
    expect(designDoc).toMatchObject({
      id: 'design-snapshot',
      name: 'Design Snapshot Updated',
      provenance: [
        expect.objectContaining({
          event: 'created',
          source: 'file-explorer-new-menu',
        }),
      ],
    });
    expect(beginMutation).toHaveBeenCalledWith('/lab', undefined);
    expect(atomicWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/lab/Design Snapshot.wpdesign.json',
        mutationToken: 'browser-workspace-mutation',
        mode: 'replace',
        expectedContentHash: expect.any(String),
      })
    );
    expect(endMutation).toHaveBeenCalledWith('browser-workspace-mutation');
  });

  it('refuses to demote an external flat-notebook edit behind a stale renderer save', async () => {
    const legacyPath = '/lab/External Winner.wpnote.json';
    const externalContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'external winner' }] }],
    };
    const staleContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'stale renderer' }] }],
    };
    setMockFileContent(
      legacyPath,
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'page-external-winner',
        title: 'External Winner',
        content: externalContent,
      })
    );
    await registerCatalogEntity({
      id: 'page-external-winner',
      type: 'notebook',
      name: 'External Winner',
      locator: 'entity://page/page-external-winner',
      storageType: 'database',
      workspaceRoot: '/lab',
    });
    await bindCatalogEntityToFile({
      entityId: 'page-external-winner',
      path: legacyPath,
      fileKind: 'waypoint-notebook',
      workspaceRoot: '/lab',
    });

    await expect(
      writeNotebookArtifactSnapshot({
        pageId: 'page-external-winner',
        title: 'External Winner',
        content: staleContent,
        expectedProjectionContent: staleContent,
      })
    ).rejects.toMatchObject({ code: 'NOTEBOOK_EXTERNAL_CONFLICT' });

    expect(JSON.parse(getMockFileContent(legacyPath) ?? '{}').content).toEqual(externalContent);
    expect(getMockFileContent(`${legacyPath}.legacy`)).toBeNull();
    expect(getMockFileContent('/lab/External Winner/.forge/notebook.json')).toBeNull();
  });

  it('keeps the flat authority visible when v2 publication fails before cutover', async () => {
    const legacyPath = '/lab/Publish Failure.wpnote.json';
    const packagePath = '/lab/Publish Failure';
    const content = { type: 'doc', content: [{ type: 'paragraph' }] };
    setMockFileContent(
      legacyPath,
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'page-publish-failure',
        title: 'Publish Failure',
        content,
      })
    );
    await registerCatalogEntity({
      id: 'page-publish-failure',
      type: 'notebook',
      name: 'Publish Failure',
      locator: 'entity://page/page-publish-failure',
      storageType: 'database',
      workspaceRoot: '/lab',
    });
    await bindCatalogEntityToFile({
      entityId: 'page-publish-failure',
      path: legacyPath,
      fileKind: 'waypoint-notebook',
      workspaceRoot: '/lab',
    });
    const mkdir = platform().fs.mkdir.bind(platform().fs);
    vi.spyOn(platform().fs, 'mkdir').mockImplementation(async (path, options, mutationToken) => {
      if (path.startsWith(packagePath)) throw new Error('injected publication failure');
      await mkdir(path, options, mutationToken);
    });

    await expect(
      writeNotebookArtifactSnapshot({
        pageId: 'page-publish-failure',
        title: 'Publish Failure',
        content,
        expectedProjectionContent: content,
      })
    ).rejects.toThrow('injected publication failure');

    expect(getMockFileContent(legacyPath)).toBeTruthy();
    expect(getMockFileContent(`${legacyPath}.legacy`)).toBeNull();
  });

  it('detects an external flat-file edit between migration read and cutover', async () => {
    const pageId = scopedProjectionId(await resolveWorkspaceScope('/lab'), 'page-cutover-race');
    const legacyPath = '/lab/Cutover Race.wpnote.json';
    const originalContent = { type: 'doc', content: [{ type: 'paragraph' }] };
    const externalContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'race winner' }] }],
    };
    const document = {
      schema: 'waypoint.notebook.v1',
      kind: 'notebook',
      id: 'page-cutover-race',
      title: 'Cutover Race',
      content: originalContent,
    };
    setMockFileContent(legacyPath, JSON.stringify(document));
    await registerCatalogEntity({
      id: pageId,
      type: 'notebook',
      name: 'Cutover Race',
      locator: `entity://page/${pageId}`,
      storageType: 'database',
      workspaceRoot: '/lab',
    });
    await bindCatalogEntityToFile({
      entityId: pageId,
      path: legacyPath,
      fileKind: 'waypoint-notebook',
      workspaceRoot: '/lab',
    });
    const atomicWrite = platform().fs.writeWorkspaceTextFileAtomic.bind(platform().fs);
    vi.spyOn(platform().fs, 'writeWorkspaceTextFileAtomic').mockImplementation(async (input) => {
      if (input.path === legacyPath) {
        setMockFileContent(legacyPath, JSON.stringify({ ...document, content: externalContent }));
      }
      return atomicWrite(input);
    });

    await expect(
      writeNotebookArtifactSnapshot({
        pageId,
        title: 'Cutover Race',
        content: originalContent,
        expectedProjectionContent: originalContent,
      })
    ).rejects.toMatchObject({ code: 'NOTEBOOK_EXTERNAL_CONFLICT' });

    expect(JSON.parse(getMockFileContent(legacyPath) ?? '{}').content).toEqual(externalContent);
    expect(getMockFileContent(`${legacyPath}.legacy`)).toBeNull();
    expect(await getCatalogFilesForEntity(pageId)).toEqual([
      expect.objectContaining({ path: legacyPath, status: 'current' }),
    ]);

    const retried = await writeNotebookArtifactSnapshot({
      pageId,
      title: 'Cutover Race',
      content: externalContent,
      expectedProjectionContent: externalContent,
    });
    expect(retried?.path).toBe('/lab/Cutover Race');
    const resolved = await resolveArtifactFile({
      path: '/lab/Cutover Race',
      workspaceRoot: '/lab',
    });
    expect(resolved.artifact.content).toEqual(externalContent);
    expect(getMockFileContent(legacyPath)).toBeNull();
    expect(JSON.parse(getMockFileContent(`${legacyPath}.legacy`) ?? '{}').content).toEqual(
      externalContent
    );
  });

  it('migrates a legacy notebook snapshot by moving its catalog binding in place', async () => {
    const legacyPath = '/lab/Legacy Snapshot.wpnote.json';
    const packagePath = '/lab/Legacy Snapshot';
    const renameFile = platform().fs.rename.bind(platform().fs);
    vi.spyOn(platform().fs, 'rename').mockImplementation(
      async (oldPath, newPath, mutationToken) => {
        if (oldPath === legacyPath && newPath === `${legacyPath}.legacy`) {
          expect(mutationToken).toBe('legacy-migration-token');
          expect(await getCatalogFilesForEntity('page-legacy-snapshot')).toEqual([
            expect.objectContaining({ path: legacyPath }),
          ]);
        }
        await renameFile(oldPath, newPath, mutationToken);
      }
    );
    setMockFileContent(
      legacyPath,
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'page-legacy-snapshot',
        title: 'Legacy Snapshot',
        content: { type: 'doc', content: [] },
        provenance: [
          {
            event: 'created',
            source: 'legacy-notebook-fixture',
          },
        ],
      })
    );
    await registerCatalogEntity({
      id: 'page-legacy-snapshot',
      type: 'notebook',
      name: 'Legacy Snapshot',
      locator: 'entity://page/page-legacy-snapshot',
      storageType: 'database',
      workspaceRoot: '/lab',
    });
    const originalBinding = await bindCatalogEntityToFile({
      entityId: 'page-legacy-snapshot',
      path: legacyPath,
      fileKind: 'waypoint-notebook',
      workspaceRoot: '/lab',
    });

    await writeNotebookArtifactSnapshot({
      pageId: 'page-legacy-snapshot',
      title: 'Legacy Snapshot Updated',
      mutationToken: 'legacy-migration-token',
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });

    expect(getMockFileContent(`${legacyPath}.legacy`)).toBeTruthy();
    expect(
      JSON.parse(getMockFileContent(`${packagePath}/.forge/notebook.json`) ?? '{}')
    ).toMatchObject({
      id: 'page-legacy-snapshot',
      title: 'Legacy Snapshot Updated',
      provenance: [
        expect.objectContaining({
          event: 'created',
          source: 'legacy-notebook-fixture',
        }),
      ],
    });
    expect(await getCatalogFilesForEntity('page-legacy-snapshot')).toEqual([
      expect.objectContaining({
        id: originalBinding.id,
        object_uuid: originalBinding.object_uuid,
        path: packagePath,
        status: 'current',
        file_kind: 'waypoint-notebook',
      }),
    ]);
    expect(await getCatalogEventsForEntity('page-legacy-snapshot')).toContainEqual(
      expect.objectContaining({
        event_type: 'path_moved',
      })
    );

    await rebindCatalogFilePath({
      oldPath: packagePath,
      newPath: legacyPath,
      workspaceRoot: '/lab',
      actor: 'test-interrupted-legacy-migration',
    });
    const retried = await writeNotebookArtifactSnapshot({
      pageId: 'page-legacy-snapshot',
      title: 'Legacy Snapshot Updated',
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    expect(retried?.path).toBe(packagePath);
    expect(getMockFileContent('/lab/Legacy Snapshot 2/.forge/notebook.json')).toBeNull();
    expect(await getCatalogFilesForEntity('page-legacy-snapshot')).toEqual([
      expect.objectContaining({
        id: originalBinding.id,
        object_uuid: originalBinding.object_uuid,
        path: packagePath,
        status: 'current',
      }),
    ]);
  });

  it('renames a file-backed design artifact and preserves the design identity', async () => {
    await registerCatalogEntity({
      id: 'design-rename',
      type: 'design',
      name: 'Old Design',
      locator: 'entity://design/design-rename',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    await createDesignArtifactFile({
      entityId: 'design-rename',
      designId: 'design-rename',
      name: 'Old Design',
      design: null,
      workspaceRoot: '/lab',
      context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
    });

    const renamed = await renameDesignArtifactFile({
      designId: 'design-rename',
      name: 'Renamed Design',
    });

    expect(renamed).toMatchObject({
      path: '/lab/Renamed Design.wpdesign.json',
      name: 'Renamed Design.wpdesign.json',
      fileKind: 'waypoint-design',
    });
    expect(getMockFileContent('/lab/Old Design.wpdesign.json')).toBeNull();
    const designDoc = JSON.parse(getMockFileContent('/lab/Renamed Design.wpdesign.json') ?? '{}');
    expect(designDoc).toMatchObject({
      id: 'design-rename',
      name: 'Old Design',
    });
    expect(await getCatalogEntity('design-rename')).toMatchObject({
      id: 'design-rename',
      name: 'Renamed Design',
    });
    expect(await getCatalogFilesForEntity('design-rename')).toEqual([
      expect.objectContaining({
        path: '/lab/Renamed Design.wpdesign.json',
        relative_path: 'Renamed Design.wpdesign.json',
        file_kind: 'waypoint-design',
      }),
    ]);
    expect(await getCatalogEventsForEntity('design-rename')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: 'path_moved' }),
        expect.objectContaining({ event_type: 'artifact_renamed' }),
      ])
    );
    const projectMemory = await readProjectMemory('/lab');
    expect(projectMemory.events.map((event) => event.eventType)).toEqual([
      'artifact_created',
      'artifact_renamed',
    ]);
    expect(projectMemory.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'Old Design.wpdesign.json', status: 'historical' }),
        expect.objectContaining({ path: 'Renamed Design.wpdesign.json', status: 'current' }),
      ])
    );
  });

  it('holds one logical workspace mutation token through the complete artifact rename', async () => {
    await registerCatalogEntity({
      id: 'design-rename-token',
      type: 'design',
      name: 'Token Before',
      locator: 'entity://design/design-rename-token',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    await createDesignArtifactFile({
      entityId: 'design-rename-token',
      designId: 'design-rename-token',
      name: 'Token Before',
      design: null,
      workspaceRoot: '/lab',
      context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
    });

    const begin = vi
      .spyOn(platform().fs, 'beginWorkspaceMutation')
      .mockImplementation(async (_workspaceRoot, parentToken) =>
        parentToken ? 'artifact-snapshot-reentry-token' : 'artifact-rename-token'
      );
    const end = vi.spyOn(platform().fs, 'endWorkspaceMutation');
    const atomicWrite = vi.spyOn(platform().fs, 'writeWorkspaceTextFileAtomic');
    const relocate = vi.mocked(platform().workspace.relocateEntityFile);
    const mkdir = vi.spyOn(platform().fs, 'mkdir');
    const writeTextFile = vi.spyOn(platform().fs, 'writeTextFile');
    relocate.mockClear();
    mkdir.mockClear();
    writeTextFile.mockClear();

    await renameDesignArtifactFile({
      designId: 'design-rename-token',
      name: 'Token After',
    });

    expect(begin).toHaveBeenCalledTimes(1);
    expect(begin).toHaveBeenCalledWith('/lab', undefined);
    expect(relocate).toHaveBeenCalledWith(
      expect.objectContaining({
        oldPath: '/lab/Token Before.wpdesign.json',
        newPath: '/lab/Token After.wpdesign.json',
        mutationToken: 'artifact-rename-token',
      })
    );
    expect(mkdir).toHaveBeenCalledWith(
      '/lab/.waypoint',
      { recursive: true },
      'artifact-rename-token'
    );
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith('artifact-rename-token');
  });

  it('renames a file-backed notebook artifact and preserves page identity', async () => {
    await registerCatalogEntity({
      id: 'page-rename',
      type: 'notebook',
      name: 'Old Notebook',
      locator: 'entity://page/page-rename',
      storageType: 'database',
      workspaceRoot: '/lab',
    });
    await createNotebookArtifactFile({
      entityId: 'page-rename',
      pageId: 'page-rename',
      title: 'Old Notebook',
      workspaceRoot: '/lab',
      context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
    });

    const renamed = await renameNotebookArtifactFile({
      pageId: 'page-rename',
      title: 'Renamed Notebook',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
    });

    expect(renamed).toMatchObject({
      path: '/lab/Renamed Notebook',
      name: 'Renamed Notebook',
      fileKind: 'waypoint-notebook',
    });
    expect(getMockFileContent('/lab/Old Notebook/.forge/notebook.json')).toBeNull();
    expect(getMockFileContent('/lab/Old Notebook/Old Notebook.md')).toBeNull();
    const notebookDoc = JSON.parse(
      getMockFileContent('/lab/Renamed Notebook/.forge/notebook.json') ?? '{}'
    );
    expect(notebookDoc).toMatchObject({
      id: 'page-rename',
      title: 'Renamed Notebook',
    });
    expect(getMockFileContent('/lab/Renamed Notebook/Renamed Notebook.md')).toBeTruthy();
    expect(getMockFileContent('/lab/Renamed Notebook/.forge/notebook-rename.json')).toContain(
      '"state": "complete"'
    );
    expect(await getCatalogEntity('page-rename')).toMatchObject({
      id: 'page-rename',
      name: 'Renamed Notebook',
    });
    expect(await platform().lims.queryEntities({ id: 'page-rename' })).toEqual([
      expect.objectContaining({
        id: 'page-rename',
        name: 'Renamed Notebook',
        fields: { packagePath: '/lab/Renamed Notebook' },
      }),
    ]);
    expect(await getCatalogFilesForEntity('page-rename')).toEqual([
      expect.objectContaining({
        path: '/lab/Renamed Notebook',
        relative_path: 'Renamed Notebook',
        file_kind: 'waypoint-notebook',
      }),
    ]);
    expect(await getCatalogEventsForEntity('page-rename')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: 'path_moved' }),
        expect.objectContaining({ event_type: 'artifact_renamed' }),
      ])
    );
    const projectMemory = await readProjectMemory('/lab');
    expect(projectMemory.events.map((event) => event.eventType)).toEqual([
      'artifact_created',
      'artifact_renamed',
    ]);
    expect(projectMemory.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'Old Notebook', status: 'historical' }),
        expect.objectContaining({ path: 'Renamed Notebook', status: 'current' }),
      ])
    );
  });

  it.each(['metadata', 'markdown'] as const)(
    'rechecks v2 notebook %s before reusing a binding snapshot',
    async (part) => {
      const rawId = 'binding-snapshot';
      const entityId = scopedProjectionId(await resolveWorkspaceScope('/lab'), rawId);
      await createNotebookArtifactFile({
        entityId,
        pageId: rawId,
        title: 'Snapshot',
        content: { type: 'doc', content: [] },
        workspaceRoot: '/lab',
        context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
      });
      const snapshot = await resolveArtifactFile({ path: '/lab/Snapshot', workspaceRoot: '/lab' });
      expect(snapshot.sourceFingerprints).toEqual([
        {
          path: '/lab/Snapshot/.forge/notebook.json',
          fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
        {
          path: '/lab/Snapshot/Snapshot.md',
          fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
      ]);
      expect(await workspaceArtifactSourcesMatch(snapshot.sourceFingerprints)).toBe(true);
      const source = snapshot.sourceFingerprints[part === 'metadata' ? 0 : 1];
      setMockFileContent(source.path, `${getMockFileContent(source.path)}\n`);
      expect(await workspaceArtifactSourcesMatch(snapshot.sourceFingerprints)).toBe(false);
      expect(await workspaceArtifactSourcesMatch([])).toBe(false);
    }
  );

  it('refuses a notebook rename when Markdown changed before rename preparation', async () => {
    const originalContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'original' }] }],
    };
    const externalContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'external winner' }] }],
    };
    await registerCatalogEntity({
      id: 'page-rename-before-prepare',
      type: 'notebook',
      name: 'Old Notebook',
      locator: 'entity://page/page-rename-before-prepare',
      storageType: 'database',
      workspaceRoot: '/lab',
    });
    await createNotebookArtifactFile({
      entityId: 'page-rename-before-prepare',
      pageId: 'page-rename-before-prepare',
      title: 'Old Notebook',
      content: originalContent,
      workspaceRoot: '/lab',
      context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
    });
    const external = serializeNotebookMarkdown({
      identity: {
        id: 'page-rename-before-prepare',
        title: 'Old Notebook',
        formatVersion: 2,
      },
      content: externalContent,
    });
    for (const payload of external.payloads) {
      setMockFileContent(`/lab/Old Notebook/${payload.relativePath}`, payload.content);
    }
    setMockFileContent('/lab/Old Notebook/Old Notebook.md', external.markdown);

    await expect(
      renameNotebookArtifactFile({
        pageId: 'page-rename-before-prepare',
        title: 'Renamed Notebook',
        content: originalContent,
      })
    ).rejects.toMatchObject({ code: 'NOTEBOOK_EXTERNAL_CONFLICT' });

    expect(getMockFileContent('/lab/Old Notebook/Old Notebook.md')).toBe(external.markdown);
    expect(getMockFileContent('/lab/Renamed Notebook/.forge/notebook.json')).toBeNull();
  });

  it('preserves an external Markdown edit that arrives after rename preparation', async () => {
    const originalContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'original' }] }],
    };
    const externalContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'external winner' }] }],
    };
    await registerCatalogEntity({
      id: 'page-rename-after-prepare',
      type: 'notebook',
      name: 'Old Notebook',
      locator: 'entity://page/page-rename-after-prepare',
      storageType: 'database',
      workspaceRoot: '/lab',
    });
    await createNotebookArtifactFile({
      entityId: 'page-rename-after-prepare',
      pageId: 'page-rename-after-prepare',
      title: 'Old Notebook',
      content: originalContent,
      workspaceRoot: '/lab',
      context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
    });
    const external = serializeNotebookMarkdown({
      identity: {
        id: 'page-rename-after-prepare',
        title: 'Old Notebook',
        formatVersion: 2,
      },
      content: externalContent,
    });
    vi.mocked(platform().workspace.relocateEntityFile).mockImplementationOnce(
      async ({ oldPath, newPath, workspaceRoot, mutationToken }) => {
        for (const payload of external.payloads) {
          setMockFileContent(`${oldPath}/${payload.relativePath}`, payload.content);
        }
        setMockFileContent(`${oldPath}/Old Notebook.md`, external.markdown);
        await platform().fs.rename(oldPath, newPath, mutationToken);
        await rebindCatalogFilePath({ oldPath, newPath, workspaceRoot });
        return {
          newPath,
          counts: {
            catalog: { updated: 1 },
            indexed: {
              indexedFilesMoved: 0,
              staleIndexedFilesMerged: 0,
              primerBindingsRepointed: 0,
            },
            lims: { rebasedEntityIds: [], workspaceIds: [] },
          },
        };
      }
    );

    await expect(
      renameNotebookArtifactFile({
        pageId: 'page-rename-after-prepare',
        title: 'Renamed Notebook',
        content: originalContent,
      })
    ).rejects.toMatchObject({ code: 'NOTEBOOK_EXTERNAL_CONFLICT' });

    const renamedMarkdown = getMockFileContent('/lab/Renamed Notebook/Renamed Notebook.md');
    expect(renamedMarkdown).toContain('external winner');
    expect(renamedMarkdown).not.toContain('original');
    expect(getMockFileContent('/lab/Old Notebook/Old Notebook.md')).toBeNull();
  });

  it('records Project Memory path history when a native artifact is renamed from the file tree', async () => {
    const mkdir = vi.spyOn(platform().fs, 'mkdir');
    await registerCatalogEntity({
      id: 'design-tree-rename',
      type: 'design',
      name: 'Tree Rename',
      locator: 'entity://design/design-tree-rename',
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    await createDesignArtifactFile({
      entityId: 'design-tree-rename',
      designId: 'design-tree-rename',
      name: 'Tree Rename',
      design: null,
      workspaceRoot: '/lab',
      context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
    });

    await platform().fs.rename(
      '/lab/Tree Rename.wpdesign.json',
      '/lab/Renamed In Tree.wpdesign.json'
    );
    await rebindCatalogFilePath({
      oldPath: '/lab/Tree Rename.wpdesign.json',
      newPath: '/lab/Renamed In Tree.wpdesign.json',
      workspaceRoot: '/lab',
    });
    await recordWorkspaceArtifactFileRenameInProjectMemory({
      oldPath: '/lab/Tree Rename.wpdesign.json',
      newPath: '/lab/Renamed In Tree.wpdesign.json',
      workspaceRoot: '/lab',
      mutationToken: 'file-tree-rename-token',
    });

    expect(mkdir).toHaveBeenCalledWith(
      '/lab/.waypoint',
      { recursive: true },
      'file-tree-rename-token'
    );

    const projectMemory = await readProjectMemory('/lab');
    expect(projectMemory.events.map((event) => event.eventType)).toEqual([
      'artifact_created',
      'artifact_renamed',
    ]);
    expect(projectMemory.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'Tree Rename.wpdesign.json', status: 'historical' }),
        expect.objectContaining({ path: 'Renamed In Tree.wpdesign.json', status: 'current' }),
      ])
    );
  });
});

describe('assembly publication reconciliation', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
  });
  afterEach(() => vi.restoreAllMocks());

  async function draft() {
    const design = {
      id: 'publication-draft',
      name: 'A',
    } as import('../features/design/types').SequenceDesign;
    await registerCatalogEntity({
      id: design.id,
      type: 'design',
      name: design.name,
      locator: `entity://design/${design.id}`,
      storageType: 'localStorage',
      workspaceRoot: '/lab',
    });
    const artifact = await createDesignArtifactFile({
      entityId: design.id,
      designId: design.id,
      name: design.name,
      design,
      workspaceRoot: '/lab',
      context: { targetPath: '/lab', targetKind: 'folder', parentPath: '/lab' },
    });
    return { design, path: artifact.path };
  }

  it('confirms creation without clearing a newer edit made while the first file was written', async () => {
    const recovery = await import('../features/design/design-recovery');
    const design = {
      id: 'publication-draft',
      name: 'A',
    } as import('../features/design/types').SequenceDesign;
    recovery.useDesignRecoveryStore.setState({ records: {} });
    recovery.captureDesignRecovery(design);
    const write = platform().fs.writeTextFile.bind(platform().fs);
    vi.spyOn(platform().fs, 'writeTextFile').mockImplementation(async (...args) => {
      if (args[0].endsWith('/A.wpdesign.json')) {
        recovery.captureDesignRecovery({ ...design, name: 'B' }, design);
      }
      return write(...args);
    });
    const { path } = await draft();
    expect(JSON.parse(getMockFileContent(path)!).design.name).toBe('A');
    expect(recovery.useDesignRecoveryStore.getState().records[design.id]).toMatchObject({
      design: { name: 'B' },
      base: recovery.designContentIdentity(design),
      pending: true,
    });
    recovery.useDesignRecoveryStore.setState({ records: {} });
  });

  it('finishes bookkeeping without replaying bytes when a previous attempt already reached disk', async () => {
    const { design, path } = await draft();
    const { designContentIdentity } = await import('../features/design/design-recovery');
    const next = { ...design, name: 'B' };
    const write = platform().fs.writeWorkspaceTextFileAtomic.bind(platform().fs);
    const atomic = vi
      .spyOn(platform().fs, 'writeWorkspaceTextFileAtomic')
      .mockImplementationOnce(async (input) => {
        await write(input);
        throw new Error('lost reply after atomic commit');
      });
    const beforeWrite = vi.fn();
    const input = {
      designId: design.id,
      name: next.name,
      design: next,
      recovery: {
        base: designContentIdentity(design),
        attempted: designContentIdentity(next),
        beforeWrite,
      },
    };
    await expect(writeDesignArtifactSnapshot(input)).rejects.toThrow('lost reply');
    expect(JSON.parse(getMockFileContent(path)!).design.name).toBe('B');
    await expect(writeDesignArtifactSnapshot(input)).resolves.toMatchObject({ path });
    expect(atomic).toHaveBeenCalledTimes(1);
    expect(beforeWrite).toHaveBeenCalledTimes(1);
  });

  it('refuses independent external edits and preserves their bytes', async () => {
    const { design, path } = await draft();
    const { designContentIdentity } = await import('../features/design/design-recovery');
    const external = {
      ...JSON.parse(getMockFileContent(path)!),
      design: { ...design, name: 'External' },
    };
    setMockFileContent(path, JSON.stringify(external));
    const atomic = vi.spyOn(platform().fs, 'writeWorkspaceTextFileAtomic');
    await expect(
      writeDesignArtifactSnapshot({
        designId: design.id,
        name: 'Local',
        design: { ...design, name: 'Local' },
        recovery: { base: designContentIdentity(design), beforeWrite: vi.fn() },
      })
    ).rejects.toThrow('changed elsewhere');
    expect(atomic).not.toHaveBeenCalled();
    expect(JSON.parse(getMockFileContent(path)!).design.name).toBe('External');
  });

  it('does not recreate a missing file or publish an unbound draft', async () => {
    const { design } = await draft();
    const { designContentIdentity } = await import('../features/design/design-recovery');
    const input = {
      designId: design.id,
      name: 'Local',
      design: { ...design, name: 'Local' },
      recovery: { base: designContentIdentity(design), beforeWrite: vi.fn() },
    };
    const atomic = vi.spyOn(platform().fs, 'writeWorkspaceTextFileAtomic');
    vi.spyOn(platform().fs, 'readTextFile').mockRejectedValueOnce(
      new Error('ENOENT: no such file or directory')
    );
    await expect(writeDesignArtifactSnapshot(input)).rejects.toThrow('ENOENT');
    expect(atomic).not.toHaveBeenCalled();
    await expect(
      writeDesignArtifactSnapshot({ ...input, designId: 'unbound' })
    ).resolves.toBeNull();
  });

  it('refuses to publish a draft whose binding is no longer an assembly file', async () => {
    const { design, path } = await draft();
    await bindCatalogEntityToFile({
      entityId: design.id,
      path,
      fileKind: 'genbank',
      workspaceRoot: '/lab',
    });
    const { designContentIdentity, DesignArtifactRetiredError } =
      await import('../features/design/design-recovery');
    await expect(
      writeDesignArtifactSnapshot({
        designId: design.id,
        name: 'Local',
        design: { ...design, name: 'Local' },
        recovery: { base: designContentIdentity(design), beforeWrite: vi.fn() },
      })
    ).rejects.toBeInstanceOf(DesignArtifactRetiredError);
  });
});
