import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ASSEMBLY_REFERENCE_ASSET_GENERATION_V1 } from '../../shared/indexed-genome';
import type {
  PreparedReferenceAssemblyEntryV1,
  ReferenceAssetPreparationProgressUpdateV1,
} from '../../shared/reference-assets-ipc';
import {
  HOSTED_REFERENCE_CATALOG_V1,
  hostedReferenceCatalogEntryV1,
  type HostedReferenceCatalogDefinitionV1,
} from './hosted-reference-catalog';
import {
  createHostedReferenceAssetAuthority,
  type HostedPreparedBundleHydrator,
  type HostedReferencePreparationRunner,
  type HostedReferenceReadinessInspector,
  type HostedReferenceSourceReadinessInspector,
} from './hosted-reference-asset-authority';
import type { HostedReferenceInstallObservation } from './hosted-reference-install-telemetry';
import type { PortablePreparedReferenceHydrationResult } from './portable-prepared-reference-hydrator';
import type { ReferenceAssetWriterLease } from './reference-asset-writer-lock';
import { referenceAssemblyCacheRoot } from '../../features/sequence/reference-catalog';
import { referenceAssetPublicationPath } from '../../features/sequence/reference-asset-publication';
import { referenceContentIdentity } from './reference-content-identity';
import type {
  ReferenceAssetPreparationInput,
  ReferenceAssetPreparationReceipt,
} from './reference-preparation-engine';
import { REFERENCE_PREPARATION_PIPELINE_REVISION } from './reference-preparation-manifest';

const PROJECT_ROOT = resolve(process.cwd(), '../..');
const PUC19_FASTA = join(PROJECT_ROOT, 'test-fixtures/indexed/pUC19/pUC19.fa');
const PUC19_GFF3 = join(PROJECT_ROOT, 'test-fixtures/indexed/pUC19/pUC19.gff3.gz');
const CATALOG_ENTRY: HostedReferenceCatalogDefinitionV1 = {
  id: 'puc19-l09137-2',
  name: 'pUC19',
  organism: 'synthetic DNA construct',
  taxId: 32_630,
  assembly: 'L09137.2',
  description: 'Canonical 2,686 bp circular pUC19 cloning vector with searchable annotations.',
  sources: {
    fasta: {
      relativePath: 'puc19/L09137.2/7267c78e26eef967/pUC19.fa',
      sha256: '7267c78e26eef9671a4fccaf3bf12ff56c27220c90135746164c943be48aad1f',
      byteLength: 2_727,
    },
    annotations: {
      relativePath: 'puc19/L09137.2/dd7cae6d069314763/pUC19.gff3.gz',
      sha256: 'dd7cae6d069314768be3e16f7b023d7ce38f40af4f85f035a6d6bb467a10a3a8',
      byteLength: 592,
    },
  },
  provenance: {
    provider: 'NCBI-derived DNAForge fixture',
    datasetId: 'L09137.2',
    datasetVersion: 'dna-indexer-schema-2',
    sourceUrl: 'https://www.ncbi.nlm.nih.gov/nuccore/L09137.2',
    license: 'NCBI public-domain data',
    attribution: 'National Center for Biotechnology Information (NCBI)',
  },
  contigs: [
    {
      chrom: 'puc19',
      sourceSeqId: 'puc19',
      displayName: 'pUC19',
      lengthBp: 2_686,
      role: 'assembled-molecule',
      aliases: { genbank: 'L09137.2' },
      circular: true,
    },
  ],
};

const PREPARED_ENTRY: PreparedReferenceAssemblyEntryV1 = {
  id: 'puc19-l09137-2',
  name: 'pUC19',
  organism: 'synthetic DNA construct',
  taxId: 32_630,
  assembly: 'L09137.2',
  description: 'Canonical 2,686 bp circular pUC19 cloning vector with searchable annotations.',
  assetCacheKey: 'puc19-l09137-2',
  members: [
    {
      chrom: 'puc19',
      displayName: 'pUC19',
      lengthBp: 2_686,
      role: 'assembled-molecule',
      aliases: { genbank: 'L09137.2' },
      circular: true,
      manifest: {
        fastaPath: 'prepared/puc19/puc19.fa',
        faiPath: 'prepared/puc19/puc19.fa.fai',
        gffPath: 'prepared/puc19/puc19.gff3.gz',
        tbiPath: 'prepared/puc19/puc19.gff3.gz.tbi',
      },
    },
  ],
};

