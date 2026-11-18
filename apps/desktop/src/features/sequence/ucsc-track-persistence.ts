import {
  DEFAULT_QUANTITATIVE_TRACK_PRESENTATION,
  assertQuantitativeTransformCompatible,
  isCurrentAdmittedTrackSource,
  isQuantitativeSourceSummaryV1,
  isIndexedBbiTrackSource,
  isTextIntervalTrackSource,
  isUcscTrackSource,
  normalizeQuantitativeTrackPresentation,
  sameAdmittedTrackSourceIdentity,
} from '@waypoint/genome-data';
import type { IndexedGenomeDataTrackState } from '../../shared/indexed-genome';
import type { Lane } from './lane-contract-store';
import {
  durableRemoteSignalUri,
  isRemoteSignalLocator,
  isTrustedRemoteSignalUrl,
  sameRemoteSignalLocator,
} from './remote-signal-url';
import { ucscTrackTargetForAssembly } from './ucsc-assembly-alias';

export function laneFromIndexedGenomeDataTrack(
  persisted: IndexedGenomeDataTrackState,
  expectedAssemblyId: string
): Lane {
  requirePersistedDataTrack(persisted, expectedAssemblyId);
  return {
    assemblyId: expectedAssemblyId,
    order: persistedTrackOrder(persisted.order),
    visible: persisted.visible,
    dataset: {
      trackId: persisted.trackId,
      trackType: persisted.trackType,
      label: persisted.label,
      color: persisted.color,
      trackPx: persisted.trackPx,
      laneHeightPx: persisted.laneHeightPx,
      maxLanes: persisted.maxLanes,
      records: [],
      kind: 'annotation',
      ...(persisted.source.scientificKind === 'quantitative'
        ? {
            quantitativePresentation: normalizeQuantitativeTrackPresentation(
              persisted.quantitativePresentation
            ),
            ...(persisted.source.quantitativeSummary
              ? { quantitativeSourceSummary: persisted.source.quantitativeSummary }
              : {}),
          }
        : {}),
      ...(persisted.remoteSignal
        ? {
            remoteSignal: {
              locator: persisted.remoteSignal,
              durableSource: persisted.source,
              admissionError: 'Opening the SSH histogram…',
            },
          }
        : {}),
    },
    ...(persisted.remoteSignal ? {} : { source: { ...persisted.source } }),
  };
}

export function indexedGenomeDataTrackFromLane(lane: Lane): IndexedGenomeDataTrackState | null {
  const { dataset } = lane;
  const liveSource = lane.source ?? dataset.remoteSignal?.durableSource;
  if (dataset.kind === 'pileup' || dataset.kind === 'variant' || !liveSource) return null;
  if (
    !isUcscTrackSource(liveSource) &&
    !isIndexedBbiTrackSource(liveSource) &&
    !isTextIntervalTrackSource(liveSource)
  ) {
    return null;
  }
  const remoteSignal = dataset.remoteSignal?.locator;
  if (remoteSignal && !isRemoteSignalLocator(remoteSignal)) return null;
  if (isTunnelScopedRemoteSignalSource(liveSource) && !remoteSignal) return null;
  const source = remoteSignal
    ? durableRemoteSignalSource(liveSource, remoteSignal, dataset.label)
    : { ...liveSource };
  return {
    trackId: dataset.trackId,
    trackType: dataset.trackType,
    label: dataset.label,
    order: lane.order,
    color: dataset.color,
    trackPx: dataset.trackPx,
    laneHeightPx: dataset.laneHeightPx ?? 8,
    maxLanes: dataset.maxLanes ?? 32,
    visible: lane.visible,
    ...(source.scientificKind === 'quantitative'
      ? {
          quantitativePresentation:
            dataset.quantitativePresentation ?? DEFAULT_QUANTITATIVE_TRACK_PRESENTATION,
        }
      : {}),
    source,
    ...(remoteSignal ? { remoteSignal: { ...remoteSignal } } : {}),
  };
}

export function indexedGenomeDataTracksEqual(
  left: readonly IndexedGenomeDataTrackState[],
  right: readonly IndexedGenomeDataTrackState[]
): boolean {
  return (
    left.length === right.length &&
    left.every((track, index) => {
      const peer = right[index];
      return (
        peer != null &&
        track.trackId === peer.trackId &&
        track.trackType === peer.trackType &&
        track.label === peer.label &&
        track.order === peer.order &&
        track.color === peer.color &&
        track.trackPx === peer.trackPx &&
        track.laneHeightPx === peer.laneHeightPx &&
        track.maxLanes === peer.maxLanes &&
        track.visible === peer.visible &&
        sameRemoteSignalLocator(track.remoteSignal, peer.remoteSignal) &&
        sameQuantitativePresentation(
          track.quantitativePresentation,
          peer.quantitativePresentation
        ) &&
        sameQuantitativeSummary(
          track.source.quantitativeSummary,
          peer.source.quantitativeSummary
        ) &&
        sameAdmittedTrackSourceIdentity(track.source, peer.source)
      );
    })
  );
}

