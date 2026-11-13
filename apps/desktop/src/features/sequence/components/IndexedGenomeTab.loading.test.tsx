import { userMessage } from '@waypoint/user-messages';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { isApplePlatform } from '@waypoint/ui-components/keyboard';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tab } from '../../canvas/types';
import { useCanvasStore } from '../../canvas/store';
import { markGenomeSessionShellError } from '../../../shared/genome-session-shell';
import type { GenomeSessionShell } from '../../../shared/indexed-genome';
import { buildGenomeAssembly, referenceAssemblyById } from '../reference-catalog';
import { useLaneContractStore } from '../lane-contract-store';
import { trackViewFixture } from '../../../shared/track-view-fixture';
import type { TrackViewDocument } from '../../../shared/track-view';
import { trackViewReference } from '../open-track-view';
import { laneFromIndexedGenomeDataTrack } from '../ucsc-track-persistence';
import * as persistedDataTracks from './usePersistedUcscTracks';
import * as persistedBamTracks from './usePersistedBamTracks';
import {
  readIndexedLiveViewport,
  resetIndexedLiveViewportForTests,
  waitForIndexedLiveViewport,
} from '../indexed-live-viewport';
import { IndexedGenomeTab } from './IndexedGenomeTab';
import { computeLoadPhase } from './indexed-genome-load-phase';

const {
  mockInit,
  mockGetSequence,
  mockGetSequenceWindow,
  mockGetFeatures,
  mockGetFeatureDetailsByManifest,
  mockGetSession,
  mockGetAssemblyOverview,
  mockSearchAssemblySequence,
  mockOpen,
  mockUpgradeSessionCapabilities,
  mockCloseSession,
  mockOn,
  mockExists,
  mockReadAssemblyOverviewFeatures,
  mockReadAssemblyAnnotationRasterV2,
  mockReadAssemblyAnnotationScene,
  mockReadAssemblyAnnotationProductSetInventory,
  mockWriteAssemblyOverviewFeatures,
  mockWriteAssemblyOverviewTexture,
  mockHasPreparedPrepackedScene,
  mockListLocalReferences,
  mockGetLocalPreparationStatus,
  mockRetryLocalReference,
  mockListHostedReferences,
  mockInstallHostedReference,
  mockGetHostedPreparationStatus,
  mockOnReferencePreparationProgress,
  mockOnHostedInstallProgress,
  mockReferenceAssetCacheRoot,
  mockReadTextFile,
  mockReadDir,
  emitReferencePreparationProgress,
  emitHostedInstallProgress,
  emitPlatformEvent,
  viewerState,
  workspaceState,
} = vi.hoisted(() => ({
  mockInit: vi.fn(),
  mockGetSequence: vi.fn(),
  mockGetSequenceWindow: vi.fn(),
  mockGetFeatures: vi.fn(),
  mockGetFeatureDetailsByManifest: vi.fn(),
  mockGetSession: vi.fn(),
  mockGetAssemblyOverview: vi.fn(),
  mockSearchAssemblySequence: vi.fn(),
  mockOpen: vi.fn(),
  mockUpgradeSessionCapabilities: vi.fn(),
  mockCloseSession: vi.fn(),
  mockOn: vi.fn(),
  mockExists: vi.fn(),
  mockReadAssemblyOverviewFeatures: vi.fn(),
  mockReadAssemblyAnnotationRasterV2: vi.fn(),
  mockReadAssemblyAnnotationScene: vi.fn(),
  mockReadAssemblyAnnotationProductSetInventory: vi.fn(),
  mockWriteAssemblyOverviewFeatures: vi.fn(),
  mockWriteAssemblyOverviewTexture: vi.fn(),
  mockHasPreparedPrepackedScene: vi.fn(() => false),
  mockListLocalReferences: vi.fn(),
  mockGetLocalPreparationStatus: vi.fn(),
  mockRetryLocalReference: vi.fn(),
  mockListHostedReferences: vi.fn(),
  mockInstallHostedReference: vi.fn(),
  mockGetHostedPreparationStatus: vi.fn(),
  mockOnReferencePreparationProgress: vi.fn(),
  mockOnHostedInstallProgress: vi.fn(),
  mockReferenceAssetCacheRoot: vi.fn(),
  mockReadTextFile: vi.fn(),
  mockReadDir: vi.fn(),
  emitReferencePreparationProgress: vi.fn(),
  emitHostedInstallProgress: vi.fn(),
  mockSearchSequence: vi.fn(),
  emitPlatformEvent: vi.fn(),
  viewerState: {
    props: null as Record<string, unknown> | null,
    autoReady: true,
  },
  workspaceState: {
    path: '/workspace',
    loading: false,
  },
}));

const canvasContext = {
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  font: '',
  textBaseline: '',
  fillRect: vi.fn(),
  strokeRect: vi.fn(),
  fillText: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  setLineDash: vi.fn(),
  setTransform: vi.fn(),
};
const mockCanvasGetContext = vi.fn();

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
    fs: {
      exists: mockExists,
      readTextFile: mockReadTextFile,
      readDir: mockReadDir,
    },
    path: {
      referenceAssetCacheRoot: mockReferenceAssetCacheRoot,
    },
    referenceAssets: {
      listLocal: mockListLocalReferences,
      getLocalPreparationStatus: mockGetLocalPreparationStatus,
      retryLocal: mockRetryLocalReference,
      listHosted: mockListHostedReferences,
      installHosted: mockInstallHostedReference,
      getHostedPreparationStatus: mockGetHostedPreparationStatus,
      onPreparationProgress: mockOnReferencePreparationProgress,
      onHostedInstallProgress: mockOnHostedInstallProgress,
    },
    genome: {
      open: mockOpen,
      upgradeSessionCapabilities: mockUpgradeSessionCapabilities,
      closeSession: mockCloseSession,
      init: mockInit,
      getSequenceWindow: mockGetSequenceWindow,
      getSequence: mockGetSequence,
      getFeatures: mockGetFeatures,
      getFeatureDetailsByManifest: mockGetFeatureDetailsByManifest,
      getSession: mockGetSession,
      getAssemblyOverview: mockGetAssemblyOverview,
      searchAssemblySequence: mockSearchAssemblySequence,
      readAssemblyOverviewFeatures: mockReadAssemblyOverviewFeatures,
      readAssemblyAnnotationRasterV2: mockReadAssemblyAnnotationRasterV2,
      readAssemblyAnnotationScene: mockReadAssemblyAnnotationScene,
      readAssemblyAnnotationProductSetInventoryV1: mockReadAssemblyAnnotationProductSetInventory,
      searchSequence: vi.fn(),
      writeAssemblyOverviewFeatures: mockWriteAssemblyOverviewFeatures,
      writeAssemblyOverviewTexture: mockWriteAssemblyOverviewTexture,
    },
    on: mockOn,
  }),
}));

vi.mock('./usePrepackedAssemblyAnnotationScene', () => ({
  hasPreparedPrepackedAssemblyAnnotationScene: mockHasPreparedPrepackedScene,
}));

