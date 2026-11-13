import { describe, expect, it } from 'vitest';
import { parseGenBankFull } from '../parsers/genbank';
import { serializeGenBank } from './genbank';

describe('portable GenBank LOCUS headers', () => {
  it.each([
    'pUC19',
    'Sundew with spaces',
    '100%20 literal',
    'α experiment 🧬',
    'Long_Name_'.repeat(12),
  ])('preserves the full display name %s with a whitespace-free locus identifier', (name) => {
    const content = serializeGenBank({
      id: 'fixture',
      name,
      sequence: 'ACGT',
      length: 4,
      circular: true,
      annotations: [],
    });
    const fields = content.split('\n')[0].split(/\s+/);
    expect(fields).toEqual([
      'LOCUS',
      expect.any(String),
      '4',
      'bp',
      'DNA',
      'circular',
      'UNK',
      expect.any(String),
    ]);
    expect(parseGenBankFull(content)).toMatchObject({
      name,
      length: 4,
      circular: true,
      sequence: 'ACGT',
    });
    expect(parseGenBankFull(serializeGenBank(parseGenBankFull(content))).name).toBe(name);
  });

  it.each([true, false])(
    'uses the standard fixed columns for short names and circular=%s',
    (circular) => {
      const header = serializeGenBank({
        id: 'fixture',
        name: 'pUC19',
        length: 4,
        sequence: 'ACGT',
        annotations: [],
        circular,
      }).split('\n')[0];
      expect(header).toHaveLength(79);
      expect(header.slice(12, 40).trim().split(/\s+/)).toEqual(['pUC19', '4']);
      expect(header.slice(40, 44)).toBe(' bp ');
      expect(header.slice(47, 54).trim()).toBe('DNA');
      expect(header.slice(55, 63).trim()).toBe(circular ? 'circular' : 'linear');
      expect(header.slice(64, 67)).toBe('UNK');
    }
  );

  it('does not decode percent text in ordinary source names', () => {
    expect(
      parseGenBankFull('LOCUS       source%20name 4 bp DNA linear\nORIGIN\n 1 acgt\n//\n').name
    ).toBe('source%20name');
  });
});
