// @vitest-environment jsdom
import { createHash } from 'node:crypto';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Renderer } from 'pixi.js';
import type { Genome, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';
import {
  COMPILED_BROAD_SURFACE_ADMISSION_PROVENANCE_V1,
  buildCompiledBroadSurfaceManifestV2,
  compiledBroadSurfaceCellIdV2,
  type CompiledBroadSurfaceAdmissionProvenanceV1,
  type CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';
import type { AnnotationOverlay as AnnotationOverlayType } from './annotation-overlay';
import { overlayPresenterInternals } from './indexed-overlay-test-internals';
import type { CompiledBroadSurfacePixiPresenterV2 as CompiledBroadSurfacePixiPresenterType } from '../overview/compiled-broad-surface-pixi-presenter';
import type { PartitionedInstancedTranscriptLayer as PartitionedInstancedTranscriptLayerType } from '../overview/partitioned-instanced-transcript-layer';
import { TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1 } from '../overview/compiled-broad-annotation-interaction-binary-v1';
import {
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  PREPACKED_ANNOTATION_VIEWPORT_DETAIL_V1,
  prepackedAnnotationSceneArtifactKey,
  type PrepackedAnnotationSceneLoadInput,
} from '../overview/prepacked-annotation-scene';
import { buildAnnotationPolicyProjectionTableV1 } from '../overview/annotation-policy-projection-v1';
import { buildAnnotationPolicyGpuInstanceDataV1 } from '../overview/annotation-policy-gpu-instances-v1';
import {
  buildPrepackedAnnotationInteractionIndexV2,
  projectPrepackedAnnotationFeatureLookupIndexV2,
} from '../overview/prepacked-annotation-interaction-index-v2';
import { retainedSubpixelAlphaScale } from '../overview/retained-subpixel-aa';
import { buildPartitionedTranscriptScene } from '../overview/partitioned-transcript-scene';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from '../overview/transcript-glyph-instances';
import { packGpuReadyPartitionedTranscriptSceneBinaryV4 } from '../overview/partitioned-transcript-scene-binary-v4';
import {
  bindTrustedPartitionedTranscriptSceneDetailInteractionV1,
  packPartitionedTranscriptSceneDetailPacketV1,
  unpackPartitionedTranscriptSceneDetailPacketV1,
} from '../overview/partitioned-transcript-scene-detail-packet-v1';
import { buildPartitionedTranscriptSceneRangeCatalogV1 } from '../overview/partitioned-transcript-scene-range-catalog-v1';
import { compiledBroadSurfaceGlobalStandbyLevelIndicesV2 } from './annotation-compiled-broad-address';

const GENOME_LENGTH_BP = 3_088_269_832;
const VIEWPORT_WIDTH_PX = 1_600;
const BROAD_CORRIDOR_FINEST_SPAN_BP = 16_000_000;
const SOURCE_FINGERPRINT = '0123456789abcdef01234567';
const PLACEMENT_FINGERPRINT = 'ap1:0123456789abcdef01234567';
const sha256 = async (bytes: Uint8Array): Promise<string> =>
  createHash('sha256').update(bytes).digest('hex');

let AnnotationOverlay: typeof AnnotationOverlayType;
let CompiledBroadSurfacePixiPresenterV2: typeof CompiledBroadSurfacePixiPresenterType;
let PartitionedInstancedTranscriptLayer: typeof PartitionedInstancedTranscriptLayerType;

beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
  ({ AnnotationOverlay } = await import('./annotation-overlay'));
  ({ CompiledBroadSurfacePixiPresenterV2 } =
    await import('../overview/compiled-broad-surface-pixi-presenter'));
  ({ PartitionedInstancedTranscriptLayer } =
    await import('../overview/partitioned-instanced-transcript-layer'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function genome(annotationLayerTypes: string[] = ['mRNA']): Genome {
  return {
    name: 'hg002-grch38',
    sourceIdentity: 'hg002-grch38-source',
    length: GENOME_LENGTH_BP,
    circular: false,
    annotationLayerTypes,
    annotationSourcePlacementProvenance: {
      contract: 'validated-annotation-source-placement.v1',
      sourceFingerprint: SOURCE_FINGERPRINT,
      placementFingerprint: PLACEMENT_FINGERPRINT,
    },
    annotationLayout: { maxAnnotationLane: 11, maxCdsLane: -1 },
    features: [
      {
        id: 1,
        type: 'mRNA',
        start: 1_500_000_000,
        end: 1_500_010_000,
        direction: 'forward',
        displayName: 'TX1',
        color: 0x3b82f6,
        lane: 0,
        annotationTrackLane: 0,
        exons: [{ start: 1_500_000_000, end: 1_500_010_000 }],
      },
    ],
  };
}

function genomeWithoutAnnotationSourcePlacement(): Genome {
  const value = genome();
  delete value.annotationSourcePlacementProvenance;
  return value;
}

function state(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: VIEWPORT_WIDTH_PX,
    height: 500,
    themeMode: 'light',
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

function pathForSpan(spanBp: number, startBp = Math.floor((GENOME_LENGTH_BP - spanBp) / 2)) {
  const pixelsPerBp = VIEWPORT_WIDTH_PX / spanBp;
  return {
    isArcMode: false,
    pixelsPerBp,
    viewStartBp: startBp,
    viewEndBp: startBp + spanBp,
    fwdStrandTop: 160,
    bpLeftX: (bp: number) => (bp - startBp) * pixelsPerBp,
    bpToScreenX: (bp: number) => (bp - startBp) * pixelsPerBp,
    bpCenterX: (bp: number) => (bp - startBp) * pixelsPerBp,
    featureLabelPosAt: (bp: number, offset: number) => ({
      x: (bp - startBp) * pixelsPerBp,
      y: 160 + offset,
      z: 0,
    }),
    featurePolygonAt: () => [],
  } as unknown as PathMapper;
}

function layout(): UnifiedLayout {
  return {
    annotationTop: 0,
    annotationHeight: 1_024,
    annotationOffset: -8,
    annotationStep: 16,
    cdsBarOffset: -8,
    cdsLaneStep: 16,
    fwdStrandTop: 160,
    revStrandBottom: 190,
    rulerY: 210,
    totalHeight: 1_200,
    offset: 0,
    sequenceRevealProgress: 0,
  } as UnifiedLayout;
}

function renderer(resolution = 1): Renderer {
  return {
    type: 1,
    resolution,
    texture: { initSource: vi.fn() },
    shader: { bind: vi.fn(), resetState: vi.fn() },
    geometry: { bind: vi.fn(), resetState: vi.fn() },
  } as unknown as Renderer;
}

function prepare(overlay: AnnotationOverlayType): void {
  prepareRasterOnly(overlay);
  expect(overlay.loadPrepackedAnnotationScene(policySceneInput())).toBe(true);
}

function prepareRasterOnly(overlay: AnnotationOverlayType, resolution = 1): void {
  overlay.setRenderer(renderer(resolution));
  overlay.loadGenome(genome());
  overlay.setLayout(layout());
}

function policySceneInput(): PrepackedAnnotationSceneLoadInput {
  const primitive = {
    startBp: 1_500_000_000,
    endBp: 1_500_010_000,
    featureIndex: 0,
    offsetCenter: -23,
    halfH: 7,
    color: 0x3b82f6,
    alpha: 1,
    cdsFade: 0,
    dirSign: 1 as const,
  };
  const policyProjectionInput = {
    features: [
      {
        annotationType: 'mRNA',
        expandedLane: 1,
        expandedTrackLane: 1,
        canonicalLane: 0,
        canonicalTrackLane: 0,
      },
    ],
    expandedBandOrder: ['mRNA'],
    canonicalBandOrder: ['mRNA'],
  } as const;
  const policyProjection = buildAnnotationPolicyProjectionTableV1(policyProjectionInput);
  return {
    ownerKey: 'compiled-broad-policy-owner',
    scene: {
      families: [{ id: 'transcript', kind: 'transcript', metadata: {} }],
      featureFamilyIndices: new Uint32Array([0]),
      primitives: [primitive],
    },
    interactionIndex: buildPrepackedAnnotationInteractionIndexV2(
      [
        {
          rendererId: 1,
          startBp: primitive.startBp,
          endBp: primitive.endBp,
          lane: 1,
          direction: 'forward',
          displayName: 'TX1',
          type: 'mRNA',
          transcriptId: 'NM_TX1.1',
          sourceId: 'rna-TX1',
          canonicalIdentity: 'canonical-TX1',
        },
      ],
      [primitive]
    ),
    policyProjection,
    policyGpuInstanceData: buildAnnotationPolicyGpuInstanceDataV1(
      new Uint32Array([0]),
      policyProjection
    ),
    runtimePolicy: { isoformMode: 'canonical', laneLimit: 12 },
    metadata: {
      genomeIdentity: 'hg002-grch38-source',
      genomeLengthBp: GENOME_LENGTH_BP,
      partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
      artifactKey: prepackedAnnotationSceneArtifactKey({
        themeMode: 'light',
        trackType: 'mRNA',
      }),
      themeMode: 'light',
      trackType: 'mRNA',
      annotationBarHeightPx: PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
      laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
      mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
      geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
      interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
    },
  };
}

function compactPolicyInteractionInput(input = policySceneInput()) {
  return {
    validationMarker: TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1,
    ownerKey: input.ownerKey,
    sourceFingerprint: SOURCE_FINGERPRINT,
    interactionPayloadSha256: '9'.repeat(64),
    sourceScene: {
      byteCount: 300_607_490,
      payloadSha256: 'a'.repeat(64),
      contractSha256: 'b'.repeat(64),
    },
    metadata: input.metadata,
    policyProjection: input.policyProjection!,
    featureLookup: projectPrepackedAnnotationFeatureLookupIndexV2(input.interactionIndex),
  };
}

async function trustedCorridorInputs(): Promise<
  Readonly<{
    compact: ReturnType<typeof compactPolicyInteractionInput>;
    first: PrepackedAnnotationSceneLoadInput;
    second: PrepackedAnnotationSceneLoadInput;
  }>
> {
  const base = policySceneInput();
  const firstPrimitive = base.scene.primitives[0]!;
  const secondPrimitive = {
    ...firstPrimitive,
    startBp: 1_620_000_000,
    endBp: 1_620_010_000,
    featureIndex: 1,
    color: 0x22c55e,
  };
  const primitives = [firstPrimitive, secondPrimitive];
  const interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
    [
      {
        rendererId: 1,
        startBp: firstPrimitive.startBp,
        endBp: firstPrimitive.endBp,
        lane: 1,
        direction: 'forward',
        displayName: 'TX1',
        type: 'mRNA',
        transcriptId: 'NM_TX1.1',
        sourceId: 'rna-TX1',
        canonicalIdentity: 'canonical-TX1',
      },
      {
        rendererId: 2,
        startBp: secondPrimitive.startBp,
        endBp: secondPrimitive.endBp,
        lane: 1,
        direction: 'forward',
        displayName: 'TX2',
        type: 'mRNA',
        transcriptId: 'NM_TX2.1',
        sourceId: 'rna-TX2',
        canonicalIdentity: 'canonical-TX2',
      },
    ],
    primitives
  );
  const policyProjectionInput = {
    features: [
      {
        annotationType: 'mRNA',
        expandedLane: 0,
        expandedTrackLane: 0,
        canonicalLane: 0,
        canonicalTrackLane: 0,
      },
      {
        annotationType: 'mRNA',
        expandedLane: 0,
        expandedTrackLane: 0,
        canonicalLane: 0,
        canonicalTrackLane: 0,
      },
    ],
    expandedBandOrder: ['mRNA'],
    canonicalBandOrder: ['mRNA'],
  } as const;
  const policyProjection = buildAnnotationPolicyProjectionTableV1(policyProjectionInput);
  const sourceScene = buildPartitionedTranscriptScene(
    primitives,
    PREPACKED_ANNOTATION_PARTITION_SPAN_BP
  );
  const source = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
    datasetContract: {
      datasetId: 'corridor-fixture',
      datasetVersion: '1',
      sourceSha256: '7'.repeat(64),
    },
    assemblyContract: {
      assemblyId: 'grch38',
      assemblyLengthBp: GENOME_LENGTH_BP,
    },
    families: [{ id: 'transcript', kind: 'transcript', metadata: {} }],
    featureFamilyIndices: new Uint32Array([0, 0]),
    scene: sourceScene,
    interactionIndex,
    policyProjection: policyProjectionInput,
    payloadSha256: sha256,
  });
  const catalog = await buildPartitionedTranscriptSceneRangeCatalogV1(
    source.manifest,
    source.payload,
    sha256
  );
  const parent: PrepackedAnnotationSceneLoadInput = {
    ...base,
    scene: {
      ...base.scene,
      featureFamilyIndices: new Uint32Array([0, 0]),
      primitives,
    },
    interactionIndex,
    policyProjection,
    policyGpuInstanceData: buildAnnotationPolicyGpuInstanceDataV1(
      new Uint32Array([0, 1]),
      policyProjection
    ),
  };
  const compact = {
    ...compactPolicyInteractionInput(parent),
    sourceScene: {
      byteCount: source.manifest.byteLength,
      payloadSha256: source.manifest.integrity.payloadSha256,
      contractSha256: source.manifest.integrity.contractSha256,
    },
  };
  const detailInput = async (
    startBp: number,
    endBp: number
  ): Promise<PrepackedAnnotationSceneLoadInput> => {
    const packet = await packPartitionedTranscriptSceneDetailPacketV1({
      sourceManifest: source.manifest,
      rangeCatalog: catalog,
      startBp,
      endBp,
      readRange: async (range) =>
        source.payload.slice(range.byteOffset, range.byteOffset + range.byteLength),
      payloadSha256: sha256,
    });
    const unpacked = await unpackPartitionedTranscriptSceneDetailPacketV1(
      packet.manifest,
      packet.payload,
      sha256
    );
    const interaction = bindTrustedPartitionedTranscriptSceneDetailInteractionV1(
      packet.manifest,
      unpacked.scene,
      compact.featureLookup,
      unpacked.rendererAdmissionCapability
    );
    return {
      ownerKey: parent.ownerKey,
      scene: {
        primitives: [],
        families: [...packet.manifest.families],
        featureFamilyIndices: unpacked.featureFamilyIndices,
      },
      gpuReadyScene: unpacked.scene,
      interactionIndex: interaction.interactionIndex,
      policyProjection,
      submissionBank: unpacked.submissionBank,
      submissionFineIndices: unpacked.submissionFineIndices,
      trustedViewportDetailPacketAdmissionV1: unpacked.rendererAdmissionCapability,
      trustedViewportDetailInteractionAdmissionV1: interaction.rendererAdmissionCapability,
      runtimePolicy: { isoformMode: 'canonical', laneLimit: 12 },
      metadata: parent.metadata,
      viewportDetail: {
        contract: PREPACKED_ANNOTATION_VIEWPORT_DETAIL_V1,
        packetPayloadSha256: packet.manifest.integrity.payloadSha256,
        sourceFingerprint: compact.sourceFingerprint,
        interactionPayloadSha256: compact.interactionPayloadSha256,
        sourceScene: packet.manifest.sourceScene,
        empty: unpacked.empty,
        coverageStartBp: startBp,
        coverageEndBp: endBp,
        handoffStartBp: startBp + Math.floor((endBp - startBp - 50_000_000) / 2),
        handoffEndBp: startBp + Math.floor((endBp - startBp + 50_000_000) / 2),
      },
    };
  };
  return {
    compact,
    first: await detailInput(1_400_000_000, 1_600_000_000),
    second: await detailInput(1_450_000_000, 1_650_000_000),
  };
}

function lncPolicySceneInput(): PrepackedAnnotationSceneLoadInput {
  const input = policySceneInput();
  const primitive = input.scene.primitives[0]!;
  const policyProjection = buildAnnotationPolicyProjectionTableV1({
    features: [
      {
        annotationType: 'lnc_RNA',
        expandedLane: 1,
        expandedTrackLane: 1,
        canonicalLane: 0,
        canonicalTrackLane: 0,
      },
    ],
    expandedBandOrder: ['lnc_RNA'],
    canonicalBandOrder: ['lnc_RNA'],
  });
  return {
    ...input,
    ownerKey: 'compiled-broad-lnc-rna-owner',
    interactionIndex: buildPrepackedAnnotationInteractionIndexV2(
      [
        {
          rendererId: 1,
          startBp: primitive.startBp,
          endBp: primitive.endBp,
          lane: 1,
          direction: 'forward',
          displayName: 'LNC1',
          type: 'lnc_RNA',
          transcriptId: 'NR_LNC1.1',
          sourceId: 'rna-LNC1',
          canonicalIdentity: 'canonical-LNC1',
        },
      ],
      [primitive]
    ),
    policyProjection,
    policyGpuInstanceData: buildAnnotationPolicyGpuInstanceDataV1(
      new Uint32Array([0]),
      policyProjection
    ),
    metadata: {
      ...input.metadata,
      artifactKey: prepackedAnnotationSceneArtifactKey({
        themeMode: 'light',
        trackType: 'lnc_RNA',
      }),
      trackType: 'lnc_RNA',
    },
  };
}

function provenance(
  artifact: CompiledBroadSurfaceManifestV2,
  overrides: Partial<CompiledBroadSurfaceAdmissionProvenanceV1> = {}
): CompiledBroadSurfaceAdmissionProvenanceV1 {
  const prepacked = policySceneInput();
  return {
    contract: COMPILED_BROAD_SURFACE_ADMISSION_PROVENANCE_V1,
    manifestFingerprint: artifact.manifestFingerprint,
    artifactKey: artifact.artifactKey,
    trackId: artifact.trackId,
    genomeIdentity: prepacked.metadata.genomeIdentity,
    genomeLengthBp: prepacked.metadata.genomeLengthBp,
    sourceFingerprint: SOURCE_FINGERPRINT,
    placementFingerprint: PLACEMENT_FINGERPRINT,
    themeMode: 'light',
    prepackedOwnerKey: prepacked.ownerKey,
    prepackedArtifactKey: prepacked.metadata.artifactKey,
    ...overrides,
  };
}

async function preparePolicyTransactionFixture(): Promise<{
  overlay: AnnotationOverlayType;
  artifact: CompiledBroadSurfaceManifestV2;
  path: PathMapper;
}> {
  const overlay = new AnnotationOverlay();
  prepare(overlay);
  const artifact = await manifest();
  expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
  const path = pathForSpan(500_000_000);
  expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
    true
  );
  const initial = overlay.getCompiledBroadSurfaceDemand({
    isoformMode: 'canonical',
    laneLimit: 12,
  });
  expect(initial.status).toBe('broad-ready');
  for (const address of initial.missingRequiredCellAddresses) {
    expect(
      overlay.admitCompiledBroadSurfaceTransparentCell({
        ...address,
        demandLeaseId: initial.demandLeaseId!,
        manifestFingerprint: artifact.manifestFingerprint,
      }).status
    ).toBe('admitted');
  }
  expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
    true
  );
  expect(overlay.getCompiledBroadSurfaceDiagnostics()).toMatchObject({
    presenting: true,
    activeIsoformMode: 'canonical',
    activeLaneLimit: 12,
  });
  return { overlay, artifact, path };
}

function warmPolicy(
  overlay: AnnotationOverlayType,
  artifact: CompiledBroadSurfaceManifestV2,
  policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null }
): void {
  const demand = overlay.getCompiledBroadSurfaceDemand(policy);
  expect(demand.status).toBe('broad-ready');
  for (const address of demand.missingRequiredCellAddresses) {
    expect(
      overlay.admitCompiledBroadSurfaceTransparentCell({
        ...address,
        demandLeaseId: demand.demandLeaseId!,
        manifestFingerprint: artifact.manifestFingerprint,
      }).status
    ).toBe('admitted');
  }
}

function warmPolicyForManifest(
  overlay: AnnotationOverlayType,
  artifact: CompiledBroadSurfaceManifestV2,
  policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null }
): void {
  const demand = overlay.getCompiledBroadSurfaceDemand(policy, artifact.manifestFingerprint);
  expect(demand.status).toBe('broad-ready');
  for (const address of demand.missingRequiredCellAddresses) {
    expect(
      overlay.admitCompiledBroadSurfaceTransparentCell({
        ...address,
        demandLeaseId: demand.demandLeaseId!,
        manifestFingerprint: artifact.manifestFingerprint,
      }).status
    ).toBe('admitted');
  }
}

