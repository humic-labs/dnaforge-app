import {
  createIndexedBbiTrackId,
  requireGenomicViewBinding,
  type CoverageSignal,
  type PileupHistogramLoadingAnimation,
  type PileupReferenceInterval,
  type PileupTrackData,
  type QuantitativeBin,
} from '@waypoint/genome-data';

import type { ActiveStressDataset, Lane } from './lane-contract-store';
import type { PileupSource } from './pileup-source';
import { stableSourceHash } from './read-pileup-import';
import {
  SIGNAL_READ_PILEUP_VIEW_V1,
  type IndexedGenomeSignalReadPileupViewState,
} from '../../shared/indexed-genome';

const MAX_HYBRID_COVERAGE_BINS = 32_768;
export const EXPERIMENTAL_HYBRID_MORPH_DURATION_MS = 160;
const EXPERIMENTAL_HYBRID_LOADING_ANIMATION_STORAGE_KEY =
  'dna1342.experimentalHybridLoadingAnimation.v1';

export const EXPERIMENTAL_HYBRID_LOADING_ANIMATIONS = [
  { value: 'diagonal-scan', label: 'Diagonal scan' },
] as const satisfies ReadonlyArray<{
  readonly value: PileupHistogramLoadingAnimation;
  readonly label: string;
}>;

export const DEFAULT_EXPERIMENTAL_HYBRID_LOADING_ANIMATION: PileupHistogramLoadingAnimation =
  'diagonal-scan';

export function isExperimentalHybridLoadingAnimation(
  value: string
): value is PileupHistogramLoadingAnimation {
  return EXPERIMENTAL_HYBRID_LOADING_ANIMATIONS.some((option) => option.value === value);
}

export function readExperimentalHybridLoadingAnimationPreference(): PileupHistogramLoadingAnimation {
  try {
    const value = globalThis.localStorage?.getItem(
      EXPERIMENTAL_HYBRID_LOADING_ANIMATION_STORAGE_KEY
    );
    return value && isExperimentalHybridLoadingAnimation(value)
      ? value
      : DEFAULT_EXPERIMENTAL_HYBRID_LOADING_ANIMATION;
  } catch {
    return DEFAULT_EXPERIMENTAL_HYBRID_LOADING_ANIMATION;
  }
}

export function writeExperimentalHybridLoadingAnimationPreference(
  value: PileupHistogramLoadingAnimation
): void {
  try {
    globalThis.localStorage?.setItem(EXPERIMENTAL_HYBRID_LOADING_ANIMATION_STORAGE_KEY, value);
  } catch {}
}

export interface ExperimentalHybridPileupDefinition {
  readonly trackId: string;
  readonly alignmentTrackId: string;
  readonly quantitativeTrackId: string;
  readonly coverageCutoffDepth: number;
  readonly loadingAnimation: PileupHistogramLoadingAnimation;
}

export interface ExperimentalHybridPileupTarget {
  getRenderer(): {
    hasTrackInstance(trackId: string): boolean;
    setTrackData(trackId: string, data: PileupTrackData): void;
  } | null;
  requestRender(): void;
}

export function createSignalReadPileupViewState(input: {
  readonly assemblyId: string;
  readonly alignment: ActiveStressDataset;
  readonly signal: ActiveStressDataset;
  readonly trackId?: string;
  readonly label?: string;
  readonly order?: number;
  readonly visible?: boolean;
  readonly presentation?: {
    readonly color?: number;
    readonly heightPx?: number;
    readonly rowHeightPx?: number;
    readonly maxRows?: number;
    readonly coverageCutoffDepth?: number;
  };
}): IndexedGenomeSignalReadPileupViewState {
  if (input.alignment.kind !== 'pileup' || !input.alignment.source) {
    throw new Error('A signal-to-reads view requires an admitted BAM or CRAM read track.');
  }
  if (input.signal.kind === 'pileup' || input.signal.trackType !== 'quantitative') {
    throw new Error('A signal-to-reads view requires an admitted quantitative BigWig track.');
  }
  requireGenomicViewBinding('signal-with-read-evidence', {
    signal: {
      id: input.signal.trackId,
      assemblyId: input.assemblyId,
      scientificKind: 'quantitative',
      regionalAccess: 'admitted-reader',
      quantitativeMeaning: 'unknown',
    },
    reads: {
      id: input.alignment.trackId,
      assemblyId: input.assemblyId,
      scientificKind: 'reads',
      regionalAccess: 'admitted-reader',
    },
  });
  const presentation = input.presentation;
  const maxLanes = Math.max(1, Math.round(presentation?.maxRows ?? input.alignment.maxLanes ?? 80));
  const view: IndexedGenomeSignalReadPileupViewState = {
    contract: SIGNAL_READ_PILEUP_VIEW_V1,
    trackId:
      input.trackId ??
      `signal-read-${input.assemblyId}-${stableSourceHash(
        [input.alignment.trackId, input.signal.trackId].join('\u0000')
      )}`,
    readsTrackId: input.alignment.trackId,
    signalTrackId: input.signal.trackId,
    label: input.label?.trim() || `${input.alignment.label} · BigWig → reads`,
    ...(input.order === undefined ? {} : { order: input.order }),
    visible: input.visible ?? true,
    color: presentation?.color ?? input.alignment.color,
    trackPx: presentation?.heightPx ?? input.alignment.trackPx,
    laneHeightPx: presentation?.rowHeightPx ?? Math.max(1, input.alignment.laneHeightPx ?? 3),
    maxLanes,
    overflowBandHeightPx: Math.max(1, input.alignment.overflowBandHeightPx ?? 36),
    coverageCutoffDepth: presentation?.coverageCutoffDepth ?? maxLanes,
    loadingAnimation: 'diagonal-scan',
  };
  requireIndexedGenomeSignalReadPileupView(view);
  return view;
}

