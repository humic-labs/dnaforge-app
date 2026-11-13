import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMockData,
  getMockData,
  MockFsModule,
  setFileTree,
  setMockFileContent,
} from '../test/platform-mocks';
import { initializeTestSchema } from '../test/initializeTestSchema';
import { expectNoProjectMemoryFilesWritten } from '../test/project-memory-guards';
import {
  bindCatalogEntityToFile,
  getCatalogEntity,
  getCatalogEntityForFilePath,
  getCatalogEventsForEntity,
  getCatalogFileForPath,
  getCatalogLinksForEntity,
  getCatalogWorkspacePlacement,
  registerCatalogEntity,
  resolveWorkspaceScope,
  updateCatalogEntityName,
} from '../db/workspace-catalog';
import { scopedProjectionId } from '../shared/workspace-scoped-identity';
import { reconcileWorkspaceRoot } from './workspace-reconcile';
import { reconcileNativeWorkspaceManifest } from './native-workspace-manifest-reconcile';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { platform } from '../platform';
import { createFileTestDb } from '../main/__tests__/test-db';
import { ensureSchema } from '../main/schema';
import {
  bindCatalogEntityFileInDb,
  catalogFileBindingAdmissionWitnessInDb,
} from '../main/catalog-file-binding';
import {
  registerCatalogEntityInDb,
  registerWorkspaceFileInDb,
} from '../main/catalog-entity-registration';
import {
  ensureWorkspaceOwnerInDb,
  refreshCatalogFileFingerprintsInDb,
  setCatalogFileStateInDb,
} from '../main/catalog-projection-commands';
import { linkCatalogEntitiesInDb } from '../main/catalog-association-commands';
import * as analytics from '../lib/analytics';
import * as workspaceArtifacts from '../db/workspace-artifacts';
import {
  NATIVE_WORKSPACE_MANIFEST_SCHEMA,
  NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
  serializeNativeWorkspaceManifest,
} from '../shared/native-workspace-manifest';
import { queryLimsEntities } from '../features/lims/operations';
import { nativeEntityReferenceHref } from '../shared/native-entity-reference';
import {
  nativeTabType,
  resolveExactNativeCatalogDestination,
  resolveNativeCatalogDestination,
} from './native-catalog-destination';
import { buildMigrationDestinationLinkIndexWriterPayload } from '../shared/benchling-migration-destination-index';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../db/sequence-package';

const scopedNb = (embeddedId: string) =>
  resolveWorkspaceScope('/lab').then((scope) => scopedProjectionId(scope, embeddedId));