vi.mock('./IndexedGenomeViewer', () => ({
  IndexedGenomeViewer: (props: {
    targetViewport?: { id: number; start: number; end: number } | null;
    overviewTexture?: unknown;
    overviewTextureStatus?: string;
    onLoadPhase?: (phase: 'loading' | 'ready' | 'error', message?: string) => void;
    onTrackError?: (kind: 'sequence' | 'annotation', message: string) => void;
    onTrackReady?: (kind: 'sequence' | 'annotation') => void;
    onCompiledBroadRasterVisualReady?: () => void;
    annotationInteractionPayloadEnabled?: boolean;
    requireFullAssemblyReadiness?: boolean;
    annotationSceneSourceRequest?: { scope?: { kind?: string } } | null;
    prepackedAnnotationSceneCache?: { status?: string; descriptor?: unknown } | null;
  }) => {
    viewerState.props = props;
    if (props.onLoadPhase && viewerState.autoReady) {
      Promise.resolve().then(() => props.onLoadPhase?.('ready'));
    }
    Promise.resolve().then(() => props.onCompiledBroadRasterVisualReady?.());
    return <div data-testid="indexed-genome-viewer-mock" />;
  },
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

function StoredIndexedGenomeTab({ entityId }: { entityId: string }) {
  const tab = useCanvasStore((state) =>
    Object.values(state.panels)
      .flatMap((panel) => panel.tabs)
      .find((candidate) => candidate.entityId === entityId)
  );
  return tab ? <IndexedGenomeTab tab={tab} /> : null;
}

function freshIndexedTab(): Tab {
  return {
    id: 'test-tab',
    type: 'sequence',
    entityId: 'indexed-sequence:chr11-test',
    sequenceDocument: {
      kind: 'indexed-sequence',
      documentId: 'indexed-sequence:chr11-test',
    },
    label: 'chr11.gbff',
    fileSizeBytes: 140 * 1024 * 1024,
    loadStatus: 'indexed',
    indexedGenome: {
      sourcePath: '/workspace/chr11.gbff',
      sourceSizeBytes: 140 * 1024 * 1024,
      sourceExt: 'gbff',
      chrom: 'chr11',
    },
  } as Tab;
}

function reopenIndexedTab(): Tab {
  return {
    id: 'test-tab',
    type: 'sequence',
    entityId: 'indexed-sequence:chr11-test',
    sequenceDocument: {
      kind: 'indexed-sequence',
      documentId: 'indexed-sequence:chr11-test',
    },
    label: 'chr11.gbff',
    fileSizeBytes: 140 * 1024 * 1024,
    loadStatus: 'indexed',
    indexedGenome: {
      sourcePath: '/workspace/chr11.gbff',
      sourceSizeBytes: 140 * 1024 * 1024,
      sourceExt: 'gbff',
      chrom: 'chr11',
      manifest: {
        chrom: 'chr11',
        fastaPath: '/workspace/.waypoint/genome-index/chr11/chr11.fa',
        faiPath: '/workspace/.waypoint/genome-index/chr11/chr11.fa.fai',
        gffPath: '/workspace/.waypoint/genome-index/chr11/chr11.gff3.gz',
        tbiPath: '/workspace/.waypoint/genome-index/chr11/chr11.gff3.gz.tbi',
        length: 135_086_622,
      },
      metadata: {
        length: 135_086_622,
        circular: false,
      },
    },
  } as Tab;
}

function assemblyIndexedTab(): Tab {
  const tab = reopenIndexedTab();
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
      assemblySearchReadiness: 'ready',
      scope: { kind: 'all' },
    },
  } as Tab;
}

function sequenceOnlyAssemblyIndexedTab(): Tab {
  const anchorManifest = {
    chrom: 'contig-1',
    fastaPath: '/workspace/prepared/contig-1/contig-1.fa',
    faiPath: '/workspace/prepared/contig-1/contig-1.fa.fai',
    gffPath: null,
    tbiPath: null,
    length: 12_345,
  };
  return {
    id: 'sequence-only-assembly-tab',
    type: 'sequence',
    entityId: 'assembly:gcf-sequence-only',
    sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:gcf-sequence-only' },
    label: 'Sequence-only assembly',
    loadStatus: 'indexed-pending',
    indexedGenome: {
      sourcePath: anchorManifest.fastaPath,
      workspaceRoot: '/workspace',
      sourceExt: 'fa',
      chrom: anchorManifest.chrom,
      manifest: anchorManifest,
      metadata: { length: anchorManifest.length, circular: false },
      assembly: {
        assemblyId: 'gcf-sequence-only',
        displayName: 'Sequence-only assembly',
        chromosomes: [
          {
            chrom: anchorManifest.chrom,
            displayName: anchorManifest.chrom,
            length: anchorManifest.length,
            manifest: anchorManifest,
          },
        ],
      },
      assemblySourceReadiness: 'ready',
      assemblyAnnotationProductsReadiness: 'not-applicable',
      assemblySearchReadiness: 'not-applicable',
      scope: { kind: 'all' },
    },
  } as Tab;
}

function freshAssemblyIndexedTab(): Tab {
  const tab = assemblyIndexedTab();
  const catalogEntry = referenceAssemblyById('grch38');
  if (!catalogEntry) throw new Error('Missing GRCh38 catalog fixture');
  const assembly = buildGenomeAssembly(catalogEntry, (path) => `/workspace/${path}`);
  const anchor = assembly.chromosomes[0];
  if (!anchor?.manifest.gffPath) throw new Error('Missing GRCh38 anchor source fixture');
  const anchorSourceSizeBytes = Math.round(6.7 * 1024 * 1024);
  return {
    ...tab,
    entityId: 'assembly:grch38',
    sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:grch38' },
    label: assembly.displayName,
    fileSizeBytes: anchorSourceSizeBytes,
    indexedGenome: {
      ...tab.indexedGenome!,
      sourcePath: anchor.manifest.gffPath,
      sourceSizeBytes: anchorSourceSizeBytes,
      sourceExt: 'gff3',
      chrom: anchor.chrom,
      manifest: undefined,
      metadata: undefined,
      assembly,
    },
  } as Tab;
}

function grch38HostedShell() {
  const entry = referenceAssemblyById('grch38');
  if (!entry) throw new Error('Missing GRCh38 catalog fixture');
  return {
    id: entry.id,
    name: entry.name,
    organism: entry.organism,
    taxId: entry.taxId,
    assembly: entry.assembly,
    description: entry.description,
    assetCacheKey: entry.assetCacheKey,
    members: entry.members.map((member) => ({
      chrom: member.chrom,
      displayName: member.displayName,
      lengthBp: member.lengthBp,
      role: member.role,
      aliases: member.aliases,
      circular: member.circular,
      cytobandId: member.chrom,
    })),
  };
}

function grch38HostedPortableView() {
  const entry = referenceAssemblyById('grch38');
  if (!entry) throw new Error('Missing GRCh38 catalog fixture');
  return {
    ...entry,
    portableView: {
      generationRoot: '/reference-assets/grch38/views/current',
      bundleFingerprint: 'f'.repeat(64),
      trackTypes: ['enhancer', 'mRNA'],
    },
  };
}

function grch38HostedAnnotationReadyView(searchReady: boolean) {
  const entry = grch38HostedPortableView();
  return {
    ...entry,
    portableView: {
      ...entry.portableView,
      assetGenerationsByTheme: {
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
      },
      searchReady,
    },
  };
}

function grch38HostedCatalogEntry() {
  return {
    id: 'grch38',
    name: 'GRCh38 (human)',
    organism: 'Homo sapiens',
    assembly: 'GRCh38.p14',
    description: 'Human reference',
    lengthBp: 3_088_286_401,
    contigCount: 24,
    downloadBytes: 1_060_000_000,
    provider: 'NCBI',
    datasetVersion: 'GRCh38.p14',
  };
}

async function waitForSessionSubscription(): Promise<void> {
  await waitFor(() => {
    expect(mockOpen).toHaveBeenCalled();
    expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
  });
  await screen.findByTestId('indexed-genome-tab');
}

function readySessionUpdate(tabState = reopenIndexedTab().indexedGenome!) {
  return {
    sessionId: 'session-chr11',
    prepareStatus: 'ready',
    prepareLoadPhase: 'indexing',
    reusedExistingIndex: false,
    shell: {
      sessionId: 'session-chr11',
      sourcePath: '/workspace/chr11.gbff',
      sourceFingerprint: 'fingerprint-chr11',
      chrom: 'chr11',
      sourceSizeBytes: 140 * 1024 * 1024,
      openReady: true,
      coordinateReady: true,
      length: 135_086_622,
      manifest: tabState.manifest,
      validationState: 'strong_match',
      openedAt: 1,
      tracks: [
        {
          id: 'chr11:sequence',
          kind: 'sequence',
          label: 'Sequence',
          state: 'coordinate_ready',
          userState: 'Showing overview',
        },
        {
          id: 'chr11:annotations',
          kind: 'annotation',
          label: 'Annotations',
          state: 'ready',
          userState: 'Showing overview',
        },
      ],
    },
    tabState,
  };
}

describe('computeLoadPhase', () => {
  it('reports the prepare phase when prepare is not yet ready', () => {
    expect(
      computeLoadPhase({
        prepareStatus: 'preparing',
        prepareLoadPhase: 'indexing',
        viewerLoadPhase: 'loading',
        hasManifest: false,
      })
    ).toBe('indexing');

    expect(
      computeLoadPhase({
        prepareStatus: 'preparing',
        prepareLoadPhase: 'opening',
        viewerLoadPhase: 'loading',
        hasManifest: true,
      })
    ).toBe('opening');
  });

  it('forwards prepare errors verbatim', () => {
    expect(
      computeLoadPhase({
        prepareStatus: 'error',
        prepareLoadPhase: 'indexing',
        viewerLoadPhase: 'loading',
        hasManifest: false,
      })
    ).toBe('error');
  });

  it('switches to loading-data once prepare is ready and viewer is still loading', () => {
    expect(
      computeLoadPhase({
        prepareStatus: 'ready',
        prepareLoadPhase: 'opening',
        viewerLoadPhase: 'loading',
        hasManifest: true,
      })
    ).toBe('loading-data');
  });

  it('forwards viewer errors after prepare succeeds', () => {
    expect(
      computeLoadPhase({
        prepareStatus: 'ready',
        prepareLoadPhase: 'opening',
        viewerLoadPhase: 'error',
        hasManifest: true,
      })
    ).toBe('error');
  });

  it('reports ready when both prepare and viewer have finished', () => {
    expect(
      computeLoadPhase({
        prepareStatus: 'ready',
        prepareLoadPhase: 'opening',
        viewerLoadPhase: 'ready',
        hasManifest: true,
      })
    ).toBe('ready');
  });

  it('does NOT claim ready if hasManifest is false even when prepareStatus is ready', () => {
    expect(
      computeLoadPhase({
        prepareStatus: 'ready',
        prepareLoadPhase: 'opening',
        viewerLoadPhase: 'ready',
        hasManifest: false,
      })
    ).toBe('opening');
  });
});

describe('IndexedGenomeTab loading screen — phase transitions', () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    mockCanvasGetContext.mockReset();
    mockCanvasGetContext.mockReturnValue(canvasContext);
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: mockCanvasGetContext,
    });
    workspaceState.path = '/workspace';
    workspaceState.loading = false;
    mockInit.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetFeatures.mockReset();
    mockGetFeatureDetailsByManifest.mockReset();
    mockGetSession.mockReset();
    mockGetAssemblyOverview.mockReset();
    mockSearchAssemblySequence.mockReset();
    mockOpen.mockReset();
    mockUpgradeSessionCapabilities.mockReset().mockImplementation(async (_sessionId, source) => {
      const shell = readySessionUpdate().shell;
      return source.intent.kind === 'reference-assembly'
        ? {
            ...shell,
            assemblyAnnotationProductsReadiness: source.intent.annotationProductsReadiness,
            assemblySearchReadiness: source.intent.searchReadiness,
            assemblyAssetGeneration: source.intent.assetGeneration,
            assemblySearchSource: source.intent.searchSource,
          }
        : shell;
    });
    mockCloseSession.mockReset();
    mockOn.mockReset();
    mockExists.mockReset();
    mockReadAssemblyOverviewFeatures.mockReset();
    mockReadAssemblyAnnotationRasterV2.mockReset();
    mockReadAssemblyAnnotationScene.mockReset();
    mockReadAssemblyAnnotationProductSetInventory.mockReset();
    mockWriteAssemblyOverviewFeatures.mockReset();
    mockWriteAssemblyOverviewTexture.mockReset();
    mockHasPreparedPrepackedScene.mockReset();
    mockHasPreparedPrepackedScene.mockReturnValue(false);
    mockListLocalReferences.mockReset().mockResolvedValue([]);
    mockGetLocalPreparationStatus.mockReset().mockResolvedValue(null);
    mockRetryLocalReference.mockReset();
    mockListHostedReferences.mockReset().mockResolvedValue([]);
    mockInstallHostedReference.mockReset();
    mockGetHostedPreparationStatus.mockReset().mockResolvedValue(null);
    mockOnReferencePreparationProgress.mockReset();
    mockOnHostedInstallProgress.mockReset();
    mockReferenceAssetCacheRoot.mockReset().mockResolvedValue('/reference-assets');
    mockReadTextFile.mockReset().mockRejectedValue(new Error('No current publication'));
    mockReadDir.mockReset().mockResolvedValue([]);
    emitReferencePreparationProgress.mockReset();
    emitHostedInstallProgress.mockReset();
    let referencePreparationProgressListener: ((progress: unknown) => void) | null = null;
    mockOnReferencePreparationProgress.mockImplementation(
      (callback: (progress: unknown) => void) => {
        referencePreparationProgressListener = callback;
        return () => {
          if (referencePreparationProgressListener === callback) {
            referencePreparationProgressListener = null;
          }
        };
      }
    );
    emitReferencePreparationProgress.mockImplementation((progress: unknown) => {
      referencePreparationProgressListener?.(progress);
    });
    let hostedInstallProgressListener: ((progress: unknown) => void) | null = null;
    mockOnHostedInstallProgress.mockImplementation((callback: (progress: unknown) => void) => {
      hostedInstallProgressListener = callback;
      return () => {
        if (hostedInstallProgressListener === callback) hostedInstallProgressListener = null;
      };
    });
    emitHostedInstallProgress.mockImplementation((progress: unknown) => {
      hostedInstallProgressListener?.(progress);
    });
    viewerState.props = null;
    viewerState.autoReady = true;
    resetIndexedLiveViewportForTests();
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
    mockReadAssemblyAnnotationRasterV2.mockResolvedValue(null);
    mockReadAssemblyAnnotationScene.mockResolvedValue(null);
    mockReadAssemblyAnnotationProductSetInventory.mockResolvedValue({
      status: 'ready',
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'b'.repeat(64),
      trackTypes: ['mRNA'],
    });
    mockReadAssemblyOverviewFeatures.mockResolvedValue(null);
    mockGetAssemblyOverview.mockResolvedValue({
      hits: 2,
      misses: 0,
      byChrom: {
        chr11: {
          chrom: 'chr11',
          cacheState: 'hit',
          layerTypes: ['gene', 'mRNA'],
          features: [],
        },
        chr12: {
          chrom: 'chr12',
          cacheState: 'hit',
          layerTypes: ['gene', 'mRNA'],
          features: [],
        },
      },
    });
    mockSearchAssemblySequence.mockResolvedValue({
      hits: [],
      truncated: false,
    });
    mockWriteAssemblyOverviewFeatures.mockResolvedValue(null);
    mockWriteAssemblyOverviewTexture.mockResolvedValue(null);
    mockOpen.mockImplementation(async (source) => {
      if (source.intent?.kind === 'internal-assembly-segment') {
        return {
          sessionId: `internal-${source.chrom}`,
          sourcePath: source.sourcePath,
          sourceFingerprint: `fingerprint-${source.chrom}`,
          chrom: source.chrom,
          openReady: true,
          coordinateReady: true,
          length: source.manifest?.length,
          manifest: source.manifest,
          validationState: 'strong_match',
          openedAt: 1,
          tracks: [],
        };
      }
      return {
        sessionId: 'session-chr11',
        sourcePath: '/workspace/chr11.gbff',
        sourceFingerprint: 'fingerprint-chr11',
        chrom: 'chr11',
        sourceSizeBytes: 140 * 1024 * 1024,
        openReady: false,
        coordinateReady: false,
        validationState: 'metadata_match',
        openedAt: 1,
        tracks: [
          {
            id: 'chr11:sequence',
            kind: 'sequence',
            label: 'Sequence',
            state: 'metadata_pending',
            userState: 'Preparing',
          },
          {
            id: 'chr11:annotations',
            kind: 'annotation',
            label: 'Annotations',
            state: 'building_cache',
            userState: 'Updating',
          },
        ],
      };
    });
    mockCloseSession.mockResolvedValue(undefined);
    mockGetSession.mockResolvedValue({
      sessionId: 'session-chr11',
      sourcePath: '/workspace/chr11.gbff',
      sourceFingerprint: 'fingerprint-chr11',
      chrom: 'chr11',
      sourceSizeBytes: 140 * 1024 * 1024,
      coordinateReady: false,
      validationState: 'metadata_match',
      openedAt: 1,
      tracks: [
        {
          id: 'chr11:sequence',
          kind: 'sequence',
          label: 'Sequence',
          state: 'metadata_pending',
          userState: 'Preparing',
        },
        {
          id: 'chr11:annotations',
          kind: 'annotation',
          label: 'Annotations',
          state: 'building_cache',
          userState: 'Updating',
        },
      ],
    });
    mockExists.mockResolvedValue(true);
  });

  it('shows the "Indexing" headline + caveat when sidecar is building from scratch', async () => {
    const tab = freshIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    const screenEl = await screen.findByTestId('indexed-genome-loading');
    expect(screenEl.dataset.loadPhase).toBe('indexing');
    expect(screen.getByText('Indexing chr11')).toBeInTheDocument();
    expect(screen.getByText(/first-time indexing can take/i)).toBeInTheDocument();
  });

  it('clears the preparation status after native open refuses the source', async () => {
    const pending = createDeferred<GenomeSessionShell>();
    mockOpen.mockReturnValueOnce(pending.promise);
    const tab = freshIndexedTab();
    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() => expect(mockOpen).toHaveBeenCalledOnce());
    expect(screen.getByText('Preparing index')).toBeInTheDocument();
    await act(async () => {
      pending.reject(new Error('The source is missing'));
    });

    expect(screen.getByTestId('indexed-genome-loading')).toHaveAttribute(
      'data-load-phase',
      'error'
    );
    expect(screen.getByText("Couldn't open chr11")).toBeInTheDocument();
    expect(screen.queryByText('Preparing index')).not.toBeInTheDocument();
  });

  it('turns an indexed renderer selection into copy, translation, and annotation actions', async () => {
    const tab = reopenIndexedTab();
    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => expect(viewerState.props).not.toBeNull());

    const onContextMenu = viewerState.props?.onContextMenu as
      | ((event: MouseEvent, context: Record<string, unknown>) => void)
      | undefined;
    expect(onContextMenu).toBeTypeOf('function');
    act(() => {
      onContextMenu?.(new MouseEvent('contextmenu', { clientX: 40, clientY: 60 }), {
        position: 12,
        featureId: null,
        orf: null,
        hitResult: null,
        highlightRange: [10, 14],
      });
    });

    const menu = await screen.findByTestId('sequence-context-menu');
    expect(menu).toHaveTextContent('Copy Sequence');
    expect(menu).toHaveTextContent('Copy Sequence (Reverse Complement)');
    expect(menu).toHaveTextContent('Copy Translation');
    expect(menu).toHaveTextContent('Add Annotation');

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Add Annotation' }));
    expect(await screen.findByTestId('indexed-annotation-dialog')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('add-name-input'), {
      target: { value: 'reviewed locus' },
    });
    fireEvent.click(screen.getByTestId('add-save-button'));

    const found = useCanvasStore.getState().findTab('sequence', tab.entityId);
    const stored = found
      ? useCanvasStore
          .getState()
          .panels[found.panelId]?.tabs.find((candidate) => candidate.id === found.tabId)
      : undefined;
    expect(stored?.indexedGenome?.userAnnotations).toEqual([
      expect.objectContaining({
        chrom: 'chr11',
        annotation: expect.objectContaining({
          name: 'reviewed locus',
          start: 11,
          end: 15,
        }),
      }),
    ]);
    await waitFor(() =>
      expect(viewerState.props?.userAnnotationDataset).toMatchObject({
        label: 'User annotations',
        records: [expect.objectContaining({ start: 10, end: 15 })],
      })
    );

    const openOverlayMenu = () => {
      const currentHandler = viewerState.props?.onContextMenu as
        | ((event: MouseEvent, context: Record<string, unknown>) => void)
        | undefined;
      act(() => {
        currentHandler?.(new MouseEvent('contextmenu'), {
          position: 12,
          featureId: null,
          orf: null,
          hitResult: null,
          highlightRange: null,
        });
      });
    };
    openOverlayMenu();
    fireEvent.mouseDown(await screen.findByRole('button', { name: 'Edit Annotation' }));
    fireEvent.change(screen.getByTestId('edit-name-input'), {
      target: { value: 'renamed locus' },
    });
    fireEvent.click(screen.getByTestId('edit-save-button'));
    await waitFor(() => {
      const location = useCanvasStore.getState().findTab('sequence', tab.entityId);
      const current = location
        ? useCanvasStore
            .getState()
            .panels[location.panelId]?.tabs.find((candidate) => candidate.id === location.tabId)
        : undefined;
      expect(current?.indexedGenome?.userAnnotations?.[0]?.annotation.name).toBe('renamed locus');
    });

    openOverlayMenu();
    fireEvent.mouseDown(await screen.findByRole('button', { name: 'Delete Annotation' }));
    await waitFor(() => {
      const location = useCanvasStore.getState().findTab('sequence', tab.entityId);
      const current = location
        ? useCanvasStore
            .getState()
            .panels[location.panelId]?.tabs.find((candidate) => candidate.id === location.tabId)
        : undefined;
      expect(current?.indexedGenome?.userAnnotations).toEqual([]);
    });
  });

  it('reads only the selected indexed interval before copying it', async () => {
    const tab = reopenIndexedTab();
    mockInit.mockResolvedValue({ length: tab.indexedGenome?.manifest?.length });
    mockGetSequence.mockResolvedValue('AACCG');
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    });
    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => expect(viewerState.props).not.toBeNull());

    const onContextMenu = viewerState.props?.onContextMenu as
      | ((event: MouseEvent, context: Record<string, unknown>) => void)
      | undefined;
    act(() => {
      onContextMenu?.(new MouseEvent('contextmenu'), {
        position: 12,
        featureId: null,
        orf: null,
        hitResult: null,
        highlightRange: [10, 14],
      });
    });
    fireEvent.mouseDown(await screen.findByRole('button', { name: 'Copy Sequence' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('AACCG'));
    expect(mockGetSequence).toHaveBeenCalledWith(
      expect.objectContaining({ chrom: 'chr11' }),
      'chr11',
      10,
      15
    );

    writeText.mockClear();
    mockGetSequence.mockClear();
    mockGetSequence.mockResolvedValue('TTGCA');
    const onSelectionChange = viewerState.props?.onSelectionChange as
      | ((start: number, end: number) => void)
      | undefined;
    act(() => onSelectionChange?.(20, 24));
    const commandModifierKey = isApplePlatform() ? 'metaKey' : 'ctrlKey';
    fireEvent.keyDown(document, { key: 'c', [commandModifierKey]: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('TTGCA'));
    expect(mockGetSequence).toHaveBeenCalledWith(
      expect.objectContaining({ chrom: 'chr11' }),
      'chr11',
      20,
      25
    );

    writeText.mockClear();
    const onSelectionClear = viewerState.props?.onSelectionClear as (() => void) | undefined;
    act(() => onSelectionClear?.());
    fireEvent.keyDown(document, { key: 'c', [commandModifierKey]: true });
    await act(async () => Promise.resolve());
    expect(writeText).not.toHaveBeenCalled();
  });

  it('runs phase-aware spliced translation for a clicked indexed CDS', async () => {
    const tab = reopenIndexedTab();
    const transcript = {
      chrom: 'chr11',
      source: 'test',
      type: 'mRNA',
      start: 10,
      end: 19,
      score: null,
      strand: '+',
      phase: null,
      attributes: { ID: ['tx-1'], Name: ['tx-one'] },
      raw: '',
    };
    const cds = {
      ...transcript,
      type: 'CDS',
      phase: '0',
      attributes: { ID: ['cds-1'], Parent: ['tx-1'] },
    };
    mockInit.mockResolvedValue({ length: tab.indexedGenome?.manifest?.length });
    mockGetFeatures.mockResolvedValue([transcript, cds]);
    mockGetFeatureDetailsByManifest.mockResolvedValue({
      chrom: 'chr11',
      featureId: 'tx-1',
      feature: transcript,
      relatedFeatures: [cds],
      sourceRecordCount: 2,
      window: { start: 10, end: 19 },
      truncated: false,
    });
    mockGetSequence.mockResolvedValue('ATG'.repeat(3));
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => expect(viewerState.props).not.toBeNull());

    const openCdsMenu = () => {
      const handler = viewerState.props?.onContextMenu as
        | ((event: MouseEvent, context: Record<string, unknown>) => void)
        | undefined;
      act(() => {
        handler?.(new MouseEvent('contextmenu'), {
          position: 14,
          featureId: 7,
          orf: null,
          hitResult: {
            kind: 'feature',
            payload: {
              id: 7,
              start: 10,
              end: 19,
              displayName: 'tx-one',
              type: 'mRNA',
              transcriptId: 'tx-1',
              direction: 'forward',
            },
          },
          highlightRange: null,
        });
      });
    };

    openCdsMenu();
    fireEvent.mouseDown(await screen.findByRole('button', { name: /Copy CDS Translation/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('MMM'));
    expect(mockGetFeatureDetailsByManifest).toHaveBeenCalledWith(
      expect.objectContaining({ chrom: 'chr11' }),
      expect.objectContaining({ chrom: 'chr11', featureId: 'tx-1', start: 10, end: 19 })
    );

    openCdsMenu();
    fireEvent.mouseDown(await screen.findByRole('button', { name: /Create amino acid sequence/ }));
    const proteinDialog = await screen.findByTestId('create-amino-acid-sequence-dialog');
    expect(proteinDialog).toHaveTextContent('MMM');
    await waitFor(() =>
      expect(screen.getByTestId('create-amino-acid-sequence-name')).toHaveValue('tx-one')
    );
  });

  it('copies spliced transcript DNA/RNA and lets the user target a sibling isoform', async () => {
    const tab = reopenIndexedTab();
    const gene = {
      chrom: 'chr11',
      source: 'test',
      type: 'gene',
      start: 10,
      end: 22,
      score: null,
      strand: '+',
      phase: null,
      attributes: { ID: ['gene-1'], Name: ['GENE1'] },
      raw: '',
    };
    const transcriptOne = {
      ...gene,
      type: 'mRNA',
      end: 19,
      attributes: { ID: ['tx-1'], Parent: ['gene-1'], Name: ['Isoform 1'] },
    };
    const transcriptTwo = {
      ...gene,
      type: 'mRNA',
      start: 11,
      end: 20,
      attributes: { ID: ['tx-2'], Parent: ['gene-1'], Name: ['Isoform 2'] },
    };
    const exon = (id: string, parent: string, start: number, end: number) => ({
      ...gene,
      type: 'exon',
      start,
      end,
      attributes: { ID: [id], Parent: [parent] },
    });
    const tx1Exons = [exon('tx1-exon-1', 'tx-1', 10, 13), exon('tx1-exon-2', 'tx-1', 16, 19)];
    const tx2Exons = [exon('tx2-exon-1', 'tx-2', 11, 14), exon('tx2-exon-2', 'tx-2', 17, 20)];

    mockInit.mockResolvedValue({ length: tab.indexedGenome?.manifest?.length });
    mockGetFeatureDetailsByManifest.mockImplementation(
      async (_manifest, request: { featureId?: string }) =>
        request.featureId === 'tx-2'
          ? {
              chrom: 'chr11',
              featureId: 'tx-2',
              feature: transcriptTwo,
              relatedFeatures: [gene, transcriptOne, ...tx2Exons],
              sourceRecordCount: 5,
              window: { start: 10, end: 22 },
              truncated: false,
            }
          : {
              chrom: 'chr11',
              featureId: 'tx-1',
              feature: transcriptOne,
              relatedFeatures: [gene, transcriptTwo, ...tx1Exons],
              sourceRecordCount: 5,
              window: { start: 10, end: 22 },
              truncated: false,
            }
    );
    mockGetSequence.mockImplementation(
      async (_manifest, _chrom: string, start: number, end: number) => {
        const sequences = new Map([
          ['10:13', 'ATG'],
          ['16:19', 'TTA'],
          ['11:14', 'TTC'],
          ['17:20', 'GAT'],
        ]);
        return sequences.get(`${start}:${end}`) ?? '';
      }
    );
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => expect(viewerState.props).not.toBeNull());

    const openTranscriptMenu = () => {
      const handler = viewerState.props?.onContextMenu as
        | ((event: MouseEvent, context: Record<string, unknown>) => void)
        | undefined;
      act(() => {
        handler?.(new MouseEvent('contextmenu'), {
          position: 14,
          featureId: 7,
          orf: null,
          hitResult: {
            kind: 'feature',
            payload: {
              id: 7,
              start: 10,
              end: 19,
              displayName: 'Isoform 1',
              type: 'mRNA',
              transcriptId: 'tx-1',
              direction: 'forward',
            },
          },
          highlightRange: null,
        });
      });
    };

    openTranscriptMenu();
    fireEvent.mouseDown(await screen.findByRole('button', { name: /Copy transcript DNA/ }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('ATGTTA'));

    openTranscriptMenu();
    fireEvent.mouseDown(await screen.findByRole('button', { name: /Copy transcript RNA/ }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('AUGUUA'));

    openTranscriptMenu();
    fireEvent.mouseDown(await screen.findByRole('button', { name: /Choose isoform/ }));
    const sibling = await screen.findByRole('radio', { name: /Isoform 2/ });
    fireEvent.click(sibling);
    fireEvent.click(screen.getByRole('button', { name: 'Copy RNA' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('UUCGAU'));

    expect(mockGetSequence).toHaveBeenCalledWith(
      expect.objectContaining({ chrom: 'chr11' }),
      'chr11',
      10,
      13
    );
    expect(mockGetSequence).toHaveBeenCalledWith(
      expect.objectContaining({ chrom: 'chr11' }),
      'chr11',
      16,
      19
    );
    expect(mockGetSequence).not.toHaveBeenCalledWith(expect.anything(), 'chr11', 10, 19);
  });

  it('admits an inactive indexed tab on first selection and keeps its session while hidden', async () => {
    const tab = freshIndexedTab();
    resetCanvasStore(tab);
    const { rerender, unmount } = render(<IndexedGenomeTab tab={tab} isActive={false} />);

    expect(mockOpen).not.toHaveBeenCalled();
    rerender(<IndexedGenomeTab tab={tab} isActive />);
    await waitFor(() => expect(mockOpen).toHaveBeenCalledOnce());
    await waitFor(() => {
      expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
        'data-session-id',
        'session-chr11'
      );
    });

    rerender(<IndexedGenomeTab tab={tab} isActive={false} />);
    expect(mockCloseSession).not.toHaveBeenCalled();
    rerender(<IndexedGenomeTab tab={tab} isActive />);
    expect(mockOpen).toHaveBeenCalledOnce();

    unmount();
    await waitFor(() => expect(mockCloseSession).toHaveBeenCalledExactlyOnceWith('session-chr11'));
  });

  it('releases the main-process session when its tab unmounts', async () => {
    const tab = freshIndexedTab();

    resetCanvasStore(tab);
    const { unmount } = render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => expect(mockOpen).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId('indexed-genome-loading')).toBeInTheDocument());

    unmount();

    await waitFor(() => expect(mockCloseSession).toHaveBeenCalledWith('session-chr11'));
  });

  it('releases a session whose open finishes after its tab already unmounted', async () => {
    const deferred = createDeferred<GenomeSessionShell>();
    mockOpen.mockReturnValueOnce(deferred.promise);
    const tab = freshIndexedTab();

    resetCanvasStore(tab);
    const { unmount } = render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => expect(mockOpen).toHaveBeenCalledOnce());
    unmount();

    deferred.resolve({
      sessionId: 'session-late',
      sourcePath: '/workspace/chr11.gbff',
      sourceFingerprint: 'fingerprint-late',
      chrom: 'chr11',
      sourceSizeBytes: 140 * 1024 * 1024,
      openReady: false,
      coordinateReady: false,
      validationState: 'metadata_match',
      openedAt: 1,
      tracks: [],
    });

    await waitFor(() => expect(mockCloseSession).toHaveBeenCalledWith('session-late'));
  });

  it('keeps one compact genome toolbar row and omits redundant controls', () => {
    const tab = freshAssemblyIndexedTab();

    resetCanvasStore(tab);
    const { unmount } = render(<IndexedGenomeTab tab={tab} />);

    const toolbar = screen.getByTestId('indexed-genome-toolbar');
    expect(toolbar).toHaveClass('items-center');
    expect(toolbar).not.toHaveClass('flex-col', 'flex-wrap', 'overflow-x-auto');
    const toolbarScroller = screen.getByTestId('indexed-genome-toolbar-scroll');
    expect(toolbarScroller).toHaveClass('overflow-x-auto');
    const trackViewActions = screen.getByRole('button', { name: 'Track view actions' });
    expect(toolbarScroller).not.toContainElement(trackViewActions);
    expect(toolbar).toContainElement(trackViewActions);
    expect(screen.getByTestId('indexed-genome-toolbar-surface')).toHaveClass('bg-bg');
    expect(screen.getByTestId('indexed-genome-toolbar-surface')).not.toHaveClass('bg-bg-subtle');
    expect(screen.getByRole('heading', { name: 'GRCh38 (human)' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'GRCh38 (human)' })).not.toHaveTextContent(
      'Indexed'
    );
    expect(screen.getByLabelText('Go to coordinate')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Go to entered coordinate' })).toBeVisible();
    expect(screen.getByLabelText('Window size')).toHaveClass('sr-only');
    expect(screen.queryByLabelText('Visible coordinates and span')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Go' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous window' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next window' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reload range' })).toBeNull();
    expect(screen.queryByTestId('open-mutation-navigator')).toBeNull();
    expect(screen.queryByTestId('indexed-genome-length-state')).toBeNull();
    expect(screen.getByTestId('indexed-genome-identity')).toHaveClass('sr-only');
    expect(screen.getByTestId('indexed-genome-identity')).toHaveTextContent('Indexed');
    expect(screen.getByTestId('indexed-genome-annotation-count')).toHaveClass('sr-only');
    unmount();
  });

  it('places selected annotation details in the toolbar without adding another row', async () => {
    const tab = assemblyIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);
    await waitFor(() => expect(viewerState.props).not.toBeNull());

    act(() => {
      const publishFeatureDetails = viewerState.props?.onFeatureDetailsStateChange as
        | ((state: unknown) => void)
        | undefined;
      publishFeatureDetails?.({
        kind: 'ready',
        annotation: {
          id: 'feat-1',
          name: 'BRCA1',
          type: 'mRNA',
          chrom: 'chr17',
          start: 100,
          end: 200,
        },
        details: {
          feature: {
            id: 'feat-1',
            type: 'mRNA',
            start: 100,
            end: 200,
            attributes: { ID: ['NM_007294'] },
          },
          featureId: 'feat-1',
          relatedFeatures: [{}, {}],
          window: { start: 43_044_294, end: 43_125_483 },
          truncated: false,
        },
      });
    });

    const toolbar = screen.getByTestId('indexed-genome-toolbar');
    const inspector = await screen.findByTestId('indexed-genome-feature-inspector');
    expect(toolbar).toContainElement(inspector);
    expect(inspector).toHaveClass('ml-auto', 'min-w-48', 'shrink-0', 'justify-end');
    expect(inspector).not.toHaveClass('absolute', 'rounded-md', 'border', 'shadow-sm');
    expect(screen.getByTestId('indexed-genome-runtime-area')).not.toContainElement(inspector);
  });

  it('labels a single source size as bytes on disk, not genomic span', async () => {
    const tab = freshIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await screen.findByTestId('indexed-genome-loading');
    expect(
      screen.getByText('chr11.gbff · 140.0 MB on disk — first-time indexing can take a few minutes')
    ).toBeInTheDocument();
    expect(screen.queryByText(/140\.0 Mb genomic span/)).not.toBeInTheDocument();
  });

  it('shows a whole-assembly genomic span instead of the anchor source file size', async () => {
    const tab = freshAssemblyIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await screen.findByTestId('indexed-genome-loading');
    expect(
      screen.getByText(
        'GRCh38 (human) · 3.09 Gb genomic span · 24 chromosomes — first-time indexing can take a few minutes'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/6\.7 MB/)).not.toBeInTheDocument();
  });

  it('presents the coordinate shell without waiting for the committed product inventory', async () => {
    const tab = assemblyIndexedTab();
    const unresolvedFullPreparation = createDeferred<never>();
    mockReadAssemblyAnnotationProductSetInventory.mockReturnValue(
      unresolvedFullPreparation.promise
    );

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() =>
      expect(mockReadAssemblyAnnotationProductSetInventory.mock.calls.length).toBeGreaterThan(0)
    );
    expect(mockReadAssemblyAnnotationScene).not.toHaveBeenCalled();
    expect(screen.getByTestId('indexed-genome-viewer-mock')).toBeInTheDocument();
  });

  it('opens an authenticated portable view without waiting on the ordinary product inventory', async () => {
    const tab = assemblyIndexedTab();
    const portableBundleFingerprint = 'f'.repeat(64);
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblySourceReadiness: 'ready',
      assemblyAnnotationProductsReadiness: 'ready',
      assemblySearchReadiness: 'pending',
      assemblyPortableBundleFingerprint: portableBundleFingerprint,
      assemblyAnnotationTrackTypes: ['enhancer', 'mRNA'],
    };
    const unresolvedOrdinaryInventory = createDeferred<never>();
    mockReadAssemblyAnnotationProductSetInventory.mockReturnValue(
      unresolvedOrdinaryInventory.promise
    );
    mockListHostedReferences.mockResolvedValue([grch38HostedCatalogEntry()]);
    mockInstallHostedReference.mockReturnValue(createDeferred<never>().promise);

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() =>
      expect(
        mockOpen.mock.calls.filter(([source]) => source.intent?.kind === 'reference-assembly')
      ).toHaveLength(1)
    );
    expect(mockReadAssemblyAnnotationProductSetInventory).not.toHaveBeenCalled();
    expect(mockOpen.mock.calls[0]?.[0].intent).toMatchObject({
      annotationProductsReadiness: 'ready',
      searchReadiness: 'pending',
    });

    await waitForSessionSubscription();
    const {
      assemblyPortableBundleFingerprint: _omittedPortableBundleFingerprint,
      ...sessionTabState
    } = tab.indexedGenome;
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(sessionTabState));
    });

    await waitFor(() => {
      const persisted = useCanvasStore.getState().findTab('sequence', tab.entityId);
      expect(
        persisted
          ? useCanvasStore
              .getState()
              .panels[persisted.panelId]?.tabs.find((candidate) => candidate.id === persisted.tabId)
              ?.indexedGenome?.assemblyPortableBundleFingerprint
          : null
      ).toBe(portableBundleFingerprint);
    });
  });

  it('opens the source-backed session with presentation and search pending when products are unavailable', async () => {
    const tab = assemblyIndexedTab();
    mockReadAssemblyAnnotationProductSetInventory.mockResolvedValue({ status: 'unavailable' });
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
    };

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() =>
      expect(
        mockOpen.mock.calls.filter(([source]) => source.intent?.kind === 'reference-assembly')
      ).toHaveLength(1)
    );
    const [source] = mockOpen.mock.calls.find(
      ([candidate]) => candidate.intent?.kind === 'reference-assembly'
    )!;
    expect(source.intent).toMatchObject({
      annotationProductsReadiness: 'pending',
      searchReadiness: 'pending',
    });
    expect(
      screen.queryByText('Failed to prepare assembly annotation indexes.')
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-assembly-search-readiness',
      'pending'
    );
    expect(mockReadAssemblyAnnotationProductSetInventory.mock.calls.length).toBeGreaterThan(0);
    expect(mockReadAssemblyAnnotationScene).not.toHaveBeenCalled();
  });

  it('opens a sequence-only assembly, exposes DNA search, and never starts annotation work', async () => {
    const tab = sequenceOnlyAssemblyIndexedTab();
    mockOpen.mockImplementation(async (source) => ({
      sessionId: 'session-sequence-only',
      sourcePath: source.sourcePath,
      sourceFingerprint: 'fingerprint-sequence-only',
      chrom: source.chrom,
      openReady: false,
      coordinateReady: false,
      manifest: source.manifest,
      validationState: 'metadata_match',
      openedAt: 1,
      assemblyAnnotationProductsReadiness: 'not-applicable',
      assemblySearchReadiness: 'not-applicable',
      tracks: [],
    }));

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() =>
      expect(
        mockOpen.mock.calls.filter(([source]) => source.intent?.kind === 'reference-assembly')
      ).toHaveLength(1)
    );
    const [source] = mockOpen.mock.calls.find(
      ([candidate]) => candidate.intent?.kind === 'reference-assembly'
    )!;
    expect(source).toMatchObject({
      sourcePath: '/workspace/prepared/contig-1/contig-1.fa',
      sourceExt: 'fa',
      manifest: {
        gffPath: null,
        tbiPath: null,
      },
      intent: {
        annotationProductsReadiness: 'not-applicable',
        searchReadiness: 'not-applicable',
      },
    });

    act(() => {
      emitPlatformEvent('genome:sessionUpdated', {
        sessionId: 'session-sequence-only',
        prepareStatus: 'ready',
        prepareLoadPhase: 'opening',
        reusedExistingIndex: true,
        shell: {
          sessionId: 'session-sequence-only',
          sourcePath: source.sourcePath,
          sourceFingerprint: 'fingerprint-sequence-only',
          chrom: source.chrom,
          openReady: true,
          coordinateReady: true,
          length: 12_345,
          manifest: source.manifest,
          validationState: 'strong_match',
          openedAt: 1,
          assemblyAnnotationProductsReadiness: 'not-applicable',
          assemblySearchReadiness: 'not-applicable',
          tracks: [
            {
              id: 'contig-1:sequence',
              kind: 'sequence',
              label: 'Sequence',
              state: 'coordinate_ready',
              userState: 'Showing overview',
            },
          ],
        },
        tabState: tab.indexedGenome,
      });
    });

    const root = await screen.findByTestId('indexed-genome-tab');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Find DNA sequence' })).toBeEnabled()
    );
    expect(root).toHaveAttribute('data-assembly-annotation-products-readiness', 'not-applicable');
    expect(root).toHaveAttribute('data-assembly-search-readiness', 'not-applicable');
    expect(viewerState.props?.annotationProductPublicationReady).toBe(true);
    expect(screen.getByTestId('indexed-genome-annotation-count')).toHaveClass('sr-only');
    expect(screen.getByTestId('indexed-genome-annotation-count')).toHaveAttribute(
      'data-count-state',
      'not-applicable'
    );
    expect(screen.getByTestId('indexed-genome-annotation-count')).toHaveTextContent(
      'No annotations'
    );
    expect(screen.getByTestId('indexed-genome-search-readiness')).toHaveClass('sr-only');
    expect(screen.getByTestId('indexed-genome-search-readiness')).toHaveTextContent(
      'Annotations not included'
    );
    expect(mockReadAssemblyAnnotationProductSetInventory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Find DNA sequence' }));
    expect(screen.getByRole('button', { name: 'Search mode: DNA bases' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Search pattern'), { target: { value: 'ACGT' } });
    await waitFor(() => expect(mockSearchAssemblySequence).toHaveBeenCalledTimes(1));
  });

  it('keeps an empty catalog shell accessible while its reference and initial frame are pending', async () => {
    viewerState.autoReady = false;
    const tab = assemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblySourceReadiness: 'pending',
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
    };

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await screen.findByTestId('indexed-genome-viewer-mock');
    expect(useLaneContractStore.getState().lanesForOwner(tab.id)).toHaveLength(0);
    expect(screen.queryByTestId('indexed-genome-loading')).not.toBeInTheDocument();
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-assembly-source-readiness',
      'pending'
    );
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-coordinate-ready',
      'false'
    );
    expect(mockOpen).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Find sequence or annotations' })).toBeDisabled();
  });

  it('renders an ideogram-only assembly without opening a genome session', async () => {
    const tab = assemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblySourceReadiness: 'pending',
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
    };

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    expect(await screen.findByTestId('indexed-genome-viewer-mock')).toBeInTheDocument();
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockReadAssemblyAnnotationProductSetInventory).not.toHaveBeenCalled();
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-assembly-source-readiness',
      'pending'
    );
    await waitFor(() => {
      expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
        'data-coordinate-ready',
        'false'
      );
    });
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute('data-validation-state', '');
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-length-state',
      'length_unknown'
    );
    expect(screen.queryByTestId('indexed-genome-length-state')).toBeNull();
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute('data-session-id', '');
    expect(screen.getByRole('button', { name: 'Go to entered coordinate' })).toBeEnabled();
    expect(screen.getByTestId('indexed-genome-annotation-count')).toHaveAttribute(
      'data-count-state',
      'pending'
    );
    expect(screen.getByRole('button', { name: 'Find sequence or annotations' })).toBeDisabled();
  });

  it('fails a legacy restored assembly with absent readiness to the shell and never opens an unvalidated stale path', async () => {
    const tab = freshAssemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      sourcePath: '/stale-generation/chr1.gff3.gz',
      assemblySourceReadiness: undefined,
      assemblyAnnotationProductsReadiness: undefined,
      assemblySearchReadiness: undefined,
    };
    const safeShell = grch38HostedShell();
    mockListHostedReferences.mockResolvedValue([grch38HostedCatalogEntry()]);
    mockInstallHostedReference.mockResolvedValue({
      status: 'view-ready',
      entry: safeShell,
    });
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: 'grch38',
        publicationId: 'current-generation',
        sourceMaterializationFingerprint: 'a'.repeat(64),
        publishedAtMs: 1,
      })
    );

    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId="assembly:grch38" />);

    expect(await screen.findByTestId('indexed-genome-viewer-mock')).toBeInTheDocument();
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-assembly-source-readiness',
      'pending'
    );
    expect(mockOpen).not.toHaveBeenCalled();

    await waitFor(() => {
      const current = useCanvasStore
        .getState()
        .panels.main.tabs.find((candidate) => candidate.entityId === 'assembly:grch38');
      expect(current?.id).toBe(tab.id);
      expect(current?.indexedGenome?.sourcePath).not.toBe('/stale-generation/chr1.gff3.gz');
      expect(current?.indexedGenome?.assemblySourceReadiness).toBe('pending');
    });
    expect(mockInstallHostedReference).toHaveBeenCalledWith({
      catalogId: 'grch38',
      themeMode: 'light',
      intent: 'open-view',
    });
    expect(
      mockOpen.mock.calls.some(([source]) => source.sourcePath === '/stale-generation/chr1.gff3.gz')
    ).toBe(false);
  });

  it('opens a legacy custom assembly through local admission without routing it into the hosted catalog', async () => {
    const tab = assemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblySourceReadiness: undefined,
      assemblyAnnotationProductsReadiness: undefined,
      assemblySearchReadiness: undefined,
    };

    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId="assembly:grch38-test" />);

    await waitFor(() =>
      expect(
        mockOpen.mock.calls.filter(([source]) => source.intent?.kind === 'reference-assembly')
      ).toHaveLength(1)
    );
    expect(mockListHostedReferences).toHaveBeenCalledTimes(1);
    expect(mockInstallHostedReference).not.toHaveBeenCalled();
    const [source] = mockOpen.mock.calls.find(
      ([candidate]) => candidate.intent?.kind === 'reference-assembly'
    )!;
    expect(source.sourcePath).toBe('/workspace/chr11.gbff');
  });

  it('upgrades a mounted local assembly when its background products publish ready', async () => {
    const tab = freshAssemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblySourceReadiness: 'ready',
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
    };
    const prepared = referenceAssemblyById('grch38');
    if (!prepared) throw new Error('Missing GRCh38 catalog fixture');
    let productsReady = false;
    mockListLocalReferences.mockResolvedValue([prepared]);
    mockGetLocalPreparationStatus.mockResolvedValue({
      assemblyId: 'grch38',
      status: 'preparing',
      phase: 'building-search',
      label: 'Building annotation and protein search',
      updatedAtMs: 1,
    });
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: prepared.assetCacheKey,
        publicationId: 'local-background-generation',
        sourceMaterializationFingerprint: 'c'.repeat(64),
        publishedAtMs: 4,
      })
    );
    mockReadAssemblyAnnotationProductSetInventory.mockImplementation(async () =>
      productsReady
        ? {
            status: 'ready',
            sourceFingerprint: 'a'.repeat(24),
            inventoryFingerprint: 'b'.repeat(64),
            trackTypes: ['mRNA'],
          }
        : { status: 'unavailable' }
    );

    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId="assembly:grch38" />);

    await waitFor(() => expect(mockOnReferencePreparationProgress).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        useCanvasStore
          .getState()
          .panels.main.tabs.find((candidate) => candidate.entityId === 'assembly:grch38')
          ?.indexedGenome
      ).toMatchObject({
        assemblyAnnotationProductsReadiness: 'pending',
        assemblySearchReadiness: 'pending',
      })
    );

    productsReady = true;
    act(() => {
      emitReferencePreparationProgress({
        operationId: 'local-grch38-import',
        assemblyId: 'grch38',
        phase: 'ready',
        label: 'GRCh38 is ready',
        completed: 1,
        total: 1,
      });
    });

    await waitFor(() =>
      expect(
        useCanvasStore
          .getState()
          .panels.main.tabs.find((candidate) => candidate.entityId === 'assembly:grch38')
          ?.indexedGenome
      ).toMatchObject({
        assemblySourceReadiness: 'ready',
        assemblyAnnotationProductsReadiness: 'ready',
        assemblySearchReadiness: 'ready',
      })
    );
    expect(mockInstallHostedReference).not.toHaveBeenCalled();
  });

  it('adopts a completed search upgrade after a tab projection changes during the request', async () => {
    const tab = assemblyIndexedTab();
    const upgrade = createDeferred<GenomeSessionShell>();
    mockUpgradeSessionCapabilities.mockReturnValue(upgrade.promise);
    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId={tab.entityId} />);

    await waitForSessionSubscription();
    const initialUpdate = readySessionUpdate(tab.indexedGenome!);
    const pendingShell: GenomeSessionShell = {
      ...initialUpdate.shell,
      assemblyAnnotationProductsReadiness: 'ready',
      assemblySearchReadiness: 'pending',
    };
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', { ...initialUpdate, shell: pendingShell });
    });
    await waitFor(() => expect(mockUpgradeSessionCapabilities).toHaveBeenCalledOnce());
    const [sessionId, source] = mockUpgradeSessionCapabilities.mock.calls[0]!;
    expect(sessionId).toBe('session-chr11');
    expect(source.intent.searchReadiness).toBe('ready');

    act(() => {
      const current = useCanvasStore
        .getState()
        .panels.main.tabs.find((candidate) => candidate.id === tab.id);
      if (!current?.indexedGenome) throw new Error('Missing indexed genome tab state');
      useCanvasStore.getState().updateTab('main', tab.id, {
        indexedGenome: {
          ...current.indexedGenome,
          assemblyAnnotationTrackTypes: ['mRNA'],
        },
      });
    });
    await act(async () => {
      upgrade.resolve({
        ...pendingShell,
        assemblySearchReadiness: 'ready',
        assemblyAssetGeneration: source.intent.assetGeneration,
        assemblySearchSource: source.intent.searchSource,
      });
      await upgrade.promise;
    });

    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-session-assembly-search-readiness',
      'ready'
    );
    expect(mockUpgradeSessionCapabilities).toHaveBeenCalledTimes(1);
  });

  it('keeps adopted search readiness when a stale pending session event arrives later', async () => {
    const tab = assemblyIndexedTab();
    const upgrade = createDeferred<GenomeSessionShell>();
    mockUpgradeSessionCapabilities.mockReturnValue(upgrade.promise);
    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId={tab.entityId} />);

    await waitForSessionSubscription();
    const initialUpdate = readySessionUpdate(tab.indexedGenome!);
    const pendingShell: GenomeSessionShell = {
      ...initialUpdate.shell,
      assemblyAnnotationProductsReadiness: 'ready',
      assemblySearchReadiness: 'pending',
    };
    const pendingUpdate = { ...initialUpdate, shell: pendingShell };
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', pendingUpdate);
    });
    await waitFor(() => expect(mockUpgradeSessionCapabilities).toHaveBeenCalledOnce());
    const [, source] = mockUpgradeSessionCapabilities.mock.calls[0]!;
    const readyShell: GenomeSessionShell = {
      ...pendingShell,
      assemblySearchReadiness: 'ready',
      assemblyAssetGeneration: source.intent.assetGeneration,
      assemblySearchSource: source.intent.searchSource,
    };
    await act(async () => {
      upgrade.resolve(readyShell);
      await upgrade.promise;
    });
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-session-assembly-search-readiness',
      'ready'
    );

    act(() => {
      emitPlatformEvent('genome:sessionUpdated', {
        ...pendingUpdate,
        shell: { ...pendingShell, assemblyAssetGeneration: source.intent.assetGeneration },
        prepareLoadPhase: 'opening',
      });
    });
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-session-assembly-search-readiness',
      'ready'
    );
  });

  it('adopts a ready generation published to the tab store while its prop is unchanged', async () => {
    const tab = assemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
    };
    mockReadAssemblyAnnotationProductSetInventory.mockResolvedValue({ status: 'unavailable' });
    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitForSessionSubscription();
    const openedSource = mockOpen.mock.calls.find(
      ([source]) => source.intent?.kind === 'reference-assembly'
    )?.[0];
    if (openedSource?.intent.kind !== 'reference-assembly' || !openedSource.intent.searchSource) {
      throw new Error('Missing prepared search request');
    }
    const initialUpdate = readySessionUpdate(tab.indexedGenome!);
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', {
        ...initialUpdate,
        shell: {
          ...initialUpdate.shell,
          assemblyAnnotationProductsReadiness: 'ready',
          assemblySearchReadiness: 'pending',
        },
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
        'data-session-assembly-search-readiness',
        'pending'
      )
    );
    act(() => {
      const current = useCanvasStore
        .getState()
        .panels.main.tabs.find((candidate) => candidate.id === tab.id);
      if (!current?.indexedGenome) throw new Error('Missing indexed genome tab state');
      useCanvasStore.getState().updateTab('main', tab.id, {
        indexedGenome: {
          ...current.indexedGenome,
          assemblyAnnotationProductsReadiness: 'ready',
          assemblySearchReadiness: 'ready',
          assemblySearchSource: openedSource.intent.searchSource,
          assemblyAssetGeneration: {
            contract: 'assembly-reference-asset-generation.v1',
            sourceFingerprint: 'a'.repeat(24),
            inventoryFingerprint: 'b'.repeat(64),
            themeMode: 'light',
          },
        },
      });
    });

    await waitFor(() => expect(mockUpgradeSessionCapabilities).toHaveBeenCalledOnce());
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-assembly-search-readiness',
      'ready'
    );
  });

  it('adopts durable local readiness when the terminal progress event is lost', async () => {
    const tab = freshAssemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblySourceReadiness: 'ready',
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
    };
    const prepared = referenceAssemblyById('grch38');
    if (!prepared) throw new Error('Missing GRCh38 catalog fixture');
    let productsReady = false;
    mockListLocalReferences.mockResolvedValue([prepared]);
    mockGetLocalPreparationStatus
      .mockResolvedValueOnce({
        assemblyId: 'grch38',
        status: 'preparing',
        phase: 'building-search',
        label: 'Building annotation and protein search',
        updatedAtMs: 1,
      })
      .mockImplementation(async () => {
        productsReady = true;
        return {
          assemblyId: 'grch38',
          status: 'ready',
          phase: 'ready',
          label: 'GRCh38 is ready',
          completed: 1,
          total: 1,
          updatedAtMs: 2,
        };
      });
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: prepared.assetCacheKey,
        publicationId: 'local-durable-ready-generation',
        sourceMaterializationFingerprint: 'c'.repeat(64),
        publishedAtMs: 5,
      })
    );
    mockReadAssemblyAnnotationProductSetInventory.mockImplementation(async () =>
      productsReady
        ? {
            status: 'ready',
            sourceFingerprint: 'a'.repeat(24),
            inventoryFingerprint: 'b'.repeat(64),
            trackTypes: ['mRNA'],
          }
        : { status: 'unavailable' }
    );

    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId="assembly:grch38" />);

    await waitFor(
      () =>
        expect(
          useCanvasStore
            .getState()
            .panels.main.tabs.find((candidate) => candidate.entityId === 'assembly:grch38')
            ?.indexedGenome
        ).toMatchObject({
          assemblySourceReadiness: 'ready',
          assemblyAnnotationProductsReadiness: 'ready',
          assemblySearchReadiness: 'ready',
        }),
      { timeout: 3_000 }
    );
    expect(mockGetLocalPreparationStatus.mock.calls.length).toBeGreaterThan(1);
    expect(mockInstallHostedReference).not.toHaveBeenCalled();
  });

  it('replays a local ready refresh that arrives while an earlier refresh is still running', async () => {
    const tab = freshAssemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblySourceReadiness: 'ready',
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
    };
    const prepared = referenceAssemblyById('grch38');
    if (!prepared) throw new Error('Missing GRCh38 catalog fixture');
    const publicationRead = createDeferred<string>();
    let publicationReleased = false;
    let refreshInventoryReads = 0;
    mockListLocalReferences.mockResolvedValue([prepared]);
    mockGetLocalPreparationStatus.mockResolvedValue({
      assemblyId: 'grch38',
      status: 'preparing',
      phase: 'building-search',
      label: 'Building annotation and protein search',
      updatedAtMs: 1,
    });
    mockReadTextFile.mockReturnValue(publicationRead.promise);
    const publication = JSON.stringify({
      contract: 'reference-asset-publication.v1',
      assetCacheKey: prepared.assetCacheKey,
      publicationId: 'local-overlap-generation',
      sourceMaterializationFingerprint: 'c'.repeat(64),
      publishedAtMs: 4,
    });
    mockReadAssemblyAnnotationProductSetInventory.mockImplementation(async () => {
      if (!publicationReleased) {
        return {
          status: 'ready',
          sourceFingerprint: 'a'.repeat(24),
          inventoryFingerprint: 'b'.repeat(64),
          trackTypes: ['mRNA'],
        };
      }
      refreshInventoryReads += 1;
      return refreshInventoryReads === 1
        ? { status: 'unavailable' }
        : {
            status: 'ready',
            sourceFingerprint: 'a'.repeat(24),
            inventoryFingerprint: 'b'.repeat(64),
            trackTypes: ['mRNA'],
          };
    });

    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId="assembly:grch38" />);

    await waitFor(() => expect(mockReadTextFile).toHaveBeenCalled());
    act(() => {
      emitReferencePreparationProgress({
        operationId: 'local-grch38-import',
        assemblyId: 'grch38',
        phase: 'ready',
        label: 'GRCh38 is ready',
        completed: 1,
        total: 1,
      });
    });
    publicationReleased = true;
    publicationRead.resolve(publication);

    await waitFor(() => expect(refreshInventoryReads).toBe(2));
    await waitFor(() =>
      expect(
        useCanvasStore
          .getState()
          .panels.main.tabs.find((candidate) => candidate.entityId === 'assembly:grch38')
          ?.indexedGenome
      ).toMatchObject({
        assemblySourceReadiness: 'ready',
        assemblyAnnotationProductsReadiness: 'ready',
        assemblySearchReadiness: 'ready',
      })
    );
    expect(mockInstallHostedReference).not.toHaveBeenCalled();
  });

  it('records a durable local failure without rendering preparation chrome over the viewer', async () => {
    const tab = freshAssemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblySourceReadiness: 'ready',
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
    };
    const prepared = referenceAssemblyById('grch38');
    if (!prepared) throw new Error('Missing GRCh38 catalog fixture');
    mockListLocalReferences.mockResolvedValue([prepared]);
    mockGetLocalPreparationStatus.mockResolvedValue({
      assemblyId: 'grch38',
      status: 'failed',
      phase: 'background-preparation-failed',
      label: 'Annotation products stopped after the renderer closed.',
      updatedAtMs: 2,
    });
    mockRetryLocalReference.mockResolvedValue({ status: 'ready', entry: prepared });
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: prepared.assetCacheKey,
        publicationId: 'local-retry-generation',
        sourceMaterializationFingerprint: 'c'.repeat(64),
        publishedAtMs: 5,
      })
    );

    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId="assembly:grch38" />);

    await waitFor(() =>
      expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
        'data-assembly-background-preparation',
        'failed'
      )
    );
    expect(screen.queryByTestId('hosted-reference-background-preparation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hosted-reference-background-retry')).not.toBeInTheDocument();
    expect(mockRetryLocalReference).not.toHaveBeenCalled();
    expect(mockInstallHostedReference).not.toHaveBeenCalled();
  });

  it('keeps a restored pending local failure non-visual when durable status is missing', async () => {
    const tab = freshAssemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblySourceReadiness: 'ready',
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
    };
    const prepared = referenceAssemblyById('grch38');
    if (!prepared) throw new Error('Missing GRCh38 catalog fixture');
    mockListLocalReferences.mockResolvedValue([prepared]);
    mockGetLocalPreparationStatus.mockResolvedValue(null);
    mockRetryLocalReference.mockResolvedValue({ status: 'ready', entry: prepared });
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: prepared.assetCacheKey,
        publicationId: 'local-interrupted-generation',
        sourceMaterializationFingerprint: 'c'.repeat(64),
        publishedAtMs: 6,
      })
    );

    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId="assembly:grch38" />);

    await waitFor(() =>
      expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
        'data-assembly-background-preparation',
        'failed'
      )
    );
    expect(screen.queryByTestId('hosted-reference-background-preparation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hosted-reference-background-retry')).not.toBeInTheDocument();
    expect(mockRetryLocalReference).not.toHaveBeenCalled();
    expect(mockInstallHostedReference).not.toHaveBeenCalled();
  });

  it('re-admits a restored ready hosted tab before any persisted source path reaches genome.open', async () => {
    const tab = freshAssemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      sourcePath: '/stale-ready-generation/chr1.gff3.gz',
      assemblySourceReadiness: 'ready',
      assemblyAnnotationProductsReadiness: 'ready',
      assemblySearchReadiness: 'ready',
    };
    const prepared = referenceAssemblyById('grch38');
    if (!prepared) throw new Error('Missing GRCh38 catalog fixture');
    mockListHostedReferences.mockResolvedValue([grch38HostedCatalogEntry()]);
    mockInstallHostedReference.mockResolvedValue({ status: 'ready', entry: prepared });
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: 'grch38',
        publicationId: 're-admitted-generation',
        sourceMaterializationFingerprint: 'e'.repeat(64),
        publishedAtMs: 3,
      })
    );

    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId="assembly:grch38" />);

    await waitFor(() =>
      expect(
        mockOpen.mock.calls.filter(([source]) => source.intent?.kind === 'reference-assembly')
      ).toHaveLength(1)
    );
    expect(mockInstallHostedReference).toHaveBeenCalledTimes(1);
    expect(mockInstallHostedReference.mock.calls.map(([request]) => request.intent)).toEqual([
      'open-view',
    ]);
    expect(
      mockOpen.mock.calls.some(
        ([source]) => source.sourcePath === '/stale-ready-generation/chr1.gff3.gz'
      )
    ).toBe(false);

    await waitFor(() =>
      expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
        'data-assembly-background-preparation',
        'idle'
      )
    );
    act(() => {
      emitHostedInstallProgress({
        operationId: 'hosted-grch38-cached-verification',
        catalogId: 'grch38',
        phase: 'resolving-hosted-reference',
        label: 'Resolving GRCh38',
      });
    });
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-assembly-background-preparation',
      'idle'
    );
  });

  it('keeps the presented coordinate viewer mounted while the same hosted assembly is admitted', async () => {
    const tab = freshAssemblyIndexedTab();
    const anchor = tab.indexedGenome?.assembly?.chromosomes[0];
    if (!anchor) throw new Error('Missing GRCh38 anchor fixture');
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      manifest: anchor.manifest,
      metadata: { length: anchor.length, circular: false },
      assemblySourceReadiness: 'ready',
      assemblyAnnotationProductsReadiness: 'ready',
      assemblySearchReadiness: 'ready',
    };
    const prepared = referenceAssemblyById('grch38');
    if (!prepared) throw new Error('Missing GRCh38 catalog fixture');
    const expectedSessionCount = tab.indexedGenome?.assembly?.chromosomes.length;
    if (!expectedSessionCount) throw new Error('Missing GRCh38 chromosome fixture');
    const admission = createDeferred<{ status: 'ready'; entry: typeof prepared }>();
    mockListHostedReferences.mockResolvedValue([grch38HostedCatalogEntry()]);
    mockInstallHostedReference.mockReturnValue(admission.promise);
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: prepared.assetCacheKey,
        publicationId: 'same-assembly-capability-upgrade',
        sourceMaterializationFingerprint: 'f'.repeat(64),
        publishedAtMs: 4,
      })
    );

    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId="assembly:grch38" />);

    await waitForSessionSubscription();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });
    const initiallyPresentedViewer = await screen.findByTestId('indexed-genome-viewer-mock');
    await waitFor(() => expect(mockInstallHostedReference).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(
      screen.getByTestId('indexed-genome-viewer-mock'),
      'the already presented source-ready owner remains mounted while hosted admission runs'
    ).toBe(initiallyPresentedViewer);

    admission.resolve({ status: 'ready', entry: prepared });
    await waitFor(() => expect(mockInstallHostedReference).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        mockOpen.mock.calls.filter(([source]) => source.intent?.kind === 'reference-assembly')
      ).toHaveLength(1)
    );
    await waitFor(() => expect(viewerState.props?.annotationSceneSourceRequest).toBeTruthy());
    expect(mockReadAssemblyAnnotationScene).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(viewerState.props?.assemblySessionConfigs).toHaveLength(expectedSessionCount)
    );

    expect(
      screen.getByTestId('indexed-genome-viewer-mock'),
      'same-assembly capability admission must not unmount the presented coordinate viewer'
    ).toBe(initiallyPresentedViewer);
  });

  it('records a hosted catalog admission failure without adding viewer chrome', async () => {
    const tab = freshAssemblyIndexedTab();
    const prepared = referenceAssemblyById('grch38');
    if (!prepared) throw new Error('Missing GRCh38 catalog fixture');
    mockListHostedReferences
      .mockRejectedValueOnce(new Error('The hosted catalog bridge stopped.'))
      .mockResolvedValue([grch38HostedCatalogEntry()]);
    mockInstallHostedReference.mockResolvedValue({ status: 'ready', entry: prepared });

    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId="assembly:grch38" />);

    await waitFor(() =>
      expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
        'data-assembly-background-preparation',
        'failed'
      )
    );
    expect(screen.queryByTestId('hosted-reference-background-preparation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hosted-reference-background-retry')).not.toBeInTheDocument();
    expect(mockInstallHostedReference).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        mockOpen.mock.calls.filter(([source]) => source.intent?.kind === 'reference-assembly')
      ).toHaveLength(1)
    );

    expect(prepared.id).toBe('grch38');
  });

  it('re-admits a failed hosted view when main announces a newly ready publication', async () => {
    const tab = freshAssemblyIndexedTab();
    const prepared = referenceAssemblyById('grch38');
    if (!prepared) throw new Error('Missing GRCh38 catalog fixture');
    mockListHostedReferences.mockResolvedValue([grch38HostedCatalogEntry()]);
    mockInstallHostedReference.mockResolvedValue({ status: 'ready', entry: prepared });
    mockReferenceAssetCacheRoot.mockResolvedValueOnce(null);

    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId="assembly:grch38" />);

    await waitFor(() =>
      expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
        'data-assembly-background-preparation',
        'failed'
      )
    );
    expect(screen.queryByTestId('hosted-reference-background-preparation')).not.toBeInTheDocument();
    expect(mockInstallHostedReference).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        mockOpen.mock.calls.filter(([source]) => source.intent?.kind === 'reference-assembly')
      ).toHaveLength(1)
    );

    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: 'grch38',
        publicationId: 'admission-retry-generation',
        sourceMaterializationFingerprint: 'e'.repeat(64),
        publishedAtMs: 5,
      })
    );
    act(() => {
      emitHostedInstallProgress({
        operationId: 'hosted-grch38-late-ready',
        catalogId: 'grch38',
        phase: 'ready',
        label: 'GRCh38 is ready',
        completed: 1,
        total: 1,
      });
    });

    await waitFor(() => expect(mockInstallHostedReference).toHaveBeenCalledTimes(2));
    expect(mockInstallHostedReference.mock.calls.map(([request]) => request.intent)).toEqual([
      'open-view',
      'require-ready',
    ]);
    expect(screen.queryByTestId('hosted-reference-background-preparation')).not.toBeInTheDocument();
  });

  it('publishes annotation detail before search and upgrades search without replacing geometry', async () => {
    const tab = freshAssemblyIndexedTab();
    const viewEntry = grch38HostedPortableView();
    const annotationEntry = grch38HostedAnnotationReadyView(false);
    const searchEntry = grch38HostedAnnotationReadyView(true);
    mockListHostedReferences.mockResolvedValue([grch38HostedCatalogEntry()]);
    mockInstallHostedReference
      .mockResolvedValueOnce({ status: 'view-ready', entry: viewEntry })
      .mockResolvedValueOnce({ status: 'ready', entry: searchEntry });
    mockGetHostedPreparationStatus.mockResolvedValue({
      status: 'annotation-ready',
      catalogId: 'grch38',
      themeMode: 'light',
      phase: 'detail-ready',
      label: 'GRCh38 annotations are ready',
      updatedAtMs: 2,
      capabilityGenerationId: 'grch38:annotation:light',
      entry: annotationEntry,
    });
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: 'grch38',
        publicationId: 'portable-capability-generation',
        sourceMaterializationFingerprint: 'f'.repeat(64),
        publishedAtMs: 2,
      })
    );

    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId="assembly:grch38" />);
    await waitFor(() => expect(mockInstallHostedReference).toHaveBeenCalledOnce());

    act(() => {
      emitHostedInstallProgress({
        operationId: 'hosted-grch38-detail-ready',
        catalogId: 'grch38',
        phase: 'detail-ready',
        label: 'GRCh38 annotations are ready',
        completed: 1,
        total: 1,
      });
    });

    await waitFor(() => expect(mockGetHostedPreparationStatus).toHaveBeenCalledOnce());
    await waitFor(() => {
      const state = Object.values(useCanvasStore.getState().panels)
        .flatMap((panel) => panel.tabs)
        .find((candidate) => candidate.entityId === 'assembly:grch38')?.indexedGenome;
      expect(state?.assemblyAnnotationProductsReadiness).toBe('ready');
      expect(state?.assemblySearchReadiness).toBe('pending');
      expect(state?.assemblyAssetGeneration?.inventoryFingerprint).toBe('2'.repeat(64));
    });
    expect(mockInstallHostedReference).toHaveBeenCalledOnce();

    act(() => {
      emitHostedInstallProgress({
        operationId: 'hosted-grch38-search-ready',
        catalogId: 'grch38',
        phase: 'ready',
        label: 'GRCh38 is ready',
        completed: 1,
        total: 1,
      });
    });

    await waitFor(() => expect(mockInstallHostedReference).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const state = Object.values(useCanvasStore.getState().panels)
        .flatMap((panel) => panel.tabs)
        .find((candidate) => candidate.entityId === 'assembly:grch38')?.indexedGenome;
      expect(state?.assemblyAnnotationProductsReadiness).toBe('ready');
      expect(state?.assemblySearchReadiness).toBe('ready');
      expect(state?.assemblyAssetGeneration?.inventoryFingerprint).toBe('2'.repeat(64));
    });
    expect(mockInstallHostedReference.mock.calls.map(([request]) => request.intent)).toEqual([
      'open-view',
      'require-ready',
    ]);
  });

  it('waits for the authenticated hosted view and projects one ready capability generation', async () => {
    const tab = freshAssemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblySourceReadiness: 'pending',
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
    };
    const prepared = referenceAssemblyById('grch38');
    if (!prepared) throw new Error('Missing GRCh38 catalog fixture');
    const admission = createDeferred<{ status: 'ready'; entry: typeof prepared }>();
    mockListHostedReferences.mockResolvedValue([grch38HostedCatalogEntry()]);
    mockInstallHostedReference.mockReturnValue(admission.promise);
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: prepared.assetCacheKey,
        publicationId: 'fully-admitted-generation',
        sourceMaterializationFingerprint: 'b'.repeat(64),
        publishedAtMs: 2,
      })
    );

    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId="assembly:grch38" />);
    await waitFor(() => expect(mockInstallHostedReference).toHaveBeenCalledTimes(1));
    expect(mockInstallHostedReference).toHaveBeenCalledWith({
      catalogId: 'grch38',
      themeMode: 'light',
      intent: 'open-view',
    });
    expect(screen.getByRole('heading', { name: 'GRCh38 (human)' })).toBeVisible();
    expect(
      mockOpen.mock.calls.filter(([source]) => source.intent?.kind === 'reference-assembly')
    ).toHaveLength(0);
    expect(
      useCanvasStore
        .getState()
        .panels.main.tabs.find((candidate) => candidate.entityId === 'assembly:grch38')
        ?.indexedGenome
    ).toMatchObject({
      assemblySourceReadiness: 'pending',
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
    });
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-assembly-background-preparation',
      'preparing'
    );
    expect(screen.queryByTestId('hosted-reference-background-preparation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hosted-reference-background-retry')).not.toBeInTheDocument();
    act(() => {
      emitHostedInstallProgress({
        operationId: 'hosted-grch38-initial',
        catalogId: 'grch38',
        phase: 'prepared-bundle-transport',
        label: 'Downloading prepared GRCh38',
      });
    });
    expect(screen.queryByText('Downloading prepared GRCh38')).not.toBeInTheDocument();

    admission.resolve({ status: 'ready', entry: prepared });
    await waitFor(() => {
      const current = useCanvasStore
        .getState()
        .panels.main.tabs.find((candidate) => candidate.entityId === 'assembly:grch38');
      expect(current?.id).toBe(tab.id);
      expect(current?.indexedGenome).toMatchObject({
        assemblySourceReadiness: 'ready',
        assemblyAnnotationProductsReadiness: 'ready',
        assemblySearchReadiness: 'ready',
      });
      expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(1);
    });

    await waitFor(() =>
      expect(
        mockOpen.mock.calls.filter(([source]) => source.intent?.kind === 'reference-assembly')
      ).toHaveLength(1)
    );
    const readyOpenSource = mockOpen.mock.calls
      .filter(([source]) => source.intent?.kind === 'reference-assembly')
      .at(-1)?.[0];
    if (!readyOpenSource) throw new Error('Missing ready assembly session open');
    expect(readyOpenSource?.intent).toMatchObject({
      annotationProductsReadiness: 'ready',
      searchReadiness: 'ready',
    });
    const readyTabState = useCanvasStore
      .getState()
      .panels.main.tabs.find(
        (candidate) => candidate.entityId === 'assembly:grch38'
      )?.indexedGenome;
    if (!readyTabState) throw new Error('Missing ready assembly tab state');
    const readyUpdate = readySessionUpdate(readyTabState);
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', {
        ...readyUpdate,
        shell: {
          ...readyUpdate.shell,
          sourcePath: readyOpenSource.sourcePath,
          chrom: readyOpenSource.chrom,
          sourceSizeBytes: readyOpenSource.sourceSizeBytes,
          manifest: readyOpenSource.manifest,
          assemblyAnnotationProductsReadiness: 'ready',
          assemblySearchReadiness: 'ready',
          assemblySearchSource: readyOpenSource.intent.searchSource,
          assemblyAssetGeneration: readyOpenSource.intent.assetGeneration,
        },
      });
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Find sequence or annotations' })).toBeEnabled()
    );
    expect(await screen.findByTestId('indexed-genome-viewer-mock')).toBeInTheDocument();
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(1);
    expect(
      mockOpen.mock.calls.filter(([source]) => source.intent?.kind === 'reference-assembly')
    ).toHaveLength(1);
    expect(viewerState.props?.annotationSceneSourceRequest).toBe(
      readyOpenSource.intent.searchSource
    );
  });

  it('never overlays failed hosted preparation on the scientific viewer', async () => {
    const tab = freshAssemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblySourceReadiness: 'pending',
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
    };
    const prepared = referenceAssemblyById('grch38');
    if (!prepared) throw new Error('Missing GRCh38 catalog fixture');
    const firstAdmission = createDeferred<{ status: 'ready'; entry: typeof prepared }>();
    mockListHostedReferences.mockResolvedValue([grch38HostedCatalogEntry()]);
    mockInstallHostedReference.mockReturnValue(firstAdmission.promise);
    mockReadTextFile.mockResolvedValue(
      JSON.stringify({
        contract: 'reference-asset-publication.v1',
        assetCacheKey: prepared.assetCacheKey,
        publicationId: 'retry-admitted-generation',
        sourceMaterializationFingerprint: 'c'.repeat(64),
        publishedAtMs: 3,
      })
    );

    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId="assembly:grch38" />);

    await waitFor(() => expect(mockInstallHostedReference).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('heading', { name: 'GRCh38 (human)' })).toBeVisible();

    act(() => {
      emitHostedInstallProgress({
        operationId: 'hosted-grch38',
        catalogId: 'grch38',
        phase: 'background-preparation-failed',
        label: 'GRCh38 detail is unavailable: the download stopped.',
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
        'data-assembly-background-preparation',
        'failed'
      )
    );
    expect(screen.queryByTestId('hosted-reference-background-preparation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hosted-reference-background-retry')).not.toBeInTheDocument();
    expect(screen.queryByText(/Checking prepared .* files/)).not.toBeInTheDocument();

    act(() => {
      emitHostedInstallProgress({
        operationId: 'hosted-grch38-retry',
        catalogId: 'grch38',
        phase: 'prepared-bundle-transport',
        label: 'Downloading prepared GRCh38',
      });
    });
    expect(screen.queryByText('Downloading prepared GRCh38')).not.toBeInTheDocument();
    expect(mockInstallHostedReference).toHaveBeenCalledTimes(1);
  });

  it('shows an honest indeterminate progress meter that tracks the main-owned phase', async () => {
    const tab = freshIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    const progress = await screen.findByRole('progressbar', {
      name: 'Genome preparation progress',
    });
    expect(progress).not.toHaveAttribute('value');
    expect(progress).not.toHaveAttribute('aria-valuenow');
    expect(progress).toHaveAttribute('aria-valuetext', 'Building genome index');
    expect(screen.getByRole('status')).toHaveTextContent('Current step: Building genome index');

    await waitForSessionSubscription();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', {
        ...readySessionUpdate(reopenIndexedTab().indexedGenome!),
        prepareStatus: 'preparing',
        prepareLoadPhase: 'opening',
      });
    });

    await waitFor(() => {
      expect(
        screen.getByRole('progressbar', { name: 'Genome preparation progress' })
      ).toHaveAttribute('aria-valuetext', 'Opening indexed files');
    });
    expect(screen.getByText('Current step: Opening indexed files')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('value');
  });

  it('renders the indexed shell immediately while a manifest-less source is still indexing', async () => {
    const tab = freshIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    expect(screen.getByTestId('indexed-genome-tab')).toBeInTheDocument();
    expect(screen.getByText('chr11.gbff')).toBeInTheDocument();
    expect(screen.queryByText('chr11')).not.toBeInTheDocument();
    expect(screen.queryByTestId('indexed-genome-length-state')).toBeNull();
    expect(screen.queryByText('Length pending')).toBeNull();
    expect(screen.getByText(/Indexing/)).toBeInTheDocument();
    expect(mockGetFeatures).not.toHaveBeenCalled();
    await screen.findByTestId('indexed-genome-tab');
  });

  it('opens a main-owned genome session shell before the background indexer resolves', async () => {
    const tab = freshIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() => {
      expect(mockOpen).toHaveBeenCalledWith({
        sourcePath: '/workspace/chr11.gbff',
        workspaceRoot: '/workspace',
        sourceExt: 'gbff',
        sourceSizeBytes: 140 * 1024 * 1024,
        chrom: 'chr11',
        intent: { kind: 'reference-single' },
      });
    });
    const shell = await screen.findByTestId('indexed-genome-tab');
    expect(shell).toHaveAttribute('data-session-id', 'session-chr11');
    expect(shell).toHaveAttribute('data-scene-mode', 'tile-native-session-shell');
    expect(shell).toHaveAttribute('data-coordinate-ready', 'false');
    expect(shell).toHaveAttribute('data-length-state', 'length_unknown');
    expect(shell).toHaveAttribute('data-sequence-track-state', 'metadata_pending');
    expect(shell).toHaveAttribute('data-annotation-track-state', 'building_cache');
    expect(screen.queryByTestId('genome-session-scene-canvas')).toBeNull();
    expect(mockCanvasGetContext).not.toHaveBeenCalled();
    expect(mockGetFeatures).not.toHaveBeenCalled();
  });

  it('lets a main-owned session update install the ready manifest without renderer indexing', async () => {
    const tab = freshIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() => {
      expect(mockOpen).toHaveBeenCalled();
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });
    await screen.findByTestId('indexed-genome-tab');

    const readyTabState = reopenIndexedTab().indexedGenome!;
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(readyTabState));
    });

    await waitFor(() => {
      const found = useCanvasStore.getState().findTab('sequence', tab.entityId);
      expect(found).toBeTruthy();
      const stored = useCanvasStore
        .getState()
        .panels[found!.panelId].tabs.find((candidate) => candidate.id === found!.tabId);
      expect(stored?.loadStatus).toBe('indexed');
      expect(stored?.indexedGenome?.manifest?.fastaPath).toBe(
        '/workspace/.waypoint/genome-index/chr11/chr11.fa'
      );
    });
    await screen.findByTestId('indexed-genome-viewer-mock');
    expect(screen.queryByTestId('indexed-genome-length-state')).toBeNull();
    expect(screen.queryByText('135,086,622 bp')).toBeNull();
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-coordinate-ready',
      'true'
    );
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-length-state',
      'coordinate_ready'
    );
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-lane-epoch',
      'fingerprint-chr11:chr11:lane-v0'
    );
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-sequence-track-state',
      'coordinate_ready'
    );
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-annotation-track-state',
      'ready'
    );
  });

  it('ignores repeated semantically identical terminal session updates while idle', async () => {
    const tab = reopenIndexedTab();
    const terminalUpdate = readySessionUpdate(tab.indexedGenome!);

    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId={tab.entityId} />);
    await waitForSessionSubscription();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', terminalUpdate);
    });
    await screen.findByTestId('indexed-genome-viewer-mock');
    await act(async () => Promise.resolve());

    viewerState.autoReady = false;
    const panelsBefore = useCanvasStore.getState().panels;
    const viewerPropsBefore = viewerState.props;
    const openCallsBefore = mockOpen.mock.calls.length;
    let storeNotifications = 0;
    const unsubscribe = useCanvasStore.subscribe(() => {
      storeNotifications += 1;
    });

    act(() => {
      for (let index = 0; index < 25; index += 1) {
        emitPlatformEvent('genome:sessionUpdated', structuredClone(terminalUpdate));
      }
    });
    await act(async () => Promise.resolve());
    unsubscribe();

    expect(storeNotifications).toBe(0);
    expect(useCanvasStore.getState().panels).toBe(panelsBefore);
    expect(viewerState.props).toBe(viewerPropsBefore);
    expect(mockOpen).toHaveBeenCalledTimes(openCallsBefore);
  });

  it('does not replace a terminal session when its own capability projection becomes ready', async () => {
    const tab = assemblyIndexedTab();
    tab.indexedGenome = {
      ...tab.indexedGenome!,
      assemblyAnnotationProductsReadiness: 'pending',
      assemblySearchReadiness: 'pending',
    };
    resetCanvasStore(tab);
    render(<StoredIndexedGenomeTab entityId={tab.entityId} />);

    await waitForSessionSubscription();
    const openSource = mockOpen.mock.calls.find(
      ([source]) => source.intent?.kind === 'reference-assembly'
    )?.[0];
    if (!openSource) throw new Error('Missing assembly session open');
    expect(openSource.intent).toMatchObject({
      annotationProductsReadiness: 'ready',
      searchReadiness: 'ready',
    });
    const readyState = {
      ...tab.indexedGenome!,
      sourceSizeBytes: 140 * 1024 * 1024,
      sourceCtimeMs: 1_786_161_500_000,
      sourceMtimeMs: 1_786_161_400_000,
      assemblyAnnotationProductsReadiness: 'ready' as const,
      assemblySearchReadiness: 'ready' as const,
    };
    const update = readySessionUpdate(readyState);
    update.shell = {
      ...update.shell,
      sourcePath: openSource.sourcePath,
      sourceSizeBytes: openSource.sourceSizeBytes,
      assemblyAnnotationProductsReadiness: 'ready',
      assemblySearchReadiness: 'ready',
    };
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', update);
    });

    await screen.findByTestId('indexed-genome-viewer-mock');
    await waitFor(() =>
      expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
        'data-session-id',
        'session-chr11'
      )
    );
    await act(async () => Promise.resolve());
    expect(
      mockOpen.mock.calls.filter(([source]) => source.intent?.kind === 'reference-assembly')
    ).toHaveLength(1);
  });

  it('delegates optional V4 reads to the viewer without starting whole-assembly STEP0 work', async () => {
    const tab = assemblyIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitForSessionSubscription();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });

    await screen.findByTestId('indexed-genome-viewer-mock');

    expect(mockReadAssemblyAnnotationRasterV2).not.toHaveBeenCalled();
    expect(mockReadAssemblyAnnotationScene).not.toHaveBeenCalled();
    expect(viewerState.props?.annotationSceneSourceRequest?.scope?.kind).toBe('complete-assembly');
    expect(mockReadAssemblyOverviewFeatures).not.toHaveBeenCalled();
    expect(mockGetAssemblyOverview).not.toHaveBeenCalled();
    expect(viewerState.props).toMatchObject({ assemblyChromIds: ['chr11', 'chr12'] });
    expect(viewerState.props?.assemblyFeatures).toEqual([]);
    expect(viewerState.props?.assemblyByChrom).toEqual(new Map());
    expect(viewerState.props?.overviewTexture).toBeUndefined();
    expect(viewerState.props?.overviewTextureStatus).toBeUndefined();
  });

  it('does not parse or publish STEP0 features while the viewer owns the prepacked scene', async () => {
    const tab = assemblyIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);
    await waitForSessionSubscription();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });

    await screen.findByTestId('indexed-genome-viewer-mock');
    expect(mockReadAssemblyAnnotationScene).not.toHaveBeenCalled();
    expect(viewerState.props?.annotationSceneSourceRequest?.scope?.kind).toBe('complete-assembly');
    expect(mockReadAssemblyAnnotationRasterV2).not.toHaveBeenCalled();
    expect(viewerState.props?.overviewTexture).toBeUndefined();
    expect(viewerState.props?.overviewTextureStatus).toBeUndefined();
    expect(mockReadAssemblyOverviewFeatures).not.toHaveBeenCalled();
    expect(mockGetAssemblyOverview).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(viewerState.props?.prepackedAnnotationSceneCache?.status).toBe('loading')
    );
    expect(viewerState.props?.prepackedAnnotationSceneCache?.descriptor).toBeTruthy();
    expect(mockReadAssemblyAnnotationScene).not.toHaveBeenCalled();
  });

  it('never starts STEP0 parsing when the viewer-owned optional V4 cache becomes stale', async () => {
    mockHasPreparedPrepackedScene.mockReturnValue(true);
    const tab = assemblyIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);
    await waitForSessionSubscription();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });

    await screen.findByTestId('indexed-genome-viewer-mock');
    expect(mockReadAssemblyAnnotationScene).not.toHaveBeenCalled();
    expect(viewerState.props?.annotationSceneSourceRequest?.scope?.kind).toBe('complete-assembly');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockHasPreparedPrepackedScene).not.toHaveBeenCalled();
    expect(mockReadAssemblyOverviewFeatures).not.toHaveBeenCalled();
    expect(mockGetAssemblyOverview).not.toHaveBeenCalled();
  });

  it('buffers a fast main session update until genome.open returns the shell id', async () => {
    const tab = freshIndexedTab();
    const openDeferred = createDeferred<Awaited<ReturnType<typeof mockOpen>>>();
    mockOpen.mockReturnValueOnce(openDeferred.promise);

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() => {
      expect(mockOn).toHaveBeenCalledWith('genome:sessionUpdated', expect.any(Function));
    });

    const readyTabState = reopenIndexedTab().indexedGenome!;
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(readyTabState));
    });

    const storedBeforeOpen = useCanvasStore
      .getState()
      .panels.main.tabs.find((candidate) => candidate.id === tab.id);
    expect(storedBeforeOpen?.indexedGenome?.manifest).toBeUndefined();

    await act(async () => {
      openDeferred.resolve({
        sessionId: 'session-chr11',
        sourcePath: '/workspace/chr11.gbff',
        sourceFingerprint: 'fingerprint-chr11',
        chrom: 'chr11',
        sourceSizeBytes: 140 * 1024 * 1024,
        openReady: false,
        coordinateReady: false,
        validationState: 'metadata_match',
        openedAt: 1,
        tracks: [
          {
            id: 'chr11:sequence',
            kind: 'sequence',
            label: 'Sequence',
            state: 'metadata_pending',
            userState: 'Preparing',
          },
        ],
      });
      await openDeferred.promise;
    });

    await waitFor(() => {
      const stored = useCanvasStore
        .getState()
        .panels.main.tabs.find((candidate) => candidate.id === tab.id);
      expect(stored?.indexedGenome?.manifest?.fastaPath).toBe(
        '/workspace/.waypoint/genome-index/chr11/chr11.fa'
      );
    });
  });

  it('recovers from a missed main session update by resyncing the session shell', async () => {
    const tab = freshIndexedTab();
    mockGetSession.mockResolvedValueOnce(
      readySessionUpdate(reopenIndexedTab().indexedGenome!).shell
    );

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() => {
      expect(mockOpen).toHaveBeenCalled();
      expect(mockGetSession).toHaveBeenCalledWith('session-chr11');
    });

    await screen.findByTestId('indexed-genome-viewer-mock');
    expect(screen.queryByTestId('indexed-genome-loading')).not.toBeInTheDocument();
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-coordinate-ready',
      'true'
    );
    const stored = useCanvasStore
      .getState()
      .panels.main.tabs.find((candidate) => candidate.id === tab.id);
    expect(stored?.loadStatus).toBe('indexed');
    expect(stored?.indexedGenome?.manifest?.fastaPath).toBe(
      '/workspace/.waypoint/genome-index/chr11/chr11.fa'
    );
  });

  it('shows the failed open when the main session failure event is missed', async () => {
    const tab = freshIndexedTab();
    const terminalShell = createDeferred<GenomeSessionShell>();
    mockGetSession.mockReturnValueOnce(terminalShell.promise);

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    const loading = await screen.findByTestId('indexed-genome-loading');
    expect(loading).toHaveAttribute('data-load-phase', 'indexing');
    await waitFor(() => expect(mockGetSession).toHaveBeenCalledWith('session-chr11'));
    const shell = await mockOpen.mock.results[0].value;
    await act(async () => {
      terminalShell.resolve(
        markGenomeSessionShellError({ session: shell, message: 'Index preparation failed' })
      );
    });

    expect(loading).toHaveAttribute('data-load-phase', 'error');
    expect(screen.getByText(/Couldn't open chr11/)).toBeInTheDocument();
    expect(screen.queryByTestId('indexed-genome-viewer-mock')).not.toBeInTheDocument();
    expect(useCanvasStore.getState().panels.main.tabs[0]).toMatchObject({
      id: tab.id,
      loadStatus: 'indexed-error',
      indexedGenome: { sourcePath: '/workspace/chr11.gbff', chrom: 'chr11' },
    });
  });

  it('keeps the persisted coordinate shell visible while main validates it', async () => {
    const tab = reopenIndexedTab();
    mockGetSession.mockResolvedValueOnce({
      sessionId: 'session-chr11',
      sourcePath: '/workspace/chr11.gbff',
      sourceFingerprint: 'fingerprint-chr11',
      chrom: 'chr11',
      sourceSizeBytes: 140 * 1024 * 1024,
      coordinateReady: true,
      length: 135_086_622,
      manifest: tab.indexedGenome!.manifest,
      validationState: 'metadata_match',
      openedAt: 1,
      tracks: [
        {
          id: 'chr11:sequence',
          kind: 'sequence',
          label: 'Sequence',
          state: 'coordinate_ready',
          userState: 'Showing overview',
        },
        {
          id: 'chr11:annotations',
          kind: 'annotation',
          label: 'Annotations',
          state: 'ready',
          userState: 'Showing overview',
        },
      ],
    });

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitFor(() => {
      expect(mockGetSession).toHaveBeenCalledWith('session-chr11');
    });

    expect(screen.getByTestId('indexed-genome-loading')).toHaveAttribute(
      'data-load-phase',
      'opening'
    );
    expect(screen.getByTestId('indexed-genome-viewer-mock')).toBeInTheDocument();
    const stored = useCanvasStore
      .getState()
      .panels.main.tabs.find((candidate) => candidate.id === tab.id);
    expect(stored?.loadStatus).toBe('indexed');
    expect(stored?.indexedGenome?.manifest?.fastaPath).toBe(
      '/workspace/.waypoint/genome-index/chr11/chr11.fa'
    );
  });

  it('shows the "Opening" headline (no indexing caveat) when the manifest is cached', async () => {
    const tab = reopenIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    const screenEl = await screen.findByTestId('indexed-genome-loading');
    expect(screenEl.dataset.loadPhase).toBe('opening');
    expect(screen.getByText('Opening chr11')).toBeInTheDocument();
    expect(screen.queryByText(/first-time indexing can take/i)).not.toBeInTheDocument();
    expect(mockOpen).toHaveBeenCalledWith({
      sourcePath: '/workspace/chr11.gbff',
      workspaceRoot: '/workspace',
      sourceExt: 'gbff',
      sourceSizeBytes: 140 * 1024 * 1024,
      chrom: 'chr11',
      manifest: tab.indexedGenome?.manifest,
      intent: { kind: 'reference-single' },
    });
    expect(mockInit).not.toHaveBeenCalled();
  });

  it('keeps the original session subscribed through stale-manifest invalidation until terminal ready', async () => {
    const tab = reopenIndexedTab();
    mockInit.mockRejectedValue(new Error('ENOENT: stale cached index'));

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitForSessionSubscription();

    act(() => {
      emitPlatformEvent('genome:sessionUpdated', {
        sessionId: 'session-chr11',
        prepareStatus: 'preparing',
        prepareLoadPhase: 'indexing',
        reusedExistingIndex: false,
        shell: {
          sessionId: 'session-chr11',
          sourcePath: '/workspace/chr11.gbff',
          sourceFingerprint: 'fingerprint-chr11',
          chrom: 'chr11',
          sourceSizeBytes: 140 * 1024 * 1024,
          coordinateReady: false,
          validationState: 'metadata_match',
          openedAt: 1,
          tracks: [
            {
              id: 'chr11:sequence',
              kind: 'sequence',
              label: 'Sequence',
              state: 'metadata_pending',
              userState: 'Preparing',
            },
            {
              id: 'chr11:annotations',
              kind: 'annotation',
              label: 'Annotations',
              state: 'building_cache',
              userState: 'Updating',
            },
          ],
        },
        tabState: {
          sourcePath: '/workspace/chr11.gbff',
          sourceSizeBytes: 140 * 1024 * 1024,
          sourceExt: 'gbff',
          chrom: 'chr11',
        },
      });
    });

    expect(mockInit).not.toHaveBeenCalled();
    expect(screen.queryByText(/Couldn't open chr11/)).not.toBeInTheDocument();
    expect(screen.getByTestId('indexed-genome-loading')).toHaveAttribute(
      'data-load-phase',
      'indexing'
    );

    await waitFor(() => {
      const stored = useCanvasStore
        .getState()
        .panels.main.tabs.find((candidate) => candidate.id === tab.id);
      expect(stored?.indexedGenome?.manifest).toBeUndefined();
    });

    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('indexed-genome-loading')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('indexed-genome-viewer-mock')).toBeInTheDocument();
    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOn).toHaveBeenCalledTimes(1);

    const stored = useCanvasStore
      .getState()
      .panels.main.tabs.find((candidate) => candidate.id === tab.id);
    expect(stored?.loadStatus).toBe('indexed');
    expect(stored?.indexedGenome?.manifest).toEqual(tab.indexedGenome?.manifest);
  });

  it('flips to "Loading" once prepare is done but viewer is still fetching data', async () => {
    const tab = reopenIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitForSessionSubscription();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('indexed-genome-loading')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('indexed-genome-tab')).toBeInTheDocument();
  });

  it('keeps a first viewer failure fatal until that mount has actually presented', async () => {
    const tab = reopenIndexedTab();
    viewerState.autoReady = false;

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitForSessionSubscription();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });
    await waitFor(() => expect(viewerState.props).not.toBeNull());

    act(() => {
      (
        viewerState.props?.onLoadPhase as
          | ((phase: 'loading' | 'ready' | 'error', message?: string) => void)
          | undefined
      )?.('error', 'Initial summary tile failed');
    });

    await waitFor(() => {
      expect(screen.getByTestId('indexed-genome-loading')).toHaveAttribute(
        'data-load-phase',
        'error'
      );
    });
    expect(screen.getByText(/Couldn't open chr11/i)).toBeInTheDocument();
    expect(screen.getByText(userMessage('tracks.loadFailed'))).toBeInTheDocument();
  });

  it('retains a physically presented viewer when a later session error arrives', async () => {
    const tab = reopenIndexedTab();
    viewerState.autoReady = false;

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitForSessionSubscription();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });
    await waitFor(() => expect(viewerState.props).not.toBeNull());
    act(() => {
      (
        viewerState.props?.onLoadPhase as
          | ((phase: 'loading' | 'ready' | 'error', message?: string) => void)
          | undefined
      )?.('ready');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('indexed-genome-loading')).not.toBeInTheDocument();
    });

    act(() => {
      emitPlatformEvent('genome:sessionUpdated', {
        ...readySessionUpdate(tab.indexedGenome!),
        prepareStatus: 'error',
        error: 'Derived index disappeared',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
        'data-sequence-track-state',
        'error'
      );
    });
    expect(screen.getByTestId('indexed-genome-viewer-mock')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't open chr11/i)).not.toBeInTheDocument();
  });

  it('commits the position controls to the real viewer viewport', async () => {
    const tab = reopenIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitForSessionSubscription();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });

    await waitFor(() => {
      expect(viewerState.props).not.toBeNull();
    });
    expect(viewerState.props?.targetViewport).toBeNull();

    const coordinateInput = screen.getByLabelText('Go to coordinate');
    coordinateInput.focus();
    fireEvent.change(coordinateInput, {
      target: { value: '1000001', selectionStart: 7, selectionEnd: 7 },
    });
    expect(coordinateInput).toHaveValue('1,000,001');
    expect(coordinateInput).toHaveProperty('selectionStart', 9);
    fireEvent.keyDown(coordinateInput, { key: 'Enter' });

    await waitFor(() => {
      expect(viewerState.props?.targetViewport).toMatchObject({
        start: 1_000_000,
        end: 1_002_000,
      });
    });
    expect(coordinateInput).toHaveValue('1,000,001');

    fireEvent.change(coordinateInput, {
      target: { value: '2000001', selectionStart: 7, selectionEnd: 7 },
    });
    expect(coordinateInput).toHaveValue('2,000,001');
    fireEvent.click(screen.getByRole('button', { name: 'Go to entered coordinate' }));
    await waitFor(() => {
      expect(viewerState.props?.targetViewport).toMatchObject({
        start: 2_000_000,
        end: 2_002_000,
      });
    });
    expect(coordinateInput).toHaveValue('2,000,001');
  });

  it.each([135_086_622, Number.MAX_SAFE_INTEGER])(
    'keeps the selected window when jumping to or beyond the last coordinate (%s)',
    async (input) => {
      const tab = reopenIndexedTab();
      resetCanvasStore(tab);
      render(<IndexedGenomeTab tab={tab} />);
      await waitForSessionSubscription();
      act(() => {
        emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
      });

      const windowSize = screen.getByLabelText('Window size');
      await waitFor(() => expect(windowSize).toBeEnabled());
      fireEvent.change(windowSize, { target: { value: '10000' } });
      const coordinate = screen.getByLabelText('Go to coordinate');
      fireEvent.change(coordinate, { target: { value: String(input) } });
      fireEvent.keyDown(coordinate, { key: 'Enter' });

      await waitFor(() => {
        expect(viewerState.props?.targetViewport).toMatchObject({
          start: 135_076_622,
          end: 135_086_622,
        });
      });
      expect(coordinate).toHaveValue('135,086,622');
    }
  );

  it('does not flush a closed tab viewport into a reopened tab for the same source', async () => {
    const tab = reopenIndexedTab();
    const indexedGenome = tab.indexedGenome;
    if (!indexedGenome) throw new Error('The indexed tab fixture has no admitted source');
    resetCanvasStore(tab);
    const view = render(<IndexedGenomeTab tab={tab} />);
    await waitForSessionSubscription();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(indexedGenome));
    });

    const commitViewport = async (start: number) => {
      const coordinateInput = screen.getByRole('textbox', { name: 'Go to coordinate' });
      fireEvent.change(coordinateInput, {
        target: { value: String(start + 1) },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Go to entered coordinate' }));
      await waitFor(() => {
        expect(viewerState.props?.targetViewport).toMatchObject({ start, end: start + 2_000 });
      });
      const command = viewerState.props?.targetViewport;
      const acknowledge = viewerState.props?.onTargetViewportCommitted;
      if (
        !command ||
        typeof command !== 'object' ||
        !('id' in command) ||
        typeof command.id !== 'number' ||
        typeof acknowledge !== 'function'
      ) {
        throw new Error('The mounted viewer has no pending viewport command and acknowledgement');
      }
      const { id } = command;
      act(() => acknowledge({ id, start, end: start + 2_000 }));
    };

    await commitViewport(1_000_000);
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(
      useCanvasStore.getState().panels.main?.tabs.find((candidate) => candidate.id === tab.id)
        ?.viewState?.indexedViewport
    ).toEqual({ start0: 1_000_000, end0: 1_002_000 });

    await commitViewport(2_000_000);
    const reopened: Tab = {
      ...tab,
      id: 'reopened-indexed-tab',
      viewState: { indexedViewport: { start0: 500, end0: 2_500 } },
    };
    act(() => {
      resetCanvasStore(reopened);
      view.unmount();
    });
    const retained = useCanvasStore
      .getState()
      .panels.main?.tabs.find((candidate) => candidate.id === reopened.id);
    expect(retained?.entityId).toBe(tab.entityId);
    expect(retained?.viewState?.indexedViewport).toEqual({ start0: 500, end0: 2_500 });
  });

  it('does not persist or acknowledge a viewport superseded by a newer coordinate jump', async () => {
    const tab: Tab = {
      ...reopenIndexedTab(),
      viewState: {
        indexedViewportCommand: { id: 3131, chrom: 'chr11', start0: 100_000, end0: 102_000 },
      },
    };
    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);
    await waitForSessionSubscription();
    act(() => emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!)));

    type ViewerCommand = { id: number; start: number; end: number };
    const readCommand = () => viewerState.props?.targetViewport as ViewerCommand | null;
    const readSaved = () =>
      useCanvasStore.getState().panels.main.tabs[0].viewState?.indexedViewport;
    await waitFor(() => expect(readCommand()).toMatchObject({ start: 100_000, end: 102_000 }));
    const superseded = readCommand();
    if (!superseded) throw new Error('The first viewport command did not reach the viewer');

    const coordinate = screen.getByRole('textbox', { name: 'Go to coordinate' });
    fireEvent.change(coordinate, { target: { value: '200001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go to entered coordinate' }));
    await waitFor(() => expect(readCommand()).toMatchObject({ start: 200_000, end: 202_000 }));
    const current = readCommand();
    const acknowledge = viewerState.props?.onTargetViewportCommitted as
      | ((viewport: ViewerCommand) => void)
      | undefined;
    if (!current || !acknowledge) throw new Error('The new coordinate jump has no viewer command');
    expect(current.id).not.toBe(superseded.id);

    act(() => acknowledge(superseded));
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(readSaved()).toBeUndefined();
    expect(readIndexedLiveViewport(tab.id)?.commandReceipt ?? null).toBeNull();

    act(() => acknowledge(current));
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(readSaved()).toEqual({ start0: 200_000, end0: 202_000 });

    act(() => acknowledge(superseded));
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(readSaved()).toEqual({ start0: 200_000, end0: 202_000 });
    expect(readIndexedLiveViewport(tab.id)?.commandReceipt ?? null).toBeNull();
  });

  it.each([0, 0.0000002384185791015625])(
    'acknowledges a viewport command only after renderer readback commits it (offset %s)',
    async (offset) => {
      const tab: Tab = {
        ...reopenIndexedTab(),
        viewState: {
          indexedViewportCommand: {
            id: 4242,
            chrom: 'chr11',
            start0: 100_000,
            end0: 102_000,
          },
        },
      };
      resetCanvasStore(tab);
      render(<IndexedGenomeTab tab={tab} />);

      await waitForSessionSubscription();
      act(() => {
        emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
      });
      await waitFor(() => {
        expect(viewerState.props?.targetViewport).toMatchObject({
          id: expect.any(Number),
          start: 100_000,
          end: 102_000,
        });
      });
      expect(screen.getByRole('textbox', { name: 'Go to coordinate' })).toHaveValue('100,001');

      act(() => {
        (
          viewerState.props?.onViewportRangeChange as
            | ((range: { start: number; end: number }) => void)
            | undefined
        )?.({ start: 100_000, end: 102_000 });
      });
      expect(readIndexedLiveViewport(tab.id)?.commandId).toBeNull();

      const pending = waitForIndexedLiveViewport({
        tabId: tab.id,
        chrom: 'chr11',
        start0: 100_000,
        end0: 102_000,
        commandId: 4242,
        timeoutMs: 100,
      });

      act(() => {
        (
          viewerState.props?.onTargetViewportCommitted as
            | ((viewport: { id: number; start: number; end: number }) => void)
            | undefined
        )?.({
          ...(viewerState.props?.targetViewport as { id: number; start: number; end: number }),
          start: 100_000 + offset,
          end: 102_000 + offset,
        });
      });
      expect(readIndexedLiveViewport(tab.id)).toMatchObject({
        chrom: 'chr11',
        start0: 100_000 + offset,
        end0: 102_000 + offset,
        commandId: 4242,
        commandReceipt: {
          commandId: 4242,
          requested: { chrom: 'chr11', start0: 100_000, end0: 102_000 },
          committed: { chrom: 'chr11', start0: 100_000 + offset, end0: 102_000 + offset },
        },
      });
      await expect(pending).resolves.toMatchObject({
        chrom: 'chr11',
        start0: 100_000 + offset,
        end0: 102_000 + offset,
      });
    }
  );

  it('acknowledges an assembly chromosome-end command while preserving its exact global camera', async () => {
    const start0 = 135_084_622;
    const end0 = 135_086_622;
    const tab: Tab = {
      ...assemblyIndexedTab(),
      viewState: { indexedViewportCommand: { id: 8484, chrom: 'chr11', start0, end0 } },
    };
    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);
    await waitForSessionSubscription();
    act(() => emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!)));
    await waitFor(() =>
      expect(viewerState.props?.targetViewport).toMatchObject({ start: start0, end: end0 })
    );
    const pending = waitForIndexedLiveViewport({
      tabId: tab.id,
      chrom: 'chr11',
      start0,
      end0,
      commandId: 8484,
      timeoutMs: 100,
    });
    const actual = {
      start: start0 + 0.0000000298023223876953125,
      end: end0 + 0.0000000298023223876953125,
    };
    act(() => {
      (
        viewerState.props?.onTargetViewportCommitted as (v: {
          id: number;
          start: number;
          end: number;
        }) => void
      )({
        ...(viewerState.props?.targetViewport as { id: number; start: number; end: number }),
        ...actual,
      });
    });
    await expect(pending).resolves.toMatchObject({
      chrom: 'chr11',
      start0: actual.start,
      end0,
      globalRange: actual,
      commandReceipt: { globalRange: actual },
    });
  });

  it.each([-1, 1])(
    'persists exact genome coordinates after floating-point camera readback (direction %s)',
    async (direction) => {
      const initial = assemblyIndexedTab();
      const tab: Tab = {
        ...initial,
        indexedGenome: {
          ...initial.indexedGenome!,
          assembly: {
            ...initial.indexedGenome!.assembly!,
            chromosomes: initial.indexedGenome!.assembly!.chromosomes.map((chromosome) => ({
              ...chromosome,
              length: 3_088_269_832,
            })),
          },
        },
      };
      resetCanvasStore(tab);
      render(<IndexedGenomeTab tab={tab} />);
      await waitForSessionSubscription();
      act(() => emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!)));
      await waitFor(() => expect(viewerState.props).not.toBeNull());
      const exact = { start: 1_950_303_672, end: 1_950_305_675 };
      const noise = direction * 2 ** -22;
      act(() => {
        (
          viewerState.props?.onViewportRangeChange as (range: {
            start: number;
            end: number;
          }) => void
        )({ start: exact.start + noise, end: exact.end + noise });
      });
      await waitFor(() => {
        const found = useCanvasStore.getState().findTab('sequence', tab.entityId)!;
        const current = useCanvasStore
          .getState()
          .panels[found.panelId].tabs.find((t) => t.id === found.tabId);
        expect(current?.viewState?.indexedViewport).toEqual({
          start0: exact.start,
          end0: exact.end,
        });
      });
    }
  );

  it.each(['data', 'alignment'] as const)(
    'keeps a saved view clean while %s restoration is pending, then detects an actual edit',
    async (pendingKind) => {
      let restoring = true;
      const dataRestore = vi
        .spyOn(persistedDataTracks, 'usePersistedDataTracks')
        .mockImplementation(() => ({
          status: restoring && pendingKind === 'data' ? 'restoring' : 'ready',
          issues: [],
        }));
      const bamRestore = vi
        .spyOn(persistedBamTracks, 'usePersistedBamTracks')
        .mockImplementation(() => ({
          status: restoring && pendingKind === 'alignment' ? 'restoring' : 'ready',
          issues: [],
        }));
      const initial = assemblyIndexedTab();
      const track = {
        trackId: 'data:restored-transcripts',
        trackType: 'imported-transcript',
        label: 'Saved transcripts',
        order: 0,
        color: 0x3b82f6,
        trackPx: 160,
        laneHeightPx: 8,
        maxLanes: 32,
        visible: true,
        source: {
          admissionVersion: 1 as const,
          uri: 'https://example.org/transcripts.bb',
          input: { kind: 'url' as const, url: 'https://example.org/transcripts.bb' },
          formatId: 'bigbed' as const,
          readerKind: 'bbi' as const,
          scientificKind: 'transcript' as const,
          assemblyId: 'grch38-test',
          referenceReceipt: {
            assemblyId: 'grch38-test',
            referenceSignature: 'reference',
            sourceSignature: 'transcripts',
            contigMap: { chr11: 'chr11' },
            checkedContigs: 1,
            status: 'compatible' as const,
            checkedAt: '2026-10-10T00:00:00.000Z',
          },
          provenance: {
            provider: 'direct-url' as const,
            sourceKind: 'remote-url' as const,
            label: 'Saved transcripts',
          },
          fingerprint: 'saved-transcripts',
        },
      };
      const document = {
        ...trackViewFixture(),
        reference: trackViewReference(initial.indexedGenome!),
        viewport: { start0: 100_000, end0: 102_000 },
        annotation: {
          policy: { isoformMode: 'canonical', laneLimit: null },
          orderedTrackIds: [],
          visibilityByTrackId: {},
        },
        dataTracks: [track],
      } as TrackViewDocument;
      const tab: Tab = {
        ...initial,
        isDirty: false,
        trackView: { document, revision: 'a'.repeat(64), path: '/library/view.json' },
        indexedGenome: { ...initial.indexedGenome!, dataTracks: [track] },
        viewState: {
          indexedGenomeViewRestoreCommand: {
            id: 'restore-pending-tracks',
            viewport: { kind: 'assembly-range', start0: 100_000, end0: 102_000 },
            annotationPolicy: { isoformMode: 'canonical', laneLimit: null },
            visibleAnnotationTrackIds: [],
            orderedAnnotationTrackIds: [],
          },
        },
      };
      let unmount = () => {};
      try {
        resetCanvasStore(tab);
        useLaneContractStore.getState().clearOwner(tab.id);
        const rendered = render(<StoredIndexedGenomeTab entityId={tab.entityId} />);
        const { rerender } = rendered;
        unmount = rendered.unmount;
        await waitFor(() =>
          expect(viewerState.props?.targetViewport).toMatchObject({ start: 100_000, end: 102_000 })
        );
        act(() => {
          (viewerState.props?.onVisibleAnnotationTypesChange as (types: Set<string>) => void)(
            new Set()
          );
          (viewerState.props?.onAnnotationTrackOrderChange as (order: string[]) => void)([]);
          (viewerState.props?.onTargetViewportCommitted as (range: unknown) => void)(
            viewerState.props?.targetViewport
          );
        });
        const currentTab = () =>
          useCanvasStore.getState().panels.main.tabs.find((candidate) => candidate.id === tab.id)!;
        expect(currentTab().isDirty).toBe(false);

        const lane = laneFromIndexedGenomeDataTrack(track, 'grch38-test');
        act(() => {
          useLaneContractStore
            .getState()
            .addLane(
              tab.id,
              'grch38-test',
              lane.dataset,
              lane.visible,
              lane.source,
              lane.order,
              'skip'
            );
          restoring = false;
          rerender(<StoredIndexedGenomeTab entityId={tab.entityId} />);
        });
        await waitFor(() => expect(currentTab().isDirty).toBe(false));
        act(() => {
          useLaneContractStore
            .getState()
            .updateLanePresentation(tab.id, track.trackId, { label: 'Edited transcripts' });
        });
        await waitFor(() => expect(currentTab().isDirty).toBe(true));
      } finally {
        unmount();
        useLaneContractStore.getState().clearOwner(tab.id);
        dataRestore.mockRestore();
        bamRestore.mockRestore();
      }
    }
  );

  it('formats the coordinate field after restoring a portable view', async () => {
    const tab: Tab = {
      ...assemblyIndexedTab(),
      viewState: {
        indexedGenomeViewRestoreCommand: {
          id: 'restore-formatted-coordinate',
          viewport: { kind: 'assembly-range', start0: 100_000, end0: 102_000 },
          annotationPolicy: { isoformMode: 'canonical', laneLimit: null },
          visibleAnnotationTrackIds: [],
          orderedAnnotationTrackIds: [],
        },
      },
    };
    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitForSessionSubscription();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });

    await waitFor(() => {
      expect(viewerState.props?.targetViewport).toMatchObject({
        id: expect.any(Number),
        start: 100_000,
        end: 102_000,
      });
    });
    expect(screen.getByRole('textbox', { name: 'Go to coordinate' })).toHaveValue('100,001');
  });

  it('keeps the viewer mounted while surfacing request-time track errors', async () => {
    const tab = reopenIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitForSessionSubscription();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });

    await waitFor(() => {
      expect(viewerState.props).not.toBeNull();
    });

    act(() => {
      (
        viewerState.props?.onTrackError as
          | ((kind: 'sequence' | 'annotation', message: string) => void)
          | undefined
      )?.('sequence', 'Indexed genome file missing');
    });

    await waitFor(() => {
      expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
        'data-sequence-track-state',
        'error'
      );
    });
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-sequence-user-state',
      'Needs attention'
    );
    expect(screen.getByTestId('indexed-genome-viewer-mock')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't open chr11/i)).not.toBeInTheDocument();
  });

  it('keeps the coordinate viewer mounted and retains an annotation error across session updates', async () => {
    const tab = assemblyIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitForSessionSubscription();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });
    await waitFor(() => expect(viewerState.props).not.toBeNull());

    act(() => {
      (
        viewerState.props?.onTrackError as
          | ((kind: 'sequence' | 'annotation', message: string) => void)
          | undefined
      )?.(
        'annotation',
        'Cached reference data is present, but DNAForge could not load the annotation view.'
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
        'data-annotation-track-state',
        'error'
      )
    );
    expect(screen.getByTestId('indexed-genome-viewer-mock')).toBeInTheDocument();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', readySessionUpdate(tab.indexedGenome!));
    });
    expect(
      screen.getByTestId('indexed-genome-tab'),
      'a normal main-process session update must not erase a renderer-load failure'
    ).toHaveAttribute('data-annotation-track-state', 'error');
    expect(screen.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-annotation-user-state',
      'Needs attention'
    );
  });

  it('surfaces a sidecar build error in the error phase', async () => {
    const tab = freshIndexedTab();

    resetCanvasStore(tab);
    render(<IndexedGenomeTab tab={tab} />);

    await waitForSessionSubscription();
    act(() => {
      emitPlatformEvent('genome:sessionUpdated', {
        sessionId: 'session-chr11',
        prepareStatus: 'error',
        prepareLoadPhase: 'indexing',
        reusedExistingIndex: false,
        error: 'sidecar exploded',
        shell: {
          sessionId: 'session-chr11',
          sourcePath: '/workspace/chr11.gbff',
          sourceFingerprint: 'fingerprint-chr11',
          chrom: 'chr11',
          sourceSizeBytes: 140 * 1024 * 1024,
          coordinateReady: false,
          validationState: 'metadata_match',
          openedAt: 1,
          tracks: [
            {
              id: 'chr11:sequence',
              kind: 'sequence',
              label: 'Sequence',
              state: 'error',
              userState: 'Needs attention',
            },
          ],
        },
        tabState: {
          sourcePath: '/workspace/chr11.gbff',
          sourceSizeBytes: 140 * 1024 * 1024,
          sourceExt: 'gbff',
          chrom: 'chr11',
          error: 'sidecar exploded',
        },
      });
    });

    await waitFor(() => {
      const el = screen.getByTestId('indexed-genome-loading');
      expect(el.dataset.loadPhase).toBe('error');
    });
    expect(screen.getByText(/Couldn't open chr11/)).toBeInTheDocument();
    expect(screen.getByText(userMessage('tracks.loadFailed'))).toBeInTheDocument();
  });
});
