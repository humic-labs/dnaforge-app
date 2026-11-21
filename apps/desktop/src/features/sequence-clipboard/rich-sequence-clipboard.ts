import {
  isCodingFeature,
  resolveAnnotationGeneticCode,
  reverseComplement,
  STANDARD_GENETIC_CODE_ID,
  type Annotation,
  type GeneticCodeSpec,
  type NucleicAcid,
} from '@waypoint/sequence-utils';
import type { EditorPasteFragment } from '@waypoint/workspace-editor';
import type { DesignAnnotation, DesignRegion, GoldenGateEnzyme } from '../design/public/types';

export const RICH_SEQUENCE_CLIPBOARD_FORMAT = 'dnaforge.rich-sequence-fragment' as const;
export const RICH_SEQUENCE_CLIPBOARD_VERSION = 2 as const;

export interface CopiedSequenceRange {
  start: number;
  end: number;
  wraps?: boolean;
}

export type CopiedSequenceOrientation = 'forward' | 'reverse-complement';

export interface CopiedSourceCoordinates {
  start: number;
  end: number;
  wraps?: boolean;
}

export function inclusiveCopiedSourceCoordinates(
  range: { start: number; end: number; wraps?: boolean },
  sequenceLength: number
): CopiedSourceCoordinates | null {
  if (!Number.isInteger(range.start) || range.start < 1 || !Number.isInteger(range.end)) {
    return null;
  }
  if (range.wraps && range.end === 0) {
    if (sequenceLength < range.start) return null;
    return { start: range.start, end: sequenceLength, wraps: true };
  }
  const end = range.end - 1;
  if (end < 1) return null;
  if (range.wraps || end < range.start) {
    return { start: range.start, end, wraps: true };
  }
  return { start: range.start, end };
}

export interface CopyablePrimerBinding {
  primerId: string;
  bindingStart: number;
  bindingEnd: number;
  strand: 1 | -1;
  sourceWorkspaceRoot?: string;
}

export interface RichSequencePrimerBinding {
  primerId: string;
  start: number;
  end: number;
  strand: 1 | -1;
  sourceWorkspaceRoot?: string;
}

export interface RichSequenceAnnotation extends DesignAnnotation {
  segments?: Array<{ start: number; end: number }>;
}

export interface RichSequenceFragment {
  format: typeof RICH_SEQUENCE_CLIPBOARD_FORMAT;
  version: number;
  sequence: string;
  sourceGeneticCode?: GeneticCodeSpec;
  sourceHadCodingContext?: boolean;
  sourceSequence?: string;
  sourceId: string;
  sourceName: string;
  start: number;
  end: number;
  sourceCoordinates?: CopiedSourceCoordinates;
  annotations: RichSequenceAnnotation[];
  sourceAnnotations?: DesignAnnotation[];
  sourceIsCircular?: boolean;
  sourceWorkspaceRoot?: string;
  primerBindings: RichSequencePrimerBinding[];
  sourceType?: 'pcr' | 'rd';
  ggType?: 'insert' | 'backbone' | 'unusable' | 'rd';
  rdOverhangs?: {
    upstream: string;
    downstream: string;
  };
  rdSourceEnzyme?: GoldenGateEnzyme;
  rdSourceEnzymeName?: string;
  rdEnds?: DesignRegion['rdEnds'];
  rdSiblingOverhangs?: string[];
}

export type RichSequenceFragmentInput = Omit<
  RichSequenceFragment,
  'format' | 'version' | 'primerBindings'
> & {
  primerBindings?: RichSequencePrimerBinding[];
};

export interface BuildRichSequenceFragmentInput {
  sourceId: string;
  sourceName: string;
  sourceSequence: string;
  sourceAnnotations: readonly Annotation[];
  sourceGeneticCode?: GeneticCodeSpec;
  sourceNucleicAcid?: NucleicAcid;
  sourcePrimerBindings?: readonly CopyablePrimerBinding[];
  sourceIsCircular?: boolean;
  sourceWorkspaceRoot?: string;
  range: CopiedSequenceRange;
  orientation: CopiedSequenceOrientation;
}

type Segment = {
  sourceStart: number;
  sourceEnd: number;
  relativeOffset: number;
};

export function normalizeRichSequenceFragment(
  input: RichSequenceFragmentInput
): RichSequenceFragment {
  return {
    ...input,
    format: RICH_SEQUENCE_CLIPBOARD_FORMAT,
    version: RICH_SEQUENCE_CLIPBOARD_VERSION,
    primerBindings: input.primerBindings ?? [],
  };
}

