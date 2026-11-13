import { create } from 'zustand';
import type {
  AdmittedTrackSource,
  AnnotationRecord,
  CoverageSignal,
  PileupHistogramLoadingAnimation,
  PileupRecord,
  PeakRecord,
  QuantitativeBin,
  QuantitativeSourceSummaryV1,
  QuantitativeTrackPresentationV1,
  RepeatRecord,
  TranscriptRecord,
  VariantRecord,
} from '@waypoint/genome-data';
import {
  assertQuantitativeTransformCompatible,
  normalizeQuantitativeTrackPresentation,
} from '@waypoint/genome-data';
import type { PileupSource } from './pileup-source';
import type { RemotePileupConnectionState } from './pileup-source';
import type { RemoteSignalLocatorV1 } from '../../shared/remote-genomics-ipc';

export interface ActiveStressDataset {
  trackType: string;
  trackId: string;
  label: string;
  color: number;
  laneHeightPx?: number;
  maxLanes?: number;
  trackPx: number;
  records: ReadonlyArray<
    | AnnotationRecord
    | TranscriptRecord
    | PeakRecord
    | RepeatRecord
    | QuantitativeBin
    | VariantRecord
  >;
  pileupRecords?: ReadonlyArray<PileupRecord>;
  kind?: 'annotation' | 'pileup' | 'variant';
  coverage?: CoverageSignal;
  overflowBandHeightPx?: number;
  source?: PileupSource;
  coverageCutoffDepth?: number;
  quantitativePresentation?: QuantitativeTrackPresentationV1;
  quantitativeSourceSummary?: QuantitativeSourceSummaryV1;
  remoteSignal?: {
    readonly locator: RemoteSignalLocatorV1;
    readonly sessionId?: string;
    readonly connection?: RemotePileupConnectionState;
    readonly admissionError?: string;
    readonly admissionCancelled?: boolean;
    readonly durableSource?: AdmittedTrackSource;
  };
  experimentalHybrid?: {
    readonly alignmentTrackId: string;
    readonly quantitativeTrackId: string;
    readonly loadingAnimation?: PileupHistogramLoadingAnimation;
    readonly waitingForSources?: boolean;
    readonly sourceError?: string;
  };
}

export interface TrackPresentationPatch {
  readonly label?: string;
  readonly color?: number;
  readonly heightPx?: number;
  readonly rowHeightPx?: number;
  readonly maxRows?: number;
  readonly coverageCutoffDepth?: number;
  readonly quantitative?: QuantitativeTrackPresentationV1;
}

export type UpdateLanePresentationResult =
  | { readonly status: 'updated'; readonly dataset: ActiveStressDataset }
  | { readonly status: 'missing'; readonly message: string }
  | { readonly status: 'invalid'; readonly message: string };

export interface Lane {
  readonly assemblyId: string;
  readonly order: number;
  readonly dataset: ActiveStressDataset;
  readonly visible: boolean;
  readonly source?: AdmittedTrackSource;
}

export const LEGACY_BUCKET = '__legacy__';
export type AddLaneResult = 'added' | 'duplicate';
export type LaneMovePlacement = 'before' | 'after';
export type LaneHistoryMode = 'record' | 'skip';

type LaneMap = Record<string, ReadonlyArray<Lane>>;
interface LaneHistory {
  readonly past: ReadonlyArray<ReadonlyArray<Lane>>;
  readonly future: ReadonlyArray<ReadonlyArray<Lane>>;
}
type LaneHistoryMap = Record<string, LaneHistory>;

const LANE_HISTORY_LIMIT = 100;

function projectVisible(lanesByOwnerId: LaneMap): ActiveStressDataset[] {
  return Object.values(lanesByOwnerId).flatMap((lanes) =>
    lanes.filter((lane) => lane.visible).map((lane) => lane.dataset)
  );
}

function commit(lanesByOwnerId: LaneMap) {
  const activeDatasets = projectVisible(lanesByOwnerId);
  return { lanesByOwnerId, activeDatasets, activeDataset: activeDatasets[0] ?? null };
}

