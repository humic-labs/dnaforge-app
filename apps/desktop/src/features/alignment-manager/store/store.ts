import { withUserMessage, userMessage } from '@waypoint/user-messages';
import { create } from 'zustand';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import type { MutationMarker } from '@waypoint/workspace-editor';
import type {
  OperationSnapshot,
  PairwiseSessionAlignmentRequest,
  PairwiseSessionAlignmentResult,
} from '@waypoint/api-client';
import { platform } from '../../../platform';
import { beginWorkflowAction, type WorkflowResultMetadata } from '../../../lib/workflow-telemetry';
import { classifyMutation, type Annotation, type GeneticCodeSpec } from '@waypoint/sequence-utils';
import { markLoadedVerificationState, startVerificationAutosave } from './verification-autosave';
import type {
  ReferenceVerificationState,
  VerificationSession,
  VerificationTrack,
  CreateSessionInput,
  SessionViewPreferences,
  AggregatedMutation,
  TrackStatus,
  SessionAlignmentOperationStatus,
  SessionAlignmentOperationQuery,
} from '../types';
import { stateToSidecar, sidecarToState, serializeSidecar, parseSidecar } from './sidecar';
import {
  readAlignmentHistory,
  writeAlignmentHistory,
  publishManagedAlignmentHistory,
} from '../utils/alignment-history-persist';
import { debugLog, debugWarn } from '../../../utils/debug-log';
import { withAlignmentHistoryAccess } from '../utils/alignment-history-access';
import { generateId, getDefaultViewMode, prefsKey } from '../utils/helpers';
import {
  computePairwiseQueryId,
  computePairwiseSessionSubjectId,
  computePairwiseQueryRevision,
  computePairwiseReferenceRevision,
  computeReferenceHash,
} from '../utils/hash';
import { resolveAlignmentQueryPath } from '../utils/alignment-query-path';
import { fingerprintAlignmentQuery, resolveAlignmentQuery } from '../utils/resolve-alignment-query';
import {
  findSequencePackageRootForReference,
  stageAlignmentQueryPaths,
} from '../utils/stage-alignment-query';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
} from '../../../db/sequence-package';
import { sequenceReferenceCheckpointId } from '../../../db/sequence-package-versioning';
import {
  readSequencePackageEvidenceRun,
  readSequencePackageHistoryIndex,
} from '../../../db/sequence-package-history-io';
import { projectPackageEvidence } from './package-evidence';
import {
  readSequenceFile,
  readReferenceForMutations,
  type AlignmentApiResponse,
} from '../utils/alignment-api';
import {
  PairwiseSessionOperationError,
  isPairwiseSessionAlignmentResult,
  pairwiseSessionOperationIdentity,
  startPairwiseSessionAlignmentOperation,
  stopPairwiseSessionAlignmentOperation,
  waitForPairwiseSessionAlignmentResult,
} from '../pairwise-session-operation-client';
import {
  computeTrackMutations,
  convertMutation,
  convertStructuralAnalysis,
  getTrackStatus,
  getAlignmentEvidence,
  calculateCoverage,
  queryInReferenceCoordinates,
  toMutationEffect,
} from '../utils/mutation-computation';
import { aggregateMutations } from './selectors/getAggregatedMutations';
import { detectPerSessionStaleness } from './staleness';
import {
  assertWorkspaceEditorsSettled,
  freezeWorkspaceEditorWrites,
  getWorkspaceEditorBlockers,
} from '../../../services/workspace-editor-mutation-state';
import { parseSequenceFileAsDocument } from '../../../shared/parse-sequence-file';
import type {
  SequenceEvidenceSessionState,
  SequenceEvidenceTrackState,
} from '../../../shared/sequence-package-evidence';
import { PAIRWISE_EVIDENCE_PARAMETERS } from '../../../shared/sequence-package-evidence';
import { useToastStore } from '../../../stores/toast-store';

interface VerificationStoreState {
  verificationState: Record<string, ReferenceVerificationState>;

  referenceSourcePaths: Record<string, string>;

  sessionViewPreferences: Record<string, SessionViewPreferences>;

  alignmentPanelOpen: Set<string>;

  focusedPosition: {
    documentId: string;
    trackId?: string;
    position: number;
    highlightRange?: { start: number; end: number };
    timestamp: number;
  } | null;

  sessionMutations: Record<
    string,
    {
      byTrack: Record<string, MutationMarker[]>;
      updatedAt: number;
    }
  >;

  staleReferences: Record<string, boolean>;

  referenceFileChecksums: Record<string, string>;

  staleSessionIds: Record<string, string[]>;

  pendingTrackIds: Record<string, Set<string>>;
}

interface VerificationStoreActions {
  registerReferenceSource: (documentId: string, sourcePath: string) => void;
  createSession: (documentId: string, input: CreateSessionInput) => string;
  runSessionAlignments: (
    documentId: string,
    sessionId: string,
    queryPaths: string[]
  ) => Promise<void>;
  prepareSessionAlignments: (
    documentId: string,
    sessionId: string,
    queryPaths: string[]
  ) => Promise<PairwiseSessionAlignmentRequest>;
  adoptSessionAlignmentOperation: (
    documentId: string,
    sessionId: string,
    operation: OperationSnapshot,
    onAdmitted?: () => void
  ) => Promise<void>;
  enrichSessionMutations: (documentId: string, sessionId: string) => Promise<void>;
  addTrackToSession: (documentId: string, sessionId: string, track: VerificationTrack) => void;
  updateTrack: (
    documentId: string,
    sessionId: string,
    trackId: string,
    updates: Partial<VerificationTrack>
  ) => void;
  setActiveSession: (documentId: string, sessionId: string | null) => void;
  removeSession: (documentId: string, sessionId: string) => Promise<void>;
  applySessionAlignmentResult: (
    documentId: string,
    sessionId: string,
    operationId: string,
    inputRevision: string,
    result: PairwiseSessionAlignmentResult,
    referenceSequence: string,
    querySequences: ReadonlyMap<string, string>,
    referenceAnnotations: Annotation[],
    referenceGeneticCode: GeneticCodeSpec,
    referenceChecksum: string | null,
    referenceTopology?: 'linear' | 'circular'
  ) => Promise<boolean>;
  resumeSessionAlignmentOperation: (documentId: string, sessionId: string) => Promise<void>;
  removeTrack: (documentId: string, sessionId: string, trackId: string) => void;
  getVerificationState: (documentId: string) => ReferenceVerificationState | undefined;
  getActiveSession: (documentId: string) => VerificationSession | undefined;
  setSessionViewPreferences: (
    documentId: string,
    sessionId: string,
    prefs: Partial<SessionViewPreferences>
  ) => void;
  getSessionViewPreferences: (
    documentId: string,
    sessionId: string
  ) => SessionViewPreferences | undefined;
  getAggregatedMutations: (documentId: string, sessionId: string) => AggregatedMutation[];
  navigateToPosition: (
    documentId: string,
    position: number,
    highlightRange?: { start: number; end: number },
    trackId?: string
  ) => void;

  clearFocusedPosition: () => void;

  getTrackMutations: (documentId: string, sessionId: string, trackId: string) => MutationMarker[];

  invalidateMutationCache: (documentId: string, sessionId: string) => void;

  renameSession: (documentId: string, sessionId: string, name: string) => void;

  renameTrack: (documentId: string, sessionId: string, trackId: string, label: string) => void;

  toggleAlignmentVisibility: (documentId: string, sessionId: string) => void;

  toggleTrackVisibility: (documentId: string, sessionId: string, trackId: string) => void;

  overrideTrackStatus: (
    documentId: string,
    sessionId: string,
    trackId: string,
    userStatus: TrackStatus | null,
    reason?: string
  ) => void;

  archiveSession: (documentId: string, sessionId: string) => void;

  unarchiveSession: (documentId: string, sessionId: string) => void;

  setAlignmentPanelOpen: (documentId: string, open: boolean) => void;

  saveSidecar: (
    documentId: string,
    options?: {
      force?: boolean;
      preserveStaleChecksum?: boolean;
      throwOnError?: boolean;
      onlyIfCurrent?: boolean;
    }
  ) => Promise<void>;

  loadSidecar: (documentId: string) => Promise<boolean>;

  checkStaleness: (documentId: string) => Promise<void>;

  toggleMutationChecked: (
    documentId: string,
    sessionId: string,
    trackId: string,
    mutationId: string
  ) => void;

  applyCheckedMutations: (documentId: string, sessionId: string, trackId: string) => Promise<void>;

  clearCheckedMutations: (documentId: string) => void;
}

type VerificationStore = VerificationStoreState & VerificationStoreActions;

const sidecarSaves = new Map<string, Promise<void>>();

function saveSidecarInOrder(sourcePath: string, save: () => Promise<void>): Promise<void> {
  const previous = sidecarSaves.get(sourcePath);
  const operation = previous ? previous.then(save, save) : save();
  sidecarSaves.set(sourcePath, operation);
  void operation
    .finally(() => {
      if (sidecarSaves.get(sourcePath) === operation) sidecarSaves.delete(sourcePath);
    })
    .catch(() => undefined);
  return operation;
}

const activeSessionRuns = new Map<string, Promise<void>>();

function runOneSessionOperation(
  documentId: string,
  sessionId: string,
  work: () => Promise<void>
): Promise<void> {
  const key = `${documentId}\u0000${sessionId}`;
  const existing = activeSessionRuns.get(key);
  if (existing) return existing;
  const run = work();
  activeSessionRuns.set(key, run);
  void run
    .finally(() => {
      if (activeSessionRuns.get(key) === run) activeSessionRuns.delete(key);
    })
    .catch(() => undefined);
  return run;
}

function requireReferenceSourcePath(state: VerificationStoreState, documentId: string): string {
  const sourcePath = state.referenceSourcePaths[documentId];
  if (!sourcePath) {
    throw new Error(`Sequence document source is unavailable: ${documentId}`);
  }
  return sourcePath;
}

async function readCurrentSessionAlignmentMaterialization(
  sourcePath: string,
  queries: readonly SessionAlignmentOperationQuery[]
): Promise<{
  referenceSequence: string;
  referenceAnnotations: Annotation[];
  referenceGeneticCode: GeneticCodeSpec;
  referenceTopology: 'linear' | 'circular';
  querySequences: ReadonlyMap<string, string>;
  referenceChecksum: string | null;
}> {
  const checksumBefore = await computeReferenceHash(sourcePath);
  const [referenceSequence, reference, queryEntries] = await Promise.all([
    readSequenceFile(sourcePath),
    readReferenceForMutations(sourcePath),
    Promise.all(
      queries.map(
        async (query) =>
          [
            query.id,
            await readSequenceFile(resolveAlignmentQueryPath(query.queryPath, sourcePath)),
          ] as const
      )
    ),
  ]);
  const checksumAfter = await computeReferenceHash(sourcePath);
  return {
    referenceSequence,
    referenceAnnotations: reference.annotations,
    referenceGeneticCode: reference.geneticCode,
    referenceTopology: reference.circular ? 'circular' : 'linear',
    querySequences: new Map(queryEntries),
    referenceChecksum:
      checksumBefore !== null && checksumBefore === checksumAfter ? checksumAfter : null,
  };
}

