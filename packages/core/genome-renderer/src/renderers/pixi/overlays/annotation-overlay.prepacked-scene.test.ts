// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Renderer } from 'pixi.js';
import type {
  AnnotationPresentationSnapshot,
  AnnotationResidentPagePublication,
  Feature,
  Genome,
  RenderState,
} from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';
import type { AnnotationOverlay as AnnotationOverlayType } from './annotation-overlay';
import { overlayPresenterInternals } from './indexed-overlay-test-internals';
import {
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_LANE_STEP_PX,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_MIN_VISIBLE_BP,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  prepackedAnnotationSceneArtifactKey,
  type PrepackedAnnotationSceneLoadInput,
  type PrepackedAnnotationSceneBuildOptions,
} from '../overview/prepacked-annotation-scene';
import { compilePrepackedAnnotationScene } from '../overview/compile-prepacked-annotation-scene';
import { buildTranscriptGlyphBlocks } from '../overview/transcript-glyph-vertices';
import { getRetainedLinearTranscriptPackDebugSnapshot } from '../overview/retained-linear-transcript-layer';
import { buildPartitionedTranscriptScene } from '../overview/partitioned-transcript-scene';
import {
  buildAnnotationPolicyProjectionTableV1,
  decodeAnnotationPolicyProjectionFeatureV1,
} from '../overview/annotation-policy-projection-v1';
import {
  annotationPolicyLaneCenterOffsetPxV1,
  buildAnnotationPolicyGpuInstanceDataV1,
} from '../overview/annotation-policy-gpu-instances-v1';
import { buildAnnotationPolicyDirectSubmissionBankV1 } from '../overview/annotation-policy-direct-submission-bank-v1';
import { buildAnnotationPolicyDirectFineIndexV1 } from '../overview/annotation-policy-direct-fine-index-v1';
import { buildPrepackedAnnotationInteractionIndexV2 } from '../overview/prepacked-annotation-interaction-index-v2';
import {
  TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4,
  packGpuReadyPartitionedTranscriptSceneBinaryV4,
  scopeTrustedPartitionedTranscriptRendererAdmissionV4,
  unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4,
} from '../overview/partitioned-transcript-scene-binary-v4';
import {
  PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1,
  PREBUILT_ANNOTATION_RASTER_LANE_PROJECTION_V1,
  PREBUILT_ANNOTATION_RASTER_PRESENTATION_V1,
  PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1,
  PREBUILT_ANNOTATION_RASTERIZER_V1,
  prebuiltAnnotationRasterPresentationArtifactKeyV1,
  type PrebuiltAnnotationRasterLaneProjectionV1,
  type PrebuiltAnnotationRasterPresentationIdentityV1,
  type PrebuiltAnnotationRasterPresentationReceiptV1,
} from '../overview/prebuilt-annotation-raster-contract';
import { ANNOTATION_PREBUILT_RASTER_MESH_FILL_KNEE_FRACTION } from './annotation-lod-ownership';

const L = 3_088_269_832;
const CORRIDOR_SPANS = [
  L,
  Math.floor(L * ANNOTATION_PREBUILT_RASTER_MESH_FILL_KNEE_FRACTION),
  Math.floor(L * 0.25),
  150_000_000,
];

type PartitionedLayerModule = typeof import('../overview/partitioned-instanced-transcript-layer');
type PartitionedInstancedTranscriptLayerType = InstanceType<
  PartitionedLayerModule['PartitionedInstancedTranscriptLayer']
>;

let AnnotationOverlay: typeof AnnotationOverlayType;
let PartitionedInstancedTranscriptLayer: PartitionedLayerModule['PartitionedInstancedTranscriptLayer'];

beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
  ({ AnnotationOverlay } = await import('./annotation-overlay'));
  ({ PartitionedInstancedTranscriptLayer } =
    await import('../overview/partitioned-instanced-transcript-layer'));
});

beforeEach(() => {
  delete (globalThis as { __WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES?: boolean })
    .__WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES;
});

afterEach(() => {
  delete (globalThis as { __dna708OwnerAudit?: unknown }).__dna708OwnerAudit;
  delete (globalThis as { __DNA708_FORCE_DOUBLE_DRAW?: boolean }).__DNA708_FORCE_DOUBLE_DRAW;
  delete window.__webglDiagnosticsEnabled;
  delete window.__webglExposeForTests;
  vi.restoreAllMocks();
});

function genome(
  name = 'hg002-grch38',
  annotationLayerTypes: string[] = ['mRNA'],
  sourceIdentity = 'hg002-grch38-source',
  sourcePlacementProvenance: Genome['annotationSourcePlacementProvenance'] | null = {
    contract: PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1,
    sourceFingerprint: '0123456789abcdef01234567',
    placementFingerprint: 'ap1:0123456789abcdef01234567',
  }
): Genome {
  return {
    name,
    sourceIdentity,
    ...(sourcePlacementProvenance
      ? { annotationSourcePlacementProvenance: sourcePlacementProvenance }
      : {}),
    length: L,
    circular: false,
    annotationLayerTypes,
    annotationLayout: { maxAnnotationLane: 7, maxCdsLane: -1 },
    features: [
      {
        id: 41,
        type: 'mRNA',
        start: 1_544_000_000,
        end: 1_544_010_000,
        direction: 'forward',
        displayName: 'TX41',
        color: 0x3b82f6,
        lane: 0,
        annotationTrackLane: 0,
        exons: [{ start: 1_544_000_000, end: 1_544_010_000 }],
      },
      ...(annotationLayerTypes.includes('enhancer')
        ? [
            {
              id: 42,
              type: 'enhancer',
              start: 100_020_000,
              end: 100_025_000,
              direction: 'none' as const,
              displayName: 'ENH42',
              color: 0x22c55e,
              lane: 1,
            },
          ]
        : []),
    ],
  };
}

function sceneInput(
  overrides: Partial<PrepackedAnnotationSceneLoadInput['metadata']> = {},
  ownerKey = 'owner-a'
): PrepackedAnnotationSceneLoadInput {
  const scene: PrepackedAnnotationSceneLoadInput['scene'] = {
    families: [{ id: 'transcript', kind: 'transcript', metadata: {} }],
    featureFamilyIndices: new Uint32Array([0]),
    primitives: [
      {
        startBp: 1_544_000_000,
        endBp: 1_544_010_000,
        featureIndex: 0,
        offsetCenter: -7,
        halfH: 7,
        color: 0x3b82f6,
        alpha: 1,
        cdsFade: 0,
        dirSign: 1,
      },
    ],
  };
  return {
    ownerKey,
    scene,
    interactionIndex: buildPrepackedAnnotationInteractionIndexV2(
      [
        {
          rendererId: 41,
          startBp: 1_544_000_000,
          endBp: 1_544_010_000,
          lane: 0,
          direction: 'forward',
          displayName: 'TX41',
          type: 'mRNA',
          transcriptId: 'NM_TX41.1',
          sourceId: 'rna-TX41',
          canonicalIdentity: 'canonical-TX41',
        },
      ],
      scene.primitives
    ),
    metadata: {
      genomeIdentity: 'hg002-grch38-source',
      genomeLengthBp: L,
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
      ...overrides,
    },
  };
}

function runtimePolicySceneInput(): PrepackedAnnotationSceneLoadInput {
  const input = sceneInput({}, 'policy-neutral-owner');
  input.scene.primitives[0].offsetCenter = -23;
  input.interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
    [
      {
        rendererId: 41,
        startBp: 1_544_000_000,
        endBp: 1_544_010_000,
        lane: 1,
        direction: 'forward',
        displayName: 'TX41',
        type: 'mRNA',
        transcriptId: 'NM_TX41.1',
        sourceId: 'rna-TX41',
        canonicalIdentity: 'canonical-TX41',
      },
    ],
    input.scene.primitives
  );
  input.policyProjection = buildAnnotationPolicyProjectionTableV1({
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
  });
  input.policyGpuInstanceData = buildAnnotationPolicyGpuInstanceDataV1(
    new Uint32Array([0]),
    input.policyProjection
  );
  input.runtimePolicy = { isoformMode: 'expanded', laneLimit: null };
  return input;
}

function typedRuntimePolicySceneInput(input: {
  trackType: string;
  rendererId: number;
  ownerKey: string;
  displayName: string;
}): PrepackedAnnotationSceneLoadInput {
  const result = runtimePolicySceneInput();
  result.ownerKey = input.ownerKey;
  result.metadata.trackType = input.trackType;
  result.metadata.artifactKey = prepackedAnnotationSceneArtifactKey({
    themeMode: 'light',
    trackType: input.trackType,
  });
  result.interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
    [
      {
        rendererId: input.rendererId,
        startBp: 1_544_000_000,
        endBp: 1_544_010_000,
        lane: 0,
        direction: 'forward',
        displayName: input.displayName,
        type: input.trackType,
        transcriptId: `${input.displayName}.1`,
        sourceId: `${input.trackType}-source`,
        canonicalIdentity: `canonical-${input.trackType}`,
      },
    ],
    result.scene.primitives
  );
  result.policyProjection = buildAnnotationPolicyProjectionTableV1({
    features: [
      {
        annotationType: input.trackType,
        expandedLane: 0,
        expandedTrackLane: 0,
        canonicalLane: 0,
        canonicalTrackLane: 0,
      },
    ],
    expandedBandOrder: [input.trackType],
    canonicalBandOrder: [input.trackType],
  });
  result.policyGpuInstanceData = buildAnnotationPolicyGpuInstanceDataV1(
    new Uint32Array([0]),
    result.policyProjection
  );
  result.runtimePolicy = { isoformMode: 'canonical', laneLimit: 2 };
  return result;
}

function directBankSceneInput(
  input: PrepackedAnnotationSceneLoadInput
): PrepackedAnnotationSceneLoadInput {
  const gpuReadyScene =
    input.gpuReadyScene ??
    buildPartitionedTranscriptScene(input.scene.primitives, PREPACKED_ANNOTATION_PARTITION_SPAN_BP);
  const policyGpuInstanceData = input.policyGpuInstanceData;
  if (!policyGpuInstanceData) throw new Error('direct-bank fixture requires policy GPU data');
  input.gpuReadyScene = gpuReadyScene;
  input.submissionBank = buildAnnotationPolicyDirectSubmissionBankV1(
    gpuReadyScene,
    policyGpuInstanceData
  );
  const expandedFine = buildAnnotationPolicyDirectFineIndexV1(input.submissionBank.expanded, L);
  input.submissionFineIndices = {
    expanded: expandedFine,
    canonical: buildAnnotationPolicyDirectFineIndexV1(
      input.submissionBank.canonical,
      L,
      expandedFine.sourceTilePrimitiveCounts
    ),
  };
  delete input.policyGpuInstanceData;
  return input;
}

function compiledSourceShapeSceneInput(input: {
  trackType: string;
  rendererId: number;
  ownerKey: string;
  displayName: string;
  startBp?: number;
  endBp?: number;
  localLane?: number;
  direction?: Feature['direction'];
}): PrepackedAnnotationSceneLoadInput {
  const startBp = input.startBp ?? 1_544_004_000;
  const endBp = input.endBp ?? 1_544_006_000;
  const compiled = compilePrepackedAnnotationScene({
    ownerKey: input.ownerKey,
    features: [
      {
        id: input.rendererId,
        type: input.trackType,
        annotationTrackId: input.trackType,
        annotationTrackLane: input.localLane ?? 0,
        start: startBp,
        end: endBp,
        direction: input.direction ?? 'none',
        displayName: input.displayName,
        color: 0x22c55e,
        lane: input.localLane ?? 0,
        sourceId: `${input.trackType}-source-${input.rendererId}`,
      },
    ],
    metadata: {
      genomeIdentity: 'hg002-grch38-source',
      genomeLengthBp: L,
      partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
      artifactKey: prepackedAnnotationSceneArtifactKey({
        themeMode: 'light',
        trackType: input.trackType,
      }),
      themeMode: 'light',
      trackType: input.trackType,
      annotationBarHeightPx: PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
      laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
      mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
      geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
      interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
    },
  });
  compiled.policyProjection = buildAnnotationPolicyProjectionTableV1({
    features: [
      {
        annotationType: input.trackType,
        expandedLane: input.localLane ?? 0,
        expandedTrackLane: input.localLane ?? 0,
        canonicalLane: input.localLane ?? 0,
        canonicalTrackLane: input.localLane ?? 0,
      },
    ],
    expandedBandOrder: [input.trackType],
    canonicalBandOrder: [input.trackType],
  });
  compiled.policyGpuInstanceData = buildAnnotationPolicyGpuInstanceDataV1(
    compiled.gpuReadyScene?.featureIndices ?? new Uint32Array(),
    compiled.policyProjection
  );
  compiled.runtimePolicy = { isoformMode: 'canonical', laneLimit: 2 };
  return compiled;
}

function directBankRuntimePolicySceneInput(): PrepackedAnnotationSceneLoadInput {
  const input = sceneInput({}, 'direct-bank-owner');
  input.scene.primitives = [
    { ...input.scene.primitives[0], featureIndex: 0, offsetCenter: -87 },
    {
      ...input.scene.primitives[0],
      startBp: 1_544_020_000,
      endBp: 1_544_030_000,
      featureIndex: 1,
      offsetCenter: -7,
    },
    {
      ...input.scene.primitives[0],
      startBp: 1_544_040_000,
      endBp: 1_544_050_000,
      featureIndex: 2,
      offsetCenter: -39,
    },
  ];
  input.scene.featureFamilyIndices = new Uint32Array([0, 0, 0]);
  input.interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
    [
      {
        rendererId: 41,
        startBp: 1_544_000_000,
        endBp: 1_544_010_000,
        lane: 5,
        direction: 'forward',
        displayName: 'TX41',
        type: 'mRNA',
        transcriptId: 'NM_TX41.1',
        sourceId: 'rna-TX41',
        canonicalIdentity: 'canonical-TX41',
      },
      {
        rendererId: 42,
        startBp: 1_544_020_000,
        endBp: 1_544_030_000,
        lane: 0,
        direction: 'forward',
        displayName: 'TX42',
        type: 'mRNA',
        transcriptId: 'NM_TX42.1',
        sourceId: 'rna-TX42',
        canonicalIdentity: 'canonical-TX42',
      },
      {
        rendererId: 43,
        startBp: 1_544_040_000,
        endBp: 1_544_050_000,
        lane: 2,
        direction: 'forward',
        displayName: 'TX43',
        type: 'mRNA',
        transcriptId: 'NM_TX43.1',
        sourceId: 'rna-TX43',
        canonicalIdentity: 'canonical-TX43',
      },
    ],
    input.scene.primitives
  );
  input.policyProjection = buildAnnotationPolicyProjectionTableV1({
    features: [
      {
        annotationType: 'mRNA',
        expandedLane: 5,
        expandedTrackLane: 5,
        canonicalLane: null,
        canonicalTrackLane: null,
      },
      {
        annotationType: 'mRNA',
        expandedLane: 0,
        expandedTrackLane: 0,
        canonicalLane: 0,
        canonicalTrackLane: 0,
      },
      {
        annotationType: 'mRNA',
        expandedLane: 2,
        expandedTrackLane: 2,
        canonicalLane: 2,
        canonicalTrackLane: 2,
      },
    ],
    expandedBandOrder: ['mRNA'],
    canonicalBandOrder: ['mRNA'],
  });
  input.gpuReadyScene = buildPartitionedTranscriptScene(
    input.scene.primitives,
    PREPACKED_ANNOTATION_PARTITION_SPAN_BP
  );
  input.policyGpuInstanceData = buildAnnotationPolicyGpuInstanceDataV1(
    input.gpuReadyScene.featureIndices,
    input.policyProjection
  );
  input.runtimePolicy = { isoformMode: 'canonical', laneLimit: 2 };
  return directBankSceneInput(input);
}

async function trustedV4RuntimePolicySceneInput(): Promise<PrepackedAnnotationSceneLoadInput> {
  const source = sceneInput({}, 'trusted-v4-source');
  const sourceSha256 = 'a'.repeat(64);
  source.metadata.genomeIdentity = `assembly-annotation-source-sha256.v1:${sourceSha256}`;
  const sourceScene = buildPartitionedTranscriptScene(
    source.scene.primitives,
    PREPACKED_ANNOTATION_PARTITION_SPAN_BP
  );
  const policy = buildAnnotationPolicyProjectionTableV1({
    features: [
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
  });
  const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
    datasetContract: {
      datasetId: 'trusted-overlay-fixture',
      datasetVersion: 'v1',
      sourceSha256,
    },
    assemblyContract: { assemblyId: 'hg002-grch38-source', assemblyLengthBp: L },
    families: source.scene.families,
    featureFamilyIndices: source.scene.featureFamilyIndices,
    scene: sourceScene,
    interactionIndex: source.interactionIndex,
    policyProjection: {
      features: Array.from({ length: policy.featureCount }, (_, featureIndex) =>
        decodeAnnotationPolicyProjectionFeatureV1(policy, featureIndex)
      ),
      expandedBandOrder: policy.expandedBandTypeIndices.map(
        (typeIndex) => policy.annotationTypes[typeIndex]
      ),
      canonicalBandOrder: policy.canonicalBandTypeIndices.map(
        (typeIndex) => policy.annotationTypes[typeIndex]
      ),
    },
  });
  const direct = unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4(
    packed.manifest,
    packed.payload,
    TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4
  );
  const ownerKey = [
    'annotation-scene-owner.v3',
    'a'.repeat(24),
    packed.manifest.integrity.payloadSha256,
    source.metadata.artifactKey,
  ].join('\n');
  const scoped = scopeTrustedPartitionedTranscriptRendererAdmissionV4(
    direct.rendererAdmissionCapability,
    {
      provenance: direct.rendererAdmissionProvenance,
      scene: direct.scene,
      families: direct.families,
      featureFamilyIndices: direct.featureFamilyIndices,
      interactionIndex: direct.interactionIndex,
      policyProjection: direct.policyProjection,
      submissionBank: direct.submissionBank,
      submissionFineIndices: direct.submissionFineIndices,
    },
    {
      ownerKey,
      sceneContractSha256: direct.rendererAdmissionProvenance.contractSha256,
      ...source.metadata,
    }
  );
  return {
    ownerKey,
    scene: {
      primitives: [],
      families: direct.families,
      featureFamilyIndices: direct.featureFamilyIndices,
    },
    gpuReadyScene: direct.scene,
    interactionIndex: direct.interactionIndex,
    policyProjection: direct.policyProjection,
    submissionBank: direct.submissionBank,
    submissionFineIndices: direct.submissionFineIndices,
    trustedRendererAdmissionV4: scoped.capability,
    trustedRendererAdmissionProvenanceV4: direct.rendererAdmissionProvenance,
    trustedRendererAdmissionLoadIdentityV4: scoped.loadIdentity,
    runtimePolicy: { isoformMode: 'canonical', laneLimit: 2 },
    metadata: source.metadata,
  };
}

function exactExpandedRasterReceipt(
  overrides: Partial<PrebuiltAnnotationRasterPresentationIdentityV1> = {}
): PrebuiltAnnotationRasterPresentationReceiptV1 {
  const identity: PrebuiltAnnotationRasterPresentationIdentityV1 = {
    contract: PREBUILT_ANNOTATION_RASTER_PRESENTATION_V1,
    sourceValidationContract: PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1,
    genomeIdentity: 'hg002-grch38-source',
    genomeLengthBp: L,
    sourceFingerprint: '0123456789abcdef01234567',
    placementFingerprint: 'ap1:0123456789abcdef01234567',
    trackType: 'mRNA',
    isoformMode: 'expanded',
    laneLimit: null,
    layerTypes: ['mRNA'],
    maxAnnotationLane: 1,
    maxCdsLane: -1,
    themeMode: 'light',
    laneArtifactContract: PREBUILT_ANNOTATION_RASTER_LANE_ARTIFACT_V1,
    annotationBarHeightPx: PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
    laneStepPx: PREPACKED_ANNOTATION_LANE_STEP_PX,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    rasterizerContractToken: PREBUILT_ANNOTATION_RASTERIZER_V1,
    ...overrides,
  };
  return {
    artifactKey: prebuiltAnnotationRasterPresentationArtifactKeyV1(identity),
    ...identity,
  };
}

function exactExpandedRasterProjection(
  laneLimit: number | null,
  sourceMaxAnnotationLane = 1
): PrebuiltAnnotationRasterLaneProjectionV1 {
  const sourceHeightPx = (sourceMaxAnnotationLane + 1) * PREPACKED_ANNOTATION_LANE_STEP_PX;
  const presentedHeightPx =
    laneLimit === null ? sourceHeightPx : laneLimit * PREPACKED_ANNOTATION_LANE_STEP_PX;
  return {
    contract: PREBUILT_ANNOTATION_RASTER_LANE_PROJECTION_V1,
    laneLimit,
    sourceHeightPx,
    sourceSpineOffsetPx: sourceHeightPx - 1,
    sourceMaxAnnotationLane,
    presentedHeightPx,
    presentedSpineOffsetPx: presentedHeightPx - 1,
  };
}

function buildOptions(
  overrides: Partial<PrepackedAnnotationSceneBuildOptions> = {}
): PrepackedAnnotationSceneBuildOptions {
  return {
    ownerKey: 'built-owner-a',
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
    ...overrides,
  };
}

