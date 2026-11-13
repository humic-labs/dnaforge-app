import { describe, it, expect, beforeEach } from 'vitest';
import { useVerificationStore } from '../../alignment-manager/store';
import type { VerificationTrack } from '../../alignment-manager/types';
import { sequenceDocumentKey } from '../../../shared/managed-sequence-document';

const REF_SOURCE_PATH = '/workspace/references/pUC19-GFP.gb';
const REF_DOCUMENT_ID = sequenceDocumentKey({
  kind: 'catalog-sequence',
  entityId: 'owned-puc19-gfp',
});
const QUERY_PATH = '/workspace/reads/clone1.ab1';

const ALIGNED_REF = 'ATGCGTACC---GATTACAGATGCTTAG';
const ALIGNED_QUERY = 'ATGCGTACCTTTGATTACAGATGCTTAG';

function makeTrack(overrides: Partial<VerificationTrack> = {}): VerificationTrack {
  return {
    id: 'track-001',
    queryPath: QUERY_PATH,
    label: 'clone1',
    alignment: {
      alignedReference: ALIGNED_REF,
      alignedQuery: ALIGNED_QUERY,
      identity: 89.3,
      coverageStart: 1,
      coverageEnd: 25,
      algorithm: 'MAFFT',
    },
    mutations: [
      {
        id: 'mut-sub-10',
        position: 10,
        type: 'substitution',
        referenceBase: 'A',
        alternateBase: 'G',
        length: 1,
      },
    ],
    status: 'variants',
    alignedAt: '2026-02-13T10:00:00Z',
    ...overrides,
  };
}

function setupFullState(trackOverrides?: Partial<VerificationTrack>) {
  const store = useVerificationStore.getState();
  const sessionId = store.createSession(REF_DOCUMENT_ID, {
    name: 'Cloning Run 1',
    mode: 'one-per-clone',
    queryPaths: [QUERY_PATH],
  });
  const track = makeTrack(trackOverrides);
  store.addTrackToSession(REF_DOCUMENT_ID, sessionId, track);
  store.setAlignmentPanelOpen(REF_DOCUMENT_ID, true);
  return { sessionId, trackId: track.id };
}

function deriveCoordinateSpace(filePath: string) {
  const s = useVerificationStore.getState();

  const refState = s.verificationState[filePath];
  const activeSessionId = refState?.activeSessionId ?? null;

  const session = activeSessionId
    ? refState?.sessions.find((sess) => sess.id === activeSessionId)
    : undefined;

  const prefsKey = activeSessionId ? `${filePath}::${activeSessionId}` : '';
  const prefs = prefsKey ? s.sessionViewPreferences[prefsKey] : undefined;
  const selectedTrackId = prefs?.selectedTrackId ?? null;

  let alignedReference: string | undefined;
  if (session && session.tracks.length > 0) {
    const track = selectedTrackId
      ? session.tracks.find((t) => t.id === selectedTrackId)
      : session.tracks[0];
    alignedReference = track?.alignment?.alignedReference;
  }

  let alignedQuery: string | undefined;
  if (session && session.tracks.length > 0) {
    const track = selectedTrackId
      ? session.tracks.find((t) => t.id === selectedTrackId)
      : session.tracks[0];
    alignedQuery = track?.alignment?.alignedQuery;
  }

  const alignmentPanelOpen = s.alignmentPanelOpen.has(filePath);

  let alignmentVisible = true;
  if (activeSessionId) {
    const key = `${filePath}::${activeSessionId}`;
    alignmentVisible = s.sessionViewPreferences[key]?.alignmentVisible !== false;
  }

  let selectedTrackHidden = false;
  if (activeSessionId) {
    const key = `${filePath}::${activeSessionId}`;
    const p = s.sessionViewPreferences[key];
    const tid = p?.selectedTrackId;
    if (tid) {
      selectedTrackHidden = (p?.hiddenTrackIds ?? []).includes(tid);
    }
  }

  const hasActiveAlignment = !!activeSessionId && !!alignedReference && !!alignedQuery;
  if (!alignmentPanelOpen || !hasActiveAlignment || !alignmentVisible || selectedTrackHidden) {
    return undefined;
  }
  return {
    mode: 'gapped' as const,
    gappedSequence: alignedReference,
    alignedQuery: alignedQuery,
  };
}

