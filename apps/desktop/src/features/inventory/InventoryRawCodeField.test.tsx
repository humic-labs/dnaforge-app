import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { InventoryRawCodeField } from './InventoryRawCodeField';
import { inventoryCodeInput } from './inventory-code-input';

it('preserves pasted interior CRLF before validating the complete raw value', () => {
  const onChange = vi.fn();
  render(<InventoryRawCodeField label="Code" value="AB" onChange={onChange} />);
  const field = screen.getByLabelText('Code') as HTMLTextAreaElement;
  field.setSelectionRange(1, 1);
  fireEvent.paste(field, { clipboardData: { getData: () => '00\r\n123' } });
  expect(onChange).toHaveBeenCalledWith('A00\r\n123B');
  expect(inventoryCodeInput(onChange.mock.calls[0][0]).value).toBe('A00\r\n123B');
});

it('uses Enter for an explicit check without inserting a newline or submitting a mutation', () => {
  const onChange = vi.fn();
  const onEnter = vi.fn();
  render(
    <InventoryRawCodeField label="Code" value="00123" onChange={onChange} onEnter={onEnter} />
  );
  expect(fireEvent.keyDown(screen.getByLabelText('Code'), { key: 'Enter' })).toBe(false);
  expect(onEnter).toHaveBeenCalledOnce();
  expect(onChange).not.toHaveBeenCalled();
});
