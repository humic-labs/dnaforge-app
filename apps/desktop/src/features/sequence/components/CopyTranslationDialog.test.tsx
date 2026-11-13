/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCustomGeneticCode } from '@waypoint/sequence-utils';
import { CopyTranslationDialog } from './CopyTranslationDialog';
import { TranslationDialogHost } from './TranslationDialogHost';
import { useTranslationDialogStore } from '../translation-dialog-store';
import { useToastStore } from '../../../stores/toast-store';

const capture = vi.hoisted(() => ({
  track: vi.fn((_event: string, _properties: Record<string, unknown>) => true),
  generation: 0,
}));
vi.mock('../../../lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/analytics')>()),
  trackRendererEvent: capture.track,
  getAnalyticsCaptureGeneration: () => capture.generation,
}));

const writeText = vi.fn().mockResolvedValue(undefined);

const COPY_FRAME_MATRIX = [
  { code: 1, strand: 'forward', frame: 1, expected: 'MK*' },
  { code: 1, strand: 'forward', frame: 2, expected: '*N' },
  { code: 1, strand: 'forward', frame: 3, expected: 'EM' },
  { code: 1, strand: 'reverse', frame: 1, expected: 'SFH' },
  { code: 1, strand: 'reverse', frame: 2, expected: 'HF' },
  { code: 1, strand: 'reverse', frame: 3, expected: 'IS' },
  { code: 2, strand: 'forward', frame: 1, expected: 'MKW' },
  { code: 2, strand: 'forward', frame: 2, expected: 'WN' },
  { code: 2, strand: 'forward', frame: 3, expected: 'EM' },
  { code: 2, strand: 'reverse', frame: 1, expected: 'SFH' },
  { code: 2, strand: 'reverse', frame: 2, expected: 'HF' },
  { code: 2, strand: 'reverse', frame: 3, expected: 'IS' },
] as const;

beforeEach(() => {
  capture.track.mockClear();
  capture.generation = 0;
  writeText.mockReset().mockResolvedValue(undefined);
  useTranslationDialogStore.setState({ request: null });
  Object.assign(navigator, { clipboard: { writeText } });
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CopyTranslationDialog original COPY-2 frame matrix', () => {
  it.each(COPY_FRAME_MATRIX)(
    'copies exact code $code $strand frame $frame translation',
    async ({ code, strand, frame, expected }) => {
      const onClose = vi.fn();
      render(<CopyTranslationDialog sequence="ATGAAATGA" geneticCode={code} onClose={onClose} />);

      expect(screen.getByTestId('copy-translation-genetic-code')).toHaveTextContent(
        `Genetic code ${code} — ${code === 1 ? 'Standard' : 'Vertebrate Mitochondrial'}`
      );
      const row = screen.getByRole('button', {
        name: `Copy ${strand} frame ${frame} translation`,
      });
      expect(row.querySelector('.font-mono')?.textContent).toBe(expected);

      fireEvent.click(row);
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

      expect(writeText.mock.calls).toEqual([[expected]]);
      expect(useToastStore.getState().toasts).toHaveLength(1);
      expect(useToastStore.getState().toasts[0]).toMatchObject({
        type: 'success',
        message: `Copied ${expected}`,
      });
    }
  );
});

