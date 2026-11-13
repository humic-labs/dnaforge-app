import type { Assembly } from '../assembly';
import {
  pickLevel,
  PREFETCH_MARGIN_TILES,
  shouldPrefetchCoarser,
  shouldPrefetchFiner,
  visibleTiles,
  maxLevelForAssembly,
  type Viewport,
} from './lod';
import { tileSpanBp } from './constants';
import { TileCache, type TileEntry } from './tile-cache';
import {
  levelInRange,
  tileKeyString,
  type TileSource,
  type TileKey,
  type TileData,
} from './tile-source';
import type { TileFetchPurpose, TileTransportPriority } from './sources/tile-transport';
import { maxReadAlignmentLevel } from './sources/tile-sources';

export interface CoordinatorOptions {
  assembly: Assembly;
  sources: TileSource[];
  cache: TileCache;
  onTileReady?: (key: TileKey) => void;
  onTileError?: (key: TileKey, reason: string, retryable: boolean) => void;
  canFetchSource?: (sourceId: string) => boolean;
}

export class TileCoordinator {
  private readonly assembly: Assembly;
  private readonly sources: TileSource[];
  private readonly cache: TileCache;
  private readonly maxLevel: number;
  private readonly onTileReady?: (key: TileKey) => void;
  private readonly onTileError?: (key: TileKey, reason: string, retryable: boolean) => void;
  private readonly canFetchSource?: (sourceId: string) => boolean;

  private currentEpoch = 0;
  private lastLevel: number | null = null;
  private lastViewCenterBp: number | null = null;
  private readonly controllers = new Map<string, AbortController>();

  constructor(opts: CoordinatorOptions) {
    this.assembly = opts.assembly;
    this.sources = opts.sources;
    this.cache = opts.cache;
    this.maxLevel = maxLevelForAssembly(opts.assembly);
    this.onTileReady = opts.onTileReady;
    this.onTileError = opts.onTileError;
    this.canFetchSource = opts.canFetchSource;
  }

  get epoch(): number {
    return this.currentEpoch;
  }
  get level(): number | null {
    return this.lastLevel;
  }
  get inFlight(): number {
    return this.controllers.size;
  }

  cancelPendingWhere(predicate: (entry: TileEntry) => boolean): number {
    return this.cache.cancelPendingWhere((entry) => {
      if (!predicate(entry)) return false;
      this.controllers.delete(tileKeyString(entry.key));
      return true;
    });
  }

  setViewport(view: Viewport): void {
    const L = pickLevel(view, this.maxLevel, this.lastLevel);
    this.lastLevel = L;
    this.currentEpoch++;

    const viewCenterBp = (view.globalStart + view.globalEnd) / 2;
    const panDeltaBp = this.lastViewCenterBp == null ? 0 : viewCenterBp - this.lastViewCenterBp;
    this.lastViewCenterBp = viewCenterBp;

    const visibleKeys = new Set<string>();

    for (const source of this.sources) {
      if (this.canFetchSource?.(source.id) === false) continue;
      for (const plan of fetchPlansForSource(source, view, L, this.maxLevel, panDeltaBp)) {
        const { level, view: fetchView, marginTiles, purpose } = plan;
        if (!levelInRange(source, level)) continue;
        for (const t of visibleTiles(fetchView, level, this.assembly, marginTiles)) {
          const key: TileKey = { sourceId: source.id, level, index: t.index };
          const ks = tileKeyString(key);
          visibleKeys.add(ks);
          const priority: TileTransportPriority = {
            purpose,
            epoch: this.currentEpoch,
            core: t.core && (purpose === 'current' || plan.promoteCore),
            marginDistanceTiles: t.marginDistanceTiles,
          };
          const existing = this.cache.peek(key);
          if (existing) {
            if (existing.state === 'ready') {
              this.cache.get(key);
              continue;
            }
            if (existing.state === 'pending') {
              updatePendingTilePriority(
                existing.priority,
                priority,
                source.id.startsWith('aln:') &&
                  source.prefetch?.sameLevelMarginTiles === 1 &&
                  level === L &&
                  L <= maxReadAlignmentLevel()
              );
              continue;
            }
          }
          const ac = new AbortController();
          this.controllers.set(ks, ac);
          this.cache.set({
            key,
            state: 'pending',
            epoch: this.currentEpoch,
            byteSize: 0,
            abort: ac,
            priority,
          });
          const stampedEpoch = this.currentEpoch;
          source
            .fetchTile(level, t.index, t.segments, ac.signal, {
              priority,
            })
            .then((data) => this.onResolve(key, stampedEpoch, ac, data))
            .catch((err) => this.onReject(key, stampedEpoch, ac, err));
        }
      }
    }

    for (const entry of this.cache.entries()) {
      const ks = tileKeyString(entry.key);
      if (visibleKeys.has(ks)) continue;
      if (this.cache.isPinned(entry.key)) continue;
      if (this.cache.isRetained(entry.key)) continue;
      this.controllers.delete(ks);
      this.cache.evict(entry.key);
    }
  }

