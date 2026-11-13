import { XMLParser } from 'fast-xml-parser';

import { getFeatureColor } from '../colors';
import { inferFeatureTypeFromLabel } from '../annotation-type-inference';
import type { AnnotatedSequence, Annotation, AnnotationDirection } from '../types';
import { SequenceParseError } from './types';
import type { ParsedSequence } from './types';

const COOKIE_PACKET = 0x09;
const DNA_PACKET = 0x00;
const PRIMERS_PACKET = 0x05;
const NOTES_PACKET = 0x06;
const FEATURES_PACKET = 0x0a;
const COOKIE_LENGTH = 14;
const COOKIE_TEXT = 'SnapGene';

type BinaryInput = ArrayBuffer | Uint8Array | Buffer;

interface Packet {
  type: number;
  length: number;
  offset: number;
}

interface ParsedRange {
  start: number;
  end: number;
}

interface SnapGeneNotes {
  name?: string;
  description?: string;
  accession?: string;
  division?: string;
  lastModified?: string;
  raw: Record<string, unknown>;
}

type XmlElement = Record<string, unknown>;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  isArray: (_tagName, jPath) => {
    const path = String(jPath);
    return [
      'Features.Feature',
      'Features.Feature.Segment',
      'Features.Feature.Q',
      'Features.Feature.Q.V',
      'Primers.Primer',
      'Primers.Primer.BindingSite',
    ].includes(path);
  },
});

export function isSnapGeneFormat(data: BinaryInput): boolean {
  if (!data || data.byteLength < 5 + COOKIE_TEXT.length) return false;
  const view = toDataView(data);
  if (view.byteLength < 5 + COOKIE_TEXT.length) return false;
  if (view.getUint8(0) !== COOKIE_PACKET) return false;
  if (view.getUint32(1, false) !== COOKIE_LENGTH) return false;
  return readAscii(view, 5, COOKIE_TEXT.length) === COOKIE_TEXT;
}

export function parseSnapGene(data: BinaryInput, filename?: string): AnnotatedSequence {
  const view = toDataView(data);
  const packets = readPackets(view);
  if (packets.length === 0) {
    throw new SequenceParseError('Empty SnapGene file', 'snapgene');
  }

  const [cookie] = packets;
  if (cookie.type !== COOKIE_PACKET) {
    throw new SequenceParseError(
      'The file does not start with a SnapGene cookie packet',
      'snapgene'
    );
  }
  validateCookie(view, cookie);

  const dnaPackets = packets.filter((packet) => packet.type === DNA_PACKET);
  if (dnaPackets.length === 0) {
    throw new SequenceParseError('No DNA packet in SnapGene file', 'snapgene');
  }
  if (dnaPackets.length > 1) {
    throw new SequenceParseError('The file contains more than one DNA packet', 'snapgene');
  }

  const dna = parseDnaPacket(view, dnaPackets[0]);
  const annotations: Annotation[] = [];
  let notes: SnapGeneNotes | undefined;

  for (const packet of packets) {
    if (packet.type === NOTES_PACKET) {
      notes = parseNotesPacket(view, packet);
    } else if (packet.type === FEATURES_PACKET) {
      annotations.push(...parseFeaturesPacket(view, packet));
    } else if (packet.type === PRIMERS_PACKET) {
      annotations.push(...parsePrimersPacket(view, packet, dna.sequence.length));
    }
  }

  const name =
    notes?.name ||
    deriveNameFromFilename(filename) ||
    notes?.accession ||
    (filename ? deriveNameFromFilename(filename) : undefined) ||
    'SnapGene_Sequence';
  const id = generateId(notes?.accession || name);

  return {
    id,
    name,
    sequence: dna.sequence,
    length: dna.sequence.length,
    annotations,
    circular: dna.circular,
    description: notes?.description,
    metadata: {
      snapgene: {
        notes: notes?.raw ?? {},
        strandedness: dna.doubleStranded ? 'double' : 'single',
        damMethylated: dna.damMethylated,
        dcmMethylated: dna.dcmMethylated,
        ecoKIMethylated: dna.ecoKIMethylated,
      },
    },
  };
}

