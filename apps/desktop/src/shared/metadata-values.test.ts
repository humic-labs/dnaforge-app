import { describe, expect, it } from 'vitest';
import { metadataValuesEqual, metadataFieldDraftValue } from './metadata-values';

describe('saved metadata comparisons', () => {
  it.each([
    ['text', '', undefined],
    ['long_text', '', null],
    ['number', null, undefined],
    ['boolean', null, undefined],
    ['string_array', [], undefined],
  ])('restores the original empty %s value after an edit is reverted', (type, draft, saved) => {
    expect(metadataFieldDraftValue({ type }, draft, saved)).toBe(saved);
  });
  it.each([
    ['text', '', 'IDT'],
    ['long_text', '', 'Primer pane metadata round trip'],
    ['number', null, 3],
    ['enum', null, 'HPLC'],
    ['string_array', [], ['one']],
  ])('removes a cleared saved %s value', (type, draft, saved) => {
    expect(metadataFieldDraftValue({ type }, draft, saved)).toBeNull();
  });
  it.each([
    ['number', 0],
    ['boolean', false],
  ])('keeps the real %s value %j', (type, value) => {
    expect(metadataFieldDraftValue({ type }, value, undefined)).toBe(value);
  });
  it('ignores object insertion order and absent undefined values', () => {
    expect(
      metadataValuesEqual(
        { a: 0, b: { x: false, y: ['one', 'two'] } },
        {
          b: { y: ['one', 'two'], x: false },
          a: 0,
          empty: undefined,
        }
      )
    ).toBe(true);
  });
  it.each([
    [0, null],
    [false, ''],
    [null, undefined],
    [
      ['one', 'two'],
      ['two', 'one'],
    ],
    [{ genotype: 'MATa' }, { genotype: 'MATα' }],
  ])('retains a real change from %j to %j', (current, saved) => {
    expect(metadataValuesEqual(current, saved)).toBe(false);
  });
});
