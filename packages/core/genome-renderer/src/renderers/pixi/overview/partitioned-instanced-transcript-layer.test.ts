import { beforeEach, describe, expect, it, vi } from 'vitest';

const pixiFakes = vi.hoisted(() => {
  const buffers: FakeBuffer[] = [];
  const geometries: FakeGeometry[] = [];

  class FakeBuffer {
    private _data: Float32Array;
    label: string;
    initialUploadCount: number;
    dataMutationCount = 0;
    destroyCount = 0;

    constructor(options: { data: Float32Array; label: string }) {
      this._data = options.data;
      this.label = options.label;
      this.initialUploadCount = options.data ? 1 : 0;
      buffers.push(this);
    }

    get data() {
      return this._data;
    }

    set data(value: Float32Array) {
      this._data = value;
      this.dataMutationCount++;
    }

    destroy() {
      this.destroyCount++;
    }
  }

  class FakeContainer {
    children: FakeMesh[] = [];
    eventMode = '';
    alpha = 1;
    visible = true;
    destroyed = false;
    addChild(child: FakeMesh) {
      this.children.push(child);
    }
    removeChild(child: FakeMesh) {
      this.children = this.children.filter((candidate) => candidate !== child);
    }
    destroy() {
      this.destroyed = true;
    }
  }

  class FakeGeometry {
    attributes: Record<
      string,
      { buffer: FakeBuffer; offset?: number; stride?: number; instance?: boolean }
    >;
    instanceCount: number;
    topology: string;
    destroyArgs: boolean[] = [];
    constructor(options: {
      attributes: FakeGeometry['attributes'];
      instanceCount: number;
      topology: string;
    }) {
      this.attributes = options.attributes;
      this.instanceCount = options.instanceCount;
      this.topology = options.topology;
      geometries.push(this);
    }
    destroy(destroyBuffers: boolean) {
      this.destroyArgs.push(destroyBuffers);
      if (destroyBuffers) {
        for (const buffer of new Set(Object.values(this.attributes).map(({ buffer }) => buffer))) {
          buffer.destroy();
        }
      }
    }
  }

  class FakeShader {
    resources: Record<string, { uniforms: Record<string, unknown> }>;
    glProgram: unknown;
    destroyCount = 0;
    constructor(options: {
      glProgram: unknown;
      resources: Record<string, Record<string, { value: unknown; type: string }>>;
    }) {
      this.glProgram = options.glProgram;
      this.resources = Object.fromEntries(
        Object.entries(options.resources).map(([name, entries]) => [
          name,
          {
            uniforms: Object.fromEntries(
              Object.entries(entries).map(([key, descriptor]) => [key, descriptor.value])
            ),
          },
        ])
      );
    }
    destroy() {
      this.destroyCount++;
    }
  }

  class FakeMesh {
    geometry: FakeGeometry;
    shader: FakeShader;
    visible = true;
    eventMode = '';
    destroyed = false;
    constructor(options: { geometry: FakeGeometry; shader: FakeShader }) {
      this.geometry = options.geometry;
      this.shader = options.shader;
    }
    destroy() {
      this.destroyed = true;
    }
  }

  return { buffers, geometries, FakeBuffer, FakeContainer, FakeGeometry, FakeShader, FakeMesh };
});

vi.mock('pixi.js', () => ({
  Buffer: pixiFakes.FakeBuffer,
  BufferUsage: { COPY_DST: 8, VERTEX: 32, STATIC: 1024 },
  Container: pixiFakes.FakeContainer,
  Geometry: pixiFakes.FakeGeometry,
  GlProgram: { from: (options: unknown) => options },
  Mesh: pixiFakes.FakeMesh,
  Shader: pixiFakes.FakeShader,
  State: { for2d: () => ({}) },
}));

import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import { buildAnnotationPolicyDirectSubmissionBankV1 } from './annotation-policy-direct-submission-bank-v1';
import { buildAnnotationPolicyDirectFineIndexV1 } from './annotation-policy-direct-fine-index-v1';
import {
  buildAnnotationPolicyGpuInstanceDataV1,
  resolveAnnotationPolicyGpuInstanceV1,
  resolveAnnotationPolicyGpuTrackLaneV1,
} from './annotation-policy-gpu-instances-v1';
import { buildAnnotationPolicyProjectionTableV1 } from './annotation-policy-projection-v1';
import { planExactAnnotationPolicySubmissionV1 } from './annotation-policy-submission-census-v1';
import {
  PARTITIONED_TRANSCRIPT_SEMANTIC_OWNER,
  PartitionedInstancedTranscriptLayer,
} from './partitioned-instanced-transcript-layer';
import {
  POLICY_TRANSCRIPT_VERTEX_SHADER,
  TRANSCRIPT_VERTEX_SHADER,
} from './retained-linear-transcript-layer';
import { buildPartitionedTranscriptScene } from './partitioned-transcript-scene';
import {
  TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4,
  packGpuReadyPartitionedTranscriptSceneBinaryV4,
  scopeTrustedPartitionedTranscriptRendererAdmissionV4,
  unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4,
} from './partitioned-transcript-scene-binary-v4';
import { buildPrepackedAnnotationInteractionIndexV2 } from './prepacked-annotation-interaction-index-v2';
import { TRANSCRIPT_GLYPH_INSTANCE_LAYOUT } from './transcript-glyph-instances';
import type { ViewerRenderContract } from './viewer-render-contract';
import { resolveAnnotationRoleColorV1 } from '../../../annotation-role-palette';

const primitive = (
  featureIndex: number,
  startBp: number,
  endBp: number
): AnnotationScenePrimitiveV1 => ({
  startBp,
  endBp,
  featureIndex,
  offsetCenter: featureIndex,
  halfH: 7,
  color: 0x123456,
  alpha: 0.85,
  cdsFade: 0,
  dirSign: 1,
});

