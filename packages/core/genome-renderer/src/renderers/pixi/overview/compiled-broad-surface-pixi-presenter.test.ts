// @vitest-environment jsdom
import { ImageSource, Texture } from 'pixi.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TRANSCRIPT_COLORS } from '../../../feature-colors';
import { indexedAnnotationColorForRuntimeTheme } from '../shared/annotation-runtime-theme';

vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => null,
  });
});

import {
  buildCompiledBroadSurfaceManifestV2,
  compiledBroadSurfaceCellIdV2,
  deriveBroadSurfacePresentationPlanV2,
  type BroadSurfacePresentationPlanV2,
  type CompiledBroadSurfaceManifestV2,
} from './bounded-annotation-broad-surface';
import {
  COMPILED_BROAD_SURFACE_PIXI_PRESENTER_V2,
  CompiledBroadSurfacePixiPresenterV2,
  type CompiledBroadSurfacePixiCameraV2,
} from './compiled-broad-surface-pixi-presenter';

const GENOME_LENGTH_BP = 3_088_269_832;
const VIEWPORT_WIDTH_PX = 1_200;
const VIEWPORT_HEIGHT_PX = 800;
const DISPLAY_DPR = 2;
const presenters: CompiledBroadSurfacePixiPresenterV2[] = [];

