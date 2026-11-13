/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilterableSelect } from './FilterableSelect';

const options = [
  { value: '', label: 'None (free-form)' },
  { value: 'moclo-cidar', label: 'CIDAR MoClo', hint: 'E. coli' },
  { value: 'ytk', label: 'Yeast Toolkit', hint: 'S. cerevisiae' },
  { value: 'mtk', label: 'Mammalian Toolkit', hint: 'human' },
];

function renderSelect(onChange = vi.fn(), value = '') {
  render(
    <FilterableSelect label="Assembly kit" value={value} options={options} onChange={onChange} />
  );
  return { combobox: screen.getByRole('combobox', { name: 'Assembly kit' }), onChange };
}

describe('FilterableSelect', () => {
  afterEach(cleanup);

  it('shows the selection when closed and opens a filterable list on click', () => {
    const { combobox } = renderSelect(vi.fn(), 'ytk');
    expect(combobox).toHaveValue('Yeast Toolkit');
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.mouseDown(combobox);
    fireEvent.focus(combobox);

    expect(combobox).toHaveAttribute('aria-expanded', 'true');
    expect(combobox).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('filters by name and by hint as the user types', () => {
    const { combobox } = renderSelect();
    fireEvent.focus(combobox);

    fireEvent.change(combobox, { target: { value: 'tool' } });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Yeast ToolkitS. cerevisiae',
      'Mammalian Toolkithuman',
    ]);

    fireEvent.change(combobox, { target: { value: 'cerev' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveTextContent('Yeast Toolkit');

    fireEvent.change(combobox, { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('ranks an earlier match first', () => {
    const { combobox } = renderSelect();
    fireEvent.focus(combobox);
    fireEvent.change(combobox, { target: { value: 'mo' } });
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('CIDAR MoClo');
  });

  it('chooses the filtered match with the keyboard', () => {
    const { combobox, onChange } = renderSelect();
    fireEvent.focus(combobox);
    fireEvent.change(combobox, { target: { value: 'mamm' } });
    fireEvent.keyDown(combobox, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('mtk');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('moves the active option with the arrow keys', () => {
    const { combobox, onChange } = renderSelect();
    fireEvent.focus(combobox);
    fireEvent.keyDown(combobox, { key: 'ArrowDown' });
    fireEvent.keyDown(combobox, { key: 'ArrowDown' });
    fireEvent.keyDown(combobox, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('ytk');
  });

  it('escape closes without changing the selection and restores the label', () => {
    const { combobox, onChange } = renderSelect(vi.fn(), 'mtk');
    fireEvent.focus(combobox);
    fireEvent.change(combobox, { target: { value: 'cid' } });
    fireEvent.keyDown(combobox, { key: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(combobox).toHaveValue('Mammalian Toolkit');
  });

  it('does not report a change when the current selection is chosen again', () => {
    const { combobox, onChange } = renderSelect(vi.fn(), 'ytk');
    fireEvent.focus(combobox);
    fireEvent.click(screen.getByRole('option', { name: /^Yeast Toolkit/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stays closed and unfilterable when disabled', () => {
    render(
      <FilterableSelect
        label="Assembly kit"
        value="ytk"
        options={options}
        onChange={vi.fn()}
        disabled
      />
    );
    const combobox = screen.getByRole('combobox', { name: 'Assembly kit' });
    fireEvent.focus(combobox);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(combobox).toBeDisabled();
  });
});
