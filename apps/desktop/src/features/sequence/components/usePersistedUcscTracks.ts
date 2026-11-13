import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { sameAdmittedTrackSourceIdentity } from '@waypoint/genome-data';

import { platform } from '../../../platform';
import type {
  IndexedGenomeBamTrackState,
  IndexedGenomeDataTrackState,
} from '../../../shared/indexed-genome';
import type { RemoteGenomicsRuntimeStatusV1 } from '../../../shared/remote-genomics-ipc';
import type { AlignmentReferenceIdentity } from '../alignment-header-client';
import {
  attachRemoteSignalBigWig,
  RemoteSignalAdmissionCancelledError,
} from '../attach-remote-signal-bigwig';
import {
  remotePileupConnectionFromStatus,
  remoteReconnectFailureMessage,
} from '../bam-track-persistence';
import {
  indexedGenomeDataTrackFromLane,
  indexedGenomeDataTracksEqual,
  laneFromIndexedGenomeDataTrack,
} from '../ucsc-track-persistence';
import { useLaneContractStore, type Lane } from '../lane-contract-store';
import {
  disconnectRemoteSessionsAfterRendererDrain,
  forgetRemoteSessionLease,
  registerRemoteSessionLease,
} from '../remote-session-release';
import { remoteSignalSourceId, sameRemoteSignalLocator } from '../remote-signal-url';
import { recoverScenarioTrackSource } from '../recover-scenario-track-source';

const EMPTY_LANES: readonly Lane[] = [];
const EMPTY_REFERENCES: readonly AlignmentReferenceIdentity[] = [];
const EMPTY_BAM_TRACKS: readonly IndexedGenomeBamTrackState[] = [];
let signalRestoreSequence = 0;
const signalRestoreCancellations = new Map<
  string,
  { readonly laneOwnerId: string; readonly cancel: () => void }
>();

export function cancelRemoteSignalRestore(laneOwnerId: string, trackId?: string): void {
  for (const [key, pending] of signalRestoreCancellations) {
    if (
      pending.laneOwnerId === laneOwnerId &&
      (trackId === undefined || key === JSON.stringify([laneOwnerId, trackId]))
    )
      pending.cancel();
  }
}

export interface DataTrackRestoreIssue {
  readonly trackId: string;
  readonly label: string;
  readonly message: string;
  readonly kind?: 'remote-signal';
}

export type PersistedDataTrackUpdater = (
  previous: readonly IndexedGenomeDataTrackState[]
) => readonly IndexedGenomeDataTrackState[];

