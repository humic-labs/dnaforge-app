export interface AlignmentObservationSource {
  alignedReference: string;
  alignedQuery: string;
  circularOffset?: number;
  referenceLength?: number;
}

export interface AlignmentEvidence {
  total: number;
  unresolved: number;
  ambiguousInsertions: number;
  complete: boolean;
}

export interface ReferenceAlignmentContext {
  sequence: string;
  topology: 'linear' | 'circular';
}

export interface ReferenceAlignmentObservation {
  circularOffset: number;
  referenceLength: number;
  referencePositions: ReadonlyArray<number | null>;
  insertionBoundaries: ReadonlyArray<number | null>;
  observedColumns: ReadonlyArray<boolean>;
  evidence: AlignmentEvidence;
  coverage: { start: number; end: number };
  completeInReferenceOrder: boolean;
}

export type ReferenceAlignmentInterpretation =
  | { kind: 'placed'; value: ReferenceAlignmentObservation }
  | { kind: 'unplaced' | 'invalid'; reason: string };

export interface AlignmentMutationAddress {
  position: number;
  type: 'substitution' | 'insertion' | 'deletion';
  length: number;
}

function referenceSpan(source: AlignmentObservationSource): number {
  return source.alignedReference.replace(/-/g, '').length;
}

function scanAlignment(
  source: AlignmentObservationSource,
  referenceLength: number,
  circularOffset: number,
  topology: ReferenceAlignmentContext['topology'],
  reference?: string
): ReferenceAlignmentInterpretation {
  const { alignedReference, alignedQuery } = source;
  if (!alignedReference.length || alignedReference.length !== alignedQuery.length) {
    return { kind: 'invalid', reason: 'Alignment columns must be nonempty and equal in length.' };
  }
  if (
    !Number.isInteger(referenceLength) ||
    referenceLength <= 0 ||
    !Number.isInteger(circularOffset) ||
    circularOffset < 0 ||
    circularOffset >= referenceLength ||
    (topology === 'linear' && circularOffset !== 0)
  ) {
    return { kind: 'invalid', reason: 'Alignment placement is outside the original reference.' };
  }
  const span = referenceSpan(source);
  if (span === 0 || span > referenceLength) {
    return { kind: 'invalid', reason: 'Alignment must traverse at most one reference copy.' };
  }
  const first = alignedQuery.search(/[^-]/);
  let last = alignedQuery.length - 1;
  while (last >= 0 && alignedQuery[last] === '-') last--;
  const referencePositions: Array<number | null> = [];
  const insertionBoundaries: Array<number | null> = [];
  const observedColumns: boolean[] = [];
  let consumed = 0;
  let unresolved = referenceLength - span;
  let ambiguousInsertions = 0;
  let start = 0;
  let end = 0;
  for (let column = 0; column < alignedReference.length; column++) {
    const ref = alignedReference[column].toUpperCase();
    const query = alignedQuery[column].toUpperCase();
    const observed = first >= 0 && column >= first && column <= last;
    const boundary = circularOffset + consumed;
    if (ref === '-') {
      referencePositions.push(null);
      insertionBoundaries.push(topology === 'circular' ? boundary % referenceLength : boundary);
      observedColumns.push(observed && query !== '-');
      if (query !== '-' && !/^[ACGTU]$/.test(query)) ambiguousInsertions++;
      continue;
    }
    const position = (boundary % referenceLength) + 1;
    if (reference !== undefined && ref !== reference[position - 1].toUpperCase()) {
      return { kind: 'invalid', reason: 'Aligned reference bases disagree with their placement.' };
    }
    consumed++;
    referencePositions.push(position);
    insertionBoundaries.push(null);
    observedColumns.push(observed);
    if (!observed || !/^[ACGTU]$/.test(ref) || (query !== '-' && !/^[ACGTU]$/.test(query))) {
      unresolved++;
    }
    if (query !== '-') {
      if (!start) start = position;
      end = position;
    }
  }
  const evidence = {
    total: referenceLength,
    unresolved,
    ambiguousInsertions,
    complete: unresolved === 0 && ambiguousInsertions === 0,
  };
  return {
    kind: 'placed',
    value: {
      circularOffset,
      referenceLength,
      referencePositions,
      insertionBoundaries,
      observedColumns,
      evidence,
      coverage: { start, end },
      completeInReferenceOrder:
        evidence.complete && circularOffset === 0 && span === referenceLength,
    },
  };
}

export function interpretReferenceAlignment(
  source: AlignmentObservationSource,
  reference: ReferenceAlignmentContext
): ReferenceAlignmentInterpretation {
  if (
    source.referenceLength !== undefined &&
    source.referenceLength !== reference.sequence.length
  ) {
    return { kind: 'invalid', reason: 'Alignment reference length does not match the reference.' };
  }
  if (source.circularOffset === undefined) {
    if (
      source.alignedReference.replace(/-/g, '').toUpperCase() !== reference.sequence.toUpperCase()
    ) {
      return { kind: 'unplaced', reason: 'This bounded alignment has no recorded placement.' };
    }
    return scanAlignment(
      source,
      reference.sequence.length,
      0,
      reference.topology,
      reference.sequence
    );
  }
  if (source.referenceLength === undefined) {
    return {
      kind: 'invalid',
      reason: 'Placed alignment is missing its original reference length.',
    };
  }
  return scanAlignment(
    source,
    source.referenceLength,
    source.circularOffset,
    reference.topology,
    reference.sequence
  );
}

