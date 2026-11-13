import { describe, it, expect } from 'vitest';
import { translateCodon } from './translation';
import {
  backtranslate,
  InvalidAminoAcidResidueError,
  UnsupportedBacktranslateHostError,
} from './backtranslate';
import {
  SUPPORTED_BACKTRANSLATE_HOSTS,
  type SupportedBacktranslateHost,
} from './codon-usage-tables';

const ALL_20_AA = 'ACDEFGHIKLMNPQRSTVWY';

function translateBack(dna: string): string {
  let protein = '';
  for (let i = 0; i < dna.length; i += 3) {
    protein += translateCodon(dna.slice(i, i + 3));
  }
  return protein;
}

describe('backtranslate  slice 2.5)', () => {
  for (const host of SUPPORTED_BACKTRANSLATE_HOSTS) {
    describe(host, () => {
      it('round-trips a single residue', () => {
        const dna = backtranslate('M', host);
        expect(dna.length).toBe(3);
        expect(translateBack(dna)).toBe('M');
      });

      it('round-trips a sequence containing every one of the 20 standard amino acids', () => {
        const dna = backtranslate(ALL_20_AA, host);
        expect(dna.length).toBe(ALL_20_AA.length * 3);
        expect(translateBack(dna)).toBe(ALL_20_AA);
      });

      it('round-trips a realistic protein sequence (GFP)', () => {
        const gfp =
          'MSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKLTLKFICTTGKLPVPWPTLVTTLTYGVQCFSRYPDHMKQHDFFKSAMPEGYVQERTIFFKDDGNYKTRAEVKFEGDTLVNRIELKGIDFKEDGNILGHKLEYNYNSHNVYIMADKQKNGIKVNFKIRHNIEDGSVQLADHYQQNTPIGDGPVLLPDNHYLSTQSALSKDPNEKRDHMVLLEFVTAAGITHGMDELYK';
        const dna = backtranslate(gfp, host);
        expect(translateBack(dna)).toBe(gfp);
      });

      it('is case- and whitespace-insensitive', () => {
        const dna = backtranslate(' m s k \n', host);
        expect(translateBack(dna)).toBe('MSK');
      });
    });
  }

  it('produces host-specific codon choices (E. coli vs S. cerevisiae differ for Arg)', () => {
    const ecoli = backtranslate('R', 'E_COLI_K12');
    const yeast = backtranslate('R', 'S_CEREVISIAE');
    expect(ecoli).not.toBe(yeast);
    expect(ecoli).toBe('CGC');
    expect(yeast).toBe('AGA');
  });

  it('rejects an unsupported host, never silently falling back to another table', () => {
    expect(() => backtranslate('MSK', 'H_SAPIENS' as SupportedBacktranslateHost)).toThrow(
      UnsupportedBacktranslateHostError
    );
  });

  it('rejects an unknown-residue (X) character with a clear error', () => {
    expect(() => backtranslate('MSKX', 'E_COLI_K12')).toThrow(InvalidAminoAcidResidueError);
  });

  it('rejects a stop codon (*) character with a clear error, never guessing a stop codon', () => {
    expect(() => backtranslate('MSK*', 'E_COLI_K12')).toThrow(InvalidAminoAcidResidueError);
  });

  it('rejects a gap character with a clear error', () => {
    expect(() => backtranslate('MS-K', 'E_COLI_K12')).toThrow(InvalidAminoAcidResidueError);
  });
});
