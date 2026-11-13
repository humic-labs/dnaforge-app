import { userMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PrimersDrawerContent } from './PrimersDrawerContent';
import type { BoundPrimer, CreatePrimerInput } from '../types';

const analyticsMocks = vi.hoisted(() => ({
  trackToolActionCompleted: vi.fn(),
  trackToolActionStarted: vi.fn(),
  trackToolError: vi.fn(),
  trackToolOpened: vi.fn(),
  subscribeAnalyticsCaptureReady: vi.fn(() => () => {}),
}));
const dialogMocks = vi.hoisted(() => ({
  save: vi.fn(async () => '/workspace/project/primers/Primer_F1.primer.json'),
}));
const bindingMocks = vi.hoisted(() => ({
  readArtifact: vi.fn(),
  updateBinding: vi.fn(),
  updateArtifactContent: vi.fn(),
  notifyBindingsChanged: vi.fn(),
}));

vi.mock('../primer-services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../primer-services')>();
  return {
    ...actual,
    primerServices: {
      ...actual.primerServices,
      persistence: { ...actual.primerServices.persistence, ...bindingMocks },
    },
  };
});

vi.mock('../../../lib/analytics', () => analyticsMocks);
vi.mock('../../../platform', () => ({
  platform: () => ({ dialog: dialogMocks, fs: { readDir: vi.fn(async () => []) } }),
}));

