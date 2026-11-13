import {
  assertQuantitativeTransformCompatible,
  createIndexedBbiTrackId,
  type IndexedBbiTrackSource,
} from '@waypoint/genome-data';

import type { AlignmentReferenceIdentity } from './alignment-header-client';
import { quantitativeIndexedBigWigDataset } from './attach-indexed-bigwig';
import { getBbiReaderWorkerClient } from './bbi-reader-runtime';
import { assertBbiReferencesCompatible } from './bbi-reference-compatibility';
import { summarizeBbiQuantitativeSource } from './bbi-quantitative-source-summary';
import { useLaneContractStore } from './lane-contract-store';
import { directRemoteSignalGrant, isTrustedRemoteSignalUrl } from './remote-signal-url';
import type { BbiReferenceInfo } from './bbi-reader-worker-protocol';
import type { ActiveStressDataset } from './lane-contract-store';
import { registerRemoteSessionLease } from './remote-session-release';
import { isRemoteSignalLocator, remoteSignalSourceId } from './remote-signal-url';

const PRIMARY_CHROMOSOME = /^(?:chr)?(?:[1-9]|1\d|2[0-2]|X|Y|M|MT)$/u;

export class RemoteSignalAdmissionCancelledError extends Error {
  constructor() {
    super('Remote histogram admission was cancelled.');
  }
}

export async function remoteSignalReferenceReceipt(input: {
  readonly assemblyId: string;
  readonly expected: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly actual: ReadonlyArray<BbiReferenceInfo>;
}) {
  const actualByName = new Map(input.actual.map((reference) => [reference.name, reference.length]));
  const mismatch = input.expected.find((reference) => {
    const length = actualByName.get(reference.name);
    return length !== undefined && length !== reference.length;
  });
  if (mismatch) {
    throw new Error(
      `BigWig reference mismatch for ${mismatch.name}: expected ${mismatch.length}, received ${actualByName.get(mismatch.name)}.`
    );
  }
  const missingPrimary = input.expected.find(
    (reference) => PRIMARY_CHROMOSOME.test(reference.name) && !actualByName.has(reference.name)
  );
  if (missingPrimary) {
    throw new Error(`BigWig is missing primary chromosome ${missingPrimary.name}.`);
  }
  const shared = input.expected.filter((reference) => actualByName.has(reference.name));
  if (shared.length === 0) {
    throw new Error('BigWig shares no chromosomes with this assembly.');
  }
  return assertBbiReferencesCompatible({
    assemblyId: input.assemblyId,
    expected: shared,
    actual: input.actual,
  });
}

