import { render, waitFor, act, screen, fireEvent, within } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { assemblyTotalLengthBp, type IndexedGenomeManifest } from '@waypoint/genome-data';
import {
  annotationCanonicalIdentityV2,
  COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
  type Feature,
} from '@waypoint/genome-renderer/pure';
import {
  assemblyAnnotationSceneInteractionOwnerKeyV3,
  type AssemblyAnnotationRasterReadResultV2,
} from '../../../shared/indexed-genome';
import type { AnnotationIndex } from '../genome-annotation-index';
import { buildGenomeAssembly, referenceAssemblyById } from '../reference-catalog';
import { resetRendererInteractionActivityForTest } from '../../../lib/renderer-interaction-activity';
import {
  ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET,
  ANNOTATION_VIEWPORT_TILE_REQUEST_MAX_BP,
} from './indexed-annotation-tile-policy';
import {
  SEQUENCE_WINDOW_PAD_BP,
  SEQUENCE_WINDOW_TARGET_BP,
} from './indexed-sequence-window-policy';
import { useAssemblyAnnotationRasterHandoff } from './useAssemblyAnnotationRaster';
import * as indexedPileupStreamingModule from './useIndexedPileupStreaming';

type IndexedGenomeViewerComponent = typeof import('./IndexedGenomeViewer').IndexedGenomeViewer;

const EXPECTED_SEQUENCE_WINDOW_BP = SEQUENCE_WINDOW_TARGET_BP + SEQUENCE_WINDOW_PAD_BP * 2;

const compatibilityWork = vi.hoisted(() => ({
  collapseIsoforms: 0,
  resolveViewportFeatures: 0,
  projectAnchorDensity: 0,
  buildViewportGlyphs: 0,
  buildAnchorGlyphs: 0,
  buildAssemblyGlyphs: 0,
  projectAssemblyLanes: 0,
  buildAssemblyScene: 0,
  adaptSceneToGenome: 0,
  fullSnapshotCandidates: 0,
}));

function resetCompatibilityWork(): void {
  for (const key of Object.keys(compatibilityWork) as Array<keyof typeof compatibilityWork>) {
    compatibilityWork[key] = 0;
  }
}

const {
  mockOpen,
  mockGetSession,
  mockClose,
  mockGetSequence,
  mockGetSequenceWindow,
  mockGetFeatures,
  mockGetFeatureDetails,
  mockGetTrackTile,
  mockGetAnnotationTile,
  mockReadAssemblyAnnotationRasterV2,
  mockReadAssemblyAnnotationProductSetInventoryV1,
  mockCancelRequest,
  mockUseCompiledBroadRasterSurface,
  mockUsePrepackedScene,
  mockUsePrepackedSceneDefault,
  mockUseCompactInteraction,
  mockHasPreparedPrepackedScene,
  webglState,
} = vi.hoisted(() => {
  const usePrepackedSceneDefault = (input: Record<string, unknown>) => {
    const cache = input.cache as
      | {
          status?: string;
          descriptor?: {
            artifact?: Record<string, unknown>;
            sceneVariant?: Record<string, unknown>;
          } | null;
        }
      | undefined;
    if (cache?.status === 'error') return 'error';
    const requested = input.requestedPolicy as Record<string, unknown> | undefined;
    const artifact = cache?.descriptor?.artifact;
    const legacyVariant = cache?.descriptor?.sceneVariant;
    if (!requested) return 'not-applicable';
    if (artifact) {
      return artifact.trackType === requested.trackType ? 'loaded-hit' : 'waiting-policy';
    }
    if (!legacyVariant) return 'not-applicable';
    return legacyVariant.trackType === requested.trackType &&
      legacyVariant.isoformMode === requested.isoformMode &&
      legacyVariant.laneLimit === requested.laneLimit
      ? 'loaded-hit'
      : 'waiting-policy';
  };
  return {
    mockOpen: vi.fn(),
    mockGetSession: vi.fn(),
    mockClose: vi.fn(),
    mockGetSequence: vi.fn(),
    mockGetSequenceWindow: vi.fn(),
    mockGetFeatures: vi.fn(),
    mockGetFeatureDetails: vi.fn(),
    mockGetTrackTile: vi.fn(),
    mockGetAnnotationTile: vi.fn(),
    mockReadAssemblyAnnotationRasterV2: vi.fn(),
    mockReadAssemblyAnnotationProductSetInventoryV1: vi.fn(),
    mockCancelRequest: vi.fn(),
    mockUseCompiledBroadRasterSurface: vi.fn(() => ({
      notifyCameraChanged: vi.fn(),
      refreshPolicy: vi.fn(),
      getDiagnostics: () => null,
      readiness: 'ready',
      policyControlsReadiness: 'ready',
    })),
    mockHasPreparedPrepackedScene: vi.fn(() => false),
    mockUsePrepackedSceneDefault: usePrepackedSceneDefault,
    mockUsePrepackedScene: vi.fn(usePrepackedSceneDefault),
    mockUseCompactInteraction: vi.fn(() => ({
      status: 'not-applicable',
      ownerKey: null,
      payloadBytes: null,
      startedAt: null,
      completedAt: null,
      error: null,
    })),
    webglState: {
      props: null as Record<string, unknown> | null,
      propsHistory: [] as Array<Record<string, unknown>>,
      viewportRange: { start: 1_000_000, end: 1_001_000 },
      cameraReadbackOffset: 0,
      cameraViewportRequests: [] as Array<{ start: number; end: number }>,
      centerBp: 1_000_500,
      handleState: {
        highlightRange: null as [number, number] | null,
        cursorPosition: null as number | null,
        proteinSearchHighlightRanges: null as ReadonlyArray<readonly [number, number]> | null,
      },
      rendererGenome: null as unknown,
      presentedFrameListeners: new Set<(receipt: { content: { genome: unknown } }) => void>(),
      rendererAnnotationSnapshot: null as unknown,
      suppressAnnotationPublications: false,
      requestRender: vi.fn(),
      schedulePostPresentWork: vi.fn<(work: (deadlineMs: number) => void) => void>(),
      linearRenderer: null as {
        loadPrebuiltGenomeWideTexture?: (...args: unknown[]) => void;
        commitPrebuiltGenomeWideTexturePolicy?: (...args: unknown[]) => boolean;
        clearPrebuiltGenomeWideTexture?: () => void;
        getRendererDebugSnapshot?: () => unknown;
        getColdGestureSnapshot?: (trackId: string) => unknown;
        loadGenome?: (genome: {
          sourceIdentity?: string;
          annotationSourcePlacementProvenance?: { sourceFingerprint?: string };
        }) => void;
        setAnnotationPresentationSnapshot?: (snapshot: unknown) => unknown;
        ingestAnnotationResidentPages?: (publication: unknown) => unknown;
        getPrepackedAnnotationSceneOwnerSnapshot?: () => unknown;
        getLaneContractRevision: () => number;
        preparePrepackedAnnotationFineViews?: (
          startBp: number,
          endBp: number
        ) => {
          status: 'outside-prewarm-corridor' | 'waiting-residents' | 'prepared' | 'complete';
          preparedOwnerKey: string | null;
          pendingOwnerCount: number;
        };
        setTrackStackEndReservePx?: (heightPx: number) => boolean;
        registerTrack?: (...args: unknown[]) => void;
        setAssembly?: (...args: unknown[]) => void;
        setChromosome?: (...args: unknown[]) => void;
        setTrackHitHandler?: (...args: unknown[]) => void;
        setTrackInstances?: (...args: unknown[]) => void;
        hasTrackData?: (...args: unknown[]) => boolean;
        setTrackData?: (...args: unknown[]) => void;
        hasTrackInstance?: (...args: unknown[]) => boolean;
      } | null,
    },
  };
});

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
let IndexedGenomeViewer: IndexedGenomeViewerComponent;

function physicallyReadyLinearRenderer() {
  return {
    getColdGestureSnapshot: () => ({
      annotation: {
        compiledBroadRasterVisible: true,
        compiledBroadRasterProvenanceValid: true,
        compiledBroadRasterPlanStatus: 'ready',
      },
    }),
    getLaneContractRevision: () => 0,
    registerTrack: vi.fn(),
    setAssembly: vi.fn(),
    setChromosome: vi.fn(),
    setTrackHitHandler: vi.fn(),
    setTrackInstances: vi.fn(),
    hasTrackData: () => true,
    setTrackData: vi.fn(),
    hasTrackInstance: () => true,
  };
}

vi.mock('../../../platform', () => ({
  platform: () => ({
    genome: {
      init: vi.fn(),
      open: mockOpen,
      getSession: mockGetSession,
      close: mockClose,
      getSequenceWindow: mockGetSequenceWindow,
      getSequence: mockGetSequence,
      getFeatures: mockGetFeatures,
      getFeatureDetails: mockGetFeatureDetails,
      getTrackTile: mockGetTrackTile,
      getAnnotationTile: mockGetAnnotationTile,
      readAssemblyAnnotationRasterV2: mockReadAssemblyAnnotationRasterV2,
      readAssemblyAnnotationProductSetInventoryV1: mockReadAssemblyAnnotationProductSetInventoryV1,
      cancelRequest: mockCancelRequest,
      searchSequence: vi.fn(),
    },
  }),
}));

vi.mock('./usePrepackedAssemblyAnnotationScene', () => ({
  usePrepackedAssemblyAnnotationScene: mockUsePrepackedScene,
  hasPreparedPrepackedAssemblyAnnotationScene: mockHasPreparedPrepackedScene,
  readActivePrepackedAnnotationSceneOwnerOracle: () => null,
}));

vi.mock('./useAssemblyCompiledBroadInteraction', () => ({
  useAssemblyCompiledBroadInteraction: mockUseCompactInteraction,
}));

vi.mock('./useAssemblyCompiledBroadRasterSurface', () => ({
  useAssemblyCompiledBroadRasterSurface: mockUseCompiledBroadRasterSurface,
}));

vi.mock('./useAnnotationPresentationSnapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useAnnotationPresentationSnapshot')>();
  return {
    ...actual,
    useAnnotationPresentationSnapshot: (
      candidate: Parameters<typeof actual.useAnnotationPresentationSnapshot>[0]
    ) => {
      if (candidate) compatibilityWork.fullSnapshotCandidates += 1;
      const publication = actual.useAnnotationPresentationSnapshot(candidate);
      return webglState.suppressAnnotationPublications ? undefined : publication;
    },
    useAnnotationResidentPagePublication: (
      candidate: Parameters<typeof actual.useAnnotationResidentPagePublication>[0]
    ) => {
      const publication = actual.useAnnotationResidentPagePublication(candidate);
      return webglState.suppressAnnotationPublications ? undefined : publication;
    },
  };
});

vi.mock('./isoform-collapse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./isoform-collapse')>();
  return {
    ...actual,
    collapseToCanonicalIsoforms: (
      ...args: Parameters<typeof actual.collapseToCanonicalIsoforms>
    ) => {
      compatibilityWork.collapseIsoforms += 1;
      return actual.collapseToCanonicalIsoforms(...args);
    },
  };
});

vi.mock('./indexed-genome-legacy-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./indexed-genome-legacy-adapter')>();
  return {
    ...actual,
    resolveAnnotationFeaturesForViewer: (
      ...args: Parameters<typeof actual.resolveAnnotationFeaturesForViewer>
    ) => {
      compatibilityWork.resolveViewportFeatures += 1;
      return actual.resolveAnnotationFeaturesForViewer(...args);
    },
    applyDensityControls: (...args: Parameters<typeof actual.applyDensityControls>) => {
      compatibilityWork.projectAnchorDensity += 1;
      return actual.applyDensityControls(...args);
    },
    buildAnnotationGlyphPayloadWithStableLanes: (
      ...args: Parameters<typeof actual.buildAnnotationGlyphPayloadWithStableLanes>
    ) => {
      compatibilityWork.buildViewportGlyphs += 1;
      return actual.buildAnnotationGlyphPayloadWithStableLanes(...args);
    },
    annotationSummaryGlyphPayloadFromRendererFeatures: (
      ...args: Parameters<typeof actual.annotationSummaryGlyphPayloadFromRendererFeatures>
    ) => {
      compatibilityWork.buildAnchorGlyphs += 1;
      return actual.annotationSummaryGlyphPayloadFromRendererFeatures(...args);
    },
    annotationGlyphPayloadFromRendererFeatures: (
      ...args: Parameters<typeof actual.annotationGlyphPayloadFromRendererFeatures>
    ) => {
      compatibilityWork.buildAssemblyGlyphs += 1;
      return actual.annotationGlyphPayloadFromRendererFeatures(...args);
    },
  };
});

vi.mock('./assembly-renderer-genome', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assembly-renderer-genome')>();
  return {
    ...actual,
    applyAssemblyRendererLaneControls: (
      ...args: Parameters<typeof actual.applyAssemblyRendererLaneControls>
    ) => {
      compatibilityWork.projectAssemblyLanes += 1;
      return actual.applyAssemblyRendererLaneControls(...args);
    },
    buildAssemblyAnnotationScene: (
      ...args: Parameters<typeof actual.buildAssemblyAnnotationScene>
    ) => {
      compatibilityWork.buildAssemblyScene += 1;
      return actual.buildAssemblyAnnotationScene(...args);
    },
  };
});

vi.mock('./indexed-genome-renderer-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./indexed-genome-renderer-adapter')>();
  return {
    ...actual,
    indexedGenomeSceneToRendererGenome: (
      ...args: Parameters<typeof actual.indexedGenomeSceneToRendererGenome>
    ) => {
      compatibilityWork.adaptSceneToGenome += 1;
      return actual.indexedGenomeSceneToRendererGenome(...args);
    },
  };
});

vi.mock('@waypoint/genome-renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@waypoint/genome-renderer')>();
  class MockIndexedPixiLinearRenderer extends actual.IndexedPixiLinearRenderer {
    static [Symbol.hasInstance](candidate: unknown): boolean {
      return (
        candidate === webglState.linearRenderer ||
        Function.prototype[Symbol.hasInstance].call(actual.IndexedPixiLinearRenderer, candidate)
      );
    }
  }
  return {
    ...actual,
    IndexedPixiLinearRenderer: MockIndexedPixiLinearRenderer,
  };
});

vi.mock('@waypoint/genome-renderer/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@waypoint/genome-renderer/react')>();
  return {
    ...actual,
    useIndexedPixiMap: (options: Record<string, unknown>) => {
      webglState.props = options;
      webglState.propsHistory.push(options);
      if (webglState.rendererGenome !== options.genome) {
        webglState.rendererGenome = options.genome;
        webglState.linearRenderer?.loadGenome?.(options.genome as { sourceIdentity?: string });
      }
      if (
        options.annotationPresentationSnapshot &&
        webglState.rendererAnnotationSnapshot !== options.annotationPresentationSnapshot
      ) {
        webglState.rendererAnnotationSnapshot = options.annotationPresentationSnapshot;
        webglState.linearRenderer?.setAnnotationPresentationSnapshot?.(
          options.annotationPresentationSnapshot
        );
      }
      if (
        options.annotationResidentPagePublication &&
        webglState.rendererAnnotationSnapshot !== options.annotationResidentPagePublication
      ) {
        webglState.rendererAnnotationSnapshot = options.annotationResidentPagePublication;
        webglState.linearRenderer?.ingestAnnotationResidentPages?.(
          options.annotationResidentPagePublication
        );
      }
      return {
        containerRef: { current: null },
        handle: {
          getState: () => webglState.handleState,
          getViewCenter: () => webglState.centerBp,
          getViewportRange: () => webglState.viewportRange,
          setViewCenter: (bp: number) => {
            webglState.centerBp = bp;
            (
              options.onCameraChange as
                | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
                | undefined
            )?.(bp, 'scroll');
          },
          setViewport: (start: number, end: number) => {
            webglState.viewportRange = { start, end };
          },
          setCameraViewport: (start: number, end: number) => {
            webglState.cameraViewportRequests.push({ start, end });
            webglState.viewportRange = {
              start: start + webglState.cameraReadbackOffset,
              end: end + webglState.cameraReadbackOffset,
            };
            webglState.centerBp = (start + end) / 2 + webglState.cameraReadbackOffset;
            (
              options.onCameraChange as
                | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
                | undefined
            )?.(webglState.centerBp, 'zoom');
            return webglState.viewportRange;
          },
          setDisplaySize: vi.fn(),
          setZoom: vi.fn(),
          requestRender: webglState.requestRender,
          schedulePostPresentWork: webglState.schedulePostPresentWork,
          subscribeToPresentedFrames: (
            listener: (receipt: { content: { genome: unknown } }) => void
          ) => {
            webglState.presentedFrameListeners.add(listener);
            return () => {
              webglState.presentedFrameListeners.delete(listener);
            };
          },
          getLinearRenderer: () => {
            const renderer = webglState.linearRenderer;
            if (renderer && !renderer.setTrackStackEndReservePx) {
              renderer.setTrackStackEndReservePx = vi.fn(() => true);
            }
            return renderer;
          },
        },
      };
    },
  };
});

function freshManifest(): IndexedGenomeManifest {
  return {
    workspaceRoot: '/workspace',
    indexDir: '/workspace/.waypoint/genome-index/chr11-test',
    chrom: 'chr11',
    fastaPath: 'chr11.fa',
    faiPath: 'chr11.fa.fai',
    gffPath: 'chr11.gff3.gz',
    gff3Path: 'chr11.gff3.gz',
    tbiPath: 'chr11.gff3.gz.tbi',
    sourcePath: '/workspace/chr11.gbff',
    indexedAt: '2026-05-11T00:00:00.000Z',
    chromosomes: [{ chrom: 'chr11', length: 135_000_000 }],
    topology: 'linear',
  } as IndexedGenomeManifest;
}

function manifestForChrom(chrom: string, length: number): IndexedGenomeManifest {
  return {
    ...freshManifest(),
    indexDir: `/workspace/.waypoint/genome-index/${chrom}-test`,
    chrom,
    fastaPath: `${chrom}.fa`,
    faiPath: `${chrom}.fa.fai`,
    gffPath: `${chrom}.gff3.gz`,
    gff3Path: `${chrom}.gff3.gz`,
    tbiPath: `${chrom}.gff3.gz.tbi`,
    sourcePath: `/workspace/${chrom}.gbff`,
    chromosomes: [{ chrom, length }],
  } as IndexedGenomeManifest;
}

function assemblySessionConfig(chrom: string, length: number) {
  const manifest = manifestForChrom(chrom, length);
  return {
    chrom,
    source: {
      sourcePath: manifest.gffPath as string,
      workspaceRoot: manifest.workspaceRoot,
      chrom,
      sourceExt: '.gz',
      intent: { kind: 'internal-assembly-segment' as const },
      manifest,
    },
    manifest,
  };
}

function fixturePrepackedSceneHitResult(
  descriptor: {
    sceneKey?: string;
    artifact?: { artifactKey?: string; trackType?: string };
    sceneVariant?: { trackType?: string };
  },
  fingerprint = 'abcdefabcdefabcdefabcdef'
) {
  const trackType = descriptor.artifact?.trackType ?? descriptor.sceneVariant?.trackType ?? 'mRNA';
  return {
    status: 'hit' as const,
    ipcContractVersion: 'assembly-annotation-scene-ipc.v4' as const,
    fingerprint,
    sourceBuildFingerprint: 'fixture-source-build',
    scope: { kind: 'complete-assembly' as const, placements: [] },
    artifact: {
      artifactKey:
        descriptor.artifact?.artifactKey ??
        `assembly-annotation-artifact.v3:${descriptor.sceneKey ?? trackType}`,
      themeMode: 'light' as const,
      trackType,
      partitionSpanBp: 1,
      annotationBarHeightPx: 14,
      laneAlgorithmToken: 'fixture-lane',
      mapperContractToken: 'fixture-mapper',
      geometryContractToken: 'fixture-geometry',
      interactionContractToken: 'fixture-interaction',
    },
    byteCount: 1,
    manifest: {
      integrity: {
        payloadSha256: '1'.repeat(64),
        contractSha256: '2'.repeat(64),
      },
    } as never,
    payload: new Uint8Array([1]),
  };
}

function fixturePrepackedSceneOwnerKey(
  descriptor: Parameters<typeof fixturePrepackedSceneHitResult>[0],
  fingerprint = 'abcdefabcdefabcdefabcdef'
): string {
  const result = fixturePrepackedSceneHitResult(descriptor, fingerprint);
  const ownerKey = assemblyAnnotationSceneInteractionOwnerKeyV3({
    sourceFingerprint: result.fingerprint,
    scenePayloadSha256: result.manifest.integrity.payloadSha256,
    sceneArtifactKey: result.artifact.artifactKey,
  });
  if (!ownerKey) throw new Error('fixture prepacked scene owner key is invalid');
  return ownerKey;
}

function fixtureReadyCompiledBroadSurface(
  descriptor: Parameters<typeof fixturePrepackedSceneHitResult>[0],
  fingerprint = 'abcdefabcdefabcdefabcdef'
) {
  const targetIdentityKey = `fixture-compiled-target:${descriptor.sceneKey ?? 'scene'}`;
  return {
    notifyCameraChanged: vi.fn(),
    refreshPolicy: vi.fn(),
    getDiagnostics: () => null,
    readiness: 'ready' as const,
    readinessTargetIdentityKey: targetIdentityKey,
    readinessRendererMatchesCurrent: true,
    targetIdentityKey,
    expectedInteractionOwnerKey: fixturePrepackedSceneOwnerKey(descriptor, fingerprint),
    policyControlsReadiness: 'ready' as const,
  };
}

function coordinateReadyShell(chrom: string, manifest: IndexedGenomeManifest) {
  return {
    sessionId: `session-${chrom}`,
    sourcePath: manifest.gffPath,
    sourceFingerprint: `${chrom}:fixture-fingerprint`,
    chrom,
    coordinateReady: true,
    length: manifest.chromosomes?.[0]?.length ?? 1,
    validationState: 'strong_match',
    openedAt: 0,
    manifest,
    tracks: [
      {
        id: `${chrom}:annotations`,
        kind: 'annotation',
        label: 'Annotations',
        state: 'coordinate_ready',
        userState: 'Preparing',
      },
    ],
  };
}

function summaryTile(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-chr11',
    requestId: 'annotation-overview-1',
    trackId: 'chr11:annotations',
    chrom: 'chr11',
    start: 0,
    end: 135_000_000,
    generation: 1,
    state: 'ready',
    fidelity: 'summary',
    validationState: 'metadata_match',
    featureModel: 'resolved-transcript-v2',
    cacheState: 'hit',
    byteCount: 96,
    recordCount: 1,
    sourceRecordCount: 5,
    layerTypes: ['gene', 'mRNA'],
    features: [
      {
        chrom: 'chr11',
        source: 'fixture',
        type: 'gene',
        start: 1_000_000,
        end: 1_001_000,
        score: null,
        strand: '+',
        phase: null,
        attributes: { ID: ['gene-1'], Name: ['GENE1'] },
        raw: '',
        transcripts: [
          {
            chrom: 'chr11',
            source: 'fixture',
            type: 'mRNA',
            start: 1_000_100,
            end: 1_000_900,
            score: null,
            strand: '+',
            phase: null,
            attributes: { ID: ['tx-1'], Parent: ['gene-1'] },
            raw: '',
          },
        ],
      },
    ],
    ...overrides,
  };
}

function smallSummaryTile() {
  const tile = summaryTile({ end: 20_000 });
  return {
    ...tile,
    features: tile.features.map((feature) => ({
      ...feature,
      start: 1_000,
      end: 2_000,
      transcripts: feature.transcripts?.map((transcript) => ({
        ...transcript,
        start: 1_100,
        end: 1_900,
      })),
    })),
  };
}

function buildingSummaryTile() {
  return summaryTile({
    state: 'building_summary',
    fidelity: 'best_available',
    recordCount: 0,
    features: [],
    message: 'Annotation summary is building in the background.',
  });
}