describe('hosted reference asset authority', () => {
  const temporaryRoots: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.close();
      server.closeAllConnections();
      await once(server, 'close').catch(() => undefined);
    }
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('lists every production hosted reference without exposing source authority', async () => {
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot: await temporaryRoot(temporaryRoots),
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
    });

    await expect(authority.listHosted()).resolves.toEqual(
      HOSTED_REFERENCE_CATALOG_V1.map((definition) =>
        hostedReferenceCatalogEntryV1(definition, 'not-cached')
      )
    );
  });

  it('does not treat copy-only catalog changes as a reference update', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [CATALOG_ENTRY],
      listPrepared: async () => [
        { ...PREPARED_ENTRY, name: 'Old display name', description: 'Old description' },
      ],
      inspectSourcePublication: async () => ({
        status: 'ready',
        publicationId: 'cached-source',
        sourceGenerationRoot: cacheRoot,
      }),
      inspectPrepared: async () => ({ status: 'ready' }),
    });
    expect((await authority.listHosted())[0].cacheStatus).toBe('cached');
  });

  it('preserves complete prepared morphology instead of replacing it with catalog fallback', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const preparedWithMorphology: PreparedReferenceAssemblyEntryV1 = {
      ...PREPARED_ENTRY,
      members: PREPARED_ENTRY.members.map((member) => ({
        ...member,
        morphology: { kind: 'generic-contig', reason: 'ineligible-member' },
      })),
    };
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [CATALOG_ENTRY],
      listPrepared: async () => [preparedWithMorphology],
      inspectSourcePublication: async () => ({
        status: 'ready',
        publicationId: 'semantic-source',
        sourceGenerationRoot: cacheRoot,
      }),
      inspectPrepared: async () => ({ status: 'ready' }),
    });

    await expect(
      authority.installHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'dark',
        onProgress: () => undefined,
      })
    ).resolves.toMatchObject({
      members: [
        expect.objectContaining({
          morphology: { kind: 'generic-contig', reason: 'ineligible-member' },
        }),
      ],
    });
  });

  it('reports cached only after source and prepared products pass admission', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const inspectSourcePublication = vi
      .fn<HostedReferenceSourceReadinessInspector>()
      .mockResolvedValueOnce({
        status: 'ready',
        publicationId: 'cached-source',
        sourceGenerationRoot: cacheRoot,
      })
      .mockResolvedValueOnce({
        status: 'ready',
        publicationId: 'cached-source',
        sourceGenerationRoot: cacheRoot,
      })
      .mockResolvedValueOnce({
        status: 'needs-refresh',
        reason: 'source-index-missing',
        message: 'prepared source files are stale',
      });
    const inspectPrepared = vi
      .fn<HostedReferenceReadinessInspector>()
      .mockResolvedValueOnce({ status: 'needs-refresh' })
      .mockResolvedValue({ status: 'ready' });
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [CATALOG_ENTRY],
      inspectSourcePublication,
      inspectPrepared,
      listPrepared: async () => [PREPARED_ENTRY],
    });

    await expect(authority.listHosted()).resolves.toEqual([
      expect.objectContaining({
        id: CATALOG_ENTRY.id,
        cacheStatus: 'not-cached',
        cacheStatusReason: 'prepared-files-incomplete',
      }),
    ]);
    await expect(authority.listHosted()).resolves.toEqual([
      expect.objectContaining({
        id: CATALOG_ENTRY.id,
        cacheStatus: 'cached',
      }),
    ]);
    await expect(authority.listHosted()).resolves.toEqual([
      expect.objectContaining({ id: CATALOG_ENTRY.id, cacheStatus: 'cached' }),
    ]);
    expect(inspectSourcePublication).toHaveBeenCalledTimes(2);

    const pointer = referenceAssetPublicationPath(
      referenceAssemblyCacheRoot(cacheRoot, PREPARED_ENTRY)
    );
    await mkdir(dirname(pointer), { recursive: true });
    await writeFile(pointer, '{}\n');
    await expect(authority.listHosted()).resolves.toEqual([
      expect.objectContaining({
        id: CATALOG_ENTRY.id,
        cacheStatus: 'stale',
        cacheStatusReason: 'local-files-invalid',
      }),
    ]);
    expect(inspectSourcePublication).toHaveBeenCalledTimes(3);
  });

  it.each(['detail', 'search'] as const)(
    'does not report cached with only %s admitted',
    async (tier) => {
      const cacheRoot = await temporaryRoot(temporaryRoots);
      const inspectCachedPreparedBundle = vi
        .fn()
        .mockResolvedValueOnce({ ...fullHydrationFixture(cacheRoot), hydratedTiers: [tier] })
        .mockResolvedValueOnce(fullHydrationFixture(cacheRoot));
      const fetchAsset = vi.fn();
      const authority = createHostedReferenceAssetAuthority({
        cacheRoot,
        projectRoot: PROJECT_ROOT,
        sourceBuildFingerprint: 'focused-test',
        indexerBinary: '/unused/injected-indexer',
        catalog: [catalogEntryWithPreparedBundle()],
        listPrepared: async () => [PREPARED_ENTRY],
        inspectSourcePublication: async () => ({
          status: 'ready',
          publicationId: 'cached-source',
          sourceGenerationRoot: cacheRoot,
        }),
        inspectCachedPreparedBundle,
        fetchAsset,
      });
      expect((await authority.listHosted())[0].cacheStatus).toBe('not-cached');
      expect((await authority.listHosted())[0].cacheStatus).toBe('cached');
      expect(inspectCachedPreparedBundle).toHaveBeenCalledWith(
        expect.objectContaining({ tiers: ['detail', 'search'] })
      );
      expect(fetchAsset).not.toHaveBeenCalled();
    }
  );

  it('reconstructs a ready full-capability snapshot through a profile-owned publication root', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const publicationRoot = await temporaryRoot(temporaryRoots);
    const fallbackPublicationRoot = await temporaryRoot(temporaryRoots);
    const inspectSourcePublication = vi.fn<HostedReferenceSourceReadinessInspector>(async () => ({
      status: 'ready',
      publicationId: 'durable-source-generation',
      sourceGenerationRoot: join(
        cacheRoot,
        CATALOG_ENTRY.id,
        'generations',
        'durable-source-generation'
      ),
    }));
    const inspectPrepared = vi.fn(async () => ({ status: 'ready' }));
    const listPrepared = vi.fn(async () => [PREPARED_ENTRY]);
    const reconstructed = createHostedReferenceAssetAuthority({
      cacheRoot,
      publicationRoot,
      fallbackPublicationRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [CATALOG_ENTRY],
      inspectSourcePublication,
      inspectPrepared,
      listPrepared,
    });

    await expect(
      reconstructed.getHostedPreparationStatus({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'dark',
      })
    ).resolves.toMatchObject({
      catalogId: CATALOG_ENTRY.id,
      themeMode: 'dark',
      status: 'ready',
      phase: 'ready',
      capabilityGenerationId: expect.stringMatching(/^[a-f0-9]{64}$/),
      entry: PREPARED_ENTRY,
    });
    expect(listPrepared).toHaveBeenCalledWith(cacheRoot, publicationRoot, fallbackPublicationRoot);
    expect(inspectSourcePublication).toHaveBeenCalledWith({
      entry: PREPARED_ENTRY,
      cacheRoot,
      publicationRoot,
      fallbackPublicationRoot,
      expectedSource: {
        fastaSha256: CATALOG_ENTRY.sources.fasta.sha256,
        gffSha256: CATALOG_ENTRY.sources.annotations.sha256,
      },
    });
    expect(inspectPrepared).toHaveBeenCalledWith({
      entry: PREPARED_ENTRY,
      cacheRoot,
      publicationRoot,
      fallbackPublicationRoot,
      sourceBuildFingerprint: 'focused-test',
      themeMode: 'dark',
      expectedSource: {
        fastaSha256: CATALOG_ENTRY.sources.fasta.sha256,
        gffSha256: CATALOG_ENTRY.sources.annotations.sha256,
      },
    });
  });

  it('returns the same complete content identity on the first cached open and later opens', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const entry: PreparedReferenceAssemblyEntryV1 = {
      ...PREPARED_ENTRY,
      referenceIdentity: referenceContentIdentity({
        source: {
          fastaSha256: CATALOG_ENTRY.sources.fasta.sha256,
          gffSha256: CATALOG_ENTRY.sources.annotations.sha256,
        },
        members: CATALOG_ENTRY.contigs,
        pipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION,
      }),
      portableView: {
        generationRoot: join(cacheRoot, CATALOG_ENTRY.id, 'generations', 'c'.repeat(64)),
        bundleFingerprint: 'c'.repeat(64),
        trackTypes: ['mRNA'],
        assetGenerationsByTheme: {
          light: {
            contract: 'assembly-reference-asset-generation.v1',
            themeMode: 'light',
            sourceFingerprint: '1'.repeat(24),
            inventoryFingerprint: '2'.repeat(64),
          },
          dark: {
            contract: 'assembly-reference-asset-generation.v1',
            themeMode: 'dark',
            sourceFingerprint: '1'.repeat(24),
            inventoryFingerprint: '3'.repeat(64),
          },
        },
      },
    };
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [CATALOG_ENTRY],
      listPrepared: async () => [entry],
      inspectSourcePublication: async () => ({
        status: 'ready',
        publicationId: 'c'.repeat(64),
        sourceGenerationRoot: entry.portableView!.generationRoot,
      }),
      inspectPrepared: async () => ({ status: 'ready' }),
    });
    const request = {
      catalogId: CATALOG_ENTRY.id,
      themeMode: 'light' as const,
      onProgress: () => undefined,
    };
    const first = await authority.openHosted(request);
    const second = await authority.openHosted(request);
    expect(first.entry.referenceIdentity).toEqual(second.entry.referenceIdentity);
    expect(first.entry.referenceVersionHistory).toEqual(second.entry.referenceVersionHistory);
    expect(first.entry.referenceVersionHistory).toHaveLength(1);
  });

  it('deduplicates status by theme while serializing writer work for one catalog family', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const preparedThemes = new Set<string>();
    const releaseTheme = new Map<'light' | 'dark', () => void>();
    const execution: string[] = [];
    let activePreparations = 0;
    let maximumActivePreparations = 0;
    const runPreparation = vi.fn<HostedReferencePreparationRunner>(async (input) => {
      const { themeMode } = input;
      execution.push(`start:${themeMode}`);
      activePreparations += 1;
      maximumActivePreparations = Math.max(maximumActivePreparations, activePreparations);
      await new Promise<void>((resolveGate) => {
        releaseTheme.set(themeMode, resolveGate);
      });
      preparedThemes.add(themeMode);
      activePreparations -= 1;
      execution.push(`finish:${themeMode}`);
      return preparationReceipt(input);
    });
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [CATALOG_ENTRY],
      inspectSourcePublication: vi.fn<HostedReferenceSourceReadinessInspector>(async () => ({
        status: 'ready',
        publicationId: 'shared-source-generation',
        sourceGenerationRoot: join(
          cacheRoot,
          CATALOG_ENTRY.id,
          'generations',
          'shared-source-generation'
        ),
      })),
      inspectPrepared: vi.fn(async ({ themeMode }) => ({
        status: preparedThemes.has(themeMode) ? 'ready' : 'needs-refresh',
      })),
      runPreparation,
      listPrepared: async () => [PREPARED_ENTRY],
    });

    const lightInstall = authority.installHosted({
      catalogId: CATALOG_ENTRY.id,
      themeMode: 'light',
      onProgress: vi.fn(),
    });
    const darkInstall = authority.installHosted({
      catalogId: CATALOG_ENTRY.id,
      themeMode: 'dark',
      onProgress: vi.fn(),
    });

    await vi.waitFor(() => expect(runPreparation).toHaveBeenCalledOnce());
    expect(execution).toEqual(['start:light']);
    await expect(
      authority.getHostedPreparationStatus({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'dark',
      })
    ).resolves.toMatchObject({
      status: 'preparing',
      themeMode: 'dark',
      phase: 'queued-hosted-reference',
    });

    const releaseLight = releaseTheme.get('light');
    expect(releaseLight).toBeTypeOf('function');
    releaseLight!();
    await vi.waitFor(() => expect(runPreparation).toHaveBeenCalledTimes(2));
    expect(execution).toEqual(['start:light', 'finish:light', 'start:dark']);
    expect(maximumActivePreparations).toBe(1);

    const releaseDark = releaseTheme.get('dark');
    expect(releaseDark).toBeTypeOf('function');
    releaseDark!();
    await expect(Promise.all([lightInstall, darkInstall])).resolves.toEqual([
      PREPARED_ENTRY,
      PREPARED_ENTRY,
    ]);

    expect(runPreparation).toHaveBeenCalledTimes(2);
    expect(runPreparation.mock.calls.map(([call]) => call.themeMode).sort()).toEqual([
      'dark',
      'light',
    ]);
    await expect(
      authority.getHostedPreparationStatus({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
      })
    ).resolves.toMatchObject({ status: 'ready', themeMode: 'light' });
    await expect(
      authority.getHostedPreparationStatus({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'dark',
      })
    ).resolves.toMatchObject({ status: 'ready', themeMode: 'dark' });
  });

  it('opens a coordinate-complete shell before cold preparation finishes', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const fastaBytes = await readFile(PUC19_FASTA);
    const gff3Bytes = await readFile(PUC19_GFF3);
    let markPreparationStarted!: () => void;
    const preparationStarted = new Promise<void>((resolve) => {
      markPreparationStarted = resolve;
    });
    let admitPrepared!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      admitPrepared = resolve;
    });
    let admitted: ReadonlyArray<PreparedReferenceAssemblyEntryV1> = [];
    const runPreparation = vi.fn<HostedReferencePreparationRunner>(async (input) => {
      markPreparationStarted();
      input.onProgress?.('published source generation');
      await preparationGate;
      admitted = [PREPARED_ENTRY];
      return preparationReceipt(input);
    });
    const progress: ReferenceAssetPreparationProgressUpdateV1[] = [];
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [CATALOG_ENTRY],
      fetchAsset: async (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith(CATALOG_ENTRY.sources.fasta.relativePath)) {
          return new Response(fastaBytes);
        }
        if (path.endsWith(CATALOG_ENTRY.sources.annotations.relativePath)) {
          return new Response(gff3Bytes);
        }
        return new Response(null, { status: 404 });
      },
      runPreparation,
      inspectSourcePublication: vi.fn<HostedReferenceSourceReadinessInspector>(async () => ({
        status: 'ready',
        publicationId: 'background-shell-source',
        sourceGenerationRoot: join(
          cacheRoot,
          CATALOG_ENTRY.id,
          'generations',
          'background-shell-source'
        ),
      })),
      listPrepared: async () => admitted,
      createOperationId: () => 'background-shell-open',
    });

    await expect(
      authority.openHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: (update) => progress.push(update),
      })
    ).resolves.toMatchObject({
      status: 'view-ready',
      entry: {
        id: CATALOG_ENTRY.id,
        members: [
          {
            chrom: 'puc19',
            lengthBp: 2_686,
          },
        ],
      },
    });
    const shell = (
      await authority.openHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: (update) => progress.push(update),
      })
    ).entry;
    expect(shell.members[0]).not.toHaveProperty('manifest');
    await preparationStarted;
    await vi.waitFor(() => expect(runPreparation).toHaveBeenCalledOnce());
    expect(progress).toContainEqual(
      expect.objectContaining({
        phase: 'view-ready',
        completed: 1,
        total: 1,
      })
    );
    expect(progress).toContainEqual(
      expect.objectContaining({
        phase: 'source-published',
        completed: 1,
        total: 1,
      })
    );

    admitPrepared();
    await vi.waitFor(() => {
      expect(progress).toContainEqual(expect.objectContaining({ phase: 'verifying-publication' }));
      expect(progress).toContainEqual(
        expect.objectContaining({ phase: 'ready', completed: 1, total: 1 })
      );
    });
  });

  it.each(['legacy', 'prepared'] as const)(
    'reconciles chromosome metadata on the installed-version opening path (%s morphology)',
    async (mode) => {
      const cacheRoot = await temporaryRoot(temporaryRoots);
      const definition = HOSTED_REFERENCE_CATALOG_V1.find(({ id }) => id === 'grch38')!;
      const prepared: PreparedReferenceAssemblyEntryV1 = {
        ...hostedReferenceCatalogEntryV1(definition, 'cached'),
        assetCacheKey: definition.id,
        members: definition.contigs.map((member) => ({
          chrom: member.chrom,
          displayName: member.displayName,
          lengthBp: member.lengthBp,
          role: member.role,
          circular: member.circular,
          cytobandId: 'stale-cached-alias',
          ...(mode === 'prepared'
            ? {
                morphology: {
                  kind: 'generic-contig' as const,
                  reason: 'conflicting-evidence' as const,
                },
              }
            : {}),
        })),
      };
      const hydration = fullHydrationFixture(cacheRoot);
      const fetchAsset = vi.fn();
      const authority = createHostedReferenceAssetAuthority({
        cacheRoot,
        projectRoot: PROJECT_ROOT,
        sourceBuildFingerprint: 'focused-test',
        indexerBinary: '/unused/injected-indexer',
        catalog: [definition],
        listPrepared: async () => [prepared],
        inspectInstalledVersion: async () => ({
          entry: prepared,
          definition,
          hydration,
          expectedSource: {
            fastaSha256: definition.sources.fasta.sha256,
            gffSha256: definition.sources.annotations.sha256,
          },
        }),
        inspectSourcePublication: async () => ({
          status: 'ready',
          publicationId: hydration.bundle.bundleFingerprint,
          sourceGenerationRoot: hydration.generationRoot,
        }),
        inspectPrepared: async () => ({ status: 'needs-refresh' }),
        admitPreparedView: async () => ({ trackTypes: ['mRNA'] }),
        hydratePreparedBundle: async () => new Promise(() => {}),
        fetchAsset,
      });

      const opened = await authority.openHosted({
        catalogId: definition.id,
        themeMode: 'light',
        onProgress: () => {},
      });
      expect(opened.entry.members).toHaveLength(24);
      expect(opened.entry.members.map(({ morphology }) => morphology)).toEqual(
        mode === 'prepared'
          ? prepared.members.map(({ morphology }) => morphology)
          : definition.contigs.map(() => expect.objectContaining({ kind: 'localized' }))
      );
      expect(opened.entry.members.map(({ cytobandId }) => cytobandId)).toEqual(
        definition.contigs.map(({ cytobandId }) => cytobandId)
      );
      expect(opened.entry.portableView?.bundleFingerprint).toBe(hydration.bundle.bundleFingerprint);
      expect(fetchAsset).not.toHaveBeenCalled();
    }
  );

  it('opens the verified installed version while a different annotation publication is still downloading', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const previousDefinition = catalogEntryWithPreparedBundle();
    const updatedDefinition = {
      ...previousDefinition,
      sources: {
        ...previousDefinition.sources,
        annotations: { ...previousDefinition.sources.annotations, sha256: 'b'.repeat(64) },
      },
      preparedBundle: {
        manifest: {
          relativePath: `objects/sha256/${'d'.repeat(2)}/${'d'.repeat(64)}`,
          sha256: 'd'.repeat(64),
          byteLength: 1,
        },
      },
    };
    const previous = fullHydrationFixture(cacheRoot);
    let release!: (hydration: PortablePreparedReferenceHydrationResult) => void;
    const download = new Promise<PortablePreparedReferenceHydrationResult>((resolve) => {
      release = resolve;
    });
    let published = false;
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/injected',
      catalog: [updatedDefinition],
      listPrepared: async () => [PREPARED_ENTRY],
      inspectInstalledVersion: async () => ({
        entry: PREPARED_ENTRY,
        definition: previousDefinition,
        hydration: previous,
        expectedSource: {
          fastaSha256: CATALOG_ENTRY.sources.fasta.sha256,
          gffSha256: CATALOG_ENTRY.sources.annotations.sha256,
        },
      }),
      inspectSourcePublication: async ({ expectedSource }) =>
        published || expectedSource.gffSha256 === CATALOG_ENTRY.sources.annotations.sha256
          ? {
              status: 'ready',
              publicationId: previous.bundle.bundleFingerprint,
              sourceGenerationRoot: previous.generationRoot,
            }
          : {
              status: 'needs-refresh',
              reason: 'source-index-missing',
              message: 'Updated annotation source is still downloading.',
            },
      inspectPrepared: async () => (published ? { status: 'ready' } : { status: 'needs-refresh' }),
      hydratePreparedBundle: async () => download,
      admitPreparedView: async () => ({ trackTypes: ['mRNA'] }),
      acquireWriterLease: async () => fakeWriterLease(),
      publishPreparedSource: async () => {
        published = true;
        return PREPARED_ENTRY;
      },
    });
    expect((await authority.listHosted())[0]).toMatchObject({ currentVersionAvailable: true });
    const opened = await authority.openHosted({
      catalogId: CATALOG_ENTRY.id,
      themeMode: 'light',
      onProgress: () => {},
    });
    expect(opened.entry.portableView?.bundleFingerprint).toBe(previous.bundle.bundleFingerprint);
    expect(published).toBe(false);
    release({ ...previous, bundle: { ...previous.bundle, bundleFingerprint: 'e'.repeat(64) } });
    await vi.waitFor(async () =>
      expect(
        (
          await authority.getHostedPreparationStatus({
            catalogId: CATALOG_ENTRY.id,
            themeMode: 'light',
          })
        )?.status
      ).toBe('ready')
    );
  });

  it('opens the current view when a superseded installed bundle fails admission', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const previousDefinition = catalogEntryWithPreparedBundle();
    const updatedDefinition = {
      ...previousDefinition,
      preparedBundle: {
        manifest: {
          relativePath: `objects/sha256/${'d'.repeat(2)}/${'d'.repeat(64)}`,
          sha256: 'd'.repeat(64),
          byteLength: 1,
        },
      },
    };
    const previous = fullHydrationFixture(cacheRoot);
    const currentView = await viewHydrationFixture(cacheRoot);
    const hydratePreparedView = vi.fn(async () => currentView);
    const admitPreparedView = vi.fn(async ({ hydration }) => {
      if (hydration === previous) {
        throw new Error('Portable annotation search manifest identity is invalid.');
      }
      return { trackTypes: ['mRNA'] };
    });
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/injected',
      catalog: [updatedDefinition],
      listPrepared: async () => [PREPARED_ENTRY],
      inspectInstalledVersion: async () => ({
        entry: PREPARED_ENTRY,
        definition: previousDefinition,
        hydration: previous,
        expectedSource: {
          fastaSha256: CATALOG_ENTRY.sources.fasta.sha256,
          gffSha256: CATALOG_ENTRY.sources.annotations.sha256,
        },
      }),
      inspectSourcePublication: async () => ({
        status: 'ready',
        publicationId: previous.bundle.bundleFingerprint,
        sourceGenerationRoot: previous.generationRoot,
      }),
      inspectPrepared: async () => ({ status: 'needs-refresh' }),
      hydratePreparedView,
      hydratePreparedBundle: async () => new Promise(() => undefined),
      admitPreparedView,
    });

    await expect(
      authority.openHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: () => undefined,
      })
    ).resolves.toMatchObject({
      status: 'view-ready',
      entry: {
        portableView: { bundleFingerprint: currentView.bundle.bundleFingerprint },
      },
    });
    expect(hydratePreparedView).toHaveBeenCalledOnce();
    expect(admitPreparedView).toHaveBeenCalledWith(
      expect.objectContaining({ definition: updatedDefinition, hydration: currentView })
    );
  });

  it('prefers an admitted prepared bundle and does not fetch raw sources', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    let admitted: ReadonlyArray<PreparedReferenceAssemblyEntryV1> = [];
    const hydration = fullHydrationFixture(cacheRoot);
    const hydratePreparedBundle: HostedPreparedBundleHydrator = vi.fn(async () => hydration);
    const writerLease = fakeWriterLease();
    const acquireWriterLease = vi.fn(async () => writerLease);
    const publishPreparedSource = vi.fn(async () => {
      admitted = [PREPARED_ENTRY];
      return PREPARED_ENTRY;
    });
    const fetchAsset = vi.fn();
    const runPreparation = vi.fn<HostedReferencePreparationRunner>();
    const admitPreparedView = vi.fn(async () => ({ trackTypes: ['mRNA'] }));
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [catalogEntryWithPreparedBundle()],
      fetchAsset,
      hydratePreparedBundle,
      admitPreparedView,
      acquireWriterLease,
      publishPreparedSource,
      inspectSourcePublication: vi.fn<HostedReferenceSourceReadinessInspector>(async () => ({
        status: 'ready',
        publicationId: hydration.bundle.bundleFingerprint,
        sourceGenerationRoot: hydration.generationRoot,
      })),
      inspectPrepared: vi.fn(async () => ({ status: 'ready' })),
      listPrepared: async () => admitted,
    });

    await expect(
      authority.installHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: () => undefined,
      })
    ).resolves.toMatchObject({
      ...PREPARED_ENTRY,
      portableView: {
        generationRoot: hydration.generationRoot,
        bundleFingerprint: hydration.bundle.bundleFingerprint,
        trackTypes: ['mRNA'],
      },
    });
    await expect(
      authority.installHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: () => undefined,
      })
    ).resolves.toMatchObject({
      ...PREPARED_ENTRY,
      portableView: {
        generationRoot: hydration.generationRoot,
        bundleFingerprint: hydration.bundle.bundleFingerprint,
        trackTypes: ['mRNA'],
      },
    });
    expect(hydratePreparedBundle).toHaveBeenCalledOnce();
    expect(admitPreparedView).toHaveBeenCalledWith({
      definition: catalogEntryWithPreparedBundle(),
      familyRoot: join(cacheRoot, CATALOG_ENTRY.id),
      hydration,
      hydrator: expect.any(Object),
    });
    expect(acquireWriterLease).toHaveBeenCalledWith(
      join(cacheRoot, CATALOG_ENTRY.id),
      '/unused/injected-indexer'
    );
    expect(publishPreparedSource).toHaveBeenCalledWith({
      cacheRoot,
      definition: catalogEntryWithPreparedBundle(),
      hydration,
      writerLease,
    });
    expect(writerLease.release).toHaveBeenCalledOnce();
    expect(fetchAsset).not.toHaveBeenCalled();
    expect(runPreparation).not.toHaveBeenCalled();
  });

  it.each(['pending', 'progress', 'failure'] as const)(
    'preserves admitted annotation detail through search %s',
    async (searchOutcome) => {
      const cacheRoot = await temporaryRoot(temporaryRoots);
      let admitted: ReadonlyArray<PreparedReferenceAssemblyEntryV1> = [];
      const fullHydration = fullHydrationFixture(cacheRoot);
      const detailHydration = {
        ...fullHydration,
        hydratedTiers: ['detail'],
      } as PortablePreparedReferenceHydrationResult;
      let releaseSearchHydration!: () => void;
      let rejectSearchHydration!: (error: Error) => void;
      const searchHydrationGate = new Promise<PortablePreparedReferenceHydrationResult>(
        (resolveGate, rejectGate) => {
          rejectSearchHydration = rejectGate;
          releaseSearchHydration = () => resolveGate(fullHydration);
        }
      );
      const hydratePreparedBundle = vi.fn<HostedPreparedBundleHydrator>(({ tiers, onProgress }) => {
        if (tiers.length === 1 && tiers[0] === 'detail') {
          return Promise.resolve(detailHydration);
        }
        if (searchOutcome !== 'pending') {
          onProgress?.({
            phase: 'transport',
            completedBytes: 1,
            totalBytes: 2,
            completedObjects: 0,
            totalObjects: 1,
            reusedObjects: 0,
          });
        }
        return searchHydrationGate;
      });
      const assetGenerationsByTheme = {
        light: {
          contract: 'assembly-reference-asset-generation.v1' as const,
          sourceFingerprint: '1'.repeat(24),
          inventoryFingerprint: '2'.repeat(64),
          themeMode: 'light' as const,
        },
        dark: {
          contract: 'assembly-reference-asset-generation.v1' as const,
          sourceFingerprint: '1'.repeat(24),
          inventoryFingerprint: '3'.repeat(64),
          themeMode: 'dark' as const,
        },
      };
      const admitPreparedView = vi.fn(async ({ hydration }) => ({
        trackTypes: ['mRNA'],
        assetGenerationsByTheme,
        searchReady: hydration.hydratedTiers.includes('search'),
      }));
      const publishPreparedSource = vi.fn(async () => {
        admitted = [PREPARED_ENTRY];
        return PREPARED_ENTRY;
      });
      const progress: ReferenceAssetPreparationProgressUpdateV1[] = [];
      const fetchAsset = vi.fn();
      const authority = createHostedReferenceAssetAuthority({
        cacheRoot,
        projectRoot: PROJECT_ROOT,
        sourceBuildFingerprint: 'focused-test',
        indexerBinary: '/unused/injected-indexer',
        catalog: [catalogEntryWithPreparedBundle()],
        fetchAsset,
        hydratePreparedBundle,
        admitPreparedView,
        acquireWriterLease: vi.fn(async () => fakeWriterLease()),
        publishPreparedSource,
        inspectSourcePublication: vi.fn<HostedReferenceSourceReadinessInspector>(async () => ({
          status: 'ready',
          publicationId: fullHydration.bundle.bundleFingerprint,
          sourceGenerationRoot: fullHydration.generationRoot,
        })),
        listPrepared: async () => admitted,
      });

      let installSettled = false;
      const installation = authority
        .installHosted({
          catalogId: CATALOG_ENTRY.id,
          themeMode: 'dark',
          onProgress: (update) => progress.push(update),
        })
        .then((entry) => {
          installSettled = true;
          return entry;
        });

      await vi.waitFor(() =>
        expect(progress).toContainEqual(
          expect.objectContaining({ phase: 'detail-ready', completed: 1, total: 1 })
        )
      );
      expect(admitPreparedView).toHaveBeenCalledOnce();
      expect(hydratePreparedBundle).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ tiers: ['detail'] })
      );
      expect(admitPreparedView).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ hydration: detailHydration })
      );
      expect(installSettled).toBe(false);
      expect(publishPreparedSource).toHaveBeenCalledOnce();
      expect((await authority.listHosted())[0].preparation).toMatchObject({
        status: 'annotation-ready',
        active: true,
      });
      await expect(
        authority.getHostedPreparationStatus({
          catalogId: CATALOG_ENTRY.id,
          themeMode: 'dark',
        })
      ).resolves.toMatchObject({
        status: 'annotation-ready',
        phase: 'detail-ready',
        entry: {
          portableView: {
            assetGenerationsByTheme,
            searchReady: false,
          },
        },
      });
      await expect(
        authority.openHosted({
          catalogId: CATALOG_ENTRY.id,
          themeMode: 'dark',
          onProgress: (update) => progress.push(update),
        })
      ).resolves.toMatchObject({
        status: 'view-ready',
        entry: {
          portableView: {
            assetGenerationsByTheme,
            searchReady: false,
          },
        },
      });
      expect(admitPreparedView).toHaveBeenCalledOnce();

      if (searchOutcome === 'failure') {
        rejectSearchHydration(new Error('search unavailable'));
        await expect(installation).rejects.toThrow('search unavailable');
        expect((await authority.listHosted())[0].preparation).toMatchObject({
          status: 'annotation-ready',
          active: false,
          label: expect.stringContaining('search is unavailable'),
        });
        expect(fetchAsset).not.toHaveBeenCalled();
        await expect(
          authority.getHostedPreparationStatus({ catalogId: CATALOG_ENTRY.id, themeMode: 'dark' })
        ).resolves.toMatchObject({
          status: 'annotation-ready',
          entry: { portableView: { searchReady: false, assetGenerationsByTheme } },
        });
        let releaseRetry!: () => void;
        hydratePreparedBundle.mockReturnValueOnce(
          new Promise((resolveGate) => {
            releaseRetry = () => resolveGate(fullHydration);
          })
        );
        const retry = authority.installHosted({
          catalogId: CATALOG_ENTRY.id,
          themeMode: 'dark',
          onProgress: () => undefined,
        });
        await expect(
          authority.getHostedPreparationStatus({ catalogId: CATALOG_ENTRY.id, themeMode: 'dark' })
        ).resolves.toMatchObject({ status: 'annotation-ready' });
        await vi.waitFor(() => expect(hydratePreparedBundle).toHaveBeenCalledTimes(3));
        releaseRetry();
        await expect(retry).resolves.toMatchObject({ portableView: { searchReady: true } });
        return;
      }
      releaseSearchHydration();
      await expect(installation).resolves.toMatchObject({
        id: PREPARED_ENTRY.id,
        portableView: {
          generationRoot: fullHydration.generationRoot,
          bundleFingerprint: fullHydration.bundle.bundleFingerprint,
          assetGenerationsByTheme,
          searchReady: true,
        },
      });
      expect(hydratePreparedBundle).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ tiers: ['detail', 'search'] })
      );
      expect(admitPreparedView).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ hydration: fullHydration })
      );
      expect(publishPreparedSource).toHaveBeenCalledTimes(2);
      expect(publishPreparedSource).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ hydration: fullHydration })
      );
    }
  );

  it('releases the assembly writer lease and does not raw-fallback when local publication fails', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const writerLease = fakeWriterLease();
    const acquireWriterLease = vi.fn(async () => writerLease);
    const publishPreparedSource = vi.fn(async () => {
      throw new Error('focused source publication rejection');
    });
    const runPreparation = vi.fn<HostedReferencePreparationRunner>();
    const progress: ReferenceAssetPreparationProgressUpdateV1[] = [];
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [catalogEntryWithPreparedBundle()],
      fetchAsset: vi.fn(async () => new Response(null, { status: 503 })),
      hydratePreparedBundle: vi.fn(async () => fullHydrationFixture(cacheRoot)),
      admitPreparedView: vi.fn(async () => ({ trackTypes: ['mRNA'] })),
      acquireWriterLease,
      publishPreparedSource,
      runPreparation,
      listPrepared: async () => [],
      createOperationId: () => 'source-publication-rejection',
    });

    await expect(
      authority.installHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: (update) => progress.push(update),
      })
    ).rejects.toThrow('focused source publication rejection');

    expect(acquireWriterLease).toHaveBeenCalledOnce();
    expect(publishPreparedSource).toHaveBeenCalledOnce();
    expect(writerLease.release).toHaveBeenCalledOnce();
    expect(runPreparation).not.toHaveBeenCalled();
    expect(progress).not.toContainEqual(
      expect.objectContaining({ phase: 'prepared-bundle-fallback' })
    );
  });

  it('reports one install outcome per background install without content', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    let admitted: ReadonlyArray<PreparedReferenceAssemblyEntryV1> = [];
    const hydration = fullHydrationFixture(cacheRoot);
    const observations: HostedReferenceInstallObservation[] = [];
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [catalogEntryWithPreparedBundle()],
      fetchAsset: vi.fn(),
      hydratePreparedBundle: vi.fn(async () => hydration),
      admitPreparedView: vi.fn(async () => ({ trackTypes: ['mRNA'] })),
      acquireWriterLease: vi.fn(async () => fakeWriterLease()),
      publishPreparedSource: vi.fn(async () => {
        admitted = [PREPARED_ENTRY];
        return PREPARED_ENTRY;
      }),
      inspectSourcePublication: vi.fn(async () => ({
        status: 'ready' as const,
        publicationId: hydration.bundle.bundleFingerprint,
        sourceGenerationRoot: hydration.generationRoot,
      })),
      inspectPrepared: vi.fn(async () => ({ status: 'ready' })),
      listPrepared: async () => admitted,
      observeInstall: (observation) => observations.push(observation),
    });

    const install = () =>
      authority.installHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: () => undefined,
      });
    await Promise.all([install(), install()]);
    await install();

    expect(observations.map((observation) => observation.install_phase)).toEqual([
      'started',
      'annotation_ready',
      'ready',
    ]);
    expect(observations[0]?.operation_id).toEqual(expect.stringMatching(/^[a-f0-9-]{36}$/));
    expect(new Set(observations.map((observation) => observation.operation_id)).size).toBe(1);
    expect(observations[2]).toMatchObject({
      feature_area: 'scientific_workflow',
      is_update: false,
      used_bundle_fallback: false,
      duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(observations)).not.toContain(cacheRoot);
    expect(JSON.stringify(observations)).not.toContain(CATALOG_ENTRY.id);
  });

  it('reports the last preparation stage when a background install fails', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const observations: HostedReferenceInstallObservation[] = [];
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [catalogEntryWithPreparedBundle()],
      fetchAsset: vi.fn(async () => new Response(null, { status: 503 })),
      hydratePreparedBundle: vi.fn(async () => fullHydrationFixture(cacheRoot)),
      admitPreparedView: vi.fn(async () => ({ trackTypes: ['mRNA'] })),
      acquireWriterLease: vi.fn(async () => fakeWriterLease()),
      publishPreparedSource: vi.fn(async () => {
        throw new Error('focused source publication rejection');
      }),
      runPreparation: vi.fn<HostedReferencePreparationRunner>(),
      listPrepared: async () => [],
      createOperationId: () => 'source-publication-rejection',
      observeInstall: (observation) => observations.push(observation),
    });

    await expect(
      authority.installHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: () => undefined,
      })
    ).rejects.toThrow('focused source publication rejection');

    expect(observations.map((observation) => observation.install_phase)).toEqual([
      'started',
      'failed',
    ]);
    expect(observations[1]).toMatchObject({
      operation_id: observations[0]?.operation_id,
      install_stage: expect.stringMatching(/^[a-z_]+$/),
      annotations_ready: false,
    });
    expect(observations[1]?.install_stage).not.toBe('other');
    expect(JSON.stringify(observations)).not.toContain('focused source publication rejection');
  });

  it('fails closed before publication when full portable admission is rejected', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const acquireWriterLease = vi.fn();
    const publishPreparedSource = vi.fn();
    const runPreparation = vi.fn<HostedReferencePreparationRunner>();
    const progress: ReferenceAssetPreparationProgressUpdateV1[] = [];
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [catalogEntryWithPreparedBundle()],
      fetchAsset: vi.fn(),
      hydratePreparedBundle: vi.fn(async () => fullHydrationFixture(cacheRoot)),
      admitPreparedView: vi.fn(async () => {
        throw new Error('focused full admission rejection');
      }),
      acquireWriterLease,
      publishPreparedSource,
      runPreparation,
      listPrepared: async () => [],
    });

    await expect(
      authority.installHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: (update) => progress.push(update),
      })
    ).rejects.toThrow('focused full admission rejection');
    expect(acquireWriterLease).not.toHaveBeenCalled();
    expect(publishPreparedSource).not.toHaveBeenCalled();
    expect(runPreparation).not.toHaveBeenCalled();
    expect(progress).not.toContainEqual(
      expect.objectContaining({ phase: 'prepared-bundle-fallback' })
    );
  });

  it('uses authenticated portable products without rebuilding stale local products', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    let admitted: ReadonlyArray<PreparedReferenceAssemblyEntryV1> = [];
    const hydration = fullHydrationFixture(cacheRoot);
    const writerLease = fakeWriterLease();
    const fetchAsset = vi.fn();
    const runPreparation = vi.fn<HostedReferencePreparationRunner>(async (input) =>
      preparationReceipt(input)
    );
    const inspectPrepared = vi.fn(async () => ({ status: 'needs-refresh' }));
    const admitPreparedView = vi.fn(async () => ({ trackTypes: ['mRNA'] }));
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [catalogEntryWithPreparedBundle()],
      fetchAsset,
      hydratePreparedBundle: vi.fn(async () => hydration),
      admitPreparedView,
      acquireWriterLease: vi.fn(async () => writerLease),
      publishPreparedSource: vi.fn(async () => {
        admitted = [PREPARED_ENTRY];
        return PREPARED_ENTRY;
      }),
      inspectSourcePublication: vi.fn<HostedReferenceSourceReadinessInspector>(async () => ({
        status: 'ready',
        publicationId: 'focused-source-publication',
        sourceGenerationRoot: cacheRoot,
      })),
      inspectPrepared,
      runPreparation,
      listPrepared: async () => admitted,
    });

    await expect(
      authority.installHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: () => undefined,
      })
    ).resolves.toMatchObject({
      id: PREPARED_ENTRY.id,
      portableView: {
        generationRoot: hydration.generationRoot,
        bundleFingerprint: hydration.bundle.bundleFingerprint,
        trackTypes: ['mRNA'],
      },
    });
    expect(admitPreparedView).toHaveBeenCalledOnce();
    expect(inspectPrepared).not.toHaveBeenCalled();
    expect(runPreparation).not.toHaveBeenCalled();
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it('keeps renderer-only portable view metadata out of strict source readmission', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const hydration = fullHydrationFixture(cacheRoot);
    const inspectedEntries: PreparedReferenceAssemblyEntryV1[] = [];
    const inspectSourcePublication = vi.fn<HostedReferenceSourceReadinessInspector>(
      async ({ entry }) => {
        inspectedEntries.push(entry);
        if (entry.portableView) {
          return {
            status: 'needs-refresh',
            reason: 'source-index-missing',
            message:
              'Prepared reference source admission failed: Prepared reference definition does not match the admitted assembly entry.',
          };
        }
        return {
          status: 'ready',
          publicationId: hydration.bundle.bundleFingerprint,
          sourceGenerationRoot: hydration.generationRoot,
        };
      }
    );
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [catalogEntryWithPreparedBundle()],
      fetchAsset: vi.fn(),
      hydratePreparedBundle: vi.fn(async () => hydration),
      admitPreparedView: vi.fn(async () => ({ trackTypes: ['mRNA'] })),
      inspectSourcePublication,
      inspectPrepared: vi.fn(async () => ({ status: 'needs-refresh' })),
      runPreparation: vi.fn<HostedReferencePreparationRunner>(),
      listPrepared: async () => [PREPARED_ENTRY],
    });

    await expect(
      authority.installHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: () => undefined,
      })
    ).resolves.toMatchObject({
      id: PREPARED_ENTRY.id,
      portableView: {
        generationRoot: hydration.generationRoot,
        bundleFingerprint: hydration.bundle.bundleFingerprint,
        trackTypes: ['mRNA'],
      },
    });
    expect(inspectedEntries.length).toBeGreaterThan(0);
    expect(inspectedEntries.every((entry) => entry.portableView === undefined)).toBe(true);
  });

  it('warm open re-admits the authenticated view without waiting for full-bundle hydration', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const hydration = fullHydrationFixture(cacheRoot);
    const viewHydration = await viewHydrationFixture(cacheRoot);
    const fullHydrationGate = new Promise<PortablePreparedReferenceHydrationResult>(
      () => undefined
    );
    const hydratePreparedBundle = vi.fn(async () => fullHydrationGate);
    const hydratePreparedView = vi.fn(async () => viewHydration);
    const admitPreparedView = vi.fn(async () => ({ trackTypes: ['mRNA'] }));
    const inspectPrepared = vi.fn(async () => ({ status: 'needs-refresh' }));
    const runPreparation = vi.fn<HostedReferencePreparationRunner>();
    const fetchAsset = vi.fn();
    const acquireWriterLease = vi.fn();
    const publishPreparedSource = vi.fn();
    const progress: ReferenceAssetPreparationProgressUpdateV1[] = [];
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [catalogEntryWithPreparedBundle()],
      fetchAsset,
      hydratePreparedBundle,
      hydratePreparedView,
      admitPreparedView,
      acquireWriterLease,
      publishPreparedSource,
      inspectSourcePublication: vi.fn<HostedReferenceSourceReadinessInspector>(async () => ({
        status: 'ready',
        publicationId: hydration.bundle.bundleFingerprint,
        sourceGenerationRoot: hydration.generationRoot,
      })),
      inspectPrepared,
      runPreparation,
      listPrepared: async () => [PREPARED_ENTRY],
    });

    await expect(
      authority.openHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: (update) => progress.push(update),
      })
    ).resolves.toMatchObject({
      status: 'view-ready',
      entry: {
        id: PREPARED_ENTRY.id,
        portableView: {
          generationRoot: viewHydration.generationRoot,
          bundleFingerprint: viewHydration.bundle.bundleFingerprint,
          trackTypes: ['mRNA'],
        },
      },
    });
    await vi.waitFor(() => expect(hydratePreparedBundle).toHaveBeenCalledOnce());
    expect(hydratePreparedView).toHaveBeenCalledOnce();
    expect(admitPreparedView).toHaveBeenCalledOnce();
    expect(inspectPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: PREPARED_ENTRY,
        themeMode: 'light',
      })
    );
    expect(runPreparation).not.toHaveBeenCalled();
    expect(acquireWriterLease).not.toHaveBeenCalled();
    expect(publishPreparedSource).not.toHaveBeenCalled();
    expect(fetchAsset).not.toHaveBeenCalled();
    expect(progress).toContainEqual({
      phase: 'view-ready',
      label: 'pUC19 visualization is ready',
      completed: 1,
      total: 1,
    });
  });

  it.each([true, false])(
    'reuses full local admission only for its published generation: %s',
    async (sameGeneration) => {
      const cacheRoot = await temporaryRoot(temporaryRoots);
      const hydration = {
        ...(await viewHydrationFixture(cacheRoot)),
        hydratedTiers: ['shell', 'view', 'detail', 'search'],
      } as PortablePreparedReferenceHydrationResult;
      const assetGenerationsByTheme = {
        light: {
          contract: 'assembly-reference-asset-generation.v1' as const,
          sourceFingerprint: '1'.repeat(24),
          inventoryFingerprint: '2'.repeat(64),
          themeMode: 'light' as const,
        },
        dark: {
          contract: 'assembly-reference-asset-generation.v1' as const,
          sourceFingerprint: '1'.repeat(24),
          inventoryFingerprint: '3'.repeat(64),
          themeMode: 'dark' as const,
        },
      };
      const hydratePreparedBundle = vi.fn<HostedPreparedBundleHydrator>(
        () => new Promise(() => undefined)
      );
      const inspectSourcePublication = vi.fn<HostedReferenceSourceReadinessInspector>(async () => ({
        status: 'ready',
        publicationId: sameGeneration ? hydration.bundle.bundleFingerprint : 'previous-generation',
        sourceGenerationRoot: hydration.generationRoot,
      }));
      const authority = createHostedReferenceAssetAuthority({
        cacheRoot,
        projectRoot: PROJECT_ROOT,
        sourceBuildFingerprint: 'focused-test',
        indexerBinary: '/unused/injected-indexer',
        catalog: [catalogEntryWithPreparedBundle()],
        listPrepared: async () => [PREPARED_ENTRY],
        inspectSourcePublication,
        hydratePreparedView: async () => hydration,
        hydratePreparedBundle,
        admitPreparedView: async () => ({
          trackTypes: ['mRNA'],
          assetGenerationsByTheme,
          searchReady: true,
        }),
      });
      const result = await authority.openHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: () => undefined,
      });
      expect(result.entry.portableView).toMatchObject({
        assetGenerationsByTheme,
        searchReady: true,
      });
      if (sameGeneration) {
        expect(hydratePreparedBundle).not.toHaveBeenCalled();
        await expect(
          authority.getHostedPreparationStatus({ catalogId: CATALOG_ENTRY.id, themeMode: 'light' })
        ).resolves.toMatchObject({ status: 'ready', entry: result.entry });
        expect(inspectSourcePublication).toHaveBeenCalledOnce();
      } else {
        await vi.waitFor(() => expect(hydratePreparedBundle).toHaveBeenCalledOnce());
        await expect(
          authority.getHostedPreparationStatus({ catalogId: CATALOG_ENTRY.id, themeMode: 'light' })
        ).resolves.toMatchObject({ status: 'preparing' });
      }
    }
  );

  it('returns the terminal generation family instead of a stale cached view on a warm reopen', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const fullHydration = fullHydrationFixture(cacheRoot);
    const viewHydration = await viewHydrationFixture(cacheRoot);
    const lightGeneration = {
      contract: 'assembly-reference-asset-generation.v1' as const,
      sourceFingerprint: '1'.repeat(24),
      inventoryFingerprint: '2'.repeat(64),
      themeMode: 'light' as const,
    };
    const darkGeneration = {
      contract: 'assembly-reference-asset-generation.v1' as const,
      sourceFingerprint: '1'.repeat(24),
      inventoryFingerprint: '3'.repeat(64),
      themeMode: 'dark' as const,
    };
    const hydratePreparedView = vi.fn(async () => viewHydration);
    const hydratePreparedBundle = vi.fn(async () => fullHydration);
    const admitPreparedView = vi.fn(async ({ hydration }) => ({
      trackTypes: ['mRNA'],
      ...(hydration.hydratedTiers.includes('detail')
        ? {
            assetGenerationsByTheme: {
              light: lightGeneration,
              dark: darkGeneration,
            },
          }
        : {}),
    }));
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [catalogEntryWithPreparedBundle()],
      fetchAsset: vi.fn(),
      hydratePreparedView,
      hydratePreparedBundle,
      admitPreparedView,
      inspectSourcePublication: vi.fn<HostedReferenceSourceReadinessInspector>(async () => ({
        status: 'ready',
        publicationId: fullHydration.bundle.bundleFingerprint,
        sourceGenerationRoot: fullHydration.generationRoot,
      })),
      inspectPrepared: vi.fn(async () => ({ status: 'needs-refresh' })),
      runPreparation: vi.fn<HostedReferencePreparationRunner>(),
      listPrepared: async () => [PREPARED_ENTRY],
    });

    const first = await authority.openHosted({
      catalogId: CATALOG_ENTRY.id,
      themeMode: 'light',
      onProgress: () => undefined,
    });
    expect(first.entry.portableView?.assetGenerationsByTheme).toBeUndefined();
    await vi.waitFor(async () => {
      await expect(
        authority.getHostedPreparationStatus({
          catalogId: CATALOG_ENTRY.id,
          themeMode: 'light',
        })
      ).resolves.toMatchObject({ status: 'ready' });
    });

    const reopened = await authority.openHosted({
      catalogId: CATALOG_ENTRY.id,
      themeMode: 'light',
      onProgress: () => undefined,
    });
    expect(reopened.entry.portableView?.assetGenerationsByTheme).toEqual({
      light: lightGeneration,
      dark: darkGeneration,
    });
    expect(hydratePreparedView).toHaveBeenCalledOnce();
    expect(hydratePreparedBundle).toHaveBeenCalledOnce();
  });

  it('atomically repoints a raw fallback generation when the portable bundle recovers', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const hydration = fullHydrationFixture(cacheRoot);
    const writerLease = fakeWriterLease();
    const publishPreparedSource = vi.fn(async () => PREPARED_ENTRY);
    const rawGenerationRoot = join(
      cacheRoot,
      CATALOG_ENTRY.id,
      'generations',
      'raw-fallback-generation'
    );
    const inspectSourcePublication = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'ready',
        publicationId: 'raw-fallback-generation',
        sourceGenerationRoot: rawGenerationRoot,
      })
      .mockResolvedValue({
        status: 'ready',
        publicationId: hydration.bundle.bundleFingerprint,
        sourceGenerationRoot: hydration.generationRoot,
      });
    const progress: ReferenceAssetPreparationProgressUpdateV1[] = [];
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [catalogEntryWithPreparedBundle()],
      fetchAsset: vi.fn(),
      hydratePreparedBundle: vi.fn(async () => hydration),
      admitPreparedView: vi.fn(async () => ({ trackTypes: ['mRNA'] })),
      acquireWriterLease: vi.fn(async () => writerLease),
      publishPreparedSource,
      inspectSourcePublication,
      inspectPrepared: vi.fn(async () => ({ status: 'needs-refresh' })),
      runPreparation: vi.fn<HostedReferencePreparationRunner>(),
      listPrepared: async () => [PREPARED_ENTRY],
    });

    await expect(
      authority.installHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: (update) => progress.push(update),
      })
    ).resolves.toMatchObject({
      id: PREPARED_ENTRY.id,
      portableView: {
        generationRoot: hydration.generationRoot,
        bundleFingerprint: hydration.bundle.bundleFingerprint,
        trackTypes: ['mRNA'],
      },
    });

    expect(publishPreparedSource).toHaveBeenCalledWith({
      cacheRoot,
      definition: catalogEntryWithPreparedBundle(),
      hydration,
      writerLease,
    });
    expect(writerLease.release).toHaveBeenCalledOnce();
    expect(inspectSourcePublication).toHaveBeenCalledTimes(3);
    expect(progress).toContainEqual(
      expect.objectContaining({ phase: 'source-published', completed: 1, total: 1 })
    );
  });

  it.each([false, true])(
    'atomically admits a portable view and preserves usable local source files: %s',
    async (sourcePublished) => {
      const cacheRoot = await temporaryRoot(temporaryRoots);
      const generationRoot = join(
        cacheRoot,
        '.portable-reference-bundles',
        CATALOG_ENTRY.id,
        'bundle'
      );
      const definitionPath = join(generationRoot, 'prepared-reference-definition.v1.json');
      await mkdir(generationRoot, { recursive: true });
      await writeFile(
        definitionPath,
        JSON.stringify({
          contract: 'dnaforge-prepared-reference-definition.v1',
          pipelineRevision: 1,
          id: CATALOG_ENTRY.id,
          name: CATALOG_ENTRY.name,
          organism: CATALOG_ENTRY.organism,
          taxId: CATALOG_ENTRY.taxId,
          assembly: CATALOG_ENTRY.assembly,
          description: CATALOG_ENTRY.description,
          assetCacheKey: CATALOG_ENTRY.id,
          source: {
            fastaSha256: CATALOG_ENTRY.sources.fasta.sha256,
            gffSha256: CATALOG_ENTRY.sources.annotations.sha256,
          },
          provenance: CATALOG_ENTRY.provenance,
          members: [
            {
              ...CATALOG_ENTRY.contigs[0],
              cytobandId: 'puc19',
              manifest: {
                fastaPath: 'prepared/puc19/puc19.fa',
                faiPath: 'prepared/puc19/puc19.fa.fai',
                gffPath: 'prepared/puc19/puc19.gff3.gz',
                tbiPath: 'prepared/puc19/puc19.gff3.gz.tbi',
              },
            },
          ],
        })
      );
      const bundleFingerprint = 'b'.repeat(64);
      const hydration = {
        bundle: {
          assembly: { id: CATALOG_ENTRY.id },
          bundleFingerprint,
          objects: [{ id: 'definition', role: 'prepared-reference-definition' }],
        },
        generationRoot,
        hydratedTiers: ['shell', 'view'],
        objectPaths: new Map([['definition', definitionPath]]),
      } as unknown as PortablePreparedReferenceHydrationResult;
      let releaseViewHydration!: () => void;
      const viewHydrationGate = new Promise<void>((resolveGate) => {
        releaseViewHydration = resolveGate;
      });
      const hydratePreparedView = vi.fn(async () => {
        await viewHydrationGate;
        return hydration;
      });
      const backgroundHydrationGate = new Promise<PortablePreparedReferenceHydrationResult>(
        () => undefined
      );
      const hydratePreparedBundle = vi.fn<HostedPreparedBundleHydrator>(
        async () => backgroundHydrationGate
      );
      const admitPreparedView = vi.fn(async () => ({ trackTypes: ['mRNA'] }));
      const existingPrepared = {
        ...PREPARED_ENTRY,
        members: PREPARED_ENTRY.members.map((member) => ({
          ...member,
          manifest: {
            ...member.manifest!,
            fastaPath: 'prepared/puc19/puc19.fa.gz',
            faiPath: 'prepared/puc19/puc19.fa.gz.fai',
            gziPath: 'prepared/puc19/puc19.fa.gz.gzi',
          },
        })),
      };
      const runPreparation = vi.fn<HostedReferencePreparationRunner>();
      const fetchAsset = vi.fn();
      const progress: ReferenceAssetPreparationProgressUpdateV1[] = [];
      const authority = createHostedReferenceAssetAuthority({
        cacheRoot,
        projectRoot: PROJECT_ROOT,
        sourceBuildFingerprint: 'focused-test',
        indexerBinary: '/unused/injected-indexer',
        catalog: [catalogEntryWithPreparedBundle()],
        hydratePreparedView,
        hydratePreparedBundle,
        admitPreparedView,
        runPreparation,
        fetchAsset,
        listPrepared: async () => (sourcePublished ? [existingPrepared] : []),
        inspectSourcePublication: async () => ({
          status: 'ready',
          publicationId: 'raw-generation',
          sourceGenerationRoot: join(cacheRoot, CATALOG_ENTRY.id, 'generations', 'raw-generation'),
        }),
      });

      let firstOpenSettled = false;
      const firstOpen = authority
        .openHosted({
          catalogId: CATALOG_ENTRY.id,
          themeMode: 'light',
          onProgress: (update) => progress.push(update),
        })
        .then((result) => {
          firstOpenSettled = true;
          return result;
        });
      await vi.waitFor(() => expect(hydratePreparedView).toHaveBeenCalledOnce());
      expect(firstOpenSettled).toBe(false);
      expect(hydratePreparedView).toHaveBeenCalledOnce();
      expect(admitPreparedView).not.toHaveBeenCalled();

      let retrySettled = false;
      const retry = authority
        .openHosted({
          catalogId: CATALOG_ENTRY.id,
          themeMode: 'light',
          onProgress: (update) => progress.push(update),
        })
        .then((result) => {
          retrySettled = true;
          return result;
        });
      await Promise.resolve();
      expect(retrySettled).toBe(false);
      expect(hydratePreparedView).toHaveBeenCalledOnce();

      releaseViewHydration();
      await expect(Promise.all([firstOpen, retry])).resolves.toEqual([
        expect.objectContaining({
          status: 'view-ready',
          entry: expect.objectContaining({
            id: CATALOG_ENTRY.id,
            portableView: { generationRoot, bundleFingerprint, trackTypes: ['mRNA'] },
            members: [
              expect.objectContaining({
                chrom: 'puc19',
                manifest: sourcePublished
                  ? existingPrepared.members[0].manifest
                  : PREPARED_ENTRY.members[0].manifest,
              }),
            ],
          }),
        }),
        expect.objectContaining({
          status: 'view-ready',
          entry: expect.objectContaining({
            id: CATALOG_ENTRY.id,
            portableView: { generationRoot, bundleFingerprint, trackTypes: ['mRNA'] },
          }),
        }),
      ]);
      expect(admitPreparedView).toHaveBeenCalledOnce();

      await expect(
        authority.openHosted({
          catalogId: CATALOG_ENTRY.id,
          themeMode: 'dark',
          onProgress: (update) => progress.push(update),
        })
      ).resolves.toMatchObject({
        entry: {
          portableView: { generationRoot, bundleFingerprint, trackTypes: ['mRNA'] },
        },
      });
      expect(hydratePreparedView).toHaveBeenCalledOnce();
      expect(admitPreparedView).toHaveBeenCalledOnce();
      expect(progress).toContainEqual(
        expect.objectContaining({
          phase: 'verifying-publication',
          label: expect.stringContaining('view is ready'),
        })
      );
      await vi.waitFor(() => expect(hydratePreparedBundle).toHaveBeenCalledOnce());
      expect(runPreparation).not.toHaveBeenCalled();
      expect(fetchAsset).not.toHaveBeenCalled();
    }
  );

  it('starts the raw-source fallback exactly once when background view admission fails', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const fastaBytes = await readFile(PUC19_FASTA);
    const gff3Bytes = await readFile(PUC19_GFF3);
    const fetchAsset = vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      if (path.endsWith(CATALOG_ENTRY.sources.fasta.relativePath)) {
        return new Response(fastaBytes);
      }
      if (path.endsWith(CATALOG_ENTRY.sources.annotations.relativePath)) {
        return new Response(gff3Bytes);
      }
      return new Response(null, { status: 404 });
    });
    const rawPreparationGate = new Promise<never>(() => undefined);
    let markPreparationStarted!: () => void;
    const preparationStarted = new Promise<void>((resolve) => {
      markPreparationStarted = resolve;
    });
    const runPreparation: HostedReferencePreparationRunner = vi.fn(async () => {
      markPreparationStarted();
      return rawPreparationGate;
    });
    const hydratePreparedView = vi.fn(async () => {
      throw new Error('focused view rejection');
    });
    const hydratePreparedBundle = vi.fn<HostedPreparedBundleHydrator>();
    const progress: ReferenceAssetPreparationProgressUpdateV1[] = [];
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [catalogEntryWithPreparedBundle()],
      fetchAsset,
      hydratePreparedView,
      hydratePreparedBundle,
      runPreparation,
      listPrepared: async () => [],
      createOperationId: () => 'view-fallback-once',
    });

    await expect(
      authority.openHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: (update) => progress.push(update),
      })
    ).resolves.toMatchObject({
      status: 'view-ready',
      entry: { id: CATALOG_ENTRY.id },
    });
    await preparationStarted;
    await vi.waitFor(() => expect(runPreparation).toHaveBeenCalledOnce());

    await Promise.all([
      authority.openHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: (update) => progress.push(update),
      }),
      authority.openHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'dark',
        onProgress: (update) => progress.push(update),
      }),
    ]);

    expect(hydratePreparedView).toHaveBeenCalledTimes(2);
    expect(hydratePreparedBundle).not.toHaveBeenCalled();
    expect(runPreparation).toHaveBeenCalledOnce();
    expect(fetchAsset).toHaveBeenCalledTimes(2);
    expect(progress).toContainEqual(
      expect.objectContaining({
        phase: 'prepared-bundle-fallback',
        label: expect.stringContaining('focused view rejection'),
      })
    );
  });

  it('retains the verified raw-source fallback when prepared hydration fails', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    let admitted: ReadonlyArray<PreparedReferenceAssemblyEntryV1> = [];
    const runPreparation = vi.fn<HostedReferencePreparationRunner>(async (input) => {
      admitted = [PREPARED_ENTRY];
      return preparationReceipt(input);
    });
    const progress: ReferenceAssetPreparationProgressUpdateV1[] = [];
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [catalogEntryWithPreparedBundle()],
      fetchAsset: async (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith(CATALOG_ENTRY.sources.fasta.relativePath)) {
          return new Response(await readFile(PUC19_FASTA));
        }
        if (path.endsWith(CATALOG_ENTRY.sources.annotations.relativePath)) {
          return new Response(await readFile(PUC19_GFF3));
        }
        return new Response(null, { status: 404 });
      },
      hydratePreparedBundle: vi.fn(async () => {
        throw new Error('focused prepared rejection');
      }),
      runPreparation,
      inspectSourcePublication: vi.fn<HostedReferenceSourceReadinessInspector>(async () => ({
        status: 'ready',
        publicationId: 'prepared-fallback-source',
        sourceGenerationRoot: join(
          cacheRoot,
          CATALOG_ENTRY.id,
          'generations',
          'prepared-fallback-source'
        ),
      })),
      listPrepared: async () => admitted,
      createOperationId: () => 'prepared-fallback',
    });

    await expect(
      authority.installHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'dark',
        onProgress: (update) => progress.push(update),
      })
    ).resolves.toEqual(PREPARED_ENTRY);
    expect(runPreparation).toHaveBeenCalledOnce();
    expect(progress).toContainEqual(
      expect.objectContaining({
        phase: 'prepared-bundle-fallback',
        label: expect.stringContaining('focused prepared rejection'),
      })
    );
  });

  it('never reports a metadata-only prepared entry as ready', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const inspectSourcePublication = vi.fn<HostedReferenceSourceReadinessInspector>(async () => ({
      status: 'needs-refresh',
      reason: 'source-index-missing',
      message: 'prepared source files are absent',
    }));
    const preparationGate = new Promise<never>(() => undefined);
    const runPreparation: HostedReferencePreparationRunner = vi.fn(async () => preparationGate);
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [CATALOG_ENTRY],
      fetchAsset: async (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith(CATALOG_ENTRY.sources.fasta.relativePath)) {
          return new Response(await readFile(PUC19_FASTA));
        }
        if (path.endsWith(CATALOG_ENTRY.sources.annotations.relativePath)) {
          return new Response(await readFile(PUC19_GFF3));
        }
        return new Response(null, { status: 404 });
      },
      runPreparation,
      inspectSourcePublication,
      listPrepared: async () => [PREPARED_ENTRY],
      createOperationId: () => 'metadata-only-open',
    });

    const opened = await authority.openHosted({
      catalogId: CATALOG_ENTRY.id,
      themeMode: 'light',
      onProgress: () => undefined,
    });
    expect(opened).toMatchObject({
      status: 'view-ready',
      entry: {
        id: CATALOG_ENTRY.id,
        members: [{ chrom: 'puc19' }],
      },
    });
    expect(opened.entry.members[0]).not.toHaveProperty('manifest');
    expect(inspectSourcePublication).toHaveBeenCalled();
    await vi.waitFor(() => expect(runPreparation).toHaveBeenCalledOnce());
  });

  it('reports the source failure that cancelled its pending sibling', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [CATALOG_ENTRY],
      listPrepared: async () => [],
      fetchAsset: async (url, init) => {
        if (new URL(url).pathname.endsWith(CATALOG_ENTRY.sources.annotations.relativePath)) {
          return new Response(null, { status: 404 });
        }
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    });

    await expect(
      authority.installHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: () => undefined,
      })
    ).rejects.toThrow('Could not download hosted GFF3: HTTP 404.');
  });

  it('completes short file writes while concurrently streaming and verifying a real HTTP source pair', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const fastaBytes = await readFile(PUC19_FASTA);
    const gff3Bytes = await readFile(PUC19_GFF3);
    const served = await startCatalogServer(
      servers,
      new Map([
        [`/${CATALOG_ENTRY.sources.fasta.relativePath}`, fastaBytes],
        [`/${CATALOG_ENTRY.sources.annotations.relativePath}`, gff3Bytes],
      ])
    );
    let admitted: ReadonlyArray<PreparedReferenceAssemblyEntryV1> = [];
    let preparationCalls = 0;
    const inspectSourcePublication = vi.fn<HostedReferenceSourceReadinessInspector>(async () => ({
      status: 'ready',
      publicationId: 'focused-source-publication',
      sourceGenerationRoot: cacheRoot,
    }));
    const inspectPrepared = vi.fn(async () => ({ status: 'ready' }));
    const runPreparation = vi.fn<HostedReferencePreparationRunner>(async (input) => {
      preparationCalls += 1;
      const manifest = JSON.parse(await readFile(input.manifestPath!, 'utf8')) as {
        assemblyIdentity: { contract: string; sha256: string };
        assembly: { id: string };
        sources: {
          fasta: { path: string; sha256: string };
          annotations: { path: string; sha256: string };
        };
        provenance: { provider: string; datasetId: string; datasetVersion: string };
        contigs: Array<{ normalizedSequenceSha256: string }>;
      };
      expect(manifest).toMatchObject({
        contract: 'dnaforge-reference-preparation.v2',
        assemblyIdentity: {
          contract: 'dnaforge-reference-assembly-identity.v2',
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
        assembly: { id: 'puc19-l09137-2', accession: 'L09137.2' },
        sources: {
          fasta: {
            sha256: CATALOG_ENTRY.sources.fasta.sha256,
          },
          annotations: {
            format: 'gff3',
            sha256: CATALOG_ENTRY.sources.annotations.sha256,
          },
        },
        provenance: {
          provider: 'NCBI-derived DNAForge fixture',
          datasetId: 'L09137.2',
          datasetVersion: 'dna-indexer-schema-2',
        },
        contigs: [
          {
            chrom: 'puc19',
            sourceSeqId: 'puc19',
            lengthBp: 2_686,
            aliases: { genbank: 'L09137.2' },
            circular: true,
            normalizedSequenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          },
        ],
      });
      expect(input.hostedManifestAdmission).toEqual({
        expectedCatalogId: CATALOG_ENTRY.id,
        expectedFastaSha256: CATALOG_ENTRY.sources.fasta.sha256,
        expectedGffSha256: CATALOG_ENTRY.sources.annotations.sha256,
      });
      expect(await sha256File(manifest.sources.fasta.path)).toBe(
        CATALOG_ENTRY.sources.fasta.sha256
      );
      expect(await sha256File(manifest.sources.annotations.path)).toBe(
        CATALOG_ENTRY.sources.annotations.sha256
      );
      admitted = [PREPARED_ENTRY];
      return preparationReceipt(input);
    });
    const progress: ReferenceAssetPreparationProgressUpdateV1[] = [];
    let shortWriteCalls = 0;
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [CATALOG_ENTRY],
      assetBaseUrl: served.baseUrl,
      allowLoopbackHttpForTests: true,
      openDestinationFile: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        return {
          write: (async (
            bytes: Uint8Array,
            offset = 0,
            length = bytes.byteLength - offset,
            position: number | null = null
          ) => {
            const boundedLength = Math.min(7, length);
            shortWriteCalls += 1;
            return handle.write(bytes, offset, boundedLength, position);
          }) as FileHandle['write'],
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
      runPreparation,
      inspectSourcePublication,
      inspectPrepared,
      listPrepared: async () => admitted,
      createOperationId: () => 'focused-operation',
    });

    await expect(authority.listHosted()).resolves.toEqual([
      expect.objectContaining({
        id: 'puc19-l09137-2',
        downloadBytes: 3_319,
      }),
    ]);
    await expect(
      authority.installHosted({
        catalogId: 'puc19-l09137-2',
        themeMode: 'dark',
        onProgress: (update) => progress.push(update),
      })
    ).resolves.toEqual(PREPARED_ENTRY);

    expect(served.maximumPendingResponses).toBe(2);
    expect(shortWriteCalls).toBeGreaterThan(2);
    expect(served.requestPaths.sort()).toEqual(
      [
        `/${CATALOG_ENTRY.sources.fasta.relativePath}`,
        `/${CATALOG_ENTRY.sources.annotations.relativePath}`,
      ].sort()
    );
    expect(preparationCalls).toBe(1);
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'downloading-reference',
          completed: 0,
          total: 3_319,
        }),
        expect.objectContaining({
          phase: 'verifying-download',
          completed: 3_319,
          total: 3_319,
        }),
        expect.objectContaining({ phase: 'verifying-publication' }),
      ])
    );
    await expect(
      stat(join(cacheRoot, '.hosted-import-staging', 'focused-operation'))
    ).rejects.toThrow();

    const warmProgress: ReferenceAssetPreparationProgressUpdateV1[] = [];
    await expect(
      authority.installHosted({
        catalogId: 'puc19-l09137-2',
        themeMode: 'light',
        onProgress: (update) => warmProgress.push(update),
      })
    ).resolves.toEqual(PREPARED_ENTRY);
    expect(preparationCalls).toBe(1);
    expect(served.requestPaths).toHaveLength(2);
    expect(inspectSourcePublication).toHaveBeenCalledTimes(3);
    expect(inspectPrepared).toHaveBeenCalledOnce();
    expect(warmProgress).toEqual([
      {
        phase: 'checking-hosted-reference',
        label: 'Checking pUC19',
      },
      {
        phase: 'ready',
        label: 'pUC19 is ready',
        completed: 1,
        total: 1,
      },
    ]);
  });

  it.each(['openHosted', 'installHosted'] as const)(
    'uses a complete admitted local publication without downloading or rebuilding a portable replacement: %s',
    async (operation) => {
      const cacheRoot = await temporaryRoot(temporaryRoots);
      const hydratePreparedBundle = vi.fn(async () => {
        throw new Error('network unavailable');
      });
      const fetchAsset = vi.fn();
      const hydratePreparedView = vi.fn(async () => {
        throw new Error('network unavailable');
      });
      const runPreparation = vi.fn<HostedReferencePreparationRunner>();
      const inspectPrepared = vi.fn(async () => ({ status: 'ready' }));
      const authority = createHostedReferenceAssetAuthority({
        cacheRoot,
        projectRoot: PROJECT_ROOT,
        sourceBuildFingerprint: 'focused-test',
        indexerBinary: '/unused/injected-indexer',
        catalog: [catalogEntryWithPreparedBundle()],
        listPrepared: async () => [PREPARED_ENTRY],
        inspectSourcePublication: vi.fn<HostedReferenceSourceReadinessInspector>(async () => ({
          status: 'ready',
          publicationId: 'local-publication',
          sourceGenerationRoot: join(
            cacheRoot,
            CATALOG_ENTRY.id,
            'generations',
            'local-publication'
          ),
        })),
        inspectPrepared,
        hydratePreparedBundle,
        hydratePreparedView,
        fetchAsset,
        runPreparation,
      });

      await expect(
        authority[operation]({
          catalogId: CATALOG_ENTRY.id,
          themeMode: 'light',
          onProgress: () => undefined,
        })
      ).resolves.toEqual(
        operation === 'openHosted'
          ? { status: 'view-ready', entry: PREPARED_ENTRY }
          : PREPARED_ENTRY
      );
      expect(inspectPrepared).toHaveBeenCalledOnce();
      expect(hydratePreparedBundle).not.toHaveBeenCalled();
      expect(hydratePreparedView).not.toHaveBeenCalled();
      expect(fetchAsset).not.toHaveBeenCalled();
      expect(runPreparation).not.toHaveBeenCalled();
    }
  );

  it('repairs stale products from a valid publication without downloading sources again', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const served = await startCatalogServer(
      servers,
      new Map([
        [`/${CATALOG_ENTRY.sources.fasta.relativePath}`, await readFile(PUC19_FASTA)],
        [`/${CATALOG_ENTRY.sources.annotations.relativePath}`, await readFile(PUC19_GFF3)],
      ])
    );
    const inspectPrepared = vi.fn(async () => ({
      status: 'needs-refresh',
      reason: 'child-artifact-missing',
    }));
    const inspectSourcePublication = vi.fn<HostedReferenceSourceReadinessInspector>(async () => ({
      status: 'ready',
      publicationId: 'focused-source-publication',
      sourceGenerationRoot: cacheRoot,
    }));
    const runPreparation = vi.fn<HostedReferencePreparationRunner>(async (input) =>
      preparationReceipt(input)
    );
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [CATALOG_ENTRY],
      assetBaseUrl: served.baseUrl,
      allowLoopbackHttpForTests: true,
      runPreparation,
      inspectSourcePublication,
      inspectPrepared,
      listPrepared: async () => [PREPARED_ENTRY],
      createOperationId: () => 'stale-publication-refresh',
    });
    const progress: ReferenceAssetPreparationProgressUpdateV1[] = [];

    await expect(
      authority.installHosted({
        catalogId: CATALOG_ENTRY.id,
        themeMode: 'light',
        onProgress: (update) => progress.push(update),
      })
    ).resolves.toEqual(PREPARED_ENTRY);

    expect(inspectPrepared).toHaveBeenCalledOnce();
    expect(runPreparation).toHaveBeenCalledOnce();
    expect(runPreparation).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestPath: null,
        publishedEntry: PREPARED_ENTRY,
        expectedPublishedSource: {
          fastaSha256: CATALOG_ENTRY.sources.fasta.sha256,
          gffSha256: CATALOG_ENTRY.sources.annotations.sha256,
        },
      })
    );
    expect(served.requestPaths).toEqual([]);
    expect(progress.at(-1)).toEqual({
      phase: 'ready',
      label: 'pUC19 is ready',
      completed: 1,
      total: 1,
    });
  });

  it('fails closed on altered bytes and removes private staging without invoking preparation', async () => {
    const cacheRoot = await temporaryRoot(temporaryRoots);
    const alteredFasta = Buffer.from(await readFile(PUC19_FASTA));
    alteredFasta[alteredFasta.length - 1] ^= 1;
    const served = await startCatalogServer(
      servers,
      new Map([
        [`/${CATALOG_ENTRY.sources.fasta.relativePath}`, alteredFasta],
        [`/${CATALOG_ENTRY.sources.annotations.relativePath}`, await readFile(PUC19_GFF3)],
      ])
    );
    const runPreparation = vi.fn<HostedReferencePreparationRunner>();
    const authority = createHostedReferenceAssetAuthority({
      cacheRoot,
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
      catalog: [CATALOG_ENTRY],
      assetBaseUrl: served.baseUrl,
      allowLoopbackHttpForTests: true,
      runPreparation,
      listPrepared: async () => [],
      createOperationId: () => 'checksum-failure',
    });

    await expect(
      authority.installHosted({
        catalogId: 'puc19-l09137-2',
        themeMode: 'light',
        onProgress: () => undefined,
      })
    ).rejects.toThrow('Hosted FASTA checksum does not match its catalog admission record.');
    expect(runPreparation).not.toHaveBeenCalled();
    await expect(
      stat(join(cacheRoot, '.hosted-import-staging', 'checksum-failure'))
    ).rejects.toThrow();
  });

  it('permits HTTP only for an explicit loopback test origin', () => {
    const baseInput = {
      cacheRoot: '/tmp/dnaforge-hosted-reference-test',
      projectRoot: PROJECT_ROOT,
      sourceBuildFingerprint: 'focused-test',
      indexerBinary: '/unused/injected-indexer',
    };
    expect(() =>
      createHostedReferenceAssetAuthority({
        ...baseInput,
        assetBaseUrl: 'http://assets.example.test/reference-genomes/v1/',
        allowLoopbackHttpForTests: true,
      })
    ).toThrow('Hosted reference assets require HTTPS.');
    expect(() =>
      createHostedReferenceAssetAuthority({
        ...baseInput,
        assetBaseUrl: 'http://127.0.0.1:9000/reference-genomes/v1/',
      })
    ).toThrow('Hosted reference assets require HTTPS.');
    expect(() =>
      createHostedReferenceAssetAuthority({
        ...baseInput,
        assetBaseUrl: 'http://127.0.0.1:9000/reference-genomes/v1/',
        allowLoopbackHttpForTests: true,
      })
    ).not.toThrow();
  });
});

