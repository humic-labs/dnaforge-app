import type { NucleicAcid } from './iupac';
export type MoleculeType = 'dna' | 'rna' | 'protein';

export type AmbiguousMoleculeReason =
  | 'empty'
  | 'too_short'
  | 'low_complexity'
  | 'mixed_t_u'
  | 'ambiguity_codes'
  | 'foreign_residues';

export type MoleculeTypeClassification =
  | { kind: MoleculeType }
  | { kind: 'ambiguous'; reason: AmbiguousMoleculeReason };

export const MIN_CLASSIFIABLE_RESIDUES = 20;

const GENBANK_MOLECULE_LABEL = /^(?:ss-|ds-|ms-)?[A-Za-z]*(?:DNA|RNA)$/;

export function parseGenBankMoleculeLabel(locusTail: string): string | null {
  for (const token of locusTail.trim().split(/\s+/)) {
    if (GENBANK_MOLECULE_LABEL.test(token)) return token;
  }
  return null;
}

export function isRnaMolecule(label: string | undefined): boolean {
  return label !== undefined && /RNA$/.test(label);
}

export function nucleicAcidOf(sequence: { readonly molecule?: string }): NucleicAcid {
  return isRnaMolecule(sequence.molecule) ? 'rna' : 'dna';
}

export function nucleicAcidOfBases(bases: string): NucleicAcid {
  return /[Uu]/.test(bases) && !/[Tt]/.test(bases) ? 'rna' : 'dna';
}
export const MIN_NUCLEOTIDE_CORE_FRACTION = 0.9;

const PROTEIN_ONLY_RESIDUES = new Set(['E', 'F', 'I', 'L', 'P', 'Q', 'J', 'O', 'Z']);

export function classifyMoleculeType(sequence: string): MoleculeTypeClassification {
  let residues = 0;
  let a = 0;
  let c = 0;
  let g = 0;
  let t = 0;
  let u = 0;
  let proteinOnly = 0;
  for (let offset = 0; offset < sequence.length; offset++) {
    const residue = sequence[offset].toUpperCase();
    if (residue < 'A' || residue > 'Z') continue;
    residues++;
    if (residue === 'A') a++;
    else if (residue === 'C') c++;
    else if (residue === 'G') g++;
    else if (residue === 'T') t++;
    else if (residue === 'U') u++;
    else if (PROTEIN_ONLY_RESIDUES.has(residue)) proteinOnly++;
  }
  if (residues === 0) return { kind: 'ambiguous', reason: 'empty' };

  const coreFraction = (a + c + g + t + u) / residues;
  if (proteinOnly > 0) {
    return coreFraction < MIN_NUCLEOTIDE_CORE_FRACTION
      ? { kind: 'protein' }
      : { kind: 'ambiguous', reason: 'foreign_residues' };
  }
  if (coreFraction < MIN_NUCLEOTIDE_CORE_FRACTION) {
    return { kind: 'ambiguous', reason: 'ambiguity_codes' };
  }
  if (t > 0 && u > 0) return { kind: 'ambiguous', reason: 'mixed_t_u' };
  if (residues < MIN_CLASSIFIABLE_RESIDUES) return { kind: 'ambiguous', reason: 'too_short' };
  if (a === 0 || c === 0 || g === 0 || t + u === 0) {
    return { kind: 'ambiguous', reason: 'low_complexity' };
  }
  return { kind: u > 0 ? 'rna' : 'dna' };
}