function sequenceWindowResponse(
  sessionId: string,
  request: { chrom: string; start: number; end: number; generation: number },
  requestId = 'sequence-window-test'
) {
  const byteCount = Math.max(0, request.end - request.start);
  return {
    sessionId,
    requestId,
    chrom: request.chrom,
    start: request.start,
    end: request.end,
    generation: request.generation,
    validationState: 'metadata_match',
    byteCount,
    bases: 'A'.repeat(byteCount),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function viewportAnnotationTileResponse(
  sessionId: string,
  request: { chrom: string; start: number; end: number; generation: number },
  requestId = 'annotation-viewport-test',
  options: {
    includeGene?: boolean;
    additionalType?: string;
    includeCodonCarrier?: boolean;
  } = {}
) {
  const center = Math.floor((request.start + request.end) / 2);
  const transcript = {
    chrom: request.chrom,
    source: 'fixture',
    type: 'mRNA',
    start: center - 400,
    end: center + 400,
    score: null,
    strand: '+',
    phase: null,
    attributes: { ID: ['exact-tx-1'], Name: ['EXACT1'] },
    raw: 'chr11\tfixture\tmRNA\t1\t900\t.\t+\t.\tID=exact-tx-1',
  };
  const features = [
    ...(options.includeGene
      ? [
          {
            ...transcript,
            type: 'gene',
            attributes: { ID: ['exact-gene-1'], Name: ['EXACT-GENE-1'] },
            raw: 'chr11\tfixture\tgene\t1\t900\t.\t+\t.\tID=exact-gene-1',
          },
        ]
      : []),
    transcript,
    ...(options.includeCodonCarrier
      ? [
          {
            ...transcript,
            type: 'CDS',
            start: center - 300,
            end: center + 300,
            phase: '0',
            attributes: {
              ID: ['exact-cds-1'],
              Parent: ['exact-tx-1'],
            },
            raw: 'chr11\tfixture\tCDS\t101\t700\t.\t+\t0\tID=exact-cds-1;Parent=exact-tx-1',
          },
        ]
      : []),
    ...(options.additionalType
      ? [
          {
            ...transcript,
            type: options.additionalType,
            attributes: {
              ID: [`exact-${options.additionalType}-1`],
              Name: [`EXACT-${options.additionalType}-1`],
            },
            raw: `chr11\tfixture\t${options.additionalType}\t1\t900\t.\t+\t.\tID=exact-${options.additionalType}-1`,
          },
        ]
      : []),
    ...(options.additionalType && options.includeCodonCarrier
      ? [
          {
            ...transcript,
            type: 'CDS',
            start: center - 250,
            end: center + 250,
            phase: '0',
            attributes: {
              ID: [`exact-${options.additionalType}-cds-1`],
              Parent: [`exact-${options.additionalType}-1`],
            },
            raw: `chr11\tfixture\tCDS\t151\t650\t.\t+\t0\tID=exact-${options.additionalType}-cds-1;Parent=exact-${options.additionalType}-1`,
          },
        ]
      : []),
  ];
  return summaryTile({
    sessionId,
    requestId,
    chrom: request.chrom,
    start: request.start,
    end: request.end,
    generation: request.generation,
    fidelity: 'best_available',
    featureModel: 'raw-gff3',
    cacheState: 'none',
    recordCount: features.length,
    sourceRecordCount: features.length,
    layerTypes: [
      'gene',
      'mRNA',
      'CDS',
      ...(options.additionalType ? [options.additionalType] : []),
    ],
    features,
  });
}

function emptyViewportAnnotationTileResponse(
  sessionId: string,
  request: { chrom: string; start: number; end: number; generation: number },
  requestId = 'annotation-viewport-empty-test'
) {
  return summaryTile({
    sessionId,
    requestId,
    chrom: request.chrom,
    start: request.start,
    end: request.end,
    generation: request.generation,
    fidelity: 'best_available',
    featureModel: 'raw-gff3',
    cacheState: 'none',
    recordCount: 0,
    sourceRecordCount: 0,
    layerTypes: [],
    features: [],
  });
}

function featureDetailsResponse() {
  return {
    chrom: 'chr11',
    featureId: 'tx-1',
    feature: {
      chrom: 'chr11',
      source: 'fixture',
      type: 'mRNA',
      start: 12_000,
      end: 78_000,
      score: null,
      strand: '+',
      phase: null,
      attributes: { ID: ['tx-1'], Parent: ['gene-1'], product: ['demo transcript'] },
      raw: '',
    },
    relatedFeatures: [
      {
        chrom: 'chr11',
        source: 'fixture',
        type: 'mRNA',
        start: 12_000,
        end: 78_000,
        score: null,
        strand: '+',
        phase: null,
        attributes: { ID: ['tx-1'], Parent: ['gene-1'] },
        raw: '',
      },
      {
        chrom: 'chr11',
        source: 'fixture',
        type: 'exon',
        start: 12_000,
        end: 12_400,
        score: null,
        strand: '+',
        phase: null,
        attributes: { Parent: ['tx-1'] },
        raw: '',
      },
    ],
    sourceRecordCount: 12,
    window: { start: 0, end: 100_000 },
    truncated: false,
  };
}

describe('IndexedGenomeViewer cold-start deferred load  perf regression)', () => {
  beforeAll(async () => {
    mockCanvasGetContext.mockReturnValue(canvasContext);
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: mockCanvasGetContext,
    });
    ({ IndexedGenomeViewer } = await import('./IndexedGenomeViewer'));
  }, 30_000);

  beforeEach(() => {
    resetRendererInteractionActivityForTest();
    mockCanvasGetContext.mockReset();
    mockCanvasGetContext.mockReturnValue(canvasContext);
    webglState.props = null;
    webglState.propsHistory = [];
    webglState.viewportRange = { start: 1_000_000, end: 1_001_000 };
    webglState.cameraReadbackOffset = 0;
    webglState.cameraViewportRequests = [];
    webglState.centerBp = 1_000_500;
    webglState.handleState.highlightRange = null;
    webglState.handleState.cursorPosition = null;
    webglState.handleState.proteinSearchHighlightRanges = null;
    webglState.rendererGenome = null;
    webglState.presentedFrameListeners.clear();
    webglState.rendererAnnotationSnapshot = null;
    webglState.suppressAnnotationPublications = false;
    webglState.requestRender.mockReset();
    webglState.schedulePostPresentWork.mockReset();
    webglState.linearRenderer = null;
    mockUseCompiledBroadRasterSurface.mockReset();
    mockUseCompiledBroadRasterSurface.mockReturnValue({
      notifyCameraChanged: vi.fn(),
      refreshPolicy: vi.fn(),
      getDiagnostics: () => null,
      readiness: 'ready',
      policyControlsReadiness: 'ready',
    });
    mockUsePrepackedScene.mockReset();
    mockUsePrepackedScene.mockImplementation(mockUsePrepackedSceneDefault);
    mockGetAnnotationTile.mockReset();
    mockUseCompactInteraction.mockReset();
    mockUseCompactInteraction.mockReturnValue({
      status: 'not-applicable',
      ownerKey: null,
      payloadBytes: null,
      startedAt: null,
      completedAt: null,
      error: null,
    });
    mockReadAssemblyAnnotationRasterV2.mockReset();
    mockReadAssemblyAnnotationProductSetInventoryV1.mockReset();
    mockReadAssemblyAnnotationProductSetInventoryV1.mockResolvedValue({
      status: 'ready',
      trackTypes: ['mRNA'],
    });
    mockHasPreparedPrepackedScene.mockReset();
    mockHasPreparedPrepackedScene.mockReturnValue(false);
    resetCompatibilityWork();
  });

  afterEach(() => {
    resetRendererInteractionActivityForTest();
    vi.unstubAllGlobals();
  });

  it.each(['light', 'dark'] as const)(
    'keeps cropped and full track surfaces on the same %s canvas background',
    async (themeMode) => {
      mockGetFeatures.mockResolvedValue([]);
      mockGetAnnotationTile.mockResolvedValue(summaryTile());
      mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
        sequenceWindowResponse(sessionId, request, requestId)
      );
      const view = render(
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={135_000_000}
          sessionId="background-session"
          themeMode={themeMode}
        />
      );
      try {
        const viewer = await screen.findByTestId('indexed-genome-viewer');
        expect(viewer).toHaveStyle({
          backgroundColor: themeMode === 'dark' ? '#1e1c1a' : '#ffffff',
        });
        expect(viewer.style.getPropertyValue('--indexed-viewer-track-background')).toBe(
          themeMode === 'dark' ? '#1e1c1a' : '#ffffff'
        );
        expect(screen.getByTestId('track-gutter')).toHaveClass(
          'bg-[var(--indexed-viewer-track-background,hsl(var(--color-bg)))]'
        );
        expect(webglState.props?.themeMode).toBe(themeMode);
      } finally {
        view.unmount();
      }
    }
  );

  it('does NOT call getFeatures/getSequenceWindow on mount when isActive=false', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequence.mockResolvedValue('');
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const { unmount } = render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
        isActive={false}
      />
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(mockGetFeatures).not.toHaveBeenCalled();
    expect(mockGetTrackTile).not.toHaveBeenCalled();
    expect(mockGetAnnotationTile).not.toHaveBeenCalled();
    expect(mockGetSequence).not.toHaveBeenCalled();
    expect(mockGetSequenceWindow).not.toHaveBeenCalled();
  });

  it('keeps the viewport test bridge on the active indexed tab when both tabs stay mounted', async () => {
    const target = window as Window & {
      __test?: { workspaceViewer?: { getSequenceLength: () => number } };
    };
    const previousTestBridge = target.__test;
    target.__test = { workspaceViewer: { getSequenceLength: () => 999_000_000 } };
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    const firstManifest = freshManifest();
    const secondManifest = manifestForChrom('chr1', 270_000_000);
    const tabs = (active: 'first' | 'second') => (
      <>
        <IndexedGenomeViewer
          laneOwnerId="first"
          manifest={firstManifest}
          length={135_000_000}
          sessionId="session-first"
          isActive={active === 'first'}
        />
        <IndexedGenomeViewer
          laneOwnerId="second"
          manifest={secondManifest}
          length={270_000_000}
          sessionId="session-second"
          isActive={active === 'second'}
        />
      </>
    );

    try {
      const view = render(tabs('first'));
      await waitFor(() =>
        expect(target.__test?.workspaceViewer?.getSequenceLength()).toBe(135_000_000)
      );
      view.rerender(tabs('second'));
      await waitFor(() =>
        expect(target.__test?.workspaceViewer?.getSequenceLength()).toBe(270_000_000)
      );
      view.rerender(tabs('first'));
      await waitFor(() =>
        expect(target.__test?.workspaceViewer?.getSequenceLength()).toBe(135_000_000)
      );
      view.unmount();
      expect(target.__test?.workspaceViewer).toBeUndefined();
    } finally {
      target.__test = previousTestBridge;
    }
  });

  it('sizes the WebGL map from the canvas host after status rows change the available height', async () => {
    let canvasHostHeight = 444;
    const observed = new Map<Element, ResizeObserverCallback>();
    vi.stubGlobal(
      'ResizeObserver',
      class TestResizeObserver {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element): void {
          observed.set(target, this.callback);
          this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        disconnect(): void {}
        unobserve(): void {}
      }
    );
    const heightSpy = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function () {
        if (this.dataset.testid === 'indexed-genome-canvas-host') return canvasHostHeight;
        if (this.dataset.testid === 'indexed-genome-visible-viewer') return 777;
        return 0;
      });
    const widthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function () {
        return this.dataset.testid === 'indexed-genome-canvas-host' ? 900 : 0;
      });
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );

    try {
      render(
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={135_000_000}
          sessionId="session-chr11"
        />
      );
      const host = await screen.findByTestId('indexed-genome-canvas-host');
      const map = screen.getByTestId('indexed-genome-webgl-map');
      expect(host).toHaveClass('overflow-hidden');
      expect(map).toHaveClass('[&>canvas]:max-h-full');
      expect(map).toHaveStyle({ maxHeight: '100%', maxWidth: '100%' });
      await waitFor(() => expect(webglState.props?.height).toBe(444));

      canvasHostHeight = 333;
      act(() => {
        observed.get(host)?.([{ target: host } as ResizeObserverEntry], {} as ResizeObserver);
      });
      await waitFor(() => expect(webglState.props?.height).toBe(333));
    } finally {
      heightSpy.mockRestore();
      widthSpy.mockRestore();
    }
  });

  it('keeps a first summary-tile failure fatal when no local viewer owner has presented', async () => {
    mockGetFeatures.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockReset();
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockReset();
    mockGetAnnotationTile.mockRejectedValue(new Error('Initial summary tile failed'));
    mockGetSequence.mockReset();
    mockGetSequence.mockResolvedValue('');
    mockGetSequenceWindow.mockReset();
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const onLoadPhase = vi.fn();
    const onTrackError = vi.fn();

    const { unmount } = render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
        onLoadPhase={onLoadPhase}
        onTrackError={onTrackError}
      />
    );

    await waitFor(() =>
      expect(onLoadPhase).toHaveBeenCalledWith('error', 'Initial summary tile failed')
    );
    expect(onLoadPhase.mock.calls.at(-1)).toEqual(['error', 'Initial summary tile failed']);
    expect(onTrackError).not.toHaveBeenCalled();
    expect(screen.getByTestId('indexed-genome-viewer-deferred')).toBeInTheDocument();
    expect(screen.queryByTestId('indexed-genome-webgl-map')).not.toBeInTheDocument();
  });

  it('keeps the durable genome, visibility, and lane publication unchanged for every hidden-track focus', async () => {
    const lncTranscript = (id: string, start: number) => ({
      chrom: 'chr11',
      source: 'fixture',
      type: 'ncRNA',
      start,
      end: start + 300,
      score: null,
      strand: '+' as const,
      phase: null,
      attributes: {
        ID: [id],
        Name: [id],
        ncRNA_class: ['lncRNA'],
      },
      raw: '',
      transcriptId: id,
      exons: [{ start, end: start + 300 }],
      cds: [],
    });
    const tile = summaryTile({
      recordCount: 2,
      sourceRecordCount: 2,
      layerTypes: ['lncRNA'],
      features: [lncTranscript('LNC-FIRST', 1_000_100), lncTranscript('LNC-SECOND', 1_000_500)],
    });
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(tile);
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const loadGenome = vi.fn();
    webglState.linearRenderer = {
      loadGenome,
      getLaneContractRevision: () => 0,
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setChromosome: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn(),
      hasTrackData: () => true,
      setTrackData: vi.fn(),
      hasTrackInstance: () => true,
    };
    let annotationIndex: AnnotationIndex | null = null;
    const baseProps = {
      manifest: freshManifest(),
      length: 135_000_000,
      sessionId: 'session-chr11',
      onAnnotationIndexBuilt: (next: AnnotationIndex | null) => {
        annotationIndex = next;
      },
    };
    const view = render(<IndexedGenomeViewer {...baseProps} />);

    try {
      await screen.findByTestId('indexed-genome-webgl-map');
      await waitFor(() => expect(annotationIndex).not.toBeNull());
      const firstMatch = annotationIndex?.query('LNC-FIRST')[0];
      const secondMatch = annotationIndex?.query('LNC-SECOND')[0];
      expect(firstMatch).toBeDefined();
      expect(secondMatch).toBeDefined();
      if (!firstMatch || !secondMatch) throw new Error('hidden-track search fixture did not index');

      const highlight = (id: number, match: typeof firstMatch) => ({
        id,
        start: match.start,
        end: match.end,
        featureType: match.featureType,
        annotationTrackId: match.annotationTrackId,
        canonicalIdentity: match.canonicalIdentity,
        annotationFeatureIndex: match.featureIndex,
      });
      const durableGenome = webglState.props?.genome;
      const durableLayerTypes = [
        ...(((durableGenome as { annotationLayerTypes?: ReadonlyArray<string> } | undefined)
          ?.annotationLayerTypes ?? []) as ReadonlyArray<string>),
      ];
      const durablePublication = webglState.props?.annotationResidentPagePublication as
        | { requestedLayerTypes?: ReadonlyArray<string> }
        | undefined;
      const loadCountBeforeTemporaryReveal = loadGenome.mock.calls.length;
      view.rerender(
        <IndexedGenomeViewer {...baseProps} searchHighlight={highlight(1, firstMatch)} />
      );
      await waitFor(() =>
        expect(webglState.props?.annotationSearchFocus).toEqual({
          trackId: 'lncRNA',
          canonicalIdentity: firstMatch.canonicalIdentity,
        })
      );
      expect(webglState.props?.annotationSearchFocusFeature).toMatchObject({
        annotationTrackId: 'lncRNA',
        canonicalIdentity: firstMatch.canonicalIdentity,
        displayName: 'LNC-FIRST',
      });
      expect(screen.getByText('Selected annotation from hidden lncRNA track')).toBeVisible();
      expect(screen.getByLabelText('Show lncRNA track')).toBeVisible();
      expect(webglState.props?.genome).toBe(durableGenome);
      expect(
        (webglState.props?.genome as { annotationLayerTypes?: ReadonlyArray<string> } | undefined)
          ?.annotationLayerTypes
      ).toEqual(durableLayerTypes);
      expect(webglState.props?.annotationResidentPagePublication).toBe(durablePublication);
      expect(loadGenome).toHaveBeenCalledTimes(loadCountBeforeTemporaryReveal);

      fireEvent.click(screen.getByTestId('annotation-type-picker-summary'));
      const lncRnaToggle = await screen.findByTestId('annotation-type-lncRNA');
      expect(lncRnaToggle).toHaveAttribute('aria-pressed', 'false');

      const temporaryGenome = webglState.props?.genome;
      const loadsAfterTemporaryReveal = loadGenome.mock.calls.length;
      const requestsAfterTemporaryReveal = mockGetAnnotationTile.mock.calls.length;

      view.rerender(
        <IndexedGenomeViewer {...baseProps} searchHighlight={highlight(2, secondMatch)} />
      );
      await waitFor(() =>
        expect(webglState.props?.annotationSearchFocus).toEqual({
          trackId: 'lncRNA',
          canonicalIdentity: secondMatch.canonicalIdentity,
        })
      );
      expect(webglState.props?.annotationSearchFocusFeature).toMatchObject({
        annotationTrackId: 'lncRNA',
        canonicalIdentity: secondMatch.canonicalIdentity,
        displayName: 'LNC-SECOND',
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(webglState.props?.genome).toBe(temporaryGenome);
      expect(loadGenome).toHaveBeenCalledTimes(loadsAfterTemporaryReveal);
      expect(mockGetAnnotationTile).toHaveBeenCalledTimes(requestsAfterTemporaryReveal);

      view.rerender(<IndexedGenomeViewer {...baseProps} searchHighlight={null} />);
      await waitFor(() => {
        expect(webglState.props?.annotationSearchFocus).toBeNull();
        expect(webglState.props?.annotationSearchFocusFeature).toBeNull();
      });
      expect(screen.queryByText('Selected annotation from hidden lncRNA track')).toBeNull();
      expect(lncRnaToggle).toHaveAttribute('aria-pressed', 'false');

      view.rerender(
        <IndexedGenomeViewer {...baseProps} searchHighlight={highlight(3, secondMatch)} />
      );
      await waitFor(() => expect(screen.getByLabelText('Show lncRNA track')).toBeVisible());
      fireEvent.click(screen.getByLabelText('Show lncRNA track'));
      await waitFor(() => {
        expect(screen.queryByText('Selected annotation from hidden lncRNA track')).toBeNull();
        expect(webglState.props?.annotationSearchFocus).toEqual({
          trackId: 'lncRNA',
          canonicalIdentity: secondMatch.canonicalIdentity,
          presentation: 'temporary-additional-lane',
        });
        expect(webglState.props?.annotationSearchFocusFeature).toMatchObject({
          annotationTrackId: 'lncRNA',
          canonicalIdentity: secondMatch.canonicalIdentity,
          displayName: 'LNC-SECOND',
        });
        expect(screen.queryByTestId('track-gutter-visible-annotation-search-focus')).toBeNull();
        expect(lncRnaToggle).toHaveAttribute('aria-pressed', 'true');
      });

      view.rerender(<IndexedGenomeViewer {...baseProps} searchHighlight={null} />);
      await waitFor(() => {
        expect(webglState.props?.annotationSearchFocus).toBeNull();
        expect(webglState.props?.annotationSearchFocusFeature).toBeNull();
      });
      expect(lncRnaToggle).toHaveAttribute('aria-pressed', 'true');
      expect(
        (webglState.props?.genome as { annotationLayerTypes?: ReadonlyArray<string> } | undefined)
          ?.annotationLayerTypes
      ).toContain('lncRNA');
    } finally {
      view.unmount();
      webglState.linearRenderer = null;
      mockGetFeatures.mockReset();
      mockGetAnnotationTile.mockReset();
      mockGetSequenceWindow.mockReset();
    }
  });

  it('presents a sequence-only genome from the empty annotation tile main returns', async () => {
    mockGetFeatures.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockReset();
    mockGetAnnotationTile.mockResolvedValue(
      summaryTile({ state: 'empty', features: [], recordCount: 0, sourceRecordCount: 0 })
    );
    mockGetSequence.mockReset();
    mockGetSequence.mockResolvedValue('');
    mockGetSequenceWindow.mockReset();
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const onLoadPhase = vi.fn();
    const sequenceOnly = {
      ...freshManifest(),
      gffPath: undefined,
      gff3Path: undefined,
      tbiPath: undefined,
      sourcePath: '/workspace/chr11.fa',
    } as IndexedGenomeManifest;

    const { unmount } = render(
      <IndexedGenomeViewer
        manifest={sequenceOnly}
        length={135_000_000}
        sessionId="session-chr11"
        onLoadPhase={onLoadPhase}
      />
    );

    await waitFor(() => expect(onLoadPhase).toHaveBeenCalledWith('ready'));
    expect(onLoadPhase).not.toHaveBeenCalledWith('error', expect.anything());
    unmount();
    for (const mock of [
      mockGetFeatures,
      mockGetAnnotationTile,
      mockGetSequence,
      mockGetSequenceWindow,
    ]) {
      mock.mockClear();
    }
  });

  it('requests a chromosome overview summary tile once isActive transitions to true', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequence.mockResolvedValue('');
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const { rerender } = render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
        isActive={false}
      />
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(mockGetFeatures).not.toHaveBeenCalled();
    expect(mockGetTrackTile).not.toHaveBeenCalled();
    expect(mockGetAnnotationTile).not.toHaveBeenCalled();

    rerender(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
        isActive={true}
      />
    );
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalled());
    expect(mockGetFeatures).not.toHaveBeenCalled();
    expect(mockGetAnnotationTile.mock.calls[0][0]).toBe('session-chr11');
    expect(mockGetAnnotationTile.mock.calls[0][1]).toMatchObject({
      chrom: 'chr11',
      start: 0,
      end: 135_000_000,
      lod: 0,
      fidelity: 'summary',
    });
    expect(mockGetTrackTile).not.toHaveBeenCalled();
    expect(mockGetAnnotationTile).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-trigger a load when isActive flips back to false after first activation', async () => {
    mockGetFeatures.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockReset();
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockReset();
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequence.mockResolvedValue('');
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const manifest = freshManifest();

    const { rerender } = render(
      <IndexedGenomeViewer
        manifest={manifest}
        length={135_000_000}
        sessionId="session-chr11"
        isActive={true}
      />
    );
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalledTimes(1));

    rerender(
      <IndexedGenomeViewer
        manifest={manifest}
        length={135_000_000}
        sessionId="session-chr11"
        isActive={false}
      />
    );
    rerender(
      <IndexedGenomeViewer
        manifest={manifest}
        length={135_000_000}
        sessionId="session-chr11"
        isActive={true}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(mockGetTrackTile).not.toHaveBeenCalled();
    expect(mockGetAnnotationTile).toHaveBeenCalledTimes(1);
    expect(mockGetFeatures).not.toHaveBeenCalled();
  });

  it('loads annotation overview when isActive defaults to true (callers that omit the prop)', async () => {
    mockGetFeatures.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockReset();
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockReset();
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequence.mockResolvedValue('');
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
      />
    );
    await waitFor(() => expect(mockGetAnnotationTile).toHaveBeenCalled());
    expect(await screen.findByLabelText('Max lanes')).toHaveValue('2');
    expect(mockGetTrackTile).not.toHaveBeenCalled();
    expect(mockGetFeatures).not.toHaveBeenCalled();
  });

  it('renders and updates the controlled mapper policy used by the parent cache', async () => {
    mockGetFeatures.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockReset();
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockReset();
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequence.mockResolvedValue('');
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const onAnnotationMapperPolicyChange = vi.fn();

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
        annotationMapperPolicy={{ isoformMode: 'expanded', laneLimit: 8 }}
        onAnnotationMapperPolicyChange={onAnnotationMapperPolicyChange}
      />
    );

    expect(await screen.findByRole('button', { name: '✓ All isoforms' })).toBeVisible();
    expect(screen.getByLabelText('Max lanes')).toHaveValue('8');

    fireEvent.click(screen.getByRole('button', { name: '✓ All isoforms' }));
    expect(onAnnotationMapperPolicyChange).toHaveBeenCalledWith({
      isoformMode: 'canonical',
      laneLimit: 8,
    });

    const lanePicker = screen.getByLabelText('Max lanes');
    fireEvent.change(lanePicker, { target: { value: '16' } });
    fireEvent.keyDown(lanePicker, { key: 'Enter' });
    expect(onAnnotationMapperPolicyChange).toHaveBeenCalledWith({
      isoformMode: 'expanded',
      laneLimit: 16,
    });
  });

  it('does not eager-load whole sequence bytes for small indexed sources', async () => {
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(smallSummaryTile());
    mockGetAnnotationTile.mockResolvedValue(smallSummaryTile());
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    const debugWindow = window as Window & {
      __webglExposeForTests?: boolean;
      __indexedGenomeViewerDebug?: {
        invariantViolations?: Array<{ invariant: string; message: string }>;
        compiledBroadRasterLoaderDiagnostics?: {
          contract: string;
          readiness: string;
        } | null;
      };
    };
    debugWindow.__webglExposeForTests = true;

    try {
      render(
        <IndexedGenomeViewer manifest={freshManifest()} length={20_000} sessionId="session-chr11" />
      );

      await waitFor(() => expect(screen.getByTestId('indexed-genome-webgl-map')).toBeTruthy());
      expect(mockGetAnnotationTile).toHaveBeenCalledTimes(1);
      expect(mockGetSequenceWindow).not.toHaveBeenCalled();
      expect(mockGetSequence).not.toHaveBeenCalled();
      expect(debugWindow.__indexedGenomeViewerDebug?.invariantViolations ?? []).toEqual([]);
      expect(
        debugWindow.__indexedGenomeViewerDebug?.compiledBroadRasterLoaderDiagnostics
      ).toBeNull();
    } finally {
      delete debugWindow.__webglExposeForTests;
      delete debugWindow.__indexedGenomeViewerDebug;
    }
  });

  it('renders a continuous overview with annotation marks instead of a visible tile range', async () => {
    mockGetFeatures.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockReset();
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockReset();
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequence.mockResolvedValue('');
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId('indexed-genome-webgl-map')).toHaveAttribute(
        'data-feature-count',
        '1'
      );
    });
    expect(screen.getByTestId('indexed-genome-viewer')).toHaveAttribute(
      'data-viewer-mode',
      'continuous-overview'
    );
    expect(screen.queryByTestId('indexed-genome-track-annotation-range')).toBeNull();
    expect(mockGetFeatures).not.toHaveBeenCalled();
  });

  it('publishes a tile-native scene debug contract without feature payloads', async () => {
    mockGetFeatures.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockReset();
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockReset();
    mockGetAnnotationTile.mockResolvedValue(summaryTile({ byteCount: 256 }));
    mockGetSequence.mockResolvedValue('');
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const debugWindow = window as unknown as {
      __webglExposeForTests?: boolean;
      __indexedGenomeViewerDebug?: {
        scene?: {
          mode: string;
          sessionId: string;
          tileSlots: Array<{ trackId: string; recordCount: number; currentForViewport: boolean }>;
        };
        sceneHasWholeFeaturePayload?: boolean;
        sceneInvariant?: {
          ok: boolean;
          currentTileSlots: number;
          retainedTileSlots: number;
          violations: string[];
        };
        rendererGenomeSummary?: {
          name: string;
          length: number;
          featureCount: number;
          sequenceWindowBp: number;
          hasWholeSequence: boolean;
        };
      };
    };
    debugWindow.__webglExposeForTests = true;
    try {
      render(
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={135_000_000}
          sessionId="session-chr11"
        />
      );
      await waitFor(() => expect(debugWindow.__indexedGenomeViewerDebug?.scene).toBeTruthy());

      expect(debugWindow.__indexedGenomeViewerDebug?.scene).toMatchObject({
        mode: 'tile-native-session-shell',
        sessionId: 'session-chr11',
      });
      expect(debugWindow.__indexedGenomeViewerDebug?.scene?.tileSlots).toEqual([
        expect.objectContaining({
          trackId: 'chr11:annotations',
          recordCount: 1,
          currentForViewport: true,
        }),
      ]);
      expect(debugWindow.__indexedGenomeViewerDebug?.sceneHasWholeFeaturePayload).toBe(false);
      expect(debugWindow.__indexedGenomeViewerDebug?.sceneInvariant).toMatchObject({
        ok: true,
        currentTileSlots: 1,
        retainedTileSlots: 0,
        violations: [],
      });
      expect(debugWindow.__indexedGenomeViewerDebug?.rendererGenomeSummary).toMatchObject({
        name: 'chr11',
        length: 135_000_000,
        featureCount: 1,
        sequenceWindowBp: 0,
        hasWholeSequence: false,
      });
      expect(screen.queryByTestId('genome-session-scene-canvas')).toBeNull();
      expect(screen.getByTestId('indexed-genome-visible-viewer')).toBeTruthy();
      expect(screen.getByTestId('indexed-genome-webgl-map')).toBeTruthy();
      expect(mockGetFeatures).not.toHaveBeenCalled();
    } finally {
      delete debugWindow.__webglExposeForTests;
      delete debugWindow.__indexedGenomeViewerDebug;
    }
  });

  it('publishes row-local pending slots while sequence and annotation viewport requests are unresolved', async () => {
    mockGetFeatures.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockReset();
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockReset();
    const pendingAnnotationTile =
      createDeferred<ReturnType<typeof viewportAnnotationTileResponse>>();
    let pendingAnnotationRequest: {
      sessionId: string;
      request: Parameters<typeof viewportAnnotationTileResponse>[1];
    } | null = null;
    mockGetAnnotationTile.mockImplementation((sessionId, request, requestId) => {
      if (request.start === 0) return Promise.resolve(summaryTile());
      pendingAnnotationRequest = { sessionId, request };
      return pendingAnnotationTile.promise.then(() =>
        viewportAnnotationTileResponse(sessionId, request, requestId)
      );
    });
    mockGetSequence.mockResolvedValue('');
    mockGetSequenceWindow.mockReset();
    const pendingSequenceWindow = createDeferred<ReturnType<typeof sequenceWindowResponse>>();
    let pendingSequenceRequest: {
      sessionId: string;
      request: Parameters<typeof sequenceWindowResponse>[1];
    } | null = null;
    mockGetSequenceWindow.mockImplementation((sessionId, request, requestId) => {
      pendingSequenceRequest = { sessionId, request };
      return pendingSequenceWindow.promise.then(() =>
        sequenceWindowResponse(sessionId, request, requestId)
      );
    });
    const debugWindow = window as unknown as {
      __webglExposeForTests?: boolean;
      __indexedGenomeViewerDebug?: {
        scene?: {
          tracks: Array<{ kind: string; state: string }>;
          tileSlots: Array<{
            kind: string;
            state: string;
            currentForViewport: boolean;
            startBp: number;
            endBp: number;
          }>;
        };
        sceneInvariant?: { ok: boolean; violations: string[] };
        invariantViolations?: Array<{ invariant: string; message: string }>;
        rendererGenomeSummary?: {
          featureCount: number;
          sequenceWindowBp: number;
          hasWholeSequence: boolean;
        };
      };
    };
    debugWindow.__webglExposeForTests = true;
    webglState.viewportRange = { start: 1_000_000, end: 1_001_000 };
    webglState.centerBp = 1_000_500;

    try {
      render(
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={135_000_000}
          sessionId="session-chr11"
        />
      );
      await waitFor(() => expect(screen.getByTestId('indexed-genome-webgl-map')).toBeTruthy());

      const onCameraChange = webglState.props?.onCameraChange as
        | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
        | undefined;
      expect(onCameraChange).toBeTypeOf('function');

      act(() => {
        onCameraChange?.(1_000_500, 'zoom');
      });

      await waitFor(() => {
        expect(pendingAnnotationRequest).not.toBeNull();
        expect(pendingSequenceRequest).not.toBeNull();
        expect(debugWindow.__indexedGenomeViewerDebug?.scene?.tileSlots).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'sequence',
              state: 'loading',
              currentForViewport: true,
            }),
            expect.objectContaining({
              kind: 'annotation',
              state: 'loading',
              currentForViewport: true,
            }),
          ])
        );
      });
      expect(debugWindow.__indexedGenomeViewerDebug?.scene?.tracks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'sequence', state: 'building_cache' }),
          expect.objectContaining({ kind: 'annotation', state: 'building_cache' }),
        ])
      );
      expect(debugWindow.__indexedGenomeViewerDebug?.sceneInvariant).toMatchObject({
        ok: true,
        violations: [],
      });

      await act(async () => {
        pendingSequenceWindow.resolve(
          sequenceWindowResponse(pendingSequenceRequest!.sessionId, pendingSequenceRequest!.request)
        );
        pendingAnnotationTile.resolve(
          viewportAnnotationTileResponse(
            pendingAnnotationRequest!.sessionId,
            pendingAnnotationRequest!.request
          )
        );
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(debugWindow.__indexedGenomeViewerDebug?.scene?.tileSlots).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'sequence', state: 'ready' }),
            expect.objectContaining({ kind: 'annotation', state: 'ready' }),
          ])
        );
      });
      await waitFor(() => {
        expect(debugWindow.__indexedGenomeViewerDebug?.rendererGenomeSummary).toMatchObject({
          featureCount: 1,
          sequenceWindowBp: EXPECTED_SEQUENCE_WINDOW_BP,
          hasWholeSequence: false,
        });
      });
      expect(debugWindow.__indexedGenomeViewerDebug?.invariantViolations ?? []).toEqual([]);
      expect(
        debugWindow.__indexedGenomeViewerDebug?.scene?.tileSlots.some(
          (slot) => slot.state === 'loading'
        )
      ).toBe(false);
    } finally {
      delete debugWindow.__webglExposeForTests;
      delete debugWindow.__indexedGenomeViewerDebug;
    }
  });

  it('requests visible sequence through the session-scoped genome API on camera changes', async () => {
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    webglState.viewportRange = { start: 1_000_000, end: 1_001_000 };
    webglState.centerBp = 1_000_500;

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
      />
    );
    await waitFor(() => expect(screen.getByTestId('indexed-genome-webgl-map')).toBeTruthy());

    const onCameraChange = webglState.props?.onCameraChange as
      | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
      | undefined;
    expect(onCameraChange).toBeTypeOf('function');

    act(() => {
      onCameraChange?.(1_000_500, 'zoom');
    });

    await waitFor(() => expect(mockGetSequenceWindow).toHaveBeenCalledTimes(1));
    expect(mockGetSequence).not.toHaveBeenCalled();
    expect(mockGetSequenceWindow.mock.calls[0][0]).toBe('session-chr11');
    expect(mockGetSequenceWindow.mock.calls[0][1]).toMatchObject({
      chrom: 'chr11',
      generation: expect.any(Number),
    });
    const request = mockGetSequenceWindow.mock.calls[0][1] as { start: number; end: number };
    expect(request.start).toBeGreaterThanOrEqual(0);
    expect(request.end).toBeLessThanOrEqual(135_000_000);
    expect(request.end - request.start).toBeLessThanOrEqual(EXPECTED_SEQUENCE_WINDOW_BP);
    expect(mockGetSequenceWindow.mock.calls[0][2]).toMatch(/^sequence-window-/);
    await waitFor(() => {
      const sequenceWindow = webglState.props?.sequenceWindow as
        | { startBp: number; bases: string }
        | undefined;
      expect(sequenceWindow?.startBp).toBe(request.start);
      expect(sequenceWindow?.bases.length).toBe(request.end - request.start);
    });
    expect(
      (webglState.props?.genome as { sequenceWindow?: unknown } | undefined)?.sequenceWindow
    ).toBeUndefined();
  });

  it('prepares every pending annotation fine view after presentation and redraws once', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    const prepareFineViews = vi
      .fn()
      .mockReturnValueOnce({
        status: 'prepared',
        preparedOwnerKey: 'mRNA-owner',
        pendingOwnerCount: 1,
      })
      .mockReturnValueOnce({
        status: 'complete',
        preparedOwnerKey: 'enhancer-owner',
        pendingOwnerCount: 0,
      });
    webglState.linearRenderer = {
      ...physicallyReadyLinearRenderer(),
      preparePrepackedAnnotationFineViews: prepareFineViews,
    };
    webglState.viewportRange = { start: 1_000_000, end: 1_000_000 + 512 * 1024 };

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
      />
    );
    await waitFor(() => expect(screen.getByTestId('indexed-genome-webgl-map')).toBeTruthy());
    const onCameraChange = webglState.props?.onCameraChange as
      | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
      | undefined;

    act(() => onCameraChange?.(1_262_144, 'zoom'));
    expect(webglState.schedulePostPresentWork).toHaveBeenCalled();
    const work = webglState.schedulePostPresentWork.mock.lastCall?.[0];
    expect(work).toBeTypeOf('function');
    const renderRequestsBeforePreparation = webglState.requestRender.mock.calls.length;
    act(() => work?.(Number.POSITIVE_INFINITY));

    expect(prepareFineViews).toHaveBeenNthCalledWith(
      1,
      1_000_000,
      1_524_288,
      undefined,
      Number.POSITIVE_INFINITY
    );
    expect(prepareFineViews).toHaveBeenNthCalledWith(
      2,
      1_000_000,
      1_524_288,
      undefined,
      Number.POSITIVE_INFINITY
    );
    expect(webglState.requestRender.mock.calls.length).toBe(renderRequestsBeforePreparation + 1);
  });

  it('keeps the tile-native scene viewport in sync during covered zooms', async () => {
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockImplementation(async (sessionId, request, requestId) =>
      request.start === 0
        ? summaryTile()
        : viewportAnnotationTileResponse(sessionId, request, requestId)
    );
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    const debugWindow = window as unknown as {
      __webglExposeForTests?: boolean;
      __indexedGenomeViewerDebug?: {
        scene?: { viewport?: { startBp: number; endBp: number } | null };
      };
    };
    debugWindow.__webglExposeForTests = true;
    webglState.viewportRange = { start: 1_000_000, end: 1_001_000 };
    webglState.centerBp = 1_000_500;

    try {
      render(
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={135_000_000}
          sessionId="session-chr11"
        />
      );
      await waitFor(() => expect(screen.getByTestId('indexed-genome-webgl-map')).toBeTruthy());

      const onCameraChange = webglState.props?.onCameraChange as
        | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
        | undefined;
      expect(onCameraChange).toBeTypeOf('function');

      act(() => {
        onCameraChange?.(1_000_500, 'zoom');
      });
      await waitFor(() => expect(mockGetSequenceWindow).toHaveBeenCalledTimes(1));
      await waitFor(() => {
        expect(debugWindow.__indexedGenomeViewerDebug?.scene?.viewport).toMatchObject({
          startBp: 1_000_000,
          endBp: 1_001_000,
        });
      });

      webglState.viewportRange = { start: 1_000_240, end: 1_000_300 };
      webglState.centerBp = 1_000_270;
      act(() => {
        onCameraChange?.(1_000_270, 'zoom');
      });

      await waitFor(() => {
        expect(debugWindow.__indexedGenomeViewerDebug?.scene?.viewport).toMatchObject({
          startBp: 1_000_240,
          endBp: 1_000_300,
        });
      });
      expect(mockGetSequenceWindow).toHaveBeenCalledTimes(1);
    } finally {
      delete debugWindow.__webglExposeForTests;
      delete debugWindow.__indexedGenomeViewerDebug;
    }
  });

  it('reports visible sequence request failures to the host shell', async () => {
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockRejectedValue(new Error('Indexed genome file missing'));
    webglState.viewportRange = { start: 1_000_000, end: 1_001_000 };
    webglState.centerBp = 1_000_500;
    const onTrackError = vi.fn();

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
        onTrackError={onTrackError}
      />
    );
    await waitFor(() => expect(screen.getByTestId('indexed-genome-webgl-map')).toBeTruthy());

    const onCameraChange = webglState.props?.onCameraChange as
      | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
      | undefined;
    expect(onCameraChange).toBeTypeOf('function');

    act(() => {
      onCameraChange?.(1_000_500, 'zoom');
    });

    await waitFor(() => {
      expect(onTrackError).toHaveBeenCalledWith('sequence', expect.stringContaining('missing'));
    });
    expect(screen.getByTestId('indexed-genome-viewer')).toHaveAttribute(
      'data-viewer-mode',
      'continuous-overview'
    );
  });

  it('requests bounded annotation viewport tiles and lets exact detail replace overlapping summary glyphs', async () => {
    const debugWindow = window as Window & {
      __webglExposeForTests?: boolean;
      __indexedGenomeViewerEvents?: Array<{ event: string; detail?: Record<string, unknown> }>;
      __indexedGenomeViewerDebug?: {
        invariantViolations?: Array<{ invariant: string; message: string }>;
      };
    };
    debugWindow.__webglExposeForTests = true;
    debugWindow.__indexedGenomeViewerEvents = [];
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockImplementation(async (sessionId, request, requestId) =>
      request.start === 0
        ? summaryTile()
        : viewportAnnotationTileResponse(sessionId, request, requestId)
    );
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    webglState.viewportRange = { start: 1_000_000, end: 1_001_000 };
    webglState.centerBp = 1_000_500;

    try {
      render(
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={135_000_000}
          sessionId="session-chr11"
        />
      );
      await waitFor(() => {
        expect(screen.getByTestId('indexed-genome-webgl-map')).toHaveAttribute(
          'data-feature-count',
          '1'
        );
      });
      const eventBaseline = debugWindow.__indexedGenomeViewerEvents?.length ?? 0;

      const onCameraChange = webglState.props?.onCameraChange as
        | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
        | undefined;
      expect(onCameraChange).toBeTypeOf('function');

      act(() => {
        onCameraChange?.(1_000_500, 'zoom');
      });

      await waitFor(() => {
        const viewportCall = mockGetAnnotationTile.mock.calls.find(
          ([, request]) => request.start !== 0
        );
        expect(viewportCall).toBeTruthy();
      });
      const viewportCall = mockGetAnnotationTile.mock.calls.find(
        ([, request]) => request.start !== 0
      );
      expect(viewportCall?.[0]).toBe('session-chr11');
      expect(viewportCall?.[1]).toMatchObject({
        trackId: 'chr11:annotations',
        chrom: 'chr11',
        fidelity: 'best_available',
        byteBudget: ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET,
        generation: expect.any(Number),
      });
      const request = viewportCall?.[1] as { start: number; end: number };
      expect(request.start).toBeGreaterThanOrEqual(0);
      expect(request.end).toBeLessThanOrEqual(135_000_000);
      expect(request.end - request.start).toBeLessThanOrEqual(
        ANNOTATION_VIEWPORT_TILE_REQUEST_MAX_BP
      );
      expect(viewportCall?.[2]).toMatch(/^annotation-viewport-/);
      expect(mockGetFeatures).not.toHaveBeenCalled();

      await waitFor(() => {
        expect(
          (debugWindow.__indexedGenomeViewerEvents ?? [])
            .slice(eventBaseline)
            .some((entry) => entry.event === 'annotation-viewport-tile-ready')
        ).toBe(true);
      });
      await waitFor(() => {
        expect(screen.getByTestId('indexed-genome-webgl-map')).toHaveAttribute(
          'data-feature-count',
          '1'
        );
      });
      expect(debugWindow.__indexedGenomeViewerDebug?.invariantViolations ?? []).toEqual([]);
      const viewportEvents = (debugWindow.__indexedGenomeViewerEvents ?? []).slice(eventBaseline);
      expect(viewportEvents.map((entry) => entry.event)).not.toContain('resolver-start');
      expect(viewportEvents.map((entry) => entry.event)).not.toContain('filter-start');
      expect(screen.getByTestId('indexed-genome-viewer')).toHaveAttribute(
        'data-viewer-mode',
        'continuous-overview'
      );
    } finally {
      delete debugWindow.__webglExposeForTests;
      delete debugWindow.__indexedGenomeViewerEvents;
    }
  });

  it('does not request anchor-session annotation or sequence tiles for an assembly view', async () => {
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockImplementation(async (sessionId, request, requestId) =>
      request.start === 0
        ? summaryTile()
        : viewportAnnotationTileResponse(sessionId, request, requestId)
    );
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    const debugWindow = window as unknown as {
      __webglExposeForTests?: boolean;
      __indexedGenomeVerboseEvents?: boolean;
      __indexedGenomeViewerEvents?: Array<{
        event: string;
        detail?: {
          centerBp?: number;
          viewportRange?: { start: number; end: number } | null;
        };
      }>;
    };
    debugWindow.__webglExposeForTests = true;
    debugWindow.__indexedGenomeVerboseEvents = true;
    debugWindow.__indexedGenomeViewerEvents = [];
    webglState.viewportRange = { start: 136_000_000, end: 136_001_000 };
    webglState.centerBp = 136_000_500;
    const onViewportRangeChange = vi.fn();

    try {
      render(
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={135_000_000}
          sessionId="session-chr11"
          assemblyChromIds={['chr11', 'chr12']}
          onViewportRangeChange={onViewportRangeChange}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('indexed-genome-webgl-map')).toHaveAttribute(
          'data-feature-count',
          '0'
        );
      });
      expect(mockGetAnnotationTile).not.toHaveBeenCalled();

      const onCameraChange = webglState.props?.onCameraChange as
        | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
        | undefined;
      expect(onCameraChange).toBeTypeOf('function');

      act(() => {
        onCameraChange?.(136_000_500, 'zoom');
      });

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });

      const cameraEvents = (debugWindow.__indexedGenomeViewerEvents ?? []).filter(
        (entry) => entry.event === 'camera-change'
      );
      expect(cameraEvents[cameraEvents.length - 1]?.detail).toMatchObject({
        centerBp: 136_000_500,
        viewportRange: { start: 136_000_000, end: 136_001_000 },
      });
      expect(onViewportRangeChange).toHaveBeenLastCalledWith({
        start: 136_000_000,
        end: 136_001_000,
      });

      webglState.viewportRange = { start: 0, end: 92_228_364 };
      webglState.centerBp = 46_114_182;
      act(() => {
        onCameraChange?.(46_114_182, 'zoom');
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      webglState.viewportRange = { start: 0, end: 100_286_400 };
      webglState.centerBp = 50_143_200;
      act(() => {
        onCameraChange?.(50_143_200, 'zoom');
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect(onViewportRangeChange).toHaveBeenLastCalledWith({
        start: 0,
        end: 100_286_400,
      });
      expect(mockGetAnnotationTile).not.toHaveBeenCalled();
      expect(mockGetSequenceWindow).not.toHaveBeenCalled();
    } finally {
      delete debugWindow.__webglExposeForTests;
      delete debugWindow.__indexedGenomeVerboseEvents;
      delete debugWindow.__indexedGenomeViewerEvents;
    }
  });

  it('publishes the real initial assembly camera when the renderer becomes ready', async () => {
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    webglState.viewportRange = null;
    const onViewportRangeChange = vi.fn();

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        onViewportRangeChange={onViewportRangeChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('indexed-genome-webgl-map')).toBeInTheDocument();
    });
    const rendererLength = Number(
      (webglState.props?.genome as { length?: number } | undefined)?.length
    );
    expect(rendererLength).toBeGreaterThan(135_000_000);
    webglState.viewportRange = { start: 0, end: rendererLength };
    const onRendererReady = webglState.props?.onRendererReady as
      | ((epoch: number) => void)
      | undefined;
    expect(onRendererReady).toBeTypeOf('function');
    act(() => {
      onRendererReady?.(1);
    });

    await waitFor(() => {
      expect(onViewportRangeChange).toHaveBeenLastCalledWith({
        start: 0,
        end: rendererLength,
      });
    });
    expect(mockGetAnnotationTile).not.toHaveBeenCalled();
    expect(mockGetSequenceWindow).not.toHaveBeenCalled();
  });

  it('publishes an assembly coordinate shell as ready without a genome session', async () => {
    mockGetAnnotationTile.mockReset();
    mockGetSequenceWindow.mockReset();
    const onLoadPhase = vi.fn();

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={270_000_000}
        assemblyChromIds={['chr11', 'chr12']}
        onLoadPhase={onLoadPhase}
      />
    );

    expect(await screen.findByTestId('indexed-genome-webgl-map')).toBeInTheDocument();
    await waitFor(() => expect(onLoadPhase).toHaveBeenCalledWith('ready'));
    expect(mockGetAnnotationTile).not.toHaveBeenCalled();
    expect(mockGetSequenceWindow).not.toHaveBeenCalled();
  });

  it('streams the hosted assembly camera to BAMs before chromosome sessions exist', async () => {
    mockGetAnnotationTile.mockReset();
    mockGetSequenceWindow.mockReset();
    const streamPileupViaTileEngine = vi.fn(() => true);
    const emptyPileupTrackStatuses = {};
    const pileupStreamingSpy = vi
      .spyOn(indexedPileupStreamingModule, 'useIndexedPileupStreaming')
      .mockReturnValue({
        streamPileupViaTileEngine,
        noteLaneContractWired: vi.fn(),
        firstInteractionReadiness: {
          inspect: () => ({ key: 'hosted-shell-test', reason: 'ready' }),
        },
        trackLifecycle: {
          subscribe: () => () => undefined,
          getSnapshot: () => emptyPileupTrackStatuses,
        },
        retryTrack: vi.fn(),
      } as never);

    try {
      render(
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={270_000_000}
          assemblyChromIds={['chr11', 'chr12']}
        />
      );

      expect(await screen.findByTestId('indexed-genome-webgl-map')).toBeInTheDocument();
      const fineViewport = { start: 136_000_000, end: 136_002_000 };
      webglState.viewportRange = fineViewport;
      const onCameraChange = webglState.props?.onCameraChange as
        | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
        | undefined;
      expect(onCameraChange).toBeTypeOf('function');

      act(() => {
        onCameraChange?.((fineViewport.start + fineViewport.end) / 2, 'zoom');
      });

      expect(streamPileupViaTileEngine).toHaveBeenCalledWith(fineViewport);
      expect(mockGetAnnotationTile).not.toHaveBeenCalled();
      expect(mockGetSequenceWindow).not.toHaveBeenCalled();
    } finally {
      pileupStreamingSpy.mockRestore();
    }
  });

  it('settles the parent track-order handoff while full GRCh38 source admission is pending', async () => {
    const reference = referenceAssemblyById('grch38');
    if (!reference) throw new Error('GRCh38 reference is missing');
    const assembly = buildGenomeAssembly(
      {
        ...reference,
        members: reference.members.map((member) => ({ ...member, manifest: undefined })),
      },
      (path) => path
    );
    const chromosomeIds = assembly.chromosomes.map(({ chrom }) => chrom);
    const manifest = assembly.chromosomes[0]!.manifest;
    const notifications: ReadonlyArray<string>[] = [];
    const reportError = console.error.bind(console);
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (
        args.some((arg) => typeof arg === 'string' && arg.includes('Maximum update depth exceeded'))
      ) {
        throw new Error('Maximum update depth exceeded in the parent/viewer handoff');
      }
      reportError(...args);
    });

    function Parent() {
      const [trackOrder, setTrackOrder] = useState<ReadonlyArray<string>>([]);
      const [revision, setRevision] = useState(0);
      const onTrackOrderChange = useCallback((next: ReadonlyArray<string>) => {
        notifications.push(next);
        setTrackOrder(next);
      }, []);
      return (
        <>
          <button onClick={() => setRevision((current) => current + 1)}>Refresh parent</button>
          <output data-testid="parent-track-order" data-revision={revision}>
            {trackOrder.join(',')}
          </output>
          <IndexedGenomeViewer
            manifest={manifest}
            length={assemblyTotalLengthBp(assembly)}
            assemblyDefinition={assembly}
            assemblyChromIds={chromosomeIds}
            onAnnotationTrackOrderChange={onTrackOrderChange}
            annotationProductPublicationReady={false}
          />
        </>
      );
    }

    try {
      render(<Parent />);
      await screen.findByTestId('indexed-genome-webgl-map');
      expect(chromosomeIds).toHaveLength(24);
      expect(assemblyTotalLengthBp(assembly)).toBe(3_088_269_832);
      expect(screen.getByTestId('parent-track-order')).toHaveTextContent('mRNA');
      const settledNotifications = notifications.length;
      fireEvent.click(screen.getByText('Refresh parent'));
      expect(screen.getByTestId('parent-track-order')).toHaveAttribute('data-revision', '1');
      expect(notifications).toHaveLength(settledNotifications);
      expect(mockReadAssemblyAnnotationProductSetInventoryV1).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('opens the full-assembly coordinate genome before annotation preparation completes', async () => {
    webglState.linearRenderer = physicallyReadyLinearRenderer();
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const onLoadPhase = vi.fn();

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={270_000_000}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_000_000),
          assemblySessionConfig('chr12', 135_000_000),
        ]}
        requireFullAssemblyReadiness
        onLoadPhase={onLoadPhase}
      />
    );

    const map = await screen.findByTestId('indexed-genome-webgl-map');
    await waitFor(() => expect(map).toHaveStyle({ pointerEvents: 'auto' }));
    expect(webglState.props?.onCameraChange).toEqual(expect.any(Function));
    act(() => {
      (webglState.props?.onRendererReady as ((epoch: number) => void) | undefined)?.(1);
    });
    expect(onLoadPhase).toHaveBeenCalledWith('loading');
    await waitFor(() => expect(onLoadPhase).toHaveBeenCalledWith('ready'));
    expect(onLoadPhase.mock.calls.at(-1)?.[0]).toBe('ready');
  });

  it('converts an indexed half-open SNV highlight to one inclusive renderer base', async () => {
    webglState.linearRenderer = physicallyReadyLinearRenderer();
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr1', {
        chrom: 'chr1',
        start: 0,
        end: 0,
        generation: 0,
      })
    );

    const view = render(
      <IndexedGenomeViewer
        manifest={{ ...freshManifest(), chrom: 'chr1' }}
        length={248_956_422}
        sessionId="session-chr1"
      />
    );

    await screen.findByTestId('indexed-genome-webgl-map');
    act(() => {
      (webglState.props?.onRendererReady as ((epoch: number) => void) | undefined)?.(1);
    });
    view.rerender(
      <IndexedGenomeViewer
        manifest={{ ...freshManifest(), chrom: 'chr1' }}
        length={248_956_422}
        sessionId="session-chr1"
        searchHighlight={{
          id: 1,
          start: 611_316,
          end: 611_317,
        }}
      />
    );
    await waitFor(() => expect(webglState.handleState.highlightRange).toEqual([611_316, 611_316]));
  });

  it('mounts the full-assembly coordinate genome when both annotation publications are absent', async () => {
    webglState.suppressAnnotationPublications = true;
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={270_000_000}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_000_000),
          assemblySessionConfig('chr12', 135_000_000),
        ]}
        prepackedAnnotationSceneCache={
          { status: 'not-applicable', descriptor: null, result: null, error: null } as never
        }
      />
    );

    await screen.findByTestId('indexed-genome-webgl-map');
    expect(webglState.props?.genome).toMatchObject({
      length: 268_361_931,
      circular: false,
    });
    expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined();
    expect(webglState.props?.annotationResidentPagePublication).toBeUndefined();
  });

  it('advances the viewer renderer generation when remounted children both report epoch one', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={270_000_000}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_000_000),
          assemblySessionConfig('chr12', 135_000_000),
        ]}
      />
    );

    await screen.findByTestId('indexed-genome-webgl-map');
    const ready = webglState.props?.onRendererReady as ((epoch: number) => void) | undefined;
    expect(ready).toBeTypeOf('function');
    act(() => ready?.(1));
    await waitFor(() =>
      expect(
        mockUsePrepackedScene.mock.calls.some(
          ([input]) => (input as Record<string, unknown>).rendererReadyEpoch === 1
        )
      ).toBe(true)
    );

    act(() => ready?.(1));
    await waitFor(() =>
      expect(
        mockUsePrepackedScene.mock.calls.some(
          ([input]) => (input as Record<string, unknown>).rendererReadyEpoch === 2
        )
      ).toBe(true)
    );
  });

  it('forwards same-renderer genome commits to prepacked admission without changing renderer identity', async () => {
    const notifyCameraChanged = vi.fn();
    mockUseCompiledBroadRasterSurface.mockReturnValue({
      notifyCameraChanged,
      refreshPolicy: vi.fn(),
      getDiagnostics: () => null,
      readiness: 'ready',
      policyControlsReadiness: 'ready',
    });
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={270_000_000}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_000_000),
          assemblySessionConfig('chr12', 135_000_000),
        ]}
      />
    );

    await screen.findByTestId('indexed-genome-webgl-map');
    const ready = webglState.props?.onRendererReady as ((epoch: number) => void) | undefined;
    const contentCommit = webglState.props?.onRendererGenomeCommit as
      | ((epoch: number) => void)
      | undefined;
    expect(ready).toBeTypeOf('function');
    expect(contentCommit).toBeTypeOf('function');
    await waitFor(() =>
      expect(notifyCameraChanged).toHaveBeenCalledWith('scroll', webglState.viewportRange, null)
    );
    notifyCameraChanged.mockClear();

    act(() => {
      ready?.(1);
      contentCommit?.(1);
    });
    await waitFor(() =>
      expect(
        mockUsePrepackedScene.mock.calls.some(([input]) => {
          const lifecycle = input as Record<string, unknown>;
          return lifecycle.rendererReadyEpoch === 1 && lifecycle.rendererGenomeCommitEpoch === 1;
        })
      ).toBe(true)
    );
    await waitFor(() =>
      expect(notifyCameraChanged).toHaveBeenCalledWith('scroll', webglState.viewportRange, null)
    );

    act(() => contentCommit?.(2));
    await waitFor(() =>
      expect(
        mockUsePrepackedScene.mock.calls.some(([input]) => {
          const lifecycle = input as Record<string, unknown>;
          return lifecycle.rendererReadyEpoch === 1 && lifecycle.rendererGenomeCommitEpoch === 2;
        })
      ).toBe(true)
    );
  });

  it('keeps the full-GRCh38 canvas mounted and interactive when the scene IPC contract is stale', async () => {
    webglState.linearRenderer = physicallyReadyLinearRenderer();
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const onLoadPhase = vi.fn();
    const cacheError = new Error('annotation scene probe returned no source revision');

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={3_088_269_832}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_000_000),
          assemblySessionConfig('chr12', 135_000_000),
        ]}
        assemblyByChrom={
          new Map([
            ['chr11', []],
            ['chr12', []],
          ])
        }
        requireFullAssemblyReadiness
        prepackedAnnotationSceneCache={
          {
            status: 'error',
            descriptor: {
              sourceIdentity: 'source',
              sceneKey: 'stale-main-contract',
              sceneVariant: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
            },
            result: null,
            error: cacheError,
          } as never
        }
        onLoadPhase={onLoadPhase}
      />
    );

    const map = await screen.findByTestId('indexed-genome-webgl-map');
    await waitFor(() => expect(map).toHaveStyle({ pointerEvents: 'auto' }));
    expect(webglState.props?.onCameraChange).toEqual(expect.any(Function));
    act(() => {
      (webglState.props?.onRendererReady as ((epoch: number) => void) | undefined)?.(1);
    });
    await waitFor(() => expect(onLoadPhase).toHaveBeenCalledWith('ready'));
    expect(onLoadPhase).not.toHaveBeenCalledWith('error', expect.anything());
    expect(screen.queryByText(/Couldn't open GRCh38/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('annotation-policy-preparation-state')).not.toBeInTheDocument();
  });

  it('overlays the admitted product generation on a stale session source before deriving the broad raster address', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const admittedProductGeneration = {
      contract: 'assembly-reference-asset-generation.v1' as const,
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'b'.repeat(64),
      themeMode: 'light' as const,
    };
    const annotationSceneSourceRequest = {
      assemblyId: 'grch38',
      workspaceRoot: '/workspace',
      scope: {
        kind: 'complete-assembly' as const,
        placements: [
          { chrom: 'chr11', length: 135_000_000, annotationCoverage: 'sourced' as const },
          { chrom: 'chr12', length: 135_000_000, annotationCoverage: 'sourced' as const },
        ],
      },
      chromosomes: [
        { chrom: 'chr11', sourcePath: '/workspace/chr11.gff3.gz', length: 135_000_000 },
        { chrom: 'chr12', sourcePath: '/workspace/chr12.gff3.gz', length: 135_000_000 },
      ],
    };

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={270_000_000}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_000_000),
          assemblySessionConfig('chr12', 135_000_000),
        ]}
        assemblyByChrom={
          new Map([
            ['chr11', []],
            ['chr12', []],
          ])
        }
        annotationSceneSourceRequest={annotationSceneSourceRequest}
        annotationAssetGeneration={admittedProductGeneration}
        annotationInteractionPayloadEnabled={false}
        requireFullAssemblyReadiness
      />
    );

    await screen.findByTestId('indexed-genome-webgl-map');
    await waitFor(() =>
      expect(
        mockUseCompiledBroadRasterSurface.mock.calls.some(([input]) => {
          const cache = (input as Record<string, unknown>).cache as
            | {
                descriptor?: {
                  artifact?: { trackType?: string };
                  request?: {
                    assemblyId?: string;
                    expectedAssetGeneration?: { inventoryFingerprint?: string };
                  };
                } | null;
              }
            | undefined;
          return (
            cache?.descriptor?.artifact?.trackType === 'mRNA' &&
            cache.descriptor.request?.assemblyId === 'grch38' &&
            cache.descriptor.request.expectedAssetGeneration?.inventoryFingerprint ===
              'b'.repeat(64)
          );
        })
      ).toBe(true)
    );
    expect(
      mockUseCompactInteraction.mock.calls.some(
        ([input]) => (input as { enabled?: boolean }).enabled === true
      )
    ).toBe(true);
  });

  it('loads one exact assembly shell before the optional interaction descriptor publishes', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const sourceSha256 = '7'.repeat(64);
    const sourceIdentity = `assembly-annotation-source-sha256.v1:${sourceSha256}`;
    const admittedRequest = {
      assemblyId: 'grch38',
      workspaceRoot: '/workspace',
      scope: {
        kind: 'complete-assembly' as const,
        placements: [
          { chrom: 'chr11', length: 135_000_000, annotationCoverage: 'sourced' as const },
          { chrom: 'chr12', length: 135_000_000, annotationCoverage: 'sourced' as const },
        ],
      },
      chromosomes: [
        { chrom: 'chr11', sourcePath: '/workspace/chr11.gff3.gz', length: 135_000_000 },
        { chrom: 'chr12', sourcePath: '/workspace/chr12.gff3.gz', length: 135_000_000 },
      ],
      ipcContractVersion: 'assembly-annotation-scene-ipc.v4' as const,
      datasetContract: {
        datasetId: 'waypoint:assembly-annotation:grch38',
        datasetVersion: 'resolved-annotation-v3:mapped-track-input.v1',
        sourceSha256,
      },
      artifact: {
        artifactKey: 'assembly-annotation-artifact.v4:test',
        themeMode: 'light' as const,
        trackType: 'mRNA',
        partitionSpanBp: 100_000_000,
        annotationBarHeightPx: 14,
        laneAlgorithmToken: 'fixture-lane',
        mapperContractToken: 'fixture-mapper',
        geometryContractToken: 'fixture-geometry',
        interactionContractToken: 'fixture-interaction',
      },
      requestedPolicy: { isoformMode: 'canonical' as const, laneLimit: 12 },
    };
    const descriptor = {
      sourceIdentity,
      placementFingerprint: 'ap1:0123456789abcdef01234567',
      runtimeCacheKey: 'late-interaction-runtime',
      sceneKey: 'late-interaction-scene',
      artifact: admittedRequest.artifact,
      request: admittedRequest,
    };
    const loadGenome = vi.fn();
    webglState.linearRenderer = {
      loadGenome,
      getLaneContractRevision: () => 0,
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn(),
      hasTrackData: () => true,
      setTrackData: vi.fn(),
      hasTrackInstance: () => true,
    };
    const baseProps = {
      manifest: freshManifest(),
      length: 270_000_000,
      assemblyChromIds: ['chr11', 'chr12'],
      assemblySessionConfigs: [
        assemblySessionConfig('chr11', 135_000_000),
        assemblySessionConfig('chr12', 135_000_000),
      ],
      assemblyByChrom: new Map([
        ['chr11', []],
        ['chr12', []],
      ]),
      annotationSceneSourceRequest: admittedRequest,
      annotationMapperPolicy: { isoformMode: 'canonical' as const, laneLimit: 12 },
      requireFullAssemblyReadiness: true,
    };
    const { rerender } = render(
      <IndexedGenomeViewer
        {...baseProps}
        sessionId="session-provisional"
        prepackedAnnotationSceneCache={
          {
            status: 'not-applicable',
            descriptor: null,
            result: null,
            error: null,
          } as never
        }
      />
    );

    await screen.findByTestId('indexed-genome-webgl-map');
    expect(
      (webglState.props?.genome as { sourceIdentity?: string } | undefined)?.sourceIdentity
    ).toBe(sourceIdentity);
    const exactShell = webglState.props?.genome;
    const loadCountBeforeDescriptor = loadGenome.mock.calls.length;

    rerender(
      <IndexedGenomeViewer
        {...baseProps}
        sessionId="session-terminal"
        prepackedAnnotationSceneCache={
          { status: 'loading', descriptor, result: null, error: null } as never
        }
      />
    );
    await waitFor(() => expect(mockUsePrepackedScene).toHaveBeenCalled());

    expect(webglState.props?.genome).toBe(exactShell);
    expect(loadGenome).toHaveBeenCalledTimes(loadCountBeforeDescriptor);
  });

  it('does not remint the compiled-raster assembly shell when a mismatched V4 interaction hit arrives late', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const descriptor = {
      sourceIdentity: 'compiled-raster-source',
      placementFingerprint: 'ap1:0123456789abcdef01234567',
      runtimeCacheKey: 'compiled-raster-runtime',
      sceneKey: 'optional-interaction-scene',
      artifact: {
        artifactKey: 'assembly-annotation-artifact.v3:optional-interaction',
        trackType: 'mRNA',
      },
      request: { requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 } },
    };
    const loadingCache = {
      status: 'loading' as const,
      descriptor,
      result: null,
      error: null,
    };
    const mismatchedHitCache = {
      status: 'hit' as const,
      descriptor,
      result: fixturePrepackedSceneHitResult(descriptor, 'bbbbbbbbbbbbbbbbbbbbbbbb'),
      error: null,
    };
    mockUseCompiledBroadRasterSurface.mockReturnValue(
      fixtureReadyCompiledBroadSurface(descriptor, 'aaaaaaaaaaaaaaaaaaaaaaaa')
    );
    const clearCompiledBroadSurfaceRequirement = vi.fn();
    const loadGenome = vi.fn(
      (genome: { annotationSourcePlacementProvenance?: { sourceFingerprint?: string } }) => {
        if (genome.annotationSourcePlacementProvenance) {
          clearCompiledBroadSurfaceRequirement();
        }
      }
    );
    webglState.linearRenderer = {
      loadGenome,
      getLaneContractRevision: () => 0,
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn(),
      hasTrackData: () => true,
      setTrackData: vi.fn(),
      hasTrackInstance: () => true,
    };
    const baseProps = {
      manifest: freshManifest(),
      length: 270_000_000,
      sessionId: 'session-chr11',
      assemblyChromIds: ['chr11', 'chr12'],
      assemblySessionConfigs: [
        assemblySessionConfig('chr11', 135_000_000),
        assemblySessionConfig('chr12', 135_000_000),
      ],
      assemblyByChrom: new Map([
        ['chr11', []],
        ['chr12', []],
      ]),
      annotationMapperPolicy: { isoformMode: 'canonical' as const, laneLimit: 12 },
      requireFullAssemblyReadiness: true,
    };
    const { rerender } = render(
      <IndexedGenomeViewer {...baseProps} prepackedAnnotationSceneCache={loadingCache as never} />
    );

    await screen.findByTestId('indexed-genome-webgl-map');
    const incumbentShell = webglState.props?.genome;
    const loadCountBeforeHit = loadGenome.mock.calls.length;
    expect(incumbentShell).not.toHaveProperty('annotationSourcePlacementProvenance');

    rerender(
      <IndexedGenomeViewer
        {...baseProps}
        prepackedAnnotationSceneCache={mismatchedHitCache as never}
      />
    );
    await waitFor(() => expect(mockUsePrepackedScene).toHaveBeenCalled());

    expect(
      mockUsePrepackedScene.mock.calls.some(
        ([input]) =>
          ((input as Record<string, unknown>).cache as { status?: string } | undefined)?.status ===
          'hit'
      )
    ).toBe(false);
    expect(webglState.props?.genome).toBe(incumbentShell);
    expect(loadGenome).toHaveBeenCalledTimes(loadCountBeforeHit);
    expect(clearCompiledBroadSurfaceRequirement).not.toHaveBeenCalled();
  });

  it.each([
    ['All', null],
    ['over-cap', COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2 + 1],
  ] as const)(
    'clamps persisted %s lanes to the compiled-surface capability before loader or controls',
    async (_caseName, persistedLaneLimit) => {
      mockGetFeatures.mockResolvedValue([]);
      mockGetAnnotationTile.mockResolvedValue(summaryTile());
      mockGetSequenceWindow.mockResolvedValue(
        sequenceWindowResponse('session-chr11', {
          chrom: 'chr11',
          start: 0,
          end: 0,
          generation: 0,
        })
      );
      const committedPolicies: Array<{
        isoformMode: 'canonical' | 'expanded';
        laneLimit: number | null;
      }> = [];

      function Harness() {
        const [policy, setPolicy] = useState<{
          isoformMode: 'canonical' | 'expanded';
          laneLimit: number | null;
        }>({ isoformMode: 'expanded', laneLimit: persistedLaneLimit });
        return (
          <IndexedGenomeViewer
            manifest={freshManifest()}
            length={270_000_000}
            sessionId="session-chr11"
            assemblyChromIds={['chr11', 'chr12']}
            assemblySessionConfigs={[
              assemblySessionConfig('chr11', 135_000_000),
              assemblySessionConfig('chr12', 135_000_000),
            ]}
            assemblyByChrom={
              new Map([
                ['chr11', []],
                ['chr12', []],
              ])
            }
            annotationMapperPolicy={policy}
            onAnnotationMapperPolicyChange={(next) => {
              committedPolicies.push(next);
              setPolicy(next);
            }}
            requireFullAssemblyReadiness
          />
        );
      }

      render(<Harness />);

      const lanePicker = await screen.findByLabelText('Max lanes');
      await waitFor(() =>
        expect(lanePicker).toHaveValue(String(COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2))
      );
      expect(screen.getByRole('button', { name: '✓ All isoforms' })).toBeEnabled();
      expect(screen.queryByRole('option', { name: 'All' })).not.toBeInTheDocument();
      expect(committedPolicies).toEqual([
        {
          isoformMode: 'expanded',
          laneLimit: COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
        },
      ]);

      const compiledInputs = mockUseCompiledBroadRasterSurface.mock.calls
        .map(([input]) => input as Record<string, unknown>)
        .filter((input) => input.assemblyRequirement != null);
      expect(compiledInputs.length).toBeGreaterThan(0);
      expect(
        compiledInputs.every(
          (input) =>
            (input.policy as { isoformMode?: string; laneLimit?: number | null }).isoformMode ===
              'expanded' &&
            (input.policy as { laneLimit?: number | null }).laneLimit ===
              COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2
        )
      ).toBe(true);
      expect(screen.queryByText('Couldn’t apply annotation settings')).not.toBeInTheDocument();
    }
  );

  it('keeps the last-good owner interactive and reports track-local progress when policy outruns it', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const canonicalCache = {
      status: 'hit' as const,
      descriptor: {
        sourceIdentity: 'source',
        sceneKey: 'canonical-12',
        sceneVariant: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
      },
      result: fixturePrepackedSceneHitResult({
        sceneKey: 'canonical-12',
        sceneVariant: { trackType: 'mRNA' },
      }),
      error: null,
    };
    let activeOwner: { ownerKey: string; genomeIdentity: string } | null = {
      ownerKey: 'canonical-owner',
      genomeIdentity: 'source',
    };
    const rendererGenomeIdentities: string[] = [];
    webglState.linearRenderer = {
      getLaneContractRevision: () => 0,
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn(),
      hasTrackData: () => true,
      setTrackData: vi.fn(),
      hasTrackInstance: () => true,
      loadGenome: (genome) => {
        const genomeIdentity = genome.sourceIdentity ?? '';
        rendererGenomeIdentities.push(genomeIdentity);
        if (activeOwner && activeOwner.genomeIdentity !== genomeIdentity) activeOwner = null;
      },
    };
    const onLoadPhase = vi.fn();
    const baseProps = {
      manifest: freshManifest(),
      length: 270_000_000,
      sessionId: 'session-chr11',
      assemblyChromIds: ['chr11', 'chr12'],
      assemblySessionConfigs: [
        assemblySessionConfig('chr11', 135_000_000),
        assemblySessionConfig('chr12', 135_000_000),
      ],
      assemblyByChrom: new Map([
        ['chr11', []],
        ['chr12', []],
      ]),
      requireFullAssemblyReadiness: true,
      prepackedAnnotationSceneCache: canonicalCache as never,
      onLoadPhase,
    };
    const { rerender } = render(
      <IndexedGenomeViewer
        {...baseProps}
        annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
      />
    );
    const map = await screen.findByTestId('indexed-genome-webgl-map');
    await waitFor(() => expect(map).toHaveStyle({ pointerEvents: 'auto' }));
    onLoadPhase.mockClear();

    webglState.propsHistory = [];
    rerender(
      <IndexedGenomeViewer
        {...baseProps}
        prepackedAnnotationSceneCache={
          { status: 'not-applicable', descriptor: null, result: null, error: null } as never
        }
        annotationMapperPolicy={{ isoformMode: 'expanded', laneLimit: 8 }}
      />
    );

    expect(
      (webglState.props?.genome as { sourceIdentity?: string } | undefined)?.sourceIdentity
    ).toBe('source');
    expect(rendererGenomeIdentities.some((identity) => /^assembly-v1\|/.test(identity))).toBe(
      false
    );
    expect(activeOwner).toEqual({
      ownerKey: 'canonical-owner',
      genomeIdentity: 'source',
    });
    expect(map).toHaveStyle({ pointerEvents: 'auto' });
    expect(webglState.props?.onCameraChange).toEqual(expect.any(Function));
    expect(screen.queryByTestId('annotation-policy-preparation-state')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '✓ All isoforms' })).toBeEnabled();
    expect(onLoadPhase).not.toHaveBeenCalledWith('loading');
    expect(onLoadPhase).not.toHaveBeenCalledWith('error', expect.anything());

    const expandedCache = {
      ...canonicalCache,
      descriptor: {
        ...canonicalCache.descriptor,
        sceneKey: 'expanded-8',
        sceneVariant: { trackType: 'mRNA', isoformMode: 'expanded', laneLimit: 8 },
      },
    };
    rerender(
      <IndexedGenomeViewer
        {...baseProps}
        prepackedAnnotationSceneCache={expandedCache as never}
        annotationMapperPolicy={{ isoformMode: 'expanded', laneLimit: 8 }}
      />
    );

    await waitFor(() =>
      expect(screen.queryByTestId('annotation-policy-preparation-state')).not.toBeInTheDocument()
    );
    activeOwner = { ownerKey: 'expanded-owner', genomeIdentity: 'source' };
    expect(activeOwner.ownerKey).toBe('expanded-owner');
    expect(map).toHaveStyle({ pointerEvents: 'auto' });
    expect(screen.getByRole('button', { name: '✓ All isoforms' })).toBeEnabled();
  });

  it('does not mask the user-composited viewer while annotation detail ownership is pending', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockImplementation(async (_sessionId, request) =>
      request.fidelity === 'summary' ? summaryTile() : await new Promise<never>(() => {})
    );
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    webglState.viewportRange = { start: 1_000_000, end: 1_001_000 };
    webglState.centerBp = 1_000_500;

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={270_000_000}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_000_000),
          assemblySessionConfig('chr12', 135_000_000),
        ]}
        assemblyByChrom={
          new Map([
            ['chr11', []],
            ['chr12', []],
          ])
        }
      />
    );

    const host = await screen.findByTestId('indexed-genome-canvas-host');
    const compositedViewer = within(host).getByTestId('indexed-genome-webgl-map');
    const pendingStatus = await within(host).findByTestId(
      'indexed-genome-annotation-owner-pending'
    );

    expect(compositedViewer).toHaveStyle({ pointerEvents: 'auto' });
    expect(pendingStatus).toHaveClass('pointer-events-none', 'absolute', 'bottom-2', 'right-2');
    expect(pendingStatus).not.toHaveClass('inset-0');
  });

  it('commits exact runtime policies without rebuilding legacy compatibility planes', async () => {
    const testBridge = window as unknown as {
      __test?: {
        setAssemblyAnnotationIsoformMode?: (mode: 'canonical' | 'expanded') => unknown;
        setAssemblyAnnotationLaneLimit?: (laneLimit: number | null) => unknown;
        getAssemblyAnnotationPolicyTransaction?: () => {
          committedPolicy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null };
          requestedPolicy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null };
          pendingRequestId: number | null;
          preparationState: 'idle' | 'preparing' | 'error';
        };
      };
    };
    testBridge.__test = {};
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const artifact = {
      artifactKey: 'assembly-annotation-artifact.v3:test-policy-neutral-mrna',
      trackType: 'mRNA',
    };
    const descriptor = {
      sourceIdentity: 'policy-neutral-source',
      placementFingerprint: 'ap1:0123456789abcdef01234567',
      runtimeCacheKey: 'policy-neutral-runtime',
      sceneKey: 'policy-neutral-scene',
      artifact,
      request: { requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 } },
    };
    const cache = {
      status: 'hit' as const,
      descriptor,
      result: fixturePrepackedSceneHitResult(descriptor),
      error: null,
    };
    const loadGenome = vi.fn();
    webglState.linearRenderer = {
      loadGenome,
      getLaneContractRevision: () => 0,
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn(),
      hasTrackData: () => true,
      setTrackData: vi.fn(),
      hasTrackInstance: () => true,
    };
    const committedPolicies: Array<{ isoformMode: string; laneLimit: number | null }> = [];
    function Harness() {
      const [policy, setPolicy] = useState({
        isoformMode: 'canonical' as 'canonical' | 'expanded',
        laneLimit: 12 as number | null,
      });
      return (
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={270_000_000}
          sessionId="session-chr11"
          assemblyChromIds={['chr11', 'chr12']}
          assemblySessionConfigs={[
            assemblySessionConfig('chr11', 135_000_000),
            assemblySessionConfig('chr12', 135_000_000),
          ]}
          assemblyByChrom={
            new Map([
              ['chr11', []],
              ['chr12', []],
            ])
          }
          prepackedAnnotationSceneCache={cache as never}
          annotationMapperPolicy={policy}
          onAnnotationMapperPolicyChange={(next) => {
            committedPolicies.push(next);
            setPolicy(next);
          }}
          requireFullAssemblyReadiness
        />
      );
    }
    render(<Harness />);
    const toggle = await screen.findByRole('button', { name: 'Primary only' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined();
    const initialMainInput = mockUsePrepackedScene.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .find(
        (input) =>
          (input.requestedPolicy as { isoformMode?: string } | undefined)?.isoformMode ===
          'canonical'
      );
    expect(initialMainInput).toBeDefined();
    act(() => {
      (initialMainInput?.onPresented as (receipt: unknown) => void)?.({
        requestId: initialMainInput?.requestId ?? null,
        descriptor,
        ownerKey: 'policy-neutral-owner',
        metadata: {
          genomeIdentity: descriptor.sourceIdentity,
          artifactKey: artifact.artifactKey,
          trackType: artifact.trackType,
        },
        runtimePolicy: { isoformMode: 'canonical', laneLimit: 12 },
        origin: 'hit',
      });
    });
    await waitFor(() => expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined());
    const policyNeutralSnapshot = webglState.props?.annotationResidentPagePublication;
    const policyNeutralGenome = webglState.props?.genome;
    expect(policyNeutralSnapshot).toBeDefined();
    expect(policyNeutralGenome).not.toHaveProperty('annotationSourcePlacementProvenance');
    const loadsBeforeClick = loadGenome.mock.calls.length;
    mockUsePrepackedScene.mockClear();
    resetCompatibilityWork();

    await waitFor(() =>
      expect(testBridge.__test?.setAssemblyAnnotationIsoformMode).toBeTypeOf('function')
    );
    act(() => {
      expect(testBridge.__test?.setAssemblyAnnotationIsoformMode?.('expanded')).toEqual({
        isoformMode: 'expanded',
        laneLimit: 12,
      });
    });

    expect(committedPolicies).toEqual([]);
    expect(screen.getByRole('button', { name: 'Primary only' })).toBeDisabled();
    expect(screen.getByTestId('annotation-policy-preparation-state')).toHaveTextContent(
      'Applying annotation settings…'
    );
    expect(testBridge.__test?.getAssemblyAnnotationPolicyTransaction?.()).toMatchObject({
      committedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
      requestedPolicy: { isoformMode: 'expanded', laneLimit: 12 },
      pendingRequestId: expect.any(Number),
      preparationState: 'preparing',
    });
    expect(
      mockUsePrepackedScene.mock.calls.some(
        ([input]) =>
          (
            (input as Record<string, unknown>).requestedPolicy as
              | { isoformMode?: string }
              | undefined
          )?.isoformMode === 'expanded'
      )
    ).toBe(false);
    const pendingCompiledInput = mockUseCompiledBroadRasterSurface.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .findLast(
        (input) =>
          (input.policy as { isoformMode?: string; laneLimit?: number } | undefined)
            ?.isoformMode === 'expanded' &&
          (input.policy as { laneLimit?: number } | undefined)?.laneLimit === 12 &&
          typeof input.policyRequestId === 'number'
      );
    expect(pendingCompiledInput).toMatchObject({
      policy: { isoformMode: 'expanded', laneLimit: 12 },
      policyRequestId: expect.any(Number),
    });
    expect(
      mockUsePrepackedScene.mock.calls.every(
        ([input]) => !('execution' in (input as Record<string, unknown>))
      )
    ).toBe(true);

    const receipt = (
      runtimePolicy: {
        isoformMode: 'canonical' | 'expanded';
        laneLimit: number;
      },
      requestId: number
    ) => ({
      requestId,
      descriptor,
      ownerKey: 'policy-neutral-owner',
      metadata: {
        genomeIdentity: descriptor.sourceIdentity,
        artifactKey: artifact.artifactKey,
        trackType: artifact.trackType,
      },
      runtimePolicy,
      origin: 'hit',
    });
    const commitPendingCompiledPolicy = (runtimePolicy: {
      isoformMode: 'canonical' | 'expanded';
      laneLimit: number;
    }) => {
      const transaction = testBridge.__test?.getAssemblyAnnotationPolicyTransaction?.();
      const requestId = transaction?.pendingRequestId;
      expect(requestId).toEqual(expect.any(Number));
      const input = mockUseCompiledBroadRasterSurface.mock.calls
        .map(([candidate]) => candidate as Record<string, unknown>)
        .findLast(
          (candidate) =>
            candidate.policyRequestId === requestId &&
            (candidate.policy as { isoformMode?: string; laneLimit?: number } | undefined)
              ?.isoformMode === runtimePolicy.isoformMode &&
            (candidate.policy as { laneLimit?: number } | undefined)?.laneLimit ===
              runtimePolicy.laneLimit
        );
      expect(input).toBeDefined();
      act(() => {
        (input?.onPolicyCommitted as (compiledReceipt: unknown) => void)?.({
          contract: 'assembly-compiled-broad-raster-policy-commit.v1',
          identityKey: 'policy-neutral-compiled-broad',
          policyRequestId: requestId,
          policy: runtimePolicy,
          surfaceManifestFingerprint: `${runtimePolicy.isoformMode}-${runtimePolicy.laneLimit}-surface`,
          catalogReceiptSha256: `${runtimePolicy.isoformMode}-${runtimePolicy.laneLimit}-catalog`,
        });
      });
    };
    const pendingRequestId = pendingCompiledInput?.policyRequestId as number;
    act(() => {
      (pendingCompiledInput?.onPolicyCommitted as (receipt: unknown) => void)?.({
        contract: 'assembly-compiled-broad-raster-policy-commit.v1',
        identityKey: 'policy-neutral-compiled-broad',
        policyRequestId: pendingRequestId,
        policy: { isoformMode: 'canonical', laneLimit: 12 },
        surfaceManifestFingerprint: 'wrong-policy-surface',
        catalogReceiptSha256: 'wrong-policy-catalog',
      });
    });
    expect(committedPolicies).toEqual([]);

    act(() => {
      (pendingCompiledInput?.onPolicyCommitted as (receipt: unknown) => void)?.({
        contract: 'assembly-compiled-broad-raster-policy-commit.v1',
        identityKey: 'policy-neutral-compiled-broad',
        policyRequestId: pendingRequestId,
        policy: { isoformMode: 'expanded', laneLimit: 12 },
        surfaceManifestFingerprint: 'expanded-12-surface',
        catalogReceiptSha256: 'expanded-12-catalog',
      });
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '✓ All isoforms' })).toBeEnabled()
    );
    expect(committedPolicies).toEqual([{ isoformMode: 'expanded', laneLimit: 12 }]);
    expect(testBridge.__test?.getAssemblyAnnotationPolicyTransaction?.()).toEqual({
      committedPolicy: { isoformMode: 'expanded', laneLimit: 12 },
      requestedPolicy: { isoformMode: 'expanded', laneLimit: 12 },
      pendingRequestId: null,
      preparationState: 'idle',
    });
    expect(loadGenome).toHaveBeenCalledTimes(loadsBeforeClick);
    expect(webglState.props?.annotationResidentPagePublication).toBe(policyNeutralSnapshot);
    expect(webglState.props?.genome).toBe(policyNeutralGenome);
    expect(webglState.props?.genome).not.toHaveProperty('annotationSourcePlacementProvenance');

    const expandedV4Input = mockUsePrepackedScene.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .findLast(
        (input) =>
          (input.requestedPolicy as { isoformMode?: string; laneLimit?: number } | undefined)
            ?.isoformMode === 'expanded' &&
          (input.requestedPolicy as { laneLimit?: number } | undefined)?.laneLimit === 12
      );
    act(() => {
      (expandedV4Input?.onPresented as (presented: unknown) => void)?.(
        receipt(
          { isoformMode: 'expanded', laneLimit: 12 },
          (expandedV4Input?.requestId as number | null) ?? 0
        )
      );
    });

    mockUsePrepackedScene.mockClear();
    act(() => {
      expect(testBridge.__test?.setAssemblyAnnotationLaneLimit?.(24)).toEqual({
        isoformMode: 'expanded',
        laneLimit: 24,
      });
    });
    expect(testBridge.__test?.getAssemblyAnnotationPolicyTransaction?.()).toMatchObject({
      committedPolicy: { isoformMode: 'expanded', laneLimit: 12 },
      requestedPolicy: { isoformMode: 'expanded', laneLimit: 24 },
      pendingRequestId: expect.any(Number),
      preparationState: 'preparing',
    });
    expect(
      mockUsePrepackedScene.mock.calls.some(
        ([input]) =>
          ((input as Record<string, unknown>).requestedPolicy as { laneLimit?: number } | undefined)
            ?.laneLimit === 24
      )
    ).toBe(false);
    expect(committedPolicies).toHaveLength(1);
    commitPendingCompiledPolicy({ isoformMode: 'expanded', laneLimit: 24 });
    await waitFor(() => expect(screen.getByLabelText('Max lanes')).toHaveValue('24'));
    expect(committedPolicies).toEqual([
      { isoformMode: 'expanded', laneLimit: 12 },
      { isoformMode: 'expanded', laneLimit: 24 },
    ]);
    expect(testBridge.__test?.getAssemblyAnnotationPolicyTransaction?.()).toEqual({
      committedPolicy: { isoformMode: 'expanded', laneLimit: 24 },
      requestedPolicy: { isoformMode: 'expanded', laneLimit: 24 },
      pendingRequestId: null,
      preparationState: 'idle',
    });
    expect(loadGenome).toHaveBeenCalledTimes(loadsBeforeClick);
    expect(webglState.props?.annotationResidentPagePublication).toBe(policyNeutralSnapshot);
    expect(webglState.props?.genome).toBe(policyNeutralGenome);

    mockUsePrepackedScene.mockClear();
    act(() => {
      expect(testBridge.__test?.setAssemblyAnnotationLaneLimit?.(8)).toEqual({
        isoformMode: 'expanded',
        laneLimit: 8,
      });
    });
    commitPendingCompiledPolicy({ isoformMode: 'expanded', laneLimit: 8 });
    await waitFor(() => expect(screen.getByLabelText('Max lanes')).toHaveValue('8'));

    mockUsePrepackedScene.mockClear();
    act(() => {
      expect(testBridge.__test?.setAssemblyAnnotationIsoformMode?.('canonical')).toEqual({
        isoformMode: 'canonical',
        laneLimit: 8,
      });
    });
    commitPendingCompiledPolicy({ isoformMode: 'canonical', laneLimit: 8 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Primary only' })).toBeEnabled());

    mockUsePrepackedScene.mockClear();
    act(() => {
      expect(testBridge.__test?.setAssemblyAnnotationLaneLimit?.(12)).toEqual({
        isoformMode: 'canonical',
        laneLimit: 12,
      });
    });
    commitPendingCompiledPolicy({ isoformMode: 'canonical', laneLimit: 12 });
    await waitFor(() => expect(screen.getByLabelText('Max lanes')).toHaveValue('12'));

    expect(compatibilityWork).toEqual({
      collapseIsoforms: 0,
      resolveViewportFeatures: 0,
      projectAnchorDensity: 0,
      buildViewportGlyphs: 0,
      buildAnchorGlyphs: 0,
      buildAssemblyGlyphs: 0,
      projectAssemblyLanes: 0,
      buildAssemblyScene: 0,
      adaptSceneToGenome: 0,
      fullSnapshotCandidates: 0,
    });
    expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined();
    expect(webglState.props?.annotationResidentPagePublication).toBe(policyNeutralSnapshot);
    expect(webglState.props?.genome).toBe(policyNeutralGenome);
    expect(loadGenome).toHaveBeenCalledTimes(loadsBeforeClick);
  });

  it('opens the coordinate assembly before reporting physical compiled-raster readiness', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    mockUseCompiledBroadRasterSurface.mockReturnValue({
      notifyCameraChanged: vi.fn(),
      refreshPolicy: vi.fn(),
      getDiagnostics: () => null,
      readiness: 'ready',
      readinessTargetIdentityKey: 'physical-ready-target',
      readinessRendererMatchesCurrent: true,
      targetIdentityKey: 'physical-ready-target',
      policyControlsReadiness: 'ready',
    });

    let physicallyPresented = false;
    let nextFrameId = 1;
    const pendingFrames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const frameId = nextFrameId++;
        pendingFrames.set(frameId, callback);
        return frameId;
      })
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((frameId: number) => pendingFrames.delete(frameId))
    );

    webglState.linearRenderer = {
      getColdGestureSnapshot: () => ({
        annotation: {
          compiledBroadRasterVisible: physicallyPresented,
          compiledBroadRasterProvenanceValid: physicallyPresented,
          compiledBroadRasterPlanStatus: 'ready',
        },
      }),
      getLaneContractRevision: () => 0,
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn(),
      hasTrackData: () => true,
      setTrackData: vi.fn(),
      hasTrackInstance: () => true,
    };
    const onCompiledBroadRasterVisualReady = vi.fn();
    const onLoadPhase = vi.fn();

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={270_000_000}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_000_000),
          assemblySessionConfig('chr12', 135_000_000),
        ]}
        assemblyByChrom={
          new Map([
            ['chr11', []],
            ['chr12', []],
          ])
        }
        onCompiledBroadRasterVisualReady={onCompiledBroadRasterVisualReady}
        onLoadPhase={onLoadPhase}
        requireFullAssemblyReadiness
      />
    );

    await screen.findByTestId('indexed-genome-webgl-map');
    await waitFor(() => expect(pendingFrames.size).toBeGreaterThan(0));
    expect(onCompiledBroadRasterVisualReady).not.toHaveBeenCalled();
    expect(onLoadPhase).toHaveBeenCalledWith('ready');
    expect(onLoadPhase).not.toHaveBeenCalledWith('error', expect.any(String));

    physicallyPresented = true;
    act(() => {
      const callbacks = Array.from(pendingFrames.values());
      pendingFrames.clear();
      for (const callback of callbacks) callback(performance.now());
    });
    expect(onCompiledBroadRasterVisualReady).toHaveBeenCalledTimes(1);
    expect(pendingFrames.size).toBe(0);
  });

  it('does not let stale readiness authorize a replacement data product on the same detail renderer', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );

    webglState.linearRenderer = {
      getColdGestureSnapshot: () => ({
        annotation: {
          compiledBroadRasterVisible: false,
          compiledBroadRasterProvenanceValid: false,
          compiledBroadRasterPlanStatus: 'detail-required',
        },
      }),
      getLaneContractRevision: () => 0,
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn(),
      hasTrackData: () => true,
      setTrackData: vi.fn(),
      hasTrackInstance: () => true,
    };

    const request = {
      assemblyId: 'grch38',
      workspaceRoot: '/fixture/workspace',
      chromosomes: [
        { chrom: 'chr11', length: 135_000_000, sourcePath: '/fixture/workspace/chr11.gff3.gz' },
        { chrom: 'chr12', length: 135_000_000, sourcePath: '/fixture/workspace/chr12.gff3.gz' },
      ],
      scope: {
        kind: 'complete-assembly',
        placements: [
          { chrom: 'chr11', length: 135_000_000, annotationCoverage: 'sourced' },
          { chrom: 'chr12', length: 135_000_000, annotationCoverage: 'sourced' },
        ],
      },
    };
    const cacheForGeneration = (generation: 'generation-a' | 'generation-b') => ({
      status: 'loading' as const,
      descriptor: {
        sourceIdentity: 'theme-switch-source',
        placementFingerprint: 'ap1:0123456789abcdef01234567',
        runtimeCacheKey: `${generation}-runtime`,
        sceneKey: `${generation}-scene`,
        artifact: {
          artifactKey: `assembly-annotation-artifact.v4:theme:light:${generation}`,
          themeMode: 'light' as const,
          trackType: 'mRNA',
        },
        request,
      },
      result: null,
      error: null,
    });
    const generationACache = cacheForGeneration('generation-a');
    const generationBCache = cacheForGeneration('generation-b');
    let readinessTargetIdentityKey = 'generation-a-runtime';
    const generationACameraNotifier = vi.fn();
    const generationBCameraNotifier = vi.fn();
    mockUseCompiledBroadRasterSurface.mockImplementation((input: Record<string, unknown>) => {
      const cache = input.cache as {
        descriptor?: { runtimeCacheKey?: string } | null;
      };
      const runtimeCacheKey = cache.descriptor?.runtimeCacheKey ?? null;
      return {
        notifyCameraChanged:
          runtimeCacheKey === 'generation-b-runtime'
            ? generationBCameraNotifier
            : generationACameraNotifier,
        refreshPolicy: vi.fn(),
        getDiagnostics: () => null,
        readiness: 'ready',
        policyControlsReadiness: 'ready',
        targetIdentityKey: cache.descriptor?.runtimeCacheKey ?? null,
        readinessTargetIdentityKey,
        readinessRendererMatchesCurrent: true,
      };
    });
    const onCompiledBroadRasterVisualReady = vi.fn();
    const renderViewer = (cache: typeof generationACache | typeof generationBCache) => (
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={270_000_000}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_000_000),
          assemblySessionConfig('chr12', 135_000_000),
        ]}
        assemblyByChrom={
          new Map([
            ['chr11', []],
            ['chr12', []],
          ])
        }
        themeMode="dark"
        prepackedAnnotationSceneCache={cache as never}
        onCompiledBroadRasterVisualReady={onCompiledBroadRasterVisualReady}
        requireFullAssemblyReadiness
      />
    );

    const { rerender } = render(renderViewer(generationACache));
    await screen.findByTestId('indexed-genome-webgl-map');
    await waitFor(() => expect(onCompiledBroadRasterVisualReady).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(generationACameraNotifier).toHaveBeenCalledWith(
        'scroll',
        { start: 1_000_000, end: 1_001_000 },
        null
      )
    );

    act(() => {
      const onCameraChange = webglState.props?.onCameraChange as
        | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
        | undefined;
      onCameraChange?.(1_000_500, 'zoom');
    });

    rerender(renderViewer(generationBCache));
    await act(async () => Promise.resolve());
    expect(onCompiledBroadRasterVisualReady).toHaveBeenCalledTimes(1);
    expect(generationBCameraNotifier).toHaveBeenCalledWith(
      'zoom',
      { start: 1_000_000, end: 1_001_000 },
      null
    );

    readinessTargetIdentityKey = 'generation-b-runtime';
    rerender(renderViewer(generationBCache));
    await waitFor(() => expect(onCompiledBroadRasterVisualReady).toHaveBeenCalledTimes(2));

    rerender(renderViewer(generationBCache));
    await act(async () => Promise.resolve());
    expect(onCompiledBroadRasterVisualReady).toHaveBeenCalledTimes(2);
  });

  it('keeps compiled annotation readiness authoritative across a display-theme toggle', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );

    const request = {
      assemblyId: 'grch38',
      workspaceRoot: '/fixture/workspace',
      chromosomes: [
        { chrom: 'chr11', length: 135_000_000, sourcePath: '/fixture/workspace/chr11.gff3.gz' },
        { chrom: 'chr12', length: 135_000_000, sourcePath: '/fixture/workspace/chr12.gff3.gz' },
      ],
      scope: {
        kind: 'complete-assembly' as const,
        placements: [
          { chrom: 'chr11', length: 135_000_000, annotationCoverage: 'sourced' as const },
          { chrom: 'chr12', length: 135_000_000, annotationCoverage: 'sourced' as const },
        ],
      },
    };
    const canonicalCache = {
      status: 'loading' as const,
      descriptor: {
        sourceIdentity: 'canonical-theme-independent-source',
        placementFingerprint: 'ap1:0123456789abcdef01234567',
        runtimeCacheKey: 'canonical-light-basis-runtime',
        sceneKey: 'canonical-light-basis-scene',
        artifact: {
          artifactKey: 'assembly-annotation-artifact.v4:theme:light',
          themeMode: 'light' as const,
          trackType: 'mRNA',
        },
        request,
      },
      result: null,
      error: null,
    };
    const debugWindow = window as unknown as {
      __webglExposeForTests?: boolean;
      __indexedGenomeViewerDebug?: {
        compiledAnnotationResidentReadiness?: { readinessScopeKey?: string };
      };
    };
    debugWindow.__webglExposeForTests = true;
    const renderViewer = (displayThemeMode: 'light' | 'dark') => (
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={270_000_000}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_000_000),
          assemblySessionConfig('chr12', 135_000_000),
        ]}
        assemblyByChrom={
          new Map([
            ['chr11', []],
            ['chr12', []],
          ])
        }
        themeMode={displayThemeMode}
        prepackedAnnotationSceneCache={canonicalCache as never}
        requireFullAssemblyReadiness
      />
    );

    const { rerender } = render(renderViewer('light'));
    await screen.findByTestId('indexed-genome-webgl-map');
    await waitFor(() =>
      expect(
        debugWindow.__indexedGenomeViewerDebug?.compiledAnnotationResidentReadiness
          ?.readinessScopeKey
      ).toEqual(expect.any(String))
    );
    const lightScope =
      debugWindow.__indexedGenomeViewerDebug?.compiledAnnotationResidentReadiness
        ?.readinessScopeKey;

    rerender(renderViewer('dark'));

    await waitFor(() =>
      expect(
        debugWindow.__indexedGenomeViewerDebug?.compiledAnnotationResidentReadiness
          ?.readinessScopeKey
      ).toBe(lightScope)
    );
    expect(webglState.props?.themeMode).toBe('dark');
    delete debugWindow.__webglExposeForTests;
  });

  it('reschedules fine-view preparation when ready annotation authority changes theme', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    webglState.linearRenderer = {
      ...physicallyReadyLinearRenderer(),
      preparePrepackedAnnotationFineViews: vi.fn(() => ({
        status: 'complete' as const,
        preparedOwnerKey: null,
        pendingOwnerCount: 0,
      })),
    };

    const cacheForTheme = (themeMode: 'light' | 'dark') => {
      const descriptor = {
        sourceIdentity: 'theme-generation-source',
        placementFingerprint: 'ap1:0123456789abcdef01234567',
        runtimeCacheKey: `${themeMode}-generation-runtime`,
        sceneKey: `${themeMode}-generation-scene`,
        artifact: {
          artifactKey: `assembly-annotation-artifact.v4:${themeMode}:generation`,
          themeMode,
          trackType: 'mRNA',
        },
        request: { requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 } },
      };
      return {
        status: 'hit' as const,
        descriptor,
        result: fixturePrepackedSceneHitResult(descriptor),
        error: null,
      };
    };
    const renderViewer = (themeMode: 'light' | 'dark') => (
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
        themeMode={themeMode}
        prepackedAnnotationSceneCache={cacheForTheme(themeMode) as never}
      />
    );

    const { rerender } = render(renderViewer('light'));
    await screen.findByTestId('indexed-genome-webgl-map');
    webglState.schedulePostPresentWork.mockClear();

    rerender(renderViewer('dark'));

    await waitFor(() => expect(webglState.schedulePostPresentWork).toHaveBeenCalledTimes(1));
  });

  it('does not lock policy controls while compiled broad rasters warm in the background', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    mockUseCompiledBroadRasterSurface.mockReturnValue({
      notifyCameraChanged: vi.fn(),
      refreshPolicy: vi.fn(),
      getDiagnostics: () => null,
      readiness: 'loading',
      policyControlsReadiness: 'warming',
    });

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={270_000_000}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_000_000),
          assemblySessionConfig('chr12', 135_000_000),
        ]}
        assemblyByChrom={
          new Map([
            ['chr11', []],
            ['chr12', []],
          ])
        }
        requireFullAssemblyReadiness
      />
    );

    expect(await screen.findByRole('button', { name: 'Primary only' })).toBeEnabled();
    expect(screen.getByLabelText('Max lanes')).toBeEnabled();
    expect(screen.queryByTestId('annotation-policy-preparation-state')).toBeNull();
  });

  it('keeps the assembly open when a selected compiled annotation product is unavailable', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    mockUseCompiledBroadRasterSurface.mockReturnValue({
      notifyCameraChanged: vi.fn(),
      refreshPolicy: vi.fn(),
      getDiagnostics: () => null,
      readiness: 'unavailable',
      policyControlsReadiness: 'unavailable',
    });
    const onLoadPhase = vi.fn();
    const onTrackError = vi.fn();

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={270_000_000}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_000_000),
          assemblySessionConfig('chr12', 135_000_000),
        ]}
        requireFullAssemblyReadiness
        onLoadPhase={onLoadPhase}
        onTrackError={onTrackError}
      />
    );

    await screen.findByTestId('indexed-genome-webgl-map');
    await waitFor(() => expect(onLoadPhase).toHaveBeenCalledWith('ready'));
    expect(onLoadPhase).not.toHaveBeenCalledWith('error', expect.any(String));
    expect(onTrackError).not.toHaveBeenCalledWith(
      'annotation',
      expect.stringContaining('Re-index')
    );
  });

  it('keeps compiled broad as the sole broad owner across policy switches while optional V4 loads and errors', async () => {
    const testBridge = window as unknown as {
      __test?: {
        setAssemblyAnnotationIsoformMode?: (mode: 'canonical' | 'expanded') => unknown;
        setAssemblyAnnotationLaneLimit?: (laneLimit: number | null) => unknown;
        getAssemblyAnnotationPolicyTransaction?: () => {
          pendingRequestId: number | null;
        };
      };
    };
    testBridge.__test = {};
    mockOpen.mockClear();
    mockGetAnnotationTile.mockClear();
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );

    const descriptor = {
      sourceIdentity: 'optional-v4-source',
      placementFingerprint: 'ap1:0123456789abcdef01234567',
      runtimeCacheKey: 'optional-v4-runtime',
      sceneKey: 'optional-v4-scene',
      artifact: {
        artifactKey: 'assembly-annotation-artifact.v3:optional-v4',
        trackType: 'mRNA',
      },
      request: { requestedPolicy: { isoformMode: 'canonical', laneLimit: 8 } },
    };
    const loadingCache = {
      status: 'loading' as const,
      descriptor,
      result: null,
      error: null,
    };
    const errorCache = {
      status: 'error' as const,
      descriptor,
      result: null,
      error: new Error('optional V4 unavailable'),
    };
    const loadGenome = vi.fn();
    const setAnnotationPresentationSnapshot = vi.fn();
    const ingestAnnotationResidentPages = vi.fn();
    webglState.linearRenderer = {
      loadGenome,
      setAnnotationPresentationSnapshot,
      ingestAnnotationResidentPages,
      getLaneContractRevision: () => 0,
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn(),
      hasTrackData: () => true,
      setTrackData: vi.fn(),
      hasTrackInstance: () => true,
    };

    function Harness({ cache }: { cache: typeof loadingCache | typeof errorCache }) {
      const [policy, setPolicy] = useState({
        isoformMode: 'canonical' as 'canonical' | 'expanded',
        laneLimit: 8 as number | null,
      });
      return (
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={270_000_000}
          sessionId="session-chr11"
          assemblyChromIds={['chr11', 'chr12']}
          assemblySessionConfigs={[
            assemblySessionConfig('chr11', 135_000_000),
            assemblySessionConfig('chr12', 135_000_000),
          ]}
          assemblyByChrom={
            new Map([
              ['chr11', []],
              ['chr12', []],
            ])
          }
          prepackedAnnotationSceneCache={cache as never}
          annotationMapperPolicy={policy}
          onAnnotationMapperPolicyChange={setPolicy}
          requireFullAssemblyReadiness
        />
      );
    }

    const { rerender } = render(<Harness cache={loadingCache} />);
    await screen.findByTestId('indexed-genome-webgl-map');
    const initialGenome = webglState.props?.genome;
    const initialResidentPublication = webglState.props?.annotationResidentPagePublication;
    const initialLoadCount = loadGenome.mock.calls.length;

    webglState.viewportRange = { start: 0, end: 270_000_000 };
    act(() => {
      (
        webglState.props?.onCameraChange as
          | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
          | undefined
      )?.(135_000_000, 'zoom');
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockGetAnnotationTile).not.toHaveBeenCalled();

    const commitPendingPolicy = (policy: {
      isoformMode: 'canonical' | 'expanded';
      laneLimit: number;
    }) => {
      const requestId =
        testBridge.__test?.getAssemblyAnnotationPolicyTransaction?.().pendingRequestId;
      expect(requestId).toEqual(expect.any(Number));
      const input = mockUseCompiledBroadRasterSurface.mock.calls
        .map(([candidate]) => candidate as Record<string, unknown>)
        .findLast(
          (candidate) =>
            candidate.policyRequestId === requestId &&
            (candidate.policy as { isoformMode?: string; laneLimit?: number } | undefined)
              ?.isoformMode === policy.isoformMode &&
            (candidate.policy as { laneLimit?: number } | undefined)?.laneLimit === policy.laneLimit
        );
      expect(input).toBeDefined();
      act(() => {
        (input?.onPolicyCommitted as (receipt: unknown) => void)?.({
          contract: 'assembly-compiled-broad-raster-policy-commit.v1',
          identityKey: 'indexed-full-assembly:chr11+chr12',
          policyRequestId: requestId,
          policy,
          surfaceManifestFingerprint: `${policy.isoformMode}-${policy.laneLimit}-surface`,
          catalogReceiptSha256: `${policy.isoformMode}-${policy.laneLimit}-catalog`,
        });
      });
    };

    resetCompatibilityWork();
    setAnnotationPresentationSnapshot.mockClear();
    act(() => {
      testBridge.__test?.setAssemblyAnnotationIsoformMode?.('expanded');
    });
    commitPendingPolicy({ isoformMode: 'expanded', laneLimit: 8 });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '✓ All isoforms' })).toBeEnabled()
    );

    rerender(<Harness cache={errorCache} />);
    act(() => {
      testBridge.__test?.setAssemblyAnnotationLaneLimit?.(24);
    });
    commitPendingPolicy({ isoformMode: 'expanded', laneLimit: 24 });
    await waitFor(() => expect(screen.getByLabelText('Max lanes')).toHaveValue('24'));

    expect(compatibilityWork).toEqual({
      collapseIsoforms: 0,
      resolveViewportFeatures: 0,
      projectAnchorDensity: 0,
      buildViewportGlyphs: 0,
      buildAnchorGlyphs: 0,
      buildAssemblyGlyphs: 0,
      projectAssemblyLanes: 0,
      buildAssemblyScene: 0,
      adaptSceneToGenome: 0,
      fullSnapshotCandidates: 0,
    });
    expect(setAnnotationPresentationSnapshot).not.toHaveBeenCalled();
    expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined();
    expect(webglState.props?.annotationResidentPagePublication).toBe(initialResidentPublication);
    expect(webglState.props?.genome).toBe(initialGenome);
    expect(loadGenome).toHaveBeenCalledTimes(initialLoadCount);
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockGetAnnotationTile).not.toHaveBeenCalled();
  });

  it('holds the presented policy until the exact compiled-broad raster commits atomically', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const artifact = {
      artifactKey: 'assembly-annotation-artifact.v3:atomic-raster-policy',
      trackType: 'mRNA',
    };
    const descriptor = {
      sourceIdentity: 'atomic-raster-policy-source',
      placementFingerprint: 'ap1:0123456789abcdef01234567',
      runtimeCacheKey: 'atomic-raster-policy-runtime',
      sceneKey: 'atomic-raster-policy-scene',
      artifact,
      request: { requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 } },
    };
    const cache = {
      status: 'hit' as const,
      descriptor,
      result: fixturePrepackedSceneHitResult(descriptor),
      error: null,
    };
    const raster = (fingerprint: string, maxAnnotationLane: number) => ({
      image: { width: 16, height: 8 } as ImageBitmap,
      manifest: {
        version: 1 as const,
        assemblyId: 'chr11+chr12',
        fingerprint,
        cacheContractToken: 'atomic-raster-policy-contract',
        sourceBuildFingerprint: 'atomic-raster-policy-build',
        placementSignature: 'atomic-raster-policy-placement',
        textureFile: `${fingerprint}.png`,
        widthPx: 16,
        heightPx: 8,
        resolution: 1,
        spineOffsetPx: 4,
        genomeLength: 270_000_000,
        maxAnnotationLane,
        maxCdsLane: -1,
        layerTypes: ['mRNA'],
      },
    });
    const canonicalRaster = raster('canonical-12', 11);
    const expandedRaster = raster('expanded-24', 23);
    const loadPrebuiltGenomeWideTexture = vi.fn();
    const commitPrebuiltGenomeWideTexturePolicy = vi.fn(() => true);
    webglState.linearRenderer = {
      loadGenome: vi.fn(),
      loadPrebuiltGenomeWideTexture,
      commitPrebuiltGenomeWideTexturePolicy,
      getLaneContractRevision: () => 0,
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn(),
      hasTrackData: () => true,
      setTrackData: vi.fn(),
      hasTrackInstance: () => true,
    };

    type Policy = {
      isoformMode: 'canonical' | 'expanded';
      laneLimit: number | null;
    };
    type RasterPreparation = {
      requestId: number;
      policy: Policy;
      status: 'loading' | 'ready' | 'miss' | 'error';
    } | null;
    const committedPolicies: Policy[] = [];
    let activePreparationRequestId: number | null = null;
    let publishDecodedExpandedRaster = () => {
      throw new Error('atomic raster harness did not mount');
    };
    let publishStaleDecodedExpandedRaster = () => {
      throw new Error('atomic raster harness did not mount');
    };
    let publishActivePreparationMiss = () => {
      throw new Error('atomic raster harness did not mount');
    };
    function Harness() {
      const [policy, setPolicy] = useState<Policy>({
        isoformMode: 'canonical',
        laneLimit: 12,
      });
      const [preparation, setPreparation] = useState<RasterPreparation>(null);
      const [texture, setTexture] = useState(canonicalRaster);
      publishDecodedExpandedRaster = () => {
        setTexture(expandedRaster);
        if (activePreparationRequestId === null) return;
        setPreparation({
          requestId: activePreparationRequestId,
          policy: { isoformMode: 'expanded', laneLimit: 12 },
          status: 'ready',
        });
      };
      publishStaleDecodedExpandedRaster = () => {
        if (activePreparationRequestId === null) return;
        setPreparation({
          requestId: activePreparationRequestId + 10_000,
          policy: { isoformMode: 'expanded', laneLimit: 12 },
          status: 'ready',
        });
      };
      publishActivePreparationMiss = () => {
        if (activePreparationRequestId === null) return;
        setPreparation({
          requestId: activePreparationRequestId,
          policy: { isoformMode: 'expanded', laneLimit: 24 },
          status: 'miss',
        });
      };
      return (
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={270_000_000}
          sessionId="session-chr11"
          assemblyChromIds={['chr11', 'chr12']}
          assemblySessionConfigs={[
            assemblySessionConfig('chr11', 135_000_000),
            assemblySessionConfig('chr12', 135_000_000),
          ]}
          assemblyByChrom={
            new Map([
              ['chr11', []],
              ['chr12', []],
            ])
          }
          overviewTexture={texture}
          overviewTextureStatus="loaded"
          prepackedAnnotationSceneCache={cache as never}
          annotationMapperPolicy={policy}
          annotationMapperPolicyRasterPreparation={preparation}
          onAnnotationMapperPolicyPreparationRequest={(publication) => {
            if (publication.status === 'prepare') {
              const next = publication.request;
              activePreparationRequestId = next.requestId;
              setPreparation({
                requestId: next.requestId,
                policy: next.policy,
                status: 'loading',
              });
              return;
            }
            if (activePreparationRequestId === publication.requestId) {
              activePreparationRequestId = null;
              setPreparation(null);
            }
          }}
          onAnnotationMapperPolicyChange={(next) => {
            committedPolicies.push(next);
            setPolicy(next);
          }}
          requireFullAssemblyReadiness
        />
      );
    }

    render(<Harness />);
    const toggle = await screen.findByRole('button', { name: 'Primary only' });
    const ready = webglState.props?.onRendererReady as ((epoch: number) => void) | undefined;
    expect(ready).toBeTypeOf('function');
    act(() => ready?.(1));
    expect(loadPrebuiltGenomeWideTexture).not.toHaveBeenCalled();
    await waitFor(() => expect(toggle).toBeEnabled());

    const initialInput = mockUsePrepackedScene.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .find(
        (input) =>
          (input.requestedPolicy as Policy | undefined)?.isoformMode === 'canonical' &&
          (input.requestedPolicy as Policy | undefined)?.laneLimit === 12
      );
    expect(initialInput).toBeDefined();
    act(() => {
      (initialInput?.onPresented as (receipt: unknown) => void)?.({
        descriptor,
        ownerKey: 'atomic-raster-policy-owner',
        metadata: {
          genomeIdentity: descriptor.sourceIdentity,
          artifactKey: artifact.artifactKey,
          trackType: artifact.trackType,
        },
        runtimePolicy: { isoformMode: 'canonical', laneLimit: 12 },
        origin: 'hit',
      });
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    mockUsePrepackedScene.mockClear();

    fireEvent.click(toggle);
    expect(screen.getByTestId('annotation-policy-preparation-state')).toHaveTextContent(
      'Applying annotation settings…'
    );
    expect(toggle).toBeDisabled();
    expect(commitPrebuiltGenomeWideTexturePolicy).not.toHaveBeenCalled();
    expect(loadPrebuiltGenomeWideTexture).not.toHaveBeenCalled();
    expect(
      mockUsePrepackedScene.mock.calls.some(
        ([input]) =>
          ((input as Record<string, unknown>).requestedPolicy as Policy | undefined)
            ?.isoformMode === 'expanded'
      )
    ).toBe(false);
    expect(committedPolicies).toEqual([]);

    act(() => publishStaleDecodedExpandedRaster());
    await act(async () => {
      await Promise.resolve();
    });
    expect(commitPrebuiltGenomeWideTexturePolicy).not.toHaveBeenCalled();
    expect(committedPolicies).toEqual([]);

    act(() => publishDecodedExpandedRaster());
    await act(async () => Promise.resolve());
    expect(commitPrebuiltGenomeWideTexturePolicy).not.toHaveBeenCalled();
    expect(committedPolicies).toEqual([]);
    const compiledExpandedInput = mockUseCompiledBroadRasterSurface.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .findLast(
        (input) =>
          input.policyRequestId === 1 &&
          (input.policy as Policy | undefined)?.isoformMode === 'expanded' &&
          (input.policy as Policy | undefined)?.laneLimit === 12
      );
    expect(compiledExpandedInput).toBeDefined();
    act(() => {
      (compiledExpandedInput?.onPolicyCommitted as (receipt: unknown) => void)?.({
        contract: 'assembly-compiled-broad-raster-policy-commit.v1',
        identityKey: 'compiled-broad-atomic-policy',
        policyRequestId: 1,
        policy: { isoformMode: 'expanded', laneLimit: 12 },
        surfaceManifestFingerprint: 'surface-expanded-12',
        catalogReceiptSha256: 'catalog-expanded-12',
      });
    });
    await waitFor(() =>
      expect(committedPolicies).toEqual([{ isoformMode: 'expanded', laneLimit: 12 }])
    );
    expect(loadPrebuiltGenomeWideTexture).not.toHaveBeenCalled();
    const pendingInput = mockUsePrepackedScene.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .findLast(
        (input) => (input.requestedPolicy as Policy | undefined)?.isoformMode === 'expanded'
      ) as Record<string, unknown> | undefined;
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '✓ All isoforms' })).toBeEnabled()
    );
    const lanePicker = screen.getByLabelText('Max lanes');
    fireEvent.change(lanePicker, { target: { value: '24' } });
    fireEvent.keyDown(lanePicker, { key: 'Enter' });
    expect(screen.getByTestId('annotation-policy-preparation-state')).toHaveTextContent(
      'Applying annotation settings…'
    );
    expect(committedPolicies).toEqual([{ isoformMode: 'expanded', laneLimit: 12 }]);
    expect(loadPrebuiltGenomeWideTexture).not.toHaveBeenCalled();
    expect(commitPrebuiltGenomeWideTexturePolicy).not.toHaveBeenCalled();

    act(() => {
      (pendingInput?.onPresented as (receipt: unknown) => void)?.({
        descriptor,
        ownerKey: 'atomic-raster-policy-owner',
        metadata: {
          genomeIdentity: descriptor.sourceIdentity,
          artifactKey: artifact.artifactKey,
          trackType: artifact.trackType,
        },
        runtimePolicy: { isoformMode: 'expanded', laneLimit: 12 },
        origin: 'hit',
      });
    });
    expect(screen.getByTestId('annotation-policy-preparation-state')).toHaveTextContent(
      'Applying annotation settings…'
    );
    expect(committedPolicies).toEqual([{ isoformMode: 'expanded', laneLimit: 12 }]);

    act(() => publishActivePreparationMiss());
    await act(async () => Promise.resolve());
    expect(screen.getByTestId('annotation-policy-preparation-state')).toHaveTextContent(
      'Applying annotation settings…'
    );
    expect(committedPolicies).toEqual([{ isoformMode: 'expanded', laneLimit: 12 }]);
    expect(screen.getByRole('button', { name: '✓ All isoforms' })).toBeDisabled();
    expect(screen.getByLabelText('Max lanes')).toHaveValue('24');
    expect(loadPrebuiltGenomeWideTexture).not.toHaveBeenCalled();
    expect(commitPrebuiltGenomeWideTexturePolicy).not.toHaveBeenCalled();

    const compiledTwentyFourInput = mockUseCompiledBroadRasterSurface.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .findLast(
        (input) =>
          input.policyRequestId === 2 &&
          (input.policy as Policy | undefined)?.isoformMode === 'expanded' &&
          (input.policy as Policy | undefined)?.laneLimit === 24
      );
    expect(compiledTwentyFourInput).toBeDefined();
    act(() => {
      (compiledTwentyFourInput?.onPolicyCommitted as (receipt: unknown) => void)?.({
        contract: 'assembly-compiled-broad-raster-policy-commit.v1',
        identityKey: 'compiled-broad-atomic-policy',
        policyRequestId: 2,
        policy: { isoformMode: 'expanded', laneLimit: 24 },
        surfaceManifestFingerprint: 'surface-expanded-24',
        catalogReceiptSha256: 'catalog-expanded-24',
      });
    });
    await waitFor(() =>
      expect(committedPolicies).toEqual([
        { isoformMode: 'expanded', laneLimit: 12 },
        { isoformMode: 'expanded', laneLimit: 24 },
      ])
    );
  });

  it('retries a failed compiled-broad policy and accepts only the exact retry receipt', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );

    const genomeLength = 270_000_000;
    const sourceRequest = {
      assemblyId: 'grch38',
      workspaceRoot: '/workspace',
      chromosomes: [
        { chrom: 'chr11', sourcePath: '/workspace/chr11.gff3.gz', length: 135_000_000 },
        { chrom: 'chr12', sourcePath: '/workspace/chr12.gff3.gz', length: 135_000_000 },
      ],
    };
    const datasetContract = {
      datasetId: 'waypoint:assembly-annotation:grch38',
      datasetVersion: 'resolved-transcript-v2',
      sourceSha256: 'a'.repeat(64),
    };
    const artifact = {
      artifactKey: 'assembly-annotation-artifact.v3:end-to-end-raster-retry',
      trackType: 'mRNA',
    };
    const descriptor = {
      sourceIdentity: `assembly-annotation-source-sha256.v1:${'a'.repeat(64)}`,
      datasetContract,
      placementFingerprint: 'ap1:0123456789abcdef01234567',
      runtimeCacheKey: 'end-to-end-raster-retry-runtime',
      sceneKey: 'end-to-end-raster-retry-scene',
      artifact,
      request: { requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 } },
    };
    const cache = {
      status: 'hit' as const,
      descriptor,
      result: fixturePrepackedSceneHitResult(descriptor),
      error: null,
    };
    const rasterResult = (
      label: string,
      maxAnnotationLane: number
    ): AssemblyAnnotationRasterReadResultV2 =>
      ({
        pngBase64: label,
        manifest: {
          version: 2,
          assemblyId: 'grch38',
          fingerprint: label,
          cacheContractToken: 'end-to-end-raster-retry-contract',
          sourceBuildFingerprint: `build-${label}`,
          placementSignature: `placement-${label}`,
          rasterVariantKey: `variant-${label}`,
          rasterVariant: {},
          textureFile: `${label}.png`,
          annotationTrackBaseOffsetPx: 0,
          sourceFingerprint: datasetContract.sourceSha256,
          placementFingerprint: descriptor.placementFingerprint,
          semanticReceipt: {},
          laneProjection: {},
          widthPx: 16,
          heightPx: 8,
          resolution: 1,
          spineOffsetPx: 4,
          genomeLength,
          maxAnnotationLane,
          maxCdsLane: -1,
          layerTypes: ['mRNA'],
        },
      }) as AssemblyAnnotationRasterReadResultV2;
    const canonicalResult = rasterResult('canonical-12', 11);
    const expandedResult = rasterResult('expanded-12-retry', 11);
    let resolveReentrantRequest!: (result: AssemblyAnnotationRasterReadResultV2 | null) => void;
    const reentrantRequest = new Promise<AssemblyAnnotationRasterReadResultV2 | null>((resolve) => {
      resolveReentrantRequest = resolve;
    });
    mockReadAssemblyAnnotationRasterV2
      .mockResolvedValueOnce(canonicalResult)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(expandedResult)
      .mockReturnValueOnce(reentrantRequest);

    const canonicalImage = {
      width: 16,
      height: 8,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    const expandedImage = {
      width: 16,
      height: 8,
      close: vi.fn(),
    } as unknown as ImageBitmap;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        blob: async () => ({ source: url }),
      }))
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async (blob: { source?: string }) =>
        blob.source?.includes('expanded-12-retry') ? expandedImage : canonicalImage
      )
    );

    type Policy = {
      isoformMode: 'canonical' | 'expanded';
      laneLimit: number | null;
    };
    type Request = { requestId: number; policy: Policy };
    const testBridge = window as unknown as {
      __test?: {
        setAssemblyAnnotationLaneLimit?: (laneLimit: number | null) => Policy;
      };
    };
    testBridge.__test = {};
    let reentrantLaneCommand: ((laneLimit: number | null) => Policy) | undefined;
    const preparedRequests: Request[] = [];
    const clearedRequestIds: number[] = [];
    const committedPolicies: Policy[] = [];
    let activeRendererPair: { rasterFingerprint: string; policy: Policy } = {
      rasterFingerprint: 'none',
      policy: { isoformMode: 'canonical', laneLimit: 12 },
    };
    const loadPrebuiltGenomeWideTexture = vi.fn(
      (_image: ImageBitmap, manifest: { fingerprint: string }) => {
        activeRendererPair = {
          ...activeRendererPair,
          rasterFingerprint: manifest.fingerprint,
        };
      }
    );
    let startReentrantRequestOnAtomicCommit = false;
    const commitPrebuiltGenomeWideTexturePolicy = vi.fn(
      (_image: ImageBitmap, manifest: { fingerprint: string }, policy: Policy) => {
        activeRendererPair = {
          rasterFingerprint: manifest.fingerprint,
          policy: { ...policy },
        };
        if (startReentrantRequestOnAtomicCommit) {
          startReentrantRequestOnAtomicCommit = false;
          expect(reentrantLaneCommand?.(24)).toEqual({
            isoformMode: 'expanded',
            laneLimit: 24,
          });
        }
        return true;
      }
    );
    webglState.linearRenderer = {
      loadGenome: vi.fn(),
      loadPrebuiltGenomeWideTexture,
      commitPrebuiltGenomeWideTexturePolicy,
      getLaneContractRevision: () => 0,
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn(),
      hasTrackData: () => true,
      setTrackData: vi.fn(),
      hasTrackInstance: () => true,
    };

    function Harness() {
      const [policy, setPolicy] = useState<Policy>({
        isoformMode: 'canonical',
        laneLimit: 12,
      });
      const [pendingRequest, setPendingRequest] = useState<Request | null>(null);
      const handlePreparationPublication = useCallback(
        (
          publication:
            | { status: 'prepare'; request: Request }
            | { status: 'clear'; requestId: number }
        ) => {
          if (publication.status === 'prepare') {
            preparedRequests.push(publication.request);
            setPendingRequest(publication.request);
            return;
          }
          clearedRequestIds.push(publication.requestId);
          setPendingRequest((current) =>
            current?.requestId === publication.requestId ? null : current
          );
        },
        []
      );
      const handlePolicyChange = useCallback((next: Policy) => {
        committedPolicies.push(next);
        setPolicy(next);
      }, []);
      const handoff = useAssemblyAnnotationRasterHandoff({
        sourceRequest,
        descriptor,
        committedPolicy: policy,
        pendingRequest,
        themeMode: 'light',
      });
      return (
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={genomeLength}
          sessionId="session-chr11"
          assemblyChromIds={['chr11', 'chr12']}
          assemblySessionConfigs={[
            assemblySessionConfig('chr11', 135_000_000),
            assemblySessionConfig('chr12', 135_000_000),
          ]}
          assemblyByChrom={
            new Map([
              ['chr11', []],
              ['chr12', []],
            ])
          }
          overviewTexture={handoff.renderer.texture}
          overviewTextureStatus={handoff.renderer.status}
          prepackedAnnotationSceneCache={cache as never}
          annotationMapperPolicy={policy}
          annotationMapperPolicyRasterPreparation={handoff.pendingPreparation}
          onAnnotationMapperPolicyPreparationRequest={handlePreparationPublication}
          onAnnotationMapperPolicyChange={handlePolicyChange}
          requireFullAssemblyReadiness
        />
      );
    }

    mockUseCompiledBroadRasterSurface.mockImplementation((input: Record<string, unknown>) => ({
      notifyCameraChanged: vi.fn(),
      refreshPolicy: vi.fn(),
      getDiagnostics: () => null,
      readiness: input.policyRequestId === 1 ? 'error' : 'ready',
      policyControlsReadiness: input.policyRequestId === 1 ? 'error' : 'ready',
      policyFailureRequestId: input.policyRequestId === 1 ? 1 : null,
    }));

    render(<Harness />);
    const toggle = await screen.findByRole('button', { name: 'Primary only' });
    const ready = webglState.props?.onRendererReady as ((epoch: number) => void) | undefined;
    expect(ready).toBeTypeOf('function');
    act(() => ready?.(1));
    expect(loadPrebuiltGenomeWideTexture).not.toHaveBeenCalled();
    expect(activeRendererPair).toEqual({
      rasterFingerprint: 'none',
      policy: { isoformMode: 'canonical', laneLimit: 12 },
    });

    const initialInput = mockUsePrepackedScene.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .find(
        (input) =>
          (input.requestedPolicy as Policy | undefined)?.isoformMode === 'canonical' &&
          (input.requestedPolicy as Policy | undefined)?.laneLimit === 12
      );
    act(() => {
      (initialInput?.onPresented as (receipt: unknown) => void)?.({
        descriptor,
        ownerKey: 'end-to-end-raster-retry-owner',
        metadata: {
          genomeIdentity: descriptor.sourceIdentity,
          artifactKey: artifact.artifactKey,
          trackType: artifact.trackType,
        },
        runtimePolicy: { isoformMode: 'canonical', laneLimit: 12 },
        origin: 'hit',
      });
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    await waitFor(() =>
      expect(testBridge.__test?.setAssemblyAnnotationLaneLimit).toBeTypeOf('function')
    );
    reentrantLaneCommand = testBridge.__test?.setAssemblyAnnotationLaneLimit;

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId('annotation-policy-preparation-state')).toHaveTextContent(
        'Couldn’t apply annotation settings'
      )
    );
    expect(preparedRequests).toEqual([]);
    expect(clearedRequestIds).toEqual([1]);
    expect(committedPolicies).toEqual([]);
    expect(activeRendererPair).toEqual({
      rasterFingerprint: 'none',
      policy: { isoformMode: 'canonical', laneLimit: 12 },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Primary only' }));
    await waitFor(() =>
      expect(
        mockUseCompiledBroadRasterSurface.mock.calls.some(
          ([input]) => (input as Record<string, unknown>).policyRequestId === 2
        )
      ).toBe(true)
    );

    expect(preparedRequests).toEqual([]);
    expect(clearedRequestIds).toEqual([1]);
    expect(commitPrebuiltGenomeWideTexturePolicy).not.toHaveBeenCalled();
    expect(loadPrebuiltGenomeWideTexture).not.toHaveBeenCalled();
    expect(activeRendererPair).toEqual({
      rasterFingerprint: 'none',
      policy: { isoformMode: 'canonical', laneLimit: 12 },
    });
    expect(screen.getByTestId('annotation-policy-preparation-state')).toHaveTextContent(
      'Applying annotation settings…'
    );

    const retryInput = mockUseCompiledBroadRasterSurface.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .findLast((input) => input.policyRequestId === 2);
    expect(retryInput).toBeDefined();
    act(() => {
      (retryInput?.onPolicyCommitted as (receipt: unknown) => void)?.({
        contract: 'assembly-compiled-broad-raster-policy-commit.v1',
        identityKey: 'compiled-broad-retry',
        policyRequestId: 1,
        policy: { isoformMode: 'expanded', laneLimit: 12 },
        surfaceManifestFingerprint: 'stale-surface',
        catalogReceiptSha256: 'stale-catalog',
      });
    });
    expect(committedPolicies).toEqual([]);
    expect(screen.getByTestId('annotation-policy-preparation-state')).toHaveTextContent(
      'Applying annotation settings…'
    );
    act(() => {
      (retryInput?.onPolicyCommitted as (receipt: unknown) => void)?.({
        contract: 'assembly-compiled-broad-raster-policy-commit.v1',
        identityKey: 'compiled-broad-retry',
        policyRequestId: 2,
        policy: { isoformMode: 'expanded', laneLimit: 12 },
        surfaceManifestFingerprint: 'retry-surface',
        catalogReceiptSha256: 'retry-catalog',
      });
    });
    await waitFor(() =>
      expect(committedPolicies).toEqual([{ isoformMode: 'expanded', laneLimit: 12 }])
    );
    await waitFor(() =>
      expect(screen.queryByTestId('annotation-policy-preparation-state')).not.toBeInTheDocument()
    );
    expect(clearedRequestIds).toContain(2);
    expect(committedPolicies).toEqual([{ isoformMode: 'expanded', laneLimit: 12 }]);
    expect(screen.getByRole('button', { name: '✓ All isoforms' })).toBeEnabled();
    expect(screen.getByLabelText('Max lanes')).toHaveValue('12');
    expect(loadPrebuiltGenomeWideTexture).not.toHaveBeenCalled();
    expect(activeRendererPair).toEqual({
      rasterFingerprint: 'none',
      policy: { isoformMode: 'canonical', laneLimit: 12 },
    });
  });

  it('keeps selected compiled tracks on the generic sidecar path without reviving the flat plane', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const artifact = {
      artifactKey: 'assembly-annotation-artifact.v3:eligibility-incarnation',
      trackType: 'mRNA',
    };
    const descriptor = {
      sourceIdentity: 'eligibility-incarnation-source',
      runtimeCacheKey: 'eligibility-incarnation-runtime',
      sceneKey: 'eligibility-incarnation-scene',
      artifact,
      request: { requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 } },
    };
    const metadata = {
      genomeIdentity: descriptor.sourceIdentity,
      genomeLengthBp: 270_000_000,
      partitionSpanBp: 10_000_000,
      artifactKey: artifact.artifactKey,
      themeMode: 'dark',
      trackType: artifact.trackType,
      annotationBarHeightPx: 96,
      laneAlgorithmToken: 'test-lane-contract',
      mapperContractToken: 'test-mapper-contract',
      geometryContractToken: 'test-geometry-contract',
      interactionContractToken: 'test-interaction-contract',
    };
    const receipt = {
      descriptor,
      ownerKey: 'eligibility-incarnation-owner',
      metadata,
      runtimePolicy: { isoformMode: 'canonical' as const, laneLimit: 12 },
      origin: 'hit' as const,
    };
    let liveOwner: {
      ownerKey: string | null;
      loaded: boolean;
      gpuPrepared: boolean;
      metadata: typeof metadata | null;
      runtimePolicy: typeof receipt.runtimePolicy | null;
    } | null = null;
    const setAnnotationPresentationSnapshot = vi.fn(() => {
      liveOwner = null;
      return { status: 'applied' as const, generation: 1, invalidatedHover: true as const };
    });
    webglState.linearRenderer = {
      loadGenome: vi.fn(),
      setAnnotationPresentationSnapshot,
      ingestAnnotationResidentPages: vi.fn(),
      getPrepackedAnnotationSceneOwnerSnapshot: () =>
        liveOwner ?? {
          ownerKey: null,
          loaded: false,
          gpuPrepared: false,
          metadata: null,
          runtimePolicy: null,
        },
      getLaneContractRevision: () => 0,
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn(),
      hasTrackData: () => true,
      setTrackData: vi.fn(),
      hasTrackInstance: () => true,
    };
    const cache = {
      status: 'hit' as const,
      descriptor,
      result: fixturePrepackedSceneHitResult(descriptor),
      error: null,
    };
    const renderViewer = () => (
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={270_000_000}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_000_000),
          assemblySessionConfig('chr12', 135_000_000),
        ]}
        assemblyFeatures={[
          {
            id: 1,
            type: 'mRNA',
            start: 100,
            end: 200,
            direction: 'forward',
            displayName: 'TX1',
            color: 0x3366ff,
            lane: 0,
          },
          {
            id: 2,
            type: 'enhancer',
            start: 300,
            end: 400,
            direction: 'none',
            displayName: 'ENH1',
            color: 0x33aa66,
            lane: 0,
          },
        ]}
        prepackedAnnotationSceneCache={cache as never}
        annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
      />
    );
    const { rerender } = render(renderViewer());

    await screen.findByTestId('indexed-genome-webgl-map');
    const initialInput = mockUsePrepackedScene.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .find(
        (input) =>
          (input.effectiveLayerTypes as string[] | undefined)?.length === 1 &&
          (input.effectiveLayerTypes as string[] | undefined)?.[0] === 'mRNA' &&
          input.activateOwner === false &&
          (input.readinessGeneration as string | undefined)?.endsWith(':mRNA') === true
      );
    expect(initialInput).toBeDefined();
    expect(initialInput).toMatchObject({ activateOwner: false, publishBridge: false });
    const stalePresentedCallback = initialInput?.onPresented as
      | ((presented: unknown) => void)
      | undefined;
    liveOwner = {
      ownerKey: receipt.ownerKey,
      loaded: true,
      gpuPrepared: true,
      metadata,
      runtimePolicy: receipt.runtimePolicy,
    };
    act(() => stalePresentedCallback?.(receipt));
    await waitFor(() => expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined());
    resetCompatibilityWork();

    fireEvent.click(screen.getByTestId('annotation-type-picker-summary'));
    const enhancer = await screen.findByTestId('annotation-type-enhancer');
    fireEvent.click(enhancer);
    await waitFor(() => expect(enhancer).toHaveAttribute('aria-pressed', 'true'));
    expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined();
    expect(webglState.props?.genome).toMatchObject({
      annotationLayerTypes: ['enhancer', 'mRNA'],
    });
    expect(
      mockUsePrepackedScene.mock.calls.some(
        ([input]) =>
          ((input as Record<string, unknown>).effectiveLayerTypes as string[] | undefined)?.[0] ===
            'enhancer' &&
          (input as Record<string, unknown>).activateOwner === false &&
          (input as Record<string, unknown>).publishBridge === false
      )
    ).toBe(true);
    expect(screen.getByTestId('indexed-genome-webgl-map')).toBeVisible();
    expect(compatibilityWork.projectAssemblyLanes).toBe(0);
    expect(compatibilityWork.buildAssemblyScene).toBe(0);
    expect(compatibilityWork.fullSnapshotCandidates).toBe(0);
    expect(setAnnotationPresentationSnapshot).not.toHaveBeenCalled();

    mockUsePrepackedScene.mockClear();
    fireEvent.click(enhancer);
    await waitFor(() => expect(enhancer).toHaveAttribute('aria-pressed', 'false'));
    expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined();
    const freshInput = mockUsePrepackedScene.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .find(
        (input) =>
          (input.effectiveLayerTypes as string[] | undefined)?.length === 1 &&
          (input.effectiveLayerTypes as string[] | undefined)?.[0] === 'mRNA' &&
          input.activateOwner === false &&
          (input.readinessGeneration as string | undefined)?.endsWith(':mRNA') === true
      );
    expect(freshInput).toBeDefined();
    expect(freshInput?.onPresented).toBeUndefined();
    const pausedEnhancerInput = mockUsePrepackedScene.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .findLast(
        (input) =>
          (input.effectiveLayerTypes as string[] | undefined)?.[0] === 'enhancer' &&
          (input.cache as { status?: string } | undefined)?.status === 'not-applicable'
      );
    expect(pausedEnhancerInput).toBeDefined();

    liveOwner = {
      ownerKey: receipt.ownerKey,
      loaded: true,
      gpuPrepared: true,
      metadata,
      runtimePolicy: receipt.runtimePolicy,
    };
    act(() => stalePresentedCallback?.(receipt));
    expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined();
    expect(webglState.props?.genome).toMatchObject({ annotationLayerTypes: ['mRNA'] });

    const freshPresentedCallback = freshInput?.onPresented as
      | ((presented: unknown) => void)
      | undefined;
    act(() => freshPresentedCallback?.(receipt));
    await waitFor(() => expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined());
    expect(webglState.props?.genome).toMatchObject({ annotationLayerTypes: ['mRNA'] });
    expect(screen.getByTestId('indexed-genome-webgl-map')).toBeVisible();

    mockUsePrepackedScene.mockClear();
    liveOwner = null;
    rerender(renderViewer());
    expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined();
    const postLossInput = mockUsePrepackedScene.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .findLast(
        (input) =>
          (input.effectiveLayerTypes as string[] | undefined)?.length === 1 &&
          (input.effectiveLayerTypes as string[] | undefined)?.[0] === 'mRNA' &&
          input.activateOwner === false &&
          (input.readinessGeneration as string | undefined)?.endsWith(':mRNA') === true
      );
    expect(postLossInput).toBeDefined();
    expect(postLossInput?.onPresented).toBeUndefined();
    liveOwner = {
      ownerKey: receipt.ownerKey,
      loaded: true,
      gpuPrepared: true,
      metadata,
      runtimePolicy: receipt.runtimePolicy,
    };
    act(() => freshPresentedCallback?.(receipt));
    expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined();
    act(() =>
      (postLossInput?.onPresented as ((presented: unknown) => void) | undefined)?.(receipt)
    );
    await waitFor(() => expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined());
    expect(webglState.props?.genome).toMatchObject({ annotationLayerTypes: ['mRNA'] });
    expect(screen.getByTestId('indexed-genome-webgl-map')).toBeVisible();
  });

  it('does not let mixed-layer V4 ineligibility veto a compiled-broad policy receipt', async () => {
    const testBridge = window as unknown as {
      __test?: {
        setAssemblyAnnotationLaneLimit?: (laneLimit: number | null) => unknown;
        getAssemblyAnnotationPolicyTransaction?: () => {
          committedPolicy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null };
          requestedPolicy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null };
          pendingRequestId: number | null;
          preparationState: 'idle' | 'preparing' | 'error';
        };
      };
    };
    testBridge.__test = {};
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const descriptor = {
      sourceIdentity: 'mixed-layer-source',
      runtimeCacheKey: 'mixed-layer-runtime',
      sceneKey: 'mixed-layer-scene',
      artifact: {
        artifactKey: 'assembly-annotation-artifact.v3:mixed-layer-mrna',
        trackType: 'mRNA',
      },
      request: {
        assemblyId: 'chr11+chr12',
        workspaceRoot: '/workspace',
        chromosomes: [
          { chrom: 'chr11', length: 135_000_000, sourcePath: '/workspace/chr11.gff3.gz' },
          { chrom: 'chr12', length: 135_000_000, sourcePath: '/workspace/chr12.gff3.gz' },
        ],
        scope: {
          kind: 'complete-assembly',
          placements: [
            { chrom: 'chr11', length: 135_000_000, annotationCoverage: 'sourced' },
            { chrom: 'chr12', length: 135_000_000, annotationCoverage: 'sourced' },
          ],
        },
        requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
      },
    };
    const committed = vi.fn();
    const refreshPolicyByTrack = new Map<string, ReturnType<typeof vi.fn>>();
    mockUseCompiledBroadRasterSurface.mockImplementation((input: Record<string, unknown>) => {
      const trackType = (
        input.cache as { descriptor?: { artifact?: { trackType?: string } } } | undefined
      )?.descriptor?.artifact?.trackType;
      const refreshPolicy = refreshPolicyByTrack.get(trackType ?? 'unknown') ?? vi.fn();
      refreshPolicyByTrack.set(trackType ?? 'unknown', refreshPolicy);
      return {
        notifyCameraChanged: vi.fn(),
        refreshPolicy,
        getDiagnostics: () => null,
        readiness: 'ready',
        policyControlsReadiness: 'ready',
      };
    });

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={270_000_000}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_000_000),
          assemblySessionConfig('chr12', 135_000_000),
        ]}
        assemblyFeatures={[
          {
            id: 1,
            type: 'mRNA',
            start: 100,
            end: 200,
            direction: 'forward',
            displayName: 'TX1',
            color: 0x3366ff,
            lane: 0,
          },
          {
            id: 2,
            type: 'enhancer',
            start: 300,
            end: 400,
            direction: 'none',
            displayName: 'ENH1',
            color: 0x33aa66,
            lane: 0,
          },
        ]}
        prepackedAnnotationSceneCache={
          {
            status: 'hit',
            descriptor,
            result: fixturePrepackedSceneHitResult(descriptor),
            error: null,
          } as never
        }
        annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
        onAnnotationMapperPolicyChange={committed}
      />
    );

    fireEvent.click(screen.getByTestId('annotation-type-picker-summary'));
    const enhancer = await screen.findByTestId('annotation-type-enhancer');
    fireEvent.click(enhancer);
    await waitFor(() => expect(enhancer).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() =>
      expect(
        mockUseCompiledBroadRasterSurface.mock.calls
          .map(([input]) => input as Record<string, unknown>)
          .some(
            (input) =>
              (input.cache as { descriptor?: { artifact?: { trackType?: string } } } | undefined)
                ?.descriptor?.artifact?.trackType === 'enhancer'
          )
      ).toBe(true)
    );
    await waitFor(() =>
      expect(testBridge.__test?.setAssemblyAnnotationLaneLimit).toBeTypeOf('function')
    );
    act(() => {
      expect(testBridge.__test?.setAssemblyAnnotationLaneLimit?.(24)).toEqual({
        isoformMode: 'canonical',
        laneLimit: 24,
      });
    });

    await waitFor(() =>
      expect(testBridge.__test?.getAssemblyAnnotationPolicyTransaction?.()).toEqual({
        committedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
        requestedPolicy: { isoformMode: 'canonical', laneLimit: 24 },
        pendingRequestId: 1,
        preparationState: 'preparing',
      })
    );
    expect(committed).not.toHaveBeenCalled();
    const compiledInputs = mockUseCompiledBroadRasterSurface.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .filter((input) => input.policyRequestId === 1);
    const compiledInputByTrackType = new Map(
      compiledInputs.map((input) => [
        (
          (input.cache as { descriptor?: { artifact?: { trackType?: string } } } | undefined)
            ?.descriptor?.artifact?.trackType ?? 'unknown'
        ).toString(),
        input,
      ])
    );
    expect([...compiledInputByTrackType.keys()].sort()).toEqual(['enhancer', 'mRNA']);
    const mrnaCompiledInput = compiledInputByTrackType.get('mRNA');
    const enhancerCompiledInput = compiledInputByTrackType.get('enhancer');
    expect(mrnaCompiledInput?.onPolicyCommitted).toBeTypeOf('function');
    expect(enhancerCompiledInput?.onPolicyCommitted).toBeTypeOf('function');
    act(() => {
      (mrnaCompiledInput?.onPolicyCommitted as (receipt: unknown) => void)?.({
        contract: 'assembly-compiled-broad-raster-policy-commit.v1',
        identityKey: 'mixed-layer-compiled-broad-startup',
        policyRequestId: null,
        policy: { isoformMode: 'canonical', laneLimit: 12 },
        surfaceManifestFingerprint: 'mixed-layer-startup-surface',
        catalogReceiptSha256: 'mixed-layer-startup-catalog',
      });
    });
    expect(refreshPolicyByTrack.get('enhancer')).toHaveBeenCalledTimes(1);
    expect(refreshPolicyByTrack.get('mRNA')).not.toHaveBeenCalled();
    act(() => {
      (mrnaCompiledInput?.onPolicyCommitted as (receipt: unknown) => void)?.({
        contract: 'assembly-compiled-broad-raster-policy-commit.v1',
        identityKey: 'mixed-layer-compiled-broad',
        policyRequestId: 1,
        policy: { isoformMode: 'canonical', laneLimit: 24 },
        surfaceManifestFingerprint: 'mixed-layer-surface',
        catalogReceiptSha256: 'mixed-layer-catalog',
      });
    });
    expect(refreshPolicyByTrack.get('enhancer')).toHaveBeenCalledTimes(2);
    expect(committed).not.toHaveBeenCalled();
    expect(screen.getByTestId('annotation-policy-preparation-state')).toHaveTextContent(
      'Applying annotation settings…'
    );
    act(() => {
      (enhancerCompiledInput?.onPolicyCommitted as (receipt: unknown) => void)?.({
        contract: 'assembly-compiled-broad-raster-policy-commit.v1',
        identityKey: 'mixed-layer-compiled-broad-enhancer',
        policyRequestId: 1,
        policy: { isoformMode: 'canonical', laneLimit: 24 },
        surfaceManifestFingerprint: 'mixed-layer-enhancer-surface',
        catalogReceiptSha256: 'mixed-layer-enhancer-catalog',
      });
    });
    expect(refreshPolicyByTrack.get('mRNA')).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(committed).toHaveBeenCalledWith({ isoformMode: 'canonical', laneLimit: 24 })
    );
    expect(screen.getByLabelText('Max lanes')).toHaveValue('12');
    expect(screen.getByTestId('annotation-policy-preparation-state')).toHaveTextContent(
      'Applying annotation settings…'
    );
  });

  it('settles an enhancer-only policy request through the selected-track loader', async () => {
    const testBridge = window as unknown as {
      __test?: {
        setAssemblyAnnotationLaneLimit?: (laneLimit: number | null) => unknown;
        getAssemblyAnnotationPolicyTransaction?: () => {
          committedPolicy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null };
          requestedPolicy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null };
          pendingRequestId: number | null;
          preparationState: 'idle' | 'preparing' | 'error';
        };
      };
    };
    testBridge.__test = {};
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const descriptor = {
      sourceIdentity: 'enhancer-only-source',
      runtimeCacheKey: 'enhancer-only-runtime',
      sceneKey: 'enhancer-only-scene',
      artifact: {
        artifactKey: 'assembly-annotation-artifact.v4:enhancer-only-mrna',
        trackType: 'mRNA',
        themeMode: 'light',
      },
      request: {
        assemblyId: 'chr11+chr12',
        workspaceRoot: '/workspace',
        chromosomes: [
          { chrom: 'chr11', length: 135_000_000, sourcePath: '/workspace/chr11.gff3.gz' },
          { chrom: 'chr12', length: 135_000_000, sourcePath: '/workspace/chr12.gff3.gz' },
        ],
        scope: {
          kind: 'complete-assembly',
          placements: [
            { chrom: 'chr11', length: 135_000_000, annotationCoverage: 'sourced' },
            { chrom: 'chr12', length: 135_000_000, annotationCoverage: 'sourced' },
          ],
        },
        requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
      },
    };
    const committedPolicies: Array<{
      isoformMode: 'canonical' | 'expanded';
      laneLimit: number | null;
    }> = [];

    function Harness() {
      const [policy, setPolicy] = useState<{
        isoformMode: 'canonical' | 'expanded';
        laneLimit: number | null;
      }>({ isoformMode: 'canonical', laneLimit: 12 });
      return (
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={270_000_000}
          sessionId="session-chr11"
          assemblyChromIds={['chr11', 'chr12']}
          assemblySessionConfigs={[
            assemblySessionConfig('chr11', 135_000_000),
            assemblySessionConfig('chr12', 135_000_000),
          ]}
          assemblyFeatures={[
            {
              id: 1,
              type: 'mRNA',
              start: 100,
              end: 200,
              direction: 'forward',
              displayName: 'TX1',
              color: 0x3366ff,
              lane: 0,
            },
            {
              id: 2,
              type: 'enhancer',
              start: 300,
              end: 400,
              direction: 'none',
              displayName: 'ENH1',
              color: 0x33aa66,
              lane: 0,
            },
          ]}
          prepackedAnnotationSceneCache={
            {
              status: 'hit',
              descriptor,
              result: fixturePrepackedSceneHitResult(descriptor),
              error: null,
            } as never
          }
          annotationMapperPolicy={policy}
          onAnnotationMapperPolicyChange={(next) => {
            committedPolicies.push(next);
            setPolicy(next);
          }}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(await screen.findByTestId('annotation-type-picker-summary'));
    const enhancer = await screen.findByTestId('annotation-type-enhancer');
    const mrna = await screen.findByTestId('annotation-type-mRNA');
    fireEvent.click(enhancer);
    fireEvent.click(mrna);
    await waitFor(() => {
      expect(enhancer).toHaveAttribute('aria-pressed', 'true');
      expect(mrna).toHaveAttribute('aria-pressed', 'false');
    });
    act(() => {
      expect(testBridge.__test?.setAssemblyAnnotationLaneLimit?.(24)).toEqual({
        isoformMode: 'canonical',
        laneLimit: 24,
      });
    });

    let enhancerCompiledInput: Record<string, unknown> | undefined;
    await waitFor(() => {
      enhancerCompiledInput = mockUseCompiledBroadRasterSurface.mock.calls
        .map(([input]) => input as Record<string, unknown>)
        .findLast(
          (input) =>
            input.policyRequestId === 1 &&
            (input.cache as { descriptor?: { artifact?: { trackType?: string } } } | undefined)
              ?.descriptor?.artifact?.trackType === 'enhancer'
        );
      expect(enhancerCompiledInput?.onPolicyCommitted).toBeTypeOf('function');
    });
    act(() => {
      (enhancerCompiledInput?.onPolicyCommitted as (receipt: unknown) => void)?.({
        contract: 'assembly-compiled-broad-raster-policy-commit.v1',
        identityKey: 'enhancer-only-compiled-broad',
        policyRequestId: 1,
        policy: { isoformMode: 'canonical', laneLimit: 24 },
        surfaceManifestFingerprint: 'enhancer-only-surface',
        catalogReceiptSha256: 'enhancer-only-catalog',
      });
    });

    await waitFor(() =>
      expect(committedPolicies).toEqual([{ isoformMode: 'canonical', laneLimit: 24 }])
    );
    expect(testBridge.__test?.getAssemblyAnnotationPolicyTransaction?.()).toEqual({
      committedPolicy: { isoformMode: 'canonical', laneLimit: 24 },
      requestedPolicy: { isoformMode: 'canonical', laneLimit: 24 },
      pendingRequestId: null,
      preparationState: 'idle',
    });
  });

  it('rejects an unavailable selected track locally without failing the assembly', async () => {
    const testBridge = window as unknown as {
      __test?: {
        setAssemblyAnnotationLaneLimit?: (laneLimit: number | null) => unknown;
        getAssemblyAnnotationPolicyTransaction?: () => {
          committedPolicy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null };
          requestedPolicy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null };
          pendingRequestId: number | null;
          preparationState: 'idle' | 'preparing' | 'error';
        };
      };
    };
    testBridge.__test = {};
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const descriptor = {
      sourceIdentity: 'track-local-unavailable-source',
      runtimeCacheKey: 'track-local-unavailable-runtime',
      sceneKey: 'track-local-unavailable-scene',
      artifact: {
        artifactKey: 'assembly-annotation-artifact.v4:track-local-unavailable-mrna',
        trackType: 'mRNA',
        themeMode: 'light',
      },
      request: {
        assemblyId: 'chr11+chr12',
        workspaceRoot: '/workspace',
        chromosomes: [
          { chrom: 'chr11', length: 135_000_000, sourcePath: '/workspace/chr11.gff3.gz' },
          { chrom: 'chr12', length: 135_000_000, sourcePath: '/workspace/chr12.gff3.gz' },
        ],
        scope: {
          kind: 'complete-assembly',
          placements: [
            { chrom: 'chr11', length: 135_000_000, annotationCoverage: 'sourced' },
            { chrom: 'chr12', length: 135_000_000, annotationCoverage: 'sourced' },
          ],
        },
        requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
      },
    };
    mockUseCompiledBroadRasterSurface.mockImplementation((input: Record<string, unknown>) => {
      const trackType = (
        input.cache as { descriptor?: { artifact?: { trackType?: string } } } | undefined
      )?.descriptor?.artifact?.trackType;
      const unavailable = trackType === 'enhancer';
      return {
        notifyCameraChanged: vi.fn(),
        refreshPolicy: vi.fn(),
        getDiagnostics: () => null,
        readiness: unavailable ? 'unavailable' : 'ready',
        policyControlsReadiness: unavailable ? 'unavailable' : 'ready',
        policyFailureRequestId: unavailable ? (input.policyRequestId ?? null) : null,
      };
    });
    const onLoadPhase = vi.fn();
    const onTrackError = vi.fn();
    const committed = vi.fn();

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={270_000_000}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_000_000),
          assemblySessionConfig('chr12', 135_000_000),
        ]}
        assemblyFeatures={[
          {
            id: 1,
            type: 'mRNA',
            start: 100,
            end: 200,
            direction: 'forward',
            displayName: 'TX1',
            color: 0x3366ff,
            lane: 0,
          },
          {
            id: 2,
            type: 'enhancer',
            start: 300,
            end: 400,
            direction: 'none',
            displayName: 'ENH1',
            color: 0x33aa66,
            lane: 0,
          },
        ]}
        prepackedAnnotationSceneCache={
          {
            status: 'hit',
            descriptor,
            result: fixturePrepackedSceneHitResult(descriptor),
            error: null,
          } as never
        }
        annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
        onAnnotationMapperPolicyChange={committed}
        onLoadPhase={onLoadPhase}
        onTrackError={onTrackError}
      />
    );

    fireEvent.click(await screen.findByTestId('annotation-type-picker-summary'));
    const enhancer = await screen.findByTestId('annotation-type-enhancer');
    fireEvent.click(enhancer);
    await waitFor(() => expect(enhancer).toHaveAttribute('aria-pressed', 'true'));
    act(() => {
      testBridge.__test?.setAssemblyAnnotationLaneLimit?.(24);
    });

    await waitFor(() =>
      expect(testBridge.__test?.getAssemblyAnnotationPolicyTransaction?.()).toMatchObject({
        committedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
        requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
        preparationState: 'error',
      })
    );
    expect(committed).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Max lanes')).toHaveValue('12');
    expect(onLoadPhase.mock.calls.some(([phase]) => phase === 'error')).toBe(false);
    expect(
      onTrackError.mock.calls.some(
        ([kind, message]) => kind === 'annotation' && String(message).includes('Re-index')
      )
    ).toBe(false);
  });

  it.each(['error', 'miss'] as const)(
    'does not let a V4 runtime scene %s veto the compiled-broad policy identity',
    async (cacheFailure) => {
      mockGetFeatures.mockResolvedValue([]);
      mockGetAnnotationTile.mockResolvedValue(summaryTile());
      mockGetSequenceWindow.mockResolvedValue(
        sequenceWindowResponse('session-chr11', {
          chrom: 'chr11',
          start: 0,
          end: 0,
          generation: 0,
        })
      );
      const descriptor = {
        sourceIdentity: 'policy-error-source',
        runtimeCacheKey: 'one-policy-neutral-runtime',
        sceneKey: 'one-policy-neutral-scene',
        artifact: {
          artifactKey: 'assembly-annotation-artifact.v3:test-error-mrna',
          trackType: 'mRNA',
        },
        request: { requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 } },
      };
      const hit = {
        status: 'hit' as const,
        descriptor,
        result: fixturePrepackedSceneHitResult(descriptor),
        error: null,
      };
      const failedCache =
        cacheFailure === 'error'
          ? {
              status: 'error' as const,
              descriptor,
              result: null,
              error: new Error('IPC read failed once'),
            }
          : {
              status: 'miss' as const,
              descriptor,
              result: {
                status: 'miss' as const,
                ipcContractVersion: 'assembly-annotation-scene-ipc.v4' as const,
                fingerprint: 'miss-fingerprint',
                sourceBuildFingerprint: 'miss-source-build-fingerprint',
              },
              error: null,
            };
      const committed = vi.fn();
      const onTrackError = vi.fn();
      const onTrackReady = vi.fn();
      type PreparationRequest = {
        requestId: number;
        policy: {
          isoformMode: 'canonical' | 'expanded';
          laneLimit: number | null;
        };
      };
      const preparationRequests: Array<PreparationRequest | null> = [];

      function Harness() {
        const [preparationRequest, setPreparationRequest] = useState<PreparationRequest | null>(
          null
        );
        return (
          <IndexedGenomeViewer
            manifest={freshManifest()}
            length={270_000_000}
            sessionId="session-chr11"
            assemblyChromIds={['chr11', 'chr12']}
            assemblySessionConfigs={[
              assemblySessionConfig('chr11', 135_000_000),
              assemblySessionConfig('chr12', 135_000_000),
            ]}
            assemblyByChrom={
              new Map([
                ['chr11', []],
                ['chr12', []],
              ])
            }
            prepackedAnnotationSceneCache={failedCache as never}
            annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
            onAnnotationMapperPolicyChange={committed}
            onTrackError={onTrackError}
            onTrackReady={onTrackReady}
            onAnnotationMapperPolicyPreparationRequest={(publication) => {
              if (publication.status === 'prepare') {
                preparationRequests.push(publication.request);
                setPreparationRequest(publication.request);
                return;
              }
              preparationRequests.push(null);
              setPreparationRequest((current) =>
                current?.requestId === publication.requestId ? null : current
              );
            }}
            requireFullAssemblyReadiness
          />
        );
      }

      render(<Harness />);
      await waitFor(() =>
        expect(onTrackError).toHaveBeenCalledWith(
          'annotation',
          'Cached reference data is present, but DNAForge could not load the annotation view.'
        )
      );
      expect(onTrackReady).not.toHaveBeenCalled();
      const laneSelect = await screen.findByLabelText('Max lanes');
      await waitFor(() => expect(laneSelect).toBeEnabled());
      fireEvent.change(laneSelect, { target: { value: '16' } });
      fireEvent.keyDown(laneSelect, { key: 'Enter' });

      await waitFor(() =>
        expect(
          mockUseCompiledBroadRasterSurface.mock.calls.some(
            ([input]) => (input as Record<string, unknown>).policyRequestId === 1
          )
        ).toBe(true)
      );
      expect(preparationRequests).toEqual([]);
      expect(committed).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Max lanes')).toHaveValue('16');
      expect(hit.descriptor.artifact).toBe(failedCache.descriptor.artifact);
      expect(hit.descriptor.runtimeCacheKey).toBe(failedCache.descriptor.runtimeCacheKey);
      expect(screen.getByTestId('annotation-policy-preparation-state')).toHaveTextContent(
        'Applying annotation settings…'
      );

      const compiledInput = mockUseCompiledBroadRasterSurface.mock.calls
        .map(([input]) => input as Record<string, unknown>)
        .findLast((input) => input.policyRequestId === 1);
      expect(compiledInput).toBeDefined();
      act(() => {
        (compiledInput?.onPolicyCommitted as (receipt: unknown) => void)?.({
          contract: 'assembly-compiled-broad-raster-policy-commit.v1',
          identityKey: 'one-policy-neutral-compiled-broad',
          policyRequestId: 1,
          policy: { isoformMode: 'canonical', laneLimit: 16 },
          surfaceManifestFingerprint: 'policy-error-surface',
          catalogReceiptSha256: 'policy-error-catalog',
        });
      });
      await waitFor(() =>
        expect(committed).toHaveBeenCalledWith({ isoformMode: 'canonical', laneLimit: 16 })
      );
      expect(preparationRequests).toEqual([]);
    }
  );

  it('clears a visible annotation failure only after the exact renderer owner presents', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const descriptor = {
      sourceIdentity: 'recovered-source',
      runtimeCacheKey: 'recovered-runtime',
      sceneKey: 'recovered-scene',
      artifact: {
        artifactKey: 'assembly-annotation-artifact.v3:recovered-mrna',
        trackType: 'mRNA',
      },
      request: { requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 } },
    };
    const failedCache = {
      status: 'error' as const,
      descriptor,
      result: null,
      error: new Error('packaged protocol fetch failed'),
    };
    const hitCache = {
      status: 'hit' as const,
      descriptor,
      result: fixturePrepackedSceneHitResult(descriptor),
      error: null,
    };
    const onTrackError = vi.fn();
    const onTrackReady = vi.fn();
    let publishRecoveredCache = (): void => {
      throw new Error('Harness has not mounted');
    };

    mockUsePrepackedScene.mockReturnValue('error');

    function Harness() {
      const [cache, setCache] = useState(failedCache);
      publishRecoveredCache = () => setCache(hitCache);
      return (
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={270_000_000}
          sessionId="session-chr11"
          assemblyChromIds={['chr11', 'chr12']}
          assemblySessionConfigs={[
            assemblySessionConfig('chr11', 135_000_000),
            assemblySessionConfig('chr12', 135_000_000),
          ]}
          assemblyByChrom={
            new Map([
              ['chr11', []],
              ['chr12', []],
            ])
          }
          prepackedAnnotationSceneCache={cache as never}
          annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
          onTrackError={onTrackError}
          onTrackReady={onTrackReady}
          requireFullAssemblyReadiness
        />
      );
    }

    render(<Harness />);
    await waitFor(() =>
      expect(onTrackError).toHaveBeenCalledWith(
        'annotation',
        'Cached reference data is present, but DNAForge could not load the annotation view.'
      )
    );

    act(() => publishRecoveredCache());
    const presentationInput = await waitFor(() => {
      const input = mockUsePrepackedScene.mock.calls
        .map(([candidate]) => candidate as Record<string, unknown>)
        .findLast((candidate) => typeof candidate.onPresented === 'function');
      expect(input).toBeDefined();
      return input;
    });
    expect(onTrackReady).not.toHaveBeenCalled();

    const receipt = {
      descriptor,
      ownerKey: 'recovered-owner',
      metadata: {
        genomeIdentity: descriptor.sourceIdentity,
        artifactKey: descriptor.artifact.artifactKey,
        trackType: descriptor.artifact.trackType,
      },
      runtimePolicy: { isoformMode: 'canonical' as const, laneLimit: 12 },
      origin: 'hit' as const,
    };
    const recoveredRenderer = {
      getLaneContractRevision: () => 0,
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn(),
      hasTrackData: () => true,
      setTrackData: vi.fn(),
      hasTrackInstance: () => true,
      getPrepackedAnnotationSceneOwnerSnapshot: () => ({
        ownerKey: receipt.ownerKey,
        loaded: true,
        gpuPrepared: true,
        metadata: receipt.metadata,
        runtimePolicy: receipt.runtimePolicy,
      }),
    };
    webglState.linearRenderer = recoveredRenderer;
    act(() => {
      (presentationInput.onPresented as (value: typeof receipt) => void)(receipt);
    });

    await waitFor(() => expect(onTrackReady).toHaveBeenCalledWith('annotation'));
    await waitFor(() => expect(recoveredRenderer.registerTrack).toHaveBeenCalled());
    expect(onTrackReady).toHaveBeenCalledTimes(1);
    expect(onTrackError).toHaveBeenCalledTimes(1);
  });

  it('publishes recovery from the compiled-track owner when the legacy scene projection stays stale', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const descriptor = {
      sourceIdentity: 'compiled-recovered-source',
      runtimeCacheKey: 'compiled-recovered-runtime',
      sceneKey: 'compiled-recovered-scene',
      artifact: {
        artifactKey: 'assembly-annotation-artifact.v3:compiled-recovered-mrna',
        trackType: 'mRNA',
      },
      request: { requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 } },
    };
    const failedCache = {
      status: 'error' as const,
      descriptor,
      result: null,
      error: new Error('packaged protocol fetch failed'),
    };
    const hitCache = {
      status: 'hit' as const,
      descriptor,
      result: fixturePrepackedSceneHitResult(descriptor),
      error: null,
    };
    mockUseCompiledBroadRasterSurface.mockReturnValue(fixtureReadyCompiledBroadSurface(descriptor));
    mockUsePrepackedScene.mockImplementation((input: Record<string, unknown>) => {
      const cache = input.cache as { status?: string } | undefined;
      return input.publishBridge === false && cache?.status === 'hit' ? 'loaded-hit' : 'error';
    });
    const onTrackError = vi.fn();
    const onTrackReady = vi.fn();
    let publishRecoveredCache = (): void => {
      throw new Error('Harness has not mounted');
    };

    function Harness() {
      const [cache, setCache] = useState(failedCache);
      publishRecoveredCache = () => setCache(hitCache);
      return (
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={270_000_000}
          sessionId="session-chr11"
          assemblyChromIds={['chr11', 'chr12']}
          assemblySessionConfigs={[
            assemblySessionConfig('chr11', 135_000_000),
            assemblySessionConfig('chr12', 135_000_000),
          ]}
          assemblyByChrom={
            new Map([
              ['chr11', []],
              ['chr12', []],
            ])
          }
          prepackedAnnotationSceneCache={cache as never}
          annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
          onTrackError={onTrackError}
          onTrackReady={onTrackReady}
          requireFullAssemblyReadiness
        />
      );
    }

    render(<Harness />);
    await waitFor(() =>
      expect(onTrackError).toHaveBeenCalledWith('annotation', expect.any(String))
    );
    expect(onTrackReady).not.toHaveBeenCalled();

    act(() => publishRecoveredCache());

    await waitFor(() => expect(onTrackReady).toHaveBeenCalledWith('annotation'));
    expect(
      mockUsePrepackedScene.mock.calls.some(
        ([input]) =>
          (input as Record<string, unknown>).publishBridge === false &&
          ((input as Record<string, unknown>).cache as { status?: string }).status === 'hit'
      )
    ).toBe(true);
  });

  it('retains current annotation authority across readiness metadata but not a source revision', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const canonicalCache = {
      status: 'hit' as const,
      descriptor: {
        sourceIdentity: 'source-before-revision',
        sceneKey: 'canonical-before-revision',
        sceneVariant: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 12 },
      },
      result: fixturePrepackedSceneHitResult({
        sceneKey: 'canonical-before-revision',
        sceneVariant: { trackType: 'mRNA' },
      }),
      error: null,
    };
    let activeOwner: { ownerKey: string; genomeIdentity: string } | null = {
      ownerKey: 'canonical-owner-before-revision',
      genomeIdentity: 'source-before-revision',
    };
    webglState.linearRenderer = {
      getLaneContractRevision: () => 0,
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn(),
      hasTrackData: () => true,
      setTrackData: vi.fn(),
      hasTrackInstance: () => true,
      loadGenome: (genome) => {
        const genomeIdentity = genome.sourceIdentity ?? '';
        if (activeOwner && activeOwner.genomeIdentity !== genomeIdentity) activeOwner = null;
      },
    };
    const originalConfigs = [
      assemblySessionConfig('chr11', 135_000_000),
      assemblySessionConfig('chr12', 135_000_000),
    ];
    const baseProps = {
      manifest: freshManifest(),
      length: 270_000_000,
      sessionId: 'session-chr11',
      assemblyChromIds: ['chr11', 'chr12'],
      assemblyByChrom: new Map([
        ['chr11', []],
        ['chr12', []],
      ]),
      requireFullAssemblyReadiness: true,
    };
    const { rerender } = render(
      <IndexedGenomeViewer
        {...baseProps}
        assemblySessionConfigs={originalConfigs}
        prepackedAnnotationSceneCache={canonicalCache as never}
        annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
      />
    );

    await screen.findByTestId('indexed-genome-webgl-map');
    expect(activeOwner?.ownerKey).toBe('canonical-owner-before-revision');

    const readinessUpdatedConfigs = originalConfigs.map((config) =>
      config.chrom === 'chr11'
        ? {
            ...config,
            manifest: { ...config.manifest, fastaPath: '/workspace/prepared/chr11.fa' },
          }
        : config
    );
    rerender(
      <IndexedGenomeViewer
        {...baseProps}
        assemblySessionConfigs={readinessUpdatedConfigs}
        prepackedAnnotationSceneCache={canonicalCache as never}
        annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
      />
    );

    expect(
      (webglState.props?.genome as { sourceIdentity?: string } | undefined)?.sourceIdentity
    ).toBe('source-before-revision');
    expect(activeOwner?.ownerKey).toBe('canonical-owner-before-revision');

    const revisedConfigs = readinessUpdatedConfigs.map((config) =>
      config.chrom === 'chr11'
        ? {
            ...config,
            source: { ...config.source, sourcePath: '/workspace/revised/chr11.gff3.gz' },
            manifest: { ...config.manifest, gffPath: '/workspace/revised/chr11.gff3.gz' },
          }
        : config
    );
    rerender(
      <IndexedGenomeViewer
        {...baseProps}
        assemblySessionConfigs={revisedConfigs}
        prepackedAnnotationSceneCache={
          { status: 'not-applicable', descriptor: null, result: null, error: null } as never
        }
        annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
      />
    );

    expect(
      (webglState.props?.genome as { sourceIdentity?: string } | undefined)?.sourceIdentity
    ).toMatch(/^assembly-annotation-source-scope\.v1\n/);
    for (const published of webglState.propsHistory) {
      const genome = published.genome as
        | { sourceIdentity?: string; name?: string; length?: number }
        | undefined;
      const snapshot = published.annotationPresentationSnapshot as
        | { sourceIdentity?: string; genomeLengthBp?: number }
        | undefined;
      if (!genome || !snapshot) continue;
      expect(genome.sourceIdentity ?? genome.name).toBe(snapshot.sourceIdentity);
      expect(genome.length).toBe(snapshot.genomeLengthBp);
    }
    expect(activeOwner).toBeNull();
  });

  it('never revives the flat compatibility plane when compiled broad is required', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const emptyByChrom = new Map([
      ['chr11', []],
      ['chr12', []],
    ]);
    const detailByChrom = new Map([
      [
        'chr11',
        [
          {
            id: 101,
            type: 'mRNA',
            start: 10_000,
            end: 20_000,
            direction: 'forward' as const,
            displayName: 'TX101',
            color: 0x3b82f6,
            lane: 17,
            exons: [{ start: 10_000, end: 20_000 }],
            transcriptId: 'tx-101',
            qualifiers: { ID: 'tx-101', _lane: '17' },
          },
        ],
      ],
      ['chr12', []],
    ]);
    const overviewTexture = {
      image: { width: 16, height: 8 } as ImageBitmap,
      manifest: {
        version: 1 as const,
        assemblyId: 'chr11+chr12',
        fingerprint: 'test-fingerprint',
        cacheContractToken: 'test-contract',
        sourceBuildFingerprint: 'test-build',
        placementSignature: 'placement:test',
        textureFile: 'chr11+chr12-test-fingerprint.png',
        widthPx: 16,
        heightPx: 8,
        resolution: 1,
        spineOffsetPx: 4,
        genomeLength: 270_000_000,
        maxAnnotationLane: 17,
        maxCdsLane: 2,
        layerTypes: ['gene', 'mRNA', 'CDS'],
      },
    };
    const baseProps = {
      manifest: freshManifest(),
      length: 270_000_000,
      sessionId: 'session-chr11',
      assemblyChromIds: ['chr11', 'chr12'],
    };
    const { rerender } = render(
      <IndexedGenomeViewer
        {...baseProps}
        assemblyByChrom={emptyByChrom}
        annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
      />
    );

    const rendererGenome = () =>
      webglState.props?.genome as
        | {
            annotationLayout?: { maxAnnotationLane: number; maxCdsLane: number };
            features?: Array<{ lane: number; qualifiers?: Record<string, string> }>;
          }
        | undefined;
    const annotationSnapshot = () =>
      webglState.props?.annotationPresentationSnapshot as
        | {
            policyKey: string;
            generation: number;
            layout: { maxAnnotationLane: number; maxCdsLane: number };
            features: ReadonlyArray<{
              lane: number;
              qualifiers?: Record<string, string>;
            }>;
          }
        | undefined;
    await screen.findByTestId('indexed-genome-webgl-map');
    expect(annotationSnapshot()).toBeUndefined();
    const stableAssemblyShell = rendererGenome();

    rerender(
      <IndexedGenomeViewer
        {...baseProps}
        assemblyByChrom={detailByChrom}
        annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
      />
    );
    expect(annotationSnapshot()).toBeUndefined();
    expect(rendererGenome()).toBe(stableAssemblyShell);

    rerender(
      <IndexedGenomeViewer
        {...baseProps}
        assemblyByChrom={detailByChrom}
        overviewTexture={overviewTexture}
        overviewTextureStatus="loaded"
        annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
      />
    );
    expect(annotationSnapshot()).toBeUndefined();
    expect(rendererGenome()).toBe(stableAssemblyShell);
    resetCompatibilityWork();

    rerender(
      <IndexedGenomeViewer
        {...baseProps}
        assemblyByChrom={detailByChrom}
        overviewTexture={overviewTexture}
        overviewTextureStatus="loaded"
        annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 8 }}
      />
    );
    expect(annotationSnapshot()).toBeUndefined();
    expect(rendererGenome()).toBe(stableAssemblyShell);
    expect(compatibilityWork.projectAssemblyLanes).toBe(0);
    expect(compatibilityWork.buildAssemblyGlyphs).toBe(0);
    expect(compatibilityWork.buildAssemblyScene).toBe(0);
    expect(compatibilityWork.fullSnapshotCandidates).toBe(0);
  });

  it('keeps one strict-equal compiled assembly shell while 62→40→28 flat sources publish nothing', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const loadGenome = vi.fn();
    const setAnnotationPresentationSnapshot = vi.fn((snapshot: { generation: number }) => ({
      status: 'applied' as const,
      generation: snapshot.generation,
      invalidatedHover: true as const,
    }));
    webglState.linearRenderer = {
      loadGenome,
      setAnnotationPresentationSnapshot,
      getLaneContractRevision: () => 0,
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn(),
      hasTrackData: () => true,
      setTrackData: vi.fn(),
      hasTrackInstance: () => true,
    };

    const features = (count: number) =>
      Array.from({ length: count }, (_, id) => ({
        id: id + 1,
        type: 'mRNA',
        start: id * 10_000,
        end: id * 10_000 + 5_000,
        direction: 'forward' as const,
        displayName: `TX${id + 1}`,
        color: 0x3b82f6,
        lane: 0,
        transcriptId: `tx-${id + 1}`,
        qualifiers: { ID: `tx-${id + 1}`, _lane: '0' },
      }));
    const byChrom = (count: number) =>
      new Map([
        ['chr11', features(count)],
        ['chr12', []],
      ]);
    const baseProps = {
      manifest: freshManifest(),
      length: 270_000_000,
      sessionId: 'session-chr11',
      assemblyChromIds: ['chr11', 'chr12'],
      annotationMapperPolicy: { isoformMode: 'canonical' as const, laneLimit: 12 },
    };
    const { rerender } = render(
      <IndexedGenomeViewer {...baseProps} assemblyByChrom={byChrom(0)} />
    );

    await screen.findByTestId('indexed-genome-webgl-map');
    expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined();
    const stableShell = webglState.props?.genome;
    const firstExposedMapProps = webglState.propsHistory.find((props) => props.genome);
    expect(firstExposedMapProps?.annotationPresentationSnapshot).toBeUndefined();
    loadGenome.mockClear();
    setAnnotationPresentationSnapshot.mockClear();

    rerender(<IndexedGenomeViewer {...baseProps} assemblyByChrom={byChrom(62)} />);
    expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined();
    expect(webglState.props?.genome).toBe(stableShell);

    rerender(<IndexedGenomeViewer {...baseProps} assemblyByChrom={byChrom(40)} />);
    expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined();
    expect(webglState.props?.genome).toBe(stableShell);

    rerender(<IndexedGenomeViewer {...baseProps} assemblyByChrom={byChrom(28)} />);
    expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined();
    expect(webglState.props?.genome).toBe(stableShell);
    expect(loadGenome).not.toHaveBeenCalled();

    expect(setAnnotationPresentationSnapshot).not.toHaveBeenCalled();
  });

  it('does not republish full-assembly annotations when camera motion crosses the legacy fetch boundary without content changes', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );
    const loadGenome = vi.fn();
    const setAnnotationPresentationSnapshot = vi.fn((snapshot: { generation: number }) => ({
      status: 'applied' as const,
      generation: snapshot.generation,
      invalidatedHover: true as const,
    }));
    webglState.linearRenderer = {
      loadGenome,
      setAnnotationPresentationSnapshot,
      getLaneContractRevision: () => 0,
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn(),
      hasTrackData: () => true,
      setTrackData: vi.fn(),
      hasTrackInstance: () => true,
    };

    const feature = (id: number, start: number) => ({
      id,
      type: 'mRNA',
      start,
      end: start + 1_000,
      direction: 'forward' as const,
      displayName: `TX${id}`,
      color: 0x3b82f6,
      lane: 0,
      transcriptId: `tx-${id}`,
      qualifiers: { ID: `tx-${id}`, _lane: '0' },
    });
    const assemblyByChrom = new Map([
      ['chr11', [feature(1, 10_000_000)]],
      ['chr12', [feature(2, 10_000_000)]],
    ]);

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={268_361_931}
        sessionId="session-chr11"
        assemblyChromIds={['chr11', 'chr12']}
        assemblySessionConfigs={[
          assemblySessionConfig('chr11', 135_086_622),
          assemblySessionConfig('chr12', 133_275_309),
        ]}
        assemblyByChrom={assemblyByChrom}
        annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
      />
    );

    await screen.findByTestId('indexed-genome-webgl-map');
    const onCameraChange = webglState.props?.onCameraChange as
      | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
      | undefined;
    expect(onCameraChange).toBeTypeOf('function');

    const broadRange = { start: 9_730_000, end: 10_270_000 };
    act(() => {
      webglState.viewportRange = broadRange;
      onCameraChange?.((broadRange.start + broadRange.end) / 2, 'zoom');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const stableSnapshot = webglState.props?.annotationPresentationSnapshot;
    const stableShell = webglState.props?.genome;
    loadGenome.mockClear();
    setAnnotationPresentationSnapshot.mockClear();

    const narrowRange = { start: 9_750_000, end: 10_250_000 };
    act(() => {
      webglState.viewportRange = narrowRange;
      onCameraChange?.((narrowRange.start + narrowRange.end) / 2, 'zoom');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(webglState.props?.genome).toBe(stableShell);
    expect(webglState.props?.annotationPresentationSnapshot).toBe(stableSnapshot);
    expect(loadGenome).not.toHaveBeenCalled();
    expect(setAnnotationPresentationSnapshot).not.toHaveBeenCalled();
  });

  it('does not report legacy overview misses when compiled broad owns the assembly', async () => {
    const debugWindow = window as unknown as {
      __webglExposeForTests?: boolean;
      __indexedGenomeViewerEvents?: Array<{ event: string; detail?: Record<string, unknown> }>;
    };
    const onTrackError = vi.fn();
    debugWindow.__webglExposeForTests = true;
    debugWindow.__indexedGenomeViewerEvents = [];

    try {
      render(
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={135_000_000}
          sessionId="session-chr11"
          assemblyChromIds={['chr11', 'chr12']}
          overviewTextureStatus="miss"
          onTrackError={onTrackError}
        />
      );

      await screen.findByTestId('indexed-genome-webgl-map');
      expect(
        debugWindow.__indexedGenomeViewerEvents?.some(
          ({ event }) => event === 'assembly-overview-texture-status'
        )
      ).toBe(false);
      expect(onTrackError).not.toHaveBeenCalled();
    } finally {
      delete debugWindow.__webglExposeForTests;
      delete debugWindow.__indexedGenomeViewerEvents;
    }
  });

  it('never admits a legacy prebuilt overview texture into a compiled-broad assembly', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequence.mockResolvedValue('');
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );

    let prebuiltLoaded = false;
    let laneContractRevision = 0;
    const laneTrackInstanceIds = new Set<string>();
    const laneTrackDataIds = new Set<string>();
    const renderer = {
      loadPrebuiltGenomeWideTexture: vi.fn(() => {
        prebuiltLoaded = true;
      }),
      isPrebuiltGenomeWideTextureLoaded: vi.fn(() => prebuiltLoaded),
      getRendererDebugSnapshot: vi.fn(() => ({
        annotationOverlay: {
          prebuiltGenomeWideTextureLoaded: prebuiltLoaded,
        },
      })),
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setChromosome: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn((tracks: ReadonlyArray<{ id: string }>) => {
        laneTrackInstanceIds.clear();
        tracks.forEach((track) => laneTrackInstanceIds.add(track.id));
        laneContractRevision += 1;
      }),
      setTrackData: vi.fn((trackId: string) => {
        laneTrackDataIds.add(trackId);
        laneContractRevision += 1;
      }),
      getLaneContractRevision: vi.fn(() => laneContractRevision),
      hasTrackInstance: vi.fn((trackId: string) => laneTrackInstanceIds.has(trackId)),
      hasTrackData: vi.fn((trackId: string) => laneTrackDataIds.has(trackId)),
    };
    webglState.linearRenderer = renderer;

    const baseProps = {
      manifest: freshManifest(),
      length: 135_000_000,
      sessionId: 'session-chr11',
      assemblyChromIds: ['chr11', 'chr12'],
      overviewTextureStatus: 'loaded' as const,
    };
    const overviewTexture = {
      image: { width: 16, height: 8 } as ImageBitmap,
      manifest: {
        version: 1,
        assemblyId: 'chr11+chr12',
        fingerprint: 'test-fingerprint',
        cacheContractToken: 'test-contract',
        sourceBuildFingerprint: 'test-build',
        placementSignature: 'placement:test',
        textureFile: 'chr11+chr12-test-fingerprint.png',
        widthPx: 16,
        heightPx: 8,
        resolution: 1,
        spineOffsetPx: 4,
        genomeLength: 270_000_000,
        maxAnnotationLane: 4,
        maxCdsLane: 1,
        layerTypes: ['mRNA', 'CDS'],
      },
    };

    const { rerender } = render(<IndexedGenomeViewer {...baseProps} overviewTexture={null} />);
    await waitFor(() => {
      expect(screen.getByTestId('indexed-genome-webgl-map')).toBeTruthy();
    });
    const ready = webglState.props?.onRendererReady as ((epoch: number) => void) | undefined;
    expect(ready).toBeTypeOf('function');
    act(() => ready?.(1));

    rerender(<IndexedGenomeViewer {...baseProps} overviewTexture={overviewTexture} />);

    expect(renderer.loadPrebuiltGenomeWideTexture).not.toHaveBeenCalled();

    const replacementRenderer = {
      ...renderer,
      loadPrebuiltGenomeWideTexture: vi.fn(),
    };
    webglState.linearRenderer = replacementRenderer;
    act(() => ready?.(1));

    expect(replacementRenderer.loadPrebuiltGenomeWideTexture).not.toHaveBeenCalled();
    expect(renderer.loadPrebuiltGenomeWideTexture).not.toHaveBeenCalled();
  });

  it('clears rather than admits a stale prebuilt texture under compiled-broad ownership', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequence.mockResolvedValue('');
    mockGetSequenceWindow.mockResolvedValue(
      sequenceWindowResponse('session-chr11', {
        chrom: 'chr11',
        start: 0,
        end: 0,
        generation: 0,
      })
    );

    let prebuiltLoaded = false;
    let laneContractRevision = 0;
    const laneTrackInstanceIds = new Set<string>();
    const laneTrackDataIds = new Set<string>();
    const renderer = {
      loadPrebuiltGenomeWideTexture: vi.fn(() => {
        prebuiltLoaded = true;
      }),
      clearPrebuiltGenomeWideTexture: vi.fn(() => {
        prebuiltLoaded = false;
      }),
      isPrebuiltGenomeWideTextureLoaded: vi.fn(() => prebuiltLoaded),
      getRendererDebugSnapshot: vi.fn(() => ({
        annotationOverlay: {
          prebuiltGenomeWideTextureLoaded: prebuiltLoaded,
        },
      })),
      registerTrack: vi.fn(),
      setAssembly: vi.fn(),
      setChromosome: vi.fn(),
      setTrackHitHandler: vi.fn(),
      setTrackInstances: vi.fn((tracks: ReadonlyArray<{ id: string }>) => {
        laneTrackInstanceIds.clear();
        tracks.forEach((track) => laneTrackInstanceIds.add(track.id));
        laneContractRevision += 1;
      }),
      setTrackData: vi.fn((trackId: string) => {
        laneTrackDataIds.add(trackId);
        laneContractRevision += 1;
      }),
      getLaneContractRevision: vi.fn(() => laneContractRevision),
      hasTrackInstance: vi.fn((trackId: string) => laneTrackInstanceIds.has(trackId)),
      hasTrackData: vi.fn((trackId: string) => laneTrackDataIds.has(trackId)),
    };
    webglState.linearRenderer = renderer;

    const baseProps = {
      manifest: freshManifest(),
      length: 135_000_000,
      sessionId: 'session-chr11',
      assemblyChromIds: ['chr11', 'chr12'],
    };
    const overviewTexture = {
      image: { width: 16, height: 8 } as ImageBitmap,
      manifest: {
        version: 1,
        assemblyId: 'chr11+chr12',
        fingerprint: 'test-fingerprint',
        cacheContractToken: 'test-contract',
        sourceBuildFingerprint: 'test-build',
        placementSignature: 'placement:test',
        textureFile: 'chr11+chr12-test-fingerprint.png',
        widthPx: 16,
        heightPx: 8,
        resolution: 1,
        spineOffsetPx: 4,
        genomeLength: 270_000_000,
        maxAnnotationLane: 4,
        maxCdsLane: 1,
        layerTypes: ['mRNA', 'CDS'],
      },
    };

    const { rerender } = render(
      <IndexedGenomeViewer
        {...baseProps}
        overviewTexture={overviewTexture}
        overviewTextureStatus="loaded"
      />
    );
    await screen.findByTestId('indexed-genome-webgl-map');
    const ready = webglState.props?.onRendererReady as ((epoch: number) => void) | undefined;
    expect(ready).toBeTypeOf('function');
    act(() => ready?.(1));

    await waitFor(() => {
      expect(renderer.clearPrebuiltGenomeWideTexture).toHaveBeenCalledTimes(1);
    });
    expect(renderer.loadPrebuiltGenomeWideTexture).not.toHaveBeenCalled();

    rerender(
      <IndexedGenomeViewer {...baseProps} overviewTexture={null} overviewTextureStatus="miss" />
    );

    await waitFor(() => {
      expect(renderer.clearPrebuiltGenomeWideTexture).toHaveBeenCalledTimes(1);
    });
    expect(renderer.loadPrebuiltGenomeWideTexture).not.toHaveBeenCalled();
  });

  it('treats a one-chromosome assembly as assembly-owned instead of demoting it to single-chrom', async () => {
    const debugWindow = window as unknown as {
      __webglExposeForTests?: boolean;
      __indexedGenomeViewerEvents?: Array<{ event: string; detail?: Record<string, unknown> }>;
    };
    const onTrackError = vi.fn();
    debugWindow.__webglExposeForTests = true;
    debugWindow.__indexedGenomeViewerEvents = [];

    try {
      render(
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={135_000_000}
          sessionId="session-chr11"
          assemblyChromIds={['chr11']}
          overviewTextureStatus="miss"
          onTrackError={onTrackError}
        />
      );

      await screen.findByTestId('indexed-genome-webgl-map');
      expect(mockUseCompiledBroadRasterSurface).toHaveBeenCalledWith(
        expect.objectContaining({
          assemblyRequirement: expect.objectContaining({
            identityKey: 'indexed-full-assembly:chr11',
          }),
        })
      );
      expect(onTrackError).not.toHaveBeenCalled();
    } finally {
      delete debugWindow.__webglExposeForTests;
      delete debugWindow.__indexedGenomeViewerEvents;
    }
  });

  it('publishes assembly detail features without dropping the complete full-assembly overview', async () => {
    mockOpen.mockReset();
    mockGetSession.mockReset();
    mockClose.mockReset();
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockOpen.mockImplementation(async (source) =>
      coordinateReadyShell(source.chrom, source.manifest)
    );
    mockGetSession.mockImplementation(async (sessionId: string) => {
      const chrom = sessionId.replace(/^session-/, '');
      const length = chrom === 'chr12' ? 133_275_309 : 135_086_622;
      return coordinateReadyShell(chrom, manifestForChrom(chrom, length));
    });
    mockClose.mockResolvedValue(undefined);
    mockGetAnnotationTile.mockImplementation(async (sessionId, request, requestId) =>
      viewportAnnotationTileResponse(sessionId, request, requestId, {
        includeGene: true,
        additionalType: 'lnc_RNA',
        includeCodonCarrier: true,
      })
    );
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 960,
      bottom: 480,
      width: 960,
      height: 480,
      toJSON: () => ({}),
    } as DOMRect);
    const debugWindow = window as unknown as {
      __webglExposeForTests?: boolean;
      __indexedGenomeViewerDebug?: {
        tileFeatureCount: number;
        resolvedFeatureCount: number;
        renderedFeatureCount: number;
        availableTypes: string[];
      };
    };
    debugWindow.__webglExposeForTests = true;
    const broadRange = { start: 135_730_500, end: 136_270_500 };
    const detailRange = { start: 135_750_500, end: 136_250_500 };
    webglState.viewportRange = broadRange;
    webglState.centerBp = 136_000_500;
    const descriptor = {
      sourceIdentity: 'active-detail-owner-source',
      runtimeCacheKey: 'active-detail-owner-runtime',
      sceneKey: 'active-detail-owner-scene',
      artifact: {
        artifactKey: 'assembly-annotation-artifact.v3:active-detail-owner',
        trackType: 'mRNA',
      },
      request: { requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 } },
    };
    const cache = {
      status: 'hit' as const,
      descriptor,
      result: fixturePrepackedSceneHitResult(descriptor),
      error: null,
    };
    mockUseCompiledBroadRasterSurface.mockReturnValue(fixtureReadyCompiledBroadSurface(descriptor));
    const loadGenome = vi.fn();
    webglState.linearRenderer = {
      ...physicallyReadyLinearRenderer(),
      loadGenome,
    };

    try {
      const view = render(
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={135_000_000}
          sessionId="session-chr11"
          assemblyChromIds={['chr11', 'chr12']}
          assemblySessionConfigs={[
            assemblySessionConfig('chr11', 135_086_622),
            assemblySessionConfig('chr12', 133_275_309),
          ]}
          prepackedAnnotationSceneCache={cache as never}
          annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
        />
      );

      await waitFor(() =>
        expect(screen.getByTestId('indexed-genome-webgl-map')).toHaveAttribute(
          'data-feature-count',
          '0'
        )
      );

      const mainPrepackedInput = mockUsePrepackedScene.mock.calls
        .map(([input]) => input as Record<string, unknown>)
        .find(
          (input) =>
            (input.requestedPolicy as { isoformMode?: string } | undefined)?.isoformMode ===
            'canonical'
        );
      expect(mainPrepackedInput).toBeDefined();
      act(() => {
        (mainPrepackedInput?.onPresented as (receipt: unknown) => void)?.({
          descriptor,
          ownerKey: 'active-detail-owner',
          metadata: {
            genomeIdentity: descriptor.sourceIdentity,
            artifactKey: descriptor.artifact.artifactKey,
            trackType: 'mRNA',
          },
          runtimePolicy: { isoformMode: 'canonical', laneLimit: 12 },
          origin: 'hit',
        });
      });

      const onCameraChange = webglState.props?.onCameraChange as
        | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
        | undefined;
      expect(onCameraChange).toBeTypeOf('function');

      act(() => {
        webglState.viewportRange = detailRange;
        onCameraChange?.(136_000_500, 'zoom');
      });

      await waitFor(
        () => {
          expect(screen.getByTestId('indexed-genome-webgl-map')).toHaveAttribute(
            'data-feature-count',
            '0'
          );
          const snapshot = webglState.props?.annotationResidentPagePublication as
            | {
                pages?: ReadonlyArray<{
                  trackId: string;
                  ownerStartBp: number;
                  ownerEndBp: number;
                  features: ReadonlyArray<unknown>;
                }>;
              }
            | undefined;
          expect(snapshot?.pages?.every((page) => page.trackId === 'mRNA')).toBe(true);
          expect(snapshot?.pages).toHaveLength(4);
          const cameraPages = snapshot?.pages?.filter(
            (page) => page.ownerStartBp < detailRange.end && page.ownerEndBp > detailRange.start
          );
          expect(cameraPages).toHaveLength(2);
          expect(cameraPages?.reduce((count, page) => count + page.features.length, 0)).toBe(2);
        },
        { timeout: 2_000 }
      );
      expect(mockGetAnnotationTile).toHaveBeenCalledWith(
        'session-chr12',
        expect.objectContaining({ chrom: 'chr12', fidelity: 'exact' }),
        expect.stringMatching(/^assembly-detail-page-chr12-/)
      );
      expect(debugWindow.__indexedGenomeViewerDebug).toMatchObject({
        tileFeatureCount: 0,
        resolvedFeatureCount: 0,
        renderedFeatureCount: 0,
      });
      expect(debugWindow.__indexedGenomeViewerDebug?.availableTypes).toEqual(
        expect.arrayContaining(['lnc_RNA', 'mRNA'])
      );
      fireEvent.click(screen.getByTestId('annotation-type-picker-summary'));
      const lncRna = await screen.findByTestId('annotation-type-lnc_RNA');
      fireEvent.click(lncRna);
      let hiddenCarrier: Feature | null = null;
      await waitFor(() => {
        const publication = webglState.props?.annotationResidentPagePublication as
          | {
              requestedLayerTypes?: ReadonlyArray<string>;
              pages?: ReadonlyArray<{ trackId: string; features: ReadonlyArray<Feature> }>;
            }
          | undefined;
        expect(publication?.requestedLayerTypes).toEqual(
          expect.arrayContaining(['lnc_RNA', 'mRNA'])
        );
        expect(publication?.pages?.some((page) => page.trackId === 'lnc_RNA')).toBe(true);
        expect(
          publication?.pages?.every((page) => ['lnc_RNA', 'mRNA'].includes(page.trackId))
        ).toBe(true);
        hiddenCarrier =
          publication?.pages
            ?.filter((page) => page.trackId === 'lnc_RNA')
            .flatMap((page) => page.features)[0] ?? null;
        expect(hiddenCarrier).not.toBeNull();
        expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined();
      });
      expect(hiddenCarrier?.canonicalIdentity).toBeUndefined();

      fireEvent.click(lncRna);
      await waitFor(() => {
        const publication = webglState.props?.annotationResidentPagePublication as
          | {
              requestedLayerTypes?: ReadonlyArray<string>;
              pages?: ReadonlyArray<{ trackId: string }>;
            }
          | undefined;
        expect(publication?.requestedLayerTypes).toEqual(['mRNA']);
        expect(publication?.pages?.some((page) => page.trackId === 'lnc_RNA')).toBe(false);
      });
      const exactHiddenCarrier = hiddenCarrier!;
      const canonicalIdentity = annotationCanonicalIdentityV2({
        genomeIdentity: descriptor.sourceIdentity,
        sourceId: exactHiddenCarrier.id.toString(36),
        transcriptId: exactHiddenCarrier.transcriptId ?? null,
        trackId: exactHiddenCarrier.annotationTrackId ?? exactHiddenCarrier.type,
        type: exactHiddenCarrier.type,
        startBp: exactHiddenCarrier.start,
        endBp: exactHiddenCarrier.end,
        direction: exactHiddenCarrier.direction,
      });
      const durableGenome = webglState.props?.genome;
      const durablePublication = webglState.props?.annotationResidentPagePublication;
      const loadCountBeforeFocus = loadGenome.mock.calls.length;
      view.rerender(
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={135_000_000}
          sessionId="session-chr11"
          assemblyChromIds={['chr11', 'chr12']}
          assemblySessionConfigs={[
            assemblySessionConfig('chr11', 135_086_622),
            assemblySessionConfig('chr12', 133_275_309),
          ]}
          prepackedAnnotationSceneCache={cache as never}
          annotationMapperPolicy={{ isoformMode: 'canonical', laneLimit: 12 }}
          searchHighlight={{
            id: 1,
            start: exactHiddenCarrier.start,
            end: exactHiddenCarrier.end,
            featureType: exactHiddenCarrier.type,
            annotationTrackId: 'lnc_RNA',
            canonicalIdentity,
          }}
        />
      );
      await waitFor(() => {
        expect(webglState.props?.annotationSearchFocus).toEqual({
          trackId: 'lnc_RNA',
          canonicalIdentity,
        });
        expect(webglState.props?.annotationSearchFocusFeature).toMatchObject({
          id: exactHiddenCarrier.id,
          annotationTrackId: 'lnc_RNA',
          canonicalIdentity,
        });
        expect(screen.getByText('Selected annotation from hidden lnc_RNA track')).toBeVisible();
      });
      expect(webglState.props?.genome).toBe(durableGenome);
      expect(webglState.props?.annotationResidentPagePublication).toBe(durablePublication);
      expect(webglState.props?.annotationPresentationSnapshot).toBeUndefined();
      expect(loadGenome).toHaveBeenCalledTimes(loadCountBeforeFocus);
      const exactCoverage = (
        webglState.props?.annotationResidentPagePublication as {
          exactCoverage?: Array<{ startBp: number; endBp: number }>;
        }
      )?.exactCoverage;
      expect(exactCoverage).toEqual(expect.any(Array));
      expect(
        exactCoverage?.some(
          (coverage) => coverage.startBp <= detailRange.start && coverage.endBp >= detailRange.end
        )
      ).toBe(true);
    } finally {
      rectSpy.mockRestore();
      delete debugWindow.__webglExposeForTests;
      delete debugWindow.__indexedGenomeViewerDebug;
    }
  });

  it('keeps the complete assembly overview and track controls stable when current detail is empty', async () => {
    mockOpen.mockReset();
    mockGetSession.mockReset();
    mockClose.mockReset();
    mockGetAnnotationTile.mockReset();
    mockGetSequenceWindow.mockReset();
    mockOpen.mockImplementation(async (source: { chrom?: string; relativePath?: string }) => {
      const chrom =
        source.chrom ?? source.relativePath?.match(/(chr\d+|chrX|chrY)\.gff3/)?.[1] ?? 'chr11';
      const length = chrom === 'chr12' ? 133_275_309 : 135_086_622;
      return coordinateReadyShell(chrom, manifestForChrom(chrom, length));
    });
    mockGetSession.mockImplementation(async (sessionId: string) => {
      const chrom = sessionId.replace(/^session-/, '');
      const length = chrom === 'chr12' ? 133_275_309 : 135_086_622;
      return coordinateReadyShell(chrom, manifestForChrom(chrom, length));
    });
    mockClose.mockResolvedValue(undefined);
    mockGetAnnotationTile.mockImplementation(async (sessionId, request, requestId) => {
      if (request.start > 10_000_000) {
        return emptyViewportAnnotationTileResponse(sessionId, request, requestId);
      }
      return viewportAnnotationTileResponse(sessionId, request, requestId, {
        includeCodonCarrier: true,
      });
    });
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 960,
      bottom: 480,
      width: 960,
      height: 480,
      toJSON: () => ({}),
    } as DOMRect);
    const debugWindow = window as unknown as {
      __webglExposeForTests?: boolean;
      __indexedGenomeViewerDebug?: {
        availableTypes: string[];
        renderedFeatureCount: number;
      };
    };
    debugWindow.__webglExposeForTests = true;
    const descriptor = {
      sourceIdentity: 'stable-empty-detail-source',
      runtimeCacheKey: 'stable-empty-detail-runtime',
      sceneKey: 'stable-empty-detail-scene',
      artifact: {
        artifactKey: 'assembly-annotation-artifact.v3:stable-empty-detail',
        trackType: 'mRNA',
      },
      request: { requestedPolicy: { isoformMode: 'canonical', laneLimit: 2 } },
    };
    const cache = {
      status: 'hit' as const,
      descriptor,
      result: fixturePrepackedSceneHitResult(descriptor),
      error: null,
    };
    mockUseCompiledBroadRasterSurface.mockReturnValue(fixtureReadyCompiledBroadSurface(descriptor));

    try {
      const firstRange = { start: 136_000_000, end: 136_001_000 };
      webglState.viewportRange = firstRange;
      webglState.centerBp = 136_000_500;
      render(
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={135_000_000}
          sessionId="session-chr11"
          assemblyChromIds={['chr11', 'chr12']}
          assemblySessionConfigs={[
            assemblySessionConfig('chr11', 135_086_622),
            assemblySessionConfig('chr12', 133_275_309),
          ]}
          assemblyAnnotationTrackTypes={['enhancer', 'mRNA']}
          prepackedAnnotationSceneCache={cache as never}
        />
      );

      await waitFor(() =>
        expect(screen.getByTestId('indexed-genome-webgl-map')).toHaveAttribute(
          'data-feature-count',
          '0'
        )
      );

      const onCameraChange = webglState.props?.onCameraChange as
        | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
        | undefined;
      expect(onCameraChange).toBeTypeOf('function');

      act(() => {
        onCameraChange?.(136_000_500, 'zoom');
      });
      const stableAssemblyShell = webglState.props?.genome;
      let stableResidentPublication:
        | {
            pages: ReadonlyArray<{
              ownerStartBp: number;
              ownerEndBp: number;
              features: ReadonlyArray<unknown>;
            }>;
          }
        | undefined;
      await waitFor(() => {
        expect(screen.getByTestId('indexed-genome-webgl-map')).toHaveAttribute(
          'data-feature-count',
          '0'
        );
        const publication = webglState.props
          ?.annotationResidentPagePublication as typeof stableResidentPublication;
        expect(publication?.pages.length).toBeGreaterThan(0);
        const page = publication.pages.find(
          (candidate) =>
            candidate.ownerStartBp < firstRange.end && candidate.ownerEndBp > firstRange.start
        );
        expect(page).toMatchObject({
          ownerStartBp: expect.any(Number),
          ownerEndBp: expect.any(Number),
          features: expect.any(Array),
        });
        expect(page?.features).toHaveLength(1);
        stableResidentPublication = publication;
      });
      expect(stableResidentPublication).toBeDefined();
      expect(screen.getByTestId('annotation-type-picker-summary-badges')).toHaveTextContent('mRNA');
      expect(debugWindow.__indexedGenomeViewerDebug?.availableTypes).toEqual(
        expect.arrayContaining(['enhancer', 'mRNA'])
      );

      const secondRange = { start: 160_000_000, end: 160_001_000 };
      webglState.viewportRange = secondRange;
      webglState.centerBp = 160_000_500;
      act(() => {
        onCameraChange?.(160_000_500, 'scroll');
      });

      await waitFor(() => {
        expect(screen.getByTestId('indexed-genome-webgl-map')).toHaveAttribute(
          'data-feature-count',
          '0'
        );
        const publication = webglState.props
          ?.annotationResidentPagePublication as typeof stableResidentPublication;
        expect(publication?.pages.length).toBeGreaterThanOrEqual(
          stableResidentPublication?.pages.length ?? 0
        );
        for (const page of stableResidentPublication?.pages ?? []) {
          expect(publication?.pages).toContain(page);
        }
      });
      expect(webglState.props?.genome).toBe(stableAssemblyShell);
      expect(screen.getByTestId('annotation-type-picker-summary-badges')).toHaveTextContent('mRNA');
      expect(debugWindow.__indexedGenomeViewerDebug?.availableTypes).toEqual(
        expect.arrayContaining(['enhancer', 'mRNA'])
      );
      expect(debugWindow.__indexedGenomeViewerDebug?.renderedFeatureCount).toBe(0);
    } finally {
      rectSpy.mockRestore();
      delete debugWindow.__webglExposeForTests;
      delete debugWindow.__indexedGenomeViewerDebug;
    }
  });

  it('coalesces rapid annotation viewport moves before sending tile IPC', async () => {
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockCancelRequest.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockImplementation(async (sessionId, request, requestId) =>
      request.start === 0
        ? summaryTile()
        : viewportAnnotationTileResponse(sessionId, request, requestId)
    );
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    webglState.viewportRange = { start: 1_000_000, end: 1_001_000 };
    webglState.centerBp = 1_000_500;

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
      />
    );
    await waitFor(() => expect(screen.getByTestId('indexed-genome-webgl-map')).toBeTruthy());

    const onCameraChange = webglState.props?.onCameraChange as
      | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
      | undefined;
    expect(onCameraChange).toBeTypeOf('function');

    act(() => {
      onCameraChange?.(1_000_500, 'zoom');
    });
    const viewportCalls = () =>
      mockGetAnnotationTile.mock.calls.filter(([, request]) => request.start !== 0);
    expect(viewportCalls()).toHaveLength(0);

    webglState.viewportRange = { start: 10_000_000, end: 10_001_000 };
    webglState.centerBp = 10_000_500;
    act(() => {
      onCameraChange?.(10_000_500, 'zoom');
    });

    await waitFor(() => expect(viewportCalls()).toHaveLength(1));
    expect(mockCancelRequest).not.toHaveBeenCalledWith(
      'session-chr11',
      expect.stringMatching(/^annotation-viewport-/)
    );
    expect(viewportCalls()[0][1]).toMatchObject({
      chrom: 'chr11',
      start: expect.any(Number),
      end: expect.any(Number),
      generation: expect.any(Number),
      fidelity: 'best_available',
    });
    const request = viewportCalls()[0][1] as { start: number; end: number };
    expect(request.start).toBeGreaterThan(9_000_000);
    expect(request.end).toBeLessThan(11_000_000);
  });

  it('retains multiple annotation viewport tiles and reuses the matching tile when panning back', async () => {
    const debugWindow = window as Window & {
      __webglExposeForTests?: boolean;
      __indexedGenomeViewerDebug?: {
        annotationViewportTile?: { startBp: number; endBp: number } | null;
        annotationViewportTiles?: Array<{ startBp: number; endBp: number }>;
        invariantViolations?: Array<{ invariant: string; message: string }>;
        scene?: {
          tileSlots?: Array<{
            kind: string;
            fidelity: string;
            startBp: number;
            endBp: number;
            currentForViewport: boolean;
          }>;
        };
      };
    };
    debugWindow.__webglExposeForTests = true;
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockCancelRequest.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockImplementation(async (sessionId, request, requestId) =>
      request.start === 0
        ? summaryTile()
        : viewportAnnotationTileResponse(sessionId, request, requestId)
    );
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    webglState.viewportRange = { start: 1_000_000, end: 1_001_000 };
    webglState.centerBp = 1_000_500;

    try {
      render(
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={135_000_000}
          sessionId="session-chr11"
        />
      );
      await waitFor(() => expect(screen.getByTestId('indexed-genome-webgl-map')).toBeTruthy());

      const onCameraChange = webglState.props?.onCameraChange as
        | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
        | undefined;
      expect(onCameraChange).toBeTypeOf('function');
      const viewportCalls = () =>
        mockGetAnnotationTile.mock.calls.filter(([, request]) => request.start !== 0);

      act(() => {
        onCameraChange?.(1_000_500, 'zoom');
      });
      await waitFor(() => expect(viewportCalls()).toHaveLength(1));
      await waitFor(() =>
        expect(debugWindow.__indexedGenomeViewerDebug?.annotationViewportTiles).toHaveLength(1)
      );
      const firstRequest = viewportCalls()[0][1] as { start: number; end: number };

      webglState.viewportRange = { start: 10_000_000, end: 10_001_000 };
      webglState.centerBp = 10_000_500;
      act(() => {
        onCameraChange?.(10_000_500, 'zoom');
      });
      await waitFor(() => expect(viewportCalls()).toHaveLength(2));
      await waitFor(() =>
        expect(debugWindow.__indexedGenomeViewerDebug?.annotationViewportTiles).toHaveLength(2)
      );

      webglState.viewportRange = { start: 1_000_000, end: 1_001_000 };
      webglState.centerBp = 1_000_500;
      act(() => {
        onCameraChange?.(1_000_500, 'zoom');
      });
      await waitFor(() => {
        expect(debugWindow.__indexedGenomeViewerDebug?.annotationViewportTile).toMatchObject({
          startBp: firstRequest.start,
          endBp: firstRequest.end,
        });
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
      });

      expect(viewportCalls()).toHaveLength(2);
      const currentDetailSlots =
        debugWindow.__indexedGenomeViewerDebug?.scene?.tileSlots?.filter(
          (slot) =>
            slot.kind === 'annotation' && slot.fidelity !== 'summary' && slot.currentForViewport
        ) ?? [];
      expect(currentDetailSlots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            startBp: firstRequest.start,
            endBp: firstRequest.end,
          }),
        ])
      );
      expect(debugWindow.__indexedGenomeViewerDebug?.invariantViolations ?? []).toEqual([]);
    } finally {
      delete debugWindow.__webglExposeForTests;
      delete debugWindow.__indexedGenomeViewerDebug;
    }
  });

  it('cancels superseded sequence window requests during rapid navigation', async () => {
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockCancelRequest.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    const firstSequence = createDeferred<ReturnType<typeof sequenceWindowResponse>>();
    mockGetSequenceWindow.mockImplementation((sessionId, request, requestId) => {
      if (mockGetSequenceWindow.mock.calls.length === 1) return firstSequence.promise;
      return Promise.resolve(sequenceWindowResponse(sessionId, request, requestId));
    });
    webglState.viewportRange = { start: 1_000_000, end: 1_001_000 };
    webglState.centerBp = 1_000_500;

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
      />
    );
    await waitFor(() => expect(screen.getByTestId('indexed-genome-webgl-map')).toBeTruthy());

    const onCameraChange = webglState.props?.onCameraChange as
      | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
      | undefined;
    expect(onCameraChange).toBeTypeOf('function');

    act(() => {
      onCameraChange?.(1_000_500, 'zoom');
    });
    await waitFor(() => expect(mockGetSequenceWindow).toHaveBeenCalledTimes(1));
    const firstRequestId = mockGetSequenceWindow.mock.calls[0][2];

    webglState.viewportRange = { start: 50_000_000, end: 50_001_000 };
    webglState.centerBp = 50_000_500;
    act(() => {
      onCameraChange?.(50_000_500, 'zoom');
    });

    await waitFor(() => expect(mockGetSequenceWindow).toHaveBeenCalledTimes(2));
    expect(mockCancelRequest).toHaveBeenCalledWith('session-chr11', firstRequestId);
    firstSequence.resolve(
      sequenceWindowResponse(
        'session-chr11',
        mockGetSequenceWindow.mock.calls[0][1],
        firstRequestId
      )
    );
  });

  it('keeps the previous sequence window when a zoomed-out cancellation resolves', async () => {
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockCancelRequest.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    const cancelledRelocation = createDeferred<ReturnType<typeof sequenceWindowResponse>>();
    mockGetSequenceWindow.mockImplementation((sessionId, request, requestId) => {
      if (mockGetSequenceWindow.mock.calls.length === 1) {
        return Promise.resolve(sequenceWindowResponse(sessionId, request, requestId));
      }
      return cancelledRelocation.promise;
    });
    webglState.viewportRange = { start: 1_000_000, end: 1_001_000 };
    webglState.centerBp = 1_000_500;

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
      />
    );
    await waitFor(() => expect(screen.getByTestId('indexed-genome-webgl-map')).toBeTruthy());

    const onCameraChange = webglState.props?.onCameraChange as
      | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
      | undefined;
    expect(onCameraChange).toBeTypeOf('function');

    act(() => {
      onCameraChange?.(1_000_500, 'zoom');
    });
    await waitFor(() => expect(mockGetSequenceWindow).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const sequenceWindow = webglState.props?.sequenceWindow as
        | { startBp: number; bases: string }
        | undefined;
      expect(sequenceWindow?.bases.length).toBeGreaterThan(0);
    });
    const retainedWindow = webglState.props?.sequenceWindow as { startBp: number; bases: string };

    webglState.viewportRange = { start: 50_000_000, end: 50_001_000 };
    webglState.centerBp = 50_000_500;
    act(() => {
      onCameraChange?.(50_000_500, 'zoom');
    });
    await waitFor(() => expect(mockGetSequenceWindow).toHaveBeenCalledTimes(2));
    const pendingRequest = mockGetSequenceWindow.mock.calls[1][1] as {
      chrom: string;
      start: number;
      generation: number;
    };
    const pendingRequestId = mockGetSequenceWindow.mock.calls[1][2] as string;

    webglState.viewportRange = { start: 0, end: 120_000_000 };
    webglState.centerBp = 60_000_000;
    act(() => {
      onCameraChange?.(60_000_000, 'zoom');
    });
    await waitFor(() =>
      expect(mockCancelRequest).toHaveBeenCalledWith('session-chr11', pendingRequestId)
    );

    await act(async () => {
      cancelledRelocation.resolve({
        sessionId: 'session-chr11',
        requestId: pendingRequestId,
        chrom: pendingRequest.chrom,
        start: pendingRequest.start,
        end: pendingRequest.start,
        generation: pendingRequest.generation,
        validationState: 'metadata_match',
        byteCount: 0,
        bases: '',
      });
      await Promise.resolve();
    });

    expect(webglState.props?.sequenceWindow).toEqual(retainedWindow);
  });

  it('loads lazy feature details when an annotation is selected', async () => {
    const onFeatureDetailsStateChange = vi.fn();
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockGetFeatureDetails.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetFeatureDetails.mockResolvedValue(featureDetailsResponse());
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );

    const { unmount } = render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
        onFeatureDetailsStateChange={onFeatureDetailsStateChange}
      />
    );
    await waitFor(() => expect(screen.getByTestId('indexed-genome-webgl-map')).toBeTruthy());
    expect(screen.queryByTestId('indexed-genome-feature-inspector')).toBeNull();

    const onFeatureClick = webglState.props?.onFeatureClick as
      | ((featureId: number | null) => void)
      | undefined;
    const genome = webglState.props?.genome as
      | { features?: Array<{ id: number; displayName: string }> }
      | undefined;
    const transcript = genome?.features?.find((feature) => feature.displayName === 'tx-1');
    expect(onFeatureClick).toBeTypeOf('function');
    expect(transcript).toBeDefined();

    act(() => {
      onFeatureClick?.(transcript!.id);
    });

    await waitFor(() => expect(mockGetFeatureDetails).toHaveBeenCalledTimes(1));
    expect(mockGetFeatureDetails.mock.calls[0][0]).toBe('session-chr11');
    expect(mockGetFeatureDetails.mock.calls[0][1]).toMatchObject({
      chrom: 'chr11',
      start: 1_000_100,
      end: 1_000_900,
      featureId: 'tx-1',
      maxWindowBp: 500_000,
    });
    expect(mockGetFeatureDetails.mock.calls[0][2]).toMatch(/^feature-details-/);

    await waitFor(() =>
      expect(onFeatureDetailsStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'ready' })
      )
    );
    expect(screen.queryByTestId('indexed-genome-feature-inspector')).toBeNull();
    expect(mockGetFeatures).not.toHaveBeenCalled();

    unmount();
    expect(onFeatureDetailsStateChange).toHaveBeenLastCalledWith({ kind: 'idle' });
  });

  it('acknowledges a presented jump after React replaces the handle for the same renderer', async () => {
    webglState.linearRenderer = physicallyReadyLinearRenderer();
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    const manifest = freshManifest();
    const onTargetViewportCommitted = vi.fn();
    const onViewportPresented = vi.fn();
    const viewer = (
      targetViewport: { id: number; start: number; end: number } | null,
      themeMode: 'light' | 'dark' = 'light'
    ) => (
      <IndexedGenomeViewer
        manifest={manifest}
        length={135_000_000}
        themeMode={themeMode}
        sessionId="session-chr11"
        targetViewport={targetViewport}
        onTargetViewportCommitted={onTargetViewportCommitted}
        onViewportPresented={onViewportPresented}
      />
    );
    const view = render(viewer(null));
    await screen.findByTestId('indexed-genome-webgl-map');
    const ready = webglState.props?.onRendererReady;
    if (typeof ready !== 'function') throw new Error('Missing renderer readiness callback');
    act(() => ready(1));
    await waitFor(() => expect(webglState.presentedFrameListeners.size).toBeGreaterThan(0));

    const command = { id: 42, start: 2_000_000, end: 2_002_000 };
    view.rerender(viewer(command));
    await waitFor(() =>
      expect(onTargetViewportCommitted).toHaveBeenCalledWith({
        id: 42,
        start: 2_000_000,
        end: 2_002_000,
      })
    );
    const rendersBeforeThemeChange = webglState.propsHistory.length;
    view.rerender(viewer(command, 'dark'));
    expect(webglState.propsHistory.length).toBeGreaterThan(rendersBeforeThemeChange);
    expect(onViewportPresented).not.toHaveBeenCalledWith('session-chr11', 42);
    act(() => {
      for (const listener of webglState.presentedFrameListeners) {
        listener({ content: { genome: webglState.rendererGenome } });
      }
    });
    expect(onViewportPresented).toHaveBeenCalledWith('session-chr11', 42);
  });

  it('commits parent viewport commands into the WebGL camera and streaming APIs', async () => {
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockImplementation(async (sessionId, request, requestId) =>
      request.start === 0
        ? summaryTile()
        : viewportAnnotationTileResponse(sessionId, request, requestId)
    );
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    webglState.viewportRange = { start: 1_000_000, end: 1_001_000 };
    webglState.centerBp = 1_000_500;
    const manifest = freshManifest();
    const onTargetViewportCommitted = vi.fn();

    const { rerender } = render(
      <IndexedGenomeViewer
        manifest={manifest}
        length={135_000_000}
        sessionId="session-chr11"
        targetViewport={null}
        onTargetViewportCommitted={onTargetViewportCommitted}
      />
    );
    await waitFor(() => expect(screen.getByTestId('indexed-genome-webgl-map')).toBeTruthy());

    rerender(
      <IndexedGenomeViewer
        manifest={manifest}
        length={135_000_000}
        sessionId="session-chr11"
        targetViewport={{ id: 1, start: 2_000_000, end: 2_002_000 }}
        onTargetViewportCommitted={onTargetViewportCommitted}
      />
    );

    await waitFor(() => {
      expect(webglState.viewportRange).toEqual({ start: 2_000_000, end: 2_002_000 });
      expect(webglState.centerBp).toBe(2_001_000);
    });
    expect(onTargetViewportCommitted).toHaveBeenCalledWith({
      id: 1,
      start: 2_000_000,
      end: 2_002_000,
    });
    await waitFor(() => expect(mockGetSequenceWindow).toHaveBeenCalled());
    expect(mockGetSequenceWindow.mock.calls.at(-1)?.[1]).toMatchObject({
      chrom: 'chr11',
      generation: expect.any(Number),
    });
    await waitFor(() => {
      expect(mockGetAnnotationTile.mock.calls.some(([, request]) => request.start !== 0)).toBe(
        true
      );
    });
    const viewportCall = mockGetAnnotationTile.mock.calls.find(
      ([, request]) => request.start !== 0
    );
    expect(viewportCall?.[1]).toMatchObject({
      trackId: 'chr11:annotations',
      chrom: 'chr11',
      fidelity: 'best_available',
    });

    await act(async () => {
      await Promise.resolve();
    });
    const sequenceCallsAfterCommit = mockGetSequenceWindow.mock.calls.length;
    const annotationCallsAfterCommit = mockGetAnnotationTile.mock.calls.length;
    rerender(
      <IndexedGenomeViewer
        manifest={manifest}
        length={135_000_000}
        sessionId="session-chr11"
        targetViewport={{ id: 1, start: 2_000_000, end: 2_002_000 }}
        onTargetViewportCommitted={onTargetViewportCommitted}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGetSequenceWindow).toHaveBeenCalledTimes(sequenceCallsAfterCommit);
    expect(mockGetAnnotationTile).toHaveBeenCalledTimes(annotationCallsAfterCommit);
    expect(onTargetViewportCommitted).toHaveBeenCalledTimes(1);
  });

  it.each(
    (['parent command', 'viewport bridge'] as const).flatMap((boundary) =>
      [
        {
          name: 'half-base 2,000 bp window',
          requested: { start: 100_000.5, end: 102_000.5 },
          expected: { start: 100_000.5, end: 102_000.5 },
        },
        {
          name: 'large assembly quarter-base 2,000 bp window',
          requested: { start: 1_815_217_051.25, end: 1_815_219_051.25 },
          expected: { start: 1_815_217_051.25, end: 1_815_219_051.25 },
        },
        {
          name: 'left axis clamp',
          requested: { start: -0.5, end: 1_999.5 },
          expected: { start: 0, end: 1_999.5 },
        },
        {
          name: 'right axis clamp',
          requested: { start: 3_088_267_831.5, end: 3_088_269_832.5 },
          expected: { start: 3_088_267_831.5, end: 3_088_269_832 },
        },
        {
          name: 'one-base minimum span',
          requested: { start: 100_000.5, end: 100_000.75 },
          expected: { start: 100_000.5, end: 100_001.5 },
        },
        {
          name: 'one-base minimum at the final axis base',
          requested: { start: 3_088_269_831.75, end: 3_088_269_833 },
          expected: { start: 3_088_269_831, end: 3_088_269_832 },
        },
      ].map((scenario) => ({ boundary, ...scenario }))
    )
  )('preserves continuous camera bounds through $boundary: $name', async (scenario) => {
    const reference = referenceAssemblyById('grch38');
    if (!reference) throw new Error('GRCh38 reference is missing');
    const assembly = buildGenomeAssembly(
      {
        ...reference,
        members: reference.members.map((member) => ({ ...member, manifest: undefined })),
      },
      (path) => path
    );
    const manifest = assembly.chromosomes[0]!.manifest;
    const length = assemblyTotalLengthBp(assembly);
    expect(length).toBe(3_088_269_832);
    webglState.linearRenderer = physicallyReadyLinearRenderer();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    const onTargetViewportCommitted = vi.fn();
    const testWindow = window as Window & {
      __test?: {
        workspaceViewer?: {
          setViewport: (range: { start: number; end: number }) => void;
          getLastViewportRange: () => { start: number; end: number } | null;
        };
      };
    };
    const previousBridge = testWindow.__test;
    testWindow.__test = {};
    const viewer = (targetViewport: { id: number; start: number; end: number } | null) => (
      <IndexedGenomeViewer
        manifest={manifest}
        length={length}
        assemblyDefinition={assembly}
        assemblyChromIds={assembly.chromosomes.map(({ chrom }) => chrom)}
        sessionId="session-grch38"
        targetViewport={targetViewport}
        onTargetViewportCommitted={onTargetViewportCommitted}
      />
    );
    const view = render(viewer(null));
    try {
      await screen.findByTestId('indexed-genome-webgl-map');
      act(() => {
        (webglState.props?.onRendererGenomeCommit as ((epoch: number) => void) | undefined)?.(1);
      });
      await waitFor(() => expect(testWindow.__test?.workspaceViewer).toBeDefined());
      const precedingCameraRequests = webglState.cameraViewportRequests.length;
      if (scenario.boundary === 'parent command') {
        view.rerender(viewer({ id: 91, ...scenario.requested }));
      } else {
        act(() => testWindow.__test?.workspaceViewer?.setViewport(scenario.requested));
      }
      await waitFor(() =>
        expect(webglState.cameraViewportRequests.slice(precedingCameraRequests)).toEqual([
          scenario.expected,
        ])
      );
      expect(webglState.viewportRange).toEqual(scenario.expected);
      expect(testWindow.__test?.workspaceViewer?.getLastViewportRange()).toEqual(scenario.expected);
      expect(webglState.viewportRange.end - webglState.viewportRange.start).toBe(
        scenario.expected.end - scenario.expected.start
      );
      if (scenario.boundary === 'parent command') {
        expect(onTargetViewportCommitted).toHaveBeenCalledOnce();
        expect(onTargetViewportCommitted).toHaveBeenCalledWith({ id: 91, ...scenario.expected });
      } else {
        expect(onTargetViewportCommitted).not.toHaveBeenCalled();
      }
      for (const [, request] of mockGetSequenceWindow.mock.calls) {
        expect(Number.isInteger(request.start)).toBe(true);
        expect(Number.isInteger(request.end)).toBe(true);
      }
    } finally {
      view.unmount();
      testWindow.__test = previousBridge;
    }
  });

  it('retries a pending viewport command after the renderer commits its genome', async () => {
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    webglState.viewportRange = { start: 0, end: 135_000_000 };
    webglState.centerBp = 67_500_000;
    const onTargetViewportCommitted = vi.fn();

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
        targetViewport={{ id: 7, start: 100_000, end: 110_000 }}
        onTargetViewportCommitted={onTargetViewportCommitted}
      />
    );

    await screen.findByTestId('indexed-genome-webgl-map');
    expect(webglState.viewportRange).toEqual({ start: 0, end: 135_000_000 });
    expect(onTargetViewportCommitted).not.toHaveBeenCalled();

    act(() => {
      (webglState.props?.onRendererGenomeCommit as ((epoch: number) => void) | undefined)?.(1);
    });

    await waitFor(() => expect(webglState.viewportRange).toEqual({ start: 100_000, end: 110_000 }));
    expect(onTargetViewportCommitted).toHaveBeenCalledWith({
      id: 7,
      start: 100_000,
      end: 110_000,
    });
  });

  it('acknowledges a saved viewport using the native committed readback', async () => {
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    mockGetAnnotationTile.mockResolvedValue(summaryTile());
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    webglState.cameraReadbackOffset = 0.0000002384185791015625;
    const onTargetViewportCommitted = vi.fn();
    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
        targetViewport={{ id: 8, start: 100_000, end: 100_155 }}
        onTargetViewportCommitted={onTargetViewportCommitted}
      />
    );
    await screen.findByTestId('indexed-genome-webgl-map');
    expect(onTargetViewportCommitted).not.toHaveBeenCalled();
    act(() => {
      (webglState.props?.onRendererGenomeCommit as ((epoch: number) => void) | undefined)?.(1);
    });
    await waitFor(() => expect(onTargetViewportCommitted).toHaveBeenCalledOnce());
    expect(onTargetViewportCommitted).toHaveBeenCalledWith({
      id: 8,
      ...webglState.viewportRange,
    });
    expect(webglState.viewportRange).not.toEqual({ start: 100_000, end: 100_155 });
  });

  it('does not apply stale annotation viewport tiles after zooming back out', async () => {
    mockGetFeatures.mockReset();
    mockGetSequence.mockReset();
    mockGetSequenceWindow.mockReset();
    mockGetTrackTile.mockReset();
    mockGetAnnotationTile.mockReset();
    mockCancelRequest.mockReset();
    mockGetFeatures.mockResolvedValue([]);
    mockGetTrackTile.mockResolvedValue(summaryTile());
    const deferredTile = createDeferred<ReturnType<typeof summaryTile>>();
    let pendingViewportRequest: {
      sessionId: string;
      request: { chrom: string; start: number; end: number; generation: number };
      requestId: string;
    } | null = null;
    mockGetAnnotationTile.mockImplementation((sessionId, request, requestId) => {
      if (request.start === 0) return Promise.resolve(summaryTile());
      pendingViewportRequest = { sessionId, request, requestId };
      return deferredTile.promise;
    });
    mockGetSequenceWindow.mockImplementation(async (sessionId, request, requestId) =>
      sequenceWindowResponse(sessionId, request, requestId)
    );
    webglState.viewportRange = { start: 1_000_000, end: 1_001_000 };
    webglState.centerBp = 1_000_500;

    render(
      <IndexedGenomeViewer
        manifest={freshManifest()}
        length={135_000_000}
        sessionId="session-chr11"
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId('indexed-genome-webgl-map')).toHaveAttribute(
        'data-feature-count',
        '1'
      );
    });

    const onCameraChange = webglState.props?.onCameraChange as
      | ((centerBp: number, reason: 'scroll' | 'zoom') => void)
      | undefined;
    expect(onCameraChange).toBeTypeOf('function');

    act(() => {
      onCameraChange?.(1_000_500, 'zoom');
    });
    await waitFor(() => expect(pendingViewportRequest).not.toBeNull());

    webglState.viewportRange = { start: 0, end: 10_000_000 };
    webglState.centerBp = 5_000_000;
    act(() => {
      onCameraChange?.(5_000_000, 'zoom');
    });
    await waitFor(() => {
      expect(mockCancelRequest).toHaveBeenCalledWith(
        'session-chr11',
        pendingViewportRequest?.requestId
      );
    });

    await act(async () => {
      if (!pendingViewportRequest) throw new Error('Missing pending viewport request');
      deferredTile.resolve(
        viewportAnnotationTileResponse(
          pendingViewportRequest.sessionId,
          pendingViewportRequest.request,
          pendingViewportRequest.requestId
        )
      );
      await Promise.resolve();
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('indexed-genome-webgl-map')).toHaveAttribute(
      'data-feature-count',
      '1'
    );
  });

  it('mounts the coordinate shell while polling a background summary build', async () => {
    vi.useFakeTimers();
    try {
      mockGetFeatures.mockReset();
      mockGetFeatures.mockResolvedValue([]);
      mockGetTrackTile.mockReset();
      mockGetAnnotationTile.mockReset();
      mockGetAnnotationTile
        .mockResolvedValueOnce(buildingSummaryTile())
        .mockResolvedValueOnce(summaryTile());
      mockGetSequence.mockResolvedValue('');
      mockGetSequenceWindow.mockResolvedValue(
        sequenceWindowResponse('session-chr11', {
          chrom: 'chr11',
          start: 0,
          end: 0,
          generation: 0,
        })
      );

      render(
        <IndexedGenomeViewer
          manifest={freshManifest()}
          length={135_000_000}
          sessionId="session-chr11"
        />
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(mockGetAnnotationTile).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('indexed-genome-webgl-map')).toHaveAttribute(
        'data-feature-count',
        '0'
      );
      const summaryState = screen.getByTestId('indexed-genome-summary-state');
      expect(summaryState).toHaveAttribute('data-tile-state', 'building_summary');
      expect(summaryState).toHaveClass('absolute');
      expect(summaryState.parentElement).toHaveAttribute(
        'data-testid',
        'indexed-genome-canvas-host'
      );

      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockGetAnnotationTile).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('indexed-genome-webgl-map')).toHaveAttribute(
        'data-feature-count',
        '1'
      );
      expect(screen.queryByTestId('indexed-genome-summary-state')).toBeNull();
      expect(mockGetTrackTile).not.toHaveBeenCalled();
      expect(mockGetFeatures).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
