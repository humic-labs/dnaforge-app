export const GENOME_SESSION_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const GENOME_SESSION_FILE_MAX_RESOURCES = 512;

export type GenomeSessionFileKind = 'igv-session' | 'ucsc-custom-tracks';

export type GenomeSessionResourceLocator =
  | Readonly<{ kind: 'path'; path: string; relative: boolean }>
  | Readonly<{ kind: 'url'; url: string }>
  | Readonly<{ kind: 's3'; bucket: string; key: string }>
  | Readonly<{ kind: 'gcs'; bucket: string; object: string }>;

export interface GenomeSessionResource {
  readonly source: GenomeSessionResourceLocator;
  readonly index?: GenomeSessionResourceLocator;
  readonly label?: string;
  readonly formatId?: string;
}

export interface GenomeSessionLocus {
  readonly chrom: string;
  readonly start0?: number;
  readonly end0?: number;
}

export interface GenomeSessionSkip {
  readonly subject: string;
  readonly reason: string;
}

export interface DecodedGenomeSessionFile {
  readonly kind: GenomeSessionFileKind;
  readonly genome?: string;
  readonly locus?: GenomeSessionLocus;
  readonly resources: ReadonlyArray<GenomeSessionResource>;
  readonly skipped: ReadonlyArray<GenomeSessionSkip>;
}

const IGV_TYPE_TO_FORMAT: Readonly<Record<string, string>> = {
  bam: 'bam',
  cram: 'cram',
  vcf: 'vcf',
  'vcf.gz': 'vcf',
  bcf: 'bcf',
  bw: 'bigwig',
  bigwig: 'bigwig',
  bb: 'bigbed',
  bigbed: 'bigbed',
  bed: 'bed',
  gff: 'gff3',
  gff3: 'gff3',
  gtf: 'gtf',
  narrowpeak: 'narrowpeak',
  broadpeak: 'broadpeak',
};

const UCSC_TYPE_TO_FORMAT: Readonly<Record<string, string>> = {
  bigwig: 'bigwig',
  bigbed: 'bigbed',
  bam: 'bam',
  cram: 'cram',
  vcftabix: 'vcf',
  vcf: 'vcf',
};

const CREDENTIAL_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'credential',
  'key',
  'password',
  'secret',
  'sig',
  'signature',
  'token',
]);
const CREDENTIAL_QUERY_PREFIXES = ['x-amz-', 'x-goog-'];
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

function withoutByteOrderMark(text: string): string {
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
}

export function detectGenomeSessionFileKind(
  fileName: string,
  head: string
): GenomeSessionFileKind | null {
  const lower = fileName.toLowerCase();
  const text = withoutByteOrderMark(head).trimStart();
  if (lower.endsWith('.xml') || text.startsWith('<?xml') || /^<Session\b/iu.test(text)) {
    return /<Session\b/iu.test(head) ? 'igv-session' : null;
  }
  const firstLine = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));
  if (firstLine && /^(browser|track)\s/iu.test(firstLine)) return 'ucsc-custom-tracks';
  return null;
}

export function decodeGenomeSessionFile(
  kind: GenomeSessionFileKind,
  text: string
): DecodedGenomeSessionFile {
  assertBounded(text);
  return kind === 'igv-session' ? decodeIgvSession(text) : decodeUcscCustomTracks(text);
}

export function decodeIgvSession(text: string): DecodedGenomeSessionFile {
  assertBounded(text);
  const session = firstTag(text, 'Session');
  if (!session) throw new Error('The file is not an IGV session: it has no <Session> element.');
  const sessionAttributes = attributesOf(session);
  const genome = cleanOptional(sessionAttributes.genome);
  const locus = parseLocus(sessionAttributes.locus);
  const resources: GenomeSessionResource[] = [];
  const skipped: GenomeSessionSkip[] = [];
  const seen = new Set<string>();
  for (const tag of allTags(text, 'Resource')) {
    if (resources.length + skipped.length >= GENOME_SESSION_FILE_MAX_RESOURCES) {
      throw new Error(
        `The session names more than ${GENOME_SESSION_FILE_MAX_RESOURCES} resources.`
      );
    }
    const attributes = attributesOf(tag);
    const path = cleanOptional(attributes.path);
    if (!path) {
      skipped.push({ subject: 'Resource', reason: 'names no path' });
      continue;
    }
    const identity = path;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const source = locatorFor(path);
    if ('reason' in source) {
      skipped.push({ subject: path, reason: source.reason });
      continue;
    }
    const indexPath = cleanOptional(attributes.index);
    const index = indexPath ? locatorFor(indexPath) : undefined;
    if (index && 'reason' in index) {
      skipped.push({ subject: path, reason: `its index ${index.reason}` });
      continue;
    }
    const type = cleanOptional(attributes.type)?.toLowerCase();
    const formatId = type ? IGV_TYPE_TO_FORMAT[type] : undefined;
    resources.push({
      source,
      ...(index ? { index } : {}),
      ...(cleanOptional(attributes.name) ? { label: cleanOptional(attributes.name) } : {}),
      ...(formatId ? { formatId } : {}),
    });
  }
  return {
    kind: 'igv-session',
    ...(genome ? { genome } : {}),
    ...(locus ? { locus } : {}),
    resources,
    skipped,
  };
}

