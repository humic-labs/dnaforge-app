import { RAW_GENETIC_CODE_TABLES, type RawGeneticCodeTable } from './genetic-codes.generated';
import type { Annotation } from './types';

export const STANDARD_GENETIC_CODE_ID = 1;

export type {
  CodonMeaning,
  CustomGeneticCodeDefinition,
  GeneticCodeSpec,
  NonStandardResidue,
  StandardAminoAcidLetter,
} from './genetic-code-spec';
import type {
  CodonMeaning,
  CustomGeneticCodeDefinition,
  GeneticCodeSpec,
  NonStandardResidue,
  StandardAminoAcidLetter,
} from './genetic-code-spec';
interface GeneticCodeTable {
  readonly name: string;

  readonly codonTable: Readonly<Record<string, string>>;

  readonly meanings: Readonly<Record<string, CodonMeaning>>;

  readonly startCodons: ReadonlySet<string>;

  readonly stopCodons: ReadonlySet<string>;

  readonly dualFunctionCodons: ReadonlySet<string>;

  readonly unassignedCodons: ReadonlySet<string>;

  readonly frameEndingCodons: ReadonlySet<string>;

  readonly residues: readonly NonStandardResidue[];
}

export interface PublishedGeneticCode extends GeneticCodeTable {
  readonly kind: 'published';
  readonly id: number;

  readonly shortName?: string;
}

export interface CustomGeneticCode extends GeneticCodeTable {
  readonly kind: 'custom';
  readonly id: string;
  readonly revision: number;

  readonly definition: CustomGeneticCodeDefinition;
}

export type GeneticCode = PublishedGeneticCode | CustomGeneticCode;

export type GeneticCodeInput = GeneticCodeSpec | GeneticCode;

const CODON_BASES = ['T', 'C', 'A', 'G'] as const;

function ncbiCodonOrder(): string[] {
  const codons: string[] = [];
  for (const first of CODON_BASES) {
    for (const second of CODON_BASES) {
      for (const third of CODON_BASES) codons.push(`${first}${second}${third}`);
    }
  }
  return codons;
}

const CODON_ORDER = ncbiCodonOrder();

export const GENETIC_CODE_CODONS: readonly string[] = CODON_ORDER;

function buildGeneticCode(raw: RawGeneticCodeTable): PublishedGeneticCode {
  const codonTable: Record<string, string> = {};
  const meanings: Record<string, CodonMeaning> = {};
  const startCodons = new Set<string>();
  const stopCodons = new Set<string>();
  const dualFunctionCodons = new Set<string>();
  for (let i = 0; i < CODON_ORDER.length; i++) {
    const codon = CODON_ORDER[i];
    const aminoAcid = raw.aminoAcids[i];
    const marker = raw.starts[i];
    codonTable[codon] = aminoAcid;
    meanings[codon] =
      aminoAcid === '*'
        ? STOP_MEANING
        : { kind: 'amino-acid', letter: aminoAcid as StandardAminoAcidLetter };
    if (marker === 'M') startCodons.add(codon);
    if (aminoAcid === '*' || marker === '*') stopCodons.add(codon);
    if (aminoAcid !== '*' && marker === '*') dualFunctionCodons.add(codon);
  }
  return {
    kind: 'published',
    id: raw.id,
    name: raw.name,
    ...(raw.shortName ? { shortName: raw.shortName } : {}),
    codonTable,
    meanings,
    startCodons,
    stopCodons,
    dualFunctionCodons,
    unassignedCodons: EMPTY_CODONS,
    frameEndingCodons: stopCodons,
    residues: [],
  };
}

const STOP_MEANING: CodonMeaning = { kind: 'stop' };
const EMPTY_CODONS: ReadonlySet<string> = new Set();

const GENETIC_CODES_BY_ID: ReadonlyMap<number, PublishedGeneticCode> = new Map(
  RAW_GENETIC_CODE_TABLES.map((raw) => [raw.id, buildGeneticCode(raw)])
);