describe('CopyTranslationDialog', () => {
  it('renders all six frames grouped forward/reverse, numbered 1/2/3', () => {
    render(<CopyTranslationDialog sequence="ATGAAATAA" label="9 bp selected" onClose={() => {}} />);

    const caption = screen.getByTestId('copy-translation-genetic-code');
    expect(caption.textContent).toContain('9 bp selected');
    expect(caption.textContent).toContain('Genetic code 1 — Standard');

    const forward = screen.getByTestId('translation-strand-forward');
    const reverse = screen.getByTestId('translation-strand-reverse');
    expect(within(forward).getByText("Forward strand (5'→3')")).toBeInTheDocument();
    expect(within(reverse).getByText("Reverse strand (3'→5')")).toBeInTheDocument();

    expect(screen.getAllByText(/^Frame [123]$/)).toHaveLength(6);
    for (const strand of ['forward', 'reverse'] as const) {
      for (const frame of [1, 2, 3]) {
        expect(screen.getByTestId(`translation-frame-${strand}-${frame}`)).toBeInTheDocument();
      }
    }
  });

  it('shows the full amino-acid translation for each frame', () => {
    render(<CopyTranslationDialog sequence="ATGAAATAA" onClose={() => {}} />);

    expect(screen.getByTestId('translation-frame-forward-1')).toHaveTextContent('MK*');

    expect(screen.getByTestId('translation-frame-reverse-1')).toHaveTextContent('LFH');
  });

  it('highlights stop codons as an out-of-frame cue', () => {
    render(<CopyTranslationDialog sequence="ATGAAATAA" onClose={() => {}} />);
    const forwardFrame1 = screen.getByTestId('translation-frame-forward-1');
    const stop = within(forwardFrame1).getByTestId('stop-codon');
    expect(stop).toHaveTextContent('*');
    expect(stop).toHaveClass('text-error');

    const reverseFrame1 = screen.getByTestId('translation-frame-reverse-1');
    expect(within(reverseFrame1).queryByTestId('stop-codon')).toBeNull();
  });

  it('shows the amino-acid length for each frame', () => {
    render(<CopyTranslationDialog sequence="ATGAAATAA" onClose={() => {}} />);

    expect(screen.getByTestId('translation-frame-length-forward-1')).toHaveTextContent('3 aa');

    expect(screen.getByTestId('translation-frame-length-forward-2')).toHaveTextContent('2 aa');
  });

  it('copies, dismisses the modal, and fires a "Copied" toast when a row is clicked', async () => {
    const onClose = vi.fn();
    render(<CopyTranslationDialog sequence="ATGAAATAA" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('translation-frame-forward-1'));
    expect(writeText).toHaveBeenCalledWith('MK*');

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ type: 'success', message: 'Copied MK*' });
  });

  it('truncates the copied translation with an ellipsis in the toast', async () => {
    const longOrf = 'ATG'.repeat(21);
    render(<CopyTranslationDialog sequence={longOrf} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('translation-frame-forward-1'));
    await vi.waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const message = useToastStore.getState().toasts[0].message;
    expect(message.startsWith('Copied ')).toBe(true);
    expect(message.endsWith('…')).toBe(true);

    expect(message).toBe(`Copied ${'M'.repeat(20)}…`);
  });

  it('disables the row (no copy, no close) for a frame with no complete codon', () => {
    const onClose = vi.fn();
    render(<CopyTranslationDialog sequence="AT" onClose={onClose} />);
    const row = screen.getByTestId('translation-frame-forward-1');
    expect(within(row).getByText('no full codon')).toBeInTheDocument();
    expect(row).toBeDisabled();
    fireEvent.click(row);
    expect(writeText).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refuses to translate an oversized selection instead of freezing on it', () => {
    render(<CopyTranslationDialog sequence={'A'.repeat(50_001)} onClose={() => {}} />);
    expect(screen.getByTestId('translation-too-large')).toBeInTheDocument();

    expect(screen.queryByTestId('translation-strand-forward')).toBeNull();
    expect(screen.queryByTestId('translation-frame-forward-1')).toBeNull();
  });

  it('retains the selected translation after clipboard rejection and closes only after retry succeeds', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    const onClose = vi.fn();
    render(<CopyTranslationDialog sequence="ATGAAATAA" label="9 bp selected" onClose={onClose} />);
    const row = screen.getByTestId('translation-frame-forward-1');
    fireEvent.click(row);
    await vi.waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(row).toHaveTextContent('MK*');
    expect(screen.getByTestId('copy-translation-genetic-code')).toHaveTextContent('9 bp selected');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ type: 'error', message: 'Failed to copy translation' });

    fireEvent.click(row);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls).toEqual([['MK*'], ['MK*']]);
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      type: 'success',
      message: 'Copied MK*',
    });
  });

  it('retains the dialog and genetic code when clipboard access is unavailable', async () => {
    Object.assign(navigator, { clipboard: undefined });
    const onClose = vi.fn();
    render(<CopyTranslationDialog sequence="ATGAAATGA" geneticCode={2} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('translation-frame-forward-1'));
    await vi.waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByTestId('translation-frame-forward-1')).toHaveTextContent('MKW');
    expect(screen.getByTestId('copy-translation-genetic-code')).toHaveTextContent(
      'Genetic code 2 — Vertebrate Mitochondrial'
    );
  });

  it('closes on the Close button, Escape, and a backdrop click', () => {
    const onClose = vi.fn();
    render(<CopyTranslationDialog sequence="ATGAAATAA" onClose={onClose} />);

    fireEvent.click(screen.getByTestId('copy-translation-dialog-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    const backdrop = screen.getByTestId('copy-translation-dialog');
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('does NOT close when the press starts inside the dialog box', () => {
    const onClose = vi.fn();
    render(<CopyTranslationDialog sequence="ATGAAATAA" onClose={onClose} />);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('CopyTranslationDialog genetic code ', () => {
  it('reads the frames by the record code it is given, and names it', () => {
    render(<CopyTranslationDialog sequence="ATGAAATGA" geneticCode={2} onClose={() => {}} />);
    expect(screen.getByTestId('copy-translation-genetic-code').textContent).toContain(
      'Genetic code 2 — Vertebrate Mitochondrial'
    );
    const frame = screen.getByTestId('translation-frame-forward-1');
    expect(within(frame).getByText('MKW')).toBeInTheDocument();

    expect(within(frame).queryByTestId('stop-codon')).toBeNull();
  });

  it('falls back to the standard code when none is given', () => {
    render(<CopyTranslationDialog sequence="ATGAAATGA" onClose={() => {}} />);
    const frame = screen.getByTestId('translation-frame-forward-1');

    expect(within(frame).getByText('MK')).toBeInTheDocument();
    expect(within(frame).getByTestId('stop-codon').textContent).toBe('*');
  });
});

describe('a selection read by a custom genetic code', () => {
  it('says what X stands for, so the copied protein can be read', () => {
    const built = buildCustomGeneticCode({
      id: 'gc-3f2a9c1e',
      revision: 1,
      name: 'Amber suppression (pAzF at TAG)',
      base: 11,
      changes: { TAG: { kind: 'residue', residue: 'pAzF' } },
      residues: [{ abbreviation: 'pAzF', name: 'p-azido-L-phenylalanine', ccd: 'AZF' }],
    });
    if (!built.ok) throw new Error('fixture must build');
    render(
      <CopyTranslationDialog
        open
        sequence="ATGTAGAAA"
        geneticCode={built.definition}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByTestId('copy-translation-genetic-code').textContent).toContain(
      'Amber suppression (pAzF at TAG)'
    );
    expect(screen.getByTestId('copy-translation-residues').textContent).toBe('X marks pAzF (TAG).');
  });
});

function pendingClipboardWrite() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((fulfill, refuse) => {
    resolve = fulfill;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

describe('CopyTranslationDialog pending clipboard ownership', () => {
  it('admits one pending write across repeated clicks and different frame rows', async () => {
    const pending = pendingClipboardWrite();
    writeText.mockReturnValueOnce(pending.promise);
    const onClose = vi.fn();
    render(
      <StrictMode>
        <CopyTranslationDialog sequence="ATGAAATAA" onClose={onClose} />
      </StrictMode>
    );
    const first = screen.getByTestId('translation-frame-forward-1');
    fireEvent.click(first);
    fireEvent.click(first);
    fireEvent.click(screen.getByTestId('translation-frame-reverse-1'));
    expect(writeText.mock.calls).toEqual([['MK*']]);
    for (const row of screen.getAllByRole('button', { name: /^Copy .* translation$/ })) {
      expect(row).toBeDisabled();
    }
    await act(async () => pending.resolve());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('releases the pending write after rejection and allows another frame to retry', async () => {
    const pending = pendingClipboardWrite();
    writeText.mockReturnValueOnce(pending.promise);
    const onClose = vi.fn();
    render(<CopyTranslationDialog sequence="ATGAAATAA" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('translation-frame-forward-1'));
    expect(screen.getByTestId('translation-frame-reverse-1')).toBeDisabled();
    await act(async () => pending.reject(new Error('denied')));
    expect(onClose).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].type).toBe('error');
    const retry = screen.getByTestId('translation-frame-reverse-1');
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls).toEqual([['MK*'], ['LFH']]);
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Copied LFH');
  });

  it.each(['success', 'failure'] as const)(
    'keeps a reopened request intact after the cancelled write reports %s',
    async (settlement) => {
      const pending = pendingClipboardWrite();
      writeText.mockReturnValueOnce(pending.promise);
      render(<TranslationDialogHost />);
      act(() =>
        useTranslationDialogStore.getState().open({ sequence: 'ATGAAATAA', label: 'first' })
      );
      fireEvent.click(screen.getByTestId('translation-frame-forward-1'));
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      act(() =>
        useTranslationDialogStore
          .getState()
          .open({ sequence: 'ATGAAATGA', geneticCode: 2, label: 'second' })
      );
      await act(async () => {
        if (settlement === 'success') pending.resolve();
        else pending.reject(new Error('late denied'));
      });
      expect(screen.getByTestId('copy-translation-genetic-code')).toHaveTextContent('second');
      expect(screen.getByTestId('translation-frame-forward-1')).toHaveTextContent('MKW');
      expect(useToastStore.getState().toasts).toHaveLength(0);
      expect(writeText.mock.calls).toEqual([['MK*']]);
      fireEvent.click(screen.getByTestId('translation-frame-forward-1'));
      await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(writeText.mock.calls).toEqual([['MK*'], ['MKW']]);
      expect(useToastStore.getState().toasts).toHaveLength(1);
    }
  );

  it('gives a replacement request its own lifetime even when its payload is identical', async () => {
    const pending = pendingClipboardWrite();
    writeText.mockReturnValueOnce(pending.promise);
    render(<TranslationDialogHost />);
    act(() => useTranslationDialogStore.getState().open({ sequence: 'ATGAAATAA', label: 'same' }));
    fireEvent.click(screen.getByTestId('translation-frame-forward-1'));
    act(() => useTranslationDialogStore.getState().open({ sequence: 'ATGAAATAA', label: 'same' }));
    await act(async () => pending.resolve());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('translation-frame-forward-1')).toBeEnabled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
    fireEvent.click(screen.getByTestId('translation-frame-forward-1'));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writeText.mock.calls).toEqual([['MK*'], ['MK*']]);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});

describe('CopyTranslationDialog physical delivery observation', () => {
  it.each(['success', 'failure'] as const)(
    'settles the accepted write after the dialog retires with %s',
    async (settlement) => {
      const pending = pendingClipboardWrite();
      writeText.mockReturnValueOnce(pending.promise);
      const onClose = vi.fn();
      const view = render(<CopyTranslationDialog sequence="ATGAAATAA" onClose={onClose} />);
      expect(capture.track).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('translation-frame-forward-1'));
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(capture.track).toHaveBeenCalledTimes(1);
      const start = capture.track.mock.calls[0];
      expect(start).toEqual([
        'sequence_translation_copy_observed',
        expect.objectContaining({
          action_phase: 'start',
          translation_copy_result: 'pending',
          translation_copy_strand: 'forward',
          translation_copy_frame: '1',
          translation_copy_code: 'standard',
          translation_copy_length_bucket: '2_5',
        }),
      ]);
      view.unmount();
      await act(async () => {
        if (settlement === 'success') pending.resolve();
        else pending.reject(new DOMException('private error text', 'NotAllowedError'));
      });
      expect(capture.track).toHaveBeenCalledTimes(2);
      expect(capture.track.mock.calls[1]).toEqual([
        'sequence_translation_copy_observed',
        expect.objectContaining({
          action_id: start[1].action_id,
          action_phase: settlement === 'success' ? 'result' : 'error',
          translation_copy_result: settlement === 'success' ? 'delivered' : 'not_allowed',
        }),
      ]);
      expect(JSON.stringify(capture.track.mock.calls)).not.toContain('MK*');
      expect(JSON.stringify(capture.track.mock.calls)).not.toContain('private error text');
      expect(onClose).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts).toHaveLength(0);
    }
  );
});

describe('CopyTranslationDialog safe effective-code observation', () => {
  it.each([
    [1, 'standard'],
    [99999, 'standard'],
    [2, 'nonstandard'],
  ] as const)(
    'reports effective code category for published input %s',
    async (geneticCode, codeCategory) => {
      render(
        <CopyTranslationDialog sequence="ATGAAATAA" geneticCode={geneticCode} onClose={vi.fn()} />
      );
      fireEvent.click(screen.getByTestId('translation-frame-forward-1'));
      await vi.waitFor(() => expect(capture.track).toHaveBeenCalledTimes(2));
      expect(capture.track.mock.calls[0][1]).toMatchObject({ translation_copy_code: codeCategory });
    }
  );
  it('closes successfully when terminal observation throws', async () => {
    capture.track.mockReturnValueOnce(true).mockImplementationOnce(() => {
      throw new Error('telemetry');
    });
    const onClose = vi.fn();
    render(<CopyTranslationDialog sequence="ATGAAATAA" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('translation-frame-forward-1'));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].type).toBe('success');
  });
});
