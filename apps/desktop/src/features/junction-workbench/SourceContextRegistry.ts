import {
  decodeSequenceDocument,
  type AnnotatedSequence,
  type Annotation,
} from '@waypoint/sequence-utils';
import PUC19_REAL_ASSEMBLY_FIXTURE_GB from '../../../../../test-fixtures/sequences/circular/pUC19.gb?raw';
import {
  getSequences,
  getSequenceIdByDocumentId,
  getSequenceWithPath,
  type DBSequence,
} from '../../db';
import { platform } from '../../platform';
import { assertCanonicalSequenceSource } from '../sequence/public/sequence-document-repository';
import type {
  DesignAnnotation,
  DesignRegion,
  HomologyRegion,
  SequenceDesign,
} from '../design/public/types';
import type { AssemblyWorkbenchSourceContext } from './AssemblyWorkbenchContract';
import { getEffectiveDesignRegions } from '../design/public/restriction-digest';
import {
  DEFAULT_JUNCTION_WINDOW_BP,
  MAX_JUNCTION_WINDOW_BP,
  type CoordMappingStrategyName,
} from './coord-mapping';
import { computeRegisteredWindow } from './registered-window';
import { unwrapCircularInterval } from './provenance/coordinates';

export type SourceContextStatus = 'full' | 'windowed' | 'missing' | 'stale' | 'truncated';
export const DEFAULT_SOURCE_CONTEXT_BUFFER_BP = 512;

export interface SourceRef {
  kind: 'inline' | 'cache' | 'db-sequence' | 'unknown';
  id: string;
  name?: string;
  version?: string;
  contentHash?: string;
}

export interface SourceWindowRequest {
  key: string;
  method: CoordMappingStrategyName;
  junctionIndex: number;
  side: 'left' | 'right';
  regionId: string;
  regionSequence: string;
  regionAnnotations: DesignAnnotation[];
  sourceRef: SourceRef;
  sourceStart: number;
  sourceEnd: number;
  sourceSequenceName: string;
  registeredStartBioCol: number;
  registeredEndBioCol: number;
  spacerLength: number;
  inlineSourceSequence?: string;
  inlineSourceAnnotations?: DesignAnnotation[];
  inlineSourceIsCircular?: boolean;
}

export interface SourceContextWindow {
  key: string;
  regionId: string;
  sourceRef: SourceRef;
  status: SourceContextStatus;
  sourceStart: number;
  sourceEnd: number;
  sourceLength: number;
  circular: boolean;
  sourceContextStart: number;
  sourceContextEnd: number;
  sourceContextSequence: string;
  sourceContextAnnotations: DesignAnnotation[];
  registeredStartBioCol: number;
  registeredEndBioCol: number;
  sourceAnnotations: DesignAnnotation[];
}

export type SourceContextWindowMap = Record<string, SourceContextWindow>;

interface LocatedSourceContext {
  source: AnnotatedSequence;
  sourceStart: number;
  sourceEnd: number;
  matchedExpectedInterval: boolean;
  sourceRef: SourceRef;
}

export class SourceContextRegistry {
  constructor(private readonly sourceSequences: Record<string, AnnotatedSequence>) {}

  resolveWindows(requests: readonly SourceWindowRequest[]): SourceContextWindowMap {
    const windows: SourceContextWindowMap = {};
    for (const request of requests) {
      windows[request.key] = this.resolveWindow(request);
    }
    return windows;
  }

  unresolvedRequests(requests: readonly SourceWindowRequest[]): SourceWindowRequest[] {
    return requests.filter((request) => this.resolveWindow(request).status === 'missing');
  }

  resolveWindow(request: SourceWindowRequest): SourceContextWindow {
    const located = this.findSourceContext(request);
    if (!located) return createMissingWindow(request);

    const status: SourceContextStatus =
      located.sourceRef.kind === 'inline'
        ? 'full'
        : located.matchedExpectedInterval
          ? 'windowed'
          : 'stale';

    return createWindowFromLocatedSource(request, located, status);
  }