export const GENETIC_CODES: readonly PublishedGeneticCode[] = [
  ...GENETIC_CODES_BY_ID.values(),
].sort((a, b) => a.id - b.id);

export const STANDARD_GENETIC_CODE: PublishedGeneticCode =
  mustGetGeneticCode(STANDARD_GENETIC_CODE_ID);

function mustGetGeneticCode(id: number): PublishedGeneticCode {
  const code = GENETIC_CODES_BY_ID.get(id);
  if (!code) throw new Error(`Genetic code ${id} is not in the NCBI table set`);
  return code;
}

export function isKnownGeneticCodeId(id: unknown): id is number {
  return typeof id === 'number' && GENETIC_CODES_BY_ID.has(id);
}

export function getGeneticCode(id: number): PublishedGeneticCode | undefined {
  return GENETIC_CODES_BY_ID.get(id);
}

export function resolveGeneticCode(code: GeneticCodeInput | undefined): GeneticCode {
  if (code === undefined) return STANDARD_GENETIC_CODE;
  if (typeof code === 'number') return GENETIC_CODES_BY_ID.get(code) ?? STANDARD_GENETIC_CODE;
  if (isResolvedGeneticCode(code)) return code;
  return customGeneticCodeTable(code);
}

function isResolvedGeneticCode(
  code: GeneticCode | CustomGeneticCodeDefinition
): code is GeneticCode {
  return 'codonTable' in code;
}

export function isCustomGeneticCodeSpec(
  spec: GeneticCodeSpec | null | undefined
): spec is CustomGeneticCodeDefinition {
  return typeof spec === 'object' && spec !== null;
}

const CUSTOM_TABLES_BY_OBJECT = new WeakMap<CustomGeneticCodeDefinition, CustomGeneticCode>();
const CUSTOM_TABLES_BY_CONTENT = new Map<string, CustomGeneticCode>();

const CUSTOM_TABLE_CACHE_LIMIT = 256;

function customGeneticCodeTable(definition: CustomGeneticCodeDefinition): CustomGeneticCode {
  const byObject = CUSTOM_TABLES_BY_OBJECT.get(definition);
  if (byObject) return byObject;

  const key = geneticCodeKey(definition);
  let table = CUSTOM_TABLES_BY_CONTENT.get(key);
  if (!table) {
    table = buildCustomGeneticCodeTable(definition);
    if (CUSTOM_TABLES_BY_CONTENT.size >= CUSTOM_TABLE_CACHE_LIMIT) {
      const oldest = CUSTOM_TABLES_BY_CONTENT.keys().next().value;
      if (oldest !== undefined) CUSTOM_TABLES_BY_CONTENT.delete(oldest);
    }
    CUSTOM_TABLES_BY_CONTENT.set(key, table);
  }
  CUSTOM_TABLES_BY_OBJECT.set(definition, table);
  return table;
}

function buildCustomGeneticCodeTable(definition: CustomGeneticCodeDefinition): CustomGeneticCode {
  const codonTable: Record<string, string> = {};
  const meanings: Record<string, CodonMeaning> = {};
  const stopCodons = new Set<string>();
  const unassignedCodons = new Set<string>();
  for (const codon of CODON_ORDER) {
    const meaning = definition.codons[codon] ?? STANDARD_GENETIC_CODE.meanings[codon];
    meanings[codon] = meaning;
    codonTable[codon] = letterForMeaning(meaning);
    if (meaning.kind === 'stop') stopCodons.add(codon);
    if (meaning.kind === 'unassigned') unassignedCodons.add(codon);
  }
  return {
    kind: 'custom',
    id: definition.id,
    revision: definition.revision,
    name: definition.name,
    definition,
    codonTable,
    meanings,
    startCodons: new Set(definition.startCodons.map((codon) => codon.toUpperCase())),
    stopCodons,
    dualFunctionCodons: EMPTY_CODONS,
    unassignedCodons,
    frameEndingCodons: new Set([...stopCodons, ...unassignedCodons]),
    residues: definition.residues,
  };
}

