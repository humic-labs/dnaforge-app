/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BacktranslateResultDialog } from './BacktranslateResultDialog';

vi.stubGlobal('navigator', {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

afterEach(cleanup);

const SEQ = 'MSKGEELFTGVVPILVELDGDVNGHKFSVSGEG';

describe('BacktranslateResultDialog', () => {
  it('renders nothing when sequence is null', () => {
    render(<BacktranslateResultDialog sequence={null} onClose={vi.fn()} />);
    expect(screen.queryByTestId('backtranslate-result-dialog')).toBeNull();
  });

  it('shows a codon-optimized DNA result for the default host', () => {
    render(<BacktranslateResultDialog sequence={SEQ} onClose={vi.fn()} />);
    const body = screen.getByTestId('backtranslate-result-body').textContent!;
    expect(body.length).toBe(SEQ.length * 3);
    expect(/^[ACGT]+$/.test(body)).toBe(true);
  });

  it('changing the host recomputes the result', () => {
    render(<BacktranslateResultDialog sequence={SEQ} onClose={vi.fn()} />);
    const before = screen.getByTestId('backtranslate-result-body').textContent;
    fireEvent.change(screen.getByTestId('backtranslate-host-select'), {
      target: { value: 'S_CEREVISIAE' },
    });
    const after = screen.getByTestId('backtranslate-result-body').textContent;
    expect(after).not.toBe(before);
  });

  it('shows an error, not a crash, for an unbacktranslatable residue (X)', () => {
    render(<BacktranslateResultDialog sequence="MSXKG" onClose={vi.fn()} />);
    expect(screen.getByTestId('backtranslate-result-error')).toBeTruthy();
    expect(screen.getByTestId('backtranslate-result-copy')).toBeDisabled();
  });

  it('Copy writes the result to the clipboard', async () => {
    render(<BacktranslateResultDialog sequence={SEQ} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('backtranslate-result-copy'));
    await waitFor(() =>
      expect(navigator.clipboard.writeText as ReturnType<typeof vi.fn>).toHaveBeenCalled()
    );
  });

  it('Close fires onClose', () => {
    const onClose = vi.fn();
    render(<BacktranslateResultDialog sequence={SEQ} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('backtranslate-result-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves DOM focus into the dialog on open (so a Cmd+C/select-text gesture lands inside it, not the sequence canvas behind it)', () => {
    render(<BacktranslateResultDialog sequence={SEQ} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByTestId('backtranslate-host-select'));
  });
});