function preparationReceipt(
  input: ReferenceAssetPreparationInput
): ReferenceAssetPreparationReceipt {
  return {
    command: input.command,
    assemblyId: input.assemblyId ?? '',
    manifestPath: input.manifestPath ?? null,
    projectRoot: input.projectRoot,
    cacheRoot: input.cacheRoot,
    workspaceRoot: input.cacheRoot,
    sourceGenerationRoot: null,
    publication: null,
    themeMode: input.themeMode,
    sourceBuildFingerprint: input.sourceBuildFingerprint,
    durationMs: 0,
    status: 'ready',
    generation: {
      contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'f'.repeat(64),
      themeMode: input.themeMode,
    },
    trackTypes: [],
  };
}

function catalogEntryWithPreparedBundle(): HostedReferenceCatalogDefinitionV1 {
  return {
    ...CATALOG_ENTRY,
    preparedBundle: {
      manifest: {
        relativePath: `objects/sha256/${'a'.repeat(2)}/${'a'.repeat(64)}`,
        sha256: 'a'.repeat(64),
        byteLength: 1,
      },
    },
  };
}

function fullHydrationFixture(cacheRoot: string): PortablePreparedReferenceHydrationResult {
  return {
    bundle: {
      bundleFingerprint: 'c'.repeat(64),
    },
    generationRoot: join(cacheRoot, '.portable-reference-bundles', 'focused-full-hydration'),
    hydratedTiers: ['detail', 'search'],
    objectPaths: new Map(),
  } as unknown as PortablePreparedReferenceHydrationResult;
}