function letterForMeaning(meaning: CodonMeaning): string {
  switch (meaning.kind) {
    case 'amino-acid':
      return meaning.letter;
    case 'stop':
      return '*';
    case 'residue':
    case 'unassigned':
      return 'X';
  }
}

export function geneticCodeKey(code: GeneticCodeInput | undefined): string {
  if (code === undefined) return `ncbi:${STANDARD_GENETIC_CODE_ID}`;
  if (typeof code === 'number') return `ncbi:${resolveGeneticCode(code).id}`;
  if (isResolvedGeneticCode(code)) {
    return code.kind === 'published' ? `ncbi:${code.id}` : geneticCodeKey(code.definition);
  }
  const codons = CODON_ORDER.filter((codon) => code.codons[codon] !== undefined).map(
    (codon) => `${codon}=${meaningKey(code.codons[codon])}`
  );
  const starts = CODON_ORDER.filter((codon) => code.startCodons.includes(codon));
  const residues = [...code.residues]
    .sort((a, b) => a.abbreviation.localeCompare(b.abbreviation))
    .map((residue) => [residue.abbreviation, residue.name, residue.ccd ?? '']);
  return `custom:${JSON.stringify([code.id, code.revision, code.name, codons, starts, residues])}`;
}

function meaningKey(meaning: CodonMeaning): string {
  switch (meaning.kind) {
    case 'amino-acid':
      return meaning.letter;
    case 'stop':
      return '*';
    case 'residue':
      return `residue:${meaning.residue}`;
    case 'unassigned':
      return 'unassigned';
  }
}

function meaningsAgree(
  left: CodonMeaning,
  leftCode: GeneticCode,
  right: CodonMeaning,
  rightCode: GeneticCode
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'amino-acid' && right.kind === 'amino-acid')
    return left.letter === right.letter;
  if (left.kind === 'residue' && right.kind === 'residue') {
    const a = leftCode.residues.find((residue) => residue.abbreviation === left.residue);
    const b = rightCode.residues.find((residue) => residue.abbreviation === right.residue);
    if (!a || !b) return left.residue === right.residue;
    return (
      a.abbreviation === b.abbreviation && a.name === b.name && (a.ccd ?? '') === (b.ccd ?? '')
    );
  }
  return true;
}

export function geneticCodesAssignIdenticalAminoAcids(
  a: GeneticCodeInput | undefined,
  b: GeneticCodeInput | undefined
): boolean {
  const left = resolveGeneticCode(a);
  const right = resolveGeneticCode(b);
  if (left === right) return true;
  return CODON_ORDER.every((codon) =>
    meaningsAgree(left.meanings[codon], left, right.meanings[codon], right)
  );
}

export function geneticCodeLabel(code: GeneticCodeInput | undefined): string {
  const resolved = resolveGeneticCode(code);
  return resolved.kind === 'published' ? `${resolved.id} — ${resolved.name}` : resolved.name;
}

