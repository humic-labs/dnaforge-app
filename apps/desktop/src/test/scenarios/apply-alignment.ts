import { useVerificationStore } from '../../features/alignment-manager/store';
import type {
  AlignmentData,
  Mutation,
  ReferenceVerificationState,
  VerificationSession,
  VerificationTrack,
} from '../../features/alignment-manager/types';
import type { AppScenario } from './types';

type AlignmentScenario = NonNullable<AppScenario['alignment']>;

export function resetAlignmentScenarioState(): void {
  useVerificationStore.setState({
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
  });
}

export function applyAlignmentScenario(alignment: AlignmentScenario): void {
  const now = new Date().toISOString();
  const sessions = alignment.sessions.map(
    (session): VerificationSession => ({
      id: session.id,
      name: session.name,
      createdAt: now,
      mode: session.mode,
      tracks: session.tracks.map(
        (track): VerificationTrack => ({
          id: track.id,
          queryPath: track.queryPath,
          label: track.label,
          alignment: track.alignment as AlignmentData,
          mutations: (track.mutations ?? []) as Mutation[],
          status: track.status,
          alignedAt: track.alignedAt ?? now,
          checkedMutations: track.checkedMutations,
        })
      ),
    })
  );

  const activeSessionId = alignment.activeSessionId ?? sessions[0]?.id ?? null;
  const staleSessionIds =
    alignment.staleSessionIds ?? (alignment.isStale ? sessions.map((session) => session.id) : []);
  const isStale = alignment.isStale || staleSessionIds.length > 0;
  const refState: ReferenceVerificationState = {
    documentId: alignment.documentId,
    activeSessionId,
    sessions,
  };

  useVerificationStore.setState((state) => {
    const sessionViewPreferences = { ...state.sessionViewPreferences };
    for (const session of sessions) {
      sessionViewPreferences[`${alignment.documentId}::${session.id}`] = {
        viewMode: 'single',
        selectedTrackId: session.tracks[0]?.id ?? null,
        alignmentVisible: true,
      };
    }

    return {
      verificationState: {
        ...state.verificationState,
        [alignment.documentId]: refState,
      },
      referenceSourcePaths: {
        ...state.referenceSourcePaths,
        [alignment.documentId]: alignment.sourcePath,
      },
      sessionViewPreferences,
      staleReferences: {
        ...state.staleReferences,
        [alignment.documentId]: isStale,
      },
      staleSessionIds: {
        ...state.staleSessionIds,
        [alignment.documentId]: staleSessionIds,
      },
      referenceFileChecksums: {
        ...state.referenceFileChecksums,
        [alignment.documentId]:
          alignment.storedChecksum ??
          (isStale ? 'stale-scenario-reference-checksum' : 'fresh-scenario-reference-checksum'),
      },
    };
  });
}