function requirePersistedDataTrack(
  value: IndexedGenomeDataTrackState,
  expectedAssemblyId: string
): asserts value is IndexedGenomeDataTrackState {
  if (!value || typeof value !== 'object') throw new Error('Invalid persisted data track.');
  if (
    !value.source ||
    (!isUcscTrackSource(value.source) &&
      !isIndexedBbiTrackSource(value.source) &&
      !isTextIntervalTrackSource(value.source))
  ) {
    throw new Error('Persisted data track has no supported indexed source.');
  }
  if (isTunnelScopedRemoteSignalSource(value.source)) {
    throw new Error('A tunnel-scoped remote histogram cannot be restored independently.');
  }
  if (value.remoteSignal) {
    const uri = durableRemoteSignalUri(value.remoteSignal);
    if (
      !isRemoteSignalLocator(value.remoteSignal) ||
      value.source.readerKind !== 'bbi' ||
      value.source.formatId !== 'bigwig' ||
      value.source.scientificKind !== 'quantitative' ||
      value.source.admissionVersion !== 1 ||
      value.source.uri !== uri ||
      value.source.input?.kind !== 'url' ||
      value.source.input.url !== uri ||
      value.source.fingerprint !== ['remote-signal', uri].join('\0')
    ) {
      throw new Error('Persisted SSH histogram has an invalid durable signal source.');
    }
  } else if (value.source.uri.startsWith('ssh://')) {
    throw new Error('Persisted SSH histogram is missing its durable signal locator.');
  }
  if (
    (value.source.admissionVersion !== 1 && value.source.admissionVersion !== 2) ||
    value.source.referenceReceipt?.status !== 'compatible'
  ) {
    throw new Error('Persisted data track has no compatible admission receipt.');
  }
  if (value.source.admissionVersion === 2 && !isCurrentAdmittedTrackSource(value.source)) {
    throw new Error('Persisted data track has an invalid current admission request.');
  }
  for (const [field, candidate] of [
    ['trackId', value.trackId],
    ['trackType', value.trackType],
    ['label', value.label],
    ['source fingerprint', value.source.fingerprint],
    ['source URI', value.source.uri],
    ['source reader', value.source.readerKind],
    ['source assembly', value.source.assemblyId],
    ['receipt assembly', value.source.referenceReceipt.assemblyId],
  ] as const) {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new Error(`Persisted data track has invalid ${field}.`);
    }
  }
  if (value.source.assemblyId !== expectedAssemblyId) {
    throw new Error(
      `Persisted data track ${value.label} belongs to assembly ${value.source.assemblyId}, not ${expectedAssemblyId}.`
    );
  }
  if (value.source.referenceReceipt.assemblyId !== expectedAssemblyId) {
    throw new Error(
      `Persisted data track ${value.label} receipt belongs to assembly ${value.source.referenceReceipt.assemblyId}, not ${expectedAssemblyId}.`
    );
  }
  if (isUcscTrackSource(value.source)) {
    for (const [field, candidate] of [
      ['source track', value.source.provenance.track],
      ['source genome', value.source.provenance.ucscGenome],
    ] as const) {
      if (typeof candidate !== 'string' || !candidate.trim()) {
        throw new Error(`Persisted UCSC track has invalid ${field}.`);
      }
    }
    if (value.source.provenance.sourceKind === 'ucsc-hub') {
      const hubUrl = value.source.provenance.hubUrl;
      if (typeof hubUrl !== 'string' || !/^https?:\/\/[^\s/]+/iu.test(hubUrl.trim())) {
        throw new Error(`Persisted hub track ${value.label} has an invalid hub URL.`);
      }
    } else {
      const expectedUcscTarget = ucscTrackTargetForAssembly(expectedAssemblyId);
      if (!expectedUcscTarget) {
        throw new Error(`UCSC loading is not mapped for assembly ${expectedAssemblyId}.`);
      }
      if (value.source.provenance.ucscGenome !== expectedUcscTarget.genomeId) {
        throw new Error(
          `DNAForge assembly ${expectedAssemblyId} maps to UCSC genome ${expectedUcscTarget.genomeId}, not ${value.source.provenance.ucscGenome}.`
        );
      }
      if (value.source.provenance.hubUrl !== expectedUcscTarget.hubUrl) {
        throw new Error(
          `Persisted UCSC track for assembly ${expectedAssemblyId} belongs to a different catalog target.`
        );
      }
    }
  }
  if (typeof value.visible !== 'boolean') {
    throw new Error(`Persisted data track ${value.label} has invalid visibility.`);
  }
  if (
    value.order !== undefined &&
    (!Number.isSafeInteger(value.order) || (value.order ?? -1) < 0)
  ) {
    throw new Error(`Persisted data track ${value.label} has an invalid order.`);
  }
  if (
    typeof value.color !== 'number' ||
    !Number.isInteger(value.color) ||
    value.color < 0 ||
    value.color > 0xff_ffff
  ) {
    throw new Error(`Persisted data track ${value.label} has an invalid color.`);
  }
  for (const [field, candidate] of [
    ['track height', value.trackPx],
    ['lane height', value.laneHeightPx],
  ] as const) {
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) {
      throw new Error(`Persisted data track ${value.label} has an invalid ${field}.`);
    }
  }
  if (
    typeof value.maxLanes !== 'number' ||
    !Number.isInteger(value.maxLanes) ||
    value.maxLanes <= 0
  ) {
    throw new Error(`Persisted data track ${value.label} has an invalid lane limit.`);
  }
  if (
    value.source.quantitativeSummary !== undefined &&
    !isQuantitativeSourceSummaryV1(value.source.quantitativeSummary)
  ) {
    throw new Error(`Persisted data track ${value.label} has an invalid source summary.`);
  }
  if (value.quantitativePresentation !== undefined) {
    if (value.source.scientificKind !== 'quantitative') {
      throw new Error(`Persisted data track ${value.label} has settings for the wrong track type.`);
    }
    const presentation = normalizeQuantitativeTrackPresentation(value.quantitativePresentation);
    assertQuantitativeTransformCompatible(presentation, value.source.quantitativeSummary, []);
  }
}