function commitOwnerLaneChange(
  state: Pick<LaneContractState, 'lanesByOwnerId' | 'laneHistoryByOwnerId'>,
  ownerId: string,
  lanes: ReadonlyArray<Lane>,
  historyMode: LaneHistoryMode = 'record'
) {
  const lanesByOwnerId = { ...state.lanesByOwnerId, [ownerId]: lanes };
  if (historyMode === 'skip') return commit(lanesByOwnerId);

  const current = state.lanesByOwnerId[ownerId] ?? [];
  const history = state.laneHistoryByOwnerId[ownerId] ?? { past: [], future: [] };
  return {
    ...commit(lanesByOwnerId),
    laneHistoryByOwnerId: {
      ...state.laneHistoryByOwnerId,
      [ownerId]: {
        past: [...history.past, current].slice(-LANE_HISTORY_LIMIT),
        future: [],
      },
    },
  };
}

function withoutOwnerHistory(historyByOwnerId: LaneHistoryMap, ownerId: string): LaneHistoryMap {
  if (!(ownerId in historyByOwnerId)) return historyByOwnerId;
  const next = { ...historyByOwnerId };
  delete next[ownerId];
  return next;
}

function normalizeCoverageCutoffDepth(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function normalizeTrackColor(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0xff_ffff, Math.round(value)));
}

export function applyTrackPresentationPatch(
  dataset: ActiveStressDataset,
  patch: TrackPresentationPatch
): ActiveStressDataset {
  const next: ActiveStressDataset = { ...dataset };
  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (!label || label.length > 200) {
      throw new Error('Track label must contain between 1 and 200 characters.');
    }
    next.label = label;
  }
  if (patch.color !== undefined) {
    if (!Number.isInteger(patch.color) || patch.color < 0 || patch.color > 0xff_ffff) {
      throw new Error('Track color must be an integer between 0x000000 and 0xffffff.');
    }
    next.color = patch.color;
  }
  if (patch.heightPx !== undefined) {
    requireFiniteRange(patch.heightPx, 32, 2_048, 'Track height', 'pixels');
    next.trackPx = Math.round(patch.heightPx);
  }
  if (patch.rowHeightPx !== undefined) {
    requireFiniteRange(patch.rowHeightPx, 1, 128, 'Row height', 'pixels');
    next.laneHeightPx = Math.round(patch.rowHeightPx);
  }
  if (patch.maxRows !== undefined) {
    requireFiniteRange(patch.maxRows, 1, 1_000, 'Maximum rows', 'rows');
    next.maxLanes = Math.round(patch.maxRows);
  }
  if (patch.coverageCutoffDepth !== undefined) {
    if (dataset.kind !== 'pileup') {
      throw new Error('Coverage cutoff is only valid for BAM/CRAM pileup tracks.');
    }
    if (
      !Number.isFinite(patch.coverageCutoffDepth) ||
      patch.coverageCutoffDepth < 0 ||
      patch.coverageCutoffDepth > 1_000_000_000
    ) {
      throw new Error('Coverage cutoff must be zero (automatic) or a finite positive depth.');
    }
    next.coverageCutoffDepth = Math.round(patch.coverageCutoffDepth);
  }
  if (patch.quantitative !== undefined) {
    if (dataset.kind === 'pileup' || !isQuantitativeTrack(dataset)) {
      throw new Error('Quantitative scale settings require a quantitative or peak track.');
    }
    const presentation = normalizeQuantitativeTrackPresentation(patch.quantitative);
    assertQuantitativeTransformCompatible(
      presentation,
      dataset.quantitativeSourceSummary,
      quantitativeValues(dataset)
    );
    next.quantitativePresentation = presentation;
  }
  return next;
}

function normalizeLaneOrder(lanes: ReadonlyArray<Lane>): ReadonlyArray<Lane> {
  return lanes.map((lane, order) => (lane.order === order ? lane : { ...lane, order }));
}

function nextLaneOrder(lanes: ReadonlyArray<Lane>): number {
  return lanes.reduce((highest, lane) => Math.max(highest, lane.order), -1) + 1;
}

