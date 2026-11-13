// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  formatIndexedCoordinateInput,
  formatIndexedCoordinateInputEdit,
  parseIndexedCoordinateInput,
} from './indexed-coordinate-input';

describe('indexed coordinate input', () => {
  it.each([
    ['', ''],
    ['1', '1'],
    ['999', '999'],
    ['1000', '1,000'],
    ['123456789', '123,456,789'],
    ['1,234_567', '1,234,567'],
    [' 1234567 ', '1,234,567'],
  ])('formats numeric assembly coordinates (%s)', (input, expected) => {
    expect(formatIndexedCoordinateInput(input)).toBe(expected);
  });

  it('does not silently reinterpret unsupported coordinate syntax', () => {
    expect(formatIndexedCoordinateInput('chr17:43,044,294')).toBe('chr17:43,044,294');
    expect(formatIndexedCoordinateInputEdit('1abc2', 3)).toEqual({
      value: '1abc2',
      selectionStart: 3,
    });
  });

  it.each([
    ['1,2934,567', 4, '12,934,567', 4],
    ['1234567', 7, '1,234,567', 9],
    ['1234567', 0, '1,234,567', 0],
    ['1234567', null, '1,234,567', 9],
    ['', 0, '', 0],
    ['1,234', 1, '1,234', 1],
  ] as const)(
    'preserves the caret for %s at %s',
    (input, selectionStart, expectedValue, expectedSelectionStart) => {
      expect(formatIndexedCoordinateInputEdit(input, selectionStart)).toEqual({
        value: expectedValue,
        selectionStart: expectedSelectionStart,
      });
    }
  );

  it.each([
    ['1', 1],
    ['1,234,567', 1_234_567],
    ['1_234 567', 1_234_567],
    ['', null],
    ['0', null],
    ['chr17:43,044,294', null],
    ['1abc2', null],
    ['999999999999999999999999', null],
  ] as const)('parses %s without joining unsupported digit groups', (input, expected) => {
    expect(parseIndexedCoordinateInput(input)).toBe(expected);
  });
});