async function manifest(
  artifactKey = 'bounded-annotation-artifact.v2:mrna',
  trackId = 'mrna',
  laneRowCounts: Readonly<{ canonical: number; expanded: number }> = {
    canonical: 12,
    expanded: 70,
  },
  rasterDevicePixelRatio = 1,
  genomeLengthBp = GENOME_LENGTH_BP,
  broadCorridorFinestSpanBp = BROAD_CORRIDOR_FINEST_SPAN_BP
): Promise<CompiledBroadSurfaceManifestV2> {
  return buildCompiledBroadSurfaceManifestV2({
    artifactKey,
    trackId,
    genomeLengthBp,
    broadCorridorFinestSpanBp,
    broadTilePhysicalWidthPx: 512,
    broadTileXGuardPhysicalPx: 1,
    prefetchRing: 1,
    maxQualifiedRasterMagnificationX: 1.75,
    rasterDevicePixelRatio,
    laneSlabRowCount: 8,
    laneRowCssHeightPx: 16,
    laneRowTextureStridePx: 16 * rasterDevicePixelRatio,
    laneRowTransparentTailGutterPx: 2 * rasterDevicePixelRatio,
    laneRowCounts,
  });
}

function updateCamera(
  overlay: AnnotationOverlayType,
  spanBp: number,
  startBp?: number,
  themeMode: 'light' | 'dark' = 'light'
): boolean {
  return overlay.updateRetainedCamera({
    path: pathForSpan(spanBp, startBp),
    state: { ...state(), themeMode },
    yOffset: 0,
    height: 500,
  });
}

function admitViewportDetailRosterAtFineLocus(
  overlay: AnnotationOverlayType,
  startBp = 1_520_000_000
): void {
  const path = pathForSpan(512 * 1024, startBp);
  prepareViewportDetailRoster(overlay, path.viewStartBp, path.viewEndBp);
  expect(
    overlay.admitPrepackedAnnotationViewportDetailRoster(path.viewStartBp, path.viewEndBp, 'light')
  ).toBe(true);
}

function prepareViewportDetailRoster(
  overlay: AnnotationOverlayType,
  viewportStartBp: number,
  viewportEndBp: number
): void {
  for (let slice = 0; slice < 8; slice += 1) {
    const result = overlay.preparePrepackedAnnotationFineViews(
      viewportStartBp,
      viewportEndBp,
      'light'
    );
    if (result.status === 'complete') return;
    expect(result.status).toBe('prepared');
  }
  throw new Error('viewport detail roster did not finish within its bounded preparation slices');
}

