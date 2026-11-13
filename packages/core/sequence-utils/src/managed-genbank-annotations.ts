import { inferFeatureTypeFromLabel } from './annotation-type-inference';
import { parseGenBankFull } from './parsers/genbank';
import { planSplitCDSMerges } from './parsers/split-cds-merge';
import type { Annotation, AnnotatedSequence } from './types';

export const MANAGED_GENBANK_ANNOTATION_ID_QUALIFIER = 'dnaforge_ann_id';
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const QUALIFIER_LINE = /^[ \t]{21}\/dnaforge_ann_id\b[^\r\n]*(?:\r?\n|$)/gmu;

export interface ManagedGenBankAnnotation {
  id: string;
  ordinals: number[];
  type: string;
  location: string;
  name: string;
  start: number;
  end: number;
  direction: 1 | -1 | 0;
}

interface RawFeatureBlock {
  ordinal: number;
  startOffset: number;
  endOffset: number;
  raw: string;
  type: string;
  location: string;
  id: string | null;
}

interface LogicalFeature {
  ordinals: number[];
  id: string | null;
  annotation: Annotation;
  inheritanceSignature: string;
}

interface InspectedDocument {
  content: string;
  sequence: AnnotatedSequence;
  originOffset: number;
  hasFeatures: boolean;
  blocks: RawFeatureBlock[];
  logical: LogicalFeature[];
}

export interface ManagedGenBankAnnotationTransfer {
  currentContent: string;
  sourceContent: string;
  annotationId: string;
  currentFrameId: string;
  sourceFrameId: string;
}

export interface ManagedGenBankAnnotationValueDigest {
  present: boolean;
  valueSha256: string;
}

export function ensureManagedGenBankAnnotationIds(
  content: string,
  mintId: () => string,
  previousContent?: string
): string {
  const current = inspect(content, false);
  const previous = previousContent === undefined ? null : inspect(previousContent, false);
  const exactOrderedRetry =
    previous !== null &&
    current.blocks.length === previous.blocks.length &&
    current.logical.length === previous.logical.length &&
    current.logical.every((item) => !item.id) &&
    previous.logical.every((item) => item.id) &&
    current.sequence.sequence === previous.sequence.sequence &&
    Boolean(current.sequence.circular) === Boolean(previous.sequence.circular) &&
    JSON.stringify(current.sequence.chosenGeneticCode ?? null) ===
      JSON.stringify(previous.sequence.chosenGeneticCode ?? null) &&
    current.blocks.every(
      (block, index) => block.raw === previous.blocks[index].raw.replace(QUALIFIER_LINE, '')
    ) &&
    current.logical.every(
      (item, index) =>
        JSON.stringify(item.ordinals) === JSON.stringify(previous.logical[index].ordinals)
    );
  const used = new Set(current.logical.flatMap((item) => (item.id ? [item.id] : [])));
  const priorBySignature = new Map<string, LogicalFeature[]>();
  for (const item of previous?.logical ?? []) {
    const matches = priorBySignature.get(item.inheritanceSignature) ?? [];
    matches.push(item);
    priorBySignature.set(item.inheritanceSignature, matches);
  }
  const currentSignatureCounts = new Map<string, number>();
  for (const item of current.logical) {
    currentSignatureCounts.set(
      item.inheritanceSignature,
      (currentSignatureCounts.get(item.inheritanceSignature) ?? 0) + 1
    );
  }
  const additions: Array<{ offset: number; line: string }> = [];
  for (const [index, item] of current.logical.entries()) {
    if (item.id) continue;
    const matches = priorBySignature.get(item.inheritanceSignature) ?? [];
    if (
      !exactOrderedRetry &&
      (matches.length > 1 ||
        (matches.length === 1 && currentSignatureCounts.get(item.inheritanceSignature) !== 1))
    ) {
      throw new Error('Managed annotation identity inheritance is ambiguous.');
    }
    const id = exactOrderedRetry
      ? previous.logical[index].id!
      : matches.length === 1 && matches[0].id
        ? matches[0].id
        : mintId();
    assertId(id);
    if (used.has(id)) throw new Error('Managed annotation ID is duplicate or already assigned.');
    used.add(id);
    for (const ordinal of item.ordinals) {
      const block = current.blocks[ordinal];
      const ending = block.raw.includes('\r\n') ? '\r\n' : '\n';
      if (!block.raw.endsWith(ending)) {
        throw new Error('Managed annotation block has no terminating line break.');
      }
      additions.push({
        offset: block.endOffset,
        line: `                     /${MANAGED_GENBANK_ANNOTATION_ID_QUALIFIER}="${id}"${ending}`,
      });
    }
  }
  let result = content;
  for (const addition of additions.sort((a, b) => b.offset - a.offset)) {
    result = result.slice(0, addition.offset) + addition.line + result.slice(addition.offset);
  }
  inspect(result, true);
  return result;
}