function multiExonGenome(
  sourceIdentity = 'hg002-grch38-source',
  annotationLayerTypes: string[] = ['mRNA']
): Genome {
  return {
    ...genome('hg002-grch38', annotationLayerTypes, sourceIdentity),
    features: [
      {
        id: 501,
        type: 'mRNA',
        start: 1_500_000_000,
        end: 1_500_004_000,
        direction: 'forward',
        displayName: 'FWD',
        color: 0x3b82f6,
        lane: 0,
        annotationTrackLane: 0,
        exons: [
          { start: 1_500_000_001, end: 1_500_001_000 },
          { start: 1_500_003_001, end: 1_500_004_000 },
        ],
        cds: [
          { start: 1_500_000_401, end: 1_500_000_900 },
          { start: 1_500_003_101, end: 1_500_003_800 },
        ],
      },
      {
        id: 502,
        type: 'mRNA',
        start: 1_550_000_000,
        end: 1_550_006_000,
        direction: 'reverse',
        displayName: 'REV',
        color: 0x3b82f6,
        lane: 1,
        annotationTrackLane: 1,
        exons: [
          { start: 1_550_000_001, end: 1_550_002_000 },
          { start: 1_550_004_001, end: 1_550_006_000 },
        ],
        cds: [{ start: 1_550_000_801, end: 1_550_005_500 }],
      },
    ],
  };
}

function state(themeMode: 'light' | 'dark' = 'light'): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 1600,
    height: 500,
    themeMode,
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

function pathForSpan(span: number): PathMapper {
  const start = Math.floor((L - span) / 2);
  const ppb = 1600 / span;
  return {
    isArcMode: false,
    pixelsPerBp: ppb,
    viewStartBp: start,
    viewEndBp: start + span,
    fwdStrandTop: 160,
    bpLeftX: (bp: number) => (bp - start) * ppb,
    bpToScreenX: (bp: number) => (bp - start) * ppb,
    bpCenterX: (bp: number) => (bp - start) * ppb,
    featureLabelPosAt: (bp: number, offset: number) => ({
      x: (bp - start) * ppb,
      y: 160 + offset,
      z: 0,
    }),
    featurePolygonAt: () => [],
  } as unknown as PathMapper;
}

function layout(): UnifiedLayout {
  return {
    annotationTop: 0,
    annotationHeight: 128,
    annotationOffset: -8,
    annotationStep: 16,
    sequenceRevealProgress: 0,
    cdsBarOffset: -8,
    cdsLaneStep: 16,
    fwdStrandTop: 160,
    revStrandBottom: 190,
    rulerY: 210,
    totalHeight: 240,
    offset: 0,
  } as UnifiedLayout;
}

function webglRenderer(): Renderer {
  return {
    type: 1,
    shader: { bind: vi.fn(), resetState: vi.fn() },
    geometry: { bind: vi.fn(), resetState: vi.fn() },
  } as unknown as Renderer;
}

function webgpuRenderer(): Renderer {
  return { type: 2 } as unknown as Renderer;
}

function prepare(overlay: AnnotationOverlayType, g = genome()): void {
  overlay.setRenderer(webglRenderer());
  overlay.loadGenome(g);
  overlay.setLayout(layout());
}

