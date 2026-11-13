import type { AnnotationRecord } from '@waypoint/genome-data';

import type {
  IndexedGenomePrimerBinding,
  IndexedGenomeUserAnnotation,
} from '../../shared/indexed-genome';
import type { ActiveStressDataset } from './lane-contract-store';
import type { IndexedAssemblyCoordinates } from './indexed-viewport-command';

export const INDEXED_USER_ANNOTATION_TRACK_ID = 'indexed-user-annotations';
const INDEXED_USER_ANNOTATION_TRACK_TYPE = 'generic-interval';
const DEFAULT_USER_ANNOTATION_COLOR = 0x16a34a;

export function upsertIndexedUserAnnotation(
  annotations: ReadonlyArray<IndexedGenomeUserAnnotation>,
  annotation: IndexedGenomeUserAnnotation
): IndexedGenomeUserAnnotation[] {
  const index = annotations.findIndex((candidate) => candidate.id === annotation.id);
  if (index < 0) return [...annotations, annotation];
  return annotations.map((candidate, candidateIndex) =>
    candidateIndex === index ? annotation : candidate
  );
}

export function deleteIndexedUserAnnotation(
  annotations: ReadonlyArray<IndexedGenomeUserAnnotation>,
  annotationId: string
): IndexedGenomeUserAnnotation[] {
  return annotations.filter((annotation) => annotation.id !== annotationId);
}

export function findIndexedUserAnnotationAtRendererPosition(
  annotations: ReadonlyArray<IndexedGenomeUserAnnotation>,
  rendererPosition: number,
  assembly?: IndexedAssemblyCoordinates
): IndexedGenomeUserAnnotation | null {
  if (!Number.isFinite(rendererPosition) || rendererPosition < 0) return null;
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const candidate = annotations[index];
    const range = rendererRangeForAnnotation(candidate, assembly);
    if (range && rendererPosition >= range.start && rendererPosition < range.end) return candidate;
  }
  return null;
}

export function indexedUserAnnotationDataset(
  annotations: ReadonlyArray<IndexedGenomeUserAnnotation>,
  assembly?: IndexedAssemblyCoordinates
): ActiveStressDataset | null {
  const records = annotations.flatMap((annotation) => {
    const range = rendererRangeForAnnotation(annotation, assembly);
    if (!range) return [];
    const record: AnnotationRecord = {
      chrom: annotation.chrom,
      start: range.start,
      end: range.end,
      name: annotation.annotation.name,
      color: parseAnnotationColor(annotation.annotation.color),
      strand: strandForDirection(annotation.annotation.direction),
      extra: {
        userAnnotationId: annotation.id,
        annotationType: annotation.annotation.type,
        ...(annotation.annotation.qualifiers
          ? { qualifiers: annotation.annotation.qualifiers }
          : {}),
      },
    };
    return [record];
  });
  if (records.length === 0) return null;
  return {
    trackType: INDEXED_USER_ANNOTATION_TRACK_TYPE,
    trackId: INDEXED_USER_ANNOTATION_TRACK_ID,
    label: 'User annotations',
    color: DEFAULT_USER_ANNOTATION_COLOR,
    laneHeightPx: 18,
    maxLanes: 24,
    trackPx: 44,
    records,
    kind: 'annotation',
  };
}

function rendererRangeForAnnotation(
  value: IndexedGenomeUserAnnotation,
  assembly?: IndexedAssemblyCoordinates
): { start: number; end: number } | null {
  const { annotation } = value;
  if (
    !value.id ||
    !value.chrom ||
    !annotation.name.trim() ||
    !Number.isSafeInteger(annotation.start) ||
    !Number.isSafeInteger(annotation.end) ||
    annotation.start < 1 ||
    annotation.end < annotation.start
  ) {
    return null;
  }
  let offset = 0;
  if (assembly) {
    const chromosome = assembly.chromosomes.find((candidate) => candidate.chrom === value.chrom);
    if (!chromosome || annotation.end > chromosome.length) return null;
    for (const candidate of assembly.chromosomes) {
      if (candidate.chrom === value.chrom) break;
      offset += candidate.length;
    }
  }
  return { start: offset + annotation.start - 1, end: offset + annotation.end };
}

function parseAnnotationColor(color: string | undefined): number {
  return color && /^#[0-9a-f]{6}$/i.test(color)
    ? Number.parseInt(color.slice(1), 16)
    : DEFAULT_USER_ANNOTATION_COLOR;
}

function strandForDirection(direction: -1 | 0 | 1): '+' | '-' | '.' {
  if (direction === 1) return '+';
  if (direction === -1) return '-';
  return '.';
}

export function trackViewUserLayers(state: {
  primerBindings?: readonly IndexedGenomePrimerBinding[];
  userAnnotations?: readonly IndexedGenomeUserAnnotation[];
}): {
  primerBindings?: IndexedGenomePrimerBinding[];
  userAnnotations?: IndexedGenomeUserAnnotation[];
} {
  const primerBindings = (state.primerBindings ?? []).map((binding) => ({
    id: binding.id,
    primerId: binding.primerId,
    primerName: binding.primerName,
    primerBases: binding.primerBases,
    chrom: binding.chrom,
    start0: binding.start0,
    end0: binding.end0,
    strand: binding.strand,
    source: binding.source,
  }));
  const userAnnotations = (state.userAnnotations ?? []).map(({ id, chrom, annotation }) => ({
    id,
    chrom,
    annotation: {
      name: annotation.name,
      type: annotation.type,
      start: annotation.start,
      end: annotation.end,
      direction: annotation.direction,
      ...(annotation.color !== undefined ? { color: annotation.color } : {}),
      ...(annotation.label !== undefined ? { label: annotation.label } : {}),
      ...(annotation.qualifiers !== undefined ? { qualifiers: annotation.qualifiers } : {}),
      ...(annotation.segments !== undefined ? { segments: annotation.segments } : {}),
    },
  }));
  return {
    ...(primerBindings.length > 0 ? { primerBindings } : {}),
    ...(userAnnotations.length > 0 ? { userAnnotations } : {}),
  };
}