describe('workspace reconcile', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['unchanged', 'changed manifest', 'lost binding', 'changed source'] as const)(
    'avoids parsing a notebook again in the second manifest pass: %s',
    async (change) => {
      setFileTree('/lab', [{ name: 'Notebook', isDirectory: true }]);
      setMockFileContent(
        '/lab/Notebook/.forge/notebook.json',
        JSON.stringify({
          schema: 'waypoint.notebook.v1',
          kind: 'notebook',
          id: 'fast-notebook',
          title: 'Notebook',
          content: { type: 'doc', content: [] },
        })
      );
      const manifest = {
        schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
        entities: [
          {
            id: 'fast-notebook',
            type: 'notebook' as const,
            name: 'Notebook',
            placement: {
              kind: 'package' as const,
              rootRelativePath: 'Notebook',
              primaryRelativePath: 'Notebook/.forge/notebook.json',
              fileKind: 'waypoint-notebook',
            },
            metadata: { retainedEvidence: 'source' },
          },
        ],
        links: [],
      };
      setMockFileContent('/lab/.forge/catalog.json', serializeNativeWorkspaceManifest(manifest));
      const resolve = vi.spyOn(workspaceArtifacts, 'resolveArtifactFile');
      const first = await reconcileNativeWorkspaceManifest('/lab');
      expect(first.notebookBindingPass?.bindings[0].sourceFingerprints[0].fingerprint).toMatch(
        /^sha256:[a-f0-9]{64}$/u
      );
      if (change === 'changed manifest') {
        manifest.entities[0].metadata.retainedEvidence = 'new source';
        setMockFileContent('/lab/.forge/catalog.json', serializeNativeWorkspaceManifest(manifest));
      }
      if (change === 'lost binding') {
        await platform().db.execute('DELETE FROM catalog_entity_files WHERE entity_id = ?', [
          await scopedNb('fast-notebook'),
        ]);
      }
      if (change === 'changed source') {
        setMockFileContent(
          '/lab/Notebook/.forge/notebook.json',
          JSON.stringify({
            schema: 'waypoint.notebook.v1',
            kind: 'notebook',
            id: 'fast-notebook',
            title: 'Updated notebook',
            content: { type: 'doc', content: [] },
          })
        );
      }

      await reconcileNativeWorkspaceManifest('/lab', first);
      expect(resolve).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 2);
      const entity = await getCatalogEntity(await scopedNb('fast-notebook'));
      expect(entity!.name).toBe(change === 'changed source' ? 'Updated notebook' : 'Notebook');
      expect(JSON.parse(entity!.metadata!)).toMatchObject({
        retainedEvidence: change === 'changed manifest' ? 'new source' : 'source',
      });
    }
  );

  it('leaves atomic native sequence provider bindings to the checked main projector', async () => {
    const root = '/atomic-sequence';
    setFileTree(root, [{ name: 'Candidate.gb', isDirectory: false }]);
    setMockFileContent(
      `${root}/Candidate.gb`,
      'LOCUS Candidate 4 bp DNA linear\nORIGIN\n 1 atgc\n//\n'
    );
    setMockFileContent(
      `${root}/.forge/catalog.json`,
      serializeNativeWorkspaceManifest({
        schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
        entities: [
          {
            id: 'candidate',
            type: 'sequence',
            name: 'Candidate',
            placement: { kind: 'file', relativePath: 'Candidate.gb', fileKind: 'genbank' },
            sourceIdentities: [
              {
                provider: 'benchling',
                stableObjectId: 'seq_CANDIDATE01',
                objectClass: 'sequence',
                bindingKind: 'observed',
              },
            ],
            lims: {
              kind: 'dna_sequence',
              name: 'Candidate',
              fields: {
                sequence: {
                  mode: 'file',
                  pathBase: 'workspace',
                  relPath: 'Candidate.gb',
                  topology: 'linear',
                  length: 4,
                  contentHash: `sha256:${'a'.repeat(64)}`,
                  sourceFormat: 'genbank',
                },
              },
            },
          },
        ],
        links: [],
      })
    );
    const main = vi.spyOn(platform().workspace, 'reconcileNativeRecords').mockResolvedValue(1);
    const writes = vi.spyOn(platform().db, 'execute');
    const exists = vi.spyOn(platform().fs, 'exists');
    expect(await reconcileNativeWorkspaceManifest(root)).toMatchObject({
      limsEntities: 1,
      providerBindings: 1,
    });
    expect(main).toHaveBeenCalledOnce();
    expect(exists.mock.calls.filter(([path]) => path === `${root}/Candidate.gb`)).toEqual([]);
    expect(
      writes.mock.calls.filter(([sql]) =>
        /(?:INSERT INTO|UPDATE) catalog_provider_bindings/u.test(sql)
      )
    ).toEqual([]);
  });

  it('delegates custom records to the file-authoritative main projection with the exact manifest hash', async () => {
    const root = '/portable-records';
    setFileTree(root, []);
    const content = serializeNativeWorkspaceManifest({
      schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
      entities: [
        {
          id: 'custom-a',
          type: 'record',
          name: 'Archived reagent',
          placement: {
            kind: 'catalog-record',
            parentRelativePath: '',
            displayName: 'Archived reagent',
            catalogType: 'record',
            presentationKind: 'record',
          },
          lifecycle: { state: 'archived', archivedAt: 123 },
          lims: {
            kind: 'reagent',
            name: 'Archived reagent',
            fields: { amount: 0 },
            schemaRevisionId: 'reagent-v1',
            schemaSnapshot: {
              schemaId: 'reagent-schema',
              schemaRevisionId: 'reagent-v1',
              version: 1,
              name: 'reagent',
              displayName: 'Reagent',
              baseKind: 'record',
              fields: [{ key: 'amount', label: 'Amount', type: 'number' }],
            },
          },
        },
      ],
      links: [],
    });
    setMockFileContent(`${root}/.forge/catalog.json`, content);
    const main = vi.spyOn(platform().workspace, 'reconcileNativeRecords').mockResolvedValue(1);
    const result = await reconcileWorkspaceRoot(root);
    expect(result.errors).toEqual([]);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    const expectedManifestSha256 = `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    expect(main).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: root, expectedManifestSha256 })
    );
    expect(await getCatalogEntity(await scopedNb('custom-a'))).toBeNull();
  });

  it('indexes an unlocked migration workspace from Git instead of walking every object folder', async () => {
    setMockFileContent(
      '/lab/.dnaforge/migration/workspace.json',
      JSON.stringify({ schema: 'dnaforge.benchling-migration-workspace.v1', status: 'unlocked' })
    );
    setMockFileContent('/lab/.git/HEAD', 'ref: refs/heads/main\n');
    setFileTree('/lab', [{ name: 'Benchling Imports', isDirectory: true }]);
    setFileTree('/lab/Benchling Imports', [{ name: 'Object 1', isDirectory: true }]);
    const indexHead = vi.spyOn(platform().workspace, 'indexManagedCatalogHead');
    const readDir = vi.spyOn(MockFsModule, 'readDir');

    const result = await reconcileWorkspaceRoot('/lab');

    expect(indexHead).toHaveBeenCalledTimes(1);
    expect(result.scanned).toBe(0);
    expect(readDir).not.toHaveBeenCalledWith('/lab/Benchling Imports');
  });

  it('discovers native artifacts and biology files under a workspace root', async () => {
    setFileTree('/lab', [
      { name: 'Recovered.wpnote.json', isDirectory: false },
      { name: 'seq.gb', isDirectory: false },
      { name: 'protein.faa', isDirectory: false },
    ]);
    setMockFileContent(
      '/lab/Recovered.wpnote.json',
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'page-recovered',
        title: 'Recovered',
        content: { type: 'doc', content: [] },
      })
    );
    setMockFileContent('/lab/seq.gb', 'LOCUS       seq 1 bp DNA\nORIGIN\n        1 a\n//');
    setMockFileContent('/lab/protein.faa', '>protein\nMKTW\n');

    const result = await reconcileWorkspaceRoot('/lab');

    expect(result.errors).toEqual([]);
    expect(result.registered).toBe(3);
    expect(await getCatalogEntityForFilePath('/lab/Recovered.wpnote.json')).toMatchObject({
      id: await scopedNb('page-recovered'),
      type: 'notebook',
    });
    expect(await getCatalogEntityForFilePath('/lab/seq.gb')).toMatchObject({
      type: 'sequence',
    });
    const protein = await getCatalogEntityForFilePath('/lab/protein.faa');
    expect(protein).toMatchObject({ type: 'protein' });
    expect(nativeTabType(protein!.type, '/lab/protein.faa')).toBe('protein');
    expect(nativeTabType('sequence', '/lab/DNA.faa')).toBe('sequence');
  });

  it('leaves a stray GenBank in its deliberately chosen folder without packaging or moving it', async () => {
    const path = '/lab/pRS426-ScRAD51-WT-native/pRS426-ScRAD51-WT-native.gb';
    const bytes = 'LOCUS       different_locus 4 bp DNA circular\nORIGIN\n        1 acgt\n//';
    setFileTree('/lab', [{ name: 'pRS426-ScRAD51-WT-native', isDirectory: true }]);
    setFileTree('/lab/pRS426-ScRAD51-WT-native', [
      { name: 'pRS426-ScRAD51-WT-native.gb', isDirectory: false },
    ]);
    setMockFileContent(path, bytes);
    const packageFile = vi.fn().mockRejectedValue(new Error('Background packaging must never run'));
    const fs = platform().fs;
    const original = fs.packageSequenceFile;
    fs.packageSequenceFile = packageFile;
    try {
      await reconcileWorkspaceRoot('/lab');
      await reconcileWorkspaceRoot('/lab');
      expect(packageFile).not.toHaveBeenCalled();
      expect(await fs.readTextFile(path)).toBe(bytes);
      expect(await getCatalogEntityForFilePath(path)).toMatchObject({ type: 'sequence' });
    } finally {
      fs.packageSequenceFile = original;
    }
  });

  it('opens a discovered loose plasmid by its exact catalog id only in its owning workspace', async () => {
    setFileTree('/lab', [{ name: 'pUC19.gb', isDirectory: false }]);
    setMockFileContent(
      '/lab/pUC19.gb',
      'LOCUS       pUC19 2686 bp DNA circular\nORIGIN\n        1 acgt\n//'
    );
    await reconcileWorkspaceRoot('/lab');
    const plasmid = await getCatalogEntityForFilePath('/lab/pUC19.gb');
    if (!plasmid) throw new Error('loose pUC19 catalog fixture was not registered');

    await expect(
      resolveExactNativeCatalogDestination({ workspaceRoot: '/lab', entityId: plasmid.id })
    ).resolves.toMatchObject({
      entityId: plasmid.id,
      title: 'pUC19.gb',
      entityType: 'sequence',
      locator: {
        kind: 'workspace_path',
        absolutePath: '/lab/pUC19.gb',
        tabType: 'sequence',
      },
    });
    await expect(
      resolveExactNativeCatalogDestination({ workspaceRoot: '/other', entityId: plasmid.id })
    ).resolves.toBeNull();
    await expect(
      resolveNativeCatalogDestination({ workspaceRoot: '/lab', rawId: plasmid.id })
    ).resolves.toMatchObject({ entityId: plasmid.id, locator: { absolutePath: '/lab/pUC19.gb' } });
    await expect(
      resolveNativeCatalogDestination({ workspaceRoot: '/other', rawId: plasmid.id })
    ).resolves.toBeNull();
  });

  it.each([
    {
      id: 'primer-search-result',
      type: 'primer' as const,
      name: 'M13 forward',
      path: '/lab/M13-forward.primer.json',
      fileKind: 'primer-artifact',
      tabType: 'primer',
    },
    {
      id: 'report-search-result',
      type: 'report' as const,
      name: 'Transformation report',
      path: '/lab/transformation-report.txt',
      fileKind: 'text',
      tabType: 'text',
    },
  ])('routes an exact $type search result to its native $tabType opener', async (fixture) => {
    await registerCatalogEntity({
      id: fixture.id,
      type: fixture.type,
      name: fixture.name,
      locator: `file://${fixture.path}`,
      storageType: 'file',
      workspaceRoot: '/lab',
    });
    await bindCatalogEntityToFile({
      entityId: fixture.id,
      path: fixture.path,
      fileKind: fixture.fileKind,
      workspaceRoot: '/lab',
    });

    await expect(
      resolveExactNativeCatalogDestination({ workspaceRoot: '/lab', entityId: fixture.id })
    ).resolves.toMatchObject({
      entityId: fixture.id,
      entityType: fixture.type,
      locator: {
        kind: 'workspace_path',
        absolutePath: fixture.path,
        tabType: fixture.tabType,
      },
    });
  });

  it('routes an owned database-only notebook search result to its page record', async () => {
    const entityId = 'ws1::database-only-notebook';
    await registerCatalogEntity({
      id: entityId,
      type: 'notebook',
      name: 'Legacy notes',
      locator: `entity://page/${entityId}`,
      storageType: 'database',
      workspaceRoot: '/lab',
    });
    await platform().db.execute(
      `INSERT INTO pages (id, title, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [entityId, 'Legacy notes', JSON.stringify({ type: 'doc', content: [] }), 1, 1]
    );

    await expect(
      resolveExactNativeCatalogDestination({ workspaceRoot: '/lab', entityId })
    ).resolves.toMatchObject({
      entityId,
      entityType: 'notebook',
      locator: { kind: 'workspace_page', pageId: entityId },
    });

    await platform().db.execute('DELETE FROM pages WHERE id = ?', [entityId]);
    await expect(
      resolveExactNativeCatalogDestination({ workspaceRoot: '/lab', entityId })
    ).resolves.toBeNull();
  });

  it('continues indexing healthy files when a native manifest entry is missing', async () => {
    setFileTree('/lab', [{ name: 'healthy.gb', isDirectory: false }]);
    setMockFileContent('/lab/healthy.gb', 'LOCUS healthy 1 bp DNA\nORIGIN\n        1 a\n//');
    setMockFileContent(
      '/lab/.forge/catalog.json',
      serializeNativeWorkspaceManifest({
        schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA,
        entities: [
          {
            id: 'sequence-missing',
            type: 'sequence',
            name: 'Deleted sequence',
            path: 'deleted.gb',
            fileKind: 'genbank',
          },
        ],
        links: [],
      })
    );

    const result = await reconcileWorkspaceRoot('/lab');

    expect(result.errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(
          'Native workspace entity is missing its authoritative path: deleted.gb'
        ),
      }),
    ]);
    expect(result.registered).toBeGreaterThan(0);
    await expect(getCatalogEntityForFilePath('/lab/healthy.gb')).resolves.toMatchObject({
      type: 'sequence',
    });
    await expect(reconcileWorkspaceRoot('/lab', { strict: true })).rejects.toThrow(
      'Workspace reconciliation failed'
    );
  });

  it('discovers provider-neutral protocol packages without a migration manifest', async () => {
    setFileTree('/lab', [{ name: 'Protocols', isDirectory: true }]);
    setFileTree('/lab/Protocols', [{ name: 'PCR', isDirectory: true }]);
    setMockFileContent(
      '/lab/Protocols/PCR/.forge/protocol.json',
      JSON.stringify({
        schema: 'dnaforge.protocol.v1',
        kind: 'protocol',
        id: 'protocol-pcr',
        title: 'PCR',
      })
    );

    const result = await reconcileWorkspaceRoot('/lab');

    expect(result.errors).toEqual([]);
    await expect(
      getCatalogEntityForFilePath('/lab/Protocols/PCR/.forge/protocol.json')
    ).resolves.toMatchObject({
      id: await scopedNb('protocol-pcr'),
      type: 'protocol',
      name: 'PCR',
    });
  });

  it('reconciles a v2 package through its primary protocol artifact', async () => {
    const root = '/lab-v2-protocol';
    const packageRoot = `${root}/Protocols/PCR`;
    const primaryPath = `${packageRoot}/.forge/protocol.json`;
    setFileTree(root, [{ name: 'Protocols', isDirectory: true }]);
    setFileTree(`${root}/Protocols`, [{ name: 'PCR', isDirectory: true }]);
    setFileTree(packageRoot, [{ name: '.forge', isDirectory: true }]);
    setFileTree(`${packageRoot}/.forge`, [{ name: 'protocol.json', isDirectory: false }]);
    setMockFileContent(
      primaryPath,
      JSON.stringify({
        schema: 'dnaforge.protocol.v1',
        kind: 'protocol',
        id: 'protocol-pcr',
        title: 'PCR',
      })
    );
    setMockFileContent(
      `${root}/.forge/catalog.json`,
      serializeNativeWorkspaceManifest({
        schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
        entities: [
          {
            id: 'protocol-pcr',
            type: 'protocol',
            name: 'PCR',
            placement: {
              kind: 'package',
              rootRelativePath: 'Protocols/PCR',
              primaryRelativePath: 'Protocols/PCR/.forge/protocol.json',
              fileKind: 'protocol',
            },
          },
        ],
        links: [],
      })
    );

    const result = await reconcileWorkspaceRoot(root);

    expect(result.errors).toEqual([]);
    await expect(getCatalogEntityForFilePath(primaryPath)).resolves.toMatchObject({
      id: scopedProjectionId(await resolveWorkspaceScope(root), 'protocol-pcr'),
      type: 'protocol',
      name: 'PCR',
    });
    await expect(getCatalogEntityForFilePath(packageRoot)).resolves.toBeNull();
  });

  it('reconstructs a provider-neutral protocol run from its own package in a fresh database', async () => {
    setFileTree('/lab', [{ name: 'Protocol Runs', isDirectory: true }]);
    setFileTree('/lab/Protocol Runs', [{ name: 'PCR run 1', isDirectory: true }]);
    setMockFileContent(
      '/lab/Protocol Runs/PCR run 1/.forge/protocol-run.json',
      JSON.stringify({
        schema: 'dnaforge.protocol-run.v1',
        kind: 'protocol_run',
        id: 'protocol-run-pcr-1',
        title: 'PCR run 1',
        status: 'in_progress',
        immutable: false,
        protocol: {
          sourceId: 'protocol-pcr',
          destinationId: 'protocol-pcr',
          name: 'PCR',
          pinnedVersionId: 'local-v1',
          pinnedVersionHash: `sha256:${'a'.repeat(64)}`,
        },
        inputs: [],
        outputs: [],
        measurements: [],
        tables: [],
        links: [],
        startedAt: '2026-08-16T01:00:00.000Z',
        completedAt: null,
        amendments: [],
      })
    );

    const result = await reconcileWorkspaceRoot('/lab');

    expect(result.errors).toEqual([]);
    await expect(
      getCatalogEntityForFilePath('/lab/Protocol Runs/PCR run 1/.forge/protocol-run.json')
    ).resolves.toMatchObject({
      id: await scopedNb('protocol-run-pcr-1'),
      type: 'protocol_run',
      name: 'PCR run 1',
    });
    await expect(
      resolveNativeCatalogDestination({ workspaceRoot: '/lab', rawId: 'protocol-run-pcr-1' })
    ).resolves.toMatchObject({
      title: 'PCR run 1',
      entityType: 'protocol_run',
      locator: {
        absolutePath: '/lab/Protocol Runs/PCR run 1/.forge/protocol-run.json',
        tabType: 'scientific-document',
      },
    });
  });

  it('resolves references from the legacy destination index when no native catalog exists', async () => {
    const payload = buildMigrationDestinationLinkIndexWriterPayload([
      {
        destinationObjectId: 'benchling-sequence-old',
        sourceStableIds: ['seq_OLD'],
        locator: {
          kind: 'workspace_path',
          relativePath: 'Benchling Imports/Sequences/Old.gb',
          tabType: 'sequence',
        },
        title: 'Old sequence',
      },
      {
        destinationObjectId: 'benchling-protein-old',
        sourceStableIds: ['prot_OLD'],
        locator: { kind: 'lims_entity', entityId: 'benchling-protein-old' },
        title: 'Old protein',
      },
      {
        destinationObjectId: 'benchling-protein-file-old',
        sourceStableIds: ['prot_FILE_OLD'],
        locator: {
          kind: 'workspace_path',
          relativePath: 'Benchling Imports/Proteins/Old.fna',
          tabType: 'protein',
        },
        title: 'Old file protein',
      },
      {
        destinationObjectId: 'benchling-sequence-file-old',
        sourceStableIds: ['seq_FILE_OLD'],
        locator: {
          kind: 'workspace_path',
          relativePath: 'Benchling Imports/Sequences/Old.faa',
          tabType: 'sequence',
        },
        title: 'Old file sequence',
      },
    ]);
    const readTextFileSlice = vi.fn(async () => ({
      text: payload.text,
      bytesRead: new TextEncoder().encode(payload.text).byteLength,
    }));

    await expect(
      resolveNativeCatalogDestination({
        workspaceRoot: '/lab',
        rawId: 'seq_OLD',
        readTextFileSlice,
      })
    ).resolves.toMatchObject({
      entityId: 'benchling-sequence-old',
      title: 'Old sequence',
      entityType: 'sequence',
      locator: {
        kind: 'workspace_path',
        absolutePath: '/lab/Benchling Imports/Sequences/Old.gb',
        tabType: 'sequence',
      },
    });
    await expect(
      resolveNativeCatalogDestination({
        workspaceRoot: '/lab',
        rawId: 'prot_OLD',
        readTextFileSlice,
      })
    ).resolves.toMatchObject({
      entityId: 'benchling-protein-old',
      title: 'Old protein',
      locator: { kind: 'lims_entity', entityId: 'benchling-protein-old' },
    });
    for (const source of [
      {
        rawId: 'prot_FILE_OLD',
        entityId: 'benchling-protein-file-old',
        type: 'protein',
        path: '/lab/Benchling Imports/Proteins/Old.fna',
      },
      {
        rawId: 'seq_FILE_OLD',
        entityId: 'benchling-sequence-file-old',
        type: 'sequence',
        path: '/lab/Benchling Imports/Sequences/Old.faa',
      },
    ]) {
      await expect(
        resolveNativeCatalogDestination({
          workspaceRoot: '/lab',
          rawId: source.rawId,
          readTextFileSlice,
        })
      ).resolves.toMatchObject({
        source: 'legacy_index',
        entityId: source.entityId,
        entityType: 'file',
        locator: { kind: 'workspace_path', absolutePath: source.path, tabType: source.type },
      });
    }
    expect(readTextFileSlice).toHaveBeenCalledWith(
      '/lab/.dnaforge/migration/destination-link-index.v1.json',
      16 * 1024 * 1024 + 1
    );
  });

  it('reconstructs portable native identities, folders, links, and molecule LIMS records', async () => {
    const track = vi.spyOn(analytics, 'trackRendererEvent').mockReturnValue(true);
    setFileTree('/lab', [
      { name: 'Folders', isDirectory: true },
      { name: 'Sequences', isDirectory: true },
      { name: 'Proteins', isDirectory: true },
    ]);
    setFileTree('/lab/Folders', [{ name: 'Characterization', isDirectory: true }]);
    setFileTree('/lab/Folders/Characterization', [{ name: '.gitkeep', isDirectory: false }]);
    setFileTree('/lab/Sequences', [
      { name: 'Reporter DNA.gb', isDirectory: false },
      { name: 'Reporter RNA.gb', isDirectory: false },
    ]);
    setFileTree('/lab/Proteins', [{ name: 'Reporter.faa', isDirectory: false }]);
    setMockFileContent('/lab/Folders/Characterization/.gitkeep', '');
    setMockFileContent(
      '/lab/Sequences/Reporter DNA.gb',
      'LOCUS Reporter_DNA 4 bp DNA linear\nORIGIN\n        1 atgc\n//\n'
    );
    setMockFileContent(
      '/lab/Sequences/Reporter RNA.gb',
      'LOCUS Reporter_RNA 4 bp RNA linear\nORIGIN\n        1 augc\n//\n'
    );
    setMockFileContent('/lab/Proteins/Reporter.faa', '>Reporter\nMKT\n');
    setMockFileContent(
      '/lab/.forge/catalog.json',
      serializeNativeWorkspaceManifest({
        schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA,
        entities: [
          {
            id: 'folder-characterization',
            type: 'folder',
            name: 'Characterization',
            path: 'Folders/Characterization',
            fileKind: 'folder',
          },
          {
            id: 'sequence-reporter-dna',
            type: 'sequence',
            name: 'Reporter DNA',
            path: 'Sequences/Reporter DNA.gb',
            fileKind: 'genbank',
            lims: {
              kind: 'dna_sequence',
              name: 'Reporter DNA',
              fields: {
                sequence: {
                  mode: 'file',
                  pathBase: 'workspace',
                  relPath: 'Sequences/Reporter DNA.gb',
                  topology: 'linear',
                  length: 4,
                  contentHash: `sha256:${'c'.repeat(64)}`,
                  fileContentHash: `sha256:${'c'.repeat(64)}`,
                  normalizedSequenceHash: `sha256:${'d'.repeat(64)}`,
                  sourceFormat: 'genbank',
                },
              },
              registrationStatus: 'registered',
            },
          },
          {
            id: 'sequence-reporter-rna',
            type: 'sequence',
            name: 'Reporter RNA',
            path: 'Sequences/Reporter RNA.gb',
            fileKind: 'genbank',
            lims: {
              kind: 'rna_sequence',
              name: 'Reporter RNA',
              fields: {
                sequence: {
                  mode: 'file',
                  pathBase: 'workspace',
                  relPath: 'Sequences/Reporter RNA.gb',
                  topology: 'linear',
                  length: 4,
                  contentHash: `sha256:${'e'.repeat(64)}`,
                  fileContentHash: `sha256:${'e'.repeat(64)}`,
                  normalizedSequenceHash: `sha256:${'f'.repeat(64)}`,
                  sourceFormat: 'genbank',
                },
              },
              registrationStatus: 'registered',
            },
          },
          {
            id: 'protein-reporter',
            type: 'protein',
            name: 'Reporter protein',
            path: 'Proteins/Reporter.faa',
            fileKind: 'fasta',
            lims: {
              kind: 'protein',
              name: 'Reporter protein',
              fields: {
                sequence: {
                  mode: 'file',
                  pathBase: 'workspace',
                  relPath: 'Proteins/Reporter.faa',
                  length: 3,
                  contentHash: `sha256:${'a'.repeat(64)}`,
                  fileContentHash: `sha256:${'a'.repeat(64)}`,
                  normalizedSequenceHash: `sha256:${'b'.repeat(64)}`,
                  sourceFormat: 'fasta',
                },
              },
              registrationStatus: 'registered',
            },
          },
        ],
        links: [
          {
            sourceId: 'folder-characterization',
            relation: 'contains',
            targetId: 'sequence-reporter-dna',
            confidence: 'confirmed',
          },
          {
            sourceId: 'folder-characterization',
            relation: 'contains',
            targetId: 'sequence-reporter-rna',
            confidence: 'confirmed',
          },
          {
            sourceId: 'folder-characterization',
            relation: 'contains',
            targetId: 'protein-reporter',
            confidence: 'confirmed',
          },
        ],
        limsLinks: [
          {
            id: 'reporter-molecule-link',
            fromEntityId: 'sequence-reporter-dna',
            toEntityId: 'sequence-reporter-rna',
            type: 'related_to',
            payload: { note: 'Keep source link' },
          },
        ],
        events: [
          {
            id: 'import-protein-reporter',
            entityId: 'protein-reporter',
            eventType: 'imported',
            actor: 'migration',
            summary: 'Imported into DNAForge',
            createdAt: 1_750_000_000_000,
          },
        ],
      })
    );

    const result = await reconcileWorkspaceRoot('/lab');
    const scope = await resolveWorkspaceScope('/lab');
    const folderId = scopedProjectionId(scope, 'folder-characterization');
    const proteinId = scopedProjectionId(scope, 'protein-reporter');

    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({
      nativeManifestEntities: 4,
      nativeManifestLinks: 3,
      nativeManifestLimsEntities: 3,
      nativeManifestEvents: 1,
    });
    await expect(
      getCatalogEntityForFilePath('/lab/Folders/Characterization')
    ).resolves.toMatchObject({ id: folderId, type: 'folder', name: 'Characterization' });
    await expect(getCatalogEntityForFilePath('/lab/Proteins/Reporter.faa')).resolves.toMatchObject({
      id: proteinId,
      type: 'protein',
      name: 'Reporter protein',
    });
    await expect(getCatalogLinksForEntity(folderId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_entity_id: folderId,
          relation: 'contains',
          target_entity_id: proteinId,
        }),
        expect.objectContaining({ relation: 'contains' }),
        expect.objectContaining({ relation: 'contains' }),
      ])
    );
    await expect(
      queryLimsEntities({ workspaceId: (await resolveWorkspaceScope('/lab')).key })
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'dna_sequence',
          fields: expect.objectContaining({
            sequence: expect.objectContaining({ relPath: '/lab/Sequences/Reporter DNA.gb' }),
          }),
        }),
        expect.objectContaining({
          kind: 'rna_sequence',
          fields: expect.objectContaining({
            sequence: expect.objectContaining({ relPath: '/lab/Sequences/Reporter RNA.gb' }),
          }),
        }),
        expect.objectContaining({
          id: proteinId,
          kind: 'protein',
          name: 'Reporter protein',
          fields: expect.objectContaining({
            sequence: expect.objectContaining({ relPath: '/lab/Proteins/Reporter.faa' }),
          }),
        }),
      ])
    );
    const reconstructedMolecules = await queryLimsEntities({
      workspaceId: (await resolveWorkspaceScope('/lab')).key,
    });
    for (const molecule of reconstructedMolecules.filter((entity) =>
      ['dna_sequence', 'rna_sequence', 'protein'].includes(entity.kind)
    )) {
      const sequence = molecule.fields.sequence as {
        contentHash?: string;
        fileContentHash?: string;
        normalizedSequenceHash?: string;
      };
      expect(sequence.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(sequence.fileContentHash).toBe(sequence.contentHash);
      expect(sequence.normalizedSequenceHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(sequence.contentHash).not.toBe(`sha256:${'a'.repeat(64)}`);
      expect(sequence.contentHash).not.toBe(`sha256:${'c'.repeat(64)}`);
      expect(sequence.contentHash).not.toBe(`sha256:${'e'.repeat(64)}`);
    }
    await expect(getCatalogEventsForEntity(proteinId)).resolves.toEqual([
      expect.objectContaining({
        id: scopedProjectionId(scope, 'import-protein-reporter'),
        event_type: 'imported',
        created_at: 1_750_000_000_000,
      }),
    ]);
    await updateCatalogEntityName(proteinId, 'User-renamed reporter');

    await platform().db.execute(
      'INSERT INTO lims_link (id,from_entity_id,to_entity_id,type,payload,tombstone) VALUES (?,?,?,?,?,?)',
      [
        scopedProjectionId(scope, 'reporter-molecule-link'),
        scopedProjectionId(scope, 'sequence-reporter-dna'),
        scopedProjectionId(scope, 'sequence-reporter-rna'),
        'related_to',
        JSON.stringify({ note: 'Later edited link' }),
        0,
      ]
    );
    const linkMutation = vi.spyOn(platform().lims, 'linkEntities');
    const catalogWrites = vi.spyOn(platform().db, 'execute');
    await reconcileWorkspaceRoot('/lab');
    expect(linkMutation).not.toHaveBeenCalled();
    expect(
      catalogWrites.mock.calls.filter(([sql]) => /UPDATE catalog_entity_links/u.test(sql))
    ).toEqual([]);
    await expect(getCatalogEventsForEntity(proteinId)).resolves.toHaveLength(1);
    await expect(getCatalogEntityForFilePath('/lab/Proteins/Reporter.faa')).resolves.toMatchObject({
      id: proteinId,
      name: 'User-renamed reporter',
    });

    const initialProtein = (
      await queryLimsEntities({ id: proteinId, includeArchived: true, limit: 1 })
    )[0];
    const initialSequence = initialProtein?.fields.sequence as
      | { contentHash?: string; length?: number }
      | undefined;
    setMockFileContent('/lab/Proteins/Reporter.faa', '>Reporter\nMKTA\n');
    await platform().db.execute(
      "UPDATE catalog_entity_links SET confidence='suggested',evidence='{}' WHERE source_entity_id=?",
      [folderId]
    );

    const repaired = await reconcileWorkspaceRoot('/lab');
    const repairedProtein = (
      await queryLimsEntities({ id: proteinId, includeArchived: true, limit: 1 })
    )[0];
    const repairedSequence = repairedProtein?.fields.sequence as
      | { contentHash?: string; length?: number }
      | undefined;

    expect(repaired.errors).toEqual([]);
    expect(repairedSequence).toMatchObject({ length: 4 });
    expect(repairedSequence?.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(repairedSequence?.contentHash).not.toBe(initialSequence?.contentHash);
    expect(repairedProtein?.name).toBe('Reporter protein');
    expect(
      (await getCatalogLinksForEntity(folderId)).every(
        (link) => link.confidence === 'confirmed' && link.evidence === null
      )
    ).toBe(true);
    const registry = track.mock.calls.filter(
      ([event, properties]) =>
        event === 'workflow_action_observed' && properties?.workflow === 'registry'
    );
    expect(registry.length).toBeGreaterThan(0);
    for (const [, properties] of registry) {
      expect(properties).toMatchObject({ workflow_origin: 'projection' });
      expect(properties).not.toHaveProperty('parent_action_id');
    }
  });

  it('reconstructs an imported strain as one database-backed catalog and LIMS entity', async () => {
    setFileTree('/lab', [{ name: 'Benchling Imports', isDirectory: true }]);
    setFileTree('/lab/Benchling Imports', [{ name: 'Imported strain', isDirectory: true }]);
    setMockFileContent(
      '/lab/Benchling Imports/Imported strain/.forge/benchling-native-record.json',
      '{"kind":"strain"}'
    );
    setMockFileContent(
      '/lab/.forge/catalog.json',
      serializeNativeWorkspaceManifest({
        schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA,
        entities: [
          {
            id: 'strain-imported',
            type: 'sample',
            name: 'Imported strain',
            path: 'Benchling Imports/Imported strain/.forge/benchling-native-record.json',
            fileKind: 'benchling-native-record-evidence',
            lims: {
              kind: 'strain',
              name: 'Imported strain',
              fields: {
                genotypeCanonical: 'deltaX',
                sourceMetadata: {
                  schemaVersion: 1,
                  origin: { type: 'connector', connectorType: 'benchling' },
                  values: {},
                  entries: [{ label: 'Genotype', value: 'deltaX', position: 0 }],
                },
              },
              registrationStatus: 'registered',
            },
          },
        ],
        links: [],
      })
    );

    const result = await reconcileWorkspaceRoot('/lab');

    expect(result.errors).toEqual([]);
    const [strain] = await queryLimsEntities({ kind: 'strain', includeArchived: true, limit: 2 });
    expect(strain).toMatchObject({
      name: 'Imported strain',
      fields: expect.objectContaining({
        sourceMetadata: expect.objectContaining({
          entries: [{ label: 'Genotype', value: 'deltaX', position: 0 }],
        }),
      }),
    });
    await expect(
      resolveNativeCatalogDestination({ workspaceRoot: '/lab', rawId: 'strain-imported' })
    ).resolves.toMatchObject({
      entityType: 'sample',
      locator: { kind: 'lims_entity' },
    });
    await expect(
      getCatalogEntityForFilePath(
        '/lab/Benchling Imports/Imported strain/.forge/benchling-native-record.json'
      )
    ).resolves.toBeNull();
  });

  it('reconstructs native navigation from a copied workspace with a fresh database and no migration runtime', async () => {
    const root = '/copied';
    const notebookPath = 'Benchling Imports/Notebooks/Study notebook';
    const protocolPath = 'Benchling Imports/Protocols/PCR protocol';
    const proteinPath = 'Benchling Imports/Proteins/Reporter protein.faa';
    const folderPath = 'Benchling Imports/Folders/Characterization';
    const secondFolderPath = 'Benchling Imports/Folders/Shared reagents';
    const protocolHref = nativeEntityReferenceHref('protocol-pcr');
    if (!protocolHref) throw new Error('Native protocol reference fixture is invalid.');

    setFileTree(root, [{ name: 'Benchling Imports', isDirectory: true }]);
    setFileTree(`${root}/Benchling Imports`, [
      { name: 'Folders', isDirectory: true },
      { name: 'Notebooks', isDirectory: true },
      { name: 'Protocols', isDirectory: true },
      { name: 'Proteins', isDirectory: true },
    ]);
    setFileTree(`${root}/Benchling Imports/Folders`, [
      { name: 'Characterization', isDirectory: true },
      { name: 'Shared reagents', isDirectory: true },
    ]);
    setFileTree(`${root}/Benchling Imports/Folders/Characterization`, [
      { name: '.gitkeep', isDirectory: false },
    ]);
    setFileTree(`${root}/Benchling Imports/Folders/Shared reagents`, [
      { name: '.gitkeep', isDirectory: false },
    ]);
    setFileTree(`${root}/Benchling Imports/Notebooks`, [
      { name: 'Study notebook', isDirectory: true },
    ]);
    setFileTree(`${root}/${notebookPath}`, [{ name: 'assets', isDirectory: true }]);
    setFileTree(`${root}/${notebookPath}/assets`, [{ name: 'result.png', isDirectory: false }]);
    setFileTree(`${root}/Benchling Imports/Protocols`, [
      { name: 'PCR protocol', isDirectory: true },
    ]);
    setFileTree(`${root}/${protocolPath}`, []);
    setFileTree(`${root}/Benchling Imports/Proteins`, [
      { name: 'Reporter protein.faa', isDirectory: false },
    ]);
    setMockFileContent(`${root}/${folderPath}/.gitkeep`, '');
    setMockFileContent(`${root}/${secondFolderPath}/.gitkeep`, '');
    setMockFileContent(`${root}/${notebookPath}/assets/result.png`, new Uint8Array([1, 2, 3]));
    setMockFileContent(
      `${root}/${notebookPath}/.forge/notebook.json`,
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'notebook-study',
        title: 'Study notebook',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'PCR protocol',
                  marks: [{ type: 'link', attrs: { href: protocolHref } }],
                },
              ],
            },
          ],
        },
      })
    );
    setMockFileContent(
      `${root}/${protocolPath}/.forge/protocol.json`,
      JSON.stringify({
        schema: 'dnaforge.protocol.v1',
        kind: 'protocol',
        id: 'protocol-pcr',
        title: 'PCR protocol',
      })
    );
    setMockFileContent(`${root}/${proteinPath}`, '>Reporter protein\nMKT\n');
    setMockFileContent(
      `${root}/.forge/catalog.json`,
      serializeNativeWorkspaceManifest({
        schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA,
        entities: [
          {
            id: 'folder-characterization',
            type: 'folder',
            name: 'Characterization',
            path: folderPath,
            fileKind: 'folder',
          },
          {
            id: 'folder-shared-reagents',
            type: 'folder',
            name: 'Shared reagents',
            path: secondFolderPath,
            fileKind: 'folder',
          },
          {
            id: 'notebook-study',
            type: 'notebook',
            name: 'Study notebook',
            path: notebookPath,
            fileKind: 'notebook',
          },
          {
            id: 'protocol-pcr',
            type: 'protocol',
            name: 'PCR protocol',
            path: `${protocolPath}/.forge/protocol.json`,
            fileKind: 'protocol',
          },
          {
            id: 'protein-reporter',
            type: 'protein',
            name: 'Reporter protein',
            path: proteinPath,
            fileKind: 'fasta',
          },
        ],
        links: [
          {
            sourceId: 'folder-characterization',
            relation: 'contains',
            targetId: 'notebook-study',
          },
          {
            sourceId: 'folder-characterization',
            relation: 'contains',
            targetId: 'protein-reporter',
          },
          {
            sourceId: 'folder-shared-reagents',
            relation: 'contains',
            targetId: 'protein-reporter',
          },
          {
            sourceId: 'notebook-study',
            relation: 'references',
            targetId: 'protocol-pcr',
          },
        ],
      })
    );
    const exists = vi.spyOn(MockFsModule, 'exists');
    const readTextFile = vi.spyOn(MockFsModule, 'readTextFile');
    const migrateNotebookPackageAtPathInMain = vi.fn(async () => null);
    const originalMigration = platform().fs.migrateNotebookPackageAtPathInMain;
    platform().fs.migrateNotebookPackageAtPathInMain = migrateNotebookPackageAtPathInMain;

    let result: Awaited<ReturnType<typeof reconcileWorkspaceRoot>>;
    try {
      result = await reconcileWorkspaceRoot(root, {
        mutationToken: 'native-manifest-reconcile-token',
      });
    } finally {
      platform().fs.migrateNotebookPackageAtPathInMain = originalMigration;
    }
    const scope = await resolveWorkspaceScope(root);
    const notebookId = scopedProjectionId(scope, 'notebook-study');
    const protocolId = scopedProjectionId(scope, 'protocol-pcr');
    const firstFolderId = scopedProjectionId(scope, 'folder-characterization');
    const secondFolderId = scopedProjectionId(scope, 'folder-shared-reagents');
    const proteinId = scopedProjectionId(scope, 'protein-reporter');

    expect(result.errors).toEqual([]);
    expect(migrateNotebookPackageAtPathInMain).toHaveBeenCalledWith(
      expect.objectContaining({
        packageRoot: `${root}/${notebookPath}`,
        workspaceRoot: root,
        mutationToken: 'native-manifest-reconcile-token',
      })
    );
    expect(result).toMatchObject({ nativeManifestEntities: 5, nativeManifestLinks: 4 });
    await expect(
      resolveNativeCatalogDestination({ workspaceRoot: root, rawId: 'notebook-study' })
    ).resolves.toMatchObject({
      entityId: notebookId,
      title: 'Study notebook',
      entityType: 'notebook',
      locator: { absolutePath: `${root}/${notebookPath}`, tabType: 'page' },
    });
    await expect(
      resolveNativeCatalogDestination({ workspaceRoot: root, rawId: 'protocol-pcr' })
    ).resolves.toMatchObject({
      entityId: protocolId,
      title: 'PCR protocol',
      entityType: 'protocol',
      locator: {
        absolutePath: `${root}/${protocolPath}/.forge/protocol.json`,
        tabType: 'scientific-document',
      },
    });
    const proteinBinding = await getCatalogFileForPath(`${root}/${proteinPath}`);
    vi.spyOn(platform().db, 'getFastaKindReadAuthority').mockImplementation(async (input) => {
      expect(input).toEqual({ path: `${root}/${proteinPath}`, workspaceRoot: root });
      return {
        status: 'declared',
        kind: 'protein',
        authority: 'canonical-source',
        path: input.path,
        workspaceRoot: root,
        entityId: proteinId,
        bindingId: proteinBinding!.id,
        objectUuid: proteinBinding!.object_uuid,
      };
    });
    await expect(
      resolveNativeCatalogDestination({ workspaceRoot: root, rawId: 'protein-reporter' })
    ).resolves.toMatchObject({
      entityId: proteinId,
      title: 'Reporter protein',
      entityType: 'protein',
      locator: { absolutePath: `${root}/${proteinPath}`, tabType: 'protein' },
    });
    await expect(getCatalogLinksForEntity(notebookId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_entity_id: notebookId,
          relation: 'references',
          target_entity_id: protocolId,
        }),
      ])
    );
    await expect(getCatalogLinksForEntity(firstFolderId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_entity_id: firstFolderId,
          relation: 'contains',
          target_entity_id: proteinId,
        }),
      ])
    );
    await expect(getCatalogLinksForEntity(secondFolderId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_entity_id: secondFolderId,
          relation: 'contains',
          target_entity_id: proteinId,
        }),
      ])
    );

    expect(
      readTextFile.mock.calls.some(([path]) => String(path).includes('.dnaforge/migration'))
    ).toBe(false);
    exists.mockRestore();
    readTextFile.mockRestore();
  });

  it('rebuilds v2 file and virtual records from a copied workspace without probing fake paths', async () => {
    const root = '/copied-v2';
    setFileTree(root, [{ name: 'Sequences', isDirectory: true }]);
    setFileTree(`${root}/Sequences`, [{ name: 'plasmid.gb', isDirectory: false }]);
    setMockFileContent(
      `${root}/Sequences/plasmid.gb`,
      'LOCUS plasmid 4 bp DNA linear\nORIGIN\n        1 acgt\n//'
    );
    setMockFileContent(
      `${root}/.forge/catalog.json`,
      serializeNativeWorkspaceManifest({
        schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
        entities: [
          {
            id: 'sequence-file',
            type: 'sequence',
            name: 'Plasmid',
            placement: {
              kind: 'file',
              relativePath: 'Sequences/plasmid.gb',
              fileKind: 'genbank',
            },
            sourceIdentities: [
              {
                provider: 'benchling',
                stableObjectId: 'seq_DEMOSQ0005',
                objectClass: 'sequence',
                bindingKind: 'observed',
              },
            ],
            migrationSource: {
              historyRunId: 'run-copied-v2',
              sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
              sourceObjectId: 'seq_DEMOSQ0005',
            },
          },
          {
            id: 'strain-record',
            type: 'sample',
            name: 'Strain A',
            placement: {
              kind: 'catalog-record',
              parentRelativePath: 'Strains',
              displayName: 'Strain A',
              catalogType: 'sample',
              presentationKind: 'strain',
            },
            lims: {
              kind: 'strain',
              name: 'Strain A',
              fields: { genotypeCanonical: 'deltaX' },
              registrationStatus: 'registered',
            },
            sourceIdentities: [
              {
                provider: 'benchling',
                stableObjectId: 'bfi_STRAINAA',
                objectClass: 'registry_entity',
                bindingKind: 'observed',
              },
            ],
            migrationSource: {
              historyRunId: 'run-copied-v2',
              sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
              sourceObjectId: 'bfi_STRAINAA',
            },
          },
          {
            id: 'sequence-record',
            type: 'sequence',
            name: 'Sequence without bases',
            placement: {
              kind: 'catalog-record',
              parentRelativePath: 'Sequences',
              displayName: 'Sequence without bases',
              catalogType: 'sequence',
              presentationKind: 'sequence',
            },
            lims: {
              kind: 'dna_sequence',
              name: 'Sequence without bases',
              fields: { sequence: { mode: 'unresolved' }, source: 'external_migration' },
              registrationStatus: 'unresolved',
            },
            sourceIdentities: [
              {
                provider: 'benchling',
                stableObjectId: 'bfi_SEQUENCEA',
                objectClass: 'registry_entity',
                bindingKind: 'observed',
              },
            ],
            migrationSource: {
              historyRunId: 'run-copied-v2',
              sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
              sourceObjectId: 'bfi_SEQUENCEA',
            },
          },
        ],
        links: [],
      })
    );
    const exists = vi.spyOn(MockFsModule, 'exists');

    const result = await reconcileWorkspaceRoot(root);
    const scope = await resolveWorkspaceScope(root);
    const directFileId = scopedProjectionId(scope, 'sequence-file');
    const strainId = scopedProjectionId(scope, 'strain-record');
    const sequenceRecordId = scopedProjectionId(scope, 'sequence-record');

    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({
      nativeManifestEntities: 3,
      nativeManifestLimsEntities: 2,
      nativeManifestProviderBindings: 3,
    });
    await expect(
      getCatalogEntityForFilePath(`${root}/Sequences/plasmid.gb`)
    ).resolves.toMatchObject({
      id: directFileId,
      status: 'active',
    });
    await expect(getCatalogWorkspacePlacement(strainId)).resolves.toMatchObject({
      parent_relative_path: 'Strains',
      display_name: 'Strain A',
      presentation_kind: 'strain',
    });
    await expect(getCatalogWorkspacePlacement(sequenceRecordId)).resolves.toMatchObject({
      parent_relative_path: 'Sequences',
      display_name: 'Sequence without bases',
      presentation_kind: 'sequence',
    });
    const strainCatalog = await getCatalogEntity(strainId);
    expect(JSON.parse(strainCatalog?.metadata ?? '{}')).toMatchObject({
      migrationSource: {
        historyRunId: 'run-copied-v2',
        sourceId: 'external-zip-aaaaaaaaaaaaaaaaaaaaaaaa',
        sourceObjectId: 'bfi_STRAINAA',
      },
    });
    expect(
      (await queryLimsEntities({ includeArchived: true, limit: 10 })).map((entity) => entity.kind)
    ).toEqual(expect.arrayContaining(['strain', 'dna_sequence']));
    expect(
      exists.mock.calls.some(
        ([path]) => String(path).includes('Strains/Strain A') || String(path).includes('_catalog')
      )
    ).toBe(false);
  });

  it('routes each copied custom-record workspace through main rather than generic LIMS registration', async () => {
    const manifest = serializeNativeWorkspaceManifest({
      schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
      entities: ['a', 'b'].map((id) => ({
        id,
        type: 'record',
        name: `Record ${id}`,
        placement: {
          kind: 'catalog-record',
          parentRelativePath: '',
          displayName: `Record ${id}`,
          catalogType: 'record',
          presentationKind: 'record',
        },
        lims: {
          kind: 'imported_reagent',
          name: `Record ${id}`,
          registrationStatus: 'registered',
          schemaRevisionId: 'reagent-v1',
          schemaSnapshot: {
            schemaId: 'reagent-schema',
            schemaRevisionId: 'reagent-v1',
            version: 1,
            name: 'imported_reagent',
            displayName: 'Reagent',
            baseKind: 'record',
            fields: [
              { key: 'amount', label: 'Amount', type: 'number' },
              { key: 'parent', label: 'Parent', type: 'record_relationship' },
            ],
          },
          fields: {
            amount: id === 'a' ? 0 : 12.5,
            ...(id === 'a'
              ? {
                  parent: {
                    sourceTargetId: 'bfi_RECORD02',
                    destinationEntityId: 'b',
                    relationType: 'parent',
                    label: 'Parent',
                    resolution: 'exact',
                  },
                }
              : {}),
          },
        },
      })),
      links: [],
    });
    const register = vi.spyOn(platform().lims, 'registerEntity');
    const main = vi.spyOn(platform().workspace, 'reconcileNativeRecords').mockResolvedValue(2);
    const copiedIds: string[] = [];
    for (const root of ['/registry-copy-one', '/registry-copy-two']) {
      setFileTree(root, []);
      setMockFileContent(`${root}/.forge/catalog.json`, manifest);
      const result = await reconcileWorkspaceRoot(root);
      expect(result.errors).toEqual([]);
      const scope = await resolveWorkspaceScope(root);
      const id = scopedProjectionId(scope, 'a');
      copiedIds.push(id);
      expect(main).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: root }));
      expect(register).not.toHaveBeenCalled();
    }
    expect(copiedIds[0]).not.toBe(copiedIds[1]);
  });

  it('marks a missing v2 direct file as missing without regenerating it', async () => {
    const root = '/copied-v2-missing';
    setFileTree(root, []);
    setMockFileContent(
      `${root}/.forge/catalog.json`,
      serializeNativeWorkspaceManifest({
        schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
        entities: [
          {
            id: 'missing-sequence',
            type: 'sequence',
            name: 'Missing sequence',
            placement: {
              kind: 'file',
              relativePath: 'Sequences/missing.gb',
              fileKind: 'genbank',
            },
          },
        ],
        links: [],
      })
    );
    const writeTextFile = vi.spyOn(MockFsModule, 'writeTextFile');

    const result = await reconcileWorkspaceRoot(root);
    const entity = await getCatalogEntity(
      scopedProjectionId(await resolveWorkspaceScope(root), 'missing-sequence')
    );
    const file = await getCatalogFileForPath(`${root}/Sequences/missing.gb`);

    expect(result.errors).toEqual([]);
    expect(entity?.status).toBe('missing');
    expect(file?.status).toBe('missing');
    expect(writeTextFile).not.toHaveBeenCalledWith(
      `${root}/Sequences/missing.gb`,
      expect.anything()
    );
  });

  it('streams new sequence hashes through the platform boundary without renderer text encoding', async () => {
    setFileTree('/lab', [{ name: 'large.gb', isDirectory: false }]);
    setMockFileContent('/lab/large.gb', 'LOCUS large 8 bp DNA\nORIGIN\n        1 acgtacgt\n//\n');
    const readTextFile = vi.spyOn(MockFsModule, 'readTextFile');
    const sha256File = vi.spyOn(MockFsModule, 'sha256File');

    await reconcileWorkspaceRoot('/lab');

    expect(sha256File).toHaveBeenCalledWith('/lab/large.gb');
    expect(readTextFile).not.toHaveBeenCalledWith('/lab/large.gb');
    await expect(getCatalogFileForPath('/lab/large.gb')).resolves.toMatchObject({
      content_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    readTextFile.mockRestore();
    sha256File.mockRestore();
  });

  it('rejects expected oversize move candidates before invoking the hash IPC boundary', async () => {
    setFileTree('/lab', [{ name: 'oversize.gb', isDirectory: false }]);
    setMockFileContent('/lab/oversize.gb', 'LOCUS oversize');
    const stat = vi.spyOn(MockFsModule, 'stat').mockResolvedValue({
      size: HARD_CAP_BYTES + 1,
      mtime: 1,
      isFile: true,
      isDirectory: false,
    });
    const sha256File = vi.spyOn(MockFsModule, 'sha256File');

    const result = await reconcileWorkspaceRoot('/lab');

    expect(sha256File).not.toHaveBeenCalled();
    expect(result.registered).toBe(1);
    await expect(getCatalogFileForPath('/lab/oversize.gb')).resolves.toMatchObject({
      content_hash: null,
    });
    stat.mockRestore();
    sha256File.mockRestore();
  });

  it('does not add a second filesystem walk for move detection', async () => {
    setFileTree('/lab', [{ name: 'nested', isDirectory: true }]);
    setFileTree('/lab/nested', [{ name: 'sequence.gb', isDirectory: false }]);
    setMockFileContent('/lab/nested/sequence.gb', 'LOCUS sequence 4 bp DNA\nORIGIN\n1 acgt\n//');
    const readDir = vi.spyOn(MockFsModule, 'readDir');

    const result = await reconcileWorkspaceRoot('/lab');

    expect(result.errors).toEqual([]);
    expect(result.registered).toBe(2);

    expect(readDir.mock.calls.map(([path]) => path)).toEqual([
      '/lab',
      '/lab/nested',
      '/lab',
      '/lab/nested',
    ]);
    readDir.mockRestore();
  });

  it('applies the Electron main-process projection without walking the renderer filesystem', async () => {
    const readDir = vi.spyOn(MockFsModule, 'readDir');
    const discovery = vi.spyOn(platform().workspace, 'discoverArtifacts').mockResolvedValue({
      primerArtifactPaths: [],
      entityArtifactPaths: [],
      scannedEntries: 250,
      errors: [],
      catalogProjection: {
        scannedFileCount: 200,
        visibleFileCount: 199,
        missingPaths: [],
        candidates: [
          {
            path: '/lab/sequence.gb',
            fileKind: 'genbank',
            sizeBytes: 42,
            modifiedAt: 100,
            contentHash: `sha256:${'a'.repeat(64)}`,
          },
        ],
      },
    });

    const result = await reconcileWorkspaceRoot('/lab');

    expect(readDir).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 200, visibleFileCount: 199, registered: 1 });
    await expect(getCatalogFileForPath('/lab/sequence.gb')).resolves.toMatchObject({
      content_hash: `sha256:${'a'.repeat(64)}`,
    });
    discovery.mockRestore();
    readDir.mockRestore();
  });

  it.each([
    { route: 'main projection', manifest: false, extension: 'faa', type: 'protein' as const },
    { route: 'filesystem walk', manifest: false, extension: 'faa', type: 'protein' as const },
    { route: 'main projection', manifest: true, extension: 'fasta', type: 'protein' as const },
    { route: 'filesystem walk', manifest: true, extension: 'fasta', type: 'protein' as const },
    { route: 'main projection', manifest: true, extension: 'faa', type: 'sequence' as const },
    { route: 'filesystem walk', manifest: true, extension: 'faa', type: 'sequence' as const },
    { route: 'main projection', manifest: true, extension: 'fna', type: 'protein' as const },
    { route: 'filesystem walk', manifest: true, extension: 'fna', type: 'protein' as const },
  ])(
    'preserves $type identity through $route for $extension manifest=$manifest',
    async ({ route, manifest, extension, type }) => {
      const rawId = `${type}-reporter`;
      const nativeName = type === 'protein' ? 'Reporter protein' : 'Reporter DNA';
      const path = `/lab/Reporter.${extension}`;
      setFileTree('/lab', [{ name: `Reporter.${extension}`, isDirectory: false }]);
      setMockFileContent(path, type === 'protein' ? '>Reporter\nMKT\n' : '>Reporter\nACGTACGT\n');
      if (manifest)
        setMockFileContent(
          '/lab/.forge/catalog.json',
          serializeNativeWorkspaceManifest({
            schema: NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
            entities: [
              {
                id: rawId,
                type,
                name: nativeName,
                placement: {
                  kind: 'file',
                  relativePath: `Reporter.${extension}`,
                  fileKind: 'fasta',
                },
              },
            ],
            links: [],
          })
        );
      if (route === 'main projection')
        vi.spyOn(platform().workspace, 'discoverArtifacts').mockResolvedValue({
          primerArtifactPaths: [],
          entityArtifactPaths: [],
          scannedEntries: 1,
          errors: [],
          catalogProjection: {
            scannedFileCount: 1,
            visibleFileCount: 1,
            missingPaths: [],
            candidates: [
              {
                path,
                fileKind: 'fasta',
                sizeBytes: 14,
                modifiedAt: 100,
                contentHash: `sha256:${'a'.repeat(64)}`,
              },
            ],
          },
        });
      const first = await reconcileWorkspaceRoot('/lab');
      expect(first.errors).toEqual([]);
      const before = await getCatalogFileForPath(path);
      const entity = await getCatalogEntityForFilePath(path);
      expect(entity).toMatchObject({
        type,
        name: manifest ? nativeName : `Reporter.${extension}`,
      });
      if (manifest) expect(entity!.id).toBe(await scopedNb(rawId));
      const second = await reconcileWorkspaceRoot('/lab');
      expect(second.errors).toEqual([]);
      expect(await getCatalogFileForPath(path)).toMatchObject({
        entity_id: before!.entity_id,
        object_uuid: before!.object_uuid,
        status: 'current',
      });
      expect(getMockData('catalog_entities')).toHaveLength(1);
    }
  );

  it.each(['main projection', 'filesystem walk'])(
    'borrows the existing workspace lease when resolving notebook packages through %s',
    async (path) => {
      setFileTree('/lab', [{ name: 'Notebook', isDirectory: true }]);
      setMockFileContent(
        '/lab/Notebook/.forge/notebook.json',
        JSON.stringify({
          schema: 'waypoint.notebook.v1',
          kind: 'notebook',
          id: 'lease-notebook',
          title: 'Notebook',
          content: { type: 'doc', content: [] },
        })
      );
      const originalMigration = platform().fs.migrateNotebookPackageAtPathInMain;
      const migrate = vi.fn<NonNullable<typeof originalMigration>>(async (input) => {
        if (input.mutationToken !== 'outer-reconcile-token')
          throw new Error('Nested notebook mutation did not borrow its owner lease');
        return null;
      });
      platform().fs.migrateNotebookPackageAtPathInMain = migrate;
      if (path === 'main projection') {
        vi.spyOn(platform().workspace, 'discoverArtifacts').mockResolvedValue({
          primerArtifactPaths: [],
          entityArtifactPaths: [],
          scannedEntries: 1,
          errors: [],
          catalogProjection: {
            scannedFileCount: 1,
            visibleFileCount: 1,
            missingPaths: [],
            candidates: [
              {
                path: '/lab/Notebook',
                fileKind: 'waypoint-notebook',
                sizeBytes: 100,
                modifiedAt: 1,
                contentHash: null,
              },
            ],
          },
        });
      }
      try {
        const result = await reconcileWorkspaceRoot('/lab', {
          mutationToken: 'outer-reconcile-token',
        });
        expect(result.errors).toEqual([]);
        expect(migrate).toHaveBeenCalledWith(
          expect.objectContaining({
            packageRoot: '/lab/Notebook',
            mutationToken: 'outer-reconcile-token',
          })
        );
      } finally {
        platform().fs.migrateNotebookPackageAtPathInMain = originalMigration;
      }
    }
  );

  it('projects supported coordinate files as structure catalog entities', async () => {
    setFileTree('/lab', [
      { name: '1FS0.pdb', isDirectory: false },
      { name: '1FS0.cif', isDirectory: false },
      { name: '1FS0.bcif', isDirectory: false },
    ]);
    setMockFileContent('/lab/1FS0.pdb', 'HEADER TEST\nATOM 1\nEND\n');
    setMockFileContent('/lab/1FS0.cif', 'data_1fs0\n_atom_site.id 1\n#\n');
    setMockFileContent('/lab/1FS0.bcif', 'binary-placeholder');

    const result = await reconcileWorkspaceRoot('/lab');

    expect(result.errors).toEqual([]);
    expect(result.registered).toBe(3);
    await expect(getCatalogEntityForFilePath('/lab/1FS0.pdb')).resolves.toMatchObject({
      type: 'structure',
    });
    await expect(getCatalogEntityForFilePath('/lab/1FS0.cif')).resolves.toMatchObject({
      type: 'structure',
    });
    await expect(getCatalogEntityForFilePath('/lab/1FS0.bcif')).resolves.toMatchObject({
      type: 'structure',
    });
  });

  it('counts only user-visible files in the committed filesystem projection', async () => {
    setFileTree('/lab', [
      { name: 'seq.gb', isDirectory: false },
      { name: '.hidden.txt', isDirectory: false },
      { name: 'seq.gb.waypoint.json', isDirectory: false },
    ]);
    setMockFileContent('/lab/seq.gb', 'LOCUS seq');
    setMockFileContent('/lab/.hidden.txt', 'hidden');
    setMockFileContent('/lab/seq.gb.waypoint.json', '{}');

    const result = await reconcileWorkspaceRoot('/lab');

    expect(result.scanned).toBe(2);
    expect(result.visibleFileCount).toBe(1);
  });

  it('holds one renderer mutation capability across managed Git catalog reconciliation', async () => {
    setMockFileContent('/lab/.dnaforge-workspace.json', '{}');
    const events: string[] = [];
    const beginWorkspaceMutation = vi
      .spyOn(platform().fs, 'beginWorkspaceMutation')
      .mockImplementation(async (workspaceRoot, parentToken) => {
        events.push(`begin:${workspaceRoot}:${parentToken ?? 'root'}`);
        return 'managed-reconcile-token';
      });
    const endWorkspaceMutation = vi
      .spyOn(platform().fs, 'endWorkspaceMutation')
      .mockImplementation(async (token) => {
        events.push(`end:${token}`);
      });
    const indexManagedCatalogHead = vi
      .spyOn(platform().workspace, 'indexManagedCatalogHead')
      .mockImplementation(async (request) => {
        events.push(`index:${request.mutationToken ?? 'missing'}`);
        return {
          headCommit: 'a'.repeat(40),
          files: [],
          scannedFileCount: 0,
          visibleFileCount: 0,
        };
      });

    const result = await reconcileWorkspaceRoot('/lab', {
      waitForMutationAvailability: true,
    });

    expect(result.errors).toEqual([]);
    expect(beginWorkspaceMutation).toHaveBeenCalledWith('/lab', undefined, true);
    expect(indexManagedCatalogHead).toHaveBeenCalledWith({
      repoPath: '/lab',
      preserveRelPaths: [],
      healWorkingTree: undefined,
      mutationToken: 'managed-reconcile-token',
    });
    expect(endWorkspaceMutation).toHaveBeenCalledWith('managed-reconcile-token');
    expect(events).toEqual([
      'begin:/lab:root',
      'index:managed-reconcile-token',
      'end:managed-reconcile-token',
    ]);
  });

  it('does not write Project Memory files during passive native artifact discovery', async () => {
    setFileTree('/lab', [{ name: 'Recovered.wpnote.json', isDirectory: false }]);
    setMockFileContent(
      '/lab/Recovered.wpnote.json',
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'page-passive-recovered',
        title: 'Passive Recovered',
        content: { type: 'doc', content: [] },
      })
    );

    const result = await reconcileWorkspaceRoot('/lab');

    expect(result.errors).toEqual([]);
    expect(result.registered).toBe(1);
    expect(await getCatalogEntityForFilePath('/lab/Recovered.wpnote.json')).toMatchObject({
      id: await scopedNb('page-passive-recovered'),
      type: 'notebook',
    });
    expectNoProjectMemoryFilesWritten('/lab');
  });

  it('does NOT flag a notebook PACKAGE binding as missing on re-reconcile (seen-accounting; A1)', async () => {
    setFileTree('/lab', [{ name: 'My Notebook', isDirectory: true }]);
    setMockFileContent(
      '/lab/My Notebook/.forge/notebook.json',
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'page-pkg',
        title: 'My Notebook',
        content: { type: 'doc', content: [] },
      })
    );

    const first = await reconcileWorkspaceRoot('/lab');
    expect(first.errors).toEqual([]);
    expect(first.registered).toBe(1);
    expect(await getCatalogEntityForFilePath('/lab/My Notebook')).toMatchObject({
      id: await scopedNb('page-pkg'),
      type: 'notebook',
    });

    const second = await reconcileWorkspaceRoot('/lab');
    expect(second.missing).toBe(0);
    expect(await getCatalogFileForPath('/lab/My Notebook')).toMatchObject({ status: 'current' });
  });

  it('treats a notebook package at the workspace root as atomic and suppresses nested plasmids', async () => {
    setFileTree('/lab', [{ name: 'Nested plasmid', isDirectory: true }]);
    setFileTree('/lab/Nested plasmid', [{ name: 'Nested plasmid.gb', isDirectory: false }]);
    setMockFileContent(
      '/lab/.forge/notebook.json',
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'root-notebook',
        title: 'Root Notebook',
        content: { type: 'doc', content: [] },
      })
    );
    setMockFileContent(
      '/lab/Nested plasmid/.forge/plasmid.json',
      JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'nested-plasmid',
        name: 'Nested plasmid',
        product: { file: 'Nested plasmid.gb' },
      })
    );
    setMockFileContent(
      '/lab/Nested plasmid/Nested plasmid.gb',
      'LOCUS       Nested_plasmid 4 bp DNA circular\nORIGIN\n        1 acgt\n//\n'
    );

    const result = await reconcileWorkspaceRoot('/lab');

    expect(result.errors).toEqual([]);
    expect(await getCatalogEntityForFilePath('/lab')).toMatchObject({
      id: await scopedNb('root-notebook'),
      type: 'notebook',
    });
    expect(await getCatalogFileForPath('/lab/Nested plasmid/Nested plasmid.gb')).toBeNull();
  });

  it('reconstructs a native protocol package when the package is the workspace root', async () => {
    setFileTree('/lab', []);
    setMockFileContent(
      '/lab/.forge/protocol.json',
      JSON.stringify({
        schema: 'dnaforge.protocol.v1',
        kind: 'protocol',
        id: 'root-protocol',
        title: 'Root protocol',
        editable: true,
        provenance: {},
        overview: 'A native protocol package.',
        materials: [],
        steps: [],
        references: [],
        attachments: [],
        updatedAt: '2026-08-16T01:00:00.000Z',
      })
    );

    const result = await reconcileWorkspaceRoot('/lab');

    expect(result.errors).toEqual([]);
    expect(await getCatalogEntityForFilePath('/lab/.forge/protocol.json')).toMatchObject({
      id: await scopedNb('root-protocol'),
      type: 'protocol',
      name: 'Root protocol',
    });
  });

  it('marks previously-known files missing without deleting identity', async () => {
    setFileTree('/lab', [{ name: 'seq.gb', isDirectory: false }]);
    setMockFileContent('/lab/seq.gb', 'LOCUS       seq 1 bp DNA\nORIGIN\n        1 a\n//');
    await reconcileWorkspaceRoot('/lab');

    setFileTree('/lab', []);
    const result = await reconcileWorkspaceRoot('/lab');

    expect(result.missing).toBe(1);
    expect(await getCatalogFileForPath('/lab/seq.gb')).toMatchObject({
      status: 'missing',
    });
    expect(getMockData('catalog_entities')).toHaveLength(1);
  });
});

describe('reconcileWorkspaceRoot — plasmid packages ', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
  });

  function seedPackage(withPrimers: boolean) {
    setFileTree('/ws', [{ name: 'pMyConstruct', isDirectory: true }]);
    setFileTree(
      '/ws/pMyConstruct',
      withPrimers
        ? [
            { name: 'pMyConstruct.gb', isDirectory: false },
            { name: 'primers', isDirectory: true },
          ]
        : [{ name: 'pMyConstruct.gb', isDirectory: false }]
    );
    if (withPrimers) {
      setFileTree('/ws/pMyConstruct/primers', [
        { name: 'pMyConstruct.primers.fasta', isDirectory: false },
      ]);
      setMockFileContent('/ws/pMyConstruct/primers/pMyConstruct.primers.fasta', '>p\nAAAA\n');
    }
    setMockFileContent(
      '/ws/pMyConstruct/pMyConstruct.gb',
      'LOCUS pMyConstruct 4 bp DNA circular\n//\n'
    );

    setMockFileContent(
      '/ws/pMyConstruct/.forge/plasmid.json',
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'package-pMyConstruct',
          name: 'pMyConstruct',
          product: { file: 'pMyConstruct.gb' },
        })
      )
    );
  }

  it('projects just-written packages and ordinary sequences before their publication commit', async () => {
    seedPackage(true);
    setFileTree('/ws', [
      { name: 'pMyConstruct', isDirectory: true },
      { name: 'uncommitted.gb', isDirectory: false },
    ]);
    setMockFileContent(
      '/ws/uncommitted.gb',
      'LOCUS pending 4 bp DNA linear\nORIGIN\n 1 atgc\n//\n'
    );
    await reconcileWorkspaceRoot('/ws');
    const sequenceBefore = await getCatalogFileForPath('/ws/uncommitted.gb');
    setMockFileContent('/ws/.dnaforge-workspace.json', '{}');
    const head = vi.spyOn(platform().workspace, 'indexManagedCatalogHead').mockResolvedValue({
      headCommit: 'a'.repeat(40),
      files: [],
      scannedFileCount: 0,
      visibleFileCount: 0,
    });
    try {
      const result = await reconcileWorkspaceRoot('/ws', {
        catalogSource: 'working-tree',
        healManagedHead: false,
      });
      expect(result.errors).toEqual([]);
      expect(result.missing).toBe(0);
      expect(head).not.toHaveBeenCalled();
      expect(await getCatalogFileForPath('/ws/pMyConstruct')).toMatchObject({
        entity_id: 'package-pMyConstruct',
        file_kind: 'waypoint-sequence',
        status: 'current',
      });
      expect(await getCatalogFileForPath('/ws/uncommitted.gb')).toMatchObject({
        entity_id: sequenceBefore!.entity_id,
        status: 'current',
      });
    } finally {
      head.mockRestore();
    }
  });

  it('indexes the package identity but not its GenBank payload or primer order sheet', async () => {
    seedPackage(true);

    await reconcileWorkspaceRoot('/ws');

    expect(await getCatalogFileForPath('/ws/pMyConstruct')).toMatchObject({
      entity_id: 'package-pMyConstruct',
      file_kind: 'waypoint-sequence',
    });
    expect(await getCatalogFileForPath('/ws/pMyConstruct/pMyConstruct.gb')).toBeNull();
    expect(
      await getCatalogFileForPath('/ws/pMyConstruct/primers/pMyConstruct.primers.fasta')
    ).toBeNull();
    expect(await getCatalogFileForPath('/ws/pMyConstruct/primers')).toBeNull();
  });

  async function withNativeLegacyPackage(
    legacy: 'file' | 'design',
    assertProjection: (root: string) => Promise<void>
  ): Promise<void> {
    const fixture = createFileTestDb('legacy-package-reconcile');
    const { db } = fixture;
    ensureSchema(db, fixture.dbPath);
    const root = join(realpathSync(fixture.tmpDir), 'workspace');
    const packageRoot = join(root, 'pMyConstruct');
    mkdirSync(join(packageRoot, '.forge'), { recursive: true });
    const product = 'LOCUS pMyConstruct 4 bp DNA circular\nORIGIN\n        1 atgc\n//\n';
    const marker = serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: 'package-pMyConstruct',
        name: 'pMyConstruct',
        product: { file: 'pMyConstruct.gb' },
        ...(legacy === 'design'
          ? {
              assembly: {
                accepted: {
                  designId: 'legacy-design',
                  acceptedAssemblyVersionId: 'package-pMyConstruct',
                },
              },
            }
          : {}),
      })
    );
    writeFileSync(join(packageRoot, 'pMyConstruct.gb'), product);
    writeFileSync(join(packageRoot, '.forge/plasmid.json'), marker);
    const spies = [
      vi
        .spyOn(platform().db, 'select')
        .mockImplementation(
          async <T>(sql: string, params?: unknown[]) => db.prepare(sql).all(...(params ?? [])) as T
        ),
      vi.spyOn(platform().db, 'execute').mockImplementation(async (sql, params) => {
        const result = db.prepare(sql).run(...(params ?? []));
        return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
      }),
      vi
        .spyOn(platform().db, 'ensureWorkspaceOwner')
        .mockImplementation(async (path, access, discovery) =>
          ensureWorkspaceOwnerInDb(db, path, access, discovery)
        ),
      vi
        .spyOn(platform().db, 'registerCatalogEntity')
        .mockImplementation(async (input) => registerCatalogEntityInDb(db, input)),
      vi
        .spyOn(platform().db, 'registerWorkspaceFile')
        .mockImplementation(async (input) => registerWorkspaceFileInDb(db, input)),
      vi.spyOn(platform().db, 'bindCatalogEntityFile').mockImplementation(async (input) => {
        const witness = catalogFileBindingAdmissionWitnessInDb(db, input);
        return bindCatalogEntityFileInDb(db, input, undefined, witness);
      }),
      vi
        .spyOn(platform().db, 'refreshCatalogFileFingerprints')
        .mockImplementation(async (files) => refreshCatalogFileFingerprintsInDb(db, files)),
      vi
        .spyOn(platform().db, 'setCatalogFileState')
        .mockImplementation(async (path, status, reason) =>
          setCatalogFileStateInDb(db, path, status, reason)
        ),
      vi
        .spyOn(platform().db, 'linkCatalogEntities')
        .mockImplementation(async (input) => linkCatalogEntitiesInDb(db, input)),
      vi.spyOn(platform().fs, 'exists').mockImplementation(async (path) => existsSync(path)),
      vi
        .spyOn(platform().fs, 'readTextFile')
        .mockImplementation(async (path) => readFileSync(path, 'utf8')),
      vi
        .spyOn(platform().fs, 'readFile')
        .mockImplementation(async (path) => new Uint8Array(readFileSync(path))),
      vi.spyOn(platform().fs, 'readDir').mockImplementation(async (path) =>
        readdirSync(path, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          children: [],
        }))
      ),
      vi.spyOn(platform().fs, 'stat').mockImplementation(async (path) => {
        const stat = statSync(path);
        return {
          size: stat.size,
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
          mtime: stat.mtimeMs,
          ctime: stat.ctimeMs,
        };
      }),
      vi
        .spyOn(platform().fs, 'sha256File')
        .mockImplementation(
          async (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
        ),
    ];
    try {
      const id = legacy === 'file' ? 'legacy-directory' : 'legacy-design';
      await registerCatalogEntity({
        id,
        type: legacy,
        name: 'pMyConstruct',
        locator: `entity://${legacy}/${id}`,
        storageType: legacy === 'file' ? 'file' : 'localStorage',
        workspaceRoot: root,
      });
      await bindCatalogEntityToFile({
        entityId: id,
        path: packageRoot,
        fileKind: legacy === 'file' ? 'file' : 'waypoint-plasmid',
        workspaceRoot: root,
      });
      const before = await getCatalogFileForPath(packageRoot);
      await assertProjection(root);
      expect(await getCatalogFileForPath(packageRoot)).toMatchObject({
        id: before!.id,
        object_uuid: before!.object_uuid,
      });
      expect(readFileSync(join(packageRoot, 'pMyConstruct.gb'), 'utf8')).toBe(product);
      expect(readFileSync(join(packageRoot, '.forge/plasmid.json'), 'utf8')).toBe(marker);
    } finally {
      for (const spy of spies.reverse()) spy.mockRestore();
      fixture.cleanup();
    }
  }

  it('replaces a legacy generic-directory binding with the package identity', async () => {
    await withNativeLegacyPackage('file', async (root) => {
      const result = await reconcileWorkspaceRoot(root);
      expect(result.errors).toEqual([]);
      expect(await getCatalogFileForPath(`${root}/pMyConstruct`)).toMatchObject({
        entity_id: 'package-pMyConstruct',
        file_kind: 'waypoint-sequence',
        status: 'current',
      });
    });
  });

  it('migrates an accepted package off its legacy design binding and preserves lineage', async () => {
    await withNativeLegacyPackage('design', async (root) => {
      const result = await reconcileWorkspaceRoot(root);
      expect(result.errors).toEqual([]);
      expect(await getCatalogFileForPath(`${root}/pMyConstruct`)).toMatchObject({
        entity_id: 'package-pMyConstruct',
        file_kind: 'waypoint-sequence',
        status: 'current',
      });
      expect(await getCatalogLinksForEntity('legacy-design')).toEqual([
        expect.objectContaining({
          source_entity_id: 'legacy-design',
          relation: 'produces',
          target_entity_id: 'package-pMyConstruct',
          confidence: 'confirmed',
        }),
      ]);
    });
  });

  it('does not steal a package root from an unrelated scientific entity', async () => {
    seedPackage(false);
    await registerCatalogEntity({
      id: 'unrelated-design',
      type: 'design',
      name: 'Different design',
      locator: 'entity://design/unrelated-design',
      storageType: 'localStorage',
      workspaceRoot: '/ws',
    });
    await bindCatalogEntityToFile({
      entityId: 'unrelated-design',
      path: '/ws/pMyConstruct',
      fileKind: 'waypoint-plasmid',
      workspaceRoot: '/ws',
    });

    const result = await reconcileWorkspaceRoot('/ws');

    expect(result.errors).toEqual([
      expect.objectContaining({
        message: 'Sequence package root is already bound to another entity: /ws/pMyConstruct',
      }),
    ]);
    expect(await getCatalogFileForPath('/ws/pMyConstruct')).toMatchObject({
      entity_id: 'unrelated-design',
    });
  });

  it('opens a catalog-selected package through its GenBank product instead of the directory', async () => {
    seedPackage(false);

    await reconcileWorkspaceRoot('/ws');

    await expect(
      resolveExactNativeCatalogDestination({
        workspaceRoot: '/ws',
        entityId: 'package-pMyConstruct',
      })
    ).resolves.toMatchObject({
      entityId: 'package-pMyConstruct',
      entityType: 'sequence',
      locator: {
        kind: 'workspace_path',
        absolutePath: '/ws/pMyConstruct/pMyConstruct.gb',
        relativePath: 'pMyConstruct/pMyConstruct.gb',
        tabType: 'sequence',
      },
    });
  });

  it('does not offer a package support FASTA to filesystem move detection', async () => {
    seedPackage(true);
    const sha256File = vi.spyOn(MockFsModule, 'sha256File');

    await reconcileWorkspaceRoot('/ws');

    expect(sha256File).not.toHaveBeenCalledWith('/ws/pMyConstruct/pMyConstruct.gb');
    expect(sha256File).not.toHaveBeenCalledWith(
      '/ws/pMyConstruct/primers/pMyConstruct.primers.fasta'
    );
    sha256File.mockRestore();
  });

  it('recognizes a package at the workspace ROOT', async () => {
    setFileTree('/ws', [
      { name: 'pUC19.gb', isDirectory: false },
      { name: 'primers', isDirectory: true },
    ]);
    setFileTree('/ws/primers', [{ name: 'pUC19.primers.fasta', isDirectory: false }]);
    setMockFileContent('/ws/pUC19.gb', 'LOCUS pUC19 4 bp DNA circular\n//\n');
    setMockFileContent('/ws/primers/pUC19.primers.fasta', '>p\nAAAA\n');
    setMockFileContent(
      '/ws/.forge/plasmid.json',
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'package-root',
          name: 'pUC19',
          product: { file: 'pUC19.gb' },
        })
      )
    );

    await reconcileWorkspaceRoot('/ws');

    expect(await getCatalogFileForPath('/ws')).toMatchObject({
      entity_id: 'package-root',
      file_kind: 'waypoint-sequence',
    });
    expect(await getCatalogFileForPath('/ws/pUC19.gb')).toBeNull();
    expect(await getCatalogFileForPath('/ws/primers/pUC19.primers.fasta')).toBeNull();
  });

  it('keeps a matured plasmid binding current when the package is the workspace ROOT', async () => {
    setFileTree('/ws', [{ name: 'pUC19.gb', isDirectory: false }]);
    setMockFileContent('/ws/pUC19.gb', 'LOCUS pUC19 4 bp DNA circular\n//\n');
    setMockFileContent(
      '/ws/.forge/plasmid.json',
      JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'root-plasmid',
        name: 'pUC19',
        product: { file: 'pUC19.gb' },
      })
    );
    await registerCatalogEntity({
      id: 'root-plasmid',
      type: 'construct',
      name: 'pUC19',
      locator: 'waypoint://construct/root-plasmid',
      storageType: 'file',
      workspaceRoot: '/ws',
    });
    await bindCatalogEntityToFile({
      entityId: 'root-plasmid',
      path: '/ws',
      fileKind: 'waypoint-sequence',
      workspaceRoot: '/ws',
    });

    const result = await reconcileWorkspaceRoot('/ws');

    expect(result.missing).toBe(0);
    expect(await getCatalogFileForPath('/ws')).toMatchObject({
      entity_id: 'root-plasmid',
      file_kind: 'waypoint-sequence',
      status: 'current',
    });
  });

  it('finds an inner package below outer support directories without indexing loose support files', async () => {
    setFileTree('/ws', [{ name: 'Outer', isDirectory: true }]);
    setFileTree('/ws/Outer', [
      { name: 'Outer.gb', isDirectory: false },
      { name: 'assets', isDirectory: true },
    ]);
    setFileTree('/ws/Outer/assets', [
      { name: 'Inner', isDirectory: true },
      { name: 'loose.fasta', isDirectory: false },
    ]);
    setFileTree('/ws/Outer/assets/Inner', [{ name: 'Inner.gb', isDirectory: false }]);
    setMockFileContent(
      '/ws/Outer/.forge/plasmid.json',
      JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'outer-package',
        name: 'Outer',
        product: { file: 'Outer.gb' },
      })
    );
    setMockFileContent('/ws/Outer/Outer.gb', 'LOCUS Outer 4 bp DNA circular\n//\n');
    setMockFileContent(
      '/ws/Outer/assets/Inner/.forge/plasmid.json',
      JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'inner-package',
        name: 'Inner',
        product: { file: 'Inner.gb' },
      })
    );
    setMockFileContent('/ws/Outer/assets/Inner/Inner.gb', 'LOCUS Inner 4 bp DNA circular\n//\n');
    setMockFileContent('/ws/Outer/assets/loose.fasta', '>support\nAAAA\n');

    await reconcileWorkspaceRoot('/ws');

    expect(await getCatalogFileForPath('/ws/Outer')).toMatchObject({
      entity_id: 'outer-package',
      file_kind: 'waypoint-sequence',
    });
    expect(await getCatalogFileForPath('/ws/Outer/assets/Inner')).toMatchObject({
      entity_id: 'inner-package',
      file_kind: 'waypoint-sequence',
    });
    expect(await getCatalogFileForPath('/ws/Outer/Outer.gb')).toBeNull();
    expect(await getCatalogFileForPath('/ws/Outer/assets/Inner/Inner.gb')).toBeNull();
    expect(await getCatalogFileForPath('/ws/Outer/assets/loose.fasta')).toBeNull();
  });

  it('reconciling twice does not duplicate the plasmid', async () => {
    seedPackage(false);

    await reconcileWorkspaceRoot('/ws');
    const first = await getCatalogFileForPath('/ws/pMyConstruct');
    await reconcileWorkspaceRoot('/ws');
    const second = await getCatalogFileForPath('/ws/pMyConstruct');

    expect(first).not.toBeNull();
    expect(second?.entity_id).toBe(first?.entity_id);
  });
});

