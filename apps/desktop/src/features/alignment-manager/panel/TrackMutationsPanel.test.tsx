import { userMessage } from '@waypoint/user-messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { MutationMarker } from '@waypoint/workspace-editor';
import { TrackMutationsPanel } from './TrackMutationsPanel';
import type { VerificationTrack } from '../types';
import { useVerificationStore } from '../store/store';

beforeEach(() => useVerificationStore.setState({ focusedPosition: null }));

beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
);
afterEach(() => vi.unstubAllGlobals());

const track: VerificationTrack = {
  id: 'clone-7',
  queryPath: '/fixture/clone-7.fa',
  label: 'Clone 7',
  status: 'variants',
  mutations: [
    {
      id: 'mut-5',
      position: 5,
      type: 'substitution',
      referenceBase: 'A',
      alternateBase: 'G',
      length: 1,
    },
  ],
};
const markers = [
  { column: 9, type: 'substitution', refBase: 'A', queryBase: 'G', refPosition: 5 },
] satisfies MutationMarker[];
const props = {
  track,
  mutationMarkers: markers,
  selectedMutationIndex: null,
  onSelectMutation: vi.fn(),
  documentId: 'fixture:ref',
};

describe('mutation DNA navigation', () => {
  it('keeps every column of a multi-base structural insertion selected at both endpoints', () => {
    const insertionTrack: VerificationTrack = {
      ...track,
      mutations: [],
      alignment: {
        alignedReference: 'A--CGT',
        alignedQuery: 'ATTCGT',
        identity: 100,
        coverageStart: 1,
        coverageEnd: 4,
        algorithm: 'MAFFT',
      },
      structuralAnalysis: {
        structuralRegions: [
          {
            id: 'inserted',
            type: 'insertion',
            columnStart: 1,
            columnEnd: 3,
            refStart: null,
            refEnd: null,
            lengthColumns: 2,
            confidence: 1,
            severity: 'medium',
            forwardIdentity: 0,
            mutationIndices: [],
          },
        ],
        pointMutationIndices: [],
        overallAssessment: { result: 'REVIEW', reason: 'insertion' },
        warnings: [],
      },
    };
    render(<TrackMutationsPanel {...props} track={insertionTrack} mutationMarkers={[]} />);
    fireEvent.click(screen.getByRole('option'));
    expect(useVerificationStore.getState().focusedPosition).toMatchObject({
      position: 2,
      highlightRange: { start: 1, end: 2 },
    });
    fireEvent.click(screen.getByTitle('Go to end of 2bp insertion'));
    expect(useVerificationStore.getState().focusedPosition).toMatchObject({
      position: 3,
      highlightRange: { start: 1, end: 2 },
    });
  });

  it('gives repeated clicks different request identities even within the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(12345);
    try {
      render(<TrackMutationsPanel {...props} />);
      fireEvent.click(screen.getByRole('option'));
      const first = useVerificationStore.getState().focusedPosition!.timestamp;
      fireEvent.click(screen.getByRole('option'));
      expect(useVerificationStore.getState().focusedPosition!.timestamp).toBeGreaterThan(first);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('navigates on a single row click with protein inspection closed', () => {
    render(<TrackMutationsPanel {...props} />);
    fireEvent.click(screen.getByRole('option'));
    expect(useVerificationStore.getState().focusedPosition).toMatchObject({
      documentId: props.documentId,
      trackId: track.id,
      position: 10,
      highlightRange: { start: 9, end: 9 },
    });
  });
});

describe('mutation protein-context action', () => {
  it('does not hide recorded changes behind an empty rendered mutation list', () => {
    render(<TrackMutationsPanel {...props} mutationMarkers={[]} />);
    expect(screen.queryByText('No mutations detected')).toBeNull();
    expect(
      screen.getByText('Mutation details are unavailable. Re-run this alignment.')
    ).toBeVisible();
  });
  it('does not call unobserved sequence a perfect match', () => {
    render(
      <TrackMutationsPanel
        {...props}
        track={{
          ...track,
          status: 'pass',
          mutations: [],
          alignment: {
            alignedReference: 'ACGT',
            alignedQuery: '--GT',
            identity: 100,
            coverageStart: 3,
            coverageEnd: 4,
            algorithm: 'MAFFT',
          },
        }}
        mutationMarkers={[]}
      />
    );
    expect(screen.queryByText('✓ Perfect match')).toBeNull();
    expect(screen.getByTestId('alignment-evidence-warning')).toHaveTextContent('2 of 4');
  });

  it('follows row clicks in an open protein pane without another action click', () => {
    const inspect = vi.fn();
    render(
      <TrackMutationsPanel {...props} onInspectProteinContext={inspect} followProteinContext />
    );
    fireEvent.click(screen.getByRole('option'));
    expect(inspect).toHaveBeenCalledWith(track.mutations[0], track);
    expect(useVerificationStore.getState().focusedPosition).toMatchObject({
      documentId: props.documentId,
      position: 10,
      highlightRange: { start: 9, end: 9 },
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the DNA and protein on the same mutation when its position is clicked', () => {
    const inspect = vi.fn();
    render(
      <TrackMutationsPanel {...props} onInspectProteinContext={inspect} followProteinContext />
    );
    fireEvent.click(screen.getByRole('button', { name: '5', exact: true }));
    expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true');
    expect(inspect).toHaveBeenCalledWith(track.mutations[0], track);
    expect(useVerificationStore.getState().focusedPosition).toMatchObject({
      position: 10,
      highlightRange: { start: 9, end: 9 },
    });
  });

  it('clears the previous clone context when the selected clone changes', () => {
    const clear = vi.fn();
    const { rerender } = render(
      <TrackMutationsPanel {...props} followProteinContext onClearProteinContext={clear} />
    );
    clear.mockClear();
    rerender(
      <TrackMutationsPanel
        {...props}
        track={{ ...track, id: 'clone-8', label: 'Clone 8' }}
        followProteinContext
        onClearProteinContext={clear}
      />
    );
    expect(clear).toHaveBeenCalledWith('Select a mutation from Clone 8.');
  });

  it('follows keyboard selection and clears the pane on Escape', () => {
    const inspect = vi.fn();
    const clear = vi.fn();
    render(
      <TrackMutationsPanel
        {...props}
        onInspectProteinContext={inspect}
        onClearProteinContext={clear}
        followProteinContext
      />
    );
    fireEvent.keyDown(screen.getByRole('option'), { key: 'Home' });
    expect(inspect).toHaveBeenCalledWith(track.mutations[0], track);
    expect(useVerificationStore.getState().focusedPosition?.position).toBe(10);
    fireEvent.keyDown(screen.getByRole('option'), { key: 'Escape' });
    expect(clear).toHaveBeenCalledWith('Select a mutation from Clone 7.');
  });

  it('clears an open pane when the alignment becomes stale without following its rows', () => {
    const inspect = vi.fn();
    const clear = vi.fn();
    render(
      <TrackMutationsPanel
        {...props}
        onInspectProteinContext={inspect}
        onClearProteinContext={clear}
        followProteinContext
        proteinContextBlockedReason={userMessage('alignment.staleProteinMapping')}
      />
    );
    fireEvent.click(screen.getByRole('option'));
    expect(inspect).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledWith(userMessage('alignment.staleProteinMapping'));
  });

  it('passes biological coordinates rather than the gapped display column', () => {
    const inspect = vi.fn();
    render(<TrackMutationsPanel {...props} onInspectProteinContext={inspect} />);
    expect(screen.queryByRole('button', { name: 'View protein context' })).toBeNull();
    fireEvent.click(screen.getByRole('option'));
    fireEvent.click(screen.getByRole('button', { name: 'View protein context' }));
    expect(inspect).toHaveBeenCalledWith(track.mutations[0], track);
    expect(inspect.mock.calls[0][0].position).toBe(5);
    expect(useVerificationStore.getState().focusedPosition).toMatchObject({
      position: 10,
      highlightRange: { start: 9, end: 9 },
    });
  });

  it('makes stale-alignment refusal visible and prevents the handoff', () => {
    const inspect = vi.fn();
    render(
      <TrackMutationsPanel
        {...props}
        onInspectProteinContext={inspect}
        proteinContextBlockedReason={userMessage('alignment.staleProteinMapping')}
      />
    );
    fireEvent.click(screen.getByRole('option'));
    expect(screen.getByRole('button', { name: 'View protein context' })).toBeDisabled();
    expect(screen.getByText(userMessage('alignment.staleProteinMapping'))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'View protein context' }));
    expect(inspect).not.toHaveBeenCalled();
  });

  it('shows mapping failures in the mutation panel', () => {
    render(
      <TrackMutationsPanel
        {...props}
        onInspectProteinContext={() => userMessage('alignment.multipleCodingFeatures')}
      />
    );
    fireEvent.click(screen.getByRole('option'));
    fireEvent.click(screen.getByRole('button', { name: 'View protein context' }));
    expect(screen.getByRole('alert')).toHaveTextContent('more than one coding feature');
  });
});