  private findSourceContext(request: SourceWindowRequest): LocatedSourceContext | null {
    const inlineSource = request.inlineSourceSequence
      ? annotatedSequenceFromInlineRequest(request)
      : null;
    const directCandidates = [
      ...(inlineSource ? [{ source: inlineSource, sourceRef: request.sourceRef }] : []),
      ...sourceLookupKeys(request)
        .map((key) => this.sourceSequences[key])
        .filter((candidate): candidate is AnnotatedSequence => Boolean(candidate?.sequence))
        .map((source) => ({ source, sourceRef: sourceRefForResolvedSource(request, source) })),
    ];
    const allCandidates = [
      ...directCandidates,
      ...Object.values(this.sourceSequences)
        .filter(
          (candidate) =>
            candidate.sequence && !directCandidates.some((entry) => entry.source === candidate)
        )
        .map((source) => ({ source, sourceRef: sourceRefForResolvedSource(request, source) })),
    ];

    for (const candidate of allCandidates) {
      const located = locateRegionInSource(request, candidate.source);
      if (located) {
        return {
          source: candidate.source,
          sourceStart: located.start,
          sourceEnd: located.end,
          matchedExpectedInterval: located.matchedExpectedInterval,
          sourceRef: candidate.sourceRef,
        };
      }
    }

    return null;
  }
}

export function createJunctionSourceWindowRequests(
  design: SequenceDesign,
  options: { homologyRegions?: HomologyRegion[]; maxWindowBp?: number } = {}
): SourceWindowRequest[] {
  const maxWindowBp = Math.min(
    options.maxWindowBp ?? DEFAULT_JUNCTION_WINDOW_BP,
    MAX_JUNCTION_WINDOW_BP
  );
  if (design.regions.length < 2) return [];

  if (design.assemblyMethod === 'goldengate') {
    return [...(design.goldenGateJunctions ?? [])]
      .sort((a, b) => a.junctionIndex - b.junctionIndex)
      .flatMap((junction) => {
        const leftIndex = junction.junctionIndex;
        const rightIndex = (leftIndex + 1) % design.regions.length;
        const leftRegion = design.regions[leftIndex];
        const rightRegion = design.regions[rightIndex];
        const spacerLength = spacerLengthForJunction(design, leftIndex);
        const window = computeRegisteredWindow(leftRegion, rightRegion, maxWindowBp, spacerLength);
        return [
          createSourceWindowRequest('goldengate', leftIndex, 'left', leftRegion, window, 0),
          createSourceWindowRequest(
            'goldengate',
            leftIndex,
            'right',
            rightRegion,
            window,
            spacerLength
          ),
        ];
      });
  }

  const effectiveDesign = {
    ...design,
    homologyRegions: options.homologyRegions ?? design.homologyRegions,
  };
  const displayRegions = getEffectiveDesignRegions(effectiveDesign);
  const method: CoordMappingStrategyName =
    design.assemblyMethod === 'nebuilder' ? 'nebuilder' : 'gibson';

  return [...effectiveDesign.homologyRegions]
    .sort((a, b) => a.junctionIndex - b.junctionIndex)
    .flatMap((homologyRegion) => {
      const leftIndex = homologyRegion.junctionIndex;
      const rightIndex = (leftIndex + 1) % displayRegions.length;
      const leftRegion = displayRegions[leftIndex];
      const rightRegion = displayRegions[rightIndex];
      const spacerLength = spacerLengthForJunction(design, leftIndex);
      const window = computeRegisteredWindow(leftRegion, rightRegion, maxWindowBp, spacerLength);
      return [
        createSourceWindowRequest(method, leftIndex, 'left', leftRegion, window, 0),
        createSourceWindowRequest(method, leftIndex, 'right', rightRegion, window, spacerLength),
      ];
    });
}

export function sourceWindowKey(
  method: CoordMappingStrategyName,
  junctionIndex: number,
  side: 'left' | 'right'
): string {
  return `${method}:${junctionIndex}:${side}`;
}

export function createAssemblyWorkbenchSourceContext(
  windows: SourceContextWindowMap
): AssemblyWorkbenchSourceContext {
  const regions: NonNullable<AssemblyWorkbenchSourceContext['regions']> = {};
  for (const window of Object.values(windows)) {
    const current = regions[window.regionId];
    if (
      current &&
      (current.sourceStart ?? 0) <= window.sourceContextStart &&
      (current.sourceEnd ?? 0) >= window.sourceContextEnd
    ) {
      continue;
    }
    regions[window.regionId] = {
      sequence: window.sourceContextSequence,
      annotations: window.sourceContextAnnotations,
      sourceStart: window.sourceContextStart,
      sourceEnd: window.sourceContextEnd,
      sourceLength: window.sourceLength,
      circular: window.circular,
    };
  }
  return { ready: true, regions };
}

function spacerLengthForJunction(design: SequenceDesign, junctionIndex: number): number {
  return (
    design.spacers.find((spacer) => spacer.junctionIndex === junctionIndex)?.sequence.length ?? 0
  );
}

export function sourceLookupKeys(
  request: Pick<SourceWindowRequest, 'sourceRef' | 'sourceSequenceName'>
): string[] {
  return [request.sourceRef.id, request.sourceSequenceName].filter((key): key is string =>
    Boolean(key)
  );
}