const PRIMITIVES = [
  primitive(101, 10_000_000, 20_000_000),
  primitive(202, 50_000_000, 310_000_000),
  primitive(303, 250_000_000, 260_000_000),
  primitive(304, 270_000_000, 280_000_000),
  primitive(404, 550_000_000, 550_001_000),
  primitive(405, 560_000_000, 560_001_000),
];

function directBankFixture() {
  const scene = buildPartitionedTranscriptScene(
    [
      primitive(0, 10, 20),
      primitive(1, 30, 40),
      primitive(2, 50, 60),
      primitive(3, 110, 130),
      primitive(4, 140, 160),
      primitive(5, 205, 260),
    ],
    100
  );
  const table = buildAnnotationPolicyProjectionTableV1({
    features: [
      {
        annotationType: 'mRNA',
        expandedLane: 2,
        expandedTrackLane: 2,
        canonicalLane: 2,
        canonicalTrackLane: 2,
      },
      {
        annotationType: 'mRNA',
        expandedLane: 0,
        expandedTrackLane: 0,
        canonicalLane: null,
        canonicalTrackLane: null,
      },
      {
        annotationType: 'mRNA',
        expandedLane: 5,
        expandedTrackLane: 5,
        canonicalLane: 0,
        canonicalTrackLane: 0,
      },
      {
        annotationType: 'mRNA',
        expandedLane: 1,
        expandedTrackLane: 1,
        canonicalLane: null,
        canonicalTrackLane: null,
      },
      {
        annotationType: 'mRNA',
        expandedLane: 3,
        expandedTrackLane: 3,
        canonicalLane: 3,
        canonicalTrackLane: 3,
      },
      {
        annotationType: 'mRNA',
        expandedLane: 9,
        expandedTrackLane: 9,
        canonicalLane: 1,
        canonicalTrackLane: 1,
      },
    ],
    expandedBandOrder: ['mRNA'],
    canonicalBandOrder: ['mRNA'],
  });
  const policyGpuInstanceData = buildAnnotationPolicyGpuInstanceDataV1(scene.featureIndices, table);
  const submissionBank = buildAnnotationPolicyDirectSubmissionBankV1(scene, policyGpuInstanceData);
  const expandedFine = buildAnnotationPolicyDirectFineIndexV1(submissionBank.expanded, 600_000);
  return {
    scene,
    policyGpuInstanceData,
    submissionBank,
    submissionFineIndices: {
      expanded: expandedFine,
      canonical: buildAnnotationPolicyDirectFineIndexV1(
        submissionBank.canonical,
        600_000,
        expandedFine.sourceTilePrimitiveCounts
      ),
    },
  };
}

async function trustedDirectBankFixture() {
  const { scene } = directBankFixture();
  const policyFeatures = [
    policyFeature(2, 2),
    policyFeature(0, null),
    policyFeature(5, 0),
    policyFeature(1, null),
    policyFeature(3, 3),
    policyFeature(4, 1),
  ];
  const ranges = [
    [10, 20],
    [30, 40],
    [50, 60],
    [110, 130],
    [140, 160],
    [205, 260],
  ] as const;
  const interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
    ranges.map(([startBp, endBp], featureIndex) => ({
      rendererId: featureIndex + 1,
      startBp,
      endBp,
      lane: policyFeatures[featureIndex].expandedLane,
      direction: 'forward' as const,
      displayName: `feature-${featureIndex}`,
      type: 'mRNA',
      transcriptId: `tx-${featureIndex}`,
      sourceId: `source-${featureIndex}`,
      canonicalIdentity: `canonical-${featureIndex}`,
    })),
    scene.sortedPrimitives
  );
  const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
    datasetContract: {
      datasetId: 'trusted-layer-fixture',
      datasetVersion: 'v1',
      sourceSha256: 'a'.repeat(64),
    },
    assemblyContract: { assemblyId: 'fixture', assemblyLengthBp: 600_000 },
    families: [{ id: 'transcript', kind: 'transcript', metadata: {} }],
    featureFamilyIndices: new Uint32Array(ranges.length),
    scene,
    interactionIndex,
    policyProjection: {
      features: policyFeatures,
      expandedBandOrder: ['mRNA'],
      canonicalBandOrder: ['mRNA'],
    },
  });
  return unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4(
    packed.manifest,
    packed.payload,
    TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4
  );
}

function policyFeature(expandedLane: number, canonicalLane: number | null) {
  return {
    annotationType: 'mRNA',
    expandedLane,
    expandedTrackLane: expandedLane,
    canonicalLane,
    canonicalTrackLane: canonicalLane,
  };
}

beforeEach(() => {
  pixiFakes.buffers.length = 0;
  pixiFakes.geometries.length = 0;
});

function sharedInstanceBuffer() {
  return pixiFakes.buffers.find(
    ({ label }) => label === 'partitioned-transcript-shared-instances'
  )!;
}

function sharedPolicyBuffer() {
  return pixiFakes.buffers.find(
    ({ label }) => label === 'partitioned-transcript-shared-policy-instances'
  )!;
}

function simulateWebGlDraw(container: InstanceType<typeof pixiFakes.FakeContainer>) {
  const vaoOffsets: Array<Record<string, number>> = [];
  const drawArraysInstancedCounts: number[] = [];
  for (const mesh of container.children) {
    if (!mesh.visible) continue;
    vaoOffsets.push(
      Object.fromEntries(
        Object.entries(mesh.geometry.attributes)
          .filter(([, attribute]) => attribute.instance)
          .map(([name, attribute]) => [name, attribute.offset ?? 0])
      )
    );
    drawArraysInstancedCounts.push(mesh.geometry.instanceCount);
  }
  return { vaoOffsets, drawArraysInstancedCounts };
}

