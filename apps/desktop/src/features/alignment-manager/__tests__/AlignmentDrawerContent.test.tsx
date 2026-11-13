import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AlignmentDrawerContent } from '../panel/AlignmentDrawerContent';
import { resetAlignmentAutoLoadRegistryForTests } from '../panel/alignment-auto-load-registry';
import type {
  ReferenceVerificationState,
  VerificationSession,
  AggregatedMutation,
  SessionViewPreferences,
} from '../types';

const mockSetActiveSession = vi.fn();
const mockSetSessionViewPreferences = vi.fn();
const mockCreateSession = vi.fn(() => 'new-session-id');
const mockRunSessionAlignments = vi.fn(() => Promise.resolve());
const mockEnrichSessionMutations = vi.fn(() => Promise.resolve());
const mockLoadSidecar = vi.fn(() => Promise.resolve(false));
const mockRegisterReferenceSource = vi.fn();

let mockVerificationState: ReferenceVerificationState | undefined;
let mockActiveSession: VerificationSession | undefined;
let mockViewPreferences: SessionViewPreferences | undefined;
let mockAggregatedMutations: AggregatedMutation[] = [];
let mockSessionViewPreferences: Record<string, SessionViewPreferences> = {};

vi.mock('../store', () => ({
  useVerificationStore: Object.assign(
    (selector: (state: unknown) => unknown) => {
      const state = {
        getVerificationState: () => mockVerificationState,
        getActiveSession: () => mockActiveSession,
        setActiveSession: mockSetActiveSession,
        getSessionViewPreferences: () => mockViewPreferences,
        setSessionViewPreferences: mockSetSessionViewPreferences,
        getAggregatedMutations: () => mockAggregatedMutations,
        sessionViewPreferences: mockSessionViewPreferences,
        verificationState: {},
        alignmentPanelOpen: new Set<string>(),
        staleReferences: {},
        referenceFileChecksums: {},
        staleSessionIds: {},
        pendingTrackIds: {},
        registerReferenceSource: mockRegisterReferenceSource,
        createSession: mockCreateSession,
        runSessionAlignments: mockRunSessionAlignments,
        removeSession: vi.fn(),
        removeTrack: vi.fn(),
        navigateToPosition: vi.fn(),
        clearFocusedPosition: vi.fn(),
        getTrackMutations: vi.fn(() => []),
        enrichSessionMutations: mockEnrichSessionMutations,
        loadSidecar: mockLoadSidecar,
        setAlignmentPanelOpen: vi.fn(),
        renameSession: vi.fn(),
        toggleAlignmentVisibility: vi.fn(),
        toggleTrackVisibility: vi.fn(),
        overrideTrackStatus: vi.fn(),
        archiveSession: vi.fn(),
        unarchiveSession: vi.fn(),
        renameTrack: vi.fn(),
        checkStaleness: vi.fn(() => Promise.resolve()),
        toggleMutationChecked: vi.fn(),
        applyCheckedMutations: vi.fn(() => Promise.resolve()),
        clearCheckedMutations: vi.fn(),
      };
      return selector(state);
    },
    {
      getState: () => ({
        getVerificationState: () => mockVerificationState,
        renameTrack: vi.fn(),
        loadSidecar: mockLoadSidecar,
        pendingTrackIds: {},
        staleSessionIds: {},
      }),
    }
  ),
}));

vi.mock('../hooks/useReferenceWatcher', () => ({
  useReferenceWatcher: vi.fn(),
}));

beforeEach(() => {
  resetAlignmentAutoLoadRegistryForTests();
  vi.clearAllMocks();
  mockEnrichSessionMutations.mockResolvedValue();
  mockLoadSidecar.mockResolvedValue(false);
  mockVerificationState = undefined;
  mockActiveSession = undefined;
  mockViewPreferences = undefined;
  mockAggregatedMutations = [];
  mockSessionViewPreferences = {};
});

function createMockSession(overrides: Partial<VerificationSession> = {}): VerificationSession {
  return {
    id: 'session-1',
    name: 'Test Session',
    createdAt: new Date().toISOString(),
    mode: 'one-per-clone',
    tracks: [],
    ...overrides,
  };
}