export function buildRichSequenceFragmentFromSelection(input: BuildRichSequenceFragmentInput): {
  clipboardSequence: string;
  fragment: RichSequenceFragment;
  region: RichSequenceFragment;
} {
  const sequenceLength = input.sourceSequence.length;
  const range = normalizeRange(input.range, sequenceLength);
  const forwardSelection = sequenceForRange(input.sourceSequence, range, sequenceLength);
  const clipboardSequence =
    input.orientation === 'reverse-complement'
      ? reverseComplement(forwardSelection, input.sourceNucleicAcid)
      : forwardSelection;
  const orientedRange = orientRange(range, sequenceLength, input.orientation);
  const sourceSequence =
    input.orientation === 'reverse-complement'
      ? reverseComplement(input.sourceSequence, input.sourceNucleicAcid)
      : input.sourceSequence;
  const annotations = orientRegionAnnotations(
    stampGeneticCodeOnCodingAnnotations(
      extractDesignAnnotationsForRange(input.sourceAnnotations, range, sequenceLength),
      input.sourceAnnotations,
      input.sourceGeneticCode ?? STANDARD_GENETIC_CODE_ID
    ),
    forwardSelection.length,
    input.orientation
  );
  const sourceAnnotations = orientSourceAnnotations(
    input.sourceAnnotations,
    sequenceLength,
    input.orientation
  );
  const primerBindings = orientPrimerBindings(
    extractPrimerBindingsForRange(input.sourcePrimerBindings ?? [], range, sequenceLength),
    forwardSelection.length,
    input.orientation
  );

  const sourceGeneticCode = input.sourceGeneticCode ?? STANDARD_GENETIC_CODE_ID;
  const fragment = normalizeRichSequenceFragment({
    sequence: clipboardSequence,
    sourceSequence,
    sourceId: input.sourceId,
    sourceName: input.sourceName,
    start: orientedRange.start,
    end: orientedRange.end,
    annotations,
    sourceAnnotations,
    sourceIsCircular: input.sourceIsCircular,
    sourceWorkspaceRoot: input.sourceWorkspaceRoot,
    primerBindings,
    sourceType: 'pcr',
    sourceGeneticCode,
    sourceHadCodingContext: rangeOverlapsCodingFeature(
      input.sourceAnnotations,
      range,
      sequenceLength
    ),
  });
  return { clipboardSequence, fragment, region: fragment };
}

export const buildCopiedRegionFromSelection = buildRichSequenceFragmentFromSelection;

export function richSequenceFragmentForEditor(fragment: RichSequenceFragment): EditorPasteFragment {
  return {
    sequence: fragment.sequence,
    annotations: fragment.annotations.map((annotation) => ({
      name: annotation.name,
      type: annotation.type,
      start: annotation.start + 1,
      end: annotation.end,
      direction: annotation.strand === 'forward' ? 1 : annotation.strand === 'reverse' ? -1 : 0,
      color: annotation.color,
      ...(annotation.segments
        ? {
            segments: annotation.segments.map((segment) => ({
              start: segment.start + 1,
              end: segment.end,
            })),
          }
        : {}),
      qualifiers: annotation.qualifiers
        ? Object.fromEntries(
            Object.entries(annotation.qualifiers).map(([key, value]) => [key, [value]])
          )
        : undefined,
    })),
    primerBindings: fragment.primerBindings.map((binding) => ({
      ...binding,
      sourceWorkspaceRoot: binding.sourceWorkspaceRoot ?? fragment.sourceWorkspaceRoot,
    })),
  };
}

