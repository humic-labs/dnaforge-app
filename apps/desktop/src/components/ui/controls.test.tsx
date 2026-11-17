import { createRef } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button, Select, TextField } from './index';

describe('shared app form controls', () => {
  it('searches rich choices, respects composition, and commits the filtered keyboard choice', async () => {
    const onValueChange = vi.fn();
    render(
      <Select
        ariaLabel="Code"
        value="A"
        searchable
        defaultOpen
        options={[
          { value: 'A', label: <span>Alpha</span>, searchText: 'Alpha' },
          { value: 'B', label: <span>Beta</span>, searchText: 'Beta' },
        ]}
        onValueChange={onValueChange}
      />
    );
    const search = screen.getByRole('searchbox', { name: 'Search options' });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: 'Beta' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true });
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('B');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes an open choice menu on Escape without invoking the parent dismissal handler', () => {
    const parentKey = vi.fn();
    render(
      <div onKeyDown={parentKey}>
        <Select
          ariaLabel="State"
          value="A"
          defaultOpen
          options={[{ value: 'A', label: 'Active' }]}
          onValueChange={vi.fn()}
        />
      </div>
    );
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'State' }), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(parentKey).not.toHaveBeenCalled();
  });

  it('reports accepting the current value without emitting a changed-value write', () => {
    const onSelect = vi.fn();
    const onValueChange = vi.fn();
    render(
      <Select
        ariaLabel="State"
        value="A"
        defaultOpen
        options={[{ value: 'A', label: 'Active' }]}
        onValueChange={onValueChange}
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByRole('option', { name: 'Active' }));
    expect(onValueChange).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('A');
  });
  it.each([undefined, true])(
    'retains portal privacy and selection with privateContent=%s',
    async (privateContent) => {
      const change = vi.fn();
      render(
        <Select
          ariaLabel="Synthetic choice"
          value="current"
          options={[
            { value: 'current', label: 'Current' },
            { value: 'alternative', label: 'Alternative' },
          ]}
          onValueChange={change}
          privateContent={privateContent}
        />
      );
      fireEvent.click(screen.getByRole('combobox', { name: 'Synthetic choice' }));
      const menu = await screen.findByRole('listbox', { name: 'Synthetic choice' });
      for (const attribute of ['data-ph-no-capture', 'data-analytics-block', 'data-ph-mask']) {
        if (privateContent) expect(menu).toHaveAttribute(attribute);
        else expect(menu).not.toHaveAttribute(attribute);
      }
      if (privateContent) expect(menu).toHaveClass('ph-no-capture', 'rr-block');
      else {
        expect(menu).not.toHaveClass('ph-no-capture');
        expect(menu).not.toHaveClass('rr-block');
      }
      fireEvent.click(within(menu).getByRole('option', { name: 'Alternative' }));
      expect(change).toHaveBeenCalledExactlyOnceWith('alternative');
      expect(screen.queryByRole('listbox', { name: 'Synthetic choice' })).not.toBeInTheDocument();
    }
  );

  it('preserves native refs and submits only an explicitly marked submit action', () => {
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const field = createRef<HTMLInputElement>();
    const action = createRef<HTMLButtonElement>();
    render(
      <form onSubmit={submit}>
        <TextField aria-label="Name" ref={field} defaultValue="Example" />
        <Button ref={action}>Open preview</Button>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </form>
    );
    expect(field.current).toBe(screen.getByRole('textbox', { name: 'Name' }));
    expect(action.current).toBe(screen.getByRole('button', { name: 'Open preview' }));
    fireEvent.click(action.current!);
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(submit).toHaveBeenCalledOnce();
  });
});
