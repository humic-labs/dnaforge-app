import { describe, expect, it } from 'vitest';

import {
  admitCompiledBroadSurfaceManifestV2,
  buildCompiledBroadSurfaceManifestV2,
  classifyBroadSurfaceObservationV2,
  compiledBroadSurfaceCellIdV2,
  deriveBoundedAnnotationPhysicalBudgetV2,
  deriveBroadSurfaceMipSelectionV2,
  deriveBroadSurfacePresentationPlanV2,
  exactBroadSurfaceTilePlacementV2,
  selectCompiledBroadSurfaceRasterVariantV2,
  type BroadSurfacePresentationPlanV2,
} from './bounded-annotation-broad-surface';

const GENOME_LENGTH_BP = 3_088_269_832;

function manifest(
  trackId = 'mrna',
  rasterDevicePixelRatio = 2,
  maxQualifiedRasterMagnificationX = 1.75
) {
  return buildCompiledBroadSurfaceManifestV2({
    artifactKey: `bounded-annotation-artifact.v1:${trackId}`,
    trackId,
    genomeLengthBp: GENOME_LENGTH_BP,
    broadCorridorFinestSpanBp: 16_000_000,
    broadTilePhysicalWidthPx: 512,
    broadTileXGuardPhysicalPx: 1,
    prefetchRing: 1,
    maxQualifiedRasterMagnificationX,
    rasterDevicePixelRatio,
    laneSlabRowCount: 8,
    laneRowCssHeightPx: 16,
    laneRowTextureStridePx: 16 * rasterDevicePixelRatio,
    laneRowTransparentTailGutterPx: 2 * rasterDevicePixelRatio,
    laneRowCounts: { canonical: 12, expanded: 70 },
  });
}

async function readyPlan(
  input: {
    isoformMode?: 'canonical' | 'expanded';
    laneLimit?: number | null;
    viewportStartBp?: number;
    viewportEndBp?: number;
    viewportCssWidthPx?: number;
    devicePixelRatio?: number;
  } = {}
): Promise<BroadSurfacePresentationPlanV2> {
  const result = deriveBroadSurfacePresentationPlanV2({
    manifest: await manifest(),
    isoformMode: input.isoformMode ?? 'expanded',
    laneLimit: input.laneLimit === undefined ? 8 : input.laneLimit,
    viewportStartBp: input.viewportStartBp ?? 0,
    viewportEndBp: input.viewportEndBp ?? GENOME_LENGTH_BP,
    viewportCssWidthPx: input.viewportCssWidthPx ?? 1_200,
    devicePixelRatio: input.devicePixelRatio ?? 2,
  });
  expect(result.status).toBe('broad-ready');
  if (result.status !== 'broad-ready') throw new Error('expected broad-ready');
  return result;
}

function passingObservation(plan: BroadSurfacePresentationPlanV2) {
  return {
    trackId: plan.trackId,
    artifactKey: plan.artifactKey,
    manifestFingerprint: plan.manifestFingerprint,
    isoformMode: plan.isoformMode,
    laneLimit: plan.laneLimit,
    selectedLevel: plan.selectedLevel,
    nativeLevelPosition: plan.nativeLevelPosition,
    lodMix: plan.lodMix,
    activeLevelIds: plan.activeLevels.map((active) => `${active.role}:L${active.level}`),
    activeLevelSampleWeights: plan.activeLevels.map((active) => active.sampleWeight),
    activeVisibleXTileIds: plan.activeVisibleXTileIds,
    activeResidentXTileIds: plan.activeResidentXTileIds,
    activeSubmittedSurfaceCellIds: plan.activeSubmittedSurfaceCellIds,
    visibleXTileIds: plan.visibleXTileIds,
    residentXTileIds: plan.residentXTileIds,
    visibleTilePlacements: plan.visibleTilePlacements,
    submittedLaneSlabIds: plan.submittedLaneSlabIds,
    submittedSurfaceCellIds: plan.submittedSurfaceCellIds,
    tileContentPhysicalWidthPx: plan.xCrop.contentPhysicalWidthPx,
    tileXGuardPhysicalPx: plan.xCrop.guardPhysicalPx,
    tileStoredPhysicalWidthPx: plan.xCrop.storedPhysicalWidthPx,
    textureContentUStart: plan.xCrop.textureContentUStart,
    textureContentUEndExclusive: plan.xCrop.textureContentUEndExclusive,
    textureSampleUMinInclusive: plan.xCrop.textureSampleUMinInclusive,
    textureSampleUMaxInclusive: plan.xCrop.textureSampleUMaxInclusive,
    finalSlabTextureEndRowExclusivePx: plan.laneCrop.finalSlabTextureEndRowExclusivePx,
    finalSlabTextureVEndExclusive: plan.laneCrop.finalSlabTextureVEndExclusive,
    finalSlabTextureSampleVMaxInclusive: plan.laneCrop.finalSlabTextureSampleVMaxInclusive,
    physicalScissorHeightPx: plan.laneCrop.physicalScissorHeightPx,
    submittedSpriteHighWater: plan.activeSubmittedSurfaceCellIds.length,
    residentTexturePixelHighWater: plan.physicalBudget.residentTexturePixelBudget,
    fragmentPixelHighWater: plan.physicalBudget.fragmentPixelBudget,
    broadVectorInstanceHighWater: 0,
    durableWriteHighWater: 0,
  };
}

