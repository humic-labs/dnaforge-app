import {
  compiledBroadSurfaceCellIdV2,
  compiledBroadSurfaceHandoffSpanBpV2,
  compiledBroadSurfaceOwnsViewportV2,
  type BroadSurfaceIsoformModeV2,
  type CompiledBroadSurfaceManifestV2,
} from '../overview/bounded-annotation-broad-surface';

export const COMPILED_BROAD_GLOBAL_STANDBY_CELL_BUDGET_V2 = 128;

export const COMPILED_BROAD_INTERACTION_RUNWAY_CELL_BUDGET_V2 = 256;

export type CompiledBroadSurfaceCellDemandAddressV2 = Readonly<{
  cellId: string;
  isoformMode: BroadSurfaceIsoformModeV2;
  level: number;
  tileX: number;
  laneSlabIndex: number;
}>;

type DemandAddressBySlabCacheV2 = Array<CompiledBroadSurfaceCellDemandAddressV2 | undefined>;
type DemandAddressByTileCacheV2 = Array<DemandAddressBySlabCacheV2 | undefined>;
type DemandAddressByLevelCacheV2 = Array<DemandAddressByTileCacheV2 | undefined>;
const DEMAND_ADDRESS_CACHE_V2 = new WeakMap<
  CompiledBroadSurfaceManifestV2,
  Record<BroadSurfaceIsoformModeV2, DemandAddressByLevelCacheV2>
>();

export function compiledBroadSurfaceDemandAddress(
  manifest: CompiledBroadSurfaceManifestV2,
  isoformMode: BroadSurfaceIsoformModeV2,
  level: number,
  tileX: number,
  laneSlabIndex: number
): CompiledBroadSurfaceCellDemandAddressV2 {
  let manifestCache = DEMAND_ADDRESS_CACHE_V2.get(manifest);
  if (!manifestCache) {
    manifestCache = { canonical: [], expanded: [] };
    DEMAND_ADDRESS_CACHE_V2.set(manifest, manifestCache);
  }
  const modeCache = manifestCache[isoformMode];
  let levelCache = modeCache[level];
  if (!levelCache) {
    levelCache = [];
    modeCache[level] = levelCache;
  }
  let tileCache = levelCache[tileX];
  if (!tileCache) {
    tileCache = [];
    levelCache[tileX] = tileCache;
  }
  const cached = tileCache[laneSlabIndex];
  if (cached) return cached;
  const address = Object.freeze({
    cellId: compiledBroadSurfaceCellIdV2({
      manifest,
      isoformMode,
      level,
      tileX,
      laneSlabIndex,
    }),
    isoformMode,
    level,
    tileX,
    laneSlabIndex,
  });
  tileCache[laneSlabIndex] = address;
  return address;
}

export function compiledBroadSurfaceOwnedCellKey(
  manifestFingerprint: string,
  cellId: string
): string {
  return `${manifestFingerprint}\u0000${cellId}`;
}

export function parseCompiledBroadSurfaceTileId(value: string): {
  readonly level: number;
  readonly tileX: number;
} {
  const match = /^L(\d+):X(\d+)$/.exec(value);
  if (!match) throw new Error('compiled broad surface tile id is invalid');
  const level = Number(match[1]);
  const tileX = Number(match[2]);
  if (!Number.isSafeInteger(level) || !Number.isSafeInteger(tileX)) {
    throw new Error('compiled broad surface tile address is invalid');
  }
  return Object.freeze({ level, tileX });
}

export function compiledBroadSurfaceResidentTileXs(
  manifest: CompiledBroadSurfaceManifestV2,
  levelIndex: number,
  viewportStartBp: number,
  viewportEndBp: number
): readonly number[] {
  const level = manifest.levels[levelIndex];
  if (!level) return Object.freeze([]);
  const firstVisible = Math.max(
    0,
    Math.min(level.tileCount - 1, Math.floor(viewportStartBp / level.tileSpanBp))
  );
  const lastVisible = Math.max(
    firstVisible,
    Math.min(level.tileCount - 1, Math.ceil(viewportEndBp / level.tileSpanBp) - 1)
  );
  const firstResident = Math.max(0, firstVisible - manifest.prefetchRing);
  const lastResident = Math.min(level.tileCount - 1, lastVisible + manifest.prefetchRing);
  return Object.freeze(
    Array.from({ length: lastResident - firstResident + 1 }, (_, index) => firstResident + index)
  );
}