describe('workspace reconcile — provider identities ', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
  });

  const INTENDED = 'seq_DEMOSQ0005';
  const TWIN = 'seq_DEMOSQ0004';

  function manifestWithTwins() {
    return serializeNativeWorkspaceManifest({
      schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA,
      entities: [
        {
          id: 'sequence-intended',
          type: 'sequence',

          name: 'Controlled Corpus Sequence',
          path: 'intended.gb',
          fileKind: 'genbank',
          sourceIdentities: [
            {
              provider: 'benchling',
              stableObjectId: INTENDED,
              objectClass: 'sequence',
              bindingKind: 'observed',
            },
          ],
        },
        {
          id: 'sequence-twin',
          type: 'sequence',
          name: 'Controlled Corpus Sequence',
          path: 'twin.gb',
          fileKind: 'genbank',
          sourceIdentities: [
            {
              provider: 'benchling',
              stableObjectId: TWIN,
              objectClass: 'sequence',
              bindingKind: 'observed',
            },
          ],
        },
      ],
      links: [],
    });
  }

  async function seedWorkspaceWithTwins() {
    setFileTree('/lab', [
      { name: 'intended.gb', isDirectory: false },
      { name: 'twin.gb', isDirectory: false },
    ]);
    const genbank = 'LOCUS x 4 bp DNA linear\nORIGIN\n        1 acgt\n//';
    setMockFileContent('/lab/intended.gb', genbank);

    setMockFileContent('/lab/twin.gb', genbank);
    setMockFileContent('/lab/.forge/catalog.json', manifestWithTwins());
  }

  async function bindingRows() {
    return platform().db.select<
      Array<{ stable_object_id: string; entity_id: string; binding_kind: string }>
    >('SELECT stable_object_id, entity_id, binding_kind FROM catalog_provider_bindings');
  }

  it('rebuilds provider bindings in a fresh database from the manifest alone', async () => {
    await seedWorkspaceWithTwins();

    const result = await reconcileWorkspaceRoot('/lab');

    expect(result.errors).toEqual([]);
    expect(result.nativeManifestProviderBindings).toBe(2);

    const scope = await resolveWorkspaceScope('/lab');
    const rows = await bindingRows();
    const byStableId = new Map(rows.map((row) => [row.stable_object_id, row.entity_id]));
    expect(byStableId.get(INTENDED)).toBe(scopedProjectionId(scope, 'sequence-intended'));
    expect(byStableId.get(TWIN)).toBe(scopedProjectionId(scope, 'sequence-twin'));

    expect(byStableId.get(INTENDED)).not.toBe(byStableId.get(TWIN));
  });

  it('creates no duplicate bindings when reconcile runs again', async () => {
    await seedWorkspaceWithTwins();
    await reconcileWorkspaceRoot('/lab');
    await reconcileWorkspaceRoot('/lab');

    expect(await bindingRows()).toHaveLength(2);
  });

  it('keeps indexing healthy files when a manifest identity is malformed', async () => {
    setFileTree('/lab', [{ name: 'healthy.gb', isDirectory: false }]);
    setMockFileContent('/lab/healthy.gb', 'LOCUS healthy 1 bp DNA\nORIGIN\n        1 a\n//');
    setMockFileContent(
      '/lab/.forge/catalog.json',
      JSON.stringify({
        schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA,
        entities: [
          {
            id: 'sequence-bad',
            type: 'sequence',
            name: 'Bad identity',
            path: 'healthy.gb',
            fileKind: 'genbank',

            sourceIdentities: [
              {
                provider: 'benchling',
                stableObjectId: 'seq_x',
                objectClass: 'sequence',
                bindingKind: 'observed',
              },
            ],
          },
        ],
        links: [],
      })
    );

    const result = await reconcileWorkspaceRoot('/lab');

    expect(result.errors.length).toBeGreaterThan(0);
    expect(await bindingRows()).toEqual([]);

    await expect(getCatalogEntityForFilePath('/lab/healthy.gb')).resolves.toMatchObject({
      type: 'sequence',
    });
  });
});