export function parseSnapGeneSequence(data: BinaryInput, filename?: string): ParsedSequence {
  const parsed = parseSnapGene(data, filename);
  return {
    id: parsed.id,
    name: parsed.name,
    sequence: parsed.sequence,
    length: parsed.length,
    format: 'snapgene',
    metadata: {
      circular: parsed.circular ?? false,
      description: parsed.description,
      annotations: parsed.annotations,
      annotationCount: parsed.annotations.length,
      snapgene: parsed.metadata?.snapgene,
    },
  };
}

function readPackets(view: DataView): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;

  while (offset < view.byteLength) {
    if (offset + 5 > view.byteLength) {
      throw new SequenceParseError('Unexpected end of SnapGene packet header', 'snapgene');
    }

    const type = view.getUint8(offset);
    const length = view.getUint32(offset + 1, false);
    const dataOffset = offset + 5;
    const nextOffset = dataOffset + length;

    if (nextOffset > view.byteLength) {
      throw new SequenceParseError('Unexpected end of SnapGene packet data', 'snapgene');
    }

    packets.push({ type, length, offset: dataOffset });
    offset = nextOffset;
  }

  return packets;
}

function validateCookie(view: DataView, packet: Packet): void {
  if (packet.length !== COOKIE_LENGTH) {
    throw new SequenceParseError('Invalid SnapGene cookie packet length', 'snapgene');
  }
  if (readAscii(view, packet.offset, COOKIE_TEXT.length) !== COOKIE_TEXT) {
    throw new SequenceParseError('The file is not a valid SnapGene file', 'snapgene');
  }
}

function parseDnaPacket(
  view: DataView,
  packet: Packet
): {
  sequence: string;
  circular: boolean;
  doubleStranded: boolean;
  damMethylated: boolean;
  dcmMethylated: boolean;
  ecoKIMethylated: boolean;
} {
  if (packet.length < 1) {
    throw new SequenceParseError('SnapGene DNA packet is empty', 'snapgene');
  }

  const flags = view.getUint8(packet.offset);
  return {
    sequence: readAscii(view, packet.offset + 1, packet.length - 1),
    circular: (flags & 0x01) !== 0,
    doubleStranded: (flags & 0x02) !== 0,
    damMethylated: (flags & 0x04) !== 0,
    dcmMethylated: (flags & 0x08) !== 0,
    ecoKIMethylated: (flags & 0x10) !== 0,
  };
}

function parseNotesPacket(view: DataView, packet: Packet): SnapGeneNotes {
  const xml = parseXmlPacket(view, packet);
  const root = asElement(xml.Notes) ?? xml;
  const description = cleanText(childText(root, 'Description'));
  const comments = cleanText(childText(root, 'Comments'));
  const accession = cleanText(childText(root, 'AccessionNumber'));
  const type = cleanText(childText(root, 'Type'));

  return {
    name: firstToken(comments || description) || undefined,
    description: description || comments || undefined,
    accession: accession || undefined,
    division: type === 'Synthetic' ? 'SYN' : type ? 'UNC' : undefined,
    lastModified: cleanText(childText(root, 'LastModified')) || undefined,
    raw: root,
  };
}