export type CompiledBroadSurfaceInteractionRunwayLevelV2 = Readonly<{
  level: number;
  role: 'active-motion' | 'finer-lookahead' | 'coarser-lookahead';
  tileXs: readonly number[];
}>;

export function compiledBroadSurfaceInteractionRunwayLevelsV2(input: {
  readonly manifest: CompiledBroadSurfaceManifestV2;
  readonly activeLevelIndices: readonly number[];
  readonly viewportStartBp: number;
  readonly viewportEndBp: number;
  readonly finerLookaheadLevels: number;
  readonly coarserLookaheadLevels: number;
  readonly motionHaloViewports: number;
  readonly submittedLaneSlabCount: number;
  readonly maximumCellCount?: number;
}): readonly CompiledBroadSurfaceInteractionRunwayLevelV2[] {
  const {
    manifest,
    activeLevelIndices,
    viewportStartBp,
    viewportEndBp,
    finerLookaheadLevels,
    coarserLookaheadLevels,
    motionHaloViewports,
    submittedLaneSlabCount,
    maximumCellCount = COMPILED_BROAD_INTERACTION_RUNWAY_CELL_BUDGET_V2,
  } = input;
  const viewportSpanBp = viewportEndBp - viewportStartBp;
  if (
    activeLevelIndices.length === 0 ||
    activeLevelIndices.some(
      (level) => !Number.isSafeInteger(level) || level < 0 || level >= manifest.levels.length
    ) ||
    !Number.isFinite(viewportStartBp) ||
    !Number.isFinite(viewportEndBp) ||
    viewportStartBp < 0 ||
    viewportEndBp > manifest.genomeLengthBp ||
    viewportSpanBp <= 0 ||
    !Number.isSafeInteger(finerLookaheadLevels) ||
    finerLookaheadLevels < 0 ||
    !Number.isSafeInteger(coarserLookaheadLevels) ||
    coarserLookaheadLevels < 0 ||
    !Number.isFinite(motionHaloViewports) ||
    motionHaloViewports < 0 ||
    !Number.isSafeInteger(submittedLaneSlabCount) ||
    submittedLaneSlabCount <= 0 ||
    !Number.isSafeInteger(maximumCellCount) ||
    maximumCellCount <= 0
  ) {
    throw new Error('compiled broad interaction runway is invalid');
  }
  const active = new Set(activeLevelIndices);
  const finestActiveLevel = Math.min(...activeLevelIndices);
  const result: CompiledBroadSurfaceInteractionRunwayLevelV2[] = [];
  let retainedCellCount = 0;
  const add = (
    level: number,
    role: CompiledBroadSurfaceInteractionRunwayLevelV2['role'],
    startBp: number,
    endBp: number
  ): void => {
    if (
      level < 0 ||
      level >= manifest.levels.length ||
      active.has(level) !== (role === 'active-motion')
    ) {
      return;
    }
    const tileXs = compiledBroadSurfaceResidentTileXs(manifest, level, startBp, endBp);
    const levelCellCount = tileXs.length * submittedLaneSlabCount;
    if (retainedCellCount + levelCellCount > maximumCellCount) return;
    retainedCellCount += levelCellCount;
    result.push(
      Object.freeze({
        level,
        role,
        tileXs,
      })
    );
  };

  const activeHaloBp = viewportSpanBp * motionHaloViewports;
  for (const level of activeLevelIndices) {
    add(
      level,
      'active-motion',
      Math.max(0, viewportStartBp - activeHaloBp),
      Math.min(manifest.genomeLengthBp, viewportEndBp + activeHaloBp)
    );
  }
  for (
    let level = finestActiveLevel - 1;
    level >= Math.max(0, finestActiveLevel - finerLookaheadLevels);
    level -= 1
  ) {
    add(level, 'finer-lookahead', viewportStartBp, viewportEndBp);
  }
  for (
    let level = finestActiveLevel + 1;
    level <= Math.min(manifest.levels.length - 1, finestActiveLevel + coarserLookaheadLevels);
    level += 1
  ) {
    if (active.has(level)) continue;
    const projectedSpanBp = Math.min(
      manifest.genomeLengthBp,
      viewportSpanBp * 2 ** (level - finestActiveLevel)
    );
    const anchorExpansionBp = Math.max(0, projectedSpanBp - viewportSpanBp);
    const motionHaloBp = projectedSpanBp * motionHaloViewports;
    add(
      level,
      'coarser-lookahead',
      Math.max(0, viewportStartBp - anchorExpansionBp - motionHaloBp),
      Math.min(manifest.genomeLengthBp, viewportEndBp + anchorExpansionBp + motionHaloBp)
    );
  }
  return Object.freeze(result);
}