describe('AnnotationOverlay guarded prepacked full-assembly owner', () => {
  it('ingests exact page deltas without rebuilding the flat assembly graph while prepacked owns the track', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    expect(overlay.loadPrepackedAnnotationScene(sceneInput({}, 'resident-page-owner'))).toBe(true);
    const path = pathForSpan(150_000_000);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );

    const flatCompatibilityFeatures: Feature[] = Array.from({ length: 200 }, (_, index) => ({
      id: 10_000 + index,
      type: 'mRNA',
      start: 100_000 + index * 1_000,
      end: 100_500 + index * 1_000,
      direction: 'forward',
      displayName: `compat-${index}`,
      color: 0x3b82f6,
      lane: index % 12,
      canonicalIdentity: `compat-${index}`,
    }));
    const publication = (
      generation: number,
      pageIndex: number
    ): AnnotationResidentPagePublication => {
      const ownerStartBp = 1_544_000_000 + pageIndex * 512 * 1024;
      const pageFeature: Feature = {
        id: 20_000 + pageIndex,
        type: 'mRNA',
        start: ownerStartBp + 100,
        end: ownerStartBp + 10_000,
        direction: 'forward',
        displayName: `page-${pageIndex}`,
        color: 0x3b82f6,
        lane: 0,
        annotationTrackId: 'mRNA',
        annotationTrackLane: 0,
        annotationTrackLaneCapacity: 12,
        canonicalIdentity: `page-${pageIndex}`,
      };
      return {
        contract: 'annotation-resident-page-publication.v1',
        sourceIdentity: 'hg002-grch38-source',
        genomeLengthBp: L,
        policyKey: 'mRNA:canonical:12',
        generation,
        requestedLayerTypes: ['mRNA'],
        exactCoverage: [{ startBp: ownerStartBp, endBp: ownerStartBp + 512 * 1024 }],
        pages: [
          {
            contract: 'annotation-presentation-page.v1',
            pageKey: `mRNA-page-${pageIndex}`,
            chromosomeId: `placement-${pageIndex}`,
            trackId: 'mRNA',
            trackOrder: 0,
            laneCapacity: 12,
            ownerStartBp,
            ownerEndBp: ownerStartBp + 512 * 1024,
            maxFeatureEndBp: ownerStartBp + 512 * 1024,
            contentRevision: `revision-${pageIndex}`,
            features: [pageFeature],
          },
        ],
      };
    };

    expect(overlay.ingestAnnotationResidentPages(publication(1, 0))).toMatchObject({
      status: 'applied',
    });
    expect(overlay.ingestAnnotationResidentPages(publication(2, 1))).toMatchObject({
      status: 'applied',
    });
    expect(overlay.getDebugSnapshot()).toMatchObject({
      featureCount: 1,
      residentAnnotationPageCount: 2,
      residentAnnotationPageSnapshotApplies: 2,
      residentAnnotationPageFlatGraphSkips: 2,
    });
    expect(overlay.maxAnnotationLane).toBe(7);
    expect(overlay.maxCdsLane).toBe(-1);
    const pageState = publication(3, 2);
    const flatCompatibility: AnnotationPresentationSnapshot = {
      contract: 'annotation-presentation-snapshot.v1',
      sourceIdentity: pageState.sourceIdentity,
      genomeLengthBp: pageState.genomeLengthBp,
      policyKey: 'mRNA:compatibility-flat',
      generation: 0,
      features: flatCompatibilityFeatures,
      requestedLayerTypes: pageState.requestedLayerTypes,
      layout: { maxAnnotationLane: 11, maxCdsLane: -1 },
      exactCoverage: pageState.exactCoverage,
    };
    expect(overlay.setAnnotationFlatPresentationSnapshot(flatCompatibility).status).toBe('applied');
    expect(overlay.maxAnnotationLane).toBe(11);
    overlay.destroy();
  });

  it('projects resident detail carriers through the active canonical and lane-limit policy', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    expect(overlay.loadPrepackedAnnotationScene(directBankRuntimePolicySceneInput())).toBe(true);
    const feature = (
      id: number,
      start: number,
      end: number,
      canonicalIdentity: string,
      expandedLane: number
    ): Feature => ({
      id,
      type: 'mRNA',
      annotationTrackId: 'mRNA',
      annotationTrackLane: expandedLane,
      annotationTrackLaneCapacity: 12,
      start,
      end,
      direction: 'forward',
      displayName: `TX${id}`,
      color: 0x3b82f6,
      lane: expandedLane,
      transcriptId: `NM_TX${id}.1`,
      sourceId: `resident-source-TX${id}`,
      canonicalIdentity: `resident-${canonicalIdentity}`,
      exons: [{ start: start + 1, end }],
      cds: [{ start: start + 1, end }],
    });
    const residentFeatures = [
      feature(41, 1_544_000_000, 1_544_010_000, 'canonical-TX41', 5),
      feature(42, 1_544_020_000, 1_544_030_000, 'canonical-TX42', 0),
      feature(43, 1_544_040_000, 1_544_050_000, 'canonical-TX43', 2),
    ];
    expect(
      overlay.ingestAnnotationResidentPages({
        contract: 'annotation-resident-page-publication.v1',
        sourceIdentity: 'hg002-grch38-source',
        genomeLengthBp: L,
        policyKey: 'source-pages:mRNA',
        generation: 0,
        requestedLayerTypes: ['mRNA'],
        exactCoverage: [{ startBp: 1_544_000_000, endBp: 1_544_512_000 }],
        pages: [
          {
            contract: 'annotation-presentation-page.v1',
            pageKey: 'mRNA:detail-policy-page',
            chromosomeId: 'chr-detail',
            trackId: 'mRNA',
            trackOrder: 0,
            laneCapacity: 12,
            ownerStartBp: 1_544_000_000,
            ownerEndBp: 1_544_512_000,
            maxFeatureEndBp: 1_544_512_000,
            contentRevision: 'detail-policy-v1',
            features: residentFeatures,
          },
        ],
      })
    ).toMatchObject({ status: 'applied' });

    const canonical = overlay.selectResidentAnnotationFeaturesForViewport(
      1_544_000_000,
      1_544_060_000
    );
    expect(canonical.status).toBe('ready');
    expect(canonical.features.map(({ id, lane }) => ({ id, lane }))).toEqual([{ id: 42, lane: 0 }]);

    const focusedDurablyVisible = overlay.selectResidentAnnotationFeaturesForViewport(
      1_544_000_000,
      1_544_060_000,
      {
        trackId: 'mRNA',
        canonicalIdentity: 'canonical-TX42',
        presentation: 'temporary-additional-lane',
      }
    );
    expect(
      focusedDurablyVisible.features.map(({ id, lane, annotationTrackLaneCapacity }) => ({
        id,
        lane,
        annotationTrackLaneCapacity,
      }))
    ).toEqual([{ id: 42, lane: 0, annotationTrackLaneCapacity: 12 }]);

    const temporaryLane = overlay.maxAnnotationLane + 1;
    const focusedPolicyHidden = overlay.selectResidentAnnotationFeaturesForViewport(
      1_544_000_000,
      1_544_060_000,
      {
        trackId: 'mRNA',
        canonicalIdentity: 'canonical-TX41',
        presentation: 'temporary-additional-lane',
      }
    );
    expect(focusedPolicyHidden.key).not.toBe(canonical.key);
    expect(
      focusedPolicyHidden.features.map(({ id, lane, annotationTrackLane, canonicalIdentity }) => ({
        id,
        lane,
        annotationTrackLane,
        canonicalIdentity,
      }))
    ).toEqual([
      {
        id: 41,
        lane: temporaryLane,
        annotationTrackLane: 0,
        canonicalIdentity: 'canonical-TX41',
      },
      {
        id: 42,
        lane: 0,
        annotationTrackLane: 0,
        canonicalIdentity: 'resident-canonical-TX42',
      },
    ]);
    expect(residentFeatures[0]).toMatchObject({
      lane: 5,
      annotationTrackLane: 5,
      canonicalIdentity: 'resident-canonical-TX41',
    });
    const canonicalAfterFocus = overlay.selectResidentAnnotationFeaturesForViewport(
      1_544_000_000,
      1_544_060_000
    );
    expect(canonicalAfterFocus.features.map(({ id, lane }) => ({ id, lane }))).toEqual([
      { id: 42, lane: 0 },
    ]);

    expect(overlay.updatePrepackedAnnotationPolicy({ isoformMode: 'expanded', laneLimit: 3 })).toBe(
      true
    );
    const finiteExpanded = overlay.selectResidentAnnotationFeaturesForViewport(
      1_544_000_000,
      1_544_060_000
    );
    expect(finiteExpanded.key).not.toBe(canonical.key);
    expect(finiteExpanded.features.map(({ id, lane }) => ({ id, lane }))).toEqual([
      { id: 42, lane: 0 },
      { id: 43, lane: 2 },
    ]);

    expect(
      overlay.updatePrepackedAnnotationPolicy({ isoformMode: 'expanded', laneLimit: null })
    ).toBe(true);
    const uncappedExpanded = overlay.selectResidentAnnotationFeaturesForViewport(
      1_544_000_000,
      1_544_060_000
    );
    expect(uncappedExpanded.features.map(({ id, lane }) => ({ id, lane }))).toEqual([
      { id: 41, lane: 5 },
      { id: 42, lane: 0 },
      { id: 43, lane: 2 },
    ]);
    overlay.destroy();
  });

  it('withholds an exact-detail direct bank until its fine view is prepared off the camera path', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    expect(overlay.loadPrepackedAnnotationScene(directBankRuntimePolicySceneInput())).toBe(true);
    const path = pathForSpan(512 * 1024);
    const renderState = state();

    overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 });
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStatus: 'fine-view-pending',
      prepackedAnnotationSceneVisiblePartitionCount: 0,
      prepackedAnnotationSceneVisibleInstanceCount: 0,
    });

    expect(
      overlay.preparePrepackedAnnotationFineViews(path.viewStartBp, path.viewEndBp, 'light')
    ).toEqual({
      status: 'complete',
      preparedOwnerKey: 'direct-bank-owner',
      pendingOwnerCount: 0,
    });
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    const resident = (
      overlayPresenterInternals(overlay) as unknown as {
        prepackedAnnotationSceneResidents: Map<
          string,
          { layer: PartitionedInstancedTranscriptLayerType }
        >;
      }
    ).prepackedAnnotationSceneResidents.get('direct-bank-owner');
    expect(resident?.layer.getFineViewDebug()).toMatchObject({
      presentationMode: 'fine',
      fineViewFallbackCount: 0,
    });
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStatus: 'eligible',
      prepackedAnnotationSceneVisibleResidentOwnerKeys: ['direct-bank-owner'],
    });
    overlay.destroy();
  });

  it('withholds a viewport packet at every LOD until the complete fine roster is admitted', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    expect(overlay.loadPrepackedAnnotationScene(directBankRuntimePolicySceneInput())).toBe(true);
    const internals = overlayPresenterInternals(overlay) as unknown as {
      prepackedAnnotationSceneResidents: Map<
        string,
        {
          viewportDetailPresentationAdmitted: boolean;
          input: { viewportDetail?: { coverageStartBp: number; coverageEndBp: number } };
        }
      >;
    };
    const resident = internals.prepackedAnnotationSceneResidents.get('direct-bank-owner')!;
    resident.viewportDetailPresentationAdmitted = false;
    resident.input.viewportDetail = { coverageStartBp: 0, coverageEndBp: L };

    overlay.updateRetainedCamera({
      path: pathForSpan(20_000_000),
      state: state(),
      yOffset: 0,
      height: 500,
    });
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneVisibleResidentOwnerKeys).toEqual([]);

    const finePath = pathForSpan(512 * 1024);
    expect(
      overlay.preparePrepackedAnnotationFineViews(finePath.viewStartBp, finePath.viewEndBp, 'light')
    ).toMatchObject({ status: 'complete', pendingOwnerCount: 0 });
    expect(
      overlay.admitPrepackedAnnotationViewportDetailRoster(
        finePath.viewStartBp,
        finePath.viewEndBp,
        'light'
      )
    ).toBe(true);
    expect(
      overlay.updateRetainedCamera({ path: finePath, state: state(), yOffset: 0, height: 500 })
    ).toBe(true);
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneVisibleResidentOwnerKeys).toEqual([
      'direct-bank-owner',
    ]);
    overlay.destroy();
  });

  it('prepares every selected direct-bank annotation type fairly before exact presentation', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, genome('hg002-grch38', ['mRNA', 'enhancer']));
    const mrna = directBankRuntimePolicySceneInput();
    mrna.ownerKey = 'fine-mrna';
    const enhancer = directBankSceneInput(
      typedRuntimePolicySceneInput({
        trackType: 'enhancer',
        rendererId: 47,
        ownerKey: 'fine-enhancer',
        displayName: 'ENH47',
      })
    );
    expect(overlay.preparePrepackedAnnotationScene(mrna)).toBe(true);
    expect(overlay.preparePrepackedAnnotationScene(enhancer)).toBe(true);
    const path = pathForSpan(512 * 1024);
    const preparedOwners = new Set<string>();

    const first = overlay.preparePrepackedAnnotationFineViews(
      path.viewStartBp,
      path.viewEndBp,
      'light'
    );
    if (first.preparedOwnerKey) preparedOwners.add(first.preparedOwnerKey);
    expect(first.pendingOwnerCount).toBe(1);
    const second = overlay.preparePrepackedAnnotationFineViews(
      path.viewStartBp,
      path.viewEndBp,
      'light'
    );
    if (second.preparedOwnerKey) preparedOwners.add(second.preparedOwnerKey);
    expect(second.pendingOwnerCount).toBe(0);
    expect(preparedOwners).toEqual(new Set(['fine-mrna', 'fine-enhancer']));

    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    const residents = (
      overlayPresenterInternals(overlay) as unknown as {
        prepackedAnnotationSceneResidents: Map<
          string,
          { layer: PartitionedInstancedTranscriptLayerType }
        >;
      }
    ).prepackedAnnotationSceneResidents;
    expect(residents.get('fine-mrna')?.layer.getFineViewDebug().presentationMode).toBe('fine');
    expect(residents.get('fine-enhancer')?.layer.getFineViewDebug().presentationMode).toBe('fine');
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneVisibleResidentOwnerKeys: ['fine-enhancer', 'fine-mrna'],
    });
    overlay.destroy();
  });

  it('renders a spliced non-CDS RNA from resident pages without routing it through the mRNA policy', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, { ...genome(), features: [], annotationExactCoverage: [] });
    expect(overlay.loadPrepackedAnnotationScene(directBankRuntimePolicySceneInput())).toBe(true);

    const ownerStartBp = Math.floor(L / 2) - 256 * 1024;
    const transcriptStartBp = Math.floor(L / 2) - 24_000;
    const lncRna: Feature = {
      id: 44,
      type: 'lnc_RNA',
      annotationTrackId: 'lnc_RNA',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 12,
      start: transcriptStartBp,
      end: transcriptStartBp + 48_000,
      direction: 'reverse',
      displayName: 'LNC44',
      color: 0x9b59b6,
      lane: 32,
      transcriptId: 'LNC44.1',
      canonicalIdentity: 'resident-lnc44',
      exons: [
        { start: transcriptStartBp, end: transcriptStartBp + 6_000 },
        { start: transcriptStartBp + 20_000, end: transcriptStartBp + 28_000 },
        { start: transcriptStartBp + 42_000, end: transcriptStartBp + 48_000 },
      ],
      cds: [],
    };
    expect(
      overlay.ingestAnnotationResidentPages({
        contract: 'annotation-resident-page-publication.v1',
        sourceIdentity: 'hg002-grch38-source',
        genomeLengthBp: L,
        policyKey: 'source-pages:lnc_RNA+mRNA',
        generation: 1,
        requestedLayerTypes: ['lnc_RNA', 'mRNA'],
        exactCoverage: [{ startBp: ownerStartBp, endBp: ownerStartBp + 512 * 1024 }],
        pages: [
          {
            contract: 'annotation-presentation-page.v1',
            pageKey: 'mRNA:detail-page',
            chromosomeId: 'chr-detail',
            trackId: 'mRNA',
            trackOrder: 0,
            laneCapacity: 12,
            ownerStartBp,
            ownerEndBp: ownerStartBp + 512 * 1024,
            maxFeatureEndBp: ownerStartBp + 512 * 1024,
            contentRevision: 'mrna-empty-detail-v1',
            features: [],
          },
          {
            contract: 'annotation-presentation-page.v1',
            pageKey: 'lnc_RNA:detail-page',
            chromosomeId: 'chr-detail',
            trackId: 'lnc_RNA',
            trackOrder: 2,
            laneCapacity: 12,
            ownerStartBp,
            ownerEndBp: ownerStartBp + 512 * 1024,
            maxFeatureEndBp: ownerStartBp + 512 * 1024,
            contentRevision: 'lnc-detail-v1',
            features: [lncRna],
          },
        ],
      })
    ).toMatchObject({ status: 'applied' });

    const selected = overlay.selectResidentAnnotationFeaturesForViewport(
      transcriptStartBp,
      transcriptStartBp + 48_000
    );
    expect(selected.status).toBe('ready');
    expect(selected.features.map(({ id, lane }) => ({ id, lane }))).toEqual([{ id: 44, lane: 3 }]);
    expect(lncRna.lane).toBe(32);
    expect(selected.features[0]?.exons).toHaveLength(3);
    expect(selected.features[0]?.cds).toEqual([]);
    expect(overlay.maxAnnotationLane).toBe(3);

    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(234_000),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      retainedLinearTranscriptVisibleFeatureCount: 1,
    });
    expect(overlay.getDebugSnapshot().retainedLinearTranscriptBlockCount).toBeGreaterThan(3);
    overlay.destroy();
  });

  it('projects every selected resident track into one compact detail stack without a singular owner', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, {
      ...genome('hg002-grch38', ['mRNA', 'lnc_RNA', 'enhancer']),
      features: [],
      annotationExactCoverage: [],
    });
    expect(
      overlay.preparePrepackedAnnotationScene(
        typedRuntimePolicySceneInput({
          trackType: 'mRNA',
          rendererId: 41,
          ownerKey: 'detail-mrna-resident',
          displayName: 'MRNA41',
        })
      )
    ).toBe(true);
    expect(
      overlay.preparePrepackedAnnotationScene(
        typedRuntimePolicySceneInput({
          trackType: 'lnc_RNA',
          rendererId: 44,
          ownerKey: 'detail-lncrna-resident',
          displayName: 'LNC44',
        })
      )
    ).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: null,
      loaded: false,
      runtimePolicy: { isoformMode: 'canonical', laneLimit: 2 },
    });

    const ownerStartBp = 1_543_900_000;
    const ownerEndBp = 1_544_512_000;
    const mrna: Feature = {
      id: 41,
      type: 'mRNA',
      annotationTrackId: 'mRNA',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 12,
      start: 1_544_000_000,
      end: 1_544_010_000,
      direction: 'forward',
      displayName: 'MRNA41',
      color: 0x3b82f6,
      lane: 72,
      transcriptId: 'MRNA41.1',
      sourceId: 'mRNA-source',
      canonicalIdentity: 'canonical-mRNA',
      exons: [
        { start: 1_544_000_000, end: 1_544_003_000 },
        { start: 1_544_007_000, end: 1_544_010_000 },
      ],
      cds: [{ start: 1_544_000_300, end: 1_544_009_700 }],
    };
    const lncRna: Feature = {
      id: 44,
      type: 'lnc_RNA',
      annotationTrackId: 'lnc_RNA',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 12,
      start: 1_544_000_000,
      end: 1_544_010_000,
      direction: 'forward',
      displayName: 'LNC44',
      color: 0x9b59b6,
      lane: 104,
      transcriptId: 'LNC44.1',
      sourceId: 'lnc_RNA-source',
      canonicalIdentity: 'canonical-lnc_RNA',
      exons: [
        { start: 1_544_000_000, end: 1_544_002_000 },
        { start: 1_544_008_000, end: 1_544_010_000 },
      ],
      cds: [],
    };
    const enhancer: Feature = {
      id: 47,
      type: 'enhancer',
      annotationTrackId: 'enhancer',
      annotationTrackLane: 1,
      annotationTrackLaneCapacity: 12,
      start: 1_544_004_000,
      end: 1_544_006_000,
      direction: 'none',
      displayName: 'ENH47',
      color: 0x22c55e,
      lane: 131,
      canonicalIdentity: 'canonical-enhancer',
    };
    const sourceLanes = [mrna.lane, lncRna.lane, enhancer.lane];

    expect(
      overlay.ingestAnnotationResidentPages({
        contract: 'annotation-resident-page-publication.v1',
        sourceIdentity: 'hg002-grch38-source',
        genomeLengthBp: L,
        policyKey: 'source-pages:mRNA+lnc_RNA+enhancer',
        generation: 1,
        requestedLayerTypes: ['mRNA', 'lnc_RNA', 'enhancer'],
        exactCoverage: [{ startBp: ownerStartBp, endBp: ownerEndBp }],
        pages: [
          {
            contract: 'annotation-presentation-page.v1',
            pageKey: 'mRNA:compact-detail-page',
            chromosomeId: 'chr-detail',
            trackId: 'mRNA',
            trackOrder: 0,
            laneCapacity: 12,
            ownerStartBp,
            ownerEndBp,
            maxFeatureEndBp: ownerEndBp,
            contentRevision: 'compact-detail-v1',
            features: [mrna],
          },
          {
            contract: 'annotation-presentation-page.v1',
            pageKey: 'lnc_RNA:compact-detail-page',
            chromosomeId: 'chr-detail',
            trackId: 'lnc_RNA',
            trackOrder: 1,
            laneCapacity: 12,
            ownerStartBp,
            ownerEndBp,
            maxFeatureEndBp: ownerEndBp,
            contentRevision: 'compact-detail-v1',
            features: [lncRna],
          },
          {
            contract: 'annotation-presentation-page.v1',
            pageKey: 'enhancer:compact-detail-page',
            chromosomeId: 'chr-detail',
            trackId: 'enhancer',
            trackOrder: 2,
            laneCapacity: 12,
            ownerStartBp,
            ownerEndBp,
            maxFeatureEndBp: ownerEndBp,
            contentRevision: 'compact-detail-v1',
            features: [enhancer],
          },
        ],
      })
    ).toMatchObject({ status: 'applied' });

    const selected = overlay.selectResidentAnnotationFeaturesForViewport(
      1_544_000_000,
      1_544_010_000
    );
    expect(selected.status).toBe('ready');
    expect(selected.features.map(({ id, lane }) => ({ id, lane }))).toEqual([
      { id: 41, lane: 0 },
      { id: 44, lane: 2 },
      { id: 47, lane: 5 },
    ]);
    expect([mrna.lane, lncRna.lane, enhancer.lane]).toEqual(sourceLanes);
    expect(selected.features.find(({ id }) => id === 41)?.cds).toHaveLength(1);
    expect(selected.features.find(({ id }) => id === 44)?.cds).toEqual([]);
    const projectedTranscriptOffsets = new WeakMap<object, number>(
      selected.features.map((feature) => [feature, -7 - feature.lane * 16])
    );
    expect(
      buildTranscriptGlyphBlocks(
        selected.features.filter(({ exons }) => (exons?.length ?? 0) > 0),
        {
          getOffset: (feature) => projectedTranscriptOffsets.get(feature) ?? null,
          halfHeight: 7,
          themeMode: 'light',
          cdsDetail: 1,
        }
      ).length
    ).toBeGreaterThan(4);

    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(234_000),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.maxAnnotationLane).toBe(4);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      retainedLinearTranscriptVisibleFeatureCount: 2,
    });
    overlay.destroy();
  });

  it('prepares an inactive expanded owner without disturbing canonical, then presents it on the next camera frame without another upload', () => {
    const prepareGpu = vi.spyOn(
      PartitionedInstancedTranscriptLayer.prototype,
      'prepareGpuResources'
    );
    const updateVisibleRange = vi.spyOn(
      PartitionedInstancedTranscriptLayer.prototype,
      'updateVisibleRange'
    );
    const updateCamera = vi.spyOn(PartitionedInstancedTranscriptLayer.prototype, 'updateCamera');
    const overlay = new AnnotationOverlay();
    prepare(overlay, { ...genome(), features: [], annotationExactCoverage: [] });
    const canonical = sceneInput({}, 'prepared-canonical');
    const expanded = sceneInput({}, 'prepared-expanded');
    expanded.interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
      [
        {
          rendererId: 84,
          startBp: 1_544_000_000,
          endBp: 1_544_010_000,
          lane: 0,
          direction: 'forward',
          displayName: 'EXPANDED',
          type: 'mRNA',
          transcriptId: 'NM_EXPANDED.1',
          sourceId: 'rna-EXPANDED',
          canonicalIdentity: 'prepared-expanded-feature',
        },
      ],
      expanded.scene.primitives
    );
    const path = pathForSpan(200_000_000);
    const hitX = path.bpLeftX(1_544_005_000);
    const hitY = path.fwdStrandTop - 8;

    expect(overlay.loadPrepackedAnnotationScene(canonical)).toBe(true);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    const canonicalOwner = overlay.getPrepackedAnnotationSceneOwnerSnapshot();
    expect(overlay.preparePrepackedAnnotationScene(expanded)).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toEqual(canonicalOwner);
    expect(overlay.hitTest(hitX, hitY, path, state())).toMatchObject({ payload: { id: 41 } });
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneResidentOwnerCount: 2,
      prepackedAnnotationScenePreparedOwnerKeys: ['prepared-canonical', 'prepared-expanded'],
      prepackedAnnotationSceneVisibleResidentOwnerKeys: ['prepared-canonical'],
      prepackedAnnotationSceneLayerCreates: 2,
      prepackedAnnotationSceneGpuPreparations: 2,
      prepackedAnnotationSceneLayerDestroys: 0,
    });

    overlay.setLayout({ ...layout(), annotationOffset: -24 });
    const latestPath = pathForSpan(150_000_000);
    expect(
      overlay.updateRetainedCamera({
        path: latestPath,
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    const latestHitX = latestPath.bpLeftX(1_544_005_000);
    const latestHitY = latestPath.fwdStrandTop - 24;
    expect(overlay.hitTest(latestHitX, latestHitY, latestPath, state())).toMatchObject({
      payload: { id: 41 },
    });

    const activationBaseline = {
      prepareGpu: prepareGpu.mock.calls.length,
      updateVisibleRange: updateVisibleRange.mock.calls.length,
      updateCamera: updateCamera.mock.calls.length,
      debug: overlay.getDebugSnapshot(),
    };
    expect(overlay.activatePrepackedAnnotationScene('prepared-expanded')).toBe(true);
    expect(prepareGpu).toHaveBeenCalledTimes(activationBaseline.prepareGpu);
    expect(updateVisibleRange).toHaveBeenCalledTimes(activationBaseline.updateVisibleRange);
    expect(updateCamera).toHaveBeenCalledTimes(activationBaseline.updateCamera);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: 'prepared-expanded',
      ownerGeneration: canonicalOwner.ownerGeneration + 1,
      loaded: true,
      gpuPrepared: true,
    });
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneVisibleResidentOwnerKeys).toEqual([
      'prepared-canonical',
    ]);
    expect(
      overlay.updateRetainedCamera({
        path: latestPath,
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneVisibleResidentOwnerKeys: ['prepared-expanded'],
      prepackedAnnotationSceneLayerCreates:
        activationBaseline.debug.prepackedAnnotationSceneLayerCreates,
      prepackedAnnotationSceneGpuPreparations:
        activationBaseline.debug.prepackedAnnotationSceneGpuPreparations,
      prepackedAnnotationSceneLayerDestroys:
        activationBaseline.debug.prepackedAnnotationSceneLayerDestroys,
    });
    expect(overlay.hitTest(latestHitX, latestHitY, latestPath, state())).toMatchObject({
      payload: { id: 84 },
    });
    overlay.destroy();
  });

  it('keeps the complete prepacked mRNA body owner when exact detail decorations cover the camera', () => {
    const span = PREPACKED_ANNOTATION_MIN_VISIBLE_BP - 1;
    const path = pathForSpan(span);
    const overlay = new AnnotationOverlay();
    prepare(overlay, { ...genome(), annotationExactCoverage: [] });
    expect(overlay.loadPrepackedAnnotationScene(sceneInput({}, 'coverage-handoff-owner'))).toBe(
      true
    );

    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    expect(
      overlay
        .getDebugSnapshot()
        .annotationPresentationOwners.filter((owner) => owner.visible)
        .map((owner) => owner.ownerId)
    ).toEqual(['prepacked-partitioned-vector-surface']);
    const settledBodyBuilds = overlay.getDebugSnapshot().retainedLinearTranscriptBuilds;

    overlay.loadGenome({
      ...genome(),
      annotationExactCoverage: [{ startBp: path.viewStartBp, endBp: path.viewEndBp }],
    });
    overlay.setLayout(layout());
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    const debug = overlay.getDebugSnapshot();
    const visibleOwners = debug.annotationPresentationOwners.filter((owner) => owner.visible);
    expect(visibleOwners).toHaveLength(1);
    expect(visibleOwners[0]?.ownerId).toBe('prepacked-partitioned-vector-surface');
    expect(debug.prepackedAnnotationSceneStatus).toBe('eligible');
    expect(debug.prepackedAnnotationSceneVisibleInstanceCount).toBeGreaterThan(0);
    expect(debug.retainedLinearTranscriptBuilds).toBe(settledBodyBuilds);

    overlay.destroy();
  });

  it('keeps the active owner exact when inactive validation or GPU preparation fails, then activates prepared residents', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const canonical = sceneInput({}, 'race-canonical');
    expect(overlay.loadPrepackedAnnotationScene(canonical)).toBe(true);
    const active = overlay.getPrepackedAnnotationSceneOwnerSnapshot();

    const corrupt = sceneInput({}, 'race-corrupt');
    corrupt.interactionIndex = {
      ...corrupt.interactionIndex,
      featurePrimitiveIndices: new Uint32Array([99]),
    };
    expect(overlay.preparePrepackedAnnotationScene(corrupt)).toBe(false);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toEqual(active);

    vi.spyOn(
      PartitionedInstancedTranscriptLayer.prototype,
      'prepareGpuResources'
    ).mockImplementationOnce(() => {
      throw new Error('injected inactive GPU preparation failure');
    });
    expect(overlay.preparePrepackedAnnotationScene(sceneInput({}, 'race-gpu-failure'))).toBe(false);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toEqual(active);

    const preparedB = sceneInput({}, 'race-b');
    const preparedC = sceneInput({}, 'race-c');
    expect(overlay.preparePrepackedAnnotationScene(preparedB)).toBe(true);
    expect(overlay.preparePrepackedAnnotationScene(preparedC)).toBe(true);
    expect(overlay.activatePrepackedAnnotationScene('race-b')).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: 'race-b',
      ownerGeneration: active.ownerGeneration + 1,
    });
    expect(overlay.activatePrepackedAnnotationScene('race-c')).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: 'race-c',
      ownerGeneration: active.ownerGeneration + 2,
    });
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneResidentOwnerCount: 3,
      prepackedAnnotationSceneLayerCreates: 3,
      prepackedAnnotationSceneLayerDestroys: 0,
      prepackedAnnotationSceneGpuPreparations: 3,
    });
    overlay.destroy();
  });

  it('reports exact active provenance with monotonic, idempotent owner generations', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);

    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: null,
      ownerGeneration: 0,
      loaded: false,
      status: 'not-loaded',
      metadata: null,
    });

    const ownerA = sceneInput({}, 'owner-a');
    expect(overlay.loadPrepackedAnnotationScene(ownerA)).toBe(true);
    const first = overlay.getPrepackedAnnotationSceneOwnerSnapshot();
    expect(first).toMatchObject({
      ownerKey: 'owner-a',
      ownerGeneration: 1,
      loaded: true,
      status: 'eligible',
      gpuPrepared: true,
      metadata: ownerA.metadata,
    });

    expect(overlay.loadPrepackedAnnotationScene(sceneInput({}, 'owner-a'))).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: 'owner-a',
      ownerGeneration: 1,
    });
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLayerCreates: 1,
      prepackedAnnotationSceneLayerDestroys: 0,
    });

    expect(overlay.loadPrepackedAnnotationScene(sceneInput({}, 'owner-b'))).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: 'owner-b',
      ownerGeneration: 2,
    });
    expect(overlay.loadPrepackedAnnotationScene(ownerA)).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: 'owner-a',
      ownerGeneration: 3,
    });

    overlay.clearPrepackedAnnotationScene();
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: null,
      ownerGeneration: 4,
      loaded: false,
      status: 'not-loaded',
      metadata: null,
    });
    overlay.clearPrepackedAnnotationScene();
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot().ownerGeneration).toBe(4);
    overlay.destroy();
  });

  it('reports O(1) active-resident submissions for the camera and zeroes them when hidden or retired', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, { ...genome(), features: [], annotationExactCoverage: [] });
    expect(overlay.loadPrepackedAnnotationScene(sceneInput({}, 'submitted-owner'))).toBe(true);

    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: 'submitted-owner',
      loaded: true,
      submittedPartitionCount: 0,
      submittedInstanceCount: 0,
    });

    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(200_000_000),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      submittedPartitionCount: 1,
      submittedInstanceCount: 1,
    });

    const outsidePath = {
      ...pathForSpan(100_000_000),
      viewStartBp: 0,
      viewEndBp: 100_000_000,
      bpLeftX: (bp: number) => (bp / 100_000_000) * 1600,
      bpToScreenX: (bp: number) => (bp / 100_000_000) * 1600,
    } as unknown as PathMapper;
    expect(
      overlay.updateRetainedCamera({
        path: outsidePath,
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      submittedPartitionCount: 0,
      submittedInstanceCount: 0,
    });

    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(200_000_000),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    overlay.setPresentationVisible(false);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      loaded: true,
      submittedPartitionCount: 0,
      submittedInstanceCount: 0,
    });

    overlay.clearPrepackedAnnotationScene();
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      loaded: false,
      submittedPartitionCount: 0,
      submittedInstanceCount: 0,
    });
    overlay.destroy();
  });

  it('keeps canonical and expanded owners GPU-resident and reactivates A→B→A without a third upload', () => {
    const prepareGpu = vi.spyOn(
      PartitionedInstancedTranscriptLayer.prototype,
      'prepareGpuResources'
    );
    const overlay = new AnnotationOverlay();
    prepare(overlay, { ...genome(), features: [], annotationExactCoverage: [] });
    const canonical = sceneInput({}, 'canonical-owner');
    canonical.interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
      [
        {
          rendererId: 41,
          startBp: 1_544_000_000,
          endBp: 1_544_010_000,
          lane: 0,
          direction: 'forward',
          displayName: 'CANONICAL',
          type: 'mRNA',
          transcriptId: 'NM_CANONICAL.1',
          sourceId: 'rna-CANONICAL',
          canonicalIdentity: 'canonical-owner-feature',
        },
      ],
      canonical.scene.primitives
    );
    const expanded = sceneInput({}, 'expanded-owner');
    expanded.interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
      [
        {
          rendererId: 84,
          startBp: 1_544_000_000,
          endBp: 1_544_010_000,
          lane: 0,
          direction: 'forward',
          displayName: 'EXPANDED',
          type: 'mRNA',
          transcriptId: 'NM_EXPANDED.1',
          sourceId: 'rna-EXPANDED',
          canonicalIdentity: 'expanded-owner-feature',
        },
      ],
      expanded.scene.primitives
    );
    const path = pathForSpan(200_000_000);
    const hitX = path.bpLeftX(1_544_005_000);
    const hitY = path.fwdStrandTop - 8;

    expect(overlay.loadPrepackedAnnotationScene(canonical)).toBe(true);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    expect(overlay.hitTest(hitX, hitY, path, state())).toMatchObject({
      payload: { id: 41, displayName: 'CANONICAL', canonicalIdentity: 'canonical-owner-feature' },
    });

    expect(overlay.loadPrepackedAnnotationScene(expanded)).toBe(true);
    expect(overlay.hitTest(hitX, hitY, path, state())).toMatchObject({
      payload: { id: 41, displayName: 'CANONICAL', canonicalIdentity: 'canonical-owner-feature' },
    });
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneOwner: { ownerKey: 'expanded-owner' },
      prepackedAnnotationSceneVisibleInstanceCount: 1,
    });
    expect(overlay.hitTest(hitX, hitY, path, state())).toMatchObject({
      payload: { id: 84, displayName: 'EXPANDED', canonicalIdentity: 'expanded-owner-feature' },
    });

    expect(overlay.loadPrepackedAnnotationScene(canonical)).toBe(true);
    expect(overlay.hitTest(hitX, hitY, path, state())).toMatchObject({
      payload: { id: 84, displayName: 'EXPANDED', canonicalIdentity: 'expanded-owner-feature' },
    });
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    expect(overlay.hitTest(hitX, hitY, path, state())).toMatchObject({
      payload: { id: 41, displayName: 'CANONICAL', canonicalIdentity: 'canonical-owner-feature' },
    });
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneOwner: { ownerKey: 'canonical-owner', ownerGeneration: 3 },
      prepackedAnnotationSceneVisibleInstanceCount: 1,
      prepackedAnnotationSceneLayerCreates: 2,
      prepackedAnnotationSceneGpuPreparations: 2,
      prepackedAnnotationSceneLayerDestroys: 0,
      prepackedAnnotationSceneResidentOwnerCount: 2,
      prepackedAnnotationInteractionReady: true,
    });
    expect(prepareGpu).toHaveBeenCalledTimes(2);
    overlay.destroy();
  });

  it('keeps owner identity, generation, metadata, and eligibility stable through the former detail corridor boundary', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    expect(overlay.loadPrepackedAnnotationScene(sceneInput({}, 'corridor-owner'))).toBe(true);
    const active = overlay.getPrepackedAnnotationSceneOwnerSnapshot();
    const {
      submittedPartitionCount: _partitions,
      submittedInstanceCount: _instances,
      ...identity
    } = active;

    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(PREPACKED_ANNOTATION_MIN_VISIBLE_BP - 1),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ...identity,
      submittedPartitionCount: 1,
      submittedInstanceCount: 1,
    });

    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(PREPACKED_ANNOTATION_MIN_VISIBLE_BP),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ...identity,
      submittedPartitionCount: 1,
      submittedInstanceCount: 1,
    });
    overlay.destroy();
  });

  it('keeps exact annotation pixels owned across the 524288 bp cold-detail handoff', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, { ...genome(), features: [], annotationExactCoverage: [] });
    expect(overlay.loadPrepackedAnnotationScene(sceneInput({}, 'cold-handoff-owner'))).toBe(true);

    for (const span of [
      PREPACKED_ANNOTATION_MIN_VISIBLE_BP + 1,
      PREPACKED_ANNOTATION_MIN_VISIBLE_BP,
      PREPACKED_ANNOTATION_MIN_VISIBLE_BP - 1,
      PREPACKED_ANNOTATION_MIN_VISIBLE_BP,
    ]) {
      expect(
        overlay.updateRetainedCamera({
          path: pathForSpan(span),
          state: state(),
          yOffset: 0,
          height: 500,
        })
      ).toBe(true);
      const debug = overlay.getDebugSnapshot();
      const visibleOwners = debug.annotationPresentationOwners.filter((owner) => owner.visible);
      expect(visibleOwners, `annotation owner at ${span} bp`).toHaveLength(1);
      expect(
        debug.prepackedAnnotationSceneVisibleInstanceCount +
          debug.retainedLinearTranscriptBlockCount,
        `annotation geometry at ${span} bp`
      ).toBeGreaterThan(0);
    }

    overlay.destroy();
  });

  it('keeps the presenting owner when replacement GPU preparation fails', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    expect(overlay.loadPrepackedAnnotationScene(sceneInput({}, 'owner-a'))).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: 'owner-a',
      ownerGeneration: 1,
      loaded: true,
    });

    vi.spyOn(
      PartitionedInstancedTranscriptLayer.prototype,
      'prepareGpuResources'
    ).mockImplementationOnce(() => {
      throw new Error('injected replacement GPU preparation failure');
    });

    expect(overlay.loadPrepackedAnnotationScene(sceneInput({}, 'owner-b'))).toBe(false);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: 'owner-a',
      ownerGeneration: 1,
      loaded: true,
      status: 'eligible',
      gpuPrepared: true,
      metadata: sceneInput({}, 'owner-a').metadata,
    });
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLayerCreates: 1,
      prepackedAnnotationSceneLayerDestroys: 0,
    });
    overlay.destroy();
  });

  it('accepts a validated GPU-ready cache scene without source primitive reconstruction', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const input = sceneInput();
    const gpuReadyScene = buildPartitionedTranscriptScene(
      input.scene.primitives,
      input.metadata.partitionSpanBp
    );
    input.scene.primitives = [];
    input.gpuReadyScene = gpuReadyScene;

    expect(overlay.loadPrepackedAnnotationScene(input)).toBe(true);
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(150_000_000),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    overlay.loadGenome(genome());
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(160_000_000),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getPrepackedAnnotationFeatureIndex('bp-partition-15', 0)).toBe(0);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLoaded: true,
      prepackedAnnotationSceneStatus: 'eligible',
      prepackedAnnotationSceneGpuPrepared: true,
      prepackedAnnotationSceneLayerCreates: 1,
      prepackedAnnotationSceneCameraUpdates: 2,
      prepackedAnnotationSceneVisibleInstanceCount: 1,
    });
    overlay.destroy();
  });

  it('rejects a GPU-ready v2 scene with no sidecar before same-owner idempotence', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const valid = sceneInput({}, 'same-owner');
    const gpuReadyScene = buildPartitionedTranscriptScene(
      valid.scene.primitives,
      valid.metadata.partitionSpanBp
    );
    valid.scene.primitives = [];
    valid.gpuReadyScene = gpuReadyScene;

    expect(overlay.loadPrepackedAnnotationScene(valid)).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationInteractionReady: true,
      prepackedAnnotationInteractionVisualCouplingValidated: true,
    });

    const missingSidecar = {
      ...valid,
      interactionIndex: undefined,
    } as unknown as PrepackedAnnotationSceneLoadInput;
    expect(overlay.loadPrepackedAnnotationScene(missingSidecar)).toBe(false);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLoaded: false,
      prepackedAnnotationSceneStatus: 'variant-mismatch',
      prepackedAnnotationSceneLayerDestroys: 1,
      prepackedAnnotationInteractionReady: false,
      prepackedAnnotationInteractionSchema: null,
      prepackedAnnotationInteractionFeatureCount: 0,
      prepackedAnnotationInteractionPrimitiveCount: 0,
      prepackedAnnotationInteractionVisualCouplingValidated: false,
    });
    overlay.destroy();
  });

  it('evicts a live same-owner scene when its reasserted sidecar fails visual coupling', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const valid = sceneInput({}, 'same-owner');
    valid.gpuReadyScene = buildPartitionedTranscriptScene(
      valid.scene.primitives,
      valid.metadata.partitionSpanBp
    );
    valid.scene.primitives = [];
    expect(overlay.loadPrepackedAnnotationScene(valid)).toBe(true);

    const invalidCoupling: PrepackedAnnotationSceneLoadInput = {
      ...valid,
      interactionIndex: {
        ...valid.interactionIndex,
        featurePrimitiveIndices: new Uint32Array([99]),
      },
    };
    expect(overlay.loadPrepackedAnnotationScene(invalidCoupling)).toBe(false);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLoaded: false,
      prepackedAnnotationSceneStatus: 'variant-mismatch',
      prepackedAnnotationSceneLayerDestroys: 1,
      prepackedAnnotationInteractionReady: false,
      prepackedAnnotationInteractionVisualCouplingValidated: false,
    });
    overlay.destroy();
  });

  it('switches isoform membership and lane caps on one 200M owner without GPU or geometry replacement', () => {
    const prepareGpu = vi.spyOn(
      PartitionedInstancedTranscriptLayer.prototype,
      'prepareGpuResources'
    );
    const updateVisibleRange = vi.spyOn(
      PartitionedInstancedTranscriptLayer.prototype,
      'updateVisibleRange'
    );
    const overlay = new AnnotationOverlay();
    prepare(overlay, { ...genome(), features: [] });
    const input = runtimePolicySceneInput();
    const path = pathForSpan(200_000_000);
    const hitX = path.bpLeftX(1_544_005_000);
    const expandedY = path.fwdStrandTop - 24;
    const canonicalY = path.fwdStrandTop - 8;

    expect(overlay.loadPrepackedAnnotationScene(input)).toBe(true);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    const loaded = overlay.getDebugSnapshot();
    expect(overlay.hitTest(hitX, expandedY, path, state())).toMatchObject({
      payload: { id: 41, lane: 1 },
    });

    expect(
      overlay.updatePrepackedAnnotationPolicy({ isoformMode: 'canonical', laneLimit: 12 })
    ).toBe(true);
    expect(overlay.hitTest(hitX, expandedY, path, state())).toBeNull();
    expect(overlay.hitTest(hitX, canonicalY, path, state())).toMatchObject({
      payload: { id: 41, lane: 0 },
    });

    expect(overlay.updatePrepackedAnnotationPolicy({ isoformMode: 'expanded', laneLimit: 1 })).toBe(
      true
    );
    expect(overlay.hitTest(hitX, expandedY, path, state())).toBeNull();
    expect(overlay.updatePrepackedAnnotationPolicy({ isoformMode: 'expanded', laneLimit: 2 })).toBe(
      true
    );
    expect(overlay.hitTest(hitX, expandedY, path, state())).toMatchObject({
      payload: { id: 41, lane: 1 },
    });

    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLayerCreates: loaded.prepackedAnnotationSceneLayerCreates,
      prepackedAnnotationSceneGpuPreparations: loaded.prepackedAnnotationSceneGpuPreparations,
      prepackedAnnotationSceneOwner: {
        ownerKey: 'policy-neutral-owner',
        ownerGeneration: loaded.prepackedAnnotationSceneOwner.ownerGeneration,
        runtimePolicy: { isoformMode: 'expanded', laneLimit: 2 },
        policyGeneration: 3,
      },
    });
    expect(prepareGpu).toHaveBeenCalledTimes(1);
    expect(updateVisibleRange).toHaveBeenCalledTimes(1);
    overlay.destroy();
  });

  it('routes a prevalidated direct bank through the real owner with exact hit identity and draw counts', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, { ...genome(), features: [] });
    const input = directBankRuntimePolicySceneInput();
    const path = pathForSpan(200_000_000);

    expect(overlay.loadPrepackedAnnotationScene(input)).toBe(true);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: 'direct-bank-owner',
      runtimePolicy: { isoformMode: 'canonical', laneLimit: 2 },
      submittedPartitionCount: 1,
      submittedInstanceCount: 1,
    });
    expect(overlay.getPrepackedAnnotationFeatureIndex('bp-partition-15', 0)).toBe(1);
    expect(overlay.getPrepackedAnnotationFeatureIndex('bp-partition-15', 1)).toBeNull();

    const internals = overlayPresenterInternals(overlay) as unknown as {
      prepackedAnnotationSceneLayer: InstanceType<typeof PartitionedInstancedTranscriptLayer>;
    };
    expect(internals.prepackedAnnotationSceneLayer.getSubmissionDebug()).toEqual({
      directBankEnabled: true,
      activeMode: 'canonical',
      actualSubmittedInstanceCount: 1,
      actualSubmittedVertexCount: 9,
      hiddenByIsoformMembershipInstanceCount: 1,
      hiddenByLaneCapInstanceCount: 1,
      visibleDrawCount: 1,
    });

    expect(
      overlay.updatePrepackedAnnotationPolicy({ isoformMode: 'expanded', laneLimit: null })
    ).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      runtimePolicy: { isoformMode: 'expanded', laneLimit: null },
      submittedPartitionCount: 1,
      submittedInstanceCount: 3,
    });
    expect(overlay.getPrepackedAnnotationFeatureIndex('bp-partition-15', 0)).toBe(1);
    expect(overlay.getPrepackedAnnotationFeatureIndex('bp-partition-15', 1)).toBe(2);
    expect(overlay.getPrepackedAnnotationFeatureIndex('bp-partition-15', 2)).toBe(0);
    overlay.destroy();
  });

  it('admits an exact trusted-v4 wrapper with zero duplicate semantic scans and fails closed on capability copies', async () => {
    const input = await trustedV4RuntimePolicySceneInput();
    const overlay = new AnnotationOverlay();
    const trustedGenome = {
      ...genome('hg002-grch38', ['mRNA'], input.metadata.genomeIdentity),
      features: [],
    };
    prepare(overlay, trustedGenome);

    expect(overlay.loadPrepackedAnnotationScene({ ...input })).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationInteractionCouplingValidationCount: 0,
      prepackedAnnotationInteractionCouplingPrimitiveScanCardinality: 0,
      prepackedAnnotationTrustedV4AdmissionCount: 1,
      prepackedAnnotationDirectFineIndexValidationCount: 0,
      prepackedAnnotationDirectFineIndexRecordScanCardinality: 0,
      prepackedAnnotationTrustedV4LayerAdmission: true,
    });
    const trustedInternals = overlayPresenterInternals(overlay) as unknown as {
      prepackedAnnotationSceneLayer: InstanceType<typeof PartitionedInstancedTranscriptLayer>;
    };
    const trustedLayer = trustedInternals.prepackedAnnotationSceneLayer;
    const glyphBufferIdentity = trustedLayer.getAnnotationPolicyDebug().glyphBufferIdentity;
    const initialOwner = overlay.getPrepackedAnnotationSceneOwnerSnapshot();
    const initialCreates = overlay.getDebugSnapshot().prepackedAnnotationSceneLayerCreates;
    for (const isoformMode of ['canonical', 'expanded'] as const) {
      for (const laneLimit of [8, 12, 24] as const) {
        expect(overlay.updatePrepackedAnnotationPolicy({ isoformMode, laneLimit })).toBe(true);
      }
    }
    expect(trustedInternals.prepackedAnnotationSceneLayer).toBe(trustedLayer);
    expect(trustedLayer.getAnnotationPolicyDebug().glyphBufferIdentity).toBe(glyphBufferIdentity);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: initialOwner.ownerKey,
      ownerGeneration: initialOwner.ownerGeneration,
      policyGeneration: initialOwner.policyGeneration + 6,
      runtimePolicy: { isoformMode: 'expanded', laneLimit: 24 },
    });
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLayerCreates: initialCreates,
      prepackedAnnotationInteractionCouplingValidationCount: 0,
      prepackedAnnotationInteractionCouplingPrimitiveScanCardinality: 0,
      prepackedAnnotationTrustedV4AdmissionCount: 1,
      prepackedAnnotationDirectFineIndexValidationCount: 0,
      prepackedAnnotationDirectFineIndexRecordScanCardinality: 0,
      prepackedAnnotationTrustedV4LayerAdmission: true,
    });
    overlay.destroy();

    const genericOverlay = new AnnotationOverlay();
    prepare(genericOverlay, trustedGenome);
    const {
      trustedRendererAdmissionV4: _capability,
      trustedRendererAdmissionProvenanceV4: _provenance,
      trustedRendererAdmissionLoadIdentityV4: _loadIdentity,
      ...genericInput
    } = input;
    expect(genericOverlay.loadPrepackedAnnotationScene(genericInput)).toBe(true);
    expect(genericOverlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationInteractionCouplingValidationCount: 1,
      prepackedAnnotationInteractionCouplingPrimitiveScanCardinality:
        input.interactionIndex.primitiveCount,
      prepackedAnnotationTrustedV4AdmissionCount: 0,
      prepackedAnnotationDirectFineIndexValidationCount: 2,
      prepackedAnnotationDirectFineIndexRecordScanCardinality:
        input.submissionFineIndices!.expanded.bankRecordIndices.length +
        input.submissionFineIndices!.canonical.bankRecordIndices.length,
      prepackedAnnotationTrustedV4LayerAdmission: false,
    });
    genericOverlay.destroy();

    const forgedOverlay = new AnnotationOverlay();
    prepare(forgedOverlay, trustedGenome);
    expect(
      forgedOverlay.loadPrepackedAnnotationScene({
        ...input,
        ownerKey: 'forged-capability-owner',
        trustedRendererAdmissionV4: { ...input.trustedRendererAdmissionV4! },
      })
    ).toBe(false);
    expect(forgedOverlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLoaded: false,
      prepackedAnnotationInteractionCouplingValidationCount: 0,
      prepackedAnnotationTrustedV4AdmissionCount: 0,
    });
    forgedOverlay.destroy();

    const ownerParts = input.ownerKey.split('\n');
    const darkArtifactKey = prepackedAnnotationSceneArtifactKey({
      themeMode: 'dark',
      trackType: 'mRNA',
    });
    const relabeledInputs: PrepackedAnnotationSceneLoadInput[] = [
      {
        ...input,
        metadata: {
          ...input.metadata,
          genomeIdentity: `assembly-annotation-source-sha256.v1:${'b'.repeat(64)}`,
        },
      },
      {
        ...input,
        ownerKey: [ownerParts[0], ownerParts[1], 'c'.repeat(64), ...ownerParts.slice(3)].join('\n'),
      },
      {
        ...input,
        ownerKey: [...ownerParts.slice(0, 4), darkArtifactKey].join('\n'),
        metadata: {
          ...input.metadata,
          themeMode: 'dark',
          artifactKey: darkArtifactKey,
        },
      },
    ];
    for (const relabeled of relabeledInputs) {
      const relabelOverlay = new AnnotationOverlay();
      prepare(relabelOverlay, {
        ...genome('hg002-grch38', ['mRNA'], relabeled.metadata.genomeIdentity),
        features: [],
      });
      expect(relabelOverlay.loadPrepackedAnnotationScene(relabeled)).toBe(false);
      expect(relabelOverlay.getDebugSnapshot()).toMatchObject({
        prepackedAnnotationSceneLoaded: false,
        prepackedAnnotationInteractionCouplingValidationCount: 0,
        prepackedAnnotationTrustedV4AdmissionCount: 0,
      });
      relabelOverlay.destroy();
    }
  });

  it('commits the fixed lane envelope with 12→8→24→uncapped policy changes without touching resident buffers', () => {
    const prepareGpu = vi.spyOn(
      PartitionedInstancedTranscriptLayer.prototype,
      'prepareGpuResources'
    );
    const overlay = new AnnotationOverlay();
    prepare(overlay, { ...genome(), features: [] });
    const input = runtimePolicySceneInput();
    input.runtimePolicy = { isoformMode: 'canonical', laneLimit: 12 };

    expect(overlay.loadPrepackedAnnotationScene(input)).toBe(true);
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(200_000_000),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    const internals = overlayPresenterInternals(overlay) as unknown as {
      prepackedAnnotationSceneLayer: InstanceType<typeof PartitionedInstancedTranscriptLayer>;
    };
    const layer = internals.prepackedAnnotationSceneLayer;
    const initialPolicyDebug = layer.getAnnotationPolicyDebug();
    const initialOverlayDebug = overlay.getDebugSnapshot();

    expect(overlay.maxAnnotationLane).toBe(11);
    expect(overlay.maxCdsLane).toBe(-1);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      runtimePolicy: { isoformMode: 'canonical', laneLimit: 12 },
      policyGeneration: 0,
    });

    const transitions = [
      [{ isoformMode: 'canonical', laneLimit: 8 }, 7],
      [{ isoformMode: 'canonical', laneLimit: 24 }, 23],
      [{ isoformMode: 'canonical', laneLimit: null }, 0],
      [{ isoformMode: 'expanded', laneLimit: null }, 1],
    ] as const;
    for (let index = 0; index < transitions.length; index += 1) {
      const [policy, expectedMaxLane] = transitions[index];
      expect(overlay.updatePrepackedAnnotationPolicy(policy)).toBe(true);
      expect(overlay.maxAnnotationLane).toBe(expectedMaxLane);
      expect(overlay.maxCdsLane).toBe(-1);
      expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
        runtimePolicy: policy,
        policyGeneration: index + 1,
      });
      const policyDebug = layer.getAnnotationPolicyDebug();
      expect(policyDebug.glyphBufferIdentity).toBe(initialPolicyDebug.glyphBufferIdentity);
      expect(policyDebug.policyBufferIdentity).toBe(initialPolicyDebug.policyBufferIdentity);
    }

    const pageStartBp = 1_544_000_000;
    const pagePublication: AnnotationResidentPagePublication = {
      contract: 'annotation-resident-page-publication.v1',
      sourceIdentity: 'hg002-grch38-source',
      genomeLengthBp: L,
      policyKey: 'source-pages:mRNA',
      generation: 1,
      requestedLayerTypes: ['mRNA'],
      exactCoverage: [{ startBp: pageStartBp, endBp: pageStartBp + 512 * 1024 }],
      pages: [
        {
          contract: 'annotation-presentation-page.v1',
          pageKey: 'late-source-page',
          chromosomeId: 'placement-late',
          trackId: 'mRNA',
          trackOrder: 0,
          laneCapacity: 12,
          ownerStartBp: pageStartBp,
          ownerEndBp: pageStartBp + 512 * 1024,
          maxFeatureEndBp: pageStartBp + 512 * 1024,
          contentRevision: 'late-source-page-v1',
          features: [
            {
              id: 90210,
              type: 'mRNA',
              start: pageStartBp + 100,
              end: pageStartBp + 20_000,
              direction: 'forward',
              displayName: 'late page feature',
              color: 0x3b82f6,
              lane: 0,
              annotationTrackId: 'mRNA',
              annotationTrackLane: 0,
              annotationTrackLaneCapacity: 12,
              canonicalIdentity: 'late-page-feature',
            },
          ],
        },
      ],
    };
    expect(overlay.ingestAnnotationResidentPages(pagePublication)).toMatchObject({
      status: 'applied',
    });
    expect(overlay.maxAnnotationLane).toBe(1);
    expect(overlay.maxCdsLane).toBe(-1);
    expect(layer.getAnnotationPolicyDebug().glyphBufferIdentity).toBe(
      initialPolicyDebug.glyphBufferIdentity
    );
    expect(layer.getAnnotationPolicyDebug().policyBufferIdentity).toBe(
      initialPolicyDebug.policyBufferIdentity
    );
    const latePagePublication: AnnotationResidentPagePublication = {
      ...pagePublication,
      generation: 2,
      pages: pagePublication.pages.map((page) => ({
        ...page,
        contentRevision: 'late-source-page-v2',
      })),
    };
    expect(overlay.ingestAnnotationResidentPages(latePagePublication)).toEqual({
      status: 'applied',
      generation: 2,
      invalidatedHover: true,
    });
    expect(overlay.maxAnnotationLane).toBe(1);
    expect(overlay.maxCdsLane).toBe(-1);

    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLayerCreates:
        initialOverlayDebug.prepackedAnnotationSceneLayerCreates,
      prepackedAnnotationSceneGpuPreparations:
        initialOverlayDebug.prepackedAnnotationSceneGpuPreparations,
      prepackedAnnotationSceneStartupBuilds:
        initialOverlayDebug.prepackedAnnotationSceneStartupBuilds,
      prepackedAnnotationSceneOwner: {
        ownerKey: 'policy-neutral-owner',
        ownerGeneration: initialOverlayDebug.prepackedAnnotationSceneOwner.ownerGeneration,
        runtimePolicy: { isoformMode: 'expanded', laneLimit: null },
        policyGeneration: 4,
      },
    });
    expect(prepareGpu).toHaveBeenCalledTimes(1);
    overlay.clearPrepackedAnnotationScene();
    expect(overlay.maxAnnotationLane).toBe(7);
    expect(overlay.maxCdsLane).toBe(-1);
    overlay.destroy();
  });

  it('hits a rich annotation at 200M through the direct GPU-ready full-assembly owner without a Feature graph', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, { ...genome(), features: [] });
    const input = sceneInput();
    const gpuReadyScene = buildPartitionedTranscriptScene(
      input.scene.primitives,
      input.metadata.partitionSpanBp
    );
    const interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
      [
        {
          rendererId: 41,
          startBp: 1_544_000_000,
          endBp: 1_544_010_000,
          lane: 0,
          direction: 'forward',
          displayName: 'TX41',
          type: 'mRNA',
          transcriptId: 'NM_TX41.1',
          sourceId: 'rna-TX41',
          canonicalIdentity: 'mRNA|rna-TX41|NM_TX41.1|1544000000|1544010000|forward',
        },
      ],
      gpuReadyScene.sortedPrimitives
    );
    input.scene.primitives = [];
    Object.assign(input, { gpuReadyScene, interactionIndex });

    expect(overlay.loadPrepackedAnnotationScene(input)).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationInteractionReady: true,
      prepackedAnnotationInteractionSchema: 'prepacked-annotation-interaction-index.v2',
      prepackedAnnotationInteractionFeatureCount: 1,
      prepackedAnnotationInteractionPrimitiveCount: 1,
      prepackedAnnotationInteractionVisualCouplingValidated: true,
      prepackedAnnotationInteractionQueries: 0,
    });
    const path = pathForSpan(200_000_000);
    path.featurePolygonAt = (startBp, endBp, offset, halfHeight) => {
      const xMin = path.bpLeftX(startBp);
      const xMax = path.bpLeftX(endBp);
      const centerY = path.fwdStrandTop + offset;
      const hh = halfHeight ?? 8;
      return [xMin, centerY - hh, xMax, centerY - hh, xMax, centerY + hh, xMin, centerY + hh];
    };
    expect(
      overlay.updateRetainedCamera({
        path,
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);

    const hit = overlay.hitTest(path.bpLeftX(1_544_005_000), path.fwdStrandTop - 8, path, state());
    expect(hit).toMatchObject({
      kind: 'feature',
      payload: {
        id: 41,
        start: 1_544_000_000,
        end: 1_544_010_000,
        displayName: 'TX41',
        type: 'mRNA',
        transcriptId: 'NM_TX41.1',
        sourceId: 'rna-TX41',
        canonicalIdentity: 'mRNA|rna-TX41|NM_TX41.1|1544000000|1544010000|forward',
      },
    });
    expect(overlay.getDebugSnapshot()).toMatchObject({
      featureCount: 0,
      prepackedAnnotationSceneVisibleInstanceCount: 1,
      prepackedAnnotationInteractionQueries: 1,
      prepackedAnnotationInteractionLastVisitedNodes: 1,
      prepackedAnnotationInteractionMaxVisitedNodes: 1,
      prepackedAnnotationInteractionLastPrimitiveCandidates: 1,
    });

    const selectedState = state();
    selectedState.hoveredId = 41;
    expect(
      overlay.updateRetainedCamera({ path, state: selectedState, yOffset: 0, height: 500 })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      lastInteractionOutlineCommandCount: 1,
      geometryRebuilds: 0,
      featureCount: 0,
    });

    const crossOwnerSelection = state();
    crossOwnerSelection.selectedIds.add(7);
    crossOwnerSelection.selectedCanonicalIdentities = new Set([
      'mRNA|rna-TX41|NM_TX41.1|1544000000|1544010000|forward',
    ]);
    expect(
      overlay.updateRetainedCamera({
        path,
        state: crossOwnerSelection,
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      lastInteractionOutlineCommandCount: 1,
      geometryRebuilds: 0,
    });

    const collisionSelection = state();
    collisionSelection.selectedIds.add(41);
    collisionSelection.selectedCanonicalIdentities = new Set(['canonical-OTHER']);
    expect(
      overlay.updateRetainedCamera({
        path,
        state: collisionSelection,
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      lastInteractionOutlineCommandCount: 0,
      geometryRebuilds: 0,
    });
    overlay.destroy();
  });

  it('dims one exact annotation track and redraws only the canonical search target without rebuilding its resident geometry', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, { ...genome(), features: [] });
    const input = sceneInput({}, 'search-focus-owner');
    input.scene.primitives = [
      {
        ...input.scene.primitives[0],
        startBp: 1_544_000_000,
        endBp: 1_544_010_000,
        featureIndex: 0,
        color: 0x123456,
        alpha: 0.65,
        dirSign: 1,
      },
      {
        ...input.scene.primitives[0],
        startBp: 1_544_020_000,
        endBp: 1_544_030_000,
        featureIndex: 1,
        color: 0xa1b2c3,
        alpha: 0.75,
        dirSign: -1,
      },
    ];
    input.scene.featureFamilyIndices = new Uint32Array([0, 0]);
    input.interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
      [
        {
          rendererId: 41,
          startBp: 1_544_000_000,
          endBp: 1_544_010_000,
          lane: 0,
          direction: 'forward',
          displayName: 'TARGET',
          type: 'mRNA',
          transcriptId: 'NM_TARGET.1',
          sourceId: 'rna-target',
          canonicalIdentity: 'canonical-TX1',
        },
        {
          rendererId: 42,
          startBp: 1_544_020_000,
          endBp: 1_544_030_000,
          lane: 0,
          direction: 'reverse',
          displayName: 'OTHER',
          type: 'mRNA',
          transcriptId: 'NM_OTHER.1',
          sourceId: 'rna-other',
          canonicalIdentity: 'canonical-TX2',
        },
      ],
      input.scene.primitives
    );

    expect(overlay.loadPrepackedAnnotationScene(input)).toBe(true);
    const path = pathForSpan(10_000_000);
    const renderState = state();
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    const before = overlay.getDebugSnapshot();
    const focusGraphics = (
      overlayPresenterInternals(overlay) as unknown as {
        annotationSearchFocusGraphics: {
          rect: (...args: unknown[]) => unknown;
          poly: (...args: unknown[]) => unknown;
          fill: (...args: unknown[]) => unknown;
          visible: boolean;
        };
        interactionGraphics: object;
      }
    ).annotationSearchFocusGraphics;
    const rect = vi.spyOn(focusGraphics, 'rect');
    const poly = vi.spyOn(focusGraphics, 'poly');
    const fill = vi.spyOn(focusGraphics, 'fill');

    renderState.annotationSearchFocus = {
      trackId: 'mRNA',
      canonicalIdentity: 'canonical-TX1',
    };
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);

    expect(rect).toHaveBeenCalledOnce();
    expect(poly).toHaveBeenCalledOnce();
    expect(fill).toHaveBeenNthCalledWith(1, expect.objectContaining({ color: 0x6b7280 }));
    expect(fill).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ color: 0x123456, alpha: expect.closeTo(0.65, 6) })
    );
    expect(overlay.getDebugSnapshot()).toMatchObject({
      annotationSearchFocusMaskDrawCount: 1,
      annotationSearchFocusPrimitiveDrawCount: 1,
      annotationSearchFocusResolvedTrackId: 'mRNA',
      annotationSearchFocusResolvedCanonicalIdentity: 'canonical-TX1',
      geometryRebuilds: before.geometryRebuilds,
      prepackedAnnotationSceneLayerCreates: before.prepackedAnnotationSceneLayerCreates,
      prepackedAnnotationSceneGpuPreparations: before.prepackedAnnotationSceneGpuPreparations,
      annotationPresentationOwners: before.annotationPresentationOwners,
    });
    expect(
      overlay.container.getChildIndex(
        (overlayPresenterInternals(overlay) as unknown as { annotationSearchFocusGraphics: object })
          .annotationSearchFocusGraphics as never
      )
    ).toBeLessThan(
      overlay.container.getChildIndex(
        (overlayPresenterInternals(overlay) as unknown as { interactionGraphics: object })
          .interactionGraphics as never
      )
    );

    rect.mockClear();
    poly.mockClear();
    fill.mockClear();
    renderState.annotationSearchFocus = {
      trackId: 'mRNA',
      canonicalIdentity: 'canonical-TX2',
    };
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    expect(rect).toHaveBeenCalledOnce();
    expect(poly).toHaveBeenCalledOnce();
    expect(fill).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ color: 0xa1b2c3, alpha: expect.closeTo(0.75, 6) })
    );
    expect(overlay.getDebugSnapshot()).toMatchObject({
      annotationSearchFocusMaskDrawCount: 1,
      annotationSearchFocusPrimitiveDrawCount: 1,
      annotationSearchFocusResolvedCanonicalIdentity: 'canonical-TX2',
      geometryRebuilds: before.geometryRebuilds,
      prepackedAnnotationSceneLayerCreates: before.prepackedAnnotationSceneLayerCreates,
      prepackedAnnotationSceneGpuPreparations: before.prepackedAnnotationSceneGpuPreparations,
      annotationPresentationOwners: before.annotationPresentationOwners,
    });

    rect.mockClear();
    poly.mockClear();
    fill.mockClear();
    renderState.annotationSearchFocus = {
      trackId: 'mRNA',
      canonicalIdentity: 'canonical-missing',
    };
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    expect(rect).not.toHaveBeenCalled();
    expect(poly).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
    expect(overlay.getDebugSnapshot()).toMatchObject({
      annotationSearchFocusMaskDrawCount: 0,
      annotationSearchFocusPrimitiveDrawCount: 0,
      annotationSearchFocusResolvedTrackId: null,
      annotationSearchFocusResolvedCanonicalIdentity: null,
      geometryRebuilds: before.geometryRebuilds,
      prepackedAnnotationSceneLayerCreates: before.prepackedAnnotationSceneLayerCreates,
      prepackedAnnotationSceneGpuPreparations: before.prepackedAnnotationSceneGpuPreparations,
      annotationPresentationOwners: before.annotationPresentationOwners,
    });

    rect.mockClear();
    poly.mockClear();
    fill.mockClear();
    renderState.annotationSearchFocus = {
      trackId: 'lnc_RNA',
      canonicalIdentity: 'canonical-TX1',
    };
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    expect(rect).not.toHaveBeenCalled();
    expect(poly).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
    expect(overlay.getDebugSnapshot()).toMatchObject({
      annotationSearchFocusMaskDrawCount: 0,
      annotationSearchFocusPrimitiveDrawCount: 0,
      annotationSearchFocusResolvedTrackId: null,
      annotationSearchFocusResolvedCanonicalIdentity: null,
    });
    overlay.destroy();
  });

  it('focus-projects exact noncanonical and lane-capped targets into visible lane zero without changing body policy or resources', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, { ...genome(), features: [] });
    const input = directBankRuntimePolicySceneInput();
    const path = pathForSpan(200_000_000);
    const renderState = state();

    expect(overlay.loadPrepackedAnnotationScene(input)).toBe(true);
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    const internals = overlayPresenterInternals(overlay) as unknown as {
      prepackedAnnotationSceneLayer: InstanceType<typeof PartitionedInstancedTranscriptLayer>;
      annotationSearchFocusGraphics: {
        rect: (...args: unknown[]) => unknown;
        poly: (...args: unknown[]) => unknown;
        fill: (...args: unknown[]) => unknown;
      };
    };
    expect(internals.prepackedAnnotationSceneLayer.getSubmissionDebug()).toMatchObject({
      activeMode: 'canonical',
      hiddenByIsoformMembershipInstanceCount: 1,
      hiddenByLaneCapInstanceCount: 1,
      visibleDrawCount: 1,
    });
    const layerBefore = internals.prepackedAnnotationSceneLayer;
    const glyphBufferBefore = layerBefore.getAnnotationPolicyDebug().glyphBufferIdentity;
    const ownerBefore = overlay.getPrepackedAnnotationSceneOwnerSnapshot();
    const resourcesBefore = overlay.getDebugSnapshot();
    const rect = vi.spyOn(internals.annotationSearchFocusGraphics, 'rect');
    const poly = vi.spyOn(internals.annotationSearchFocusGraphics, 'poly');
    const fill = vi.spyOn(internals.annotationSearchFocusGraphics, 'fill');
    const laneZeroCenterY =
      path.fwdStrandTop +
      layout().annotationOffset +
      PREPACKED_ANNOTATION_BAR_HEIGHT_PX / 2 +
      annotationPolicyLaneCenterOffsetPxV1(0);

    for (const canonicalIdentity of ['canonical-TX41', 'canonical-TX43']) {
      renderState.annotationSearchFocus = {
        trackId: 'mRNA',
        canonicalIdentity,
      };
      expect(
        overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
      ).toBe(true);

      expect(rect).toHaveBeenCalledOnce();
      expect(poly).toHaveBeenCalledOnce();
      expect(fill).toHaveBeenCalledTimes(2);
      const points = poly.mock.calls[0]?.[0] as number[];
      const yCoordinates = points.filter((_coordinate, index) => index % 2 === 1);
      expect((Math.min(...yCoordinates) + Math.max(...yCoordinates)) / 2).toBeCloseTo(
        laneZeroCenterY,
        6
      );
      expect(overlay.getDebugSnapshot()).toMatchObject({
        annotationSearchFocusMaskDrawCount: 1,
        annotationSearchFocusPrimitiveDrawCount: 1,
        annotationSearchFocusResolvedTrackId: 'mRNA',
        annotationSearchFocusResolvedCanonicalIdentity: canonicalIdentity,
        geometryRebuilds: resourcesBefore.geometryRebuilds,
        prepackedAnnotationSceneLayerCreates: resourcesBefore.prepackedAnnotationSceneLayerCreates,
        prepackedAnnotationSceneGpuPreparations:
          resourcesBefore.prepackedAnnotationSceneGpuPreparations,
        annotationPresentationOwners: resourcesBefore.annotationPresentationOwners,
      });
      expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toEqual(ownerBefore);
      expect(internals.prepackedAnnotationSceneLayer).toBe(layerBefore);
      expect(
        internals.prepackedAnnotationSceneLayer.getAnnotationPolicyDebug().glyphBufferIdentity
      ).toBe(glyphBufferBefore);
      expect(internals.prepackedAnnotationSceneLayer.getSubmissionDebug()).toMatchObject({
        activeMode: 'canonical',
        hiddenByIsoformMembershipInstanceCount: 1,
        hiddenByLaneCapInstanceCount: 1,
        visibleDrawCount: 1,
      });

      rect.mockClear();
      poly.mockClear();
      fill.mockClear();
    }
    overlay.destroy();
  });

  it('uses exactly one temporary lane beyond the durable body and removes it without policy or resource mutation', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, { ...genome(), features: [] });
    const input = directBankRuntimePolicySceneInput();
    const path = pathForSpan(200_000_000);
    const renderState = state();

    expect(overlay.loadPrepackedAnnotationScene(input)).toBe(true);
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    const internals = overlayPresenterInternals(overlay) as unknown as {
      prepackedAnnotationSceneLayer: InstanceType<typeof PartitionedInstancedTranscriptLayer>;
      annotationSearchFocusGraphics: {
        rect: (...args: unknown[]) => unknown;
        poly: (...args: unknown[]) => unknown;
        fill: (...args: unknown[]) => unknown;
        visible: boolean;
      };
    };
    const bodyLayer = internals.prepackedAnnotationSceneLayer;
    const bodySubmissionBefore = bodyLayer.getSubmissionDebug();
    expect(bodySubmissionBefore).toMatchObject({
      activeMode: 'canonical',
      hiddenByIsoformMembershipInstanceCount: 1,
      hiddenByLaneCapInstanceCount: 1,
      visibleDrawCount: 1,
    });
    const durableMaxLane = overlay.maxAnnotationLane;
    expect(durableMaxLane).toBe(1);
    const temporaryLane = durableMaxLane + 1;
    const bodyPolicyBefore = bodyLayer.getAnnotationPolicyDebug();
    const bodyBuffer = bodyPolicyBefore.glyphBufferIdentity;
    const bodyOwner = overlay.getPrepackedAnnotationSceneOwnerSnapshot();
    const resourcesBefore = overlay.getDebugSnapshot();
    const rect = vi.spyOn(internals.annotationSearchFocusGraphics, 'rect');
    const poly = vi.spyOn(internals.annotationSearchFocusGraphics, 'poly');

    renderState.annotationSearchFocus = {
      trackId: 'mRNA',
      canonicalIdentity: 'canonical-TX42',
      presentation: 'temporary-additional-lane',
    };
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    expect(rect).not.toHaveBeenCalled();
    expect(poly).toHaveBeenCalledOnce();
    const visiblePoints = poly.mock.calls[0]?.[0] as number[];
    const visibleYCoordinates = visiblePoints.filter((_coordinate, index) => index % 2 === 1);
    const durableLaneCenterY =
      path.fwdStrandTop +
      layout().annotationOffset +
      PREPACKED_ANNOTATION_BAR_HEIGHT_PX / 2 +
      annotationPolicyLaneCenterOffsetPxV1(0);
    expect((Math.min(...visibleYCoordinates) + Math.max(...visibleYCoordinates)) / 2).toBeCloseTo(
      durableLaneCenterY,
      6
    );
    expect(overlay.getDebugSnapshot()).toMatchObject({
      annotationSearchFocusMaskDrawCount: 0,
      annotationSearchFocusPrimitiveDrawCount: 1,
      annotationSearchFocusResolvedCanonicalIdentity: 'canonical-TX42',
      annotationSearchFocusPresentationLane: null,
    });
    expect(overlay.maxAnnotationLane).toBe(durableMaxLane);

    rect.mockClear();
    poly.mockClear();
    renderState.annotationSearchFocus = {
      trackId: 'mRNA',
      canonicalIdentity: 'canonical-TX41',
      presentation: 'temporary-additional-lane',
    };
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);

    expect(rect).toHaveBeenCalledOnce();
    expect(rect.mock.calls[0]?.[3]).toBe(layout().annotationStep);
    expect(poly).toHaveBeenCalledOnce();
    const points = poly.mock.calls[0]?.[0] as number[];
    const yCoordinates = points.filter((_coordinate, index) => index % 2 === 1);
    const temporaryLaneCenterY =
      path.fwdStrandTop +
      layout().annotationOffset +
      PREPACKED_ANNOTATION_BAR_HEIGHT_PX / 2 +
      annotationPolicyLaneCenterOffsetPxV1(temporaryLane);
    expect((Math.min(...yCoordinates) + Math.max(...yCoordinates)) / 2).toBeCloseTo(
      temporaryLaneCenterY,
      6
    );
    expect(overlay.getDebugSnapshot()).toMatchObject({
      annotationSearchFocusMaskDrawCount: 1,
      annotationSearchFocusPrimitiveDrawCount: 1,
      annotationSearchFocusResolvedTrackId: 'mRNA',
      annotationSearchFocusResolvedCanonicalIdentity: 'canonical-TX41',
      annotationSearchFocusPresentationLane: temporaryLane,
      geometryRebuilds: resourcesBefore.geometryRebuilds,
      prepackedAnnotationSceneLayerCreates: resourcesBefore.prepackedAnnotationSceneLayerCreates,
      prepackedAnnotationSceneGpuPreparations:
        resourcesBefore.prepackedAnnotationSceneGpuPreparations,
      annotationPresentationOwners: resourcesBefore.annotationPresentationOwners,
    });
    expect(overlay.maxAnnotationLane).toBe(durableMaxLane);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toEqual(bodyOwner);
    expect(internals.prepackedAnnotationSceneLayer).toBe(bodyLayer);
    expect(bodyLayer.getAnnotationPolicyDebug()).toEqual(bodyPolicyBefore);
    expect(bodyLayer.getAnnotationPolicyDebug().glyphBufferIdentity).toBe(bodyBuffer);
    expect(bodyLayer.getSubmissionDebug()).toEqual(bodySubmissionBefore);

    rect.mockClear();
    poly.mockClear();
    renderState.annotationSearchFocus = null;
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);

    expect(rect).not.toHaveBeenCalled();
    expect(poly).not.toHaveBeenCalled();
    expect(internals.annotationSearchFocusGraphics.visible).toBe(false);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      annotationSearchFocusMaskDrawCount: 0,
      annotationSearchFocusPrimitiveDrawCount: 0,
      annotationSearchFocusResolvedTrackId: null,
      annotationSearchFocusResolvedCanonicalIdentity: null,
      annotationSearchFocusPresentationLane: null,
      geometryRebuilds: resourcesBefore.geometryRebuilds,
      prepackedAnnotationSceneLayerCreates: resourcesBefore.prepackedAnnotationSceneLayerCreates,
      prepackedAnnotationSceneGpuPreparations:
        resourcesBefore.prepackedAnnotationSceneGpuPreparations,
      annotationPresentationOwners: resourcesBefore.annotationPresentationOwners,
    });
    expect(overlay.maxAnnotationLane).toBe(durableMaxLane);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toEqual(bodyOwner);
    expect(internals.prepackedAnnotationSceneLayer).toBe(bodyLayer);
    expect(bodyLayer.getAnnotationPolicyDebug()).toEqual(bodyPolicyBefore);
    expect(bodyLayer.getAnnotationPolicyDebug().glyphBufferIdentity).toBe(bodyBuffer);
    expect(bodyLayer.getSubmissionDebug()).toEqual(bodySubmissionBefore);
    overlay.destroy();
  });

  it('destroys transient search-focus and interaction graphics with the overlay', () => {
    const overlay = new AnnotationOverlay();
    const internals = overlayPresenterInternals(overlay) as unknown as {
      annotationSearchFocusGraphics: { destroyed: boolean };
      interactionGraphics: { destroyed: boolean };
    };
    const focusGraphics = internals.annotationSearchFocusGraphics;
    const interactionGraphics = internals.interactionGraphics;

    expect(focusGraphics.destroyed).toBe(false);
    expect(interactionGraphics.destroyed).toBe(false);
    overlay.destroy();
    expect(focusGraphics.destroyed).toBe(true);
    expect(interactionGraphics.destroyed).toBe(true);
  });

  it('does not construct or retain owner-audit snapshots when production diagnostics are disabled', () => {
    window.__webglDiagnosticsEnabled = false;
    delete (globalThis as { __dna708OwnerAudit?: unknown }).__dna708OwnerAudit;

    const overlay = new AnnotationOverlay();
    prepare(overlay);
    expect(overlay.loadPrepackedAnnotationScene(sceneInput())).toBe(true);
    const retained = overlay.getRetainedLinearPresenterForTest();
    const snapshotBuilder = vi.spyOn(retained, 'buildPresentationDebugSnapshot');
    const drawAuditBuilder = vi.spyOn(retained, 'beginDrawAudit');

    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(150_000_000),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);

    expect(snapshotBuilder).not.toHaveBeenCalled();
    expect(drawAuditBuilder).not.toHaveBeenCalled();
    expect((globalThis as { __dna708OwnerAudit?: unknown }).__dna708OwnerAudit).toBeUndefined();

    const existingRing = { frames: [] as unknown[], maxFrames: 8_000 };
    (globalThis as { __dna708OwnerAudit?: typeof existingRing }).__dna708OwnerAudit = existingRing;
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(160_000_000),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(snapshotBuilder).not.toHaveBeenCalled();
    expect(drawAuditBuilder).not.toHaveBeenCalled();
    expect(existingRing.frames).toHaveLength(0);
    overlay.destroy();
  });

  it('records owner-audit frames only when a test explicitly leases the recorder', () => {
    window.__webglDiagnosticsEnabled = false;
    window.__webglExposeForTests = true;
    delete (globalThis as { __dna708OwnerAudit?: unknown }).__dna708OwnerAudit;

    const overlay = new AnnotationOverlay();
    prepare(overlay);
    expect(overlay.loadPrepackedAnnotationScene(sceneInput())).toBe(true);
    const snapshotBuilder = vi.spyOn(
      overlay.getRetainedLinearPresenterForTest(),
      'buildPresentationDebugSnapshot'
    );

    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(150_000_000),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);

    expect(snapshotBuilder).not.toHaveBeenCalled();
    expect((globalThis as { __dna708OwnerAudit?: unknown }).__dna708OwnerAudit).toBeUndefined();

    const ownerAudit = {
      frames: [] as Array<{ presenting: string[]; doubleDraw: boolean }>,
      maxFrames: 8_000,
      enabled: true,
    };
    (globalThis as { __dna708OwnerAudit?: typeof ownerAudit }).__dna708OwnerAudit = ownerAudit;
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(160_000_000),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);

    expect(snapshotBuilder).toHaveBeenCalledOnce();
    expect(ownerAudit.frames).toMatchObject([
      {
        presenting: ['prepacked-partitioned-vector-surface'],
        doubleDraw: false,
      },
    ]);
    overlay.destroy();
  });

  it('makes the RED control a real second owner for compact prepacked-first assemblies', () => {
    window.__webglExposeForTests = true;
    (globalThis as { __DNA708_FORCE_DOUBLE_DRAW?: boolean }).__DNA708_FORCE_DOUBLE_DRAW = true;
    const ownerAudit = {
      frames: [] as Array<{
        presenting: string[];
        doubleDraw: boolean;
        ownerViolations: string[];
      }>,
      maxFrames: 8_000,
      enabled: true,
    };
    (globalThis as { __dna708OwnerAudit?: typeof ownerAudit }).__dna708OwnerAudit = ownerAudit;

    const overlay = new AnnotationOverlay();
    prepare(overlay);
    expect(overlay.loadPrepackedAnnotationScene(sceneInput())).toBe(true);
    const packsBefore = getRetainedLinearTranscriptPackDebugSnapshot();
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(160_000_000),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);

    expect(ownerAudit.frames).toHaveLength(1);
    expect(ownerAudit.frames[0]).toMatchObject({
      presenting: ['prepacked-partitioned-vector-surface', 'active-segment-retained-surface'],
      doubleDraw: true,
    });
    expect(ownerAudit.frames[0]?.ownerViolations).toContain(
      'duplicate-exact-annotation-owner:transcript-body:prepacked-partitioned-vector-surface+active-segment-retained-surface'
    );
    const packsAfter = getRetainedLinearTranscriptPackDebugSnapshot();
    expect(packsAfter.count).toBe(packsBefore.count + 1);
    expect(packsAfter.blocks).toBe(1);

    (globalThis as { __DNA708_FORCE_DOUBLE_DRAW?: boolean }).__DNA708_FORCE_DOUBLE_DRAW = false;
    const release = overlay.releaseForcedDoubleDrawForTest();
    const restored = overlay.getDebugSnapshot();
    expect(release).toEqual({
      presenting: false,
      retainedBlockCount: 0,
      sentinelResident: false,
    });
    expect(
      restored.annotationPresentationOwners
        .filter((owner) => owner.visible && owner.visualGroups.length > 0)
        .map((owner) => owner.ownerId)
    ).toEqual(['prepacked-partitioned-vector-surface']);
    overlay.destroy();
  });

  it('keeps one owner through direct and reverse full-to-150M gestures with zero legacy builds', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const input = sceneInput();
    expect(overlay.loadPrepackedAnnotationScene(input)).toBe(true);
    expect(overlay.loadPrepackedAnnotationScene(input)).toBe(true);

    const ownerIds: Array<string | null> = [];
    for (const span of [...CORRIDOR_SPANS, ...CORRIDOR_SPANS.slice(0, -1).reverse()]) {
      expect(
        overlay.updateRetainedCamera({
          path: pathForSpan(span),
          state: state(),
          yOffset: 0,
          height: 500,
        })
      ).toBe(true);
      const debug = overlay.getDebugSnapshot();
      ownerIds.push(debug.annotationLodBackend);
      expect(debug.prepackedAnnotationSceneStatus).toBe('eligible');
      expect(debug.annotationPresentationOwnerViolations).toEqual([]);
      expect(debug.annotationPresentationOwners.filter((owner) => owner.visible)).toHaveLength(1);
      expect(debug.retainedTranscriptDecorationsDrawn).toBe(false);
    }

    expect(new Set(ownerIds)).toEqual(new Set(['prepacked-partitioned-vector-surface']));
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLayerCreates: 1,
      prepackedAnnotationSceneLayerDestroys: 0,
      prepackedAnnotationSceneCameraUpdates: 7,
      retainedLinearTranscriptBuilds: 0,
      overviewGlyphTilesBuildCount: 0,
    });
    overlay.destroy();
  });

  it('keeps the sharp raster at the fill knee and hands off to the already-resident vector scene', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    overlay.loadPrebuiltGenomeWideTexture({ width: 8192, height: 128 } as ImageBitmap, {
      widthPx: 8192,
      heightPx: 128,
      resolution: 1,
      spineOffsetPx: 64,
      genomeLength: L,
      semanticReceipt: exactExpandedRasterReceipt(),
    });
    expect(overlay.loadPrepackedAnnotationScene(runtimePolicySceneInput())).toBe(true);

    const observations: Array<{ span: number; owner: string | null }> = [];
    for (const span of [
      L,
      Math.floor(L * 0.8),
      Math.ceil(L * ANNOTATION_PREBUILT_RASTER_MESH_FILL_KNEE_FRACTION),
      Math.floor(L * (ANNOTATION_PREBUILT_RASTER_MESH_FILL_KNEE_FRACTION - 0.01)),
      150_000_000,
      27_000_000,
      2_000_000,
      1_000_000,
      PREPACKED_ANNOTATION_MIN_VISIBLE_BP,
    ]) {
      expect(
        overlay.updateRetainedCamera({
          path: pathForSpan(span),
          state: state(),
          yOffset: 0,
          height: 500,
        })
      ).toBe(true);
      const debug = overlay.getDebugSnapshot();
      const owners = debug.annotationPresentationOwners.filter((owner) => owner.visible);
      expect(owners).toHaveLength(1);
      expect(debug.prepackedAnnotationSceneLoaded).toBe(true);
      expect(debug.prepackedAnnotationSceneLayerCreates).toBe(1);
      expect(debug.prepackedAnnotationSceneLayerDestroys).toBe(0);
      expect(debug.retainedLinearDataBuilds).toBe(0);
      expect(debug.retainedLinearTranscriptBuilds).toBe(0);
      if (owners[0]?.ownerId === 'compiled-raster-surface') {
        expect(debug.prebuiltGenomeWideTextureContractMatch).toBe(true);
        expect(debug.prebuiltGenomeWideTexturePlacementMatch).toBe(true);
        expect(debug.prebuiltGenomeWideTextureLayerTypes).toEqual(['mRNA']);
        expect(owners[0]?.layerTypes).toEqual(['mRNA']);
      }
      observations.push({ span, owner: owners[0]?.ownerId ?? null });
    }

    expect(observations.map(({ owner }) => owner)).toEqual([
      'compiled-raster-surface',
      'compiled-raster-surface',
      'compiled-raster-surface',
      'prepacked-partitioned-vector-surface',
      'prepacked-partitioned-vector-surface',
      'prepacked-partitioned-vector-surface',
      'prepacked-partitioned-vector-surface',
      'prepacked-partitioned-vector-surface',
      'prepacked-partitioned-vector-surface',
    ]);
    overlay.destroy();
  });

  it('uses the exact expanded/8 raster at full-genome scale without submitting the vector owner', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const projection = exactExpandedRasterProjection(8);
    overlay.loadPrebuiltGenomeWideTexture({ width: 8192, height: 128 } as ImageBitmap, {
      widthPx: 8192,
      heightPx: projection.presentedHeightPx,
      resolution: 1,
      spineOffsetPx: projection.presentedSpineOffsetPx,
      genomeLength: L,
      semanticReceipt: exactExpandedRasterReceipt(),
      laneProjection: projection,
    });
    expect(overlay.loadPrepackedAnnotationScene(runtimePolicySceneInput())).toBe(true);
    expect(overlay.updatePrepackedAnnotationPolicy({ isoformMode: 'expanded', laneLimit: 8 })).toBe(
      true
    );

    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(L),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);

    const debug = overlay.getDebugSnapshot();
    expect(debug).toMatchObject({
      annotationLodBackend: 'compiled-raster-surface',
      prebuiltGenomeWideTextureContractMatch: true,
      prebuiltGenomeWideTextureVisible: true,
      prepackedAnnotationSceneCameraUpdates: 0,
      prepackedAnnotationSceneVisibleInstanceCount: 0,
    });
    expect(debug.annotationPresentationOwners.filter((owner) => owner.visible)).toEqual([
      expect.objectContaining({ ownerId: 'compiled-raster-surface' }),
    ]);
    overlay.destroy();
  });

  it('atomically replaces a finite-cap raster and policy without exposing the vector fallback', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const initialProjection = exactExpandedRasterProjection(8);
    overlay.loadPrebuiltGenomeWideTexture(
      { width: 8192, height: initialProjection.presentedHeightPx } as ImageBitmap,
      {
        widthPx: 8192,
        heightPx: initialProjection.presentedHeightPx,
        resolution: 1,
        spineOffsetPx: initialProjection.presentedSpineOffsetPx,
        genomeLength: L,
        semanticReceipt: exactExpandedRasterReceipt(),
        laneProjection: initialProjection,
      }
    );
    expect(overlay.loadPrepackedAnnotationScene(runtimePolicySceneInput())).toBe(true);
    expect(overlay.updatePrepackedAnnotationPolicy({ isoformMode: 'expanded', laneLimit: 8 })).toBe(
      true
    );
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(L),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      annotationLodBackend: 'compiled-raster-surface',
      prepackedAnnotationSceneVisibleInstanceCount: 0,
    });

    const replacementProjection = exactExpandedRasterProjection(24);
    expect(
      overlay.commitPrebuiltGenomeWideTexturePolicy(
        { width: 8192, height: replacementProjection.presentedHeightPx } as ImageBitmap,
        {
          widthPx: 8192,
          heightPx: replacementProjection.presentedHeightPx,
          resolution: 1,
          spineOffsetPx: replacementProjection.presentedSpineOffsetPx,
          genomeLength: L,
          semanticReceipt: exactExpandedRasterReceipt(),
          laneProjection: replacementProjection,
        },
        { isoformMode: 'expanded', laneLimit: 24 }
      )
    ).toBe(true);
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(L),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);

    const debug = overlay.getDebugSnapshot();
    expect(debug).toMatchObject({
      annotationLodBackend: 'compiled-raster-surface',
      prebuiltGenomeWideTextureContractMatch: true,
      prebuiltGenomeWideTextureVisible: true,
      prepackedAnnotationSceneCameraUpdates: 0,
      prepackedAnnotationSceneVisibleInstanceCount: 0,
    });
    expect(overlay.getColdGestureSnapshot().prepackedRuntimeLaneLimit).toBe(24);
    expect(debug.annotationPresentationOwners.filter((owner) => owner.visible)).toEqual([
      expect.objectContaining({ ownerId: 'compiled-raster-surface' }),
    ]);
    overlay.destroy();
  });

  it('retains a decoded raster across loadGenome but refuses it for mismatched active provenance', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    overlay.loadPrebuiltGenomeWideTexture({ width: 8192, height: 128 } as ImageBitmap, {
      widthPx: 8192,
      heightPx: 128,
      resolution: 1,
      spineOffsetPx: 64,
      genomeLength: L,
      semanticReceipt: exactExpandedRasterReceipt(),
    });
    expect(overlay.loadPrepackedAnnotationScene(runtimePolicySceneInput())).toBe(true);
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(L),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prebuiltGenomeWideTextureLoaded: true,
      prebuiltGenomeWideTextureContractMatch: true,
      prebuiltGenomeWideTextureVisible: true,
    });

    overlay.loadGenome(
      genome('hg002-grch38', ['mRNA'], 'hg002-grch38-source', {
        contract: PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1,
        sourceFingerprint: 'fedcba9876543210fedcba98',
        placementFingerprint: 'ap1:0123456789abcdef01234567',
      })
    );
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prebuiltGenomeWideTextureLoaded: true,
      prebuiltGenomeWideTextureContractMatch: false,
      prebuiltGenomeWideTextureVisible: false,
    });

    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(L),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    const debug = overlay.getDebugSnapshot();
    expect(debug).toMatchObject({
      prebuiltGenomeWideTextureLoaded: true,
      prebuiltGenomeWideTextureContractMatch: false,
      prebuiltGenomeWideTextureSourceMatch: false,
      prebuiltGenomeWideTexturePlacementMatch: true,
      prebuiltGenomeWideTextureSourceFingerprint: '0123456789abcdef01234567',
      prebuiltGenomeWideTexturePlacementFingerprint: 'ap1:0123456789abcdef01234567',
    });
    expect(debug.annotationPresentationOwners.filter((owner) => owner.visible)).toEqual([
      expect.objectContaining({ ownerId: 'prepacked-partitioned-vector-surface' }),
    ]);
    overlay.destroy();
  });

  it('does not let a flat presentation snapshot erase host-validated raster provenance', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    overlay.loadPrebuiltGenomeWideTexture({ width: 8192, height: 32 } as ImageBitmap, {
      widthPx: 8192,
      heightPx: 32,
      resolution: 1,
      spineOffsetPx: 31,
      genomeLength: L,
      semanticReceipt: exactExpandedRasterReceipt(),
      laneProjection: exactExpandedRasterProjection(null),
    });
    expect(overlay.loadPrepackedAnnotationScene(runtimePolicySceneInput())).toBe(true);
    const camera = {
      path: pathForSpan(L),
      state: state(),
      yOffset: 0,
      height: 500,
    };
    expect(overlay.updateRetainedCamera(camera)).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prebuiltGenomeWideTextureContractMatch: true,
      prebuiltGenomeWideTextureSourceMatch: true,
      prebuiltGenomeWideTexturePlacementMatch: true,
      prebuiltGenomeWideTextureVisible: true,
    });

    const snapshot: AnnotationPresentationSnapshot = {
      contract: 'annotation-presentation-snapshot.v1',
      sourceIdentity: 'hg002-grch38-source',
      genomeLengthBp: L,
      policyKey: 'mRNA:expanded:uncapped',
      generation: 1,
      features: genome().features ?? [],
      requestedLayerTypes: ['mRNA'],
      layout: { maxAnnotationLane: 1, maxCdsLane: -1 },
      exactCoverage: [{ startBp: 0, endBp: L }],
    };
    expect(overlay.setAnnotationFlatPresentationSnapshot(snapshot)).toMatchObject({
      status: 'applied',
    });
    expect(overlay.updateRetainedCamera(camera)).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prebuiltGenomeWideTextureContractMatch: true,
      prebuiltGenomeWideTextureSourceMatch: true,
      prebuiltGenomeWideTexturePlacementMatch: true,
      prebuiltGenomeWideTextureVisible: true,
    });
    overlay.destroy();
  });

  it('preserves the immutable buffer and stable hit feature index across same-genome streaming updates', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    expect(overlay.loadPrepackedAnnotationScene(sceneInput())).toBe(true);
    expect(overlay.getPrepackedAnnotationFeatureIndex('bp-partition-15', 0)).toBe(0);

    overlay.loadGenome({ ...genome(), features: [...(genome().features ?? [])] });
    overlay.setLayout(layout());
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(150_000_000),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);

    expect(overlay.getPrepackedAnnotationFeatureIndex('bp-partition-15', 0)).toBe(0);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStatus: 'eligible',
      prepackedAnnotationSceneLayerCreates: 1,
      prepackedAnnotationSceneLayerDestroys: 0,
    });
    overlay.destroy();
  });

  it('default-deny hides a previously presenting legacy owner before the prepacked owner presents', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    (
      globalThis as { __WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES?: boolean }
    ).__WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES = false;
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(L),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot().annotationLodBackend).not.toBe(
      'prepacked-partitioned-vector-surface'
    );

    expect(overlay.loadPrepackedAnnotationScene(sceneInput())).toBe(true);
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(L),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    const visible = overlay
      .getDebugSnapshot()
      .annotationPresentationOwners.filter((owner) => owner.visible);
    expect(visible.map(({ ownerId }) => ownerId)).toEqual(['prepacked-partitioned-vector-surface']);
    overlay.destroy();
  });

  it('accepts the exact mRNA resident when another selected type has its own per-track owner', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, genome('hg002-grch38', ['mRNA', 'enhancer']));
    expect(overlay.loadPrepackedAnnotationScene(sceneInput())).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStatus: 'eligible',
      prepackedAnnotationSceneLoaded: true,
      prepackedAnnotationSceneLayerCreates: 1,
    });
    overlay.destroy();
  });

  it.each(['gene', 'enhancer'])(
    'admits a compiler-produced, coupled %s source-shape artifact through the generic resident path',
    (trackType) => {
      const overlay = new AnnotationOverlay();
      prepare(overlay, genome('hg002-grch38', [trackType]));
      const input = compiledSourceShapeSceneInput({
        trackType,
        rendererId: 47,
        ownerKey: `prepared-${trackType}`,
        displayName: `${trackType}-47`,
        direction: 'reverse',
      });

      expect(overlay.loadPrepackedAnnotationScene(input)).toBe(true);
      expect(overlay.getDebugSnapshot()).toMatchObject({
        prepackedAnnotationSceneStatus: 'eligible',
        prepackedAnnotationSceneLoaded: true,
        prepackedAnnotationSceneLayerCreates: 1,
      });
      overlay.destroy();
    }
  );

  it('rejects a valid artifact whose metadata names an unrequested track', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, genome('hg002-grch38', ['enhancer']));
    expect(overlay.loadPrepackedAnnotationScene(sceneInput())).toBe(false);
    const debug = overlay.getDebugSnapshot();
    expect(debug.prepackedAnnotationSceneStatus).toBe('mixed-layer-fallback');
    expect(debug.prepackedAnnotationSceneLoaded).toBe(false);
    expect(debug.prepackedAnnotationSceneLayerCreates).toBe(0);
    overlay.destroy();
  });

  it('rejects a scene containing source-shape families even for a transcript-only request', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const input = sceneInput();
    input.scene.families.push({ id: 'enhancer', kind: 'source-shape', metadata: {} });
    expect(overlay.loadPrepackedAnnotationScene(input)).toBe(false);
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneStatus).toBe(
      'scene-contains-source-shape'
    );
    overlay.destroy();
  });

  it('fails legacy or internally inconsistent artifact metadata closed at the renderer boundary', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    expect(
      overlay.loadPrepackedAnnotationScene(
        sceneInput({
          artifactKey:
            'annotation-scene.v1|mRNA-only|light|bar:14|lanes:source-lanes.v1|geometry:retained-linear-directional-block.v1',
        })
      )
    ).toBe(false);
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneStatus).toBe('variant-mismatch');

    expect(
      overlay.loadPrepackedAnnotationScene(
        sceneInput({
          artifactKey: prepackedAnnotationSceneArtifactKey({
            themeMode: 'light',
            trackType: 'lnc_RNA',
          }),
        })
      )
    ).toBe(false);
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneStatus).toBe('variant-mismatch');
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneLayerCreates).toBe(0);
    overlay.destroy();
  });

  it('destroys once and falls back on true genome identity mismatch', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    expect(overlay.loadPrepackedAnnotationScene(sceneInput())).toBe(true);
    overlay.loadGenome(genome('hg002-grch38', ['mRNA'], 'different-source-same-length'));
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLoaded: false,
      prepackedAnnotationSceneStatus: 'genome-mismatch',
      prepackedAnnotationSceneLayerCreates: 1,
      prepackedAnnotationSceneLayerDestroys: 1,
    });
    overlay.clearPrepackedAnnotationScene();
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneLayerDestroys).toBe(1);
    overlay.destroy();
  });

  it('destroys every compatible resident owner on a true source identity mismatch', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const canonical = sceneInput({}, 'source-canonical');
    const expanded = sceneInput({}, 'source-expanded');
    expect(overlay.loadPrepackedAnnotationScene(canonical)).toBe(true);
    expect(overlay.loadPrepackedAnnotationScene(expanded)).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneResidentOwnerCount: 2,
      prepackedAnnotationSceneLayerCreates: 2,
      prepackedAnnotationSceneLayerDestroys: 0,
    });

    overlay.loadGenome(genome('hg002-grch38', ['mRNA'], 'different-source-same-length'));
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLoaded: false,
      prepackedAnnotationSceneStatus: 'genome-mismatch',
      prepackedAnnotationSceneResidentOwnerCount: 0,
      prepackedAnnotationSceneLayerCreates: 2,
      prepackedAnnotationSceneLayerDestroys: 2,
    });
    overlay.destroy();
  });

  it('bounds the resident bank at sixteen owners with deterministic least-recently-used eviction', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const owners = Array.from({ length: 17 }, (_, index) =>
      sceneInput({}, `lru-${String(index).padStart(2, '0')}`)
    );
    for (const owner of owners) expect(overlay.loadPrepackedAnnotationScene(owner)).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneResidentOwnerCount: 16,
      prepackedAnnotationSceneLayerCreates: 17,
      prepackedAnnotationSceneLayerDestroys: 1,
      prepackedAnnotationSceneGpuPreparations: 17,
    });

    expect(overlay.loadPrepackedAnnotationScene(owners[0])).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneResidentOwnerCount: 16,
      prepackedAnnotationSceneLayerCreates: 18,
      prepackedAnnotationSceneLayerDestroys: 2,
      prepackedAnnotationSceneGpuPreparations: 18,
    });
    overlay.destroy();
  });

  it('evicts an unselected resident before any resident required by the current selected set', () => {
    const protectedTrackTypes = ['mRNA', 'lnc_RNA', 'enhancer'];
    const fillerTrackTypes = Array.from({ length: 13 }, (_, index) => `filler-${index}`);
    const initialTrackTypes = [...protectedTrackTypes, ...fillerTrackTypes];
    const overlay = new AnnotationOverlay();
    prepare(overlay, genome('hg002-grch38', initialTrackTypes));

    for (let index = 0; index < initialTrackTypes.length; index += 1) {
      const trackType = initialTrackTypes[index];
      expect(
        overlay.preparePrepackedAnnotationScene(
          compiledSourceShapeSceneInput({
            trackType,
            rendererId: 1_000 + index,
            ownerKey: `resident-${trackType}`,
            displayName: `RESIDENT-${trackType}`,
          })
        )
      ).toBe(true);
    }
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneResidentOwnerCount).toBe(16);

    const joiningTrackType = 'joining-track';
    overlay.loadGenome(genome('hg002-grch38', [...protectedTrackTypes, joiningTrackType]));
    overlay.setLayout(layout());
    expect(
      overlay.preparePrepackedAnnotationScene(
        compiledSourceShapeSceneInput({
          trackType: joiningTrackType,
          rendererId: 2_000,
          ownerKey: `resident-${joiningTrackType}`,
          displayName: 'JOINING',
        })
      )
    ).toBe(true);

    const preparedOwnerKeys = overlay.getDebugSnapshot().prepackedAnnotationScenePreparedOwnerKeys;
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneResidentOwnerCount).toBe(16);
    expect(preparedOwnerKeys).toEqual(
      expect.arrayContaining([
        'resident-mRNA',
        'resident-lnc_RNA',
        'resident-enhancer',
        'resident-joining-track',
      ])
    );
    expect(preparedOwnerKeys).not.toContain('resident-filler-0');
    overlay.destroy();
  });

  it('retains every selected resident when the selected set exceeds the ordinary LRU limit', () => {
    const selectedTrackTypes = Array.from({ length: 17 }, (_, index) => `selected-${index}`);
    const overlay = new AnnotationOverlay();
    prepare(overlay, genome('hg002-grch38', selectedTrackTypes));

    for (let index = 0; index < selectedTrackTypes.length; index += 1) {
      const trackType = selectedTrackTypes[index];
      expect(
        overlay.preparePrepackedAnnotationScene(
          compiledSourceShapeSceneInput({
            trackType,
            rendererId: 3_000 + index,
            ownerKey: `resident-${trackType}`,
            displayName: `SELECTED-${index}`,
          })
        )
      ).toBe(true);
    }

    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneResidentOwnerCount: 17,
      prepackedAnnotationScenePreparedOwnerKeys: selectedTrackTypes
        .map((trackType) => `resident-${trackType}`)
        .sort((left, right) => left.localeCompare(right)),
    });
    overlay.destroy();
  });

  it('presents and hit-tests prepared tracks using realized lanes rather than reserving the global cap', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, genome('hg002-grch38', ['mRNA', 'lnc_RNA', 'enhancer']));
    const mrna = directBankRuntimePolicySceneInput();
    mrna.ownerKey = 'prepared-mrna';
    const lncRna = typedRuntimePolicySceneInput({
      trackType: 'lnc_RNA',
      rendererId: 44,
      ownerKey: 'prepared-lncrna',
      displayName: 'LNC44',
    });
    const enhancer = compiledSourceShapeSceneInput({
      trackType: 'enhancer',
      rendererId: 47,
      ownerKey: 'prepared-enhancer',
      displayName: 'ENH47',
    });
    expect(overlay.preparePrepackedAnnotationScene(mrna)).toBe(true);
    expect(overlay.preparePrepackedAnnotationScene(lncRna)).toBe(true);
    expect(overlay.preparePrepackedAnnotationScene(enhancer)).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: null,
      loaded: false,
    });
    const path = pathForSpan(70_000_000);
    const renderState = state();
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    const residentMap = (
      overlayPresenterInternals(overlay) as unknown as {
        prepackedAnnotationSceneResidents: Map<
          string,
          {
            policyGeneration: number;
            input: {
              interactionIndex: { featureCount: number; primitiveCount: number } | null;
            };
            layer: PartitionedInstancedTranscriptLayerType;
          }
        >;
      }
    ).prepackedAnnotationSceneResidents;
    expect(residentMap.get('prepared-mrna')!.layer.getSubmissionDebug()).toMatchObject({
      activeMode: 'canonical',
      actualSubmittedInstanceCount: 1,
      hiddenByIsoformMembershipInstanceCount: 1,
      hiddenByLaneCapInstanceCount: 1,
    });
    expect(
      overlay.updatePrepackedAnnotationPolicy({ isoformMode: 'expanded', laneLimit: 12 })
    ).toBe(true);
    const residentPolicies = [...residentMap.entries()]
      .map(
        ([ownerKey, resident]) =>
          [
            ownerKey,
            resident.policyGeneration,
            resident.layer.getAnnotationPolicyDebug().runtime,
          ] as const
      )
      .sort(([left], [right]) => left.localeCompare(right));
    expect(residentPolicies).toEqual([
      ['prepared-enhancer', 1, { isoformMode: 'expanded', laneLimit: 12 }],
      ['prepared-lncrna', 1, { isoformMode: 'expanded', laneLimit: 12 }],
      ['prepared-mrna', 1, { isoformMode: 'expanded', laneLimit: 12 }],
    ]);
    expect(residentMap.get('prepared-mrna')!.layer.getSubmissionDebug()).toMatchObject({
      activeMode: 'expanded',
      actualSubmittedInstanceCount: 3,
      hiddenByIsoformMembershipInstanceCount: 0,
      hiddenByLaneCapInstanceCount: 0,
    });
    expect(overlay.maxAnnotationLane).toBe(9);

    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneResidentOwnerCount: 3,
      prepackedAnnotationSceneVisibleResidentOwnerKeys: [
        'prepared-enhancer',
        'prepared-lncrna',
        'prepared-mrna',
      ],
      prepackedAnnotationSceneVisiblePartitionCount: 3,
    });
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneVisibleInstanceCount).toBeGreaterThan(
      2
    );
    const expectedInteractionFeatureCount = [...residentMap.values()].reduce(
      (count, resident) => count + (resident.input.interactionIndex?.featureCount ?? 0),
      0
    );
    const expectedInteractionPrimitiveCount = [...residentMap.values()].reduce(
      (count, resident) => count + (resident.input.interactionIndex?.primitiveCount ?? 0),
      0
    );
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationInteractionReady: true,
      prepackedAnnotationInteractionFeatureCount: expectedInteractionFeatureCount,
      prepackedAnnotationInteractionPrimitiveCount: expectedInteractionPrimitiveCount,
    });
    expect(
      overlay
        .getDebugSnapshot()
        .annotationPresentationOwners.find(
          ({ ownerId }) => ownerId === 'prepacked-partitioned-vector-surface'
        )
    ).toMatchObject({
      visible: true,
      coverageComplete: true,
      layerTypes: ['enhancer', 'lnc_RNA', 'mRNA'],
    });

    const x = path.bpLeftX(1_544_005_000);
    expect(overlay.hitTest(x, path.fwdStrandTop - 88, path, renderState)).toMatchObject({
      payload: { id: 41, type: 'mRNA', displayName: 'TX41' },
    });
    expect(overlay.hitTest(x, path.fwdStrandTop - 120, path, renderState)).toMatchObject({
      payload: { id: 44, type: 'lnc_RNA', displayName: 'LNC44' },
    });
    expect(overlay.hitTest(x, path.fwdStrandTop - 152, path, renderState)).toMatchObject({
      payload: { id: 0, type: 'enhancer', displayName: 'ENH47' },
    });

    renderState.hoveredId = 41;
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    expect(overlay.getDebugSnapshot().lastInteractionOutlineCommandCount).toBe(1);
    overlay.destroy();
  });

  it('rolls every prepared track back when one resident rejects a shared policy transaction', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, genome('hg002-grch38', ['mRNA', 'lnc_RNA']));
    expect(
      overlay.preparePrepackedAnnotationScene(
        typedRuntimePolicySceneInput({
          trackType: 'mRNA',
          rendererId: 41,
          ownerKey: 'rollback-mrna',
          displayName: 'MRNA41',
        })
      )
    ).toBe(true);
    expect(
      overlay.preparePrepackedAnnotationScene(
        typedRuntimePolicySceneInput({
          trackType: 'lnc_RNA',
          rendererId: 44,
          ownerKey: 'rollback-lncrna',
          displayName: 'LNC44',
        })
      )
    ).toBe(true);

    const internals = overlayPresenterInternals(overlay) as unknown as {
      prepackedAnnotationPolicyGeneration: number;
      prepackedAnnotationSceneResidents: Map<
        string,
        {
          policyGeneration: number;
          layer: PartitionedInstancedTranscriptLayerType;
        }
      >;
    };
    const mrna = internals.prepackedAnnotationSceneResidents.get('rollback-mrna')!;
    const lncRna = internals.prepackedAnnotationSceneResidents.get('rollback-lncrna')!;
    const generationBefore = internals.prepackedAnnotationPolicyGeneration;
    const mrnaBefore = mrna.layer.getAnnotationPolicyDebug();
    const lncRnaBefore = lncRna.layer.getAnnotationPolicyDebug();
    vi.spyOn(lncRna.layer, 'beginAnnotationPolicyTransaction').mockReturnValueOnce(null);

    expect(
      overlay.updatePrepackedAnnotationPolicy({ isoformMode: 'expanded', laneLimit: 12 })
    ).toBe(false);
    expect(mrna.layer.getAnnotationPolicyDebug()).toMatchObject({
      runtime: mrnaBefore.runtime,
      updateCount: mrnaBefore.updateCount,
    });
    expect(lncRna.layer.getAnnotationPolicyDebug()).toMatchObject({
      runtime: lncRnaBefore.runtime,
      updateCount: lncRnaBefore.updateCount,
    });
    expect(internals.prepackedAnnotationPolicyGeneration).toBe(generationBefore);
    expect(mrna.policyGeneration).toBe(generationBefore);
    expect(lncRna.policyGeneration).toBe(generationBefore);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot().runtimePolicy).toEqual({
      isoformMode: 'canonical',
      laneLimit: 2,
    });
    overlay.destroy();
  });

  it('rolls every prepared track back when a resident policy begin throws', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, genome('hg002-grch38', ['mRNA', 'lnc_RNA']));
    for (const input of [
      typedRuntimePolicySceneInput({
        trackType: 'mRNA',
        rendererId: 41,
        ownerKey: 'throw-begin-mrna',
        displayName: 'MRNA41',
      }),
      typedRuntimePolicySceneInput({
        trackType: 'lnc_RNA',
        rendererId: 44,
        ownerKey: 'throw-begin-lncrna',
        displayName: 'LNC44',
      }),
    ]) {
      expect(overlay.preparePrepackedAnnotationScene(input)).toBe(true);
    }
    const residents = (
      overlayPresenterInternals(overlay) as unknown as {
        prepackedAnnotationSceneResidents: Map<
          string,
          { layer: PartitionedInstancedTranscriptLayerType }
        >;
      }
    ).prepackedAnnotationSceneResidents;
    const mrna = residents.get('throw-begin-mrna')!.layer;
    const lncRna = residents.get('throw-begin-lncrna')!.layer;
    const before = [mrna, lncRna].map((layer) => ({
      policy: layer.getAnnotationPolicyDebug(),
      submission: layer.getSubmissionDebug(),
    }));
    vi.spyOn(lncRna, 'beginAnnotationPolicyTransaction').mockImplementationOnce(() => {
      throw new Error('injected begin failure');
    });

    expect(
      overlay.updatePrepackedAnnotationPolicy({ isoformMode: 'expanded', laneLimit: 12 })
    ).toBe(false);
    for (const [index, layer] of [mrna, lncRna].entries()) {
      expect(layer.getAnnotationPolicyDebug()).toMatchObject(before[index].policy);
      expect(layer.getSubmissionDebug()).toEqual(before[index].submission);
    }
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      runtimePolicy: { isoformMode: 'canonical', laneLimit: 2 },
      policyGeneration: 0,
    });
    expect(
      overlay.updatePrepackedAnnotationPolicy({ isoformMode: 'expanded', laneLimit: 12 })
    ).toBe(true);
    overlay.destroy();
  });

  it('preflights every resident receipt before any irreversible policy finalize', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, genome('hg002-grch38', ['mRNA', 'lnc_RNA']));
    for (const input of [
      typedRuntimePolicySceneInput({
        trackType: 'mRNA',
        rendererId: 41,
        ownerKey: 'preflight-mrna',
        displayName: 'MRNA41',
      }),
      typedRuntimePolicySceneInput({
        trackType: 'lnc_RNA',
        rendererId: 44,
        ownerKey: 'preflight-lncrna',
        displayName: 'LNC44',
      }),
    ]) {
      expect(overlay.preparePrepackedAnnotationScene(input)).toBe(true);
    }
    const residents = (
      overlayPresenterInternals(overlay) as unknown as {
        prepackedAnnotationSceneResidents: Map<
          string,
          { layer: PartitionedInstancedTranscriptLayerType }
        >;
      }
    ).prepackedAnnotationSceneResidents;
    const mrna = residents.get('preflight-mrna')!.layer;
    const lncRna = residents.get('preflight-lncrna')!.layer;
    const before = [mrna, lncRna].map((layer) => ({
      policy: layer.getAnnotationPolicyDebug(),
      submission: layer.getSubmissionDebug(),
    }));
    const mrnaCommit = vi.spyOn(mrna, 'commitAnnotationPolicyTransaction');
    const lncRnaCommit = vi.spyOn(lncRna, 'commitAnnotationPolicyTransaction');
    vi.spyOn(lncRna, 'canCommitAnnotationPolicyTransaction').mockReturnValueOnce(false);

    expect(
      overlay.updatePrepackedAnnotationPolicy({ isoformMode: 'expanded', laneLimit: 12 })
    ).toBe(false);
    expect(mrnaCommit).not.toHaveBeenCalled();
    expect(lncRnaCommit).not.toHaveBeenCalled();
    for (const [index, layer] of [mrna, lncRna].entries()) {
      expect(layer.getAnnotationPolicyDebug()).toMatchObject(before[index].policy);
      expect(layer.getSubmissionDebug()).toEqual(before[index].submission);
    }
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      runtimePolicy: { isoformMode: 'canonical', laneLimit: 2 },
      policyGeneration: 0,
    });
    expect(
      overlay.updatePrepackedAnnotationPolicy({ isoformMode: 'expanded', laneLimit: 12 })
    ).toBe(true);
    overlay.destroy();
  });

  it('keeps the committed viewer policy authoritative when a prepared resident activates', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, genome('hg002-grch38', ['mRNA']));
    const first = typedRuntimePolicySceneInput({
      trackType: 'mRNA',
      rendererId: 41,
      ownerKey: 'activation-policy-first',
      displayName: 'FIRST',
    });
    const second = typedRuntimePolicySceneInput({
      trackType: 'mRNA',
      rendererId: 42,
      ownerKey: 'activation-policy-second',
      displayName: 'SECOND',
    });
    expect(overlay.loadPrepackedAnnotationScene(first)).toBe(true);
    expect(overlay.preparePrepackedAnnotationScene(second)).toBe(true);
    overlay.clearCompiledBroadSurfaceManifest();
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot().runtimePolicy).toEqual({
      isoformMode: 'canonical',
      laneLimit: 2,
    });
    expect(
      overlay.updatePrepackedAnnotationPolicy({ isoformMode: 'expanded', laneLimit: 12 })
    ).toBe(true);

    expect(overlay.activatePrepackedAnnotationScene(second.ownerKey)).toBe(true);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: second.ownerKey,
      runtimePolicy: { isoformMode: 'expanded', laneLimit: 12 },
      policyGeneration: 1,
    });
    const internals = overlayPresenterInternals(overlay) as unknown as {
      prepackedAnnotationSceneLayer: PartitionedInstancedTranscriptLayerType;
      destroyPrepackedAnnotationSceneResident: (ownerKey: string, status: 'not-loaded') => void;
    };
    const activeLayer = internals.prepackedAnnotationSceneLayer;
    expect(activeLayer.getAnnotationPolicyDebug().runtime).toEqual({
      isoformMode: 'expanded',
      laneLimit: 12,
    });
    internals.destroyPrepackedAnnotationSceneResident(second.ownerKey, 'not-loaded');
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: null,
      loaded: false,
      runtimePolicy: { isoformMode: 'expanded', laneLimit: 12 },
      policyGeneration: 1,
    });
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(70_000_000),
        state: state(),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneVisibleResidentOwnerKeys).toEqual([
      first.ownerKey,
    ]);
    overlay.destroy();
  });

  it('never presents a prepared subset when one newly requested resident is missing', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, genome('hg002-grch38', ['mRNA', 'lnc_RNA']));
    expect(
      overlay.preparePrepackedAnnotationScene(
        typedRuntimePolicySceneInput({
          trackType: 'mRNA',
          rendererId: 41,
          ownerKey: 'atomic-mrna',
          displayName: 'MRNA41',
        })
      )
    ).toBe(true);
    expect(
      overlay.preparePrepackedAnnotationScene(
        typedRuntimePolicySceneInput({
          trackType: 'lnc_RNA',
          rendererId: 44,
          ownerKey: 'atomic-lncrna',
          displayName: 'LNC44',
        })
      )
    ).toBe(true);

    const path = pathForSpan(70_000_000);
    const renderState = state();
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneVisibleResidentOwnerKeys).toEqual([
      'atomic-lncrna',
      'atomic-mrna',
    ]);
    expect(overlay.getColdGestureSnapshot()).toMatchObject({
      soleOwnerCount: 1,
      soleOwnerId: 'prepacked-partitioned-vector-surface',
      soleOwnerLayerTypes: ['lnc_RNA', 'mRNA'],
      soleOwnerVisualGroups: ['transcript-body', 'cds-exon', 'intron-connector'],
      soleOwnerCoverageComplete: true,
      prepackedRequestedResidentCount: 2,
      prepackedRequestedResidentRosterReady: true,
      prepackedSubmittedPartitionCount: 2,
      prepackedSubmittedInstanceCount: 2,
    });

    overlay.loadGenome(genome('hg002-grch38', ['mRNA', 'lnc_RNA', 'enhancer']));
    overlay.setLayout(layout());
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStatus: 'holding-last-good',
      prepackedAnnotationSceneVisibleResidentOwnerKeys: ['atomic-lncrna', 'atomic-mrna'],
    });
    expect(
      overlay
        .getDebugSnapshot()
        .annotationPresentationOwners.find(
          ({ ownerId }) => ownerId === 'prepacked-partitioned-vector-surface'
        )
    ).toMatchObject({
      visible: true,
      coverageComplete: true,
      layerTypes: ['lnc_RNA', 'mRNA'],
    });

    expect(
      overlay.preparePrepackedAnnotationScene(
        compiledSourceShapeSceneInput({
          trackType: 'enhancer',
          rendererId: 47,
          ownerKey: 'atomic-enhancer',
          displayName: 'ENH47',
        })
      )
    ).toBe(true);
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStatus: 'eligible',
      prepackedAnnotationSceneVisibleResidentOwnerKeys: [
        'atomic-enhancer',
        'atomic-lncrna',
        'atomic-mrna',
      ],
    });
    overlay.destroy();
  });

  it('keeps a disjoint last-good set in its own lanes and interaction plane while replacement loads', () => {
    const updateCamera = vi.spyOn(PartitionedInstancedTranscriptLayer.prototype, 'updateCamera');
    const overlay = new AnnotationOverlay();
    prepare(overlay, genome('hg002-grch38', ['mRNA', 'lnc_RNA']));
    expect(
      overlay.preparePrepackedAnnotationScene(
        typedRuntimePolicySceneInput({
          trackType: 'mRNA',
          rendererId: 41,
          ownerKey: 'held-mrna',
          displayName: 'HELD-MRNA',
        })
      )
    ).toBe(true);
    expect(
      overlay.preparePrepackedAnnotationScene(
        typedRuntimePolicySceneInput({
          trackType: 'lnc_RNA',
          rendererId: 44,
          ownerKey: 'held-lncrna',
          displayName: 'HELD-LNC',
        })
      )
    ).toBe(true);

    const path = pathForSpan(70_000_000);
    const renderState = state();
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    updateCamera.mockClear();

    overlay.loadGenome(genome('hg002-grch38', ['enhancer']));
    overlay.setLayout(layout());
    expect(
      overlay.updateRetainedCamera({ path, state: renderState, yOffset: 0, height: 500 })
    ).toBe(true);
    expect(updateCamera.mock.calls.map((call) => Number(call[4])).sort((a, b) => a - b)).toEqual([
      -33, -1,
    ]);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStatus: 'holding-last-good',
      prepackedAnnotationSceneVisibleResidentOwnerKeys: ['held-lncrna', 'held-mrna'],
    });
    expect(
      overlay
        .getDebugSnapshot()
        .annotationPresentationOwners.find(
          ({ ownerId }) => ownerId === 'prepacked-partitioned-vector-surface'
        )
    ).toMatchObject({
      visible: true,
      coverageComplete: true,
      layerTypes: ['lnc_RNA', 'mRNA'],
    });

    const x = path.bpLeftX(1_544_005_000);
    expect(overlay.hitTest(x, path.fwdStrandTop - 8, path, renderState)).toMatchObject({
      payload: { id: 41, type: 'mRNA' },
    });
    expect(overlay.hitTest(x, path.fwdStrandTop - 40, path, renderState)).toMatchObject({
      payload: { id: 44, type: 'lnc_RNA' },
    });
    overlay.destroy();
  });

  it('invalidates the complete-set receipt when any recorded resident is destroyed', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, genome('hg002-grch38', ['mRNA', 'lnc_RNA']));
    expect(
      overlay.preparePrepackedAnnotationScene(
        typedRuntimePolicySceneInput({
          trackType: 'mRNA',
          rendererId: 41,
          ownerKey: 'receipt-mrna',
          displayName: 'RECEIPT-MRNA',
        })
      )
    ).toBe(true);
    expect(
      overlay.preparePrepackedAnnotationScene(
        typedRuntimePolicySceneInput({
          trackType: 'lnc_RNA',
          rendererId: 44,
          ownerKey: 'receipt-lncrna',
          displayName: 'RECEIPT-LNC',
        })
      )
    ).toBe(true);

    const path = pathForSpan(70_000_000);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneVisibleResidentOwnerKeys).toEqual([
      'receipt-lncrna',
      'receipt-mrna',
    ]);

    expect(
      overlay.preparePrepackedAnnotationScene(
        typedRuntimePolicySceneInput({
          trackType: 'mRNA',
          rendererId: 45,
          ownerKey: 'receipt-lncrna',
          displayName: 'CONFLICTING-MRNA',
        })
      )
    ).toBe(false);
    overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 });
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneVisibleResidentOwnerKeys).toEqual([]);
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneStatus).not.toBe('holding-last-good');
    overlay.destroy();
  });

  it('keeps both resident GPU owners across a layout shift and updates only the shared track-base camera uniform', () => {
    const updateCamera = vi.spyOn(PartitionedInstancedTranscriptLayer.prototype, 'updateCamera');
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    expect(overlay.loadPrepackedAnnotationScene(sceneInput({}, 'layout-a'))).toBe(true);
    expect(overlay.loadPrepackedAnnotationScene(sceneInput({}, 'layout-b'))).toBe(true);
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneResidentOwnerCount).toBe(2);
    const path = pathForSpan(200_000_000);
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    expect(updateCamera).toHaveBeenLastCalledWith(
      expect.anything(),
      1600,
      500,
      expect.anything(),
      -1,
      'light',
      undefined
    );

    overlay.setLayout({ ...layout(), annotationOffset: -24 });
    expect(overlay.updateRetainedCamera({ path, state: state(), yOffset: 0, height: 500 })).toBe(
      true
    );
    expect(updateCamera).toHaveBeenLastCalledWith(
      expect.anything(),
      1600,
      500,
      expect.anything(),
      -17,
      'light',
      undefined
    );
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLoaded: true,
      prepackedAnnotationSceneStatus: 'eligible',
      prepackedAnnotationSceneResidentOwnerCount: 2,
      prepackedAnnotationSceneLayerCreates: 2,
      prepackedAnnotationSceneLayerDestroys: 0,
    });

    const x = path.bpLeftX(1_544_005_000);
    expect(overlay.hitTest(x, path.fwdStrandTop - 8, path, state())).toBeNull();
    expect(overlay.hitTest(x, path.fwdStrandTop - 24, path, state())).toMatchObject({
      payload: { id: 41 },
    });

    const selected = state();
    selected.hoveredId = 41;
    expect(overlay.updateRetainedCamera({ path, state: selected, yOffset: 0, height: 500 })).toBe(
      true
    );
    expect(overlay.getDebugSnapshot().lastInteractionOutlineCommandCount).toBe(1);
    overlay.destroy();
  });

  it('keeps the canonical vector owner while dark mode changes only its shader state', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const light = sceneInput({}, 'theme-light-owner');
    const dark = sceneInput(
      {
        artifactKey: prepackedAnnotationSceneArtifactKey({
          themeMode: 'dark',
          trackType: 'mRNA',
        }),
        themeMode: 'dark',
      },
      'theme-dark-owner'
    );
    expect(overlay.loadPrepackedAnnotationScene(light)).toBe(true);
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(L),
        state: state('light'),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(L),
        state: state('dark'),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLoaded: true,
      prepackedAnnotationSceneStatus: 'eligible',
      prepackedAnnotationSceneLayerDestroys: 0,
      prepackedAnnotationSceneOwner: {
        ownerKey: 'theme-light-owner',
        metadata: { themeMode: 'light' },
      },
    });

    expect(overlay.preparePrepackedAnnotationScene(dark)).toBe(false);
    expect(overlay.getPrepackedAnnotationSceneOwnerSnapshot()).toMatchObject({
      ownerKey: 'theme-light-owner',
      metadata: { themeMode: 'light' },
    });
    expect(overlay.activatePrepackedAnnotationScene('theme-dark-owner')).toBe(false);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLoaded: true,
      prepackedAnnotationSceneStatus: 'eligible',
      prepackedAnnotationSceneLayerDestroys: 0,
      prepackedAnnotationSceneResidentOwnerCount: 1,
      prepackedAnnotationSceneOwner: {
        ownerKey: 'theme-light-owner',
        metadata: { themeMode: 'light' },
      },
    });
    overlay.destroy();
  });

  it('reuses fine-prewarmed canonical detail after a dark toggle', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const path = pathForSpan(512 * 1024);
    const light = directBankRuntimePolicySceneInput();
    light.ownerKey = 'theme-light-direct-bank';
    const dark = directBankRuntimePolicySceneInput();
    dark.ownerKey = 'theme-dark-direct-bank';
    dark.metadata.themeMode = 'dark';
    dark.metadata.artifactKey = prepackedAnnotationSceneArtifactKey({
      themeMode: 'dark',
      trackType: 'mRNA',
    });

    expect(overlay.loadPrepackedAnnotationScene(light)).toBe(true);
    expect(
      overlay.preparePrepackedAnnotationFineViews(path.viewStartBp, path.viewEndBp, 'light')
    ).toMatchObject({ status: 'complete', pendingOwnerCount: 0 });
    expect(
      overlay.updateRetainedCamera({ path, state: state('light'), yOffset: 0, height: 500 })
    ).toBe(true);
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneVisibleResidentOwnerKeys).toEqual([
      'theme-light-direct-bank',
    ]);

    expect(overlay.preparePrepackedAnnotationScene(dark)).toBe(false);
    expect(overlay.activatePrepackedAnnotationScene('theme-dark-direct-bank')).toBe(false);
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneVisibleResidentOwnerKeys).toEqual([
      'theme-light-direct-bank',
    ]);
    expect(
      overlay.updateRetainedCamera({ path, state: state('dark'), yOffset: 0, height: 500 })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStatus: 'eligible',
      prepackedAnnotationSceneVisibleResidentOwnerKeys: ['theme-light-direct-bank'],
      prepackedAnnotationSceneVisiblePartitionCount: expect.any(Number),
      prepackedAnnotationSceneVisibleInstanceCount: expect.any(Number),
    });

    expect(
      overlay.preparePrepackedAnnotationFineViews(path.viewStartBp, path.viewEndBp, 'dark')
    ).toMatchObject({ status: 'complete', pendingOwnerCount: 0 });
    expect(
      overlay.updateRetainedCamera({ path, state: state('dark'), yOffset: 0, height: 500 })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStatus: 'eligible',
      prepackedAnnotationSceneVisibleResidentOwnerKeys: ['theme-light-direct-bank'],
    });
    overlay.destroy();
  });

  it('reclaims a presented theme owner only after two successful Pixi presentation boundaries', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay);
    const light = sceneInput({}, 'presented-light-owner');
    expect(overlay.loadPrepackedAnnotationScene(light)).toBe(true);
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(160_000_000),
        state: state('light'),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot().prepackedAnnotationSceneVisibleResidentOwnerKeys).toEqual([
      'presented-light-owner',
    ]);

    overlay.clearPrepackedAnnotationScene();
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneResidentOwnerCount: 0,
      prepackedAnnotationSceneLayerDestroys: 0,
      prepackedAnnotationSceneRetiredLayerCount: 1,
    });

    overlay.releaseRetiredGpuResourcesAfterPresent();
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLayerDestroys: 0,
      prepackedAnnotationSceneRetiredLayerCount: 1,
    });
    overlay.releaseRetiredGpuResourcesAfterPresent();
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneLayerDestroys: 1,
      prepackedAnnotationSceneRetiredLayerCount: 0,
    });
    overlay.destroy();
  });

  it('reuses one canonical nine-track roster after a dark toggle', () => {
    const trackTypes = Array.from({ length: 9 }, (_, index) => `theme-track-${index}`);
    const lightOwnerKeys = trackTypes.map((trackType) => `theme-light-${trackType}`);
    const darkOwnerKeys = trackTypes.map((trackType) => `theme-dark-${trackType}`);
    const overlay = new AnnotationOverlay();
    prepare(overlay, genome('hg002-grch38', trackTypes));

    const themedScene = (
      trackType: string,
      rendererId: number,
      ownerKey: string,
      themeMode: 'light' | 'dark'
    ): PrepackedAnnotationSceneLoadInput => {
      const input = compiledSourceShapeSceneInput({
        trackType,
        rendererId,
        ownerKey,
        displayName: `${themeMode.toUpperCase()}-${trackType}`,
      });
      input.metadata.themeMode = themeMode;
      input.metadata.artifactKey = prepackedAnnotationSceneArtifactKey({
        themeMode,
        trackType,
      });
      return input;
    };

    for (let index = 0; index < trackTypes.length; index += 1) {
      expect(
        overlay.preparePrepackedAnnotationScene(
          themedScene(trackTypes[index], 4_000 + index, lightOwnerKeys[index], 'light')
        )
      ).toBe(true);
    }
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(L),
        state: state('light'),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStatus: 'eligible',
      prepackedAnnotationSceneResidentOwnerCount: 9,
      prepackedAnnotationSceneVisibleResidentOwnerKeys: [...lightOwnerKeys].sort((left, right) =>
        left.localeCompare(right)
      ),
    });

    for (let index = 0; index < trackTypes.length; index += 1) {
      expect(
        overlay.preparePrepackedAnnotationScene(
          themedScene(trackTypes[index], 5_000 + index, darkOwnerKeys[index], 'dark')
        )
      ).toBe(false);
    }
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneResidentOwnerCount: 9,
      prepackedAnnotationSceneLayerDestroys: 0,
      prepackedAnnotationScenePreparedOwnerKeys: [...lightOwnerKeys].sort((left, right) =>
        left.localeCompare(right)
      ),
    });

    expect(overlay.activatePrepackedAnnotationScene(darkOwnerKeys.at(-1)!)).toBe(false);
    expect(
      overlay.updateRetainedCamera({
        path: pathForSpan(L),
        state: state('dark'),
        yOffset: 0,
        height: 500,
      })
    ).toBe(true);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStatus: 'eligible',
      prepackedAnnotationSceneResidentOwnerCount: 9,
      prepackedAnnotationSceneVisibleResidentOwnerKeys: [...lightOwnerKeys].sort((left, right) =>
        left.localeCompare(right)
      ),
    });
    overlay.destroy();
  });

  it('fails closed on WebGPU and never constructs the WebGL-only layer', () => {
    const overlay = new AnnotationOverlay();
    overlay.setRenderer(webgpuRenderer());
    overlay.loadGenome(genome());
    overlay.setLayout(layout());
    expect(overlay.loadPrepackedAnnotationScene(sceneInput())).toBe(false);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStatus: 'unsupported-renderer',
      prepackedAnnotationSceneLayerCreates: 0,
    });
    overlay.destroy();
  });
});

