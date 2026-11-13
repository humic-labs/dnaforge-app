/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EntitySchemaFieldSnapshot } from '../../entity-schema';
import { EntityMetadataFieldEditor } from './EntityMetadataFieldEditor';

describe('shared entity metadata editing', () => {
  it('keeps a required-name error and recovery actions together until discard', async () => {
    const onCommit = vi.fn();
    render(
      <EntityMetadataFieldEditor
        field={{ key: 'name', label: 'Name', type: 'text', required: true }}
        value="Original name"
        onCommit={onCommit}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Name', exact: true }));
    const input = screen.getByRole('textbox', { name: 'Name', exact: true });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByRole('alert');
    const feedback = within(screen.getByRole('group', { name: 'Name save error', exact: true }));
    expect(feedback.getByRole('alert')).toHaveTextContent(/Name.*required.*not been saved/iu);
    expect(
      screen.queryByRole('button', { name: 'Edit Name', exact: true })
    ).not.toBeInTheDocument();
    fireEvent.click(feedback.getByRole('button', { name: 'Retry Name', exact: true }));
    expect(feedback.getByRole('alert')).toBeVisible();
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.click(feedback.getByRole('button', { name: 'Discard Name', exact: true }));
    expect(
      screen.queryByRole('group', { name: 'Name save error', exact: true })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Name', exact: true })).toHaveTextContent(
      'Original name'
    );
    expect(onCommit).not.toHaveBeenCalled();
  });
  it.each([
    { field: { key: 'text', label: 'Text', type: 'text' }, value: 'original', role: 'textbox' },
    {
      field: { key: 'notes', label: 'Notes', type: 'long_text' },
      value: 'original',
      role: 'textbox',
    },
    { field: { key: 'count', label: 'Count', type: 'number' }, value: 3, role: 'spinbutton' },
    { field: { key: 'flag', label: 'Flag', type: 'boolean' }, value: false, role: 'combobox' },
    {
      field: { key: 'choice', label: 'Choice', type: 'enum', enumOptions: ['A', 'B'] },
      value: 'A',
      role: 'combobox',
    },
    { field: { key: 'date', label: 'Date', type: 'date' }, value: '2026-10-22', role: null },
    { field: { key: 'tags', label: 'Tags', type: 'string_array' }, value: ['A'], role: 'textbox' },
    { field: { key: 'code', label: 'Code', type: 'genetic_code' }, value: 1, role: 'combobox' },
  ] satisfies Array<{ field: EntitySchemaFieldSnapshot; value: unknown; role: string | null }>)(
    'Escape leaves $field.type without writing and returns keyboard focus',
    ({ field, value, role }) => {
      const onCommit = vi.fn();
      const documentKey = vi.fn();
      document.addEventListener('keydown', documentKey);
      render(<EntityMetadataFieldEditor field={field} value={value} onCommit={onCommit} />);
      fireEvent.click(screen.getByRole('button', { name: `Edit ${field.label}`, exact: true }));
      const control = role
        ? screen.getByRole(role, { name: field.label, exact: true })
        : screen.getByLabelText(field.label);
      expect(control).toHaveAttribute(
        'data-ui-control',
        role === 'combobox'
          ? 'select'
          : field.type === 'long_text' || field.type === 'string_array'
            ? 'textarea'
            : 'input'
      );
      fireEvent.keyDown(control, { key: 'Escape' });
      expect(
        screen.getByRole('button', { name: `Edit ${field.label}`, exact: true })
      ).toHaveFocus();
      expect(onCommit).not.toHaveBeenCalled();
      expect(documentKey).not.toHaveBeenCalled();
      document.removeEventListener('keydown', documentKey);
    }
  );

  it.each([
    {
      field: { key: 'state', label: 'State', type: 'enum', enumOptions: ['Active', 'Stored'] },
      value: 'Active',
      query: 'stor',
      label: 'Stored',
      expected: 'Stored',
    },
    {
      field: { key: 'flag', label: 'Flag', type: 'boolean' },
      value: true,
      query: 'no',
      label: 'No',
      expected: false,
    },
  ] satisfies Array<{
    field: EntitySchemaFieldSnapshot;
    value: unknown;
    query: string;
    label: string;
    expected: unknown;
  }>)(
    'filters $field.type choices without writing until selection',
    async ({ field, value, query, label, expected }) => {
      const onCommit = vi.fn().mockResolvedValue(undefined);
      render(<EntityMetadataFieldEditor field={field} value={value} onCommit={onCommit} />);
      const trigger = () =>
        screen.getByRole('button', { name: `Edit ${field.label}`, exact: true });
      fireEvent.click(trigger());
      const search = screen.getByRole('searchbox', { name: `Search ${field.label.toLowerCase()}` });
      fireEvent.change(search, { target: { value: query } });
      expect(screen.getAllByRole('option')).toHaveLength(1);
      expect(screen.getByRole('option', { name: label, exact: true })).toBeVisible();
      expect(onCommit).not.toHaveBeenCalled();
      fireEvent.keyDown(search, { key: 'Escape' });
      expect(trigger()).toHaveFocus();
      expect(onCommit).not.toHaveBeenCalled();
      fireEvent.click(trigger());
      expect(screen.getByRole('searchbox')).toHaveValue('');
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: query } });
      fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
      await waitFor(() => expect(onCommit).toHaveBeenCalledExactlyOnceWith(expected));
    }
  );
});