export function compiledBroadSurfaceGlobalStandbyLevelIndicesV2(
  manifest: CompiledBroadSurfaceManifestV2,
  submittedLaneSlabCount: number,
  maximumCellCount = COMPILED_BROAD_GLOBAL_STANDBY_CELL_BUDGET_V2
): readonly number[] {
  if (
    !Number.isSafeInteger(submittedLaneSlabCount) ||
    submittedLaneSlabCount <= 0 ||
    !Number.isSafeInteger(maximumCellCount) ||
    maximumCellCount <= 0
  ) {
    throw new Error('compiled broad global standby budget is invalid');
  }
  let retainedCellCount = 0;
  let firstRetainedLevel = manifest.levels.length;
  for (let levelIndex = manifest.levels.length - 1; levelIndex >= 0; levelIndex -= 1) {
    const level = manifest.levels[levelIndex];
    if (!level || level.level !== levelIndex || !Number.isSafeInteger(level.tileCount)) {
      throw new Error('compiled broad global standby manifest levels are invalid');
    }
    const levelCellCount = level.tileCount * submittedLaneSlabCount;
    if (retainedCellCount + levelCellCount > maximumCellCount) break;
    retainedCellCount += levelCellCount;
    firstRetainedLevel = levelIndex;
  }
  return Object.freeze(
    Array.from(
      { length: manifest.levels.length - firstRetainedLevel },
      (_, offset) => firstRetainedLevel + offset
    )
  );
}

export interface CompiledBroadSurfaceZoomOutSuccessorCoverageV1 {
  readonly startBp: number;
  readonly endBp: number;
  readonly source: 'authenticated-detail-corridor' | 'camera-transition-envelope';
}

export interface CompiledBroadSurfaceZoomOutTransitionViewportV1 {
  readonly startBp: number;
  readonly endBp: number;
  readonly spanBp: number;
}

export function compiledBroadSurfaceZoomOutTransitionViewportV1(input: {
  readonly manifest: CompiledBroadSurfaceManifestV2;
  readonly viewportCssWidthPx: number;
  readonly devicePixelRatio: number;
  readonly successorCoverage: Readonly<{ startBp: number; endBp: number }>;
  readonly authenticatedDetailHandoffViewport?: Readonly<{
    startBp: number;
    endBp: number;
  }> | null;
}): CompiledBroadSurfaceZoomOutTransitionViewportV1 {
  const {
    manifest,
    viewportCssWidthPx,
    devicePixelRatio,
    successorCoverage,
    authenticatedDetailHandoffViewport,
  } = input;
  const viewportPhysicalWidthPx = viewportCssWidthPx * devicePixelRatio;
  const coverageStartBp = successorCoverage.startBp;
  const coverageEndBp = successorCoverage.endBp;
  if (
    !Number.isFinite(viewportPhysicalWidthPx) ||
    viewportPhysicalWidthPx <= 0 ||
    !Number.isSafeInteger(coverageStartBp) ||
    !Number.isSafeInteger(coverageEndBp) ||
    coverageStartBp < 0 ||
    coverageEndBp <= coverageStartBp ||
    coverageEndBp > manifest.genomeLengthBp
  ) {
    throw new Error('compiled broad transition viewport is invalid');
  }
  const spanBp = compiledBroadSurfaceHandoffSpanBpV2({
    genomeLengthBp: manifest.genomeLengthBp,
    broadCorridorFinestSpanBp: manifest.broadCorridorFinestSpanBp,
    viewportCssWidthPx,
    devicePixelRatio,
  });
  if (authenticatedDetailHandoffViewport) {
    const { startBp, endBp } = authenticatedDetailHandoffViewport;
    if (
      !Number.isSafeInteger(startBp) ||
      !Number.isSafeInteger(endBp) ||
      startBp < coverageStartBp ||
      endBp > coverageEndBp ||
      endBp <= startBp ||
      endBp - startBp < spanBp ||
      !compiledBroadSurfaceOwnsViewportV2({
        broadCorridorFinestSpanBp: manifest.broadCorridorFinestSpanBp,
        viewportSpanBp: endBp - startBp,
        viewportCssWidthPx,
        devicePixelRatio,
      })
    ) {
      throw new Error('authenticated compiled broad handoff viewport is invalid');
    }
    return Object.freeze({ startBp, endBp, spanBp: endBp - startBp });
  }
  const focusBp = (coverageStartBp + coverageEndBp) / 2;
  const startBp = Math.max(
    0,
    Math.min(manifest.genomeLengthBp - spanBp, Math.floor(focusBp - spanBp / 2))
  );
  return Object.freeze({ startBp, endBp: startBp + spanBp, spanBp });
}

