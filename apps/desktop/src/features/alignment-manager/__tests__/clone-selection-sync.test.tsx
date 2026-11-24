import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useVerificationStore } from '../store';
import { useAlignmentDerivedState } from '../hooks/useAlignmentDerivedState';
import type { VerificationTrack } from '../types';

const documentId = 'clone-selection-reference';

function track(id: string, position: number | null): VerificationTrack {
  return {
    id,
    queryPath: `/fixtures/${id}.fasta`,
    label: id,
    alignment: {
      alignedReference: 'ATGC',
      alignedQuery: position === 2 ? 'ACGC' : position === 3 ? 'ATAC' : 'ATGC',
      identity: position === null ? 100 : 75,
      coverageStart: 1,
      coverageEnd: 4,
      algorithm: 'MAFFT',
    },
    mutations:
      position === null
        ? []
        : [
            {
              id: `${id}-substitution`,
              position,
              type: 'substitution',
              referenceBase: position === 2 ? 'T' : 'G',
              alternateBase: position === 2 ? 'C' : 'A',
              length: 1,
            },
          ],
    status: position === null ? 'pass' : 'variants',
    alignedAt: '2026-10-19T00:00:00.000Z',
  };
}

beforeEach(() => {
  useVerificationStore.setState({
    verificationState: {},
    sessionViewPreferences: {},
    sessionMutations: {},
    alignmentPanelOpen: new Set(),
    focusedPosition: null,
  });
});

function session() {
  const store = useVerificationStore.getState();
  const id = store.createSession(documentId, {
    name: 'Clones',
    mode: 'one-per-clone',
    queryPaths: [],
  });
  store.addTrackToSession(documentId, id, track('clone-a', 2));
  store.addTrackToSession(documentId, id, track('clone-b', 3));
  store.addTrackToSession(documentId, id, track('matching-clone', null));
  store.setSessionViewPreferences(documentId, id, {
    selectedTrackId: 'clone-a',
    viewMode: 'single',
  });
  return id;
}

const markerA = { column: 1, type: 'substitution', refBase: 'T', queryBase: 'C', refPosition: 2 };
const markerB = { column: 2, type: 'substitution', refBase: 'G', queryBase: 'A', refPosition: 3 };

