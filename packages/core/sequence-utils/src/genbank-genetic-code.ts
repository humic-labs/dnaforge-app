import {
  buildCustomGeneticCode,
  validateCustomGeneticCode,
  type CodonMeaning,
  type CustomGeneticCodeDefinition,
  type NonStandardResidue,
  type StandardAminoAcidLetter,
} from './custom-genetic-codes';
import {
  GENETIC_CODE_CODONS,
  isCustomGeneticCodeSpec,
  type GeneticCodeSpec,
} from './genetic-codes';
import { GENBANK_LOCUS_ENCODING_COMMENT } from './genbank-locus';

export const GENBANK_GENETIC_CODE_COMMENT_PREFIX = 'COMMENT     DNAForge genetic-code';

const MARKER = /^COMMENT\s+DNAForge genetic-code(-name|-codons|-starts|-residue)?:\s?(.*)$/;
const MAX_LINE = 80;

export type GenBankGeneticCodeReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'code'; readonly spec: GeneticCodeSpec }
  | { readonly kind: 'unreadable'; readonly message: string };

export function isGenBankGeneticCodeLine(line: string): boolean {
  return MARKER.test(line.trimEnd());
}

export function formatGenBankGeneticCodeLines(spec: GeneticCodeSpec): string[] {
  if (!isCustomGeneticCodeSpec(spec)) return [`${GENBANK_GENETIC_CODE_COMMENT_PREFIX}: ${spec}`];

  const codonEntries = GENETIC_CODE_CODONS.filter((codon) => spec.codons[codon]).map(
    (codon) => `${codon}=${meaningToken(spec.codons[codon])}`
  );
  return [
    `${GENBANK_GENETIC_CODE_COMMENT_PREFIX}: custom ${spec.id} rev ${spec.revision}`,
    `${GENBANK_GENETIC_CODE_COMMENT_PREFIX}-name: ${spec.name}`,
    ...wrapped(`${GENBANK_GENETIC_CODE_COMMENT_PREFIX}-codons:`, codonEntries),
    ...wrapped(`${GENBANK_GENETIC_CODE_COMMENT_PREFIX}-starts:`, [...spec.startCodons]),
    ...spec.residues.map(
      (residue) =>
        `${GENBANK_GENETIC_CODE_COMMENT_PREFIX}-residue: ${residue.abbreviation} ${residue.ccd ?? '-'} ${residue.name}`
    ),
  ];
}

export function readGenBankGeneticCode(lines: readonly string[]): GenBankGeneticCodeReading {
  let head: string | undefined;
  let name: string | undefined;
  const codonTokens: string[] = [];
  const startTokens: string[] = [];
  const residueLines: string[] = [];

  for (const raw of lines) {
    const match = MARKER.exec(raw.trimEnd());
    if (!match) continue;
    const [, field, value] = match;
    switch (field) {
      case undefined:
        if (head !== undefined) return unreadable('The file records more than one genetic code.');
        head = value.trim();
        break;
      case '-name':
        name = value.trim();
        break;
      case '-codons':
        codonTokens.push(...tokens(value));
        break;
      case '-starts':
        startTokens.push(...tokens(value));
        break;
      case '-residue':
        residueLines.push(value.trim());
        break;
    }
  }

  if (head === undefined) {
    return name || codonTokens.length || startTokens.length || residueLines.length
      ? unreadable('The file has parts of a custom genetic code but not the line that starts it.')
      : { kind: 'none' };
  }

  if (/^\d+$/.test(head)) {
    const id = Number.parseInt(head, 10);
    return id > 0 ? { kind: 'code', spec: id } : unreadable(`"${head}" is not a genetic code.`);
  }

  const custom = /^custom\s+(\S+)\s+rev\s+(\d+)$/.exec(head);
  if (!custom) return unreadable(`"${head}" is not a genetic code.`);

  const codons: Record<string, CodonMeaning> = {};
  for (const token of codonTokens) {
    const pair = /^([A-Za-z]{3})=(\S+)$/.exec(token);
    if (!pair) return unreadable(`"${token}" is not a codon assignment.`);
    codons[pair[1].toUpperCase()] = tokenToMeaning(pair[2]);
  }

  const residues: NonStandardResidue[] = [];
  for (const line of residueLines) {
    const parts = /^(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!parts) return unreadable(`"${line}" is not a residue definition.`);
    residues.push({
      abbreviation: parts[1],
      name: parts[3].trim(),
      ...(parts[2] === '-' ? {} : { ccd: parts[2] }),
    });
  }

  const definition: CustomGeneticCodeDefinition = {
    id: custom[1],
    revision: Number.parseInt(custom[2], 10),
    name: name ?? '',
    codons,
    startCodons: startTokens.map((codon) => codon.toUpperCase()),
    residues,
  };
  const issues = validateCustomGeneticCode(definition);
  if (issues.length > 0) {
    return unreadable(
      `The custom genetic code "${definition.name || definition.id}" in this file is damaged: ${issues[0].message}`
    );
  }

  const normalized = buildCustomGeneticCode({
    id: definition.id,
    revision: definition.revision,
    name: definition.name,
    base: 1,
    changes: definition.codons,
    startCodons: definition.startCodons,
    residues: definition.residues,
  });
  return normalized.ok
    ? { kind: 'code', spec: normalized.definition }
    : unreadable(normalized.issues[0].message);
}

