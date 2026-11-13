import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { builtinPrimerSchemaView } from '../primer-entity-schema';
import { PrimerSchemaFields } from './PrimerSchemaFields';

describe('PrimerSchemaFields', () => {
  it('shows the schema fields directly, including empty optional fields', () => {
    const schema = builtinPrimerSchemaView();
    const onValuesChange = vi.fn();
    render(
      <PrimerSchemaFields
        schemas={[schema]}
        selectedSchemaId={schema.schemaId}
        values={{ vendor: 'IDT' }}
        onSelectSchema={vi.fn()}
        onValuesChange={onValuesChange}
      />
    );

    expect(screen.getByLabelText('Vendor')).toHaveValue('IDT');
    expect(screen.getByLabelText('Purification')).toHaveValue('');
    expect(screen.getByLabelText('Notes')).toHaveValue('');
    const schemaPicker = screen.getByRole('combobox', { name: 'Schema' });
    expect(schemaPicker).toHaveAttribute('aria-required', 'true');
    expect(screen.getByText('Schema *')).toBeInTheDocument();
    fireEvent.click(schemaPicker);
    expect(screen.getByRole('listbox', { name: 'Schema' })).toBeVisible();
    fireEvent.keyDown(schemaPicker, { key: 'Escape' });
    expect(screen.queryByLabelText('Add schema field')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entity-schema-field-sequence')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Purification'), { target: { value: 'HPLC' } });
    expect(onValuesChange).toHaveBeenCalledWith({ vendor: 'IDT', purification: 'HPLC' });
  });

  it('preserves schema order and edits boolean, number, date and enum fields', () => {
    const schema = {
      ...builtinPrimerSchemaView(),
      fields: [
        { key: 'approved', label: 'Approved', type: 'boolean' as const },
        { key: 'amount', label: 'Amount', type: 'number' as const, required: true },
        { key: 'received', label: 'Received', type: 'date' as const },
        {
          key: 'batch',
          label: 'Batch',
          type: 'enum' as const,
          required: true,
          enumOptions: ['A', 'B'],
        },
      ],
    };
    const onValuesChange = vi.fn();
    render(
      <PrimerSchemaFields
        schemas={[schema]}
        selectedSchemaId={schema.schemaId}
        values={{ approved: false, amount: '12', received: '2026-10-02', batch: 'A' }}
        onSelectSchema={vi.fn()}
        onValuesChange={onValuesChange}
      />
    );

    const fields = screen
      .getByTestId('primer-schema-fields')
      .querySelectorAll('[data-testid^="entity-schema-field-"]');
    expect(Array.from(fields, (field) => field.getAttribute('data-testid'))).toEqual([
      'entity-schema-field-approved',
      'entity-schema-field-amount',
      'entity-schema-field-received',
      'entity-schema-field-batch',
    ]);
    expect(screen.getByLabelText(/Amount/)).toBeRequired();
    expect(screen.getByLabelText('Received')).toHaveValue('2026-10-02');
    fireEvent.click(screen.getByLabelText('Approved'));
    expect(onValuesChange).toHaveBeenLastCalledWith(expect.objectContaining({ approved: true }));
    const batch = screen.getByRole('combobox', { name: 'Batch' });
    expect(batch).toHaveAttribute('aria-required', 'true');
    fireEvent.keyDown(batch, { key: 'ArrowDown' });
    fireEvent.keyDown(batch, { key: 'ArrowDown' });
    fireEvent.keyDown(batch, { key: 'Enter' });
    expect(onValuesChange).toHaveBeenLastCalledWith(expect.objectContaining({ batch: 'B' }));
  });
});
