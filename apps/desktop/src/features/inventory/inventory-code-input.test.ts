import { expect, it } from 'vitest';
import { inventoryCodeInput, inventoryRawTextOffset } from './inventory-code-input';

it('preserves code case, zeros and spaces while removing only one declared trailing terminator', () => {
  for (const suffix of ['', '\r\n', '\n', '\r'])
    expect(inventoryCodeInput(` 00AbC ${suffix}`).value).toBe(' 00AbC ');
  expect(inventoryCodeInput('00\n123\n')).toEqual({
    raw: '00\n123\n',
    value: '00\n123',
    terminator: 'LF',
  });
  expect(inventoryCodeInput('00123\r\n\r\n').value).toBe('00123\r\n');
  expect(inventoryCodeInput('00123\t').value).toBe('00123\t');
});

it('maps a textarea selection back to the captured raw pasted text', () => {
  const raw = '00\r\nAb\rC';
  expect(raw.slice(0, inventoryRawTextOffset(raw, 4))).toBe('00\r\nA');
  expect(raw.slice(inventoryRawTextOffset(raw, 6))).toBe('C');
});