describe('Alignment Lane Invariants', () => {
  beforeEach(() => {
    useVerificationStore.setState({
      verificationState: {},
      referenceSourcePaths: {},
      referenceFileChecksums: {},
      staleReferences: {},
      sessionViewPreferences: {},
      alignmentPanelOpen: new Set<string>(),
      focusedPosition: null,
      sessionMutations: {},
    });
    useVerificationStore.getState().registerReferenceSource(REF_DOCUMENT_ID, REF_SOURCE_PATH);
  });

  describe('selector correctness', () => {
    it('activeSessionId selector returns the active session after createSession', () => {
      const store = useVerificationStore.getState();
      const sessionId = store.createSession(REF_DOCUMENT_ID, {
        name: 'S1',
        mode: 'one-per-clone',
        queryPaths: [],
      });
      const refState = useVerificationStore.getState().verificationState[REF_DOCUMENT_ID];
      expect(refState?.activeSessionId).toBe(sessionId);
    });

    it('alignedReference selector returns the first track alignment when no selectedTrackId', () => {
      setupFullState();
      const s = useVerificationStore.getState();
      const refState = s.verificationState[REF_DOCUMENT_ID];
      const sessionId = refState!.activeSessionId!;
      const session = refState!.sessions.find((sess) => sess.id === sessionId)!;
      expect(session.tracks[0].alignment.alignedReference).toBe(ALIGNED_REF);
    });

    it('alignedQuery selector returns the first track alignment when no selectedTrackId', () => {
      setupFullState();
      const s = useVerificationStore.getState();
      const refState = s.verificationState[REF_DOCUMENT_ID];
      const sessionId = refState!.activeSessionId!;
      const session = refState!.sessions.find((sess) => sess.id === sessionId)!;
      expect(session.tracks[0].alignment.alignedQuery).toBe(ALIGNED_QUERY);
    });

    it('alignedReference selector returns selected track when selectedTrackId is set', () => {
      const { sessionId } = setupFullState();
      const track2 = makeTrack({
        id: 'track-002',
        label: 'clone2',
        alignment: {
          alignedReference: 'XXXX',
          alignedQuery: 'YYYY',
          identity: 50,
          coverageStart: 1,
          coverageEnd: 4,
          algorithm: 'MAFFT',
        },
      });
      useVerificationStore.getState().addTrackToSession(REF_DOCUMENT_ID, sessionId, track2);
      useVerificationStore.getState().setSessionViewPreferences(REF_DOCUMENT_ID, sessionId, {
        selectedTrackId: 'track-002',
      });

      const s = useVerificationStore.getState();
      const key = `${REF_DOCUMENT_ID}::${sessionId}`;
      const selTrackId = s.sessionViewPreferences[key]?.selectedTrackId;
      expect(selTrackId).toBe('track-002');

      const session = s.verificationState[REF_DOCUMENT_ID]!.sessions.find(
        (sess) => sess.id === sessionId
      )!;
      const selectedTrack = session.tracks.find((t) => t.id === selTrackId);
      expect(selectedTrack?.alignment.alignedReference).toBe('XXXX');
    });

    it('alignmentPanelOpen selector reads from the Set correctly', () => {
      useVerificationStore.getState().setAlignmentPanelOpen(REF_DOCUMENT_ID, true);
      expect(useVerificationStore.getState().alignmentPanelOpen.has(REF_DOCUMENT_ID)).toBe(true);

      useVerificationStore.getState().setAlignmentPanelOpen(REF_DOCUMENT_ID, false);
      expect(useVerificationStore.getState().alignmentPanelOpen.has(REF_DOCUMENT_ID)).toBe(false);
    });

    it('alignmentVisible defaults to true when no preferences exist', () => {
      const { sessionId } = setupFullState();
      const key = `${REF_DOCUMENT_ID}::${sessionId}`;
      const s = useVerificationStore.getState();
      expect(s.sessionViewPreferences[key]?.alignmentVisible !== false).toBe(true);
    });

    it('selectedTrackHidden returns false when no track is selected', () => {
      setupFullState();
      const s = useVerificationStore.getState();
      const refState = s.verificationState[REF_DOCUMENT_ID]!;
      const key = `${REF_DOCUMENT_ID}::${refState.activeSessionId}`;
      const prefs = s.sessionViewPreferences[key];
      const trackId = prefs?.selectedTrackId;
      expect(trackId).toBeFalsy();
      const hidden = trackId ? (prefs?.hiddenTrackIds ?? []).includes(trackId) : false;
      expect(hidden).toBe(false);
    });
  });

  describe('coordinateSpace should be defined (alignment lane visible)', () => {
    it('when all conditions are met: panel open, active session, real alignment data', () => {
      setupFullState();
      const cs = deriveCoordinateSpace(REF_DOCUMENT_ID);
      expect(cs).toBeDefined();
      expect(cs!.mode).toBe('gapped');
      expect(cs!.gappedSequence).toBe(ALIGNED_REF);
      expect(cs!.alignedQuery).toBe(ALIGNED_QUERY);
    });

    it('when using first track as fallback (no selectedTrackId)', () => {
      setupFullState();
      const cs = deriveCoordinateSpace(REF_DOCUMENT_ID);
      expect(cs).toBeDefined();
    });

    it('when selectedTrackId explicitly points to a track with alignment data', () => {
      const { sessionId } = setupFullState();
      useVerificationStore.getState().setSessionViewPreferences(REF_DOCUMENT_ID, sessionId, {
        selectedTrackId: 'track-001',
      });
      const cs = deriveCoordinateSpace(REF_DOCUMENT_ID);
      expect(cs).toBeDefined();
      expect(cs!.gappedSequence).toBe(ALIGNED_REF);
    });

    it('after toggling panel off then on again', () => {
      setupFullState();
      const store = useVerificationStore.getState();
      store.setAlignmentPanelOpen(REF_DOCUMENT_ID, false);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeUndefined();

      useVerificationStore.getState().setAlignmentPanelOpen(REF_DOCUMENT_ID, true);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });

    it('after toggling alignment visibility off then on again', () => {
      const { sessionId } = setupFullState();
      const store = useVerificationStore.getState();
      store.toggleAlignmentVisibility(REF_DOCUMENT_ID, sessionId);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeUndefined();

      useVerificationStore.getState().toggleAlignmentVisibility(REF_DOCUMENT_ID, sessionId);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });
  });

  describe('coordinateSpace should be undefined (alignment lane hidden)', () => {
    it('when alignmentPanelOpen is false', () => {
      setupFullState();
      useVerificationStore.getState().setAlignmentPanelOpen(REF_DOCUMENT_ID, false);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeUndefined();
    });

    it('when no verificationState exists for the file path', () => {
      expect(deriveCoordinateSpace('/some/other/file.gb')).toBeUndefined();
    });

    it('when no activeSessionId is set', () => {
      setupFullState();
      useVerificationStore.getState().setActiveSession(REF_DOCUMENT_ID, null);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeUndefined();
    });

    it('when session has no tracks', () => {
      const store = useVerificationStore.getState();
      store.createSession(REF_DOCUMENT_ID, {
        name: 'Empty session',
        mode: 'one-per-clone',
        queryPaths: [],
      });
      store.setAlignmentPanelOpen(REF_DOCUMENT_ID, true);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeUndefined();
    });

    it('when alignedReference is empty string', () => {
      setupFullState({
        alignment: {
          alignedReference: '',
          alignedQuery: ALIGNED_QUERY,
          identity: 0,
          coverageStart: 0,
          coverageEnd: 0,
          algorithm: 'MAFFT',
        },
      });
      const cs = deriveCoordinateSpace(REF_DOCUMENT_ID);
      expect(cs).toBeUndefined();
    });

    it('when alignedQuery is empty string', () => {
      setupFullState({
        alignment: {
          alignedReference: ALIGNED_REF,
          alignedQuery: '',
          identity: 0,
          coverageStart: 0,
          coverageEnd: 0,
          algorithm: 'MAFFT',
        },
      });
      const cs = deriveCoordinateSpace(REF_DOCUMENT_ID);
      expect(cs).toBeUndefined();
    });

    it('when BOTH alignedReference and alignedQuery are empty strings', () => {
      setupFullState({
        alignment: {
          alignedReference: '',
          alignedQuery: '',
          identity: 0,
          coverageStart: 0,
          coverageEnd: 0,
          algorithm: 'MAFFT',
        },
      });
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeUndefined();
    });

    it('when alignmentVisible is toggled off', () => {
      const { sessionId } = setupFullState();
      useVerificationStore.getState().toggleAlignmentVisibility(REF_DOCUMENT_ID, sessionId);
      const key = `${REF_DOCUMENT_ID}::${sessionId}`;
      const prefs = useVerificationStore.getState().sessionViewPreferences[key];
      expect(prefs?.alignmentVisible).toBe(false);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeUndefined();
    });

    it('when the selected track is hidden via hiddenTrackIds', () => {
      const { sessionId } = setupFullState();
      const store = useVerificationStore.getState();
      store.setSessionViewPreferences(REF_DOCUMENT_ID, sessionId, {
        selectedTrackId: 'track-001',
      });
      useVerificationStore
        .getState()
        .toggleTrackVisibility(REF_DOCUMENT_ID, sessionId, 'track-001');

      const key = `${REF_DOCUMENT_ID}::${sessionId}`;
      const prefs = useVerificationStore.getState().sessionViewPreferences[key];
      expect(prefs?.hiddenTrackIds).toContain('track-001');
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeUndefined();
    });

    it('when selectedTrackId points to a non-existent track', () => {
      const { sessionId } = setupFullState();
      useVerificationStore.getState().setSessionViewPreferences(REF_DOCUMENT_ID, sessionId, {
        selectedTrackId: 'track-NONEXISTENT',
      });
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeUndefined();
    });

    it('when the active session was removed', () => {
      const { sessionId } = setupFullState();
      useVerificationStore.getState().removeSession(REF_DOCUMENT_ID, sessionId);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('alignment lane uses alignedReference not raw sequence', () => {
      setupFullState();
      const cs = deriveCoordinateSpace(REF_DOCUMENT_ID);
      expect(cs).toBeDefined();
      expect(cs!.gappedSequence).toContain('-');
      expect(cs!.gappedSequence).toBe(ALIGNED_REF);
    });

    it('alignedQuery in coordinateSpace is the gapped query', () => {
      setupFullState();
      const cs = deriveCoordinateSpace(REF_DOCUMENT_ID);
      expect(cs).toBeDefined();
      expect(cs!.alignedQuery).toBe(ALIGNED_QUERY);
    });

    it('multiple references have independent panel-open state', () => {
      const REF2 = '/workspace/references/pBR322.gb';
      setupFullState();

      const store = useVerificationStore.getState();
      const sid2 = store.createSession(REF2, {
        name: 'Session for pBR322',
        mode: 'one-per-clone',
        queryPaths: [],
      });
      const track2 = makeTrack({ id: 'track-br322' });
      useVerificationStore.getState().addTrackToSession(REF2, sid2, track2);

      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
      expect(deriveCoordinateSpace(REF2)).toBeUndefined();

      useVerificationStore.getState().setAlignmentPanelOpen(REF2, true);
      expect(deriveCoordinateSpace(REF2)).toBeDefined();
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });

    it('switching active sessions changes which alignment data is used', () => {
      const store = useVerificationStore.getState();
      const sid1 = store.createSession(REF_DOCUMENT_ID, {
        name: 'Session A',
        mode: 'one-per-clone',
        queryPaths: [],
      });
      const trackA = makeTrack({
        id: 'track-A',
        alignment: {
          alignedReference: 'AAAA',
          alignedQuery: 'AAAG',
          identity: 75,
          coverageStart: 1,
          coverageEnd: 4,
          algorithm: 'MAFFT',
        },
      });
      useVerificationStore.getState().addTrackToSession(REF_DOCUMENT_ID, sid1, trackA);

      const sid2 = useVerificationStore.getState().createSession(REF_DOCUMENT_ID, {
        name: 'Session B',
        mode: 'one-per-clone',
        queryPaths: [],
      });
      const trackB = makeTrack({
        id: 'track-B',
        alignment: {
          alignedReference: 'CCCC',
          alignedQuery: 'CCCT',
          identity: 75,
          coverageStart: 1,
          coverageEnd: 4,
          algorithm: 'MAFFT',
        },
      });
      useVerificationStore.getState().addTrackToSession(REF_DOCUMENT_ID, sid2, trackB);
      useVerificationStore.getState().setAlignmentPanelOpen(REF_DOCUMENT_ID, true);

      let cs = deriveCoordinateSpace(REF_DOCUMENT_ID);
      expect(cs?.gappedSequence).toBe('CCCC');

      useVerificationStore.getState().setActiveSession(REF_DOCUMENT_ID, sid1);
      cs = deriveCoordinateSpace(REF_DOCUMENT_ID);
      expect(cs?.gappedSequence).toBe('AAAA');
    });

    it('unhiding a track restores the alignment lane', () => {
      const { sessionId } = setupFullState();
      const store = useVerificationStore.getState();
      store.setSessionViewPreferences(REF_DOCUMENT_ID, sessionId, {
        selectedTrackId: 'track-001',
      });

      useVerificationStore
        .getState()
        .toggleTrackVisibility(REF_DOCUMENT_ID, sessionId, 'track-001');
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeUndefined();

      useVerificationStore
        .getState()
        .toggleTrackVisibility(REF_DOCUMENT_ID, sessionId, 'track-001');
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });

    it('only the selected track being hidden matters, not other hidden tracks', () => {
      const { sessionId } = setupFullState();
      const store = useVerificationStore.getState();

      const track2 = makeTrack({ id: 'track-002', label: 'clone2' });
      store.addTrackToSession(REF_DOCUMENT_ID, sessionId, track2);

      useVerificationStore.getState().setSessionViewPreferences(REF_DOCUMENT_ID, sessionId, {
        selectedTrackId: 'track-001',
      });
      useVerificationStore
        .getState()
        .toggleTrackVisibility(REF_DOCUMENT_ID, sessionId, 'track-002');

      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });
  });

  describe('persistence partialize safety', () => {
    it('partialize does NOT include verificationState', () => {
      setupFullState();

      const persistApi = useVerificationStore.persist;
      const options = persistApi?.getOptions?.();

      expect(options?.partialize).toBeDefined();

      const fullState = useVerificationStore.getState();
      const partialized = options!.partialize!(fullState);

      expect(partialized).not.toHaveProperty('verificationState');
      expect(partialized).not.toHaveProperty('alignmentPanelOpen');
      expect(partialized).not.toHaveProperty('focusedPosition');
      expect(partialized).not.toHaveProperty('sessionMutations');

      expect(partialized).toHaveProperty('sessionViewPreferences');
    });

    it('partialize output contains ONLY sessionViewPreferences', () => {
      setupFullState();

      const options = useVerificationStore.persist?.getOptions?.();
      const fullState = useVerificationStore.getState();
      const partialized = options!.partialize!(fullState);

      const keys = Object.keys(partialized);
      expect(keys).toEqual(['sessionViewPreferences']);
    });
  });

  describe('alignment data survives unrelated state changes', () => {
    it('navigateToPosition does not corrupt alignment data', () => {
      const { sessionId } = setupFullState();
      const store = useVerificationStore.getState();

      store.navigateToPosition(REF_DOCUMENT_ID, 42, { start: 40, end: 44 });

      const session = useVerificationStore.getState().getActiveSession(REF_DOCUMENT_ID);
      expect(session?.tracks[0].alignment.alignedReference).toBe(ALIGNED_REF);
      expect(session?.tracks[0].alignment.alignedQuery).toBe(ALIGNED_QUERY);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });

    it('clearFocusedPosition does not corrupt alignment data', () => {
      setupFullState();
      const store = useVerificationStore.getState();
      store.navigateToPosition(REF_DOCUMENT_ID, 10);
      useVerificationStore.getState().clearFocusedPosition();

      const session = useVerificationStore.getState().getActiveSession(REF_DOCUMENT_ID);
      expect(session?.tracks[0].alignment.alignedReference).toBe(ALIGNED_REF);
      expect(session?.tracks[0].alignment.alignedQuery).toBe(ALIGNED_QUERY);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });

    it('renameSession does not corrupt alignment data', () => {
      const { sessionId } = setupFullState();
      useVerificationStore.getState().renameSession(REF_DOCUMENT_ID, sessionId, 'Renamed Session');

      const session = useVerificationStore.getState().getActiveSession(REF_DOCUMENT_ID);
      expect(session?.name).toBe('Renamed Session');
      expect(session?.tracks[0].alignment.alignedReference).toBe(ALIGNED_REF);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });

    it('renameTrack does not corrupt alignment data', () => {
      const { sessionId } = setupFullState();
      useVerificationStore
        .getState()
        .renameTrack(REF_DOCUMENT_ID, sessionId, 'track-001', 'New Label');

      const session = useVerificationStore.getState().getActiveSession(REF_DOCUMENT_ID);
      expect(session?.tracks[0].label).toBe('New Label');
      expect(session?.tracks[0].alignment.alignedReference).toBe(ALIGNED_REF);
      expect(session?.tracks[0].alignment.alignedQuery).toBe(ALIGNED_QUERY);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });

    it('overrideTrackStatus does not corrupt alignment data', () => {
      const { sessionId } = setupFullState();
      useVerificationStore
        .getState()
        .overrideTrackStatus(REF_DOCUMENT_ID, sessionId, 'track-001', 'pass', 'Looks good');

      const session = useVerificationStore.getState().getActiveSession(REF_DOCUMENT_ID);
      expect(session?.tracks[0].userStatus).toBe('pass');
      expect(session?.tracks[0].alignment.alignedReference).toBe(ALIGNED_REF);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });

    it('setSessionViewPreferences does not corrupt alignment data', () => {
      const { sessionId } = setupFullState();
      useVerificationStore.getState().setSessionViewPreferences(REF_DOCUMENT_ID, sessionId, {
        viewMode: 'stacked',
        selectedTrackId: 'track-001',
      });

      const session = useVerificationStore.getState().getActiveSession(REF_DOCUMENT_ID);
      expect(session?.tracks[0].alignment.alignedReference).toBe(ALIGNED_REF);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });

    it('archiveSession + unarchiveSession does not corrupt alignment data', () => {
      const { sessionId } = setupFullState();
      useVerificationStore.getState().archiveSession(REF_DOCUMENT_ID, sessionId);

      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeUndefined();

      useVerificationStore.getState().unarchiveSession(REF_DOCUMENT_ID, sessionId);
      useVerificationStore.getState().setActiveSession(REF_DOCUMENT_ID, sessionId);

      const session = useVerificationStore.getState().getActiveSession(REF_DOCUMENT_ID);
      expect(session?.tracks[0].alignment.alignedReference).toBe(ALIGNED_REF);
      expect(session?.tracks[0].alignment.alignedQuery).toBe(ALIGNED_QUERY);

      useVerificationStore.getState().setAlignmentPanelOpen(REF_DOCUMENT_ID, true);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });

    it('adding another track does not corrupt the first track alignment data', () => {
      const { sessionId } = setupFullState();
      const track2 = makeTrack({
        id: 'track-002',
        label: 'clone2',
        alignment: {
          alignedReference: 'GGGG',
          alignedQuery: 'GGGT',
          identity: 75,
          coverageStart: 1,
          coverageEnd: 4,
          algorithm: 'MAFFT',
        },
      });
      useVerificationStore.getState().addTrackToSession(REF_DOCUMENT_ID, sessionId, track2);

      const session = useVerificationStore.getState().getActiveSession(REF_DOCUMENT_ID);
      expect(session?.tracks[0].alignment.alignedReference).toBe(ALIGNED_REF);
      expect(session?.tracks[1].alignment.alignedReference).toBe('GGGG');
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)!.gappedSequence).toBe(ALIGNED_REF);
    });

    it('removing a different track does not corrupt the active track', () => {
      const { sessionId } = setupFullState();
      const track2 = makeTrack({ id: 'track-002', label: 'clone2' });
      useVerificationStore.getState().addTrackToSession(REF_DOCUMENT_ID, sessionId, track2);

      useVerificationStore.getState().removeTrack(REF_DOCUMENT_ID, sessionId, 'track-002');

      const session = useVerificationStore.getState().getActiveSession(REF_DOCUMENT_ID);
      expect(session?.tracks).toHaveLength(1);
      expect(session?.tracks[0].alignment.alignedReference).toBe(ALIGNED_REF);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });
  });

  describe('rapid state transitions', () => {
    it('rapid panel open/close settles to correct final state', () => {
      setupFullState();
      const store = useVerificationStore.getState;

      for (let i = 0; i < 20; i++) {
        useVerificationStore.getState().setAlignmentPanelOpen(REF_DOCUMENT_ID, i % 2 === 0);
      }
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeUndefined();

      useVerificationStore.getState().setAlignmentPanelOpen(REF_DOCUMENT_ID, true);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });

    it('rapid session switches always show correct alignment data', () => {
      const store = useVerificationStore.getState();
      const sessions: string[] = [];

      for (let i = 0; i < 5; i++) {
        const sid = useVerificationStore.getState().createSession(REF_DOCUMENT_ID, {
          name: `Session ${i}`,
          mode: 'one-per-clone',
          queryPaths: [],
        });
        const track = makeTrack({
          id: `track-${i}`,
          alignment: {
            alignedReference: `REF${i}${'ATGC'.repeat(10)}`,
            alignedQuery: `QRY${i}${'ATGC'.repeat(10)}`,
            identity: 90 + i,
            coverageStart: 1,
            coverageEnd: 43,
            algorithm: 'MAFFT',
          },
        });
        useVerificationStore.getState().addTrackToSession(REF_DOCUMENT_ID, sid, track);
        sessions.push(sid);
      }

      useVerificationStore.getState().setAlignmentPanelOpen(REF_DOCUMENT_ID, true);

      for (const sid of sessions) {
        useVerificationStore.getState().setActiveSession(REF_DOCUMENT_ID, sid);
        const cs = deriveCoordinateSpace(REF_DOCUMENT_ID);
        expect(cs).toBeDefined();
        const session = useVerificationStore.getState().getActiveSession(REF_DOCUMENT_ID);
        expect(cs!.gappedSequence).toBe(session!.tracks[0].alignment.alignedReference);
      }
    });

    it('interleaved navigateToPosition calls do not break coordinateSpace', () => {
      setupFullState();

      for (let i = 0; i < 50; i++) {
        useVerificationStore.getState().navigateToPosition(REF_DOCUMENT_ID, i + 1);
      }
      useVerificationStore.getState().clearFocusedPosition();

      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)!.gappedSequence).toBe(ALIGNED_REF);
    });
  });

  describe('truthiness edge cases for alignment strings', () => {
    it('alignedReference of whitespace-only string is truthy and results in coordinateSpace', () => {
      setupFullState({
        alignment: {
          alignedReference: '   ',
          alignedQuery: 'ATG',
          identity: 0,
          coverageStart: 0,
          coverageEnd: 0,
          algorithm: 'MAFFT',
        },
      });
      const cs = deriveCoordinateSpace(REF_DOCUMENT_ID);
      expect(cs).toBeDefined();
    });

    it('alignedReference of single character is truthy', () => {
      setupFullState({
        alignment: {
          alignedReference: 'A',
          alignedQuery: 'A',
          identity: 100,
          coverageStart: 1,
          coverageEnd: 1,
          algorithm: 'MAFFT',
        },
      });
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });

    it('undefined alignment on track results in undefined coordinateSpace', () => {
      const store = useVerificationStore.getState();
      const sid = store.createSession(REF_DOCUMENT_ID, {
        name: 'Bad track',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const badTrack: VerificationTrack = {
        id: 'track-bad',
        queryPath: QUERY_PATH,
        label: 'bad',
        alignment: {
          alignedReference: undefined as unknown as string,
          alignedQuery: undefined as unknown as string,
          identity: 0,
          coverageStart: 0,
          coverageEnd: 0,
          algorithm: 'MAFFT',
        },
        mutations: [],
        status: 'fail',
        alignedAt: new Date().toISOString(),
      };

      useVerificationStore.getState().addTrackToSession(REF_DOCUMENT_ID, sid, badTrack);
      useVerificationStore.getState().setAlignmentPanelOpen(REF_DOCUMENT_ID, true);

      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeUndefined();
    });
  });

  describe('mutation cache independence', () => {
    it('invalidating mutation cache does not affect coordinateSpace', () => {
      const { sessionId } = setupFullState();
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();

      useVerificationStore.getState().invalidateMutationCache(REF_DOCUMENT_ID, sessionId);
      expect(deriveCoordinateSpace(REF_DOCUMENT_ID)).toBeDefined();
    });

    it('getTrackMutations returns results even after cache invalidation', () => {
      const { sessionId } = setupFullState();
      useVerificationStore.getState().invalidateMutationCache(REF_DOCUMENT_ID, sessionId);

      const mutations = useVerificationStore
        .getState()
        .getTrackMutations(REF_DOCUMENT_ID, sessionId, 'track-001');
      expect(mutations.length).toBeGreaterThan(0);
    });
  });

  describe('boolean matrix: all combinations of the 4 gating conditions', () => {
    type Scenario = {
      panelOpen: boolean;
      hasData: boolean;
      visible: boolean;
      trackHidden: boolean;
      expected: boolean;
    };

    const scenarios: Scenario[] = [
      { panelOpen: true, hasData: true, visible: true, trackHidden: false, expected: true },
      { panelOpen: false, hasData: true, visible: true, trackHidden: false, expected: false },
      { panelOpen: true, hasData: false, visible: true, trackHidden: false, expected: false },
      { panelOpen: true, hasData: true, visible: false, trackHidden: false, expected: false },
      { panelOpen: true, hasData: true, visible: true, trackHidden: true, expected: false },
      { panelOpen: false, hasData: false, visible: true, trackHidden: false, expected: false },
      { panelOpen: false, hasData: true, visible: false, trackHidden: false, expected: false },
      { panelOpen: false, hasData: true, visible: true, trackHidden: true, expected: false },
      { panelOpen: true, hasData: false, visible: false, trackHidden: false, expected: false },
      { panelOpen: true, hasData: false, visible: true, trackHidden: true, expected: false },
      { panelOpen: true, hasData: true, visible: false, trackHidden: true, expected: false },
      { panelOpen: false, hasData: false, visible: false, trackHidden: false, expected: false },
      { panelOpen: false, hasData: false, visible: true, trackHidden: true, expected: false },
      { panelOpen: false, hasData: true, visible: false, trackHidden: true, expected: false },
      { panelOpen: true, hasData: false, visible: false, trackHidden: true, expected: false },
      { panelOpen: false, hasData: false, visible: false, trackHidden: true, expected: false },
    ];

    for (const sc of scenarios) {
      const label =
        `panel=${sc.panelOpen}, data=${sc.hasData}, visible=${sc.visible}, ` +
        `hidden=${sc.trackHidden} => ${sc.expected ? 'DEFINED' : 'UNDEFINED'}`;

      it(label, () => {
        useVerificationStore.setState({
          verificationState: {},
          sessionViewPreferences: {},
          alignmentPanelOpen: new Set<string>(),
          focusedPosition: null,
          sessionMutations: {},
        });

        if (sc.hasData) {
          const store = useVerificationStore.getState();
          const sid = store.createSession(REF_DOCUMENT_ID, {
            name: 'Matrix test',
            mode: 'one-per-clone',
            queryPaths: [],
          });
          const track = makeTrack();
          useVerificationStore.getState().addTrackToSession(REF_DOCUMENT_ID, sid, track);

          useVerificationStore.getState().setSessionViewPreferences(REF_DOCUMENT_ID, sid, {
            selectedTrackId: 'track-001',
          });

          if (!sc.visible) {
            useVerificationStore.getState().toggleAlignmentVisibility(REF_DOCUMENT_ID, sid);
          }
          if (sc.trackHidden) {
            useVerificationStore
              .getState()
              .toggleTrackVisibility(REF_DOCUMENT_ID, sid, 'track-001');
          }
        } else {
          const store = useVerificationStore.getState();
          store.createSession(REF_DOCUMENT_ID, {
            name: 'Empty',
            mode: 'one-per-clone',
            queryPaths: [],
          });
        }

        if (sc.panelOpen) {
          useVerificationStore.getState().setAlignmentPanelOpen(REF_DOCUMENT_ID, true);
        }

        const cs = deriveCoordinateSpace(REF_DOCUMENT_ID);
        if (sc.expected) {
          expect(cs).toBeDefined();
        } else {
          expect(cs).toBeUndefined();
        }
      });
    }
  });
});
