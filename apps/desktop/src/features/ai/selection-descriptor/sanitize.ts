const CONTROL_AND_FORMAT_CHARS = new RegExp(
  '[' +
    '\\u0000-\\u001F' +
    '\\u007F-\\u009F' +
    '\\u200B-\\u200F' +
    '\\u202A-\\u202E' +
    '\\u2060' +
    '\\u2066-\\u2069' +
    '\\uFEFF' +
    ']',
  'g'
);

const WHITESPACE_FOLD = /[\t\r\n]+/g;
const MULTISPACE = / {2,}/g;

export const TRUNCATION_MARKER = '…';

function stripControlAndFormat(input: string): string {
  return input
    .replace(WHITESPACE_FOLD, ' ')
    .replace(CONTROL_AND_FORMAT_CHARS, '')
    .replace(MULTISPACE, ' ')
    .trim();
}

function toGraphemes(input: string): string[] {
  return Array.from(input);
}

function capOnGraphemeBoundary(input: string, capGraphemes: number): string {
  if (capGraphemes <= 0) return '';
  const graphemes = toGraphemes(input);
  if (graphemes.length <= capGraphemes) return input;
  return graphemes.slice(0, capGraphemes).join('') + TRUNCATION_MARKER;
}

export function sanitizeUntrusted(input: string | null | undefined, capGraphemes: number): string {
  if (!input) return '';
  return capOnGraphemeBoundary(stripControlAndFormat(input), capGraphemes);
}

export function truncateMiddleOut(input: string | null | undefined, capGraphemes: number): string {
  const cleaned = stripControlAndFormat(input ?? '');
  if (!cleaned) return '';
  const graphemes = toGraphemes(cleaned);
  if (graphemes.length <= capGraphemes) return cleaned;
  if (capGraphemes < 8) return capOnGraphemeBoundary(cleaned, capGraphemes);

  const budget = capGraphemes - 1;
  const headLen = Math.ceil(budget * 0.6);
  const tailLen = budget - headLen;
  const head = graphemes.slice(0, headLen).join('').trimEnd();
  const tail = graphemes
    .slice(graphemes.length - tailLen)
    .join('')
    .trimStart();
  return `${head}${TRUNCATION_MARKER}${tail}`;
}

export function untrustedField(
  value: string | null | undefined,
  capGraphemes: number,
  { middleOut = false }: { middleOut?: boolean } = {}
): { value: string; trust: 'untrusted-data' } | null {
  const sanitized = middleOut
    ? truncateMiddleOut(value, capGraphemes)
    : sanitizeUntrusted(value, capGraphemes);
  if (!sanitized) return null;
  return { value: sanitized, trust: 'untrusted-data' };
}

export const DB_XREF_ALLOWLIST = [
  'GeneID',
  'UniProtKB',
  'UniProtKB/Swiss-Prot',
  'UniProtKB/TrEMBL',
  'PDB',
  'GO',
  'InterPro',
  'EC',
  'taxon',
  'RefSeq',
  'HGNC',
  'Ensembl',
] as const;

const DB_XREF_ALLOWLIST_LOWER = new Set(DB_XREF_ALLOWLIST.map((n) => n.toLowerCase()));

export function allowlistDbXref(xref: string | null | undefined): string | null {
  if (!xref) return null;
  const raw = xref.trim();
  const colon = raw.indexOf(':');
  if (colon <= 0) return null;
  const namespace = raw.slice(0, colon);
  if (!DB_XREF_ALLOWLIST_LOWER.has(namespace.toLowerCase())) return null;
  const accession = sanitizeUntrusted(raw.slice(colon + 1), 64);
  if (!accession) return null;
  const canonical = DB_XREF_ALLOWLIST.find((n) => n.toLowerCase() === namespace.toLowerCase());
  return `${canonical}:${accession}`;
}
