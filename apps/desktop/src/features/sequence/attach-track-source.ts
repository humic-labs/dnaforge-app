import type { LocalAuthorityContext } from '../../shared/local-indexed-track-authority';
import {
  createTrackAdmissionRequestId,
  trackAdmissionRequestLabel,
  type AdmittedTrackSource,
  type TrackAdmissionRequestV1,
} from '@waypoint/genome-data';

import type { AlignmentReferenceIdentity } from './alignment-header-client';
import { datasetForAdmittedTrack } from './admitted-track-dataset';
import { useLaneContractStore } from './lane-contract-store';
import { admitTrackSource, resolveTrackAdmissionRequest } from './track-admission';

export interface AttachTrackAdmissionRequestInput {
  readonly laneOwnerId: string;
  readonly assemblyId: string;
  readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly request: TrackAdmissionRequestV1;
  readonly signal?: AbortSignal;
  readonly localAuthorityContext?: LocalAuthorityContext;
  readonly admit?: typeof admitTrackSource;
}

export interface AttachTrackAdmissionRequestResult {
  readonly status: 'added' | 'duplicate';
  readonly trackId: string;
  readonly label: string;
  readonly source?: AdmittedTrackSource;
}

const pendingAttachments = new Map<string, Promise<AttachTrackAdmissionRequestResult>>();

export async function attachTrackAdmissionRequest(
  input: AttachTrackAdmissionRequestInput
): Promise<AttachTrackAdmissionRequestResult> {
  const request = resolveTrackAdmissionRequest(input.request, input.assemblyId);
  const trackId = createTrackAdmissionRequestId(request);
  const label = trackAdmissionRequestLabel(request);
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
      throw new Error(`Track ${trackId} completed admission without a durable lane.`);
    }
    return { status: 'duplicate', trackId, label: durableLabel };
  }

  const attachment = admitAndAttach(input, request, trackId, label);
  pendingAttachments.set(pendingKey, attachment);
  try {
    return await attachment;
  } finally {
    if (pendingAttachments.get(pendingKey) === attachment) pendingAttachments.delete(pendingKey);
  }
}

async function admitAndAttach(
  input: AttachTrackAdmissionRequestInput,
  request: TrackAdmissionRequestV1,
  trackId: string,
  label: string
): Promise<AttachTrackAdmissionRequestResult> {
  const admit = input.admit ?? admitTrackSource;
  const source = await admit({
    request,
    assemblyId: input.assemblyId,
    assemblyReferences: input.assemblyReferences,
    signal: input.signal,
    localAuthorityContext: input.localAuthorityContext,
  });
  if (source.assemblyId !== input.assemblyId || source.referenceReceipt.status !== 'compatible') {
    throw new Error('Track admission did not return a compatible source for the open assembly.');
  }
  let dataset;
  try {
    dataset = datasetForAdmittedTrack({ trackId, label, source });
  } catch {
    throw new Error(
      `The admitted ${source.formatId} ${source.scientificKind} source has no attachment adapter.`
    );
  }

  const status = useLaneContractStore
    .getState()
    .addLane(input.laneOwnerId, input.assemblyId, dataset, true, source);
  const durableLabel =
    status === 'duplicate'
      ? (useLaneContractStore
          .getState()
          .lanesForOwner(input.laneOwnerId)
          .find((lane) => lane.dataset.trackId === trackId)?.dataset.label ?? label)
      : label;
  return { status, trackId, label: durableLabel, source };
}
