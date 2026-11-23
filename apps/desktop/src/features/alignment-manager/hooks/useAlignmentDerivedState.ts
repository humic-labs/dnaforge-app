import { useVerificationStore } from '../store';
import type { MinimapViewMode, StructuralRegion } from '../types';

const EMPTY_REGIONS: StructuralRegion[] = [];
const EMPTY_TRACK_IDS: string[] = [];

export function useAlignmentDerivedState(documentId: string) {
  const activeSessionId = useVerificationStore((s) => {
    const refState = s.verificationState[documentId];
    return refState?.activeSessionId ?? null;
  });

  const activeSession = useVerificationStore((s) => {
    const refState = s.verificationState[documentId];
    return refState?.sessions.find((session) => session.id === refState.activeSessionId) ?? null;
  });

  const trackIdsKey = useVerificationStore((s) => {
    const refState = s.verificationState[documentId];
    const sessionId = refState?.activeSessionId;
    if (!sessionId) return '';
    const session = refState.sessions.find((sess) => sess.id === sessionId);
    if (!session) return '';
    return session.tracks.map((t) => t.id).join(',');
  });

  const selectedTrackId = useVerificationStore((s) => {
    const refState = s.verificationState[documentId];
    const sessionId = refState?.activeSessionId;
    if (!sessionId) return null;
    const key = `${documentId}::${sessionId}`;
    return s.sessionViewPreferences[key]?.selectedTrackId ?? null;
  });

  const viewMode = useVerificationStore((s): MinimapViewMode => {
    return activeSessionId
      ? (s.getSessionViewPreferences(documentId, activeSessionId)?.viewMode ?? 'single')
      : 'single';
  });

  const hiddenTrackIds = useVerificationStore((s) => {
    const sessionId = s.verificationState[documentId]?.activeSessionId;
    return sessionId
      ? (s.sessionViewPreferences[`${documentId}::${sessionId}`]?.hiddenTrackIds ?? EMPTY_TRACK_IDS)
      : EMPTY_TRACK_IDS;
  });

  const alignedReference = useVerificationStore((s) => {
    const refState = s.verificationState[documentId];
    const sessionId = refState?.activeSessionId;
    if (!sessionId) return undefined;
    const session = refState.sessions.find((sess) => sess.id === sessionId);
    if (!session || session.tracks.length === 0) return undefined;
    const key = `${documentId}::${sessionId}`;
    const trackId = s.sessionViewPreferences[key]?.selectedTrackId;
    const track = trackId ? session.tracks.find((t) => t.id === trackId) : session.tracks[0];
    return track?.alignment?.alignedReference;
  });

  const alignedQuery = useVerificationStore((s) => {
    const refState = s.verificationState[documentId];
    const sessionId = refState?.activeSessionId;
    if (!sessionId) return undefined;
    const session = refState.sessions.find((sess) => sess.id === sessionId);
    if (!session || session.tracks.length === 0) return undefined;
    const key = `${documentId}::${sessionId}`;
    const trackId = s.sessionViewPreferences[key]?.selectedTrackId;
    const track = trackId ? session.tracks.find((t) => t.id === trackId) : session.tracks[0];
    return track?.alignment?.alignedQuery;
  });

  const getTrackMutations = useVerificationStore((s) => s.getTrackMutations);

  const alignmentPanelOpen = useVerificationStore((s) => s.alignmentPanelOpen.has(documentId));

  const alignmentVisible = useVerificationStore((s) => {
    const refState = s.verificationState[documentId];
    const sessionId = refState?.activeSessionId;
    if (!sessionId) return true;
    const key = `${documentId}::${sessionId}`;
    return s.sessionViewPreferences[key]?.alignmentVisible !== false;
  });

  const selectedTrackHidden = useVerificationStore((s) => {
    const refState = s.verificationState[documentId];
    const sessionId = refState?.activeSessionId;
    if (!sessionId) return false;
    const key = `${documentId}::${sessionId}`;
    const prefs = s.sessionViewPreferences[key];
    const trackId = prefs?.selectedTrackId;
    if (!trackId) return false;
    return (prefs?.hiddenTrackIds ?? []).includes(trackId);
  });

  const isStale = useVerificationStore((s) => !!s.staleReferences[documentId]);

  const isPending = useVerificationStore((s) => {
    const refState = s.verificationState[documentId];
    const sessionId = refState?.activeSessionId;
    if (!sessionId) return false;
    const key = `${documentId}::${sessionId}`;
    const pending = s.pendingTrackIds[key];
    return !!pending && pending.size > 0;
  });

  const structuralRegions = useVerificationStore((s): StructuralRegion[] => {
    const refState = s.verificationState[documentId];
    const sessionId = refState?.activeSessionId;
    if (!sessionId) return EMPTY_REGIONS;
    const session = refState.sessions.find((sess) => sess.id === sessionId);
    if (!session || session.tracks.length === 0) return EMPTY_REGIONS;
    const key = `${documentId}::${sessionId}`;
    const trackId = s.sessionViewPreferences[key]?.selectedTrackId;
    const track = trackId ? session.tracks.find((t) => t.id === trackId) : session.tracks[0];
    return track?.structuralAnalysis?.structuralRegions ?? EMPTY_REGIONS;
  });

  return {
    activeSessionId,
    activeSession,
    trackIdsKey,
    selectedTrackId,
    viewMode,
    hiddenTrackIds,
    alignedReference,
    alignedQuery,
    getTrackMutations,
    alignmentPanelOpen,
    alignmentVisible,
    selectedTrackHidden,
    isStale,
    isPending,
    structuralRegions,
  };
}
