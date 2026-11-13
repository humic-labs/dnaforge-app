export const SUPPORTED_BACKTRANSLATE_HOSTS = ['E_COLI_K12', 'S_CEREVISIAE'] as const;
export type SupportedBacktranslateHost = (typeof SUPPORTED_BACKTRANSLATE_HOSTS)[number];

export const BACKTRANSLATE_HOST_LABELS: Record<SupportedBacktranslateHost, string> = {
  E_COLI_K12: 'Escherichia coli K12',
  S_CEREVISIAE: 'Saccharomyces cerevisiae',
};

export interface CodonUsageEntry {
  codon: string;
  fraction: number;
}

export type CodonUsageTable = Record<string, CodonUsageEntry[]>;

function sorted(entries: CodonUsageEntry[]): CodonUsageEntry[] {
  return [...entries].sort((a, b) => b.fraction - a.fraction);
}

const E_COLI_K12: CodonUsageTable = {
  A: sorted([
    { codon: 'GCT', fraction: 0.11 },
    { codon: 'GCC', fraction: 0.31 },
    { codon: 'GCA', fraction: 0.21 },
    { codon: 'GCG', fraction: 0.38 },
  ]),
  R: sorted([
    { codon: 'CGT', fraction: 0.36 },
    { codon: 'CGC', fraction: 0.44 },
    { codon: 'CGA', fraction: 0.07 },
    { codon: 'CGG', fraction: 0.07 },
    { codon: 'AGA', fraction: 0.02 },
    { codon: 'AGG', fraction: 0.03 },
  ]),
  N: sorted([
    { codon: 'AAT', fraction: 0.47 },
    { codon: 'AAC', fraction: 0.53 },
  ]),
  D: sorted([
    { codon: 'GAT', fraction: 0.65 },
    { codon: 'GAC', fraction: 0.35 },
  ]),
  C: sorted([
    { codon: 'TGT', fraction: 0.42 },
    { codon: 'TGC', fraction: 0.58 },
  ]),
  Q: sorted([
    { codon: 'CAA', fraction: 0.3 },
    { codon: 'CAG', fraction: 0.7 },
  ]),
  E: sorted([
    { codon: 'GAA', fraction: 0.7 },
    { codon: 'GAG', fraction: 0.3 },
  ]),
  G: sorted([
    { codon: 'GGT', fraction: 0.29 },
    { codon: 'GGC', fraction: 0.46 },
    { codon: 'GGA', fraction: 0.13 },
    { codon: 'GGG', fraction: 0.12 },
  ]),
  H: sorted([
    { codon: 'CAT', fraction: 0.55 },
    { codon: 'CAC', fraction: 0.45 },
  ]),
  I: sorted([
    { codon: 'ATT', fraction: 0.58 },
    { codon: 'ATC', fraction: 0.35 },
    { codon: 'ATA', fraction: 0.07 },
  ]),
  L: sorted([
    { codon: 'TTA', fraction: 0.15 },
    { codon: 'TTG', fraction: 0.12 },
    { codon: 'CTT', fraction: 0.12 },
    { codon: 'CTC', fraction: 0.1 },
    { codon: 'CTA', fraction: 0.05 },
    { codon: 'CTG', fraction: 0.46 },
  ]),
  K: sorted([
    { codon: 'AAA', fraction: 0.73 },
    { codon: 'AAG', fraction: 0.27 },
  ]),
  M: sorted([{ codon: 'ATG', fraction: 1.0 }]),
  F: sorted([
    { codon: 'TTT', fraction: 0.57 },
    { codon: 'TTC', fraction: 0.43 },
  ]),
  P: sorted([
    { codon: 'CCT', fraction: 0.17 },
    { codon: 'CCC', fraction: 0.13 },
    { codon: 'CCA', fraction: 0.14 },
    { codon: 'CCG', fraction: 0.55 },
  ]),
  S: sorted([
    { codon: 'TCT', fraction: 0.11 },
    { codon: 'TCC', fraction: 0.11 },
    { codon: 'TCA', fraction: 0.15 },
    { codon: 'TCG', fraction: 0.16 },
    { codon: 'AGT', fraction: 0.14 },
    { codon: 'AGC', fraction: 0.33 },
  ]),
  T: sorted([
    { codon: 'ACT', fraction: 0.16 },
    { codon: 'ACC', fraction: 0.47 },
    { codon: 'ACA', fraction: 0.13 },
    { codon: 'ACG', fraction: 0.24 },
  ]),
  W: sorted([{ codon: 'TGG', fraction: 1.0 }]),
  Y: sorted([
    { codon: 'TAT', fraction: 0.53 },
    { codon: 'TAC', fraction: 0.47 },
  ]),
  V: sorted([
    { codon: 'GTT', fraction: 0.25 },
    { codon: 'GTC', fraction: 0.18 },
    { codon: 'GTA', fraction: 0.17 },
    { codon: 'GTG', fraction: 0.4 },
  ]),
  '*': sorted([
    { codon: 'TAA', fraction: 0.64 },
    { codon: 'TAG', fraction: 0.0 },
    { codon: 'TGA', fraction: 0.36 },
  ]),
};

