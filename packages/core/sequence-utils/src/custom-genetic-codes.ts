import {
  GENETIC_CODE_CODONS,
  GENETIC_CODES,
  STANDARD_GENETIC_CODE,
  geneticCodesAssignIdenticalAminoAcids,
  resolveGeneticCode,
  type CodonMeaning,
  type CustomGeneticCodeDefinition,
  type GeneticCodeInput,
  type NonStandardResidue,
  type StandardAminoAcidLetter,
} from './genetic-codes';
import { translateCodon } from './codon-translation';

export type {
  CodonMeaning,
  CustomGeneticCodeDefinition,
  NonStandardResidue,
  StandardAminoAcidLetter,
} from './genetic-codes';

export const STANDARD_AMINO_ACID_LETTERS: readonly StandardAminoAcidLetter[] = [
  'A',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'K',
  'L',
  'M',
  'N',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'V',
  'W',
  'Y',
  'U',
  'O',
];

export const CUSTOM_GENETIC_CODE_NAME_MAX_LENGTH = 40;
export const NON_STANDARD_RESIDUE_NAME_MAX_LENGTH = 40;

const RESIDUE_ABBREVIATION = /^[A-Za-z][A-Za-z0-9-]{1,7}$/;
const CCD_CODE = /^[A-Z0-9]{1,5}$/;
const CUSTOM_ID = /^gc-[0-9a-f]{8,32}$/;
const CODON = /^[ACGT]{3}$/;

const CODON_INDEX = new Map(GENETIC_CODE_CODONS.map((codon, index) => [codon, index]));

export interface CustomGeneticCodeIssue {
  readonly path: string;
  readonly message: string;
}

export interface BuildCustomGeneticCodeInput {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly base: GeneticCodeInput;
  readonly changes: Readonly<Record<string, CodonMeaning>>;
  readonly startCodons?: readonly string[];
  readonly residues: readonly NonStandardResidue[];
}

export type BuildCustomGeneticCodeResult =
  | { readonly ok: true; readonly definition: CustomGeneticCodeDefinition }
  | { readonly ok: false; readonly issues: readonly CustomGeneticCodeIssue[] };

export function buildCustomGeneticCode(
  input: BuildCustomGeneticCodeInput
): BuildCustomGeneticCodeResult {
  const base = resolveGeneticCode(input.base);
  const issues: CustomGeneticCodeIssue[] = [];

  const meanings: Record<string, CodonMeaning> = { ...base.meanings };
  for (const [rawCodon, meaning] of Object.entries(input.changes)) {
    const codon = rawCodon.toUpperCase();
    if (!CODON.test(codon)) {
      issues.push({ path: `codons.${rawCodon}`, message: `"${rawCodon}" is not a codon.` });
      continue;
    }
    meanings[codon] = meaning;
  }

  const codons: Record<string, CodonMeaning> = {};
  for (const codon of GENETIC_CODE_CODONS) {
    if (!sameMeaning(meanings[codon], STANDARD_GENETIC_CODE.meanings[codon])) {
      codons[codon] = meanings[codon];
    }
  }

  const definition: CustomGeneticCodeDefinition = {
    id: input.id,
    revision: input.revision,
    name: input.name.trim(),
    codons,
    startCodons: inCodonOrder(
      (input.startCodons ?? [...base.startCodons]).map((c) => c.toUpperCase())
    ),
    residues: [...input.residues]
      .map((residue) => ({
        abbreviation: residue.abbreviation.trim(),
        name: residue.name.trim(),
        ...(residue.ccd?.trim() ? { ccd: residue.ccd.trim().toUpperCase() } : {}),
      }))
      .sort((a, b) => a.abbreviation.localeCompare(b.abbreviation)),
  };

  issues.push(...validateCustomGeneticCode(definition));
  return issues.length > 0 ? { ok: false, issues } : { ok: true, definition };
}

