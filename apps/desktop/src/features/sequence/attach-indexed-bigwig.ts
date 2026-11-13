import {
  DEFAULT_QUANTITATIVE_TRACK_PRESENTATION,
  createIndexedBbiTrackId,
  indexedBbiTrackLabel,
  type AdmittedTrackSource,
  type IndexedBbiTrackInput,
  type IndexedBbiTrackSource,
} from '@waypoint/genome-data';
import { BUILTIN_TRACK_TYPES, QUANTITATIVE_TYPE } from '@waypoint/genome-renderer';

import type { IndexedGenomeTabState } from '../../shared/indexed-genome';
import type { AlignmentReferenceIdentity } from './alignment-header-client';
import { assemblyContigNaming } from './contig-name-map';
import { admitIndexedBigWigSource } from './indexed-track-admission';
import { useLaneContractStore, type ActiveStressDataset } from './lane-contract-store';

export const INDEXED_BIGWIG_LANE_COLOR = 0x3b82f6;

export interface AttachIndexedBigWigInput {
  readonly laneOwnerId: string;
  readonly assemblyId: string;
  readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly source: IndexedBbiTrackInput;
  readonly label?: string;
  readonly admit?: typeof admitIndexedBigWigSource;
}

export interface AttachIndexedBigWigResult {
  readonly status: 'added' | 'duplicate';
  readonly trackId: string;
  readonly label: string;
  readonly source?: IndexedBbiTrackSource;
}

const pendingAttachments = new Map<string, Promise<AttachIndexedBigWigResult>>();

export function assemblyIdFromIndexedGenome(genome: IndexedGenomeTabState): string {
  return genome.assembly?.assemblyId ?? genome.chrom;
}

export function assemblyReferencesFromIndexedGenome(
  genome: IndexedGenomeTabState
): AlignmentReferenceIdentity[] {
  const assemblyChromosomes = genome.assembly?.chromosomes ?? [];
  if (assemblyChromosomes.length > 0) {
    return [...assemblyContigNaming(assemblyChromosomes)];
  }
  const length = genome.manifest?.length ?? genome.metadata?.length;
  if (typeof length === 'number' && Number.isFinite(length) && length > 0) {
    return [{ name: genome.chrom, length }];
  }
  return [];
}

export function quantitativeIndexedBigWigDataset(input: {
  readonly trackId: string;
  readonly label: string;
  readonly source?: AdmittedTrackSource;
}): ActiveStressDataset {
  return {
    trackType: BUILTIN_TRACK_TYPES.quantitative,
    trackId: input.trackId,
    label: input.label,
    color: INDEXED_BIGWIG_LANE_COLOR,
    laneHeightPx: 8,
    maxLanes: 32,
    trackPx:
      QUANTITATIVE_TYPE.defaultSizing.kind === 'fixed'
        ? QUANTITATIVE_TYPE.defaultSizing.pixels
        : 96,
    records: [],
    kind: 'annotation',
    quantitativePresentation: DEFAULT_QUANTITATIVE_TRACK_PRESENTATION,
    ...(input.source?.quantitativeSummary
      ? { quantitativeSourceSummary: input.source.quantitativeSummary }
      : {}),
  };
}

export async function attachIndexedBigWig(
  input: AttachIndexedBigWigInput
): Promise<AttachIndexedBigWigResult> {
  const trackId = createIndexedBbiTrackId({
    assemblyId: input.assemblyId,
    source: input.source,
  });
  const label = input.label?.trim() || indexedBbiTrackLabel(input.source);
  const existing = useLaneContractStore
    .getState()
    .lanesForOwner(input.laneOwnerId)
    .find((lane) => lane.dataset.trackId === trackId);
  if (existing) {
    return { status: 'duplicate', trackId, label: existing.dataset.label };
  }

  const pendingKey = `${input.laneOwnerId}\u0000${trackId}`;
  const pending = pendingAttachments.get(pendingKey);
  if (pending) {
    await pending;
    const durableLabel = useLaneContractStore
      .getState()
      .lanesForOwner(input.laneOwnerId)
      .find((lane) => lane.dataset.trackId === trackId)?.dataset.label;
    if (!durableLabel) {
      throw new Error(`Indexed BigWig ${trackId} completed admission without a durable lane.`);
    }
    return { status: 'duplicate', trackId, label: durableLabel };
  }

  const attachment = admitAndAttachIndexedBigWig(input, trackId, label);
  pendingAttachments.set(pendingKey, attachment);
  try {
    return await attachment;
  } finally {
    if (pendingAttachments.get(pendingKey) === attachment) {
      pendingAttachments.delete(pendingKey);
    }
  }
}

async function admitAndAttachIndexedBigWig(
  input: AttachIndexedBigWigInput,
  trackId: string,
  label: string
): Promise<AttachIndexedBigWigResult> {
  const admit = input.admit ?? admitIndexedBigWigSource;
  const source = await admit({
    assemblyId: input.assemblyId,
    assemblyReferences: input.assemblyReferences,
    source: input.source,
    label,
  });
  const status = useLaneContractStore
    .getState()
    .addLane(
      input.laneOwnerId,
      input.assemblyId,
      quantitativeIndexedBigWigDataset({ trackId, label, source }),
      true,
      source
    );
  const durableLabel =
    status === 'duplicate'
      ? (useLaneContractStore
          .getState()
          .lanesForOwner(input.laneOwnerId)
          .find((lane) => lane.dataset.trackId === trackId)?.dataset.label ?? label)
      : label;
  return { status, trackId, label: durableLabel, source };
}