async function viewHydrationFixture(
  cacheRoot: string
): Promise<PortablePreparedReferenceHydrationResult> {
  const generationRoot = join(
    cacheRoot,
    '.portable-reference-bundles',
    CATALOG_ENTRY.id,
    'warm-view'
  );
  const definitionPath = join(generationRoot, 'prepared-reference-definition.v1.json');
  await mkdir(generationRoot, { recursive: true });
  await writeFile(
    definitionPath,
    JSON.stringify({
      contract: 'dnaforge-prepared-reference-definition.v1',
      pipelineRevision: 1,
      id: CATALOG_ENTRY.id,
      name: CATALOG_ENTRY.name,
      organism: CATALOG_ENTRY.organism,
      taxId: CATALOG_ENTRY.taxId,
      assembly: CATALOG_ENTRY.assembly,
      description: CATALOG_ENTRY.description,
      assetCacheKey: CATALOG_ENTRY.id,
      source: {
        fastaSha256: CATALOG_ENTRY.sources.fasta.sha256,
        gffSha256: CATALOG_ENTRY.sources.annotations.sha256,
      },
      provenance: CATALOG_ENTRY.provenance,
      members: [
        {
          ...CATALOG_ENTRY.contigs[0],
          cytobandId: 'puc19',
          manifest: PREPARED_ENTRY.members[0].manifest,
        },
      ],
    })
  );
  return {
    bundle: {
      assembly: { id: CATALOG_ENTRY.id },
      bundleFingerprint: 'd'.repeat(64),
      objects: [{ id: 'definition', role: 'prepared-reference-definition' }],
    },
    generationRoot,
    hydratedTiers: ['shell', 'view'],
    objectPaths: new Map([['definition', definitionPath]]),
  } as unknown as PortablePreparedReferenceHydrationResult;
}

