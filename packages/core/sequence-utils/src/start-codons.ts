import { toNucleicAcid } from './iupac';

export type GeneticCodeId = number;

const STANDARD_STARTS = new Set(['ATG', 'CTG', 'TTG']);

const BACTERIAL_STARTS = new Set(['ATG', 'GTG', 'TTG', 'ATT', 'ATC', 'ATA', 'CTG']);

const START_CODONS_BY_CODE: ReadonlyMap<GeneticCodeId, ReadonlySet<string>> = new Map([
  [1, STANDARD_STARTS],
  [11, BACTERIAL_STARTS],
]);

export function startCodonsForGeneticCode(code: GeneticCodeId | undefined): ReadonlySet<string> {
  if (code === undefined) return STANDARD_STARTS;
  return START_CODONS_BY_CODE.get(code) ?? STANDARD_STARTS;
}

export function isStartCodonForGeneticCode(
  codon: string,
  code: GeneticCodeId | undefined = 1
): boolean {
  return startCodonsForGeneticCode(code).has(toNucleicAcid(codon.toUpperCase(), 'dna'));
}

const STANDARD_STOPS = new Set(['TAA', 'TAG', 'TGA']);

export function stopCodonsForGeneticCode(_code: GeneticCodeId | undefined): ReadonlySet<string> {
  return STANDARD_STOPS;
}

export function isStopCodonForGeneticCode(
  codon: string,
  code: GeneticCodeId | undefined = 1
): boolean {
  return stopCodonsForGeneticCode(code).has(toNucleicAcid(codon.toUpperCase(), 'dna'));
}