export function buildExperimentalHybridPileupDataset(input: {
  readonly alignment: ActiveStressDataset;
  readonly signal: ActiveStressDataset;
  readonly view?: IndexedGenomeSignalReadPileupViewState;
}): ActiveStressDataset {
  if (
    input.view &&
    (input.view.readsTrackId !== input.alignment.trackId ||
      input.view.signalTrackId !== input.signal.trackId)
  ) {
    throw new Error('The signal-to-reads view does not match its admitted source tracks.');
  }
  return buildExperimentalHybridPileupDatasetFromAlignment(
    input.alignment,
    input.signal.trackId,
    input.view,
    false
  );
}

function buildExperimentalHybridPileupDatasetFromAlignment(
  alignment: ActiveStressDataset,
  quantitativeTrackId: string,
  view: IndexedGenomeSignalReadPileupViewState | undefined,
  waitingForSources: boolean
): ActiveStressDataset {
  const maxRows = Math.max(1, Math.round(view?.maxLanes ?? alignment.maxLanes ?? 80));
  return {
    kind: 'pileup',
    trackType: alignment.trackType,
    trackId:
      view?.trackId ?? `hybrid-${alignment.trackId}-${stableSourceHash(quantitativeTrackId)}`,
    label: view?.label ?? `${alignment.label} · BigWig → reads`,
    color: view?.color ?? alignment.color,
    laneHeightPx: view?.laneHeightPx ?? alignment.laneHeightPx,
    maxLanes: maxRows,
    overflowBandHeightPx: view?.overflowBandHeightPx ?? alignment.overflowBandHeightPx,
    trackPx: view?.trackPx ?? alignment.trackPx,
    records: [],
    coverageCutoffDepth: view?.coverageCutoffDepth ?? maxRows,
    experimentalHybrid: {
      alignmentTrackId: alignment.trackId,
      quantitativeTrackId,
      loadingAnimation:
        view?.loadingAnimation ?? readExperimentalHybridLoadingAnimationPreference(),
      ...(waitingForSources ? { waitingForSources: true } : {}),
    },
  };
}

export function indexedGenomeSignalReadPileupViewFromLane(
  lane: Lane
): IndexedGenomeSignalReadPileupViewState | null {
  const hybrid = lane.dataset.experimentalHybrid;
  if (!hybrid || lane.dataset.kind !== 'pileup') return null;
  return {
    contract: SIGNAL_READ_PILEUP_VIEW_V1,
    trackId: lane.dataset.trackId,
    readsTrackId: hybrid.alignmentTrackId,
    signalTrackId: hybrid.quantitativeTrackId,
    label: lane.dataset.label,
    order: lane.order,
    visible: lane.visible,
    color: lane.dataset.color,
    trackPx: lane.dataset.trackPx,
    laneHeightPx: Math.max(1, lane.dataset.laneHeightPx ?? 3),
    maxLanes: Math.max(1, Math.round(lane.dataset.maxLanes ?? 80)),
    overflowBandHeightPx: Math.max(1, lane.dataset.overflowBandHeightPx ?? 36),
    coverageCutoffDepth: Math.max(
      1,
      Math.round(lane.dataset.coverageCutoffDepth ?? lane.dataset.maxLanes ?? 80)
    ),
    loadingAnimation: 'diagonal-scan',
  };
}