function createSessionNeedingEnrichment(id: string): VerificationSession {
  return createMockSession({
    id,
    tracks: [
      {
        id: `track-${id}`,
        queryPath: `/path/to/${id}.ab1`,
        label: id,
        alignment: {
          alignedReference: 'ATGC',
          alignedQuery: 'ACGC',
          identity: 75,
          coverageStart: 1,
          coverageEnd: 4,
          algorithm: 'MAFFT',
        },
        mutations: [
          {
            id: `mutation-${id}`,
            position: 2,
            type: 'substitution',
            referenceBase: 'T',
            alternateBase: 'C',
          },
        ],
        status: 'variants',
        alignedAt: new Date().toISOString(),
      },
    ],
  });
}

describe('AlignmentDrawerContent', () => {
  const documentId = 'sequence-reference';
  const referencePath = '/path/to/reference.gb';
  const referenceName = 'reference.gb';

  describe('empty state', () => {
    it('shows empty state when no sessions exist', () => {
      mockVerificationState = undefined;

      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );

      expect(screen.getByText(/no alignments/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /new alignment/i })).toBeInTheDocument();
    });

    it('displays the reference name in the header', () => {
      mockVerificationState = undefined;

      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );

      expect(screen.getByText(referenceName)).toBeInTheDocument();
    });

    it('calls the add-files handler from the + New button', () => {
      mockVerificationState = undefined;
      const onAddFiles = vi.fn();

      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
          onAddFiles={onAddFiles}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /new alignment/i }));

      expect(onAddFiles).toHaveBeenCalledTimes(1);
    });

    it('describes the production picker path without advertising an unwired drop target', () => {
      const onAddFiles = vi.fn();
      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
          onAddFiles={onAddFiles}
        />
      );

      expect(screen.queryByText(/drop sequencing files/i)).not.toBeInTheDocument();
      expect(screen.getByText('Click "+ New" to select sequencing files.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /new alignment/i }));
      expect(onAddFiles).toHaveBeenCalledTimes(1);
    });

    it('retains the advertised drop workflow when its owner supplies it', () => {
      const onDroppedFiles = vi.fn();
      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
          onAddFiles={vi.fn()}
          onDroppedFiles={onDroppedFiles}
        />
      );

      expect(screen.getByText(/drop sequencing files here or click/i)).toBeInTheDocument();
      const file = new File(['trace'], 'clone.ab1');
      fireEvent.drop(screen.getByTestId('alignment-drop-target'), {
        dataTransfer: { files: [file], types: ['Files'] },
      });
      expect(onDroppedFiles).toHaveBeenCalledExactlyOnceWith([file]);
    });

    it('updates the hint when drop-only capability is withdrawn', () => {
      const onDroppedFiles = vi.fn();
      const view = render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
          onDroppedFiles={onDroppedFiles}
        />
      );
      expect(screen.getByText('Drop sequencing files here to start.')).toBeInTheDocument();

      view.rerender(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );
      expect(screen.queryByText(/drop sequencing files/i)).not.toBeInTheDocument();
      expect(screen.getByText('No sequencing files have been added.')).toBeInTheDocument();
      fireEvent.drop(screen.getByTestId('alignment-drop-target'), {
        dataTransfer: { files: [new File(['trace'], 'clone.ab1')], types: ['Files'] },
      });
      expect(onDroppedFiles).not.toHaveBeenCalled();
    });

    it('does not repeat an absent sidecar read while the drawer stays mounted', async () => {
      mockVerificationState = undefined;
      mockLoadSidecar.mockResolvedValue(false);

      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockLoadSidecar).toHaveBeenCalledTimes(1);
    });
  });

  describe('with sessions', () => {
    beforeEach(() => {
      const session = createMockSession({
        id: 'session-1',
        name: 'Cloning Run 1',
        mode: 'one-per-clone',
        tracks: [
          {
            id: 'track-1',
            queryPath: '/path/to/clone1.ab1',
            label: 'clone1',
            alignment: {
              alignedReference: 'ATGC',
              alignedQuery: 'ATGC',
              identity: 99.8,
              coverageStart: 1,
              coverageEnd: 800,
              algorithm: 'MAFFT',
            },
            mutations: [],
            status: 'pass',
            alignedAt: new Date().toISOString(),
          },
          {
            id: 'track-2',
            queryPath: '/path/to/clone2.ab1',
            label: 'clone2',
            alignment: {
              alignedReference: 'ATGC',
              alignedQuery: 'ATGC',
              identity: 97.1,
              coverageStart: 1,
              coverageEnd: 780,
              algorithm: 'MAFFT',
            },
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
            status: 'fail',
            alignedAt: new Date().toISOString(),
          },
        ],
      });

      mockVerificationState = {
        documentId,
        sessions: [session],
        activeSessionId: 'session-1',
      };
      mockActiveSession = session;
      mockViewPreferences = { viewMode: 'stacked', selectedTrackId: null };
      mockSessionViewPreferences = {
        [`${documentId}::session-1`]: { viewMode: 'stacked', selectedTrackId: null },
      };
      mockAggregatedMutations = [
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
          trackIds: ['track-2'],
          hasConflict: true,
        },
      ];
    });

    it('gives mutation review space while keeping alignment and clone controls reachable', () => {
      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
          followProteinContext
        />
      );
      const toggle = screen.getByRole('button', { name: 'Alignment and clone controls' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveTextContent('Cloning Run 1');
      expect(toggle).toHaveTextContent('clone1');
      expect(screen.queryByRole('listbox', { name: 'Clones' })).not.toBeInTheDocument();
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('listbox', { name: 'Clones' })).toBeVisible();
      fireEvent.click(toggle);
      expect(screen.queryByRole('listbox', { name: 'Clones' })).not.toBeInTheDocument();
    });

    it('displays session name', () => {
      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );

      const matches = screen.getAllByText('Cloning Run 1');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    it('displays session mode label', () => {
      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );

      expect(screen.getByText(/1\/clone/)).toBeInTheDocument();
    });

    it('does not duplicate in-flight enrichment when the active session switches A to B to A', async () => {
      const pendingResolvers: Array<() => void> = [];
      mockEnrichSessionMutations.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            pendingResolvers.push(resolve);
          })
      );
      const needsEnrichment = (id: string): VerificationSession =>
        createMockSession({
          id,
          tracks: [
            {
              id: `track-${id}`,
              queryPath: `/path/to/${id}.ab1`,
              label: id,
              alignment: {
                alignedReference: 'ATGC',
                alignedQuery: 'ACGC',
                identity: 75,
                coverageStart: 1,
                coverageEnd: 4,
                algorithm: 'MAFFT',
              },
              mutations: [
                {
                  id: `mutation-${id}`,
                  position: 2,
                  type: 'substitution',
                  referenceBase: 'T',
                  alternateBase: 'C',
                },
              ],
              status: 'variants',
              alignedAt: new Date().toISOString(),
            },
          ],
        });
      const sessionA = needsEnrichment('session-a');
      const sessionB = needsEnrichment('session-b');
      mockActiveSession = sessionA;

      const { rerender } = render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );
      await act(async () => Promise.resolve());

      mockActiveSession = sessionB;
      rerender(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );
      await act(async () => Promise.resolve());

      mockActiveSession = sessionA;
      rerender(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );
      await act(async () => Promise.resolve());

      expect(mockEnrichSessionMutations).toHaveBeenCalledTimes(2);
      expect(mockEnrichSessionMutations).toHaveBeenNthCalledWith(1, documentId, 'session-a');
      expect(mockEnrichSessionMutations).toHaveBeenNthCalledWith(2, documentId, 'session-b');

      await act(async () => {
        for (const resolve of pendingResolvers) resolve();
        await Promise.resolve();
      });
    });

    it('does not repeat a no-op enrichment while the drawer stays mounted', async () => {
      mockActiveSession = createSessionNeedingEnrichment('session-no-annotations');
      mockEnrichSessionMutations.mockResolvedValue();

      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockEnrichSessionMutations).toHaveBeenCalledTimes(1);
    });

    it('does not duplicate in-flight enrichment across drawer unmount and remount', async () => {
      let resolveEnrichment: (() => void) | undefined;
      mockEnrichSessionMutations.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveEnrichment = resolve;
          })
      );
      mockActiveSession = createMockSession({
        id: 'session-pending',
        tracks: [
          {
            id: 'track-pending',
            queryPath: '/path/to/pending.ab1',
            label: 'pending',
            alignment: {
              alignedReference: 'ATGC',
              alignedQuery: 'ACGC',
              identity: 75,
              coverageStart: 1,
              coverageEnd: 4,
              algorithm: 'MAFFT',
            },
            mutations: [
              {
                id: 'mutation-pending',
                position: 2,
                type: 'substitution',
                referenceBase: 'T',
                alternateBase: 'C',
              },
            ],
            status: 'variants',
            alignedAt: new Date().toISOString(),
          },
        ],
      });

      const first = render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );
      await act(async () => Promise.resolve());
      first.unmount();
      const second = render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );
      await act(async () => Promise.resolve());

      expect(mockEnrichSessionMutations).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolveEnrichment?.();
        await Promise.resolve();
        await Promise.resolve();
      });

      second.unmount();
      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );
      await act(async () => Promise.resolve());
      expect(mockEnrichSessionMutations).toHaveBeenCalledTimes(2);
    });

    it('does not duplicate an in-flight sidecar read across drawer unmount and remount', async () => {
      let resolveSidecar: ((loaded: boolean) => void) | undefined;
      mockVerificationState = undefined;
      mockActiveSession = undefined;
      mockLoadSidecar.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveSidecar = resolve;
          })
      );

      const first = render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );
      await act(async () => Promise.resolve());
      first.unmount();
      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );
      await act(async () => Promise.resolve());

      expect(mockLoadSidecar).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolveSidecar?.(false);
        await Promise.resolve();
      });
    });

    it('displays tracks with their identity', () => {
      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );

      expect(screen.getByText('clone1')).toBeInTheDocument();
      expect(screen.getByText('clone2')).toBeInTheDocument();

      expect(screen.getByText('99.80%')).toBeInTheDocument();
      expect(screen.getByText('97.10%')).toBeInTheDocument();
    });

    it('highlights active session with accent styling', () => {
      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );

      const sessionNames = screen.getAllByText('Cloning Run 1');
      const hasActiveRow = sessionNames.some((el) => el.closest('[class*="bg-accent"]') !== null);
      expect(hasActiveRow).toBe(true);
    });

    it('shows perfect match message when selected track has no mutations', () => {
      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );

      expect(screen.getByText('clone1')).toBeInTheDocument();
      expect(screen.getByText('clone2')).toBeInTheDocument();

      expect(screen.getByText(/no mutations detected/i)).toBeInTheDocument();
    });

    it('updates store when selecting a different clone', () => {
      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );

      const clone2Option = screen.getByText('clone2').closest('[role="option"]');
      expect(clone2Option).toBeTruthy();
      fireEvent.click(clone2Option!);

      expect(mockSetSessionViewPreferences).toHaveBeenCalledWith(documentId, 'session-1', {
        selectedTrackId: 'track-2',
      });
    });
  });

  describe('multiple sessions', () => {
    beforeEach(() => {
      const session1 = createMockSession({
        id: 'session-1',
        name: 'Session 1',
        mode: 'one-per-clone',
      });

      const session2 = createMockSession({
        id: 'session-2',
        name: 'Session 2',
        mode: 'multi-per-clone',
      });

      mockVerificationState = {
        documentId,
        sessions: [session1, session2],
        activeSessionId: 'session-2',
      };
      mockActiveSession = session2;
      mockViewPreferences = { viewMode: 'single', selectedTrackId: null };
      mockSessionViewPreferences = {
        [`${documentId}::session-1`]: { viewMode: 'stacked', selectedTrackId: null },
        [`${documentId}::session-2`]: { viewMode: 'single', selectedTrackId: null },
      };
    });

    it('displays all sessions', () => {
      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );

      expect(screen.getByText('Session 1')).toBeInTheDocument();

      expect(screen.getAllByText('Session 2').length).toBeGreaterThanOrEqual(1);
    });

    it('can switch active session', () => {
      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );

      const session1Text = screen.getByText('Session 1');
      fireEvent.click(session1Text);

      expect(mockSetActiveSession).toHaveBeenCalledWith(documentId, 'session-1');
    });
  });

  describe('+ New full add-flow', () => {
    it('renders pending files in the inline form when the picker returns selections', () => {
      mockVerificationState = undefined;
      const pendingFiles = [
        { path: '/runs/clone-1.ab1', name: 'clone-1.ab1' },
        { path: '/runs/clone-2.ab1', name: 'clone-2.ab1' },
      ];

      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
          pendingFiles={pendingFiles}
          onAddFiles={vi.fn()}
          onClearPendingFiles={vi.fn()}
        />
      );

      expect(screen.getByText(/New Alignment Session/i)).toBeInTheDocument();

      expect(screen.getByText(/Files to align \(2\)/i)).toBeInTheDocument();

      expect(screen.getByText(/clone-1\.ab1/)).toBeInTheDocument();
      expect(screen.getByText(/clone-2\.ab1/)).toBeInTheDocument();

      expect(screen.queryByRole('button', { name: /^new alignment$/i })).not.toBeInTheDocument();
    });

    it('submits the inline form and creates an alignment session from the pending files', async () => {
      mockVerificationState = undefined;
      const onClearPendingFiles = vi.fn();
      const pendingFiles = [
        { path: '/runs/clone-1.ab1', name: 'clone-1.ab1' },
        { path: '/runs/clone-2.ab1', name: 'clone-2.ab1' },
      ];

      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
          pendingFiles={pendingFiles}
          onAddFiles={vi.fn()}
          onClearPendingFiles={onClearPendingFiles}
        />
      );

      const nameInput = screen.getByPlaceholderText(/\d{4}-\d{2}-\d{2}.*reference\.gb/i);
      fireEvent.change(nameInput, { target: { value: 'Cloning Run 1' } });

      const submitButton = screen.getByRole('button', { name: /create & align/i });
      await act(async () => {
        fireEvent.click(submitButton);

        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockCreateSession).toHaveBeenCalledWith(documentId, {
        name: 'Cloning Run 1',
        mode: 'one-per-clone',
        queryPaths: ['/runs/clone-1.ab1', '/runs/clone-2.ab1'],
      });

      expect(mockRunSessionAlignments).toHaveBeenCalledWith(documentId, 'new-session-id', [
        '/runs/clone-1.ab1',
        '/runs/clone-2.ab1',
      ]);

      expect(onClearPendingFiles).toHaveBeenCalledTimes(1);
    });

    it('forwards dropped files to the parent instead of opening the picker', () => {
      mockVerificationState = undefined;
      const onDroppedFiles = vi.fn();
      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
          onAddFiles={vi.fn()}
          onDroppedFiles={onDroppedFiles}
        />
      );

      const target = screen.getByTestId('alignment-drop-target');
      const file = new File(['ATGC'], 'clone.fasta', { type: 'text/plain' });
      fireEvent.drop(target, { dataTransfer: { files: [file], types: ['Files'] } });

      expect(onDroppedFiles).toHaveBeenCalledTimes(1);
      expect(onDroppedFiles.mock.calls[0][0]).toHaveLength(1);
      expect(onDroppedFiles.mock.calls[0][0][0].name).toBe('clone.fasta');
    });

    it('does not create a session when no files are pending (cancelled picker)', () => {
      mockVerificationState = undefined;

      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
          pendingFiles={[]}
          onAddFiles={vi.fn()}
          onClearPendingFiles={vi.fn()}
        />
      );

      expect(screen.queryByText(/New Alignment Session/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /new alignment/i })).toBeInTheDocument();
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(mockRunSessionAlignments).not.toHaveBeenCalled();
    });
  });

  describe(' attached clone rows', () => {
    it('renders clone-1 and clone-1-2 as alignment clone rows', () => {
      const session = createMockSession({
        id: 'session-1',
        name: ' attached clones',
        mode: 'one-per-clone',
        tracks: [
          {
            id: 'track-1',
            queryPath: '/pkg/contents/clone-1.fasta',
            label: 'clone-1',
            alignment: {
              alignedReference: 'ACGT',
              alignedQuery: 'ACGT',
              identity: 100,
              coverageStart: 1,
              coverageEnd: 4,
              algorithm: 'MAFFT',
            },
            mutations: [],
            status: 'pass',
            alignedAt: new Date().toISOString(),
          },
          {
            id: 'track-2',
            queryPath: '/pkg/contents/clone-1-2.fasta',
            label: 'clone-1-2',
            alignment: {
              alignedReference: 'ACGT',
              alignedQuery: 'ACCT',
              identity: 99.4,
              coverageStart: 1,
              coverageEnd: 4,
              algorithm: 'MAFFT',
            },
            mutations: [],
            status: 'variants',
            alignedAt: new Date().toISOString(),
          },
        ],
      });
      mockVerificationState = {
        documentId,
        sessions: [session],
        activeSessionId: 'session-1',
      };
      mockActiveSession = session;
      mockViewPreferences = { viewMode: 'single', selectedTrackId: 'track-1' };

      render(
        <AlignmentDrawerContent
          documentId={documentId}
          sourcePath={referencePath}
          referenceName={referenceName}
        />
      );

      const rows = screen.getAllByTestId('alignment-clone-row');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveAttribute('data-track-label', 'clone-1');
      expect(rows[1]).toHaveAttribute('data-track-label', 'clone-1-2');
      expect(screen.queryByText(/no alignments/i)).not.toBeInTheDocument();
    });
  });
});
