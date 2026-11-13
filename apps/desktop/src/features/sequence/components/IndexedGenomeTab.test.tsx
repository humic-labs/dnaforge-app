import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { annotationTypeBadgeStyle } from '@waypoint/genome-renderer/pure';

import type { Tab } from '../../canvas/types';
import { useCanvasStore } from '../../canvas/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import * as analytics from '../../../lib/analytics';
import type { GenomeOpenSource, IndexedGenomeUcscTrackState } from '../../../shared/indexed-genome';
import { useLaneContractStore } from '../lane-contract-store';
import { buildGenomeAssembly, referenceAssemblyById } from '../reference-catalog';
import {
  IndexedGenomeTab,
  genomeSessionCapabilityUpgradeSource,
  indexedAnnotationBadgeType,
  tabStateWithPreparedAssemblyProduct,
} from './IndexedGenomeTab';

const {
  mockInit,
  mockGetSequence,
  mockGetSequenceWindow,
  mockGetFeatures,
  mockSearchSequence,
  mockQueryAssemblyAnnotationSearch,
  mockReadAssemblyAnnotationProductSetInventoryV1,
  mockReadAssemblyAnnotationRasterV2,
  mockOpen,
  mockCloseSession,
  mockUpgradeSessionCapabilities,
  mockDialogOpen,
  mockOn,
  mockExists,
  mockStat,
  mockWatchFile,
  mockUnwatchFile,
  emitPlatformEvent,
  mockPrepackedSceneCache,
  mockAssemblyAnnotationFeatures,
  viewerProps,
  workspaceState,
  darkModeState,
  referenceAssetsState,
  mockReadAlignmentHeader,
  mockPrepareAlignmentCoverage,
  mockStartVariantSourceOperation,
  mockWaitForVariantSourceResult,
  mockReadVariantPage,
  mockRemoteConnect,
  mockRemoteDisconnect,
  mockBbiOpen,
  mockBbiClose,
  mockBbiQuery,
} = vi.hoisted(() => ({
  mockInit: vi.fn(),
  mockGetSequence: vi.fn(),
  mockGetSequenceWindow: vi.fn(),
  mockGetFeatures: vi.fn(),
  mockSearchSequence: vi.fn(),
  mockQueryAssemblyAnnotationSearch: vi.fn(),
  mockReadAssemblyAnnotationProductSetInventoryV1: vi.fn(),
  mockReadAssemblyAnnotationRasterV2: vi.fn(),
  mockOpen: vi.fn(),
  mockCloseSession: vi.fn(),
  mockUpgradeSessionCapabilities: vi.fn(),
  mockDialogOpen: vi.fn(),
  mockOn: vi.fn(),
  mockExists: vi.fn(),
  mockStat: vi.fn(),
  mockWatchFile: vi.fn(),
  mockUnwatchFile: vi.fn(),
  emitPlatformEvent: vi.fn(),
  mockPrepackedSceneCache: vi.fn(() => ({
    status: 'not-applicable',
    descriptor: null,
    result: null,
    error: null,
  })),
  mockAssemblyAnnotationFeatures: vi.fn(() => null),
  viewerProps: { current: null as Record<string, unknown> | null },
  workspaceState: {
    path: '/workspace',
    loading: true,
  },
  darkModeState: {
    current: false,
  },
  referenceAssetsState: {
    current: {} as Record<string, unknown>,
  },
  mockReadAlignmentHeader: vi.fn(),
  mockPrepareAlignmentCoverage: vi.fn(),
  mockStartVariantSourceOperation: vi.fn(),
  mockWaitForVariantSourceResult: vi.fn(),
  mockReadVariantPage: vi.fn(),
  mockRemoteConnect: vi.fn(),
  mockRemoteDisconnect: vi.fn().mockResolvedValue(undefined),
  mockBbiOpen: vi.fn(),
  mockBbiClose: vi.fn().mockResolvedValue(undefined),
  mockBbiQuery: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../shared/context/DarkModeContext', () => ({
  useDarkMode: () => ({
    darkMode: darkModeState.current,
    themeMode: darkModeState.current ? 'dark' : 'light',
    setThemeMode: vi.fn(),
    toggleDarkMode: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useWorkspace', () => ({
  useWorkspace: () => ({
    path: workspaceState.path,
    loading: workspaceState.loading,
    error: null,
    selectWorkspace: vi.fn(),
    setWorkspacePath: vi.fn(),
    clearWorkspace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    dialog: {
      open: mockDialogOpen,
    },
    fs: {
      exists: mockExists,
      stat: mockStat,
      watchFile: mockWatchFile,
      unwatchFile: mockUnwatchFile,
    },
    genome: {
      open: mockOpen,
      closeSession: mockCloseSession,
      upgradeSessionCapabilities: mockUpgradeSessionCapabilities,
      init: mockInit,
      getSequenceWindow: mockGetSequenceWindow,
      getSequence: mockGetSequence,
      getFeatures: mockGetFeatures,
      searchSequence: mockSearchSequence,
      queryAssemblyAnnotationSearch: mockQueryAssemblyAnnotationSearch,
      readAssemblyAnnotationProductSetInventoryV1: mockReadAssemblyAnnotationProductSetInventoryV1,
      readAssemblyAnnotationRasterV2: mockReadAssemblyAnnotationRasterV2,
    },
    referenceAssets: referenceAssetsState.current,
    remoteGenomics: {
      connectAlignment: mockRemoteConnect,
      disconnectSession: mockRemoteDisconnect,
      subscribeStatus: () => () => undefined,
    },
    on: mockOn,
  }),
}));

vi.mock('../variant-client', () => ({
  readVariantPage: mockReadVariantPage,
}));

vi.mock('../variant-source-operation-client', () => ({
  startVariantSourceOperation: mockStartVariantSourceOperation,
  waitForVariantSourceResult: mockWaitForVariantSourceResult,
}));

vi.mock('../alignment-header-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../alignment-header-client')>();
  return {
    ...actual,
    readAlignmentHeader: mockReadAlignmentHeader,
  };
});

vi.mock('../alignment-coverage-operation-client', () => ({
  startAlignmentCoverageOperation: mockPrepareAlignmentCoverage,
}));

vi.mock('../bbi-reader-runtime', () => ({
  getBbiReaderWorkerClient: () => ({
    open: mockBbiOpen,
    closeSource: mockBbiClose,
    queryQuantitative: mockBbiQuery,
  }),
}));

vi.mock('./IndexedGenomeViewer', () => ({
  IndexedGenomeViewer: (props: Record<string, unknown>) => {
    viewerProps.current = props;
    return (
      <>
        <button
          type="button"
          data-testid="mock-annotation-mode-change"
          onClick={() =>
            (
              props.onAnnotationMapperPolicyChange as
                | ((policy: { isoformMode: 'expanded'; laneLimit: number }) => void)
                | undefined
            )?.({
              isoformMode: 'expanded',
              laneLimit: (props.annotationMapperPolicy as { laneLimit: number }).laneLimit,
            })
          }
        >
          Change annotation mode
        </button>
        <button
          type="button"
          data-testid="mock-annotation-lane-change"
          onClick={() =>
            (
              props.onAnnotationMapperPolicyChange as
                | ((policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: 8 }) => void)
                | undefined
            )?.({
              isoformMode: (
                props.annotationMapperPolicy as {
                  isoformMode: 'canonical' | 'expanded';
                }
              ).isoformMode,
              laneLimit: 8,
            })
          }
        >
          Change annotation lanes
        </button>
      </>
    );
  },
}));

vi.mock('./useAssemblyPrepackedAnnotationSceneCache', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./useAssemblyPrepackedAnnotationSceneCache')>();
  return {
    ...actual,
    useAssemblyPrepackedAnnotationSceneCache: mockPrepackedSceneCache,
  };
});

vi.mock('./useAssemblyAnnotationFeatures', () => ({
  useAssemblyAnnotationFeatures: mockAssemblyAnnotationFeatures,
}));

function resetCanvasStore(tab: Tab): void {
  useCanvasStore.setState({
    panels: {
      main: {
        id: 'main',
        tabs: [tab],
        activeTabId: tab.id,
      },
    },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    oversizeScanComplete: true,
  });
}

