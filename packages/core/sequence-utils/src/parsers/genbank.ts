import type { AnnotatedSequence, Annotation, AnnotationDirection } from '../types';
import { genBankFeatureColor } from '../colors';
import { inferFeatureTypeFromLabel } from '../annotation-type-inference';
import { planSplitCDSMerges } from './split-cds-merge';
import { decodeGenBankLocusName, GENBANK_LOCUS_ENCODING_COMMENT } from '../genbank-locus';
import { isGenBankGeneticCodeLine, readGenBankGeneticCode } from '../genbank-genetic-code';
import { parseGenBankMoleculeLabel } from '../molecule-type';

export interface FeatureLocation {
  start: number;
  end: number;
  complement: boolean;

  segments?: Array<{ start: number; end: number }>;

  locationString?: string;
}

export interface IndexedGenBankRecord {
  readonly ordinal: number;
  readonly startByte: number;
  readonly endByteExclusive: number;
  readonly name: string;
  readonly length: number;
  readonly circular: boolean;
}

interface RawFeature {
  type: string;
  qualifiers: Record<string, string[]>;
  location: FeatureLocation;
  locationString: string;
}

export class GenBankParseError extends Error {
  constructor(
    message: string,
    public line?: number
  ) {
    super(line ? `Line ${line}: ${message}` : message);
    this.name = 'GenBankParseError';
  }
}

const LOCUS_PREFIX = [0x4c, 0x4f, 0x43, 0x55, 0x53] as const;

function lineStartsWith(bytes: Uint8Array, start: number, prefix: readonly number[]): boolean {
  return prefix.every((byte, offset) => bytes[start + offset] === byte);
}

function isRecordTerminator(bytes: Uint8Array, start: number, end: number): boolean {
  if (bytes[start] !== 0x2f || bytes[start + 1] !== 0x2f) return false;
  for (let offset = start + 2; offset < end; offset++) {
    if (bytes[offset] !== 0x20 && bytes[offset] !== 0x09) return false;
  }
  return true;
}