describe('bounded 2D broad annotation surface', () => {
  it('builds complete fixed-8-row canonical/expanded slab rosters with padded last slabs', async () => {
    const value = await manifest();
    expect(value.contract).toBe('compiled-broad-surface-manifest.v2');
    expect(value.levelOrderingContract).toBe('broad-surface-level-order.finest-first.v1');
    expect(value.broadCorridorFinestSpanBp).toBe(16_000_000);
    expect(value.laneSlabRowCount).toBe(8);
    expect(value.laneSlabs.canonical).toEqual([
      {
        slabId: 'canonical:slab:0',
        slabIndex: 0,
        firstLaneRow: 0,
        sourceLaneRowCount: 8,
        paddedLaneRowCount: 0,
      },
      {
        slabId: 'canonical:slab:1',
        slabIndex: 1,
        firstLaneRow: 8,
        sourceLaneRowCount: 4,
        paddedLaneRowCount: 4,
      },
    ]);
    expect(value.laneSlabs.expanded).toHaveLength(9);
    expect(value.laneSlabs.expanded[value.laneSlabs.expanded.length - 1]).toEqual({
      slabId: 'expanded:slab:8',
      slabIndex: 8,
      firstLaneRow: 64,
      sourceLaneRowCount: 6,
      paddedLaneRowCount: 2,
    });
    expect(value.manifestFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('numbers a complete dyadic pyramid finest-first and never imports the opposite slippy convention', async () => {
    const value = await manifest();
    expect(value.levels.slice(0, 4)).toEqual([
      { level: 0, tileSpanBp: 16_000_000, tileCount: 194 },
      { level: 1, tileSpanBp: 32_000_000, tileCount: 97 },
      { level: 2, tileSpanBp: 64_000_000, tileCount: 49 },
      { level: 3, tileSpanBp: 128_000_000, tileCount: 25 },
    ]);
    for (const level of value.levels) {
      expect(level.tileSpanBp).toBe(16_000_000 * 2 ** level.level);
      expect(level.tileCount).toBe(Math.ceil(GENOME_LENGTH_BP / level.tileSpanBp));
    }
    expect(value.levels.at(-1)?.tileCount).toBe(1);
  });

  it('keeps the final partial tile on its nominal dyadic destination instead of stretching it', async () => {
    const value = await manifest();
    const level = value.levels[0];
    const placement = exactBroadSurfaceTilePlacementV2({
      manifest: value,
      level: level.level,
      tileX: level.tileCount - 1,
    });
    expect(placement).toEqual({
      tileId: 'L0:X193',
      level: 0,
      tileX: 193,
      nominalStartBp: 3_088_000_000,
      nominalEndBpExclusive: 3_104_000_000,
      nominalSpanBp: 16_000_000,
      sourceStartBp: 3_088_000_000,
      sourceEndBpExclusive: GENOME_LENGTH_BP,
      sourceSpanBp: 269_832,
      destinationStartBp: 3_088_000_000,
      destinationEndBpExclusive: 3_104_000_000,
      destinationSpanBp: 16_000_000,
      isAssemblyTerminalTile: true,
    });
    expect(placement.destinationSpanBp).toBe(level.tileSpanBp);
    expect(placement.destinationSpanBp).not.toBe(placement.sourceSpanBp);
  });

  it('reuses immutable tile placements and cell ids across camera plans', async () => {
    const value = await manifest();
    const address = { manifest: value, level: 2, tileX: 7 };
    const firstPlacement = exactBroadSurfaceTilePlacementV2(address);
    const secondPlacement = exactBroadSurfaceTilePlacementV2(address);
    expect(secondPlacement).toBe(firstPlacement);

    const cell = {
      ...address,
      isoformMode: 'canonical' as const,
      laneSlabIndex: 0,
    };
    expect(compiledBroadSurfaceCellIdV2(cell)).toBe(compiledBroadSurfaceCellIdV2(cell));
  });

  it('selects exact adjacent mips with a camera-derived premultiplied mix and continuous common-level weight', async () => {
    const value = await manifest();
    const selectionAt = (nativeLevelPosition: number) => {
      const desiredNativeTileSpanBp = 16_000_000 * 2 ** nativeLevelPosition;
      return deriveBroadSurfaceMipSelectionV2({
        manifest: value,
        viewportStartBp: 0,
        viewportEndBp: desiredNativeTileSpanBp,
        viewportPhysicalWidthPx: 512,
      });
    };

    const exact = selectionAt(1);
    expect(exact).toMatchObject({
      nativeLevelPosition: 1,
      finerLevel: 1,
      coarserLevel: null,
      lodMix: 0,
    });
    expect(exact?.activeLevels).toEqual([
      expect.objectContaining({ role: 'single', level: 1, sampleWeight: 1 }),
    ]);

    const beforeQualifiedBand = selectionAt(1.1);
    expect(beforeQualifiedBand).toMatchObject({ finerLevel: 1, coarserLevel: 2, lodMix: 0 });
    expect(beforeQualifiedBand?.activeLevels).toEqual([
      expect.objectContaining({ role: 'finer', level: 1, sampleWeight: 1 }),
    ]);

    const blended = selectionAt(1.5);
    expect(blended?.activeLevels.map(({ role, level }) => ({ role, level }))).toEqual([
      { role: 'finer', level: 1 },
      { role: 'coarser', level: 2 },
    ]);
    if (!blended) throw new Error('expected blended adjacent levels');
    expect(blended?.lodMix).toBeGreaterThan(0);
    expect(blended?.lodMix).toBeLessThan(1);
    expect(blended.activeLevels[0].sampleWeight).toBe(1 - blended.lodMix);
    expect(blended.activeLevels[1].sampleWeight).toBe(blended.lodMix);
    expect(blended?.activeLevels[1].rasterMagnificationX).toBeLessThanOrEqual(
      value.maxQualifiedRasterMagnificationX
    );
    expect(blended?.activeLevels[1].rasterMagnificationX).toBeLessThan(2);

    const immediatelyBefore = selectionAt(2 - 0.000001);
    const boundary = selectionAt(2);
    const immediatelyAfter = selectionAt(2 + 0.000001);
    if (!immediatelyBefore || !boundary || !immediatelyAfter) {
      throw new Error('expected boundary-adjacent selections');
    }
    const commonLevelBeforeBoundary = immediatelyBefore.activeLevels.at(-1);
    expect(commonLevelBeforeBoundary).toMatchObject({ level: 2 });
    if (!commonLevelBeforeBoundary) throw new Error('expected common adjacent level');
    expect(commonLevelBeforeBoundary.sampleWeight).toBeGreaterThan(0.999_999_999);
    expect(boundary.activeLevels).toEqual([
      expect.objectContaining({ role: 'single', level: 2, sampleWeight: 1 }),
    ]);
    expect(immediatelyAfter.activeLevels).toEqual([
      expect.objectContaining({ role: 'finer', level: 2, sampleWeight: 1 }),
    ]);
  });

  it('keeps the compatibility resource roster level-coherent while exposing the full adjacent pair', async () => {
    const value = await manifest();
    const result = deriveBroadSurfacePresentationPlanV2({
      manifest: value,
      isoformMode: 'expanded',
      laneLimit: 8,
      viewportStartBp: 0,
      viewportEndBp: 16_000_000 * 2 ** 1.5,
      viewportCssWidthPx: 256,
      devicePixelRatio: 2,
    });
    expect(result.status).toBe('broad-ready');
    if (result.status !== 'broad-ready') throw new Error('expected broad-ready');

    expect(result.selectedLevel).toBe(1);
    expect(result.activeLevels.map(({ level }) => level)).toEqual([1, 2]);
    expect(result.visibleXTileIds.every((id) => id.startsWith('L1:'))).toBe(true);
    expect(result.residentXTileIds.every((id) => id.startsWith('L1:'))).toBe(true);
    expect(result.submittedSurfaceCellIds.every((id) => id.includes('|L1:'))).toBe(true);
    expect(result.activeVisibleXTileIds.some((id) => id.startsWith('L2:'))).toBe(true);
    expect(result.activeResidentXTileIds.some((id) => id.startsWith('L2:'))).toBe(true);
    expect(result.activeSubmittedSurfaceCellIds.some((id) => id.includes('|L2:'))).toBe(true);
  });

  it('makes full-genome All/8 exactly slab 0 and an exact X×slab cross-product', async () => {
    const plan = await readyPlan({ isoformMode: 'expanded', laneLimit: 8 });
    expect(plan.submittedLaneSlabIds).toEqual(['expanded:slab:0']);
    expect(plan.laneCrop).toMatchObject({
      visibleLaneRowCount: 8,
      finalSlabIndex: 0,
      finalSlabVisibleRowCount: 8,
      finalSlabSourceRowCount: 8,
      finalSlabPaddedRowCount: 0,
      finalSlabTextureEndRowExclusivePx: 256,
      finalSlabTextureVEndExclusive: 1,
      cssHeightPx: 128,
      projectedPhysicalHeightPx: 256,
      physicalScissorHeightPx: 256,
    });
    expect(plan.submittedSurfaceCellIds).toEqual(
      plan.visibleXTileIds.flatMap((xTileId) =>
        plan.submittedLaneSlabIds.map(
          (slabId) => `M${plan.manifestFingerprint}|DPR2|${xTileId}|${slabId}`
        )
      )
    );
    expect(plan.physicalBudget.visibleSpriteBudget).toBe(plan.activeVisibleXTileIds.length);
    expect(plan.physicalBudget.broadVectorInstanceBudget).toBe(0);
  });

  it('hash-binds the one-pixel bilinear X guard and budgets the stored 514px texture', async () => {
    const plan = await readyPlan({ laneLimit: 8 });
    expect(plan.xCrop).toEqual({
      contentPhysicalWidthPx: 512,
      guardPhysicalPx: 1,
      storedPhysicalWidthPx: 514,
      contentStartPx: 1,
      contentEndExclusivePx: 513,
      textureContentUStart: 1 / 514,
      textureContentUEndExclusive: 513 / 514,
      textureSampleUMinInclusive: 1.5 / 514,
      textureSampleUMaxInclusive: 512.5 / 514,
    });
    expect(plan.physicalBudget.trackBudgets[0]).toMatchObject({
      tileContentPhysicalWidthPx: 512,
      tileXGuardPhysicalPx: 1,
      tileStoredPhysicalWidthPx: 514,
    });
    expect(plan.physicalBudget.residentTexturePixelBudget).toBe(
      plan.activeResidentXTileIds.length * 514 * 256
    );

    const wrongGuard = classifyBroadSurfaceObservationV2(plan, {
      ...passingObservation(plan),
      tileXGuardPhysicalPx: 0,
      tileStoredPhysicalWidthPx: 512,
    });
    expect(wrongGuard.failures).toContain('x-guard-crop-mismatch');
  });

  it.each([
    { laneLimit: 8, slabCount: 1, finalRows: 8, finalIndex: 0 },
    { laneLimit: 12, slabCount: 2, finalRows: 4, finalIndex: 1 },
    { laneLimit: 24, slabCount: 3, finalRows: 8, finalIndex: 2 },
    { laneLimit: 64, slabCount: 8, finalRows: 8, finalIndex: 7 },
    { laneLimit: null, slabCount: 9, finalRows: 6, finalIndex: 8 },
  ])(
    'selects only intersecting slabs for expanded cap $laneLimit',
    async ({ laneLimit, slabCount, finalRows, finalIndex }) => {
      const plan = await readyPlan({ laneLimit });
      expect(plan.submittedLaneSlabIds).toHaveLength(slabCount);
      expect(plan.laneCrop.finalSlabIndex).toBe(finalIndex);
      expect(plan.laneCrop.finalSlabVisibleRowCount).toBe(finalRows);
      expect(plan.laneCrop.finalSlabTextureEndRowExclusivePx).toBe(finalRows * 32);
      expect(plan.submittedSurfaceCellIds).toHaveLength(plan.visibleXTileIds.length * slabCount);
    }
  );

  it('crops the padded expanded final slab at row 6 with gutter/half-texel separation', async () => {
    const plan = await readyPlan({ laneLimit: null });
    expect(plan.laneCrop).toMatchObject({
      finalSlabIndex: 8,
      finalSlabVisibleRowCount: 6,
      finalSlabSourceRowCount: 6,
      finalSlabPaddedRowCount: 2,
      finalSlabTextureEndRowExclusivePx: 192,
      finalSlabTextureHiddenRowStartPx: 192,
      finalSlabTextureVEndExclusive: 6 / 8,
      finalSlabTextureSampleVMaxInclusive: 191.5 / 256,
      finalSlabNextRowFirstTexelCenterV: 192.5 / 256,
    });
    expect(plan.laneCrop.finalSlabTextureSampleVMaxInclusive).toBeLessThan(
      plan.laneCrop.finalSlabNextRowFirstTexelCenterV
    );
  });

  it('rejects hidden, missing, and extra slab submissions', async () => {
    const plan = await readyPlan({ laneLimit: 8 });
    for (const submittedLaneSlabIds of [
      ['expanded:slab:0', 'expanded:slab:1'],
      [],
      ['expanded:slab:1'],
    ]) {
      const observed = {
        ...passingObservation(plan),
        submittedLaneSlabIds,
        submittedSurfaceCellIds: plan.visibleXTileIds.flatMap((xTileId) =>
          submittedLaneSlabIds.map((slabId) => `DPR2|${xTileId}|${slabId}`)
        ),
      };
      const result = classifyBroadSurfaceObservationV2(plan, observed);
      expect(result.status).toBe('red');
      expect(result.failures).toContain('submitted-lane-slab-set-mismatch');
    }
  });

  it('rejects partial/padded final-slab leakage', async () => {
    const plan = await readyPlan({ laneLimit: null });
    const result = classifyBroadSurfaceObservationV2(plan, {
      ...passingObservation(plan),
      finalSlabTextureEndRowExclusivePx: 256,
      finalSlabTextureVEndExclusive: 1,
      finalSlabTextureSampleVMaxInclusive: 255.5 / 256,
    });
    expect(result.status).toBe('red');
    expect(result.failures).toContain('lane-slab-crop-mismatch');
  });

  it('rejects missing/extra X×slab products even when X and slab rosters match', async () => {
    const plan = await readyPlan({ laneLimit: 24 });
    const missing = classifyBroadSurfaceObservationV2(plan, {
      ...passingObservation(plan),
      submittedSurfaceCellIds: plan.submittedSurfaceCellIds.slice(1),
    });
    const extra = classifyBroadSurfaceObservationV2(plan, {
      ...passingObservation(plan),
      submittedSurfaceCellIds: [
        ...plan.submittedSurfaceCellIds,
        `M${plan.manifestFingerprint}|DPR2|${plan.visibleXTileIds[0]}|expanded:slab:3`,
      ],
    });
    expect(missing.failures).toContain('submitted-surface-cell-set-mismatch');
    expect(extra.failures).toContain('submitted-surface-cell-set-mismatch');
  });

  it('derives exact edge-clamped X rings and their 2D sprite budget', async () => {
    for (const viewportStartBp of [0, GENOME_LENGTH_BP - 2_200_000_000]) {
      const plan = await readyPlan({
        laneLimit: 24,
        viewportStartBp,
        viewportEndBp: viewportStartBp + 2_200_000_000,
      });
      expect(plan.residentXTileIds.every((id) => !id.includes('X-'))).toBe(true);
      expect(plan.physicalBudget.visibleSpriteBudget).toBe(
        plan.activeVisibleXTileIds.length * plan.submittedLaneSlabIds.length
      );
      expect(plan.activeSubmittedSurfaceCellIds).toHaveLength(
        plan.physicalBudget.visibleSpriteBudget
      );
    }
  });

  it('rejects submitting a residency-ring tile and rejects a missing required ring tile', async () => {
    const plan = await readyPlan({
      laneLimit: 8,
      viewportStartBp: 300_000_000,
      viewportEndBp: 2_500_000_000,
    });
    const ringTileIds = plan.residentXTileIds.filter(
      (tileId) => !plan.visibleXTileIds.includes(tileId)
    );
    expect(ringTileIds.length).toBeGreaterThan(0);

    const submittedRing = classifyBroadSurfaceObservationV2(plan, {
      ...passingObservation(plan),
      submittedSurfaceCellIds: [
        ...plan.submittedSurfaceCellIds,
        `M${plan.manifestFingerprint}|DPR2|${ringTileIds[0]}|expanded:slab:0`,
      ],
    });
    expect(submittedRing.failures).toContain('submitted-surface-cell-set-mismatch');

    const missingResidentRing = classifyBroadSurfaceObservationV2(plan, {
      ...passingObservation(plan),
      residentXTileIds: plan.residentXTileIds.filter((tileId) => tileId !== ringTileIds[0]),
    });
    expect(missingResidentRing.failures).toContain('resident-x-tile-set-mismatch');
  });

  it('derives sprite, texture-pixel, fragment, and zero-vector budgets', async () => {
    const plan = await readyPlan({ laneLimit: 24 });
    expect(plan.physicalBudget).toMatchObject({
      authority: 'bounded-annotation-planning-authority.v2',
      committedVisibleBroadTrackCount: 1,
      visibleSpriteBudget: plan.activeVisibleXTileIds.length * plan.submittedLaneSlabIds.length,
      residentTexturePixelBudget:
        plan.activeResidentXTileIds.length * plan.submittedLaneSlabIds.length * 514 * 256,
      committedTrackPhysicalHeightPx: 768,
      fragmentPixelBudget: 2_400 * 768,
      broadVectorInstanceBudget: 0,
      durableWriteBudget: 0,
    });
    const overflow = classifyBroadSurfaceObservationV2(plan, {
      ...passingObservation(plan),
      submittedSpriteHighWater: plan.physicalBudget.visibleSpriteBudget + 1,
      residentTexturePixelHighWater: plan.physicalBudget.residentTexturePixelBudget + 1,
      fragmentPixelHighWater: plan.physicalBudget.fragmentPixelBudget + 1,
      broadVectorInstanceHighWater: 1,
      durableWriteHighWater: 1,
    });
    expect(overflow.failures).toEqual([
      'submitted-sprite-high-water-overflow',
      'resident-texture-pixel-high-water-overflow',
      'fragment-pixel-high-water-overflow',
      'broad-vector-instance-budget-violated',
      'durable-write-budget-violated',
    ]);
  });

  it('derives dual-mip and multi-track budgets from submitted cells and stored pixels only', async () => {
    const mrna = await manifest('mrna', 2);
    const lncrna = await manifest('lncrna', 2);
    const viewportEndBp = 16_000_000 * 2 ** 1.5;
    const budget = deriveBoundedAnnotationPhysicalBudgetV2({
      viewportCssWidthPx: 256,
      devicePixelRatio: 2,
      committedVisibleBroadTracks: [
        {
          trackId: 'mrna',
          manifest: mrna,
          isoformMode: 'expanded',
          laneLimit: 8,
          viewportStartBp: 0,
          viewportEndBp,
        },
        {
          trackId: 'lncrna',
          manifest: lncrna,
          isoformMode: 'canonical',
          laneLimit: 12,
          viewportStartBp: 0,
          viewportEndBp,
        },
      ],
    });
    expect(budget.committedVisibleBroadTrackCount).toBe(2);
    expect(budget.trackBudgets.every((track) => track.activeLevels.length === 2)).toBe(true);
    expect(budget.visibleSpriteBudget).toBe(
      budget.trackBudgets.reduce((sum, track) => sum + track.surfaceSpriteBudget, 0)
    );
    expect(budget.residentTexturePixelBudget).toBe(
      budget.trackBudgets.reduce((sum, track) => sum + track.residentTexturePixelBudget, 0)
    );
    expect(budget.committedTrackPhysicalHeightPx).toBe(256 + 384);
    expect(budget.fragmentPixelBudget).toBe(512 * (256 + 384));
    expect(budget.broadVectorInstanceBudget).toBe(0);
    expect(budget.durableWriteBudget).toBe(0);
  });

  it('keeps catalog identity camera-independent and gives camera planning zero durable writes', async () => {
    const value = await manifest();
    const left = deriveBroadSurfacePresentationPlanV2({
      manifest: value,
      isoformMode: 'expanded',
      laneLimit: 8,
      viewportStartBp: 0,
      viewportEndBp: 200_000_000,
      viewportCssWidthPx: 1_200,
      devicePixelRatio: 2,
    });
    const right = deriveBroadSurfacePresentationPlanV2({
      manifest: value,
      isoformMode: 'expanded',
      laneLimit: 24,
      viewportStartBp: 400_000_000,
      viewportEndBp: 600_000_000,
      viewportCssWidthPx: 1_200,
      devicePixelRatio: 2,
    });
    expect(left.status).toBe('broad-ready');
    expect(right.status).toBe('broad-ready');
    if (left.status !== 'broad-ready' || right.status !== 'broad-ready') {
      throw new Error('expected broad-ready plans');
    }
    expect(left.artifactKey).toBe(right.artifactKey);
    expect(left.manifestFingerprint).toBe(right.manifestFingerprint);
    expect(left.physicalBudget.durableWriteBudget).toBe(0);
    expect(right.physicalBudget.durableWriteBudget).toBe(0);
    expect(
      compiledBroadSurfaceCellIdV2({
        manifest: value,
        isoformMode: 'expanded',
        level: 0,
        tileX: 3,
        laneSlabIndex: 0,
      })
    ).toBe(`M${value.manifestFingerprint}|DPR2|L0:X3|expanded:slab:0`);

    const writeAttempt = classifyBroadSurfaceObservationV2(left, {
      ...passingObservation(left),
      durableWriteHighWater: 1,
    });
    expect(writeAttempt.failures).toContain('durable-write-budget-violated');
  });

  it('rejects non-adjacent/time-mutated mip state and stretched terminal placement observations', async () => {
    const plan = await readyPlan();
    const wrongMip = classifyBroadSurfaceObservationV2(plan, {
      ...passingObservation(plan),
      lodMix: Math.min(1, plan.lodMix + 0.1),
      activeLevelIds: plan.activeLevels.map((active, index) =>
        index === plan.activeLevels.length - 1
          ? `${active.role}:L${active.level + 1}`
          : `${active.role}:L${active.level}`
      ),
    });
    expect(wrongMip.failures).toContain('adjacent-mip-selection-mismatch');

    const terminalIndex = plan.visibleTilePlacements.findIndex(
      (placement) => placement.isAssemblyTerminalTile
    );
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    const stretchedPlacements = plan.visibleTilePlacements.map((placement, index) =>
      index === terminalIndex
        ? {
            ...placement,
            destinationEndBpExclusive: placement.sourceEndBpExclusive,
            destinationSpanBp: placement.sourceSpanBp,
          }
        : placement
    );
    const stretched = classifyBroadSurfaceObservationV2(plan, {
      ...passingObservation(plan),
      visibleTilePlacements: stretchedPlacements,
    });
    expect(stretched.failures).toContain('nominal-tile-placement-mismatch');
  });

  it('rejects a presentation owner mismatch', async () => {
    const plan = await readyPlan();
    const result = classifyBroadSurfaceObservationV2(plan, {
      ...passingObservation(plan),
      trackId: 'lncrna',
    });
    expect(result.failures).toContain('presentation-owner-mismatch');
  });

  it('cryptographically admits exact persisted 2D manifests and rejects level-order mixing', async () => {
    const original = await manifest();
    const persisted = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    const admitted = await admitCompiledBroadSurfaceManifestV2(persisted);
    expect(admitted).not.toBe(original);
    expect(Object.isFrozen(admitted.laneSlabs.expanded)).toBe(true);

    await expect(
      admitCompiledBroadSurfaceManifestV2({
        ...persisted,
        levelOrderingContract: 'broad-surface-level-order.root-first.v1',
      })
    ).rejects.toThrow('level ordering');
    await expect(
      admitCompiledBroadSurfaceManifestV2({
        ...persisted,
        mipBlendContract: 'broad-surface-time-animated-fade.v1',
      })
    ).rejects.toThrow('manifest contract');
    await expect(
      admitCompiledBroadSurfaceManifestV2({
        ...persisted,
        levels: [...(persisted.levels as unknown[])].reverse(),
      })
    ).rejects.toThrow('pyramid');
    await expect(
      admitCompiledBroadSurfaceManifestV2({
        ...persisted,
        broadTileXGuardPhysicalPx: 2,
      })
    ).rejects.toThrow('pinned physical geometry');
    await expect(
      admitCompiledBroadSurfaceManifestV2({
        ...persisted,
        laneRowCssHeightPx: 32,
      })
    ).rejects.toThrow('pinned physical geometry');
    await expect(
      admitCompiledBroadSurfaceManifestV2({
        ...persisted,
        prefetchRing: 2,
      })
    ).rejects.toThrow('pinned physical geometry');
    await expect(
      admitCompiledBroadSurfaceManifestV2({
        ...persisted,
        rasterDevicePixelRatio: 4,
        laneRowTextureStridePx: 64,
        laneRowTransparentTailGutterPx: 8,
      })
    ).rejects.toThrow('pinned physical geometry');
    await expect(manifest('mrna', 2, 1)).rejects.toThrow('greater than 1 and less than 2');
    await expect(manifest('mrna', 2, 2)).rejects.toThrow('greater than 1 and less than 2');

    const laneSlabs = persisted.laneSlabs as {
      canonical: unknown[];
      expanded: Array<Record<string, unknown>>;
    };
    await expect(
      admitCompiledBroadSurfaceManifestV2({
        ...persisted,
        laneSlabs: {
          ...laneSlabs,
          expanded: laneSlabs.expanded.slice(0, -1),
        },
      })
    ).rejects.toThrow('roster is incomplete');
    await expect(
      admitCompiledBroadSurfaceManifestV2({
        ...persisted,
        laneSlabs: {
          ...laneSlabs,
          expanded: laneSlabs.expanded.map((slab, index, all) =>
            index === all.length - 1 ? { ...slab, paddedLaneRowCount: 0 } : slab
          ),
        },
      })
    ).rejects.toThrow('roster is invalid');
  });

  it('yields detail-required below the finite broad-corridor finest span', async () => {
    const result = deriveBroadSurfacePresentationPlanV2({
      manifest: await manifest(),
      isoformMode: 'expanded',
      laneLimit: 8,
      viewportStartBp: 0,
      viewportEndBp: 50_000_000,
      viewportCssWidthPx: 1_200,
      devicePixelRatio: 2,
    });
    expect(result).toMatchObject({
      status: 'detail-required',
      broadCorridorFinestSpanBp: 16_000_000,
    });
    expect(result).not.toHaveProperty('selectedLevel');
  });

  it.each([1, 1.25, 1.5, 2])(
    'uses a 2x bank without magnification on display DPR %s',
    async (devicePixelRatio) => {
      const result = deriveBroadSurfacePresentationPlanV2({
        manifest: await manifest('mrna', 2),
        isoformMode: 'expanded',
        laneLimit: 8,
        viewportStartBp: 0,
        viewportEndBp: GENOME_LENGTH_BP,
        viewportCssWidthPx: 1_200,
        devicePixelRatio,
      });
      expect(result.status).toBe('broad-ready');
      if (result.status !== 'broad-ready') throw new Error('expected broad-ready');
      expect(result.laneCrop).toMatchObject({
        rasterDevicePixelRatio: 2,
        displayDevicePixelRatio: devicePixelRatio,
        textureToDisplayScale: devicePixelRatio / 2,
        cssHeightPx: 128,
        projectedPhysicalHeightPx: 128 * devicePixelRatio,
      });
      expect(result.laneCrop.textureToDisplayScale).toBeLessThanOrEqual(1);
    }
  );

  it('requires a denser bank instead of magnifying a 2x bank onto a 3x display', async () => {
    const result = deriveBroadSurfacePresentationPlanV2({
      manifest: await manifest('mrna', 2),
      isoformMode: 'expanded',
      laneLimit: 8,
      viewportStartBp: 0,
      viewportEndBp: GENOME_LENGTH_BP,
      viewportCssWidthPx: 1_200,
      devicePixelRatio: 3,
    });
    expect(result).toEqual(
      expect.objectContaining({
        status: 'broad-artifact-required',
        reason: 'insufficient-raster-device-pixel-ratio',
        manifestRasterDevicePixelRatio: 2,
        requestedRasterDevicePixelRatio: 3,
      })
    );
    expect(result).not.toHaveProperty('selectedLevel');
  });

  it('selects the smallest adequate immutable 1x/2x/3x raster variant', async () => {
    const variants = await Promise.all([
      manifest('mrna', 1),
      manifest('mrna', 2),
      manifest('mrna', 3),
    ]);
    for (const [devicePixelRatio, expectedRasterScale] of [
      [1, 1],
      [1.25, 2],
      [1.5, 2],
      [2, 2],
      [2.5, 3],
      [3, 3],
    ] as const) {
      expect(
        selectCompiledBroadSurfaceRasterVariantV2({ manifests: variants, devicePixelRatio })
          ?.rasterDevicePixelRatio
      ).toBe(expectedRasterScale);
    }
    expect(
      selectCompiledBroadSurfaceRasterVariantV2({ manifests: variants, devicePixelRatio: 3.1 })
    ).toBeNull();
    const otherTrack = await manifest('lncrna', 2);
    expect(() =>
      selectCompiledBroadSurfaceRasterVariantV2({
        manifests: [variants[0], otherTrack],
        devicePixelRatio: 1,
      })
    ).toThrow('one logical surface');
  });
});