  private onResolve(
    key: TileKey,
    stampedEpoch: number,
    controller: AbortController,
    data: TileData
  ): void {
    const ks = tileKeyString(key);
    if (this.controllers.get(ks) === controller) this.controllers.delete(ks);
    const entry = this.cache.peek(key);
    if (!entry || entry.epoch !== stampedEpoch) return;
    if (data.state === 'error') {
      this.cache.resolve(key, data);
      this.onTileError?.(key, data.errorReason ?? 'error', data.errorRetryable !== false);
      return;
    }
    this.cache.resolve(key, data);
    this.onTileReady?.(key);
  }

  private onReject(
    key: TileKey,
    stampedEpoch: number,
    controller: AbortController,
    err: unknown
  ): void {
    const ks = tileKeyString(key);
    const name = (err as { name?: string } | undefined)?.name;
    if (this.controllers.get(ks) === controller) this.controllers.delete(ks);
    if (name === 'AbortError' && controller.signal.aborted) {
      return;
    }
    const entry = this.cache.peek(key);
    if (!entry || entry.epoch !== stampedEpoch) return;
    entry.state = 'error';
    entry.abort = undefined;
    entry.priority = undefined;
    this.onTileError?.(key, 'fetch-failed', true);
  }
}

function updatePendingTilePriority(
  target: TileTransportPriority | undefined,
  next: TileTransportPriority,
  preserveCurrentReadCollar = false
): void {
  if (!target) return;
  if (next.epoch < target.epoch) return;
  if (
    preserveCurrentReadCollar &&
    next.epoch === target.epoch &&
    target.purpose === 'current' &&
    target.marginDistanceTiles === 1 &&
    next.purpose !== 'current'
  ) {
    return;
  }
  if (next.epoch === target.epoch && !tilePriorityIsStronger(next, target)) return;
  target.purpose = next.purpose;
  target.epoch = next.epoch;
  target.core = next.core;
  target.marginDistanceTiles = next.marginDistanceTiles;
}

function tilePriorityIsStronger(
  next: TileTransportPriority,
  current: TileTransportPriority
): boolean {
  const purposeRank = (purpose: TileFetchPurpose): number => {
    if (purpose === 'current') return 0;
    if (purpose === 'pan-lead') return 1;
    if (purpose === 'adjacent-finer') return 2;
    if (purpose === 'critical-handoff') return 3;
    if (purpose === 'coarser') return 4;
    return 5;
  };
  if (next.core !== current.core) return next.core;
  const nextPurposeRank = purposeRank(next.purpose);
  const currentPurposeRank = purposeRank(current.purpose);
  if (nextPurposeRank !== currentPurposeRank) return nextPurposeRank < currentPurposeRank;
  return next.marginDistanceTiles < current.marginDistanceTiles;
}

type FetchPlan = {
  level: number;
  view: Viewport;
  marginTiles: number;
  purpose: TileFetchPurpose;
  promoteCore: boolean;
};

type CriticalFinerHandoff = {
  level: number;
  prefetchLevels: number;
  minCurrentLevel: number;
  maxCurrentLevel: number;
  lookaheadWindowBp?: number;
};

const CRITICAL_HANDOFF_ADJACENT_DESCENT_LEVELS = 3;
const COVERAGE_WORKING_SET_MARGIN = 6;
const COVERAGE_FLOOR_FETCH_DEPTH = 2;
const COVERAGE_PAN_LEAD_COMMITS = 8;
const COVERAGE_MAX_LEAD_TILES = 16;
const ALIGNMENT_PAN_LEAD_COMMITS = 16;
const ALIGNMENT_MAX_LEAD_TILES = 8;