function isTunnelScopedRemoteSignalSource(source: NonNullable<Lane['source']>): boolean {
  return (
    isIndexedBbiTrackSource(source) &&
    source.input.kind === 'url' &&
    isTrustedRemoteSignalUrl(source.uri) &&
    isTrustedRemoteSignalUrl(source.input.url) &&
    source.fingerprint.startsWith('remote-signal\u0000ssh://')
  );
}

function durableRemoteSignalSource(
  source: NonNullable<Lane['source']>,
  locator: NonNullable<IndexedGenomeDataTrackState['remoteSignal']>,
  label: string
): NonNullable<Lane['source']> {
  const uri = durableRemoteSignalUri(locator);
  return {
    admissionVersion: 1,
    uri,
    input: { kind: 'url', url: uri },
    formatId: 'bigwig',
    recommendedTypes: ['quantitative'],
    fingerprint: ['remote-signal', uri].join('\0'),
    readerKind: 'bbi',
    scientificKind: 'quantitative',
    quantitativeColumnSemantics: 'continuous-signal',
    ...(source.quantitativeSummary ? { quantitativeSummary: source.quantitativeSummary } : {}),
    assemblyId: source.assemblyId,
    referenceReceipt: { ...source.referenceReceipt },
    provenance: { provider: 'direct-url', sourceKind: 'remote-url', label },
  };
}

function sameQuantitativePresentation(
  left: IndexedGenomeDataTrackState['quantitativePresentation'],
  right: IndexedGenomeDataTrackState['quantitativePresentation']
): boolean {
  const a = normalizeQuantitativeTrackPresentation(left);
  const b = normalizeQuantitativeTrackPresentation(right);
  return (
    a.version === b.version &&
    a.graph === b.graph &&
    a.palette === b.palette &&
    a.showRange === b.showRange &&
    (a.smoothingSigmaBins ?? 0) === (b.smoothingSigmaBins ?? 0) &&
    a.scale.mode === b.scale.mode &&
    a.scale.transform === b.scale.transform &&
    a.scale.min === b.scale.min &&
    a.scale.max === b.scale.max &&
    a.scale.groupId === b.scale.groupId
  );
}

function sameQuantitativeSummary(
  left: IndexedGenomeDataTrackState['source']['quantitativeSummary'],
  right: IndexedGenomeDataTrackState['source']['quantitativeSummary']
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.contract === right.contract &&
    left.algorithm === right.algorithm &&
    left.targetSampleCount === right.targetSampleCount &&
    left.sampleCount === right.sampleCount &&
    left.lowerQuantile === right.lowerQuantile &&
    left.upperQuantile === right.upperQuantile &&
    left.robustMin === right.robustMin &&
    left.robustMax === right.robustMax &&
    left.fullMin === right.fullMin &&
    left.fullMax === right.fullMax &&
    left.missingData === right.missingData
  );
}

function persistedTrackOrder(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
