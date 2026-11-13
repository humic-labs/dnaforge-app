import {
  compiledBroadSurfaceDemandAddress,
  compiledBroadSurfaceGlobalStandbyLevelIndicesV2,
  compiledBroadSurfaceInteractionRunwayLevelsV2,
  compiledBroadSurfaceResidentTileXs,
  compiledBroadSurfaceZoomOutSuccessorCoverageV1,
  compiledBroadSurfaceZoomOutTransitionViewportV1,
  type CompiledBroadSurfaceCellDemandAddressV2,
} from './annotation-compiled-broad-address';
import {
  deriveBroadSurfacePresentationPlanV2,
  exactLaneSlabCropV2,
  type BroadSurfaceIsoformModeV2,
  type CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';
import {
  COMPILED_BROAD_ACTIVE_LEVEL_MOTION_HALO_VIEWPORTS,
  COMPILED_BROAD_CRITICAL_COARSER_LOOKAHEAD_LEVELS,
} from './indexed-compiled-broad-demand-collect';

export type CompiledBroadDetailHandoffResult =
  | { status: 'skipped' }
  | { status: 'rejected' }
  | {
      status: 'ok';
      handoffById: Map<string, CompiledBroadSurfaceCellDemandAddressV2>;
      interactionPrefetchById: Map<string, CompiledBroadSurfaceCellDemandAddressV2>;
    };

export function collectCompiledBroadDetailHandoffCells(input: {
  detail:
    | {
        coverageStartBp?: number;
        coverageEndBp?: number;
        handoffStartBp?: number;
        handoffEndBp?: number;
      }
    | null
    | undefined;
  planStatus: string;
  ownsViewport: boolean;
  manifest: CompiledBroadSurfaceManifestV2;
  planIsoformMode: BroadSurfaceIsoformModeV2;
  resolvedPolicy: { isoformMode: BroadSurfaceIsoformModeV2; laneLimit: number | null };
  camera: {
    viewportStartBp: number;
    viewportEndBp: number;
    viewportCssWidthPx: number;
    devicePixelRatio: number;
  };
}): CompiledBroadDetailHandoffResult {
  if (input.planStatus !== 'detail-required' || !input.ownsViewport) {
    return { status: 'skipped' };
  }
  const { manifest, camera, detail, resolvedPolicy } = input;
  const handoffById = new Map<string, CompiledBroadSurfaceCellDemandAddressV2>();
  const interactionPrefetchById = new Map<string, CompiledBroadSurfaceCellDemandAddressV2>();
  try {
    const laneCrop = exactLaneSlabCropV2({
      manifest,
      isoformMode: resolvedPolicy.isoformMode,
      laneLimit: resolvedPolicy.laneLimit,
      devicePixelRatio: camera.devicePixelRatio,
    });
    const coverage = compiledBroadSurfaceZoomOutSuccessorCoverageV1({
      manifest,
      ...camera,
      authenticatedDetailCorridorCoverage:
        typeof detail?.coverageStartBp === 'number' && typeof detail.coverageEndBp === 'number'
          ? { startBp: detail.coverageStartBp, endBp: detail.coverageEndBp }
          : null,
    });
    const transitionViewport = compiledBroadSurfaceZoomOutTransitionViewportV1({
      manifest,
      viewportCssWidthPx: camera.viewportCssWidthPx,
      devicePixelRatio: camera.devicePixelRatio,
      successorCoverage: coverage,
      authenticatedDetailHandoffViewport:
        typeof detail?.handoffStartBp === 'number' && typeof detail.handoffEndBp === 'number'
          ? { startBp: detail.handoffStartBp, endBp: detail.handoffEndBp }
          : null,
    });
    const transitionPlan = deriveBroadSurfacePresentationPlanV2({
      manifest,
      isoformMode: resolvedPolicy.isoformMode,
      laneLimit: resolvedPolicy.laneLimit,
      viewportStartBp: transitionViewport.startBp,
      viewportEndBp: transitionViewport.endBp,
      viewportCssWidthPx: camera.viewportCssWidthPx,
      devicePixelRatio: camera.devicePixelRatio,
    });
    if (transitionPlan.status !== 'broad-ready') return { status: 'rejected' };
    for (const active of transitionPlan.activeLevels) {
      for (const placement of active.visibleTilePlacements) {
        for (let slab = 0; slab < laneCrop.submittedLaneSlabIds.length; slab += 1) {
          const address = compiledBroadSurfaceDemandAddress(
            manifest,
            transitionPlan.isoformMode,
            active.level,
            placement.tileX,
            slab
          );
          handoffById.set(address.cellId, address);
        }
      }
    }
    for (const level of manifest.levels) {
      for (const tileX of compiledBroadSurfaceResidentTileXs(
        manifest,
        level.level,
        coverage.startBp,
        coverage.endBp
      )) {
        for (let slab = 0; slab < laneCrop.submittedLaneSlabIds.length; slab += 1) {
          const address = compiledBroadSurfaceDemandAddress(
            manifest,
            input.planIsoformMode,
            level.level,
            tileX,
            slab
          );
          handoffById.set(address.cellId, address);
        }
      }
    }
    for (const runway of compiledBroadSurfaceInteractionRunwayLevelsV2({
      manifest,
      activeLevelIndices: transitionPlan.activeLevels.map(({ level }) => level),
      viewportStartBp: transitionViewport.startBp,
      viewportEndBp: transitionViewport.endBp,
      finerLookaheadLevels: manifest.levels.length,
      coarserLookaheadLevels: COMPILED_BROAD_CRITICAL_COARSER_LOOKAHEAD_LEVELS,
      motionHaloViewports: COMPILED_BROAD_ACTIVE_LEVEL_MOTION_HALO_VIEWPORTS,
      submittedLaneSlabCount: laneCrop.submittedLaneSlabIds.length,
    })) {
      for (const tileX of runway.tileXs) {
        for (let slab = 0; slab < laneCrop.submittedLaneSlabIds.length; slab += 1) {
          const address = compiledBroadSurfaceDemandAddress(
            manifest,
            transitionPlan.isoformMode,
            runway.level,
            tileX,
            slab
          );
          if (!handoffById.has(address.cellId)) {
            interactionPrefetchById.set(address.cellId, address);
          }
        }
      }
    }
    for (const level of compiledBroadSurfaceGlobalStandbyLevelIndicesV2(
      manifest,
      laneCrop.submittedLaneSlabIds.length
    )) {
      for (let tileX = 0; tileX < manifest.levels[level]!.tileCount; tileX += 1) {
        for (let slab = 0; slab < laneCrop.submittedLaneSlabIds.length; slab += 1) {
          const address = compiledBroadSurfaceDemandAddress(
            manifest,
            transitionPlan.isoformMode,
            level,
            tileX,
            slab
          );
          if (!handoffById.has(address.cellId)) {
            interactionPrefetchById.set(address.cellId, address);
          }
        }
      }
    }
  } catch {
    return { status: 'rejected' };
  }
  return { status: 'ok', handoffById, interactionPrefetchById };
}
