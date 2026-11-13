import { useVerificationStore } from '../store';

const EMPTY_STALE_IDS: string[] = [];
const EMPTY_PENDING_SET: ReadonlySet<string> = new Set();

export function useAlignmentManagerState(documentId: string) {
  const verificationState = useVerificationStore((s) => s.getVerificationState(documentId));
  const activeSession = useVerificationStore((s) => s.getActiveSession(documentId));
  const sessionViewPreferences = useVerificationStore((s) => s.sessionViewPreferences);
  const isStale = useVerificationStore((s) => s.staleReferences[documentId] ?? false);
  const staleSessionIds = useVerificationStore(
    (s) => s.staleSessionIds[documentId] ?? EMPTY_STALE_IDS
  );
  const pendingTrackIds = useVerificationStore((s) => {
    const sessionId = s.verificationState[documentId]?.activeSessionId;
    if (!sessionId) return EMPTY_PENDING_SET;
    const key = `${documentId}::${sessionId}`;
    return s.pendingTrackIds[key] ?? EMPTY_PENDING_SET;
  });
  return {
    verificationState,
    activeSession,
    sessionViewPreferences,
    isStale,
    staleSessionIds,
    pendingTrackIds,
  };
}

export function useAlignmentManagerActions() {
  const registerReferenceSource = useVerificationStore((s) => s.registerReferenceSource);
  const setActiveSession = useVerificationStore((s) => s.setActiveSession);
  const removeSession = useVerificationStore((s) => s.removeSession);
  const setSessionViewPreferences = useVerificationStore((s) => s.setSessionViewPreferences);
  const createSession = useVerificationStore((s) => s.createSession);
  const runSessionAlignments = useVerificationStore((s) => s.runSessionAlignments);
  const navigateToPosition = useVerificationStore((s) => s.navigateToPosition);
  const clearFocusedPosition = useVerificationStore((s) => s.clearFocusedPosition);
  const getTrackMutations = useVerificationStore((s) => s.getTrackMutations);
  const enrichSessionMutations = useVerificationStore((s) => s.enrichSessionMutations);
  const loadSidecar = useVerificationStore((s) => s.loadSidecar);
  const setAlignmentPanelOpen = useVerificationStore((s) => s.setAlignmentPanelOpen);
  const renameSession = useVerificationStore((s) => s.renameSession);
  const toggleAlignmentVisibility = useVerificationStore((s) => s.toggleAlignmentVisibility);
  const toggleTrackVisibility = useVerificationStore((s) => s.toggleTrackVisibility);
  const overrideTrackStatus = useVerificationStore((s) => s.overrideTrackStatus);
  const archiveSession = useVerificationStore((s) => s.archiveSession);
  const unarchiveSession = useVerificationStore((s) => s.unarchiveSession);
  const removeTrack = useVerificationStore((s) => s.removeTrack);
  const checkStaleness = useVerificationStore((s) => s.checkStaleness);
  const toggleMutationChecked = useVerificationStore((s) => s.toggleMutationChecked);
  const applyCheckedMutations = useVerificationStore((s) => s.applyCheckedMutations);
  const clearCheckedMutations = useVerificationStore((s) => s.clearCheckedMutations);

  return {
    registerReferenceSource,
    setActiveSession,
    removeSession,
    setSessionViewPreferences,
    createSession,
    runSessionAlignments,
    navigateToPosition,
    clearFocusedPosition,
    getTrackMutations,
    enrichSessionMutations,
    loadSidecar,
    setAlignmentPanelOpen,
    renameSession,
    toggleAlignmentVisibility,
    toggleTrackVisibility,
    overrideTrackStatus,
    archiveSession,
    unarchiveSession,
    removeTrack,
    checkStaleness,
    toggleMutationChecked,
    applyCheckedMutations,
    clearCheckedMutations,
  };
}
