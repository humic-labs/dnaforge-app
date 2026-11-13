const CODE_TO_BASES: Readonly<Record<string, string>> = Object.freeze({
  A: 'A',
  C: 'C',
  G: 'G',
  T: 'T',
  R: 'AG',
  Y: 'CT',
  S: 'CG',
  W: 'AT',
  K: 'GT',
  M: 'AC',
  B: 'CGT',
  D: 'AGT',
  H: 'ACT',
  V: 'ACG',
  N: 'ACGT',
});

const URACIL_ALIAS = 'T';

const PASSTHROUGH_CHARS = Object.freeze(['-', '.', '*', ' ']);

export const DNA_ALPHABET: readonly string[] = Object.freeze(['A', 'C', 'G', 'T']);

function canonicalise(bases: string): string {
  return [...new Set(bases.toUpperCase())].sort().join('');
}

const BASES_TO_CODE: Record<string, string> = {};
for (const [code, bases] of Object.entries(CODE_TO_BASES)) {
  BASES_TO_CODE[canonicalise(bases)] = code;
}

const BASE_COMPLEMENT: Record<string, string> = { A: 'T', T: 'A', C: 'G', G: 'C' };

export const IUPAC_COMPLEMENT: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};
  for (const [code, bases] of Object.entries(CODE_TO_BASES)) {
    const complementedSet = canonicalise([...bases].map((b) => BASE_COMPLEMENT[b]).join(''));
    const complementCode = BASES_TO_CODE[complementedSet];
    /* istanbul ignore next -- unreachable while CODE_TO_BASES is closed under complement */
    if (!complementCode) {
      throw new Error(`IUPAC table is not closed under complement: ${code} -> ${complementedSet}`);
    }
    map[code] = complementCode;
    map[code.toLowerCase()] = complementCode.toLowerCase();
  }

  map['U'] = BASE_COMPLEMENT[URACIL_ALIAS];
  map['u'] = BASE_COMPLEMENT[URACIL_ALIAS].toLowerCase();
  for (const ch of PASSTHROUGH_CHARS) map[ch] = ch;
  return Object.freeze(map);
})();

export type NucleicAcid = 'dna' | 'rna';

export const IUPAC_RNA_COMPLEMENT: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(IUPAC_COMPLEMENT).map(([base, complement]) => [
      base,
      complement === 'T' ? 'U' : complement === 't' ? 'u' : complement,
    ])
  )
);

export function complementTable(acid: NucleicAcid = 'dna'): Readonly<Record<string, string>> {
  return acid === 'rna' ? IUPAC_RNA_COMPLEMENT : IUPAC_COMPLEMENT;
}

export function toNucleicAcid(bases: string, acid: NucleicAcid): string {
  return acid === 'rna'
    ? bases.replace(/T/g, 'U').replace(/t/g, 'u')
    : bases.replace(/U/g, 'T').replace(/u/g, 't');
}

export const IUPAC_EXPANSION: Readonly<Record<string, string>> = Object.freeze({
  ...CODE_TO_BASES,
  U: URACIL_ALIAS,
});

export const IUPAC_DEGENERACY: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Object.entries(IUPAC_EXPANSION).map(([code, bases]) => [code, bases.length]))
);

export const IUPAC_REGEX_CLASS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(IUPAC_EXPANSION).map(([code, bases]) => [
      code,
      bases.length === 1 ? bases : `[${bases}]`,
    ])
  )
);

export function isDegenerateBase(base: string): boolean {
  return (IUPAC_DEGENERACY[base.toUpperCase()] ?? 0) > 1;
}

export function containsDegenerateBases(sequence: string): boolean {
  for (const ch of sequence) {
    if (isDegenerateBase(ch)) return true;
  }
  return false;
}

export function complementBase(base: string, acid: NucleicAcid = 'dna'): string {
  return complementTable(acid)[base] ?? base;
}

export function reverseComplement(sequence: string, acid: NucleicAcid = 'dna'): string {
  const table = complementTable(acid);

  const outputChunks: string[] = [];
  const chunkSize = 64 * 1024;
  for (let end = sequence.length; end > 0; end -= chunkSize) {
    const start = Math.max(0, end - chunkSize);
    const chunk = new Array<string>(end - start);
    for (let sourceIndex = end - 1, outputIndex = 0; sourceIndex >= start; sourceIndex -= 1) {
      chunk[outputIndex] = table[sequence[sourceIndex]] ?? sequence[sourceIndex];
      outputIndex += 1;
    }
    outputChunks.push(chunk.join(''));
  }
  return outputChunks.join('');
}

export const DEFAULT_MAX_EXPANSION = 1024;

export function expandDegenerateSequence(
  sequence: string,
  options: { maxCombinations?: number } = {}
): string[] | null {
  const cap = options.maxCombinations ?? DEFAULT_MAX_EXPANSION;
  const upper = sequence.toUpperCase();

  let combinations = 1;
  const positions: string[] = [];
  for (const ch of upper) {
    if (PASSTHROUGH_CHARS.includes(ch)) continue;
    const bases = IUPAC_EXPANSION[ch];
    if (!bases) continue;
    positions.push(bases);
    combinations *= bases.length;
    if (combinations > cap) return null;
  }

  let results: string[] = [''];
  for (const bases of positions) {
    const next: string[] = [];
    for (const prefix of results) {
      for (const base of bases) next.push(prefix + base);
    }
    results = next;
  }
  return results;
}
