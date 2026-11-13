// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Application, Container } from 'pixi.js';
import type {
  AnnotationPresentationSnapshot,
  AnnotationPresentationSnapshotApplyResult,
  Genome,
  RenderState,
} from '../../types';
import type {
  PrepackedAnnotationSceneBuildOptions,
  PrepackedAnnotationSceneLoadInput,
} from './overview/prepacked-annotation-scene';
import {
  PIXI_LINEAR_RENDERER_COLD_GESTURE_SNAPSHOT_V1,
  PIXI_LINEAR_RENDERER_OPERATION_SNAPSHOT_V1,
} from './linear-renderer';
import { IndexedPixiLinearRenderer } from './indexed-linear-renderer';

const SOURCE = 'operation-oracle-source';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      measureText: (text: string) => ({ width: text.length * 6 }),
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

function genome(): Genome {
  return {
    name: 'operation oracle genome',
    sourceIdentity: SOURCE,
    length: 1_000,
    circular: false,
    features: [],
    sequenceAvailable: true,
  };
}

function state(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 300,
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: [0, 1_000],
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

function presentation(generation: number): AnnotationPresentationSnapshot {
  return {
    contract: 'annotation-presentation-snapshot.v1',
    sourceIdentity: SOURCE,
    genomeLengthBp: 1_000,
    policyKey: 'canonical:lanes=12:layers=mRNA:glyph=v2',
    generation,
    features: [],
    requestedLayerTypes: ['mRNA'],
    layout: { maxAnnotationLane: -1, maxCdsLane: -1 },
    exactCoverage: [{ startBp: 0, endBp: 1_000 }],
  };
}

function app(): Application {
  return {
    stage: new Container(),
    canvas: document.createElement('canvas'),
  } as unknown as Application;
}

type PrepackedMethods = {
  loadPrepackedAnnotationScene(input: PrepackedAnnotationSceneLoadInput): boolean;
  preparePrepackedAnnotationScene(input: PrepackedAnnotationSceneLoadInput): boolean;
  activatePrepackedAnnotationScene(ownerKey: string): boolean;
  updatePrepackedAnnotationPolicy(policy: {
    isoformMode: 'canonical' | 'expanded';
    laneLimit: number | null;
  }): boolean;
  clearPrepackedAnnotationScene(): void;
  buildAndLoadPrepackedAnnotationScene(
    options: PrepackedAnnotationSceneBuildOptions
  ): PrepackedAnnotationSceneLoadInput | null;
};

function prepackedMethods(renderer: IndexedPixiLinearRenderer): PrepackedMethods {
  return (renderer as unknown as { annotationOverlay: PrepackedMethods }).annotationOverlay;
}

describe('PixiLinearRenderer O(1) operation oracle', () => {
  it('assigns a distinct immutable generation to every renderer object', () => {
    const first = new IndexedPixiLinearRenderer().getRendererOperationSnapshot();
    const secondRenderer = new IndexedPixiLinearRenderer();
    const second = secondRenderer.getRendererOperationSnapshot();

    expect(first.contract).toBe(PIXI_LINEAR_RENDERER_OPERATION_SNAPSHOT_V1);
    expect(first.forensicDebugSnapshotCount).toBe(0);
    expect(second.rendererGeneration).toBeGreaterThan(first.rendererGeneration);
    expect(secondRenderer.getRendererOperationSnapshot().rendererGeneration).toBe(
      second.rendererGeneration
    );
    expect(first.counts).toEqual({
      loadGenome: 0,
      annotationSnapshotAttempt: 0,
      annotationSnapshotApply: 0,
      prepackedLoad: 0,
      prepackedPrepare: 0,
      prepackedActivate: 0,
      prepackedPolicyUpdate: 0,
      prepackedRetire: 0,
      contentChangedFrame: 0,
      cameraOnlyFrame: 0,
    });
  });

  it('projects interaction readiness without materializing forensic renderer state', () => {
    const renderer = new IndexedPixiLinearRenderer();
    const overlay = renderer as unknown as {
      annotationOverlay: {
        getCompiledBroadAnnotationInteractionAuthoritySnapshot: () => {
          contract: 'compiled-broad-annotation-interaction-authority-snapshot.v1';
          residentGeneration: number;
          preparedOwnerKeys: readonly string[];
        };
      };
    };
    const authority = vi
      .spyOn(overlay.annotationOverlay, 'getCompiledBroadAnnotationInteractionAuthoritySnapshot')
      .mockReturnValue({
        contract: 'compiled-broad-annotation-interaction-authority-snapshot.v1',
        residentGeneration: 7,
        preparedOwnerKeys: ['owner-a', 'owner-b'],
      });
    const forensic = vi.spyOn(renderer, 'getRendererDebugSnapshot');

    expect(renderer.getCompiledBroadAnnotationInteractionAuthoritySnapshot()).toEqual({
      contract: 'compiled-broad-annotation-interaction-authority-snapshot.v1',
      residentGeneration: 7,
      preparedOwnerKeys: ['owner-a', 'owner-b'],
    });
    expect(authority).toHaveBeenCalledOnce();
    expect(forensic).not.toHaveBeenCalled();
    expect(renderer.getRendererOperationSnapshot().forensicDebugSnapshotCount).toBe(0);
  });

  it('reports exact operation deltas and credits only resident-content frames as camera-only', async () => {
    const renderer = new IndexedPixiLinearRenderer();
    const renderState = state();
    await renderer.init(app(), genome(), () => renderState);

    expect(renderer.getRendererOperationSnapshot()).toMatchObject({
      operationEpoch: 1,
      contentOperationEpoch: 1,
      completedFrameEpoch: 0,
      counts: { loadGenome: 1 },
      lastEpochs: { loadGenome: 1 },
    });

    expect(renderer.setAnnotationPresentationSnapshot(presentation(1))).toEqual({
      status: 'applied',
      generation: 1,
      invalidatedHover: true,
    });
    const afterAppliedSnapshot = renderer.getRendererOperationSnapshot();
    expect(afterAppliedSnapshot.contentOperationEpoch).toBe(3);
    expect(afterAppliedSnapshot.counts.annotationSnapshotAttempt).toBe(1);
    expect(afterAppliedSnapshot.counts.annotationSnapshotApply).toBe(1);
    expect(afterAppliedSnapshot.lastEpochs.annotationSnapshotAttempt).toBe(2);
    expect(afterAppliedSnapshot.lastEpochs.annotationSnapshotApply).toBe(3);

    expect(renderer.setAnnotationPresentationSnapshot(presentation(0))).toEqual({
      status: 'rejected',
      reason: 'stale-generation',
    } satisfies AnnotationPresentationSnapshotApplyResult);
    const afterRejectedSnapshot = renderer.getRendererOperationSnapshot();
    expect(afterRejectedSnapshot.contentOperationEpoch).toBe(4);
    expect(afterRejectedSnapshot.counts.annotationSnapshotAttempt).toBe(2);
    expect(afterRejectedSnapshot.counts.annotationSnapshotApply).toBe(1);
    expect(afterRejectedSnapshot.lastEpochs.annotationSnapshotAttempt).toBe(4);
    expect(afterRejectedSnapshot.lastEpochs.annotationSnapshotApply).toBe(3);

    const overlay = prepackedMethods(renderer);
    vi.spyOn(overlay, 'loadPrepackedAnnotationScene').mockReturnValue(true);
    vi.spyOn(overlay, 'preparePrepackedAnnotationScene').mockReturnValue(false);
    vi.spyOn(overlay, 'activatePrepackedAnnotationScene').mockReturnValue(true);
    vi.spyOn(overlay, 'updatePrepackedAnnotationPolicy').mockReturnValue(true);
    vi.spyOn(overlay, 'clearPrepackedAnnotationScene').mockImplementation(() => undefined);
    const input = {} as PrepackedAnnotationSceneLoadInput;

    expect(renderer.loadPrepackedAnnotationScene(input)).toBe(true);
    expect(renderer.preparePrepackedAnnotationScene(input)).toBe(false);
    expect(renderer.activatePrepackedAnnotationScene('prepared-owner')).toBe(true);
    expect(
      renderer.updatePrepackedAnnotationPolicy({
        isoformMode: 'canonical',
        laneLimit: 12,
      })
    ).toBe(true);
    renderer.clearPrepackedAnnotationScene();

    const beforeFrames = renderer.getRendererOperationSnapshot();
    expect(beforeFrames).toMatchObject({
      operationEpoch: 9,
      contentOperationEpoch: 9,
      completedFrameEpoch: 0,
      counts: {
        loadGenome: 1,
        annotationSnapshotAttempt: 2,
        annotationSnapshotApply: 1,
        prepackedLoad: 1,
        prepackedPrepare: 1,
        prepackedActivate: 1,
        prepackedPolicyUpdate: 1,
        prepackedRetire: 1,
        contentChangedFrame: 0,
        cameraOnlyFrame: 0,
      },
      lastEpochs: {
        prepackedLoad: 5,
        prepackedPrepare: 6,
        prepackedActivate: 7,
        prepackedPolicyUpdate: 8,
        prepackedRetire: 9,
      },
    });
    expect(
      beforeFrames.counts.prepackedLoad +
        beforeFrames.counts.prepackedPrepare +
        beforeFrames.counts.prepackedActivate +
        beforeFrames.counts.prepackedPolicyUpdate +
        beforeFrames.counts.prepackedRetire
    ).toBe(5);

    renderer.render(renderState);
    const firstFrame = renderer.getRendererOperationSnapshot();
    expect(firstFrame).toMatchObject({
      operationEpoch: 10,
      contentOperationEpoch: 9,
      completedFrameEpoch: 1,
      presentedFrameEpoch: 0,
      presentedContentOperationEpoch: 0,
      counts: { contentChangedFrame: 1, cameraOnlyFrame: 0 },
      lastEpochs: { contentChangedFrame: 10, cameraOnlyFrame: 0 },
    });
    renderer.completePresentedFrame();
    expect(renderer.getRendererOperationSnapshot()).toMatchObject({
      completedFrameEpoch: 1,
      presentedFrameEpoch: 1,
      presentedContentOperationEpoch: 9,
    });

    renderState.viewOffset = 0.1;
    renderer.render(renderState);
    const cameraOnlyFrame = renderer.getRendererOperationSnapshot();
    expect(cameraOnlyFrame).toMatchObject({
      operationEpoch: 11,
      contentOperationEpoch: 9,
      completedFrameEpoch: 2,
      presentedFrameEpoch: 1,
      presentedContentOperationEpoch: 9,
      counts: { contentChangedFrame: 1, cameraOnlyFrame: 1 },
      lastEpochs: { contentChangedFrame: 10, cameraOnlyFrame: 11 },
    });
    renderer.completePresentedFrame();

    const stableBaseline = cameraOnlyFrame;
    renderState.viewOffset = 0.2;
    renderer.render(renderState);
    const stableAfter = renderer.getRendererOperationSnapshot();
    expect(stableAfter.contentOperationEpoch - stableBaseline.contentOperationEpoch).toBe(0);
    expect(stableAfter.completedFrameEpoch - stableBaseline.completedFrameEpoch).toBe(1);
    expect(stableAfter.counts.cameraOnlyFrame - stableBaseline.counts.cameraOnlyFrame).toBe(1);
    expect(stableAfter.counts.contentChangedFrame - stableBaseline.counts.contentChangedFrame).toBe(
      0
    );

    const bridged = renderer.getRendererDebugSnapshot() as {
      operationOracle: ReturnType<IndexedPixiLinearRenderer['getRendererOperationSnapshot']>;
    };
    expect(bridged.operationOracle).toEqual({
      ...stableAfter,
      forensicDebugSnapshotCount: stableAfter.forensicDebugSnapshotCount + 1,
    });
    expect(renderer.getRendererOperationSnapshot().forensicDebugSnapshotCount).toBe(1);
    expect(bridged.operationOracle.rendererGeneration).toBe(
      renderer.getRendererOperationSnapshot().rendererGeneration
    );
  });

  it('does not advance a completed-frame epoch when rendering throws', async () => {
    const renderer = new IndexedPixiLinearRenderer();
    const renderState = state();
    await renderer.init(app(), genome(), () => renderState);
    const internals = renderer as unknown as {
      applyTheme(nextState: RenderState): void;
    };
    const applyTheme = vi.spyOn(internals, 'applyTheme').mockImplementationOnce(() => {
      throw new Error('injected frame failure');
    });

    const before = renderer.getRendererOperationSnapshot();
    expect(() => renderer.render(renderState)).toThrow('injected frame failure');
    expect(renderer.getRendererOperationSnapshot()).toEqual(before);

    applyTheme.mockRestore();
    renderer.render(renderState);
    expect(renderer.getRendererOperationSnapshot()).toMatchObject({
      completedFrameEpoch: 1,
      counts: { contentChangedFrame: 1, cameraOnlyFrame: 0 },
    });
  });

  it('records the offline build-and-load entry point as a prepacked load operation', () => {
    const renderer = new IndexedPixiLinearRenderer();
    vi.spyOn(prepackedMethods(renderer), 'buildAndLoadPrepackedAnnotationScene').mockReturnValue(
      null
    );

    expect(
      renderer.buildAndLoadPrepackedAnnotationScene({} as PrepackedAnnotationSceneBuildOptions)
    ).toBeNull();
    expect(renderer.getRendererOperationSnapshot()).toMatchObject({
      operationEpoch: 1,
      contentOperationEpoch: 1,
      counts: { prepackedLoad: 1 },
      lastEpochs: { prepackedLoad: 1 },
    });
  });

  it('copies every successful policy lane envelope without snapshot, load, prepare, activate, or build work', () => {
    const renderer = new IndexedPixiLinearRenderer();
    const overlay = prepackedMethods(renderer) as PrepackedMethods & {
      maxAnnotationLane: number;
      maxCdsLane: number;
    };
    const internals = renderer as unknown as {
      genome: Genome;
      _maxAnnotationLane: number;
      _maxCdsLane: number;
    };
    internals.genome = genome();
    overlay.maxAnnotationLane = 11;
    overlay.maxCdsLane = -1;
    vi.spyOn(overlay, 'updatePrepackedAnnotationPolicy').mockImplementation((policy) => {
      overlay.maxAnnotationLane = policy.laneLimit === null ? 3 : policy.laneLimit - 1;
      overlay.maxCdsLane = -1;
      return true;
    });
    const baseline = renderer.getRendererOperationSnapshot();

    for (const [laneLimit, expectedMaxLane] of [
      [8, 7],
      [24, 23],
      [null, 3],
    ] as const) {
      expect(renderer.updatePrepackedAnnotationPolicy({ isoformMode: 'expanded', laneLimit })).toBe(
        true
      );
      expect(internals._maxAnnotationLane).toBe(expectedMaxLane);
      expect(internals._maxCdsLane).toBe(-1);
    }

    const snapshotOverlay = overlay as typeof overlay & {
      setAnnotationPresentationSnapshot(
        snapshot: AnnotationPresentationSnapshot
      ): AnnotationPresentationSnapshotApplyResult;
    };
    vi.spyOn(snapshotOverlay, 'setAnnotationPresentationSnapshot').mockReturnValue({
      status: 'applied',
      generation: 1,
      invalidatedHover: true,
    });
    const staleSnapshot = {
      ...presentation(1),
      layout: { maxAnnotationLane: -1, maxCdsLane: -1 },
    };
    expect(renderer.setAnnotationPresentationSnapshot(staleSnapshot)).toMatchObject({
      status: 'applied',
    });
    expect(internals._maxAnnotationLane).toBe(3);
    expect(internals._maxCdsLane).toBe(-1);

    const after = renderer.getRendererOperationSnapshot();
    expect(after.counts.prepackedPolicyUpdate - baseline.counts.prepackedPolicyUpdate).toBe(3);
    expect(after.counts.annotationSnapshotAttempt - baseline.counts.annotationSnapshotAttempt).toBe(
      1
    );
    expect(after.counts.annotationSnapshotApply - baseline.counts.annotationSnapshotApply).toBe(1);
    expect(after.counts.loadGenome - baseline.counts.loadGenome).toBe(0);
    expect(after.counts.prepackedLoad - baseline.counts.prepackedLoad).toBe(0);
    expect(after.counts.prepackedPrepare - baseline.counts.prepackedPrepare).toBe(0);
    expect(after.counts.prepackedActivate - baseline.counts.prepackedActivate).toBe(0);
  });

  it('reconciles the sole overlay envelope after direct load, activate, and clear operations', () => {
    const renderer = new IndexedPixiLinearRenderer();
    const overlay = prepackedMethods(renderer) as PrepackedMethods & {
      maxAnnotationLane: number;
      maxCdsLane: number;
    };
    const internals = renderer as unknown as {
      _maxAnnotationLane: number;
      _maxCdsLane: number;
    };
    const input = {} as PrepackedAnnotationSceneLoadInput;
    vi.spyOn(overlay, 'loadPrepackedAnnotationScene').mockImplementation(() => {
      overlay.maxAnnotationLane = 11;
      overlay.maxCdsLane = -1;
      return true;
    });
    vi.spyOn(overlay, 'activatePrepackedAnnotationScene').mockImplementation(() => {
      overlay.maxAnnotationLane = 7;
      overlay.maxCdsLane = -1;
      return true;
    });
    vi.spyOn(overlay, 'clearPrepackedAnnotationScene').mockImplementation(() => {
      overlay.maxAnnotationLane = 3;
      overlay.maxCdsLane = 0;
    });

    expect(renderer.loadPrepackedAnnotationScene(input)).toBe(true);
    expect([internals._maxAnnotationLane, internals._maxCdsLane]).toEqual([11, -1]);
    expect(renderer.activatePrepackedAnnotationScene('owner-b')).toBe(true);
    expect([internals._maxAnnotationLane, internals._maxCdsLane]).toEqual([7, -1]);
    renderer.clearPrepackedAnnotationScene();
    expect([internals._maxAnnotationLane, internals._maxCdsLane]).toEqual([3, 0]);
  });

  it('projects one exact track and annotation receipt without entering either debug tree', () => {
    const renderer = new IndexedPixiLinearRenderer();
    const container = new Container();
    const track = {
      id: 'pileup-exact',
      type: 'pileup',
      order: 0,
      visible: true,
      assemblyId: 'test',
      zone: 'below-legacy',
      sizing: { kind: 'fixed', pixels: 24 },
    } as const;
    const diagnostics = {
      coverageLodRole: 'resident',
      coverageLodLevel: 3,
      coverageLodTargetLevel: 3,
      coverageLodBinSize: 4096,
      coverageLodAuthority: 'gpu-atlas',
      coverageLodProvenanceExact: true,
      coverageSamplePassCount: 0,
      coverageGeometryBuildCount: 0,
      coverageBufferUploadCount: 0,
      coverageSignalNonzeroBinCount: 128,
      renderedReadDensityAlpha: 0.75,
      densityRowsMeshVisible: false,
      coverageGpuAtlasAuthorityKey: 'authority',
      coverageGpuAtlasTextureResourceCreateCount: 1,
      coverageGpuAtlasGpuTextureResourceCreateCount: 1,
      coverageGpuAtlasGpuTextureUploadCount: 1,
      coverageGpuAtlasGpuTextureUploadComplete: true,
      coverageGpuAtlasTextureResourceUid: 0,
      coverageGpuAtlasShaderTextureResourceUid: 0,
      coverageGpuAtlasShaderTextureResourceBound: true,
      coverageGpuAtlasGeometryBuildCount: 1,
      coverageGpuAtlasCameraUniformUpdateCount: 9,
      coverageGpuAtlasRenderOwner: 'coverage-gpu-atlas',
      coverageGpuAtlasShaderProgramName: 'coverage-gpu-atlas',
      coverageGpuAtlasShaderProgramKey: 0,
      coverageGpuAtlasShaderProgramCompiled: true,
      coverageGpuAtlasActive: true,
      coverageGpuAtlasBaseBinSizeBp: 256,
      rendererViewportStartBp: 10,
      rendererViewportEndBp: 990,
    };
    const internals = renderer as unknown as {
      genome: Genome;
      lastViewportBpRange: { start: number; end: number };
      lastViewportWidthPx: number;
      lastCanvasHeight: number;
      trackInstancesById: Map<string, typeof track>;
      trackContainers: Map<string, Container>;
      trackRenderers: Map<string, { getDiagnostics: (value: Container) => object }>;
      annotationOverlay: {
        getLayoutStateForTest: () => {
          currentGenomeIdentity: string;
          genomeLength: number;
        };
        getDebugSnapshot: () => unknown;
      };
    };
    internals.genome = genome();
    internals.lastViewportBpRange = { start: 10, end: 990 };
    internals.lastViewportWidthPx = 800;
    internals.lastCanvasHeight = 300;
    internals.trackInstancesById.set(track.id, track);
    internals.trackContainers.set(track.id, container);
    internals.trackRenderers.set(track.type, {
      getDiagnostics: (value) => (value === container ? diagnostics : {}),
    });
    const layout = internals.annotationOverlay.getLayoutStateForTest();
    layout.currentGenomeIdentity = SOURCE;
    layout.genomeLength = 1_000;
    const rendererDebug = vi.spyOn(renderer, 'getRendererDebugSnapshot');
    const annotationDebug = vi.spyOn(internals.annotationOverlay, 'getDebugSnapshot');

    const snapshot = renderer.getColdGestureSnapshot(track.id);

    expect(snapshot).toMatchObject({
      contract: PIXI_LINEAR_RENDERER_COLD_GESTURE_SNAPSHOT_V1,
      supported: true,
      genomeIdentity: SOURCE,
      genomeLengthBp: 1_000,
      viewportStartBp: 10,
      viewportEndBp: 990,
      viewportWidthPx: 800,
      viewportHeightPx: 300,
      track: {
        requestedTrackId: track.id,
        trackFound: true,
        diagnosticsSupported: true,
        coverageGpuAtlasAuthorityKey: 'authority',
        coverageGpuAtlasTextureResourceUid: 0,
        coverageGpuAtlasShaderProgramKey: 0,
        coverageGpuAtlasShaderProgramCompiled: true,
        coverageSamplePassCount: 0,
        coverageGeometryBuildCount: 0,
        coverageBufferUploadCount: 0,
        coverageSignalNonzeroBinCount: 128,
        renderedReadDensityAlpha: 0.75,
        densityRowsMeshVisible: false,
      },
      annotation: {
        contract: 'annotation-overlay-cold-gesture-snapshot.v1',
        genomeIdentity: SOURCE,
        genomeLengthBp: 1_000,
      },
    });
    expect(rendererDebug).not.toHaveBeenCalled();
    expect(annotationDebug).not.toHaveBeenCalled();
    expect(renderer.getColdGestureSnapshot('missing')).toMatchObject({
      supported: false,
      track: {
        requestedTrackId: 'missing',
        trackFound: false,
        diagnosticsSupported: false,
      },
    });

    const mutableDiagnostics = diagnostics as unknown as Record<string, unknown>;
    const densityRowsMeshVisible = mutableDiagnostics.densityRowsMeshVisible;
    delete mutableDiagnostics.densityRowsMeshVisible;
    expect(renderer.getColdGestureSnapshot(track.id)).toMatchObject({
      supported: false,
      track: { diagnosticsSupported: false },
    });
    mutableDiagnostics.densityRowsMeshVisible = densityRowsMeshVisible;

    const coverageSignalNonzeroBinCount = mutableDiagnostics.coverageSignalNonzeroBinCount;
    delete mutableDiagnostics.coverageSignalNonzeroBinCount;
    expect(renderer.getColdGestureSnapshot(track.id)).toMatchObject({
      supported: false,
      track: { diagnosticsSupported: false },
    });
    mutableDiagnostics.coverageSignalNonzeroBinCount = coverageSignalNonzeroBinCount;
  });
});
