import { useCallback, useEffect, useRef, useState } from 'react';

import { platform } from '../../../platform';
import type {
  RemoteAlignmentConnectRequestV1,
  RemoteAlignmentMaterializationV1,
  RemoteEndpointProfileV1,
  RemoteSignalConnectRequestV1,
  RemoteSignalMaterializationV1,
  RemoteGenomicsRuntimeStatusV1,
} from '../../../shared/remote-genomics-ipc';
import {
  createIndexedBbiTrackId,
  directTrackAdmissionRequest,
  trackAdmissionRequestLabel,
  type TrackAdmissionRequestV1,
} from '@waypoint/genome-data';

import {
  readAlignmentHeader,
  requireExactAlignmentReferenceMatch,
  requireReadableAlignmentIndex,
  type AlignmentReferenceIdentity,
} from '../alignment-header-client';
import { startAlignmentCoverageOperation } from '../alignment-coverage-operation-client';
import { remoteAlignmentHeaderSource } from '../pileup-source';
import {
  attachAlignedReadRequest,
  chooseLocalCramReferenceThroughPicker,
  prepareAlignmentSource,
  type AlignedReadImportPhase,
  type PreparedAlignmentSource,
} from '../attach-aligned-read-request';
import { useLaneContractStore } from '../lane-contract-store';
import {
  ALIGNMENT_TRACK_DIALOG_EXTENSIONS,
  basenameForPath,
  buildReadPileupDataset,
} from '../read-pileup-import';
import {
  canonicalRemoteReadIdentity,
  remotePileupConnectionFromStatus,
  remoteReconnectFailureMessage,
} from '../bam-track-persistence';
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
import { cancelRemoteSignalRestore } from './usePersistedUcscTracks';

export interface BamTrackImportNotice {
  readonly kind: 'success' | 'warn' | 'error';
  readonly text: string;
}

export type BamTrackImportProgressPhase = AlignedReadImportPhase;

export interface BamTrackImportProgress {
  readonly phase: BamTrackImportProgressPhase;
  readonly label: string;
  readonly fileName: string;
  readonly fileNumber: number;
  readonly fileCount: number;
  readonly stepNumber: number;
  readonly stepCount: 4;
}

interface BamTrackGenome {
  readonly laneOwnerId: string;
  readonly assemblyId: string;
  readonly displayName: string;
  readonly references: ReadonlyArray<AlignmentReferenceIdentity>;
}

interface RemoteSignalRefreshRequest {
  readonly trackId: string;
  readonly sessionId: string;
  readonly endpointId: string;
  readonly target: string;
  readonly signalPath: string;
  readonly bigWigUrl: string;
  readonly byteLength: number;
  readonly supersededSignal?: { readonly trackId: string; readonly fingerprint: string };
  readonly resumeCancelled?: boolean;
}

interface PendingRemoteAdmission {
  readonly interactive: boolean;
  readonly trackId?: string;
  readonly isCurrent: () => boolean;
  readonly cancel: () => void;
  committing: boolean;
}

interface RemoteAdmissionScope {
  readonly signal: AbortSignal;
  readonly commit: (publish: () => boolean) => boolean;
}

class RemoteAdmissionCancelledError extends Error {
  constructor() {
    super('Remote aligned-read connection was cancelled.');
  }
}

let remoteImportRequestSequence = 0;

function nextRemoteImportRequestId(): string {
  remoteImportRequestSequence += 1;
  return `remote-import-${Date.now()}-${remoteImportRequestSequence}`;
}

export interface BamTrackImportController {
  readonly busy: string | null;
  readonly remoteConnecting: boolean;
  readonly cancelRemoteConnect: () => void;
  readonly cancelRemoteSignalConnect?: (trackId: string) => void;
  readonly progress: BamTrackImportProgress | null;
  readonly notice: BamTrackImportNotice | null;
  readonly lastOperation: 'add' | 'repair' | null;
  readonly clearNotice: () => void;
  readonly recentRemoteEndpoints: readonly RemoteEndpointProfileV1[];
  readonly refreshRemoteEndpoints: () => Promise<void>;
  readonly addRemote: (request: RemoteAlignmentConnectRequestV1) => Promise<void>;
  readonly addFiles: (paths: ReadonlyArray<string>) => Promise<void>;
  readonly addRequests: (requests: ReadonlyArray<TrackAdmissionRequestV1>) => Promise<void>;
  readonly reconnectRemoteTrack: (trackId: string) => Promise<boolean>;
  readonly editRemoteTrack: (
    trackId: string,
    request: RemoteAlignmentConnectRequestV1
  ) => Promise<void>;
  readonly editRemoteSignalTrack?: (
    trackId: string,
    request: RemoteSignalConnectRequestV1
  ) => Promise<void>;
  readonly repairTrack: (trackId: string) => Promise<void>;
}

