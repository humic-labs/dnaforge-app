import {
  compiledBroadSurfaceDemandAddress,
  compiledBroadSurfaceGlobalStandbyLevelIndicesV2,
  compiledBroadSurfaceInteractionRunwayLevelsV2,
  compiledBroadSurfaceResidentTileXs,
  parseCompiledBroadSurfaceTileId,
} from './annotation-compiled-broad-address';
import { deriveBroadSurfaceMipSelectionV2 } from '../overview/bounded-annotation-broad-surface';
import type {
  BroadSurfaceIsoformModeV2,
  CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';
import type { CompiledBroadSurfaceCellDemandAddressV2 } from './annotation-compiled-broad-address';
import { CompiledBroadDemandCellBank } from './indexed-compiled-broad-demand-cells';

export const COMPILED_BROAD_CRITICAL_COARSER_LOOKAHEAD_LEVELS = 3;
export const COMPILED_BROAD_ACTIVE_LEVEL_MOTION_HALO_VIEWPORTS = 2;

export function collectCompiledBroadReadyDemandCells(input: {
  manifest: CompiledBroadSurfaceManifestV2;
  plan: {
    isoformMode: BroadSurfaceIsoformModeV2;
    submittedLaneSlabIds: readonly unknown[];
    activeLevels: ReadonlyArray<{
      level: number;
      visibleTilePlacements: ReadonlyArray<{ tileX: number }>;
      residentXTileIds: readonly string[];
    }>;
  };
  camera: {
    viewportStartBp: number;
    viewportEndBp: number;
    viewportCssWidthPx: number;
    devicePixelRatio: number;
  };
}): CompiledBroadDemandCellBank<CompiledBroadSurfaceCellDemandAddressV2> {
  const { manifest, plan, camera } = input;
  const demandCells = new CompiledBroadDemandCellBank<CompiledBroadSurfaceCellDemandAddressV2>();
  const add = (
    target: 'required' | 'successor' | 'interactionPrefetch' | 'prefetch',
    level: number,
    tileX: number,
    laneSlabIndex: number
  ): void => {
    const address = compiledBroadSurfaceDemandAddress(
      manifest,
      plan.isoformMode,
      level,
      tileX,
      laneSlabIndex
    );
    if (target === 'required') demandCells.addRequired(address);
    else if (target === 'successor') demandCells.addSuccessor(address);
    else if (target === 'interactionPrefetch') demandCells.addInteractionPrefetch(address);
    else demandCells.addPrefetch(address);
  };
  for (const active of plan.activeLevels) {
    for (const placement of active.visibleTilePlacements) {
      for (let slab = 0; slab < plan.submittedLaneSlabIds.length; slab += 1) {
        add('required', active.level, placement.tileX, slab);
      }
    }
  }
  for (const active of plan.activeLevels) {
    for (const tileId of active.residentXTileIds) {
      const { level, tileX } = parseCompiledBroadSurfaceTileId(tileId);
      for (let slab = 0; slab < plan.submittedLaneSlabIds.length; slab += 1) {
        add('successor', level, tileX, slab);
      }
    }
  }
  const viewportSpanBp = Math.max(1, camera.viewportEndBp - camera.viewportStartBp);
  for (const active of plan.activeLevels) {
    for (const tileX of compiledBroadSurfaceResidentTileXs(
      manifest,
      active.level,
      camera.viewportStartBp - viewportSpanBp * COMPILED_BROAD_ACTIVE_LEVEL_MOTION_HALO_VIEWPORTS,
      camera.viewportEndBp + viewportSpanBp * COMPILED_BROAD_ACTIVE_LEVEL_MOTION_HALO_VIEWPORTS
    )) {
      for (let slab = 0; slab < plan.submittedLaneSlabIds.length; slab += 1) {
        add('successor', active.level, tileX, slab);
      }
    }
  }
  const selection = deriveBroadSurfaceMipSelectionV2({
    manifest,
    viewportStartBp: camera.viewportStartBp,
    viewportEndBp: camera.viewportEndBp,
    viewportPhysicalWidthPx: camera.viewportCssWidthPx * camera.devicePixelRatio,
  });
  if (selection) {
    const activeLevels = new Set(selection.activeLevels.map(({ level }) => level));
    const adjacentCandidates = new Set<number>();
    const lower = Math.floor(selection.nativeLevelPosition);
    const upper = Math.ceil(selection.nativeLevelPosition);
    adjacentCandidates.add(lower);
    adjacentCandidates.add(upper);
    adjacentCandidates.add(lower - 1);
    adjacentCandidates.add(upper + 1);
    for (const level of adjacentCandidates) {
      if (level < 0 || level >= manifest.levels.length || activeLevels.has(level)) continue;
      for (const tileX of compiledBroadSurfaceResidentTileXs(
        manifest,
        level,
        camera.viewportStartBp,
        camera.viewportEndBp
      )) {
        for (let slab = 0; slab < plan.submittedLaneSlabIds.length; slab += 1) {
          add('successor', level, tileX, slab);
        }
      }
    }
    const activeLevelIndices = selection.activeLevels.map(({ level }) => level);
    const finestActiveLevel = Math.min(...activeLevelIndices);
    for (const runway of compiledBroadSurfaceInteractionRunwayLevelsV2({
      manifest,
      activeLevelIndices,
      viewportStartBp: camera.viewportStartBp,
      viewportEndBp: camera.viewportEndBp,
      finerLookaheadLevels: manifest.levels.length,
      coarserLookaheadLevels: COMPILED_BROAD_CRITICAL_COARSER_LOOKAHEAD_LEVELS,
      motionHaloViewports: COMPILED_BROAD_ACTIVE_LEVEL_MOTION_HALO_VIEWPORTS,
      submittedLaneSlabCount: plan.submittedLaneSlabIds.length,
    })) {
      for (const tileX of runway.tileXs) {
        for (let slab = 0; slab < plan.submittedLaneSlabIds.length; slab += 1) {
          add('interactionPrefetch', runway.level, tileX, slab);
        }
      }
    }
    for (let level = finestActiveLevel + 1; level < manifest.levels.length; level += 1) {
      for (let tileX = 0; tileX < manifest.levels[level]!.tileCount; tileX += 1) {
        for (let slab = 0; slab < plan.submittedLaneSlabIds.length; slab += 1) {
          add('prefetch', level, tileX, slab);
        }
      }
    }
  }
  for (const level of compiledBroadSurfaceGlobalStandbyLevelIndicesV2(
    manifest,
    plan.submittedLaneSlabIds.length
  )) {
    for (let tileX = 0; tileX < manifest.levels[level]!.tileCount; tileX += 1) {
      for (let slab = 0; slab < plan.submittedLaneSlabIds.length; slab += 1) {
        add('interactionPrefetch', level, tileX, slab);
      }
    }
  }
  return demandCells;
}
