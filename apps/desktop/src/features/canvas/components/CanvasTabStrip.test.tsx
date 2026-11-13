import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