const S_CEREVISIAE: CodonUsageTable = {
  A: sorted([
    { codon: 'GCT', fraction: 0.38 },
    { codon: 'GCC', fraction: 0.22 },
    { codon: 'GCA', fraction: 0.29 },
    { codon: 'GCG', fraction: 0.11 },
  ]),
  R: sorted([
    { codon: 'CGT', fraction: 0.14 },
    { codon: 'CGC', fraction: 0.06 },
    { codon: 'CGA', fraction: 0.07 },
    { codon: 'CGG', fraction: 0.04 },
    { codon: 'AGA', fraction: 0.48 },
    { codon: 'AGG', fraction: 0.21 },
  ]),
  N: sorted([
    { codon: 'AAT', fraction: 0.59 },
    { codon: 'AAC', fraction: 0.41 },
  ]),
  D: sorted([
    { codon: 'GAT', fraction: 0.65 },
    { codon: 'GAC', fraction: 0.35 },
  ]),
  C: sorted([
    { codon: 'TGT', fraction: 0.63 },
    { codon: 'TGC', fraction: 0.37 },
  ]),
  Q: sorted([
    { codon: 'CAA', fraction: 0.69 },
    { codon: 'CAG', fraction: 0.31 },
  ]),
  E: sorted([
    { codon: 'GAA', fraction: 0.7 },
    { codon: 'GAG', fraction: 0.3 },
  ]),
  G: sorted([
    { codon: 'GGT', fraction: 0.47 },
    { codon: 'GGC', fraction: 0.19 },
    { codon: 'GGA', fraction: 0.22 },
    { codon: 'GGG', fraction: 0.12 },
  ]),
  H: sorted([
    { codon: 'CAT', fraction: 0.64 },
    { codon: 'CAC', fraction: 0.36 },
  ]),
  I: sorted([
    { codon: 'ATT', fraction: 0.46 },
    { codon: 'ATC', fraction: 0.26 },
    { codon: 'ATA', fraction: 0.27 },
  ]),
  L: sorted([
    { codon: 'TTA', fraction: 0.28 },
    { codon: 'TTG', fraction: 0.29 },
    { codon: 'CTT', fraction: 0.13 },
    { codon: 'CTC', fraction: 0.06 },
    { codon: 'CTA', fraction: 0.14 },
    { codon: 'CTG', fraction: 0.11 },
  ]),
  K: sorted([
    { codon: 'AAA', fraction: 0.58 },
    { codon: 'AAG', fraction: 0.42 },
  ]),
  M: sorted([{ codon: 'ATG', fraction: 1.0 }]),
  F: sorted([
    { codon: 'TTT', fraction: 0.59 },
    { codon: 'TTC', fraction: 0.41 },
  ]),
  P: sorted([
    { codon: 'CCT', fraction: 0.31 },
    { codon: 'CCC', fraction: 0.15 },
    { codon: 'CCA', fraction: 0.42 },
    { codon: 'CCG', fraction: 0.12 },
  ]),
  S: sorted([
    { codon: 'TCT', fraction: 0.26 },
    { codon: 'TCC', fraction: 0.16 },
    { codon: 'TCA', fraction: 0.21 },
    { codon: 'TCG', fraction: 0.1 },
    { codon: 'AGT', fraction: 0.16 },
    { codon: 'AGC', fraction: 0.11 },
  ]),
  T: sorted([
    { codon: 'ACT', fraction: 0.35 },
    { codon: 'ACC', fraction: 0.22 },
    { codon: 'ACA', fraction: 0.3 },
    { codon: 'ACG', fraction: 0.14 },
  ]),
  W: sorted([{ codon: 'TGG', fraction: 1.0 }]),
  Y: sorted([
    { codon: 'TAT', fraction: 0.56 },
    { codon: 'TAC', fraction: 0.44 },
  ]),
  V: sorted([
    { codon: 'GTT', fraction: 0.39 },
    { codon: 'GTC', fraction: 0.21 },
    { codon: 'GTA', fraction: 0.21 },
    { codon: 'GTG', fraction: 0.19 },
  ]),
  '*': sorted([
    { codon: 'TAA', fraction: 0.47 },
    { codon: 'TAG', fraction: 0.23 },
    { codon: 'TGA', fraction: 0.3 },
  ]),
};

export const CODON_USAGE_TABLES: Record<SupportedBacktranslateHost, CodonUsageTable> = {
  E_COLI_K12,
  S_CEREVISIAE,
};

export function isSupportedBacktranslateHost(value: string): value is SupportedBacktranslateHost {
  return (SUPPORTED_BACKTRANSLATE_HOSTS as readonly string[]).includes(value);
}