function fakeWriterLease(): ReferenceAssetWriterLease {
  return {
    assertOwned: vi.fn(async () => undefined),
    commitPointer: vi.fn(async () => undefined),
    acceptReconciledCommit: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
}

async function temporaryRoot(temporaryRoots: string[]): Promise<string> {
  const root = join(
    tmpdir(),
    `dnaforge-hosted-reference-${process.pid}-${Date.now()}-${temporaryRoots.length}`
  );
  temporaryRoots.push(root);
  return root;
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function startCatalogServer(
  servers: Server[],
  assets: ReadonlyMap<string, Buffer>
): Promise<{
  readonly baseUrl: string;
  readonly requestPaths: string[];
  readonly maximumPendingResponses: number;
}> {
  const requestPaths: string[] = [];
  const pending: Array<{ response: ServerResponse; bytes: Buffer }> = [];
  let maximumPendingResponses = 0;
  let fallback: NodeJS.Timeout | undefined;
  const flush = (): void => {
    if (fallback) clearTimeout(fallback);
    fallback = undefined;
    for (const { response, bytes } of pending.splice(0)) {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', bytes.byteLength);
      response.end(bytes);
    }
  };
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    requestPaths.push(path);
    const bytes = assets.get(path);
    if (!bytes) {
      response.statusCode = 404;
      response.end();
      return;
    }
    pending.push({ response, bytes });
    maximumPendingResponses = Math.max(maximumPendingResponses, pending.length);
    if (pending.length === assets.size) flush();
    else fallback ??= setTimeout(flush, 500);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Focused hosted-reference server did not bind a TCP port.');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requestPaths,
    get maximumPendingResponses() {
      return maximumPendingResponses;
    },
  };
}
