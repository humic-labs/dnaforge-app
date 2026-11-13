import { platform } from '../../platform';
import { useLaneContractStore, type Lane } from './lane-contract-store';
import { remoteAlignmentSourceId, remoteSignalSourceId } from './remote-signal-url';
import { releaseRemoteTileSessionWhenDrained } from './remote-tile-session-drain';

interface PendingRemoteSessionRelease {
  phase: 'draining-transport' | 'waiting-for-lane-release';
  disconnect: () => void;
  unsubscribeFromLanes: (() => void) | null;
}

const pendingReleases = new Map<string, PendingRemoteSessionRelease>();
const leaseSources = new Map<string, { readonly laneOwnerId: string; readonly sourceId: string }>();

export function registerRemoteSessionLease(input: {
  readonly laneOwnerId: string;
  readonly sessionId: string;
  readonly sourceId: string | null | undefined;
}): void {
  if (!input.sourceId) return;
  leaseSources.set(input.sessionId, { laneOwnerId: input.laneOwnerId, sourceId: input.sourceId });
}

export function forgetRemoteSessionLease(sessionId: string): void {
  leaseSources.delete(sessionId);
}

function laneReferencesRemoteSession(lane: Lane, sessionId: string, sourceId?: string): boolean {
  return (
    lane.dataset.source?.remote?.sessionId === sessionId ||
    lane.dataset.remoteSignal?.sessionId === sessionId ||
    (sourceId !== undefined && remoteSignalSourceId(lane.source?.uri ?? '') === sourceId)
  );
}

function retireSupersededSourceBinding(sessionId: string): void {
  const lease = leaseSources.get(sessionId);
  if (!lease) return;
  const lanes = useLaneContractStore.getState().lanesForOwner(lease.laneOwnerId);
  if (lanes.some((lane) => lane.dataset.source?.remote?.sessionId === sessionId)) return;
  const publishedReplacement = lanes.find((lane) => {
    const source = lane.dataset.source;
    const replacementId = source?.remote?.sessionId ?? lane.dataset.remoteSignal?.sessionId;
    if (replacementId === sessionId) return false;
    const replacement = replacementId ? leaseSources.get(replacementId) : undefined;
    return (
      replacement?.laneOwnerId === lease.laneOwnerId &&
      replacement.sourceId === lease.sourceId &&
      (lane.dataset.kind === 'pileup'
        ? remoteAlignmentSourceId(source?.bamPath ?? '')
        : remoteSignalSourceId(lane.source?.uri ?? '')) === lease.sourceId
    );
  });
  if (publishedReplacement) {
    leaseSources.delete(sessionId);
    const replacementId =
      publishedReplacement.dataset.source?.remote?.sessionId ??
      publishedReplacement.dataset.remoteSignal?.sessionId;
    for (const lane of lanes) {
      const remote = lane.dataset.remoteSignal;
      if (
        remote?.sessionId !== sessionId ||
        remoteSignalSourceId(lane.source?.uri ?? '') !== lease.sourceId
      )
        continue;
      useLaneContractStore
        .getState()
        .replaceLaneDataset(
          lease.laneOwnerId,
          lane.dataset.trackId,
          lane.assemblyId,
          { ...lane.dataset, remoteSignal: { ...remote, sessionId: replacementId } },
          lane.source
        );
    }
  }
}

function anyLaneReferencesRemoteSession(sessionId: string): boolean {
  retireSupersededSourceBinding(sessionId);
  const lease = leaseSources.get(sessionId);
  if (lease) {
    return useLaneContractStore
      .getState()
      .lanesForOwner(lease.laneOwnerId)
      .some((lane) => laneReferencesRemoteSession(lane, sessionId, lease.sourceId));
  }
  return Object.values(useLaneContractStore.getState().lanesByOwnerId).some((lanes) =>
    lanes.some((lane) => laneReferencesRemoteSession(lane, sessionId))
  );
}

function requestTransportDrainWhenUnreferenced(
  sessionId: string,
  pending: PendingRemoteSessionRelease
): void {
  if (pendingReleases.get(sessionId) !== pending) return;
  if (anyLaneReferencesRemoteSession(sessionId)) return;
  pending.unsubscribeFromLanes?.();
  pending.unsubscribeFromLanes = null;
  pending.phase = 'draining-transport';
  releaseRemoteTileSessionWhenDrained(sessionId, () => finishRelease(sessionId, pending));
}

function waitForLaneRelease(sessionId: string, pending: PendingRemoteSessionRelease): void {
  if (pendingReleases.get(sessionId) !== pending) return;
  pending.phase = 'waiting-for-lane-release';

  pending.unsubscribeFromLanes = useLaneContractStore.subscribe(() =>
    requestTransportDrainWhenUnreferenced(sessionId, pending)
  );
  requestTransportDrainWhenUnreferenced(sessionId, pending);
}

function finishRelease(sessionId: string, pending: PendingRemoteSessionRelease): void {
  if (pendingReleases.get(sessionId) !== pending) return;

  if (anyLaneReferencesRemoteSession(sessionId)) {
    waitForLaneRelease(sessionId, pending);
    return;
  }

  pending.unsubscribeFromLanes?.();
  pendingReleases.delete(sessionId);
  forgetRemoteSessionLease(sessionId);
  pending.disconnect();
}

export function disconnectRemoteSessionsAfterRendererDrain(sessionIds: Iterable<string>): void {
  const remoteApi = platform().remoteGenomics;
  if (!remoteApi) return;

  for (const sessionId of new Set(sessionIds)) {
    if (!sessionId) continue;
    retireSupersededSourceBinding(sessionId);
    const existing = pendingReleases.get(sessionId);
    if (existing) {
      if (existing.phase === 'waiting-for-lane-release') {
        requestTransportDrainWhenUnreferenced(sessionId, existing);
      }
      continue;
    }
    const pending: PendingRemoteSessionRelease = {
      phase: 'draining-transport',
      disconnect: () => {
        void remoteApi.disconnectSession(sessionId).catch(() => undefined);
      },
      unsubscribeFromLanes: null,
    };
    pendingReleases.set(sessionId, pending);
    releaseRemoteTileSessionWhenDrained(sessionId, () => finishRelease(sessionId, pending));
  }
}
