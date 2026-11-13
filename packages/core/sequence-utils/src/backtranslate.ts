import {
  CODON_USAGE_TABLES,
  isSupportedBacktranslateHost,
  SUPPORTED_BACKTRANSLATE_HOSTS,
} from './codon-usage-tables';

export class UnsupportedBacktranslateHostError extends Error {
  constructor(host: string) {
    super(
      `Unsupported backtranslate host "${host}". Supported hosts: ` +
        `${SUPPORTED_BACKTRANSLATE_HOSTS.join(', ')}.`
    );
    this.name = 'UnsupportedBacktranslateHostError';
  }
}

export class InvalidAminoAcidResidueError extends Error {
  constructor(residue: string, index: number) {
    super(
      `Cannot backtranslate residue "${residue}" at position ${index + 1}: only the 20 ` +
        `standard amino acids are supported (no X/ambiguity codes, no stop codons, no gaps).`
    );
    this.name = 'InvalidAminoAcidResidueError';
  }
}

const STANDARD_AMINO_ACIDS = new Set('ACDEFGHIKLMNPQRSTVWY'.split(''));

export function backtranslate(aaSequence: string, host: string): string {
  if (!isSupportedBacktranslateHost(host)) {
    throw new UnsupportedBacktranslateHostError(host);
  }
  const table = CODON_USAGE_TABLES[host];
  const cleaned = aaSequence.replace(/\s/g, '').toUpperCase();

  let dna = '';
  for (let i = 0; i < cleaned.length; i++) {
    const residue = cleaned[i];
    if (!STANDARD_AMINO_ACIDS.has(residue)) {
      throw new InvalidAminoAcidResidueError(residue, i);
    }
    dna += table[residue][0].codon;
  }
  return dna;
}