function colorChannels(color: number): readonly [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

function mixColor(left: number, right: number): number {
  const leftChannels = colorChannels(left);
  const rightChannels = colorChannels(right);
  const mixed = leftChannels.map((channel, index) =>
    Math.round((channel + rightChannels[index]) / 2)
  );
  return (mixed[0] << 16) | (mixed[1] << 8) | mixed[2];
}

function maximumColorChannelDelta(left: number, right: number): number {
  const leftChannels = colorChannels(left);
  const rightChannels = colorChannels(right);
  return Math.max(
    ...leftChannels.map((channel, index) => Math.abs(channel - rightChannels[index]))
  );
}

async function manifest(): Promise<CompiledBroadSurfaceManifestV2> {
  return buildCompiledBroadSurfaceManifestV2({
    artifactKey: 'bounded-annotation-artifact.v2:mrna',
    trackId: 'mrna',
    genomeLengthBp: GENOME_LENGTH_BP,
    broadCorridorFinestSpanBp: 16_000_000,
    broadTilePhysicalWidthPx: 512,
    broadTileXGuardPhysicalPx: 1,
    prefetchRing: 1,
    maxQualifiedRasterMagnificationX: 1.75,
    rasterDevicePixelRatio: 2,
    laneSlabRowCount: 8,
    laneRowCssHeightPx: 16,
    laneRowTextureStridePx: 32,
    laneRowTransparentTailGutterPx: 4,
    laneRowCounts: { canonical: 12, expanded: 368 },
  });
}

it('keeps a compiled light-basis transcript mixture near the equivalent dark vector mixture', () => {
  const canonicalRasterMixture = mixColor(
    TRANSCRIPT_COLORS.light.cdsThick,
    TRANSCRIPT_COLORS.light.utr
  );
  const expectedVectorMixture = mixColor(
    TRANSCRIPT_COLORS.dark.cdsThick,
    TRANSCRIPT_COLORS.dark.utr
  );
  const projectedRasterMixture = indexedAnnotationColorForRuntimeTheme(
    canonicalRasterMixture,
    'mRNA',
    'dark'
  );

  expect(
    maximumColorChannelDelta(projectedRasterMixture, expectedVectorMixture)
  ).toBeLessThanOrEqual(24);
});

function plan(
  value: CompiledBroadSurfaceManifestV2,
  input: {
    startBp?: number;
    spanBp?: number;
    mode?: 'canonical' | 'expanded';
    laneLimit?: number | null;
  } = {}
): BroadSurfacePresentationPlanV2 {
  const startBp = input.startBp ?? 100_000_000;
  const spanBp = input.spanBp ?? 500_000_000;
  const result = deriveBroadSurfacePresentationPlanV2({
    manifest: value,
    isoformMode: input.mode ?? 'expanded',
    laneLimit: input.laneLimit === undefined ? 12 : input.laneLimit,
    viewportStartBp: startBp,
    viewportEndBp: startBp + spanBp,
    viewportCssWidthPx: VIEWPORT_WIDTH_PX,
    devicePixelRatio: DISPLAY_DPR,
  });
  expect(result.status).toBe('broad-ready');
  if (result.status !== 'broad-ready') throw new Error('expected broad-ready plan');
  return result;
}

function decodedTexture(
  value: CompiledBroadSurfaceManifestV2,
  options: { dynamic?: boolean; physicalWidth?: number; resolution?: number } = {}
): Texture {
  const physicalWidth =
    options.physicalWidth ?? value.broadTilePhysicalWidthPx + value.broadTileXGuardPhysicalPx * 2;
  const physicalHeight = value.laneSlabRowCount * value.laneRowTextureStridePx;
  const source = new ImageSource({
    resource: { width: physicalWidth, height: physicalHeight } as ImageBitmap,
    resolution: options.resolution ?? 1,
    scaleMode: 'linear',
  });
  return new Texture({ source, dynamic: options.dynamic });
}

function camera(
  value: BroadSurfacePresentationPlanV2,
  options: { startBp?: number; top?: number; themeMode?: 'light' | 'dark' } = {}
): CompiledBroadSurfacePixiCameraV2 {
  const startBp = options.startBp ?? value.viewportStartBp;
  const spanBp = value.viewportEndBp - value.viewportStartBp;
  const pixelsPerBp = VIEWPORT_WIDTH_PX / spanBp;
  return {
    plan: value,
    contract: {
      pixelsPerBp,
      xOriginBp: startBp,
      projectX: (bp) => (bp - startBp) * pixelsPerBp,
      projectY: (offset) => offset,
    },
    trackTopCssPx: options.top ?? 24,
    viewportCssWidthPx: VIEWPORT_WIDTH_PX,
    viewportCssHeightPx: VIEWPORT_HEIGHT_PX,
    themeMode: options.themeMode ?? 'light',
  };
}

function addresses(value: BroadSurfacePresentationPlanV2) {
  return value.activeLevels.flatMap((level) =>
    level.residentXTileIds.flatMap((tileId) => {
      const match = /^L(\d+):X(\d+)$/.exec(tileId);
      if (!match) throw new Error(`bad tile id: ${tileId}`);
      return value.submittedLaneSlabIds.map((_slabId, laneSlabIndex) => ({
        isoformMode: value.isoformMode,
        level: Number(match[1]),
        tileX: Number(match[2]),
        laneSlabIndex,
      }));
    })
  );
}

function submittedAddresses(value: BroadSurfacePresentationPlanV2) {
  return value.activeLevels.flatMap((level) =>
    level.visibleTilePlacements.flatMap((placement) =>
      value.submittedLaneSlabIds.map((_slabId, laneSlabIndex) => ({
        isoformMode: value.isoformMode,
        level: level.level,
        tileX: placement.tileX,
        laneSlabIndex,
      }))
    )
  );
}

function admitPlan(
  presenter: CompiledBroadSurfacePixiPresenterV2,
  value: CompiledBroadSurfaceManifestV2,
  presentation: BroadSurfacePresentationPlanV2,
  textures = new Map<string, Texture>()
): Map<string, Texture> {
  expect(presenter.reservePresentationCapacity(presentation)).toBe(true);
  for (const address of addresses(presentation)) {
    const texture = decodedTexture(value);
    const cellId = compiledBroadSurfaceCellIdV2({ manifest: value, ...address });
    if (presenter.hasResidentCell(cellId)) {
      texture.destroy(true);
      continue;
    }
    const result = presenter.admitCellTexture({ ...address, texture });
    if (result.status === 'admitted') textures.set(result.cellId, texture);
    else if (result.status === 'already-resident') texture.destroy(true);
    else throw new Error('reason' in result ? result.reason : 'unexpected admission result');
  }
  return textures;
}

afterEach(() => {
  while (presenters.length > 0) presenters.pop()?.destroy();
});

describe('CompiledBroadSurfacePixiPresenterV2', () => {
  it('constructs zero catalog-sized meshes and reserves only the visible bounded high-water', async () => {
    const value = await manifest();
    const presentation = plan(value, { laneLimit: 64 });
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);

    expect(presenter.diagnostics()).toMatchObject({
      quadPoolCapacity: 0,
      meshCreationCount: 0,
      shaderCreationCount: 0,
      geometryCreationCount: 1,
    });
    expect(presenter.reservePresentationCapacity(presentation)).toBe(true);
    const expectedCapacity =
      presentation.activeLevels[0].visibleTilePlacements.length *
      presentation.submittedLaneSlabIds.length;
    expect(expectedCapacity).toBeLessThan(100);
    expect(presenter.diagnostics()).toMatchObject({
      quadPoolCapacity: expectedCapacity,
      meshCreationCount: expectedCapacity * 2,
      shaderCreationCount: expectedCapacity * 2,
      geometryCreationCount: 1,
    });
  });

  it('pre-reserves fixed mesh capacity for the full-genome through 150 Mb corridor', async () => {
    const value = await manifest();
    const spans = [GENOME_LENGTH_BP, 2_200_000_000, 1_300_000_000, 500_000_000, 150_000_000];
    const plans = spans.flatMap((spanBp) =>
      [8, 12, 24, 64].map((laneLimit) =>
        plan(value, {
          startBp: Math.floor((GENOME_LENGTH_BP - spanBp) / 2),
          spanBp,
          mode: 'expanded',
          laneLimit,
        })
      )
    );
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    expect(
      presenter.reserveCorridorPresentationCapacity({
        viewportCssWidthPx: VIEWPORT_WIDTH_PX,
        devicePixelRatio: DISPLAY_DPR,
        maximumLaneLimit: 64,
      })
    ).toBe(true);
    const reserved = presenter.diagnostics();
    const architectureVisibleTileBound =
      Math.ceil((VIEWPORT_WIDTH_PX * DISPLAY_DPR) / (value.broadTilePhysicalWidthPx / 2)) + 2;
    expect(reserved.quadPoolCapacity).toBeLessThanOrEqual(architectureVisibleTileBound * 8);
    expect(
      presenter.reservePresentationCapacity(plan(value, { mode: 'expanded', laneLimit: null }))
    ).toBe(false);
    expect(
      presenter.reserveCorridorPresentationCapacity({
        viewportCssWidthPx: VIEWPORT_WIDTH_PX / 2,
        devicePixelRatio: DISPLAY_DPR,
        maximumLaneLimit: 64,
      })
    ).toBe(true);
    expect(presenter.diagnostics().quadPoolCapacity).toBe(reserved.quadPoolCapacity);

    for (const presentation of plans) {
      admitPlan(presenter, value, presentation);
      const afterAdmission = presenter.diagnostics();
      expect(afterAdmission).toMatchObject({
        quadPoolCapacity: reserved.quadPoolCapacity,
        meshCreationCount: reserved.meshCreationCount,
        geometryCreationCount: reserved.geometryCreationCount,
      });
      const textureAdmissionCount = afterAdmission.textureAdmissionCount;
      const staged = presenter.stagePresentation(presentation);
      if (staged.status === 'staged') {
        expect(presenter.commitStagedPresentation(staged.receipt, camera(presentation))).toBe(true);
      } else {
        expect(staged.status).toBe('already-active');
        expect(presenter.updateCamera(camera(presentation))).toBe(true);
      }
      expect(presenter.diagnostics()).toMatchObject({
        quadPoolCapacity: reserved.quadPoolCapacity,
        meshCreationCount: reserved.meshCreationCount,
        geometryCreationCount: reserved.geometryCreationCount,
        textureAdmissionCount,
        broadVectorSubmissionCount: 0,
        runtimeCellCompileCount: 0,
        runtimeDurableWriteCount: 0,
      });
    }
  });

  it('retains immutable texture-pair bindings across LOD revisits without listener churn', async () => {
    const value = await manifest();
    const whole = plan(value, { startBp: 0, spanBp: GENOME_LENGTH_BP });
    const closer = plan(value, { spanBp: 1_300_000_000 });
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    const textures = admitPlan(presenter, value, whole);
    admitPlan(presenter, value, closer, textures);
    const sourceOffSpies = [...textures.values()].map((texture) => vi.spyOn(texture.source, 'off'));

    const first = presenter.stagePresentation(whole);
    if (first.status !== 'staged') throw new Error('expected whole-genome stage');
    expect(presenter.commitStagedPresentation(first.receipt, camera(whole))).toBe(true);

    const second = presenter.stagePresentation(closer);
    if (second.status !== 'staged') throw new Error('expected closer stage');
    expect(presenter.commitStagedPresentation(second.receipt, camera(closer))).toBe(true);

    const beforeRevisit = presenter.diagnostics().shaderCreationCount;
    const revisit = presenter.stagePresentation(whole);
    if (revisit.status !== 'staged') throw new Error('expected whole-genome revisit stage');
    expect(presenter.commitStagedPresentation(revisit.receipt, camera(whole))).toBe(true);

    expect(presenter.diagnostics().shaderCreationCount).toBe(beforeRevisit);
    for (const sourceOff of sourceOffSpies) expect(sourceOff).not.toHaveBeenCalled();
  });

  it('fails closed on an incomplete adjacent-mip roster with zero vector fallback', async () => {
    const value = await manifest();
    const presentation = plan(value);
    expect(presentation.activeLevels).toHaveLength(2);
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);

    const result = presenter.stagePresentation(presentation);

    expect(result.status).toBe('missing-cells');
    if (result.status !== 'missing-cells') throw new Error('expected missing cells');
    expect(result.missingCellIds).toHaveLength(presentation.activeSubmittedSurfaceCellIds.length);
    expect(presenter.diagnostics()).toMatchObject({
      contract: COMPILED_BROAD_SURFACE_PIXI_PRESENTER_V2,
      presenting: false,
      holdingLastGood: false,
      broadVectorSubmissionCount: 0,
      runtimeCellCompileCount: 0,
      runtimeDurableWriteCount: 0,
      lastFailure: 'required-raster-cells-missing',
    });
  });

  it('atomically commits one premultiplied two-source quad per fine tile and lane slab', async () => {
    const value = await manifest();
    const presentation = plan(value);
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    admitPlan(presenter, value, presentation);

    const staged = presenter.stagePresentation(presentation);
    expect(staged.status).toBe('staged');
    if (staged.status !== 'staged') throw new Error('expected staged scene');
    expect(presenter.diagnostics().presenting).toBe(false);

    expect(presenter.commitStagedPresentation(staged.receipt, camera(presentation))).toBe(true);

    const diagnostics = presenter.diagnostics();
    expect(diagnostics.presenting).toBe(true);
    expect(diagnostics.atomicCommitCount).toBe(1);
    expect(diagnostics.activeMipWeights).toEqual(
      presentation.activeLevels.map((level) => level.sampleWeight)
    );
    expect(diagnostics.activeLevels).toEqual(
      presentation.activeLevels.map((level) => ({
        role: level.role,
        level: level.level,
        tileSpanBp: level.tileSpanBp,
        sampleWeight: level.sampleWeight,
        projectedTilePhysicalWidthPx: level.projectedTilePhysicalWidthPx,
        rasterMagnificationX: level.rasterMagnificationX,
      }))
    );
    expect(diagnostics.maxQualifiedRasterMagnificationX).toBe(
      value.maxQualifiedRasterMagnificationX
    );
    expect(diagnostics.submittedCellIds).toEqual(presentation.activeSubmittedSurfaceCellIds);
    expect(diagnostics.activeResidentCellIds).toHaveLength(staged.receipt.residentCellIds.length);
    expect(diagnostics.presentedQuads).toHaveLength(
      presentation.activeLevels[0].visibleTilePlacements.length *
        presentation.submittedLaneSlabIds.length
    );
    expect(diagnostics.presentedQuads.every((quad) => quad.finerCellId.length > 0)).toBe(true);
    expect(diagnostics.presentedQuads.every((quad) => quad.coarserCellId.length > 0)).toBe(true);
    expect(
      diagnostics.presentedQuads.some((quad) =>
        quad.finerUvRect.some((valueAtIndex, index) => valueAtIndex !== quad.coarserUvRect[index])
      )
    ).toBe(true);
    expect(diagnostics.broadVectorSubmissionCount).toBe(0);
  });

  it('purely preflights the exact receipt, topology, residency, and camera before commit', async () => {
    const value = await manifest();
    const presentation = plan(value);
    const mismatchedPresentation = plan(value, { startBp: 900_000_000 });
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    admitPlan(presenter, value, presentation);

    const staged = presenter.stagePresentation(presentation);
    if (staged.status !== 'staged') throw new Error('expected staged scene');
    const validCamera = camera(presentation);
    const before = presenter.diagnostics();

    expect(presenter.canCommitStagedPresentation(staged.receipt, validCamera)).toBe(true);
    expect(
      presenter.canCommitStagedPresentation(Object.freeze({ ...staged.receipt }), validCamera)
    ).toBe(false);
    expect(
      presenter.canCommitStagedPresentation(staged.receipt, camera(mismatchedPresentation))
    ).toBe(false);
    expect(
      presenter.canCommitStagedPresentation(staged.receipt, {
        ...validCamera,
        viewportCssWidthPx: 0,
      })
    ).toBe(false);
    expect(
      presenter.canCommitStagedPresentation(staged.receipt, {
        ...validCamera,
        contract: { ...validCamera.contract, projectX: () => Number.NaN },
      })
    ).toBe(false);

    expect(presenter.diagnostics()).toEqual(before);
    expect(presenter.canCommitStagedPresentation(staged.receipt, validCamera)).toBe(true);
    expect(presenter.commitStagedPresentation(staged.receipt, validCamera)).toBe(true);
    expect(presenter.diagnostics()).toMatchObject({
      presenting: true,
      atomicCommitCount: 1,
      cameraTransformUpdateCount: 1,
      lastFailure: null,
    });
  });

  it('fails preflight after staged residency invalidation without publishing a scene', async () => {
    const value = await manifest();
    const presentation = plan(value);
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    const textures = admitPlan(presenter, value, presentation);

    const staged = presenter.stagePresentation(presentation);
    if (staged.status !== 'staged') throw new Error('expected staged scene');
    const stagedCell = staged.receipt.residentCellIds[0];
    textures.get(stagedCell)?.source.update();

    expect(presenter.canCommitStagedPresentation(staged.receipt, camera(presentation))).toBe(false);
    expect(presenter.commitStagedPresentation(staged.receipt, camera(presentation))).toBe(false);
    expect(presenter.diagnostics()).toMatchObject({
      presenting: false,
      atomicCommitCount: 0,
      cameraTransformUpdateCount: 0,
      lastFailure: 'staged-raster-cell-invalidated',
    });
  });

  it('uses nominal world placement and crops the final lane slab at the exact row boundary', async () => {
    const value = await manifest();
    const presentation = plan(value, { laneLimit: 12 });
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    admitPlan(presenter, value, presentation);
    const staged = presenter.stagePresentation(presentation);
    if (staged.status !== 'staged') throw new Error('expected staged scene');
    presenter.commitStagedPresentation(staged.receipt, camera(presentation));

    const diagnostics = presenter.diagnostics();
    const firstPlacement = presentation.activeLevels[0].visibleTilePlacements[0];
    const firstSlab = diagnostics.presentedQuads.find(
      (quad) =>
        quad.destinationStartBp === firstPlacement.destinationStartBp && quad.laneSlabIndex === 0
    );
    const finalSlab = diagnostics.presentedQuads.find(
      (quad) =>
        quad.destinationStartBp === firstPlacement.destinationStartBp && quad.laneSlabIndex === 1
    );
    expect(firstSlab).toMatchObject({
      destinationStartBp: firstPlacement.destinationStartBp,
      destinationEndBpExclusive: firstPlacement.destinationEndBpExclusive,
      visibleLaneRowCount: 8,
    });
    expect(finalSlab).toMatchObject({ visibleLaneRowCount: 4 });
    expect(finalSlab?.finerUvRect[1]).toBe(0.5);
    expect(finalSlab?.finerUvRect[3]).toBe(0);
  });

  it('updates only transforms and mip weight for camera motion within one staged roster', async () => {
    const value = await manifest();
    const presentation = plan(value);
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    admitPlan(presenter, value, presentation);
    const staged = presenter.stagePresentation(presentation);
    if (staged.status !== 'staged') throw new Error('expected staged scene');
    presenter.commitStagedPresentation(staged.receipt, camera(presentation));
    const before = presenter.diagnostics();

    for (let index = 0; index < 20; index += 1) {
      expect(
        presenter.updateCamera(
          camera(presentation, { startBp: presentation.viewportStartBp + index * 1_000 })
        )
      ).toBe(true);
    }

    const after = presenter.diagnostics();
    expect(after.stagedSceneBuildCount).toBe(before.stagedSceneBuildCount);
    expect(after.atomicCommitCount).toBe(before.atomicCommitCount);
    expect(after.textureAdmissionCount).toBe(before.textureAdmissionCount);
    expect(after.meshCreationCount).toBe(before.meshCreationCount);
    expect(after.shaderCreationCount).toBe(before.shaderCreationCount);
    expect(after.geometryCreationCount).toBe(before.geometryCreationCount);
    expect(after.residentCellIds).toEqual(before.residentCellIds);
    expect(after.runtimeCellCompileCount).toBe(0);
    expect(after.runtimeDurableWriteCount).toBe(0);
    expect(after.broadVectorSubmissionCount).toBe(0);
    expect(after.cameraTransformUpdateCount).toBe(before.cameraTransformUpdateCount + 20);
  });

  it('reports the exact live adjacent-mip roster without invoking allocating diagnostics', async () => {
    const value = await manifest();
    const initial = plan(value, { startBp: 100_000_000, spanBp: 500_000_000 });
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    admitPlan(presenter, value, initial);
    const staged = presenter.stagePresentation(initial);
    if (staged.status !== 'staged') throw new Error('expected staged scene');
    expect(presenter.commitStagedPresentation(staged.receipt, camera(initial))).toBe(true);
    expect(presenter.activeTopologyCoversLastCamera).toBe(true);
    const diagnostics = vi.spyOn(presenter, 'diagnostics');

    const before = presenter.getColdGestureSnapshot();
    expect(before).toEqual({
      activeLevelIds: initial.activeLevels.map((level) => `${level.role}:L${level.level}`),
      activeMipWeights: initial.activeLevels.map((level) => level.sampleWeight),
      activeResidentCellIds: initial.activeSubmittedSurfaceCellIds,
      submittedCellIds: initial.activeSubmittedSurfaceCellIds,
      runtimeCellCompileCount: 0,
      runtimeDurableWriteCount: 0,
    });
    expect(diagnostics).not.toHaveBeenCalled();

    const moved = [499_000_000, 501_000_000, 498_000_000, 502_000_000]
      .map((spanBp) => plan(value, { startBp: 100_000_000, spanBp }))
      .find(
        (candidate) =>
          candidate.lodMix !== initial.lodMix &&
          candidate.activeSubmittedSurfaceCellIds.length ===
            initial.activeSubmittedSurfaceCellIds.length &&
          candidate.activeSubmittedSurfaceCellIds.every(
            (cellId, index) => cellId === initial.activeSubmittedSurfaceCellIds[index]
          )
      );
    expect(moved).toBeDefined();
    if (!moved) throw new Error('expected same-topology plan with a different mip mix');
    const movedCamera = camera(moved);
    expect(
      presenter.updateCameraWithinActiveTopology({
        isoformMode: moved.isoformMode,
        laneLimit: moved.laneLimit,
        viewportStartBp: moved.viewportStartBp,
        viewportEndBp: moved.viewportEndBp,
        devicePixelRatio: DISPLAY_DPR,
        contract: movedCamera.contract,
        trackTopCssPx: movedCamera.trackTopCssPx,
        viewportCssWidthPx: movedCamera.viewportCssWidthPx,
        viewportCssHeightPx: movedCamera.viewportCssHeightPx,
        themeMode: movedCamera.themeMode,
      })
    ).toBe(true);
    expect(presenter.activeTopologyCoversLastCamera).toBe(true);

    const outside = plan(value, { startBp: 900_000_000, spanBp: 500_000_000 });
    const outsideCamera = camera(outside);
    expect(
      presenter.updateCameraWithinActiveTopology({
        isoformMode: outside.isoformMode,
        laneLimit: outside.laneLimit,
        viewportStartBp: outside.viewportStartBp,
        viewportEndBp: outside.viewportEndBp,
        devicePixelRatio: DISPLAY_DPR,
        contract: outsideCamera.contract,
        trackTopCssPx: outsideCamera.trackTopCssPx,
        viewportCssWidthPx: outsideCamera.viewportCssWidthPx,
        viewportCssHeightPx: outsideCamera.viewportCssHeightPx,
        themeMode: outsideCamera.themeMode,
      })
    ).toBe(false);
    expect(presenter.activeTopologyCoversLastCamera).toBe(false);

    const after = presenter.getColdGestureSnapshot();
    expect(after.activeLevelIds).toEqual(
      moved.activeLevels.map((level) => `${level.role}:L${level.level}`)
    );
    expect(after.activeMipWeights).toEqual(moved.activeLevels.map((level) => level.sampleWeight));
    expect(after.activeMipWeights).not.toEqual(before.activeMipWeights);
    expect(after.activeResidentCellIds).toBe(before.activeResidentCellIds);
    expect(after.submittedCellIds).toBe(before.submittedCellIds);
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it('clears stale missing demand after the active topology exactly covers the latest camera', async () => {
    const value = await manifest();
    const initial = plan(value, { startBp: 100_000_000, spanBp: 500_000_000 });
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    admitPlan(presenter, value, initial);
    const staged = presenter.stagePresentation(initial);
    if (staged.status !== 'staged') throw new Error('expected staged scene');
    expect(presenter.commitStagedPresentation(staged.receipt, camera(initial))).toBe(true);

    const unavailable = plan(value, { startBp: 1_800_000_000, spanBp: 500_000_000 });
    expect(presenter.stagePresentation(unavailable)).toMatchObject({ status: 'missing-cells' });
    expect(presenter.diagnostics()).toMatchObject({
      presenting: true,
      holdingLastGood: true,
    });
    expect(presenter.missingCellCount).toBeGreaterThan(0);

    const restoredCamera = camera(initial);
    expect(
      presenter.updateCameraWithinActiveTopology({
        isoformMode: initial.isoformMode,
        laneLimit: initial.laneLimit,
        viewportStartBp: initial.viewportStartBp,
        viewportEndBp: initial.viewportEndBp,
        devicePixelRatio: DISPLAY_DPR,
        contract: restoredCamera.contract,
        trackTopCssPx: restoredCamera.trackTopCssPx,
        viewportCssWidthPx: restoredCamera.viewportCssWidthPx,
        viewportCssHeightPx: restoredCamera.viewportCssHeightPx,
        themeMode: restoredCamera.themeMode,
      })
    ).toBe(true);
    expect(presenter.activeTopologyCoversLastCamera).toBe(true);
    expect(presenter.missingCellCount).toBe(0);
    expect(presenter.diagnostics()).toMatchObject({
      presenting: true,
      holdingLastGood: false,
      missingCellIds: [],
    });
  });

  it('accepts fresh planner receipts across a same-roster pan without stage allocation or rebuild', async () => {
    const value = await manifest();
    const initial = plan(value, { startBp: 100_000_000, spanBp: 500_000_000 });
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    admitPlan(presenter, value, initial);
    const staged = presenter.stagePresentation(initial);
    if (staged.status !== 'staged') throw new Error('expected staged scene');
    presenter.commitStagedPresentation(staged.receipt, camera(initial));
    const before = presenter.diagnostics();

    for (let offsetBp = 1_000; offsetBp <= 20_000; offsetBp += 1_000) {
      const moved = plan(value, {
        startBp: 100_000_000 + offsetBp,
        spanBp: 500_000_000,
      });
      expect(moved).not.toBe(initial);
      expect(moved.activeSubmittedSurfaceCellIds).toEqual(initial.activeSubmittedSurfaceCellIds);
      const movedCamera = camera(moved);
      expect(
        presenter.updateCameraWithinActiveTopology({
          isoformMode: moved.isoformMode,
          laneLimit: moved.laneLimit,
          viewportStartBp: moved.viewportStartBp,
          viewportEndBp: moved.viewportEndBp,
          devicePixelRatio: DISPLAY_DPR,
          contract: movedCamera.contract,
          trackTopCssPx: movedCamera.trackTopCssPx,
          viewportCssWidthPx: movedCamera.viewportCssWidthPx,
          viewportCssHeightPx: movedCamera.viewportCssHeightPx,
          themeMode: movedCamera.themeMode,
        })
      ).toBe(true);
    }
    expect(presenter.diagnostics()).toMatchObject({
      stagedSceneBuildCount: before.stagedSceneBuildCount,
      atomicCommitCount: before.atomicCommitCount,
      meshCreationCount: before.meshCreationCount,
      shaderCreationCount: before.shaderCreationCount,
      geometryCreationCount: before.geometryCreationCount,
      broadVectorSubmissionCount: 0,
      runtimeCellCompileCount: 0,
      runtimeDurableWriteCount: 0,
    });
  });

  it('commits when every visible cell is ready even if the newly exposed far prefetch ring is absent', async () => {
    const value = await manifest();
    const presentation = plan(value, { startBp: 900_000_000 });
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    expect(presenter.reservePresentationCapacity(presentation)).toBe(true);
    for (const address of submittedAddresses(presentation)) {
      const texture = decodedTexture(value);
      expect(presenter.admitCellTexture({ ...address, texture }).status).toBe('admitted');
    }
    expect(addresses(presentation).length).toBeGreaterThan(submittedAddresses(presentation).length);

    const staged = presenter.stagePresentation(presentation);
    expect(staged.status).toBe('staged');
    if (staged.status !== 'staged') throw new Error('expected visible-only stage');
    expect(presenter.commitStagedPresentation(staged.receipt, camera(presentation))).toBe(true);
    expect(presenter.diagnostics()).toMatchObject({
      presenting: true,
      holdingLastGood: false,
      missingCellIds: [],
      broadVectorSubmissionCount: 0,
    });
  });

  it('treats transparent occupancy as complete without manufacturing fragment work', async () => {
    const value = await manifest();
    const presentation = plan(value);
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    expect(presenter.reservePresentationCapacity(presentation)).toBe(true);
    for (const address of submittedAddresses(presentation)) {
      expect(presenter.admitTransparentCell(address).status).toBe('admitted');
      expect(presenter.admitTransparentCell(address).status).toBe('already-resident');
    }
    const staged = presenter.stagePresentation(presentation);
    if (staged.status !== 'staged') throw new Error('expected transparent stage');
    presenter.hide();
    expect(presenter.commitStagedPresentation(staged.receipt, camera(presentation))).toBe(true);
    expect(presenter.diagnostics()).toMatchObject({
      presenting: true,
      residentTextureCellCount: 0,
      residentTransparentCellCount: presentation.activeSubmittedSurfaceCellIds.length,
      presentedQuads: [],
      broadVectorSubmissionCount: 0,
    });

    const address = submittedAddresses(presentation)[0];
    const conflictingTexture = decodedTexture(value);
    expect(presenter.admitCellTexture({ ...address, texture: conflictingTexture })).toMatchObject({
      status: 'rejected',
      reason: 'immutable-cell-address-conflict',
    });
  });

  it('uses Texture.EMPTY for one transparent mip source while keeping one premultiplied quad', async () => {
    const value = await manifest();
    const presentation = plan(value);
    expect(presentation.activeLevels).toHaveLength(2);
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    expect(presenter.reservePresentationCapacity(presentation)).toBe(true);
    const coarserLevel = presentation.activeLevels[1].level;
    for (const address of submittedAddresses(presentation)) {
      if (address.level === coarserLevel) {
        expect(presenter.admitTransparentCell(address).status).toBe('admitted');
      } else {
        expect(
          presenter.admitCellTexture({ ...address, texture: decodedTexture(value) }).status
        ).toBe('admitted');
      }
    }
    const staged = presenter.stagePresentation(presentation);
    if (staged.status !== 'staged') throw new Error('expected mixed occupancy stage');
    presenter.commitStagedPresentation(staged.receipt, camera(presentation));
    expect(presenter.diagnostics().presentedQuads).toHaveLength(
      presentation.activeLevels[0].visibleTilePlacements.length *
        presentation.submittedLaneSlabIds.length
    );
  });

  it('matches the exact vector lane centers for full and partial slabs', async () => {
    const value = await manifest();
    const presentation = plan(value, { laneLimit: 12 });
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    admitPlan(presenter, value, presentation);
    const staged = presenter.stagePresentation(presentation);
    if (staged.status !== 'staged') throw new Error('expected staged scene');
    presenter.commitStagedPresentation(staged.receipt, camera(presentation, { top: 24 }));
    const firstTileStart = presentation.activeLevels[0].visibleTilePlacements[0].destinationStartBp;
    const quads = presenter
      .diagnostics()
      .presentedQuads.filter(({ destinationStartBp }) => destinationStartBp === firstTileStart);
    const centerForLane = (lane: number): number => {
      const slabIndex = Math.floor(lane / value.laneSlabRowCount);
      const localLane = lane % value.laneSlabRowCount;
      const quad = quads.find(({ laneSlabIndex }) => laneSlabIndex === slabIndex);
      if (!quad) throw new Error(`missing slab ${slabIndex}`);
      const storedCenterPhysicalPx =
        localLane * value.laneRowTextureStridePx +
        (value.laneRowTextureStridePx - value.laneRowTransparentTailGutterPx) / 2;
      return (
        quad.destinationTopCssPx +
        quad.destinationHeightCssPx -
        storedCenterPhysicalPx / value.rasterDevicePixelRatio
      );
    };
    for (const lane of [0, 7, 8, 11]) {
      expect(centerForLane(lane)).toBe(24 + value.laneRowCssHeightPx / 2 - lane * 16);
    }
  });

  it('keeps residency bounded across pans and clears every resident on destroy', async () => {
    const value = await manifest();
    const first = plan(value, { startBp: 100_000_000 });
    const second = plan(value, { startBp: 1_800_000_000 });
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    admitPlan(presenter, value, first);
    admitPlan(presenter, value, second);
    const firstStage = presenter.stagePresentation(first);
    if (firstStage.status !== 'staged') throw new Error('expected first stage');
    presenter.commitStagedPresentation(firstStage.receipt, camera(first));
    const secondStage = presenter.stagePresentation(second);
    if (secondStage.status !== 'staged') throw new Error('expected second stage');
    presenter.commitStagedPresentation(secondStage.receipt, camera(second));

    const keep = new Set(second.activeSubmittedSurfaceCellIds);
    const evicted = presenter.evictCellsExcept(keep);
    expect(evicted.length).toBeGreaterThan(0);
    expect(presenter.diagnostics().residentCellIds.length).toBeLessThanOrEqual(keep.size);
    presenter.destroy();
    expect(presenter.diagnostics()).toMatchObject({
      presenting: false,
      residentTextureCellCount: 0,
      residentTransparentCellCount: 0,
    });
    presenters.pop();
  });

  it('keeps last-good raster visible until a shifted two-mip roster is complete', async () => {
    const value = await manifest();
    const initial = plan(value, { startBp: 100_000_000 });
    const shifted = plan(value, { startBp: 900_000_000 });
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    admitPlan(presenter, value, initial);
    const firstStage = presenter.stagePresentation(initial);
    if (firstStage.status !== 'staged') throw new Error('expected first stage');
    presenter.commitStagedPresentation(firstStage.receipt, camera(initial));
    const initialSubmitted = presenter.diagnostics().submittedCellIds;

    const missing = presenter.stagePresentation(shifted);
    expect(missing.status).toBe('missing-cells');
    expect(presenter.updateCamera(camera(shifted))).toBe(false);
    expect(presenter.diagnostics()).toMatchObject({
      presenting: true,
      holdingLastGood: true,
      submittedCellIds: initialSubmitted,
      broadVectorSubmissionCount: 0,
    });

    admitPlan(presenter, value, shifted);
    const secondStage = presenter.stagePresentation(shifted);
    if (secondStage.status !== 'staged') throw new Error('expected second stage');
    expect(presenter.diagnostics().submittedCellIds).toEqual(initialSubmitted);
    expect(presenter.commitStagedPresentation(secondStage.receipt, camera(shifted))).toBe(true);
    expect(presenter.diagnostics()).toMatchObject({
      presenting: true,
      holdingLastGood: false,
      submittedCellIds: shifted.activeSubmittedSurfaceCellIds,
      atomicCommitCount: 2,
    });
  });

  it('rejects mutable, physically wrong, and conflicting textures at immutable cell addresses', async () => {
    const value = await manifest();
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    const address = { isoformMode: 'expanded' as const, level: 0, tileX: 0, laneSlabIndex: 0 };
    const mutable = decodedTexture(value, { dynamic: true });
    const wrongSize = decodedTexture(value, { physicalWidth: 512 });
    const wrongUploadResolution = decodedTexture(value, {
      resolution: value.rasterDevicePixelRatio,
    });
    const first = decodedTexture(value);
    const conflict = decodedTexture(value);

    expect(presenter.admitCellTexture({ ...address, texture: mutable })).toMatchObject({
      status: 'rejected',
      reason: 'decoded-cell-texture-is-mutable',
    });
    expect(presenter.admitCellTexture({ ...address, texture: wrongSize })).toMatchObject({
      status: 'rejected',
      reason: 'decoded-cell-texture-physical-geometry-mismatch',
    });
    expect(
      presenter.admitCellTexture({ ...address, texture: wrongUploadResolution })
    ).toMatchObject({
      status: 'rejected',
      reason: 'decoded-cell-texture-physical-geometry-mismatch',
    });
    expect(presenter.admitCellTexture({ ...address, texture: first }).status).toBe('admitted');
    expect(presenter.admitCellTexture({ ...address, texture: first }).status).toBe(
      'already-resident'
    );
    expect(presenter.admitCellTexture({ ...address, texture: conflict })).toMatchObject({
      status: 'rejected',
      reason: 'immutable-cell-address-conflict',
    });
  });

  it('invalidates the active owner instead of drawing a mutated persisted cell', async () => {
    const value = await manifest();
    const presentation = plan(value);
    const presenter = new CompiledBroadSurfacePixiPresenterV2(value);
    presenters.push(presenter);
    const textures = admitPlan(presenter, value, presentation);
    const staged = presenter.stagePresentation(presentation);
    if (staged.status !== 'staged') throw new Error('expected staged scene');
    presenter.commitStagedPresentation(staged.receipt, camera(presentation));
    const activeCell = presenter.diagnostics().activeResidentCellIds[0];
    expect(presenter.diagnostics().presenting).toBe(true);

    textures.get(activeCell)?.source.update();

    expect(presenter.diagnostics()).toMatchObject({
      presenting: false,
      broadVectorSubmissionCount: 0,
      lastFailure: 'active-raster-cell-invalidated',
    });
  });
});
