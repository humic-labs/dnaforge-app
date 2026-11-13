import { useEffect, useMemo, useRef, useState } from 'react';

import { platform } from '../../../platform';
import { alignedReadSourceGenerationsEqual } from '../../../shared/aligned-read-source-generation';
import type { IndexedGenomeBamTrackState } from '../../../shared/indexed-genome';
import type {
  RemoteAlignmentLocatorV1,
  RemoteGenomicsRuntimeStatusV1,
} from '../../../shared/remote-genomics-ipc';
import {
  readAlignmentHeader,
  requireExactAlignmentReferenceMatch,
  requireReadableAlignmentIndex,
  type AlignmentReferenceIdentity,
} from '../alignment-header-client';
import { startAlignmentCoverageOperation } from '../alignment-coverage-operation-client';
import { remoteAlignmentHeaderSource } from '../pileup-source';
import { openAlignedReadSource } from '../aligned-read-source-session';
import { captureAlignedReadSourceGeneration } from '../aligned-read-source-generation';
import {
  dedupePersistedBamTracks,
  indexedGenomeBamTrackFromLane,
  laneFromUnreadablePersistedBamTrack,
  indexedGenomeBamTracksEqual,
  laneFromIndexedGenomeBamTrack,
  mergeLiveIndexedGenomeBamTracks,
  remotePileupConnectionFromStatus,
  remoteReconnectFailureMessage,
  remoteRuntimeStatusMatchesLocator,
  savedRemoteAlignmentMatchesRuntime,
} from '../bam-track-persistence';
import { useLaneContractStore, type Lane } from '../lane-contract-store';
import {
  attachRemoteSignalBigWig,
  RemoteSignalAdmissionCancelledError,
} from '../attach-remote-signal-bigwig';
import {
  disconnectRemoteSessionsAfterRendererDrain,
  forgetRemoteSessionLease,
  registerRemoteSessionLease,
} from '../remote-session-release';
import { remoteAlignmentSourceId, remoteSignalSourceId } from '../remote-signal-url';

const EMPTY_LANES: readonly Lane[] = [];
let remoteRestoreRequestSequence = 0;

function nextRemoteRestoreRequestId(): string {
  remoteRestoreRequestSequence += 1;
  return `remote-restore-${Date.now()}-${remoteRestoreRequestSequence}`;
}

export interface BamTrackRestoreIssue {
  readonly trackId: string;
  readonly label: string;
  readonly message: string;
  readonly kind?: 'remote-signal';
}

export type PersistedBamTrackUpdater = (
  previous: readonly IndexedGenomeBamTrackState[]
) => readonly IndexedGenomeBamTrackState[];

interface PendingRemoteRestore {
  readonly locator: RemoteAlignmentLocatorV1;
  readonly controller: AbortController;
  requestId: string | null;
  sessionId: string | null;
  released: Promise<void> | null;
  committing: boolean;
}

interface PendingRemoteSignalAdmission {
  readonly laneOwnerId: string;
  readonly assemblyId: string;
  readonly referencesIdentity: string;
  readonly sessionId: string;
  readonly controller: AbortController;
  readonly completion: Promise<BamTrackRestoreIssue | null>;
}

const pendingRemoteSignals = new Map<string, PendingRemoteSignalAdmission>();

function remoteSignalAdmissionKey(laneOwnerId: string, trackId: string): string {
  return JSON.stringify([laneOwnerId, trackId]);
}

interface UsePersistedBamTracksOptions {
  readonly laneOwnerId: string;
  readonly assemblyId: string;
  readonly assemblyDisplayName: string;
  readonly references: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly persistedTracks: readonly IndexedGenomeBamTrackState[];
  readonly onChange: (update: PersistedBamTrackUpdater) => void;
}