export function decodeUcscCustomTracks(text: string): DecodedGenomeSessionFile {
  assertBounded(text);
  const resources: GenomeSessionResource[] = [];
  const skipped: GenomeSessionSkip[] = [];
  const seen = new Set<string>();
  let locus: GenomeSessionLocus | undefined;
  let genome: string | undefined;
  let pendingInline: { readonly label: string } | null = null;
  let inlineCount = 0;
  for (const rawLine of withoutByteOrderMark(text).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^browser\s/iu.test(line)) {
      const position = /^browser\s+position\s+(\S+)/iu.exec(line);
      if (position) locus = parseLocus(position[1]) ?? locus;
      const db = /^browser\s+(?:db|genome)\s+(\S+)/iu.exec(line);
      if (db) genome = db[1];
      continue;
    }
    if (/^track\s/iu.test(line)) {
      if (pendingInline && inlineCount > 0) {
        skipped.push({ subject: pendingInline.label, reason: 'carries inline data lines' });
      }
      pendingInline = null;
      inlineCount = 0;
      if (resources.length + skipped.length >= GENOME_SESSION_FILE_MAX_RESOURCES) {
        throw new Error(`The file names more than ${GENOME_SESSION_FILE_MAX_RESOURCES} tracks.`);
      }
      const settings = parseTrackLine(line);
      const label = settings.name ?? settings.description ?? `track ${resources.length + 1}`;
      const bigDataUrl = settings.bigdataurl;
      if (!bigDataUrl) {
        pendingInline = { label };
        continue;
      }
      if (seen.has(bigDataUrl)) continue;
      seen.add(bigDataUrl);
      const source = locatorFor(bigDataUrl);
      if ('reason' in source) {
        skipped.push({ subject: label, reason: source.reason });
        continue;
      }
      const indexUrl = settings.bigdataindex;
      const index = indexUrl ? locatorFor(indexUrl) : undefined;
      if (index && 'reason' in index) {
        skipped.push({ subject: label, reason: `its index ${index.reason}` });
        continue;
      }
      const type = settings.type?.split(/\s+/u)[0]?.toLowerCase();
      const formatId = type ? UCSC_TYPE_TO_FORMAT[type] : undefined;
      if (type && !formatId) {
        skipped.push({ subject: label, reason: `has unsupported track type ${type}` });
        continue;
      }
      resources.push({
        source,
        ...(index ? { index } : {}),
        label,
        ...(formatId ? { formatId } : {}),
      });
      continue;
    }
    if (pendingInline) inlineCount += 1;
  }
  if (pendingInline && inlineCount > 0) {
    skipped.push({ subject: pendingInline.label, reason: 'carries inline data lines' });
  }
  if (resources.length === 0 && skipped.length === 0 && !locus) {
    throw new Error('The file has no browser or track lines.');
  }
  return {
    kind: 'ucsc-custom-tracks',
    ...(genome ? { genome } : {}),
    ...(locus ? { locus } : {}),
    resources,
    skipped,
  };
}

export function parseLocus(raw: string | undefined): GenomeSessionLocus | undefined {
  const clean = raw?.trim();
  if (!clean || clean.toLowerCase() === 'all') return undefined;
  const match = /^([^\s:]+)(?::([\d,]+)-([\d,]+))?$/u.exec(clean);
  if (!match) return undefined;
  const chrom = match[1]!;
  if (match[2] === undefined || match[3] === undefined) return { chrom };
  const start1 = Number(match[2].replace(/,/gu, ''));
  const end1 = Number(match[3].replace(/,/gu, ''));
  if (!Number.isSafeInteger(start1) || !Number.isSafeInteger(end1) || start1 < 1 || end1 < start1) {
    return { chrom };
  }
  return { chrom, start0: start1 - 1, end0: end1 };
}

function assertBounded(text: string): void {
  if (new TextEncoder().encode(text).length > GENOME_SESSION_FILE_MAX_BYTES) {
    throw new Error('The session file is larger than 4 MiB.');
  }
}

function firstTag(text: string, name: string): string | null {
  const match = new RegExp(`<${name}\\b[^>]*>`, 'iu').exec(text);
  return match ? match[0] : null;
}

function allTags(text: string, name: string): string[] {
  return text.match(new RegExp(`<${name}\\b[^>]*>`, 'giu')) ?? [];
}

function attributesOf(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag)) !== null) {
    attributes[match[1]!] = decodeXmlEntities(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&amp;/gu, '&');
}

function parseTrackLine(line: string): Record<string, string> {
  const settings: Record<string, string> = {};
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line.slice('track'.length))) !== null) {
    settings[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return settings;
}

function cleanOptional(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean ? clean : undefined;
}

function locatorFor(raw: string): GenomeSessionResourceLocator | { readonly reason: string } {
  const value = raw.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(value)?.[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return { reason: 'is not a valid URL' };
    }
    if (!parsed.hostname) return { reason: 'is not a valid URL' };
    if (parsed.username || parsed.password) return { reason: 'carries credentials in its URL' };
    for (const key of parsed.searchParams.keys()) {
      const normalized = key.toLowerCase();
      if (
        CREDENTIAL_QUERY_KEYS.has(normalized) ||
        CREDENTIAL_QUERY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
      ) {
        return { reason: 'carries credential parameters in its URL' };
      }
    }
    parsed.hash = '';
    return { kind: 'url', url: parsed.href };
  }
  if (scheme === 's3' || scheme === 'gs') {
    const rest = value.slice(scheme.length + 3);
    const slash = rest.indexOf('/');
    const bucket = slash < 0 ? rest : rest.slice(0, slash);
    const key = slash < 0 ? '' : rest.slice(slash + 1);
    if (!bucket || !key) return { reason: `is not a complete ${scheme}:// object address` };
    return scheme === 's3' ? { kind: 's3', bucket, key } : { kind: 'gcs', bucket, object: key };
  }
  if (scheme) return { reason: `uses unsupported scheme ${scheme}://` };
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')) {
    return { kind: 'path', path: value, relative: false };
  }
  return { kind: 'path', path: value, relative: true };
}