describe('AnnotationOverlay compiled broad-surface demand leases', () => {
  it('retains an admitted overview when zoom reaches detail before detail is loaded', async () => {
    const overlay = new AnnotationOverlay();
    try {
      prepareRasterOnly(overlay);
      const artifact = await manifest();
      expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
      updateCamera(overlay, 500_000_000, 1_300_000_000);
      const demand = overlay.getCompiledBroadSurfaceDemand({
        isoformMode: 'canonical',
        laneLimit: 12,
      });
      for (const address of demand.missingRequiredCellAddresses) {
        expect(
          overlay.admitCompiledBroadSurfaceTransparentCell({
            ...address,
            demandLeaseId: demand.demandLeaseId!,
            manifestFingerprint: artifact.manifestFingerprint,
          }).status
        ).toBe('admitted');
      }
      updateCamera(overlay, 500_000_000, 1_300_000_000);
      expect(overlay.getColdGestureSnapshot().compiledBroadRasterVisible).toBe(true);
      updateCamera(overlay, 20_000_000, 1_490_000_000);
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        compiledBroadRasterVisible: true,
        compiledBroadRasterPlanStatus: 'broad-holding-last-good',
      });
      updateCamera(overlay, 100_000, 1_500_000_000);
      expect(overlay.getColdGestureSnapshot().compiledBroadRasterVisible).toBe(true);
    } finally {
      overlay.destroy();
    }
  });

  it('treats a complete genome below the physical broad handoff as detail-only readiness', async () => {
    const genomeLengthBp = 12_157_105;
    const overlay = new AnnotationOverlay();
    overlay.setRenderer(renderer());
    overlay.loadGenome({
      ...genome(['mRNA']),
      length: genomeLengthBp,
      features: [],
    });
    overlay.setLayout(layout());
    const artifact = await manifest(
      'bounded-annotation-artifact.v2:small-mrna',
      'mrna',
      { canonical: 12, expanded: 70 },
      1,
      genomeLengthBp,
      6_000_000
    );
    expect(
      overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact, { genomeLengthBp }))
    ).toBe(true);
    expect(updateCamera(overlay, genomeLengthBp, 0)).toBe(true);

    expect(
      overlay.getCompiledBroadSurfaceDemand({ isoformMode: 'canonical', laneLimit: 12 })
    ).toMatchObject({
      status: 'detail-required',
      requiredCellAddresses: [],
      missingRequiredCellAddresses: [],
      successorCellAddresses: [],
      missingSuccessorCellAddresses: [],
      interactionPrefetchCellAddresses: [],
      missingInteractionPrefetchCellAddresses: [],
      missingCellAddresses: [],
    });
    overlay.destroy();
  });

  it('prepares every broad successor mip while detail remains the only presentation owner', async () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const artifact = await manifest();
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    const detailStartBp = 1_490_000_000;
    expect(updateCamera(overlay, 20_000_000, detailStartBp)).toBe(true);
    const policy = { isoformMode: 'canonical' as const, laneLimit: 12 };
    const detailDemand = overlay.getCompiledBroadSurfaceDemand(policy);

    expect(detailDemand.status).toBe('detail-required');
    expect(detailDemand.demandLeaseId).not.toBeNull();
    expect(detailDemand.requiredCellAddresses).toEqual([]);
    expect(detailDemand.missingSuccessorCellAddresses.length).toBeGreaterThan(0);
    expect(detailDemand.missingInteractionPrefetchCellAddresses.length).toBeGreaterThan(0);
    expect(new Set(detailDemand.successorCellAddresses.map(({ level }) => level))).toEqual(
      new Set(artifact.levels.map(({ level }) => level))
    );
    const submittedSlabCount = Math.ceil(policy.laneLimit / artifact.laneSlabRowCount);
    const retainedDetailRoster = [
      ...detailDemand.successorCellAddresses,
      ...detailDemand.interactionPrefetchCellAddresses,
    ];
    for (const level of compiledBroadSurfaceGlobalStandbyLevelIndicesV2(
      artifact,
      submittedSlabCount
    )) {
      expect(retainedDetailRoster.filter((address) => address.level === level)).toHaveLength(
        artifact.levels[level]!.tileCount * submittedSlabCount
      );
    }
    const transitionPrefix = detailDemand.successorCellAddresses.slice(0, 4);
    expect(transitionPrefix).toHaveLength(4);
    expect(new Set(transitionPrefix.map(({ level }) => level))).toEqual(new Set([0]));
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      compiledBroadRasterVisible: false,
      compiledBroadRasterPlanStatus: 'detail-required',
    });

    for (const address of detailDemand.missingSuccessorCellAddresses) {
      expect(
        overlay.admitCompiledBroadSurfaceTransparentCell({
          ...address,
          demandLeaseId: detailDemand.demandLeaseId!,
          manifestFingerprint: artifact.manifestFingerprint,
        })
      ).toMatchObject({ status: 'admitted' });
    }
    for (const address of detailDemand.missingInteractionPrefetchCellAddresses) {
      expect(
        overlay.admitCompiledBroadSurfaceTransparentCell({
          ...address,
          demandLeaseId: detailDemand.demandLeaseId!,
          manifestFingerprint: artifact.manifestFingerprint,
        })
      ).toMatchObject({ status: 'admitted' });
    }

    expect(updateCamera(overlay, 450_000_000, detailStartBp + 10_000_000)).toBe(true);
    const successorDemand = overlay.getCompiledBroadSurfaceDemand(policy);
    expect(successorDemand.status).toBe('broad-ready');
    expect(successorDemand.missingRequiredCellAddresses).toEqual([]);
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      soleOwnerCount: 1,
      soleOwnerId: 'compiled-broad-raster-surface',
      compiledBroadRasterVisible: true,
      compiledBroadRasterPlanStatus: 'broad-presenting',
    });
    overlay.destroy();
  });

  it('derives successor coverage from the newest same-owner detail replacement', async () => {
    const overlay = new AnnotationOverlay();
    prepareRasterOnly(overlay);
    const { compact, first, second } = await trustedCorridorInputs();
    expect(overlay.loadCompiledBroadAnnotationInteraction(compact)).not.toBeNull();
    const artifact = await manifest();
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    expect(overlay.preparePrepackedAnnotationScene(first)).toBe(true);
    admitViewportDetailRosterAtFineLocus(overlay);
    expect(updateCamera(overlay, 20_000_000, 1_490_000_000)).toBe(true);
    const policy = { isoformMode: 'canonical' as const, laneLimit: 12 };
    const incumbentDemand = overlay.getCompiledBroadSurfaceDemand(policy);
    expect(incumbentDemand.status).toBe('detail-required');
    const incumbentFinestTiles = new Set(
      incumbentDemand.successorCellAddresses
        .filter(({ level }) => level === 0)
        .map(({ tileX }) => tileX)
    );

    expect(overlay.preparePrepackedAnnotationScene(second)).toBe(true);
    const replacementDemand = overlay.getCompiledBroadSurfaceDemand(policy);
    expect(replacementDemand.status).toBe('detail-required');
    const replacementFinestTiles = new Set(
      replacementDemand.successorCellAddresses
        .filter(({ level }) => level === 0)
        .map(({ tileX }) => tileX)
    );

    expect(replacementFinestTiles).not.toEqual(incumbentFinestTiles);
    expect(Math.max(...replacementFinestTiles)).toBeGreaterThan(Math.max(...incumbentFinestTiles));
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      soleOwnerCount: 1,
      soleOwnerId: 'prepacked-partitioned-vector-surface',
      compiledBroadRasterVisible: false,
    });
    overlay.destroy();
  });

  it('keeps broad demand path-independent after a prior detail visit', async () => {
    const overlay = new AnnotationOverlay();
    prepareRasterOnly(overlay);
    const { compact, first } = await trustedCorridorInputs();
    expect(overlay.loadCompiledBroadAnnotationInteraction(compact)).not.toBeNull();
    const artifact = await manifest();
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    expect(overlay.preparePrepackedAnnotationScene(first)).toBe(true);
    admitViewportDetailRosterAtFineLocus(overlay);
    const policy = { isoformMode: 'canonical' as const, laneLimit: 12 };

    expect(updateCamera(overlay, 20_000_000, 1_490_000_000)).toBe(true);
    const detailDemand = overlay.getCompiledBroadSurfaceDemand(policy);
    expect(detailDemand.status).toBe('detail-required');
    const detailHandoffIds = new Set(
      detailDemand.successorCellAddresses.map(({ cellId }) => cellId)
    );
    expect(detailHandoffIds.size).toBeGreaterThan(0);

    expect(updateCamera(overlay, 500_000_000, 1_250_000_000)).toBe(true);
    const broadDemand = overlay.getCompiledBroadSurfaceDemand(policy);
    expect(broadDemand.status).toBe('broad-ready');
    const baseline = new AnnotationOverlay();
    prepareRasterOnly(baseline);
    expect(baseline.loadCompiledBroadAnnotationInteraction(compact)).not.toBeNull();
    expect(baseline.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    expect(updateCamera(baseline, 500_000_000, 1_250_000_000)).toBe(true);
    const baselineDemand = baseline.getCompiledBroadSurfaceDemand(policy);
    expect(baselineDemand.status).toBe('broad-ready');
    const tiers = [
      broadDemand.requiredCellAddresses,
      broadDemand.successorCellAddresses,
      broadDemand.interactionPrefetchCellAddresses,
      broadDemand.prefetchCellAddresses,
    ].map((addresses) => new Set(addresses.map(({ cellId }) => cellId)));
    const [requiredIds, successorIds, interactionIds, prefetchIds] = tiers;

    for (let left = 0; left < tiers.length; left += 1) {
      for (let right = left + 1; right < tiers.length; right += 1) {
        expect([...tiers[left]!].filter((cellId) => tiers[right]!.has(cellId))).toEqual([]);
      }
    }
    expect(requiredIds).toEqual(
      new Set(baselineDemand.requiredCellAddresses.map(({ cellId }) => cellId))
    );
    expect(successorIds).toEqual(
      new Set(baselineDemand.successorCellAddresses.map(({ cellId }) => cellId))
    );
    expect(interactionIds).toEqual(
      new Set(baselineDemand.interactionPrefetchCellAddresses.map(({ cellId }) => cellId))
    );
    expect(prefetchIds).toEqual(
      new Set(baselineDemand.prefetchCellAddresses.map(({ cellId }) => cellId))
    );

    baseline.destroy();
    overlay.destroy();
  });

  it('leases a bounded fast-motion envelope with near-first finer mips and a coarser return spine', async () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const artifact = await manifest();
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    expect(updateCamera(overlay, 500_000_000, 100_000_000)).toBe(true);
    const policy = { isoformMode: 'canonical' as const, laneLimit: 12 };
    const first = overlay.getCompiledBroadSurfaceDemand(policy);
    expect(first.status).toBe('broad-ready');

    const firstRoster = new Set(
      [
        ...first.requiredCellAddresses,
        ...first.successorCellAddresses,
        ...first.interactionPrefetchCellAddresses,
        ...first.prefetchCellAddresses,
      ].map(({ cellId }) => cellId)
    );
    const fullPolicyPyramidCellCount =
      artifact.levels.reduce((total, level) => total + level.tileCount, 0) *
      Math.ceil(policy.laneLimit / artifact.laneSlabRowCount);
    expect(firstRoster.size).toBeLessThan(fullPolicyPyramidCellCount);
    const finestRequiredLevel = Math.min(...first.requiredCellAddresses.map(({ level }) => level));
    expect(
      new Set([...firstRoster].map((cellId) => Number(/\|L(\d+):/.exec(cellId)?.[1]))).has(
        Math.max(0, finestRequiredLevel - 3)
      )
    ).toBe(true);

    expect(updateCamera(overlay, 100_000_000, 1_500_000_000)).toBe(true);
    const second = overlay.getCompiledBroadSurfaceDemand(policy);
    expect(second.status).toBe('broad-ready');
    const secondRoster = new Set(
      [
        ...second.requiredCellAddresses,
        ...second.successorCellAddresses,
        ...second.interactionPrefetchCellAddresses,
        ...second.prefetchCellAddresses,
      ].map(({ cellId }) => cellId)
    );
    expect(secondRoster).not.toEqual(firstRoster);
    expect(secondRoster.size).toBeLessThan(fullPolicyPyramidCellCount);
    const finestSecondRequiredLevel = Math.min(
      ...second.requiredCellAddresses.map(({ level }) => level)
    );
    const laneSlabCount = Math.ceil(policy.laneLimit / artifact.laneSlabRowCount);
    for (let level = finestSecondRequiredLevel + 1; level < artifact.levels.length; level += 1) {
      const completeLevelRoster = new Set(
        [
          ...second.requiredCellAddresses,
          ...second.successorCellAddresses,
          ...second.interactionPrefetchCellAddresses,
          ...second.prefetchCellAddresses,
        ]
          .filter((address) => address.level === level)
          .map(({ cellId }) => cellId)
      );
      expect(completeLevelRoster).toHaveLength(artifact.levels[level]!.tileCount * laneSlabCount);
    }
    const finerLevels = [1, 2, 3]
      .map((distance) => finestRequiredLevel - distance)
      .filter((level) => level >= 0);
    const firstSuccessorLevels = new Set(first.successorCellAddresses.map(({ level }) => level));
    const firstInteractionPrefetchLevels = new Set(
      first.interactionPrefetchCellAddresses.map(({ level }) => level)
    );
    if (finerLevels[0] !== undefined) expect(firstSuccessorLevels.has(finerLevels[0])).toBe(true);
    for (const level of finerLevels.slice(1)) {
      expect(firstInteractionPrefetchLevels.has(level)).toBe(true);
    }
    const secondSuccessorIds = new Set(second.successorCellAddresses.map(({ cellId }) => cellId));
    const secondInteractionPrefetchIds = new Set(
      second.interactionPrefetchCellAddresses.map(({ cellId }) => cellId)
    );
    expect(
      second.interactionPrefetchCellAddresses.some(({ cellId }) => secondSuccessorIds.has(cellId))
    ).toBe(false);
    expect(second.prefetchCellAddresses.some(({ cellId }) => secondSuccessorIds.has(cellId))).toBe(
      false
    );
    expect(
      second.prefetchCellAddresses.some(({ cellId }) => secondInteractionPrefetchIds.has(cellId))
    ).toBe(false);
    overlay.destroy();
  });

  it('puts the complete two-viewport interaction pan in the foreground successor contract', async () => {
    const overlay = new AnnotationOverlay();
    prepareRasterOnly(overlay, 2);
    const artifact = await manifest(
      'bounded-annotation-artifact.v2:mrna',
      'mrna',
      { canonical: 12, expanded: 70 },
      2
    );
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    const policy = { isoformMode: 'canonical' as const, laneLimit: 12 };
    const spanBp = 450_000_000;
    const startBp = 1_592_207_132;

    expect(updateCamera(overlay, spanBp, startBp)).toBe(true);
    const beforePan = overlay.getCompiledBroadSurfaceDemand(policy);
    expect(beforePan.status).toBe('broad-ready');
    const foregroundIds = new Set(
      [...beforePan.requiredCellAddresses, ...beforePan.successorCellAddresses].map(
        ({ cellId }) => cellId
      )
    );

    expect(updateCamera(overlay, spanBp, startBp + spanBp * 2)).toBe(true);
    const afterPan = overlay.getCompiledBroadSurfaceDemand(policy);
    expect(afterPan.status).toBe('broad-ready');
    expect(
      afterPan.requiredCellAddresses.filter(({ cellId }) => !foregroundIds.has(cellId))
    ).toEqual([]);

    overlay.destroy();
  });

  it('uses each broad artifact realized lane count under a finite per-track cap', async () => {
    const overlay = new AnnotationOverlay();
    overlay.setRenderer(renderer());
    overlay.loadGenome(genome(['mRNA', 'lnc_RNA']));
    overlay.setLayout(layout());
    const mrnaArtifact = await manifest('bounded-annotation-artifact.v2:mrna:one-lane', 'mRNA', {
      canonical: 1,
      expanded: 1,
    });
    const lncArtifact = await manifest(
      'bounded-annotation-artifact.v2:lnc-rna:two-lanes',
      'lnc_RNA',
      { canonical: 2, expanded: 2 }
    );
    expect(overlay.loadCompiledBroadSurfaceManifest(mrnaArtifact, provenance(mrnaArtifact))).toBe(
      true
    );
    expect(
      overlay.loadCompiledBroadSurfaceManifest(
        lncArtifact,
        provenance(lncArtifact, {
          prepackedOwnerKey: 'compiled-broad-lnc-rna-owner',
          prepackedArtifactKey: prepackedAnnotationSceneArtifactKey({
            themeMode: 'light',
            trackType: 'lnc_RNA',
          }),
        })
      )
    ).toBe(true);

    const internals = overlayPresenterInternals(overlay) as unknown as {
      annotationTrackRealizedLaneCapacity: (
        trackId: string,
        policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null }
      ) => number;
      compiledBroadSurfaceLaneStart: (
        trackId: string,
        requestedLayerTypes: readonly string[],
        policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: number | null }
      ) => number;
      annotationTrackStackMaxLane: (policy: {
        isoformMode: 'canonical' | 'expanded';
        laneLimit: number | null;
      }) => number;
    };
    const selectedTypes = ['mRNA', 'lnc_RNA'] as const;
    const twelveLaneCap = { isoformMode: 'canonical' as const, laneLimit: 12 };
    expect(internals.annotationTrackRealizedLaneCapacity('mRNA', twelveLaneCap)).toBe(1);
    expect(internals.annotationTrackRealizedLaneCapacity('lnc_RNA', twelveLaneCap)).toBe(2);
    expect(internals.compiledBroadSurfaceLaneStart('mRNA', selectedTypes, twelveLaneCap)).toBe(0);
    expect(internals.compiledBroadSurfaceLaneStart('lnc_RNA', selectedTypes, twelveLaneCap)).toBe(
      2
    );
    expect(internals.annotationTrackStackMaxLane(twelveLaneCap)).toBe(3);

    const oneLaneCap = { isoformMode: 'canonical' as const, laneLimit: 1 };
    expect(internals.annotationTrackRealizedLaneCapacity('lnc_RNA', oneLaneCap)).toBe(1);
    expect(internals.compiledBroadSurfaceLaneStart('lnc_RNA', selectedTypes, oneLaneCap)).toBe(2);
    expect(internals.annotationTrackStackMaxLane(oneLaneCap)).toBe(2);
    overlay.destroy();
  });

  it.each(['lnc_RNA', 'enhancer'])(
    'retains the active %s raster until its same-artifact replacement is complete',
    async (trackType) => {
      const overlay = new AnnotationOverlay();
      try {
        overlay.setRenderer(renderer());
        overlay.loadGenome({ ...genome([trackType]), features: [] });
        overlay.setLayout(layout());
        const artifactKey = `bounded-annotation-artifact.v2:${trackType}:refresh`;
        const v1 = await manifest(artifactKey, trackType, { canonical: 12, expanded: 70 });
        const v2 = await manifest(artifactKey, trackType, { canonical: 12, expanded: 69 });
        const receiptOverrides = {
          prepackedOwnerKey: `compiled-broad-${trackType}-owner`,
          prepackedArtifactKey: prepackedAnnotationSceneArtifactKey({
            themeMode: 'light' as const,
            trackType,
          }),
        };
        expect(overlay.loadCompiledBroadSurfaceManifest(v1, provenance(v1, receiptOverrides))).toBe(
          true
        );
        updateCamera(overlay, 500_000_000);
        warmPolicyForManifest(overlay, v1, { isoformMode: 'canonical', laneLimit: 12 });
        expect(updateCamera(overlay, 500_000_000)).toBe(true);

        const internals = overlayPresenterInternals(overlay) as unknown as {
          compiledBroadSurfaceTrackOwners: Map<
            string,
            {
              manifest: CompiledBroadSurfaceManifestV2;
              presenter: CompiledBroadSurfacePixiPresenterType;
            }
          >;
          compiledBroadSurfaceTrackCandidateOwners: Map<
            string,
            {
              manifest: CompiledBroadSurfaceManifestV2;
              presenter: CompiledBroadSurfacePixiPresenterType;
            }
          >;
        };
        const activeV1 = internals.compiledBroadSurfaceTrackOwners.get(trackType)!;
        const destroyV1 = vi.spyOn(activeV1.presenter, 'destroy');
        expect(activeV1.presenter.isPresenting).toBe(true);

        expect(overlay.loadCompiledBroadSurfaceManifest(v2, provenance(v2, receiptOverrides))).toBe(
          true
        );
        expect(internals.compiledBroadSurfaceTrackOwners.get(trackType)?.manifest).toBe(v1);
        expect(internals.compiledBroadSurfaceTrackCandidateOwners.get(trackType)?.manifest).toBe(
          v2
        );
        expect(destroyV1).not.toHaveBeenCalled();
        expect(updateCamera(overlay, 500_000_000)).toBe(true);
        expect(activeV1.presenter.isPresenting).toBe(true);
        expect(destroyV1).not.toHaveBeenCalled();

        warmPolicyForManifest(overlay, v2, { isoformMode: 'canonical', laneLimit: 12 });
        expect(updateCamera(overlay, 500_000_000)).toBe(true);
        const activeV2 = internals.compiledBroadSurfaceTrackOwners.get(trackType)!;
        expect(activeV2.manifest).toBe(v2);
        expect(activeV2.presenter.isPresenting).toBe(true);
        expect(internals.compiledBroadSurfaceTrackCandidateOwners.has(trackType)).toBe(false);
        expect(destroyV1).toHaveBeenCalledOnce();
        expect(overlay.getColdGestureSnapshot()).toMatchObject({
          soleOwnerCount: 1,
          soleOwnerId: 'compiled-broad-raster-surface',
        });
      } finally {
        overlay.destroy();
      }
    }
  );

  it('rebinds a same-raster interaction generation without replacing its presenter or pixels', async () => {
    const overlay = new AnnotationOverlay();
    try {
      const trackType = 'enhancer';
      overlay.setRenderer(renderer());
      overlay.loadGenome({ ...genome([trackType]), features: [] });
      overlay.setLayout(layout());
      const artifact = await manifest(
        'bounded-annotation-artifact.v2:enhancer:same-raster-new-interaction',
        trackType
      );
      const firstProvenance = provenance(artifact, {
        prepackedOwnerKey: 'compiled-broad-enhancer-owner-v1',
        prepackedArtifactKey: prepackedAnnotationSceneArtifactKey({
          themeMode: 'light',
          trackType,
        }),
      });
      const nextProvenance = {
        ...firstProvenance,
        prepackedOwnerKey: 'compiled-broad-enhancer-owner-v2',
      };
      expect(overlay.loadCompiledBroadSurfaceManifest(artifact, firstProvenance)).toBe(true);
      updateCamera(overlay, 500_000_000);
      warmPolicyForManifest(overlay, artifact, {
        isoformMode: 'canonical',
        laneLimit: 12,
      });
      expect(updateCamera(overlay, 500_000_000)).toBe(true);

      const internals = overlayPresenterInternals(overlay) as unknown as {
        compiledBroadSurfaceTrackOwners: Map<
          string,
          {
            provenance: CompiledBroadSurfaceAdmissionProvenanceV1;
            presenter: CompiledBroadSurfacePixiPresenterType;
          }
        >;
        compiledBroadSurfaceTrackCandidateOwners: Map<
          string,
          { provenance: CompiledBroadSurfaceAdmissionProvenanceV1 }
        >;
      };
      const firstOwner = internals.compiledBroadSurfaceTrackOwners.get(trackType);
      const firstPresenter = firstOwner?.presenter;
      const firstResidentCellIds = firstPresenter?.diagnostics().residentCellIds ?? [];
      expect(firstResidentCellIds.length).toBeGreaterThan(0);
      expect(firstPresenter?.isPresenting).toBe(true);
      expect(overlay.loadCompiledBroadSurfaceManifest(artifact, nextProvenance)).toBe(true);
      expect(
        internals.compiledBroadSurfaceTrackOwners.get(trackType)?.provenance.prepackedOwnerKey
      ).toBe(nextProvenance.prepackedOwnerKey);
      expect(internals.compiledBroadSurfaceTrackOwners.get(trackType)?.presenter).toBe(
        firstPresenter
      );
      expect(internals.compiledBroadSurfaceTrackCandidateOwners.has(trackType)).toBe(false);
      expect(firstPresenter?.diagnostics().residentCellIds).toEqual(firstResidentCellIds);
      expect(firstPresenter?.isPresenting).toBe(true);
      expect(updateCamera(overlay, 500_000_000)).toBe(true);
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        soleOwnerCount: 1,
        soleOwnerId: 'compiled-broad-raster-surface',
      });
    } finally {
      overlay.destroy();
    }
  });

  it('keeps the canonical raster owner while dark mode changes only runtime presentation', async () => {
    const overlay = new AnnotationOverlay();
    try {
      const trackType = 'lnc_RNA';
      overlay.setRenderer(renderer());
      overlay.loadGenome({ ...genome([trackType]), features: [] });
      overlay.setLayout(layout());
      const lightArtifact = await manifest(
        'bounded-annotation-artifact.v2:lnc-rna:light',
        trackType
      );
      const darkArtifact = await manifest('bounded-annotation-artifact.v2:lnc-rna:dark', trackType);
      const lightReceipt = provenance(lightArtifact, {
        themeMode: 'light',
        prepackedOwnerKey: 'compiled-broad-lnc-rna-light-owner',
        prepackedArtifactKey: prepackedAnnotationSceneArtifactKey({
          themeMode: 'light',
          trackType,
        }),
      });
      const darkReceipt = provenance(darkArtifact, {
        themeMode: 'dark',
        prepackedOwnerKey: 'compiled-broad-lnc-rna-dark-owner',
        prepackedArtifactKey: prepackedAnnotationSceneArtifactKey({
          themeMode: 'dark',
          trackType,
        }),
      });

      expect(overlay.loadCompiledBroadSurfaceManifest(lightArtifact, lightReceipt)).toBe(true);
      updateCamera(overlay, 500_000_000);
      warmPolicyForManifest(overlay, lightArtifact, {
        isoformMode: 'canonical',
        laneLimit: 12,
      });
      expect(updateCamera(overlay, 500_000_000)).toBe(true);

      const internals = overlayPresenterInternals(overlay) as unknown as {
        compiledBroadSurfaceTrackOwners: Map<
          string,
          {
            manifest: CompiledBroadSurfaceManifestV2;
            presenter: CompiledBroadSurfacePixiPresenterType;
          }
        >;
        compiledBroadSurfaceTrackCandidateOwners: Map<
          string,
          {
            manifest: CompiledBroadSurfaceManifestV2;
            presenter: CompiledBroadSurfacePixiPresenterType;
          }
        >;
      };
      const activeLight = internals.compiledBroadSurfaceTrackOwners.get(trackType)!;
      const hideLight = vi.spyOn(activeLight.presenter, 'hide');
      const destroyLight = vi.spyOn(activeLight.presenter, 'destroy');
      const residentCellIds = activeLight.presenter.diagnostics().residentCellIds;
      expect(activeLight.presenter.isPresenting).toBe(true);

      expect(overlay.loadCompiledBroadSurfaceManifest(darkArtifact, darkReceipt)).toBe(false);
      expect(internals.compiledBroadSurfaceTrackOwners.get(trackType)?.manifest).toBe(
        lightArtifact
      );
      expect(internals.compiledBroadSurfaceTrackCandidateOwners.has(trackType)).toBe(false);
      expect(activeLight.presenter.isPresenting).toBe(true);
      expect(hideLight).not.toHaveBeenCalled();
      expect(destroyLight).not.toHaveBeenCalled();

      expect(updateCamera(overlay, 500_000_000, undefined, 'dark')).toBe(true);
      expect(activeLight.presenter.isPresenting).toBe(true);
      expect(activeLight.presenter.runtimeThemeMode).toBe('dark');
      expect(activeLight.presenter.diagnostics().residentCellIds).toEqual(residentCellIds);
      expect(hideLight).not.toHaveBeenCalled();
      expect(destroyLight).not.toHaveBeenCalled();
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        soleOwnerCount: 1,
        soleOwnerId: 'compiled-broad-raster-surface',
        compiledBroadRasterVisible: true,
        soleOwnerContractValid: true,
        activeOwnerKey: lightReceipt.prepackedOwnerKey,
        activeArtifactKey: lightReceipt.prepackedArtifactKey,
        activeTrackType: trackType,
        activeRuntimeIsoformMode: 'canonical',
        activeRuntimeLaneLimit: 12,
        activeSourceFingerprint: SOURCE_FINGERPRINT,
        activePlacementFingerprint: PLACEMENT_FINGERPRINT,
      });

      expect(updateCamera(overlay, 500_000_000, undefined, 'light')).toBe(true);
      expect(internals.compiledBroadSurfaceTrackOwners.get(trackType)).toBe(activeLight);
      expect(activeLight.presenter.runtimeThemeMode).toBe('light');
      expect(activeLight.presenter.diagnostics().residentCellIds).toEqual(residentCellIds);
      expect(destroyLight).not.toHaveBeenCalled();
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        soleOwnerCount: 1,
        soleOwnerId: 'compiled-broad-raster-surface',
        activeOwnerKey: lightReceipt.prepackedOwnerKey,
        activeArtifactKey: lightReceipt.prepackedArtifactKey,
        activeTrackType: trackType,
      });
    } finally {
      overlay.destroy();
    }
  });

  it('keeps one canonical two-track roster across a dark toggle and policy commit', async () => {
    const overlay = new AnnotationOverlay();
    try {
      const themePolicy = { isoformMode: 'expanded' as const, laneLimit: 8 };
      overlay.setRenderer(renderer());
      overlay.loadGenome({ ...genome(['mRNA', 'lnc_RNA']), features: [] });
      overlay.setLayout(layout());

      const lightMrna = await manifest('bounded-annotation-artifact.v2:mrna:light-roster', 'mRNA');
      const lightLnc = await manifest(
        'bounded-annotation-artifact.v2:lnc-rna:light-roster',
        'lnc_RNA'
      );
      const darkMrna = await manifest('bounded-annotation-artifact.v2:mrna:dark-roster', 'mRNA');
      const darkLnc = await manifest(
        'bounded-annotation-artifact.v2:lnc-rna:dark-roster',
        'lnc_RNA'
      );
      expect(
        overlay.loadCompiledBroadSurfaceManifest(
          lightMrna,
          provenance(lightMrna, {
            themeMode: 'light',
            prepackedOwnerKey: 'compiled-broad-mrna-light-roster-owner',
            prepackedArtifactKey: prepackedAnnotationSceneArtifactKey({
              themeMode: 'light',
              trackType: 'mRNA',
            }),
          })
        )
      ).toBe(true);
      expect(
        overlay.loadCompiledBroadSurfaceManifest(
          lightLnc,
          provenance(lightLnc, {
            themeMode: 'light',
            prepackedOwnerKey: 'compiled-broad-lnc-rna-light-roster-owner',
            prepackedArtifactKey: prepackedAnnotationSceneArtifactKey({
              themeMode: 'light',
              trackType: 'lnc_RNA',
            }),
          })
        )
      ).toBe(true);

      updateCamera(overlay, 500_000_000);
      warmPolicyForManifest(overlay, lightMrna, {
        isoformMode: 'canonical',
        laneLimit: 12,
      });
      warmPolicyForManifest(overlay, lightLnc, {
        isoformMode: 'canonical',
        laneLimit: 12,
      });
      expect(updateCamera(overlay, 500_000_000)).toBe(true);

      const internals = overlayPresenterInternals(overlay) as unknown as {
        compiledBroadSurfaceOwnerForTrack: (trackId: string) => {
          manifest: CompiledBroadSurfaceManifestV2;
          presenter: CompiledBroadSurfacePixiPresenterType;
        } | null;
        compiledBroadSurfaceCandidateOwnerForTrack: (trackId: string) => {
          manifest: CompiledBroadSurfaceManifestV2;
          presenter: CompiledBroadSurfacePixiPresenterType;
        } | null;
      };
      const activeLightMrna = internals.compiledBroadSurfaceOwnerForTrack('mRNA')!;
      const activeLightLnc = internals.compiledBroadSurfaceOwnerForTrack('lnc_RNA')!;
      expect(activeLightMrna.manifest).toBe(lightMrna);
      expect(activeLightLnc.manifest).toBe(lightLnc);
      expect(activeLightMrna.presenter.isPresenting).toBe(true);
      expect(activeLightLnc.presenter.isPresenting).toBe(true);

      expect(
        overlay.loadCompiledBroadSurfaceManifest(
          darkMrna,
          provenance(darkMrna, {
            themeMode: 'dark',
            prepackedOwnerKey: 'compiled-broad-mrna-dark-roster-owner',
            prepackedArtifactKey: prepackedAnnotationSceneArtifactKey({
              themeMode: 'dark',
              trackType: 'mRNA',
            }),
          })
        )
      ).toBe(false);
      expect(updateCamera(overlay, 500_000_000, undefined, 'dark')).toBe(true);

      expect(internals.compiledBroadSurfaceOwnerForTrack('mRNA')?.manifest).toBe(lightMrna);
      expect(internals.compiledBroadSurfaceOwnerForTrack('lnc_RNA')?.manifest).toBe(lightLnc);
      expect(internals.compiledBroadSurfaceCandidateOwnerForTrack('mRNA')).toBeNull();
      expect(activeLightMrna.presenter.runtimeThemeMode).toBe('dark');
      expect(activeLightLnc.presenter.runtimeThemeMode).toBe('dark');
      expect(activeLightMrna.presenter.isPresenting).toBe(true);
      expect(activeLightLnc.presenter.isPresenting).toBe(true);
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        soleOwnerCount: 1,
        soleOwnerId: 'compiled-broad-raster-surface',
      });

      warmPolicyForManifest(overlay, lightMrna, themePolicy);
      warmPolicyForManifest(overlay, lightLnc, themePolicy);
      expect(overlay.commitAnnotationPresentationPolicy(themePolicy)).toEqual({
        status: 'committed',
        policyGeneration: 1,
      });
      expect(internals.compiledBroadSurfaceOwnerForTrack('mRNA')?.manifest).toBe(lightMrna);
      expect(internals.compiledBroadSurfaceOwnerForTrack('lnc_RNA')?.manifest).toBe(lightLnc);
      expect(internals.compiledBroadSurfaceCandidateOwnerForTrack('mRNA')).toBeNull();

      expect(
        overlay.loadCompiledBroadSurfaceManifest(
          darkLnc,
          provenance(darkLnc, {
            themeMode: 'dark',
            prepackedOwnerKey: 'compiled-broad-lnc-rna-dark-roster-owner',
            prepackedArtifactKey: prepackedAnnotationSceneArtifactKey({
              themeMode: 'dark',
              trackType: 'lnc_RNA',
            }),
          })
        )
      ).toBe(false);
      expect(updateCamera(overlay, 500_000_000, undefined, 'dark')).toBe(true);

      expect(internals.compiledBroadSurfaceOwnerForTrack('mRNA')?.manifest).toBe(lightMrna);
      expect(internals.compiledBroadSurfaceOwnerForTrack('lnc_RNA')?.manifest).toBe(lightLnc);
      expect(internals.compiledBroadSurfaceCandidateOwnerForTrack('mRNA')).toBeNull();
      expect(internals.compiledBroadSurfaceCandidateOwnerForTrack('lnc_RNA')).toBeNull();
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        soleOwnerCount: 1,
        soleOwnerId: 'compiled-broad-raster-surface',
        compiledBroadRasterVisible: true,
      });
    } finally {
      overlay.destroy();
    }
  });

  it('requires an explicit source-placement authority before raster admission when V4 is unresolved', async () => {
    const overlay = new AnnotationOverlay();
    overlay.setRenderer(renderer());
    overlay.loadGenome(genomeWithoutAnnotationSourcePlacement());
    overlay.setLayout(layout());
    const artifact = await manifest();
    const exactAuthority = {
      genomeIdentity: 'hg002-grch38-source',
      genomeLengthBp: GENOME_LENGTH_BP,
      sourceFingerprint: SOURCE_FINGERPRINT,
      placementFingerprint: PLACEMENT_FINGERPRINT,
    } as const;

    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(false);
    expect(
      overlay.admitCompiledBroadSurfaceSourcePlacementAuthority({
        ...exactAuthority,
        genomeIdentity: 'different-genome',
      })
    ).toBe(false);
    expect(
      overlay.admitCompiledBroadSurfaceSourcePlacementAuthority({
        ...exactAuthority,
        genomeLengthBp: GENOME_LENGTH_BP - 1,
      })
    ).toBe(false);
    expect(
      overlay.admitCompiledBroadSurfaceSourcePlacementAuthority({
        ...exactAuthority,
        sourceFingerprint: 'not-a-fingerprint',
      })
    ).toBe(false);
    expect(
      overlay.admitCompiledBroadSurfaceSourcePlacementAuthority({
        ...exactAuthority,
        placementFingerprint: 'not-a-placement-fingerprint',
      })
    ).toBe(false);

    expect(overlay.admitCompiledBroadSurfaceSourcePlacementAuthority(exactAuthority)).toBe(true);
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      compiledBroadRasterLoaded: true,
      compiledBroadRasterProvenanceValid: true,
      prepackedLoaded: false,
    });

    overlay.loadGenome(genomeWithoutAnnotationSourcePlacement());
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      compiledBroadRasterLoaded: true,
      compiledBroadRasterProvenanceValid: true,
    });

    overlay.loadGenome({
      ...genome(),
      annotationSourcePlacementProvenance: {
        contract: 'validated-annotation-source-placement.v1',
        sourceFingerprint: 'fedcba9876543210fedcba98',
        placementFingerprint: 'ap1:fedcba9876543210fedcba98',
      },
    });
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      compiledBroadRasterLoaded: false,
      compiledBroadRasterProvenanceValid: false,
    });
    overlay.destroy();
  });

  it('admits compact interaction before source authority and joins it only to the exact raster owner', async () => {
    const overlay = new AnnotationOverlay();
    overlay.setRenderer(renderer());
    overlay.loadGenome(genomeWithoutAnnotationSourcePlacement());
    overlay.setLayout(layout());
    const compact = compactPolicyInteractionInput();
    const artifact = await manifest();
    const exactProvenance = provenance(artifact);

    expect(overlay.loadCompiledBroadAnnotationInteraction(compact)).not.toBeNull();
    expect(overlay.getCompiledBroadAnnotationInteractionAuthoritySnapshot()).toEqual({
      contract: 'compiled-broad-annotation-interaction-authority-snapshot.v1',
      residentGeneration: 1,
      preparedOwnerKeys: [compact.ownerKey],
    });
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, exactProvenance)).toBe(false);

    expect(
      overlay.admitCompiledBroadSurfaceSourcePlacementAuthority({
        genomeIdentity: compact.metadata.genomeIdentity,
        genomeLengthBp: compact.metadata.genomeLengthBp,
        sourceFingerprint: SOURCE_FINGERPRINT,
        placementFingerprint: PLACEMENT_FINGERPRINT,
      })
    ).toBe(true);
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, exactProvenance)).toBe(true);
    const path = pathForSpan(500_000_000);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    warmPolicy(overlay, artifact, { isoformMode: 'canonical', laneLimit: 12 });
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );

    const internals = overlayPresenterInternals(overlay) as unknown as {
      compiledBroadAnnotationInteractionResidentForTrack(
        trackId: string
      ): { sourceFingerprint: string } | null;
    };
    expect(internals.compiledBroadAnnotationInteractionResidentForTrack('mRNA')).toMatchObject({
      sourceFingerprint: SOURCE_FINGERPRINT,
    });

    const wrongSourceCompact = {
      ...compact,
      ownerKey: 'wrong-source-owner',
      sourceFingerprint: 'fedcba9876543210fedcba98',
    };
    expect(overlay.loadCompiledBroadAnnotationInteraction(wrongSourceCompact)).not.toBeNull();
    expect(internals.compiledBroadAnnotationInteractionResidentForTrack('mRNA')).toMatchObject({
      sourceFingerprint: SOURCE_FINGERPRINT,
    });

    overlay.loadGenome({
      ...genomeWithoutAnnotationSourcePlacement(),
      name: 'different-genome',
      sourceIdentity: 'different-genome-source',
    });
    expect(overlay.getCompiledBroadAnnotationInteractionAuthoritySnapshot()).toEqual({
      contract: 'compiled-broad-annotation-interaction-authority-snapshot.v1',
      residentGeneration: 3,
      preparedOwnerKeys: [],
    });
    overlay.destroy();
  });

  it('rejects raster-catalog authority that conflicts with explicit genome provenance', () => {
    const overlay = new AnnotationOverlay();
    prepareRasterOnly(overlay);
    expect(
      overlay.admitCompiledBroadSurfaceSourcePlacementAuthority({
        genomeIdentity: 'hg002-grch38-source',
        genomeLengthBp: GENOME_LENGTH_BP,
        sourceFingerprint: 'fedcba9876543210fedcba98',
        placementFingerprint: PLACEMENT_FINGERPRINT,
      })
    ).toBe(false);
    expect(
      overlay.admitCompiledBroadSurfaceSourcePlacementAuthority({
        genomeIdentity: 'hg002-grch38-source',
        genomeLengthBp: GENOME_LENGTH_BP,
        sourceFingerprint: SOURCE_FINGERPRINT,
        placementFingerprint: 'ap1:fedcba9876543210fedcba98',
      })
    ).toBe(false);
    overlay.destroy();
  });

  it('admits visual provenance without a prepacked owner while rejecting wrong source or placement', async () => {
    const overlay = new AnnotationOverlay();
    prepareRasterOnly(overlay);
    const artifact = await manifest();

    expect(
      overlay.loadCompiledBroadSurfaceManifest(
        artifact,
        provenance(artifact, { sourceFingerprint: 'fedcba9876543210fedcba98' })
      )
    ).toBe(false);
    expect(
      overlay.loadCompiledBroadSurfaceManifest(
        artifact,
        provenance(artifact, { placementFingerprint: 'ap1:fedcba9876543210fedcba98' })
      )
    ).toBe(false);
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      compiledBroadRasterLoaded: false,
      compiledBroadRasterProvenanceValid: false,
    });

    expect(
      (
        overlayPresenterInternals(overlay) as unknown as {
          compiledBroadSurfaceProvenanceFailure: (
            manifest: CompiledBroadSurfaceManifestV2,
            receipt: CompiledBroadSurfaceAdmissionProvenanceV1
          ) => string | null;
        }
      ).compiledBroadSurfaceProvenanceFailure(artifact, provenance(artifact))
    ).toBeNull();
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      compiledBroadRasterLoaded: true,
      compiledBroadRasterProvenanceValid: true,
      compiledBroadRasterProvenanceSourceFingerprint: SOURCE_FINGERPRINT,
      compiledBroadRasterProvenancePlacementFingerprint: PLACEMENT_FINGERPRINT,
      compiledBroadRasterProvenancePrepackedOwnerKey: policySceneInput().ownerKey,
    });
    overlay.destroy();
  });

  it('never calls allocating diagnostics from demand, admission, camera, cold-snapshot, or hit paths', async () => {
    const diagnostics = vi.spyOn(CompiledBroadSurfacePixiPresenterV2.prototype, 'diagnostics');
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const artifact = await manifest();
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    const path = pathForSpan(500_000_000);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    const demand = overlay.getCompiledBroadSurfaceDemand({
      isoformMode: 'canonical',
      laneLimit: 12,
    });
    for (const address of demand.missingRequiredCellAddresses) {
      expect(
        overlay.admitCompiledBroadSurfaceTransparentCell({
          ...address,
          demandLeaseId: demand.demandLeaseId!,
          manifestFingerprint: artifact.manifestFingerprint,
        }).status
      ).toBe('admitted');
    }
    expect(
      overlay.reconcileCompiledBroadSurfaceResidentLeases([demand.demandLeaseId!]).status
    ).toBe('reconciled');
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    overlay.getColdGestureSnapshot();
    overlay.hitTest(800, 160, path, state());
    expect(diagnostics).not.toHaveBeenCalled();
    overlay.destroy();
  });

  it('uses the presented topology as the sole post-frame demand-refresh oracle', async () => {
    const { overlay, artifact, path } = await preparePolicyTransactionFixture();
    const policy = { isoformMode: 'canonical' as const, laneLimit: 12 };

    expect(
      overlay.isCompiledBroadSurfaceDemandRefreshRequired(policy, artifact.manifestFingerprint)
    ).toBe(false);
    const movedPath = pathForSpan(500_000_000, path.viewStartBp + 1_000);
    expect(
      overlay.updateRetainedCamera({ path: movedPath, state: state(), yOffset: 0, height: 500 })
    ).toBe(true);
    expect(
      overlay.isCompiledBroadSurfaceDemandRefreshRequired(policy, artifact.manifestFingerprint)
    ).toBe(false);

    expect(updateCamera(overlay, 500_000_000, 900_000_000)).toBe(true);
    expect(
      overlay.isCompiledBroadSurfaceDemandRefreshRequired(policy, artifact.manifestFingerprint)
    ).toBe(true);
    expect(
      overlay.isCompiledBroadSurfaceDemandRefreshRequired(
        { ...policy, isoformMode: 'expanded' },
        artifact.manifestFingerprint
      )
    ).toBe(true);
    overlay.destroy();
  });

  it('does not rebuild a fully resident detail-return bridge on every detail camera frame', async () => {
    const overlay = new AnnotationOverlay();
    prepareRasterOnly(overlay);
    const { compact, first: detailScene, second: replacementScene } = await trustedCorridorInputs();
    expect(overlay.loadCompiledBroadAnnotationInteraction(compact)).not.toBeNull();
    const artifact = await manifest();
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    expect(overlay.preparePrepackedAnnotationScene(detailScene)).toBe(true);
    admitViewportDetailRosterAtFineLocus(overlay);
    const policy = { isoformMode: 'canonical' as const, laneLimit: 12 };
    const detailStartBp = 1_490_000_000;
    expect(updateCamera(overlay, 20_000_000, detailStartBp)).toBe(true);
    const first = overlay.getCompiledBroadSurfaceDemand(policy);
    expect(first.status).toBe('detail-required');
    for (const address of [
      ...first.missingSuccessorCellAddresses,
      ...first.missingInteractionPrefetchCellAddresses,
    ]) {
      expect(
        overlay.admitCompiledBroadSurfaceTransparentCell({
          ...address,
          demandLeaseId: first.demandLeaseId!,
          manifestFingerprint: artifact.manifestFingerprint,
        }).status
      ).toBe('admitted');
    }
    expect(overlay.getCompiledBroadSurfaceDemand(policy)).toMatchObject({
      status: 'detail-required',
      missingCellAddresses: [],
    });

    expect(updateCamera(overlay, 20_000_000, detailStartBp + 1_000)).toBe(true);
    expect(
      overlay.isCompiledBroadSurfaceDemandRefreshRequired(policy, artifact.manifestFingerprint)
    ).toBe(false);

    const internal = overlayPresenterInternals(overlay) as unknown as {
      compiledBroadSurfaceCameraEpoch: number;
      compiledBroadSurfaceLastCameraRequest: {
        viewportStartBp: number;
        viewportEndBp: number;
        viewportCssWidthPx: number;
        devicePixelRatio: number;
      };
    };
    internal.compiledBroadSurfaceCameraEpoch += 1;
    internal.compiledBroadSurfaceLastCameraRequest = {
      viewportStartBp: 0,
      viewportEndBp: GENOME_LENGTH_BP,
      viewportCssWidthPx: 1_920,
      devicePixelRatio: 2,
    };
    expect(
      overlay.isCompiledBroadSurfaceDemandRefreshRequired(policy, artifact.manifestFingerprint)
    ).toBe(true);

    expect(updateCamera(overlay, 20_000_000, detailStartBp + 1_000, 'dark')).toBe(true);
    expect(
      overlay.isCompiledBroadSurfaceDemandRefreshRequired(policy, artifact.manifestFingerprint)
    ).toBe(false);
    expect(overlay.preparePrepackedAnnotationScene(replacementScene)).toBe(true);
    expect(
      overlay.isCompiledBroadSurfaceDemandRefreshRequired(policy, artifact.manifestFingerprint)
    ).toBe(true);
    overlay.destroy();
  });

  it('does not synchronously construct coarse fallback meshes while staging a trusted viewport-detail packet', async () => {
    const overlay = new AnnotationOverlay();
    prepareRasterOnly(overlay);
    const { compact, first: detailScene } = await trustedCorridorInputs();
    expect(overlay.loadCompiledBroadAnnotationInteraction(compact)).not.toBeNull();
    expect(overlay.preparePrepackedAnnotationScene(detailScene)).toBe(true);

    const residents = (
      overlayPresenterInternals(overlay) as unknown as {
        prepackedAnnotationSceneResidents: Map<
          string,
          { layer: PartitionedInstancedTranscriptLayerType }
        >;
      }
    ).prepackedAnnotationSceneResidents;
    const layer = residents.get(detailScene.ownerKey)?.layer;
    expect(layer).toBeDefined();
    expect(layer!.getAdmissionValidationDebug().trustedDetailPacketAdmission).toBe(true);
    expect(layer!.getDebugViews().filter(({ viewKind }) => viewKind === 'coarse')).toEqual([]);

    const viewportStartBp = 1_520_000_000;
    const viewportEndBp = viewportStartBp + 512 * 1024;
    expect(
      overlay.preparePrepackedAnnotationFineViews(viewportStartBp, viewportEndBp, 'light')
    ).toMatchObject({ status: 'prepared', pendingOwnerCount: 1 });
    expect(
      overlay.preparePrepackedAnnotationFineViews(viewportStartBp, viewportEndBp, 'light')
    ).toMatchObject({ status: 'prepared', pendingOwnerCount: 1 });
    const coarseCountBefore = layer!
      .getDebugViews()
      .filter(({ viewKind }) => viewKind === 'coarse').length;
    expect(
      overlay.preparePrepackedAnnotationFineViews(viewportStartBp, viewportEndBp, 'light')
    ).toMatchObject({ status: 'prepared', pendingOwnerCount: 1 });
    expect(layer!.getDebugViews().filter(({ viewKind }) => viewKind === 'coarse')).toHaveLength(
      coarseCountBefore + 1
    );

    for (let attempt = 0; attempt < 64 && !layer!.isCoarseFallbackPrepared; attempt += 1) {
      overlay.preparePrepackedAnnotationFineViews(viewportStartBp, viewportEndBp, 'light');
    }
    const deferredCoarseViews = layer!
      .getDebugViews()
      .filter(({ viewKind }) => viewKind === 'coarse');
    expect(deferredCoarseViews.length).toBeGreaterThan(0);
    expect(
      deferredCoarseViews.every(({ instanceBaseByteOffset }) => instanceBaseByteOffset === 0)
    ).toBe(true);
    expect(
      deferredCoarseViews.every(
        ({ instanceCount, ownedInstanceBufferByteLength }) =>
          ownedInstanceBufferByteLength ===
          instanceCount * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes
      )
    ).toBe(true);

    overlay.destroy();
  });

  it('uploads DPR artifacts with physical BufferImageSource geometry and resolution one', async () => {
    const overlay = new AnnotationOverlay();
    const initSource = vi.fn();
    overlay.setRenderer({
      type: 1,
      resolution: 2,
      texture: { initSource },
      shader: { bind: vi.fn(), resetState: vi.fn() },
      geometry: { bind: vi.fn(), resetState: vi.fn() },
    } as unknown as Renderer);
    overlay.loadGenome(genome());
    overlay.setLayout(layout());
    expect(overlay.loadPrepackedAnnotationScene(policySceneInput())).toBe(true);
    const artifact = await buildCompiledBroadSurfaceManifestV2({
      artifactKey: 'bounded-annotation-artifact.v2:mrna:dpr2',
      trackId: 'mrna',
      genomeLengthBp: GENOME_LENGTH_BP,
      broadCorridorFinestSpanBp: BROAD_CORRIDOR_FINEST_SPAN_BP,
      broadTilePhysicalWidthPx: 512,
      broadTileXGuardPhysicalPx: 1,
      prefetchRing: 1,
      maxQualifiedRasterMagnificationX: 1.75,
      rasterDevicePixelRatio: 2,
      laneSlabRowCount: 8,
      laneRowCssHeightPx: 16,
      laneRowTextureStridePx: 32,
      laneRowTransparentTailGutterPx: 4,
      laneRowCounts: { canonical: 12, expanded: 70 },
    });
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    expect(updateCamera(overlay, 500_000_000)).toBe(true);
    const demand = overlay.getCompiledBroadSurfaceDemand({
      isoformMode: 'canonical',
      laneLimit: 12,
    });
    const address = demand.requiredCellAddresses[0];
    const widthPx = 514;
    const heightPx = 256;
    const bytes = new Uint8Array(widthPx * heightPx * 4);
    expect(
      overlay.admitCompiledBroadSurfaceRgbaCell({
        ...address,
        demandLeaseId: demand.demandLeaseId!,
        manifestFingerprint: artifact.manifestFingerprint,
        widthPx,
        heightPx,
        premultipliedRgba: bytes,
      })
    ).toMatchObject({
      status: 'admitted',
      gpuPreuploaded: true,
      explicitCopyByteLength: 0,
      uploadedByteLength: bytes.byteLength,
    });
    expect(initSource).toHaveBeenCalledTimes(1);
    expect(initSource.mock.calls[0][0]).toMatchObject({
      width: widthPx,
      height: heightPx,
      pixelWidth: widthPx,
      pixelHeight: heightPx,
      resolution: 1,
    });
    expect(initSource.mock.calls[0][0].resource).toBe(bytes);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      compiledBroadSurfaceExplicitRgbaCopyBytes: 0,
      compiledBroadSurfaceGpuPreuploadedBytes: bytes.byteLength,
      compiledBroadSurfacePostPresentGpuUploads: 0,
      compiledBroadSurfacePostPresentGpuUploadBytes: 0,
    });
    expect(overlay.getCompiledBroadSurfaceDiagnostics()).toMatchObject({
      provenanceValid: true,
      provenanceSourceFingerprint: SOURCE_FINGERPRINT,
      provenancePlacementFingerprint: PLACEMENT_FINGERPRINT,
      rgbaAdmissionCount: 1,
      gpuPreuploadCount: 1,
      explicitRgbaCopyBytes: 0,
      gpuPreuploadedBytes: bytes.byteLength,
      postPresentGpuUploadCount: 0,
      postPresentGpuUploadBytes: 0,
    });
    overlay.destroy();
  });

  it('uses submitted texture residency as the single readiness authority', async () => {
    const overlay = new AnnotationOverlay();
    const initSource = vi.fn();
    overlay.setRenderer({
      type: 1,
      resolution: 1,
      texture: { initSource },
      shader: { bind: vi.fn(), resetState: vi.fn() },
      geometry: { bind: vi.fn(), resetState: vi.fn() },
    } as unknown as Renderer);
    overlay.loadGenome(genome());
    overlay.setLayout(layout());
    expect(overlay.loadPrepackedAnnotationScene(policySceneInput())).toBe(true);
    const artifact = await manifest();
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    expect(updateCamera(overlay, 500_000_000)).toBe(true);
    const demand = overlay.getCompiledBroadSurfaceDemand({
      isoformMode: 'canonical',
      laneLimit: 12,
    });
    const address = demand.requiredCellAddresses[0]!;
    expect(
      overlay.admitCompiledBroadSurfaceRgbaCell({
        ...address,
        demandLeaseId: demand.demandLeaseId!,
        manifestFingerprint: artifact.manifestFingerprint,
        widthPx: artifact.broadTilePhysicalWidthPx + artifact.broadTileXGuardPhysicalPx * 2,
        heightPx: artifact.laneSlabRowCount * artifact.laneRowTextureStridePx,
        premultipliedRgba: new Uint8Array(
          (artifact.broadTilePhysicalWidthPx + artifact.broadTileXGuardPhysicalPx * 2) *
            artifact.laneSlabRowCount *
            artifact.laneRowTextureStridePx *
            4
        ),
      })
    ).toMatchObject({ status: 'admitted' });
    expect(
      overlay
        .getCompiledBroadSurfaceDemand(
          { isoformMode: 'canonical', laneLimit: 12 },
          artifact.manifestFingerprint
        )
        .missingRequiredCellAddresses.map(({ cellId }) => cellId)
    ).not.toContain(address.cellId);
    expect(initSource).toHaveBeenCalledTimes(1);
    overlay.destroy();
  });

  it('warms an alternate policy without consulting or changing the committed policy', async () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const artifact = await manifest();
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    expect(updateCamera(overlay, 500_000_000)).toBe(true);

    const current = overlay.getCompiledBroadSurfaceDemand({
      isoformMode: 'canonical',
      laneLimit: 12,
    });
    expect(current).toMatchObject({ status: 'broad-ready', cameraEpoch: 1 });
    expect(current.demandLeaseId).not.toBeNull();
    for (const address of current.missingRequiredCellAddresses) {
      expect(
        overlay.admitCompiledBroadSurfaceTransparentCell({
          ...address,
          manifestFingerprint: artifact.manifestFingerprint,
          demandLeaseId: current.demandLeaseId!,
        })
      ).toMatchObject({ status: 'admitted' });
    }
    expect(updateCamera(overlay, 500_000_000)).toBe(true);
    expect(overlay.getCompiledBroadSurfaceDiagnostics()).toMatchObject({
      presenting: true,
      activeIsoformMode: 'canonical',
      activeLaneLimit: 12,
      broadVectorSubmissionCount: 0,
    });

    const standby = overlay.getCompiledBroadSurfaceDemand({
      isoformMode: 'expanded',
      laneLimit: 64,
    });
    expect(standby).toMatchObject({ status: 'broad-ready', cameraEpoch: current.cameraEpoch });
    expect(standby.demandLeaseId).not.toBe(current.demandLeaseId);
    for (const address of standby.missingCellAddresses) {
      expect(
        overlay.admitCompiledBroadSurfaceTransparentCell({
          ...address,
          manifestFingerprint: artifact.manifestFingerprint,
          demandLeaseId: standby.demandLeaseId!,
        })
      ).toMatchObject({ status: 'admitted' });
    }
    const standbyIds = new Set(standby.requiredCellAddresses.map(({ cellId }) => cellId));
    expect(overlay.getCompiledBroadSurfaceDiagnostics()).toMatchObject({
      presenting: true,
      activeIsoformMode: 'canonical',
      activeLaneLimit: 12,
    });

    const currentRefresh = overlay.getCompiledBroadSurfaceDemand({
      isoformMode: 'canonical',
      laneLimit: 12,
    });
    const afterRefresh = new Set(
      overlay.getCompiledBroadSurfaceDiagnostics()?.residentCellIds ?? []
    );
    expect([...standbyIds].every((cellId) => afterRefresh.has(cellId))).toBe(true);

    const reconciled = overlay.reconcileCompiledBroadSurfaceResidentLeases([
      currentRefresh.demandLeaseId!,
      standby.demandLeaseId!,
    ]);
    expect(reconciled).toMatchObject({
      status: 'reconciled',
      cameraEpoch: current.cameraEpoch,
      evictedCellIds: [],
    });
    const afterUnion = new Set(overlay.getCompiledBroadSurfaceDiagnostics()?.residentCellIds ?? []);
    expect([...standbyIds].every((cellId) => afterUnion.has(cellId))).toBe(true);

    overlay.destroy();
  });

  it('rejects stale-pan and outside-roster admissions without evicting live pixels', async () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const artifact = await manifest();
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    expect(updateCamera(overlay, 500_000_000, 100_000_000)).toBe(true);
    const lease = overlay.getCompiledBroadSurfaceDemand({
      isoformMode: 'expanded',
      laneLimit: 64,
    });
    expect(lease.status).toBe('broad-ready');

    const outsideAddress = {
      isoformMode: 'canonical' as const,
      level: 0,
      tileX: artifact.levels[0].tileCount - 1,
      laneSlabIndex: 0,
    };
    const outsideCellId = compiledBroadSurfaceCellIdV2({
      manifest: artifact,
      ...outsideAddress,
    });
    expect(
      overlay.admitCompiledBroadSurfaceTransparentCell({
        ...outsideAddress,
        cellId: outsideCellId,
        manifestFingerprint: artifact.manifestFingerprint,
        demandLeaseId: lease.demandLeaseId!,
      })
    ).toMatchObject({
      status: 'rejected',
      reason: 'compiled-broad-surface-cell-outside-demand-lease',
    });

    const leasedAddress = lease.requiredCellAddresses[0];
    expect(leasedAddress).toBeDefined();
    expect(updateCamera(overlay, 500_000_000, 1_000_000_000)).toBe(true);
    expect(
      overlay.admitCompiledBroadSurfaceTransparentCell({
        ...leasedAddress,
        manifestFingerprint: artifact.manifestFingerprint,
        demandLeaseId: lease.demandLeaseId!,
      })
    ).toMatchObject({
      status: 'rejected',
      reason: 'compiled-broad-surface-demand-lease-stale-or-unknown',
    });
    expect(
      overlay.reconcileCompiledBroadSurfaceResidentLeases([lease.demandLeaseId!])
    ).toMatchObject({
      status: 'rejected',
      reason: 'compiled-broad-surface-demand-lease-stale-or-unknown',
      evictedCellIds: [],
    });
    overlay.destroy();
  });

  it('fails closed across the full broad corridor when an indexed artifact is absent', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    expect(
      overlay.requireCompiledBroadSurface({
        genomeLengthBp: GENOME_LENGTH_BP,
        broadCorridorFinestSpanBp: BROAD_CORRIDOR_FINEST_SPAN_BP,
      })
    ).toBe(true);
    for (const spanBp of [
      GENOME_LENGTH_BP,
      2_200_000_000,
      1_300_000_000,
      500_000_000,
      150_000_000,
    ]) {
      expect(updateCamera(overlay, spanBp)).toBe(true);
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        compiledBroadRasterLoaded: false,
        compiledBroadRasterVisible: false,
        compiledBroadRasterPlanStatus: 'broad-cells-missing',
        compiledBroadRasterVectorSubmissionCount: 0,
        compiledVectorVisible: false,
        retainedTranscriptVisible: false,
        immediateLiveVisible: false,
      });
    }
    updateCamera(overlay, 20_000_000);
    expect(overlay.getColdGestureSnapshot().compiledBroadRasterPlanStatus).toBe('detail-required');
    overlay.destroy();
  });

  it('lets an admitted portable manifest replace only a provisional same-genome corridor', async () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const promotedArtifact = await manifest(
      'portable-saccer3-compatible-artifact',
      'mRNA',
      { canonical: 6, expanded: 6 },
      1,
      GENOME_LENGTH_BP,
      16_000_000
    );

    expect(
      overlay.requireCompiledBroadSurface({
        genomeLengthBp: GENOME_LENGTH_BP,
        broadCorridorFinestSpanBp: 3_000_000,
      })
    ).toBe(true);
    expect(
      overlay.loadCompiledBroadSurfaceManifest(promotedArtifact, provenance(promotedArtifact))
    ).toBe(true);

    expect(
      overlay.requireCompiledBroadSurface({
        genomeLengthBp: GENOME_LENGTH_BP,
        broadCorridorFinestSpanBp: 8_000_000,
      })
    ).toBe(true);
    const conflictingArtifact = await manifest(
      'portable-conflicting-artifact',
      'CDS',
      { canonical: 6, expanded: 6 },
      1,
      GENOME_LENGTH_BP,
      8_000_000
    );
    expect(
      overlay.loadCompiledBroadSurfaceManifest(conflictingArtifact, provenance(conflictingArtifact))
    ).toBe(false);
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      compiledBroadRasterLoaded: true,
      compiledBroadRasterProvenanceValid: true,
    });
    overlay.destroy();
  });

  it('uses the exact last-good vector instead of stretching broad when a newly selected track is missing', async () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const mrnaArtifact = await manifest();
    expect(overlay.loadCompiledBroadSurfaceManifest(mrnaArtifact, provenance(mrnaArtifact))).toBe(
      true
    );
    const spanBp = 150_000_000;
    expect(updateCamera(overlay, spanBp)).toBe(true);
    const mrnaDemand = overlay.getCompiledBroadSurfaceDemand({
      isoformMode: 'canonical',
      laneLimit: 12,
    });
    expect(mrnaDemand.status).toBe('broad-ready');
    for (const address of mrnaDemand.missingRequiredCellAddresses) {
      expect(
        overlay.admitCompiledBroadSurfaceTransparentCell({
          ...address,
          demandLeaseId: mrnaDemand.demandLeaseId!,
          manifestFingerprint: mrnaArtifact.manifestFingerprint,
        }).status
      ).toBe('admitted');
    }
    expect(updateCamera(overlay, spanBp)).toBe(true);
    const completeMrna = overlay.getCompiledBroadSurfaceDiagnostics()!;
    expect(completeMrna).toMatchObject({ presenting: true, holdingLastGood: false });

    overlay.loadGenome(genome(['mRNA', 'lnc_RNA']));
    const lncArtifact = await manifest('bounded-annotation-artifact.v2:lnc-rna', 'lnc_RNA');
    expect(
      overlay.loadCompiledBroadSurfaceManifest(
        lncArtifact,
        provenance(lncArtifact, {
          prepackedOwnerKey: 'compiled-broad-lnc-rna-owner',
          prepackedArtifactKey: prepackedAnnotationSceneArtifactKey({
            themeMode: 'light',
            trackType: 'lnc_RNA',
          }),
        })
      )
    ).toBe(true);

    const internals = overlayPresenterInternals(overlay) as unknown as {
      compiledBroadSurfacePresenter: CompiledBroadSurfacePixiPresenterType;
      compiledBroadSurfaceTrackOwners: Map<
        string,
        { presenter: CompiledBroadSurfacePixiPresenterType }
      >;
      finalizeCompiledBroadSurfaceFrame: (camera: unknown) => true;
    };
    const finalize = vi.spyOn(internals, 'finalizeCompiledBroadSurfaceFrame');
    const clearImmediate = vi.spyOn(
      overlay.getPrepackedControllerForTest(),
      'clearImmediateStateForCompiledAnnotationOwner'
    );

    expect(updateCamera(overlay, spanBp)).toBe(true);
    expect(finalize).not.toHaveBeenCalled();
    expect(clearImmediate).toHaveBeenCalledTimes(1);
    expect(internals.compiledBroadSurfacePresenter.isPresenting).toBe(false);
    expect(internals.compiledBroadSurfaceTrackOwners.get('lnc_RNA')?.presenter.isPresenting).toBe(
      false
    );
    expect(overlay.getCompiledBroadSurfaceDiagnostics()).toMatchObject({
      presenting: false,
      activeResidentCellIds: completeMrna.activeResidentCellIds,
      atomicCommitCount: completeMrna.atomicCommitCount,
    });
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStatus: 'holding-last-good',
      prepackedAnnotationSceneVisibleResidentOwnerKeys: ['compiled-broad-policy-owner'],
    });
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      soleOwnerCount: 1,
      soleOwnerId: 'prepacked-partitioned-vector-surface',
      soleOwnerCoverageComplete: true,
    });
    overlay.destroy();
  });

  it('preflights every staged track before committing a new multi-track raster generation', async () => {
    const overlay = new AnnotationOverlay();
    try {
      overlay.setRenderer(renderer());
      overlay.loadGenome({ ...genome(['mRNA', 'lnc_RNA']), features: [] });
      overlay.setLayout(layout());
      expect(overlay.loadPrepackedAnnotationScene(policySceneInput())).toBe(true);
      expect(overlay.loadPrepackedAnnotationScene(lncPolicySceneInput())).toBe(true);

      const mrnaArtifact = await manifest();
      const lncArtifact = await manifest(
        'bounded-annotation-artifact.v2:lnc-rna:transaction',
        'lnc_RNA'
      );
      expect(overlay.loadCompiledBroadSurfaceManifest(mrnaArtifact, provenance(mrnaArtifact))).toBe(
        true
      );
      expect(
        overlay.loadCompiledBroadSurfaceManifest(
          lncArtifact,
          provenance(lncArtifact, {
            prepackedOwnerKey: lncPolicySceneInput().ownerKey,
            prepackedArtifactKey: lncPolicySceneInput().metadata.artifactKey,
          })
        )
      ).toBe(true);

      const spanBp = 150_000_000;
      expect(updateCamera(overlay, spanBp)).toBe(true);
      warmPolicyForManifest(overlay, mrnaArtifact, {
        isoformMode: 'canonical',
        laneLimit: 12,
      });
      warmPolicyForManifest(overlay, lncArtifact, {
        isoformMode: 'canonical',
        laneLimit: 12,
      });
      expect(updateCamera(overlay, spanBp)).toBe(true);

      const internals = overlayPresenterInternals(overlay) as unknown as {
        compiledBroadSurfacePresenter: CompiledBroadSurfacePixiPresenterType;
        compiledBroadSurfaceTrackOwners: Map<
          string,
          { presenter: CompiledBroadSurfacePixiPresenterType }
        >;
      };
      const presenters = [
        internals.compiledBroadSurfacePresenter,
        internals.compiledBroadSurfaceTrackOwners.get('lnc_RNA')!.presenter,
      ];
      const before = presenters.map((presenter) => presenter.diagnostics());
      expect(presenters.every((presenter) => presenter.isPresenting)).toBe(true);

      const nextStartBp = 200_000_000;
      expect(updateCamera(overlay, spanBp, nextStartBp)).toBe(true);
      warmPolicyForManifest(overlay, mrnaArtifact, {
        isoformMode: 'canonical',
        laneLimit: 12,
      });
      warmPolicyForManifest(overlay, lncArtifact, {
        isoformMode: 'canonical',
        laneLimit: 12,
      });

      let preflightCount = 0;
      const preflight = vi
        .spyOn(CompiledBroadSurfacePixiPresenterV2.prototype, 'canCommitStagedPresentation')
        .mockImplementation(() => {
          preflightCount += 1;
          return preflightCount !== 2;
        });
      const commit = vi.spyOn(
        CompiledBroadSurfacePixiPresenterV2.prototype,
        'commitStagedPresentation'
      );

      expect(updateCamera(overlay, spanBp, nextStartBp)).toBe(true);
      expect(preflight).toHaveBeenCalledTimes(2);
      expect(commit).not.toHaveBeenCalled();
      expect(
        presenters.map((presenter) => ({
          presenting: presenter.isPresenting,
          activeResidentCellIds: presenter.diagnostics().activeResidentCellIds,
          atomicCommitCount: presenter.diagnostics().atomicCommitCount,
        }))
      ).toEqual(
        before.map((diagnostics) => ({
          presenting: false,
          activeResidentCellIds: diagnostics.activeResidentCellIds,
          atomicCommitCount: diagnostics.atomicCommitCount,
        }))
      );
    } finally {
      overlay.destroy();
    }
  });

  it('falls through to an ordinary vector body when required broad cells are missing', async () => {
    const overlay = new AnnotationOverlay();
    try {
      prepare(overlay);
      const artifact = await manifest();
      expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
      const path = pathForSpan(500_000_000);

      expect(
        overlay.updateRetainedCamera({
          path,
          state: { ...state(), hoveredId: 1 },
          yOffset: 0,
          height: 500,
        })
      ).toBe(true);

      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        compiledBroadRasterPlanStatus: 'broad-cells-missing',
        compiledBroadRasterVisible: false,
        soleOwnerCount: 1,
        soleOwnerId: 'prepacked-partitioned-vector-surface',
        prepackedSubmittedInstanceCount: 1,
      });
      expect(overlay.getDebugSnapshot()).toMatchObject({
        prepackedAnnotationSceneVisibleInstanceCount: 1,
        lastInteractionOutlineCommandCount: 1,
      });
    } finally {
      overlay.destroy();
    }
  });

  it('uses the complete exact vector owner instead of stretching a previous broad LOD', async () => {
    const overlay = new AnnotationOverlay();
    try {
      prepare(overlay);
      const artifact = await manifest();
      expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
      const initialSpanBp = 150_000_000;
      expect(updateCamera(overlay, initialSpanBp)).toBe(true);
      const initialDemand = overlay.getCompiledBroadSurfaceDemand({
        isoformMode: 'canonical',
        laneLimit: 12,
      });
      expect(initialDemand.status).toBe('broad-ready');
      for (const address of initialDemand.missingRequiredCellAddresses) {
        expect(
          overlay.admitCompiledBroadSurfaceTransparentCell({
            ...address,
            demandLeaseId: initialDemand.demandLeaseId!,
            manifestFingerprint: artifact.manifestFingerprint,
          }).status
        ).toBe('admitted');
      }
      expect(updateCamera(overlay, initialSpanBp)).toBe(true);
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        soleOwnerId: 'compiled-broad-raster-surface',
        soleOwnerCoverageComplete: true,
      });

      expect(updateCamera(overlay, 500_000_000)).toBe(true);
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        compiledBroadRasterPlanStatus: 'broad-cells-missing',
        compiledBroadRasterVisible: false,
        soleOwnerCount: 1,
        soleOwnerId: 'prepacked-partitioned-vector-surface',
        soleOwnerCoverageComplete: true,
        prepackedSubmittedInstanceCount: 1,
      });
    } finally {
      overlay.destroy();
    }
  });

  it('never retains a broad raster when the detail camera leaves its admitted tile coverage', async () => {
    const overlay = new AnnotationOverlay();
    try {
      prepareRasterOnly(overlay);
      const artifact = await manifest();
      expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
      const initialSpanBp = 150_000_000;
      updateCamera(overlay, initialSpanBp);
      const initialDemand = overlay.getCompiledBroadSurfaceDemand({
        isoformMode: 'canonical',
        laneLimit: 12,
      });
      expect(initialDemand.status).toBe('broad-ready');
      for (const address of initialDemand.missingRequiredCellAddresses) {
        expect(
          overlay.admitCompiledBroadSurfaceTransparentCell({
            ...address,
            demandLeaseId: initialDemand.demandLeaseId!,
            manifestFingerprint: artifact.manifestFingerprint,
          }).status
        ).toBe('admitted');
      }
      updateCamera(overlay, initialSpanBp);
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        soleOwnerId: 'compiled-broad-raster-surface',
        compiledBroadRasterVisible: true,
      });

      updateCamera(overlay, 20_000_000, 2_000_000_000);
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        compiledBroadRasterPlanStatus: 'detail-required',
        compiledBroadRasterVisible: false,
      });
      expect(overlay.getColdGestureSnapshot().soleOwnerId).not.toBe(
        'compiled-broad-raster-surface'
      );
    } finally {
      overlay.destroy();
    }
  });

  it('holds the committed broad owner until a dark-mode detail replacement physically presents', async () => {
    const overlay = new AnnotationOverlay();
    try {
      prepareRasterOnly(overlay);
      const { compact, first, second } = await trustedCorridorInputs();
      expect(overlay.loadCompiledBroadAnnotationInteraction(compact)).not.toBeNull();
      expect(overlay.preparePrepackedAnnotationScene(first)).toBe(true);

      const initialDetailStartBp = 1_499_900_000;
      admitViewportDetailRosterAtFineLocus(overlay, initialDetailStartBp);
      expect(updateCamera(overlay, 512 * 1024, initialDetailStartBp)).toBe(true);
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        soleOwnerCount: 1,
        soleOwnerId: 'prepacked-partitioned-vector-surface',
        soleOwnerCoverageComplete: true,
      });

      const artifact = await manifest();
      expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
      const broadSpanBp = 150_000_000;
      const broadStartBp = 1_490_000_000;
      expect(updateCamera(overlay, broadSpanBp, broadStartBp, 'dark')).toBe(true);
      const broadDemand = overlay.getCompiledBroadSurfaceDemand({
        isoformMode: 'canonical',
        laneLimit: 12,
      });
      expect(broadDemand.status).toBe('broad-ready');
      for (const address of broadDemand.missingRequiredCellAddresses) {
        expect(
          overlay.admitCompiledBroadSurfaceTransparentCell({
            ...address,
            demandLeaseId: broadDemand.demandLeaseId!,
            manifestFingerprint: artifact.manifestFingerprint,
          }).status
        ).toBe('admitted');
      }
      expect(updateCamera(overlay, broadSpanBp, broadStartBp, 'dark')).toBe(true);
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        soleOwnerCount: 1,
        soleOwnerId: 'compiled-broad-raster-surface',
        soleOwnerCoverageComplete: true,
      });

      expect(overlay.preparePrepackedAnnotationScene(second)).toBe(true);
      const replacementStartBp = 1_610_000_000;
      const replacementSpanBp = 20_000_000;
      expect(updateCamera(overlay, replacementSpanBp, replacementStartBp, 'dark')).toBe(true);
      expect(overlay.getDebugSnapshot()).toMatchObject({
        prepackedAnnotationSceneStatus: 'fine-view-pending',
      });
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        soleOwnerCount: 1,
        soleOwnerId: 'compiled-broad-raster-surface',
        soleOwnerCoverageComplete: true,
        compiledBroadRasterPlanStatus: 'broad-holding-last-good',
      });

      admitViewportDetailRosterAtFineLocus(overlay, 1_620_000_000);
      expect(updateCamera(overlay, replacementSpanBp, replacementStartBp, 'dark')).toBe(true);
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        soleOwnerCount: 1,
        soleOwnerId: 'prepacked-partitioned-vector-surface',
        soleOwnerCoverageComplete: true,
        compiledBroadRasterVisible: false,
      });
    } finally {
      overlay.destroy();
    }
  });

  it('keeps canonical owner identity while a visible last-good broad topology is incomplete', async () => {
    const overlay = new AnnotationOverlay();
    try {
      prepareRasterOnly(overlay);
      const artifact = await manifest();
      const admittedProvenance = provenance(artifact);
      expect(overlay.loadCompiledBroadSurfaceManifest(artifact, admittedProvenance)).toBe(true);
      const initialSpanBp = 150_000_000;
      updateCamera(overlay, initialSpanBp);
      const initialDemand = overlay.getCompiledBroadSurfaceDemand({
        isoformMode: 'canonical',
        laneLimit: 12,
      });
      expect(initialDemand.status).toBe('broad-ready');
      for (const address of initialDemand.missingRequiredCellAddresses) {
        expect(
          overlay.admitCompiledBroadSurfaceTransparentCell({
            ...address,
            demandLeaseId: initialDemand.demandLeaseId!,
            manifestFingerprint: artifact.manifestFingerprint,
          }).status
        ).toBe('admitted');
      }
      updateCamera(overlay, initialSpanBp);

      updateCamera(overlay, 500_000_000);
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        soleOwnerId: 'compiled-broad-raster-surface',
        soleOwnerCoverageComplete: false,
        soleOwnerContractValid: false,
        activeOwnerKey: admittedProvenance.prepackedOwnerKey,
        activeArtifactKey: admittedProvenance.prepackedArtifactKey,
        activeSourceIdentity: 'hg002-grch38-source',
        activeSourceFingerprint: SOURCE_FINGERPRINT,
        activePlacementFingerprint: PLACEMENT_FINGERPRINT,
        compiledBroadRasterHoldingLastGood: true,
      });
    } finally {
      overlay.destroy();
    }
  });

  it('does not alter an ordinary non-indexed viewer when no requirement is armed', async () => {
    const { SequenceAnnotationOverlay } = await import('./sequence-annotation-overlay');
    expect('requireCompiledBroadSurface' in new SequenceAnnotationOverlay()).toBe(false);
  });

  it('counts legacy and compiled raster owners independently and fails the double-draw oracle', async () => {
    const { overlay } = await preparePolicyTransactionFixture();
    const internals = overlayPresenterInternals(overlay) as unknown as {
      genomeWideTextureCacheLayer: unknown;
      buildPresentationDebugSnapshot: () => {
        annotationPresentationOwners: Array<{ ownerId: string; visible: boolean }>;
        annotationPresentationOwnerViolations: string[];
      };
    };
    const original = internals.genomeWideTextureCacheLayer;
    internals.genomeWideTextureCacheLayer = {
      runtimeTexturePresenting: false,
      prebuiltTexturePresenting: true,
      hasPrebuilt: () => true,
      prebuiltCompositeCount: 1,
    };

    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      legacyPrebuiltRasterVisible: true,
      compiledBroadRasterVisible: true,
      rasterOwnerCount: 2,
      soleOwnerCount: 2,
      soleOwnerId: null,
      soleOwnerContractValid: false,
      prebuiltRasterContractMatch: false,
      prebuiltRasterSourceMatch: false,
      prebuiltRasterPlacementMatch: false,
    });
    expect(overlay.getCompiledBroadSurfaceDiagnostics()).toMatchObject({
      legacyRasterVisible: true,
      compiledRasterVisible: true,
      rasterOwnerCount: 2,
    });
    const presentation = internals.buildPresentationDebugSnapshot();
    expect(
      presentation.annotationPresentationOwners
        .filter((owner) => owner.visible)
        .map((owner) => owner.ownerId)
    ).toEqual(expect.arrayContaining(['compiled-raster-surface', 'compiled-broad-raster-surface']));
    expect(presentation.annotationPresentationOwnerViolations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('duplicate-exact-annotation-owner:raster-surface:'),
      ])
    );

    internals.genomeWideTextureCacheLayer = original;
    overlay.destroy();
  });

  it('runs 1000 same-topology broad camera frames without plan, diagnostic, contract, or resource growth', async () => {
    const { overlay } = await preparePolicyTransactionFixture();
    const before = overlay.getDebugSnapshot();
    const bodyBefore = overlay.getCompiledBroadSurfaceDiagnostics()!;
    const authorityBefore = overlay.getAnnotationBodyPresentationAuthoritySnapshot();
    expect(authorityBefore.generation).not.toBeNull();
    const internals = overlayPresenterInternals(overlay) as unknown as {
      compiledBroadSurfaceLinearContract: unknown;
      compiledBroadSurfaceFastCamera: unknown;
      compiledBroadSurfaceSteadyRoster: unknown;
      compiledBroadSurfaceOwnerRosterForTheme: (...args: unknown[]) => unknown;
    };
    const contractIdentity = internals.compiledBroadSurfaceLinearContract;
    const mailboxIdentity = internals.compiledBroadSurfaceFastCamera;
    const rosterIdentity = internals.compiledBroadSurfaceSteadyRoster;
    expect(rosterIdentity).not.toBeNull();
    const rosterResolution = vi.spyOn(internals, 'compiledBroadSurfaceOwnerRosterForTheme');
    rosterResolution.mockClear();
    const diagnostics = vi.spyOn(CompiledBroadSurfacePixiPresenterV2.prototype, 'diagnostics');
    diagnostics.mockClear();
    const spanBp = 500_000_000;
    const startBp = Math.floor((GENOME_LENGTH_BP - spanBp) / 2);

    for (let index = 0; index < 1_000; index += 1) {
      expect(updateCamera(overlay, spanBp, startBp + index * 100)).toBe(true);
    }

    expect(diagnostics).not.toHaveBeenCalled();
    expect(rosterResolution).not.toHaveBeenCalled();
    expect(internals.compiledBroadSurfaceLinearContract).toBe(contractIdentity);
    expect(internals.compiledBroadSurfaceFastCamera).toBe(mailboxIdentity);
    expect(internals.compiledBroadSurfaceSteadyRoster).toBe(rosterIdentity);
    const after = overlay.getDebugSnapshot();
    const bodyAfter = overlay.getCompiledBroadSurfaceDiagnostics()!;
    const authorityAfter = overlay.getAnnotationBodyPresentationAuthoritySnapshot();
    expect(authorityAfter.commitEpoch).toBe(authorityBefore.commitEpoch);
    expect(authorityAfter.generation).toBe(authorityBefore.generation);
    expect(after.compiledBroadSurfacePlanDerivationCount).toBe(
      before.compiledBroadSurfacePlanDerivationCount
    );
    expect(after.compiledBroadSurfaceCameraContractCreateCount).toBe(1);
    expect(after.compiledBroadSurfaceFastCameraMailboxCreateCount).toBe(1);
    expect(bodyAfter).toMatchObject({
      stagedSceneBuildCount: bodyBefore.stagedSceneBuildCount,
      atomicCommitCount: bodyBefore.atomicCommitCount,
      meshCreationCount: bodyBefore.meshCreationCount,
      shaderCreationCount: bodyBefore.shaderCreationCount,
      geometryCreationCount: bodyBefore.geometryCreationCount,
      textureAdmissionCount: bodyBefore.textureAdmissionCount,
      runtimeCellCompileCount: 0,
      runtimeDurableWriteCount: 0,
      broadVectorSubmissionCount: 0,
    });
    overlay.destroy();
  });
});

