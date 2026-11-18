import { userMessage } from '@waypoint/user-messages';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PrimerCreationForm, resolvePrimerOwningProjectRoot } from './PrimerCreationForm';
import { useSettingsStore } from '../../junction-workbench/settings';
import { DEFAULT_TM_MODEL } from '../../design/algorithms/tm-model';
import { reverseComplement } from '@waypoint/sequence-utils';

vi.mock('../../../platform', () => ({
  platform: () => ({ fs: { readDir: vi.fn(async () => []) } }),
}));

vi.mock('@waypoint/scientific-artifacts/shared/primers/tm/tm-calculator', () => ({
  calculateTmNN: vi.fn().mockReturnValue(58.4),
  calculateGcContent: vi.fn().mockReturnValue(50.0),
}));

const { nebFetchMock, trackToolErrorMock } = vi.hoisted(() => ({
  nebFetchMock: vi.fn(),
  trackToolErrorMock: vi.fn(),
}));
vi.mock('../../design/algorithms/neb-tm-client', () => ({
  makeNebFetch: () => nebFetchMock,
}));
vi.mock('../../../lib/analytics', () => ({
  trackToolError: trackToolErrorMock,
  subscribeAnalyticsCaptureReady: vi.fn(() => () => {}),
}));

const defaultProps = {
  onSave: vi.fn().mockResolvedValue(undefined),
  onCancel: vi.fn(),
  sequenceId: 42,
  sequenceLength: 2686,
  initialBindingStart: 100,
  initialBindingEnd: 120,
  workspaceRoot: '/workspace/project',
  targetDocumentId: 'sequence-puc19',
  targetFilePath: '/workspace/project/pUC19.gb',
  circular: true,
};