export function useBamTrackImport(genome: BamTrackGenome): BamTrackImportController {
  const addLane = useLaneContractStore((state) => state.addLane);
  const replaceLaneDataset = useLaneContractStore((state) => state.replaceLaneDataset);
  const [busy, setBusy] = useState<string | null>(null);
  const [remoteConnecting, setRemoteConnecting] = useState(false);
  const [progress, setProgress] = useState<BamTrackImportProgress | null>(null);
  const [notice, setNotice] = useState<BamTrackImportNotice | null>(null);
  const [recentRemoteEndpoints, setRecentRemoteEndpoints] = useState<
    readonly RemoteEndpointProfileV1[]
  >([]);
  const [lastOperation, setLastOperation] = useState<'add' | 'repair' | null>(null);
  const mounted = useRef(true);
  const activeIndexWaiters = useRef(new Set<AbortController>());
  const activeRemoteSessions = useRef(new Set<string>());
  const pendingRemoteAdmissions = useRef(new Map<string, PendingRemoteAdmission>());
  const remoteReconnects = useRef(new Map<string, Promise<boolean>>());
  const remoteSignalRefreshControllers = useRef(new Map<string, AbortController>());
  const runtimeStatuses = useRef(new Map<string, RemoteGenomicsRuntimeStatusV1>());

  useEffect(() => {
    const api = platform().remoteGenomics;
    if (!api?.subscribeStatus) return;
    return api.subscribeStatus(({ status }) => {
      const previous = runtimeStatuses.current.get(status.sourceId);
      if (!previous || previous.updatedAt <= status.updatedAt)
        runtimeStatuses.current.set(status.sourceId, status);
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = useLaneContractStore.subscribe(() => {
      for (const admission of pendingRemoteAdmissions.current.values()) {
        if (!admission.committing && !admission.isCurrent()) admission.cancel();
      }
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      for (const controller of activeIndexWaiters.current) controller.abort();
      activeIndexWaiters.current.clear();
      for (const controller of remoteSignalRefreshControllers.current.values()) controller.abort();
      remoteSignalRefreshControllers.current.clear();
      for (const admission of pendingRemoteAdmissions.current.values()) admission.cancel();
      pendingRemoteAdmissions.current.clear();
      disconnectRemoteSessionsAfterRendererDrain(activeRemoteSessions.current);
      activeRemoteSessions.current.clear();
    };
  }, [genome.laneOwnerId]);

  const cancelRemoteAdmissions = useCallback(
    (trackId?: string): void => {
      cancelRemoteSignalRestore(genome.laneOwnerId, trackId);
      for (const admission of pendingRemoteAdmissions.current.values()) {
        if (admission.interactive && (trackId === undefined || admission.trackId === trackId))
          admission.cancel();
      }
    },
    [genome.laneOwnerId]
  );
  const cancelRemoteConnect = useCallback(() => cancelRemoteAdmissions(), [cancelRemoteAdmissions]);
  const cancelRemoteSignalConnect = useCallback(
    (trackId: string) => cancelRemoteAdmissions(trackId),
    [cancelRemoteAdmissions]
  );

  const withRemoteAdmission = useCallback(
    async <
      T,
      M extends RemoteAlignmentMaterializationV1 | RemoteSignalMaterializationV1 =
        RemoteAlignmentMaterializationV1,
    >(
      request: RemoteAlignmentConnectRequestV1 | RemoteSignalConnectRequestV1,
      admit: (materialization: M, scope: RemoteAdmissionScope) => Promise<T>,
      isCurrent: () => boolean = () => true,
      kind: 'alignment' | 'signal' = 'alignment',
      trackId?: string
    ): Promise<T> => {
      const api = platform().remoteGenomics;
      if (!api) throw new Error('Remote cluster streaming is available only in the desktop app.');
      const requestId = nextRemoteImportRequestId();
      const controller = new AbortController();
      let sessionId: string | null = null;
      let released: Promise<void> | null = null;
      const release = (): Promise<void> => {
        if (sessionId) {
          const ownedSessionId = sessionId;
          sessionId = null;
          forgetRemoteSessionLease(ownedSessionId);
          released = api.disconnectSession(ownedSessionId).catch(() => undefined);
        }
        return released ?? Promise.resolve();
      };
      const finish = (): void => {
        pendingRemoteAdmissions.current.delete(requestId);
        if (mounted.current) {
          setRemoteConnecting(
            [...pendingRemoteAdmissions.current.values()].some((pending) => pending.interactive)
          );
        }
      };
      const admission: PendingRemoteAdmission = {
        interactive: request.allowInteractive === true,
        trackId,
        committing: false,
        isCurrent,
        cancel: () => {
          if (controller.signal.aborted) return;
          controller.abort();
          if (sessionId) void release();
          else void api.cancelConnect(requestId).catch(() => undefined);
        },
      };
      const requireCurrent = (): void => {
        if (!mounted.current || controller.signal.aborted || !isCurrent()) {
          admission.cancel();
          throw new RemoteAdmissionCancelledError();
        }
      };
      pendingRemoteAdmissions.current.set(requestId, admission);
      if (mounted.current) {
        setRemoteConnecting(
          [...pendingRemoteAdmissions.current.values()].some((pending) => pending.interactive)
        );
      }
      try {
        requireCurrent();
        const materialization = (
          kind === 'signal'
            ? await api.connectSignal({ ...request, requestId } as RemoteSignalConnectRequestV1)
            : await api.connectAlignment({
                ...request,
                requestId,
              } as RemoteAlignmentConnectRequestV1)
        ) as M;
        sessionId = materialization.sessionId;
        registerRemoteSessionLease({
          laneOwnerId: genome.laneOwnerId,
          sessionId,
          sourceId:
            materialization.runtimeStatus?.sourceId ??
            ('bamUrl' in materialization
              ? remoteAlignmentSourceId(materialization.bamUrl)
              : null) ??
            remoteSignalSourceId(materialization.bigWigUrl ?? ''),
        });
        requireCurrent();
        return await admit(materialization, {
          signal: controller.signal,
          commit: (publish) => {
            requireCurrent();
            admission.committing = true;
            try {
              if (!publish()) return false;
              activeRemoteSessions.current.add(materialization.sessionId);
              sessionId = null;
              finish();
              return true;
            } finally {
              admission.committing = false;
            }
          },
        });
      } catch (error) {
        if (controller.signal.aborted) throw new RemoteAdmissionCancelledError();
        throw error;
      } finally {
        await release();
        finish();
      }
    },
    [genome.laneOwnerId]
  );

  const prepareForCurrentView = useCallback(
    async (
      request: TrackAdmissionRequestV1,
      reportProgress: (
        phase: BamTrackImportProgressPhase,
        label: string,
        stepNumber: number
      ) => void
    ): Promise<PreparedAlignmentSource> => {
      const controller = new AbortController();
      activeIndexWaiters.current.add(controller);
      try {
        return await prepareAlignmentSource(request, genome, reportProgress, {
          signal: controller.signal,
          resolveLocalCramReference: chooseLocalCramReferenceThroughPicker,
        });
      } finally {
        activeIndexWaiters.current.delete(controller);
      }
    },
    [genome]
  );

  const clearNotice = useCallback(() => setNotice(null), []);

  const refreshRemoteEndpoints = useCallback(async (): Promise<void> => {
    const remoteApi = platform().remoteGenomics;
    if (!remoteApi) {
      setRecentRemoteEndpoints([]);
      return;
    }
    try {
      setRecentRemoteEndpoints(await remoteApi.listEndpoints());
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const refreshRemoteSignalUntilHealthy = useCallback(
    (request: RemoteSignalRefreshRequest): void => {
      remoteSignalRefreshControllers.current.get(request.trackId)?.abort();
      const controller = new AbortController();
      remoteSignalRefreshControllers.current.set(request.trackId, controller);
      void (async () => {
        let failureCount = 0;
        try {
          while (!controller.signal.aborted) {
            const current = useLaneContractStore
              .getState()
              .lanesForOwner(genome.laneOwnerId)
              .find((candidate) => candidate.dataset.trackId === request.trackId);
            if (
              current?.dataset.kind !== 'pileup' ||
              current.dataset.source?.remote?.sessionId !== request.sessionId
            ) {
              return;
            }
            if (failureCount > 0) {
              await waitForRemoteSignalRetry(
                Math.min(30_000, 1_000 * 2 ** Math.min(5, failureCount - 1)),
                controller.signal
              );
              if (controller.signal.aborted) return;
            }
            try {
              const replacementTrackId = createIndexedBbiTrackId({
                assemblyId: genome.assemblyId,
                source: { kind: 'url', url: `ssh://${request.target}${request.signalPath}` },
              });
              const replacementWasPresent = useLaneContractStore
                .getState()
                .lanesForOwner(genome.laneOwnerId)
                .some((lane) => lane.dataset.trackId === replacementTrackId);
              await attachRemoteSignalBigWig({
                laneOwnerId: genome.laneOwnerId,
                assemblyId: genome.assemblyId,
                assemblyReferences: genome.references,
                target: request.target,
                signalPath: request.signalPath,
                bigWigUrl: request.bigWigUrl,
                byteLength: request.byteLength,
                resumeCancelled: request.resumeCancelled,
                remote: {
                  locator: {
                    contract: 'remote-signal-locator.v1',
                    endpointId: request.endpointId,
                    target: request.target,
                    signalPath: request.signalPath,
                  },
                  sessionId: request.sessionId,
                  connection: current.dataset.source?.remote?.connection,
                },
                signal: controller.signal,
                primaryTrack: { trackId: request.trackId, sessionId: request.sessionId },
              });
              const superseded = request.supersededSignal;
              if (superseded) {
                const store = useLaneContractStore.getState();
                const lanes = store.lanesForOwner(genome.laneOwnerId);
                const previous = lanes.find((lane) => lane.dataset.trackId === superseded.trackId);
                const stillReferenced = lanes.some((lane) => {
                  if (lane.dataset.experimentalHybrid?.quantitativeTrackId === superseded.trackId)
                    return true;
                  const locator = lane.dataset.source?.remote?.locator;
                  return (
                    locator?.signalPath &&
                    createIndexedBbiTrackId({
                      assemblyId: lane.assemblyId,
                      source: { kind: 'url', url: `ssh://${locator.target}${locator.signalPath}` },
                    }) === superseded.trackId
                  );
                });
                if (previous?.source?.fingerprint === superseded.fingerprint && !stillReferenced) {
                  const replacement = lanes.find(
                    (lane) => lane.dataset.trackId === replacementTrackId
                  );
                  store.replaceOwnerLanes(
                    genome.laneOwnerId,
                    replacement && !replacementWasPresent
                      ? lanes.flatMap((lane) => {
                          if (lane.dataset.trackId === superseded.trackId)
                            return [{ ...replacement, order: previous.order }];
                          return lane.dataset.trackId === replacementTrackId ? [] : [lane];
                        })
                      : lanes.filter((lane) => lane.dataset.trackId !== superseded.trackId),
                    'skip'
                  );
                }
              }
              return;
            } catch (error) {
              if (error instanceof RemoteSignalAdmissionCancelledError) return;
              failureCount += 1;
            }
          }
        } finally {
          if (remoteSignalRefreshControllers.current.get(request.trackId) === controller) {
            remoteSignalRefreshControllers.current.delete(request.trackId);
          }
        }
      })();
    },
    [genome]
  );

  const addRemote = useCallback(
    async (request: RemoteAlignmentConnectRequestV1): Promise<void> => {
      setLastOperation('add');
      setNotice(null);
      setProgress(null);
      const remoteApi = platform().remoteGenomics;
      if (!remoteApi) {
        const message = 'Remote cluster streaming is available only in the desktop app.';
        setNotice({ kind: 'error', text: message });
        throw new Error(message);
      }

      const name = basenameForPath(request.alignmentPath);
      try {
        setBusy(`Connecting to ${request.target}…`);
        setProgress({
          phase: 'checking-index',
          label: 'Opening SSH tunnel',
          fileName: name,
          fileNumber: 1,
          fileCount: 1,
          stepNumber: 1,
          stepCount: 4,
        });
        await withRemoteAdmission(
          { ...request, allowInteractive: true },
          async (materialization, admission) => {
            setBusy(`Validating ${name}…`);
            setProgress({
              phase: 'validating-assembly',
              label: 'Validating assembly',
              fileName: name,
              fileNumber: 1,
              fileCount: 1,
              stepNumber: 2,
              stepCount: 4,
            });
            const header = await waitForRemoteAdmission(
              readAlignmentHeader(remoteAlignmentHeaderSource(materialization)),
              admission.signal
            );
            requireReadableAlignmentIndex(header);
            requireExactAlignmentReferenceMatch({
              alignmentReferences: header.references,
              expectedReferences: genome.references,
              genomeDisplayName: genome.displayName,
              alignmentFormat: header.isCram ? 'CRAM' : 'BAM',
            });

            setBusy(`Adding track for ${name}…`);
            setProgress({
              phase: 'adding-track',
              label: 'Adding track',
              fileName: name,
              fileNumber: 1,
              fileCount: 1,
              stepNumber: 4,
              stepCount: 4,
            });
            const connection = remoteMaterializationConnection(
              materialization,
              runtimeStatuses.current
            );
            const dataset = buildReadPileupDataset({
              assemblyId: genome.assemblyId,
              assemblyDisplayName: genome.displayName,
              bamPath: materialization.bamUrl,
              indexPath: materialization.indexPath,
              sourceIdentity: canonicalRemoteReadIdentity(
                materialization.locator.endpointId,
                materialization.locator.alignmentPath
              ),
              label: name,
              remote: {
                locator: materialization.locator,
                sessionId: materialization.sessionId,
                generation: materialization.generation,
                ...(materialization.tileBaseUrl
                  ? { tileBaseUrl: materialization.tileBaseUrl }
                  : {}),
                ...(connection ? { connection } : {}),
              },
            });
            const added = admission.commit(
              () => addLane(genome.laneOwnerId, genome.assemblyId, dataset) === 'added'
            );
            if (!added) {
              setNotice({ kind: 'warn', text: `${name} is already attached.` });
            } else {
              let histogramNote = '';
              if (
                materialization.bigWigUrl &&
                materialization.locator.signalPath &&
                materialization.generation.signal &&
                materialization.generation.signal.size > 0
              ) {
                remoteSignalRefreshControllers.current.get(dataset.trackId)?.abort();
                const controller = new AbortController();
                remoteSignalRefreshControllers.current.set(dataset.trackId, controller);
                try {
                  const histogram = await attachRemoteSignalBigWig({
                    laneOwnerId: genome.laneOwnerId,
                    assemblyId: genome.assemblyId,
                    assemblyReferences: genome.references,
                    target: materialization.locator.target,
                    signalPath: materialization.locator.signalPath,
                    bigWigUrl: materialization.bigWigUrl,
                    byteLength: materialization.generation.signal.size,
                    resumeCancelled: true,
                    remote: {
                      locator: {
                        contract: 'remote-signal-locator.v1',
                        endpointId: materialization.locator.endpointId,
                        target: materialization.locator.target,
                        signalPath: materialization.locator.signalPath,
                      },
                      sessionId: materialization.sessionId,
                      connection: dataset.source?.remote?.connection,
                    },
                    signal: controller.signal,
                    primaryTrack: {
                      trackId: dataset.trackId,
                      sessionId: materialization.sessionId,
                    },
                  });
                  histogramNote = ` Histogram: ${histogram.label}.`;
                } catch (error) {
                  if (error instanceof RemoteSignalAdmissionCancelledError) return;
                  histogramNote = ` Histogram failed: ${
                    error instanceof Error ? error.message : String(error)
                  }`;
                } finally {
                  if (remoteSignalRefreshControllers.current.get(dataset.trackId) === controller) {
                    remoteSignalRefreshControllers.current.delete(dataset.trackId);
                  }
                }
              }
              if (!mounted.current) return;
              setRecentRemoteEndpoints((current) => [
                materialization.endpoint,
                ...current.filter(
                  (endpoint) => endpoint.endpointId !== materialization.endpoint.endpointId
                ),
              ]);
              const readFormat = materialization.bamUrl.toLowerCase().includes('.cram')
                ? 'CRAM'
                : 'BAM';
              setNotice({
                kind: histogramNote.startsWith(' Histogram failed') ? 'warn' : 'success',
                text: `Streaming ${name} from ${materialization.endpoint.displayName}.${histogramNote} Read details come from the ${readFormat} index.`,
              });
            }
          }
        );
      } catch (error) {
        const message = remoteReconnectFailureMessage(request.target, error);
        if (mounted.current) setNotice({ kind: 'error', text: `${name}: ${message}` });
        throw error;
      } finally {
        if (mounted.current) {
          setBusy(null);
          setProgress(null);
        }
      }
    },
    [addLane, genome, withRemoteAdmission]
  );

  const addRequests = useCallback(
    async (requests: ReadonlyArray<TrackAdmissionRequestV1>) => {
      setLastOperation('add');
      setNotice(null);
      setProgress(null);
      if (requests.length === 0) return;
      let added = 0;
      let indexed = 0;
      let coverageQueued = 0;
      const duplicates: string[] = [];
      const errors: string[] = [];

      for (const [fileIndex, request] of requests.entries()) {
        const name = trackAdmissionRequestLabel(request);
        const progressFor = (
          phase: BamTrackImportProgressPhase,
          label: string,
          stepNumber: number
        ): BamTrackImportProgress => ({
          phase,
          label,
          fileName: name,
          fileNumber: fileIndex + 1,
          fileCount: requests.length,
          stepNumber,
          stepCount: 4,
        });
        setBusy(`Checking ${name}…`);
        setProgress(progressFor('checking-index', 'Checking index', 1));
        const controller = new AbortController();
        activeIndexWaiters.current.add(controller);
        try {
          const attached = await attachAlignedReadRequest({
            request,
            genome,
            signal: controller.signal,
            resolveLocalCramReference: chooseLocalCramReferenceThroughPicker,
            onProgress: (phase, label, step) => {
              setBusy(
                phase === 'adding-track'
                  ? `Adding track for ${name}…`
                  : phase === 'validating-reference'
                    ? `Choosing the reference for ${name}…`
                    : phase === 'checking-index'
                      ? `Checking ${name}…`
                      : `Validating ${name}…`
              );
              setProgress(progressFor(phase, label, step));
            },
          });
          if (attached.indexCreated) indexed += 1;
          if (attached.status === 'duplicate') duplicates.push(name);
          else {
            added += 1;
            if (attached.coverage) {
              coverageQueued += 1;
              void attached.coverage
                .then(() => {
                  setNotice({
                    kind: 'success',
                    text: `Coverage preparation started for ${name}. Follow it in Jobs.`,
                  });
                })
                .catch((error) => {
                  setNotice({
                    kind: 'error',
                    text: `${name} was added, but overview coverage could not be started: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  });
                });
            }
          }
        } catch (error) {
          errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          activeIndexWaiters.current.delete(controller);
        }
      }

      setBusy(null);
      setProgress(null);
      const messages: string[] = [];
      if (indexed > 0) messages.push(`Indexed ${indexed} BAM file${indexed === 1 ? '' : 's'}.`);
      if (added > 0) messages.push(`Added ${added} aligned-read track${added === 1 ? '' : 's'}.`);
      if (coverageQueued > 0) messages.push('Preparing overview coverage in the background.');
      if (duplicates.length > 0) messages.push(`Already added: ${duplicates.join(', ')}.`);
      if (errors.length > 0) messages.push(errors.join(' '));
      setNotice({
        kind: errors.length > 0 ? 'error' : duplicates.length > 0 ? 'warn' : 'success',
        text: messages.join(' '),
      });
    },
    [genome]
  );

  const addFiles = useCallback(
    (paths: ReadonlyArray<string>) =>
      addRequests(
        paths.map((path) =>
          directTrackAdmissionRequest({
            assemblyId: genome.assemblyId,
            input: { kind: 'path', path },
            ingress: 'file-picker',
          })
        )
      ),
    [addRequests, genome.assemblyId]
  );

  const reconnectRemoteSignalTrack = useCallback(
    async (
      trackId: string,
      replacementRequest?: RemoteSignalConnectRequestV1,
      interactive = false
    ): Promise<boolean> => {
      const pending = remoteReconnects.current.get(trackId);
      if (pending) {
        if (!replacementRequest && !interactive) return pending;
        await pending.catch(() => undefined);
      }
      cancelRemoteSignalRestore(genome.laneOwnerId, trackId);
      const lane = useLaneContractStore
        .getState()
        .lanesForOwner(genome.laneOwnerId)
        .find((candidate) => candidate.dataset.trackId === trackId);
      const remote = lane?.dataset.remoteSignal;
      if (!lane || !remote) return false;
      const oldSource = lane.source;
      const oldSessionId = remote.sessionId;
      const request = replacementRequest ?? {
        target: remote.locator.target,
        signalPath: remote.locator.signalPath,
      };
      const reconnect = withRemoteAdmission<boolean, RemoteSignalMaterializationV1>(
        {
          ...request,
          ...(interactive ? { allowInteractive: true } : {}),
          endpointId:
            request.target === remote.locator.target ? remote.locator.endpointId : undefined,
        },
        async (materialization, admission) => {
          await attachRemoteSignalBigWig({
            laneOwnerId: genome.laneOwnerId,
            assemblyId: genome.assemblyId,
            assemblyReferences: genome.references,
            trackId,
            label: lane.dataset.label,
            target: materialization.locator.target,
            signalPath: materialization.locator.signalPath,
            bigWigUrl: materialization.bigWigUrl,
            byteLength: materialization.generation.signal.size,
            signal: admission.signal,
            commit: admission.commit,
            resumeCancelled: true,
            remote: {
              locator: materialization.locator,
              sessionId: materialization.sessionId,
              ...(materialization.runtimeStatus
                ? { connection: remotePileupConnectionFromStatus(materialization.runtimeStatus) }
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
          });
          if (oldSessionId) disconnectRemoteSessionsAfterRendererDrain([oldSessionId]);
          if (mounted.current)
            setRecentRemoteEndpoints((current) => [
              materialization.endpoint,
              ...current.filter(
                (endpoint) => endpoint.endpointId !== materialization.endpoint.endpointId
              ),
            ]);
          return true;
        },
        () => {
          const current = useLaneContractStore
            .getState()
            .lanesForOwner(genome.laneOwnerId)
            .find((candidate) => candidate.dataset.trackId === trackId);
          return (
            current?.assemblyId === genome.assemblyId &&
            current.source === oldSource &&
            current.dataset.remoteSignal?.locator === remote.locator &&
            current.dataset.remoteSignal.sessionId === oldSessionId
          );
        },
        'signal',
        trackId
      );
      remoteReconnects.current.set(trackId, reconnect);
      try {
        return await reconnect;
      } finally {
        if (remoteReconnects.current.get(trackId) === reconnect)
          remoteReconnects.current.delete(trackId);
      }
    },
    [genome, withRemoteAdmission]
  );

  const reconnectRemoteTrack = useCallback(
    async (
      trackId: string,
      replacementRequest?: RemoteAlignmentConnectRequestV1,
      interactive = false
    ): Promise<boolean> => {
      if (
        useLaneContractStore
          .getState()
          .lanesForOwner(genome.laneOwnerId)
          .find((lane) => lane.dataset.trackId === trackId)?.dataset.remoteSignal
      ) {
        return reconnectRemoteSignalTrack(trackId, undefined, interactive);
      }
      const existing = remoteReconnects.current.get(trackId);
      if (existing) {
        if (!replacementRequest && !interactive) return existing;
        await existing.catch(() => undefined);
      }

      const reconnect = (async (): Promise<boolean> => {
        const lane = useLaneContractStore
          .getState()
          .lanesForOwner(genome.laneOwnerId)
          .find((candidate) => candidate.dataset.trackId === trackId);
        if (!lane || lane.dataset.kind !== 'pileup') {
          throw new Error('This aligned-read track is no longer available.');
        }
        const source = lane.dataset.source;
        const savedRemote = source?.remote?.locator;
        if (!savedRemote?.target || !savedRemote.alignmentPath || !savedRemote.indexPath) {
          return false;
        }
        const remoteApi = platform().remoteGenomics;
        if (!remoteApi) {
          throw new Error('Remote cluster streaming is available only in the desktop app.');
        }

        const oldSessionId = source?.remote?.sessionId;
        const requestedSource = replacementRequest ?? {
          target: savedRemote.target,
          alignmentPath: savedRemote.alignmentPath,
          indexPath: savedRemote.indexPath,
          ...(savedRemote.signalPath ? { signalPath: savedRemote.signalPath } : {}),
          ...(savedRemote.tileServerReceiptPath
            ? { tileServerReceiptPath: savedRemote.tileServerReceiptPath }
            : {}),
        };
        try {
          if (!replacementRequest && interactive) {
            await remoteApi
              .retryEndpoint(
                source?.remote?.connection?.sourceId || savedRemote.endpointId || savedRemote.target
              )
              .catch(() => false);
          }
          return await withRemoteAdmission(
            {
              ...requestedSource,
              ...(interactive ? { allowInteractive: true } : {}),
              ...(requestedSource.target === savedRemote.target
                ? { endpointId: savedRemote.endpointId }
                : { endpointId: undefined }),
            },
            async (materialization, admission) => {
              const header = await waitForRemoteAdmission(
                readAlignmentHeader(remoteAlignmentHeaderSource(materialization)),
                admission.signal
              );
              requireReadableAlignmentIndex(header);
              requireExactAlignmentReferenceMatch({
                alignmentReferences: header.references,
                expectedReferences: genome.references,
                genomeDisplayName: genome.displayName,
                alignmentFormat: header.isCram ? 'CRAM' : 'BAM',
              });
              const connection = remoteMaterializationConnection(
                materialization,
                runtimeStatuses.current
              );
              const built = buildReadPileupDataset({
                assemblyId: genome.assemblyId,
                assemblyDisplayName: genome.displayName,
                bamPath: materialization.bamUrl,
                indexPath: materialization.indexPath,
                sourceIdentity: canonicalRemoteReadIdentity(
                  materialization.locator.endpointId,
                  materialization.locator.alignmentPath
                ),
                label: lane.dataset.label.replace(`${genome.displayName}: `, ''),
                remote: {
                  locator: materialization.locator,
                  sessionId: materialization.sessionId,
                  generation: materialization.generation,
                  ...(materialization.tileBaseUrl
                    ? { tileBaseUrl: materialization.tileBaseUrl }
                    : {}),
                  ...(connection ? { connection } : {}),
                },
              });
              const replacement = {
                ...built,
                trackId,
                label: lane.dataset.label,
                color: lane.dataset.color,
                trackPx: lane.dataset.trackPx,
                laneHeightPx: lane.dataset.laneHeightPx,
                maxLanes: lane.dataset.maxLanes,
                coverageCutoffDepth: lane.dataset.coverageCutoffDepth,
              };
              const signalId = (target: string, signalPath: string | undefined) =>
                signalPath
                  ? createIndexedBbiTrackId({
                      assemblyId: genome.assemblyId,
                      source: { kind: 'url', url: `ssh://${target}${signalPath}` },
                    })
                  : null;
              const previousSignalId = signalId(savedRemote.target, savedRemote.signalPath);
              const nextSignalId = signalId(
                materialization.locator.target,
                materialization.locator.signalPath
              );
              const previousSignal = useLaneContractStore
                .getState()
                .lanesForOwner(genome.laneOwnerId)
                .find((candidate) => candidate.dataset.trackId === previousSignalId)?.source;
              if (
                !admission.commit(() => {
                  if (
                    replaceLaneDataset(
                      genome.laneOwnerId,
                      trackId,
                      genome.assemblyId,
                      replacement
                    ) === 'missing'
                  )
                    return false;
                  if (previousSignalId && previousSignalId !== nextSignalId) {
                    const store = useLaneContractStore.getState();
                    const lanes = store.lanesForOwner(genome.laneOwnerId);
                    const nextSignalReady = lanes.some(
                      (candidate) =>
                        candidate.dataset.trackId === nextSignalId &&
                        candidate.dataset.kind !== 'pileup' &&
                        candidate.dataset.trackType === 'quantitative'
                    );
                    for (const composed of lanes) {
                      const hybrid = composed.dataset.experimentalHybrid;
                      if (
                        hybrid?.alignmentTrackId !== trackId ||
                        hybrid.quantitativeTrackId !== previousSignalId
                      )
                        continue;
                      if (!nextSignalId) {
                        store.removeLane(genome.laneOwnerId, composed.dataset.trackId);
                        continue;
                      }
                      replaceLaneDataset(
                        genome.laneOwnerId,
                        composed.dataset.trackId,
                        genome.assemblyId,
                        {
                          ...composed.dataset,
                          experimentalHybrid: {
                            ...hybrid,
                            quantitativeTrackId: nextSignalId,
                            waitingForSources: !nextSignalReady,
                            sourceError: undefined,
                          },
                        },
                        composed.source
                      );
                    }
                  }
                  return true;
                })
              ) {
                throw new Error('This aligned-read track was removed before reconnect completed.');
              }
              if (oldSessionId && oldSessionId !== materialization.sessionId) {
                activeRemoteSessions.current.delete(oldSessionId);
                disconnectRemoteSessionsAfterRendererDrain([oldSessionId]);
              }
              setRecentRemoteEndpoints((current) => [
                materialization.endpoint,
                ...current.filter(
                  (endpoint) => endpoint.endpointId !== materialization.endpoint.endpointId
                ),
              ]);
              if (
                materialization.bigWigUrl &&
                materialization.locator.signalPath &&
                materialization.generation.signal &&
                materialization.generation.signal.size > 0
              ) {
                refreshRemoteSignalUntilHealthy({
                  trackId,
                  sessionId: materialization.sessionId,
                  endpointId: materialization.locator.endpointId,
                  resumeCancelled: interactive,
                  target: materialization.locator.target,
                  signalPath: materialization.locator.signalPath,
                  bigWigUrl: materialization.bigWigUrl,
                  byteLength: materialization.generation.signal.size,
                  ...(previousSignalId && previousSignalId !== nextSignalId && previousSignal
                    ? {
                        supersededSignal: {
                          trackId: previousSignalId,
                          fingerprint: previousSignal.fingerprint,
                        },
                      }
                    : {}),
                });
              }
              return true;
            },
            () => {
              const current = useLaneContractStore
                .getState()
                .lanesForOwner(genome.laneOwnerId)
                .find((candidate) => candidate.dataset.trackId === trackId);
              return (
                current?.dataset.kind === 'pileup' &&
                current.dataset.source?.remote?.locator === savedRemote &&
                current.dataset.source.remote.sessionId === oldSessionId
              );
            }
          );
        } catch (error) {
          if (error instanceof RemoteAdmissionCancelledError) throw error;
          throw new Error(remoteReconnectFailureMessage(requestedSource.target, error));
        }
      })();
      remoteReconnects.current.set(trackId, reconnect);
      try {
        return await reconnect;
      } finally {
        if (remoteReconnects.current.get(trackId) === reconnect) {
          remoteReconnects.current.delete(trackId);
        }
      }
    },
    [
      genome,
      reconnectRemoteSignalTrack,
      refreshRemoteSignalUntilHealthy,
      replaceLaneDataset,
      withRemoteAdmission,
    ]
  );

  const editRemoteTrack = useCallback(
    async (trackId: string, request: RemoteAlignmentConnectRequestV1): Promise<void> => {
      setLastOperation('repair');
      setNotice(null);
      setBusy(`Checking ${request.alignmentPath} on ${request.target}…`);
      try {
        const repaired = await reconnectRemoteTrack(trackId, request, true);
        if (!repaired) throw new Error('This track has no saved remote source.');
        if (mounted.current)
          setNotice({
            kind: 'success',
            text: `Updated the remote source to ${request.alignmentPath} on ${request.target}.`,
          });
      } catch (error) {
        const message = remoteReconnectFailureMessage(request.target, error);
        if (mounted.current) setNotice({ kind: 'error', text: message });
        if (error instanceof RemoteAdmissionCancelledError) throw error;
        throw new Error(message);
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [reconnectRemoteTrack]
  );

  const editRemoteSignalTrack = useCallback(
    async (trackId: string, request: RemoteSignalConnectRequestV1): Promise<void> => {
      setLastOperation('repair');
      setNotice(null);
      setBusy(`Checking ${request.signalPath} on ${request.target}…`);
      try {
        if (!(await reconnectRemoteSignalTrack(trackId, request, true)))
          throw new Error('This remote histogram is no longer available.');
        if (mounted.current)
          setNotice({
            kind: 'success',
            text: `Updated the remote source to ${request.signalPath} on ${request.target}.`,
          });
      } catch (error) {
        const message = remoteReconnectFailureMessage(request.target, error);
        if (mounted.current) setNotice({ kind: 'error', text: message });
        throw error instanceof RemoteAdmissionCancelledError ? error : new Error(message);
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [reconnectRemoteSignalTrack]
  );

  const repairTrack = useCallback(
    async (trackId: string): Promise<void> => {
      setLastOperation('repair');
      setNotice(null);
      setProgress(null);
      const lane = useLaneContractStore
        .getState()
        .lanesForOwner(genome.laneOwnerId)
        .find((candidate) => candidate.dataset.trackId === trackId);
      if (lane?.dataset.remoteSignal) {
        const remote = lane.dataset.remoteSignal;
        setBusy(`Opening ${lane.dataset.label} on ${remote.locator.target}…`);
        try {
          if (!(await reconnectRemoteSignalTrack(trackId, undefined, true)))
            throw new Error('This remote histogram is no longer available.');
          if (mounted.current)
            setNotice({
              kind: 'success',
              text: `Opened ${lane.dataset.label} again from ${remote.locator.target}.`,
            });
        } catch (error) {
          if (mounted.current)
            setNotice({
              kind: 'error',
              text: remoteReconnectFailureMessage(remote.locator.target, error),
            });
        } finally {
          if (mounted.current) setBusy(null);
        }
        return;
      }
      if (!lane || lane.dataset.kind !== 'pileup') {
        setNotice({ kind: 'error', text: 'This aligned-read track is no longer available.' });
        return;
      }

      const savedRemote = lane.dataset.source?.remote?.locator;
      if (savedRemote?.target && savedRemote.alignmentPath && savedRemote.indexPath) {
        const name = basenameForPath(savedRemote.alignmentPath);
        try {
          setBusy(`Opening ${name} on ${savedRemote.target}…`);
          await reconnectRemoteTrack(trackId, undefined, true);
          if (mounted.current)
            setNotice({
              kind: 'success',
              text: `Opened ${name} again from ${savedRemote.target}.`,
            });
        } catch (error) {
          if (error instanceof RemoteAdmissionCancelledError) {
            if (mounted.current) setNotice({ kind: 'warn', text: error.message });
            return;
          }
          const message = remoteReconnectFailureMessage(savedRemote.target, error);
          const current = useLaneContractStore
            .getState()
            .lanesForOwner(genome.laneOwnerId)
            .find((candidate) => candidate.dataset.trackId === trackId);
          const source = current?.dataset.source;
          if (
            mounted.current &&
            current &&
            source?.remote?.locator === savedRemote &&
            source.remote.sessionId === lane.dataset.source?.remote?.sessionId
          ) {
            replaceLaneDataset(genome.laneOwnerId, trackId, genome.assemblyId, {
              ...current.dataset,
              source: { ...source, admissionError: message },
            });
          }
          if (mounted.current) setNotice({ kind: 'error', text: message });
        } finally {
          if (mounted.current) {
            setBusy(null);
            setProgress(null);
          }
        }
        return;
      }

      let selection: string | string[] | null;
      try {
        selection = await platform().dialog.open({
          multiple: false,
          title: `Repair ${lane.dataset.label}`,
          filters: [
            { name: 'BAM or CRAM read alignments', extensions: ALIGNMENT_TRACK_DIALOG_EXTENSIONS },
            { name: 'All files', extensions: ['*'] },
          ],
        });
      } catch (error) {
        setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
        return;
      }
      const bamPath = Array.isArray(selection) ? selection[0] : selection;
      if (!bamPath) return;
      const name = basenameForPath(bamPath);
      const progressFor = (
        phase: BamTrackImportProgressPhase,
        label: string,
        stepNumber: number
      ): BamTrackImportProgress => ({
        phase,
        label,
        fileName: name,
        fileNumber: 1,
        fileCount: 1,
        stepNumber,
        stepCount: 4,
      });

      try {
        const prepared = await prepareForCurrentView(
          directTrackAdmissionRequest({
            assemblyId: genome.assemblyId,
            input: { kind: 'path', path: bamPath },
            ingress: 'file-picker',
          }),
          (phase, label, step) => {
            setBusy(
              phase === 'validating-reference'
                ? `Choosing the reference for ${name}…`
                : phase === 'checking-index'
                  ? `Checking ${name}…`
                  : `Validating ${name}…`
            );
            setProgress(progressFor(phase, label, step));
          }
        );
        setBusy(`Repairing ${lane.dataset.label}…`);
        setProgress(progressFor('adding-track', 'Repairing track', 4));
        const replacement = buildReadPileupDataset({
          assemblyId: genome.assemblyId,
          assemblyDisplayName: genome.displayName,
          bamPath: prepared.bamPath,
          indexPath: prepared.indexPath,
          ...(prepared.referencePath ? { referencePath: prepared.referencePath } : {}),
          generation: prepared.generation,
          ...(prepared.grantExpiresAtMs !== undefined
            ? { grantExpiresAtMs: prepared.grantExpiresAtMs }
            : {}),
          ...(prepared.htsget ? { htsget: prepared.htsget } : {}),
        });
        if (
          replaceLaneDataset(
            genome.laneOwnerId,
            trackId,
            genome.assemblyId,
            replacement,
            prepared.admittedSource
          ) === 'missing'
        ) {
          throw new Error('This aligned-read track was removed before Repair completed.');
        }
        setBusy(null);
        setProgress(null);
        setNotice({
          kind: 'success',
          text: `Repaired ${lane.dataset.label}. Preparing overview coverage in the background.`,
        });
        if (prepared.generation && prepared.indexPath)
          void startAlignmentCoverageOperation({
            assemblyId: genome.assemblyId,
            bamPath: prepared.bamPath,
            indexPath: prepared.indexPath,
            referencePath: prepared.referencePath,
            sourceGeneration: prepared.generation,
            chroms: genome.references.map((reference) => reference.name),
          })
            .then(() => {
              setNotice({
                kind: 'success',
                text: `Coverage preparation started for ${lane.dataset.label}. Follow it in Jobs.`,
              });
            })
            .catch((error) => {
              setNotice({
                kind: 'error',
                text: `${lane.dataset.label} was repaired, but overview coverage could not be started: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              });
            });
      } catch (error) {
        setBusy(null);
        setProgress(null);
        setNotice({
          kind: 'error',
          text: `${name}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
    [
      genome,
      prepareForCurrentView,
      reconnectRemoteSignalTrack,
      reconnectRemoteTrack,
      replaceLaneDataset,
    ]
  );

  return {
    busy,
    remoteConnecting,
    cancelRemoteConnect,
    cancelRemoteSignalConnect,
    progress,
    notice,
    lastOperation,
    clearNotice,
    recentRemoteEndpoints,
    refreshRemoteEndpoints,
    addRemote,
    addFiles,
    addRequests,
    reconnectRemoteTrack,
    editRemoteTrack,
    editRemoteSignalTrack,
    repairTrack,
  };
}

function remoteMaterializationConnection(
  materialization: RemoteAlignmentMaterializationV1 | RemoteSignalMaterializationV1,
  statuses: ReadonlyMap<string, RemoteGenomicsRuntimeStatusV1>
) {
  const sourceId =
    materialization.runtimeStatus?.sourceId ??
    ('bamUrl' in materialization ? remoteAlignmentSourceId(materialization.bamUrl) : null) ??
    remoteSignalSourceId(materialization.bigWigUrl ?? '');
  const latest = sourceId ? statuses.get(sourceId) : undefined;
  const status =
    latest &&
    (!materialization.runtimeStatus || latest.updatedAt >= materialization.runtimeStatus.updatedAt)
      ? latest
      : materialization.runtimeStatus;
  return status ? remotePileupConnectionFromStatus(status) : undefined;
}

function waitForRemoteAdmission<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = (): void => reject(new RemoteAdmissionCancelledError());
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

function waitForRemoteSignalRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(done, delayMs);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
