import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useCanvasStore } from '../canvas/store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type {
  IndexedGenomeBamTrackState,
  IndexedGenomeDataTrackState,
  IndexedGenomeSignalReadPileupViewState,
} from '../../shared/indexed-genome';

const {
  mockReferenceAssetCacheRoot,
  mockReadTextFile,
  mockExists,
  mockOpen,
  mockGetSession,
  mockGetAnnotationTile,
  mockClose,
  mockReadAssemblyAnnotationProductSetInventory,
  mockWriteAssemblyOverviewFeatures,
} = vi.hoisted(() => ({
  mockReferenceAssetCacheRoot: vi.fn(),
  mockReadTextFile: vi.fn(),
  mockExists: vi.fn(),
  mockOpen: vi.fn(),
  mockGetSession: vi.fn(),
  mockGetAnnotationTile: vi.fn(),
  mockClose: vi.fn(),
  mockReadAssemblyAnnotationProductSetInventory: vi.fn(),
  mockWriteAssemblyOverviewFeatures: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    path: { referenceAssetCacheRoot: mockReferenceAssetCacheRoot },
    fs: { exists: mockExists, readTextFile: mockReadTextFile },
    genome: {
      open: mockOpen,
      getSession: mockGetSession,
      getAnnotationTile: mockGetAnnotationTile,
      close: mockClose,
      readAssemblyAnnotationProductSetInventoryV1: mockReadAssemblyAnnotationProductSetInventory,
      writeAssemblyOverviewFeatures: mockWriteAssemblyOverviewFeatures,
    },
  }),
}));

import { openAssembly } from './openAssembly';
import { referenceAssemblyById, type ReferenceAssemblyEntry } from './reference-catalog';

function resetCanvasStore() {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    oversizeScanComplete: true,
  });
}

const grch38 = () => referenceAssemblyById('grch38')!;

function sequenceOnlyAssembly(): ReferenceAssemblyEntry {
  return {
    id: 'gcf-sequence-only',
    name: 'Sequence-only assembly',
    organism: 'Test organism',
    description: 'Prepared reference without an annotation source.',
    assetCacheKey: 'gcf-sequence-only',
    members: [
      {
        chrom: 'contig-1',
        lengthBp: 12_345,
        manifest: {
          fastaPath: 'prepared/contig-1/contig-1.fa',
          faiPath: 'prepared/contig-1/contig-1.fa.fai',
        },
      },
      {
        chrom: 'contig-2',
        lengthBp: 6_789,
        manifest: {
          fastaPath: 'prepared/contig-2/contig-2.fa',
          faiPath: 'prepared/contig-2/contig-2.fa.fai',
        },
      },
    ],
  };
}

const UCSC_TRACK: IndexedGenomeDataTrackState = {
  trackId: 'ucsc:hg38-gc5BaseBw',
  trackType: 'quantitative',
  label: 'GC Percent',
  color: 0x16a34a,
  trackPx: 160,
  laneHeightPx: 48,
  maxLanes: 1,
  visible: true,
  source: {
    admissionVersion: 1,
    uri: 'https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/gc5BaseBw/gc5Base.bw',
    formatId: 'bigwig',
    readerKind: 'bbi',
    scientificKind: 'quantitative',
    quantitativeColumnSemantics: 'continuous-signal',
    assemblyId: 'grch38',
    referenceReceipt: {
      assemblyId: 'grch38',
      referenceSignature: 'grch38',
      sourceSignature: 'gc5BaseBw',
      contigMap: { chr1: 'chr1' },
      checkedContigs: 1,
      status: 'compatible',
      checkedAt: '2026-07-28T00:00:00.000Z',
    },
    provenance: {
      provider: 'ucsc',
      sourceKind: 'ucsc-native',
      catalogId: 'hg38:gc5BaseBw',
      ucscGenome: 'hg38',
      track: 'gc5BaseBw',
      label: 'GC Percent',
    },
    fingerprint: 'ucsc-native\u0000hg38\u0000gc5BaseBw\u0000',
  },
};

const BAM_TRACK: IndexedGenomeBamTrackState = {
  trackId: 'reads',
  label: 'Reads',
  source: { bamPath: '/analysis/reads.bam', indexPath: '/analysis/reads.bam.bai' },
  visible: false,
  coverageCutoffDepth: 80,
};

const SIGNAL_READ_VIEW: IndexedGenomeSignalReadPileupViewState = {
  contract: 'dnaforge.signal-read-pileup-view.v1',
  trackId: 'combined',
  readsTrackId: BAM_TRACK.trackId,
  signalTrackId: UCSC_TRACK.trackId,
  label: 'Coverage to reads',
  visible: true,
  color: 0xa8ceff,
  trackPx: 276,
  laneHeightPx: 3,
  maxLanes: 80,
  overflowBandHeightPx: 36,
  coverageCutoffDepth: 80,
  loadingAnimation: 'diagonal-scan',
};

function tabsOf() {
  return useCanvasStore.getState().panels.main.tabs;
}