export function updateGenBankGeneticCodeComment(
  content: string,
  spec: GeneticCodeSpec | null
): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const header = headerLineCount(lines);
  const existing: number[] = [];
  for (let i = 0; i < header; i++) {
    if (isGenBankGeneticCodeLine(lines[i])) existing.push(i);
  }

  const replacement = spec === null ? [] : formatGenBankGeneticCodeLines(spec);
  if (
    existing.length === replacement.length &&
    existing.every((index, i) => lines[index] === replacement[i])
  ) {
    return content;
  }

  let insertAt: number;
  if (existing.length > 0) {
    insertAt = existing[0];
    for (const index of [...existing].reverse()) lines.splice(index, 1);
  } else {
    if (replacement.length === 0) return content;
    const locusEncoding = lines.findIndex((line) => line === GENBANK_LOCUS_ENCODING_COMMENT);
    const locus = lines.findIndex((line) => /^LOCUS\b/.test(line));
    if (locusEncoding === -1 && locus === -1) {
      throw new Error('GenBank text has no LOCUS line to anchor the genetic-code marker to.');
    }
    insertAt = (locusEncoding === -1 ? locus : locusEncoding) + 1;
  }
  lines.splice(insertAt, 0, ...replacement);
  return lines.join(newline);
}

function headerLineCount(lines: readonly string[]): number {
  const end = lines.findIndex((line) => /^(FEATURES|ORIGIN)\b/.test(line));
  return end === -1 ? lines.length : end;
}

function meaningToken(meaning: CodonMeaning): string {
  switch (meaning.kind) {
    case 'amino-acid':
      return meaning.letter;
    case 'stop':
      return '*';
    case 'residue':
      return meaning.residue;
    case 'unassigned':
      return 'unassigned';
  }
}

function tokenToMeaning(token: string): CodonMeaning {
  if (token === '*') return { kind: 'stop' };
  if (token === 'unassigned') return { kind: 'unassigned' };
  if (token.length === 1) return { kind: 'amino-acid', letter: token as StandardAminoAcidLetter };
  return { kind: 'residue', residue: token };
}

function tokens(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function wrapped(label: string, entries: readonly string[]): string[] {
  if (entries.length === 0) return [];
  const out: string[] = [];
  let line = label;
  for (const entry of entries) {
    if (line !== label && line.length + 1 + entry.length > MAX_LINE) {
      out.push(line);
      line = label;
    }
    line = `${line} ${entry}`;
  }
  out.push(line);
  return out;
}

function unreadable(message: string): GenBankGeneticCodeReading {
  return { kind: 'unreadable', message };
}
