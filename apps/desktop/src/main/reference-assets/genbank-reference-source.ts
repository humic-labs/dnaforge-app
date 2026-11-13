import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const GENBANK_EXTENSIONS = new Set(['.gb', '.gbk', '.gbff']);

export function isGenbankPath(path: string): boolean {
  const extension = path.toLowerCase().slice(path.lastIndexOf('.'));
  return GENBANK_EXTENSIONS.has(extension);
}

export interface SplitGenbankFeature {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly strand: '+' | '-';
  readonly phase?: 0 | 1 | 2;
}

export interface SplitGenbankRecord {
  readonly seqId: string;
  readonly organism: string | null;
  readonly accession: string | null;
  readonly sequence: string;
  readonly features: readonly SplitGenbankFeature[];
}

export function splitGenbankText(text: string): SplitGenbankRecord[] {
  const records = text
    .split(/^\/\//m)
    .map((record) => record.trim())
    .filter((record) => record.startsWith('LOCUS'));
  if (records.length === 0) {
    throw new Error('This GenBank file has no LOCUS record.');
  }
  return records.map(splitOneRecord);
}

export async function materializeGenbankSources(
  genbankPath: string,
  stagingRoot: string
): Promise<readonly [string, string]> {
  const text = await readFile(genbankPath, 'utf8');
  const records = splitGenbankText(text);
  const directory = resolve(stagingRoot, 'genbank-sources');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stem = basename(genbankPath).replace(/\.(?:gb|gbk|gbff)(?:\.gz)?$/iu, '') || 'genbank';
  const fastaPath = resolve(directory, `${stem}.fna`);
  const gffPath = resolve(directory, `${stem}.gff`);
  const fasta = records
    .map((record) => `>${record.seqId}\n${wrapSequence(record.sequence)}\n`)
    .join('');
  const gff = ['##gff-version 3'];
  for (const record of records) {
    gff.push(`##sequence-region ${record.seqId} 1 ${record.sequence.length}`);
    const organism = record.organism?.replace(/[;\n]/gu, ' ');
    gff.push(
      `${record.seqId}\tGenBank\tsource\t1\t${record.sequence.length}\t.\t+\t.\tID=source-${record.seqId}${
        organism ? `;organism=${organism}` : ''
      }`
    );
    record.features.forEach((feature, index) => {
      gff.push(
        `${record.seqId}\tGenBank\t${feature.type}\t${feature.start}\t${feature.end}\t.\t${feature.strand}\t${feature.phase ?? '.'}\tID=${feature.type}-${index + 1}`
      );
    });
  }
  await writeFile(fastaPath, fasta, 'utf8');
  await writeFile(gffPath, `${gff.join('\n')}\n`, 'utf8');
  return [fastaPath, gffPath];
}

function splitOneRecord(record: string): SplitGenbankRecord {
  const locus = record.match(/^LOCUS\s+(\S+)/u);
  if (!locus?.[1]) throw new Error('A GenBank record is missing its LOCUS name.');
  const accession = record.match(/^ACCESSION\s+(\S+)/mu)?.[1] ?? null;
  const organism = record.match(/\/organism="([^"]+)"/u)?.[1] ?? null;
  const originIndex = record.search(/^ORIGIN\s*$/mu);
  if (originIndex < 0) throw new Error(`GenBank record ${locus[1]} has no ORIGIN sequence.`);
  const featuresText = record.slice(0, originIndex);
  const origin = record
    .slice(originIndex)
    .split(/\r?\n/u)
    .slice(1)
    .join('')
    .replace(/[^acgtn]/giu, '')
    .toUpperCase();
  if (origin.length === 0) throw new Error(`GenBank record ${locus[1]} has an empty sequence.`);
  const features = readFeatureSpans(featuresText, origin.length);
  return { seqId: locus[1], organism, accession, sequence: origin, features };
}

function readFeatureSpans(featuresText: string, length: number): SplitGenbankFeature[] {
  const lines = featuresText.split(/\r?\n/u);
  const features: SplitGenbankFeature[] = [];
  let type: string | null = null;
  let location = '';
  let locationClosed = false;
  let codonStart = 1;
  const flush = () => {
    const featureType = type;
    if (!featureType) return;
    if (featureType !== 'source' && location.trim().length > 0) {
      const spans = parseGenbankLocation(location, length);
      const phases = featureType === 'CDS' ? codingPhases(spans, codonStart) : null;
      spans.forEach((span, index) => {
        features.push(
          phases
            ? { type: featureType, ...span, phase: phases[index] }
            : { type: featureType, ...span }
        );
      });
    }
    type = null;
    location = '';
    locationClosed = false;
    codonStart = 1;
  };
  for (const line of lines) {
    const feature = line.match(/^ {5}(\S+)(?:\s+(.*))?$/u);
    if (feature?.[1]) {
      flush();
      type = feature[1];
      location = feature[2] ?? '';
      locationClosed = false;
      continue;
    }
    if (!type) continue;
    const codon = line.match(/^\s+\/codon_start=([123])\s*$/u);
    if (codon?.[1]) codonStart = Number(codon[1]);
    if (locationClosed) continue;
    if (/^\s+\//u.test(line)) {
      locationClosed = true;
      continue;
    }
    const continued = line.match(/^\s+(\S.*)$/u);
    if (continued?.[1]) location += continued[1];
  }
  flush();
  return features;
}