export function validateCustomGeneticCode(
  definition: CustomGeneticCodeDefinition
): CustomGeneticCodeIssue[] {
  const issues: CustomGeneticCodeIssue[] = [];

  if (!CUSTOM_ID.test(definition.id)) {
    issues.push({ path: 'id', message: `"${definition.id}" is not a custom genetic code id.` });
  }
  if (!Number.isInteger(definition.revision) || definition.revision < 1) {
    issues.push({ path: 'revision', message: 'Revision must be a whole number from 1.' });
  }

  const name = definition.name.trim();
  if (name.length === 0) issues.push({ path: 'name', message: 'Give the code a name.' });
  if (name.length > CUSTOM_GENETIC_CODE_NAME_MAX_LENGTH) {
    issues.push({
      path: 'name',
      message: `Names can be at most ${CUSTOM_GENETIC_CODE_NAME_MAX_LENGTH} characters, so they fit a GenBank line.`,
    });
  }
  if (/["\r\n]/.test(name)) {
    issues.push({ path: 'name', message: 'Names cannot contain double quotes or line breaks.' });
  }

  const residuesByKey = new Map<string, NonStandardResidue>();
  for (const residue of definition.residues) {
    const path = `residues.${residue.abbreviation}`;
    if (!RESIDUE_ABBREVIATION.test(residue.abbreviation)) {
      issues.push({
        path,
        message: `"${residue.abbreviation}" is not a usable abbreviation: use 2–8 letters, digits or hyphens, starting with a letter, so it is never mistaken for a one-letter amino acid.`,
      });
    }
    const key = residue.abbreviation.toLowerCase();
    if (residuesByKey.has(key)) {
      issues.push({ path, message: `"${residue.abbreviation}" is defined more than once.` });
    }
    residuesByKey.set(key, residue);
    if (residue.name.trim().length === 0) {
      issues.push({ path, message: `Give "${residue.abbreviation}" its full name.` });
    }
    if (
      residue.name.length > NON_STANDARD_RESIDUE_NAME_MAX_LENGTH ||
      /["\r\n]/.test(residue.name)
    ) {
      issues.push({
        path,
        message: `The name of "${residue.abbreviation}" must be at most ${NON_STANDARD_RESIDUE_NAME_MAX_LENGTH} characters, with no double quotes or line breaks.`,
      });
    }
    if (residue.ccd !== undefined && !CCD_CODE.test(residue.ccd)) {
      issues.push({
        path,
        message: `"${residue.ccd}" is not a PDB chemical component code (1–5 capital letters or digits).`,
      });
    }
  }

  const usedResidues = new Set<string>();
  for (const [codon, meaning] of Object.entries(definition.codons)) {
    const path = `codons.${codon}`;
    if (!CODON.test(codon)) {
      issues.push({ path, message: `"${codon}" is not a codon.` });
      continue;
    }
    if (sameMeaning(meaning, STANDARD_GENETIC_CODE.meanings[codon])) {
      issues.push({
        path,
        message: `${codon} already means that in the standard code; only differences are stored.`,
      });
    }
    if (meaning.kind === 'amino-acid' && !STANDARD_AMINO_ACID_LETTERS.includes(meaning.letter)) {
      issues.push({ path, message: `"${meaning.letter}" is not a standard amino acid letter.` });
    }
    if (meaning.kind === 'residue') {
      if (!residuesByKey.has(meaning.residue.toLowerCase())) {
        issues.push({
          path,
          message: `${codon} reads "${meaning.residue}", which is not defined. Define the residue first.`,
        });
      } else {
        usedResidues.add(meaning.residue.toLowerCase());
      }
    }
  }
  for (const residue of definition.residues) {
    if (!usedResidues.has(residue.abbreviation.toLowerCase())) {
      issues.push({
        path: `residues.${residue.abbreviation}`,
        message: `"${residue.abbreviation}" is not used by any codon. Assign it or remove it.`,
      });
    }
  }

  if (definition.startCodons.length === 0) {
    issues.push({ path: 'startCodons', message: 'A code needs at least one start codon.' });
  }
  for (const codon of definition.startCodons) {
    if (!CODON.test(codon)) {
      issues.push({ path: 'startCodons', message: `"${codon}" is not a codon.` });
      continue;
    }
    const meaning = definition.codons[codon] ?? STANDARD_GENETIC_CODE.meanings[codon];
    if (meaning.kind === 'stop' || meaning.kind === 'unassigned') {
      issues.push({
        path: 'startCodons',
        message: `${codon} cannot be a start codon: it is ${meaning.kind === 'stop' ? 'a stop codon' : 'unassigned'} in this code.`,
      });
    }
  }

  if (issues.length === 0) {
    const published = identicalPublishedCode(definition);
    if (published !== undefined) {
      issues.push({
        path: 'codons',
        message: `This is identical to published genetic code ${published.id} (${published.name}). Use that instead, so other tools can read it.`,
      });
    }
  }

  return issues;
}

export function codonMeaning(
  codon: string,
  code: GeneticCodeInput | undefined
): CodonMeaning | undefined {
  return resolveGeneticCode(code).meanings[codon.toUpperCase()];
}

export interface CodonDisplay {
  readonly short: string;
  readonly full: string;
  readonly kind: CodonMeaning['kind'];
}

export function codonDisplay(codon: string, code: GeneticCodeInput | undefined): CodonDisplay {
  const resolved = resolveGeneticCode(code);
  const meaning = resolved.meanings[codon.toUpperCase()];
  switch (meaning?.kind) {
    case 'amino-acid':
      return { short: meaning.letter, full: meaning.letter, kind: 'amino-acid' };
    case 'stop':
      return { short: '*', full: '*', kind: 'stop' };
    case 'unassigned':
      return { short: 'X', full: '?', kind: 'unassigned' };
    case 'residue': {
      const residue = resolved.residues.find((entry) => entry.abbreviation === meaning.residue);
      return { short: 'X', full: residue?.abbreviation ?? 'X', kind: 'residue' };
    }
    default: {
      const letter = translateCodon(codon, resolved);
      return { short: letter, full: letter, kind: letter === '*' ? 'stop' : 'amino-acid' };
    }
  }
}

export interface CodonLabelFit {
  readonly text: string;
  readonly scale: number;
}

export const UNNAMED_RESIDUE_COLOR = '#B0A08C';

const PLACEHOLDER_LABELS = new Set(['', 'X', 'x', '?', '*']);

export function nonStandardResidueColor(abbreviation: string): string {
  if (PLACEHOLDER_LABELS.has(abbreviation.trim())) return UNNAMED_RESIDUE_COLOR;
  let hash = 0;
  for (const char of abbreviation) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  let hue = hash % 320;
  hue = (hue + 20) % 360;
  return hslToHex(hue, 62, 52);
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - chroma / 2;
  const [r, g, b] = (
    h < 60
      ? [chroma, x, 0]
      : h < 120
        ? [x, chroma, 0]
        : h < 180
          ? [0, chroma, x]
          : h < 240
            ? [0, x, chroma]
            : h < 300
              ? [x, 0, chroma]
              : [chroma, 0, x]
  ).map((channel) => Math.round((channel + m) * 255));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

const MIN_RESIDUE_LABEL_SCALE = 0.63;

const RESIDUE_LABEL_MAX_SCALE = 0.9;
const RESIDUE_LABEL_SIDE_MARGIN = 0.05;

export function codonLabelThatFits(
  display: CodonDisplay,
  availablePx: number,
  fontSizePx: number,
  measure?: (text: string) => number
): CodonLabelFit {
  if (display.full === display.short || display.full.length <= 1) {
    return { text: display.full, scale: 1 };
  }
  const needed = measure ? measure(display.full) : display.full.length * fontSizePx * 0.55;
  const usable = availablePx * (1 - 2 * RESIDUE_LABEL_SIDE_MARGIN);
  const scale = Math.min(RESIDUE_LABEL_MAX_SCALE, usable / needed);
  return scale >= MIN_RESIDUE_LABEL_SCALE
    ? { text: display.full, scale }
    : { text: display.short, scale: 1 };
}

export function nonStandardResidueLegend(code: GeneticCodeInput | undefined): string | undefined {
  const resolved = resolveGeneticCode(code);
  if (resolved.residues.length === 0) return undefined;
  const described = resolved.residues.map((residue) => {
    const codons = GENETIC_CODE_CODONS.filter((codon) => {
      const meaning = resolved.meanings[codon];
      return meaning.kind === 'residue' && meaning.residue === residue.abbreviation;
    });
    return `${residue.abbreviation} (${codons.join(', ')})`;
  });
  return `X marks ${described.join(' and ')}.`;
}

export function codonResidue(
  codon: string,
  code: GeneticCodeInput | undefined
): NonStandardResidue | undefined {
  const resolved = resolveGeneticCode(code);
  const meaning = resolved.meanings[codon.toUpperCase()];
  if (meaning?.kind !== 'residue') return undefined;
  return resolved.residues.find((residue) => residue.abbreviation === meaning.residue);
}

function identicalPublishedCode(definition: CustomGeneticCodeDefinition) {
  const starts = definition.startCodons.join(',');
  return GENETIC_CODES.find(
    (published) =>
      geneticCodesAssignIdenticalAminoAcids(published, definition) &&
      inCodonOrder([...published.startCodons]).join(',') === starts
  );
}

function sameMeaning(a: CodonMeaning | undefined, b: CodonMeaning | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'amino-acid' && b.kind === 'amino-acid') return a.letter === b.letter;
  if (a.kind === 'residue' && b.kind === 'residue') return a.residue === b.residue;
  return true;
}

function inCodonOrder(codons: readonly string[]): string[] {
  return [...new Set(codons)].sort(
    (a, b) =>
      (CODON_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (CODON_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER)
  );
}
