import { describe, it, expect, beforeEach } from 'vitest';
import { useVerificationStore } from '../store';
import type { VerificationTrack, SessionMode } from '../types';

function createMockTrack(overrides: Partial<VerificationTrack> = {}): VerificationTrack {
  return {
    id: `track-${Date.now()}`,
    queryPath: '/path/to/query.ab1',
    label: 'query',
    alignment: {
      alignedReference: 'ATGC',
      alignedQuery: 'ATGC',
      identity: 100,
      coverageStart: 1,
      coverageEnd: 4,
      algorithm: 'MAFFT',
    },
    mutations: [],
    status: 'pass',
    alignedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('useVerificationStore', () => {
  beforeEach(() => {
    useVerificationStore.setState({
      verificationState: {},
      sessionViewPreferences: {},
    });
  });

  describe('createSession', () => {
    it('creates a new session with the given name and mode', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Cloning Run 1',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');

      const state = store.getVerificationState(referencePath);
      expect(state).toBeDefined();
      expect(state?.sessions).toHaveLength(1);
      expect(state?.sessions[0].name).toBe('Cloning Run 1');
      expect(state?.sessions[0].mode).toBe('one-per-clone');
      expect(state?.sessions[0].tracks).toEqual([]);
    });

    it('sets the new session as active by default', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Test Session',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const state = store.getVerificationState(referencePath);
      expect(state?.activeSessionId).toBe(sessionId);
    });

    it('allows multiple sessions for the same reference', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      store.createSession(referencePath, {
        name: 'Session 1',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      store.createSession(referencePath, {
        name: 'Session 2',
        mode: 'multi-per-clone',
        queryPaths: [],
      });

      const state = store.getVerificationState(referencePath);
      expect(state?.sessions).toHaveLength(2);
      expect(state?.sessions[0].name).toBe('Session 1');
      expect(state?.sessions[1].name).toBe('Session 2');
    });

    it('throws error if name is empty', () => {
      const store = useVerificationStore.getState();

      expect(() => {
        store.createSession('/path/to/ref.gb', {
          name: '',
          mode: 'one-per-clone',
          queryPaths: [],
        });
      }).toThrow('Session name is required');
    });

    it('throws error if name is only whitespace', () => {
      const store = useVerificationStore.getState();

      expect(() => {
        store.createSession('/path/to/ref.gb', {
          name: '   ',
          mode: 'one-per-clone',
          queryPaths: [],
        });
      }).toThrow('Session name is required');
    });
  });

  describe('addTrackToSession', () => {
    it('adds a track to an existing session', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Test Session',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const track = createMockTrack({ id: 'track-1', label: 'clone1' });
      store.addTrackToSession(referencePath, sessionId, track);

      const session = store.getActiveSession(referencePath);
      expect(session?.tracks).toHaveLength(1);
      expect(session?.tracks[0].label).toBe('clone1');
    });

    it('throws error if session does not exist', () => {
      const store = useVerificationStore.getState();
      const track = createMockTrack();

      expect(() => {
        store.addTrackToSession('/path/to/ref.gb', 'non-existent-session', track);
      }).toThrow('Session not found');
    });
  });

  describe('updateTrack', () => {
    it('updates track properties', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const track = createMockTrack({ id: 'track-1', status: 'pass' });
      store.addTrackToSession(referencePath, sessionId, track);

      store.updateTrack(referencePath, sessionId, 'track-1', {
        status: 'fail',
        mutations: [
          {
            id: 'mut-1',
            position: 100,
            type: 'deletion',
            referenceBase: 'ATGC',
            alternateBase: '',
            length: 4,
            effect: {
              featureName: 'GFP',
              featureType: 'CDS',
              classification: 'frameshift',
            },
          },
        ],
      });

      const session = store.getActiveSession(referencePath);
      expect(session?.tracks[0].status).toBe('fail');
      expect(session?.tracks[0].mutations).toHaveLength(1);
    });
  });

  describe('setActiveSession', () => {
    it('changes the active session', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      const session1Id = store.createSession(referencePath, {
        name: 'Session 1',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const session2Id = store.createSession(referencePath, {
        name: 'Session 2',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      expect(store.getVerificationState(referencePath)?.activeSessionId).toBe(session2Id);

      store.setActiveSession(referencePath, session1Id);
      expect(store.getVerificationState(referencePath)?.activeSessionId).toBe(session1Id);
    });

    it('can clear the active session', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      store.createSession(referencePath, {
        name: 'Test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      store.setActiveSession(referencePath, null);
      expect(store.getVerificationState(referencePath)?.activeSessionId).toBeNull();
    });
  });

  describe('removeSession', () => {
    it('removes a session from the reference', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      store.removeSession(referencePath, sessionId);

      const state = store.getVerificationState(referencePath);
      expect(state?.sessions).toHaveLength(0);
    });

    it('clears activeSessionId if removing the active session', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      expect(store.getVerificationState(referencePath)?.activeSessionId).toBe(sessionId);

      store.removeSession(referencePath, sessionId);

      expect(store.getVerificationState(referencePath)?.activeSessionId).toBeNull();
    });

    it('sets another session as active if available', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      const session1Id = store.createSession(referencePath, {
        name: 'Session 1',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const session2Id = store.createSession(referencePath, {
        name: 'Session 2',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      store.removeSession(referencePath, session2Id);

      expect(store.getVerificationState(referencePath)?.activeSessionId).toBe(session1Id);
    });
  });

  describe('removeTrack', () => {
    it('removes a track from a session', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const track1 = createMockTrack({ id: 'track-1' });
      const track2 = createMockTrack({ id: 'track-2' });

      store.addTrackToSession(referencePath, sessionId, track1);
      store.addTrackToSession(referencePath, sessionId, track2);

      expect(store.getActiveSession(referencePath)?.tracks).toHaveLength(2);

      store.removeTrack(referencePath, sessionId, 'track-1');

      const session = store.getActiveSession(referencePath);
      expect(session?.tracks).toHaveLength(1);
      expect(session?.tracks[0].id).toBe('track-2');
    });
  });

  describe('getActiveSession', () => {
    it('returns the active session', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      store.createSession(referencePath, {
        name: 'Active Session',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const activeSession = store.getActiveSession(referencePath);
      expect(activeSession?.name).toBe('Active Session');
    });

    it('returns undefined if no active session', () => {
      const store = useVerificationStore.getState();

      const activeSession = store.getActiveSession('/nonexistent/path.gb');
      expect(activeSession).toBeUndefined();
    });
  });

  describe('sessionViewPreferences', () => {
    it('returns default preferences based on session mode', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Compare Session',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const prefs = store.getSessionViewPreferences(referencePath, sessionId);

      expect(prefs?.viewMode).toBe('stacked');
    });

    it('returns single view mode for multi-per-clone sessions', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Consensus Session',
        mode: 'multi-per-clone',
        queryPaths: [],
      });

      const prefs = store.getSessionViewPreferences(referencePath, sessionId);
      expect(prefs?.viewMode).toBe('single');
    });

    it('allows overriding view preferences', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      expect(store.getSessionViewPreferences(referencePath, sessionId)?.viewMode).toBe('stacked');

      store.setSessionViewPreferences(referencePath, sessionId, {
        viewMode: 'single',
        selectedTrackId: 'track-1',
      });

      const prefs = store.getSessionViewPreferences(referencePath, sessionId);
      expect(prefs?.viewMode).toBe('single');
      expect(prefs?.selectedTrackId).toBe('track-1');
    });
  });

  describe('aggregated mutations', () => {
    it('aggregates mutations across tracks in a session', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/reference.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const track1 = createMockTrack({
        id: 'track-1',
        mutations: [
          {
            id: 'mut-1',
            position: 100,
            type: 'substitution',
            referenceBase: 'A',
            alternateBase: 'G',
            length: 1,
          },
        ],
      });

      const track2 = createMockTrack({
        id: 'track-2',
        mutations: [
          {
            id: 'mut-2',
            position: 100,
            type: 'substitution',
            referenceBase: 'A',
            alternateBase: 'G',
            length: 1,
          },
        ],
      });

      const track3 = createMockTrack({
        id: 'track-3',
        mutations: [
          {
            id: 'mut-3',
            position: 200,
            type: 'substitution',
            referenceBase: 'T',
            alternateBase: 'C',
            length: 1,
          },
        ],
      });

      store.addTrackToSession(referencePath, sessionId, track1);
      store.addTrackToSession(referencePath, sessionId, track2);
      store.addTrackToSession(referencePath, sessionId, track3);

      const aggregated = store.getAggregatedMutations(referencePath, sessionId);

      expect(aggregated).toHaveLength(2);

      const mut100 = aggregated.find((m) => m.position === 100);
      expect(mut100?.trackIds).toContain('track-1');
      expect(mut100?.trackIds).toContain('track-2');
      expect(mut100?.hasConflict).toBe(true);

      const mut200 = aggregated.find((m) => m.position === 200);
      expect(mut200?.trackIds).toEqual(['track-3']);
      expect(mut200?.hasConflict).toBe(true);
    });
  });

  describe('computeTrackMutations edge cases', () => {
    it('handles empty alignment gracefully', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/ref.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Empty alignment test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const track = createMockTrack({
        id: 'track-empty',
        alignment: {
          alignedReference: '',
          alignedQuery: '',
          identity: 0,
          coverageStart: 0,
          coverageEnd: 0,
          algorithm: 'MAFFT',
        },
        mutations: [
          {
            id: 'mut-1',
            position: 1,
            type: 'substitution',
            referenceBase: 'A',
            alternateBase: 'G',
            length: 1,
          },
        ],
      });

      store.addTrackToSession(referencePath, sessionId, track);
      const mutations = store.getTrackMutations(referencePath, sessionId, 'track-empty');

      expect(mutations).toEqual([]);
    });

    it('handles mutation position beyond reference length', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/ref.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Out of bounds test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const track = createMockTrack({
        id: 'track-oob',
        alignment: {
          alignedReference: 'ATGC',
          alignedQuery: 'ATGC',
          identity: 100,
          coverageStart: 1,
          coverageEnd: 4,
          algorithm: 'MAFFT',
        },
        mutations: [
          {
            id: 'mut-oob',
            position: 100,
            type: 'substitution',
            referenceBase: 'A',
            alternateBase: 'G',
            length: 1,
          },
        ],
      });

      store.addTrackToSession(referencePath, sessionId, track);
      const mutations = store.getTrackMutations(referencePath, sessionId, 'track-oob');

      expect(mutations).toEqual([]);
    });

    it('handles deletion extending past sequence end', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/ref.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Deletion past end test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const track = createMockTrack({
        id: 'track-del',
        alignment: {
          alignedReference: 'ATGCATGCAT',
          alignedQuery: 'ATGCAT----',
          identity: 60,
          coverageStart: 1,
          coverageEnd: 10,
          algorithm: 'MAFFT',
        },
        mutations: [
          {
            id: 'mut-del',
            position: 7,
            type: 'deletion',
            referenceBase: 'GCATXXX',
            alternateBase: '-',
            length: 7,
          },
        ],
      });

      store.addTrackToSession(referencePath, sessionId, track);
      const mutations = store.getTrackMutations(referencePath, sessionId, 'track-del');

      expect(mutations).toHaveLength(1);
      expect(mutations[0].column).toBe(6);
      expect(mutations[0].endColumn).toBe(9);
    });

    it('handles substitution at valid position', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/ref.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Valid substitution test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const track = createMockTrack({
        id: 'track-sub',
        alignment: {
          alignedReference: 'ATGCATGCAT',
          alignedQuery: 'ATGGATGCAT',
          identity: 90,
          coverageStart: 1,
          coverageEnd: 10,
          algorithm: 'MAFFT',
        },
        mutations: [
          {
            id: 'mut-sub',
            position: 4,
            type: 'substitution',
            referenceBase: 'C',
            alternateBase: 'G',
            length: 1,
          },
        ],
      });

      store.addTrackToSession(referencePath, sessionId, track);
      const mutations = store.getTrackMutations(referencePath, sessionId, 'track-sub');

      expect(mutations).toHaveLength(1);
      expect(mutations[0].column).toBe(3);
      expect(mutations[0].type).toBe('substitution');
      expect(mutations[0].refBase).toBe('C');
      expect(mutations[0].queryBase).toBe('G');
    });

    it('handles insertion with gaps in alignment', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/ref.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Insertion test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const track = createMockTrack({
        id: 'track-ins',
        alignment: {
          alignedReference: 'ATGC---ATGCAT',
          alignedQuery: 'ATGCTTTATGCAT',
          identity: 77,
          coverageStart: 1,
          coverageEnd: 10,
          algorithm: 'MAFFT',
        },
        mutations: [
          {
            id: 'mut-ins',
            position: 5,
            type: 'insertion',
            referenceBase: '-',
            alternateBase: 'TTT',
            length: 3,
          },
        ],
      });

      store.addTrackToSession(referencePath, sessionId, track);
      const mutations = store.getTrackMutations(referencePath, sessionId, 'track-ins');

      expect(mutations).toHaveLength(1);
      expect(mutations[0].type).toBe('insertion');
      expect(mutations[0].column).toBe(4);
      expect(mutations[0].endColumn).toBe(6);
    });

    it('handles insertion at position 1 (start of sequence)', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/ref.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Insertion at start test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const track = createMockTrack({
        id: 'track-ins-start',
        alignment: {
          alignedReference: '---ATGCAT',
          alignedQuery: 'TTTATGCAT',
          identity: 67,
          coverageStart: 1,
          coverageEnd: 6,
          algorithm: 'MAFFT',
        },
        mutations: [
          {
            id: 'mut-ins-start',
            position: 1,
            type: 'insertion',
            referenceBase: '-',
            alternateBase: 'TTT',
            length: 3,
          },
        ],
      });

      store.addTrackToSession(referencePath, sessionId, track);
      const mutations = store.getTrackMutations(referencePath, sessionId, 'track-ins-start');

      expect(mutations).toHaveLength(1);
      expect(mutations[0].type).toBe('insertion');
      expect(mutations[0].column).toBe(0);
      expect(mutations[0].endColumn).toBe(2);
    });

    it('handles multi-base deletion', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/ref.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Multi-base deletion test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const track = createMockTrack({
        id: 'track-multidel',
        alignment: {
          alignedReference: 'ATGCATGCAT',
          alignedQuery: 'AT---TGCAT',
          identity: 70,
          coverageStart: 1,
          coverageEnd: 10,
          algorithm: 'MAFFT',
        },
        mutations: [
          {
            id: 'mut-multidel',
            position: 3,
            type: 'deletion',
            referenceBase: 'GCA',
            alternateBase: '-',
            length: 3,
          },
        ],
      });

      store.addTrackToSession(referencePath, sessionId, track);
      const mutations = store.getTrackMutations(referencePath, sessionId, 'track-multidel');

      expect(mutations).toHaveLength(1);
      expect(mutations[0].type).toBe('deletion');
      expect(mutations[0].column).toBe(2);
      expect(mutations[0].endColumn).toBe(4);
    });
  });

  describe('persist partialize (regression: rehydration must not corrupt live state)', () => {
    it('partialize must NOT include verificationState', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/ref.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Persist test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const track = createMockTrack({
        id: 'track-persist',
        alignment: {
          alignedReference: 'ATGCATGCATGCATGC',
          alignedQuery: 'ATGGATGCATGCATGC',
          identity: 93.75,
          coverageStart: 1,
          coverageEnd: 16,
          algorithm: 'MAFFT',
        },
        mutations: [
          {
            id: 'mut-1',
            position: 4,
            type: 'substitution',
            referenceBase: 'C',
            alternateBase: 'G',
            length: 1,
          },
        ],
      });

      store.addTrackToSession(referencePath, sessionId, track);

      const persistApi = useVerificationStore.persist;
      const options = persistApi?.getOptions?.();

      if (options?.partialize) {
        const fullState = useVerificationStore.getState();
        const partialized = options.partialize(fullState);

        expect(partialized).not.toHaveProperty('verificationState');

        expect(partialized).toHaveProperty('sessionViewPreferences');
      }
    });

    it('live alignment data survives state changes without being corrupted', () => {
      const store = useVerificationStore.getState();
      const referencePath = '/path/to/ref.gb';

      const sessionId = store.createSession(referencePath, {
        name: 'Corruption test',
        mode: 'one-per-clone',
        queryPaths: [],
      });

      const alignedReference = 'ATGC--ATGCAT';
      const alignedQuery = 'ATGCGGATGCAT';

      const track = createMockTrack({
        id: 'track-corruption',
        alignment: {
          alignedReference,
          alignedQuery,
          identity: 83.3,
          coverageStart: 1,
          coverageEnd: 10,
          algorithm: 'MAFFT',
        },
        mutations: Array.from({ length: 200 }, (_, i) => ({
          id: `mut-${i}`,
          position: i + 1,
          type: 'substitution' as const,
          referenceBase: 'A',
          alternateBase: 'G',
          length: 1,
        })),
      });

      store.addTrackToSession(referencePath, sessionId, track);

      store.navigateToPosition(referencePath, 5);
      store.clearFocusedPosition();

      const session = store.getActiveSession(referencePath);
      expect(session?.tracks[0].alignment.alignedReference).toBe(alignedReference);
      expect(session?.tracks[0].alignment.alignedQuery).toBe(alignedQuery);
      expect(session?.tracks[0].mutations).toHaveLength(200);
    });
  });
});
