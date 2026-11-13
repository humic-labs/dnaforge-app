import type { Feature } from '@waypoint/genome-renderer';

export interface AlignmentColumnChange {
  readonly start: number;
  readonly end: number;
  readonly kind: 'insertion' | 'deletion' | 'substitution';
}

export interface AnnotationDnaData {
  readonly dnaChange: 'unchanged' | 'added' | 'removed' | 'modified';
  readonly dnaChanged: boolean;
  readonly insertedBases: number;
  readonly deletedBases: number;
  readonly substitutedBases: number;
  readonly referenceBases: number;
  readonly queryBases: number;
}

export interface AnnotationComparisonData extends AnnotationDnaData {
  readonly featureId: number;
  readonly source: 'before' | 'after';
  readonly recordChange: 'unchanged' | 'added' | 'removed' | 'modified' | null;
}

export function annotationColumnRanges(feature: Feature): Array<{ start: number; end: number }> {
  const intervals = feature.exons?.length ? feature.exons : feature.segments;
  return intervals?.length
    ? intervals.map(({ start, end }) => ({ start: start - 1, end }))
    : [{ start: feature.start, end: feature.end }];
}

function requireMatchingColumns(reference: string, query: string): void {
  if (!reference.length || reference.length !== query.length) {
    throw new Error('Aligned DNA must have equal nonempty gapped columns.');
  }
}

export function alignmentColumnChanges(reference: string, query: string): AlignmentColumnChange[] {
  requireMatchingColumns(reference, query);
  const changes: Array<{ start: number; end: number; kind: AlignmentColumnChange['kind'] }> = [];
  for (let column = 0; column < reference.length; column++) {
    const before = reference[column].toUpperCase();
    const after = query[column].toUpperCase();
    if (before === after) continue;
    const kind = before === '-' ? 'insertion' : after === '-' ? 'deletion' : 'substitution';
    const previous = changes[changes.length - 1];
    if (previous?.kind === kind && previous.end === column) previous.end++;
    else changes.push({ start: column, end: column + 1, kind });
  }
  return changes;
}

export function annotationDnaData(
  feature: Feature,
  reference: string,
  query: string,
  previous?: Feature
): AnnotationDnaData {
  requireMatchingColumns(reference, query);
  const ranges = [
    ...annotationColumnRanges(feature),
    ...(previous ? annotationColumnRanges(previous) : []),
  ]
    .flatMap((range) =>
      range.end < range.start
        ? [
            { start: range.start, end: reference.length },
            { start: 0, end: range.end },
          ]
        : [range]
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let coveredUntil = 0;
  let insertedBases = 0;
  let deletedBases = 0;
  let substitutedBases = 0;
  let referenceBases = 0;
  let queryBases = 0;
  for (const range of ranges) {
    const start = Math.max(coveredUntil, range.start);
    const end = Math.min(reference.length, range.end);
    for (let column = start; column < end; column++) {
      const before = reference[column].toUpperCase();
      const after = query[column].toUpperCase();
      if (before !== '-') referenceBases++;
      if (after !== '-') queryBases++;
      if (before === after) continue;
      if (before === '-') insertedBases++;
      else if (after === '-') deletedBases++;
      else substitutedBases++;
    }
    coveredUntil = Math.max(coveredUntil, end);
  }
  const dnaChanged = insertedBases + deletedBases + substitutedBases > 0;
  return {
    dnaChange: !dnaChanged
      ? 'unchanged'
      : referenceBases === 0
        ? 'added'
        : queryBases === 0
          ? 'removed'
          : 'modified',
    dnaChanged,
    insertedBases,
    deletedBases,
    substitutedBases,
    referenceBases,
    queryBases,
  };
}
