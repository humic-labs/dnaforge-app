import type { AnnotatedSequence, Annotation } from '../types';
import { formatGenBankLocusPrefix, GENBANK_LOCUS_ENCODING_COMMENT } from '../genbank-locus';
import { formatGenBankGeneticCodeLines } from '../genbank-genetic-code';
import { inferFeatureTypeFromLabel } from '../annotation-type-inference';
import { parseFeatureLocation, resolveGenBankFeatureDirection } from '../parsers/genbank';

export function formatOrigin(sequence: string): string {
  if (!sequence) return 'ORIGIN\n//\n';
  const lines: string[] = ['ORIGIN'];
  const seq = sequence;
  for (let i = 0; i < seq.length; i += 60) {
    const lineNum = String(i + 1).padStart(9, ' ');
    const chunk = seq.slice(i, i + 60);
    const groups = chunk.match(/.{1,10}/g) || [];
    lines.push(`${lineNum} ${groups.join(' ')}`);
  }
  lines.push('//');
  return lines.join('\n') + '\n';
}

export function formatFeature(annotation: Annotation): string {
  const name = annotation.name || annotation.type || 'unknown';
  const type = annotation.type || 'misc_feature';
  const start = annotation.start ?? 1;
  const end = annotation.end ?? start;

  const lines: string[] = [];

  const location = buildLocationString(
    start,
    end,
    annotation.direction,
    annotation.qualifiers,
    annotation.segments
  );
  const sourceQualifiers = annotation.qualifiers ?? {};
  const resolvedType = sourceQualifiers.dnaforge_original_type?.length
    ? type
    : inferFeatureTypeFromLabel(type, name);
  const inferredDirection = resolveGenBankFeatureDirection(
    parseFeatureLocation(location),
    resolvedType,
    sourceQualifiers
  );
  const qualifiers =
    inferredDirection === annotation.direction
      ? sourceQualifiers
      : {
          ...sourceQualifiers,
          direction: [
            annotation.direction === 1 ? 'RIGHT' : annotation.direction === -1 ? 'LEFT' : 'NONE',
            ...(sourceQualifiers.direction?.slice(1) ?? []),
          ],
        };

  const featureLine = `     ${type.padEnd(16)}${location}`;
  lines.push(featureLine);

  for (const label of [name, ...(annotation.qualifiers?.label?.slice(1) ?? [])]) {
    lines.push(...wrapQualifier('label', label));
  }

  if (Object.keys(qualifiers).length > 0) {
    for (const [key, values] of Object.entries(qualifiers)) {
      if (key === 'label') continue;
      if (key.startsWith('_')) continue;
      if (!values || values.length === 0) continue;
      for (const value of values) {
        if (!value && value !== '') continue;
        lines.push(...wrapQualifier(key, value));
      }
    }
  }

  return lines.join('\n');
}

function buildLocationString(
  start: number,
  end: number,
  direction: 1 | -1 | 0,
  qualifiers?: Record<string, string[]>,
  segments?: Array<{ start: number; end: number }>
): string {
  const storedLocation = qualifiers?._locationString?.[0];
  if (storedLocation) return storedLocation;

  // exported file yields a CDS that translates to garbage. Anything the app
  const range =
    segments && segments.length > 1
      ? `join(${segments.map((segment) => `${segment.start}..${segment.end}`).join(',')})`
      : `${start}..${end}`;
  if (direction === -1) {
    return `complement(${range})`;
  }
  return range;
}

function wrapQualifier(key: string, value: string): string[] {
  const indent = ' '.repeat(21);
  const escaped = value.replace(/"/g, '""');
  const fullLine = `${indent}/${key}="${escaped}"`;

  if (fullLine.length <= 80) {
    return [fullLine];
  }

  const lines: string[] = [];
  const prefix = `${indent}/${key}="`;
  let remaining = escaped + '"';
  let first = true;

  while (remaining.length > 0) {
    if (first) {
      const maxChars = 80 - prefix.length;
      const chunkLength = qualifierChunkLength(remaining, maxChars, key === 'translation');
      lines.push(prefix + remaining.slice(0, chunkLength));
      remaining = remaining.slice(chunkLength);
      first = false;
    } else {
      const maxChars = 80 - indent.length;
      const chunkLength = qualifierChunkLength(remaining, maxChars, key === 'translation');
      lines.push(indent + remaining.slice(0, chunkLength));
      remaining = remaining.slice(chunkLength);
    }
  }

  return lines;
}

function qualifierChunkLength(value: string, maxChars: number, hardWrap: boolean): number {
  if (!hardWrap) {
    if (value.length <= maxChars) return value.length;
    let lastBoundary = 0;
    for (let index = 1; index < value.length - 1; index += 1) {
      if (value[index] !== ' ' || /\s/.test(value[index - 1]) || /\s/.test(value[index + 1]))
        continue;
      const boundary = index + 1;
      if (boundary > maxChars) return lastBoundary || boundary;
      lastBoundary = boundary;
    }
    return lastBoundary || value.length;
  }
  let length = Math.min(value.length, maxChars);
  if (length < value.length && value[length - 1] === '"' && value[length] === '"') {
    length -= 1;
  }
  return Math.max(1, length);
}

export function formatFeatures(annotations: Annotation[]): string {
  if (annotations.length === 0) return '';

  const lines: string[] = ['FEATURES             Location/Qualifiers'];

  for (const ann of annotations) {
    lines.push(formatFeature(ann));
  }

  return lines.join('\n') + '\n';
}

function formatGenBankDate(date: Date = new Date()): string {
  const months = [
    'JAN',
    'FEB',
    'MAR',
    'APR',
    'MAY',
    'JUN',
    'JUL',
    'AUG',
    'SEP',
    'OCT',
    'NOV',
    'DEC',
  ];
  const day = String(date.getDate()).padStart(2, '0');
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

export function serializeGenBank(seq: AnnotatedSequence, options: { date?: Date } = {}): string {
  const sections: string[] = [];

  const locus = formatGenBankLocusPrefix(seq.name, seq.length);
  const topology = (seq.circular ? 'circular' : 'linear').padEnd(8);
  const molecule = `${seq.molecule ?? 'DNA'} `.padEnd(8);
  sections.push(`${locus} bp    ${molecule}${topology} UNK ${formatGenBankDate(options.date)}`);

  if (seq.description) {
    sections.push(`DEFINITION  ${seq.description}`);
  }

  const identifier = encodeURIComponent(seq.name || 'Unknown');
  sections.push(`ACCESSION   ${identifier}`);
  sections.push(`VERSION     ${identifier}`);
  sections.push(GENBANK_LOCUS_ENCODING_COMMENT);
  if (seq.chosenGeneticCode !== undefined) {
    sections.push(...formatGenBankGeneticCodeLines(seq.chosenGeneticCode));
  }

  const features = formatFeatures(seq.annotations);
  if (features) {
    sections.push(features.trimEnd());
  }

  sections.push(formatOrigin(seq.sequence).trimEnd());

  return sections.join('\n') + '\n';
}