describe('AnnotationOverlay compiled broad-surface policy transaction', () => {
  const nextPolicy = { isoformMode: 'expanded' as const, laneLimit: 8 };

  function layerFor(overlay: AnnotationOverlayType): PartitionedInstancedTranscriptLayerType {
    return (
      overlayPresenterInternals(overlay) as unknown as {
        prepackedAnnotationSceneLayer: PartitionedInstancedTranscriptLayerType;
      }
    ).prepackedAnnotationSceneLayer;
  }

  it.each(
    (['all-first', 'genes-first'] as const).flatMap((ordering) =>
      (['canonical', 'expanded'] as const).flatMap((isoformMode) =>
        [500_000_000, 2_000].map((spanBp) => ({ ordering, isoformMode, spanBp }))
      )
    )
  )(
    'waits for joining GRCh37 annotation types: $ordering, $isoformMode, $spanBp bp',
    async ({ ordering, isoformMode, spanBp }) => {
      const overlay = new AnnotationOverlay();
      const allTypes = ['mRNA', '3UTR', '5UTR', 'region'];
      const grch37LengthBp = 3_137_161_264;
      const sourceIdentity = 'hg19-source-fixture';
      const artifacts = new Map<string, CompiledBroadSurfaceManifestV2>();
      const initialPolicy = { isoformMode, laneLimit: 2 };
      const changedPolicy = { isoformMode, laneLimit: 4 };
      const cameraStart = spanBp === 2_000 ? 1_499_999_500 : undefined;
      const preparePolicyData = (
        artifact: CompiledBroadSurfaceManifestV2,
        policy: typeof initialPolicy
      ) => {
        if (spanBp === 2_000) {
          expect(
            overlay.getCompiledBroadSurfaceDemand(policy, artifact.manifestFingerprint).status
          ).toBe('detail-required');
        } else {
          warmPolicyForManifest(overlay, artifact, policy);
        }
      };
      try {
        overlay.setRenderer(renderer());
        const annotationLayout = { maxAnnotationLane: 11, maxCdsLane: -1 };
        const coordinateGenome: Genome = {
          ...genome(ordering === 'all-first' ? allTypes : ['mRNA']),
          name: 'GRCh37 (human)',
          sourceIdentity,
          length: grch37LengthBp,
          annotationLayout,
        };
        overlay.loadGenome(coordinateGenome);
        overlay.setLayout(layout());
        const geneInput = {
          ...policySceneInput(),
          runtimePolicy: initialPolicy,
          metadata: {
            ...policySceneInput().metadata,
            genomeIdentity: sourceIdentity,
            genomeLengthBp: grch37LengthBp,
          },
        };
        const admissionFor = (artifact: CompiledBroadSurfaceManifestV2) =>
          provenance(artifact, {
            genomeIdentity: sourceIdentity,
            genomeLengthBp: grch37LengthBp,
            prepackedOwnerKey:
              artifact.trackId === 'mRNA' ? geneInput.ownerKey : `grch37-owner:${artifact.trackId}`,
            prepackedArtifactKey: prepackedAnnotationSceneArtifactKey({
              themeMode: 'light',
              trackType: artifact.trackId,
            }),
          });
        expect(overlay.preparePrepackedAnnotationScene(geneInput)).toBe(true);
        const mrnaArtifact = await manifest(
          'grch37-journey:mrna',
          'mRNA',
          { canonical: 12, expanded: 70 },
          1,
          grch37LengthBp
        );
        artifacts.set('mRNA', mrnaArtifact);
        expect(
          overlay.loadCompiledBroadSurfaceManifest(mrnaArtifact, admissionFor(mrnaArtifact))
        ).toBe(true);
        updateCamera(overlay, spanBp, cameraStart);
        preparePolicyData(mrnaArtifact, initialPolicy);

        if (ordering === 'genes-first') {
          preparePolicyData(mrnaArtifact, changedPolicy);
          expect(overlay.commitAnnotationPresentationPolicy(changedPolicy).status).toBe(
            'committed'
          );
          const result = overlay.setAnnotationPresentationSnapshot({
            contract: 'annotation-presentation-snapshot.v1',
            generation: 1,
            sourceIdentity,
            genomeLengthBp: coordinateGenome.length,
            policyKey: `${isoformMode}:lanes=4:layers=mRNA,3UTR,5UTR,region`,
            features: coordinateGenome.features ?? [],
            requestedLayerTypes: allTypes,
            layout: annotationLayout,
            exactCoverage: [],
          });
          expect(result.status).toBe('applied');
          updateCamera(overlay, spanBp, cameraStart);
        }

        const displayedPolicy = ordering === 'genes-first' ? changedPolicy : initialPolicy;
        const before = overlay.getPrepackedAnnotationSceneOwnerSnapshot();
        expect(overlay.commitAnnotationPresentationPolicy(displayedPolicy)).toEqual({
          status: 'deferred',
          reason: 'selected-raster-roster-incomplete',
        });
        expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toEqual(before);

        for (const [index, trackType] of allTypes.slice(1).entries()) {
          const artifact = await manifest(
            `grch37-journey:${trackType}`,
            trackType,
            {
              canonical: trackType === 'region' ? 1 : 4,
              expanded: trackType === 'region' ? 1 : 8,
            },
            1,
            grch37LengthBp
          );
          artifacts.set(trackType, artifact);
          expect(overlay.loadCompiledBroadSurfaceManifest(artifact, admissionFor(artifact))).toBe(
            true
          );
          preparePolicyData(artifact, changedPolicy);
          if (index < 2) {
            expect(overlay.commitAnnotationPresentationPolicy(displayedPolicy).status).toBe(
              'deferred'
            );
            expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toEqual(before);
          }
        }
        preparePolicyData(mrnaArtifact, changedPolicy);
        expect(overlay.commitAnnotationPresentationPolicy(changedPolicy).status).toBe('committed');
        expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot().runtimePolicy).toEqual(
          changedPolicy
        );
        for (const trackType of allTypes) {
          const artifact = artifacts.get(trackType);
          if (!artifact) throw new Error(`missing test artifact for ${trackType}`);
          const diagnostics = overlay.getCompiledBroadSurfaceDemand(
            changedPolicy,
            artifact.manifestFingerprint
          );
          expect(diagnostics.status).toBe(spanBp === 2_000 ? 'detail-required' : 'broad-ready');
          expect(diagnostics.missingRequiredCellAddresses).toEqual([]);
        }
        const largerPolicy = { isoformMode, laneLimit: 8 };
        for (const artifact of artifacts.values()) preparePolicyData(artifact, largerPolicy);
        expect(overlay.commitAnnotationPresentationPolicy(largerPolicy).status).toBe('committed');
        expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot().runtimePolicy).toEqual(
          largerPolicy
        );
      } finally {
        overlay.destroy();
      }
    }
  );

  it('commits a shared policy through an lnc_RNA-only compiled raster owner', async () => {
    const overlay = new AnnotationOverlay();
    try {
      overlay.setRenderer(renderer());
      overlay.loadGenome(genome(['lnc_RNA']));
      overlay.setLayout(layout());
      const artifact = await manifest('bounded-annotation-artifact.v2:lnc-rna-only', 'lnc_RNA');
      expect(
        overlay.loadCompiledBroadSurfaceManifest(
          artifact,
          provenance(artifact, {
            prepackedOwnerKey: lncPolicySceneInput().ownerKey,
            prepackedArtifactKey: lncPolicySceneInput().metadata.artifactKey,
          })
        )
      ).toBe(true);
      expect(updateCamera(overlay, 500_000_000)).toBe(true);
      warmPolicyForManifest(overlay, artifact, nextPolicy);

      expect(overlay.updateAnnotationPresentationPolicy(nextPolicy)).toBe(true);
      const lncOwner = (
        overlayPresenterInternals(overlay) as unknown as {
          compiledBroadSurfaceTrackOwners: Map<
            string,
            { presenter: CompiledBroadSurfacePixiPresenterType }
          >;
        }
      ).compiledBroadSurfaceTrackOwners.get('lnc_RNA');
      expect(lncOwner?.presenter.diagnostics()).toMatchObject({
        presenting: true,
        activeIsoformMode: 'expanded',
        activeLaneLimit: 8,
      });
      expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
        loaded: false,
        runtimePolicy: nextPolicy,
        policyGeneration: 1,
      });
      expect(overlay.maxAnnotationLane).toBe(7);
    } finally {
      overlay.destroy();
    }
  });

  it('lets the first ready non-mRNA loader commit through the complete vector roster', async () => {
    const overlay = new AnnotationOverlay();
    try {
      overlay.setRenderer(renderer());
      overlay.loadGenome(genome(['mRNA', 'lnc_RNA']));
      overlay.setLayout(layout());
      expect(overlay.preparePrepackedAnnotationScene(policySceneInput())).toBe(true);
      expect(overlay.preparePrepackedAnnotationScene(lncPolicySceneInput())).toBe(true);

      const mrnaArtifact = await manifest('bounded-annotation-artifact.v2:mrna-racing', 'mRNA');
      const lncArtifact = await manifest(
        'bounded-annotation-artifact.v2:lnc-rna-first-ready',
        'lnc_RNA'
      );
      expect(overlay.loadCompiledBroadSurfaceManifest(mrnaArtifact, provenance(mrnaArtifact))).toBe(
        true
      );
      expect(
        overlay.loadCompiledBroadSurfaceManifest(
          lncArtifact,
          provenance(lncArtifact, {
            prepackedOwnerKey: lncPolicySceneInput().ownerKey,
            prepackedArtifactKey: lncPolicySceneInput().metadata.artifactKey,
          })
        )
      ).toBe(true);
      expect(updateCamera(overlay, 500_000_000)).toBe(true);
      warmPolicyForManifest(overlay, lncArtifact, nextPolicy);

      expect(overlay.updateAnnotationPresentationPolicy(nextPolicy)).toBe(true);
      const residents = (
        overlayPresenterInternals(overlay) as unknown as {
          prepackedAnnotationSceneResidents: Map<
            string,
            { layer: PartitionedInstancedTranscriptLayerType; policyGeneration: number }
          >;
        }
      ).prepackedAnnotationSceneResidents;
      expect([...residents.values()]).toHaveLength(2);
      for (const resident of residents.values()) {
        expect(resident.layer.isPresenting).toBe(true);
        expect(resident.layer.getAnnotationPolicyDebug().runtime).toEqual(nextPolicy);
        expect(resident.policyGeneration).toBe(1);
      }
      expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
        runtimePolicy: nextPolicy,
        policyGeneration: 1,
      });
      expect(overlay.getDebugSnapshot()).toMatchObject({
        compiledBroadRasterVisible: false,
        prepackedAnnotationSceneVisibleResidentOwnerKeys: expect.arrayContaining([
          policySceneInput().ownerKey,
          lncPolicySceneInput().ownerKey,
        ]),
        prepackedAnnotationSceneVisibleInstanceCount: 2,
      });
    } finally {
      overlay.destroy();
    }
  });

  it('defers raster-first policy publication until every selected track is ready', async () => {
    const overlay = new AnnotationOverlay();
    try {
      overlay.setRenderer(renderer());
      overlay.loadGenome({ ...genome(['mRNA', 'lnc_RNA']), features: [] });
      overlay.setLayout(layout());
      const mrnaArtifact = await manifest(
        'bounded-annotation-artifact.v2:mrna:raster-first',
        'mRNA'
      );
      const lncArtifact = await manifest(
        'bounded-annotation-artifact.v2:lnc-rna:raster-first',
        'lnc_RNA'
      );
      expect(overlay.loadCompiledBroadSurfaceManifest(mrnaArtifact, provenance(mrnaArtifact))).toBe(
        true
      );
      expect(
        overlay.loadCompiledBroadSurfaceManifest(
          lncArtifact,
          provenance(lncArtifact, {
            prepackedOwnerKey: lncPolicySceneInput().ownerKey,
            prepackedArtifactKey: lncPolicySceneInput().metadata.artifactKey,
          })
        )
      ).toBe(true);
      updateCamera(overlay, 500_000_000);
      warmPolicyForManifest(overlay, lncArtifact, nextPolicy);

      const before = overlay.getPrepackedAnnotationSceneOwnerSnapshot();
      expect(overlay.commitAnnotationPresentationPolicy(nextPolicy)).toEqual({
        status: 'deferred',
        reason: 'selected-raster-roster-incomplete',
      });
      expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toEqual(before);
      expect(overlay.getColdGestureSnapshot()).toMatchObject({ soleOwnerCount: 0 });

      warmPolicyForManifest(overlay, mrnaArtifact, nextPolicy);
      expect(overlay.commitAnnotationPresentationPolicy(nextPolicy)).toEqual({
        status: 'committed',
        policyGeneration: 1,
      });
      expect(overlay.getColdGestureSnapshot()).toMatchObject({
        soleOwnerCount: 1,
        soleOwnerId: 'compiled-broad-raster-surface',
      });
      const internals = overlayPresenterInternals(overlay) as unknown as {
        compiledBroadSurfacePresenter: CompiledBroadSurfacePixiPresenterType;
        compiledBroadSurfaceTrackOwners: Map<
          string,
          { presenter: CompiledBroadSurfacePixiPresenterType }
        >;
      };
      expect(internals.compiledBroadSurfacePresenter.isPresenting).toBe(true);
      expect(internals.compiledBroadSurfaceTrackOwners.get('lnc_RNA')?.presenter.isPresenting).toBe(
        true
      );

      const committed = overlay.getPrepackedAnnotationSceneOwnerSnapshot();
      expect(overlay.commitAnnotationPresentationPolicy(nextPolicy)).toEqual({
        status: 'committed',
        policyGeneration: 1,
      });
      expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toEqual(committed);
    } finally {
      overlay.destroy();
    }
  });

  it('preserves the global policy when prepacked residents clear under a surviving lnc_RNA raster', async () => {
    const overlay = new AnnotationOverlay();
    try {
      overlay.setRenderer(renderer());
      overlay.loadGenome(genome(['lnc_RNA']));
      overlay.setLayout(layout());
      const artifact = await manifest('bounded-annotation-artifact.v2:lnc-rna-survivor', 'lnc_RNA');
      expect(
        overlay.loadCompiledBroadSurfaceManifest(
          artifact,
          provenance(artifact, {
            prepackedOwnerKey: lncPolicySceneInput().ownerKey,
            prepackedArtifactKey: lncPolicySceneInput().metadata.artifactKey,
          })
        )
      ).toBe(true);
      expect(overlay.loadPrepackedAnnotationScene(lncPolicySceneInput())).toBe(true);
      const policyBefore = overlay.getPrepackedAnnotationSceneOwnerSnapshot().runtimePolicy;
      expect(policyBefore).toEqual({ isoformMode: 'canonical', laneLimit: 12 });

      overlay.clearPrepackedAnnotationScene();

      expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
        loaded: false,
        runtimePolicy: policyBefore,
      });
      expect(
        (
          overlayPresenterInternals(overlay) as unknown as {
            compiledBroadSurfaceTrackOwners: Map<string, unknown>;
          }
        ).compiledBroadSurfaceTrackOwners.has('lnc_RNA')
      ).toBe(true);
    } finally {
      overlay.destroy();
    }
  });

  it('invalidates same-policy publication when the last targeted compiled owner retires', async () => {
    const overlay = new AnnotationOverlay();
    try {
      overlay.setRenderer(renderer());
      overlay.loadGenome(genome(['lnc_RNA']));
      overlay.setLayout(layout());
      const artifact = await manifest('bounded-annotation-artifact.v2:lnc-rna-retired', 'lnc_RNA');
      const receipt = provenance(artifact, {
        prepackedOwnerKey: lncPolicySceneInput().ownerKey,
        prepackedArtifactKey: lncPolicySceneInput().metadata.artifactKey,
      });
      expect(overlay.loadCompiledBroadSurfaceManifest(artifact, receipt)).toBe(true);
      const input = lncPolicySceneInput();
      expect(overlay.loadPrepackedAnnotationScene(input)).toBe(true);
      const internals = overlayPresenterInternals(overlay) as unknown as {
        destroyPrepackedAnnotationSceneResident: (
          ownerKey: string,
          status: 'not-loaded',
          recordOwnerChange: boolean
        ) => void;
      };
      internals.destroyPrepackedAnnotationSceneResident(input.ownerKey, 'not-loaded', false);
      expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
        loaded: false,
        runtimePolicy: { isoformMode: 'canonical', laneLimit: 12 },
      });

      overlay.clearCompiledBroadSurfaceManifest(artifact.manifestFingerprint);
      expect(overlay.loadCompiledBroadSurfaceManifest(artifact, receipt)).toBe(true);
      expect(updateCamera(overlay, 500_000_000)).toBe(true);

      expect(
        overlay.updateAnnotationPresentationPolicy({ isoformMode: 'canonical', laneLimit: 12 })
      ).toBe(false);
      expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot().runtimePolicy).toBeNull();
    } finally {
      overlay.destroy();
    }
  });

  it('rejects a same-policy acknowledgement when any selected track lacks body authority', () => {
    const overlay = new AnnotationOverlay();
    try {
      prepare(overlay);
      overlay.loadGenome(genome(['mRNA', 'lnc_RNA']));

      expect(
        overlay.updateAnnotationPresentationPolicy({ isoformMode: 'canonical', laneLimit: 12 })
      ).toBe(false);

      overlay.loadGenome({ ...genome([]), features: [] });
      expect(
        overlay.updateAnnotationPresentationPolicy({ isoformMode: 'canonical', laneLimit: 12 })
      ).toBe(true);
    } finally {
      overlay.destroy();
    }
  });

  it('commits raster pixels, policy, and lane envelope before any prepacked owner exists', async () => {
    const overlay = new AnnotationOverlay();
    prepareRasterOnly(overlay);
    const artifact = await manifest();
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    const path = pathForSpan(500_000_000);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    warmPolicy(overlay, artifact, nextPolicy);

    expect(overlay.updateAnnotationPresentationPolicy(nextPolicy)).toBe(true);
    expect(overlay.updateAnnotationPresentationPolicy(nextPolicy)).toBe(true);
    expect(overlay.getCompiledBroadSurfaceDiagnostics()).toMatchObject({
      presenting: true,
      activeIsoformMode: 'expanded',
      activeLaneLimit: 8,
      broadVectorSubmissionCount: 0,
    });
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      loaded: false,
      ownerKey: null,
      runtimePolicy: nextPolicy,
      policyGeneration: 1,
    });
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      soleOwnerCount: 1,
      soleOwnerId: 'compiled-broad-raster-surface',
      compiledBroadRasterVisible: true,
      compiledBroadRasterActiveLevelIds: expect.arrayContaining([
        expect.stringMatching(/^(?:single|finer):L\d+$/),
      ]),
      compiledBroadRasterActiveMipWeights: expect.arrayContaining([expect.any(Number)]),
      compiledBroadRasterActiveResidentCellIds: expect.arrayContaining([expect.any(String)]),
      compiledBroadRasterSubmittedCellIds: expect.arrayContaining([expect.any(String)]),
      compiledBroadRasterRuntimeCellCompileCount: 0,
      compiledBroadRasterRuntimeDurableWriteCount: 0,
      prepackedLoaded: false,
      prepackedRuntimeIsoformMode: 'expanded',
      prepackedRuntimeLaneLimit: 8,
    });
    expect(overlay.maxAnnotationLane).toBe(7);
    expect(overlay.maxCdsLane).toBe(-1);
    expect(
      overlay.hitTest(path.bpLeftX(1_500_005_000), path.fwdStrandTop - 24, path, state())
    ).toBeNull();
    overlay.destroy();
  });

  it('answers broad hits from the compact parent-bound lookup without creating a GPU scene', async () => {
    const overlay = new AnnotationOverlay();
    prepareRasterOnly(overlay);
    const artifact = await manifest();
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    const path = pathForSpan(500_000_000);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    warmPolicy(overlay, artifact, nextPolicy);
    expect(overlay.updateAnnotationPresentationPolicy(nextPolicy)).toBe(true);

    const compact = compactPolicyInteractionInput();
    const admitted = overlay.loadCompiledBroadAnnotationInteraction(compact);
    expect(admitted).not.toBeNull();
    expect(admitted?.featureLookup).toBe(compact.featureLookup);
    expect(overlay.loadCompiledBroadAnnotationInteraction(compact)).toBe(admitted);
    expect(
      overlay.loadCompiledBroadAnnotationInteraction({
        ...compact,
        featureLookup: { ...compact.featureLookup },
      })
    ).toBe(admitted);
    expect(
      overlay.loadCompiledBroadAnnotationInteraction({
        ...compact,
        interactionPayloadSha256: '8'.repeat(64),
      })
    ).toBeNull();
    expect(
      overlay.hitTest(path.bpLeftX(1_500_005_000), path.fwdStrandTop - 24, path, state())
    ).toMatchObject({
      kind: 'feature',
      payload: {
        id: 1,
        displayName: 'TX1',
        type: 'mRNA',
        transcriptId: 'NM_TX1.1',
        sourceId: 'rna-TX1',
        canonicalIdentity: 'canonical-TX1',
        lane: 1,
      },
    });
    expect(
      overlay.updateRetainedCamera({
        path,
        state: { ...state(), hoveredId: 1 },
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneResidentOwnerCount: 0,
      prepackedAnnotationSceneGpuPreparations: 0,
      compiledBroadAnnotationInteractionResidentGeneration: 1,
      compiledBroadAnnotationInteractionPreparedOwnerKeys: [compact.ownerKey],
      lastInteractionOutlineCommandCount: 1,
    });
    expect(overlay.getCompiledBroadAnnotationInteractionAuthoritySnapshot()).toEqual({
      contract: 'compiled-broad-annotation-interaction-authority-snapshot.v1',
      residentGeneration: 1,
      preparedOwnerKeys: [compact.ownerKey],
    });
    overlay.destroy();
  });

  it('retains every selected compact interaction owner when the selected set exceeds the ordinary cache limit', () => {
    const selectedTrackTypes = Array.from({ length: 17 }, (_, index) => `selected-${index}`);
    const overlay = new AnnotationOverlay();
    prepareRasterOnly(overlay);
    overlay.loadGenome(genome(selectedTrackTypes));
    overlay.setLayout(layout());

    for (const trackType of selectedTrackTypes) {
      const base = compactPolicyInteractionInput();
      expect(
        overlay.loadCompiledBroadAnnotationInteraction({
          ...base,
          ownerKey: `compact-${trackType}`,
          metadata: {
            ...base.metadata,
            trackType,
            artifactKey: prepackedAnnotationSceneArtifactKey({
              themeMode: 'light',
              trackType,
            }),
          },
        })
      ).not.toBeNull();
    }

    expect(overlay.getCompiledBroadAnnotationInteractionAuthoritySnapshot()).toEqual({
      contract: 'compiled-broad-annotation-interaction-authority-snapshot.v1',
      residentGeneration: 17,
      preparedOwnerKeys: selectedTrackTypes
        .map((trackType) => `compact-${trackType}`)
        .sort((left, right) => left.localeCompare(right)),
    });
    overlay.destroy();
  });

  it('keeps a same-owner corridor incumbent until its replacement physically presents', async () => {
    const overlay = new AnnotationOverlay();
    prepareRasterOnly(overlay);
    const { compact, first, second } = await trustedCorridorInputs();
    expect(overlay.loadCompiledBroadAnnotationInteraction(compact)).not.toBeNull();
    expect(overlay.preparePrepackedAnnotationScene(first)).toBe(true);
    const path = pathForSpan(100_000_000, 1_475_000_000);
    admitViewportDetailRosterAtFineLocus(overlay);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      soleOwnerCount: 1,
      soleOwnerId: 'prepacked-partitioned-vector-surface',
      soleOwnerCoverageComplete: true,
    });

    expect(overlay.preparePrepackedAnnotationScene(second)).toBe(true);
    const internal = overlayPresenterInternals(overlay) as unknown as {
      prepackedAnnotationSceneResidents: Map<string, { input: PrepackedAnnotationSceneLoadInput }>;
      prepackedAnnotationSceneReplacementCandidates: Map<
        string,
        { input: PrepackedAnnotationSceneLoadInput }
      >;
    };
    expect(internal.prepackedAnnotationSceneResidents).toHaveLength(1);
    expect(
      internal.prepackedAnnotationSceneResidents.get(first.ownerKey)?.input.viewportDetail
        ?.packetPayloadSha256
    ).toBe(first.viewportDetail?.packetPayloadSha256);
    expect(
      internal.prepackedAnnotationSceneReplacementCandidates.get(first.ownerKey)?.input
        .viewportDetail?.packetPayloadSha256
    ).toBe(second.viewportDetail?.packetPayloadSha256);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneResidentOwnerCount: 1,
      prepackedAnnotationSceneLayerCreates: 2,
      prepackedAnnotationSceneLayerDestroys: 0,
      prepackedAnnotationSceneVisibleResidentOwnerKeys: [first.ownerKey],
    });

    admitViewportDetailRosterAtFineLocus(overlay);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    expect(internal.prepackedAnnotationSceneReplacementCandidates).toHaveLength(0);
    expect(
      internal.prepackedAnnotationSceneResidents.get(first.ownerKey)?.input.viewportDetail
        ?.packetPayloadSha256
    ).toBe(second.viewportDetail?.packetPayloadSha256);
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      soleOwnerCount: 1,
      soleOwnerId: 'prepacked-partitioned-vector-surface',
      soleOwnerCoverageComplete: true,
    });
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneLayerDestroys).toBe(0);
    overlay.releaseRetiredGpuResourcesAfterPresent();
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLayerDestroys: 0,
      prepackedAnnotationSceneRetiredLayerCount: 1,
    });
    overlay.releaseRetiredGpuResourcesAfterPresent();
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneLayerDestroys).toBe(1);
    overlay.destroy();
  });

  it('selects the newest camera-covering generation instead of a stale replacement slot', async () => {
    const overlay = new AnnotationOverlay();
    prepareRasterOnly(overlay);
    const { compact, first, second } = await trustedCorridorInputs();
    expect(overlay.loadCompiledBroadAnnotationInteraction(compact)).not.toBeNull();
    expect(overlay.preparePrepackedAnnotationScene(first)).toBe(true);
    const staleReplacement: PrepackedAnnotationSceneLoadInput = {
      ...second,
      viewportDetail: {
        ...second.viewportDetail!,
        coverageStartBp: 1_550_000_000,
        coverageEndBp: 1_650_000_000,
        handoffStartBp: 1_570_000_000,
        handoffEndBp: 1_620_000_000,
      },
    };
    expect(overlay.preparePrepackedAnnotationScene(staleReplacement)).toBe(true);

    const viewportStartBp = 1_499_900_000;
    const viewportEndBp = viewportStartBp + 512 * 1024;
    prepareViewportDetailRoster(overlay, viewportStartBp, viewportEndBp);
    expect(
      overlay.admitPrepackedAnnotationViewportDetailRoster(viewportStartBp, viewportEndBp, 'light')
    ).toBe(true);
    expect(updateCamera(overlay, 512 * 1024, viewportStartBp)).toBe(true);
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      soleOwnerCount: 1,
      soleOwnerId: 'prepacked-partitioned-vector-surface',
      soleOwnerCoverageComplete: true,
    });
    overlay.destroy();
  });

  it('retargets identical packet bytes to a new corridor without preserving presentation authority', async () => {
    const overlay = new AnnotationOverlay();
    prepareRasterOnly(overlay);
    const { compact, first } = await trustedCorridorInputs();
    expect(overlay.loadCompiledBroadAnnotationInteraction(compact)).not.toBeNull();
    expect(overlay.preparePrepackedAnnotationScene(first)).toBe(true);

    const retargeted: PrepackedAnnotationSceneLoadInput = {
      ...first,
      viewportDetail: {
        ...first.viewportDetail!,
        coverageStartBp: 1_425_000_000,
        coverageEndBp: 1_625_000_000,
        handoffStartBp: 1_500_000_000,
        handoffEndBp: 1_550_000_000,
      },
    };
    expect(retargeted.viewportDetail?.packetPayloadSha256).toBe(
      first.viewportDetail?.packetPayloadSha256
    );
    expect(overlay.preparePrepackedAnnotationScene(retargeted)).toBe(true);

    const internal = overlayPresenterInternals(overlay) as unknown as {
      prepackedAnnotationSceneResidents: Map<
        string,
        {
          input: PrepackedAnnotationSceneLoadInput;
          viewportDetailPresentationAdmitted: boolean;
        }
      >;
      prepackedAnnotationSceneReplacementCandidates: Map<
        string,
        {
          input: PrepackedAnnotationSceneLoadInput;
          viewportDetailPresentationAdmitted: boolean;
        }
      >;
    };
    const retargetedResident =
      internal.prepackedAnnotationSceneReplacementCandidates.get(first.ownerKey) ??
      internal.prepackedAnnotationSceneResidents.get(first.ownerKey);
    expect(retargetedResident?.input.viewportDetail).toMatchObject({
      coverageStartBp: 1_425_000_000,
      coverageEndBp: 1_625_000_000,
      handoffStartBp: 1_500_000_000,
      handoffEndBp: 1_550_000_000,
    });
    expect(retargetedResident?.viewportDetailPresentationAdmitted).toBe(false);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLayerCreates: 1,
      prepackedAnnotationSceneVisibleResidentOwnerKeys: [],
    });

    admitViewportDetailRosterAtFineLocus(overlay);
    expect(retargetedResident?.viewportDetailPresentationAdmitted).toBe(true);
    overlay.destroy();
  });

  it('rejects compact interaction that lacks the trusted main-process admission marker', () => {
    const overlay = new AnnotationOverlay();
    expect(
      overlay.loadCompiledBroadAnnotationInteraction({
        ...compactPolicyInteractionInput(),
        validationMarker: 'forged',
      } as never)
    ).toBeNull();
    overlay.destroy();
  });

  it('retires a stale active interaction owner when the exact compiled owner prepares later', async () => {
    const overlay = new AnnotationOverlay();
    prepareRasterOnly(overlay);
    const artifact = await manifest();
    expect(overlay.loadCompiledBroadSurfaceManifest(artifact, provenance(artifact))).toBe(true);
    const path = pathForSpan(500_000_000);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    warmPolicy(overlay, artifact, nextPolicy);
    expect(overlay.updateAnnotationPresentationPolicy(nextPolicy)).toBe(true);
    const hitX = path.bpLeftX(1_500_005_000);
    const hitY = path.fwdStrandTop - 24;

    const wrongOwner = { ...policySceneInput(), ownerKey: 'wrong-interaction-owner' };
    expect(overlay.loadPrepackedAnnotationScene(wrongOwner)).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      loaded: true,
      ownerKey: 'wrong-interaction-owner',
      runtimePolicy: nextPolicy,
    });
    expect(overlay.hitTest(hitX, hitY, path, state())).toBeNull();
    expect(
      overlay.updateRetainedCamera({
        path,
        state: { ...state(), hoveredId: 1 },
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot().lastInteractionOutlineCommandCount).toBe(0);

    const rasterBeforeExactJoin = overlay.getCompiledBroadSurfaceDiagnostics()!;
    const admissionBeforeExactJoin = overlay.getDebugSnapshot();
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      prepackedRequestedResidentCount: 0,
      prepackedRequestedResidentRosterReady: false,
      prepackedRequestedSingleResidentOwnerKey: null,
    });
    expect(overlay.preparePrepackedAnnotationScene(policySceneInput())).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      loaded: false,
      ownerKey: null,
      runtimePolicy: nextPolicy,
    });
    const rasterAfterExactJoin = overlay.getCompiledBroadSurfaceDiagnostics()!;
    const admissionAfterExactJoin = overlay.getDebugSnapshot();
    expect(admissionAfterExactJoin.prepackedAnnotationScenePreparedOwnerKeys).toEqual([
      policySceneInput().ownerKey,
      wrongOwner.ownerKey,
    ]);
    expect(admissionAfterExactJoin.prepackedAnnotationSceneLayerDestroys).toBe(
      admissionBeforeExactJoin.prepackedAnnotationSceneLayerDestroys
    );
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      prepackedResidentRosterGeneration: expect.any(Number),
      prepackedRequestedResidentCount: 1,
      prepackedRequestedResidentRosterReady: true,
      prepackedRequestedSingleResidentOwnerKey: policySceneInput().ownerKey,
      prepackedRequestedSingleResidentArtifactKey: policySceneInput().metadata.artifactKey,
    });
    expect(overlay.getColdGestureSnapshot().prepackedResidentRosterGeneration).toBeGreaterThan(0);
    expect(rasterAfterExactJoin).toMatchObject({
      manifestFingerprint: rasterBeforeExactJoin.manifestFingerprint,
      activeIsoformMode: rasterBeforeExactJoin.activeIsoformMode,
      activeLaneLimit: rasterBeforeExactJoin.activeLaneLimit,
      residentCellIds: rasterBeforeExactJoin.residentCellIds,
      activeResidentCellIds: rasterBeforeExactJoin.activeResidentCellIds,
      textureAdmissionCount: rasterBeforeExactJoin.textureAdmissionCount,
      transparentCellAdmissionCount: rasterBeforeExactJoin.transparentCellAdmissionCount,
      stagedSceneBuildCount: rasterBeforeExactJoin.stagedSceneBuildCount,
      atomicCommitCount: rasterBeforeExactJoin.atomicCommitCount,
      meshCreationCount: rasterBeforeExactJoin.meshCreationCount,
      shaderCreationCount: rasterBeforeExactJoin.shaderCreationCount,
      geometryCreationCount: rasterBeforeExactJoin.geometryCreationCount,
    });
    expect(admissionAfterExactJoin.compiledBroadSurfaceRgbaAdmissions).toBe(
      admissionBeforeExactJoin.compiledBroadSurfaceRgbaAdmissions
    );
    expect(admissionAfterExactJoin.compiledBroadSurfaceGpuPreuploads).toBe(
      admissionBeforeExactJoin.compiledBroadSurfaceGpuPreuploads
    );
    expect(overlay.hitTest(hitX, hitY, path, state())).toMatchObject({
      payload: { id: 1, lane: 1 },
    });
    expect(
      overlay.updateRetainedCamera({
        path,
        state: { ...state(), hoveredId: 1 },
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot().lastInteractionOutlineCommandCount).toBeGreaterThan(0);

    const resourceBeforeFocus = overlay.getDebugSnapshot();
    const bodyBeforeFocus = overlay.getCompiledBroadSurfaceDiagnostics()!;
    const focusGraphics = (
      overlayPresenterInternals(overlay) as unknown as {
        annotationSearchFocusGraphics: {
          rect: (...args: unknown[]) => unknown;
          poly: (...args: unknown[]) => unknown;
          fill: (...args: unknown[]) => unknown;
        };
      }
    ).annotationSearchFocusGraphics;
    const focusRect = vi.spyOn(focusGraphics, 'rect');
    const focusPoly = vi.spyOn(focusGraphics, 'poly');
    const focusFill = vi.spyOn(focusGraphics, 'fill');
    expect(
      overlay.updateRetainedCamera({
        path,
        state: {
          ...state(),
          annotationSearchFocus: {
            trackId: 'mRNA',
            canonicalIdentity: 'canonical-TX1',
          },
        },
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(focusRect).toHaveBeenCalledOnce();
    expect(focusPoly).toHaveBeenCalledOnce();
    expect(focusFill).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        color: 0x3b82f6,
        alpha: expect.closeTo(
          retainedSubpixelAlphaScale((10_000 * VIEWPORT_WIDTH_PX) / 500_000_000),
          6
        ),
      })
    );
    expect(overlay.getDebugSnapshot()).toMatchObject({
      compiledBroadRasterVisible: true,
      annotationSearchFocusMaskDrawCount: 1,
      annotationSearchFocusPrimitiveDrawCount: 1,
      annotationSearchFocusResolvedTrackId: 'mRNA',
      annotationSearchFocusResolvedCanonicalIdentity: 'canonical-TX1',
      prepackedAnnotationSceneLayerCreates:
        resourceBeforeFocus.prepackedAnnotationSceneLayerCreates,
      prepackedAnnotationSceneGpuPreparations:
        resourceBeforeFocus.prepackedAnnotationSceneGpuPreparations,
      compiledBroadSurfaceRgbaAdmissions: resourceBeforeFocus.compiledBroadSurfaceRgbaAdmissions,
      compiledBroadSurfaceGpuPreuploads: resourceBeforeFocus.compiledBroadSurfaceGpuPreuploads,
      annotationPresentationOwners: resourceBeforeFocus.annotationPresentationOwners,
    });
    expect(overlay.getCompiledBroadSurfaceDiagnostics()).toMatchObject({
      meshCreationCount: bodyBeforeFocus.meshCreationCount,
      shaderCreationCount: bodyBeforeFocus.shaderCreationCount,
      geometryCreationCount: bodyBeforeFocus.geometryCreationCount,
      textureAdmissionCount: bodyBeforeFocus.textureAdmissionCount,
      transparentCellAdmissionCount: bodyBeforeFocus.transparentCellAdmissionCount,
      stagedSceneBuildCount: bodyBeforeFocus.stagedSceneBuildCount,
      atomicCommitCount: bodyBeforeFocus.atomicCommitCount,
    });

    focusRect.mockClear();
    focusPoly.mockClear();
    focusFill.mockClear();
    expect(
      overlay.updateRetainedCamera({
        path,
        state: {
          ...state(),
          annotationSearchFocus: {
            trackId: 'mRNA',
            canonicalIdentity: 'canonical-missing',
          },
        },
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(focusRect).not.toHaveBeenCalled();
    expect(focusPoly).not.toHaveBeenCalled();
    expect(focusFill).not.toHaveBeenCalled();
    expect(overlay.getDebugSnapshot()).toMatchObject({
      compiledBroadRasterVisible: true,
      annotationSearchFocusMaskDrawCount: 0,
      annotationSearchFocusPrimitiveDrawCount: 0,
      annotationSearchFocusResolvedTrackId: null,
      annotationSearchFocusResolvedCanonicalIdentity: null,
      prepackedAnnotationSceneLayerCreates:
        resourceBeforeFocus.prepackedAnnotationSceneLayerCreates,
      prepackedAnnotationSceneGpuPreparations:
        resourceBeforeFocus.prepackedAnnotationSceneGpuPreparations,
      compiledBroadSurfaceRgbaAdmissions: resourceBeforeFocus.compiledBroadSurfaceRgbaAdmissions,
      compiledBroadSurfaceGpuPreuploads: resourceBeforeFocus.compiledBroadSurfaceGpuPreuploads,
      annotationPresentationOwners: resourceBeforeFocus.annotationPresentationOwners,
    });
    expect(overlay.getCompiledBroadSurfaceDiagnostics()).toMatchObject({
      meshCreationCount: bodyBeforeFocus.meshCreationCount,
      shaderCreationCount: bodyBeforeFocus.shaderCreationCount,
      geometryCreationCount: bodyBeforeFocus.geometryCreationCount,
      textureAdmissionCount: bodyBeforeFocus.textureAdmissionCount,
      transparentCellAdmissionCount: bodyBeforeFocus.transparentCellAdmissionCount,
      stagedSceneBuildCount: bodyBeforeFocus.stagedSceneBuildCount,
      atomicCommitCount: bodyBeforeFocus.atomicCommitCount,
    });
    overlay.destroy();
  });

  it('falls back to one complete vector body when target-policy raster cells are missing', async () => {
    const { overlay, path } = await preparePolicyTransactionFixture();
    const layer = layerFor(overlay);
    const bodyBefore = overlay.getCompiledBroadSurfaceDiagnostics();
    const ownerBefore = overlay.getPrepackedAnnotationSceneOwnerSnapshot();
    const layerBefore = layer.getAnnotationPolicyDebug();
    const maxLaneBefore = overlay.maxAnnotationLane;
    const hitX = path.bpLeftX(1_500_005_000);

    expect(overlay.hitTest(hitX, path.fwdStrandTop - 8, path, state())).toMatchObject({
      payload: { id: 1, lane: 0 },
    });
    expect(overlay.updatePrepackedAnnotationPolicy(nextPolicy)).toBe(true);
    expect(overlay.getCompiledBroadSurfaceDiagnostics()).toMatchObject({
      presenting: false,
      activeIsoformMode: bodyBefore?.activeIsoformMode,
      activeLaneLimit: bodyBefore?.activeLaneLimit,
      activeResidentCellIds: bodyBefore?.activeResidentCellIds,
      atomicCommitCount: bodyBefore?.atomicCommitCount,
    });
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: ownerBefore.ownerKey,
      ownerGeneration: ownerBefore.ownerGeneration,
      loaded: true,
      status: 'eligible',
      runtimePolicy: nextPolicy,
      policyGeneration: ownerBefore.policyGeneration + 1,
      submittedPartitionCount: 1,
      submittedInstanceCount: 1,
    });
    expect(layer.getAnnotationPolicyDebug()).not.toEqual(layerBefore);
    expect(layer.getAnnotationPolicyDebug().runtime).toEqual(nextPolicy);
    expect(overlay.maxAnnotationLane).toBe(7);
    expect(overlay.maxAnnotationLane).not.toBe(maxLaneBefore);
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      soleOwnerCount: 1,
      soleOwnerId: 'prepacked-partitioned-vector-surface',
    });
    expect(overlay.hitTest(hitX, path.fwdStrandTop - 8, path, state())).toBeNull();
    expect(overlay.hitTest(hitX, path.fwdStrandTop - 24, path, state())).toMatchObject({
      payload: { id: 1, lane: 1 },
    });
    overlay.destroy();
  });

  it('acknowledges an already-published policy without restaging a pending broad camera', async () => {
    const { overlay, artifact } = await preparePolicyTransactionFixture();
    warmPolicy(overlay, artifact, nextPolicy);
    expect(overlay.updateAnnotationPresentationPolicy(nextPolicy)).toBe(true);

    const pendingPath = pathForSpan(90_000_000, 100_000_000);
    expect(
      overlay.updateRetainedCamera({
        path: pendingPath,
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    const pendingDemand = overlay.getCompiledBroadSurfaceDemand(nextPolicy);
    expect(pendingDemand.status).toBe('broad-ready');
    expect(pendingDemand.missingRequiredCellAddresses.length).toBeGreaterThan(0);

    const bodyBefore = overlay.getCompiledBroadSurfaceDiagnostics();
    const ownerBefore = overlay.getPrepackedAnnotationSceneOwnerSnapshot();
    const maxLaneBefore = overlay.maxAnnotationLane;
    const beginPolicy = vi.spyOn(layerFor(overlay), 'beginAnnotationPolicyTransaction');
    const stageBody = vi.spyOn(CompiledBroadSurfacePixiPresenterV2.prototype, 'stagePresentation');

    expect(overlay.updateAnnotationPresentationPolicy(nextPolicy)).toBe(true);
    expect(beginPolicy).not.toHaveBeenCalled();
    expect(stageBody).not.toHaveBeenCalled();
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toEqual(ownerBefore);
    expect(overlay.getCompiledBroadSurfaceDiagnostics()).toEqual(bodyBefore);
    expect(overlay.maxAnnotationLane).toBe(maxLaneBefore);
    overlay.destroy();
  });

  it('rolls back a partially-mutating prepacked-layer policy failure exactly', async () => {
    const { overlay, artifact, path } = await preparePolicyTransactionFixture();
    warmPolicy(overlay, artifact, nextPolicy);
    const layer = layerFor(overlay);
    const bodyBefore = overlay.getCompiledBroadSurfaceDiagnostics();
    const ownerBefore = overlay.getPrepackedAnnotationSceneOwnerSnapshot();
    const layerBefore = layer.getAnnotationPolicyDebug();
    const maxLaneBefore = overlay.maxAnnotationLane;
    const original = PartitionedInstancedTranscriptLayer.prototype.updateAnnotationPolicy;
    vi.spyOn(
      PartitionedInstancedTranscriptLayer.prototype,
      'updateAnnotationPolicy'
    ).mockImplementation(function (this: PartitionedInstancedTranscriptLayerType, policy) {
      original.call(this, policy);
      throw new Error('injected-policy-update-failure-after-mutation');
    });

    expect(overlay.updatePrepackedAnnotationPolicy(nextPolicy)).toBe(false);
    expect(layer.getAnnotationPolicyDebug()).toEqual(layerBefore);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toEqual(ownerBefore);
    expect(overlay.maxAnnotationLane).toBe(maxLaneBefore);
    expect(overlay.getCompiledBroadSurfaceDiagnostics()).toMatchObject({
      activeIsoformMode: bodyBefore?.activeIsoformMode,
      activeLaneLimit: bodyBefore?.activeLaneLimit,
      activeResidentCellIds: bodyBefore?.activeResidentCellIds,
      atomicCommitCount: bodyBefore?.atomicCommitCount,
    });
    expect(
      overlay.hitTest(path.bpLeftX(1_500_005_000), path.fwdStrandTop - 8, path, state())
    ).toMatchObject({ payload: { id: 1, lane: 0 } });
    overlay.destroy();
  });

  it('keeps a two-raster two-resident policy generation atomic when raster #2 preflight fails', async () => {
    const overlay = new AnnotationOverlay();
    overlay.setRenderer(renderer());
    overlay.loadGenome(genome(['mRNA', 'lnc_RNA']));
    overlay.setLayout(layout());

    const mrnaInput = policySceneInput();
    const lncInput = lncPolicySceneInput();
    expect(overlay.preparePrepackedAnnotationScene(mrnaInput)).toBe(true);
    expect(overlay.preparePrepackedAnnotationScene(lncInput)).toBe(true);

    const mrnaArtifact = await manifest(
      'bounded-annotation-artifact.v2:mrna:compound-atomic-policy',
      'mRNA'
    );
    const lncArtifact = await manifest(
      'bounded-annotation-artifact.v2:lnc-rna:compound-atomic-policy',
      'lnc_RNA'
    );
    expect(overlay.loadCompiledBroadSurfaceManifest(mrnaArtifact, provenance(mrnaArtifact))).toBe(
      true
    );
    expect(
      overlay.loadCompiledBroadSurfaceManifest(
        lncArtifact,
        provenance(lncArtifact, {
          prepackedOwnerKey: lncInput.ownerKey,
          prepackedArtifactKey: lncInput.metadata.artifactKey,
        })
      )
    ).toBe(true);

    const path = pathForSpan(500_000_000);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    const initialPolicy = { isoformMode: 'canonical' as const, laneLimit: 12 };
    warmPolicyForManifest(overlay, mrnaArtifact, initialPolicy);
    warmPolicyForManifest(overlay, lncArtifact, initialPolicy);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    warmPolicyForManifest(overlay, mrnaArtifact, nextPolicy);
    warmPolicyForManifest(overlay, lncArtifact, nextPolicy);

    type Resident = {
      ownerKey: string;
      layer: PartitionedInstancedTranscriptLayerType;
      policyGeneration: number;
      visiblePartitionCount: number;
      visibleInstanceCount: number;
    };
    const internals = overlayPresenterInternals(overlay) as unknown as {
      compiledBroadSurfacePresenter: CompiledBroadSurfacePixiPresenterType;
      compiledBroadSurfaceTrackOwners: Map<
        string,
        { presenter: CompiledBroadSurfacePixiPresenterType }
      >;
      prepackedAnnotationSceneResidents: Map<string, Resident>;
      prepackedAnnotationRuntimePolicy: {
        isoformMode: 'canonical' | 'expanded';
        laneLimit: number | null;
      };
      prepackedAnnotationPolicyGeneration: number;
      maxAnnotationLane: number;
      maxCdsLane: number;
      maxLane: number;
    };
    const rasters = [
      internals.compiledBroadSurfacePresenter,
      internals.compiledBroadSurfaceTrackOwners.get('lnc_RNA')!.presenter,
    ];
    const residents = [
      internals.prepackedAnnotationSceneResidents.get(mrnaInput.ownerKey)!,
      internals.prepackedAnnotationSceneResidents.get(lncInput.ownerKey)!,
    ];
    expect(rasters.every((presenter) => presenter.isPresenting)).toBe(true);
    expect(residents.every((resident) => !resident.layer.isPresenting)).toBe(true);

    const authoritativeSnapshot = () => {
      const debug = overlay.getDebugSnapshot();
      return {
        rasters: rasters.map((presenter) => {
          const diagnostics = presenter.diagnostics();
          return {
            presenting: presenter.isPresenting,
            activeIsoformMode: diagnostics.activeIsoformMode,
            activeLaneLimit: diagnostics.activeLaneLimit,
            activeResidentCellIds: diagnostics.activeResidentCellIds,
            submittedCellIds: diagnostics.submittedCellIds,
            atomicCommitCount: diagnostics.atomicCommitCount,
          };
        }),
        residents: residents.map((resident) => ({
          ownerKey: resident.ownerKey,
          runtimePolicy: resident.layer.getAnnotationPolicyDebug().runtime,
          policyGeneration: resident.policyGeneration,
          presenting: resident.layer.isPresenting,
          visiblePartitionCount: resident.visiblePartitionCount,
          visibleInstanceCount: resident.visibleInstanceCount,
        })),
        globalPolicy: { ...internals.prepackedAnnotationRuntimePolicy },
        globalGeneration: internals.prepackedAnnotationPolicyGeneration,
        laneEnvelope: {
          maxAnnotationLane: internals.maxAnnotationLane,
          maxCdsLane: internals.maxCdsLane,
          maxLane: internals.maxLane,
          layout: debug.layout,
        },
        visibility: {
          compiledBroadRasterVisible: debug.compiledBroadRasterVisible,
          presentationLayerTypes: debug.annotationPresentationLayerTypes,
          presentationOwners: debug.annotationPresentationOwners,
          ownerViolations: debug.annotationPresentationOwnerViolations,
          visibleResidentOwnerKeys: debug.prepackedAnnotationSceneVisibleResidentOwnerKeys,
          coldOwner: {
            soleOwnerCount: overlay.getColdGestureSnapshot().soleOwnerCount,
            soleOwnerId: overlay.getColdGestureSnapshot().soleOwnerId,
          },
        },
      };
    };

    const before = authoritativeSnapshot();
    const residentCommits = residents.map((resident) =>
      vi.spyOn(resident.layer, 'commitAnnotationPolicyTransaction')
    );
    const residentRollbacks = residents.map((resident) =>
      vi.spyOn(resident.layer, 'rollbackAnnotationPolicyTransaction')
    );
    const rasterCommit = vi.spyOn(
      CompiledBroadSurfacePixiPresenterV2.prototype,
      'commitStagedPresentation'
    );
    const originalPreflight =
      CompiledBroadSurfacePixiPresenterV2.prototype.canCommitStagedPresentation;
    const preflightPresenters: CompiledBroadSurfacePixiPresenterType[] = [];
    const rasterPreflight = vi
      .spyOn(CompiledBroadSurfacePixiPresenterV2.prototype, 'canCommitStagedPresentation')
      .mockImplementation(function (this: CompiledBroadSurfacePixiPresenterType, receipt, camera) {
        preflightPresenters.push(this);
        if (preflightPresenters.length === 2) return false;
        return originalPreflight.call(this, receipt, camera);
      });

    expect(overlay.commitAnnotationPresentationPolicy(nextPolicy)).toEqual({
      status: 'rejected',
      reason: 'annotation-policy-commit-rejected',
    });
    expect(preflightPresenters).toHaveLength(2);
    expect(rasters.includes(preflightPresenters[0]!)).toBe(true);
    expect(rasters.includes(preflightPresenters[1]!)).toBe(true);
    expect(preflightPresenters[0]).not.toBe(preflightPresenters[1]);
    expect(rasterCommit).not.toHaveBeenCalled();
    for (const rollback of residentRollbacks) expect(rollback).toHaveBeenCalledOnce();
    for (const commit of residentCommits) expect(commit).not.toHaveBeenCalled();
    expect(authoritativeSnapshot()).toEqual(before);

    rasterPreflight.mockRestore();
    expect(overlay.commitAnnotationPresentationPolicy(nextPolicy)).toEqual({
      status: 'committed',
      policyGeneration: before.globalGeneration + 1,
    });
    expect(rasterCommit).toHaveBeenCalledTimes(2);
    for (const commit of residentCommits) expect(commit).toHaveBeenCalledOnce();
    for (const rollback of residentRollbacks) expect(rollback).toHaveBeenCalledOnce();

    const after = authoritativeSnapshot();
    for (const [index, raster] of after.rasters.entries()) {
      expect(raster).toMatchObject({
        presenting: true,
        activeIsoformMode: nextPolicy.isoformMode,
        activeLaneLimit: nextPolicy.laneLimit,
        atomicCommitCount: before.rasters[index]!.atomicCommitCount + 1,
      });
      expect(raster.activeResidentCellIds.length).toBeGreaterThan(0);
      expect(raster.submittedCellIds.length).toBeGreaterThan(0);
      expect(raster.activeResidentCellIds.every((cellId) => cellId.includes('|expanded:'))).toBe(
        true
      );
      expect(raster.submittedCellIds.every((cellId) => cellId.includes('|expanded:'))).toBe(true);
    }
    expect(after.residents).toEqual(
      before.residents.map((resident) => ({
        ...resident,
        runtimePolicy: nextPolicy,
        policyGeneration: resident.policyGeneration + 1,
      }))
    );
    expect(after.globalPolicy).toEqual(nextPolicy);
    expect(after.globalGeneration).toBe(before.globalGeneration + 1);
    expect(after.laneEnvelope).toMatchObject({
      maxAnnotationLane: 16,
      maxCdsLane: -1,
      maxLane: 16,
    });
    expect(after.visibility).toEqual(before.visibility);
    overlay.destroy();
  });

  it('rolls the layer back and discards the staged raster when raster preflight fails', async () => {
    const { overlay, artifact, path } = await preparePolicyTransactionFixture();
    warmPolicy(overlay, artifact, nextPolicy);
    const layer = layerFor(overlay);
    const bodyBefore = overlay.getCompiledBroadSurfaceDiagnostics();
    const ownerBefore = overlay.getPrepackedAnnotationSceneOwnerSnapshot();
    const layerBefore = layer.getAnnotationPolicyDebug();
    const maxLaneBefore = overlay.maxAnnotationLane;
    const preflight = vi
      .spyOn(CompiledBroadSurfacePixiPresenterV2.prototype, 'canCommitStagedPresentation')
      .mockReturnValue(false);
    const commit = vi.spyOn(
      CompiledBroadSurfacePixiPresenterV2.prototype,
      'commitStagedPresentation'
    );

    expect(overlay.updatePrepackedAnnotationPolicy(nextPolicy)).toBe(false);
    expect(preflight).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(layer.getAnnotationPolicyDebug()).toEqual(layerBefore);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toEqual(ownerBefore);
    expect(overlay.maxAnnotationLane).toBe(maxLaneBefore);
    expect(overlay.getCompiledBroadSurfaceDiagnostics()).toMatchObject({
      activeIsoformMode: bodyBefore?.activeIsoformMode,
      activeLaneLimit: bodyBefore?.activeLaneLimit,
      activeResidentCellIds: bodyBefore?.activeResidentCellIds,
      atomicCommitCount: bodyBefore?.atomicCommitCount,
    });
    expect(
      overlay.hitTest(path.bpLeftX(1_500_005_000), path.fwdStrandTop - 8, path, state())
    ).toMatchObject({ payload: { id: 1, lane: 0 } });
    overlay.destroy();
  });

  it('commits body, interaction policy, and lane envelope in one guarded JS stack with zero resource work', async () => {
    const { overlay, artifact, path } = await preparePolicyTransactionFixture();
    warmPolicy(overlay, artifact, nextPolicy);
    const hitX = path.bpLeftX(1_500_005_000);
    const debugBefore = overlay.getDebugSnapshot();
    const bodyBefore = overlay.getCompiledBroadSurfaceDiagnostics()!;
    const original = CompiledBroadSurfacePixiPresenterV2.prototype.commitStagedPresentation;
    const intermediateHits: Array<unknown> = [];
    const bodyPolicies: Array<string | null> = [];
    const commit = vi
      .spyOn(CompiledBroadSurfacePixiPresenterV2.prototype, 'commitStagedPresentation')
      .mockImplementation(function (this: CompiledBroadSurfacePixiPresenterType, receipt, camera) {
        bodyPolicies.push(this.diagnostics().activeIsoformMode);
        intermediateHits.push(overlay.hitTest(hitX, path.fwdStrandTop - 8, path, state()));
        const committed = original.call(this, receipt, camera);
        bodyPolicies.push(this.diagnostics().activeIsoformMode);
        intermediateHits.push(overlay.hitTest(hitX, path.fwdStrandTop - 24, path, state()));
        return committed;
      });

    expect(overlay.updatePrepackedAnnotationPolicy(nextPolicy)).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(bodyPolicies).toEqual(['canonical', 'expanded']);
    expect(intermediateHits).toEqual([null, null]);
    expect(overlay.getCompiledBroadSurfaceDiagnostics()).toMatchObject({
      presenting: true,
      activeIsoformMode: 'expanded',
      activeLaneLimit: 8,
      atomicCommitCount: bodyBefore.atomicCommitCount + 1,
      broadVectorSubmissionCount: 0,
      runtimeCellCompileCount: 0,
      runtimeDurableWriteCount: 0,
      meshCreationCount: bodyBefore.meshCreationCount,
      shaderCreationCount: bodyBefore.shaderCreationCount,
      textureAdmissionCount: bodyBefore.textureAdmissionCount,
    });
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      runtimePolicy: nextPolicy,
      policyGeneration: 1,
    });
    expect(overlay.maxAnnotationLane).toBe(7);
    expect(overlay.maxCdsLane).toBe(-1);
    expect(overlay.hitTest(hitX, path.fwdStrandTop - 8, path, state())).toBeNull();
    expect(overlay.hitTest(hitX, path.fwdStrandTop - 24, path, state())).toMatchObject({
      payload: { id: 1, lane: 1 },
    });
    const debugAfter = overlay.getDebugSnapshot();
    expect(debugAfter.prepackedAnnotationSceneLayerCreates).toBe(
      debugBefore.prepackedAnnotationSceneLayerCreates
    );
    expect(debugAfter.prepackedAnnotationSceneGpuPreparations).toBe(
      debugBefore.prepackedAnnotationSceneGpuPreparations
    );
    expect(debugAfter.compiledBroadSurfaceRgbaAdmissions).toBe(
      debugBefore.compiledBroadSurfaceRgbaAdmissions
    );
    expect(debugAfter.compiledBroadSurfaceGpuPreuploads).toBe(
      debugBefore.compiledBroadSurfaceGpuPreuploads
    );
    overlay.destroy();
  });
});
