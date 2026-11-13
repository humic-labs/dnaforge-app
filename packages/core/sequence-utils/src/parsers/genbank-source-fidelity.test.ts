import { describe, expect, it } from 'vitest';
import { parseGenBankFull } from './genbank';

const source = `LOCUS       source            24 bp    DNA     linear SYN 01-JAN-2000
DEFINITION  Source description.
KEYWORDS    first keyword
            second keyword
FEATURES             Location/Qualifiers
     CDS             1..6
                     /label="Repeated peptide"
                     /note="First exported feature"
     CDS             10..15
                     /label="Repeated peptide"
                     /note="Second exported feature"
     misc_feature    18..24
                     /label="GAL1 promoter"
ORIGIN
        1 acgtacgtacgtacgtacgtacgt
//
`;

describe('GenBank source-feature fidelity', () => {
  it('preserves separate exported features and their types when requested', () => {
    const parsed = parseGenBankFull(source, { featurePolicy: 'preserve' });
    expect(parsed.annotations).toHaveLength(3);
    expect(parsed.annotations.map(({ start, end, type }) => ({ start, end, type }))).toEqual([
      { start: 1, end: 6, type: 'CDS' },
      { start: 10, end: 15, type: 'CDS' },
      { start: 18, end: 24, type: 'misc_feature' },
    ]);
    expect(parsed.annotations[1].qualifiers?.note).toEqual(['Second exported feature']);
  });

  it('keeps legacy inference available for ordinary unmarked source files', () => {
    const parsed = parseGenBankFull(source);
    expect(parsed.annotations).toHaveLength(2);
    expect(parsed.annotations[0].segments).toEqual([
      { start: 1, end: 6 },
      { start: 10, end: 15 },
    ]);
    expect(parsed.annotations[1].type).toBe('promoter');
  });

  it('does not merge native source-marked features on reopen', () => {
    const marked = source.replace(
      /\/label="Repeated peptide"/g,
      '/dnaforge_original_type="CDS"\n                     /label="Repeated peptide"'
    );
    const parsed = parseGenBankFull(marked);
    expect(parsed.annotations).toHaveLength(3);
    expect(parsed.annotations[1].qualifiers?.note).toEqual(['Second exported feature']);
  });

  it('does not append another header field continuation to the description', () => {
    expect(parseGenBankFull(source).description).toBe('Source description.');
  });
});