export function compiledBroadSurfaceZoomOutSuccessorCoverageV1(input: {
  readonly manifest: CompiledBroadSurfaceManifestV2;
  readonly viewportStartBp: number;
  readonly viewportEndBp: number;
  readonly viewportCssWidthPx: number;
  readonly devicePixelRatio: number;
  readonly authenticatedDetailCorridorCoverage?: Readonly<{
    startBp: number;
    endBp: number;
  }> | null;
}): CompiledBroadSurfaceZoomOutSuccessorCoverageV1 {
  const {
    manifest,
    viewportStartBp,
    viewportEndBp,
    viewportCssWidthPx,
    devicePixelRatio,
    authenticatedDetailCorridorCoverage,
  } = input;
  const viewportSpanBp = viewportEndBp - viewportStartBp;
  const viewportPhysicalWidthPx = viewportCssWidthPx * devicePixelRatio;
  if (
    !Number.isFinite(viewportStartBp) ||
    !Number.isFinite(viewportEndBp) ||
    viewportStartBp < 0 ||
    viewportEndBp > manifest.genomeLengthBp ||
    viewportSpanBp <= 0 ||
    !Number.isFinite(viewportPhysicalWidthPx) ||
    viewportPhysicalWidthPx <= 0
  ) {
    throw new Error('compiled broad successor camera is invalid');
  }
  if (
    authenticatedDetailCorridorCoverage &&
    Number.isSafeInteger(authenticatedDetailCorridorCoverage.startBp) &&
    Number.isSafeInteger(authenticatedDetailCorridorCoverage.endBp) &&
    authenticatedDetailCorridorCoverage.startBp >= 0 &&
    authenticatedDetailCorridorCoverage.endBp > authenticatedDetailCorridorCoverage.startBp &&
    authenticatedDetailCorridorCoverage.endBp <= manifest.genomeLengthBp
  ) {
    return Object.freeze({
      startBp: authenticatedDetailCorridorCoverage.startBp,
      endBp: authenticatedDetailCorridorCoverage.endBp,
      source: 'authenticated-detail-corridor',
    });
  }

  const firstBroadOwnedSpanBp = Math.min(
    manifest.genomeLengthBp,
    Math.max(
      viewportSpanBp,
      (manifest.broadCorridorFinestSpanBp * viewportPhysicalWidthPx) /
        manifest.broadTilePhysicalWidthPx
    )
  );
  const anchoredExpansionBp = Math.max(0, firstBroadOwnedSpanBp - viewportSpanBp);
  return Object.freeze({
    startBp: Math.max(0, Math.floor(viewportStartBp - anchoredExpansionBp)),
    endBp: Math.min(manifest.genomeLengthBp, Math.ceil(viewportEndBp + anchoredExpansionBp)),
    source: 'camera-transition-envelope',
  });
}

export function compiledBroadSurfaceRequirementOwnsCamera(input: {
  readonly requirement: Readonly<{
    genomeLengthBp: number;
    broadCorridorFinestSpanBp: number;
  }>;
  readonly viewportStartBp: number;
  readonly viewportEndBp: number;
  readonly viewportCssWidthPx: number;
  readonly devicePixelRatio: number;
}): boolean {
  return compiledBroadSurfaceOwnsViewportV2({
    broadCorridorFinestSpanBp: input.requirement.broadCorridorFinestSpanBp,
    viewportSpanBp: input.viewportEndBp - input.viewportStartBp,
    viewportCssWidthPx: input.viewportCssWidthPx,
    devicePixelRatio: input.devicePixelRatio,
  });
}