export function listManagedGenBankAnnotations(content: string): ManagedGenBankAnnotation[] {
  const document = inspect(content, true);
  return document.logical.map((item) => ({
    id: item.id!,
    ordinals: [...item.ordinals],
    type: item.annotation.type,
    location: document.blocks[item.ordinals[0]].location,
    name: item.annotation.name,
    start: item.annotation.start,
    end: item.annotation.end,
    direction: item.annotation.direction,
  }));
}

export async function managedGenBankAnnotationValueDigest(
  content: string,
  annotationId: string
): Promise<ManagedGenBankAnnotationValueDigest> {
  assertId(annotationId);
  const document = inspect(content, true);
  const item = document.logical.find((candidate) => candidate.id === annotationId);
  const present = Boolean(item);
  const value = item
    ? rawGroup(document, item)
    : `dnaforge-managed-annotation-absence-v1:${annotationId}`;
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return {
    present,
    valueSha256: `sha256:${Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')}`,
  };
}

export function replaceManagedGenBankAnnotation(input: ManagedGenBankAnnotationTransfer): string {
  const { current, source } = inspectTransfer(input);
  const target = requireItem(current, input.annotationId);
  const historical = requireItem(source, input.annotationId);
  const sourceRaw = rawGroup(source, historical);
  const { start, end } = groupSpan(current, target);
  const result = current.content.slice(0, start) + sourceRaw + current.content.slice(end);
  verifyResult(result, current, input.annotationId, true);
  return result;
}

export function insertManagedGenBankAnnotation(input: ManagedGenBankAnnotationTransfer): string {
  const { current, source } = inspectTransfer(input);
  if (current.logical.some((item) => item.id === input.annotationId)) {
    throw new Error('Managed annotation is already present in the current product.');
  }
  const historical = requireItem(source, input.annotationId);
  const sourceRaw = rawGroup(source, historical);
  const featureHeader = current.hasFeatures
    ? ''
    : `FEATURES             Location/Qualifiers${current.content.includes('\r\n') ? '\r\n' : '\n'}`;
  const result =
    current.content.slice(0, current.originOffset) +
    featureHeader +
    sourceRaw +
    current.content.slice(current.originOffset);
  verifyResult(result, current, input.annotationId, true);
  return result;
}

export function removeManagedGenBankAnnotation(input: ManagedGenBankAnnotationTransfer): string {
  const { current, source } = inspectTransfer(input);
  if (source.logical.some((item) => item.id === input.annotationId)) {
    throw new Error('Historical source still contains the selected managed annotation.');
  }
  const target = requireItem(current, input.annotationId);
  const { start, end } = groupSpan(current, target);
  const result = current.content.slice(0, start) + current.content.slice(end);
  verifyResult(result, current, input.annotationId, false);
  return result;
}

function inspectTransfer(input: ManagedGenBankAnnotationTransfer): {
  current: InspectedDocument;
  source: InspectedDocument;
} {
  assertId(input.annotationId);
  if (!input.currentFrameId || input.currentFrameId !== input.sourceFrameId) {
    throw new Error('Managed annotation coordinate frames differ or are unverified.');
  }
  const current = inspect(input.currentContent, true);
  const source = inspect(input.sourceContent, true);
  if (current.sequence.sequence.toUpperCase() !== source.sequence.sequence.toUpperCase()) {
    throw new Error('Managed annotation source and target DNA bases differ.');
  }
  if (Boolean(current.sequence.circular) !== Boolean(source.sequence.circular)) {
    throw new Error('Managed annotation source and target topology differs.');
  }
  if (
    current.sequence.unreadableGeneticCode ||
    source.sequence.unreadableGeneticCode ||
    JSON.stringify(current.sequence.chosenGeneticCode ?? null) !==
      JSON.stringify(source.sequence.chosenGeneticCode ?? null)
  ) {
    throw new Error('Managed annotation source and target genetic-code context differs.');
  }
  return { current, source };
}