export function laneFromIndexedGenomeSignalReadPileupView(
  view: IndexedGenomeSignalReadPileupViewState,
  assemblyId: string,
  sourceLanes: ReadonlyArray<Lane>,
  options: { readonly allowPendingSignal?: boolean } = {}
): Lane {
  requireIndexedGenomeSignalReadPileupView(view);
  const alignmentLane = sourceLanes.find((lane) => lane.dataset.trackId === view.readsTrackId);
  const signalLane = sourceLanes.find((lane) => lane.dataset.trackId === view.signalTrackId);
  const alignment = alignmentLane?.dataset;
  const signal = signalLane?.dataset;
  if (alignment?.kind !== 'pileup' || !alignment.source) {
    throw new Error(`Signal-to-reads view ${view.label} has no admitted read source.`);
  }
  const signalReady = signal && signal.kind !== 'pileup' && signal.trackType === 'quantitative';
  if (!signalReady && !options.allowPendingSignal) {
    throw new Error(`Signal-to-reads view ${view.label} has no admitted quantitative signal.`);
  }
  if (signalReady) {
    const binding = requireGenomicViewBinding('signal-with-read-evidence', {
      signal: {
        id: signal.trackId,
        assemblyId: signalLane!.assemblyId,
        scientificKind: 'quantitative',
        regionalAccess: 'admitted-reader',
        quantitativeMeaning: 'unknown',
      },
      reads: {
        id: alignment.trackId,
        assemblyId: alignmentLane!.assemblyId,
        scientificKind: 'reads',
        regionalAccess: 'admitted-reader',
      },
    });
    if (binding.assemblyId !== assemblyId) {
      throw new Error(`Signal-to-reads view ${view.label} uses another reference assembly.`);
    }
  }
  return {
    assemblyId,
    order: view.order ?? sourceLanes.length,
    visible: view.visible,
    dataset: signalReady
      ? buildExperimentalHybridPileupDataset({ alignment, signal, view })
      : buildExperimentalHybridPileupDatasetFromAlignment(
          alignment,
          view.signalTrackId,
          view,
          true
        ),
  };
}

export function requireIndexedGenomeSignalReadPileupView(
  view: IndexedGenomeSignalReadPileupViewState
): void {
  if (
    view.contract !== SIGNAL_READ_PILEUP_VIEW_V1 ||
    !view.trackId ||
    !view.readsTrackId ||
    !view.signalTrackId ||
    view.readsTrackId === view.signalTrackId ||
    !view.label ||
    typeof view.visible !== 'boolean' ||
    !Number.isInteger(view.color) ||
    view.color < 0 ||
    view.color > 0xff_ffff ||
    !positiveFinite(view.trackPx) ||
    !positiveFinite(view.laneHeightPx) ||
    !positiveInteger(view.maxLanes) ||
    !positiveFinite(view.overflowBandHeightPx) ||
    !positiveFinite(view.coverageCutoffDepth) ||
    view.loadingAnimation !== 'diagonal-scan'
  ) {
    throw new Error('Invalid persisted signal-to-reads pileup view.');
  }
}

