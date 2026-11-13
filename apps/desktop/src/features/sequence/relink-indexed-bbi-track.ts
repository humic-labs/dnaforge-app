import { isIndexedBbiTrackSource, requireTrackAdmissionRequest } from '@waypoint/genome-data';
import { useLaneContractStore } from './lane-contract-store';
import { admitIndexedBigBedRequest, admitIndexedBigWigRequest } from './indexed-track-admission';
import { datasetForAdmittedTrack } from './admitted-track-dataset';

export async function relinkIndexedBbiTrack(input: {
  ownerId: string;
  trackId: string;
  path: string;
  assemblyReferences: ReadonlyArray<{ name: string; length: number }>;
}): Promise<void> {
  const state = useLaneContractStore.getState();
  const lane = state.lanesByOwnerId[input.ownerId]?.find(
    (candidate) => candidate.dataset.trackId === input.trackId
  );
  const source = lane?.source;
  if (!lane || !source || !isIndexedBbiTrackSource(source) || source.input?.kind !== 'path')
    throw new Error('This local track is no longer available for relinking.');
  const request = {
    ...requireTrackAdmissionRequest(source),
    source: { kind: 'local-file' as const, path: input.path },
  };
  const replacement = await (
    source.formatId === 'bigwig' ? admitIndexedBigWigRequest : admitIndexedBigBedRequest
  )({ request, assemblyReferences: input.assemblyReferences });
  const current = useLaneContractStore
    .getState()
    .lanesByOwnerId[
      input.ownerId
    ]?.find((candidate) => candidate.dataset.trackId === input.trackId);
  if (current?.source !== source)
    throw new Error('The track changed while its replacement file was being checked.');
  useLaneContractStore.getState().replaceLaneDataset(
    input.ownerId,
    input.trackId,
    replacement.assemblyId,
    datasetForAdmittedTrack({
      trackId: input.trackId,
      label: current.dataset.label,
      source: replacement,
    }),
    replacement
  );
}