function inspect(content: string, requireIds: boolean): InspectedDocument {
  if (typeof content !== 'string' || /\r(?!\n)/u.test(content)) {
    throw new Error('Managed GenBank content is invalid.');
  }
  const locusCount = [...content.matchAll(/^LOCUS\b/gmu)].length;
  const locusLine = /^LOCUS[^\r\n]*/gmu.exec(content)?.[0] ?? '';
  const locusSuffix = /^LOCUS\s+.+?\s+\d+\s+bp\b([^\r\n]*)/iu.exec(locusLine)?.[1] ?? '';
  const declaredTopologies = locusSuffix.match(/\b(?:linear|circular)\b/giu) ?? [];
  const originMatches = [...content.matchAll(/^ORIGIN\b[^\r\n]*(?:\r?\n|$)/gmu)];
  const terminatorCount = [...content.matchAll(/^\/\/\s*$/gmu)].length;
  if (
    locusCount !== 1 ||
    originMatches.length !== 1 ||
    terminatorCount !== 1 ||
    declaredTopologies.length !== 1
  ) {
    throw new Error('Managed annotation operations require exactly one complete GenBank record.');
  }
  const header = /^FEATURES\b[^\r\n]*(?:\r?\n|$)/gmu.exec(content);
  const origin = originMatches[0];
  if (header && header.index >= origin.index) {
    throw new Error('Managed GenBank FEATURES section is malformed.');
  }
  const regionStart = header ? header.index + header[0].length : origin.index;
  const region = content.slice(regionStart, origin.index);
  const starts = [...region.matchAll(/^ {5}(\S+)[ \t]+([^\r\n]+)(?:\r?\n|$)/gmu)];
  if (starts.length === 0 && region.trim() !== '') {
    throw new Error('Managed GenBank FEATURES section has unrecognized content.');
  }
  const blocks = starts.map((match, ordinal) => {
    const startOffset = regionStart + match.index!;
    const endOffset =
      ordinal + 1 < starts.length ? regionStart + starts[ordinal + 1].index! : origin.index;
    const raw = content.slice(startOffset, endOffset);
    if (
      raw
        .split(/\r?\n/u)
        .slice(1)
        .some((line) => line.length > 0 && !/^ {21}/u.test(line))
    ) {
      throw new Error(
        'Managed GenBank feature block has unsupported continuation or top-level content.'
      );
    }
    return {
      ordinal,
      startOffset,
      endOffset,
      raw,
      type: match[1],
      location: featureLocation(raw, match[2]),
      id: rawId(raw),
    };
  });
  if (starts.length > 0 && region.slice(0, starts[0].index).trim() !== '') {
    throw new Error('Managed GenBank FEATURES preamble is unrecognized.');
  }
  const preserved = parseGenBankFull(content, { featurePolicy: 'preserve' });
  const normal = parseGenBankFull(content);
  if (
    preserved.annotations.length !== blocks.length ||
    preserved.sequence.length !== preserved.length ||
    normal.sequence !== preserved.sequence
  ) {
    throw new Error('Managed GenBank raw features do not match the parsed record.');
  }
  for (const block of blocks) validateLocation(block.location, preserved.sequence.length);
  const plans = planSplitCDSMerges(
    preserved.annotations.map((annotation) => {
      const type = annotation.qualifiers?.dnaforge_original_type?.length
        ? annotation.type
        : inferFeatureTypeFromLabel(annotation.type, annotation.qualifiers?.label?.[0]);
      return {
        start: annotation.start,
        end: annotation.end,
        type,
        name: annotation.name,
        identity: annotation.qualifiers?.locus_tag?.[0],
        directionKey: String(
          annotation.direction === 0 && type === 'CDS' ? 1 : annotation.direction
        ),
        hasSegments: Boolean(annotation.segments),
        preserveSourceFeature: Boolean(annotation.qualifiers?.dnaforge_original_type?.length),
      };
    })
  );
  const membership = new Map<number, number[]>();
  for (const plan of plans) {
    const ordered = [...plan].sort((a, b) => a - b);
    if (ordered.some((ordinal, index) => ordinal !== ordered[0] + index)) {
      throw new Error('Managed annotation split-CDS group is non-contiguous.');
    }
    if (!plan.every((ordinal, index) => ordinal === ordered[index])) {
      throw new Error('Managed annotation split-CDS group order is ambiguous.');
    }
    for (const ordinal of ordered) membership.set(ordinal, ordered);
  }
  const logical: LogicalFeature[] = [];
  const visited = new Set<number>();
  for (const block of blocks) {
    if (visited.has(block.ordinal)) continue;
    const ordinals = membership.get(block.ordinal) ?? [block.ordinal];
    for (const ordinal of ordinals) visited.add(ordinal);
    const ids = ordinals.map((ordinal) => blocks[ordinal].id);
    if (ids.some((id) => id !== ids[0])) {
      throw new Error('Managed annotation split-CDS group has conflicting or missing IDs.');
    }
    if (requireIds && !ids[0]) throw new Error('Managed annotation ID is missing.');
    logical.push({
      ordinals,
      id: ids[0],
      annotation: normal.annotations[logical.length],
      inheritanceSignature:
        ordinals.map((ordinal) => stripId(blocks[ordinal].raw)).join('\0') +
        '\0' +
        JSON.stringify(withoutManagedId(normal.annotations[logical.length])),
    });
  }
  if (normal.annotations.length !== logical.length || logical.some((item) => !item.annotation)) {
    throw new Error('Managed annotation merge grouping is ambiguous.');
  }
  const ids = logical.flatMap((item) => (item.id ? [item.id] : []));
  if (new Set(ids).size !== ids.length) throw new Error('Managed annotation ID is duplicate.');
  return {
    content,
    sequence: preserved,
    originOffset: origin.index,
    hasFeatures: Boolean(header),
    blocks,
    logical,
  };
}