export function indexedGenomeSignalReadPileupViewsEqual(
  left: ReadonlyArray<IndexedGenomeSignalReadPileupViewState>,
  right: ReadonlyArray<IndexedGenomeSignalReadPileupViewState>
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function buildPileupReadSourcesByTrackId(
  datasets: ReadonlyArray<ActiveStressDataset>
): ReadonlyMap<string, PileupSource> {
  const sources = new Map<string, PileupSource>();
  for (const dataset of datasets) {
    if (dataset.kind === 'pileup' && dataset.source) {
      sources.set(dataset.trackId, dataset.source);
    }
  }
  for (const dataset of datasets) {
    const alignmentTrackId = dataset.experimentalHybrid?.alignmentTrackId;
    if (!alignmentTrackId) continue;
    const source = sources.get(alignmentTrackId);
    if (source) sources.set(dataset.trackId, source);
  }
  return sources;
}

export function buildExperimentalHybridStreamingLanes(
  lanes: ReadonlyArray<Lane>
): ReadonlyArray<Lane> {
  const requiredTrackIds = new Set<string>();
  for (const lane of lanes) {
    if (!lane.visible) continue;
    const hybrid = lane.dataset.experimentalHybrid;
    if (!hybrid) continue;
    requiredTrackIds.add(hybrid.alignmentTrackId);
    requiredTrackIds.add(hybrid.quantitativeTrackId);
  }
  return lanes.flatMap((lane) => {
    if (!lane.visible && !requiredTrackIds.has(lane.dataset.trackId)) return [];
    return [lane.visible ? lane : { ...lane, visible: true }];
  });
}

export function experimentalHybridDefinition(
  dataset: ActiveStressDataset
): ExperimentalHybridPileupDefinition | null {
  const hybrid = dataset.experimentalHybrid;
  if (!hybrid || dataset.kind !== 'pileup') return null;
  return {
    trackId: dataset.trackId,
    alignmentTrackId: hybrid.alignmentTrackId,
    quantitativeTrackId: hybrid.quantitativeTrackId,
    loadingAnimation:
      hybrid.loadingAnimation && isExperimentalHybridLoadingAnimation(hybrid.loadingAnimation)
        ? hybrid.loadingAnimation
        : DEFAULT_EXPERIMENTAL_HYBRID_LOADING_ANIMATION,
    coverageCutoffDepth: Math.max(
      1,
      Math.round(dataset.coverageCutoffDepth ?? dataset.maxLanes ?? 80)
    ),
  };
}

export function deriveExperimentalHybridPileupLanes(
  lanes: ReadonlyArray<Lane>,
  allowAutomaticCreation = true
): ReadonlyArray<{ readonly assemblyId: string; readonly dataset: ActiveStressDataset }> {
  if (!allowAutomaticCreation) return [];
  const byTrackId = new Map(lanes.map((lane) => [lane.dataset.trackId, lane] as const));
  const existingPairs = new Set(
    lanes.flatMap((lane) => {
      const hybrid = lane.dataset.experimentalHybrid;
      return hybrid ? [`${hybrid.alignmentTrackId}\0${hybrid.quantitativeTrackId}`] : [];
    })
  );
  const derived: Array<{ assemblyId: string; dataset: ActiveStressDataset }> = [];
  for (const alignmentLane of lanes) {
    const alignment = alignmentLane.dataset;
    const locator = alignment.source?.remote?.locator;
    if (alignment.kind !== 'pileup' || !locator?.signalPath) continue;
    const durableSignalUrl = `ssh://${locator.target}${locator.signalPath}`;
    const quantitativeTrackId = createIndexedBbiTrackId({
      assemblyId: alignmentLane.assemblyId,
      source: { kind: 'url', url: durableSignalUrl },
    });
    const signalLane = byTrackId.get(quantitativeTrackId);
    if (!signalLane || signalLane.dataset.kind === 'pileup') continue;
    const pairKey = `${alignment.trackId}\0${quantitativeTrackId}`;
    if (existingPairs.has(pairKey)) continue;
    derived.push({
      assemblyId: alignmentLane.assemblyId,
      dataset: buildExperimentalHybridPileupDataset({
        alignment,
        signal: signalLane.dataset,
      }),
    });
  }
  return derived;
}

export function buildHybridPileupCoverage(
  sourceRecords: ReadonlyArray<QuantitativeBin>,
  sourceRevision: string
): CoverageSignal | undefined {
  const records = sourceRecords
    .filter(
      (record) =>
        Number.isFinite(record.start) &&
        Number.isFinite(record.end) &&
        Number.isFinite(record.value) &&
        record.end > record.start
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (records.length === 0) return undefined;
  const sourceStart = records[0]!.start;
  const sourceEnd = records.reduce((end, record) => Math.max(end, record.end), sourceStart);
  const sourceSpan = sourceEnd - sourceStart;
  if (!(sourceSpan > 0)) return undefined;
  const smallestRecordSpan = records.reduce(
    (smallest, record) => Math.min(smallest, record.end - record.start),
    Number.POSITIVE_INFINITY
  );
  const binSize = Math.max(
    1,
    Math.ceil(smallestRecordSpan),
    Math.ceil(sourceSpan / MAX_HYBRID_COVERAGE_BINS)
  );
  const startBp = Math.floor(sourceStart / binSize) * binSize;
  const endBp = Math.ceil(sourceEnd / binSize) * binSize;
  const binCount = Math.max(1, Math.ceil((endBp - startBp) / binSize));
  const weightedValues = new Float64Array(binCount);
  const weights = new Float64Array(binCount);
  for (const record of records) {
    const first = Math.max(0, Math.floor((record.start - startBp) / binSize));
    const last = Math.min(binCount, Math.ceil((record.end - startBp) / binSize));
    for (let index = first; index < last; index += 1) {
      const binStart = startBp + index * binSize;
      const overlap = Math.max(
        0,
        Math.min(record.end, binStart + binSize) - Math.max(record.start, binStart)
      );
      if (overlap <= 0) continue;
      weightedValues[index] += record.value * overlap;
      weights[index] += overlap;
    }
  }
  const bins = new Array<number>(binCount);
  let maxDepth = 0;
  for (let index = 0; index < binCount; index += 1) {
    const value = weights[index]! > 0 ? weightedValues[index]! / weights[index]! : 0;
    bins[index] = value;
    if (value > maxDepth) maxDepth = value;
  }
  const sourceTrackId = sourceRevision.split(':', 1)[0] ?? sourceRevision;
  return {
    coverageRevision: `hybrid-bigwig:${sourceRevision}`,
    startBp,
    bins,
    binSize,
    maxDepth,
    provenance: {
      exact: true,
      method: 'bigwig-pileup-height-map',
      source: sourceTrackId,
      sourceBinSize: binSize,
    },
  };
}

export class ExperimentalHybridPileupPublisher {
  private definitions: ReadonlyArray<ExperimentalHybridPileupDefinition>;
  private readonly target: ExperimentalHybridPileupTarget;
  private readonly quantitativeByTrackId = new Map<string, CoverageSignal | undefined>();
  private readonly histogramPendingByTrackId = new Map<
    string,
    ReadonlyArray<PileupReferenceInterval>
  >();
  private readonly alignmentByTrackId = new Map<string, PileupTrackData>();

  constructor(input: {
    readonly definitions: ReadonlyArray<ExperimentalHybridPileupDefinition>;
    readonly target: ExperimentalHybridPileupTarget;
  }) {
    this.definitions = input.definitions;
    this.target = input.target;
  }

  updateDefinitions(definitions: ReadonlyArray<ExperimentalHybridPileupDefinition>): void {
    this.definitions = definitions;
    this.replay();
  }

  publishQuantitative(
    trackId: string,
    records: ReadonlyArray<QuantitativeBin>,
    revision: string
  ): void {
    this.histogramPendingByTrackId.set(trackId, []);
    this.quantitativeByTrackId.set(
      trackId,
      buildHybridPileupCoverage(records, `${trackId}:${revision}`)
    );
    this.publishForQuantitativeTrack(trackId);
  }

  publishHistogramPendingIntervals(
    trackId: string,
    intervals: ReadonlyArray<PileupReferenceInterval>
  ): void {
    const previous = this.histogramPendingByTrackId.get(trackId);
    if (
      previous &&
      previous.length === intervals.length &&
      previous.every(
        (interval, index) =>
          interval.startBp === intervals[index]?.startBp &&
          interval.endBp === intervals[index]?.endBp
      )
    )
      return;
    this.histogramPendingByTrackId.set(trackId, intervals);
    this.publishForQuantitativeTrack(trackId);
  }

  publishAlignment(trackId: string, data: PileupTrackData): void {
    this.alignmentByTrackId.set(trackId, data);
    this.publishForAlignmentTrack(trackId);
  }

  replay(): void {
    for (const definition of this.definitions) this.publish(definition);
  }

  private publishForQuantitativeTrack(trackId: string): void {
    for (const definition of this.definitions) {
      if (definition.quantitativeTrackId === trackId) this.publish(definition);
    }
  }

  private publishForAlignmentTrack(trackId: string): void {
    for (const definition of this.definitions) {
      if (definition.alignmentTrackId === trackId) this.publish(definition);
    }
  }

  private publish(definition: ExperimentalHybridPileupDefinition): void {
    const renderer = this.target.getRenderer();
    if (!renderer?.hasTrackInstance(definition.trackId)) return;
    const alignment = this.alignmentByTrackId.get(definition.alignmentTrackId);
    const coverage = this.quantitativeByTrackId.get(definition.quantitativeTrackId);
    const readsLoading =
      alignment == null ||
      alignment.referenceIntervals?.some((interval) => interval.state === 'pending') === true;
    renderer.setTrackData(definition.trackId, {
      dataAuthority: 'static',
      records: alignment?.records ?? [],
      ...(coverage ? { coverage } : {}),
      ...(alignment?.alternateColumns ? { alternateColumns: alignment.alternateColumns } : {}),
      ...(alignment?.readSource ? { readSource: alignment.readSource } : {}),
      ...(alignment?.referenceIntervals
        ? { referenceIntervals: alignment.referenceIntervals }
        : {}),
      coverageCutoffDepth: definition.coverageCutoffDepth,
      experimentalReadHandoff: {
        kind: 'bigwig-height-morph-to-reads',
        morphDurationMs: EXPERIMENTAL_HYBRID_MORPH_DURATION_MS,
        readsLoading,
        histogramPendingIntervals:
          this.histogramPendingByTrackId.get(definition.quantitativeTrackId) ?? [],
        loadingAnimation: definition.loadingAnimation,
      },
    });
    this.target.requestRender();
  }
}