async function retainedEvidencePaths(
  sourcePath: string,
  runId: string
): Promise<{
  packageRoot: string;
  referenceReadPath: string;
  queryPaths: ReadonlyMap<string, string>;
}> {
  const packageRoot = await findSequencePackageRootForReference(sourcePath);
  if (!packageRoot) throw new Error('The package for this retained alignment run is unavailable.');
  const marker = parseSequencePackageDocument(
    await platform().fs.readTextFile(sequencePackagePaths(packageRoot).metaPath)
  );
  const run = marker.evidenceRuns?.find((candidate) => candidate.id === runId);
  if (!run) throw new Error('The retained alignment inputs are missing from the package.');
  return {
    packageRoot,
    referenceReadPath: fromPackageRelative(run.reference.artifact.path, packageRoot),
    queryPaths: new Map(
      run.queries.map((query) => [query.id, fromPackageRelative(query.artifact.path, packageRoot)])
    ),
  };
}

async function currentPackageCheckpointId(sourcePath: string): Promise<string | null> {
  const packageRoot = await findSequencePackageRootForReference(sourcePath);
  if (!packageRoot) return null;
  const marker = parseSequencePackageDocument(
    await platform().fs.readTextFile(sequencePackagePaths(packageRoot).metaPath)
  );
  return sequenceReferenceCheckpointId(marker);
}

async function readRetainedProducerResult(
  documentId: string,
  packageRoot: string,
  runId: string,
  operationId: string,
  inputRevision: string
): Promise<PairwiseSessionAlignmentResult | null> {
  const fs = platform().fs;
  const index = await readSequencePackageHistoryIndex({
    packageRoot,
    workspaceRoot: packageRoot,
    expectedPackageId: documentId,
    fs,
  });
  const run = index.document.evidenceRuns?.find((candidate) => candidate.id === runId);
  if (!run || run.status !== 'completed') return null;
  const read = await readSequencePackageEvidenceRun({
    index,
    runId,
    workspaceRoot: packageRoot,
    fs,
  });
  if (
    read.status !== 'available' ||
    run.managedOperationId !== operationId ||
    run.inputRevision !== inputRevision ||
    !isPairwiseSessionAlignmentResult(read.result)
  ) {
    throw new Error(
      'The retained producer result is unavailable or does not match this operation.'
    );
  }
  return read.result;
}

function evidenceTrackState(track: VerificationTrack): SequenceEvidenceTrackState {
  return {
    queryId: track.id,
    label: track.label,
    alignment: track.alignment,
    mutations: track.mutations,
    ...(track.structuralAnalysis ? { structuralAnalysis: track.structuralAnalysis } : {}),
    status: track.status,
    ...(track.userStatus ? { userStatus: track.userStatus } : {}),
    ...(track.userOverrideReason ? { userOverrideReason: track.userOverrideReason } : {}),
    ...(track.checkedMutations ? { checkedMutations: track.checkedMutations } : {}),
    alignedAt: track.alignedAt,
  };
}

async function appendRetainedEvidenceState(
  documentId: string,
  packageRoot: string,
  runId: string,
  tracks: readonly VerificationTrack[],
  session?: VerificationSession
): Promise<void> {
  await platform().fs.appendSequenceEvidenceState({
    workspaceRoot: packageRoot,
    packageRoot,
    packageId: documentId,
    runId,
    stateId: crypto.randomUUID(),
    classifier: 'mutation-impact-v1',
    ...(session ? { session: evidenceSessionState(session) } : {}),
    tracks: tracks.map(evidenceTrackState),
  });
}

function evidenceSessionState(session: VerificationSession): SequenceEvidenceSessionState {
  return {
    name: session.name,
    mode: session.mode,
    createdAt: session.createdAt,
    archived: session.archived === true,
  };
}

async function appendCurrentEvidenceStates(
  documentId: string,
  sourcePath: string,
  refState: ReferenceVerificationState
): Promise<void> {
  const packageRoot = await findSequencePackageRootForReference(sourcePath);
  if (!packageRoot) return;
  const marker = parseSequencePackageDocument(
    await platform().fs.readTextFile(sequencePackagePaths(packageRoot).metaPath)
  );
  const recorded = new Set(
    marker.evidenceRuns?.filter((run) => run.status === 'completed').map((run) => run.id) ?? []
  );
  const byRun = new Map<
    string,
    { session: VerificationSession; tracks: Map<string, VerificationTrack> }
  >();
  for (const session of refState.sessions) {
    for (const track of [...(session.historicalTracks ?? []), ...session.tracks]) {
      if (!track.evidenceRunId || !recorded.has(track.evidenceRunId)) continue;
      const entry = byRun.get(track.evidenceRunId) ?? {
        session,
        tracks: new Map<string, VerificationTrack>(),
      };
      entry.tracks.set(track.id, track);
      byRun.set(track.evidenceRunId, entry);
    }
  }
  for (const [runId, entry] of byRun) {
    await appendRetainedEvidenceState(
      documentId,
      packageRoot,
      runId,
      [...entry.tracks.values()],
      entry.session
    );
  }
}

async function readPackageEvidenceProjection(
  documentId: string,
  sourcePath: string,
  sidecarState?: ReferenceVerificationState
): Promise<ReferenceVerificationState | null> {
  const packageRoot = await findSequencePackageRootForReference(sourcePath);
  if (!packageRoot) return null;
  const index = await readSequencePackageHistoryIndex({
    packageRoot,
    workspaceRoot: packageRoot,
    expectedPackageId: documentId,
    fs: platform().fs,
  });
  const runs = index.document.evidenceRuns ?? [];
  if (runs.length === 0) return sidecarState ?? null;
  const reads = new Map();
  for (const run of runs) {
    if (run.status !== 'completed') continue;
    reads.set(
      run.id,
      await readSequencePackageEvidenceRun({
        index,
        runId: run.id,
        workspaceRoot: packageRoot,
        fs: platform().fs,
      })
    );
  }
  return projectPackageEvidence({ documentId, packageRoot, sidecarState, runs, reads });
}

function withCheckedMutationsCleared(
  refState: ReferenceVerificationState
): ReferenceVerificationState {
  return {
    ...refState,
    sessions: refState.sessions.map((session) => ({
      ...session,
      tracks: session.tracks.map((track) => ({
        ...track,
        checkedMutations: undefined,
      })),
    })),
  };
}

type AlignmentLoadRequest = {
  phase: 'loading' | 'ready' | 'retired' | 'error';
  sourcePath: string;
  baseline: ReferenceVerificationState | undefined;
};
const alignmentLoadRequests = new Map<string, AlignmentLoadRequest>();

