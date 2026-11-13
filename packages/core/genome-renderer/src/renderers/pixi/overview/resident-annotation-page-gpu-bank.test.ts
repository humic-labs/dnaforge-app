import { beforeEach, describe, expect, it, vi } from 'vitest';

const pixiFakes = vi.hoisted(() => {
  const buffers: FakeBuffer[] = [];

  class FakeBuffer {
    private _data: Float32Array;
    readonly label: string;
    dataMutationCount = 0;
    destroyCount = 0;

    constructor(options: { data: Float32Array; label: string }) {
      this._data = options.data;
      this.label = options.label;
      buffers.push(this);
    }

    get data(): Float32Array {
      return this._data;
    }

    set data(value: Float32Array) {
      this._data = value;
      this.dataMutationCount += 1;
    }

    destroy(): void {
      this.destroyCount += 1;
    }
  }

  class FakeContainer {
    children: unknown[] = [];
    eventMode = '';
    visible = true;
    destroyed = false;

    addChild(child: unknown): void {
      this.children.push(child);
    }

    removeChild(child: unknown): void {
      this.children = this.children.filter((candidate) => candidate !== child);
    }

    destroy(): void {
      this.destroyed = true;
    }
  }

  class FakeGeometry {
    readonly attributes: Record<string, unknown>;
    readonly instanceCount: number;
    destroyCount = 0;

    constructor(options: { attributes: Record<string, unknown>; instanceCount: number }) {
      this.attributes = options.attributes;
      this.instanceCount = options.instanceCount;
    }

    destroy(): void {
      this.destroyCount += 1;
    }
  }

  class FakeShader {
    readonly resources: Record<string, { uniforms: Record<string, unknown> }>;
    readonly glProgram: unknown;
    destroyCount = 0;

    constructor(options: {
      glProgram: unknown;
      resources: Record<string, Record<string, { value: unknown }>>;
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

    destroy(): void {
      this.destroyCount += 1;
    }
  }

  class FakeMesh {
    eventMode = '';
    visible = true;
    destroyed = false;

    destroy(): void {
      this.destroyed = true;
    }
  }

  return { buffers, FakeBuffer, FakeContainer, FakeGeometry, FakeShader, FakeMesh };
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

import type { AnnotationResidentPageRecord } from '../../../annotation-resident-page-store';
import { computeAnnotationTrackLayoutPlan } from '../../../geometry/annotation-track-layout-plan';
import type { Feature } from '../../../types';
import { ResidentAnnotationPageGpuBank } from './resident-annotation-page-gpu-bank';
import type { ViewerRenderContract } from './viewer-render-contract';

const SOURCE = 'assembly:grch38';
const POLICY = 'annotation-source-ir.v3';
const LENGTH = 3_088_269_832;
const LANE_CONTRACT = 'annotation-track-layout.v1:16:14:4';

function sourceShapeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 101,
    type: 'enhancer',
    annotationTrackId: 'enhancer',
    annotationTrackLane: 0,
    annotationTrackLaneCapacity: 2,
    start: 100_000,
    end: 110_000,
    direction: 'forward',
    displayName: 'enhancer-101',
    color: 0x3b82f6,
    lane: 0,
    sourceId: 'enhancer-101',
    ...overrides,
  };
}

function record(
  input: {
    pageKey?: string;
    contentRevision?: string;
    trackId?: string;
    features?: ReadonlyArray<Feature>;
  } = {}
): AnnotationResidentPageRecord {
  const pageKey = input.pageKey ?? 'page-0';
  const contentRevision = input.contentRevision ?? 'revision-0';
  const trackId = input.trackId ?? 'enhancer';
  const features = input.features ?? [sourceShapeFeature({ annotationTrackId: trackId })];
  return {
    sourceIdentity: SOURCE,
    policyKey: POLICY,
    pageKey,
    contentRevision,
    identityKey: `${SOURCE}\u0000${POLICY}\u0000${pageKey}\u0000${contentRevision}`,
    logicalKey: `${SOURCE}\u0000${POLICY}\u0000${pageKey}`,
    byteSize: 1024,
    canonicalFeatureIdentities: features.map((feature) => `canonical:${feature.id}`),
    page: {
      contract: 'annotation-presentation-page.v1',
      pageKey,
      chromosomeId: 'chr-test',
      trackId,
      trackOrder: 0,
      laneCapacity: 2,
      ownerStartBp: 0,
      ownerEndBp: 1_000_000,
      maxFeatureEndBp: features.reduce((max, feature) => Math.max(max, feature.end), 1_000_000),
      contentRevision,
      features,
    },
  };
}

const compileOptions = (contextGeneration: number) => ({
  genomeLengthBp: LENGTH,
  annotationBarHeightPx: 14,
  partitionSpanBp: 100_000_000,
  laneContractIdentity: LANE_CONTRACT,
  themeMode: 'light' as const,
  contextGeneration,
});

const renderer = () => ({
  shader: { bind: vi.fn(), resetState: vi.fn() },
  geometry: { bind: vi.fn(), resetState: vi.fn() },
});

beforeEach(() => {
  pixiFakes.buffers.length = 0;
});

describe('ResidentAnnotationPageGpuBank', () => {
  it('uploads a non-transcript page once and keeps camera updates uniform-only', () => {
    const bank = new ResidentAnnotationPageGpuBank({ laneContractIdentity: LANE_CONTRACT });
    const page = record();
    const artifact = bank.compilePage(page, compileOptions(1));
    expect(bank.compilePage(page, compileOptions(1))).toBe(artifact);
    expect(artifact.authorityStatus).toBe('page-local-exact');
    expect(artifact.exactReady).toBe(true);

    const prepareRenderer = renderer();
    expect(bank.preparePage(artifact.gpuIdentityKey, prepareRenderer as never).status).toBe(
      'prepared'
    );
    expect(bank.preparePage(artifact.gpuIdentityKey, prepareRenderer as never).status).toBe(
      'reused'
    );
    expect(bank.setVisiblePages([artifact.gpuIdentityKey])).toBe(true);
    const instanceBuffer = bank.getPageDebug(artifact.gpuIdentityKey)
      ?.instanceBufferIdentity as InstanceType<typeof pixiFakes.FakeBuffer> | null;
    expect(instanceBuffer).not.toBeNull();

    const contract: ViewerRenderContract = {
      pixelsPerBp: 0.001,
      xOriginBp: 50_000,
      projectX: (bp) => (bp - 50_000) * 0.001,
      projectY: (offset) => 200 + offset,
    };
    const layoutPlan = computeAnnotationTrackLayoutPlan({
      tracks: [{ trackId: 'enhancer', laneCapacity: 2 }],
      laneStepPx: 16,
      barHeightPx: 14,
      trackGapPx: 4,
    });
    bank.updateCamera({ contract, viewportWidth: 1200, viewportHeight: 500, layoutPlan });
    bank.updateCamera({ contract, viewportWidth: 1200, viewportHeight: 500, layoutPlan });

    expect(instanceBuffer?.dataMutationCount).toBe(0);
    expect(bank.getDebugSnapshot()).toMatchObject({
      cpuArtifactCount: 1,
      gpuPageCount: 1,
      gpuPrepareCount: 1,
      gpuUploadCount: 1,
      cameraUpdates: 2,
      trackUniformWrites: 2,
      visiblePageKeys: [artifact.gpuIdentityKey],
    });
  });

  it('commits page visibility atomically and retains the prior owner on a missing candidate', () => {
    const bank = new ResidentAnnotationPageGpuBank({ laneContractIdentity: LANE_CONTRACT });
    const artifact = bank.compilePage(record(), compileOptions(1));
    bank.preparePage(artifact.gpuIdentityKey, renderer() as never);
    expect(bank.setVisiblePages([artifact.gpuIdentityKey])).toBe(true);

    expect(bank.setVisiblePages(['not-prepared'])).toBe(false);
    expect(bank.getDebugSnapshot().visiblePageKeys).toEqual([artifact.gpuIdentityKey]);
    expect(bank.getPageDebug(artifact.gpuIdentityKey)?.visible).toBe(true);
  });

  it('fails closed for transcript pages whose complete body authority is the shared scene', () => {
    const bank = new ResidentAnnotationPageGpuBank({ laneContractIdentity: LANE_CONTRACT });
    const transcript = sourceShapeFeature({
      type: 'mRNA',
      annotationTrackId: 'mRNA',
      exons: [{ start: 100_001, end: 110_000 }],
      transcriptId: 'tx-101',
    });
    const artifact = bank.compilePage(
      record({ trackId: 'mRNA', features: [transcript] }),
      compileOptions(1)
    );

    expect(artifact.authorityStatus).toBe('shared-scene-required');
    expect(artifact.exactReady).toBe(false);
    expect(bank.preparePage(artifact.gpuIdentityKey, renderer() as never)).toEqual({
      status: 'rejected',
      gpuIdentityKey: artifact.gpuIdentityKey,
      reason: 'incomplete-page',
    });
    expect(bank.getDebugSnapshot().gpuUploadCount).toBe(0);
  });

  it('retires prior-context GPU pages before preparing a new renderer generation', () => {
    const bank = new ResidentAnnotationPageGpuBank({ laneContractIdentity: LANE_CONTRACT });
    const first = bank.compilePage(record(), compileOptions(1));
    bank.preparePage(first.gpuIdentityKey, renderer() as never);
    bank.setVisiblePages([first.gpuIdentityKey]);

    const second = bank.compilePage(
      record({ pageKey: 'page-1', contentRevision: 'revision-1' }),
      compileOptions(2)
    );
    bank.preparePage(second.gpuIdentityKey, renderer() as never);

    expect(bank.getPageDebug(first.gpuIdentityKey)).toBeNull();
    expect(bank.getPageDebug(second.gpuIdentityKey)).not.toBeNull();
    expect(bank.getDebugSnapshot()).toMatchObject({
      activeContextGeneration: 2,
      gpuPageCount: 1,
      gpuUploadCount: 2,
      visiblePageKeys: [],
    });
  });
});
