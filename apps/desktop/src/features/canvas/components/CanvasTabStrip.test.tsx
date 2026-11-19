import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_TAB_TRANSFER_EVENT } from '../../terminal/public/tab-transfer';
import { CanvasTabStrip, RuntimeCanvasTab } from './CanvasTabStrip';

describe('RuntimeCanvasTab', () => {
  it('uses the shared tab treatment and selects an inactive runtime document', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <CanvasTabStrip panelId="runtime">
        <RuntimeCanvasTab
          id="sequences/first.gb"
          label="first.gb"
          type="sequence"
          selected={false}
          onSelect={onSelect}
          onClose={onClose}
        />
        <RuntimeCanvasTab
          id="sequences/second.gb"
          label="second.gb"
          type="sequence"
          selected
          onSelect={onSelect}
        />
      </CanvasTabStrip>
    );

    expect(screen.getByRole('tab', { name: 'first' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'second' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: 'first' }));
    expect(onSelect).toHaveBeenCalledWith('sequences/first.gb');

    fireEvent.click(screen.getByRole('button', { name: 'Close first.gb' }));
    expect(onClose).toHaveBeenCalledWith('sequences/first.gb');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

it('places a dragged shell in the panel that owns the drop strip', () => {
  render(<CanvasTabStrip panelId="second-panel">{null}</CanvasTabStrip>);
  const transfer = vi.fn();
  window.addEventListener(TERMINAL_TAB_TRANSFER_EVENT, transfer);
  try {
    const strip = screen.getByTestId('tabbar-second-panel');
    const type = 'application/x-dnaforge-terminal';
    const dataTransfer = {
      types: [type],
      getData: (format: string) => (format === type ? 'live-shell' : ''),
    };
    expect(fireEvent.dragOver(strip, { dataTransfer })).toBe(false);
    fireEvent.drop(strip, { dataTransfer });
    expect(transfer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        detail: { target: 'editor', sessionId: 'live-shell', panelId: 'second-panel' },
      })
    );
    const file = { types: ['Files'], getData: () => '' };
    expect(fireEvent.dragOver(strip, { dataTransfer: file })).toBe(true);
    fireEvent.drop(strip, { dataTransfer: file });
    expect(transfer).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener(TERMINAL_TAB_TRANSFER_EVENT, transfer);
  }
});