function explicitProductPublication(
  storage: 'assembly-cache-root.v1' | 'publication-generation-root.v1',
  sourceFingerprint = 'b'.repeat(24),
  inventoryFingerprint = 'c'.repeat(64)
) {
  return {
    contract: 'reference-asset-publication.v1',
    assetCacheKey: 'grch38',
    publicationId: 'test-generation',
    sourceMaterializationFingerprint: 'a'.repeat(64),
    publishedAtMs: 1,
    productLayout: {
      contract: 'reference-asset-product-layout.v1',
      productManifestContract: 'assembly-annotation-product-set-manifest.v2',
      storage,
      completeness: 'complete',
      requiredAnnotationProducts: (['light', 'dark'] as const).map((themeMode) => ({
        assemblyId: 'grch38',
        themeMode,
        sourceFingerprint,
        inventoryFingerprint,
      })),
    },
  };
}

describe('openAssembly  assembly entity open path)', () => {
  beforeEach(() => {
    resetCanvasStore();
    useWorkspaceStore.setState({ folders: [] });
    mockReferenceAssetCacheRoot.mockReset();
    mockReadTextFile.mockReset();
    mockExists.mockReset();
    mockOpen.mockReset();
    mockGetSession.mockReset();
    mockGetAnnotationTile.mockReset();
    mockClose.mockReset();
    mockReadAssemblyAnnotationProductSetInventory.mockReset();
    mockWriteAssemblyOverviewFeatures.mockReset();
    mockReferenceAssetCacheRoot.mockResolvedValue(
      '/Users/foo/Library/Application Support/DNAForge/reference-assets'
    );
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: 'grch38',
        publicationId: 'test-generation',
        sourceMaterializationFingerprint: 'a'.repeat(64),
        publishedAtMs: 1,
      })
    );
    mockExists.mockResolvedValue(true);
    mockOpen.mockImplementation(async (source) => ({
      sessionId: `indexed-${source.chrom}`,
      sourcePath: source.sourcePath,
      sourceFingerprint: `fingerprint-${source.chrom}`,
      chrom: source.chrom,
      openReady: true,
      coordinateReady: true,
      length: source.manifest.length,
      manifest: source.manifest,
      validationState: 'strong_match',
      openedAt: 1,
      tracks: [],
    }));
    mockGetAnnotationTile.mockImplementation(async (sessionId, request) => ({
      sessionId,
      requestId: `overview-${request.chrom}`,
      trackId: request.trackId,
      chrom: request.chrom,
      start: request.start,
      end: request.end,
      generation: request.generation,
      state: 'ready',
      fidelity: 'summary',
      validationState: 'strong_match',
      byteCount: 1,
      recordCount: 1,
      cacheState: 'hit',
    }));
    mockClose.mockResolvedValue(undefined);
    mockReadAssemblyAnnotationProductSetInventory.mockResolvedValue({
      status: 'ready',
      sourceFingerprint: 'b'.repeat(24),
      inventoryFingerprint: 'c'.repeat(64),
      trackTypes: ['enhancer', 'lnc_RNA', 'mRNA'],
    });
    mockWriteAssemblyOverviewFeatures.mockResolvedValue({ featureCount: 3, path: '/cache' });
  });

  it('opens independent named track views of one reference and refreshes only the requested view', async () => {
    const first = await openAssembly(grch38(), {
      viewEntity: { id: 'track-view:first', name: 'Genes' },
    });
    const second = await openAssembly(grch38(), {
      viewEntity: { id: 'track-view:second', name: 'Coverage' },
    });
    expect(first).not.toBe(second);
    expect(tabsOf().map((tab) => [tab.entityId, tab.label])).toEqual([
      ['track-view:first', 'Genes'],
      ['track-view:second', 'Coverage'],
    ]);
    const before = tabsOf().find((tab) => tab.id === first);
    await openAssembly(grch38(), {
      viewEntity: { id: 'track-view:second', name: 'Coverage' },
      refreshExistingTabOnly: true,
    });
    expect(tabsOf()).toHaveLength(2);
    expect(tabsOf().find((tab) => tab.id === first)).toBe(before);
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(second);
  });

  it('opens one sequence tab carrying the full 24-chromosome assembly at scope:all', async () => {
    const tabId = await openAssembly(grch38());
    expect(tabId).toBeTruthy();
    const tab = tabsOf().find((t) => t.id === tabId)!;
    expect(tab.type).toBe('sequence');
    expect(tab.entityId).toMatch(/^track-view-/u);
    expect(tab.isDirty).toBe(true);
    expect(tab.sequenceDocument).toEqual({
      kind: 'indexed-sequence',
      documentId: tab.entityId,
    });
    expect(tab.label).toBe('GRCh38 (human)');
    expect(tab.loadStatus).toBe('indexed-pending');
    expect(tab.indexedGenome?.assembly?.assemblyId).toBe('grch38');
    expect(tab.indexedGenome?.assembly?.chromosomes).toHaveLength(24);
    expect(tab.indexedGenome?.assemblyAnnotationTrackTypes).toEqual([
      'enhancer',
      'lnc_RNA',
      'mRNA',
    ]);
    expect(tab.indexedGenome?.scope).toEqual({ kind: 'all' });
  });

  it('binds every newly opened assembly and its prepared products to the two-lane default', async () => {
    const tabId = await openAssembly(grch38());
    const tab = tabsOf().find((candidate) => candidate.id === tabId)!;

    expect(tab.initialAnnotationMapperPolicy).toEqual({
      isoformMode: 'canonical',
      laneLimit: 2,
    });
    expect(
      mockReadAssemblyAnnotationProductSetInventory.mock.calls[0]?.[0].seedProduct.requestedPolicy
        .laneLimit
    ).toBe(2);
  });

  it('opens a shipped assembly only after its current-theme committed product is ready', async () => {
    const tabId = await openAssembly(grch38());

    expect(tabId).toBeTruthy();
    expect(mockReadAssemblyAnnotationProductSetInventory).toHaveBeenCalledTimes(1);
    expect(
      mockReadAssemblyAnnotationProductSetInventory.mock.calls[0]?.[0].seedProduct
    ).toMatchObject({
      assemblyId: 'grch38',
      scope: expect.objectContaining({ kind: 'complete-assembly' }),
      chromosomes: expect.arrayContaining([expect.objectContaining({ chrom: 'chr1' })]),
      artifact: expect.objectContaining({ themeMode: 'light', trackType: 'mRNA' }),
    });
  });

  it('prepares the exact ordered annotation sources declared by the assembly manifest', async () => {
    const entry = grch38();

    expect(await openAssembly(entry)).toBeTruthy();

    const product = mockReadAssemblyAnnotationProductSetInventory.mock.calls[0]?.[0].seedProduct;
    expect(
      product.chromosomes.map((chromosome: { chrom: string; sourcePath?: string | null }) => ({
        chrom: chromosome.chrom,
        sourcePath: chromosome.sourcePath,
      }))
    ).toEqual(
      entry.members.map((member) => ({
        chrom: member.chrom,
        sourcePath:
          `/Users/foo/Library/Application Support/DNAForge/reference-assets/grch38/` +
          `generations/test-generation/` +
          member.manifest?.gffPath,
      }))
    );
  });

  it('performs read-only admission without opening per-chromosome indexing sessions', async () => {
    expect(await openAssembly(grch38())).toBeTruthy();
    expect(mockReadAssemblyAnnotationProductSetInventory).toHaveBeenCalledTimes(1);
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetAnnotationTile).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('reports honest pre-tab preparation phases while the atomic product set is built', async () => {
    const phases: string[] = [];

    const tabId = await openAssembly(grch38(), {
      onProgress: (progress) => phases.push(progress.phase),
    });

    expect(tabId).toBeTruthy();
    expect(phases).toEqual([
      'validating-reference',
      'reading-annotation-inventory',
      'opening-indexed-genome',
    ]);
  });

  it('uses a source-bound committed inventory without rebuilding the full source graph', async () => {
    mockReadAssemblyAnnotationProductSetInventory.mockResolvedValue({
      status: 'ready',
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'b'.repeat(64),
      trackTypes: ['enhancer', 'lnc_RNA', 'mRNA'],
    });

    expect(await openAssembly(grch38())).toBeTruthy();
    expect(mockReadAssemblyAnnotationProductSetInventory).toHaveBeenCalledTimes(1);
  });

  it('does not mount a viewer tab while prepared-asset admission is unresolved', async () => {
    let finish!: (value: unknown) => void;
    mockReadAssemblyAnnotationProductSetInventory.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );

    const phases: string[] = [];
    const opening = openAssembly(grch38(), {
      annotationThemeMode: 'dark',
      onProgress: (progress) => phases.push(progress.phase),
    });
    await vi.waitFor(() =>
      expect(mockReadAssemblyAnnotationProductSetInventory).toHaveBeenCalled()
    );
    expect(tabsOf()).toHaveLength(0);
    expect(phases.at(-1)).toBe('reading-annotation-inventory');
    finish({
      status: 'ready',
      sourceFingerprint: 'b'.repeat(24),
      inventoryFingerprint: 'c'.repeat(64),
      trackTypes: ['enhancer', 'lnc_RNA', 'mRNA'],
    });

    expect(await opening).toBeTruthy();
    expect(tabsOf()).toHaveLength(1);
    expect(phases.at(-1)).toBe('opening-indexed-genome');
    expect(
      mockReadAssemblyAnnotationProductSetInventory.mock.calls[0]?.[0].seedProduct.artifact
        .themeMode
    ).toBe('light');
  });

  it('opens the coordinate shell with annotation and search capabilities pending', async () => {
    mockReadAssemblyAnnotationProductSetInventory.mockResolvedValue({ status: 'unavailable' });

    const phases: string[] = [];

    expect(
      await openAssembly(grch38(), {
        onProgress: (progress) => phases.push(progress.phase),
      })
    ).toBeTruthy();
    expect(tabsOf()).toHaveLength(1);
    expect(tabsOf()[0]?.indexedGenome).toMatchObject({
      assemblySourceReadiness: 'ready',
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
    });
    expect(phases.at(-1)).toBe('opening-indexed-genome');
  });

  it('admits a layout-less production publication from its immutable generation products', async () => {
    const generationRoot =
      '/Users/foo/Library/Application Support/DNAForge/reference-assets/grch38/' +
      'generations/test-generation';
    mockReadAssemblyAnnotationProductSetInventory.mockImplementation(async (input) =>
      input.seedProduct.workspaceRoot === generationRoot
        ? {
            status: 'ready',
            sourceFingerprint: 'b'.repeat(24),
            inventoryFingerprint: 'c'.repeat(64),
            trackTypes: ['enhancer', 'lnc_RNA', 'mRNA'],
          }
        : { status: 'unavailable' }
    );

    const tabId = await openAssembly(grch38());

    expect(
      mockReadAssemblyAnnotationProductSetInventory.mock.calls.map(
        ([input]) => input.seedProduct.workspaceRoot
      )
    ).toEqual([generationRoot]);
    expect(tabsOf().find((tab) => tab.id === tabId)?.indexedGenome).toMatchObject({
      workspaceRoot: generationRoot,
      assemblyAnnotationProductsReadiness: 'ready',
    });
  });

  it('falls back to identity-validated shared products for a layout-less legacy publication', async () => {
    useWorkspaceStore.setState({
      folders: [
        {
          path: '/Users/foo/waypoint/test-fixtures/sources',
          name: 'sources',
          addedAt: 1,
        },
      ],
    });
    const generationRoot =
      '/Users/foo/Library/Application Support/DNAForge/reference-assets/grch38/' +
      'generations/test-generation';
    const sharedRoot = '/Users/foo/Library/Application Support/DNAForge/reference-assets/grch38';
    mockReadAssemblyAnnotationProductSetInventory.mockImplementation(async (input) =>
      input.seedProduct.workspaceRoot === sharedRoot
        ? {
            status: 'ready',
            sourceFingerprint: 'b'.repeat(24),
            inventoryFingerprint: 'c'.repeat(64),
            trackTypes: ['enhancer', 'lnc_RNA', 'mRNA'],
          }
        : { status: 'unavailable' }
    );

    const tabId = await openAssembly(grch38());

    expect(
      mockReadAssemblyAnnotationProductSetInventory.mock.calls.map(
        ([input]) => input.seedProduct.workspaceRoot
      )
    ).toEqual([generationRoot, sharedRoot]);
    expect(tabsOf().find((tab) => tab.id === tabId)?.indexedGenome?.workspaceRoot).toBe(sharedRoot);
  });

  it('binds every annotation read to the exact generation-local product declared by the pointer', async () => {
    mockReadTextFile.mockResolvedValue(
      JSON.stringify(explicitProductPublication('publication-generation-root.v1'))
    );

    const tabId = await openAssembly(grch38(), { annotationThemeMode: 'dark' });
    const state = tabsOf().find((tab) => tab.id === tabId)?.indexedGenome;
    const generationRoot =
      '/Users/foo/Library/Application Support/DNAForge/reference-assets/grch38/' +
      'generations/test-generation';

    expect(
      mockReadAssemblyAnnotationProductSetInventory.mock.calls[0]?.[0].seedProduct.workspaceRoot
    ).toBe(generationRoot);
    expect(state?.workspaceRoot).toBe(generationRoot);
    expect(state?.assemblyAssetGenerationsByTheme).toEqual({
      light: {
        contract: 'assembly-reference-asset-generation.v1',
        sourceFingerprint: 'b'.repeat(24),
        inventoryFingerprint: 'c'.repeat(64),
        themeMode: 'light',
      },
      dark: {
        contract: 'assembly-reference-asset-generation.v1',
        sourceFingerprint: 'b'.repeat(24),
        inventoryFingerprint: 'c'.repeat(64),
        themeMode: 'dark',
      },
    });
  });

  it('keeps the coordinate shell pending instead of opening incompatible published products', async () => {
    mockReadTextFile.mockResolvedValue(
      JSON.stringify(
        explicitProductPublication('publication-generation-root.v1', 'd'.repeat(24), 'e'.repeat(64))
      )
    );

    const tabId = await openAssembly(grch38(), { annotationThemeMode: 'light' });
    const state = tabsOf().find((tab) => tab.id === tabId)?.indexedGenome;

    expect(tabId).toBeTruthy();
    expect(state?.assemblyAnnotationProductsReadiness).toBe('pending');
    expect(state?.assemblyAssetGeneration).toBeUndefined();
    expect(state?.assemblyAssetGenerationsByTheme).toBeUndefined();
  });

  it('anchors the genome session on the first indexed chromosome (chr1), not the entityId', async () => {
    const tabId = await openAssembly(grch38());
    const tab = tabsOf().find((t) => t.id === tabId)!;
    expect(tab.indexedGenome?.chrom).toBe('chr1');
    expect(tab.indexedGenome?.sourcePath).toMatch(
      /reference-assets\/grch38\/generations\/test-generation\/prepared\/chr1\/chr1\.gff3\.gz$/
    );
    expect(tab.indexedGenome?.sourcePath).not.toBe(tab.entityId);
  });

  it('opens a prepared sequence-only assembly from FASTA without probing annotation products', async () => {
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: 'gcf-sequence-only',
        publicationId: 'sequence-generation',
        sourceMaterializationFingerprint: 'd'.repeat(64),
        publishedAtMs: 2,
      })
    );

    const tabId = await openAssembly(sequenceOnlyAssembly());
    const state = tabsOf().find((tab) => tab.id === tabId)?.indexedGenome;

    expect(state).toMatchObject({
      sourcePath:
        '/Users/foo/Library/Application Support/DNAForge/reference-assets/' +
        'gcf-sequence-only/generations/sequence-generation/prepared/contig-1/contig-1.fa',
      sourceExt: 'fa',
      chrom: 'contig-1',
      manifest: {
        gffPath: null,
        tbiPath: null,
      },
      assemblySourceReadiness: 'ready',
      assemblyAnnotationProductsReadiness: 'not-applicable',
      assemblySearchReadiness: 'not-applicable',
    });
    expect(state?.assembly?.chromosomes.map((chromosome) => chromosome.chrom)).toEqual([
      'contig-1',
      'contig-2',
    ]);
    expect(mockReadAssemblyAnnotationProductSetInventory).not.toHaveBeenCalled();
  });

  it('rejects a publication whose non-anchor member files are missing', async () => {
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: 'gcf-sequence-only',
        publicationId: 'sequence-generation',
        sourceMaterializationFingerprint: 'd'.repeat(64),
        publishedAtMs: 2,
      })
    );
    mockExists.mockImplementation(async (path: string) => !path.includes('/contig-2/'));

    await expect(openAssembly(sequenceOnlyAssembly())).rejects.toThrow(
      /missing for contig-2.*Add the reference again/u
    );
    expect(tabsOf()).toHaveLength(0);
    expect(mockExists).toHaveBeenCalledWith(
      expect.stringContaining('/prepared/contig-2/contig-2.fa')
    );
    expect(mockExists).toHaveBeenCalledWith(
      expect.stringContaining('/prepared/contig-2/contig-2.fa.fai')
    );
  });

  it('uses a separate portable view generation without claiming source or search readiness', async () => {
    mockReadTextFile.mockRejectedValue(new Error('no ordinary local publication'));
    mockExists.mockResolvedValue(false);
    const generationRoot =
      '/Users/foo/Library/Application Support/DNAForge/reference-assets/.portable-reference-bundles/grch38/bundle';
    const tabId = await openAssembly(
      {
        ...grch38(),
        portableView: {
          generationRoot,
          bundleFingerprint: 'd'.repeat(64),
          trackTypes: ['enhancer', 'mRNA'],
          assetGenerationsByTheme: {
            light: {
              contract: 'assembly-reference-asset-generation.v1',
              sourceFingerprint: 'b'.repeat(24),
              inventoryFingerprint: 'c'.repeat(64),
              themeMode: 'light',
            },
            dark: {
              contract: 'assembly-reference-asset-generation.v1',
              sourceFingerprint: 'b'.repeat(24),
              inventoryFingerprint: 'e'.repeat(64),
              themeMode: 'dark',
            },
          },
        },
      },
      { annotationThemeMode: 'dark' }
    );
    const state = tabsOf().find((tab) => tab.id === tabId)?.indexedGenome;

    expect(state?.manifest.gffPath).toBe(`${generationRoot}/prepared/chr1/chr1.gff3.gz`);
    expect(state?.workspaceRoot).toBe(
      '/Users/foo/Library/Application Support/DNAForge/reference-assets/grch38'
    );
    expect(state?.assemblySourceReadiness).toBe('pending');
    expect(state?.assemblyAnnotationProductsReadiness).toBe('ready');
    expect(state?.assemblyAnnotationTrackTypes).toEqual(['enhancer', 'mRNA']);
    expect(state?.assemblySearchReadiness).toBe('pending');
    expect(state?.assemblyAssetGeneration).toEqual(state?.assemblyAssetGenerationsByTheme?.light);
    expect(state?.assemblyAssetGenerationsByTheme?.light.themeMode).toBe('light');
    expect(mockReadAssemblyAnnotationProductSetInventory).not.toHaveBeenCalled();
  });

  it('keeps an admitted version on its own sources after the current pointer advances', async () => {
    const generationRoot =
      '/Users/foo/Library/Application Support/DNAForge/reference-assets/grch38/generations/' +
      'd'.repeat(64);
    const tabId = await openAssembly({
      ...grch38(),
      portableView: {
        generationRoot,
        bundleFingerprint: 'd'.repeat(64),
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
    });
    const state = tabsOf().find((tab) => tab.id === tabId)?.indexedGenome;
    expect(state?.manifest.fastaPath).toBe(generationRoot + '/prepared/chr1/chr1.fa.gz');
    expect(state?.assemblySourceReadiness).toBe('ready');
    expect(state?.sourcePath.startsWith(generationRoot)).toBe(true);
  });

  it('opens the portable view without borrowing an older raw publication with different source filenames', async () => {
    const generationRoot =
      '/Users/foo/Library/Application Support/DNAForge/reference-assets/grch38/generations/' +
      'd'.repeat(64);
    mockExists.mockImplementation(
      async (path: string) => path.endsWith('.fa.gz') || path.endsWith('.fa.gz.fai')
    );
    const reference = grch38();
    const tabId = await openAssembly({
      ...reference,
      members: reference.members.map((member) => ({
        ...member,
        manifest: member.manifest && {
          ...member.manifest,
          fastaPath: member.manifest.fastaPath.replace('.fa.gz', '.fa'),
          faiPath: member.manifest.faiPath.replace('.fa.gz.fai', '.fa.fai'),
        },
      })),
      portableView: { generationRoot, bundleFingerprint: 'd'.repeat(64), trackTypes: ['mRNA'] },
    });
    const state = tabsOf().find((tab) => tab.id === tabId)?.indexedGenome;
    expect(state?.manifest.fastaPath).toBe(generationRoot + '/prepared/chr1/chr1.fa');
    expect(state?.assembly?.chromosomes).toHaveLength(24);
    expect(state?.assemblySourceReadiness).toBe('pending');
    expect(state?.assemblySearchReadiness).toBe('pending');
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it('keeps the portable theme family authoritative after ordinary preparation becomes ready', async () => {
    const portableLight = {
      contract: 'assembly-reference-asset-generation.v1' as const,
      sourceFingerprint: '1'.repeat(24),
      inventoryFingerprint: '2'.repeat(64),
      themeMode: 'light' as const,
    };
    const portableDark = {
      contract: 'assembly-reference-asset-generation.v1' as const,
      sourceFingerprint: '1'.repeat(24),
      inventoryFingerprint: '3'.repeat(64),
      themeMode: 'dark' as const,
    };
    mockReadAssemblyAnnotationProductSetInventory.mockResolvedValue({
      status: 'ready',
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'b'.repeat(64),
      trackTypes: ['enhancer', 'mRNA'],
    });

    const tabId = await openAssembly(
      {
        ...grch38(),
        portableView: {
          generationRoot:
            '/Users/foo/Library/Application Support/DNAForge/reference-assets/' +
            '.portable-reference-bundles/grch38/bundle',
          bundleFingerprint: 'd'.repeat(64),
          trackTypes: ['enhancer', 'mRNA'],
          assetGenerationsByTheme: { light: portableLight, dark: portableDark },
          searchReady: true,
        },
      },
      { annotationThemeMode: 'dark' }
    );
    const state = tabsOf().find((tab) => tab.id === tabId)?.indexedGenome;

    expect(state?.assemblyAnnotationProductsReadiness).toBe('ready');
    expect(state?.assemblySearchReadiness).toBe('ready');
    expect(state?.workspaceRoot).toBe(
      '/Users/foo/Library/Application Support/DNAForge/reference-assets/grch38'
    );
    expect(state?.assemblyAssetGeneration).toEqual(portableLight);
    expect(state?.assemblyAssetGenerationsByTheme).toEqual({
      light: portableLight,
      dark: portableDark,
    });
    expect(state?.assemblyAssetGeneration).not.toMatchObject({
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'b'.repeat(64),
    });
    expect(mockReadAssemblyAnnotationProductSetInventory).not.toHaveBeenCalled();
  });

  it('does not let a view-only refresh revoke the admitted family for the same portable bundle', async () => {
    const portableLight = {
      contract: 'assembly-reference-asset-generation.v1' as const,
      sourceFingerprint: '1'.repeat(24),
      inventoryFingerprint: '2'.repeat(64),
      themeMode: 'light' as const,
    };
    const portableDark = {
      contract: 'assembly-reference-asset-generation.v1' as const,
      sourceFingerprint: '1'.repeat(24),
      inventoryFingerprint: '3'.repeat(64),
      themeMode: 'dark' as const,
    };
    const portableView = {
      generationRoot:
        '/Users/foo/Library/Application Support/DNAForge/reference-assets/' +
        '.portable-reference-bundles/grch38/bundle',
      bundleFingerprint: 'd'.repeat(64),
      trackTypes: ['enhancer', 'mRNA'],
    };

    const tabId = await openAssembly(
      {
        ...grch38(),
        portableView: {
          ...portableView,
          assetGenerationsByTheme: { light: portableLight, dark: portableDark },
        },
      },
      { annotationThemeMode: 'light' }
    );

    expect(
      await openAssembly(
        { ...grch38(), portableView },
        {
          annotationThemeMode: 'dark',
          refreshExistingTabOnly: true,
          viewEntity: {
            id: tabsOf().find((tab) => tab.id === tabId)!.entityId,
            name: 'Human view',
          },
        }
      )
    ).toBe(tabId);

    const state = tabsOf().find((tab) => tab.id === tabId)?.indexedGenome;
    expect(state?.assemblyPortableBundleFingerprint).toBe('d'.repeat(64));
    expect(state?.assemblyAssetGenerationsByTheme).toEqual({
      light: portableLight,
      dark: portableDark,
    });
    expect(state?.assemblyAssetGeneration).toEqual(portableLight);
  });

  it('does not retain a generation family across a portable bundle replacement', async () => {
    const portableLight = {
      contract: 'assembly-reference-asset-generation.v1' as const,
      sourceFingerprint: '1'.repeat(24),
      inventoryFingerprint: '2'.repeat(64),
      themeMode: 'light' as const,
    };
    const portableDark = {
      contract: 'assembly-reference-asset-generation.v1' as const,
      sourceFingerprint: '1'.repeat(24),
      inventoryFingerprint: '3'.repeat(64),
      themeMode: 'dark' as const,
    };
    const generationRoot =
      '/Users/foo/Library/Application Support/DNAForge/reference-assets/' +
      '.portable-reference-bundles/grch38/bundle';

    const tabId = await openAssembly({
      ...grch38(),
      portableView: {
        generationRoot,
        bundleFingerprint: 'd'.repeat(64),
        trackTypes: ['mRNA'],
        assetGenerationsByTheme: { light: portableLight, dark: portableDark },
      },
    });
    await openAssembly(
      {
        ...grch38(),
        portableView: {
          generationRoot,
          bundleFingerprint: 'e'.repeat(64),
          trackTypes: ['mRNA'],
        },
      },
      {
        annotationThemeMode: 'dark',
        refreshExistingTabOnly: true,
        viewEntity: { id: tabsOf().find((tab) => tab.id === tabId)!.entityId, name: 'Human view' },
      }
    );

    const state = tabsOf().find((tab) => tab.id === tabId)?.indexedGenome;
    expect(state?.assemblyPortableBundleFingerprint).toBe('e'.repeat(64));
    expect(state?.assemblyAssetGeneration).toBeUndefined();
    expect(state?.assemblyAssetGenerationsByTheme).toBeUndefined();
  });

  it('keeps coordinates admitted but annotations pending until the portable detail family commits', async () => {
    mockReadAssemblyAnnotationProductSetInventory.mockResolvedValue({ status: 'unavailable' });
    const generationRoot =
      '/Users/foo/Library/Application Support/DNAForge/reference-assets/.portable-reference-bundles/grch38/bundle';
    const tabId = await openAssembly({
      ...grch38(),
      portableView: {
        generationRoot,
        bundleFingerprint: 'd'.repeat(64),
        trackTypes: ['enhancer', 'mRNA'],
      },
    });
    const state = tabsOf().find((tab) => tab.id === tabId)?.indexedGenome;

    expect(state?.sourcePath).toContain('/generations/test-generation/');
    expect(state?.assemblySourceReadiness).toBe('ready');
    expect(state?.assemblyAnnotationProductsReadiness).toBe('pending');
    expect(state?.assemblyAnnotationTrackTypes).toEqual(['enhancer', 'mRNA']);
    expect(state?.assemblySearchReadiness).toBe('pending');
    expect(mockReadAssemblyAnnotationProductSetInventory).not.toHaveBeenCalled();
  });

  it('opens independent unsaved views of the same assembly', async () => {
    const a = await openAssembly(grch38());
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: 'grch38',
        publicationId: 'replacement-generation',
        sourceMaterializationFingerprint: 'b'.repeat(64),
        publishedAtMs: 2,
      })
    );
    const b = await openAssembly(grch38());
    expect(a).not.toBe(b);
    expect(tabsOf()).toHaveLength(2);
    expect(tabsOf().every((tab) => tab.isDirty)).toBe(true);
    expect(tabsOf()[0]?.indexedGenome?.sourcePath).toContain('/generations/test-generation/');
    expect(tabsOf()[1]?.indexedGenome?.sourcePath).toContain(
      '/generations/replacement-generation/'
    );
    expect(mockReadTextFile).toHaveBeenCalledTimes(2);

    resetCanvasStore();
    const c = await openAssembly(grch38());
    expect(tabsOf().find((tab) => tab.id === c)?.indexedGenome?.sourcePath).toContain(
      '/generations/replacement-generation/'
    );
  });

  it('preserves unified data tracks while refreshing a mounted hosted assembly', async () => {
    const tabId = await openAssembly(grch38());
    const current = tabsOf().find((tab) => tab.id === tabId);
    expect(current?.indexedGenome).toBeTruthy();
    useCanvasStore.getState().updateTab('main', tabId!, {
      indexedGenome: {
        ...current!.indexedGenome!,
        dataTracks: [UCSC_TRACK],
      },
    });

    expect(
      await openAssembly(grch38(), {
        annotationThemeMode: 'dark',
        refreshExistingTabOnly: true,
        viewEntity: { id: current!.entityId, name: current!.label },
      })
    ).toBe(tabId);

    expect(tabsOf().find((tab) => tab.id === tabId)?.indexedGenome?.dataTracks).toEqual([
      UCSC_TRACK,
    ]);
  });

  it('stores an initial annotation policy atomically on the new full-assembly tab', async () => {
    const tabId = await openAssembly(grch38(), {
      initialAnnotationMapperPolicy: { isoformMode: 'expanded', laneLimit: 12 },
    });
    const tab = tabsOf().find((candidate) => candidate.id === tabId)!;
    expect(tab.initialAnnotationMapperPolicy).toEqual({
      isoformMode: 'expanded',
      laneLimit: 12,
    });
  });

  it('cancels before the first canvas mutation when the commit guard expires', async () => {
    await expect(openAssembly(grch38(), { commitGuard: () => false })).resolves.toBeNull();
    expect(tabsOf()).toHaveLength(0);
  });

  it('commits a fully resolved portable view with the assembly tab', async () => {
    const restoreCommand = {
      id: 'portable-restore-1',
      viewport: { kind: 'locus' as const, chrom: 'chr1', start0: 120, end0: 420 },
      annotationPolicy: { isoformMode: 'expanded' as const, laneLimit: 12 },
      visibleAnnotationTrackIds: ['gene'],
      orderedAnnotationTrackIds: ['gene', 'mRNA'],
    };
    const tabId = await openAssembly(grch38(), {
      initialAnnotationMapperPolicy: restoreCommand.annotationPolicy,
      commitGuard: () => true,
      restoreView: {
        scope: { kind: 'locus', chrom: 'chr1', start: 120, end: 420 },
        dataTracks: [UCSC_TRACK],
        bamTracks: [BAM_TRACK],
        signalReadPileupViews: [SIGNAL_READ_VIEW],
        annotationTrackTypes: ['gene', 'mRNA'],
        indexedViewport: { start0: 120, end0: 420 },
        command: restoreCommand,
      },
    });
    const tab = tabsOf().find((candidate) => candidate.id === tabId);

    expect(tab).toMatchObject({
      initialAnnotationMapperPolicy: restoreCommand.annotationPolicy,
      indexedGenome: {
        scope: { kind: 'locus', chrom: 'chr1', start: 120, end: 420 },
        dataTracks: [UCSC_TRACK],
        bamTracks: [BAM_TRACK],
        signalReadPileupViews: [SIGNAL_READ_VIEW],
        assemblyAnnotationTrackTypes: ['gene', 'mRNA'],
      },
      viewState: {
        indexedViewport: { start0: 120, end0: 420 },
        indexedViewportCommand: null,
        indexedGenomeViewRestoreCommand: restoreCommand,
      },
    });
  });

  it('keeps each view’s annotation policy independent', async () => {
    const firstId = await openAssembly(grch38());
    const secondId = await openAssembly(grch38(), {
      initialAnnotationMapperPolicy: { isoformMode: 'expanded', laneLimit: 8 },
    });
    expect(secondId).not.toBe(firstId);
    expect(tabsOf().find((tab) => tab.id === secondId)?.initialAnnotationMapperPolicy).toEqual({
      isoformMode: 'expanded',
      laneLimit: 8,
    });
    expect(tabsOf().find((tab) => tab.id === firstId)?.initialAnnotationMapperPolicy).toEqual({
      isoformMode: 'canonical',
      laneLimit: 2,
    });
  });

  it('opens from application storage without requiring a development project root', async () => {
    expect(await openAssembly(grch38())).toBeTruthy();
    expect(mockReferenceAssetCacheRoot).toHaveBeenCalledTimes(1);
    expect(tabsOf()).toHaveLength(1);
  });

  it('rejects a committed publication when its prepared source is missing on disk', async () => {
    mockExists.mockResolvedValue(false);
    await expect(openAssembly(grch38())).rejects.toThrow(/Prepared reference files are missing/u);
    expect(tabsOf()).toHaveLength(0);
    expect(mockReadAssemblyAnnotationProductSetInventory).not.toHaveBeenCalled();
  });

  it('opens an ideogram-only shell without reading mutable canonical paths when no publication is committed', async () => {
    mockReadTextFile.mockRejectedValue(new Error('ENOENT'));

    expect(await openAssembly(grch38())).toBeTruthy();
    expect(mockExists).not.toHaveBeenCalled();
    expect(tabsOf()).toHaveLength(1);
    expect(tabsOf()[0]?.indexedGenome?.assemblySourceReadiness).toBe('pending');
  });

  it('persists a JSON-serializable assembly (survives the canvas-store round-trip)', async () => {
    await openAssembly(grch38());
    const tab = tabsOf()[0];
    const json = JSON.stringify(tab.indexedGenome);
    const back = JSON.parse(json);
    expect(back.assembly.chromosomes).toHaveLength(24);
    expect(back.scope).toEqual({ kind: 'all' });
  });
});