export function alignmentEvidence(source: AlignmentObservationSource): AlignmentEvidence {
  const total = source.referenceLength ?? referenceSpan(source);
  const result = scanAlignment(source, total, source.circularOffset ?? 0, 'circular');
  if (result.kind !== 'placed') {
    return {
      total: Number.isInteger(total) && total > 0 ? total : 0,
      unresolved: Number.isInteger(total) && total > 0 ? total : 0,
      ambiguousInsertions: 0,
      complete: false,
    };
  }
  return {
    ...result.value.evidence,
    complete:
      (source.circularOffset === undefined) === (source.referenceLength === undefined) &&
      result.value.evidence.complete,
  };
}

function recordedObservation(
  source: AlignmentObservationSource,
  topology: ReferenceAlignmentContext['topology']
): ReferenceAlignmentInterpretation {
  if (source.referenceLength !== undefined && source.circularOffset === undefined) {
    return { kind: 'unplaced', reason: 'This bounded alignment has no recorded placement.' };
  }
  if (source.circularOffset !== undefined && source.referenceLength === undefined) {
    return {
      kind: 'invalid',
      reason: 'Placed alignment is missing its original reference length.',
    };
  }
  return scanAlignment(
    source,
    source.referenceLength ?? referenceSpan(source),
    source.circularOffset ?? 0,
    topology
  );
}

export function alignmentColumnAddress(
  source: AlignmentObservationSource,
  column: number,
  topology: ReferenceAlignmentContext['topology'] = 'linear'
): {
  referencePosition: number | null;
  insertionBoundary: number | null;
  observed: boolean;
} | null {
  if (!Number.isInteger(column) || column < 0 || column >= source.alignedReference.length) {
    return null;
  }
  const result = recordedObservation(source, topology);
  if (result.kind !== 'placed') return null;
  return {
    referencePosition: result.value.referencePositions[column],
    insertionBoundary: result.value.insertionBoundaries[column],
    observed: result.value.observedColumns[column],
  };
}

export function mutationAlignmentColumns(
  source: AlignmentObservationSource,
  mutation: AlignmentMutationAddress,
  topology: ReferenceAlignmentContext['topology'] = 'linear'
): { column: number; endColumn?: number } | null {
  const legacy = source.circularOffset === undefined && source.referenceLength === undefined;
  const result = recordedObservation(source, topology);
  if (result.kind !== 'placed' || !Number.isInteger(mutation.position) || mutation.position < 1) {
    return null;
  }
  const value = result.value;
  if (!Number.isInteger(mutation.length) || mutation.length < 1) return null;
  if (mutation.type === 'insertion') {
    const boundary =
      topology === 'circular'
        ? (mutation.position - 1) % value.referenceLength
        : mutation.position - 1;
    if (mutation.position > value.referenceLength + 1) return null;
    const groups: number[][] = [];
    for (let column = 0; column < value.insertionBoundaries.length; column++) {
      if (value.insertionBoundaries[column] !== boundary || !value.observedColumns[column])
        continue;
      const prior = groups.at(-1);
      if (prior && prior.at(-1) === column - 1) prior.push(column);
      else groups.push([column]);
    }
    const columns =
      groups.length === 1
        ? groups[0]
        : value.circularOffset === 0 && mutation.position === 1 && groups[0]?.[0] === 0
          ? groups[0]
          : value.circularOffset === 0 &&
              mutation.position === value.referenceLength + 1 &&
              groups.at(-1)?.at(-1) === source.alignedReference.length - 1
            ? groups.at(-1)
            : undefined;
    if (!columns || columns.length !== mutation.length) return null;
    return {
      column: columns[0],
      ...(columns.length > 1 ? { endColumn: columns[columns.length - 1] } : {}),
    };
  }
  const column = value.referencePositions.indexOf(mutation.position);
  if (column < 0 || (!legacy && !value.observedColumns[column])) return null;
  if (mutation.type === 'substitution') {
    if (!legacy && source.alignedQuery[column] === '-') return null;
    return { column };
  }
  const columns: number[] = [];
  for (let current = column; current < source.alignedReference.length; current++) {
    if (value.referencePositions[current] === null) break;
    if (source.alignedQuery[current] !== '-' || (!legacy && !value.observedColumns[current])) {
      break;
    }
    columns.push(current);
    if (columns.length === mutation.length) break;
  }
  if (columns.length === 0 || (!legacy && columns.length !== mutation.length)) return null;
  return {
    column,
    ...(columns.length > 1 ? { endColumn: columns[columns.length - 1] } : {}),
  };
}