function rangeOverlapsCodingFeature(
  annotations: readonly Annotation[],
  range: CopiedSequenceRange,
  sequenceLength: number
): boolean {
  const selection = getRangeSegments(range, sequenceLength);
  if (selection.length === 0) return false;
  for (const annotation of annotations) {
    if (!isCodingFeature(annotation)) continue;
    for (const source of getAnnotationSegments(annotation, sequenceLength)) {
      for (const selected of selection) {
        if (
          Math.min(selected.sourceEnd, source.sourceEnd) >
          Math.max(selected.sourceStart, source.sourceStart)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function stampGeneticCodeOnCodingAnnotations(
  extracted: RichSequenceAnnotation[],
  sourceAnnotations: readonly Annotation[],
  sourceGeneticCode: GeneticCodeSpec
): RichSequenceAnnotation[] {
  const declaredByKey = new Map<string, GeneticCodeSpec>();
  for (const annotation of sourceAnnotations) {
    if (!isCodingFeature(annotation)) continue;
    declaredByKey.set(
      `${annotation.type}\u0000${annotation.name}`,
      resolveAnnotationGeneticCode(annotation, sourceGeneticCode)
    );
  }

  return extracted.map((annotation) => {
    const code = declaredByKey.get(`${annotation.type}\u0000${annotation.name}`);
    if (typeof code !== 'number' || code === STANDARD_GENETIC_CODE_ID) return annotation;
    return {
      ...annotation,
      qualifiers: { ...(annotation.qualifiers ?? {}), transl_table: String(code) },
    };
  });
}

export function extractDesignAnnotationsForRange(
  annotations: readonly Annotation[],
  range: CopiedSequenceRange,
  sequenceLength: number
): RichSequenceAnnotation[] {
  if (annotations.length === 0 || sequenceLength <= 0) return [];

  const selectionSegments = getRangeSegments(range, sequenceLength);
  const result: RichSequenceAnnotation[] = [];

  for (const annotation of annotations) {
    const annotationSegments = getAnnotationSegments(annotation, sequenceLength);

    for (const selected of selectionSegments) {
      for (const source of annotationSegments) {
        const start = Math.max(selected.sourceStart, source.sourceStart);
        const end = Math.min(selected.sourceEnd, source.sourceEnd);
        if (end <= start) continue;

        const qualifiers = designQualifiersFromSequence(annotation.qualifiers);
        const segments = annotation.segments?.flatMap((segment) => {
          const segmentStart = Math.max(start, segment.start - 1);
          const segmentEnd = Math.min(end, segment.end);
          return segmentEnd > segmentStart
            ? [
                {
                  start: selected.relativeOffset + segmentStart - selected.sourceStart,
                  end: selected.relativeOffset + segmentEnd - selected.sourceStart,
                },
              ]
            : [];
        });
        if (annotation.segments && !segments?.length) continue;
        result.push({
          name: annotation.name,
          type: annotation.type,
          start: segments?.length
            ? Math.min(...segments.map((segment) => segment.start))
            : selected.relativeOffset + start - selected.sourceStart,
          end: segments?.length
            ? Math.max(...segments.map((segment) => segment.end))
            : selected.relativeOffset + end - selected.sourceStart,
          strand:
            annotation.direction === 1
              ? 'forward'
              : annotation.direction === -1
                ? 'reverse'
                : 'none',
          color: annotation.color,
          ...(segments?.length ? { segments } : {}),
          ...(qualifiers ? { qualifiers } : {}),
        });
      }
    }
  }

  return result;
}

export function extractPrimerBindingsForRange(
  bindings: readonly CopyablePrimerBinding[],
  range: CopiedSequenceRange,
  sequenceLength: number
): RichSequencePrimerBinding[] {
  const selectionSegments = getRangeSegments(range, sequenceLength);
  const result: RichSequencePrimerBinding[] = [];

  for (const binding of bindings) {
    if (binding.bindingEnd <= binding.bindingStart) continue;
    const containingSegment = selectionSegments.find(
      (segment) =>
        binding.bindingStart >= segment.sourceStart && binding.bindingEnd <= segment.sourceEnd
    );
    if (!containingSegment) continue;
    result.push({
      primerId: binding.primerId,
      start:
        containingSegment.relativeOffset + binding.bindingStart - containingSegment.sourceStart,
      end: containingSegment.relativeOffset + binding.bindingEnd - containingSegment.sourceStart,
      strand: binding.strand,
      ...(binding.sourceWorkspaceRoot ? { sourceWorkspaceRoot: binding.sourceWorkspaceRoot } : {}),
    });
  }

  return result.sort((a, b) => a.start - b.start || a.end - b.end);
}

function getRangeSegments(range: CopiedSequenceRange, sequenceLength: number): Segment[] {
  const start = clamp(range.start, 0, sequenceLength);
  const end = clamp(range.end, 0, sequenceLength);

  if (range.wraps) {
    return [
      { sourceStart: start, sourceEnd: sequenceLength, relativeOffset: 0 },
      { sourceStart: 0, sourceEnd: end, relativeOffset: sequenceLength - start },
    ].filter((segment) => segment.sourceEnd > segment.sourceStart);
  }

  const sourceStart = Math.min(start, end);
  const sourceEnd = Math.max(start, end);
  return sourceEnd > sourceStart ? [{ sourceStart, sourceEnd, relativeOffset: 0 }] : [];
}

function getAnnotationSegments(annotation: Annotation, sequenceLength: number): Segment[] {
  const start = clamp(annotation.start - 1, 0, sequenceLength);
  const end = clamp(annotation.end, 0, sequenceLength);

  if (start <= end) {
    return end > start ? [{ sourceStart: start, sourceEnd: end, relativeOffset: 0 }] : [];
  }

  return [
    { sourceStart: start, sourceEnd: sequenceLength, relativeOffset: 0 },
    { sourceStart: 0, sourceEnd: end, relativeOffset: sequenceLength - start },
  ].filter((segment) => segment.sourceEnd > segment.sourceStart);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeRange(range: CopiedSequenceRange, sequenceLength: number): CopiedSequenceRange {
  return {
    start: clamp(range.start, 0, sequenceLength),
    end: clamp(range.end, 0, sequenceLength),
    wraps: range.wraps,
  };
}

function sequenceForRange(
  sourceSequence: string,
  range: CopiedSequenceRange,
  sequenceLength: number
): string {
  return getRangeSegments(range, sequenceLength)
    .map((segment) => sourceSequence.slice(segment.sourceStart, segment.sourceEnd))
    .join('');
}

function orientRange(
  range: CopiedSequenceRange,
  sequenceLength: number,
  orientation: CopiedSequenceOrientation
): CopiedSequenceRange {
  if (orientation === 'forward') return range;
  return {
    start: sequenceLength - range.end,
    end: sequenceLength - range.start,
    wraps: range.wraps,
  };
}

function orientRegionAnnotations(
  annotations: RichSequenceAnnotation[],
  selectionLength: number,
  orientation: CopiedSequenceOrientation
): RichSequenceAnnotation[] {
  if (orientation === 'forward') return sortAnnotations(annotations);

  return sortAnnotations(
    annotations.map((annotation) => ({
      ...annotation,
      start: selectionLength - annotation.end,
      end: selectionLength - annotation.start,
      strand: flipStrand(annotation.strand),
      ...(annotation.segments
        ? {
            segments: annotation.segments
              .map((segment) => ({
                start: selectionLength - segment.end,
                end: selectionLength - segment.start,
              }))
              .sort((a, b) => a.start - b.start || a.end - b.end),
          }
        : {}),
    }))
  );
}

function orientPrimerBindings(
  bindings: RichSequencePrimerBinding[],
  selectionLength: number,
  orientation: CopiedSequenceOrientation
): RichSequencePrimerBinding[] {
  if (orientation === 'forward') return bindings;
  return bindings
    .map((binding) => ({
      ...binding,
      start: selectionLength - binding.end,
      end: selectionLength - binding.start,
      strand: binding.strand === 1 ? (-1 as const) : (1 as const),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function orientSourceAnnotations(
  annotations: readonly Annotation[],
  sequenceLength: number,
  orientation: CopiedSequenceOrientation
): DesignAnnotation[] {
  return sortAnnotations(
    annotations.map((annotation) => {
      const designAnnotation = designAnnotationFromSequence(annotation, sequenceLength);
      if (orientation === 'forward') return designAnnotation;
      return {
        ...designAnnotation,
        start: sequenceLength - designAnnotation.end,
        end: sequenceLength - designAnnotation.start,
        strand: flipStrand(designAnnotation.strand),
      };
    })
  );
}

function designAnnotationFromSequence(
  annotation: Annotation,
  sequenceLength: number
): DesignAnnotation {
  const qualifiers = designQualifiersFromSequence(annotation.qualifiers);
  return {
    name: annotation.name,
    type: annotation.type,
    start: clamp(annotation.start - 1, 0, sequenceLength),
    end: clamp(annotation.end, 0, sequenceLength),
    strand:
      annotation.direction === 1 ? 'forward' : annotation.direction === -1 ? 'reverse' : 'none',
    color: annotation.color,
    ...(qualifiers ? { qualifiers } : {}),
  };
}

function designQualifiersFromSequence(
  qualifiers: Record<string, string[]> | undefined
): Record<string, string> | undefined {
  if (!qualifiers) return undefined;
  const result: Record<string, string> = {};
  for (const [key, values] of Object.entries(qualifiers)) {
    const value = values[0];
    if (value !== undefined) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function flipStrand(strand: DesignAnnotation['strand']): DesignAnnotation['strand'] {
  if (strand === 'forward') return 'reverse';
  if (strand === 'reverse') return 'forward';
  return 'none';
}

function sortAnnotations<T extends DesignAnnotation>(annotations: T[]): T[] {
  return [...annotations].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return a.end - b.end;
    return a.name.localeCompare(b.name);
  });
}
