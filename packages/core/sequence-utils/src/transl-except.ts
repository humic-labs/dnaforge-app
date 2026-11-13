import {
  INSDC_MODIFIED_AMINO_ACIDS,
  INSDC_STANDARD_AMINO_ACIDS,
} from './insdc-amino-acids.generated';

export type TranslExceptAmino =
  | {
      readonly kind: 'standard';
      readonly abbreviation: string;
      readonly letter: string;
      readonly name: string;
    }
  | { readonly kind: 'modified'; readonly abbreviation: string; readonly name: string }
  | { readonly kind: 'stop' }
  | { readonly kind: 'other' };

export interface TranslExceptLocation {
  readonly start: number;
  readonly end: number;
  readonly accession?: string;
  readonly complement?: boolean;
}

export interface TranslExcept {
  readonly location: TranslExceptLocation;
  readonly aa: TranslExceptAmino;
}

const STANDARD_BY_ABBREVIATION = new Map(
  INSDC_STANDARD_AMINO_ACIDS.map((entry) => [entry.abbreviation.toLowerCase(), entry])
);
const MODIFIED_BY_ABBREVIATION = new Map(
  INSDC_MODIFIED_AMINO_ACIDS.map((entry) => [entry.abbreviation.toLowerCase(), entry])
);

function parseAmino(raw: string): TranslExceptAmino | null {
  const token = raw.trim();
  if (token.length === 0) return null;
  if (token.toUpperCase() === 'TERM') return { kind: 'stop' };
  if (token.toUpperCase() === 'OTHER') return { kind: 'other' };

  const standard = STANDARD_BY_ABBREVIATION.get(token.toLowerCase());
  if (standard) {
    return {
      kind: 'standard',
      abbreviation: standard.abbreviation,
      letter: standard.letter,
      name: standard.name,
    };
  }
  const modified = MODIFIED_BY_ABBREVIATION.get(token.toLowerCase());
  if (modified) {
    return { kind: 'modified', abbreviation: modified.abbreviation, name: modified.name };
  }
  return null;
}

function parseLocation(raw: string): TranslExceptLocation | null {
  let body = raw.trim();
  let complement = false;

  const wrapped = /^complement\s*\(\s*(.+?)\s*\)$/i.exec(body);
  if (wrapped) {
    complement = true;
    body = wrapped[1];
  }

  let accession: string | undefined;
  const qualified = /^([A-Za-z][A-Za-z0-9_.]*)\s*:\s*(.+)$/.exec(body);
  if (qualified) {
    accession = qualified[1];
    body = qualified[2];
  }

  const range = /^(\d+)\s*\.\.\s*(\d+)$/.exec(body);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (end < start) return null;
    return {
      start,
      end,
      ...(accession ? { accession } : {}),
      ...(complement ? { complement } : {}),
    };
  }

  const single = /^(\d+)$/.exec(body);
  if (single) {
    const at = Number(single[1]);
    return {
      start: at,
      end: at,
      ...(accession ? { accession } : {}),
      ...(complement ? { complement } : {}),
    };
  }
  return null;
}

export function parseTranslExcept(value: string): TranslExcept | null {
  const trimmed = value
    .trim()
    .replace(/^\(\s*/, '')
    .replace(/\s*\)\s*$/, '');
  if (trimmed.length === 0) return null;

  const aaAt = trimmed.search(/,\s*aa\s*:/i);
  if (aaAt === -1) return null;
  const posPart = trimmed.slice(0, aaAt);
  const aaPart = trimmed.slice(aaAt).replace(/^,\s*aa\s*:/i, '');

  const posMatch = /^\s*pos\s*:\s*(.+)$/i.exec(posPart);
  if (!posMatch) return null;

  const location = parseLocation(posMatch[1]);
  if (!location) return null;
  const aa = parseAmino(aaPart);
  if (!aa) return null;
  return { location, aa };
}

const AMINO_ACID_ROOTS = [
  'phenylalanine',
  'asparagine',
  'isoleucine',
  'methionine',
  'tryptophan',
  'glutamate',
  'glutamine',
  'aspartate',
  'histidine',
  'threonine',
  'arginine',
  'cysteine',
  'tyrosine',
  'leucine',
  'alanine',
  'glycine',
  'proline',
  'serine',
  'lysine',
  'valine',
  'aspartic',
  'glutamic',
];

