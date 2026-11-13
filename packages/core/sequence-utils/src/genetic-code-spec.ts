export type CodonMeaning =
  | { readonly kind: 'amino-acid'; readonly letter: StandardAminoAcidLetter }
  | { readonly kind: 'stop' }
  | { readonly kind: 'residue'; readonly residue: string }
  | { readonly kind: 'unassigned' };

export type StandardAminoAcidLetter =
  | 'A'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
  | 'G'
  | 'H'
  | 'I'
  | 'K'
  | 'L'
  | 'M'
  | 'N'
  | 'P'
  | 'Q'
  | 'R'
  | 'S'
  | 'T'
  | 'V'
  | 'W'
  | 'Y'
  | 'U'
  | 'O';

export interface NonStandardResidue {
  readonly abbreviation: string;
  readonly name: string;
  readonly ccd?: string;
}

export interface CustomGeneticCodeDefinition {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly codons: Readonly<Record<string, CodonMeaning>>;
  readonly startCodons: readonly string[];
  readonly residues: readonly NonStandardResidue[];
}

export type GeneticCodeSpec = number | CustomGeneticCodeDefinition;
