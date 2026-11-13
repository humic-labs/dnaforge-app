import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TableToolbar } from './TableToolbar';

function setup(copy = vi.fn(async () => {}), replace = vi.fn(() => true)) {
  const view = render(
    <TableToolbar
      rows={3}
      cols={3}
      onAddRow={vi.fn()}
      onRemoveRow={vi.fn()}
      onAddColumn={vi.fn()}
      onRemoveColumn={vi.fn()}
      onExportCSV={vi.fn()}
      onCopyToClipboard={copy}
      onReplaceTable={replace}
    />
  );
  return { ...view, copy, replace };
}

describe('table Copy fulfillment and explicit replacement UI', () => {
  it('does not acknowledge or duplicate a pending copy; only fulfillment shows Copied', async () => {
    let finish!: () => void;
    const copy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    setup(copy);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.getByRole('button', { name: 'Copying…' })).toBeDisabled();
    expect(screen.queryByText('✓ Copied')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copying…' }));
    expect(copy).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    expect(screen.getByRole('button', { name: '✓ Copied' })).toBeEnabled();
  });

  it.each(['rejected', 'unsupported'] as const)(
    'retains an honest retry after %s clipboard write',
    async (kind) => {
      const copy = vi.fn(async () => {});
      copy.mockRejectedValueOnce(new Error(kind));
      setup(copy);
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not copy'));
      expect(screen.queryByText('✓ Copied')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Retry copy' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '✓ Copied' })).toBeInTheDocument()
      );
      expect(copy).toHaveBeenCalledTimes(2);
    }
  );

  it('requires a separate deliberate replacement confirmation and supports cancel without mutation', () => {
    const { replace } = setup();
    expect(
      screen.queryByRole('textbox', { name: 'Replacement table data' })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replace table…' }));
    const input = screen.getByRole('textbox', { name: 'Replacement table data' });
    fireEvent.change(input, { target: { value: 'X\tY' } });
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText(/Undo restores the previous cells and size/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(replace).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('textbox', { name: 'Replacement table data' })
    ).not.toBeInTheDocument();
  });

  it('retains a rejected replacement draft for retry and clears it only after confirmation', () => {
    const replace = vi.fn(() => true).mockReturnValueOnce(false);
    setup(undefined, replace);
    fireEvent.click(screen.getByRole('button', { name: 'Replace table…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Replacement table data' }), {
      target: { value: 'X\tY' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Replace all cells' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Replacement was not confirmed');
    expect(screen.getByRole('textbox', { name: 'Replacement table data' })).toHaveValue('X\tY');
    fireEvent.click(screen.getByRole('button', { name: 'Replace all cells' }));
    expect(replace).toHaveBeenLastCalledWith('X\tY', '');
    expect(
      screen.queryByRole('textbox', { name: 'Replacement table data' })
    ).not.toBeInTheDocument();
  });

  it('preserves the current HTML paste but discards that flavor after a deliberate text edit', () => {
    const { replace } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Replace table…' }));
    const input = screen.getByRole('textbox', { name: 'Replacement table data' });
    const html = '<table><tr><td><b>X</b></td></tr></table>';
    fireEvent.paste(input, {
      clipboardData: { getData: (type: string) => (type === 'text/html' ? html : 'X') },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Replace all cells' }));
    expect(replace).toHaveBeenCalledWith('X', html);
    fireEvent.click(screen.getByRole('button', { name: 'Replace table…' }));
    const edited = screen.getByRole('textbox', { name: 'Replacement table data' });
    fireEvent.paste(edited, {
      clipboardData: { getData: (type: string) => (type === 'text/html' ? html : 'X') },
    });
    fireEvent.change(edited, { target: { value: 'Y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace all cells' }));
    expect(replace).toHaveBeenLastCalledWith('Y', '');
  });

  it('uses the canonical blocked surface for all new content-bearing replacement controls', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Replace table…' }));
    const form = screen.getByRole('form', { name: 'Replace table' });
    expect(form).toHaveClass('ph-no-capture');
    expect(form).toHaveAttribute('data-analytics-block', 'true');
    expect(form).toHaveAttribute('data-ph-no-capture');
    expect(form).toHaveAttribute('data-ph-mask', 'true');
  });
});