function featureLocation(raw: string, first: string): string {
  const lines = raw.split(/\r?\n/u);
  const continuation: string[] = [];
  for (const line of lines.slice(1)) {
    if (/^ {21}\//u.test(line)) break;
    if (/^ {21}\S/u.test(line)) continuation.push(line.trim());
  }
  return first.trim() + continuation.join('');
}

function validateLocation(location: string, length: number): void {
  let inner = location;
  if (inner.startsWith('complement(') && inner.endsWith(')')) inner = inner.slice(11, -1);
  if (/^(?:join|order)\(/u.test(inner) && inner.endsWith(')')) {
    inner = inner.slice(inner.indexOf('(') + 1, -1);
  }
  const parts = inner.split(',');
  if (parts.length === 0) throw new Error('Managed annotation location is unsupported.');
  for (const part of parts) {
    const range = /^<?(\d+)\.\.>?(\d+)$/u.exec(part.trim());
    const point = /^(\d+)$/u.exec(part.trim());
    const between = /^(\d+)\^(\d+)$/u.exec(part.trim());
    if (!range && !point && !between) {
      throw new Error('Managed annotation location is unsupported.');
    }
    const start = Number((range ?? point ?? between)![1]);
    const end = Number(range?.[2] ?? point?.[1] ?? between?.[2]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end > length ||
      start > end
    ) {
      throw new Error(
        `Managed annotation location ${location} is outside its ${length} bp coordinate frame.`
      );
    }
  }
}

function rawId(raw: string): string | null {
  const lines = [...raw.matchAll(QUALIFIER_LINE)];
  if (lines.length === 0) return null;
  if (lines.length !== 1) throw new Error('Managed annotation ID qualifier is duplicate.');
  const value = /^[ \t]{21}\/dnaforge_ann_id="([^"]+)"(?:\r?\n|$)$/u.exec(lines[0][0])?.[1];
  if (!value) throw new Error('Managed annotation ID qualifier is invalid.');
  assertId(value);
  return value;
}

function assertId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error('Managed annotation ID is invalid.');
}

function stripId(raw: string): string {
  return raw.replace(QUALIFIER_LINE, '');
}

function withoutManagedId(annotation: Annotation | undefined): Annotation | null {
  if (!annotation) return null;
  const qualifiers = { ...annotation.qualifiers };
  delete qualifiers[MANAGED_GENBANK_ANNOTATION_ID_QUALIFIER];
  return { ...annotation, qualifiers };
}

function requireItem(document: InspectedDocument, id: string): LogicalFeature {
  const item = document.logical.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Managed annotation ${id} is absent from the requested revision.`);
  return item;
}

function groupSpan(
  document: InspectedDocument,
  item: LogicalFeature
): {
  start: number;
  end: number;
} {
  return {
    start: document.blocks[item.ordinals[0]].startOffset,
    end: document.blocks[item.ordinals[item.ordinals.length - 1]].endOffset,
  };
}

function rawGroup(document: InspectedDocument, item: LogicalFeature): string {
  const { start, end } = groupSpan(document, item);
  return document.content.slice(start, end);
}

function verifyResult(
  result: string,
  before: InspectedDocument,
  annotationId: string,
  shouldExist: boolean
): void {
  const after = inspect(result, true);
  if (
    after.sequence.sequence.toUpperCase() !== before.sequence.sequence.toUpperCase() ||
    Boolean(after.sequence.circular) !== Boolean(before.sequence.circular)
  ) {
    throw new Error('Managed annotation splice changed DNA bases or topology.');
  }
  if (after.logical.some((item) => item.id === annotationId) !== shouldExist) {
    throw new Error('Managed annotation splice did not produce the requested identity state.');
  }
  const peersBefore = before.logical
    .filter((item) => item.id !== annotationId)
    .map((item) => [item.id, rawGroup(before, item)]);
  const peersAfter = after.logical
    .filter((item) => item.id !== annotationId)
    .map((item) => [item.id, rawGroup(after, item)]);
  if (JSON.stringify(peersBefore) !== JSON.stringify(peersAfter)) {
    throw new Error('Managed annotation splice changed an unselected feature.');
  }
}