describe('clone selection through the production viewer hook', () => {
  it('keeps the session default when choosing or hiding a read before setting a display mode', () => {
    const store = useVerificationStore.getState();
    const id = store.createSession(documentId, {
      name: 'Pair',
      mode: 'one-per-clone',
      queryPaths: [],
    });
    store.addTrackToSession(documentId, id, track('a', null));
    store.addTrackToSession(documentId, id, track('b', null));
    const { result } = renderHook(() => useAlignmentDerivedState(documentId));
    expect(result.current.viewMode).toBe('stacked');
    act(() => store.setSessionViewPreferences(documentId, id, { selectedTrackId: 'b' }));
    act(() => store.toggleTrackVisibility(documentId, id, 'a'));
    expect(result.current.viewMode).toBe('stacked');
    expect(result.current.hiddenTrackIds).toEqual(['a']);
    act(() => store.setSessionViewPreferences(documentId, id, { viewMode: 'single' }));
    expect(result.current.viewMode).toBe('single');
  });

  it('reacts to selection changes and returns the selected clone’s actual gapped markers', () => {
    const id = session();
    const { result } = renderHook(() => useAlignmentDerivedState(documentId));
    expect(result.current.selectedTrackId).toBe('clone-a');
    expect(result.current.alignedQuery).toBe('ACGC');
    expect(
      result.current.getTrackMutations(documentId, id, result.current.selectedTrackId!)
    ).toEqual([markerA]);
    act(() =>
      useVerificationStore
        .getState()
        .setSessionViewPreferences(documentId, id, { selectedTrackId: 'clone-b' })
    );
    expect(result.current.selectedTrackId).toBe('clone-b');
    expect(result.current.viewMode).toBe('single');
    expect(result.current.alignedQuery).toBe('ATAC');
    expect(
      result.current.getTrackMutations(documentId, id, result.current.selectedTrackId!)
    ).toEqual([markerB]);
  });

  it('keeps selected-clone markers distinct while stacked mode retains both alignment rows', () => {
    const id = session();
    const { result } = renderHook(() => useAlignmentDerivedState(documentId));
    act(() =>
      useVerificationStore.getState().setSessionViewPreferences(documentId, id, {
        selectedTrackId: 'clone-b',
        viewMode: 'stacked',
      })
    );
    expect(result.current.viewMode).toBe('stacked');
    expect(result.current.trackIdsKey).toBe('clone-a,clone-b,matching-clone');
    expect(
      result.current.getTrackMutations(documentId, id, result.current.selectedTrackId!)
    ).toEqual([markerB]);
    expect(result.current.getTrackMutations(documentId, id, 'clone-a')).toEqual([markerA]);
  });

  it('clears markers on a matching clone and restores them on return', () => {
    const id = session();
    const { result } = renderHook(() => useAlignmentDerivedState(documentId));
    act(() =>
      useVerificationStore
        .getState()
        .setSessionViewPreferences(documentId, id, { selectedTrackId: 'matching-clone' })
    );
    expect(result.current.alignedQuery).toBe('ATGC');
    expect(
      result.current.getTrackMutations(documentId, id, result.current.selectedTrackId!)
    ).toEqual([]);
    act(() =>
      useVerificationStore
        .getState()
        .setSessionViewPreferences(documentId, id, { selectedTrackId: 'clone-a' })
    );
    expect(
      result.current.getTrackMutations(documentId, id, result.current.selectedTrackId!)
    ).toEqual([markerA]);
  });

  it('preserves concrete mutation output when legacy sessions have no computed cache', () => {
    const id = session();
    const store = useVerificationStore.getState();
    expect(store.getTrackMutations(documentId, id, 'clone-a')).toEqual([markerA]);
    store.invalidateMutationCache(documentId, id);
    expect(
      useVerificationStore.getState().sessionMutations[`${documentId}::${id}`]
    ).toBeUndefined();
    expect(store.getTrackMutations(documentId, id, 'clone-a')).toEqual([markerA]);
  });

  it('uses real gap columns for insertion and deletion markers', () => {
    const id = session();
    const gapped = track('gapped-clone', null);
    gapped.alignment = { ...gapped.alignment, alignedReference: 'AT--GC', alignedQuery: 'ATTT-C' };
    gapped.mutations = [
      {
        id: 'insert',
        position: 3,
        type: 'insertion',
        referenceBase: '',
        alternateBase: 'TT',
        length: 2,
      },
      {
        id: 'delete',
        position: 3,
        type: 'deletion',
        referenceBase: 'G',
        alternateBase: '',
        length: 1,
      },
    ];
    const store = useVerificationStore.getState();
    store.addTrackToSession(documentId, id, gapped);
    expect(store.getTrackMutations(documentId, id, gapped.id)).toEqual([
      { column: 2, endColumn: 3, type: 'insertion', refBase: '-', queryBase: 'TT', refPosition: 3 },
      {
        column: 4,
        endColumn: undefined,
        type: 'deletion',
        refBase: 'G',
        queryBase: '-',
        refPosition: 3,
      },
    ]);
  });

  it('does not borrow another clone’s markers when a selected track is missing', () => {
    const id = session();
    const { result } = renderHook(() => useAlignmentDerivedState(documentId));
    act(() =>
      useVerificationStore
        .getState()
        .setSessionViewPreferences(documentId, id, { selectedTrackId: 'removed-clone' })
    );
    expect(result.current.selectedTrackId).toBe('removed-clone');
    expect(result.current.alignedQuery).toBeUndefined();
    expect(result.current.getTrackMutations(documentId, id, 'removed-clone')).toEqual([]);
    expect(result.current.getTrackMutations(documentId, id, 'clone-a')).toEqual([markerA]);
  });
});