export function usePersistedBamTracks({
  laneOwnerId,
  assemblyId,
  assemblyDisplayName,
  references,
  persistedTracks,
  onChange,
}: UsePersistedBamTracksOptions): {
  status: 'restoring' | 'ready';
  issues: readonly BamTrackRestoreIssue[];
} {
  const ownedLanes = useLaneContractStore(
    (state) => state.lanesByOwnerId[laneOwnerId] ?? EMPTY_LANES
  );
  const addLane = useLaneContractStore((state) => state.addLane);
  const replaceLaneDataset = useLaneContractStore((state) => state.replaceLaneDataset);
  const [status, setStatus] = useState<'restoring' | 'ready'>(
    persistedTracks.length > 0 ? 'restoring' : 'ready'
  );
  const [issues, setIssues] = useState<readonly BamTrackRestoreIssue[]>([]);
  const persistedTracksRef = useRef(persistedTracks);
  persistedTracksRef.current = persistedTracks;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const referencesRef = useRef(references);
  referencesRef.current = references;
  const referencesIdentity = references
    .map((reference) => `${reference.name}\0${reference.length}`)
    .join('\u0001');
  const previousRestoreReferencesIdentityRef = useRef(referencesIdentity);
  const unavailableTrackIdsRef = useRef<ReadonlySet<string>>(new Set());
  const admittedTrackIdsRef = useRef<Set<string>>(new Set());
  const persistedTrackIdentity = persistedTracks.map((track) => track.trackId).join('\0');
  const [restoreEpoch, setRestoreEpoch] = useState(0);
  const runtimeStatuses = useRef(new Map<string, RemoteGenomicsRuntimeStatusV1>());
  const changedTrackIdsRef = useRef<Set<string>>(new Set());
  const trackedRemoteSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const liveRemoteSessionIds = useMemo(
    () =>
      new Set(
        ownedLanes.flatMap((lane) => {
          const sessionId = lane.dataset.source?.remote?.sessionId;
          return sessionId ? [sessionId] : [];
        })
      ),
    [ownedLanes]
  );
  const watchedSourcePaths = useMemo(() => {
    const pathToTrackIds = new Map<string, Set<string>>();
    const add = (path: string | undefined, trackId: string): void => {
      if (!path) return;
      const trackIds = pathToTrackIds.get(path) ?? new Set<string>();
      trackIds.add(trackId);
      pathToTrackIds.set(path, trackIds);
    };
    for (const track of persistedTracks) {
      if (track.source?.remote) continue;
      if (isNetworkAlignedReadTrack(track)) {
        add(track.source?.referencePath, track.trackId);
        add(
          track.source?.referencePath ? `${track.source.referencePath}.fai` : undefined,
          track.trackId
        );
        continue;
      }
      add(track.source?.bamPath, track.trackId);
      add(track.source?.indexPath, track.trackId);
      add(track.source?.referencePath, track.trackId);
      add(
        track.source?.referencePath ? `${track.source.referencePath}.fai` : undefined,
        track.trackId
      );
    }
    return pathToTrackIds;
  }, [persistedTracks]);
  const watchedSourcePathsIdentity = [...watchedSourcePaths.keys()].sort().join('\0');
  const remoteGrantExpiries = ownedLanes.flatMap((lane) => {
    const expiry = lane.dataset.source?.grantExpiresAtMs;
    return typeof expiry === 'number' && Number.isFinite(expiry) ? [expiry] : [];
  });
  const remoteGrantExpiryIdentity = remoteGrantExpiries
    .sort((left, right) => left - right)
    .join('\0');

  useEffect(() => {
    disconnectRemoteSessionsAfterRendererDrain(
      [...trackedRemoteSessionIdsRef.current].filter(
        (sessionId) => !liveRemoteSessionIds.has(sessionId)
      )
    );
    trackedRemoteSessionIdsRef.current = liveRemoteSessionIds;
  }, [liveRemoteSessionIds]);

  useEffect(
    () => () => {
      disconnectRemoteSessionsAfterRendererDrain(trackedRemoteSessionIdsRef.current);
      trackedRemoteSessionIdsRef.current = new Set();
    },
    []
  );

  useEffect(() => {
    for (const pending of pendingRemoteSignals.values()) {
      if (
        pending.laneOwnerId === laneOwnerId &&
        (pending.assemblyId !== assemblyId || pending.referencesIdentity !== referencesIdentity)
      ) {
        pending.controller.abort();
      }
    }
  }, [assemblyId, laneOwnerId, referencesIdentity]);

  useEffect(() => {
    const remoteApi = platform().remoteGenomics;
    if (!remoteApi?.subscribeStatus) return;
    return remoteApi.subscribeStatus(({ status: remoteStatus }) => {
      const cached = runtimeStatuses.current.get(remoteStatus.sourceId);
      if (!cached || cached.updatedAt <= remoteStatus.updatedAt)
        runtimeStatuses.current.set(remoteStatus.sourceId, remoteStatus);
      const lanes = useLaneContractStore.getState().lanesForOwner(laneOwnerId);
      for (const lane of lanes) {
        const pileupSource = lane.dataset.source;
        const remote = pileupSource?.remote;
        if (
          !pileupSource ||
          !remote ||
          !remoteRuntimeStatusMatchesLocator(remote.locator, remoteStatus)
        ) {
          continue;
        }
        const current = remote.connection;
        const currentSourceId = current?.sourceId ?? remoteAlignmentSourceId(pileupSource.bamPath);
        if (currentSourceId && currentSourceId !== remoteStatus.sourceId) continue;
        if (
          current &&
          (current.updatedAt > remoteStatus.updatedAt ||
            (current.updatedAt === remoteStatus.updatedAt &&
              current.transportGeneration > remoteStatus.transportGeneration))
        ) {
          continue;
        }
        const connection = remotePileupConnectionFromStatus(remoteStatus);
        if (remotePileupConnectionsEqual(current, connection)) continue;
        replaceLaneDataset(
          laneOwnerId,
          lane.dataset.trackId,
          assemblyId,
          {
            ...lane.dataset,
            source: {
              ...pileupSource,
              remote: { ...remote, connection },
            },
          },
          lane.source
        );
      }
    });
  }, [assemblyId, laneOwnerId, replaceLaneDataset]);

  useEffect(() => {
    if (watchedSourcePaths.size === 0) return;
    for (const path of watchedSourcePaths.keys()) {
      void platform()
        .fs.watchFile(path)
        .catch((error) => console.warn('[AlignedReads] Could not watch source:', error));
    }
    const unsubscribe = platform().on('file-changed', (...args: unknown[]) => {
      const path = args[0];
      if (typeof path !== 'string') return;
      const trackIds = watchedSourcePaths.get(path);
      if (!trackIds) return;
      for (const trackId of trackIds) changedTrackIdsRef.current.add(trackId);
      setRestoreEpoch((current) => current + 1);
    });
    return () => {
      unsubscribe();
      for (const path of watchedSourcePaths.keys()) {
        void platform()
          .fs.unwatchFile(path)
          .catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedSourcePathsIdentity]);

  useEffect(() => {
    const nextExpiry = remoteGrantExpiries[0];
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(
      () => setRestoreEpoch((current) => current + 1),
      Math.max(1_000, nextExpiry - Date.now() - 30_000)
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteGrantExpiryIdentity]);

  useEffect(() => {
    let cancelled = false;
    const ownedRemoteSessions = new Set<string>();
    const pendingRemoteRestores = new Map<string, PendingRemoteRestore>();
    const remoteApi = platform().remoteGenomics;
    const releasePendingRemoteRestore = (restore: PendingRemoteRestore): Promise<void> => {
      if (restore.sessionId) {
        const sessionId = restore.sessionId;
        restore.sessionId = null;
        forgetRemoteSessionLease(sessionId);
        restore.released =
          remoteApi?.disconnectSession(sessionId).catch(() => undefined) ?? Promise.resolve();
      }
      return restore.released ?? Promise.resolve();
    };
    const cancelPendingRemoteRestore = (restore: PendingRemoteRestore): void => {
      if (restore.controller.signal.aborted) return;
      restore.controller.abort();
      if (restore.requestId) {
        void remoteApi?.cancelConnect?.(restore.requestId).catch(() => undefined);
      }
      void releasePendingRemoteRestore(restore);
    };
    const disconnectOwnedRemoteSessions = (): void => {
      disconnectRemoteSessionsAfterRendererDrain(ownedRemoteSessions);
      ownedRemoteSessions.clear();
    };
    const cancelPendingRemoteRestores = (): void => {
      for (const restore of pendingRemoteRestores.values()) cancelPendingRemoteRestore(restore);
      pendingRemoteRestores.clear();
    };
    const snapshot = dedupePersistedBamTracks(persistedTracksRef.current);
    const referencesUnchanged = previousRestoreReferencesIdentityRef.current === referencesIdentity;
    previousRestoreReferencesIdentityRef.current = referencesIdentity;
    const liveRemoteLanes = new Map<string, Lane>();
    const changedTrackIds = changedTrackIdsRef.current;
    changedTrackIdsRef.current = new Set();
    const expectedReferences = [...referencesRef.current];
    const preparationChroms = expectedReferences.map((reference) => reference.name);
    setIssues([]);
    if (snapshot.length === 0) {
      unavailableTrackIdsRef.current = new Set();
      setStatus('ready');
      return () => {
        cancelled = true;
        cancelPendingRemoteRestores();
        disconnectOwnedRemoteSessions();
      };
    }
    setStatus('restoring');
    for (const track of snapshot) {
      if (!track.source.remote) continue;
      try {
        const current = useLaneContractStore
          .getState()
          .lanesForOwner(laneOwnerId)
          .find((lane) => lane.dataset.trackId === track.trackId);
        const currentSource = current?.dataset.source;
        const currentRemote = currentSource?.remote;
        if (
          referencesUnchanged &&
          current?.assemblyId === assemblyId &&
          currentRemote?.sessionId &&
          currentRemote.generation &&
          !currentSource?.admissionError &&
          /^http:\/\/127\.0\.0\.1:\d+\/v1\//u.test(currentSource?.bamPath ?? '') &&
          currentRemote.locator.target === track.source.remote.target &&
          currentRemote.locator.signalPath === track.source.remote.signalPath &&
          savedRemoteAlignmentMatchesRuntime(track.source.remote, currentRemote.locator)
        ) {
          liveRemoteLanes.set(track.trackId, current);
          admittedTrackIdsRef.current.add(track.trackId);
          continue;
        }
        const lane = laneFromIndexedGenomeBamTrack(track, {
          assemblyId,
          assemblyDisplayName,
        });
        const locator = lane.dataset.source?.remote?.locator;
        if (locator) {
          pendingRemoteRestores.set(track.trackId, {
            locator,
            controller: new AbortController(),
            requestId: null,
            sessionId: null,
            released: null,
            committing: false,
          });
        }
        if (
          replaceLaneDataset(
            laneOwnerId,
            lane.dataset.trackId,
            assemblyId,
            lane.dataset,
            lane.source
          ) === 'missing'
        ) {
          addLane(
            laneOwnerId,
            assemblyId,
            lane.dataset,
            lane.visible,
            lane.source,
            lane.order,
            'skip'
          );
        }
        admittedTrackIdsRef.current.add(track.trackId);
      } catch {}
    }
    for (const track of snapshot) {
      if (!changedTrackIds.has(track.trackId)) continue;
      try {
        const lane = laneFromIndexedGenomeBamTrack(track, {
          assemblyId,
          assemblyDisplayName,
        });
        if (lane.dataset.source) {
          replaceLaneDataset(
            laneOwnerId,
            track.trackId,
            assemblyId,
            {
              ...lane.dataset,
              source: {
                ...lane.dataset.source,
                admissionError: `The aligned-read source changed on disk. Revalidating it against ${assemblyDisplayName}…`,
              },
            },
            lane.source
          );
        }
      } catch {}
    }

    const unsubscribeFromLanes = useLaneContractStore.subscribe(() => {
      const state = useLaneContractStore.getState();
      const lanes = state.lanesForOwner(laneOwnerId);
      for (const [trackId, restore] of pendingRemoteRestores) {
        const current = lanes.find((lane) => lane.dataset.trackId === trackId);
        const currentRemote = current?.dataset.source?.remote;
        if (!restore.committing && currentRemote?.locator !== restore.locator) {
          const newlyCancelled = !restore.controller.signal.aborted;
          cancelPendingRemoteRestore(restore);
          if (!newlyCancelled) continue;
          if (current) {
            const descriptor = indexedGenomeBamTrackFromLane(current);
            if (descriptor) {
              onChangeRef.current((previous) =>
                previous.map((track) => (track.trackId === trackId ? descriptor : track))
              );
            }
          } else if (Object.prototype.hasOwnProperty.call(state.lanesByOwnerId, laneOwnerId)) {
            onChangeRef.current((previous) =>
              previous.filter((track) => track.trackId !== trackId)
            );
          }
        }
      }
    });

    void Promise.all(
      snapshot.map(async (track) => {
        let repairLane: Lane | null = null;
        let remoteRestore: PendingRemoteRestore | null = null;
        try {
          repairLane = laneFromIndexedGenomeBamTrack(track, {
            assemblyId,
            assemblyDisplayName,
          });
          if (track.source.remote) {
            const current = liveRemoteLanes.get(track.trackId);
            if (current) {
              return {
                track,
                lane: current,
                sourceGeneration: null,
                grantExpiresAtMs: null,
                issue: null,
                signal: null,
              } as const;
            }
            const remoteApi = platform().remoteGenomics;
            if (!remoteApi) {
              throw new Error('Remote cluster streaming is available only in the desktop app.');
            }
            remoteRestore = pendingRemoteRestores.get(track.trackId) ?? null;
            if (!remoteRestore || remoteRestore.controller.signal.aborted) {
              throw new Error('Remote aligned-read restore was cancelled.');
            }
            remoteRestore.requestId = nextRemoteRestoreRequestId();
            const materialization = await remoteApi.connectAlignment({
              requestId: remoteRestore.requestId,
              endpointId: track.source.remote.endpointId,
              target: track.source.remote.target,
              alignmentPath: track.source.remote.alignmentPath,
              indexPath: track.source.remote.indexPath,
              ...(track.source.remote.tileServerReceiptPath
                ? { tileServerReceiptPath: track.source.remote.tileServerReceiptPath }
                : {}),
              ...(track.source.remote.signalPath
                ? { signalPath: track.source.remote.signalPath }
                : {}),
            });
            remoteRestore.requestId = null;
            remoteRestore.sessionId = materialization.sessionId;
            registerRemoteSessionLease({
              laneOwnerId,
              sessionId: materialization.sessionId,
              sourceId:
                materialization.runtimeStatus?.sourceId ??
                remoteAlignmentSourceId(materialization.bamUrl) ??
                remoteSignalSourceId(materialization.bigWigUrl ?? ''),
            });
            if (cancelled || remoteRestore.controller.signal.aborted) {
              throw new Error('Remote aligned-read restore was cancelled.');
            }
            const header = await waitForRemoteRestore(
              readAlignmentHeader(remoteAlignmentHeaderSource(materialization)),
              remoteRestore.controller.signal
            );
            requireReadableAlignmentIndex(header);
            requireExactAlignmentReferenceMatch({
              alignmentReferences: header.references,
              expectedReferences,
              genomeDisplayName: assemblyDisplayName,
              alignmentFormat: header.isCram ? 'CRAM' : 'BAM',
            });
            const lane = laneFromIndexedGenomeBamTrack(
              track,
              { assemblyId, assemblyDisplayName },
              materialization
            );
            return {
              track,
              lane,
              sourceGeneration: null,
              grantExpiresAtMs: null,
              issue: null,
              signal: materialization.bigWigUrl
                ? {
                    endpointId: materialization.locator.endpointId,
                    target: materialization.locator.target,
                    signalPath: materialization.locator.signalPath,
                    bigWigUrl: materialization.bigWigUrl,
                    byteLength: materialization.generation.signal?.size,
                  }
                : null,
            } as const;
          }
          if (isNetworkAlignedReadTrack(track)) {
            const opened = await openAlignedReadSource({
              source: track.admittedSource,
              assemblyReferences: expectedReferences,
              assemblyDisplayName,
            });
            const lane: Lane = {
              ...repairLane,
              dataset: { ...repairLane.dataset, source: opened.source },
            };
            return {
              track,
              lane,
              sourceGeneration: null,
              grantExpiresAtMs: opened.grantExpiresAtMs ?? null,
              issue: null,
            } as const;
          }
          const generation = await captureAlignedReadSourceGeneration(
            track.source,
            platform().fs.stat
          );
          if (!alignedReadSourceGenerationsEqual(track.source.generation, generation)) {
            const header = await readAlignmentHeader({
              bamPath: track.source.bamPath,
              indexPath: track.source.indexPath,
              referencePath: track.source.referencePath,
              generation,
            });
            requireReadableAlignmentIndex(header);
            requireExactAlignmentReferenceMatch({
              alignmentReferences: header.references,
              expectedReferences,
              genomeDisplayName: assemblyDisplayName,
              alignmentFormat: header.isCram ? 'CRAM' : 'BAM',
            });
          }
          const refreshedTrack: IndexedGenomeBamTrackState = {
            ...track,
            source: { ...track.source, generation },
          };
          const lane = laneFromIndexedGenomeBamTrack(refreshedTrack, {
            assemblyId,
            assemblyDisplayName,
          });
          return {
            track: refreshedTrack,
            lane,
            sourceGeneration: generation,
            grantExpiresAtMs: null,
            issue: null,
          } as const;
        } catch (error) {
          if (remoteRestore) {
            remoteRestore.requestId = null;
            await releasePendingRemoteRestore(remoteRestore);
            if (remoteRestore.controller.signal.aborted) {
              pendingRemoteRestores.delete(track.trackId);
              return {
                track,
                lane: null,
                sourceGeneration: null,
                grantExpiresAtMs: null,
                issue: null,
              } as const;
            }
          }
          const message = track.source.remote?.target
            ? remoteReconnectFailureMessage(track.source.remote.target, error)
            : error instanceof Error
              ? error.message
              : String(error);
          if (repairLane?.dataset.source) {
            repairLane = {
              ...repairLane,
              dataset: {
                ...repairLane.dataset,
                source: {
                  ...repairLane.dataset.source,
                  admissionError: `${message} Repair opens this saved file again.`,
                },
              },
            };
          } else {
            repairLane = laneFromUnreadablePersistedBamTrack(
              track,
              { assemblyId, assemblyDisplayName },
              message
            );
          }
          const label =
            typeof track?.label === 'string' && track.label.trim().length > 0
              ? track.label
              : 'BAM track';
          const trackId = typeof track?.trackId === 'string' ? track.trackId : '';
          return {
            track,
            lane: repairLane,
            sourceGeneration: null,
            grantExpiresAtMs: null,
            issue: {
              trackId,
              label,
              message,
            } satisfies BamTrackRestoreIssue,
          } as const;
        }
      })
    ).then(async (results) => {
      if (cancelled) return;
      const nextIssues = results.flatMap((result) =>
        result.issue && !pendingRemoteRestores.get(result.track.trackId)?.controller.signal.aborted
          ? [result.issue]
          : []
      );
      unavailableTrackIdsRef.current = new Set(
        results.flatMap((result) => (result.issue && !result.lane ? [result.issue.trackId] : []))
      );
      const signalAdmissions: Array<Promise<BamTrackRestoreIssue | null>> = [];
      for (const result of results) {
        if (cancelled) return;
        if (!result.lane) continue;
        if (liveRemoteLanes.has(result.track.trackId)) {
          const pendingSignal = pendingRemoteSignals.get(
            remoteSignalAdmissionKey(laneOwnerId, result.track.trackId)
          );
          if (
            pendingSignal &&
            pendingSignal.sessionId === result.lane.dataset.source?.remote?.sessionId
          ) {
            signalAdmissions.push(pendingSignal.completion);
          }
          continue;
        }
        const remoteRestore = pendingRemoteRestores.get(result.track.trackId);
        if (result.track.source.remote && !remoteRestore) continue;
        if (remoteRestore?.controller.signal.aborted) {
          await releasePendingRemoteRestore(remoteRestore);
          if (cancelled) return;
          pendingRemoteRestores.delete(result.track.trackId);
          continue;
        }
        let lane = result.lane;
        const failedSource = lane.dataset.source;
        if (!result.issue && failedSource?.remote) {
          const sourceId =
            failedSource.remote.connection?.sourceId ??
            remoteAlignmentSourceId(failedSource.bamPath);
          const latest = sourceId ? runtimeStatuses.current.get(sourceId) : undefined;
          if (
            latest &&
            (!failedSource.remote.connection ||
              latest.updatedAt >= failedSource.remote.connection.updatedAt)
          ) {
            lane = {
              ...lane,
              dataset: {
                ...lane.dataset,
                source: {
                  ...failedSource,
                  remote: {
                    ...failedSource.remote,
                    connection: remotePileupConnectionFromStatus(latest),
                  },
                },
              },
            };
          }
        }
        if (result.issue && failedSource?.remote) {
          const currentRemote = useLaneContractStore
            .getState()
            .lanesForOwner(laneOwnerId)
            .find((candidate) => candidate.dataset.trackId === lane.dataset.trackId)?.dataset
            .source?.remote;
          const currentConnection =
            currentRemote?.locator === failedSource.remote.locator
              ? currentRemote.connection
              : failedSource.remote.connection;
          const terminalConnection =
            currentConnection?.state === 'needs-authentication' ||
            currentConnection?.state === 'blocked'
              ? currentConnection
              : {
                  ...(currentConnection ?? {
                    attempt: 0,
                    transportGeneration: 0,
                    lastFailure: null,
                  }),
                  state: 'blocked' as const,
                  updatedAt: currentConnection?.updatedAt ?? Date.now(),
                };
          lane = {
            ...lane,
            dataset: {
              ...lane.dataset,
              source: {
                ...failedSource,
                remote: { ...failedSource.remote, connection: terminalConnection },
              },
            },
          };
        }
        if (cancelled) return;
        if (remoteRestore && pendingRemoteRestores.get(result.track.trackId) !== remoteRestore) {
          continue;
        }
        if (remoteRestore) remoteRestore.committing = true;
        if (
          replaceLaneDataset(
            laneOwnerId,
            lane.dataset.trackId,
            assemblyId,
            lane.dataset,
            lane.source
          ) === 'missing'
        ) {
          addLane(
            laneOwnerId,
            assemblyId,
            lane.dataset,
            lane.visible,
            lane.source,
            lane.order,
            'skip'
          );
        }
        if (remoteRestore) {
          if (remoteRestore.sessionId) {
            ownedRemoteSessions.add(remoteRestore.sessionId);
            remoteRestore.sessionId = null;
          }
          pendingRemoteRestores.delete(result.track.trackId);
          remoteRestore.committing = false;
        }
        if (result.issue) continue;
        const signal = 'signal' in result ? result.signal : null;
        if (
          signal?.bigWigUrl &&
          signal.signalPath &&
          signal.byteLength != null &&
          signal.byteLength > 0
        ) {
          const controller = new AbortController();
          const pendingKey = remoteSignalAdmissionKey(laneOwnerId, result.track.trackId);
          pendingRemoteSignals.get(pendingKey)?.controller.abort();
          const sessionId = lane.dataset.source?.remote?.sessionId ?? '';
          const unsubscribe = useLaneContractStore.subscribe(() => {
            const current = useLaneContractStore
              .getState()
              .lanesForOwner(laneOwnerId)
              .find((candidate) => candidate.dataset.trackId === result.track.trackId);
            if (
              current?.assemblyId !== assemblyId ||
              current.dataset.source?.remote?.sessionId !== sessionId
            ) {
              controller.abort();
            }
          });
          const forgetPendingSignal = (): void => {
            unsubscribe();
            controller.signal.removeEventListener('abort', forgetPendingSignal);
            if (pendingRemoteSignals.get(pendingKey)?.controller === controller) {
              pendingRemoteSignals.delete(pendingKey);
            }
          };
          controller.signal.addEventListener('abort', forgetPendingSignal, { once: true });
          const savedSignalLane = useLaneContractStore
            .getState()
            .lanesForOwner(laneOwnerId)
            .find((candidate) => {
              const remote = candidate.dataset.remoteSignal;
              const source = candidate.source ?? remote?.durableSource;
              return (
                candidate.assemblyId === assemblyId &&
                remote?.locator.contract === 'remote-signal-locator.v1' &&
                remote.locator.target === signal.target &&
                remote.locator.signalPath === signal.signalPath &&
                source?.readerKind === 'bbi' &&
                source.formatId === 'bigwig' &&
                source.assemblyId === assemblyId &&
                (!candidate.source || source.referenceReceipt.status === 'compatible')
              );
            });
          const completion = attachRemoteSignalBigWig({
            laneOwnerId,
            assemblyId,
            assemblyReferences: references,
            target: signal.target,
            signalPath: signal.signalPath,
            bigWigUrl: signal.bigWigUrl,
            byteLength: signal.byteLength,
            ...(savedSignalLane ? { trackId: savedSignalLane.dataset.trackId } : {}),
            remote: {
              locator: {
                contract: 'remote-signal-locator.v1',
                endpointId: signal.endpointId,
                target: signal.target,
                signalPath: signal.signalPath,
              },
              sessionId,
              connection: lane.dataset.source?.remote?.connection,
            },
            label: signal.signalPath.split('/').pop(),
            signal: controller.signal,
            primaryTrack: {
              trackId: lane.dataset.trackId,
              sessionId,
            },
          })
            .then(() => {
              forgetPendingSignal();
              return null;
            })
            .catch((error): BamTrackRestoreIssue | null => {
              if (
                error instanceof RemoteSignalAdmissionCancelledError ||
                controller.signal.aborted
              ) {
                forgetPendingSignal();
                return null;
              }
              return {
                kind: 'remote-signal',
                trackId: result.track.trackId,
                label: result.track.label,
                message: `Histogram could not be opened: ${
                  error instanceof Error ? error.message : String(error)
                } Open Connection details to reconnect or edit the source.`,
              };
            });
          pendingRemoteSignals.set(pendingKey, {
            laneOwnerId,
            assemblyId,
            referencesIdentity,
            sessionId,
            controller,
            completion,
          });
          signalAdmissions.push(completion);
        }
        if (
          preparationChroms.length > 0 &&
          !result.track.source.remote &&
          result.sourceGeneration
        ) {
          void startAlignmentCoverageOperation({
            assemblyId,
            bamPath: result.track.source.bamPath,
            indexPath: result.track.source.indexPath,
            referencePath: result.track.source.referencePath,
            sourceGeneration: result.sourceGeneration,
            chroms: preparationChroms,
          }).catch((error) => {
            if (cancelled) return;
            setIssues((current) => [
              ...current.filter((issue) => issue.trackId !== result.track.trackId),
              {
                trackId: result.track.trackId,
                label: result.track.label,
                message: `Overview coverage could not be started: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
            ]);
          });
        }
      }
      const signalIssues = (await Promise.all(signalAdmissions)).filter(
        (issue): issue is BamTrackRestoreIssue => issue !== null
      );
      if (cancelled) return;
      setIssues([...nextIssues, ...signalIssues]);
      setStatus('ready');
    });

    return () => {
      cancelled = true;
      unsubscribeFromLanes();
      cancelPendingRemoteRestores();
      disconnectOwnedRemoteSessions();
    };
  }, [
    addLane,
    assemblyDisplayName,
    assemblyId,
    laneOwnerId,
    persistedTrackIdentity,
    referencesIdentity,
    replaceLaneDataset,
    restoreEpoch,
  ]);

  useEffect(() => {
    if (status !== 'ready') return;
    const live = ownedLanes.flatMap((lane) => {
      const descriptor = indexedGenomeBamTrackFromLane(lane);
      return descriptor ? [descriptor] : [];
    });
    const presentIds = new Set(ownedLanes.map((lane) => lane.dataset.trackId));
    const restoringIds = new Set(persistedTracksRef.current.map((track) => track.trackId));
    const admittedBefore = new Set(admittedTrackIdsRef.current);
    for (const trackId of presentIds) admittedTrackIdsRef.current.add(trackId);
    onChange((previous) => {
      const unique = dedupePersistedBamTracks(previous);
      const protectedIds = new Set<string>(unavailableTrackIdsRef.current);
      for (const track of unique) {
        const waitingForRestore =
          restoringIds.has(track.trackId) && !admittedBefore.has(track.trackId);
        if (waitingForRestore || presentIds.has(track.trackId)) protectedIds.add(track.trackId);
      }
      const next = mergeLiveIndexedGenomeBamTracks(unique, live, protectedIds);
      return indexedGenomeBamTracksEqual(previous, next) ? previous : next;
    });
  }, [onChange, ownedLanes, status]);

  return { status, issues };
}

function waitForRemoteRestore<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = (): void => reject(new Error('Remote aligned-read restore was cancelled.'));
    signal.addEventListener('abort', cancel, { once: true });
    pending.then(
      (result) => {
        signal.removeEventListener('abort', cancel);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      }
    );
    if (signal.aborted) cancel();
  });
}

function remotePileupConnectionsEqual(
  left: ReturnType<typeof remotePileupConnectionFromStatus> | undefined,
  right: ReturnType<typeof remotePileupConnectionFromStatus>
): boolean {
  return (
    left?.sourceId === right.sourceId &&
    left?.state === right.state &&
    left.attempt === right.attempt &&
    left.transportGeneration === right.transportGeneration &&
    left.updatedAt === right.updatedAt &&
    left.lastFailure?.code === right.lastFailure?.code &&
    left.lastFailure?.message === right.lastFailure?.message
  );
}

function isNetworkAlignedReadTrack(
  track: IndexedGenomeBamTrackState
): track is IndexedGenomeBamTrackState & {
  readonly admittedSource: NonNullable<IndexedGenomeBamTrackState['admittedSource']>;
} {
  return (
    track.admittedSource?.input?.kind === 'url' ||
    track.admittedSource?.request?.source.kind === 'htsget'
  );
}