function fetchPlansForSource(
  source: TileSource,
  view: Viewport,
  currentLevel: number,
  maxLevel: number,
  panDeltaBp = 0
): FetchPlan[] {
  const out: FetchPlan[] = [];
  const seen = new Set<string>();
  const sameLevelMarginTiles = sameLevelMarginTilesForLevel(source, currentLevel);
  const add = (
    level: number,
    fetchView = view,
    marginTiles = PREFETCH_MARGIN_TILES,
    purpose: TileFetchPurpose = 'unknown',
    dedupeKey = String(level),
    promoteCore = false
  ): void => {
    if (level < 0 || level > maxLevel || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    out.push({
      level,
      view: fetchView,
      marginTiles,
      purpose,
      promoteCore,
    });
  };

  add(currentLevel, view, 0, 'current', `current-core:${currentLevel}`);

  const isCoverageSource = source.id.startsWith('cov:') || source.id.startsWith('covasm:');
  const coverageWorkingSetMargin = Math.max(
    0,
    Math.floor(source.prefetch?.coverageWorkingSetMarginTiles ?? COVERAGE_WORKING_SET_MARGIN)
  );
  const criticalHandoffs = criticalFinerHandoffsForSource(source, maxLevel);
  const activeCriticalHandoffs = criticalHandoffs.filter(
    (handoff) =>
      currentLevel > handoff.level &&
      currentLevel >= handoff.minCurrentLevel &&
      currentLevel <= handoff.maxCurrentLevel
  );
  if (isCoverageSource && currentLevel >= 1) {
    const coarsestFloorLevel = currentLevel - 1;
    const readDensityHandoffActive = activeCriticalHandoffs.some((handoff) => handoff.level <= 3);
    const floorFetchDepth = readDensityHandoffActive ? 1 : COVERAGE_FLOOR_FETCH_DEPTH;
    const lowestFloorLevel = Math.max(0, currentLevel - floorFetchDepth);
    const leadBp = Math.min(
      Math.abs(panDeltaBp) * COVERAGE_PAN_LEAD_COMMITS,
      tileSpanBp(coarsestFloorLevel) * COVERAGE_MAX_LEAD_TILES
    );
    const workingView: Viewport =
      leadBp > 0 && panDeltaBp !== 0
        ? {
            ...view,
            globalStart: view.globalStart - (panDeltaBp < 0 ? leadBp : 0),
            globalEnd: view.globalEnd + (panDeltaBp > 0 ? leadBp : 0),
          }
        : view;
    for (let floorLevel = coarsestFloorLevel; floorLevel >= lowestFloorLevel; floorLevel--) {
      add(
        floorLevel,
        workingView,
        coverageWorkingSetMargin,
        'current',
        `coverage-working-set:${floorLevel}`
      );
    }
  }

  const primaryCriticalFinerLevel = source.prefetch?.criticalFinerLevel;
  add(
    currentLevel,
    view,
    isCoverageSource ? PREFETCH_MARGIN_TILES : sameLevelMarginTiles,
    'current',
    `current-margin:${currentLevel}`
  );
  if (source.id.startsWith('aln:') && panDeltaBp !== 0) {
    const leadBp = Math.min(
      Math.abs(panDeltaBp) * ALIGNMENT_PAN_LEAD_COMMITS,
      tileSpanBp(currentLevel) * ALIGNMENT_MAX_LEAD_TILES
    );
    const leadingView: Viewport = {
      ...view,
      globalStart: view.globalStart - (panDeltaBp < 0 ? leadBp : 0),
      globalEnd: view.globalEnd + (panDeltaBp > 0 ? leadBp : 0),
    };
    add(currentLevel, leadingView, 0, 'pan-lead', `alignment-pan-lead:${currentLevel}`, true);
  }
  const primaryCriticalHandoffs =
    primaryCriticalFinerLevel == null
      ? []
      : activeCriticalHandoffs.filter((handoff) => handoff.level === primaryCriticalFinerLevel);
  if (primaryCriticalHandoffs.length > 0) {
    const nearestCriticalLevel = Math.max(
      ...primaryCriticalHandoffs.map((handoff) => handoff.level)
    );
    const firstAdjacentDescentLevel = Math.max(
      nearestCriticalLevel + 1,
      currentLevel - CRITICAL_HANDOFF_ADJACENT_DESCENT_LEVELS
    );
    for (let level = currentLevel - 1; level >= firstAdjacentDescentLevel; level--) {
      add(level, view, PREFETCH_MARGIN_TILES, 'adjacent-finer', `critical-adjacent:${level}`);
    }
  }

  if (activeCriticalHandoffs.length > 0) {
    for (const handoff of activeCriticalHandoffs) {
      const lookaheadView = centeredLookaheadView(view, handoff.lookaheadWindowBp);
      const firstCriticalPrefetchLevel = Math.max(0, handoff.level - handoff.prefetchLevels + 1);
      for (let level = handoff.level; level >= firstCriticalPrefetchLevel; level--) {
        add(level, lookaheadView, PREFETCH_MARGIN_TILES, 'critical-handoff');
      }
    }
  }

  if (isCoverageSource && source.prefetch?.wholeGenomeResident !== false) {
    const wholeGenomeView: Viewport = {
      ...view,
      globalStart: 0,
      globalEnd: tileSpanBp(maxLevel),
    };
    const residentLevels = [Math.max(0, maxLevel - 1)];
    for (const lvl of residentLevels) {
      add(lvl, wholeGenomeView, 0, 'coarser', `coverage-coarse-resident:${lvl}`);
    }
  }

  const hasCriticalFinerLevel = primaryCriticalFinerLevel != null;
  const mayUseAdjacentFinerPrefetch =
    source.prefetch != null &&
    (!hasCriticalFinerLevel || currentLevel <= primaryCriticalFinerLevel);
  const adjacentFinerPrefetch =
    activeCriticalHandoffs.length === 0 &&
    mayUseAdjacentFinerPrefetch &&
    shouldPrefetchFiner(view, currentLevel);
  const prioritizeAdjacentFiner =
    hasCriticalFinerLevel && currentLevel === primaryCriticalFinerLevel && adjacentFinerPrefetch;
  if (prioritizeAdjacentFiner) {
    add(currentLevel - 1, view, PREFETCH_MARGIN_TILES, 'adjacent-finer');
  }

  if (!prioritizeAdjacentFiner && adjacentFinerPrefetch) {
    add(currentLevel - 1, view, PREFETCH_MARGIN_TILES, 'adjacent-finer');
  }

  if (shouldPrefetchCoarser(view, currentLevel)) {
    add(currentLevel + 1, view, PREFETCH_MARGIN_TILES, 'coarser');
  }
  return out;
}

function criticalFinerHandoffsForSource(
  source: TileSource,
  maxLevel: number
): CriticalFinerHandoff[] {
  const out: CriticalFinerHandoff[] = [];
  const primaryLevel = source.prefetch?.criticalFinerLevel;
  if (primaryLevel != null) {
    out.push({
      level: primaryLevel,
      prefetchLevels: normalizeCriticalPrefetchLevels(source.prefetch?.criticalFinerPrefetchLevels),
      minCurrentLevel: primaryLevel + 1,
      maxCurrentLevel: source.prefetch?.criticalFinerMaxCurrentLevel ?? maxLevel,
      lookaheadWindowBp: source.prefetch?.finerLookaheadWindowBp,
    });
  }
  for (const handoff of source.prefetch?.additionalCriticalFinerHandoffs ?? []) {
    out.push({
      level: handoff.level,
      prefetchLevels: normalizeCriticalPrefetchLevels(handoff.prefetchLevels),
      minCurrentLevel:
        handoff.minCurrentLevel != null && Number.isFinite(handoff.minCurrentLevel)
          ? Math.max(0, Math.floor(handoff.minCurrentLevel))
          : handoff.level + 1,
      maxCurrentLevel:
        handoff.maxCurrentLevel != null && Number.isFinite(handoff.maxCurrentLevel)
          ? Math.min(maxLevel, Math.max(0, Math.floor(handoff.maxCurrentLevel)))
          : maxLevel,
      lookaheadWindowBp: handoff.lookaheadWindowBp,
    });
  }
  return out;
}

function sameLevelMarginTilesForLevel(source: TileSource, currentLevel: number): number {
  const configured = source.prefetch?.sameLevelMarginTiles;
  if (!(configured != null && configured > 0)) return PREFETCH_MARGIN_TILES;
  const configuredMinLevel = source.prefetch?.sameLevelMarginMinLevel;
  if (configuredMinLevel != null && Number.isFinite(configuredMinLevel)) {
    const minLevel = Math.max(0, Math.floor(configuredMinLevel));
    return currentLevel >= minLevel ? configured : PREFETCH_MARGIN_TILES;
  }
  const criticalFinerLevel = source.prefetch?.criticalFinerLevel;
  if (criticalFinerLevel == null) return configured;
  const firstCriticalPrefetchLevel = Math.max(
    0,
    criticalFinerLevel -
      normalizeCriticalPrefetchLevels(source.prefetch?.criticalFinerPrefetchLevels) +
      1
  );
  return currentLevel >= firstCriticalPrefetchLevel ? configured : PREFETCH_MARGIN_TILES;
}

function normalizeCriticalPrefetchLevels(levels: number | undefined): number {
  if (!(levels != null && Number.isFinite(levels))) return 1;
  return Math.max(1, Math.floor(levels));
}

function centeredLookaheadView(view: Viewport, windowBp: number | undefined): Viewport {
  if (!(windowBp != null && windowBp > 0)) return view;
  const span = view.globalEnd - view.globalStart;
  if (span <= windowBp) return view;
  const center = (view.globalStart + view.globalEnd) / 2;
  const half = windowBp / 2;
  return {
    globalStart: Math.max(0, center - half),
    globalEnd: center + half,
    viewportPx: view.viewportPx,
  };
}