export async function attachRemoteSignalBigWig(input: {
  readonly laneOwnerId: string;
  readonly assemblyId: string;
  readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly target: string;
  readonly signalPath: string;
  readonly bigWigUrl: string;
  readonly byteLength: number;
  readonly label?: string;
  readonly signal?: AbortSignal;
  readonly primaryTrack?: { readonly trackId: string; readonly sessionId: string };
  readonly trackId?: string;
  readonly remote?: ActiveStressDataset['remoteSignal'];
  readonly remoteConnection?: () => NonNullable<ActiveStressDataset['remoteSignal']>['connection'];
  readonly commit?: (publish: () => boolean) => boolean;
  readonly resumeCancelled?: boolean;
}): Promise<{ readonly trackId: string; readonly label: string }> {
  if (!isTrustedRemoteSignalUrl(input.bigWigUrl)) {
    throw new Error('The remote histogram URL is not a DNAForge SSH range endpoint.');
  }
  if (input.assemblyReferences.length === 0) {
    throw new Error('The reference assembly has no chromosome identity to verify this histogram.');
  }
  if (
    input.remote &&
    (!isRemoteSignalLocator(input.remote.locator) ||
      input.remote.locator.target !== input.target ||
      input.remote.locator.signalPath !== input.signalPath)
  ) {
    throw new Error('The remote histogram locator does not match the admitted signal.');
  }
  const durableUrl = `ssh://${input.target}${input.signalPath}`;
  const trackId =
    input.trackId ??
    createIndexedBbiTrackId({
      assemblyId: input.assemblyId,
      source: { kind: 'url', url: durableUrl },
    });
  const label = input.label?.trim() || signalLabel(input.signalPath);
  const fingerprint = ['remote-signal', durableUrl, input.bigWigUrl, input.byteLength].join(
    '\u0000'
  );
  const expectedValidators = { contentLength: input.byteLength };
  const originalSignalLane = useLaneContractStore
    .getState()
    .lanesForOwner(input.laneOwnerId)
    .find((lane) => lane.dataset.trackId === trackId);
  const originalSignalSource = originalSignalLane?.source;
  const requireCurrent = (): void => {
    const lanes = useLaneContractStore.getState().lanesForOwner(input.laneOwnerId);
    const primary = input.primaryTrack;
    const primarySessionId = primary
      ? lanes.find((lane) => lane.dataset.trackId === primary.trackId)?.dataset.source?.remote
          ?.sessionId
      : undefined;
    const currentSignalLane = lanes.find((lane) => lane.dataset.trackId === trackId);
    if (
      input.signal?.aborted ||
      (primary && primarySessionId !== primary.sessionId) ||
      currentSignalLane?.source !== originalSignalSource ||
      (currentSignalLane?.dataset.remoteSignal?.admissionCancelled && !input.resumeCancelled) ||
      (originalSignalLane && !currentSignalLane)
    ) {
      throw new RemoteSignalAdmissionCancelledError();
    }
  };
  requireCurrent();
  const reader = getBbiReaderWorkerClient();
  const header = await reader.open(
    fingerprint,
    'bigwig',
    directRemoteSignalGrant({ uri: input.bigWigUrl, fingerprint, expectedValidators })
  );
  let quantitativeSummary: IndexedBbiTrackSource['quantitativeSummary'];
  let referenceReceipt: IndexedBbiTrackSource['referenceReceipt'];
  try {
    if (header.fileType !== 'bigwig') {
      throw new Error(`The admitted source is ${header.fileType}, not BigWig.`);
    }
    referenceReceipt = await remoteSignalReferenceReceipt({
      assemblyId: input.assemblyId,
      expected: input.assemblyReferences,
      actual: header.references,
    });
    try {
      quantitativeSummary = await summarizeBbiQuantitativeSource({
        reader,
        sourceKey: fingerprint,
        header,
        signal: input.signal,
      });
    } catch {
      quantitativeSummary = undefined;
    }
  } finally {
    await reader.closeSource(fingerprint);
  }
  const source: IndexedBbiTrackSource = {
    admissionVersion: 1,
    uri: input.bigWigUrl,
    input: { kind: 'url', url: input.bigWigUrl },
    formatId: 'bigwig',
    recommendedTypes: ['quantitative'],
    fingerprint,
    readerKind: 'bbi',
    scientificKind: 'quantitative',
    quantitativeColumnSemantics: 'continuous-signal',
    ...(quantitativeSummary ? { quantitativeSummary } : {}),
    assemblyId: input.assemblyId,
    referenceReceipt,
    provenance: {
      provider: 'direct-url',
      sourceKind: 'remote-url',
      label,
    },
    expectedValidators,
  };

  requireCurrent();
  const store = useLaneContractStore.getState();
  const existing = store
    .lanesForOwner(input.laneOwnerId)
    .find((lane) => lane.dataset.trackId === trackId);
  if (existing?.dataset.quantitativePresentation) {
    assertQuantitativeTransformCompatible(
      existing.dataset.quantitativePresentation,
      quantitativeSummary,
      []
    );
  }
  const dataset = {
    ...quantitativeIndexedBigWigDataset({ trackId, label, source }),
    ...(input.remote
      ? {
          remoteSignal: {
            ...input.remote,
            ...(input.remoteConnection
              ? { connection: input.remoteConnection() }
              : input.primaryTrack
                ? {
                    connection: store
                      .lanesForOwner(input.laneOwnerId)
                      .find((lane) => lane.dataset.trackId === input.primaryTrack!.trackId)?.dataset
                      .source?.remote?.connection,
                  }
                : {}),
          },
        }
      : {}),
  };
  if (input.remote?.sessionId) {
    registerRemoteSessionLease({
      laneOwnerId: input.laneOwnerId,
      sessionId: input.remote.sessionId,
      sourceId: remoteSignalSourceId(input.bigWigUrl),
    });
  }
  const publish = (): boolean => {
    if (
      store.replaceLaneDataset(input.laneOwnerId, trackId, input.assemblyId, dataset, source) ===
      'missing'
    ) {
      return store.addLane(input.laneOwnerId, input.assemblyId, dataset, true, source) === 'added';
    }
    return true;
  };
  if (!(input.commit ? input.commit(publish) : publish()))
    throw new RemoteSignalAdmissionCancelledError();
  return { trackId, label };
}

function signalLabel(signalPath: string): string {
  const name = signalPath.split('/').pop()?.trim();
  return name && name.length > 0 ? name : 'Remote BigWig';
}