function readySessionUpdate(tabState = indexedTab().indexedGenome!) {
  const sessionId = `session-${tabState.chrom}`;
  return {
    sessionId,
    prepareStatus: 'ready',
    prepareLoadPhase: 'opening',
    reusedExistingIndex: true,
    shell: {
      sessionId,
      sourcePath: tabState.sourcePath,
      sourceFingerprint: `fingerprint-${tabState.chrom}`,
      chrom: tabState.chrom,
      sourceSizeBytes: tabState.sourceSizeBytes,
      openReady: true,
      coordinateReady: true,
      length: tabState.manifest?.length ?? tabState.metadata.length,
      manifest: tabState.manifest,
      validationState: 'metadata_match',
      openedAt: 1,
      ...(tabState.assembly
        ? {
            assemblySearchReadiness: 'ready' as const,
            assemblySearchSource: assemblySearchSceneCacheDescriptor().descriptor.request,
          }
        : {}),
      tracks: [
        {
          id: `${tabState.chrom}:sequence`,
          kind: 'sequence',
          label: 'Sequence',
          state: 'coordinate_ready',
          userState: 'Showing overview',
        },
      ],
    },
    tabState,
  };
}

function indexedTab(): Tab {
  const manifest = {
    chrom: 'chr11',
    fastaPath: '/workspace/.waypoint/genome-index/chr11/chr11.fa',
    faiPath: '/workspace/.waypoint/genome-index/chr11/chr11.fa.fai',
    gffPath: null,
    tbiPath: null,
    length: 135_086_622,
    circular: false,
  };

  return {
    id: 'tab-chr11',
    type: 'sequence',
    label: 'chr11.fa',
    entityId: 'indexed-sequence:chr11-test',
    sequenceDocument: {
      kind: 'indexed-sequence',
      documentId: 'indexed-sequence:chr11-test',
    },
    loadStatus: 'indexed',
    fileSizeBytes: 137_016_451,
    indexedGenome: {
      sourcePath: '/workspace/chr11.fa',
      sourceSizeBytes: 137_016_451,
      sourceExt: 'fa',
      chrom: 'chr11',
      outputDir: '/workspace/.waypoint/genome-index/chr11',
      manifest,
      metadata: {
        length: 135_086_622,
        circular: false,
        featureCount: 0,
      },
      indexedAt: 1,
    },
  };
}

function assemblyIndexedTab(): Tab {
  const tab = indexedTab();
  return {
    ...tab,
    id: 'assembly-tab',
    entityId: 'assembly:grch38-test',
    sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:grch38-test' },
    label: 'GRCh38 Test',
    indexedGenome: {
      ...tab.indexedGenome!,
      assembly: {
        assemblyId: 'grch38-test',
        displayName: 'GRCh38 Test',
        chromosomes: [
          {
            chrom: 'chr11',
            displayName: 'chr11',
            length: 135_086_622,
            manifest: tab.indexedGenome!.manifest!,
          },
          {
            chrom: 'chr12',
            displayName: 'chr12',
            length: 133_275_309,
            manifest: {
              chrom: 'chr12',
              fastaPath: '/workspace/.waypoint/genome-index/chr12/chr12.fa',
              faiPath: '/workspace/.waypoint/genome-index/chr12/chr12.fa.fai',
              gffPath: '/workspace/.waypoint/genome-index/chr12/chr12.gff3.gz',
              tbiPath: '/workspace/.waypoint/genome-index/chr12/chr12.gff3.gz.tbi',
              length: 133_275_309,
            },
          },
        ],
      },
      assemblySourceReadiness: 'ready',
      assemblyAnnotationProductsReadiness: 'ready',
      assemblyAnnotationTrackTypes: ['enhancer', 'mRNA'],
      assemblySearchReadiness: 'ready',
      scope: { kind: 'all' },
    },
  } as Tab;
}