describe('PartitionedInstancedTranscriptLayer — shared WebGL buffer views', () => {
  it('links both policy layouts before any transcript scene exists', () => {
    const renderer = {
      shader: { bind: vi.fn(), resetState: vi.fn() },
    };

    PartitionedInstancedTranscriptLayer.prepareGpuPrograms(renderer as never);

    expect(renderer.shader.bind).toHaveBeenCalledTimes(2);
    expect(renderer.shader.bind.mock.calls.every((call) => call[1] === true)).toBe(true);
    const shaders = renderer.shader.bind.mock.calls.map(
      ([shader]) => shader as { glProgram: { vertex: string } }
    );
    expect(shaders.some(({ glProgram }) => glProgram.vertex === TRANSCRIPT_VERTEX_SHADER)).toBe(
      true
    );
    expect(
      shaders.some(({ glProgram }) => glProgram.vertex === POLICY_TRANSCRIPT_VERTEX_SHADER)
    ).toBe(true);
    expect(renderer.shader.resetState).toHaveBeenCalledTimes(1);
  });

  it('prepares shader, immutable buffers, and every partition VAO before interaction', () => {
    const scene = buildPartitionedTranscriptScene(PRIMITIVES, 100_000_000);
    const layer = new PartitionedInstancedTranscriptLayer(scene, { rendererKind: 'webgl' });
    const renderer = {
      shader: { bind: vi.fn(), resetState: vi.fn() },
      geometry: { bind: vi.fn(), resetState: vi.fn() },
    };

    layer.prepareGpuResources(renderer as never);
    layer.prepareGpuResources(renderer as never);

    expect(layer.isGpuPrepared).toBe(true);
    expect(renderer.shader.bind).toHaveBeenCalledTimes(1);
    expect(renderer.shader.bind).toHaveBeenCalledWith(expect.anything(), true);
    expect(renderer.geometry.bind).toHaveBeenCalledTimes(scene.partitions.length);
    expect(renderer.geometry.resetState).toHaveBeenCalledTimes(1);
    expect(renderer.shader.resetState).toHaveBeenCalledTimes(1);
    expect(sharedInstanceBuffer().dataMutationCount).toBe(0);
  });

  it('creates one immutable instance upload shared by every partition geometry', () => {
    const scene = buildPartitionedTranscriptScene(PRIMITIVES, 100_000_000);
    const layer = new PartitionedInstancedTranscriptLayer(scene, { rendererKind: 'webgl' });
    const instanceBuffer = sharedInstanceBuffer();

    expect(instanceBuffer.initialUploadCount).toBe(1);
    expect(instanceBuffer.dataMutationCount).toBe(0);
    expect(instanceBuffer.data).toBe(scene.packedInstanceData);
    expect(pixiFakes.buffers.filter((buffer) => buffer === instanceBuffer)).toHaveLength(1);
    for (const geometry of pixiFakes.geometries) {
      const instanceAttributes = Object.values(geometry.attributes).filter(
        ({ instance }) => instance
      );
      expect(instanceAttributes).toHaveLength(9);
      expect(instanceAttributes.every(({ buffer }) => buffer === instanceBuffer)).toBe(true);
    }
    expect(layer.semanticOwnerId).toBe(PARTITIONED_TRANSCRIPT_SEMANTIC_OWNER);
    expect(layer.container.children).toHaveLength(scene.partitions.length);
  });

  it('switches expanded/canonical and 8/12/24/unlimited policy through uniforms only', () => {
    const policyPrimitives: AnnotationScenePrimitiveV1[] = [
      { ...primitive(0, 10, 20), offsetCenter: -7 },
      { ...primitive(1, 30, 40), offsetCenter: -151 },
      { ...primitive(2, 50, 60), offsetCenter: -407 },
    ];
    const scene = buildPartitionedTranscriptScene(policyPrimitives, 100);
    const table = buildAnnotationPolicyProjectionTableV1({
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
          expandedLane: 9,
          expandedTrackLane: 9,
          canonicalLane: null,
          canonicalTrackLane: null,
        },
        {
          annotationType: 'mRNA',
          expandedLane: 25,
          expandedTrackLane: 25,
          canonicalLane: 9,
          canonicalTrackLane: 9,
        },
      ],
      expandedBandOrder: ['mRNA'],
      canonicalBandOrder: ['mRNA'],
    });
    const policyData = buildAnnotationPolicyGpuInstanceDataV1(scene.featureIndices, table);
    const layer = new PartitionedInstancedTranscriptLayer(scene, {
      rendererKind: 'webgl',
      policyGpuInstanceData: policyData,
    });
    const glyphBuffer = sharedInstanceBuffer();
    const policyBuffer = sharedPolicyBuffer();
    const glyphIdentity = glyphBuffer.data;
    const policyIdentity = policyBuffer.data;
    const geometryIdentity = [...pixiFakes.geometries];
    const shader = (
      layer.container.children[0] as unknown as InstanceType<typeof pixiFakes.FakeMesh>
    ).shader;
    const shaderSource = shader.glProgram as { vertex: string };

    expect(shaderSource.vertex).toContain('attribute vec4 aPolicyLanes');
    expect(shaderSource.vertex).toContain('uPolicyIsoformMode');
    expect(shaderSource.vertex).toContain('policyVisible');
    expect(policyBuffer.initialUploadCount).toBe(1);
    for (const geometry of pixiFakes.geometries) {
      expect(geometry.attributes.aPolicyLanes.buffer).toBe(policyBuffer);
      expect(geometry.attributes.aPolicyLanes.stride).toBe(4 * Float32Array.BYTES_PER_ELEMENT);
    }

    let updateCount = 0;
    for (const laneLimit of [8, 12, 24, null] as const) {
      for (const isoformMode of ['expanded', 'canonical'] as const) {
        layer.updateAnnotationPolicy({ isoformMode, laneLimit });
        updateCount += 1;
        const uniforms = shader.resources.transcriptUniforms.uniforms;
        expect(uniforms.uPolicyIsoformMode).toBe(isoformMode === 'canonical' ? 1 : 0);
        expect(uniforms.uPolicyLaneLimit).toBe(laneLimit ?? -1);
        for (
          let primitiveIndex = 0;
          primitiveIndex < scene.featureIndices.length;
          primitiveIndex++
        ) {
          const resolved = resolveAnnotationPolicyGpuInstanceV1(policyData, primitiveIndex, {
            isoformMode,
            laneLimit,
          });
          expect(
            resolveAnnotationPolicyGpuTrackLaneV1(policyData, primitiveIndex, {
              isoformMode,
              laneLimit,
            })
          ).toBe(resolved.trackLane);
          if (resolved.visible) {
            expect(resolved.offsetCenterPx).toBe(-7 - resolved.trackLane! * 16);
          }
        }
      }
    }

    expect(layer.getAnnotationPolicyDebug()).toMatchObject({
      enabled: true,
      updateCount,
      runtime: { isoformMode: 'canonical', laneLimit: null },
    });
    expect(layer.getAnnotationPolicyDebug().glyphBufferIdentity).toBe(glyphIdentity);
    expect(layer.getAnnotationPolicyDebug().policyBufferIdentity).toBe(policyIdentity);
    expect(sharedInstanceBuffer()).toBe(glyphBuffer);
    expect(sharedPolicyBuffer()).toBe(policyBuffer);
    expect(glyphBuffer.initialUploadCount).toBe(1);
    expect(policyBuffer.initialUploadCount).toBe(1);
    expect(glyphBuffer.dataMutationCount).toBe(0);
    expect(policyBuffer.dataMutationCount).toBe(0);
    expect(pixiFakes.geometries).toEqual(geometryIdentity);
  });

  it('characterizes the current whole-mesh policy over-submission without changing glyph bytes', () => {
    const policyPrimitives: AnnotationScenePrimitiveV1[] = [
      { ...primitive(0, 10_000_000, 20_000_000), offsetCenter: -7 },
      { ...primitive(1, 30_000_000, 40_000_000), offsetCenter: -151 },
      { ...primitive(2, 50_000_000, 60_000_000), offsetCenter: -407 },
    ];
    const scene = buildPartitionedTranscriptScene(policyPrimitives, 100_000_000);
    const table = buildAnnotationPolicyProjectionTableV1({
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
          expandedLane: 9,
          expandedTrackLane: 9,
          canonicalLane: null,
          canonicalTrackLane: null,
        },
        {
          annotationType: 'mRNA',
          expandedLane: 25,
          expandedTrackLane: 25,
          canonicalLane: 25,
          canonicalTrackLane: 25,
        },
      ],
      expandedBandOrder: ['mRNA'],
      canonicalBandOrder: ['mRNA'],
    });
    const policyData = buildAnnotationPolicyGpuInstanceDataV1(scene.featureIndices, table);
    const layer = new PartitionedInstancedTranscriptLayer(scene, {
      rendererKind: 'webgl',
      policyGpuInstanceData: policyData,
    });
    const glyphBuffer = sharedInstanceBuffer();
    const glyphBytesBefore = glyphBuffer.data.slice();

    layer.updateAnnotationPolicy({ isoformMode: 'canonical', laneLimit: 12 });
    layer.updateVisibleRange(0, 100_000_000);
    const actualSubmittedInstanceCount = simulateWebGlDraw(
      layer.container as unknown as InstanceType<typeof pixiFakes.FakeContainer>
    ).drawArraysInstancedCounts.reduce((sum, count) => sum + count, 0);
    const oracle = planExactAnnotationPolicySubmissionV1(scene, policyData, 0, 100_000_000, {
      isoformMode: 'canonical',
      laneLimit: 12,
    });

    expect(actualSubmittedInstanceCount).toBe(3);
    expect(actualSubmittedInstanceCount).toBe(oracle.currentFullMeshSubmittedInstanceCount);
    expect(oracle.exactEligibleInstanceCount).toBe(1);
    expect(actualSubmittedInstanceCount).toBeGreaterThan(oracle.exactEligibleInstanceCount);
    expect(oracle).toMatchObject({
      spatialEnvelopeOverfetchInstanceCount: 0,
      hiddenByIsoformMembershipInstanceCount: 1,
      hiddenByLaneCapInstanceCount: 1,
    });
    expect(sharedInstanceBuffer()).toBe(glyphBuffer);
    expect(glyphBuffer.data).toEqual(glyphBytesBefore);
    expect(glyphBuffer.dataMutationCount).toBe(0);
  });

  it('binds exact VAO byte offsets for two partitions and draws their instance counts', () => {
    const scene = buildPartitionedTranscriptScene(PRIMITIVES, 100_000_000);
    const layer = new PartitionedInstancedTranscriptLayer(scene, { rendererKind: 'webgl' });
    layer.updateVisibleRange(0, 600_000_000);
    const draw = simulateWebGlDraw(
      layer.container as unknown as InstanceType<typeof pixiFakes.FakeContainer>
    );
    expect(draw.drawArraysInstancedCounts).toEqual([2, 2, 2]);
    const stride = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes;
    expect(draw.vaoOffsets[0].aBpStartChunk).toBe(0);
    expect(draw.vaoOffsets[0].aColor).toBe(8 * Float32Array.BYTES_PER_ELEMENT);
    expect(draw.vaoOffsets[1].aBpStartChunk).toBe(2 * stride);
    expect(draw.vaoOffsets[1].aColor).toBe(2 * stride + 8 * Float32Array.BYTES_PER_ELEMENT);
  });

  it('changes submissions at full and 150M views without buffer upload on pan/zoom', () => {
    const scene = buildPartitionedTranscriptScene(PRIMITIVES, 100_000_000);
    const layer = new PartitionedInstancedTranscriptLayer(scene, { rendererKind: 'webgl' });
    const instanceBuffer = sharedInstanceBuffer();

    layer.updateVisibleRange(0, 600_000_000);
    expect(
      simulateWebGlDraw(layer.container as unknown as InstanceType<typeof pixiFakes.FakeContainer>)
        .drawArraysInstancedCounts
    ).toEqual([2, 2, 2]);
    layer.updateVisibleRange(200_000_000, 350_000_000);
    expect(
      simulateWebGlDraw(layer.container as unknown as InstanceType<typeof pixiFakes.FakeContainer>)
        .drawArraysInstancedCounts
    ).toEqual([2, 2]);

    const contract: ViewerRenderContract = {
      pixelsPerBp: 0.001,
      xOriginBp: 200_000_000,
      projectX: (bp) => (bp - 200_000_000) * 0.001,
      projectY: (offset) => 100 + offset,
    };
    layer.updateCamera(contract, 1000, 300);
    layer.updateVisibleRange(210_000_000, 360_000_000);
    expect(instanceBuffer.initialUploadCount).toBe(1);
    expect(instanceBuffer.dataMutationCount).toBe(0);
  });

  it('hides and shows a prepared submission through only the container gate', () => {
    const scene = buildPartitionedTranscriptScene(PRIMITIVES, 100_000_000);
    const layer = new PartitionedInstancedTranscriptLayer(scene, { rendererKind: 'webgl' });
    const renderer = {
      shader: { bind: vi.fn(), resetState: vi.fn() },
      geometry: { bind: vi.fn(), resetState: vi.fn() },
    };
    layer.prepareGpuResources(renderer as never);
    layer.updateVisibleRange(200_000_000, 350_000_000);
    const instanceBuffer = sharedInstanceBuffer();
    const preparedViews = layer
      .getDebugViews()
      .filter(({ visible }) => visible)
      .map(({ key }) => key);

    layer.hide();
    expect(layer.isPresenting).toBe(false);
    expect(layer.getDebugViews().every(({ visible }) => !visible)).toBe(true);
    layer.show();
    expect(layer.isPresenting).toBe(true);
    expect(
      layer
        .getDebugViews()
        .filter(({ visible }) => visible)
        .map(({ key }) => key)
    ).toEqual(preparedViews);
    expect(renderer.shader.bind).toHaveBeenCalledTimes(1);
    expect(instanceBuffer.dataMutationCount).toBe(0);
  });

  it('projects the current annotation track base without mutating or recreating geometry', () => {
    const scene = buildPartitionedTranscriptScene(PRIMITIVES, 100_000_000);
    const layer = new PartitionedInstancedTranscriptLayer(scene, { rendererKind: 'webgl' });
    const buffers = [...pixiFakes.buffers];
    const geometries = [...pixiFakes.geometries];
    const contract: ViewerRenderContract = {
      pixelsPerBp: 0.001,
      xOriginBp: 0,
      projectX: (bp) => bp * 0.001,
      projectY: (offset) => 100 + offset,
    };

    (
      layer.updateCamera as (
        contract: ViewerRenderContract,
        width: number,
        height: number,
        cdsDetail: number,
        annotationTrackBasePx: number
      ) => void
    )(contract, 1000, 300, 0, -1);
    const shader = (
      layer.container.children[0] as unknown as InstanceType<typeof pixiFakes.FakeMesh>
    ).shader;
    expect(shader.resources.transcriptUniforms.uniforms.uY0).toBe(99);
    expect(layer.getPresentationLayoutDebug()).toEqual({
      screenAnchorYCssPx: 99,
      viewportWidthCssPx: 1000,
      viewportHeightCssPx: 300,
    });

    (
      layer.updateCamera as (
        contract: ViewerRenderContract,
        width: number,
        height: number,
        cdsDetail: number,
        annotationTrackBasePx: number
      ) => void
    )(contract, 1000, 300, 0, -17);
    expect(shader.resources.transcriptUniforms.uniforms.uY0).toBe(83);
    expect(layer.getPresentationLayoutDebug()).toEqual({
      screenAnchorYCssPx: 83,
      viewportWidthCssPx: 1000,
      viewportHeightCssPx: 300,
    });
    expect(pixiFakes.buffers).toEqual(buffers);
    expect(pixiFakes.geometries).toEqual(geometries);
    expect(
      buffers.every(
        ({ dataMutationCount, destroyCount }) => dataMutationCount === 0 && destroyCount === 0
      )
    ).toBe(true);
    expect(geometries.every(({ destroyArgs }) => destroyArgs.length === 0)).toBe(true);
  });

  it('submits a long offscreen-start feature and preserves stable featureIndex mapping', () => {
    const scene = buildPartitionedTranscriptScene(PRIMITIVES, 100_000_000);
    const layer = new PartitionedInstancedTranscriptLayer(scene, { rendererKind: 'webgl' });
    const submissions = layer.updateVisibleRange(300_000_000, 320_000_000);
    expect(submissions.map(({ partitionIndex }) => partitionIndex)).toEqual([0]);
    expect(layer.featureIndexFor('bp-partition-0', 0)).toBe(101);
    expect(layer.featureIndexFor('bp-partition-0', 1)).toBe(202);
    expect(layer.featureIndexFor('bp-partition-0', 2)).toBeNull();
  });

  it('uses direct mode banks and arbitrary cap prefixes without buffer upload or mutation', () => {
    const { scene, submissionBank, submissionFineIndices } = directBankFixture();
    const layer = new PartitionedInstancedTranscriptLayer(scene, {
      rendererKind: 'webgl',
      artifactGeneration: 'artifact-A',
      submissionBank,
      submissionFineIndices,
    });
    const buffers = [...pixiFakes.buffers];
    const geometries = [...pixiFakes.geometries];

    layer.updateAnnotationPolicy({ isoformMode: 'canonical', laneLimit: 3 });
    const canonicalSubmissions = layer.updateVisibleRange(0, 600_000);
    expect(canonicalSubmissions.map(({ instanceCount }) => instanceCount)).toEqual([2, 1]);
    expect(layer.getSubmissionDebug()).toEqual({
      directBankEnabled: true,
      activeMode: 'canonical',
      actualSubmittedInstanceCount: 3,
      actualSubmittedVertexCount: 27,
      hiddenByIsoformMembershipInstanceCount: 2,
      hiddenByLaneCapInstanceCount: 1,
      visibleDrawCount: 2,
    });
    expect(layer.featureIndexFor('bp-partition-0', 0)).toBe(2);
    expect(layer.featureIndexFor('bp-partition-0', 1)).toBe(0);
    expect(layer.featureIndexFor('bp-partition-0', 2)).toBeNull();

    layer.updateAnnotationPolicy({ isoformMode: 'expanded', laneLimit: 1 });
    expect(layer.getSubmissionDebug()).toMatchObject({
      activeMode: 'expanded',
      actualSubmittedInstanceCount: 1,
      hiddenByIsoformMembershipInstanceCount: 0,
      hiddenByLaneCapInstanceCount: 5,
      visibleDrawCount: 1,
    });
    layer.updateAnnotationPolicy({ isoformMode: 'expanded', laneLimit: null });
    expect(layer.getSubmissionDebug()).toMatchObject({
      actualSubmittedInstanceCount: 6,
      hiddenByLaneCapInstanceCount: 0,
      visibleDrawCount: 3,
    });

    expect(pixiFakes.buffers).toEqual(buffers);
    expect(pixiFakes.geometries).toEqual(geometries);
    expect(buffers.every(({ initialUploadCount }) => initialUploadCount === 1)).toBe(true);
    expect(buffers.every(({ dataMutationCount }) => dataMutationCount === 0)).toBe(true);
    expect(
      pixiFakes.buffers.some(
        ({ label }) => label === 'partitioned-transcript-shared-policy-instances'
      )
    ).toBe(false);
  });

  it('role-codes both banks and shades them from a palette that overrides replace', () => {
    const { scene, submissionBank, submissionFineIndices } = directBankFixture();
    const expandedRecords = submissionBank.expanded.featureIndices.length;
    const canonicalRecords = submissionBank.canonical.featureIndices.length;
    const expandedRoleIndices = Uint8Array.from({ length: expandedRecords }, (_, i) => i % 2);
    const canonicalRoleIndices = Uint8Array.from({ length: canonicalRecords }, () => 1);
    const layer = new PartitionedInstancedTranscriptLayer(scene, {
      rendererKind: 'webgl',
      artifactGeneration: 'artifact-roles',
      submissionBank,
      submissionFineIndices,
      colorRoles: {
        roleTable: ['transcript:intron', 'transcript:utr'],
        expandedRoleIndices,
        canonicalRoleIndices,
      },
    });
    const { strideFloats, color } = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT;
    for (let record = 0; record < expandedRecords; record++) {
      expect(submissionBank.expanded.packedInstanceData[record * strideFloats + color]).toBe(
        -(expandedRoleIndices[record] + 1)
      );
    }
    for (let record = 0; record < canonicalRecords; record++) {
      expect(submissionBank.canonical.packedInstanceData[record * strideFloats + color]).toBe(-2);
    }
    const uniforms = (
      layer.container.children[0] as unknown as InstanceType<typeof pixiFakes.FakeMesh>
    ).shader.resources.transcriptUniforms.uniforms as { uRolePalette: Float32Array };
    const rgb = (value: number) =>
      [16, 8, 0].map((shift) => Math.fround(((value >> shift) & 0xff) / 255));
    const utrSlot = () => Array.from(uniforms.uRolePalette.slice(4, 7));
    expect(utrSlot()).toEqual(rgb(resolveAnnotationRoleColorV1('transcript:utr', 'light')));
    expect(layer.getRolePaletteDebug()).toEqual({
      roleCoded: true,
      roleCount: 2,
      theme: 'light',
      overriddenRoleCount: 0,
    });

    const contract: ViewerRenderContract = {
      pixelsPerBp: 0.001,
      xOriginBp: 0,
      projectX: (bp) => bp * 0.001,
      projectY: (offset) => 100 + offset,
    } as ViewerRenderContract;
    layer.updateCamera(contract, 1000, 300, 0, 0, 'dark');
    expect(utrSlot()).toEqual(rgb(resolveAnnotationRoleColorV1('transcript:utr', 'dark')));

    const overrides = { 'transcript:utr': 0xff8000 } as const;
    layer.updateCamera(contract, 1000, 300, 0, 0, 'dark', overrides);
    expect(utrSlot()).toEqual(rgb(0xff8000));
    expect(layer.getRolePaletteDebug().overriddenRoleCount).toBe(1);
    layer.updateCamera(contract, 1000, 300, 0, 0, 'light', undefined);
    expect(utrSlot()).toEqual(rgb(resolveAnnotationRoleColorV1('transcript:utr', 'light')));
  });

  it('keeps baked colours when roles are not parallel to the banks', () => {
    const { scene, submissionBank, submissionFineIndices } = directBankFixture();
    const before = Float32Array.from(submissionBank.expanded.packedInstanceData);
    const layer = new PartitionedInstancedTranscriptLayer(scene, {
      rendererKind: 'webgl',
      artifactGeneration: 'artifact-roles-mismatch',
      submissionBank,
      submissionFineIndices,
      colorRoles: {
        roleTable: ['transcript:intron'],
        expandedRoleIndices: new Uint8Array(1),
        canonicalRoleIndices: new Uint8Array(submissionBank.canonical.featureIndices.length),
      },
    });
    expect(layer.getRolePaletteDebug().roleCoded).toBe(false);
    expect(submissionBank.expanded.packedInstanceData).toEqual(before);
  });

  it('restores direct-bank visibility, counts, clocks, and policy exactly on transaction rollback', () => {
    const { scene, submissionBank, submissionFineIndices } = directBankFixture();
    const layer = new PartitionedInstancedTranscriptLayer(scene, {
      rendererKind: 'webgl',
      artifactGeneration: 'transaction-rollback-artifact',
      submissionBank,
      submissionFineIndices,
    });
    layer.updateAnnotationPolicy({ isoformMode: 'canonical', laneLimit: 3 });
    layer.updateVisibleRange(0, 600_000);
    const policyBefore = layer.getAnnotationPolicyDebug();
    const submissionBefore = layer.getSubmissionDebug();
    const viewsBefore = layer.getDebugViews();
    const fineBefore = layer.getFineViewDebug();
    const buffersBefore = [...pixiFakes.buffers];
    const geometriesBefore = [...pixiFakes.geometries];

    const transaction = layer.beginAnnotationPolicyTransaction({
      isoformMode: 'expanded',
      laneLimit: 1,
    });
    expect(transaction).not.toBeNull();
    expect(layer.getSubmissionDebug()).toMatchObject({
      activeMode: 'expanded',
      actualSubmittedInstanceCount: 1,
    });
    expect(layer.rollbackAnnotationPolicyTransaction(transaction!)).toBe(true);
    expect(layer.getAnnotationPolicyDebug()).toEqual(policyBefore);
    expect(layer.getSubmissionDebug()).toEqual(submissionBefore);
    expect(layer.getDebugViews()).toEqual(viewsBefore);
    expect(layer.getFineViewDebug()).toEqual(fineBefore);
    expect(pixiFakes.buffers).toEqual(buffersBefore);
    expect(pixiFakes.geometries).toEqual(geometriesBefore);
    expect(buffersBefore.every(({ dataMutationCount }) => dataMutationCount === 0)).toBe(true);
  });

  it('skips exactly the two O(records) fine-index scans only for an exact validated-v4 capability', async () => {
    const direct = await trustedDirectBankFixture();
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
        ownerKey: 'fixture-owner',
        sceneContractSha256: direct.rendererAdmissionProvenance.contractSha256,
        genomeIdentity: 'fixture-source',
        genomeLengthBp: 600_000,
        partitionSpanBp: direct.scene.partitionSpanBp,
        artifactKey: 'fixture-artifact',
        themeMode: 'light',
        trackType: 'mRNA',
        annotationBarHeightPx: 14,
        laneAlgorithmToken: 'fixture-lanes',
        mapperContractToken: 'fixture-mapper',
        geometryContractToken: 'fixture-geometry',
        interactionContractToken: 'fixture-interaction',
      }
    );
    const binding = {
      provenance: direct.rendererAdmissionProvenance,
      loadIdentity: scoped.loadIdentity,
      scene: direct.scene,
      families: direct.families,
      featureFamilyIndices: direct.featureFamilyIndices,
      interactionIndex: direct.interactionIndex,
      policyProjection: direct.policyProjection,
      submissionBank: direct.submissionBank,
      submissionFineIndices: direct.submissionFineIndices,
    };
    const options = {
      rendererKind: 'webgl' as const,
      artifactGeneration: 'trusted-v4',
      submissionBank: direct.submissionBank,
      submissionFineIndices: direct.submissionFineIndices,
    };
    const trusted = PartitionedInstancedTranscriptLayer.fromValidatedV4(
      binding,
      options,
      scoped.capability
    );
    expect(trusted.getAdmissionValidationDebug()).toEqual({
      trustedV4Admission: true,
      trustedDetailPacketAdmission: false,
      directFineIndexValidationCount: 0,
      directFineIndexRecordScanCardinality: 0,
    });
    trusted.destroy();

    const generic = new PartitionedInstancedTranscriptLayer(direct.scene, options);
    expect(generic.getAdmissionValidationDebug()).toEqual({
      trustedV4Admission: false,
      trustedDetailPacketAdmission: false,
      directFineIndexValidationCount: 2,
      directFineIndexRecordScanCardinality:
        direct.submissionFineIndices.expanded.bankRecordIndices.length +
        direct.submissionFineIndices.canonical.bankRecordIndices.length,
    });
    generic.destroy();

    expect(() =>
      PartitionedInstancedTranscriptLayer.fromValidatedV4(binding, options, {
        ...scoped.capability,
      })
    ).toThrow(/capability mismatch/);
    expect(() =>
      PartitionedInstancedTranscriptLayer.fromValidatedV4(
        { ...binding, policyProjection: { ...direct.policyProjection } },
        options,
        scoped.capability
      )
    ).toThrow(/capability mismatch/);
  });

  it('prewarms both fine modes under artifact+tile+mode keys and never cap keys', () => {
    const { scene, submissionBank, submissionFineIndices } = directBankFixture();
    const layer = new PartitionedInstancedTranscriptLayer(scene, {
      rendererKind: 'webgl',
      artifactGeneration: 'artifact-fine',
      submissionBank,
      submissionFineIndices,
      maxFineViews: 8,
    });
    const renderer = {
      shader: { bind: vi.fn(), resetState: vi.fn() },
      geometry: { bind: vi.fn(), resetState: vi.fn() },
    };
    layer.prepareGpuResources(renderer as never);
    layer.updateVisibleRange(25, 155);
    expect(layer.getFineViewDebug()).toMatchObject({
      presentationMode: 'coarse',
      fineViewFallbackCount: 1,
    });
    expect(layer.requiresFinePresentationForViewport(25, 155)).toBe(true);
    expect(layer.isFinePresentationExact).toBe(false);
    expect(layer.areFineViewsPrewarmed(25, 155, 0)).toBe(false);

    expect(layer.prewarmFineViews(25, 155, renderer as never, 0)).toEqual({
      built: 2,
      reused: 0,
      evicted: 0,
      requiredFineCount: 1,
    });
    expect(layer.areFineViewsPrewarmed(25, 155, 0)).toBe(true);
    expect(renderer.shader.bind.mock.calls.every((call) => call[1] === true)).toBe(true);
    expect(layer.areFineViewsPrewarmed(524_300, 524_400, 0)).toBe(false);
    const buffersAfterPrewarm = [...pixiFakes.buffers];
    layer.updateAnnotationPolicy({ isoformMode: 'canonical', laneLimit: 3 });
    const fineSubmissions = layer.updateVisibleRange(25, 155);
    expect(fineSubmissions).toHaveLength(1);
    expect(fineSubmissions[0].key).toContain('artifact-fine|fine-512k:0|mode:canonical');
    expect(layer.featureIndexFor(fineSubmissions[0].key, 0)).toBe(2);
    expect(layer.getFineViewDebug()).toMatchObject({
      presentationMode: 'fine',
      fineVisibleCount: 1,
      requiredFineCount: 1,
      fineViewCacheSize: 2,
    });
    expect(layer.isFinePresentationExact).toBe(true);
    expect(layer.getSubmissionDebug()).toMatchObject({
      activeMode: 'canonical',
      actualSubmittedInstanceCount: 3,
      hiddenByIsoformMembershipInstanceCount: 2,
      hiddenByLaneCapInstanceCount: 1,
      visibleDrawCount: 1,
    });

    for (const runtime of [
      { isoformMode: 'canonical' as const, laneLimit: 1 },
      { isoformMode: 'expanded' as const, laneLimit: 6 },
      { isoformMode: 'expanded' as const, laneLimit: null },
    ]) {
      layer.updateAnnotationPolicy(runtime);
      layer.updateVisibleRange(25, 155);
    }
    expect(pixiFakes.buffers).toEqual(buffersAfterPrewarm);
    expect(buffersAfterPrewarm.every(({ dataMutationCount }) => dataMutationCount === 0)).toBe(
      true
    );
    expect(
      pixiFakes.buffers.filter(({ label }) => label.startsWith('partitioned-transcript-bank-fine-'))
    ).toHaveLength(2);
  });

  it('clips the fine-view halo at the final assembly tile', () => {
    const { scene, submissionBank, submissionFineIndices } = directBankFixture();
    const layer = new PartitionedInstancedTranscriptLayer(scene, {
      rendererKind: 'webgl',
      artifactGeneration: 'artifact-final-tile',
      submissionBank,
      submissionFineIndices,
      maxFineViews: 8,
    });
    const renderer = {
      shader: { bind: vi.fn(), resetState: vi.fn() },
      geometry: { bind: vi.fn(), resetState: vi.fn() },
    };
    layer.prepareGpuResources(renderer as never);

    expect(layer.prewarmFineViews(524_300, 599_999, renderer as never)).toEqual({
      built: 4,
      reused: 0,
      evicted: 0,
      requiredFineCount: 2,
    });
    expect(layer.areFineViewsPrewarmed(524_300, 599_999)).toBe(true);
    expect(layer.getFineViewDebug()).toMatchObject({
      fineViewCacheSize: 4,
    });
  });

  it('bounds whole-genome direct-bank broad submission to one draw per 100Mb partition', () => {
    const primitives = Array.from({ length: 31 }, (_, partitionIndex) =>
      primitive(
        partitionIndex,
        partitionIndex * 100_000_000 + 10,
        partitionIndex * 100_000_000 + 20
      )
    );
    const scene = buildPartitionedTranscriptScene(primitives, 100_000_000);
    const table = buildAnnotationPolicyProjectionTableV1({
      features: primitives.map(() => ({
        annotationType: 'mRNA',
        expandedLane: 0,
        expandedTrackLane: 0,
        canonicalLane: 0,
        canonicalTrackLane: 0,
      })),
      expandedBandOrder: ['mRNA'],
      canonicalBandOrder: ['mRNA'],
    });
    const policyGpuInstanceData = buildAnnotationPolicyGpuInstanceDataV1(
      scene.featureIndices,
      table
    );
    const submissionBank = buildAnnotationPolicyDirectSubmissionBankV1(
      scene,
      policyGpuInstanceData
    );
    const expandedFine = buildAnnotationPolicyDirectFineIndexV1(
      submissionBank.expanded,
      3_100_000_000
    );
    const layer = new PartitionedInstancedTranscriptLayer(scene, {
      rendererKind: 'webgl',
      submissionBank,
      submissionFineIndices: {
        expanded: expandedFine,
        canonical: buildAnnotationPolicyDirectFineIndexV1(
          submissionBank.canonical,
          3_100_000_000,
          expandedFine.sourceTilePrimitiveCounts
        ),
      },
    });

    layer.updateAnnotationPolicy({ isoformMode: 'canonical', laneLimit: 12 });
    layer.updateVisibleRange(0, 3_100_000_000);
    const draw = simulateWebGlDraw(
      layer.container as unknown as InstanceType<typeof pixiFakes.FakeContainer>
    );
    expect(draw.drawArraysInstancedCounts).toHaveLength(31);
    expect(draw.drawArraysInstancedCounts).toEqual(Array(31).fill(1));
    expect(layer.getSubmissionDebug()).toMatchObject({
      actualSubmittedInstanceCount: 31,
      actualSubmittedVertexCount: 279,
      visibleDrawCount: 31,
    });
  });

  it('destroys Geometry views without buffers, then owner destroys each shared buffer once', () => {
    const scene = buildPartitionedTranscriptScene(PRIMITIVES, 100_000_000);
    const layer = new PartitionedInstancedTranscriptLayer(scene, { rendererKind: 'webgl' });
    const buffers = [...pixiFakes.buffers];
    layer.destroy();
    expect(pixiFakes.geometries.every(({ destroyArgs }) => destroyArgs.join(',') === 'false')).toBe(
      true
    );
    expect(buffers.map(({ destroyCount }) => destroyCount)).toEqual([1, 1]);
    layer.destroy();
    expect(buffers.map(({ destroyCount }) => destroyCount)).toEqual([1, 1]);
  });

  it.each(['webgpu', 'canvas'] as const)(
    'fails closed for %s before allocating buffers',
    (kind) => {
      const scene = buildPartitionedTranscriptScene(PRIMITIVES, 100_000_000);
      expect(() => new PartitionedInstancedTranscriptLayer(scene, { rendererKind: kind })).toThrow(
        /requires WebGL/
      );
      expect(pixiFakes.buffers).toHaveLength(0);
    }
  );

  it('fails closed before allocation when partition ranges are not contiguous', () => {
    const scene = buildPartitionedTranscriptScene(PRIMITIVES, 100_000_000);
    const corrupt = {
      ...scene,
      partitions: [scene.partitions[0], { ...scene.partitions[1], firstInstance: 99 }],
    };
    expect(
      () => new PartitionedInstancedTranscriptLayer(corrupt, { rendererKind: 'webgl' })
    ).toThrow(/sorted, and contiguous/);
    expect(pixiFakes.buffers).toHaveLength(0);
  });
});