function createTestBoundPrimer(overrides?: Partial<BoundPrimer>): BoundPrimer {
  const id = `test-${Math.random().toString(36).slice(2)}`;
  const bindId = `bind-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    catalogNumber: 'P001',
    name: 'Test_F1',
    sequence: 'ATCGATCGATCGATCGATCG',
    length: 20,
    tm: 58.4,
    gcPercent: 50.0,
    origin: 'manual',
    originDetails: null,
    status: 'designed',
    vendor: null,
    orderDate: null,
    application: null,
    scale: null,
    purification: null,
    modifications: null,
    stockLocation: null,
    concentration: null,
    notes: null,
    workspaceId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    binding: {
      id: bindId,
      primerId: id,
      sequenceId: 42,
      bindingStart: 100,
      bindingEnd: 120,
      strand: 1,
      source: 'manual',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    ...overrides,
  };
}

const defaultProps = {
  primers: [] as BoundPrimer[],
  isLoading: false,
  workspaceRoot: '/workspace/project',
  onPrimerCreate: vi.fn().mockResolvedValue(undefined),
  onDetach: vi.fn(),
};

describe('PrimersDrawerContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders empty state when no primers', () => {
    render(<PrimersDrawerContent {...defaultProps} />);
    expect(screen.getByTestId('primers-empty-state')).toBeDefined();
    expect(screen.getByText(/no primers attached yet/i)).toBeDefined();
  });

  it('edits only the selected binding and preserves an existing creation session', async () => {
    const primer = createTestBoundPrimer();
    primer.originDetails = { authority: 'primer_artifact', artifactPath: 'primer.primer.json' };
    primer.binding = {
      ...primer.binding,
      id: 'second-site',
      bindingStart: 204,
      bindingEnd: 224,
      strand: -1,
    };
    const artifact = {
      artifactRevision: 7,
      bindings: [
        {
          id: primer.binding.id,
          target: { documentId: 'template' },
          coordinates: { start: 204, end: 224, strand: -1 },
        },
      ],
    };
    bindingMocks.readArtifact.mockResolvedValue({ artifact, resolvedBindings: [] });
    bindingMocks.updateBinding.mockResolvedValue({
      artifact: { ...artifact, artifactRevision: 8 },
    });
    const onClearBindingEdit = vi.fn();
    const props = {
      ...defaultProps,
      primers: [primer],
      targetDocumentId: 'template',
      targetFilePath: '/workspace/project/template.gb',
      sequenceLength: 600,
      circular: true,
      pendingCreation: {
        sequence: 'ATCGATCGATCGATCGATCG',
        direction: 'forward' as const,
        bindingStart: 100,
        bindingEnd: 120,
      },
      onClearBindingEdit,
    };
    const { rerender } = render(<PrimersDrawerContent {...props} />);
    fireEvent.change(screen.getByTestId('primer-name-input'), {
      target: { value: 'Keep this creation draft' },
    });

    rerender(<PrimersDrawerContent {...props} pendingBindingEdit={primer} />);
    const editor = await screen.findByTestId('primer-binding-editor');
    await waitFor(() =>
      expect(within(editor).getByRole('button', { name: 'Save binding site' })).toBeEnabled()
    );
    expect(screen.getByTestId('primer-creation-form')).not.toBeVisible();
    expect(within(editor).queryByRole('textbox', { name: 'Primer sequence' })).toBeNull();
    fireEvent.click(within(editor).getByRole('button', { name: 'Increase binding position' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save binding site' }));

    await waitFor(() =>
      expect(bindingMocks.updateBinding).toHaveBeenCalledWith(
        expect.objectContaining({
          primer,
          bindingId: 'second-site',
          expectedArtifactRevision: 7,
          bindingStart: 205,
          bindingEnd: 225,
          bindingStrand: -1,
          targetDocumentId: 'template',
          bindingSequenceId: 42,
        })
      )
    );
    expect(bindingMocks.updateArtifactContent).not.toHaveBeenCalled();
    expect(bindingMocks.notifyBindingsChanged).toHaveBeenCalledWith(42);
    await waitFor(() => expect(onClearBindingEdit).toHaveBeenCalled());
    rerender(<PrimersDrawerContent {...props} pendingBindingEdit={null} />);
    fireEvent.click(screen.getByTestId('primers-tab-create'));
    expect(screen.getByTestId('primer-name-input')).toHaveValue('Keep this creation draft');
    expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute(
      'data-oligo-notation',
      'ATCGATCGATCGATCGATCG'
    );
    expect(defaultProps.onPrimerCreate).not.toHaveBeenCalled();
  });

  it('renders primer list when primers exist', () => {
    const primers = [
      createTestBoundPrimer({ name: 'lacZ_F1' }),
      createTestBoundPrimer({ name: 'lacZ_R1' }),
    ];
    render(<PrimersDrawerContent {...defaultProps} primers={primers} />);

    expect(screen.getByTestId('primers-list')).toBeDefined();
    expect(screen.getByText('lacZ_F1')).toBeDefined();
    expect(screen.getByText('lacZ_R1')).toBeDefined();
  });

  it('shows loading skeleton when isLoading=true', () => {
    const { container } = render(<PrimersDrawerContent {...defaultProps} isLoading={true} />);
    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBe(3);
  });

  it('shows instructional text in empty state', () => {
    render(<PrimersDrawerContent {...defaultProps} />);

    expect(screen.getByText(/design a new primer/i)).toBeDefined();
  });

  it('switches to the Create tab (showing the form) when pendingCreation is provided', () => {
    render(
      <PrimersDrawerContent
        {...defaultProps}
        pendingCreation={{
          sequence: 'ATCGATCG',
          direction: 'forward',
          bindingStart: 100,
          bindingEnd: 108,
        }}
      />
    );

    expect(screen.getByTestId('primer-creation-form')).toBeDefined();
    expect(screen.getByTestId('primers-tab-create').getAttribute('data-active')).toBe('true');
    expect(screen.queryByTestId('primers-list')).toBeNull();
  });

  it('calls onPrimerClick when a primer row is clicked', () => {
    const onPrimerClick = vi.fn();
    const primer = createTestBoundPrimer({
      name: 'lacZ_F1',
      id: 'primer-1',
      binding: {
        id: 'bind-1',
        primerId: 'primer-1',
        sequenceId: 42,
        bindingStart: 100,
        bindingEnd: 120,
        strand: 1,
        source: 'manual',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
    render(
      <PrimersDrawerContent {...defaultProps} primers={[primer]} onPrimerClick={onPrimerClick} />
    );

    fireEvent.click(screen.getByTestId('primer-row-bind-1'));
    expect(onPrimerClick).toHaveBeenCalledWith(primer);
  });

  it('surfaces an artifact detach failure and keeps the row visible', async () => {
    const primer = createTestBoundPrimer({ name: 'file_backed_F1' });
    const onDetach = vi.fn().mockRejectedValue(new Error('artifact changed on disk'));
    render(<PrimersDrawerContent {...defaultProps} primers={[primer]} onDetach={onDetach} />);

    fireEvent.click(screen.getByTestId(`primer-detach-${primer.binding.id}`));

    await waitFor(() =>
      expect(screen.getByTestId('primer-detach-error').textContent).toBe(
        userMessageWithValues('primer.detachFailed', { name: userMessageValue('file_backed_F1') })
      )
    );
    expect(screen.getByTestId(`primer-row-${primer.binding.id}`)).toBeDefined();
  });

  it('renders the tab bar with Attached + Create (and Find when searchable)', () => {
    render(<PrimersDrawerContent {...defaultProps} />);
    expect(screen.getByTestId('primers-tab-attached')).toBeDefined();
    expect(screen.getByTestId('primers-tab-create')).toBeDefined();
    expect(screen.queryByTestId('primers-tab-find')).toBeNull();
  });

  it('keeps Create and Find mutually exclusive — switching tabs swaps the panel', () => {
    const onSearch = vi.fn();
    const onAttach = vi.fn().mockResolvedValue(undefined);
    render(
      <PrimersDrawerContent
        {...defaultProps}
        onSearch={onSearch}
        onAttach={onAttach}
        pendingCreation={{
          sequence: 'ATCGATCG',
          direction: 'forward',
          bindingStart: 100,
          bindingEnd: 108,
        }}
      />
    );
    expect(screen.getByTestId('primer-creation-form')).toBeDefined();
    expect(screen.queryByTestId('region-mode-select')).toBeNull();

    fireEvent.click(screen.getByTestId('primers-tab-find'));
    expect(screen.getByTestId('region-mode-select')).toBeDefined();
    expect(screen.getByTestId('primer-creation-form')).not.toBeVisible();
    expect(analyticsMocks.trackToolOpened).toHaveBeenCalledWith('primers', 'sidebar');
  });

  it('opens the Find Primers panel pre-scoped on an auto-scope request ', () => {
    const onSearch = vi.fn();
    const onAttach = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <PrimersDrawerContent
        {...defaultProps}
        onSearch={onSearch}
        onAttach={onAttach}
        autoScope={null}
      />
    );
    expect(screen.queryByTestId('region-mode-select')).toBeNull();

    rerender(
      <PrimersDrawerContent
        {...defaultProps}
        onSearch={onSearch}
        onAttach={onAttach}
        autoScope={{ nonce: 1, region: null }}
      />
    );
    expect(screen.getByTestId('region-mode-select')).toBeDefined();
    expect(onSearch).not.toHaveBeenCalled();
    expect(analyticsMocks.trackToolOpened).toHaveBeenCalledWith('primers', 'menu');
  });

  it('tracks manual Create tab opens and successful primer creation', async () => {
    const onPrimerCreate = vi.fn().mockResolvedValue(undefined);
    render(<PrimersDrawerContent {...defaultProps} onPrimerCreate={onPrimerCreate} />);

    fireEvent.click(screen.getByTestId('primers-tab-create'));
    expect(analyticsMocks.trackToolOpened).toHaveBeenCalledWith('primer_design', 'sidebar');

    fireEvent.change(screen.getByTestId('primer-sequence-input'), {
      target: { value: 'ATCGATCGATCGATCGATCG' },
    });
    fireEvent.change(screen.getByTestId('primer-name-input'), {
      target: { value: 'Primer_F1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save primer/i }));

    await waitFor(() => expect(onPrimerCreate).toHaveBeenCalledTimes(1));
    expect(onPrimerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactPath: '/workspace/project/primers/Primer_F1.primer.json',
        requireRegistry: true,
      })
    );
    expect(analyticsMocks.trackToolActionStarted).toHaveBeenCalledWith(
      'primer_design',
      'sidebar',
      'created'
    );
    expect(analyticsMocks.trackToolActionCompleted).toHaveBeenCalledWith(
      'primer_design',
      'sidebar',
      'created'
    );
  });

  it('retains the edited session and its canvas preview across Attached and Find until Cancel', async () => {
    const onClearPendingCreation = vi.fn();
    const onPreviewChange = vi.fn();
    render(
      <PrimersDrawerContent
        {...defaultProps}
        pendingCreation={{
          sequence: 'atcgatcgatcgatcgatcg',
          direction: 'reverse',
          bindingStart: 100,
          bindingEnd: 120,
        }}
        referenceSequence={'atcg'.repeat(100)}
        onClearPendingCreation={onClearPendingCreation}
        onPreviewChange={onPreviewChange}
        onSearch={vi.fn()}
        onAttach={vi.fn()}
      />
    );
    const notation = '/5Phos/atcg/iBiodT/atcgatcgatcgatcg';
    fireEvent.change(screen.getByTestId('primer-name-input'), {
      target: { value: 'Working primer' },
    });
    fireEvent.change(screen.getByTestId('primer-sequence-input'), {
      target: { value: notation },
    });
    const preview = onPreviewChange.mock.calls.at(-1)?.[0];
    for (const tab of ['attached', 'find']) {
      fireEvent.click(screen.getByTestId(`primers-tab-${tab}`));
      const form = screen.queryByTestId('primer-creation-form');
      if (form) expect(form).not.toBeVisible();
      expect(onPreviewChange.mock.calls.at(-1)?.[0]).toEqual(preview);
      fireEvent.click(screen.getByTestId('primers-tab-create'));
      expect(screen.getByTestId('primer-name-input')).toHaveValue('Working primer');
      expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute(
        'data-oligo-notation',
        notation
      );
      expect(onPreviewChange.mock.calls.at(-1)?.[0]).toEqual(preview);
    }
    expect(onClearPendingCreation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onPreviewChange.mock.calls.at(-1)?.[0]).toEqual({ display: null });
    expect(onClearPendingCreation).toHaveBeenCalledTimes(1);
  });

  it('retains a manual draft until Cancel starts a fresh session', () => {
    render(<PrimersDrawerContent {...defaultProps} />);
    fireEvent.click(screen.getByTestId('primers-tab-create'));
    fireEvent.change(screen.getByTestId('primer-name-input'), {
      target: { value: 'Manual draft' },
    });
    fireEvent.change(screen.getByTestId('primer-sequence-input'), {
      target: { value: 'atcgatcgatcgatcgatcg' },
    });
    fireEvent.click(screen.getByTestId('primers-tab-attached'));
    fireEvent.click(screen.getByTestId('primers-tab-create'));
    expect(screen.getByTestId('primer-name-input')).toHaveValue('Manual draft');
    expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute(
      'data-oligo-notation',
      'atcgatcgatcgatcgatcg'
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    fireEvent.click(screen.getByTestId('primers-tab-create'));
    expect(screen.getByTestId('primer-name-input')).toHaveValue('');
    expect(screen.getByTestId('primer-sequence-input')).toHaveValue('');
  });
});