export function parseTranslTableQualifier(annotation: {
  qualifiers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  qualifierValues?: Readonly<Record<string, readonly string[]>>;
}): number | null {
  const value = annotation.qualifierValues?.transl_table ?? annotation.qualifiers?.transl_table;
  const raw = typeof value === 'string' ? value : value?.[0];
  if (raw === undefined) return null;
  const parsed = Number.parseInt(String(raw).trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

const CODING_FEATURE_TYPES = new Set(['CDS', 'mat_peptide', 'sig_peptide', 'transit_peptide']);

export function isCodingFeature(annotation: Pick<Annotation, 'type'>): boolean {
  return CODING_FEATURE_TYPES.has(annotation.type);
}

export type GeneticCodeBasis = 'declared' | 'declared-mixed' | 'chosen' | 'default';

export interface SequenceGeneticCodeResolution {
  readonly code: GeneticCodeSpec;
  readonly basis: GeneticCodeBasis;

  readonly declaredCodes: readonly number[];

  readonly mixed: boolean;

  readonly needsUserChoice: boolean;

  readonly organelle?: string;

  readonly unreadableGeneticCode?: string;
}

const AMBIGUOUS_ORGANELLE_PREFIXES = ['mitochondri', 'kinetoplast', 'hydrogenosome'];

function organelleOf(sequence: {
  readonly annotations: readonly Pick<Annotation, 'type' | 'qualifiers'>[];
}): string | undefined {
  for (const annotation of sequence.annotations ?? []) {
    if (annotation.type !== 'source') continue;
    const value = annotation.qualifiers?.organelle?.[0];
    if (value) return value;
  }
  return undefined;
}

function organelleIsAmbiguous(organelle: string | undefined): boolean {
  if (!organelle) return false;
  const lowered = organelle.toLowerCase();
  return AMBIGUOUS_ORGANELLE_PREFIXES.some((prefix) => lowered.includes(prefix));
}

export function resolveSequenceGeneticCode(
  sequence: {
    readonly annotations: readonly Pick<Annotation, 'type' | 'qualifiers'>[];
    readonly chosenGeneticCode?: GeneticCodeSpec;
    readonly unreadableGeneticCode?: string;
  },
  options: { readonly chosenGeneticCode?: GeneticCodeSpec } = {}
): SequenceGeneticCodeResolution {
  const counts = new Map<number, number>();
  for (const annotation of sequence.annotations ?? []) {
    if (!isCodingFeature(annotation)) continue;
    const declared = parseTranslTableQualifier(annotation);
    if (declared === null) continue;
    counts.set(declared, (counts.get(declared) ?? 0) + 1);
  }

  const declaredCodes = [...counts.keys()].sort((a, b) => a - b);
  const mixed = declaredCodes.length > 1;
  const chosen = options.chosenGeneticCode ?? sequence.chosenGeneticCode;

  if (isKnownGeneticCodeId(chosen) || isCustomGeneticCodeSpec(chosen)) {
    const organelle = organelleOf(sequence);
    return {
      code: chosen,
      basis: 'chosen',
      declaredCodes,
      mixed,
      needsUserChoice: false,
      ...(organelle ? { organelle } : {}),
    };
  }

  if (declaredCodes.length > 0) {
    let best = declaredCodes[0];
    for (const id of declaredCodes) {
      const better = (counts.get(id) ?? 0) > (counts.get(best) ?? 0);
      if (better) best = id;
    }
    return {
      code: best,
      basis: mixed ? 'declared-mixed' : 'declared',
      declaredCodes,
      mixed,
      needsUserChoice: false,
    };
  }

  const organelle = organelleOf(sequence);
  const unreadable = sequence.unreadableGeneticCode;
  return {
    code: STANDARD_GENETIC_CODE_ID,
    basis: 'default',
    declaredCodes,
    mixed: false,
    needsUserChoice: organelleIsAmbiguous(organelle) || unreadable !== undefined,
    ...(organelle ? { organelle } : {}),
    ...(unreadable !== undefined ? { unreadableGeneticCode: unreadable } : {}),
  };
}

export type RecordGeneticCodeBasis = SequenceGeneticCodeResolution['basis'];

export function resolveAnnotationGeneticCode(
  annotation: Parameters<typeof parseTranslTableQualifier>[0],
  sequenceCode: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID,

  basis?: RecordGeneticCodeBasis
): GeneticCodeSpec {
  const raw = annotation.qualifierValues?.transl_table ?? annotation.qualifiers?.transl_table;
  const declarations = typeof raw === 'string' ? [raw] : (raw ?? []);
  const declared = declarations
    .map((value) => Number.parseInt(value, 10))
    .find(isKnownGeneticCodeId);
  if (basis !== 'chosen' && declared !== undefined) return declared;
  if (isCustomGeneticCodeSpec(sequenceCode)) return sequenceCode;
  if (isKnownGeneticCodeId(sequenceCode)) return sequenceCode;
  return declared ?? STANDARD_GENETIC_CODE_ID;
}