export async function loadSourceSequenceForKey(key: string): Promise<AnnotatedSequence | null> {
  const bundledSource = loadBundledSourceSequence(key);
  if (bundledSource) return bundledSource;
  const dbSequence = await loadSourceSequenceFromDb(key);
  return dbSequence;
}

export async function loadAllSourceSequencesFromDb(): Promise<
  Array<readonly [string, AnnotatedSequence]>
> {
  const sequences = await getSequences(500);
  const sources = await Promise.allSettled(
    sequences
      .filter((sequence) => Boolean(sequence.sequence))
      .map(async (sequence) => {
        const current = await getSequenceWithPath(sequence.id);
        if (!current) return [];
        await assertCanonicalSequenceSource(current.document_id, current.file_path);
        const annotated = dbSequenceToAnnotatedSequence(current);
        return [
          [current.document_id, annotated] as const,
          [`seq_${current.id}`, annotated] as const,
          [String(current.id), annotated] as const,
        ];
      })
  );
  return sources.flatMap((source) => (source.status === 'fulfilled' ? source.value : []));
}

function createSourceWindowRequest(
  method: CoordMappingStrategyName,
  junctionIndex: number,
  side: 'left' | 'right',
  region: DesignRegion,
  window: { registeredStartBioCol: number; registeredEndBioCol: number },
  spacerLength: number
): SourceWindowRequest {
  return {
    key: sourceWindowKey(method, junctionIndex, side),
    method,
    junctionIndex,
    side,
    regionId: region.id,
    regionSequence: region.sequence,
    regionAnnotations: region.annotations,
    sourceRef: sourceRefForRegion(region),
    sourceStart: region.sourceStart,
    sourceEnd: region.sourceEnd,
    sourceSequenceName: region.sourceSequenceName,
    registeredStartBioCol: window.registeredStartBioCol,
    registeredEndBioCol: window.registeredEndBioCol,
    spacerLength,
    inlineSourceSequence: region.sourceSequence,
    inlineSourceAnnotations: region.sourceAnnotations,
    inlineSourceIsCircular: region.sourceIsCircular,
  };
}

function sourceRefForRegion(region: DesignRegion): SourceRef {
  if (region.sourceSequence) {
    return { kind: 'inline', id: region.sourceSequenceId, name: region.sourceSequenceName };
  }
  if (region.sourceSequenceId.startsWith('seq_') || /^\d+$/.test(region.sourceSequenceId)) {
    return { kind: 'db-sequence', id: region.sourceSequenceId, name: region.sourceSequenceName };
  }
  if (region.sourceSequenceId) {
    return { kind: 'cache', id: region.sourceSequenceId, name: region.sourceSequenceName };
  }
  return { kind: 'unknown', id: region.id, name: region.sourceSequenceName };
}

function sourceRefForResolvedSource(
  request: SourceWindowRequest,
  source: AnnotatedSequence
): SourceRef {
  if (request.sourceRef.kind !== 'unknown') return request.sourceRef;
  return { kind: 'cache', id: source.id, name: source.name };
}

function annotatedSequenceFromInlineRequest(request: SourceWindowRequest): AnnotatedSequence {
  return {
    id: request.sourceRef.id,
    name: request.sourceSequenceName,
    sequence: request.inlineSourceSequence ?? '',
    length: request.inlineSourceSequence?.length ?? 0,
    circular: Boolean(request.inlineSourceIsCircular),
    annotations: designAnnotationsToSequenceAnnotations(request.inlineSourceAnnotations ?? []),
  };
}

function createWindowFromLocatedSource(
  request: SourceWindowRequest,
  located: LocatedSourceContext,
  status: SourceContextStatus
): SourceContextWindow {
  const source = located.source;
  const context = sourceContextSliceForRange(source, located.sourceStart, located.sourceEnd);

  return {
    key: request.key,
    regionId: request.regionId,
    sourceRef: located.sourceRef,
    status,
    sourceStart: located.sourceStart,
    sourceEnd: located.sourceEnd,
    sourceLength: source.sequence.length,
    circular: Boolean(source.circular),
    sourceContextStart: context.start,
    sourceContextEnd: context.end,
    sourceContextSequence: context.sequence,
    sourceContextAnnotations: toDesignAnnotations(source.annotations ?? []),
    registeredStartBioCol: request.registeredStartBioCol,
    registeredEndBioCol: request.registeredEndBioCol,
    sourceAnnotations: toDesignAnnotations(source.annotations ?? []),
  };
}

