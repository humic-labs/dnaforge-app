import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ColorPaletteSelector } from './annotation-fields';
import { initAddState, initEditState } from './helpers';

afterEach(cleanup);

describe('annotation color selection', () => {
  it('retains named palettes and applies the selected palette swatch', () => {
    const onChange = vi.fn();
    const { container } = render(<ColorPaletteSelector value="#123456" onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Annotation color palette' }));
    expect(screen.getAllByRole('option').map((button) => button.textContent)).toEqual([
      'Classic',
      'Vivid',
      'Pastel',
      'Bold',
      'Accessible',
      'Muted',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'Accessible' }));
    const swatches = container.querySelectorAll<HTMLButtonElement>(
      'button[style*="background-color"]'
    );
    expect(swatches).toHaveLength(10);
    expect(swatches[0]).toHaveStyle({ backgroundColor: '#000000' });
    expect(swatches[9]).toHaveStyle({ backgroundColor: '#88CCEE' });
    fireEvent.click(swatches[9]!);
    expect(onChange).toHaveBeenCalledWith('#88CCEE');
  });

  it('preserves saved and drafted custom colors while keeping the classic default', () => {
    expect(
      initEditState({ name: 'Custom', type: 'gene', start: 1, end: 8, color: '#123456' }).color
    ).toBe('#123456');
    expect(
      initAddState(
        { name: 'Draft', type: 'gene', start: 1, end: 8, direction: 1, color: '#abcdef' },
        null
      ).color
    ).toBe('#abcdef');
    expect(initAddState(null, null).color).toBe('#4E79A7');
    expect(initEditState({ name: 'Default', type: 'gene', start: 1, end: 8 }).color).toBe(
      '#4E79A7'
    );
  });
});