function codingPhases(
  spans: ReadonlyArray<{ start: number; end: number; strand: '+' | '-' }>,
  codonStart: number
): Array<0 | 1 | 2> {
  const ascending = spans.every(
    (span, index) => index === 0 || span.start >= spans[index - 1].start
  );
  const order = spans.map((_, index) => index);
  if (spans.length > 1 && spans.every((span) => span.strand === '-') && ascending) order.reverse();
  const phases = new Array<0 | 1 | 2>(spans.length);
  let consumed = 0;
  for (const index of order) {
    phases[index] = ((((codonStart - 1 - consumed) % 3) + 3) % 3) as 0 | 1 | 2;
    consumed += spans[index].end - spans[index].start + 1;
  }
  return phases;
}

function parseGenbankLocation(
  raw: string,
  length: number
): Array<{ start: number; end: number; strand: '+' | '-' }> {
  const compact = raw.replace(/\s+/gu, '');
  const parsed = parseLocation(compact, 0, '+', length);
  if (parsed.index !== compact.length) {
    throw new Error(`Could not read GenBank location "${raw.trim()}".`);
  }
  return parsed.spans;
}

function parseLocation(
  source: string,
  index: number,
  strand: '+' | '-',
  length: number
): { spans: Array<{ start: number; end: number; strand: '+' | '-' }>; index: number } {
  if (source.startsWith('complement(', index)) {
    const inner = parseLocation(
      source,
      index + 'complement('.length,
      strand === '+' ? '-' : '+',
      length
    );
    return { spans: inner.spans, index: expectChar(source, inner.index, ')') + 1 };
  }
  const listWord = source.startsWith('join(', index)
    ? 'join('
    : source.startsWith('order(', index)
      ? 'order('
      : null;
  if (listWord) {
    let cursor = index + listWord.length;
    const spans: Array<{ start: number; end: number; strand: '+' | '-' }> = [];
    while (cursor < source.length && source[cursor] !== ')') {
      if (source[cursor] === ',') cursor += 1;
      const part = parseLocation(source, cursor, strand, length);
      spans.push(...part.spans);
      cursor = part.index;
    }
    return { spans, index: expectChar(source, cursor, ')') + 1 };
  }
  const span = parseSpan(source, index, strand, length);
  return { spans: [span.span], index: span.index };
}

function parseSpan(
  source: string,
  index: number,
  strand: '+' | '-',
  length: number
): { span: { start: number; end: number; strand: '+' | '-' }; index: number } {
  let cursor = index;
  if (source[cursor] === '<') cursor += 1;
  const start = readInteger(source, cursor);
  cursor = start.index;
  let endValue = start.value;
  if (source.startsWith('..', cursor)) {
    cursor += 2;
    if (source[cursor] === '>') cursor += 1;
    const end = readInteger(source, cursor);
    endValue = end.value;
    cursor = end.index;
  } else if (source[cursor] === '^') {
    const end = readInteger(source, cursor + 1);
    endValue = end.value;
    cursor = end.index;
  }
  const startValue = Math.min(start.value, endValue);
  const stopValue = Math.max(start.value, endValue);
  const startClamped = Math.max(1, startValue);
  const endClamped = Math.min(length, stopValue);
  if (endClamped < startClamped) {
    throw new Error(`GenBank location ${start.value}..${endValue} is outside the sequence.`);
  }
  return { span: { start: startClamped, end: endClamped, strand }, index: cursor };
}

function readInteger(source: string, index: number): { value: number; index: number } {
  const match = /^(\d+)/u.exec(source.slice(index));
  if (!match?.[1])
    throw new Error(
      `GenBank location is missing a coordinate near "${source.slice(index, index + 24)}".`
    );
  return { value: Number(match[1]), index: index + match[1].length };
}

function expectChar(source: string, index: number, expected: string): number {
  if (source[index] !== expected) {
    throw new Error(
      `GenBank location is missing "${expected}" near "${source.slice(index, index + 24)}".`
    );
  }
  return index;
}

function wrapSequence(sequence: string): string {
  return sequence.replace(/(.{60})/gu, '$1\n').trimEnd();
}