function hasSameHybridSourcePair(left: ActiveStressDataset, right: ActiveStressDataset): boolean {
  const leftHybrid = left.experimentalHybrid;
  const rightHybrid = right.experimentalHybrid;
  return Boolean(
    leftHybrid &&
    rightHybrid &&
    leftHybrid.alignmentTrackId === rightHybrid.alignmentTrackId &&
    leftHybrid.quantitativeTrackId === rightHybrid.quantitativeTrackId
  );
}

interface LaneContractState {
  lanesByOwnerId: LaneMap;
  laneHistoryByOwnerId: LaneHistoryMap;
  activeDatasets: ReadonlyArray<ActiveStressDataset>;
  activeDataset: ActiveStressDataset | null;
  lanesForOwner: (ownerId: string) => ReadonlyArray<Lane>;
  addLane: (
    ownerId: string,
    assemblyId: string,
    dataset: ActiveStressDataset,
    initialVisible?: boolean,
    source?: AdmittedTrackSource,
    initialOrder?: number,
    historyMode?: LaneHistoryMode
  ) => AddLaneResult;
  replaceLaneDataset: (
    ownerId: string,
    trackId: string,
    assemblyId: string,
    dataset: ActiveStressDataset,
    source?: AdmittedTrackSource
  ) => 'replaced' | 'missing';
  replaceOwnerLanes: (
    ownerId: string,
    lanes: ReadonlyArray<Lane>,
    historyMode?: LaneHistoryMode
  ) => void;
  removeLane: (ownerId: string, trackId: string) => void;
  moveLane: (
    ownerId: string,
    trackId: string,
    targetTrackId: string,
    placement: LaneMovePlacement,
    historyMode?: LaneHistoryMode
  ) => void;
  setLaneOrder: (ownerId: string, orderedTrackIds: ReadonlyArray<string>) => boolean;
  setLaneVisible: (ownerId: string, trackId: string, visible: boolean) => void;
  updateLanePresentation: (
    ownerId: string,
    trackId: string,
    patch: TrackPresentationPatch,
    historyMode?: LaneHistoryMode
  ) => UpdateLanePresentationResult;
  commitLaneHeightResize: (
    ownerId: string,
    trackId: string,
    startingHeightPx: number,
    heightPx: number
  ) => UpdateLanePresentationResult;
  setLaneColor: (ownerId: string, trackId: string, color: number) => void;
  setLaneCoverageCutoff: (ownerId: string, trackId: string, cutoffDepth: number) => void;
  canUndoLaneChange: (ownerId: string) => boolean;
  canRedoLaneChange: (ownerId: string) => boolean;
  undoLaneChange: (ownerId: string) => boolean;
  redoLaneChange: (ownerId: string) => boolean;
  clearOwnerHistory: (ownerId: string) => void;
  replaceForOwner: (
    ownerId: string,
    assemblyId: string,
    datasets: ReadonlyArray<ActiveStressDataset>
  ) => void;
  clearOwner: (ownerId: string) => void;
  setActiveDatasets: (datasets: ReadonlyArray<ActiveStressDataset>) => void;
  setActiveDataset: (dataset: ActiveStressDataset | null) => void;
  clear: () => void;
}