export function residueNameFromNote(note: string | undefined): string | null {
  if (!note) return null;
  const text = note.trim();
  if (text.length === 0) return null;

  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '');
    if (token.length === 0) continue;
    const lower = token.toLowerCase();
    if (AMINO_ACID_ROOTS.some((root) => lower.length > root.length && lower.endsWith(root))) {
      return token;
    }
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9,()' -]{2,60}$/.test(text)) return null;
  const words = text.split(/\s+/);
  if (words.length === 1) return text;
  if (words.length === 2 && words[1].toLowerCase() === 'acid' && /[-0-9]/.test(words[0])) {
    return text;
  }
  return null;
}

export function translExceptsOf(genbank: string): TranslExcept[] {
  const out: TranslExcept[] = [];
  const unwrapped = genbank.replace(/\n {21}(?!\/)/g, '');
  for (const match of unwrapped.matchAll(/\/transl_except\s*=\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g)) {
    const parsed = parseTranslExcept(match[1]);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function residueAbbreviationFromNote(note: string | undefined): string | null {
  if (!note) return null;
  const bracketed = /\(([A-Za-z][A-Za-z0-9-]{1,7})\)/.exec(note);
  if (!bracketed) return null;
  if (/^[ACGTU]{3}$/i.test(bracketed[1])) return null;
  return bracketed[1];
}

const STANDARD_BY_LETTER = new Map(
  INSDC_STANDARD_AMINO_ACIDS.map((entry) => [entry.letter.toUpperCase(), entry])
);

export function aminoAcidNameForLetter(letter: string): string | null {
  return STANDARD_BY_LETTER.get(letter.toUpperCase())?.name ?? null;
}

export interface CodonException {
  readonly except: TranslExcept;
  readonly residueName: string | null;
  readonly residueAbbreviation: string | null;
}

type Qualifiers = Readonly<Record<string, readonly string[] | undefined>>;

export function codonExceptionsOf(qualifiers: Qualifiers | undefined): Map<number, CodonException> {
  const out = new Map<number, CodonException>();
  const note = qualifiers?.note?.[0];
  for (const raw of qualifiers?.transl_except ?? []) {
    const except = parseTranslExcept(raw);
    if (!except) continue;
    out.set(except.location.start, {
      except,
      residueName: except.aa.kind === 'other' ? residueNameFromNote(note) : null,
      residueAbbreviation: except.aa.kind === 'other' ? residueAbbreviationFromNote(note) : null,
    });
  }
  return out;
}

export function codonExceptionDisplay(exception: CodonException): {
  readonly short: string;
  readonly full: string;
  readonly kind: 'amino-acid' | 'stop' | 'residue';
} {
  const { aa } = exception.except;
  switch (aa.kind) {
    case 'standard':
      return { short: aa.letter, full: aa.letter, kind: 'amino-acid' };
    case 'stop':
      return { short: '*', full: '*', kind: 'stop' };
    case 'modified':
      return { short: 'X', full: aa.abbreviation, kind: 'residue' };
    case 'other': {
      const full = exception.residueAbbreviation ?? exception.residueName ?? 'X';
      return { short: 'X', full, kind: 'residue' };
    }
  }
}

export function formatTranslExcept(except: TranslExcept): string {
  const { location, aa } = except;
  const range =
    location.start === location.end ? `${location.start}` : `${location.start}..${location.end}`;
  const positioned = location.complement ? `complement(${range})` : range;
  const qualified = location.accession ? `${location.accession}:${positioned}` : positioned;
  const value = aa.kind === 'stop' ? 'TERM' : aa.kind === 'other' ? 'OTHER' : aa.abbreviation;
  return `(pos:${qualified},aa:${value})`;
}

export function withTranslExcept(
  qualifiers: Qualifiers | undefined,
  at: number,
  except: TranslExcept | null
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(qualifiers ?? {})) {
    if (values) next[key] = [...values];
  }
  const kept = (next.transl_except ?? []).filter((raw) => {
    const parsed = parseTranslExcept(raw);
    return parsed === null || parsed.location.start !== at;
  });
  if (except) kept.push(formatTranslExcept(except));
  if (kept.length > 0) next.transl_except = kept;
  else delete next.transl_except;
  return next;
}
