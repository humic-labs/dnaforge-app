import { fromPackageRelative, type SequencePackageEvidenceRun } from '../../../db/sequence-package';
import type { SequencePackageEvidenceRead } from '../../../db/sequence-package-history-io';
import type {
  ReferenceVerificationState,
  SessionAlignmentOperation,
  VerificationSession,
  VerificationTrack,
} from '../types';

export function projectPackageEvidence(input: {
  documentId: string;
  packageRoot: string;
  sidecarState?: ReferenceVerificationState;
  runs: SequencePackageEvidenceRun[];
  reads: Map<string, SequencePackageEvidenceRead>;
}): ReferenceVerificationState {
  const sessions = new Map<string, VerificationSession>();
  const localOperations = new Map<string, SessionAlignmentOperation>();
  for (const sidecar of input.sidecarState?.sessions ?? []) {
    if (sidecar.alignmentOperation) localOperations.set(sidecar.id, sidecar.alignmentOperation);
    sessions.set(sidecar.id, {
      ...sidecar,
      tracks: sidecar.tracks.filter((track) => !track.evidenceRunId),
      historicalTracks: sidecar.historicalTracks?.filter((track) => !track.evidenceRunId),
      alignmentOperation: sidecar.alignmentOperation?.evidenceRunId
        ? undefined
        : sidecar.alignmentOperation,
    });
  }
  for (const run of input.runs) {
    const prior = sessions.get(run.sessionId);
    const session: VerificationSession = prior ?? {
      id: run.sessionId,
      name: run.session?.name ?? 'Recovered sequencing review',
      createdAt: run.session?.createdAt ?? run.createdAt,
      mode: run.session?.mode ?? 'one-per-clone',
      tracks: [],
    };
    if (run.session) {
      session.name = run.session.name;
      session.mode = run.session.mode;
      session.createdAt = run.session.createdAt;
    }
    const read = input.reads.get(run.id);
    if (read?.status === 'available' && read.states.length > 0) {
      const latest = read.states[read.states.length - 1];
      const reviewedSession = sessionFromState(latest);
      if (reviewedSession) {
        session.name = reviewedSession.name;
        session.mode = reviewedSession.mode;
        session.createdAt = reviewedSession.createdAt;
        session.archived = reviewedSession.archived;
      }
      const tracks = tracksFromState(latest, run, input.packageRoot);

      session.historicalTracks = [
        ...(session.historicalTracks ?? []),
        ...session.tracks.filter((track) => Boolean(track.evidenceRunId)),
      ];
      session.tracks = [...session.tracks.filter((track) => !track.evidenceRunId), ...tracks];
    }
    if (run.managedOperationId && run.inputRevision) {
      const local = localOperations.get(run.sessionId);
      const alias = local?.inputCorrelationId;
      const inputCorrelationId =
        local?.id === run.managedOperationId &&
        local.inputRevision === run.inputRevision &&
        local.evidenceRunId === run.id &&
        typeof alias === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(alias)
          ? alias.toLowerCase()
          : undefined;
      const operation: SessionAlignmentOperation = {
        id: run.managedOperationId,
        inputRevision: run.inputRevision,
        ...(inputCorrelationId ? { inputCorrelationId } : {}),
        status:
          run.status === 'prepared'
            ? 'active'
            : run.status === 'completed' && read?.status === 'available' && read.states.length === 0
              ? 'active'
              : run.status === 'completed'
                ? 'succeeded'
                : run.status,
        evidenceRunId: run.id,
        testedReference: {
          fileSha256: run.reference.artifact.sha256,
          sequenceRevision: run.reference.sequenceRevision,
          topology: run.reference.topology,
          checkpointId: run.reference.checkpointId,
        },
        queries: run.queries.map((query) => ({
          id: query.id,
          label: query.label,
          queryPath: fromPackageRelative(query.artifact.path, input.packageRoot),
        })),
      };
      session.alignmentOperation = operation;
    }
    sessions.set(run.sessionId, session);
  }
  return {
    documentId: input.documentId,
    sessions: [...sessions.values()],
    activeSessionId:
      input.sidecarState?.activeSessionId &&
      sessions.has(input.sidecarState.activeSessionId) &&
      !sessions.get(input.sidecarState.activeSessionId)?.archived
        ? input.sidecarState.activeSessionId
        : ([...sessions.values()].find((session) => !session.archived)?.id ?? null),
  };
}

function sessionFromState(value: unknown): {
  name: string;
  mode: VerificationSession['mode'];
  createdAt: string;
  archived: boolean;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>).session;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Retained sequencing session state is malformed.');
  }
  const session = raw as Record<string, unknown>;
  if (
    typeof session.name !== 'string' ||
    !session.name.trim() ||
    (session.mode !== 'one-per-clone' && session.mode !== 'multi-per-clone') ||
    typeof session.createdAt !== 'string' ||
    typeof session.archived !== 'boolean'
  ) {
    throw new Error('Retained sequencing session state is malformed.');
  }
  return {
    name: session.name,
    mode: session.mode,
    createdAt: session.createdAt,
    archived: session.archived,
  };
}

function tracksFromState(
  value: unknown,
  run: SequencePackageEvidenceRun,
  packageRoot: string
): VerificationTrack[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Retained sequencing review state is malformed.');
  }
  const state = value as Record<string, unknown>;
  if (!Array.isArray(state.tracks) || state.tracks.length !== run.queries.length) {
    throw new Error('Retained sequencing review is missing a query.');
  }
  const rows = state.tracks;
  return run.queries.map((query) => {
    const row = rows.find(
      (entry: unknown) =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        (entry as Record<string, unknown>).queryId === query.id
    ) as Record<string, unknown> | undefined;
    if (
      !row ||
      !row.alignment ||
      !Array.isArray(row.mutations) ||
      !['pass', 'variants', 'fail', 'incomplete'].includes(String(row.status)) ||
      typeof row.alignedAt !== 'string'
    ) {
      throw new Error('Retained sequencing track is malformed.');
    }
    return {
      id: query.id,
      label: typeof row.label === 'string' && row.label.trim() ? row.label : query.label,
      queryPath: fromPackageRelative(query.artifact.path, packageRoot),
      alignment: row.alignment as VerificationTrack['alignment'],
      mutations: row.mutations as VerificationTrack['mutations'],
      ...(row.structuralAnalysis
        ? { structuralAnalysis: row.structuralAnalysis as VerificationTrack['structuralAnalysis'] }
        : {}),
      status: row.status as VerificationTrack['status'],
      ...(row.userStatus ? { userStatus: row.userStatus as VerificationTrack['userStatus'] } : {}),
      ...(row.userOverrideReason ? { userOverrideReason: row.userOverrideReason as string } : {}),
      ...(row.checkedMutations ? { checkedMutations: row.checkedMutations as string[] } : {}),
      alignedAt: row.alignedAt,
      evidenceRunId: run.id,
      testedReference: {
        fileSha256: run.reference.artifact.sha256,
        sequenceRevision: run.reference.sequenceRevision,
        topology: run.reference.topology,
        checkpointId: run.reference.checkpointId,
      },
    };
  });
}