function createMissingWindow(request: SourceWindowRequest): SourceContextWindow {
  const sourceLength =
    request.inlineSourceSequence?.length ??
    Math.max(request.sourceEnd, request.sourceStart, request.regionSequence.length);
  const circular = Boolean(request.inlineSourceIsCircular);

  return {
    key: request.key,
    regionId: request.regionId,
    sourceRef: request.sourceRef,
    status: 'missing',
    sourceStart: request.sourceStart,
    sourceEnd: request.sourceEnd,
    circular,
    sourceContextStart: request.sourceStart,
    sourceContextEnd: request.sourceEnd,
    sourceContextSequence: request.regionSequence,
    sourceLength,
    sourceContextAnnotations: request.regionAnnotations.map((annotation) => ({
      ...annotation,
      start: request.sourceStart + annotation.start,
      end: request.sourceStart + annotation.end,
    })),
    registeredStartBioCol: request.registeredStartBioCol,
    registeredEndBioCol: request.registeredEndBioCol,
    sourceAnnotations: request.regionAnnotations.map((annotation) => ({
      ...annotation,
      start: request.sourceStart + annotation.start,
      end: request.sourceStart + annotation.end,
    })),
  };
}

function sourceContextSliceForRange(
  source: AnnotatedSequence,
  sourceStart: number,
  sourceEnd: number
): { start: number; end: number; sequence: string } {
  const circular = Boolean(source.circular);
  const interval = unwrapCircularInterval(sourceStart, sourceEnd, source.sequence.length, circular);
  const start = circular
    ? interval.start - DEFAULT_SOURCE_CONTEXT_BUFFER_BP
    : Math.max(0, interval.start - DEFAULT_SOURCE_CONTEXT_BUFFER_BP);
  const end = circular
    ? interval.end + DEFAULT_SOURCE_CONTEXT_BUFFER_BP
    : Math.min(source.sequence.length, interval.end + DEFAULT_SOURCE_CONTEXT_BUFFER_BP);
  if (!circular) {
    return { start, end, sequence: source.sequence.slice(start, end) };
  }
  let sequence = '';
  for (let position = start; position < end; position++) {
    const normalized = resolveSourcePosition(position, source);
    sequence += normalized === null ? ' ' : (source.sequence[normalized] ?? ' ');
  }
  return { start, end, sequence };
}

function loadBundledSourceSequence(key: string): AnnotatedSequence | null {
  if (
    !(import.meta.env.DEV || import.meta.env.MODE === 'test') ||
    key !== 'fixture:sequence:puc19-real-assembly'
  )
    return null;
  return parseSourceSequenceFile(PUC19_REAL_ASSEMBLY_FIXTURE_GB, key);
}

function locateRegionInSource(
  request: SourceWindowRequest,
  source: AnnotatedSequence
): { start: number; end: number; matchedExpectedInterval: boolean } | null {
  if (!source.sequence || !request.regionSequence) return null;

  const expected = extractSourceSlice(
    source.sequence,
    request.sourceStart,
    request.sourceEnd,
    Boolean(source.circular)
  );
  if (sameDna(expected, request.regionSequence)) {
    return {
      start: request.sourceStart,
      end: request.sourceEnd,
      matchedExpectedInterval: true,
    };
  }

  const haystack = source.sequence.toUpperCase();
  const needle = request.regionSequence.toUpperCase();
  const directIndex = haystack.indexOf(needle);
  if (directIndex >= 0) {
    return {
      start: directIndex,
      end: directIndex + request.regionSequence.length,
      matchedExpectedInterval: false,
    };
  }

  if (source.circular === true && request.regionSequence.length <= source.sequence.length) {
    const wrappedIndex = (haystack + haystack).indexOf(needle);
    if (wrappedIndex >= 0 && wrappedIndex < source.sequence.length) {
      return {
        start: wrappedIndex,
        end: wrappedIndex + request.regionSequence.length,
        matchedExpectedInterval: false,
      };
    }
  }

  return null;
}

function resolveSourcePosition(
  rawSourcePosition: number,
  source: Pick<AnnotatedSequence, 'sequence' | 'circular'>
): number | null {
  if (source.sequence.length === 0) return null;
  if (source.circular) return normalizePosition(rawSourcePosition, source.sequence.length);
  if (rawSourcePosition < 0 || rawSourcePosition >= source.sequence.length) return null;
  return rawSourcePosition;
}