function parseFeaturesPacket(view: DataView, packet: Packet): Annotation[] {
  const xml = parseXmlPacket(view, packet);
  const featuresRoot = asElement(xml.Features);
  if (!featuresRoot) return [];

  const features = arrayOfElements(featuresRoot.Feature);
  const annotations: Annotation[] = [];

  for (const feature of features) {
    const type = stringAttr(feature.type) || 'misc_feature';
    const direction = directionalityToDirection(stringAttr(feature.directionality), true);
    const standardSegments = arrayOfElements(feature.Segment)
      .filter((segment) => stringAttr(segment.type) !== 'gap')
      .map((segment, index) => ({
        range: parseRange(stringAttr(segment.range), false),
        color: stringAttr(segment.color),
        name: cleanText(stringAttr(segment.name)),
        standardIndex: index + 1,
      }))
      .filter((segment) => segment.range !== null) as Array<{
      range: ParsedRange;
      color?: string;
      name: string;
      standardIndex: number;
    }>;

    if (standardSegments.length === 0) continue;

    const orderedSegments =
      direction === -1 ? [...standardSegments].reverse() : [...standardSegments];
    const segments = orderedSegments.map((segment) => segment.range);
    const singleWrap = segments.length === 1 && segments[0].start > segments[0].end;
    const start = singleWrap
      ? segments[0].start
      : Math.min(...segments.map((segment) => segment.start));
    const end = singleWrap ? segments[0].end : Math.max(...segments.map((segment) => segment.end));

    const qualifiers = parseQualifiers(feature);
    const segmentParts = standardSegments
      .filter((segment) => segment.name)
      .map((segment) => [segment.standardIndex, segment.name] as const);
    if (segmentParts.length > 0) {
      const parts =
        direction === -1
          ? segmentParts
              .map(([index, name]) => [standardSegments.length - index + 1, name] as const)
              .reverse()
          : segmentParts;
      qualifiers.parts = [parts.map(([index, name]) => `${index}:${name}`).join(';')];
    }

    const featureName = cleanText(stringAttr(feature.name));
    if (featureName) {
      if (!qualifiers.label?.length) {
        qualifiers.label = [featureName];
      } else if (!qualifiers.label.includes(featureName)) {
        qualifiers.name = [featureName];
      }
    }

    const label =
      qualifiers.label?.[0] ||
      qualifiers.gene?.[0] ||
      qualifiers.product?.[0] ||
      qualifiers.note?.[0] ||
      type;
    const resolvedType = inferFeatureTypeFromLabel(type, qualifiers.label?.[0]);
    if (segments.length > 1) {
      qualifiers._locationString = [
        locationStringForSegments(
          standardSegments.map((segment) => segment.range),
          direction
        ),
      ];
    }

    const color = firstUsableColor(standardSegments.map((segment) => segment.color));
    const annotation: Annotation = {
      name: label,
      type: resolvedType,
      start,
      end,
      direction,
      color: color ?? getFeatureColor(resolvedType),
      qualifiers,
    };
    if (segments.length > 1) {
      annotation.segments = segments;
    }
    annotations.push(annotation);
  }

  return annotations;
}

function parsePrimersPacket(view: DataView, packet: Packet, sequenceLength: number): Annotation[] {
  const xml = parseXmlPacket(view, packet);
  const primersRoot = asElement(xml.Primers);
  if (!primersRoot) return [];

  const hybridizationParams = asElement(primersRoot.HybridizationParams);
  const minMatchLength = numberAttr(hybridizationParams?.minContinuousMatchLen) ?? 0;
  const minMeltingTemperature = numberAttr(hybridizationParams?.minMeltingTemperature) ?? 0;
  const annotations: Annotation[] = [];

  for (const primer of arrayOfElements(primersRoot.Primer)) {
    const primerName = cleanText(stringAttr(primer.name)) || 'Primer';
    const primerSequence = cleanSequence(stringAttr(primer.sequence));
    const seenSimplified = new Set<string>();

    for (const site of arrayOfElements(primer.BindingSite)) {
      const range = parseRange(stringAttr(site.location), true);
      if (!range) continue;

      const direction = boundStrandToDirection(stringAttr(site.boundStrand));
      const locationKey = `${range.start}-${range.end}-${direction}`;
      const simplified = stringAttr(site.simplified) === '1';
      if (simplified && seenSimplified.has(locationKey)) continue;

      const annealedBases = cleanSequence(stringAttr(site.annealedBases));
      if (annealedBases && annealedBases.length < minMatchLength) continue;

      const meltingTemperature = numberAttr(site.meltingTemperature);
      if (meltingTemperature !== undefined && meltingTemperature < minMeltingTemperature) continue;

      seenSimplified.add(locationKey);

      const sequence = primerSequence || annealedBases;
      const qualifiers: Record<string, string[]> = {
        label: [primerName],
      };
      if (sequence) qualifiers.sequence = [sequence];
      const description = cleanText(stringAttr(primer.description));
      if (description) qualifiers.note = [description];

      annotations.push({
        name: primerName,
        type: 'primer_bind',
        start: clampPosition(range.start, sequenceLength),
        end: clampPosition(range.end, sequenceLength),
        direction,
        color: getFeatureColor('primer_bind'),
        qualifiers,
      });
    }
  }

  return annotations;
}