describe('AnnotationOverlay pre-interaction scene generation', () => {
  it('persists exact track-local lane geometry before camera input (lane 0 = -7; lane 11 = -183)', () => {
    const overlay = new AnnotationOverlay();
    const g = multiExonGenome();
    const features = g.features ?? [];
    features[0].annotationTrackLane = 0;
    features[1].annotationTrackLane = 11;
    prepare(overlay, g);

    const generated = overlay.buildAndLoadPrepackedAnnotationScene(buildOptions());
    expect(generated).not.toBeNull();
    const expected = (g.features ?? []).flatMap((feature, featureIndex) =>
      buildTranscriptGlyphBlocks([feature], {
        getOffset: () => -7 - (feature.annotationTrackLane ?? Number.NaN) * 16,
        halfHeight: 7,
        themeMode: 'light',
        cdsDetail: 0,
      }).map((block) => ({
        ...block,
        featureIndex,
        offsetCenter: Math.fround(block.offsetCenter),
        halfH: Math.fround(block.halfH),
        alpha: Math.fround(block.alpha),
        cdsFade: Math.fround(block.cdsFade),
      }))
    );
    const expectedGpu = buildPartitionedTranscriptScene(
      expected,
      PREPACKED_ANNOTATION_PARTITION_SPAN_BP
    );
    expect(generated?.scene.primitives).toEqual([]);
    expect(generated?.gpuReadyScene).toMatchObject({
      partitionSpanBp: expectedGpu.partitionSpanBp,
      maxPrimitiveSpanBp: expectedGpu.maxPrimitiveSpanBp,
      packedInstanceData: expectedGpu.packedInstanceData,
      featureIndices: expectedGpu.featureIndices,
      partitions: expectedGpu.partitions,
    });
    expect('sortedPrimitives' in (generated?.gpuReadyScene ?? {})).toBe(false);
    expect(new Set(generated?.gpuReadyScene?.featureIndices)).toEqual(new Set([0, 1]));
    const packed = generated?.gpuReadyScene?.packedInstanceData;
    expect(packed?.[4]).toBe(-7);
    expect(packed?.[(packed?.length ?? 0) - 8]).toBe(-183);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStartupBuilds: 1,
      prepackedAnnotationSceneLayerCreates: 1,
      prepackedAnnotationSceneCameraUpdates: 0,
      retainedLinearTranscriptBuilds: 0,
    });

    overlay.updateRetainedCamera({ path: pathForSpan(L), state: state(), yOffset: 0, height: 500 });
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStartupBuilds: 1,
      prepackedAnnotationSceneLayerCreates: 1,
      retainedLinearTranscriptBuilds: 0,
    });
    overlay.destroy();
  });

  it('fails closed before compiling any scene when a transcript lacks annotationTrackLane', () => {
    const overlay = new AnnotationOverlay();
    const g = multiExonGenome();
    delete (g.features ?? [])[1].annotationTrackLane;
    prepare(overlay, g);

    expect(overlay.buildAndLoadPrepackedAnnotationScene(buildOptions())).toBeNull();
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStatus: 'variant-mismatch',
      prepackedAnnotationSceneStartupBuilds: 0,
      prepackedAnnotationSceneLayerCreates: 0,
    });
    overlay.destroy();
  });

  it('is idempotent for the same source identity and exact variant', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, multiExonGenome());
    const options = buildOptions();
    const first = overlay.buildAndLoadPrepackedAnnotationScene(options);
    const second = overlay.buildAndLoadPrepackedAnnotationScene(options);
    expect(second).toBe(first);
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStartupBuilds: 1,
      prepackedAnnotationSceneLayerCreates: 1,
      prepackedAnnotationSceneLayerDestroys: 0,
    });
    overlay.destroy();
  });

  it('builds one ordinary source-shape artifact when that arbitrary track is the sole request', () => {
    const overlay = new AnnotationOverlay();
    const g = genome('hg002-grch38', ['enhancer']);
    g.features = [
      {
        id: 701,
        type: 'enhancer',
        annotationTrackId: 'enhancer',
        annotationTrackLane: 0,
        start: 1_544_004_000,
        end: 1_544_006_000,
        direction: 'reverse',
        displayName: 'ENH701',
        color: 0x22c55e,
        lane: 0,
        sourceId: 'enhancer-701',
      },
    ];
    prepare(overlay, g);
    const generated = overlay.buildAndLoadPrepackedAnnotationScene(
      buildOptions({
        trackType: 'enhancer',
        artifactKey: prepackedAnnotationSceneArtifactKey({
          themeMode: 'light',
          trackType: 'enhancer',
        }),
      })
    );

    expect(generated).not.toBeNull();
    expect(generated?.metadata.trackType).toBe('enhancer');
    expect(generated?.gpuReadyScene?.featureIndices).toEqual(new Uint32Array([0]));
    expect(generated?.interactionIndex.featureCount).toBe(1);
    overlay.destroy();
  });

  it('keeps the one-shot helper track-local and refuses a multi-track request', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, multiExonGenome('hg002-grch38-source', ['mRNA', 'enhancer']));
    expect(overlay.buildAndLoadPrepackedAnnotationScene(buildOptions())).toBeNull();
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStatus: 'mixed-layer-fallback',
      prepackedAnnotationSceneStartupBuilds: 0,
      prepackedAnnotationSceneLayerCreates: 0,
    });
    overlay.destroy();
  });

  it('refuses generation without WebGL or a current lane layout', () => {
    const webgpu = new AnnotationOverlay();
    webgpu.setRenderer(webgpuRenderer());
    webgpu.loadGenome(multiExonGenome());
    webgpu.setLayout(layout());
    expect(webgpu.buildAndLoadPrepackedAnnotationScene(buildOptions())).toBeNull();
    expect(webgpu.getDebugSnapshot().prepackedAnnotationSceneStatus).toBe('unsupported-renderer');
    webgpu.destroy();

    const noLayout = new AnnotationOverlay();
    noLayout.setRenderer(webglRenderer());
    noLayout.loadGenome(multiExonGenome());
    expect(noLayout.buildAndLoadPrepackedAnnotationScene(buildOptions())).toBeNull();
    expect(noLayout.getDebugSnapshot().prepackedAnnotationSceneStatus).toBe('variant-mismatch');
    noLayout.destroy();
  });

  it('regenerates for a new source, rejects a second theme owner, and refuses a layout-height mismatch', () => {
    const overlay = new AnnotationOverlay();
    prepare(overlay, multiExonGenome());
    const first = overlay.buildAndLoadPrepackedAnnotationScene(buildOptions());
    expect(first).not.toBeNull();

    overlay.loadGenome(multiExonGenome('second-source-same-length'));
    overlay.setLayout(layout());
    const second = overlay.buildAndLoadPrepackedAnnotationScene(buildOptions());
    expect(second?.metadata.genomeIdentity).toBe('second-source-same-length');
    expect(second).not.toBe(first);

    const dark = overlay.buildAndLoadPrepackedAnnotationScene(
      buildOptions({
        ownerKey: 'built-owner-dark',
        themeMode: 'dark',
        artifactKey: prepackedAnnotationSceneArtifactKey({
          themeMode: 'dark',
          trackType: 'mRNA',
        }),
      })
    );
    expect(dark).toBeNull();
    expect(
      overlay.buildAndLoadPrepackedAnnotationScene(buildOptions({ annotationBarHeightPx: 15 }))
    ).toBeNull();
    expect(overlay.getDebugSnapshot()).toMatchObject({
      prepackedAnnotationSceneStartupBuilds: 2,
      prepackedAnnotationSceneLayerCreates: 2,
      prepackedAnnotationSceneLayerDestroys: 1,
      prepackedAnnotationSceneResidentOwnerCount: 1,
    });
    overlay.destroy();
  });
});