function extractSourceSlice(
  sourceSequence: string,
  start: number,
  end: number,
  circular: boolean
): string {
  if (sourceSequence.length === 0) return '';
  if (!circular) return sourceSequence.slice(start, end);

  const length = end >= start ? end - start : sourceSequence.length - start + end;
  if (length <= 0) return '';

  let result = '';
  for (let offset = 0; offset < length; offset++) {
    result += sourceSequence[normalizePosition(start + offset, sourceSequence.length)] ?? '';
  }
  return result;
}

function sameDna(a: string, b: string): boolean {
  return a.length === b.length && a.toUpperCase() === b.toUpperCase();
}

function normalizePosition(position: number, length: number): number {
  if (length <= 0) return 0;
  return ((position % length) + length) % length;
}

function toDesignAnnotations(annotations: AnnotatedSequence['annotations']): DesignAnnotation[] {
  return (annotations ?? []).map((annotation) => ({
    name: annotation.name,
    type: annotation.type,
    start: annotation.start - 1,
    end: annotation.end,
    strand:
      annotation.direction === 1 ? 'forward' : annotation.direction === -1 ? 'reverse' : 'none',
    color: annotation.color,
    qualifiers: designQualifiersFromSequence(annotation.qualifiers),
  }));
}

function designAnnotationsToSequenceAnnotations(annotations: DesignAnnotation[]): Annotation[] {
  return annotations.map((annotation) => ({
    name: annotation.name,
    type: annotation.type,
    start: annotation.start + 1,
    end: annotation.end,
    direction: annotation.strand === 'forward' ? 1 : annotation.strand === 'reverse' ? -1 : 0,
    color: annotation.color,
    qualifiers: sequenceQualifiersFromDesign(annotation.qualifiers),
  }));
}

function designQualifiersFromSequence(
  qualifiers: Record<string, string[] | string> | undefined
): Record<string, string> | undefined {
  if (!qualifiers) return undefined;
  const converted: Record<string, string> = {};
  for (const [key, values] of Object.entries(qualifiers)) {
    const value = Array.isArray(values)
      ? (values.find((item) => item.length > 0) ?? values[0])
      : values;
    if (value !== undefined) converted[key] = value;
  }
  return Object.keys(converted).length > 0 ? converted : undefined;
}

function sequenceQualifiersFromDesign(
  qualifiers: Record<string, string> | undefined
): Record<string, string[]> | undefined {
  if (!qualifiers) return undefined;
  const converted: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(qualifiers)) {
    converted[key] = [value];
  }
  return converted;
}

async function loadSourceSequenceFromDb(key: string): Promise<AnnotatedSequence | null> {
  const sequenceId = await resolveSequenceId(key);
  if (sequenceId === null) return null;
  const sequence = await getSequenceWithPath(sequenceId);
  if (!sequence) return null;
  await assertCanonicalSequenceSource(sequence.document_id, sequence.file_path);
  if (!sequence.sequence) {
    const parsed = await loadSourceSequenceFromPrivatePath(sequence.file_path);
    return parsed ? { ...parsed, id: sequence.document_id } : null;
  }
  return dbSequenceToAnnotatedSequence(sequence);
}

async function resolveSequenceId(key: string): Promise<number | null> {
  if (key.startsWith('seq_')) {
    const id = Number.parseInt(key.slice(4), 10);
    return Number.isFinite(id) ? id : null;
  }
  if (/^\d+$/.test(key)) {
    return Number.parseInt(key, 10);
  }
  return getSequenceIdByDocumentId(key);
}

function dbSequenceToAnnotatedSequence(
  sequence: DBSequence & { file_path: string }
): AnnotatedSequence {
  return {
    id: String(sequence.id),
    name: sequence.name,
    sequence: sequence.sequence ?? '',
    length: sequence.length,
    circular: Boolean(sequence.circular),
    annotations: [],
  };
}

async function loadSourceSequenceFromPrivatePath(
  sourcePath: string
): Promise<AnnotatedSequence | null> {
  try {
    const filename = sourcePath.split(/[\\/]/).pop() || sourcePath;
    const content = isBinarySequencePath(filename)
      ? await platform().fs.readFile(sourcePath)
      : await platform().fs.readTextFile(sourcePath);
    return parseSourceSequenceFile(content, sourcePath);
  } catch {
    return null;
  }
}

function parseSourceSequenceFile(
  content: string | ArrayBuffer | Uint8Array | Buffer,
  filePath: string
): AnnotatedSequence | null {
  const filename = filePath.split('/').pop() || filePath;
  try {
    return decodeSequenceDocument(content, { path: filePath, filename }).sequence;
  } catch {
    return null;
  }
}

function isBinarySequencePath(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext === 'ab1' || ext === 'abi' || ext === 'dna';
}