describe('PrimerCreationForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['forward', 'reverse'] as const)(
    'shifts the whole %s primer without changing its bases or modifications and saves the shifted interval',
    async (direction) => {
      const onSave = vi.fn(async () => undefined);
      const onPreviewChange = vi.fn();
      const onGoToBinding = vi.fn();
      const notation = `/5Phos/acgtACGTacgtACGTacgt/3SpC3/`;
      render(
        <PrimerCreationForm
          {...defaultProps}
          initialName="Register"
          initialDirection={direction}
          initialSequence={notation}
          referenceSequence={`${'a'.repeat(100)}g${'a'.repeat(20)}t${'a'.repeat(2564)}`}
          onSave={onSave}
          onPreviewChange={onPreviewChange}
          onGoToBinding={onGoToBinding}
        />
      );
      const initialCoordinate = direction === 'forward' ? 120 : 101;
      expect(screen.getByTestId('primer-position-input')).toHaveValue(String(initialCoordinate));
      fireEvent.click(screen.getByLabelText('Increase binding position'));
      expect(screen.getByTestId('primer-position-input')).toHaveValue(
        String(initialCoordinate + 1)
      );
      expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute(
        'data-oligo-notation',
        notation
      );
      expect(screen.getByTestId('primer-length-input')).toHaveValue('20');
      expect(onPreviewChange.mock.calls.at(-1)?.[0]?.display).toMatchObject({
        start: 101,
        end: 121,
        bases: 'acgtACGTacgtACGTacgt',
      });
      fireEvent.click(screen.getByTestId('primer-goto-binding'));
      expect(onGoToBinding).toHaveBeenLastCalledWith(101, 121);
      fireEvent.submit(screen.getByTestId('primer-creation-form'));
      await waitFor(() =>
        expect(onSave).toHaveBeenCalledWith(
          expect.objectContaining({
            bindingStart: 101,
            bindingEnd: 121,
            sequence: 'acgtACGTacgtACGTacgt',
            oligo: expect.objectContaining({ notation }),
          })
        )
      );
      fireEvent.click(screen.getByLabelText('Increase length'));
      expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute(
        'data-oligo-notation',
        `/5Phos/acgtACGTacgtACGTacgt${direction === 'forward' ? 't' : 'c'}/3SpC3/`
      );
      expect(onPreviewChange.mock.calls.at(-1)?.[0]?.display).toMatchObject(
        direction === 'forward' ? { start: 101, end: 122 } : { start: 100, end: 121 }
      );
    }
  );

  it('wraps position steps on circular templates and bounds the whole interval on linear ones', () => {
    const onPreviewChange = vi.fn();
    const props = {
      ...defaultProps,
      initialSequence: 'a'.repeat(20),
      initialBindingStart: 80,
      initialBindingEnd: 100,
      sequenceLength: 100,
      referenceSequence: 'a'.repeat(100),
      onPreviewChange,
    };
    const { unmount } = render(<PrimerCreationForm {...props} />);
    fireEvent.click(screen.getByLabelText('Increase binding position'));
    expect(screen.getByTestId('primer-position-input')).toHaveValue('1');
    expect(onPreviewChange.mock.calls.at(-1)?.[0]?.display).toMatchObject({ start: 81, end: 1 });
    fireEvent.click(screen.getByLabelText('Decrease binding position'));
    expect(screen.getByTestId('primer-position-input')).toHaveValue('100');
    unmount();
    render(<PrimerCreationForm {...props} circular={false} />);
    expect(screen.getByLabelText('Increase binding position')).toBeDisabled();
    fireEvent.change(screen.getByTestId('primer-position-input'), { target: { value: '1' } });
    fireEvent.blur(screen.getByTestId('primer-position-input'));
    expect(screen.getByTestId('primer-position-input')).toHaveValue('20');
    expect(screen.getByLabelText('Decrease binding position')).toBeDisabled();
    expect(onPreviewChange.mock.calls.at(-1)?.[0]?.display).toMatchObject({ start: 0, end: 20 });
  });

  it('shows indexed-reference genomic positions while saving host coordinates relative to the loaded window', async () => {
    const onSave = vi.fn(async () => undefined);
    render(
      <PrimerCreationForm
        {...defaultProps}
        hostOwnedBinding
        bindingCoordinateOffset={100000}
        circular={false}
        initialName="Window"
        initialSequence={'a'.repeat(20)}
        referenceSequence={'a'.repeat(2686)}
        onSave={onSave}
      />
    );
    const position = screen.getByTestId('primer-position-input');
    expect(position).toHaveValue('100120');
    act(() => position.focus());
    fireEvent.change(position, { target: { value: '100130' } });
    fireEvent.keyDown(position, { key: 'Enter' });
    expect(position).toHaveValue('100130');
    fireEvent.submit(screen.getByTestId('primer-creation-form'));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ sequence: 'a'.repeat(20) }), {
        start: 110,
        end: 130,
        strand: 1,
      })
    );
  });

  it('assigns nested save locations to the deepest project regardless of mount order', () => {
    const outer = { path: '/lab' };
    const inner = { path: '/lab/client-a' };
    const saveDir = '/lab/client-a/primers';

    expect(resolvePrimerOwningProjectRoot([outer, inner], saveDir)).toBe(inner.path);
    expect(resolvePrimerOwningProjectRoot([inner, outer], saveDir)).toBe(inner.path);
  });

  it('renders the form with all inputs', () => {
    render(<PrimerCreationForm {...defaultProps} />);

    expect(screen.getByTestId('primer-creation-form')).toBeDefined();
    expect(screen.getByTestId('primer-name-input')).toBeDefined();
    expect(screen.getByTestId('primer-sequence-input')).toBeDefined();

    expect(screen.queryByTestId('primer-artifact-path')).toBeNull();
  });

  it('reveals the sequence folder even when it is outside the mounted project roots', async () => {
    render(<PrimerCreationForm {...defaultProps} targetFilePath="/other/sequences/pBR322.gb" />);

    expect(screen.getByTestId('primer-save-location-trigger')).toHaveTextContent('sequences');
    const selectedFolder = await screen.findByTestId('primer-picker-folder-/other/sequences');
    expect(selectedFolder).toHaveAttribute('data-selected', 'true');
  });

  it('keeps exact matches quiet and navigates using the current binding coordinates', () => {
    const onGoToBinding = vi.fn();
    render(
      <PrimerCreationForm
        {...defaultProps}
        initialSequence={'A'.repeat(20)}
        referenceSequence={'A'.repeat(2686)}
        onGoToBinding={onGoToBinding}
      />
    );
    expect(screen.queryByTestId('primer-mismatch-summary')).not.toBeInTheDocument();
    expect(screen.queryByText('Exact match to template')).not.toBeInTheDocument();
    const target = screen.getByRole('button', {
      name: 'Go to primer binding site on the sequence',
    });
    expect(target.closest('[data-testid="primer-preview-box"]')).not.toBeNull();
    expect(target).toHaveClass('absolute', 'top-1.5');
    expect(target).not.toHaveClass('bottom-1.5');
    expect(target).toHaveTextContent('');
    expect(screen.queryByText('Binding site')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('primer-goto-binding'));
    expect(onGoToBinding).toHaveBeenLastCalledWith(100, 120);
    fireEvent.click(screen.getByLabelText('Increase length'));
    fireEvent.click(screen.getByTestId('primer-goto-binding'));
    expect(onGoToBinding).toHaveBeenLastCalledWith(100, 121);
    fireEvent.click(screen.getByRole('button', { name: 'Reverse primer' }));
    expect(target).toHaveClass('absolute', 'bottom-1.5');
    expect(target).not.toHaveClass('top-1.5');
    fireEvent.click(target);
    expect(onGoToBinding).toHaveBeenLastCalledWith(100, 120);
    fireEvent.click(screen.getByRole('button', { name: 'Forward primer' }));
    expect(target).toHaveClass('top-1.5');
    expect(target).not.toHaveClass('bottom-1.5');
  });

  it.each(['forward', 'reverse'] as const)(
    'preserves mixed template case and modifications through %s PBS resizing, preview and save',
    async (direction) => {
      const templateBases = 'acgtACGTacgtACGTacgt';
      const initialBases =
        direction === 'reverse' ? reverseComplement(templateBases) : templateBases;
      const extension = direction === 'reverse' ? 'cT' : 'tC';
      const onSave = vi.fn().mockResolvedValue(undefined);
      const onPreviewChange = vi.fn();
      render(
        <PrimerCreationForm
          {...defaultProps}
          initialName="Case_F1"
          initialDirection={direction}
          initialSequence={`/5Phos/${initialBases}/3SpC3/`}
          referenceSequence={`${'A'.repeat(99)}g${templateBases}tC${'A'.repeat(2544)}`}
          onSave={onSave}
          onPreviewChange={onPreviewChange}
        />
      );
      fireEvent.click(screen.getByLabelText('Increase length'));
      fireEvent.click(screen.getByLabelText('Increase length'));
      const resized = `${initialBases}${extension}`;
      expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute(
        'data-oligo-notation',
        `/5Phos/${resized}/3SpC3/`
      );
      expect(onPreviewChange.mock.calls.at(-1)?.[0]?.display?.bases).toBe(resized);
      expect(onPreviewChange.mock.calls.at(-1)?.[0]?.display?.modificationMarkers).toEqual([
        expect.objectContaining({
          token: '/5Phos/',
          anchor: { kind: 'terminus', end: 'five-prime' },
        }),
        expect.objectContaining({
          token: '/3SpC3/',
          anchor: { kind: 'terminus', end: 'three-prime' },
        }),
      ]);
      expect(screen.queryByTestId('primer-mismatch-summary')).not.toBeInTheDocument();
      fireEvent.submit(screen.getByTestId('primer-creation-form'));
      await waitFor(() =>
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ sequence: resized }))
      );
      fireEvent.click(screen.getByLabelText('Decrease length'));
      expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute(
        'data-oligo-notation',
        `/5Phos/${initialBases}${extension[0]}/3SpC3/`
      );
    }
  );

  it('still warns about a mismatch at the extension end', () => {
    render(
      <PrimerCreationForm
        {...defaultProps}
        initialSequence={`${'A'.repeat(19)}C`}
        referenceSequence={'A'.repeat(2686)}
      />
    );
    expect(screen.getByTestId('primer-mismatch-summary')).toHaveTextContent(
      "1 mismatch — one at the 3' terminus"
    );
  });

  it('updates reverse-primer terminal warnings in oligo order after editing', () => {
    render(
      <PrimerCreationForm
        {...defaultProps}
        initialDirection="reverse"
        initialSequence={`c${'t'.repeat(18)}c`}
        referenceSequence={'a'.repeat(2686)}
      />
    );
    expect(screen.getByTestId('primer-mismatch-summary')).toHaveTextContent(
      "2 mismatches — one at the 3' terminus"
    );
    fireEvent.change(screen.getByTestId('primer-sequence-input'), {
      target: { value: `c${'t'.repeat(18)}ct` },
    });
    expect(screen.getByTestId('primer-mismatch-summary')).toHaveTextContent('2 mismatches');
    expect(screen.getByTestId('primer-mismatch-summary')).not.toHaveTextContent("3' terminus");
    expect(document.querySelector('label[for="primer-sequence-input"]')).toHaveTextContent(
      'Sequence (5′→3′) *'
    );
  });

  it('suggests a name from the target file + binding indices (ghost text, Tab accepts)', () => {
    render(<PrimerCreationForm {...defaultProps} />);
    const input = screen.getByTestId('primer-name-input') as HTMLInputElement;

    expect(input).toHaveAttribute('placeholder', 'pUC19_101_120');
    expect(input.value).toBe('');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('pUC19_101_120');
  });

  it('keeps the 3′ genomic endpoint fixed when bases are typed at the 5′ end', async () => {
    const onPreviewChange = vi.fn();
    render(
      <PrimerCreationForm
        {...defaultProps}
        initialSequence={'A'.repeat(20)}
        initialDirection="forward"
        onPreviewChange={onPreviewChange}
      />
    );

    await waitFor(() => {
      const d = onPreviewChange.mock.calls.at(-1)?.[0]?.display;
      expect(d?.start).toBe(100);
      expect(d?.end).toBe(120);
    });

    fireEvent.change(screen.getByTestId('primer-sequence-input'), {
      target: { value: 'A'.repeat(25) },
    });
    await waitFor(() => {
      const d = onPreviewChange.mock.calls.at(-1)?.[0]?.display;
      expect(d?.start).toBe(95);
      expect(d?.end).toBe(120);
      expect(d?.bases).toBe('A'.repeat(25));
    });
  });

  it('moves the 3′ genomic endpoint only when the length control changes it', async () => {
    const onPreviewChange = vi.fn();
    render(
      <PrimerCreationForm
        {...defaultProps}
        initialSequence={'A'.repeat(20)}
        initialDirection="forward"
        referenceSequence={'A'.repeat(2686)}
        onPreviewChange={onPreviewChange}
      />
    );

    fireEvent.click(screen.getByLabelText('Increase length'));

    await waitFor(() => {
      const d = onPreviewChange.mock.calls.at(-1)?.[0]?.display;
      expect(d?.start).toBe(100);
      expect(d?.end).toBe(121);
      expect(d?.bases).toHaveLength(21);
    });
  });

  it('keeps standalone creation focused on the primer instead of showing template-only controls', () => {
    render(
      <PrimerCreationForm
        {...defaultProps}
        initialBindingStart={undefined}
        initialBindingEnd={undefined}
        initialSequence="ATCGATCGATCGATCG"
      />
    );
    const ta = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;
    expect(ta.value).toBe('ATCGATCGATCGATCG');
    expect(screen.queryByRole('button', { name: 'Forward primer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reverse primer' })).not.toBeInTheDocument();
    expect(screen.getAllByText('16 nt')).toHaveLength(1);
  });

  it('previews the primer name as a title and routes both rename gestures to the persistent field', () => {
    render(<PrimerCreationForm {...defaultProps} />);

    expect(screen.getByTestId('primer-form-title').textContent).toBe('Untitled Primer');
    fireEvent.change(screen.getByTestId('primer-name-input'), { target: { value: 'lacZ_fwd' } });
    expect(screen.getByTestId('primer-form-title').textContent).toBe('lacZ_fwd');

    const input = screen.getByTestId('primer-name-input') as HTMLInputElement;
    fireEvent.doubleClick(screen.getByTestId('primer-form-title'));
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('lacZ_fwd'.length);

    input.blur();
    fireEvent.click(screen.getByRole('button', { name: 'Edit primer name' }));
    expect(document.activeElement).toBe(input);
  });

  it('pre-populates sequence from initialSequence', () => {
    render(<PrimerCreationForm {...defaultProps} initialSequence="ATCGATCGATCGATCGATCG" />);

    const textarea = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;
    expect(textarea.value).toBe('ATCGATCGATCGATCGATCG');
  });

  it('shows computed Tm and GC% for valid sequence', () => {
    render(<PrimerCreationForm {...defaultProps} initialSequence="ATCGATCGATCGATCGATCG" />);

    expect(screen.getByTestId('primer-computed-values')).toBeDefined();

    expect(screen.getByTestId('primer-tm-value').textContent).toMatch(/^58\.4°C/);
    expect(screen.getByText('50%')).toBeDefined();
  });

  it('does not show computed values for short sequence', () => {
    render(<PrimerCreationForm {...defaultProps} initialSequence="ATCG" />);

    expect(screen.queryByTestId('primer-computed-values')).toBeNull();
  });

  it('sets forward direction by default', () => {
    render(<PrimerCreationForm {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Forward primer' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Reverse primer' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('pre-selects direction from initialDirection', () => {
    render(<PrimerCreationForm {...defaultProps} initialDirection="reverse" />);
    expect(screen.getByRole('button', { name: 'Reverse primer' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Forward primer' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('calls onSave with correct input when submitted', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PrimerCreationForm
        {...defaultProps}
        onSave={onSave}
        initialSequence="ATCGATCGATCGATCGATCG"
      />
    );

    fireEvent.change(screen.getByTestId('primer-name-input'), {
      target: { value: 'lacZ_F1' },
    });

    fireEvent.submit(screen.getByTestId('primer-creation-form'));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'lacZ_F1',
          sequence: 'ATCGATCGATCGATCGATCG',
          artifactPath: '/workspace/project/lacZ_F1.primer.json',
          workspaceRoot: '/workspace/project',
          targetDocumentId: 'sequence-puc19',
          targetFilePath: '/workspace/project/pUC19.gb',
          requireRegistry: true,
        })
      );
    });
  });

  it('saves a standalone primer directly into the folder selected before the form opened', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PrimerCreationForm
        onSave={onSave}
        onCancel={vi.fn()}
        workspaceRoot="/workspace/project"
        initialSaveDir="/workspace/project/oligos"
        initialSequence="ATCGATCGATCGATCGATCG"
      />
    );

    fireEvent.change(screen.getByTestId('primer-name-input'), {
      target: { value: 'Library_F1' },
    });
    fireEvent.submit(screen.getByTestId('primer-creation-form'));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Library_F1',
          artifactPath: '/workspace/project/oligos/Library_F1.primer.json',
          workspaceRoot: '/workspace/project',
          requireRegistry: true,
        })
      );
    });
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('bindingSequenceId');
  });

  it('preserves the typed case when saving (case-sensitive)', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PrimerCreationForm
        {...defaultProps}
        onSave={onSave}
        initialSequence="atcgATCGatcgATCGatcg"
      />
    );
    fireEvent.change(screen.getByTestId('primer-name-input'), { target: { value: 'lacZ_F1' } });
    fireEvent.submit(screen.getByTestId('primer-creation-form'));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ sequence: 'atcgATCGatcgATCGatcg' })
      )
    );
  });

  it('saves IDT notation as natural bases plus structured modification anchors', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PrimerCreationForm
        onSave={onSave}
        onCancel={vi.fn()}
        workspaceRoot="/workspace/project"
        initialSaveDir="/workspace/project/oligos"
        initialName="Modified_F1"
        initialSequence="/5Phos/ATCGATCGAT/iBiodT/CGATCGATCG"
      />
    );

    fireEvent.submit(screen.getByTestId('primer-creation-form'));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Modified_F1',
          sequence: 'ATCGATCGATTCGATCGATCG',
          oligo: expect.objectContaining({
            vendor: 'idt',
            notation: '/5Phos/ATCGATCGAT/iBiodT/CGATCGATCG',
          }),
        })
      )
    );
  });

  it('switches standalone creation to an exact RNA order without running a DNA Tm model', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PrimerCreationForm
        onSave={onSave}
        onCancel={vi.fn()}
        workspaceRoot="/workspace/project"
        initialSaveDir="/workspace/project/oligos"
        initialName="RNA oligo"
        initialSequence="/5Phos/rArCrGrUrArCrGrUrArCrGrU/3SpC3/"
        orderType="rna"
      />
    );

    expect(screen.queryByTestId('primer-tm-model-inline')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save Primer' })).toBeEnabled();

    fireEvent.submit(screen.getByTestId('primer-creation-form'));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          sequence: 'ACGUACGUACGU',
          oligo: expect.objectContaining({
            orderType: 'rna',
            notation: '/5Phos/rArCrGrUrArCrGrUrArCrGrU/3SpC3/',
          }),
        })
      )
    );
  });

  it('keeps reference-bound primer design DNA-only', () => {
    render(<PrimerCreationForm {...defaultProps} />);
    expect(screen.queryByTestId('primer-order-type-picker')).toBeNull();
  });

  it('uses the full IDT slash picker for a template-bound primer without moving its binding', () => {
    const onGoToBinding = vi.fn();
    render(
      <PrimerCreationForm
        {...defaultProps}
        initialSequence={'A'.repeat(20)}
        referenceSequence={'A'.repeat(2686)}
        onGoToBinding={onGoToBinding}
      />
    );
    const input = screen.getByTestId('primer-sequence-input') as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: { value: `/pho${'A'.repeat(20)}`, selectionStart: 4, selectionEnd: 4 },
    });
    fireEvent.click(screen.getByRole('option', { name: /5′ phosphorylation.*5Phos/i }));
    expect(input).toHaveAttribute('data-oligo-notation', `/5Phos/${'A'.repeat(20)}`);
    expect(input.value).toBe(`*${'A'.repeat(20)}`);
    expect(screen.getByTestId('primer-length-input')).toHaveValue('20');
    fireEvent.click(screen.getByTestId('primer-goto-binding'));
    expect(onGoToBinding).toHaveBeenCalledWith(100, 120);
  });

  it('counts biological bases when changing binding length and retains terminal IDT modifications', () => {
    const onGoToBinding = vi.fn();
    render(
      <PrimerCreationForm
        {...defaultProps}
        initialSequence={`/5Phos/${'A'.repeat(20)}/3SpC3/`}
        referenceSequence={'A'.repeat(2686)}
        onGoToBinding={onGoToBinding}
      />
    );
    fireEvent.click(screen.getByLabelText('Increase length'));
    expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute(
      'data-oligo-notation',
      `/5Phos/${'A'.repeat(21)}/3SpC3/`
    );
    fireEvent.click(screen.getByTestId('primer-goto-binding'));
    expect(onGoToBinding).toHaveBeenLastCalledWith(100, 121);
    fireEvent.click(screen.getByLabelText('Decrease length'));
    expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute(
      'data-oligo-notation',
      `/5Phos/${'A'.repeat(20)}/3SpC3/`
    );
  });

  it('rejects pasted IDT notation whose modification is in the wrong position', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PrimerCreationForm
        onSave={onSave}
        onCancel={vi.fn()}
        workspaceRoot="/workspace/project"
        initialSaveDir="/workspace/project/oligos"
        initialName="Invalid_modified_F1"
        initialSequence="ATCGATCGATCGATCGATCG/5Phos/"
      />
    );

    expect(screen.getByRole('button', { name: 'Save Primer' })).toBeDisabled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '/5Phos/ can only be used at the 5′ end'
    );
    fireEvent.submit(screen.getByTestId('primer-creation-form'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows non-blocking vendor guidance separately from hard validation errors', () => {
    render(
      <PrimerCreationForm
        onSave={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
        workspaceRoot="/workspace/project"
        initialSaveDir="/workspace/project/oligos"
        initialName="DTPA series"
        initialSequence="A/iDTPA//iDTPA//iDTPA//iDTPA/T"
      />
    );

    expect(screen.getByTestId('primer-form-warning')).toHaveTextContent(
      /documents adjacent DTPA series of 2 or 3/i
    );
    expect(screen.queryByTestId('primer-form-error')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save Primer' })).toBeEnabled();
  });

  it('blocks Save when the shared vendor registry rejects a modification combination', () => {
    render(
      <PrimerCreationForm
        onSave={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
        workspaceRoot="/workspace/project"
        initialSaveDir="/workspace/project/oligos"
        initialName="Incompatible dyes"
        initialSequence="/5YakYel/AC/36-TAMSp/"
      />
    );

    expect(screen.getByTestId('primer-form-error')).toHaveTextContent(
      /does not allow Yakima Yellow and TAMRA/i
    );
    expect(screen.getByRole('button', { name: 'Save Primer' })).toBeDisabled();
  });

  it('prefills artifact-backed edits and keeps the authoritative file location fixed', () => {
    render(
      <PrimerCreationForm
        onSave={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
        workspaceRoot="/workspace/project"
        initialName="Existing primer"
        initialSequence="ATCGATCGATCGATCGATCG"
        fixedArtifactPath="/workspace/project/oligos/existing.primer.json"
      />
    );

    expect(screen.getByTestId('primer-name-input')).toHaveValue('Existing primer');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    expect(screen.queryByTestId('primer-save-location-picker')).not.toBeInTheDocument();
    expect(screen.getByTestId('primer-fixed-location')).toHaveTextContent('oligos/existing');
  });

  it.each(['dna', 'rna'] as const)(
    'disables unchanged, reverted and acknowledged %s metadata saves',
    async (orderType) => {
      const onSave = vi.fn(async () => undefined);
      render(
        <PrimerCreationForm
          onSave={onSave}
          onCancel={vi.fn()}
          workspaceRoot="/workspace/project"
          initialName="Existing oligo"
          initialOrderType={orderType}
          initialSequence={orderType === 'rna' ? 'ACGUACGUACGU' : 'ACGTACGTACGT'}
          fixedArtifactPath="/workspace/project/oligos/existing.primer.json"
        />
      );
      const save = screen.getByRole('button', { name: 'Save Changes' });
      expect(save).toBeDisabled();
      fireEvent.submit(screen.getByTestId('primer-creation-form'));
      expect(onSave).not.toHaveBeenCalled();
      fireEvent.change(screen.getByTestId('primer-name-input'), {
        target: { value: 'Changed oligo' },
      });
      expect(save).toBeEnabled();
      fireEvent.change(screen.getByTestId('primer-name-input'), {
        target: { value: 'Existing oligo' },
      });
      expect(save).toBeDisabled();
      fireEvent.change(screen.getByTestId('primer-name-input'), {
        target: { value: 'Saved oligo' },
      });
      fireEvent.click(save);
      await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
      await waitFor(() => expect(save).toBeDisabled());
      fireEvent.change(screen.getByTestId('primer-name-input'), {
        target: { value: 'Existing oligo' },
      });
      expect(save).toBeEnabled();
    }
  );

  it('shows the inline folder tree by default and collapses it to the selected path field', () => {
    render(<PrimerCreationForm {...defaultProps} initialSequence="ATCGATCGATCGATCGATCG" />);
    expect(screen.queryByTestId('primer-artifact-choose')).toBeNull();
    const trigger = screen.getByTestId('primer-save-location-trigger');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('primer-save-location-picker')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('primer-save-location-picker')).not.toBeInTheDocument();
  });

  it('fills the drawer through the pinned Save Primer action bar', () => {
    render(<PrimerCreationForm {...defaultProps} initialSequence="ATCGATCGATCGATCGATCG" />);
    expect(screen.getByTestId('primer-creation-form').className).toContain('min-h-0');
    expect(screen.getByTestId('primer-form-content').className).toContain('overflow-y-auto');
    expect(screen.getByTestId('primer-save-location-section').className).toContain('flex-1');
    expect(screen.getByTestId('primer-save-location-section').className).toContain('min-h-[280px]');
    expect(screen.getByTestId('primer-save-location-expanded').className).toContain('flex-1');
    expect(screen.getByTestId('primer-save-location-picker').className).toContain('h-full');
    expect(screen.getByTestId('primer-save-location-picker').className).not.toContain(
      'max-h-[240px]'
    );
    expect(screen.getByTestId('primer-form-actions')).toBeInTheDocument();
  });

  it('requires a name — Save is disabled until a name is entered', () => {
    render(<PrimerCreationForm {...defaultProps} initialSequence="ATCGATCGATCGATCGATCG" />);
    const save = screen.getByRole('button', { name: 'Save Primer' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId('primer-name-input'), { target: { value: 'lacZ_F1' } });
    expect(save).toBeEnabled();
  });

  it('blocks submit and errors when the name is empty', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PrimerCreationForm
        {...defaultProps}
        onSave={onSave}
        initialSequence="ATCGATCGATCGATCGATCG"
      />
    );
    fireEvent.submit(screen.getByTestId('primer-creation-form'));
    expect(await screen.findByTestId('primer-form-error')).toHaveTextContent('Enter a name');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('surfaces registry or history save failures and leaves the form open', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Git history commit failed'));
    render(
      <PrimerCreationForm
        {...defaultProps}
        onSave={onSave}
        initialSequence="ATCGATCGATCGATCGATCG"
      />
    );

    fireEvent.change(screen.getByTestId('primer-name-input'), { target: { value: 'lacZ_F1' } });
    fireEvent.submit(screen.getByTestId('primer-creation-form'));

    expect(await screen.findByRole('alert')).toHaveTextContent(userMessage('primer.failed'));
    expect(screen.getByTestId('primer-creation-form')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Primer' })).toBeEnabled();
  });

  it('explains an ownership mismatch, preserves the draft and allows a successful retry', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'fs:writeWorkspaceTextFileAtomic': Error: WORKSPACE_MUTATION_DECLARED_ROOT_MISMATCH"
        )
      )
      .mockResolvedValueOnce(undefined);
    render(
      <PrimerCreationForm
        {...defaultProps}
        onSave={onSave}
        initialSequence="ATCGATCGATCGATCGATCG"
      />
    );
    fireEvent.change(screen.getByTestId('primer-name-input'), { target: { value: 'lacZ_F1' } });
    fireEvent.submit(screen.getByTestId('primer-creation-form'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose a folder in the owning project and save again'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('WORKSPACE_MUTATION');
    expect(screen.getByTestId('primer-name-input')).toHaveValue('lacZ_F1');
    expect(screen.getByTestId('primer-sequence-input')).toHaveValue('ATCGATCGATCGATCGATCG');
    expect(screen.getByRole('button', { name: 'Save Primer' })).toBeEnabled();
    fireEvent.submit(screen.getByTestId('primer-creation-form'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('shows error for invalid sequence', async () => {
    render(<PrimerCreationForm {...defaultProps} initialSequence="XYZ" />);

    fireEvent.submit(screen.getByTestId('primer-creation-form'));

    await waitFor(() => {
      expect(screen.getByTestId('primer-form-error')).toBeDefined();
    });
  });

  it('calls onCancel when cancel button clicked', () => {
    const onCancel = vi.fn();
    render(<PrimerCreationForm {...defaultProps} onCancel={onCancel} />);

    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  describe('NEB Tm preview updates on product-code switch ', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      nebFetchMock.mockReset();
      trackToolErrorMock.mockReset();
      useSettingsStore.setState({ tmModel: DEFAULT_TM_MODEL });
    });

    afterEach(() => {
      vi.useRealTimers();
      useSettingsStore.setState({ tmModel: DEFAULT_TM_MODEL });
    });

    async function chooseInlineTmModel(optionValue: string, advanceMs = 0) {
      fireEvent.click(screen.getByTestId('primer-tm-model-inline'));
      fireEvent.click(screen.getByTestId(`primer-tm-model-inline-option-${optionValue}`));
      if (advanceMs > 0) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(advanceMs);
        });
      }
    }

    it('stays silent (no caution icon) while an NEB fetch is in flight — no premature UI, no telemetry', async () => {
      nebFetchMock.mockImplementation(() => new Promise(() => {}));
      render(<PrimerCreationForm {...defaultProps} initialSequence="ATCGATCGATCGATCGATCG" />);

      expect(screen.getByTestId('primer-tm-value').textContent).toBe('58.4°C');
      expect(screen.queryByTestId('primer-tm-neb-unavailable')).toBeNull();

      await chooseInlineTmModel('q5-0');

      expect(screen.queryByTestId('primer-tm-neb-unavailable')).toBeNull();
      expect(trackToolErrorMock).not.toHaveBeenCalled();
    });

    it('resolves to the real, distinct NEB value with no caution icon and no telemetry on success', async () => {
      const onPreviewChange = vi.fn();
      nebFetchMock.mockResolvedValueOnce({
        tm: 71.2,
        nebApiVersion: '0.19.0',
        fetchedAt: '2026-07-22T00:00:00.000Z',
      });
      render(
        <PrimerCreationForm
          {...defaultProps}
          initialSequence="ATCGATCGATCGATCGATCG"
          onPreviewChange={onPreviewChange}
        />
      );

      await chooseInlineTmModel('q5-0', 500);

      expect(screen.getByTestId('primer-tm-value').textContent).toBe('71.2°C');
      expect(onPreviewChange.mock.calls.at(-1)?.[0]?.display?.tm).toBe(71.2);
      expect(screen.queryByTestId('primer-tm-neb-unavailable')).toBeNull();
      expect(trackToolErrorMock).not.toHaveBeenCalled();

      nebFetchMock.mockImplementation(() => new Promise(() => {}));
      await chooseInlineTmModel('phusion-0');

      expect(screen.getByTestId('primer-tm-value').textContent).not.toBe('71.2°C');
      expect(screen.queryByTestId('primer-tm-neb-unavailable')).toBeNull();
    });

    it('a failed NEB fetch shows the caution icon (not a text badge) once settled, and logs telemetry exactly once', async () => {
      nebFetchMock.mockRejectedValueOnce(new Error('rate limited'));
      render(<PrimerCreationForm {...defaultProps} initialSequence="ATCGATCGATCGATCGATCG" />);

      await chooseInlineTmModel('q5-0', 500);

      expect(screen.getByTestId('primer-tm-value').textContent).toBe('58.4°C');
      const icon = screen.getByTestId('primer-tm-neb-unavailable');
      expect(icon).toBeInTheDocument();
      expect(icon.textContent).not.toMatch(/est\.?/i);
      expect(trackToolErrorMock).toHaveBeenCalledTimes(1);
      expect(trackToolErrorMock).toHaveBeenCalledWith('primers', 'sidebar', 'provider_unavailable');
    });
  });
});