function parseQualifiers(feature: XmlElement): Record<string, string[]> {
  const qualifiers: Record<string, string[]> = {};
  for (const qualifier of arrayOfElements(feature.Q)) {
    const name = stringAttr(qualifier.name);
    if (!name) continue;
    const values = arrayOfElements(qualifier.V)
      .map((value) => {
        if (value.text !== undefined) return cleanText(stringAttr(value.text));
        if (value.predef !== undefined) return cleanText(stringAttr(value.predef));
        if (value.int !== undefined) return cleanText(stringAttr(value.int));
        return cleanText(nodeText(value));
      })
      .filter((value) => value.length > 0);
    qualifiers[name] = values;
  }
  return qualifiers;
}

function parseXmlPacket(view: DataView, packet: Packet): XmlElement {
  const xml = readUtf8(view, packet.offset, packet.length).replace(/^\uFEFF/, '');
  const parsed = xmlParser.parse(xml) as unknown;
  if (!isElement(parsed)) {
    throw new SequenceParseError('Invalid XML packet in SnapGene file', 'snapgene');
  }
  return parsed;
}

function parseRange(value: string | undefined, isPrimer: boolean): ParsedRange | null {
  if (!value) return null;
  const [rawStart, rawEnd] = value.split('-').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null;

  if (isPrimer) {
    return {
      start: rawStart + 1,
      end: rawEnd + 1,
    };
  }

  return {
    start: rawStart,
    end: rawEnd,
  };
}

function directionalityToDirection(
  value: string | undefined,
  defaultForward: boolean
): AnnotationDirection {
  if (value === '2') return -1;
  if (value === '0' || value === '3') return 0;
  return defaultForward ? 1 : 0;
}

function boundStrandToDirection(value: string | undefined): AnnotationDirection {
  return value === '1' ? -1 : 1;
}

function locationStringForSegments(
  segments: ParsedRange[],
  direction: AnnotationDirection
): string {
  const inner = `join(${segments.map((segment) => `${segment.start}..${segment.end}`).join(',')})`;
  return direction === -1 ? `complement(${inner})` : inner;
}

function clampPosition(position: number, sequenceLength: number): number {
  if (sequenceLength <= 0) return position;
  return Math.min(Math.max(position, 1), sequenceLength);
}

function firstUsableColor(colors: Array<string | undefined>): string | undefined {
  return colors.find((color) => color && color !== 'noColor');
}

function childText(node: XmlElement, key: string): string {
  return nodeText(node[key]);
}

function nodeText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (isElement(value) && value['#text'] !== undefined) {
    return nodeText(value['#text']);
  }
  return '';
}

function cleanText(value: string | undefined): string {
  if (!value) return '';
  return decodeXmlEntities(value)
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSequence(value: string | undefined): string {
  return value?.replace(/\s+/g, '') ?? '';
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function firstToken(value: string | undefined): string {
  return value?.trim().split(/\s+/, 1)[0] ?? '';
}

function stringAttr(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function numberAttr(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function arrayOfElements(value: unknown): XmlElement[] {
  if (Array.isArray(value)) return value.filter(isElement);
  return isElement(value) ? [value] : [];
}

function asElement(value: unknown): XmlElement | undefined {
  return isElement(value) ? value : undefined;
}

function isElement(value: unknown): value is XmlElement {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toDataView(data: BinaryInput): DataView {
  if (data instanceof ArrayBuffer) return new DataView(data);
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function readAscii(view: DataView, offset: number, length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += String.fromCharCode(view.getUint8(offset + i));
  }
  return result;
}

function readUtf8(view: DataView, offset: number, length: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  return new TextDecoder('utf-8').decode(bytes);
}

function generateId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'snapgene-sequence'
  );
}

function deriveNameFromFilename(filename?: string): string | undefined {
  if (!filename) return undefined;
  const base = filename.split(/[\\/]/).pop() || filename;
  return base.replace(/\.dna$/i, '') || undefined;
}
