export type AccessionScheme = 'addgene' | 'genbank' | 'refseq';

export interface AccessionRef {
  scheme: AccessionScheme;
  id: string;
}

const REFSEQ_RE = /\b([A-Z]{2}_\d+)(?:\.\d+)?\b/g;

const GENBANK_RE =
  /\b([A-Z]\d{5}|[A-Z]{2}\d{6}|[A-Z]{2}\d{8}|[A-Z]{3}\d{5}|[A-Z]{3}\d{7})(?:\.\d+)?\b/g;

const ADDGENE_RE = /addgene[\s:#]*(\d+)|#\s*(\d+)/gi;

interface FoundAccession {
  scheme: AccessionScheme;
  id: string;
  index: number;
}

function stripVersion(id: string): string {
  return id.replace(/\.\d+$/, '');
}

export function accessionIdentityKey(ref: AccessionRef): string {
  const normalizedId = stripVersion(ref.id).toLowerCase();
  return `acc:${ref.scheme}:${normalizedId}`;
}

function collectRefSeq(text: string, out: FoundAccession[]): void {
  REFSEQ_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFSEQ_RE.exec(text)) !== null) {
    out.push({ scheme: 'refseq', id: match[1].toUpperCase(), index: match.index });
  }
}

function collectGenBank(
  text: string,
  refseqSpans: readonly [number, number][],
  out: FoundAccession[]
): void {
  GENBANK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GENBANK_RE.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const overlapsRefSeq = refseqSpans.some(([s, e]) => start < e && end > s);
    if (overlapsRefSeq) continue;
    out.push({ scheme: 'genbank', id: match[1].toUpperCase(), index: start });
  }
}

function collectAddgene(text: string, out: FoundAccession[]): void {
  ADDGENE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ADDGENE_RE.exec(text)) !== null) {
    const digits = match[1] ?? match[2];
    if (!digits) continue;
    out.push({ scheme: 'addgene', id: digits, index: match.index });
  }
}

export function parseAccessions(text: string): AccessionRef[] {
  if (!text) return [];

  const found: FoundAccession[] = [];
  collectRefSeq(text, found);
  const refseqSpans = found.map((f): [number, number] => [f.index, f.index + f.id.length]);
  collectGenBank(text, refseqSpans, found);
  collectAddgene(text, found);

  found.sort((a, b) => a.index - b.index);

  const seen = new Set<string>();
  const result: AccessionRef[] = [];
  for (const f of found) {
    const ref: AccessionRef = { scheme: f.scheme, id: stripVersion(f.id) };
    const key = accessionIdentityKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

export function parseAccessionIdentity(value: string): AccessionRef | null {
  const refs = parseAccessions(value);
  return refs.length === 1 ? refs[0] : null;
}

function collectKeys(text: string, seen: Set<string>, out: string[]): void {
  for (const ref of parseAccessions(text)) {
    const key = accessionIdentityKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
}

export function extractRowAccessions(
  row: Record<string, string>,
  accessionColumnKeys: readonly string[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const columnKey of accessionColumnKeys) {
    const cell = row[columnKey];
    if (typeof cell === 'string') collectKeys(cell, seen, out);
  }
  return out;
}

export function accessionKeysForEntityFields(fields: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const accessions = fields.accessions;
  if (Array.isArray(accessions)) {
    for (const entry of accessions) {
      if (typeof entry === 'string') collectKeys(entry, seen, out);
    }
  }

  for (const key of ['source', 'notes'] as const) {
    const value = fields[key];
    if (typeof value === 'string') collectKeys(value, seen, out);
  }

  return out;
}