export const useVerificationStore = create<VerificationStore>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        verificationState: {},
        referenceSourcePaths: {},
        sessionViewPreferences: {},
        alignmentPanelOpen: new Set<string>(),
        focusedPosition: null,
        sessionMutations: {},
        staleReferences: {},
        referenceFileChecksums: {},
        staleSessionIds: {},
        pendingTrackIds: {},

        registerReferenceSource: (documentId: string, sourcePath: string): void => {
          set((state) => {
            if (state.referenceSourcePaths[documentId] === sourcePath) return state;
            return {
              referenceSourcePaths: {
                ...state.referenceSourcePaths,
                [documentId]: sourcePath,
              },
            };
          });
        },

        createSession: (documentId: string, input: CreateSessionInput): string => {
          const trimmedName = input.name.trim();
          if (!trimmedName) {
            throw withUserMessage(
              new Error('Session name is required'),
              'failure.session-name-is-required'
            );
          }

          const sessionId = generateId();
          const now = new Date().toISOString();

          const newSession: VerificationSession = {
            id: sessionId,
            name: trimmedName,
            createdAt: now,
            mode: input.mode,
            tracks: [],
          };

          set((state) => {
            const existingState = state.verificationState[documentId];

            const updatedState: ReferenceVerificationState = existingState
              ? {
                  ...existingState,
                  sessions: [...existingState.sessions, newSession],
                  activeSessionId: sessionId,
                }
              : {
                  documentId,
                  sessions: [newSession],
                  activeSessionId: sessionId,
                };

            return {
              verificationState: {
                ...state.verificationState,
                [documentId]: updatedState,
              },
            };
          });

          return sessionId;
        },

        prepareSessionAlignments: async (
          documentId: string,
          sessionId: string,
          queryPaths: string[]
        ): Promise<PairwiseSessionAlignmentRequest> => {
          const sourcePath = requireReferenceSourcePath(get(), documentId);
          debugLog(
            `[runSessionAlignments] Starting alignments for session ${sessionId} with ${queryPaths.length} files`
          );

          if (queryPaths.length === 0) {
            throw new Error('At least one query file is required for session alignment.');
          }

          const packageRoot = await findSequencePackageRootForReference(sourcePath);
          const recordedSession = get().verificationState[documentId]?.sessions.find(
            (session) => session.id === sessionId
          );
          const recordedFingerprints = new Map<string, string>();
          for (const track of recordedSession?.tracks ?? []) {
            if (!track.queryFingerprint) continue;
            recordedFingerprints.set(track.queryPath, track.queryFingerprint);
            recordedFingerprints.set(
              resolveAlignmentQueryPath(track.queryPath, sourcePath),
              track.queryFingerprint
            );
          }
          const currentQueryPaths = await Promise.all(
            queryPaths.map(async (queryPath) => {
              const current = await resolveAlignmentQuery(
                { queryPath, queryFingerprint: recordedFingerprints.get(queryPath) },
                sourcePath
              );
              return current === resolveAlignmentQueryPath(queryPath, sourcePath)
                ? queryPath
                : current;
            })
          );
          let stagedQueryPaths = currentQueryPaths;
          try {
            if (!packageRoot || packageRoot.startsWith('/hosted/'))
              stagedQueryPaths = await stageAlignmentQueryPaths(sourcePath, currentQueryPaths);
          } catch (err) {
            console.warn(
              '[runSessionAlignments] Could not stage queries into the plasmid package; aligning in place:',
              err
            );
          }

          const currentSession = get().verificationState[documentId]?.sessions.find(
            (session) => session.id === sessionId
          );
          if (!currentSession) {
            debugWarn(`[runSessionAlignments] Session ${sessionId} no longer exists`);
            throw new Error('This alignment session no longer exists.');
          }

          const existingTracksByPath = new Map<string, VerificationTrack>();
          for (const track of currentSession.tracks) {
            existingTracksByPath.set(track.queryPath, track);
            existingTracksByPath.set(resolveAlignmentQueryPath(track.queryPath, sourcePath), track);
          }

          const queryDescriptors = await Promise.all(
            stagedQueryPaths.map(async (stagedPath, index) => {
              const requestedQueryPath = queryPaths[index] ?? stagedPath;
              const requestedPath = resolveAlignmentQueryPath(requestedQueryPath, sourcePath);
              const resolvedPath = resolveAlignmentQueryPath(stagedPath, sourcePath);
              const existingTrack =
                existingTracksByPath.get(requestedQueryPath) ??
                existingTracksByPath.get(stagedPath) ??
                existingTracksByPath.get(resolvedPath) ??
                existingTracksByPath.get(requestedPath);
              const queryPath = stagedPath;
              const filename = resolvedPath.split(/[\\/]/).pop() || 'Unknown';
              const queryFingerprint =
                (await fingerprintAlignmentQuery(resolvedPath)) ?? existingTrack?.queryFingerprint;
              return {
                id: existingTrack?.id ?? (await computePairwiseQueryId(sessionId, queryPath)),
                queryPath,
                label: existingTrack?.label ?? filename.replace(/\.[^.]+$/, ''),
                resolvedPath,
                ...(queryFingerprint ? { queryFingerprint } : {}),
              };
            })
          );
          const evidenceRunId =
            packageRoot && !packageRoot.startsWith('/hosted/') ? crypto.randomUUID() : null;
          const prepared =
            packageRoot && evidenceRunId
              ? await platform().fs.prepareSequenceEvidenceRun({
                  workspaceRoot: packageRoot,
                  packageRoot,
                  packageId: documentId,
                  sourcePath,
                  sessionId,
                  session: {
                    name: currentSession.name,
                    mode: currentSession.mode,
                    createdAt: currentSession.createdAt,
                  },
                  runId: evidenceRunId,
                  queries: queryDescriptors.map(({ id, label, resolvedPath }) => ({
                    id,
                    label,
                    path: resolvedPath,
                  })),
                })
              : null;
          const referenceReadPath = prepared?.referenceReadPath ?? sourcePath;
          let referenceSequence: string;
          let testedReference: NonNullable<VerificationTrack['testedReference']>;
          let queryPlans: Array<(typeof queryDescriptors)[number] & { sequence: string }>;
          try {
            const referenceChecksumBefore = await computeReferenceHash(referenceReadPath);
            let referenceAtStart: Awaited<ReturnType<typeof readReferenceForMutations>>;
            try {
              [referenceSequence, referenceAtStart] = await Promise.all([
                readSequenceFile(referenceReadPath),
                readReferenceForMutations(referenceReadPath),
              ]);
            } catch (error) {
              throw new Error(
                `Failed to read sequence document: ${error instanceof Error ? error.message : 'Unknown error'}`
              );
            }
            const referenceChecksumAfter = await computeReferenceHash(referenceReadPath);
            if (!referenceChecksumBefore || referenceChecksumBefore !== referenceChecksumAfter) {
              throw new Error('The reference changed while the alignment input was read.');
            }
            testedReference = prepared
              ? {
                  fileSha256: prepared.run.reference.artifact.sha256,
                  sequenceRevision: prepared.run.reference.sequenceRevision,
                  topology: prepared.run.reference.topology,
                  checkpointId: prepared.run.reference.checkpointId,
                }
              : {
                  fileSha256: referenceChecksumBefore,
                  sequenceRevision: await computePairwiseReferenceRevision(referenceSequence),
                  topology: referenceAtStart.circular ? 'circular' : 'linear',
                  checkpointId: await currentPackageCheckpointId(sourcePath),
                };
            if (
              referenceChecksumBefore !== testedReference.fileSha256 ||
              (await computePairwiseReferenceRevision(referenceSequence)) !==
                testedReference.sequenceRevision ||
              (referenceAtStart.circular ? 'circular' : 'linear') !== testedReference.topology
            ) {
              throw new Error('Frozen evidence reference does not match the alignment input.');
            }
            queryPlans = await Promise.all(
              queryDescriptors.map(async (query) => ({
                ...query,
                sequence: await readSequenceFile(
                  prepared?.queryPaths[query.id] ?? query.resolvedPath
                ),
              }))
            );
          } catch (error) {
            if (prepared && packageRoot && evidenceRunId) {
              await platform().fs.failSequenceEvidenceRun({
                workspaceRoot: packageRoot,
                packageRoot,
                packageId: documentId,
                runId: evidenceRunId,
                status: 'failed',
              });
            }
            throw error;
          }

          const plans = queryPlans.map(({ id, queryPath, label, queryFingerprint }) => ({
            id,
            queryPath: prepared?.attachedQueryPaths?.[id] ?? queryPath,
            label,
            ...(queryFingerprint ? { queryFingerprint } : {}),
          }));
          set((state) => {
            const reference = state.verificationState[documentId];
            return {
              verificationState: {
                ...state.verificationState,
                [documentId]: {
                  ...reference,
                  sessions: reference.sessions.map((session) =>
                    session.id === sessionId
                      ? {
                          ...session,
                          alignmentPreparation: plans,
                          alignmentPreparedReference: {
                            testedReference,
                            ...(evidenceRunId ? { evidenceRunId } : {}),
                          },
                        }
                      : session
                  ),
                },
              },
            };
          });
          try {
            await get().saveSidecar(documentId, {
              preserveStaleChecksum: true,
              throwOnError: true,
            });
          } catch (error) {
            if (prepared && packageRoot && evidenceRunId) {
              await platform().fs.failSequenceEvidenceRun({
                workspaceRoot: packageRoot,
                packageRoot,
                packageId: documentId,
                runId: evidenceRunId,
                status: 'failed',
              });
            }
            throw error;
          }
          return {
            referenceSequence,
            queries: queryPlans.map((query) => ({ id: query.id, sequence: query.sequence })),
            ...PAIRWISE_EVIDENCE_PARAMETERS,
            isCircular: testedReference.topology === 'circular',
          };
        },

        runSessionAlignments: async (documentId, sessionId, queryPaths): Promise<void> =>
          runOneSessionOperation(documentId, sessionId, async () => {
            const receipt = beginWorkflowAction({ workflow: 'alignment', action: 'compute' });
            let prepared = false;
            let operation: OperationSnapshot | undefined;
            const metadata = (): WorkflowResultMetadata => {
              const current = get().verificationState[documentId]?.sessions.find(
                (value) => value.id === sessionId
              )?.alignmentOperation;
              return {
                operationId: operation?.id,
                ...(current?.id === operation?.id
                  ? { artifactCorrelationId: current?.inputCorrelationId }
                  : {}),
              };
            };
            try {
              const input = await get().prepareSessionAlignments(documentId, sessionId, queryPaths);
              prepared = true;
              try {
                const sourcePath = requireReferenceSourcePath(get(), documentId);
                const session = get().verificationState[documentId]?.sessions.find(
                  (value) => value.id === sessionId
                );
                const evidenceRunId = session?.alignmentPreparedReference?.evidenceRunId;
                const retained = evidenceRunId
                  ? await retainedEvidencePaths(sourcePath, evidenceRunId)
                  : null;
                operation = await startPairwiseSessionAlignmentOperation(
                  documentId,
                  sessionId,
                  input,
                  [
                    { key: 'reference', path: retained?.referenceReadPath ?? sourcePath },
                    ...(session?.alignmentPreparation ?? []).map((query) => ({
                      key: `query:${query.id}`,
                      path:
                        retained?.queryPaths.get(query.id) ??
                        resolveAlignmentQueryPath(query.queryPath, sourcePath),
                    })),
                  ]
                );
              } catch (error) {
                const evidenceRunId = get().verificationState[documentId]?.sessions.find(
                  (session) => session.id === sessionId
                )?.alignmentPreparedReference?.evidenceRunId;
                if (evidenceRunId) {
                  const sourcePath = requireReferenceSourcePath(get(), documentId);
                  const packageRoot = await findSequencePackageRootForReference(sourcePath);
                  if (packageRoot)
                    await platform().fs.failSequenceEvidenceRun({
                      workspaceRoot: packageRoot,
                      packageRoot,
                      packageId: documentId,
                      runId: evidenceRunId,
                      status: 'failed',
                    });
                }
                throw error;
              }
              await get().adoptSessionAlignmentOperation(documentId, sessionId, operation);
              const current = get().verificationState[documentId]?.sessions.find(
                (value) => value.id === sessionId
              )?.alignmentOperation;
              if (current?.id !== operation.id) {
                receipt.complete({
                  ...metadata(),
                  status: 'stopped',
                  outcomeKind: 'alignment_superseded',
                });
              } else if (current.status === 'succeeded' && !current.attachmentError) {
                receipt.complete({
                  ...metadata(),
                  status: 'ready',
                  outcomeKind: 'alignment_attached',
                  resultCount: current.queries.length,
                  usableResult: true,
                });
              } else {
                receipt.complete({
                  ...metadata(),
                  status: 'needs_action',
                  outcomeKind: 'alignment_not_attached',
                  resultCount: 0,
                });
              }
            } catch (error) {
              if (
                error instanceof PairwiseSessionOperationError &&
                error.operationState === 'canceled'
              ) {
                receipt.cancel(metadata());
              } else if (error instanceof PairwiseSessionOperationError) {
                receipt.fail('alignment_execution_failed', {
                  ...metadata(),
                  status: error.operationState === 'interrupted' ? 'stopped' : 'failed',
                });
              } else if (operation) {
                receipt.fail('alignment_observation_failed', {
                  ...metadata(),
                  status: 'needs_action',
                });
              } else if (!prepared) {
                receipt.fail('alignment_inputs_refused', {
                  status: 'blocked',
                  outcomeKind: 'validation_refused',
                });
              } else {
                receipt.fail('alignment_submission_failed', { status: 'failed' });
              }
              throw error;
            }
          }),

        adoptSessionAlignmentOperation: async (
          documentId,
          sessionId,
          operation,
          onAdmitted
        ): Promise<void> => {
          if (operation.kind !== 'pairwise-session-alignment')
            throw new Error('This job did not align a clone session.');
          if (
            operation.subject.subject_id !==
            (await computePairwiseSessionSubjectId(documentId, sessionId))
          )
            throw new Error('This alignment job belongs to a different reference or session.');
          const sourcePath = requireReferenceSourcePath(get(), documentId);
          const session = get().verificationState[documentId]?.sessions.find(
            (item) => item.id === sessionId
          );
          if (session?.alignmentOperation?.id === operation.id) {
            const queryPathsById = new Map(
              session.alignmentPreparation?.map((query) => [query.id, query.queryPath]) ?? []
            );
            if (queryPathsById.size > 0) {
              set((state) => {
                const reference = state.verificationState[documentId];
                return {
                  verificationState: {
                    ...state.verificationState,
                    [documentId]: {
                      ...reference,
                      sessions: reference.sessions.map((current) =>
                        current.id === sessionId && current.alignmentOperation?.id === operation.id
                          ? {
                              ...current,
                              tracks: current.tracks.map((track) => ({
                                ...track,
                                queryPath: queryPathsById.get(track.id) ?? track.queryPath,
                              })),
                              alignmentOperation: {
                                ...current.alignmentOperation,
                                queries: current.alignmentOperation.queries.map((query) => ({
                                  ...query,
                                  queryPath: queryPathsById.get(query.id) ?? query.queryPath,
                                })),
                              },
                            }
                          : current
                      ),
                    },
                  },
                };
              });
            }
            await get().saveSidecar(documentId, {
              preserveStaleChecksum: true,
              throwOnError: true,
            });
            onAdmitted?.();
            return;
          }
          const queryPlans = session?.alignmentPreparation;
          const admission = session?.alignmentPreparedReference;
          if (!queryPlans?.length || !admission)
            throw new Error(
              'This session has no verified prepared source inputs. Prepare the analysis again.'
            );
          const { testedReference, evidenceRunId } = admission;
          const retained = evidenceRunId
            ? await retainedEvidencePaths(sourcePath, evidenceRunId)
            : null;
          const prepared = retained
            ? { ...retained, queryPaths: Object.fromEntries(retained.queryPaths) }
            : null;
          const packageRoot = retained?.packageRoot;
          const referenceReadPath = retained?.referenceReadPath ?? sourcePath;
          const pendingKey = prefsKey(documentId, sessionId);
          set((state) => ({
            pendingTrackIds: {
              ...state.pendingTrackIds,
              [pendingKey]: new Set(queryPlans.map((query) => query.id)),
            },
          }));

          const identity = pairwiseSessionOperationIdentity(operation);
          if (prepared && packageRoot && evidenceRunId) {
            try {
              await platform().fs.activateSequenceEvidenceRun({
                workspaceRoot: packageRoot,
                packageRoot,
                packageId: documentId,
                runId: evidenceRunId,
                managedOperationId: identity.id,
                inputRevision: identity.inputRevision,
              });
            } catch (error) {
              await stopPairwiseSessionAlignmentOperation(identity.id).catch((stopError) => {
                debugWarn('[runSessionAlignments] Could not stop unrecorded operation', stopError);
              });
              set((state) => {
                const { [pendingKey]: _, ...remainingPending } = state.pendingTrackIds;
                return { pendingTrackIds: remainingPending };
              });
              throw error;
            }
          }
          let admitted = false;
          let supersededOperationId: string | undefined;
          set((state) => {
            const refState = state.verificationState[documentId];
            const sessionIndex = refState?.sessions.findIndex(
              (session) => session.id === sessionId
            );
            if (!refState || sessionIndex === undefined || sessionIndex < 0) return state;
            admitted = true;
            const sessions = [...refState.sessions];
            const previousOperation = sessions[sessionIndex].alignmentOperation;
            if (previousOperation?.status === 'active' && previousOperation.id !== identity.id) {
              supersededOperationId = previousOperation.id;
            }
            sessions[sessionIndex] = {
              ...sessions[sessionIndex],
              alignmentPreparation: undefined,
              alignmentPreparedReference: undefined,
              alignmentOperation: {
                id: identity.id,
                inputRevision: identity.inputRevision,
                inputCorrelationId: crypto.randomUUID(),
                status: 'active',
                testedReference,
                ...(evidenceRunId ? { evidenceRunId } : {}),
                queries: queryPlans.map(({ id, queryPath, label, queryFingerprint }) => ({
                  id,
                  queryPath,
                  label,
                  ...(queryFingerprint ? { queryFingerprint } : {}),
                })),
              },
            };
            return {
              verificationState: {
                ...state.verificationState,
                [documentId]: { ...refState, sessions },
              },
            };
          });

          if (!admitted) {
            await stopPairwiseSessionAlignmentOperation(identity.id).catch((error) => {
              debugWarn('[runSessionAlignments] Could not stop orphaned operation', error);
            });
            if (prepared && packageRoot && evidenceRunId) {
              await platform().fs.failSequenceEvidenceRun({
                workspaceRoot: packageRoot,
                packageRoot,
                packageId: documentId,
                runId: evidenceRunId,
                managedOperationId: identity.id,
                inputRevision: identity.inputRevision,
                status: 'canceled',
              });
            }
            return;
          }

          if (supersededOperationId) {
            await stopPairwiseSessionAlignmentOperation(supersededOperationId).catch((error) => {
              debugWarn('[runSessionAlignments] Could not stop superseded operation', error);
            });
          }

          await get().saveSidecar(documentId, { preserveStaleChecksum: true, throwOnError: true });
          onAdmitted?.();

          try {
            const result = await waitForPairwiseSessionAlignmentResult(identity);
            if (prepared && packageRoot && evidenceRunId) {
              await platform().fs.completeSequenceEvidenceRun({
                workspaceRoot: packageRoot,
                packageRoot,
                packageId: documentId,
                runId: evidenceRunId,
                managedOperationId: identity.id,
                inputRevision: identity.inputRevision,
                result,
              });
            }
            const current = await readCurrentSessionAlignmentMaterialization(
              referenceReadPath,
              queryPlans.map((query) => ({
                ...query,
                queryPath: prepared?.queryPaths[query.id] ?? query.queryPath,
              }))
            );
            const applied = await get().applySessionAlignmentResult(
              documentId,
              sessionId,
              identity.id,
              identity.inputRevision,
              result,
              current.referenceSequence,
              current.querySequences,
              current.referenceAnnotations,
              current.referenceGeneticCode,
              current.referenceChecksum,
              current.referenceTopology
            );
            if (applied) await get().checkStaleness(documentId);
          } catch (error) {
            const terminalFailure = error instanceof PairwiseSessionOperationError;
            const status: SessionAlignmentOperationStatus =
              terminalFailure &&
              (error.operationState === 'canceled' || error.operationState === 'interrupted')
                ? error.operationState
                : 'failed';
            let sessionStillOwnsOperation = false;
            set((state) => {
              const refState = state.verificationState[documentId];
              if (!refState) return state;
              const sessions = refState.sessions.map((session) => {
                if (
                  session.id !== sessionId ||
                  session.alignmentOperation?.id !== identity.id ||
                  session.alignmentOperation.inputRevision !== identity.inputRevision
                ) {
                  return session;
                }
                sessionStillOwnsOperation = true;
                const failedIds = new Set(
                  session.alignmentOperation.queries.map((query) => query.id)
                );
                return {
                  ...session,
                  alignmentOperation: {
                    ...session.alignmentOperation,
                    status: terminalFailure ? status : ('active' as const),
                  },
                  tracks: session.tracks.map((track) =>
                    terminalFailure && failedIds.has(track.id)
                      ? { ...track, failedToRealign: true }
                      : track
                  ),
                };
              });
              const { [pendingKey]: _, ...remainingPending } = state.pendingTrackIds;
              return {
                verificationState: {
                  ...state.verificationState,
                  [documentId]: { ...refState, sessions },
                },
                pendingTrackIds: remainingPending,
              };
            });
            if (!sessionStillOwnsOperation) return;
            if (prepared && packageRoot && evidenceRunId && terminalFailure) {
              await platform().fs.failSequenceEvidenceRun({
                workspaceRoot: packageRoot,
                packageRoot,
                packageId: documentId,
                runId: evidenceRunId,
                managedOperationId: identity.id,
                inputRevision: identity.inputRevision,
                status,
              });
            }
            await get().saveSidecar(documentId, { preserveStaleChecksum: true });
            throw error;
          }
        },

        applySessionAlignmentResult: async (
          documentId,
          sessionId,
          operationId,
          inputRevision,
          result,
          referenceSequence,
          querySequences,
          referenceAnnotations,
          referenceGeneticCode,
          referenceChecksum,
          referenceTopology
        ): Promise<boolean> =>
          withAlignmentHistoryAccess(get().referenceSourcePaths[documentId] ?? '', async () => {
            const session = get().verificationState[documentId]?.sessions.find(
              (value) => value.id === sessionId
            );
            const operation = session?.alignmentOperation;
            if (
              !session ||
              !operation ||
              operation.id !== operationId ||
              operation.inputRevision !== inputRevision ||
              operation.status !== 'active'
            ) {
              return false;
            }
            if (result.inputRevision !== inputRevision) {
              throw new Error('Pairwise session result revision no longer matches the session.');
            }

            const resultById = new Map(result.results.map((row) => [row.queryId, row]));
            if (
              resultById.size !== operation.queries.length ||
              operation.queries.some((query) => !resultById.has(query.id))
            ) {
              throw new Error('Pairwise session result did not contain every admitted query.');
            }

            const referenceRevision = await computePairwiseReferenceRevision(referenceSequence);
            const queryRevisionEntries = await Promise.all(
              operation.queries.map(async (query) => {
                const sequence = querySequences.get(query.id);
                if (sequence === undefined) {
                  throw new Error(`Query bytes are unavailable for managed result ${query.id}.`);
                }
                return [query.id, await computePairwiseQueryRevision(sequence)] as const;
              })
            );
            const queryRevisions = new Map(queryRevisionEntries);
            const bytesStillMatch =
              referenceChecksum !== null &&
              (operation.testedReference === undefined ||
                (operation.testedReference.fileSha256 === referenceChecksum &&
                  operation.testedReference.sequenceRevision === referenceRevision &&
                  (referenceTopology === undefined ||
                    operation.testedReference.topology === referenceTopology))) &&
              referenceRevision === result.referenceRevision &&
              result.results.every((row) => queryRevisions.get(row.queryId) === row.queryRevision);

            if (!bytesStillMatch || referenceChecksum === null) {
              const pendingKey = prefsKey(documentId, sessionId);
              set((state) => {
                const refState = state.verificationState[documentId];
                if (!refState) return state;
                const staleIds = new Set(state.staleSessionIds[documentId] ?? []);
                staleIds.add(sessionId);
                const sessions = refState.sessions.map((value) =>
                  value.id === sessionId &&
                  value.alignmentOperation?.id === operationId &&
                  value.alignmentOperation.status === 'active'
                    ? {
                        ...value,
                        alignmentOperation: {
                          ...value.alignmentOperation,
                          status: 'succeeded' as const,
                          attachmentError:
                            'The input sequences changed. Re-run for the current inputs.',
                        },
                      }
                    : value
                );
                const { [pendingKey]: _, ...remainingPending } = state.pendingTrackIds;
                return {
                  verificationState: {
                    ...state.verificationState,
                    [documentId]: { ...refState, sessions },
                  },
                  staleSessionIds: {
                    ...state.staleSessionIds,
                    [documentId]: [...staleIds],
                  },
                  staleReferences: { ...state.staleReferences, [documentId]: true },
                  pendingTrackIds: remainingPending,
                };
              });
              if (!requireReferenceSourcePath(get(), documentId).startsWith('/hosted/')) {
                await get().saveSidecar(documentId, { preserveStaleChecksum: true });
              }
              return false;
            }

            const alignedAt = new Date().toISOString();
            const nextTracks = [...session.tracks];
            for (const query of operation.queries) {
              const row = resultById.get(query.id);
              if (!row) throw new Error('The alignment result is missing a query.');
              const alignmentResult = row.alignment as AlignmentApiResponse;
              const querySequence = queryInReferenceCoordinates(
                alignmentResult.aligned_reference,
                alignmentResult.aligned_query,
                referenceSequence
              );
              const apiMutations = alignmentResult.mutations ?? [];
              const coverage = calculateCoverage(
                alignmentResult.aligned_reference,
                alignmentResult.aligned_query
              );
              const structuralAnalysis = alignmentResult.analysis
                ? convertStructuralAnalysis(alignmentResult.analysis)
                : undefined;
              const mutations = apiMutations.map((apiMutation, index) => {
                const mutation = convertMutation(apiMutation, index);
                if (referenceAnnotations.length > 0) {
                  const impact = classifyMutation(
                    apiMutation,
                    referenceSequence,
                    querySequence,
                    referenceAnnotations,
                    referenceGeneticCode
                  );
                  mutation.effect = toMutationEffect(impact, apiMutation.type);
                }
                return mutation;
              });
              const replacement = {
                queryPath: query.queryPath,
                ...(query.queryFingerprint ? { queryFingerprint: query.queryFingerprint } : {}),
                alignment: {
                  alignedReference: alignmentResult.aligned_reference,
                  alignedQuery: alignmentResult.aligned_query,
                  identity: alignmentResult.identity,
                  coverageStart: coverage.start,
                  coverageEnd: coverage.end,
                  algorithm: 'MAFFT' as const,
                },
                mutations,
                structuralAnalysis,
                status: getTrackStatus(
                  alignmentResult.identity,
                  apiMutations.length,
                  structuralAnalysis?.overallAssessment,
                  getAlignmentEvidence(
                    alignmentResult.aligned_reference,
                    alignmentResult.aligned_query
                  ).complete
                ),
                alignedAt,
                testedReference: operation.testedReference ?? {
                  fileSha256: referenceChecksum,
                  sequenceRevision: referenceRevision,
                  topology: referenceTopology ?? 'linear',
                  checkpointId: null,
                },
                evidenceRunId: operation.evidenceRunId,
                checkedMutations: undefined,
                failedToRealign: undefined,
              };
              const existingIndex = nextTracks.findIndex(
                (track) => track.id === query.id || track.queryPath === query.queryPath
              );
              if (existingIndex >= 0) {
                nextTracks[existingIndex] = { ...nextTracks[existingIndex], ...replacement };
              } else {
                nextTracks.push({
                  id: query.id,
                  label: query.label,
                  ...replacement,
                });
              }
            }

            const sourcePath = requireReferenceSourcePath(get(), documentId);
            if (operation.evidenceRunId) {
              const packageRoot = await findSequencePackageRootForReference(sourcePath);
              if (!packageRoot)
                throw new Error('The package for this retained alignment result is unavailable.');
              await appendRetainedEvidenceState(
                documentId,
                packageRoot,
                operation.evidenceRunId,
                operation.queries.map((query) => {
                  const track = nextTracks.find((candidate) => candidate.id === query.id);
                  if (!track) throw new Error('An interpreted evidence track is missing.');
                  return track;
                }),
                session
              );
            }
            const latestReferenceHash = await computeReferenceHash(sourcePath);
            const currentCheckpointId = await currentPackageCheckpointId(sourcePath);
            const runStillCurrent =
              latestReferenceHash !== null &&
              latestReferenceHash ===
                (operation.testedReference?.fileSha256 ?? referenceChecksum) &&
              (!operation.testedReference ||
                operation.testedReference.checkpointId === currentCheckpointId);

            const pendingKey = prefsKey(documentId, sessionId);
            const beforePublication = get();
            const currentReference = beforePublication.verificationState[documentId];
            const currentSession = currentReference?.sessions.find(
              (value) => value.id === sessionId
            );
            if (
              !currentSession ||
              currentSession.alignmentOperation?.id !== operationId ||
              currentSession.alignmentOperation.status !== 'active'
            )
              return false;
            const candidate = {
              ...currentReference,
              sessions: currentReference.sessions.map((value) =>
                value.id === sessionId
                  ? {
                      ...value,
                      tracks: nextTracks,
                      historicalTracks: [
                        ...(currentSession.historicalTracks ?? []),
                        ...currentSession.tracks.filter((track) =>
                          operation.queries.some(
                            (query) => query.id === track.id || query.queryPath === track.queryPath
                          )
                        ),
                      ],
                      alignmentOperation: {
                        ...operation,
                        status: 'succeeded' as const,
                        attachmentError: undefined,
                      },
                    }
                  : value
              ),
            };
            let published = false;
            try {
              published = await publishManagedAlignmentHistory(
                sourcePath,
                serializeSidecar(
                  stateToSidecar(
                    sourcePath
                      .split('/')
                      .pop()
                      ?.replace(/\.[^.]+$/, '') ?? 'unknown',
                    candidate,
                    beforePublication.sessionViewPreferences,
                    referenceChecksum
                  )
                ),
                operation
              );
            } catch (error) {
              set((state) => {
                const ref = state.verificationState[documentId];
                if (
                  !ref ||
                  !ref.sessions.some(
                    (value) =>
                      value.id === sessionId && value.alignmentOperation?.id === operationId
                  )
                )
                  return state;
                const { [pendingKey]: _, ...remaining } = state.pendingTrackIds;
                return {
                  verificationState: {
                    ...state.verificationState,
                    [documentId]: {
                      ...ref,
                      sessions: ref.sessions.map((value) =>
                        value.id === sessionId
                          ? {
                              ...value,
                              alignmentOperation: {
                                ...operation,
                                status: 'succeeded',
                                attachmentError:
                                  error instanceof Error ? error.message : String(error),
                              },
                            }
                          : value
                      ),
                    },
                  },
                  staleReferences: { ...state.staleReferences, [documentId]: true },
                  staleSessionIds: {
                    ...state.staleSessionIds,
                    [documentId]: [
                      ...new Set([...(state.staleSessionIds[documentId] ?? []), sessionId]),
                    ],
                  },
                  pendingTrackIds: remaining,
                };
              });
              return false;
            }
            let applied = false;
            set((state) => {
              const refState = state.verificationState[documentId];
              if (!refState) return state;
              const sessionIndex = refState.sessions.findIndex((value) => value.id === sessionId);
              const current = refState.sessions[sessionIndex];
              if (
                sessionIndex < 0 ||
                current.alignmentOperation?.id !== operationId ||
                current.alignmentOperation.inputRevision !== inputRevision ||
                current.alignmentOperation.status !== 'active'
              ) {
                return state;
              }
              applied = true;
              const sessions = [...refState.sessions];
              sessions[sessionIndex] = {
                ...current,
                tracks: nextTracks,
                historicalTracks: [
                  ...(current.historicalTracks ?? []),
                  ...current.tracks.filter((track) =>
                    operation.queries.some(
                      (query) => query.id === track.id || query.queryPath === track.queryPath
                    )
                  ),
                ],
                alignmentOperation: { ...current.alignmentOperation, status: 'succeeded' },
              };
              const staleIds = new Set(state.staleSessionIds[documentId] ?? []);
              if (runStillCurrent) staleIds.delete(sessionId);
              else staleIds.add(sessionId);
              const { [pendingKey]: _, ...remainingPending } = state.pendingTrackIds;
              return {
                verificationState: {
                  ...state.verificationState,
                  [documentId]: { ...refState, sessions },
                },
                staleSessionIds: { ...state.staleSessionIds, [documentId]: [...staleIds] },
                staleReferences: {
                  ...state.staleReferences,
                  [documentId]: staleIds.size > 0,
                },
                referenceFileChecksums:
                  referenceChecksum && runStillCurrent
                    ? { ...state.referenceFileChecksums, [documentId]: referenceChecksum }
                    : state.referenceFileChecksums,
                pendingTrackIds: remainingPending,
              };
            });
            if (applied && !published)
              await get().saveSidecar(documentId, { force: true, throwOnError: true });
            return applied;
          }),

        resumeSessionAlignmentOperation: async (documentId, sessionId): Promise<void> => {
          const state = get();
          const sourcePath = requireReferenceSourcePath(state, documentId);
          const session = state.verificationState[documentId]?.sessions.find(
            (value) => value.id === sessionId
          );
          const operation = session?.alignmentOperation;
          if (!session || !operation || operation.status !== 'active') return;

          const pendingKey = prefsKey(documentId, sessionId);
          set((current) => ({
            pendingTrackIds: {
              ...current.pendingTrackIds,
              [pendingKey]: new Set(operation.queries.map((query) => query.id)),
            },
          }));

          let retained: Awaited<ReturnType<typeof retainedEvidencePaths>> | null = null;
          try {
            retained = operation.evidenceRunId
              ? await retainedEvidencePaths(sourcePath, operation.evidenceRunId)
              : null;
            const archivedResult =
              retained && operation.evidenceRunId
                ? await readRetainedProducerResult(
                    documentId,
                    retained.packageRoot,
                    operation.evidenceRunId,
                    operation.id,
                    operation.inputRevision
                  )
                : null;
            const result =
              archivedResult ??
              (await waitForPairwiseSessionAlignmentResult({
                id: operation.id,
                inputRevision: operation.inputRevision,
              }));
            if (retained && operation.evidenceRunId && !archivedResult) {
              await platform().fs.completeSequenceEvidenceRun({
                workspaceRoot: retained.packageRoot,
                packageRoot: retained.packageRoot,
                packageId: documentId,
                runId: operation.evidenceRunId,
                managedOperationId: operation.id,
                inputRevision: operation.inputRevision,
                result,
              });
            }
            const current = await readCurrentSessionAlignmentMaterialization(
              retained?.referenceReadPath ?? sourcePath,
              operation.queries.map((query) => ({
                ...query,
                queryPath: retained?.queryPaths.get(query.id) ?? query.queryPath,
              }))
            );
            const applied = await get().applySessionAlignmentResult(
              documentId,
              sessionId,
              operation.id,
              operation.inputRevision,
              result,
              current.referenceSequence,
              current.querySequences,
              current.referenceAnnotations,
              current.referenceGeneticCode,
              current.referenceChecksum,
              current.referenceTopology
            );
            if (applied) await get().checkStaleness(documentId);
          } catch (error) {
            const terminalFailure = error instanceof PairwiseSessionOperationError;
            const status: SessionAlignmentOperationStatus =
              terminalFailure &&
              (error.operationState === 'canceled' || error.operationState === 'interrupted')
                ? error.operationState
                : 'failed';
            set((current) => {
              const refState = current.verificationState[documentId];
              if (!refState) return current;
              const sessions = refState.sessions.map((value) =>
                value.id === sessionId &&
                value.alignmentOperation?.id === operation.id &&
                value.alignmentOperation.status === 'active'
                  ? {
                      ...value,
                      alignmentOperation: {
                        ...value.alignmentOperation,
                        status: terminalFailure ? status : ('active' as const),
                      },
                    }
                  : value
              );
              const { [pendingKey]: _, ...remainingPending } = current.pendingTrackIds;
              return {
                verificationState: {
                  ...current.verificationState,
                  [documentId]: { ...refState, sessions },
                },
                pendingTrackIds: remainingPending,
              };
            });
            if (terminalFailure && retained && operation.evidenceRunId) {
              await platform()
                .fs.failSequenceEvidenceRun({
                  workspaceRoot: retained.packageRoot,
                  packageRoot: retained.packageRoot,
                  packageId: documentId,
                  runId: operation.evidenceRunId,
                  managedOperationId: operation.id,
                  inputRevision: operation.inputRevision,
                  status,
                })
                .catch((recordError) => {
                  debugWarn(
                    '[resumeSessionAlignmentOperation] Could not retain terminal status',
                    recordError
                  );
                });
            }
            await get().saveSidecar(documentId, { preserveStaleChecksum: true });
            debugWarn('[resumeSessionAlignmentOperation] Observation failed', error);
          }
        },

        enrichSessionMutations: async (documentId: string, sessionId: string): Promise<void> => {
          const state = get();
          const refState = state.verificationState[documentId];
          if (!refState) return;
          const sourcePath = requireReferenceSourcePath(state, documentId);

          const session = refState.sessions.find((s) => s.id === sessionId);
          if (!session) return;
          if (state.staleSessionIds[documentId]?.includes(sessionId)) return;

          const tracksNeedingEnrichment = session.tracks.filter(
            (t) =>
              !t.testedReference && t.mutations.length > 0 && t.mutations.some((m) => !m.effect)
          );
          if (tracksNeedingEnrichment.length === 0) return;

          const [{ annotations, geneticCode: referenceGeneticCode }, referenceBases] =
            await Promise.all([
              readReferenceForMutations(sourcePath),
              readSequenceFile(sourcePath),
            ]);
          if (annotations.length === 0) {
            debugLog('[enrichSessionMutations] No annotations found for reference, skipping');
            return;
          }

          debugLog(
            `[enrichSessionMutations] Enriching ${tracksNeedingEnrichment.length} tracks with ${annotations.length} annotations`
          );

          for (const track of tracksNeedingEnrichment) {
            try {
              const referenceSeq = referenceBases;
              const querySeq = queryInReferenceCoordinates(
                track.alignment.alignedReference,
                track.alignment.alignedQuery,
                referenceBases
              );

              const enrichedMutations = track.mutations.map((mutation) => {
                if (mutation.effect) return mutation;

                const impact = classifyMutation(
                  {
                    type: mutation.type,
                    position: mutation.position,
                    ref_base: mutation.referenceBase,
                    query_base: mutation.alternateBase,
                    length: mutation.length,
                  },
                  referenceSeq,
                  querySeq,
                  annotations,
                  referenceGeneticCode
                );

                return { ...mutation, effect: toMutationEffect(impact, mutation.type) };
              });

              get().updateTrack(documentId, sessionId, track.id, {
                mutations: enrichedMutations,
              });
            } catch (err) {
              console.error(`[enrichSessionMutations] Failed to enrich track ${track.label}:`, err);
            }
          }

          debugLog('[enrichSessionMutations] Enrichment complete');
        },

        addTrackToSession: (
          documentId: string,
          sessionId: string,
          track: VerificationTrack
        ): void => {
          if (track.alignment?.alignedReference === '' || track.alignment?.alignedQuery === '') {
            console.error('INVARIANT VIOLATION: Track added with empty alignment strings', {
              trackId: track.id,
              alignedRefLen: track.alignment?.alignedReference?.length,
              alignedQueryLen: track.alignment?.alignedQuery?.length,
            });
          }

          const state = get();
          const refState = state.verificationState[documentId];

          if (!refState) {
            throw new Error('Session not found');
          }

          const sessionIndex = refState.sessions.findIndex((s) => s.id === sessionId);
          if (sessionIndex === -1) {
            throw new Error('Session not found');
          }

          const trackMutations = computeTrackMutations(track);

          set((state) => {
            const refState = state.verificationState[documentId];
            const updatedSessions = [...refState.sessions];
            updatedSessions[sessionIndex] = {
              ...updatedSessions[sessionIndex],
              tracks: [...updatedSessions[sessionIndex].tracks, track],
            };

            const cacheKey = prefsKey(documentId, sessionId);
            const existingCache = state.sessionMutations[cacheKey];

            return {
              verificationState: {
                ...state.verificationState,
                [documentId]: {
                  ...refState,
                  sessions: updatedSessions,
                },
              },
              sessionMutations: {
                ...state.sessionMutations,
                [cacheKey]: {
                  byTrack: {
                    ...(existingCache?.byTrack ?? {}),
                    [track.id]: trackMutations,
                  },
                  updatedAt: Date.now(),
                },
              },
            };
          });
        },

        updateTrack: (
          documentId: string,
          sessionId: string,
          trackId: string,
          updates: Partial<VerificationTrack>
        ): void => {
          if (
            updates.alignment?.alignedReference === '' ||
            updates.alignment?.alignedQuery === ''
          ) {
            console.error('INVARIANT VIOLATION: Track updated with empty alignment strings', {
              trackId,
              alignedRefLen: updates.alignment?.alignedReference?.length,
              alignedQueryLen: updates.alignment?.alignedQuery?.length,
            });
          }

          set((state) => {
            const refState = state.verificationState[documentId];
            if (!refState) return state;

            const sessionIndex = refState.sessions.findIndex((s) => s.id === sessionId);
            if (sessionIndex === -1) return state;

            const session = refState.sessions[sessionIndex];
            const trackIndex = session.tracks.findIndex((t) => t.id === trackId);
            if (trackIndex === -1) return state;

            const updatedTracks = [...session.tracks];
            updatedTracks[trackIndex] = {
              ...updatedTracks[trackIndex],
              ...updates,
            };

            const updatedSessions = [...refState.sessions];
            updatedSessions[sessionIndex] = {
              ...session,
              tracks: updatedTracks,
            };

            const cacheKey = prefsKey(documentId, sessionId);
            const { [cacheKey]: _, ...remainingMutationCache } = state.sessionMutations;

            return {
              verificationState: {
                ...state.verificationState,
                [documentId]: {
                  ...refState,
                  sessions: updatedSessions,
                },
              },
              sessionMutations: remainingMutationCache,
            };
          });
        },

        setActiveSession: (documentId: string, sessionId: string | null): void => {
          set((state) => {
            const refState = state.verificationState[documentId];
            if (!refState) return state;

            return {
              verificationState: {
                ...state.verificationState,
                [documentId]: {
                  ...refState,
                  activeSessionId: sessionId,
                },
              },
            };
          });
        },

        removeSession: async (documentId: string, sessionId: string): Promise<void> => {
          const retainedSession = get().verificationState[documentId]?.sessions.find(
            (session) => session.id === sessionId
          );
          if (
            retainedSession &&
            (retainedSession.alignmentOperation?.evidenceRunId ||
              [...retainedSession.tracks, ...(retainedSession.historicalTracks ?? [])].some(
                (track) => Boolean(track.evidenceRunId)
              ))
          ) {
            get().archiveSession(documentId, sessionId);
            await get().saveSidecar(documentId);
            useToastStore
              .getState()
              .addToast(
                userMessage(
                  'notice.this-session-has-retained-sequencing-evidence-so-it-was-archived-inste'
                ),
                { definition: 'sequence-evidence-retained' }
              );
            return;
          }
          let activeOperationId: string | undefined;
          set((state) => {
            const refState = state.verificationState[documentId];
            if (!refState) return state;

            const removedSession = refState.sessions.find((session) => session.id === sessionId);
            if (removedSession?.alignmentOperation?.status === 'active') {
              activeOperationId = removedSession.alignmentOperation.id;
            }

            const updatedSessions = refState.sessions.filter((s) => s.id !== sessionId);

            let newActiveSessionId: string | null = refState.activeSessionId;
            if (refState.activeSessionId === sessionId) {
              newActiveSessionId =
                updatedSessions.length > 0 ? updatedSessions[updatedSessions.length - 1].id : null;
            }

            const prefKey = prefsKey(documentId, sessionId);
            const { [prefKey]: _, ...remainingPrefs } = state.sessionViewPreferences;
            const { [prefKey]: _pending, ...remainingPending } = state.pendingTrackIds;
            const staleIds = (state.staleSessionIds[documentId] ?? []).filter(
              (id) => id !== sessionId
            );

            return {
              verificationState: {
                ...state.verificationState,
                [documentId]: {
                  ...refState,
                  sessions: updatedSessions,
                  activeSessionId: newActiveSessionId,
                },
              },
              sessionViewPreferences: remainingPrefs,
              pendingTrackIds: remainingPending,
              staleSessionIds: { ...state.staleSessionIds, [documentId]: staleIds },
              staleReferences: {
                ...state.staleReferences,
                [documentId]: staleIds.length > 0,
              },
            };
          });

          const persistDeletion = get().referenceSourcePaths[documentId]
            ? get()
                .saveSidecar(documentId, { preserveStaleChecksum: true })
                .catch((error) =>
                  debugWarn(`[removeSession] Could not persist deletion for ${sessionId}`, error)
                )
            : Promise.resolve();

          if (activeOperationId) {
            try {
              await Promise.all([
                persistDeletion,
                stopPairwiseSessionAlignmentOperation(activeOperationId),
              ]);
            } catch (error) {
              debugWarn(
                `[removeSession] Could not confirm Stop for operation ${activeOperationId}`,
                error
              );
            }
          } else {
            await persistDeletion;
          }
        },

        removeTrack: (documentId: string, sessionId: string, trackId: string): void => {
          const retainedTrack = get()
            .verificationState[documentId]?.sessions.find((session) => session.id === sessionId)
            ?.tracks.find((track) => track.id === trackId);
          if (retainedTrack?.evidenceRunId) {
            useToastStore
              .getState()
              .addToast(
                userMessage(
                  'notice.this-read-belongs-to-retained-sequencing-evidence-hide-it-in-the-viewe'
                ),
                { definition: 'sequence-evidence-retained' }
              );
            return;
          }
          set((state) => {
            const refState = state.verificationState[documentId];
            if (!refState) return state;

            const sessionIndex = refState.sessions.findIndex((s) => s.id === sessionId);
            if (sessionIndex === -1) return state;

            const session = refState.sessions[sessionIndex];
            const updatedTracks = session.tracks.filter((t) => t.id !== trackId);

            const updatedSessions = [...refState.sessions];
            updatedSessions[sessionIndex] = {
              ...session,
              tracks: updatedTracks,
            };

            const cacheKey = prefsKey(documentId, sessionId);
            const { [cacheKey]: _, ...remainingMutationCache } = state.sessionMutations;

            return {
              verificationState: {
                ...state.verificationState,
                [documentId]: {
                  ...refState,
                  sessions: updatedSessions,
                },
              },
              sessionMutations: remainingMutationCache,
            };
          });
        },

        getVerificationState: (documentId: string): ReferenceVerificationState | undefined => {
          return get().verificationState[documentId];
        },

        getActiveSession: (documentId: string): VerificationSession | undefined => {
          const refState = get().verificationState[documentId];
          if (!refState || !refState.activeSessionId) return undefined;
          return refState.sessions.find((s) => s.id === refState.activeSessionId);
        },

        setSessionViewPreferences: (
          documentId: string,
          sessionId: string,
          prefs: Partial<SessionViewPreferences>
        ): void => {
          const key = prefsKey(documentId, sessionId);

          set((state) => {
            const existing = state.sessionViewPreferences[key];
            return {
              sessionViewPreferences: {
                ...state.sessionViewPreferences,
                [key]: {
                  ...existing,
                  ...prefs,
                } as SessionViewPreferences,
              },
            };
          });
        },

        getSessionViewPreferences: (
          documentId: string,
          sessionId: string
        ): SessionViewPreferences | undefined => {
          const state = get();
          const key = prefsKey(documentId, sessionId);

          const explicit = state.sessionViewPreferences[key];
          if (explicit && explicit.viewMode) {
            return explicit;
          }

          const refState = state.verificationState[documentId];
          if (!refState) return undefined;

          const session = refState.sessions.find((s) => s.id === sessionId);
          if (!session) return undefined;

          const defaultPrefs: SessionViewPreferences = {
            viewMode: getDefaultViewMode(session),
            selectedTrackId: null,
          };

          if (explicit) {
            return {
              viewMode: explicit.viewMode ?? defaultPrefs.viewMode,
              selectedTrackId: explicit.selectedTrackId ?? defaultPrefs.selectedTrackId,
            };
          }

          return defaultPrefs;
        },

        getAggregatedMutations: (documentId: string, sessionId: string): AggregatedMutation[] => {
          const state = get();
          const refState = state.verificationState[documentId];
          if (!refState) return [];

          const session = refState.sessions.find((s) => s.id === sessionId);
          if (!session) return [];

          return aggregateMutations(session);
        },

        navigateToPosition: (
          documentId: string,
          position: number,
          highlightRange?: { start: number; end: number },
          trackId?: string
        ): void => {
          const timestamp = Math.max(Date.now(), (get().focusedPosition?.timestamp ?? 0) + 1);
          debugLog('[Store] navigateToPosition called:', {
            documentId,
            position,
            highlightRange,
            timestamp,
          });

          const state = get();
          const refState = state.verificationState[documentId];
          const sessionId = refState?.activeSessionId;
          if (sessionId) {
            const key = prefsKey(documentId, sessionId);
            const prefs = state.sessionViewPreferences[key];
            if (prefs?.alignmentVisible === false) {
              set((s) => ({
                sessionViewPreferences: {
                  ...s.sessionViewPreferences,
                  [key]: { ...s.sessionViewPreferences[key], alignmentVisible: true },
                },
              }));
            }
          }

          set({
            focusedPosition: {
              documentId,
              trackId,
              position,
              highlightRange,
              timestamp,
            },
          });
        },

        clearFocusedPosition: (): void => {
          debugLog('[Store] clearFocusedPosition called', {
            currentValue: get().focusedPosition,
          });
          set({ focusedPosition: null });
        },

        getTrackMutations: (
          documentId: string,
          sessionId: string,
          trackId: string
        ): MutationMarker[] => {
          const state = get();
          const cacheKey = prefsKey(documentId, sessionId);

          const cached = state.sessionMutations[cacheKey]?.byTrack[trackId];
          if (cached) {
            return cached;
          }

          const refState = state.verificationState[documentId];
          if (!refState) return [];

          const session = refState.sessions.find((s) => s.id === sessionId);
          if (!session) return [];

          const track = session.tracks.find((t) => t.id === trackId);
          if (!track) return [];

          return computeTrackMutations(track);
        },

        invalidateMutationCache: (documentId: string, sessionId: string): void => {
          const cacheKey = prefsKey(documentId, sessionId);
          set((state) => {
            const { [cacheKey]: _, ...remainingMutationCache } = state.sessionMutations;
            return { sessionMutations: remainingMutationCache };
          });
        },

        renameSession: (documentId: string, sessionId: string, name: string): void => {
          const trimmed = name.trim();
          if (!trimmed) return;
          set((state) => {
            const refState = state.verificationState[documentId];
            if (!refState) return state;
            return {
              verificationState: {
                ...state.verificationState,
                [documentId]: {
                  ...refState,
                  sessions: refState.sessions.map((s) =>
                    s.id === sessionId ? { ...s, name: trimmed } : s
                  ),
                },
              },
            };
          });
          void get().saveSidecar(documentId, { preserveStaleChecksum: true });
        },

        renameTrack: (
          documentId: string,
          sessionId: string,
          trackId: string,
          label: string
        ): void => {
          const trimmed = label.trim();
          if (!trimmed) return;
          get().updateTrack(documentId, sessionId, trackId, { label: trimmed });
          void get().saveSidecar(documentId, { preserveStaleChecksum: true });
        },

        toggleAlignmentVisibility: (documentId: string, sessionId: string): void => {
          const key = prefsKey(documentId, sessionId);
          set((state) => {
            const existing = state.sessionViewPreferences[key];
            const current = existing?.alignmentVisible !== false;
            return {
              sessionViewPreferences: {
                ...state.sessionViewPreferences,
                [key]: {
                  ...existing,
                  viewMode: existing?.viewMode ?? 'single',
                  selectedTrackId: existing?.selectedTrackId ?? null,
                  alignmentVisible: !current,
                },
              },
            };
          });
        },

        toggleTrackVisibility: (documentId: string, sessionId: string, trackId: string): void => {
          const key = prefsKey(documentId, sessionId);
          set((state) => {
            const existing = state.sessionViewPreferences[key];
            const hiddenIds = existing?.hiddenTrackIds ?? [];
            const isHidden = hiddenIds.includes(trackId);
            return {
              sessionViewPreferences: {
                ...state.sessionViewPreferences,
                [key]: {
                  ...existing,
                  viewMode: existing?.viewMode ?? 'single',
                  selectedTrackId: existing?.selectedTrackId ?? null,
                  hiddenTrackIds: isHidden
                    ? hiddenIds.filter((id) => id !== trackId)
                    : [...hiddenIds, trackId],
                },
              },
            };
          });
        },

        overrideTrackStatus: (
          documentId: string,
          sessionId: string,
          trackId: string,
          userStatus: TrackStatus | null,
          reason?: string
        ): void => {
          get().updateTrack(documentId, sessionId, trackId, {
            userStatus: userStatus ?? undefined,
            userOverrideReason: userStatus ? (reason ?? undefined) : undefined,
          });
          void get().saveSidecar(documentId, { preserveStaleChecksum: true });
        },

        archiveSession: (documentId: string, sessionId: string): void => {
          set((state) => {
            const refState = state.verificationState[documentId];
            if (!refState) return state;
            const newSessions = refState.sessions.map((s) =>
              s.id === sessionId ? { ...s, archived: true } : s
            );
            let newActiveId = refState.activeSessionId;
            if (newActiveId === sessionId) {
              const nextActive = newSessions.find((s) => !s.archived);
              newActiveId = nextActive?.id ?? null;
            }
            return {
              verificationState: {
                ...state.verificationState,
                [documentId]: {
                  ...refState,
                  sessions: newSessions,
                  activeSessionId: newActiveId,
                },
              },
            };
          });
          void get().saveSidecar(documentId, { preserveStaleChecksum: true });
        },

        unarchiveSession: (documentId: string, sessionId: string): void => {
          set((state) => {
            const refState = state.verificationState[documentId];
            if (!refState) return state;
            return {
              verificationState: {
                ...state.verificationState,
                [documentId]: {
                  ...refState,
                  sessions: refState.sessions.map((s) =>
                    s.id === sessionId ? { ...s, archived: false } : s
                  ),
                },
              },
            };
          });
          void get().saveSidecar(documentId, { preserveStaleChecksum: true });
        },

        setAlignmentPanelOpen: (documentId: string, open: boolean): void => {
          debugLog('[Store] setAlignmentPanelOpen called:', {
            documentId,
            open,
            currentState: Array.from(get().alignmentPanelOpen),
          });
          set((state) => {
            const next = new Set(state.alignmentPanelOpen);
            if (open) {
              next.add(documentId);
            } else {
              next.delete(documentId);
            }
            return { alignmentPanelOpen: next };
          });
        },

        saveSidecar: async (
          documentId: string,
          options?: {
            force?: boolean;
            preserveStaleChecksum?: boolean;
            onlyIfCurrent?: boolean;
            throwOnError?: boolean;
          }
        ): Promise<void> =>
          saveSidecarInOrder(get().referenceSourcePaths[documentId] ?? '', () =>
            withAlignmentHistoryAccess(get().referenceSourcePaths[documentId] ?? '', async () => {
              const state = get();
              const refState = state.verificationState[documentId];
              if (!refState) return;
              if (options?.onlyIfCurrent && state.staleReferences[documentId]) return;
              const sourcePath = requireReferenceSourcePath(state, documentId);
              try {
                await appendCurrentEvidenceStates(documentId, sourcePath, refState);
                if (
                  state.staleReferences[documentId] &&
                  !state.referenceFileChecksums[documentId] &&
                  !options?.force
                ) {
                  return;
                }
                const recordedChecksum = state.referenceFileChecksums[documentId];
                let checksum =
                  state.staleReferences[documentId] && recordedChecksum
                    ? recordedChecksum
                    : await computeReferenceHash(sourcePath);
                if (
                  checksum &&
                  recordedChecksum &&
                  checksum !== recordedChecksum &&
                  !state.staleReferences[documentId]
                ) {
                  await get().checkStaleness(documentId);
                  if (get().staleReferences[documentId]) {
                    if (options?.onlyIfCurrent) return;
                    checksum = recordedChecksum;
                  }
                }
                if (!checksum) {
                  if (options?.throwOnError)
                    throw new Error(
                      'No safe reference checksum is available to save this analysis.'
                    );
                  console.error('[saveSidecar] No safe reference checksum is available');
                  return;
                }

                const refName =
                  sourcePath
                    .split('/')
                    .pop()
                    ?.replace(/\.[^.]+$/, '') ?? 'unknown';

                const sidecar = stateToSidecar(
                  refName,
                  refState,
                  state.sessionViewPreferences,
                  checksum
                );
                const json = serializeSidecar(sidecar);
                const sidecarPath = await writeAlignmentHistory(sourcePath, json);

                set((state) => ({
                  referenceFileChecksums: {
                    ...state.referenceFileChecksums,
                    [documentId]: checksum,
                  },
                  staleReferences: {
                    ...state.staleReferences,
                    [documentId]: state.staleReferences[documentId] ?? false,
                  },
                }));

                debugLog(
                  `[saveSidecar] Saved ${refState.sessions.length} sessions to ${sidecarPath}`
                );
              } catch (err) {
                console.error('[saveSidecar] Failed:', err);
                useToastStore
                  .getState()
                  .addToast(
                    userMessage(
                      'notice.sequencing-review-changes-could-not-be-saved-keep-this-entity-open-and'
                    ),
                    { definition: 'sequence-evidence-save-failed' }
                  );
                if (options?.throwOnError) throw err;
              }
            })
          ),

        loadSidecar: async (documentId: string): Promise<boolean> => {
          const request: AlignmentLoadRequest = {
            phase: 'loading',
            sourcePath: get().referenceSourcePaths[documentId] ?? '',
            baseline: get().verificationState[documentId],
          };
          const previous = alignmentLoadRequests.get(documentId);
          if (previous) previous.phase = 'retired';
          alignmentLoadRequests.set(documentId, request);
          const ownsRequest = () =>
            alignmentLoadRequests.get(documentId) === request &&
            request.phase === 'loading' &&
            get().referenceSourcePaths[documentId] === request.sourcePath &&
            get().verificationState[documentId] === request.baseline;
          try {
            return await withAlignmentHistoryAccess(request.sourcePath, async () => {
              try {
                if (!ownsRequest()) return false;
                const sourcePath = requireReferenceSourcePath(get(), documentId);
                let sidecarProjection: ReturnType<typeof sidecarToState> | null = null;
                try {
                  const content = await readAlignmentHistory(sourcePath);
                  if (content)
                    sidecarProjection = sidecarToState(parseSidecar(content), documentId);
                } catch (error) {
                  debugWarn(
                    '[loadSidecar] Legacy sidecar is unreadable; checking package evidence',
                    error
                  );
                }
                const refState =
                  (await readPackageEvidenceProjection(
                    documentId,
                    sourcePath,
                    sidecarProjection?.refState
                  )) ?? sidecarProjection?.refState;
                if (!refState) return false;
                const viewPreferences = sidecarProjection?.viewPreferences ?? {};
                const referenceChecksum =
                  sidecarProjection?.referenceChecksum ??
                  (await computeReferenceHash(sourcePath)) ??
                  '';

                const currentHash = await computeReferenceHash(sourcePath);
                const checksumStale =
                  !referenceChecksum || !currentHash || currentHash !== referenceChecksum;

                let currentSequenceLength: number | null = null;
                let currentReference: {
                  fileSha256: string | null;
                  sequenceRevision: string;
                  topology: 'linear' | 'circular';
                  checkpointId: string | null;
                } | null = null;
                try {
                  const [currentSequence, reference] = await Promise.all([
                    readSequenceFile(sourcePath),
                    readReferenceForMutations(sourcePath),
                  ]);
                  currentSequenceLength = currentSequence.length;
                  currentReference = {
                    fileSha256: currentHash,
                    sequenceRevision: await computePairwiseReferenceRevision(currentSequence),
                    topology: reference.circular ? 'circular' : 'linear',
                    checkpointId: await currentPackageCheckpointId(sourcePath),
                  };
                } catch {} // eslint-disable-line no-empty
                const perSessionStale = detectPerSessionStaleness(
                  refState.sessions,
                  checksumStale,
                  currentSequenceLength,
                  currentReference
                );

                const hasLegacyTrack = refState.sessions.some((session) =>
                  session.tracks.some((track) => !track.testedReference)
                );
                const hasVersionedTrack = refState.sessions.some((session) =>
                  session.tracks.some((track) => Boolean(track.testedReference))
                );
                const isStale =
                  perSessionStale.size > 0 ||
                  (checksumStale && (hasLegacyTrack || !hasVersionedTrack));

                const staleIds = Array.from(perSessionStale);

                if (!ownsRequest()) return false;
                request.phase = 'ready';
                markLoadedVerificationState(refState);
                set((state) => ({
                  verificationState: {
                    ...state.verificationState,
                    [documentId]: refState,
                  },
                  sessionViewPreferences: {
                    ...state.sessionViewPreferences,
                    ...Object.fromEntries(
                      Object.entries(viewPreferences).map(([key, saved]) => [
                        key,
                        { ...saved, ...state.sessionViewPreferences[key] },
                      ])
                    ),
                  },
                  staleReferences: {
                    ...state.staleReferences,
                    [documentId]: isStale,
                  },
                  referenceFileChecksums: {
                    ...state.referenceFileChecksums,
                    [documentId]: referenceChecksum,
                  },
                  staleSessionIds: {
                    ...state.staleSessionIds,
                    [documentId]: staleIds,
                  },
                }));

                for (const session of refState.sessions) {
                  if (session.alignmentOperation?.status === 'active') {
                    void get().resumeSessionAlignmentOperation(documentId, session.id);
                  }
                }

                debugLog(`[loadSidecar] Loaded ${refState.sessions.length} sessions`);
                return true;
              } catch (err) {
                request.phase = 'error';
                console.error('[loadSidecar] Failed:', err);
                return false;
              }
            });
          } finally {
            if (request.phase === 'loading') request.phase = 'retired';
            if (alignmentLoadRequests.get(documentId) === request) {
              alignmentLoadRequests.delete(documentId);
            }
          }
        },

        checkStaleness: async (documentId: string): Promise<void> => {
          const state = get();
          const storedChecksum = state.referenceFileChecksums[documentId];
          const refState = state.verificationState[documentId];
          if (
            !storedChecksum &&
            !refState?.sessions.some((session) =>
              session.tracks.some((track) => Boolean(track.testedReference))
            )
          )
            return;
          const sourcePath = requireReferenceSourcePath(state, documentId);
          const currentHash = await computeReferenceHash(sourcePath);
          let currentLength: number | null = null;
          let currentReference: {
            fileSha256: string | null;
            sequenceRevision: string;
            topology: 'linear' | 'circular';
            checkpointId: string | null;
          } | null = null;
          try {
            const [sequence, reference] = await Promise.all([
              readSequenceFile(sourcePath),
              readReferenceForMutations(sourcePath),
            ]);
            currentLength = sequence.length;
            currentReference = {
              fileSha256: currentHash,
              sequenceRevision: await computePairwiseReferenceRevision(sequence),
              topology: reference.circular ? 'circular' : 'linear',
              checkpointId: await currentPackageCheckpointId(sourcePath),
            };
          } catch {} // eslint-disable-line no-empty
          const staleIds = refState
            ? [
                ...detectPerSessionStaleness(
                  refState.sessions,
                  !storedChecksum || !currentHash || currentHash !== storedChecksum,
                  currentLength,
                  currentReference
                ),
              ]
            : [];
          const checksumStale = !storedChecksum || !currentHash || currentHash !== storedChecksum;
          const hasLegacyTrack =
            refState?.sessions.some((session) =>
              session.tracks.some((track) => !track.testedReference)
            ) ?? false;
          const hasVersionedTrack =
            refState?.sessions.some((session) =>
              session.tracks.some((track) => Boolean(track.testedReference))
            ) ?? false;
          const isStale =
            staleIds.length > 0 || (checksumStale && (hasLegacyTrack || !hasVersionedTrack));

          set((s) => ({
            staleReferences: {
              ...s.staleReferences,
              [documentId]: isStale,
            },
            staleSessionIds: {
              ...s.staleSessionIds,
              [documentId]: isStale ? staleIds : [],
            },
          }));
        },

        toggleMutationChecked: (
          documentId: string,
          sessionId: string,
          trackId: string,
          mutationId: string
        ): void => {
          set((state) => {
            const refState = state.verificationState[documentId];
            if (!refState) return state;

            const sessionIdx = refState.sessions.findIndex((s) => s.id === sessionId);
            if (sessionIdx === -1) return state;

            const trackIdx = refState.sessions[sessionIdx].tracks.findIndex(
              (t) => t.id === trackId
            );
            if (trackIdx === -1) return state;

            const track = refState.sessions[sessionIdx].tracks[trackIdx];
            const current = track.checkedMutations ?? [];
            const updated = current.includes(mutationId)
              ? current.filter((id) => id !== mutationId)
              : [...current, mutationId];

            const updatedSessions = [...refState.sessions];
            const updatedTracks = [...updatedSessions[sessionIdx].tracks];
            updatedTracks[trackIdx] = {
              ...updatedTracks[trackIdx],
              checkedMutations: updated.length > 0 ? updated : undefined,
            };
            updatedSessions[sessionIdx] = {
              ...updatedSessions[sessionIdx],
              tracks: updatedTracks,
            };

            return {
              verificationState: {
                ...state.verificationState,
                [documentId]: { ...refState, sessions: updatedSessions },
              },
            };
          });

          get().saveSidecar(documentId);
        },

        applyCheckedMutations: async (
          documentId: string,
          sessionId: string,
          trackId: string
        ): Promise<void> => {
          const state = get();
          const refState = state.verificationState[documentId];
          if (!refState) throw new Error('No verification state for this reference');
          const sourcePath = requireReferenceSourcePath(state, documentId);

          const session = refState.sessions.find((s) => s.id === sessionId);
          if (!session) throw new Error('Session not found');

          const track = session.tracks.find((t) => t.id === trackId);
          if (!track) throw new Error('Track not found');

          const packageRoot = await findSequencePackageRootForReference(sourcePath);
          if (!packageRoot || !track.evidenceRunId || !track.testedReference) {
            throw new Error(
              'Apply requires a retained, version-owned sequencing result. Re-run this alignment first.'
            );
          }
          const mutationScope = { workspaceRoot: packageRoot, affectedEntityIds: [documentId] };
          assertWorkspaceEditorsSettled(mutationScope);
          const currentHash = await computeReferenceHash(sourcePath);
          if (!currentHash) throw new Error('The current sequence file is unavailable.');
          const currentSequence = await readSequenceFile(sourcePath);
          const currentReference = await readReferenceForMutations(sourcePath);
          if (
            (await computePairwiseReferenceRevision(currentSequence)) !==
              track.testedReference.sequenceRevision ||
            (currentReference.circular ? 'circular' : 'linear') !==
              track.testedReference.topology ||
            (await currentPackageCheckpointId(sourcePath)) !== track.testedReference.checkpointId
          ) {
            throw new Error(
              'The reference coordinates or topology changed. Re-run before applying mutations.'
            );
          }

          const checkedIds = track.checkedMutations ?? [];
          if (checkedIds.length === 0) throw new Error('No mutations checked');

          const checkedMutations = track.mutations.filter((m) => checkedIds.includes(m.id));
          console.warn(
            `[applyCheckedMutations] ${checkedIds.length} checked, ${checkedMutations.length} matched, IDs: ${checkedIds.join(', ')}`
          );
          if (checkedMutations.length === 0) {
            throw new Error(
              `No mutations matched checked IDs. Checked: [${checkedIds.join(', ')}], Available: [${track.mutations
                .map((m) => m.id)
                .slice(0, 5)
                .join(', ')}...]`
            );
          }

          const releaseFreeze = freezeWorkspaceEditorWrites(mutationScope);
          try {
            const { applyMutationsToSequence } = await import('../utils/apply-mutations');
            const { readSequenceFileGuarded } =
              await import('../../sequence/public/utils/guarded-read');

            const fileContent = await readSequenceFileGuarded(sourcePath);
            if ((await computeReferenceHash(sourcePath)) !== currentHash) {
              throw new Error(
                'The reference file changed while the mutation application was prepared.'
              );
            }
            const parsed = parseSequenceFileAsDocument(fileContent, sourcePath).sequence;

            const result = applyMutationsToSequence(
              parsed.sequence,
              parsed.annotations,
              checkedMutations
            );
            if (result.sequence === parsed.sequence && result.annotations === parsed.annotations) {
              throw new Error('The selected mutations made no change to the sequence.');
            }
            const draftSequence = `${parsed.sequence}${result.sequence}`;
            const nativeSave = await platform().fs.saveSequenceDocument({
              documentId,
              sourcePath,
              sequencingEvidenceRunId: track.evidenceRunId,
              capture: {
                sequence: {
                  ...parsed,
                  sequence: result.sequence,
                  length: result.sequence.length,
                  annotations: result.annotations,
                },
                draftBaseline: {
                  sequence: parsed.sequence,
                  length: parsed.sequence.length,
                  circular: parsed.circular === true,
                },
                draftSequence,
                insertedRanges:
                  result.sequence.length > 0
                    ? [{ start: parsed.sequence.length, end: draftSequence.length }]
                    : [],
                deletedRanges:
                  parsed.sequence.length > 0 ? [{ start: 0, end: parsed.sequence.length }] : [],
                substitutedRanges: [],
                draftLineageId: crypto.randomUUID(),
              },
            });
            if (nativeSave.status !== 'saved') {
              throw new Error(
                'The managed sequence save was unavailable; no direct-write fallback is allowed.'
              );
            }
            const { completeSavedSequenceDocument } =
              await import('../../../services/sequence-document-save-completion');
            const completion = await completeSavedSequenceDocument(
              { documentId, sourcePath },
              'Apply reviewed sequencing mutations',
              (savedDocumentId) => get().checkStaleness(savedDocumentId)
            );
            if (completion.status === 'commit-failed') {
              throw new Error('Sequence changes were saved, but the Git history commit failed.');
            }
          } finally {
            releaseFreeze();
          }
        },

        clearCheckedMutations: (documentId: string): void => {
          set((state) => {
            const refState = state.verificationState[documentId];
            if (!refState) return state;
            return {
              verificationState: {
                ...state.verificationState,
                [documentId]: withCheckedMutationsCleared(refState),
              },
            };
          });
        },
      }),
      {
        name: 'waypoint-verification-store',
        version: 1,
        migrate: () => ({
          sessionViewPreferences: {},
        }),
        partialize: (state) => {
          const result = {
            sessionViewPreferences: state.sessionViewPreferences,
          };

          if ('verificationState' in result) {
            console.error('CRITICAL: verificationState leaked into partialize!');
          }

          return result;
        },
      }
    )
  )
);

startVerificationAutosave(useVerificationStore, (documentId) => {
  const sourcePath = useVerificationStore.getState().referenceSourcePaths[documentId];
  if (!sourcePath) return false;
  return getWorkspaceEditorBlockers({
    workspaceRoot: sourcePath,
    affectedEntityIds: [documentId],
  }).some(
    (editor) =>
      editor.state !== 'clean' && (editor.entityId === documentId || editor.path === sourcePath)
  );
});