function persistedUcscTrack(
  overrides: Partial<IndexedGenomeUcscTrackState> = {}
): IndexedGenomeUcscTrackState {
  return {
    trackId: 'ucsc:hg38-gc5BaseBw',
    trackType: 'quantitative',
    label: 'GC Percent',
    color: 0x3b82f6,
    trackPx: 160,
    laneHeightPx: 8,
    maxLanes: 32,
    visible: true,
    source: {
      admissionVersion: 1,
      uri: 'https://example.org/gc5Base.bw',
      formatId: 'bigwig',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      quantitativeColumnSemantics: 'continuous-signal',
      assemblyId: 'grch38-test',
      referenceReceipt: {
        assemblyId: 'grch38-test',
        referenceSignature: 'grch38-test',
        sourceSignature: 'gc5BaseBw',
        contigMap: { chr11: 'chr11' },
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
    ...overrides,
  };
}

function fullGenomeIndexedTab(): Tab {
  const catalogEntry = referenceAssemblyById('grch38');
  if (!catalogEntry) throw new Error('GRCh38 catalog entry is required by this test');
  const assembly = buildGenomeAssembly(
    catalogEntry,
    (relativePath) => `/workspace/${relativePath}`
  );
  const anchor = assembly.chromosomes[0];
  if (!anchor) throw new Error('GRCh38 must have an anchor chromosome');

  return {
    id: 'grch38-full-assembly',
    type: 'sequence',
    label: 'GRCh38 (human)',
    entityId: 'assembly:grch38',
    sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:grch38' },
    loadStatus: 'indexed',
    fileSizeBytes: 248_956_422,
    indexedGenome: {
      sourcePath: anchor.manifest.fastaPath,
      sourceSizeBytes: 248_956_422,
      sourceExt: 'fa',
      chrom: anchor.chrom,
      outputDir: '/workspace/.waypoint/genome-index/grch38',
      manifest: anchor.manifest,
      metadata: {
        length: anchor.length,
        circular: false,
        featureCount: 0,
      },
      indexedAt: 1,
      assembly,
      assemblySourceReadiness: 'ready',
      assemblyAnnotationProductsReadiness: 'ready',
      assemblySearchReadiness: 'ready',
      scope: { kind: 'all' },
    },
  };
}

function assemblySearchSceneCacheDescriptor(sourceSha256 = 'a'.repeat(64)) {
  return {
    status: 'loading',
    descriptor: {
      request: {
        ipcContractVersion: 'assembly-annotation-scene-ipc.v4',
        assemblyId: 'GRCh38',
        workspaceRoot: '/workspace',
        scope: {
          kind: 'complete-assembly',
          placements: [
            { chrom: 'chr11', length: 135_086_622, annotationCoverage: 'sourced' },
            { chrom: 'chr12', length: 133_275_309, annotationCoverage: 'sourced' },
          ],
        },
        chromosomes: [
          {
            chrom: 'chr11',
            length: 135_086_622,
            sourcePath: '/workspace/.waypoint/genome-index/chr11/chr11.gff3.gz',
          },
          {
            chrom: 'chr12',
            length: 133_275_309,
            sourcePath: '/workspace/.waypoint/genome-index/chr12/chr12.gff3.gz',
          },
        ],
        datasetContract: {
          datasetId: 'GRCh38-annotations',
          datasetVersion: '1',
          sourceSha256,
        },
        artifact: { artifactKey: 'mRNA-light', trackType: 'mRNA' },
        requestedPolicy: { isoformMode: 'canonical', laneLimit: 2 },
      },
    },
    result: null,
    error: null,
  } as never;
}

describe('genome session capability upgrade authority', () => {
  it('keeps a newly admitted publication when an older terminal session snapshot arrives', () => {
    const state = assemblyIndexedTab().indexedGenome!;
    const generation = {
      contract: 'assembly-reference-asset-generation.v1' as const,
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'b'.repeat(64),
      themeMode: 'light' as const,
    };
    const searchSource = assemblySearchSceneCacheDescriptor().descriptor.request;

    const merged = tabStateWithPreparedAssemblyProduct(
      {
        ...state,
        assemblyAnnotationProductsReadiness: 'pending',
        assemblySearchReadiness: 'pending',
        assemblyAssetGeneration: undefined,
        assemblySearchSource: undefined,
      },
      {
        assembly: state.assembly!,
        annotationProductsReadiness: 'ready',
        searchReadiness: 'ready',
        generation,
        searchSource,
        trackTypes: ['CDS'],
      }
    );

    expect(merged).toMatchObject({
      assemblyAnnotationProductsReadiness: 'ready',
      assemblySearchReadiness: 'ready',
      assemblyAssetGeneration: generation,
      assemblySearchSource: searchSource,
      assemblyAnnotationTrackTypes: ['CDS'],
    });
  });

  it('projects a detail-ready publication onto the existing session identity', () => {
    const tab = assemblyIndexedTab();
    const indexedState = tab.indexedGenome!;
    indexedState.assemblyAssetGeneration = {
      contract: 'assembly-reference-asset-generation.v1',
      sourceFingerprint: 'a'.repeat(64),
      inventoryFingerprint: 'b'.repeat(64),
      themeMode: 'light',
    };
    indexedState.assemblySearchSource = assemblySearchSceneCacheDescriptor().descriptor.request;
    indexedState.assemblySearchReadiness = 'pending';

    expect(
      genomeSessionCapabilityUpgradeSource({ indexedState, workspaceRoot: '/workspace' })
    ).toMatchObject({
      sourcePath: indexedState.sourcePath,
      manifest: indexedState.manifest,
      intent: {
        kind: 'reference-assembly',
        annotationProductsReadiness: 'ready',
        searchReadiness: 'pending',
        assetGeneration: indexedState.assemblyAssetGeneration,
        searchSource: indexedState.assemblySearchSource,
      },
    });
  });

  it('cannot invent an upgrade before generation and source authority exist', () => {
    const indexedState = assemblyIndexedTab().indexedGenome!;
    delete indexedState.assemblyAssetGeneration;
    delete indexedState.assemblySearchSource;
    expect(
      genomeSessionCapabilityUpgradeSource({ indexedState, workspaceRoot: '/workspace' })
    ).toBeNull();
  });
});

describe('IndexedGenomeTab', () => {
  it('colors a subclassed result from the same raw type that labels and colors its glyph', () => {
    expect(
      indexedAnnotationBadgeType({
        start: 100,
        end: 200,
        strand: 'forward',
        type: 'annotation',
        label: 'Subclassed regulatory hit',
        featureType: 'regulatory',
        annotationTrackId: 'enhancer',
      })
    ).toBe('regulatory');
  });

  beforeEach(() => {
    darkModeState.current = false;
    referenceAssetsState.current = {};
    workspaceState.path = '/workspace';
    workspaceState.loading = true;
    useWorkspaceStore.getState().clearWorkspace();
    mockInit.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetFeatures.mockReset();
    mockSearchSequence.mockReset();
    mockQueryAssemblyAnnotationSearch.mockReset().mockResolvedValue(null);
    mockReadAssemblyAnnotationProductSetInventoryV1.mockReset().mockResolvedValue({
      status: 'ready',
      sourceFingerprint: 'b'.repeat(24),
      inventoryFingerprint: 'c'.repeat(64),
      trackTypes: ['mRNA'],
    });
    mockReadAssemblyAnnotationRasterV2.mockReset();
    mockOpen.mockReset();
    mockCloseSession.mockReset().mockResolvedValue(true);
    mockUpgradeSessionCapabilities
      .mockReset()
      .mockImplementation(async (sessionId: string, source: GenomeOpenSource) => ({
        ...readySessionUpdate(indexedTab().indexedGenome!).shell,
        sessionId,
        sourcePath: source.sourcePath,
        chrom: source.chrom ?? source.manifest?.chrom ?? 'chr11',
        manifest: source.manifest,
        assemblyAnnotationProductsReadiness:
          source.intent.kind === 'reference-assembly'
            ? source.intent.annotationProductsReadiness
            : undefined,
        assemblySearchReadiness:
          source.intent.kind === 'reference-assembly' ? source.intent.searchReadiness : undefined,
        ...(source.intent.kind === 'reference-assembly' && source.intent.searchReadiness === 'ready'
          ? { assemblyAnnotationFeatureCount: 42_731 }
          : {}),
        ...(source.intent.kind === 'reference-assembly' && source.intent.assetGeneration
          ? { assemblyAssetGeneration: source.intent.assetGeneration }
          : {}),
        ...(source.intent.kind === 'reference-assembly' && source.intent.searchSource
          ? { assemblySearchSource: source.intent.searchSource }
          : {}),
      }));
    mockDialogOpen.mockReset();
    mockOn.mockReset();
    mockExists.mockReset();
    mockStat.mockReset().mockResolvedValue({
      canonicalPath: '/canonical/file',
      size: 1,
      isFile: true,
      isDirectory: false,
      mtime: 1,
      ctime: 1,
      mtimeNs: '1000000',
      ctimeNs: '1000000',
      device: '42',
      inode: '1001',
    });
    mockWatchFile.mockReset().mockResolvedValue(undefined);
    mockUnwatchFile.mockReset().mockResolvedValue(undefined);
    useLaneContractStore.getState().clear();
    emitPlatformEvent.mockReset();
    mockPrepackedSceneCache.mockReset();
    mockPrepackedSceneCache.mockReturnValue({
      status: 'not-applicable',
      descriptor: null,
      result: null,
      error: null,
    });
    mockAssemblyAnnotationFeatures.mockClear();
    mockReadAlignmentHeader.mockReset().mockResolvedValue({
      format: 'bam',
      isCram: false,
      referenceRequired: false,
      references: [
        { name: 'chr11', length: 135_086_622, md5: null },
        { name: 'chr12', length: 133_275_309, md5: null },
      ],
      index: { state: 'present' },
    });
    mockPrepareAlignmentCoverage.mockReset().mockResolvedValue(undefined);
    mockStartVariantSourceOperation.mockReset().mockResolvedValue({ id: 'variant-operation-1' });
    mockWaitForVariantSourceResult.mockReset();
    mockReadVariantPage.mockReset();
    mockRemoteConnect.mockReset();
    mockRemoteDisconnect.mockReset().mockResolvedValue(undefined);
    mockBbiOpen.mockReset();
    mockBbiClose.mockReset().mockResolvedValue(undefined);
    mockBbiQuery.mockReset().mockResolvedValue([]);
    viewerProps.current = null;
    (window as unknown as { __test?: Record<string, unknown> }).__test = {};
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    mockOn.mockImplementation((channel: string, callback: (payload: unknown) => void) => {
      const callbacks = listeners.get(channel) ?? new Set<(payload: unknown) => void>();
      callbacks.add(callback);
      listeners.set(channel, callbacks);
      return () => {
        callbacks.delete(callback);
      };
    });
    emitPlatformEvent.mockImplementation((channel: string, payload: unknown) => {
      for (const callback of listeners.get(channel) ?? []) callback(payload);
    });
    mockGetSequence.mockResolvedValue('A'.repeat(20));
    mockGetSequenceWindow.mockResolvedValue({
      sessionId: 'session-chr11',
      requestId: 'sequence-window-test',
      chrom: 'chr11',
      start: 0,
      end: 20,
      generation: 0,
      validationState: 'metadata_match',
      byteCount: 20,
      bases: 'A'.repeat(20),
    });
    mockGetFeatures.mockResolvedValue([]);
    mockSearchSequence.mockResolvedValue([]);
    mockOpen.mockResolvedValue({
      sessionId: 'session-chr11',
      sourcePath: '/workspace/chr11.fa',
      sourceFingerprint: 'fingerprint-chr11',
      chrom: 'chr11',
      sourceSizeBytes: 137_016_451,
      coordinateReady: false,
      validationState: 'metadata_match',
      openedAt: 1,
      tracks: [],
    });
    mockExists.mockResolvedValue(true);
  });

  it('keeps one canonical product generation across runtime theme toggles', () => {
    const tab = fullGenomeIndexedTab();
    tab.indexedGenome!.assemblyAssetGenerationsByTheme = {
      light: {
        contract: 'assembly-reference-asset-generation.v1',
        sourceFingerprint: 'b'.repeat(24),
        inventoryFingerprint: 'c'.repeat(64),
        themeMode: 'light',
      },
      dark: {
        contract: 'assembly-reference-asset-generation.v1',
        sourceFingerprint: 'b'.repeat(24),
        inventoryFingerprint: 'd'.repeat(64),
        themeMode: 'dark',
      },
    };
    resetCanvasStore(tab);

    const { rerender } = render(<IndexedGenomeTab tab={tab} />);
    expect(mockPrepackedSceneCache).toHaveBeenLastCalledWith(
      expect.objectContaining({
        themeMode: 'light',
        request: expect.objectContaining({
          expectedAssetGeneration: tab.indexedGenome!.assemblyAssetGenerationsByTheme.light,
        }),
      })
    );
    darkModeState.current = true;
    rerender(<IndexedGenomeTab tab={tab} />);
    expect(mockPrepackedSceneCache).toHaveBeenLastCalledWith(
      expect.objectContaining({
        themeMode: 'light',
        request: expect.objectContaining({
          expectedAssetGeneration: tab.indexedGenome!.assemblyAssetGenerationsByTheme.light,
        }),
      })
    );
  });

  it('does not strand the tab on Opening indexed genome when a prepare effect reruns', async () => {
    const tab = indexedTab();

    resetCanvasStore(tab);
    const { rerender } = render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() => {
      const el = screen.getByTestId('indexed-genome-loading');
      expect(el.dataset.loadPhase).toBe('opening');
    });
    workspaceState.loading = false;
    rerender(<IndexedGenomeTab tab={tab} />);

    await waitFor(() => {
      expect(mockOpen).toHaveBeenCalledTimes(1);
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });

    await waitFor(() => {
      expect(screen.getByTestId('indexed-genome-loading').dataset.loadPhase).toBe('loading-data');
    });
    expect(screen.queryByText('Indexed')).toBeNull();
    expect(screen.queryByText('135,086,622 bp')).toBeNull();
    expect(screen.queryByText('1-2,000 of 135,086,622')).not.toBeInTheDocument();
    expect(screen.queryByTestId('genome-session-shell')).not.toBeInTheDocument();
  });

  it('reports a missing native admission source as one correlated open refusal', async () => {
    workspaceState.loading = false;
    const tab = indexedTab();
    resetCanvasStore(tab);
    mockOpen.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'genome:open': Error: ENOENT: no such file or directory"
      )
    );
    const ready = vi.spyOn(analytics, 'isAnalyticsCaptureReady').mockReturnValue(true);
    const track = vi.spyOn(analytics, 'trackRendererEvent').mockReturnValue(true);
    try {
      const view = render(<IndexedGenomeTab tab={tab} />);
      await waitFor(() =>
        expect(screen.getByTestId('indexed-genome-loading').dataset.loadPhase).toBe('error')
      );
      view.unmount();
      const rows = track.mock.calls
        .filter(([event]) => event === 'indexed_genome_stage')
        .map(([, properties]) => properties);
      expect(rows.map((row) => row?.genome_stage)).toEqual(['open_accepted', 'open_refused']);
      expect(rows[1]).toMatchObject({
        operation_id: rows[0]?.operation_id,
        genome_generation_id: rows[0]?.genome_generation_id,
        genome_started_at_ms: rows[0]?.genome_started_at_ms,
        genome_reason: 'source_unavailable',
      });
      expect(mockOpen).toHaveBeenCalledTimes(1);
      expect(mockCloseSession).not.toHaveBeenCalled();
    } finally {
      track.mockRestore();
      ready.mockRestore();
    }
  });

  it('opens a source-ready coordinate shell while mounted hosted view re-admission is pending', async () => {
    workspaceState.loading = false;
    const tab = fullGenomeIndexedTab();
    const neverAdmitted = new Promise<never>(() => undefined);
    let publishHostedProgress:
      | ((progress: { catalogId: string; phase: string; label: string }) => void)
      | null = null;
    referenceAssetsState.current = {
      listHosted: vi.fn().mockResolvedValue([{ id: 'grch38' }]),
      installHosted: vi.fn().mockReturnValue(neverAdmitted),
      onHostedInstallProgress: vi.fn(
        (callback: (progress: { catalogId: string; phase: string; label: string }) => void) => {
          publishHostedProgress = callback;
          return () => undefined;
        }
      ),
    };
    resetCanvasStore(tab);

    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() => {
      expect(mockOpen).toHaveBeenCalledTimes(1);
    });
    expect(mockOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: tab.indexedGenome!.sourcePath,
        intent: expect.objectContaining({ kind: 'reference-assembly' }),
      })
    );
    expect(referenceAssetsState.current.installHosted).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId: 'grch38', intent: 'open-view' })
    );

    act(() => {
      publishHostedProgress?.({
        catalogId: 'grch38',
        phase: 'ready',
        label: 'GRCh38 is ready',
      });
    });
    expect(mockPrepackedSceneCache).toHaveBeenLastCalledWith(
      expect.objectContaining({ preparationGeneration: 0 })
    );
    expect(referenceAssetsState.current.installHosted).toHaveBeenCalledTimes(1);
  });

  it('refreshes the mounted hosted publication when background product admission becomes ready', async () => {
    workspaceState.loading = false;
    const tab = fullGenomeIndexedTab();
    const prepared = referenceAssemblyById('grch38');
    if (!prepared) throw new Error('GRCh38 catalog entry is required by this test');
    let publishHostedProgress:
      | ((progress: { catalogId: string; phase: string; label: string }) => void)
      | null = null;
    const installHosted = vi.fn().mockResolvedValue({ status: 'ready', entry: prepared });
    referenceAssetsState.current = {
      listHosted: vi.fn().mockResolvedValue([{ id: 'grch38' }]),
      installHosted,
      onHostedInstallProgress: vi.fn(
        (callback: (progress: { catalogId: string; phase: string; label: string }) => void) => {
          publishHostedProgress = callback;
          return () => undefined;
        }
      ),
    };
    resetCanvasStore(tab);

    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() => expect(installHosted).toHaveBeenCalledTimes(1));
    act(() => {
      publishHostedProgress?.({
        catalogId: 'grch38',
        phase: 'ready',
        label: 'GRCh38 is ready',
      });
    });

    await waitFor(() => expect(installHosted).toHaveBeenCalledTimes(2));
    expect(installHosted.mock.calls.map(([request]) => request.intent)).toEqual([
      'open-view',
      'require-ready',
    ]);
  });

  it('upgrades later capabilities on the session that already owns presentation', async () => {
    workspaceState.loading = false;
    const tab = assemblyIndexedTab();
    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    const staleSessionUpdate = readySessionUpdate({
      ...tab.indexedGenome!,
      assemblySearchReadiness: 'pending',
    });
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', {
        ...staleSessionUpdate,
        shell: {
          ...staleSessionUpdate.shell,
          assemblyAnnotationProductsReadiness: 'ready',
          assemblySearchReadiness: 'pending',
        },
      });
    });

    await waitFor(() => expect(mockUpgradeSessionCapabilities).toHaveBeenCalledTimes(1));
    expect(mockUpgradeSessionCapabilities).toHaveBeenCalledWith(
      'session-chr11',
      expect.objectContaining({
        sourcePath: tab.indexedGenome!.sourcePath,
        intent: expect.objectContaining({
          kind: 'reference-assembly',
          annotationProductsReadiness: 'ready',
          searchReadiness: 'ready',
        }),
      })
    );
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });

  it('publishes a completed capability upgrade after the tab state changes in flight', async () => {
    workspaceState.loading = false;
    const tab = assemblyIndexedTab();
    resetCanvasStore(tab);
    const staleSessionUpdate = readySessionUpdate({
      ...tab.indexedGenome!,
      assemblySearchReadiness: 'pending',
    });
    const upgradedShell = {
      ...staleSessionUpdate.shell,
      assemblyAnnotationProductsReadiness: 'ready' as const,
      assemblySearchReadiness: 'ready' as const,
      assemblyAnnotationFeatureCount: 42_731,
    };
    let resolveUpgrade!: (shell: typeof upgradedShell) => void;
    mockUpgradeSessionCapabilities.mockImplementation(
      () =>
        new Promise<typeof upgradedShell>((resolve) => {
          resolveUpgrade = resolve;
        })
    );

    const { rerender } = render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', {
        ...staleSessionUpdate,
        shell: {
          ...staleSessionUpdate.shell,
          assemblyAnnotationProductsReadiness: 'ready',
          assemblySearchReadiness: 'pending',
        },
      });
    });
    await waitFor(() => expect(mockUpgradeSessionCapabilities).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-session-assembly-search-readiness',
      'pending'
    );

    act(() => {
      rerender(<IndexedGenomeTab tab={{ ...tab, indexedGenome: { ...tab.indexedGenome! } }} />);
    });
    await act(async () => {
      resolveUpgrade(upgradedShell);
    });

    await waitFor(() =>
      expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
        'data-session-assembly-search-readiness',
        'ready'
      )
    );
    expect(screen.getByTestId('indexed-genome-annotation-count')).toHaveAttribute(
      'data-count-state',
      'ready'
    );
  });

  it('restores persisted BAM identity and presentation state into the lane store', async () => {
    const tab = assemblyIndexedTab();
    tab.indexedGenome!.bamTracks = [
      {
        trackId: 'persisted-tumor',
        label: 'Tumor reads',
        source: {
          bamPath: '/data/tumor.bam',
          indexPath: '/managed/tumor.bam.bai',
        },
        visible: false,
        coverageCutoffDepth: 125,
      },
    ];
    resetCanvasStore(tab);

    const { rerender } = render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() => {
      expect(useLaneContractStore.getState().lanesForOwner(tab.id)).toEqual([
        expect.objectContaining({
          visible: false,
          dataset: expect.objectContaining({
            trackId: 'persisted-tumor',
            label: 'Tumor reads',
            coverageCutoffDepth: 125,
            source: expect.objectContaining({
              bamPath: '/data/tumor.bam',
              indexPath: '/managed/tumor.bam.bai',
            }),
          }),
        }),
      ]);
    });
    expect(screen.queryByTestId('bam-track-restore-error')).not.toBeInTheDocument();

    act(() => {
      useLaneContractStore.getState().setLaneVisible(tab.id, 'persisted-tumor', true);
      useLaneContractStore.getState().setLaneCoverageCutoff(tab.id, 'persisted-tumor', 260);
    });
    await waitFor(() => {
      const storedTab = useCanvasStore
        .getState()
        .panels.main.tabs.find((candidate) => candidate.id === tab.id);
      expect(storedTab?.indexedGenome?.bamTracks).toEqual([
        expect.objectContaining({
          trackId: 'persisted-tumor',
          visible: true,
          coverageCutoffDepth: 260,
        }),
      ]);
    });

    const canvasPersistence = JSON.parse(
      localStorage.getItem('waypoint-desktop-canvas') ?? 'null'
    ) as {
      state?: { panels?: { main?: { tabs?: Tab[] } } };
    } | null;
    const persistedTab = canvasPersistence?.state?.panels?.main?.tabs?.find(
      (candidate) => candidate.id === tab.id
    );
    expect(persistedTab?.indexedGenome?.bamTracks).toEqual([
      expect.objectContaining({
        trackId: 'persisted-tumor',
        source: expect.objectContaining({
          bamPath: '/data/tumor.bam',
          indexPath: '/managed/tumor.bam.bai',
        }),
        visible: true,
        coverageCutoffDepth: 260,
      }),
    ]);
  });

  it('keeps a moved BAM failure on its Repair row instead of duplicating it in a banner', async () => {
    const tab = assemblyIndexedTab();
    tab.indexedGenome!.bamTracks = [
      {
        trackId: 'missing-tumor',
        label: 'Tumor reads',
        source: {
          bamPath: '/moved/tumor.bam',
          indexPath: '/managed/tumor.bam.bai',
        },
        visible: true,
        coverageCutoffDepth: 0,
      },
    ];
    mockStat.mockImplementation(async (path: string) => {
      if (path === '/moved/tumor.bam') throw new Error('ENOENT');
      return {
        canonicalPath: `/canonical${path}`,
        size: 1,
        isFile: true,
        isDirectory: false,
        mtime: 1,
        ctime: 1,
        mtimeNs: '1000000',
        ctimeNs: '1000000',
      };
    });
    resetCanvasStore(tab);

    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() =>
      expect(useLaneContractStore.getState().lanesForOwner(tab.id)).toMatchObject([
        {
          dataset: {
            trackId: 'missing-tumor',
            source: {
              bamPath: '/moved/tumor.bam',
              indexPath: '/managed/tumor.bam.bai',
              admissionError: expect.stringContaining('/moved/tumor.bam'),
            },
          },
        },
      ])
    );
    expect(screen.queryByTestId('bam-track-restore-error')).not.toBeInTheDocument();
  });

  it('shows recovery for a rejected SSH histogram while keeping its admitted reads', async () => {
    const tab = assemblyIndexedTab();
    const locator = {
      contract: 'remote-alignment-locator.v1' as const,
      endpointId: 'endpoint-1',
      target: 'lab-hpc',
      alignmentPath: '/project/tumor.bam',
      indexPath: '/project/tumor.bam.bai',
      signalPath: '/project/coverage.bigWig',
    };
    tab.indexedGenome!.bamTracks = [
      {
        trackId: 'ssh-tumor',
        label: 'Tumor reads',
        source: {
          bamPath: locator.alignmentPath,
          indexPath: locator.indexPath,
          remote: locator,
        },
        visible: true,
        coverageCutoffDepth: 0,
      },
    ];
    const generation = (canonicalPath: string, size: number) => ({
      canonicalPath,
      size,
      mtimeNs: '1',
      ctimeNs: '1',
      device: '1',
      inode: '2',
    });
    mockRemoteConnect.mockResolvedValue({
      protocol: 'dnaforge-remote-range.v1',
      sessionId: 'visible-admission-view-lease',
      endpoint: {
        endpointId: locator.endpointId,
        displayName: 'Lab HPC',
        target: locator.target,
        lastConnectedAt: 1,
        observedPlatform: 'linux',
        lastFailure: null,
      },
      locator,
      bamUrl: 'http://127.0.0.1:43119/v1/visible-admission-source/alignment.bam',
      bigWigUrl: 'http://127.0.0.1:43119/v1/visible-admission-source/signal.bigWig',
      indexPath: '/tmp/visible-admission-source/tumor.bam.bai',
      generation: {
        alignment: generation(locator.alignmentPath, 100),
        index: generation(locator.indexPath, 10),
        signal: generation(locator.signalPath, 1_000),
      },
    });
    mockBbiOpen.mockResolvedValue({
      fileType: 'bigwig',
      references: [
        { name: 'chr11', length: 135_086_621 },
        { name: 'chr12', length: 133_275_309 },
      ],
      zoomReductionLevels: [10],
      totalSummary: { basesCovered: 100, scoreMin: 0, scoreMax: 12 },
    });
    resetCanvasStore(tab);

    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() => expect(mockBbiClose).toHaveBeenCalledOnce());
    const readLane = useLaneContractStore
      .getState()
      .lanesForOwner(tab.id)
      .find((lane) => lane.dataset.trackId === 'ssh-tumor');
    expect(readLane?.dataset.source?.remote?.sessionId).toBe('visible-admission-view-lease');
    expect(readLane?.dataset.source?.admissionError).toBeUndefined();
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(tab.id)
        .some((lane) => lane.source?.scientificKind === 'quantitative')
    ).toBe(false);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'BigWig reference mismatch for chr11: expected 135086622, received 135086621.'
    );
    expect(alert).toHaveTextContent('Connection details');
    expect(mockRemoteDisconnect).not.toHaveBeenCalled();
  });

  it('surfaces and removes a persisted UCSC track from an unmapped assembly', async () => {
    const tab = assemblyIndexedTab();
    tab.indexedGenome!.ucscTracks = [
      persistedUcscTrack({
        trackId: 'ucsc:hg38-broken',
        label: 'Broken signal',
        trackPx: 0,
      }),
    ];
    resetCanvasStore(tab);

    render(<IndexedGenomeTab tab={tab} />);

    const alert = await screen.findByTestId('ucsc-track-restore-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Couldn’t restore 1 data track.');
    expect(alert).toHaveTextContent(
      'Broken signal: UCSC loading is not mapped for assembly grch38-test.'
    );
    expect(useLaneContractStore.getState().lanesForOwner(tab.id)).toEqual([]);
    await waitFor(() => {
      const storedTab = useCanvasStore
        .getState()
        .panels.main.tabs.find((candidate) => candidate.id === tab.id);
      expect(storedTab?.indexedGenome?.dataTracks).toEqual([]);
      expect(storedTab?.indexedGenome?.ucscTracks).toBeUndefined();
    });
  });

  it('preserves BAM descriptors when the main-process genome session republishes tab state', async () => {
    workspaceState.loading = false;
    const tab = assemblyIndexedTab();
    tab.indexedGenome!.bamTracks = [
      {
        trackId: 'durable-normal',
        label: 'Normal reads',
        source: {
          bamPath: '/data/normal.bam',
          indexPath: '/managed/normal.bam.bai',
        },
        visible: true,
        coverageCutoffDepth: 90,
      },
    ];
    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });

    const { bamTracks: _rendererOnlyBamTracks, ...mainTabState } = tab.indexedGenome!;
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(mainTabState));
    });

    await waitFor(() => {
      expect(useCanvasStore.getState().panels.main.tabs[0]?.indexedGenome?.bamTracks).toMatchObject(
        tab.indexedGenome!.bamTracks
      );
    });
  });

  it('keeps the indexed genome viewer host from becoming a scroll container', async () => {
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 135_086_622 });
    resetCanvasStore(indexedTab());

    render(<IndexedGenomeTab tab={indexedTab()} />);

    await waitFor(() => {
      expect(screen.getByTestId('indexed-genome-tab')).toBeInTheDocument();
    });

    const host = screen.getByTestId('indexed-genome-viewer-scroll-host');
    expect(host).toHaveClass('overflow-hidden');
    expect(host).not.toHaveClass('overflow-auto');
  });

  it('keeps the indexed viewer flush with the panel top and left edges', async () => {
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 135_086_622 });
    resetCanvasStore(indexedTab());

    render(<IndexedGenomeTab tab={indexedTab()} />);
    await waitFor(() => {
      expect(screen.getByTestId('indexed-genome-tab')).toBeInTheDocument();
    });

    const host = screen.getByTestId('indexed-genome-viewer-scroll-host');
    expect(host).not.toHaveClass('px-4');
    expect(host).not.toHaveClass('py-3');
  });

  it('labels an assembly without exposing redundant session metadata', async () => {
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 268_361_931 });
    mockPrepackedSceneCache.mockReturnValue({
      status: 'loading',
      descriptor: {},
      result: null,
      error: null,
    } as never);
    const tab = assemblyIndexedTab();
    resetCanvasStore(tab);

    render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    const readyUpdate = readySessionUpdate(tab.indexedGenome!);
    act(() =>
      emitPlatformEvent('genome:sessionUpdated', {
        ...readyUpdate,
        shell: {
          ...readyUpdate.shell,
          assemblyAnnotationFeatureCount: 42_731,
          validationState: 'strong_match',
        },
      })
    );

    const title = await screen.findByRole('heading', { name: 'GRCh38 Test' });
    expect(title).not.toHaveTextContent('268,361,931 bp');
    expect(title).not.toHaveTextContent('42,731 annotations');
    expect(title).not.toHaveTextContent('chr11');
    expect(title).not.toHaveTextContent('MB');
    expect(screen.getByTestId('indexed-genome-identity')).toHaveClass('sr-only');
    expect(screen.getByTestId('indexed-genome-identity')).toHaveTextContent('268,361,931 bp');
    expect(screen.getByTestId('indexed-genome-annotation-count')).toHaveClass('sr-only');
    expect(screen.getByTestId('indexed-genome-annotation-count')).toHaveAttribute(
      'data-count-state',
      'ready'
    );
    expect(screen.getByTestId('indexed-genome-annotation-count')).toHaveTextContent(
      '42,731 annotations'
    );
  });

  it('reports a half-base camera window by its actual span rather than rounded endpoint coverage', async () => {
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 135_086_622 });
    const tab = indexedTab();
    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => expect(viewerProps.current).not.toBeNull());
    act(() => {
      (viewerProps.current?.onLoadPhase as ((phase: 'ready') => void) | undefined)?.('ready');
      (
        viewerProps.current?.onViewportRangeChange as
          | ((range: { start: number; end: number }) => void)
          | undefined
      )?.({ start: 32_400_500.5, end: 32_402_500.5 });
    });
    expect(screen.getByTestId('indexed-genome-live-span')).toHaveTextContent('2,000 bp span');
    expect(screen.getByTestId('indexed-genome-live-range')).toHaveTextContent(
      '32,400,501–32,402,500'
    );
  });

  it('keeps camera-owned coordinates out of the toolbar and opens the shared FindBar', async () => {
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 135_086_622 });
    const tab = indexedTab();
    resetCanvasStore(tab);

    render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => expect(viewerProps.current).not.toBeNull());
    act(() => {
      (viewerProps.current?.onLoadPhase as ((phase: 'ready') => void) | undefined)?.('ready');
      (
        viewerProps.current?.onViewportRangeChange as
          | ((range: { start: number; end: number }) => void)
          | undefined
      )?.({ start: 1_999, end: 5_499 });
    });

    expect(screen.getByTestId('indexed-genome-live-range')).toHaveClass('sr-only');
    expect(screen.getByTestId('indexed-genome-live-range')).toHaveTextContent('2,000–5,499');
    expect(screen.getByTestId('indexed-genome-live-span')).toHaveClass('sr-only');

    const findButton = screen.getByRole('button', { name: 'Find sequence or annotations' });
    expect(findButton).toBeDisabled();
    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    act(() => emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!)));
    await waitFor(() => expect(findButton).toBeEnabled());
    expect(findButton).toBeEnabled();
    act(() => findButton.click());
    expect(screen.getByTestId('findbar-shell')).toBeVisible();
  });

  it('keeps persisted mutation calls dormant without a top-toolbar trigger', async () => {
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 3_088_269_832 });
    const tab = fullGenomeIndexedTab();
    mockOpen.mockResolvedValue({
      sessionId: 'session-chr1',
      sourcePath: tab.indexedGenome!.sourcePath,
      sourceFingerprint: 'fingerprint-chr1',
      chrom: 'chr1',
      sourceSizeBytes: tab.indexedGenome!.sourceSizeBytes,
      coordinateReady: false,
      validationState: 'metadata_match',
      openedAt: 1,
      tracks: [],
    });
    const matchedReferences = tab.indexedGenome!.assembly!.chromosomes.map(
      (chromosome) => chromosome.chrom
    );
    const generation = {
      canonicalPath: '/workspace/HG002.GRCh38.vcf.gz',
      size: 123,
      mtimeNs: '456',
      ctimeNs: '457',
      device: '10',
      inode: '11',
    };
    const preparedSource = {
      sourcePath: '/workspace/HG002.GRCh38.vcf.gz',
      queryPath: '/workspace/HG002.GRCh38.vcf.gz',
      indexPath: '/workspace/HG002.GRCh38.vcf.gz.tbi',
      format: 'vcf' as const,
      label: 'HG002.GRCh38.vcf.gz',
      sourceSizeBytes: 123,
      sourceMtimeNs: '456',
      sourceIdentity: 'd'.repeat(64),
      sourceGeneration: generation,
      queryGeneration: generation,
      indexGeneration: {
        ...generation,
        canonicalPath: '/workspace/HG002.GRCh38.vcf.gz.tbi',
        inode: '12',
      },
      assemblyRevision: `variant-assembly-v1:sha256:${'e'.repeat(64)}`,
      matchedReferences,
      samples: ['HG002'],
    };
    const variant = {
      id: 'call-chr7',
      recordId: 'rs-test',
      chrom: 'chr7',
      start: 108_833_384,
      end: 108_833_385,
      position: 108_833_385,
      ref: 'C',
      alts: ['T'],
      quality: 99,
      filters: ['PASS'],
      variantClass: 'substitution' as const,
      genotypes: { HG002: '0/1' },
    };
    mockWaitForVariantSourceResult.mockResolvedValue(preparedSource);
    mockReadVariantPage.mockResolvedValue({ variants: [variant], nextCursor: null });
    resetCanvasStore(tab);

    const { rerender } = render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    const attachedSource = { ...preparedSource, attachedAt: 1 };
    act(() => {
      useCanvasStore.getState().updateTab('main', tab.id, {
        indexedGenome: {
          ...tab.indexedGenome!,
          variantSource: attachedSource,
        },
      });
    });
    const externallyUpdatedTab = useCanvasStore.getState().panels.main.tabs[0]!;
    rerender(<IndexedGenomeTab tab={externallyUpdatedTab} />);

    act(() => emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!)));
    await waitFor(() =>
      expect(useCanvasStore.getState().panels.main.tabs[0]?.indexedGenome?.variantSource).toEqual(
        attachedSource
      )
    );
    await waitFor(() => expect(viewerProps.current).not.toBeNull());
    act(() => {
      (viewerProps.current?.onLoadPhase as ((phase: 'ready') => void) | undefined)?.('ready');
    });

    expect(screen.queryByTestId('open-mutation-navigator')).toBeNull();
    expect(screen.queryByTestId('mutation-navigator')).toBeNull();
    expect(mockDialogOpen).not.toHaveBeenCalled();
    expect(mockStartVariantSourceOperation).not.toHaveBeenCalled();
    expect(mockWaitForVariantSourceResult).not.toHaveBeenCalled();
    expect(mockReadVariantPage).not.toHaveBeenCalled();
  });

  it('carries an exact hidden-track hit into a lifecycle-scoped viewer focus', async () => {
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 3_088_269_832 });
    mockQueryAssemblyAnnotationSearch.mockResolvedValue({
      status: 'hit',
      fingerprint: 'grch38-search-source',
      featureCount: 1,
      matches: [
        {
          featureIndex: 0,
          start: 1_813_906_514,
          end: 1_813_908_122,
          label: 'H19',
          featureType: 'ncRNA',
          annotationTrackId: 'lncRNA',
          canonicalIdentity: 'annotation.v2:H19.ncrna.1',
        },
      ],
    });
    mockPrepackedSceneCache.mockReturnValue(assemblySearchSceneCacheDescriptor());
    const tab = assemblyIndexedTab();
    resetCanvasStore(tab);

    const { rerender } = render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    act(() => emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!)));
    await waitFor(() => expect(viewerProps.current).not.toBeNull());
    act(() => {
      (viewerProps.current?.onLoadPhase as ((phase: 'ready') => void) | undefined)?.('ready');
    });

    act(() => screen.getByRole('button', { name: 'Find sequence or annotations' }).click());
    act(() => screen.getByRole('button', { name: 'Search mode: DNA bases' }).click());
    fireEvent.change(screen.getByLabelText('Search pattern'), { target: { value: 'H1' } });

    expect(screen.getByText('type 3+ chars')).toBeInTheDocument();
    expect(mockQueryAssemblyAnnotationSearch).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Search pattern'), { target: { value: 'H19' } });

    const resultRow = await screen.findByTestId('findbar-aa-result-row');
    expect(resultRow).toHaveTextContent('H19');
    expect(resultRow).toHaveTextContent('ncRNA');
    const lightBadge = within(resultRow).getByText('ncRNA');
    const lightBadgeStyle = annotationTypeBadgeStyle('ncRNA', 'light');
    expect(lightBadge).toHaveStyle({
      background: lightBadgeStyle.background,
      color: lightBadgeStyle.color,
      boxShadow: `inset 0 -2px 0 ${lightBadgeStyle.accent}`,
    });
    expect(mockQueryAssemblyAnnotationSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'H19', limit: 500 }),
      expect.objectContaining({ signal: expect.anything() })
    );

    darkModeState.current = true;
    rerender(<IndexedGenomeTab tab={tab} />);
    const darkBadgeStyle = annotationTypeBadgeStyle('ncRNA', 'dark');
    await waitFor(() =>
      expect(within(screen.getByTestId('findbar-aa-result-row')).getByText('ncRNA')).toHaveStyle({
        background: darkBadgeStyle.background,
        color: darkBadgeStyle.color,
        boxShadow: `inset 0 -2px 0 ${darkBadgeStyle.accent}`,
      })
    );
    expect(viewerProps.current?.themeMode).toBe('dark');

    act(() => screen.getByTestId('mock-annotation-lane-change').click());
    expect(screen.getByTestId('findbar-aa-result-row')).toHaveTextContent('H19');

    fireEvent.click(screen.getByTestId('findbar-aa-result-row'));
    await waitFor(() =>
      expect(viewerProps.current?.searchHighlight).toEqual(
        expect.objectContaining({
          start: 1_813_906_514,
          end: 1_813_908_122,
          featureType: 'ncRNA',
          annotationTrackId: 'lncRNA',
          canonicalIdentity: 'annotation.v2:H19.ncrna.1',
        })
      )
    );

    mockPrepackedSceneCache.mockReturnValue(assemblySearchSceneCacheDescriptor('b'.repeat(64)));
    const revisedSearchUpdate = readySessionUpdate(tab.indexedGenome!);
    act(() =>
      emitPlatformEvent('genome:sessionUpdated', {
        ...revisedSearchUpdate,
        shell: {
          ...revisedSearchUpdate.shell,
          assemblySearchSource: assemblySearchSceneCacheDescriptor('b'.repeat(64)).descriptor
            .request,
        },
      })
    );
    rerender(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => expect(viewerProps.current?.searchHighlight).toBeNull());
    expect(screen.getByLabelText('Search pattern')).toHaveValue('H19');

    fireEvent.change(screen.getByLabelText('Search pattern'), { target: { value: 'H19X' } });
    await waitFor(() => expect(viewerProps.current?.searchHighlight).toBeNull());

    act(() => {
      (
        viewerProps.current?.onViewportRangeChange as
          | ((range: { start: number; end: number }) => void)
          | undefined
      )?.({ start: 1_813_900_000, end: 1_813_920_000 });
    });
    fireEvent.change(screen.getByLabelText('Search pattern'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Search pattern'), { target: { value: 'H19' } });
    expect(await screen.findByTestId('findbar-aa-result-row')).toHaveTextContent('H19');

    fireEvent.click(screen.getByTestId('findbar-aa-result-row'));
    await waitFor(() => expect(viewerProps.current?.searchHighlight).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Close find bar' }));
    await waitFor(() => expect(viewerProps.current?.searchHighlight).toBeNull());
  });

  it('does zero annotation-search I/O while an active assembly viewer has Find closed', async () => {
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 3_088_269_832 });
    mockPrepackedSceneCache.mockReturnValue(assemblySearchSceneCacheDescriptor());
    const tab = assemblyIndexedTab();
    resetCanvasStore(tab);

    render(<IndexedGenomeTab tab={tab} isActive />);

    await waitFor(() => expect(mockPrepackedSceneCache).toHaveBeenCalled());
    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    act(() => emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!)));
    await waitFor(() => expect(viewerProps.current).not.toBeNull());
    expect(mockQueryAssemblyAnnotationSearch).not.toHaveBeenCalled();

    act(() => screen.getByTestId('mock-annotation-lane-change').click());
    expect(mockQueryAssemblyAnnotationSearch).not.toHaveBeenCalled();
  });

  it('uses one controlled mapper policy for the viewer controls and prepacked cache', async () => {
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 135_086_622 });
    resetCanvasStore(indexedTab());

    const tab = indexedTab();
    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });

    await waitFor(() => expect(screen.getByTestId('mock-annotation-mode-change')).toBeVisible());
    expect(viewerProps.current?.annotationMapperPolicy).toEqual({
      isoformMode: 'canonical',
      laneLimit: 2,
    });
    expect(mockPrepackedSceneCache).toHaveBeenCalledWith(
      expect.objectContaining({
        prepareOnMiss: false,
        policy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 2 },
      })
    );
    expect(mockAssemblyAnnotationFeatures).toHaveBeenLastCalledWith(
      undefined,
      '/workspace',
      false,
      'canonical'
    );

    act(() => {
      screen.getByTestId('mock-annotation-mode-change').click();
    });

    await waitFor(() => {
      expect(viewerProps.current?.annotationMapperPolicy).toEqual({
        isoformMode: 'expanded',
        laneLimit: 2,
      });
      expect(mockPrepackedSceneCache).toHaveBeenLastCalledWith(
        expect.objectContaining({
          prepareOnMiss: false,
          policy: { trackType: 'mRNA', isoformMode: 'expanded', laneLimit: 2 },
        })
      );
      expect(mockAssemblyAnnotationFeatures).toHaveBeenLastCalledWith(
        undefined,
        '/workspace',
        false,
        'expanded'
      );
    });
    act(() => {
      screen.getByTestId('mock-annotation-lane-change').click();
    });
    await waitFor(() => {
      expect(viewerProps.current?.annotationMapperPolicy).toEqual({
        isoformMode: 'expanded',
        laneLimit: 8,
      });
      expect(mockPrepackedSceneCache).toHaveBeenLastCalledWith(
        expect.objectContaining({
          policy: { trackType: 'mRNA', isoformMode: 'expanded', laneLimit: 8 },
        })
      );
      expect(mockAssemblyAnnotationFeatures).toHaveBeenLastCalledWith(
        undefined,
        '/workspace',
        false,
        'expanded'
      );
    });
  });

  it('falls back to two annotation lanes for an assembly tab without a born policy', async () => {
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 135_086_622 });
    const tab = assemblyIndexedTab();
    resetCanvasStore(tab);

    render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    act(() => emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!)));

    await waitFor(() => expect(screen.getByTestId('mock-annotation-mode-change')).toBeVisible());
    expect(viewerProps.current?.annotationMapperPolicy).toEqual({
      isoformMode: 'canonical',
      laneLimit: 2,
    });
    expect(mockPrepackedSceneCache).toHaveBeenLastCalledWith(
      expect.objectContaining({
        policy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 2 },
      })
    );
  });

  it('keeps compiled policy request ids monotonic while the session reopens without remounting the Viewer', async () => {
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 268_361_931 });
    mockReadAssemblyAnnotationRasterV2.mockImplementation(
      () => new Promise<never>(() => undefined)
    );
    mockPrepackedSceneCache.mockReturnValue({
      status: 'loading',
      descriptor: {
        sourceIdentity: 'grch38-policy-source',
        datasetContract: {
          datasetId: 'grch38-test',
          datasetVersion: '1',
          sourceSha256: 'a'.repeat(64),
        },
        runtimeCacheKey: 'policy-runtime',
        sceneKey: 'policy-scene',
        artifact: { artifactKey: 'policy-artifact', trackType: 'mRNA' },
      },
      result: null,
      error: null,
    } as never);
    const tab = assemblyIndexedTab();
    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    const readyUpdate = readySessionUpdate(tab.indexedGenome!);
    act(() => emitPlatformEvent('genome:sessionUpdated', readyUpdate));
    await waitFor(() => expect(screen.getByTestId('mock-annotation-mode-change')).toBeVisible());

    const allocateBeforeReopen = viewerProps.current?.allocateAnnotationMapperPolicyRequestId as
      | (() => number)
      | undefined;
    expect(allocateBeforeReopen).toBeTypeOf('function');
    expect(viewerProps.current?.onAnnotationMapperPolicyPreparationRequest).toBeUndefined();
    expect(viewerProps.current?.annotationMapperPolicyRasterPreparation).toBeUndefined();
    expect(viewerProps.current?.overviewTexture).toBeUndefined();
    expect(viewerProps.current?.overviewTextureStatus).toBeUndefined();
    expect(allocateBeforeReopen?.()).toBe(1);

    act(() =>
      emitPlatformEvent('genome:sessionUpdated', {
        ...readyUpdate,
        prepareStatus: 'preparing',
      })
    );
    await waitFor(() => expect(screen.getByTestId('mock-annotation-mode-change')).toBeVisible());
    act(() => emitPlatformEvent('genome:sessionUpdated', readyUpdate));
    await waitFor(() => expect(screen.getByTestId('mock-annotation-mode-change')).toBeVisible());

    const allocateAfterReopen = viewerProps.current?.allocateAnnotationMapperPolicyRequestId as
      | (() => number)
      | undefined;
    expect(allocateAfterReopen).toBe(allocateBeforeReopen);
    expect(allocateAfterReopen?.()).toBe(2);
    expect(viewerProps.current?.onAnnotationMapperPolicyPreparationRequest).toBeUndefined();
    expect(viewerProps.current?.annotationMapperPolicyRasterPreparation).toBeUndefined();
  });

  it('starts the owner-bound V4 payload when source validation is ready without duplicating the seed read', async () => {
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 268_361_931 });
    mockPrepackedSceneCache.mockImplementation(
      () =>
        ({
          status: 'loading',
          descriptor: {
            sourceIdentity: 'grch38-raster-first-source',
            datasetContract: {
              datasetId: 'grch38-test',
              datasetVersion: '1',
              sourceSha256: 'a'.repeat(64),
            },
            runtimeCacheKey: 'raster-first-runtime',
            sceneKey: 'raster-first-scene',
            artifact: { artifactKey: 'raster-first-artifact', trackType: 'mRNA' },
          },
          result: null,
          error: null,
        }) as never
    );
    const tab = assemblyIndexedTab();
    resetCanvasStore(tab);
    const { rerender } = render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    act(() => emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!)));
    await waitFor(() => expect(viewerProps.current).not.toBeNull());

    expect(mockPrepackedSceneCache).toHaveBeenLastCalledWith(
      expect.objectContaining({ interactionPayloadEnabled: false })
    );
    expect(viewerProps.current?.annotationInteractionPayloadEnabled).toBe(true);
    expect(viewerProps.current?.annotationProductPublicationReady).toBe(true);
    expect(viewerProps.current?.onCompiledBroadRasterVisualReady).toBeUndefined();

    darkModeState.current = true;
    rerender(<IndexedGenomeTab tab={tab} />);
    await waitFor(() =>
      expect(mockPrepackedSceneCache).toHaveBeenLastCalledWith(
        expect.objectContaining({
          interactionPayloadEnabled: false,
          themeMode: 'light',
        })
      )
    );
    expect(viewerProps.current?.annotationInteractionPayloadEnabled).toBe(true);
  });

  it('keeps source-validated annotation payloads disabled while a hosted source is pending', async () => {
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 268_361_931 });
    mockPrepackedSceneCache.mockImplementation(
      () =>
        ({
          status: 'loading',
          descriptor: {
            sourceIdentity: 'grch38-portable-view-source',
            datasetContract: {
              datasetId: 'grch38-test',
              datasetVersion: '1',
              sourceSha256: 'a'.repeat(64),
            },
            runtimeCacheKey: 'portable-view-runtime',
            sceneKey: 'portable-view-scene',
            artifact: { artifactKey: 'portable-view-artifact', trackType: 'mRNA' },
          },
          result: null,
          error: null,
        }) as never
    );
    const tab = assemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblySourceReadiness: 'pending',
      assemblyAnnotationProductsReadiness: 'ready',
      assemblySearchReadiness: 'pending',
    };
    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => expect(viewerProps.current).not.toBeNull());

    await waitFor(() =>
      expect(mockPrepackedSceneCache).toHaveBeenLastCalledWith(
        expect.objectContaining({ interactionPayloadEnabled: false })
      )
    );
    expect(viewerProps.current?.annotationInteractionPayloadEnabled).toBe(false);
  });

  it('derives the assembly source descriptor before prepared products become ready', async () => {
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 268_361_931 });
    mockReadAssemblyAnnotationProductSetInventoryV1.mockResolvedValue({ status: 'unavailable' });
    const tab = assemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblySourceReadiness: 'ready',
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
    };
    resetCanvasStore(tab);

    render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    act(() => emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!)));
    await waitFor(() => expect(viewerProps.current).not.toBeNull());

    await waitFor(() =>
      expect(mockPrepackedSceneCache).toHaveBeenLastCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ assemblyId: 'grch38-test' }),
          interactionPayloadEnabled: false,
          prepareProductOnly: true,
        })
      )
    );
    expect(viewerProps.current?.annotationProductPublicationReady).toBe(false);
  });

  it('is born in the tab-supplied initial mapper policy before source or scene work starts', async () => {
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 135_086_622 });
    const tab = indexedTab();
    tab.initialAnnotationMapperPolicy = {
      isoformMode: 'expanded',
      laneLimit: 8,
    };
    resetCanvasStore(tab);

    render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });

    await waitFor(() => expect(screen.getByTestId('mock-annotation-mode-change')).toBeVisible());
    expect(viewerProps.current?.annotationMapperPolicy).toEqual({
      isoformMode: 'expanded',
      laneLimit: 8,
    });
    expect(mockPrepackedSceneCache).toHaveBeenLastCalledWith(
      expect.objectContaining({
        policy: { trackType: 'mRNA', isoformMode: 'expanded', laneLimit: 8 },
      })
    );
    expect(mockAssemblyAnnotationFeatures).toHaveBeenLastCalledWith(
      undefined,
      '/workspace',
      false,
      'expanded'
    );
  });

  it('uses one cache hook without a policy-specific standby preparation', async () => {
    const canonicalDescriptor = {
      sourceIdentity: 'source-canonical',
      runtimeCacheKey: 'runtime-canonical-12',
      sceneKey: 'scene-canonical-12',
      sceneVariant: {
        trackType: 'mRNA',
        isoformMode: 'canonical' as const,
        laneLimit: 12,
      },
    };
    const validatedHit = {
      status: 'hit' as const,
      fingerprint: 'a'.repeat(24),
      sourceBuildFingerprint: 'b'.repeat(64),
      byteCount: 0,
      manifest: {
        integrity: {
          payloadSha256: 'c'.repeat(64),
          contractSha256: 'd'.repeat(64),
        },
      },
    };
    mockPrepackedSceneCache.mockImplementation((input: Record<string, unknown>) => {
      const policy = input.policy as { isoformMode: 'canonical' | 'expanded' };
      if (policy.isoformMode === 'canonical') {
        return {
          status: 'hit',
          descriptor: canonicalDescriptor,
          result: validatedHit,
          error: null,
        } as never;
      }
      return {
        status: input.enabled === false ? 'not-applicable' : 'hit',
        descriptor:
          input.enabled === false ? null : { ...canonicalDescriptor, sceneKey: 'expanded' },
        result: input.enabled === false ? null : validatedHit,
        error: null,
      } as never;
    });
    workspaceState.loading = false;
    mockInit.mockResolvedValue({ length: 135_086_622 });
    const tab = indexedTab();
    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });
    await waitFor(() => expect(viewerProps.current).not.toBeNull());

    expect(mockPrepackedSceneCache).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: expect.objectContaining({ isoformMode: 'canonical' }),
      })
    );
    expect(
      mockPrepackedSceneCache.mock.calls.some(
        ([input]) => (input as Record<string, unknown>).enabled === false
      )
    ).toBe(false);

    act(() => {
      (
        viewerProps.current?.onAnnotationMapperPolicyChange as
          | ((policy: { isoformMode: 'expanded'; laneLimit: number }) => void)
          | undefined
      )?.({ isoformMode: 'expanded', laneLimit: 24 });
    });

    await waitFor(() =>
      expect(mockPrepackedSceneCache).toHaveBeenCalledWith(
        expect.objectContaining({
          policy: { trackType: 'mRNA', isoformMode: 'expanded', laneLimit: 24 },
        })
      )
    );
  });
});
