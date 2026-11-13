import { describe, expect, it } from 'vitest';
import { normalizePlainDnaClipboardText } from './clipboard';

describe('normalizePlainDnaClipboardText', () => {
  it('accepts whitespace-delimited IUPAC DNA and normalizes RNA uracil', () => {
    expect(normalizePlainDnaClipboardText('ACGT RYSW\nKMBD HVNU')).toBe('ACGTRYSWKMBDHVNT');
  });

  it('rejects formatted sequence records instead of extracting DNA-looking letters', () => {
    expect(
      normalizePlainDnaClipboardText('LOCUS pUC19 2686 bp DNA\nFEATURES Location/Qualifiers')
    ).toBeNull();
  });
});