export function indexGenBankRecords(
  sourceBytes: Uint8Array,
  options: { readonly maxRecords?: number } = {}
): IndexedGenBankRecord[] {
  if (
    options.maxRecords !== undefined &&
    (!Number.isSafeInteger(options.maxRecords) || options.maxRecords < 1)
  ) {
    throw new GenBankParseError('maxRecords must be a positive integer');
  }
  const ranges: Array<{ startByte: number; endByteExclusive: number }> = [];
  let openRecordStart: number | undefined;
  let lineStart = 0;

  while (lineStart < sourceBytes.byteLength) {
    let lineEnd = lineStart;
    while (
      lineEnd < sourceBytes.byteLength &&
      sourceBytes[lineEnd] !== 0x0a &&
      sourceBytes[lineEnd] !== 0x0d
    ) {
      lineEnd += 1;
    }
    let nextLineStart = lineEnd;
    if (sourceBytes[nextLineStart] === 0x0d) nextLineStart += 1;
    if (sourceBytes[nextLineStart] === 0x0a) nextLineStart += 1;

    if (lineStartsWith(sourceBytes, lineStart, LOCUS_PREFIX)) {
      if (openRecordStart !== undefined) {
        throw new GenBankParseError('Found a new LOCUS before the previous record terminator');
      }
      openRecordStart = lineStart;
    } else if (isRecordTerminator(sourceBytes, lineStart, lineEnd)) {
      if (openRecordStart === undefined) {
        throw new GenBankParseError('Found a record terminator before a LOCUS line');
      }
      ranges.push({ startByte: openRecordStart, endByteExclusive: nextLineStart });
      if (options.maxRecords !== undefined && ranges.length > options.maxRecords) {
        throw new GenBankParseError(
          `GenBank source contains more than ${options.maxRecords.toLocaleString()} records`
        );
      }
      openRecordStart = undefined;
    }

    lineStart = nextLineStart;
  }

  if (openRecordStart !== undefined) {
    throw new GenBankParseError('GenBank record is missing its // terminator');
  }
  if (ranges.length === 0) {
    throw new GenBankParseError('No complete GenBank records found');
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  return ranges.map((range, ordinal) => {
    let parsed: AnnotatedSequence;
    try {
      parsed = parseGenBankFull(
        decoder.decode(sourceBytes.subarray(range.startByte, range.endByteExclusive))
      );
    } catch (error) {
      throw new GenBankParseError(
        `Record ${ordinal + 1} could not be parsed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!parsed.sequence) {
      throw new GenBankParseError(`Record ${ordinal + 1} contains no sequence`);
    }
    return {
      ordinal,
      ...range,
      name: parsed.name,
      length: parsed.sequence.length,
      circular: parsed.circular ?? false,
    };
  });
}

export function parseGenBankRecords(content: string): AnnotatedSequence[] {
  const lines = content.split(/\r?\n/);
  const recordContents: string[] = [];
  let currentRecord: string[] | undefined;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];

    if (/^LOCUS\b/.test(line)) {
      if (currentRecord) {
        throw new GenBankParseError(
          'Found a new LOCUS before the previous record terminator',
          lineIndex + 1
        );
      }
      currentRecord = [line];
      continue;
    }

    if (!currentRecord) {
      continue;
    }

    currentRecord.push(line);
    if (/^\/\/\s*$/.test(line)) {
      recordContents.push(currentRecord.join('\n'));
      currentRecord = undefined;
    }
  }

  if (currentRecord) {
    throw new GenBankParseError('GenBank record is missing its // terminator');
  }

  if (recordContents.length === 0) {
    const parsed = parseGenBankFull(content);
    if (!parsed.sequence && !isDeclaredEmptyGenBankRecord(content, parsed)) {
      throw new GenBankParseError('No sequence found in GenBank file');
    }
    return [parsed];
  }

  return recordContents.map((record) => {
    const parsed = parseGenBankFull(record);
    if (!parsed.sequence && !isDeclaredEmptyGenBankRecord(record, parsed)) {
      throw new GenBankParseError('No sequence found in GenBank file');
    }
    return parsed;
  });
}

export function parseGenBankFull(
  content: string,
  options: { readonly featurePolicy?: 'preserve' | 'infer' } = {}
): AnnotatedSequence {
  const lines = content.split(/\r?\n/);

  let name = 'Unknown';
  let locusNameEncoded = false;
  const geneticCodeLines: string[] = [];
  let length = 0;

  let circular = false;
  let molecule: string | null = null;
  let definition = '';
  let sequence = '';
  const rawFeatures: RawFeature[] = [];

  let currentSection = '';
  let currentFeatureType = '';
  let currentQualifiers: Record<string, string[]> = {};
  let currentQualifierKey = '';
  let currentQualifierValue = '';
  let currentQualifierIsQuoted = false;
  let currentQualifierQuoteOpen = false;
  let featureLocationStr = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (currentSection === 'DEFINITION' && /^[A-Z]/.test(line)) currentSection = '';

    if (line.startsWith('LOCUS')) {
      const locusMatch = line.match(/^LOCUS\s+(.+?)\s+(\d+)\s+bp\b(.*)$/i);
      if (locusMatch) {
        name = locusMatch[1].trim();
        length = parseInt(locusMatch[2], 10);
        molecule = parseGenBankMoleculeLabel(locusMatch[3] ?? '');
        const topologyMatch = locusMatch[3]?.match(/\b(circular|linear)\b/i);
        if (topologyMatch) {
          circular = topologyMatch[1].toLowerCase() === 'circular';
        }
      }
      continue;
    }

    if (line === GENBANK_LOCUS_ENCODING_COMMENT) {
      locusNameEncoded = true;
      continue;
    }

    if (currentSection !== 'FEATURES' && isGenBankGeneticCodeLine(line)) {
      geneticCodeLines.push(line);
      continue;
    }

    if (line.startsWith('DEFINITION')) {
      definition = line.substring(12).trim();
      currentSection = 'DEFINITION';
      continue;
    }

    if (currentSection === 'DEFINITION' && line.startsWith('            ')) {
      definition += ' ' + line.trim();
      continue;
    }

    if (line.startsWith('FEATURES')) {
      currentSection = 'FEATURES';
      continue;
    }

    if (line.startsWith('ORIGIN')) {
      if (currentFeatureType && featureLocationStr) {
        saveCurrentQualifier(currentQualifiers, currentQualifierKey, currentQualifierValue);
        rawFeatures.push(
          buildRawFeature(currentFeatureType, currentQualifiers, featureLocationStr)
        );

        currentFeatureType = '';
        currentQualifierKey = '';
        currentQualifierValue = '';
        currentQualifierIsQuoted = false;
        currentQualifierQuoteOpen = false;
      }
      currentSection = 'ORIGIN';
      continue;
    }

    if (line.startsWith('//')) {
      break;
    }

    if (currentSection === 'FEATURES') {
      const featureMatch = line.match(/^ {5}(\S+)\s+(.+)$/);
      if (featureMatch) {
        if (currentFeatureType && featureLocationStr) {
          saveCurrentQualifier(currentQualifiers, currentQualifierKey, currentQualifierValue);
          rawFeatures.push(
            buildRawFeature(currentFeatureType, currentQualifiers, featureLocationStr)
          );
        }

        currentFeatureType = featureMatch[1];
        featureLocationStr = featureMatch[2];
        currentQualifiers = {};
        currentQualifierKey = '';
        currentQualifierValue = '';
        currentQualifierIsQuoted = false;
        currentQualifierQuoteOpen = false;
        continue;
      }

      if (currentQualifierKey && currentQualifierIsQuoted && currentQualifierQuoteOpen) {
        const indentedContinuation = line.match(/^ {21}(.*)$/);
        const columnZeroContinuation =
          !indentedContinuation &&
          /^\S/.test(line) &&
          !/^(?:LOCUS|DEFINITION|ACCESSION|VERSION|DBLINK|KEYWORDS|SOURCE|REFERENCE|COMMENT|FEATURES|BASE COUNT|ORIGIN|CONTIG|PRIMARY|PROJECT|SEGMENT|WGS|WGS_SCAFLD|TSA|TLS)\b/.test(
            line
          )
            ? line
            : null;
        const continuation = indentedContinuation?.[1] ?? columnZeroContinuation;
        if (continuation !== null && continuation !== undefined) {
          const segment = consumeQuotedQualifierSegment(continuation);
          const separator =
            columnZeroContinuation !== null && currentQualifierValue && segment.value ? ' ' : '';
          currentQualifierValue += separator + segment.value;
          currentQualifierQuoteOpen = !segment.closed;
          continue;
        }
      }

      const qualifierMatch = line.match(/^\s{21}\/(\w+)(?:=(.*))?$/);
      if (qualifierMatch && currentFeatureType) {
        saveCurrentQualifier(currentQualifiers, currentQualifierKey, currentQualifierValue);

        currentQualifierKey = qualifierMatch[1];
        const initial = beginQualifierValue(qualifierMatch[2] ?? '');
        currentQualifierValue = initial.value;
        currentQualifierIsQuoted = initial.quoted;
        currentQualifierQuoteOpen = initial.quoted && !initial.closed;
        continue;
      }

      const continuationMatch = line.match(/^ {21}(.*)$/);
      if (continuationMatch && currentQualifierKey) {
        if (currentQualifierIsQuoted) {
          const segment = consumeQuotedQualifierSegment(continuationMatch[1]);
          currentQualifierValue += segment.value;
          currentQualifierQuoteOpen = !segment.closed;
        } else {
          currentQualifierValue += continuationMatch[1];
        }
        continue;
      }

      if (line.match(/^\s{21}\S/) && currentFeatureType && !currentQualifierKey) {
        featureLocationStr += line.trim();
        continue;
      }
    }

    if (currentSection === 'ORIGIN') {
      const seqMatch = line.match(/^\s*\d+\s+([a-zA-Z\s]+)$/);
      if (seqMatch) {
        sequence += seqMatch[1].replace(/\s/g, '');
      }
    }
  }

  if (currentFeatureType && currentQualifiers) {
    saveCurrentQualifier(currentQualifiers, currentQualifierKey, currentQualifierValue);
  }

  if (length === 0 && sequence.length > 0) {
    length = sequence.length;
  }

  if (circular && length > 0) {
    for (const f of rawFeatures) {
      f.location = applyComplementOriginWrap(f.location, length);
    }
  }

  const annotations = rawFeatures.map((feature) =>
    rawFeatureToAnnotation(feature, options.featurePolicy === 'preserve')
  );

  if (options.featurePolicy !== 'preserve') mergeSplitCDSAnnotations(annotations);

  if (locusNameEncoded) name = decodeGenBankLocusName(name);
  const geneticCode = readGenBankGeneticCode(geneticCodeLines);
  return {
    id: name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, ''),
    name,
    sequence,
    length,
    annotations,
    circular,
    ...(definition ? { description: definition } : {}),
    ...(geneticCode.kind === 'code' ? { chosenGeneticCode: geneticCode.spec } : {}),
    ...(geneticCode.kind === 'unreadable' ? { unreadableGeneticCode: geneticCode.message } : {}),
    ...(molecule && molecule !== 'DNA' ? { molecule } : {}),
  };
}

export function isDeclaredEmptyGenBankRecord(
  content: string,
  parsed: Pick<AnnotatedSequence, 'sequence' | 'length' | 'annotations'>
): boolean {
  if (parsed.sequence !== '' || parsed.length !== 0 || parsed.annotations.length !== 0) {
    return false;
  }
  const lines = content.split(/\r?\n/);
  return (
    lines.some((line) => /^LOCUS\s+.+?\s+0\s+bp\b/i.test(line)) &&
    lines.some((line) => /^ORIGIN\s*$/i.test(line)) &&
    lines.some((line) => /^\/\/\s*$/.test(line))
  );
}

export function applyComplementOriginWrap(
  location: FeatureLocation,
  sequenceLength: number
): FeatureLocation {
  if (sequenceLength <= 0) return location;

  if (!location.complement) return location;

  if (location.locationString && !location.locationString.includes('join(')) return location;
  const segs = location.segments;
  if (!segs || segs.length !== 2) return location;
  if (location.start > location.end) return location;
  if (segs[0].start !== 1 || segs[1].end !== sequenceLength) return location;
  return {
    ...location,
    start: segs[1].start,
    end: segs[0].end,
    segments: [segs[1], segs[0]],
  };
}

export function parseFeatureLocation(locationStr: string): FeatureLocation {
  const str = locationStr.trim();

  const isComplement = str.startsWith('complement(');
  const inner = isComplement ? str.slice(11, -1) : str;

  if (inner.startsWith('join(')) {
    const joinContent = inner.slice(5, -1);
    const segments = parseJoinSegments(joinContent);

    let spansOrigin = false;
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].start < segments[i - 1].end) {
        spansOrigin = true;
        break;
      }
    }

    return {
      start: spansOrigin ? segments[0].start : Math.min(...segments.map((s) => s.start)),
      end: spansOrigin
        ? segments[segments.length - 1].end
        : Math.max(...segments.map((s) => s.end)),
      complement: isComplement,
      segments,
      locationString: str,
    };
  }

  if (inner.startsWith('order(')) {
    const orderContent = inner.slice(6, -1);
    const segments = parseJoinSegments(orderContent);

    return {
      start: Math.min(...segments.map((s) => s.start)),
      end: Math.max(...segments.map((s) => s.end)),
      complement: isComplement,
      segments,
      locationString: str,
    };
  }

  const rangeMatch = inner.match(/<?(\d+)\.\.>?(\d+)/);
  if (rangeMatch) {
    return {
      start: parseInt(rangeMatch[1], 10),
      end: parseInt(rangeMatch[2], 10),
      complement: isComplement,
      locationString: str,
    };
  }

  const singleMatch = inner.match(/^(\d+)$/);
  if (singleMatch) {
    const pos = parseInt(singleMatch[1], 10);
    return { start: pos, end: pos, complement: isComplement, locationString: str };
  }

  const insertMatch = inner.match(/(\d+)\^(\d+)/);
  if (insertMatch) {
    return {
      start: parseInt(insertMatch[1], 10),
      end: parseInt(insertMatch[2], 10),
      complement: isComplement,
      locationString: str,
    };
  }

  const numbers = inner.match(/\d+/g);
  if (numbers && numbers.length >= 2) {
    return {
      start: parseInt(numbers[0], 10),
      end: parseInt(numbers[numbers.length - 1], 10),
      complement: isComplement,
      locationString: str,
    };
  }

  return { start: 1, end: 1, complement: isComplement, locationString: str };
}

function parseJoinSegments(content: string): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  const parts = content.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    const match = trimmed.match(/<?(\d+)\.\.>?(\d+)/);
    if (match) {
      segments.push({
        start: parseInt(match[1], 10),
        end: parseInt(match[2], 10),
      });
    }
  }

  return segments;
}

function saveCurrentQualifier(
  qualifiers: Record<string, string[]>,
  key: string,
  value: string
): void {
  if (!key) return;

  const cleanValue = value.replace(/""/g, '"');
  const existing = qualifiers[key];
  if (existing) {
    existing.push(cleanValue);
  } else {
    qualifiers[key] = [cleanValue];
  }
}

function beginQualifierValue(rawValue: string): {
  value: string;
  quoted: boolean;
  closed: boolean;
} {
  if (!rawValue.startsWith('"')) {
    return { value: rawValue, quoted: false, closed: true };
  }
  const segment = consumeQuotedQualifierSegment(rawValue.slice(1));
  return { ...segment, quoted: true };
}

function consumeQuotedQualifierSegment(rawSegment: string): {
  value: string;
  closed: boolean;
} {
  let trailingQuotes = 0;
  for (let index = rawSegment.length - 1; index >= 0; index -= 1) {
    if (rawSegment[index] !== '"') break;
    trailingQuotes += 1;
  }

  const closed = trailingQuotes % 2 === 1;
  return {
    value: closed ? rawSegment.slice(0, -1) : rawSegment,
    closed,
  };
}

function buildRawFeature(
  type: string,
  qualifiers: Record<string, string[]>,
  locationStr: string
): RawFeature {
  return {
    type,
    qualifiers: { ...qualifiers },
    location: parseFeatureLocation(locationStr),
    locationString: locationStr,
  };
}

export function resolveGenBankFeatureDirection(
  location: FeatureLocation,
  type: string,
  qualifiers: Record<string, string[]>
): AnnotationDirection {
  const explicit = qualifiers.direction?.[0]?.toUpperCase();
  if (explicit === 'RIGHT') return 1;
  if (explicit === 'LEFT') return -1;
  if (explicit === 'NONE') return 0;
  if (location.complement) return -1;

  const directionalTypes = ['CDS', 'gene', 'mRNA', 'promoter', 'tRNA', 'rRNA'];
  const normalizedType = type.toLowerCase();
  if (
    directionalTypes.includes(type) ||
    normalizedType === 'ncrna' ||
    normalizedType === 'tmrna' ||
    normalizedType === 'misc_rna' ||
    normalizedType === 'antisense_rna' ||
    normalizedType === 'snrna' ||
    normalizedType === 'snorna' ||
    normalizedType.endsWith('_rna')
  ) {
    return 1;
  }
  return 0;
}

function mergeSplitCDSAnnotations(annotations: Annotation[]): void {
  const plans = planSplitCDSMerges(
    annotations.map((a) => ({
      start: a.start,
      end: a.end,
      type: a.type,
      name: a.name,
      ...(a.qualifiers?.['locus_tag']?.[0] ? { identity: a.qualifiers['locus_tag'][0] } : {}),
      directionKey: String(a.direction),
      hasSegments: Boolean(a.segments),
      preserveSourceFeature: Boolean(a.qualifiers?.dnaforge_original_type?.length),
    }))
  );

  const indicesToRemove: number[] = [];
  for (const indices of plans) {
    const segments = indices.map((idx) => ({
      start: annotations[idx].start,
      end: annotations[idx].end,
    }));

    const isReverse = annotations[indices[0]].direction === -1;
    const segStrs = segments.map((s) => `${s.start}..${s.end}`).join(',');
    const locationString = isReverse ? `complement(join(${segStrs}))` : `join(${segStrs})`;

    const target = annotations[indices[0]];
    target.start = segments[0].start;
    target.end = segments[segments.length - 1].end;
    target.segments = segments;
    target.qualifiers = {
      ...target.qualifiers,
      _locationString: [locationString],
    };

    for (let i = 1; i < indices.length; i++) {
      indicesToRemove.push(indices[i]);
    }
  }

  indicesToRemove.sort((a, b) => b - a);
  for (const idx of indicesToRemove) {
    annotations.splice(idx, 1);
  }
}

function rawFeatureToAnnotation(raw: RawFeature, preserveSourceType = false): Annotation {
  const { qualifiers, location, type } = raw;

  const name =
    qualifiers.label?.[0] ||
    qualifiers.gene?.[0] ||
    qualifiers.product?.[0] ||
    qualifiers.note?.[0] ||
    type;

  const resolvedType =
    preserveSourceType || qualifiers.dnaforge_original_type?.length
      ? type
      : inferFeatureTypeFromLabel(type, qualifiers.label?.[0]);

  const direction = resolveGenBankFeatureDirection(location, resolvedType, qualifiers);
  const annotation: Annotation = {
    name,
    type: resolvedType,
    start: location.start,
    end: location.end,
    direction,
    color: genBankFeatureColor(resolvedType, direction, qualifiers),
    qualifiers,
  };

  const isJoin =
    location.locationString?.startsWith('join(') ||
    location.locationString?.startsWith('complement(join(');
  if (location.segments && location.segments.length > 1 && isJoin) {
    annotation.segments = location.segments;

    annotation.qualifiers = {
      ...annotation.qualifiers,
      _locationString: [raw.locationString],
    };
  }

  return annotation;
}

export function extractRawSequence(genbankString: string): string {
  const originMatch = genbankString.match(/ORIGIN\r?\n([\s\S]*?)\/\//);
  if (!originMatch) {
    throw new GenBankParseError('GenBank ORIGIN section is missing or malformed.');
  }
  return originMatch[1].replace(/[\s0-9]/g, '');
}

export function isGenBankFormat(content: string): boolean {
  const firstLine = content.trim().split(/\r?\n/)[0];
  return firstLine.startsWith('LOCUS');
}