export const useLaneContractStore = create<LaneContractState>((set, get) => ({
  lanesByOwnerId: {},
  laneHistoryByOwnerId: {},
  activeDatasets: [],
  activeDataset: null,

  lanesForOwner: (ownerId) => get().lanesByOwnerId[ownerId] ?? [],

  addLane: (
    ownerId,
    assemblyId,
    dataset,
    initialVisible = true,
    source,
    initialOrder,
    historyMode = 'record'
  ) => {
    const existing = get().lanesByOwnerId[ownerId] ?? [];
    if (
      existing.some(
        (lane) =>
          lane.dataset.trackId === dataset.trackId || hasSameHybridSourcePair(lane.dataset, dataset)
      )
    ) {
      return 'duplicate';
    }
    set((state) => {
      const current = state.lanesByOwnerId[ownerId] ?? [];
      const requestedOrder =
        typeof initialOrder === 'number' && Number.isSafeInteger(initialOrder) && initialOrder >= 0
          ? initialOrder
          : nextLaneOrder(current);
      const next = [
        ...current,
        {
          assemblyId,
          order: requestedOrder,
          dataset,
          visible: initialVisible,
          ...(source ? { source } : {}),
        },
      ].sort((left, right) => left.order - right.order);
      return commitOwnerLaneChange(state, ownerId, next, historyMode);
    });
    return 'added';
  },

  replaceLaneDataset: (ownerId, trackId, assemblyId, dataset, source) => {
    const existing = get().lanesByOwnerId[ownerId] ?? [];
    if (!existing.some((lane) => lane.dataset.trackId === trackId)) return 'missing';
    set((state) =>
      commit({
        ...state.lanesByOwnerId,
        [ownerId]: (state.lanesByOwnerId[ownerId] ?? []).map((lane) =>
          lane.dataset.trackId === trackId
            ? {
                ...lane,
                assemblyId,
                dataset: {
                  ...dataset,
                  trackId,
                  label: lane.dataset.label,
                  color: lane.dataset.color,
                  trackPx: lane.dataset.trackPx,
                  laneHeightPx: lane.dataset.laneHeightPx,
                  maxLanes: lane.dataset.maxLanes,
                  coverageCutoffDepth: lane.dataset.coverageCutoffDepth,
                  quantitativePresentation: lane.dataset.quantitativePresentation,
                },
                ...(source ? { source } : {}),
              }
            : lane
        ),
      })
    );
    return 'replaced';
  },

  replaceOwnerLanes: (ownerId, lanes, historyMode = 'record') =>
    set((state) => {
      const normalized = normalizeLaneOrder(
        [...lanes].sort((left, right) => left.order - right.order)
      );
      if (historyMode === 'record') return commitOwnerLaneChange(state, ownerId, normalized);
      return {
        ...commit({ ...state.lanesByOwnerId, [ownerId]: normalized }),
        laneHistoryByOwnerId: withoutOwnerHistory(state.laneHistoryByOwnerId, ownerId),
      };
    }),

  removeLane: (ownerId, trackId) => {
    if (!(get().lanesByOwnerId[ownerId] ?? []).some((lane) => lane.dataset.trackId === trackId)) {
      return;
    }
    set((state) =>
      commitOwnerLaneChange(
        state,
        ownerId,
        (state.lanesByOwnerId[ownerId] ?? []).filter((lane) => {
          if (lane.dataset.trackId === trackId) return false;
          const composition = lane.dataset.experimentalHybrid;
          return (
            composition?.alignmentTrackId !== trackId &&
            composition?.quantitativeTrackId !== trackId
          );
        })
      )
    );
  },

  moveLane: (ownerId, trackId, targetTrackId, placement, historyMode = 'record') => {
    if (trackId === targetTrackId) return;
    set((state) => {
      const current = state.lanesByOwnerId[ownerId] ?? [];
      const source = current.find((lane) => lane.dataset.trackId === trackId);
      if (!source || !current.some((lane) => lane.dataset.trackId === targetTrackId)) return state;
      const remaining = current.filter((lane) => lane.dataset.trackId !== trackId);
      const targetIndex = remaining.findIndex((lane) => lane.dataset.trackId === targetTrackId);
      if (targetIndex < 0) return state;
      const next = [...remaining];
      next.splice(placement === 'before' ? targetIndex : targetIndex + 1, 0, source);
      return commitOwnerLaneChange(state, ownerId, normalizeLaneOrder(next), historyMode);
    });
  },

  setLaneOrder: (ownerId, orderedTrackIds) => {
    const current = get().lanesByOwnerId[ownerId] ?? [];
    if (orderedTrackIds.length !== current.length) return false;
    const requestedIds = new Set(orderedTrackIds);
    if (
      requestedIds.size !== orderedTrackIds.length ||
      current.some((lane) => !requestedIds.has(lane.dataset.trackId))
    ) {
      return false;
    }
    const currentIds = current.map((lane) => lane.dataset.trackId);
    if (currentIds.every((trackId, index) => trackId === orderedTrackIds[index])) return false;
    const lanesByTrackId = new Map(current.map((lane) => [lane.dataset.trackId, lane]));
    const next: Lane[] = [];
    for (let order = 0; order < orderedTrackIds.length; order += 1) {
      const lane = lanesByTrackId.get(orderedTrackIds[order]);
      if (!lane) return false;
      next.push({ ...lane, order });
    }
    set((state) => commitOwnerLaneChange(state, ownerId, next));
    return true;
  },

  setLaneVisible: (ownerId, trackId, visible) => {
    const lane = (get().lanesByOwnerId[ownerId] ?? []).find(
      (candidate) => candidate.dataset.trackId === trackId
    );
    if (!lane || lane.visible === visible) return;
    set((state) =>
      commitOwnerLaneChange(
        state,
        ownerId,
        (state.lanesByOwnerId[ownerId] ?? []).map((candidate) =>
          candidate.dataset.trackId === trackId ? { ...candidate, visible } : candidate
        )
      )
    );
  },

  updateLanePresentation: (ownerId, trackId, patch, historyMode = 'record') => {
    const lane = (get().lanesByOwnerId[ownerId] ?? []).find(
      (candidate) => candidate.dataset.trackId === trackId
    );
    if (!lane) {
      return { status: 'missing', message: `Track ${trackId} does not exist in view ${ownerId}.` };
    }
    let dataset: ActiveStressDataset;
    try {
      dataset = applyTrackPresentationPatch(lane.dataset, patch);
    } catch (error) {
      return {
        status: 'invalid',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    set((state) =>
      commitOwnerLaneChange(
        state,
        ownerId,
        (state.lanesByOwnerId[ownerId] ?? []).map((candidate) =>
          candidate.dataset.trackId === trackId ? { ...candidate, dataset } : candidate
        ),
        historyMode
      )
    );
    return { status: 'updated', dataset };
  },

  commitLaneHeightResize: (ownerId, trackId, startingHeightPx, heightPx) => {
    const lane = (get().lanesByOwnerId[ownerId] ?? []).find(
      (candidate) => candidate.dataset.trackId === trackId
    );
    if (!lane) {
      return { status: 'missing', message: `Track ${trackId} does not exist in view ${ownerId}.` };
    }
    let baselineDataset: ActiveStressDataset;
    let dataset: ActiveStressDataset;
    try {
      baselineDataset = applyTrackPresentationPatch(lane.dataset, {
        heightPx: startingHeightPx,
      });
      dataset = applyTrackPresentationPatch(lane.dataset, { heightPx });
    } catch (error) {
      return {
        status: 'invalid',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (baselineDataset.trackPx === dataset.trackPx) {
      return get().updateLanePresentation(ownerId, trackId, { heightPx }, 'skip');
    }
    set((state) => {
      const current = state.lanesByOwnerId[ownerId] ?? [];
      if (!current.some((candidate) => candidate.dataset.trackId === trackId)) return state;
      const baseline = current.map((candidate) =>
        candidate.dataset.trackId === trackId
          ? { ...candidate, dataset: baselineDataset }
          : candidate
      );
      const next = current.map((candidate) =>
        candidate.dataset.trackId === trackId ? { ...candidate, dataset } : candidate
      );
      const history = state.laneHistoryByOwnerId[ownerId] ?? { past: [], future: [] };
      return {
        ...commit({ ...state.lanesByOwnerId, [ownerId]: next }),
        laneHistoryByOwnerId: {
          ...state.laneHistoryByOwnerId,
          [ownerId]: {
            past: [...history.past, baseline].slice(-LANE_HISTORY_LIMIT),
            future: [],
          },
        },
      };
    });
    return { status: 'updated', dataset };
  },

  setLaneColor: (ownerId, trackId, color) => {
    get().updateLanePresentation(ownerId, trackId, { color: normalizeTrackColor(color) });
  },

  setLaneCoverageCutoff: (ownerId, trackId, cutoffDepth) => {
    get().updateLanePresentation(ownerId, trackId, {
      coverageCutoffDepth: normalizeCoverageCutoffDepth(cutoffDepth),
    });
  },

  canUndoLaneChange: (ownerId) => (get().laneHistoryByOwnerId[ownerId]?.past.length ?? 0) > 0,

  canRedoLaneChange: (ownerId) => (get().laneHistoryByOwnerId[ownerId]?.future.length ?? 0) > 0,

  undoLaneChange: (ownerId) => {
    let changed = false;
    set((state) => {
      const history = state.laneHistoryByOwnerId[ownerId];
      const previous = history?.past[history.past.length - 1];
      if (!history || !previous) return state;
      changed = true;
      const current = state.lanesByOwnerId[ownerId] ?? [];
      return {
        ...commit({ ...state.lanesByOwnerId, [ownerId]: previous }),
        laneHistoryByOwnerId: {
          ...state.laneHistoryByOwnerId,
          [ownerId]: {
            past: history.past.slice(0, -1),
            future: [current, ...history.future].slice(0, LANE_HISTORY_LIMIT),
          },
        },
      };
    });
    return changed;
  },

  redoLaneChange: (ownerId) => {
    let changed = false;
    set((state) => {
      const history = state.laneHistoryByOwnerId[ownerId];
      const next = history?.future[0];
      if (!history || !next) return state;
      changed = true;
      const current = state.lanesByOwnerId[ownerId] ?? [];
      return {
        ...commit({ ...state.lanesByOwnerId, [ownerId]: next }),
        laneHistoryByOwnerId: {
          ...state.laneHistoryByOwnerId,
          [ownerId]: {
            past: [...history.past, current].slice(-LANE_HISTORY_LIMIT),
            future: history.future.slice(1),
          },
        },
      };
    });
    return changed;
  },

  clearOwnerHistory: (ownerId) =>
    set((state) => ({
      laneHistoryByOwnerId: withoutOwnerHistory(state.laneHistoryByOwnerId, ownerId),
    })),

  replaceForOwner: (ownerId, assemblyId, datasets) =>
    set((state) => ({
      ...commit({
        ...state.lanesByOwnerId,
        [ownerId]: datasets.map((dataset, order) => ({
          assemblyId,
          order,
          dataset,
          visible: true,
        })),
      }),
      laneHistoryByOwnerId: withoutOwnerHistory(state.laneHistoryByOwnerId, ownerId),
    })),

  clearOwner: (ownerId) =>
    set((state) => {
      const next = { ...state.lanesByOwnerId };
      delete next[ownerId];
      return {
        ...commit(next),
        laneHistoryByOwnerId: withoutOwnerHistory(state.laneHistoryByOwnerId, ownerId),
      };
    }),

  setActiveDatasets: (datasets) =>
    set((state) =>
      commit({
        ...state.lanesByOwnerId,
        [LEGACY_BUCKET]: datasets.map((dataset, order) => ({
          assemblyId: LEGACY_BUCKET,
          order,
          dataset,
          visible: true,
        })),
      })
    ),

  setActiveDataset: (dataset) =>
    set((state) =>
      commit({
        ...state.lanesByOwnerId,
        [LEGACY_BUCKET]: dataset
          ? [{ assemblyId: LEGACY_BUCKET, order: 0, dataset, visible: true }]
          : [],
      })
    ),

  clear: () => set(() => ({ ...commit({}), laneHistoryByOwnerId: {} })),
}));

function requireFiniteRange(
  value: number,
  min: number,
  max: number,
  label: string,
  unit: string
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max} ${unit}.`);
  }
}

function isQuantitativeTrack(dataset: ActiveStressDataset): boolean {
  return dataset.trackType === 'quantitative' || dataset.trackType === 'peak';
}

function quantitativeValues(dataset: ActiveStressDataset): number[] {
  const values: number[] = [];
  for (const record of dataset.records) {
    if ('value' in record && typeof record.value === 'number') values.push(record.value);
    else if ('signalValue' in record && typeof record.signalValue === 'number') {
      values.push(record.signalValue);
    }
  }
  return values;
}

if ((import.meta.env.DEV || import.meta.env.MODE === 'test') && typeof window !== 'undefined') {
  (window as Window & { __laneContractStore?: typeof useLaneContractStore }).__laneContractStore =
    useLaneContractStore;
}