export function usePersistedDataTracks({
  laneOwnerId,
  assemblyId,
  persistedTracks,
  onChange,
  references = EMPTY_REFERENCES,
  pairedBamTracks = EMPTY_BAM_TRACKS,
  pairedSourcesReady = true,
}: {
  laneOwnerId: string;
  assemblyId: string;
  persistedTracks: readonly IndexedGenomeDataTrackState[];
  onChange: (update: PersistedDataTrackUpdater) => void;
  references?: readonly AlignmentReferenceIdentity[];
  pairedBamTracks?: readonly IndexedGenomeBamTrackState[];
  pairedSourcesReady?: boolean;
}): { status: 'restoring' | 'ready'; issues: readonly DataTrackRestoreIssue[] } {
  const ownedLanes = useLaneContractStore(
    (state) => state.lanesByOwnerId[laneOwnerId] ?? EMPTY_LANES
  );
  const persistedRef = useRef(persistedTracks);
  persistedRef.current = persistedTracks;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const ownerWasPresent = useRef(false);
  const runtimeStatuses = useRef(new Map<string, RemoteGenomicsRuntimeStatusV1>());
  const pairedRef = useRef(pairedBamTracks);
  pairedRef.current = pairedBamTracks;
  const referencesRef = useRef(references);
  referencesRef.current = references;
  const referencesIdentity = useMemo(
    () => JSON.stringify(references.map(({ name, length }) => [name, length])),
    [references]
  );
  const liveSessions = useRef(new Set<string>());
  const [status, setStatus] = useState<'restoring' | 'ready'>(
    persistedTracks.length > 0 ? 'restoring' : 'ready'
  );
  const [issues, setIssues] = useState<readonly DataTrackRestoreIssue[]>([]);
  const hasRemoteSignals =
    persistedTracks.some((track) => track.remoteSignal) ||
    ownedLanes.some((lane) => lane.dataset.remoteSignal);

  useEffect(
    () => () => {
      if (liveSessions.current.size > 0)
        disconnectRemoteSessionsAfterRendererDrain(liveSessions.current);
      liveSessions.current.clear();
    },
    [laneOwnerId]
  );

  useEffect(() => {
    ownerWasPresent.current = Object.prototype.hasOwnProperty.call(
      useLaneContractStore.getState().lanesByOwnerId,
      laneOwnerId
    );
    return useLaneContractStore.subscribe((state, before) => {
      if (!Object.prototype.hasOwnProperty.call(state.lanesByOwnerId, laneOwnerId)) return;
      ownerWasPresent.current = true;
      const lanes = state.lanesForOwner(laneOwnerId);
      const presentIds = new Set(lanes.map((lane) => lane.dataset.trackId));
      const removedIds = new Set(
        (before.lanesByOwnerId[laneOwnerId] ?? EMPTY_LANES)
          .filter((lane) => !presentIds.has(lane.dataset.trackId))
          .map((lane) => lane.dataset.trackId)
      );
      const live = lanes.flatMap((lane) => {
        const descriptor = indexedGenomeDataTrackFromLane(lane);
        return descriptor ? [descriptor] : [];
      });
      const liveById = new Map(live.map((track) => [track.trackId, track]));
      onChangeRef.current((previous) => {
        const next = previous.flatMap((track) =>
          removedIds.has(track.trackId) ? [] : [liveById.get(track.trackId) ?? track]
        );
        const ids = new Set(next.map((track) => track.trackId));
        next.push(...live.filter((track) => !ids.has(track.trackId)));
        return indexedGenomeDataTracksEqual(previous, next) ? previous : next;
      });
    });
  }, [laneOwnerId]);

  useEffect(() => {
    const sessions = new Set(
      ownedLanes.flatMap((lane) =>
        lane.dataset.remoteSignal?.sessionId ? [lane.dataset.remoteSignal.sessionId] : []
      )
    );
    const removed = [...liveSessions.current].filter((id) => !sessions.has(id));
    if (removed.length > 0) disconnectRemoteSessionsAfterRendererDrain(removed);
    liveSessions.current = sessions;
  }, [ownedLanes]);

  useEffect(() => {
    if (!hasRemoteSignals) return;
    const api = platform().remoteGenomics;
    if (!api?.subscribeStatus) return;
    return api.subscribeStatus(({ status: next }) => {
      const cached = runtimeStatuses.current.get(next.sourceId);
      if (!cached || cached.updatedAt <= next.updatedAt)
        runtimeStatuses.current.set(next.sourceId, next);
      const store = useLaneContractStore.getState();
      for (const lane of store.lanesForOwner(laneOwnerId)) {
        const remote = lane.dataset.remoteSignal;
        if (
          !remote ||
          remote.locator.target !== next.target ||
          remote.locator.signalPath !== next.signalPath
        )
          continue;
        const sourceId =
          remote.connection?.sourceId ?? remoteSignalSourceId(lane.source?.uri ?? '');
        if (sourceId && sourceId !== next.sourceId) continue;
        if (!sourceId && !remote.sessionId) continue;
        const current = remote.connection;
        if (
          current &&
          (current.updatedAt > next.updatedAt ||
            (current.updatedAt === next.updatedAt &&
              current.transportGeneration >= next.transportGeneration &&
              current.state === next.state))
        )
          continue;
        store.replaceLaneDataset(
          laneOwnerId,
          lane.dataset.trackId,
          assemblyId,
          {
            ...lane.dataset,
            remoteSignal: { ...remote, connection: remotePileupConnectionFromStatus(next) },
          },
          lane.source
        );
      }
    });
  }, [assemblyId, hasRemoteSignals, laneOwnerId]);

  useEffect(() => {
    let cancelled = false;
    const pending = new Set<() => void>();
    const waitingCancellations: {
      key: string;
      cancellation: { laneOwnerId: string; cancel: () => void };
    }[] = [];
    const snapshot = [...persistedRef.current];
    setIssues([]);
    setStatus(snapshot.length > 0 ? 'restoring' : 'ready');
    const nextIssues: DataTrackRestoreIssue[] = [];
    const restores: Promise<void>[] = [];
    let waiting = false;
    for (const persisted of snapshot) {
      try {
        const restored = laneFromIndexedGenomeDataTrack(persisted, assemblyId);
        const store = useLaneContractStore.getState();
        const existing = store
          .lanesForOwner(laneOwnerId)
          .find((lane) => lane.dataset.trackId === persisted.trackId);
        if (!existing)
          store.addLane(
            laneOwnerId,
            assemblyId,
            restored.dataset,
            restored.visible,
            restored.source,
            restored.order,
            'skip'
          );
        if (persisted.source.provenance.devScenarioFixture) {
          if (referencesRef.current.length === 0) {
            waiting = true;
            continue;
          }
          const original = store
            .lanesForOwner(laneOwnerId)
            .find((lane) => lane.dataset.trackId === persisted.trackId)!;
          const originalSource = original.source;
          if (!originalSource || !sameAdmittedTrackSourceIdentity(originalSource, persisted.source))
            continue;
          const controller = new AbortController();
          const cancel = () => controller.abort();
          const currentLane = () =>
            useLaneContractStore
              .getState()
              .lanesForOwner(laneOwnerId)
              .find((lane) => lane.dataset.trackId === persisted.trackId);
          const unsubscribe = useLaneContractStore.subscribe(() => {
            if (currentLane()?.source !== originalSource) cancel();
          });
          pending.add(cancel);
          restores.push(
            recoverScenarioTrackSource(originalSource, referencesRef.current, controller.signal)
              .then((source) => {
                const current = currentLane();
                if (
                  cancelled ||
                  controller.signal.aborted ||
                  current?.source !== originalSource ||
                  source === originalSource
                )
                  return;
                useLaneContractStore
                  .getState()
                  .replaceLaneDataset(
                    laneOwnerId,
                    persisted.trackId,
                    assemblyId,
                    current.dataset,
                    source
                  );
              })
              .catch((error: unknown) => {
                if (cancelled || controller.signal.aborted) return;
                nextIssues.push({
                  trackId: persisted.trackId,
                  label: currentLane()?.dataset.label ?? persisted.label,
                  message: error instanceof Error ? error.message : String(error),
                });
              })
              .finally(() => {
                unsubscribe();
                pending.delete(cancel);
              })
          );
        }
        if (!persisted.remoteSignal) continue;
        if (existing?.dataset.remoteSignal?.admissionCancelled && !existing.source) continue;
        if (
          existing?.source &&
          sameRemoteSignalLocator(existing.dataset.remoteSignal?.locator, persisted.remoteSignal)
        ) {
          store.replaceOwnerLanes(
            laneOwnerId,
            store.lanesForOwner(laneOwnerId).map((lane) =>
              lane.dataset.trackId === persisted.trackId
                ? {
                    ...lane,
                    visible: restored.visible,
                    order: restored.order,
                    dataset: {
                      ...lane.dataset,
                      label: restored.dataset.label,
                      color: restored.dataset.color,
                      trackPx: restored.dataset.trackPx,
                      laneHeightPx: restored.dataset.laneHeightPx,
                      maxLanes: restored.dataset.maxLanes,
                      quantitativePresentation: restored.dataset.quantitativePresentation,
                    },
                  }
                : lane
            ),
            'skip'
          );
          continue;
        }
        const paired = pairedRef.current.some((track) => {
          const locator = track.source.remote;
          return (
            locator?.target === persisted.remoteSignal!.target &&
            locator.signalPath === persisted.remoteSignal!.signalPath
          );
        });
        if (referencesRef.current.length === 0 || (paired && !pairedSourcesReady)) {
          waiting = true;
          const key = JSON.stringify([laneOwnerId, persisted.trackId]);
          const cancellation = {
            laneOwnerId,
            cancel: () => {
              const current = useLaneContractStore
                .getState()
                .lanesForOwner(laneOwnerId)
                .find((lane) => lane.dataset.trackId === persisted.trackId);
              if (!current?.dataset.remoteSignal) return;
              const message =
                'Remote histogram connection was cancelled. Open Connection details to reconnect or edit the source.';
              useLaneContractStore.getState().replaceLaneDataset(
                laneOwnerId,
                persisted.trackId,
                assemblyId,
                {
                  ...current.dataset,
                  remoteSignal: {
                    ...current.dataset.remoteSignal,
                    admissionCancelled: true,
                    admissionError: message,
                  },
                },
                current.source
              );
              setIssues((previous) => [
                ...previous.filter((issue) => issue.trackId !== persisted.trackId),
                {
                  kind: 'remote-signal',
                  trackId: persisted.trackId,
                  label: persisted.label,
                  message,
                },
              ]);
            },
          };
          signalRestoreCancellations.set(key, cancellation);
          waitingCancellations.push({ key, cancellation });
          continue;
        }
        const original = store
          .lanesForOwner(laneOwnerId)
          .find((lane) => lane.dataset.trackId === persisted.trackId)!;
        const controller = new AbortController();
        const requestId = 'remote-signal-restore-' + Date.now() + '-' + ++signalRestoreSequence;
        const api = platform().remoteGenomics;
        let sessionId: string | null = null;
        let release: Promise<void> | null = null;
        let committing = false;
        const isCurrent = (): boolean => {
          const current = useLaneContractStore
            .getState()
            .lanesForOwner(laneOwnerId)
            .find((lane) => lane.dataset.trackId === persisted.trackId);
          return (
            !cancelled &&
            !controller.signal.aborted &&
            current?.assemblyId === assemblyId &&
            current.source === original.source &&
            current.dataset.remoteSignal?.locator === original.dataset.remoteSignal?.locator &&
            current.dataset.remoteSignal?.sessionId === original.dataset.remoteSignal?.sessionId
          );
        };
        const releaseCandidate = (): Promise<void> => {
          if (sessionId && api) {
            const id = sessionId;
            sessionId = null;
            forgetRemoteSessionLease(id);
            release = api.disconnectSession(id).catch(() => undefined);
          }
          return release ?? Promise.resolve();
        };
        const cancellationKey = JSON.stringify([laneOwnerId, persisted.trackId]);
        const cancel = (explicit = false): void => {
          if (controller.signal.aborted) return;
          controller.abort();
          if (explicit && !cancelled) {
            const current = useLaneContractStore
              .getState()
              .lanesForOwner(laneOwnerId)
              .find((lane) => lane.dataset.trackId === persisted.trackId);
            if (current?.dataset.remoteSignal) {
              const message =
                'Remote histogram connection was cancelled. Open Connection details to reconnect or edit the source.';
              nextIssues.push({
                kind: 'remote-signal',
                trackId: persisted.trackId,
                label: persisted.label,
                message,
              });
              useLaneContractStore.getState().replaceLaneDataset(
                laneOwnerId,
                persisted.trackId,
                assemblyId,
                {
                  ...current.dataset,
                  remoteSignal: {
                    ...current.dataset.remoteSignal,
                    admissionCancelled: true,
                    admissionError: message,
                  },
                },
                current.source
              );
            }
          }
          if (sessionId) void releaseCandidate();
          else void api?.cancelConnect(requestId).catch(() => undefined);
        };
        pending.add(cancel);
        const cancellation = { laneOwnerId, cancel: () => cancel(true) };
        signalRestoreCancellations.set(cancellationKey, cancellation);
        const unsubscribe = useLaneContractStore.subscribe(() => {
          if (!committing && !isCurrent()) cancel();
        });
        restores.push(
          (async () => {
            try {
              if (!api?.connectSignal)
                throw new Error('Remote histogram streaming is available only in the desktop app.');
              const materialization = await api.connectSignal({
                requestId,
                endpointId: persisted.remoteSignal!.endpointId,
                target: persisted.remoteSignal!.target,
                signalPath: persisted.remoteSignal!.signalPath,
              });
              sessionId = materialization.sessionId;
              registerRemoteSessionLease({
                laneOwnerId,
                sessionId,
                sourceId:
                  materialization.runtimeStatus?.sourceId ??
                  remoteSignalSourceId(materialization.bigWigUrl),
              });
              if (!isCurrent()) throw new RemoteSignalAdmissionCancelledError();
              await attachRemoteSignalBigWig({
                laneOwnerId,
                assemblyId,
                assemblyReferences: referencesRef.current,
                trackId: persisted.trackId,
                label: persisted.label,
                target: materialization.locator.target,
                signalPath: materialization.locator.signalPath,
                bigWigUrl: materialization.bigWigUrl,
                byteLength: materialization.generation.signal.size,
                signal: controller.signal,
                remote: {
                  locator: materialization.locator,
                  sessionId: materialization.sessionId,
                  ...(materialization.runtimeStatus
                    ? {
                        connection: remotePileupConnectionFromStatus(materialization.runtimeStatus),
                      }
                    : {}),
                },
                remoteConnection: () => {
                  const latest = runtimeStatuses.current.get(
                    materialization.runtimeStatus?.sourceId ??
                      remoteSignalSourceId(materialization.bigWigUrl) ??
                      ''
                  );
                  const current =
                    latest &&
                    (!materialization.runtimeStatus ||
                      latest.updatedAt >= materialization.runtimeStatus.updatedAt)
                      ? latest
                      : materialization.runtimeStatus;
                  return current ? remotePileupConnectionFromStatus(current) : undefined;
                },
                commit: (publish) => {
                  if (!isCurrent()) return false;
                  committing = true;
                  try {
                    if (!publish()) return false;
                    liveSessions.current.add(materialization.sessionId);
                    sessionId = null;
                    return true;
                  } finally {
                    committing = false;
                  }
                },
              });
            } catch (error) {
              if (
                cancelled ||
                controller.signal.aborted ||
                error instanceof RemoteSignalAdmissionCancelledError
              )
                return;
              const message =
                'Histogram could not be opened: ' +
                remoteReconnectFailureMessage(persisted.remoteSignal!.target, error) +
                ' Open Connection details to reconnect or edit the source.';
              nextIssues.push({
                kind: 'remote-signal',
                trackId: persisted.trackId,
                label: persisted.label,
                message,
              });
              const current = useLaneContractStore
                .getState()
                .lanesForOwner(laneOwnerId)
                .find((lane) => lane.dataset.trackId === persisted.trackId);
              if (current?.dataset.remoteSignal && isCurrent()) {
                committing = true;
                try {
                  useLaneContractStore.getState().replaceLaneDataset(
                    laneOwnerId,
                    persisted.trackId,
                    assemblyId,
                    {
                      ...current.dataset,
                      remoteSignal: { ...current.dataset.remoteSignal, admissionError: message },
                    },
                    current.source
                  );
                } finally {
                  committing = false;
                }
              }
            } finally {
              if (signalRestoreCancellations.get(cancellationKey) === cancellation)
                signalRestoreCancellations.delete(cancellationKey);
              unsubscribe();
              pending.delete(cancel);
              await releaseCandidate();
            }
          })()
        );
      } catch (error) {
        nextIssues.push({
          trackId: typeof persisted?.trackId === 'string' ? persisted.trackId : '',
          label:
            typeof persisted?.label === 'string' && persisted.label.trim()
              ? persisted.label
              : 'Data track',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    void Promise.all(restores).then(() => {
      if (cancelled) return;
      setIssues(nextIssues);
      if (!waiting) setStatus('ready');
    });
    return () => {
      cancelled = true;
      for (const cancel of pending) cancel();
      for (const { key, cancellation } of waitingCancellations)
        if (signalRestoreCancellations.get(key) === cancellation)
          signalRestoreCancellations.delete(key);
    };
  }, [assemblyId, laneOwnerId, referencesIdentity, pairedSourcesReady]);

  useLayoutEffect(() => {
    if (status !== 'ready') return;
    if (
      ownerWasPresent.current &&
      !Object.prototype.hasOwnProperty.call(
        useLaneContractStore.getState().lanesByOwnerId,
        laneOwnerId
      )
    )
      return;
    const live = ownedLanes.flatMap((lane) => {
      const descriptor = indexedGenomeDataTrackFromLane(lane);
      return descriptor ? [descriptor] : [];
    });
    onChange((previous) => (indexedGenomeDataTracksEqual(previous, live) ? previous : live));
  }, [laneOwnerId, onChange, ownedLanes, status]);
  const visibleIssues = issues.filter((issue) => {
    if (issue.kind !== 'remote-signal') return true;
    const lane = ownedLanes.find((candidate) => candidate.dataset.trackId === issue.trackId);
    return lane?.dataset.remoteSignal && (!lane.source || lane.dataset.remoteSignal.admissionError);
  });
  return { status, issues: visibleIssues };
}
