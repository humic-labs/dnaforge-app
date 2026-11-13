export interface SequenceEditMarkerRange {
  start: number;
  end: number;
}

export interface SequenceEditSubstitutionRange extends SequenceEditMarkerRange {
  original: string;
}

export type SequenceEditTransitionOperation =
  | { kind: 'insert'; at: number; length: number }
  | { kind: 'delete'; start: number; end: number }
  | { kind: 'substitute'; start: number; end: number };

export interface SequenceEditTransition {
  beforeLength: number;
  afterLength: number;
  operations: SequenceEditTransitionOperation[];
}

export interface DeriveSequenceEditTransitionInput {
  baselineSequence: string;
  draftSequence: string;
  cleanSequence: string;
  insertedRanges: readonly SequenceEditMarkerRange[];
  deletedRanges: readonly SequenceEditMarkerRange[];
  substitutedRanges: readonly SequenceEditSubstitutionRange[];
}

export class SequenceEditTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SequenceEditTransitionError';
  }
}

export function deriveSequenceEditTransition(
  input: DeriveSequenceEditTransitionInput
): SequenceEditTransition {
  const { baselineSequence, draftSequence, cleanSequence } = input;
  validateRanges('inserted', input.insertedRanges, draftSequence.length);
  validateRanges('deleted', input.deletedRanges, draftSequence.length);
  validateSubstitutionRanges(input.substitutedRanges, draftSequence.length);

  const operations: SequenceEditTransitionOperation[] = [];
  let insertedIndex = 0;
  let deletedIndex = 0;
  let substitutedIndex = 0;
  let baselinePosition = 0;
  let cleanPosition = 0;

  for (let draftPosition = 0; draftPosition < draftSequence.length; draftPosition += 1) {
    insertedIndex = advancePastPosition(input.insertedRanges, insertedIndex, draftPosition);
    deletedIndex = advancePastPosition(input.deletedRanges, deletedIndex, draftPosition);
    substitutedIndex = advancePastPosition(
      input.substitutedRanges,
      substitutedIndex,
      draftPosition
    );

    const inserted = rangeAt(input.insertedRanges, insertedIndex, draftPosition);
    const deleted = rangeAt(input.deletedRanges, deletedIndex, draftPosition);
    const substituted = rangeAt(input.substitutedRanges, substitutedIndex, draftPosition);

    if (inserted) {
      if (deleted || substituted) {
        throw new SequenceEditTransitionError(
          `Inserted marker overlap at draft coordinate ${draftPosition}.`
        );
      }
      assertCleanCharacter(draftSequence, draftPosition, cleanSequence, cleanPosition);
      appendInsert(operations, baselinePosition);
      cleanPosition += 1;
      continue;
    }

    if (baselinePosition >= baselineSequence.length) {
      throw new SequenceEditTransitionError(
        `Baseline mismatch at draft coordinate ${draftPosition}: unmarked draft content remains.`
      );
    }

    const expectedBaselineCharacter = substituted
      ? substituted.original[draftPosition - substituted.start]
      : draftSequence[draftPosition];
    if (baselineSequence[baselinePosition] !== expectedBaselineCharacter) {
      throw new SequenceEditTransitionError(
        `Baseline mismatch at baseline coordinate ${baselinePosition}.`
      );
    }

    if (deleted) {
      appendBaselineOperation(operations, 'delete', baselinePosition);
    } else {
      assertCleanCharacter(draftSequence, draftPosition, cleanSequence, cleanPosition);
      cleanPosition += 1;
      if (substituted) {
        appendBaselineOperation(operations, 'substitute', baselinePosition);
      }
    }
    baselinePosition += 1;
  }

  if (baselinePosition !== baselineSequence.length) {
    throw new SequenceEditTransitionError(
      `Baseline mismatch: replay consumed ${baselinePosition} of ${baselineSequence.length} characters.`
    );
  }
  if (cleanPosition !== cleanSequence.length) {
    throw new SequenceEditTransitionError(
      `Clean sequence mismatch: replay produced ${cleanPosition} of ${cleanSequence.length} characters.`
    );
  }

  return {
    beforeLength: baselineSequence.length,
    afterLength: cleanSequence.length,
    operations,
  };
}

function validateRanges(
  label: string,
  ranges: readonly SequenceEditMarkerRange[],
  draftLength: number
): void {
  let previousEnd = 0;
  for (const [index, range] of ranges.entries()) {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end <= range.start ||
      range.end > draftLength
    ) {
      throw new SequenceEditTransitionError(
        `${capitalize(label)} marker ${index} is outside draft bounds.`
      );
    }
    if (index > 0 && range.start < previousEnd) {
      throw new SequenceEditTransitionError(
        `${capitalize(label)} markers are not in canonical order or overlap.`
      );
    }
    previousEnd = range.end;
  }
}

function validateSubstitutionRanges(
  ranges: readonly SequenceEditSubstitutionRange[],
  draftLength: number
): void {
  validateRanges('substituted', ranges, draftLength);
  for (const [index, range] of ranges.entries()) {
    if (typeof range.original !== 'string' || range.original.length !== range.end - range.start) {
      throw new SequenceEditTransitionError(
        `Substituted marker ${index} has an invalid retained-original length.`
      );
    }
  }
}

function advancePastPosition(
  ranges: readonly SequenceEditMarkerRange[],
  index: number,
  position: number
): number {
  let nextIndex = index;
  while (ranges[nextIndex] && ranges[nextIndex].end <= position) nextIndex += 1;
  return nextIndex;
}

function rangeAt<T extends SequenceEditMarkerRange>(
  ranges: readonly T[],
  index: number,
  position: number
): T | undefined {
  const range = ranges[index];
  return range && range.start <= position && position < range.end ? range : undefined;
}

function assertCleanCharacter(
  draftSequence: string,
  draftPosition: number,
  cleanSequence: string,
  cleanPosition: number
): void {
  if (draftSequence[draftPosition] !== cleanSequence[cleanPosition]) {
    throw new SequenceEditTransitionError(
      `Clean sequence mismatch at output coordinate ${cleanPosition}.`
    );
  }
}

function appendInsert(operations: SequenceEditTransitionOperation[], at: number): void {
  const previous = operations[operations.length - 1];
  if (previous?.kind === 'insert' && previous.at === at) {
    previous.length += 1;
    return;
  }
  operations.push({ kind: 'insert', at, length: 1 });
}

function appendBaselineOperation(
  operations: SequenceEditTransitionOperation[],
  kind: 'delete' | 'substitute',
  position: number
): void {
  const previous = operations[operations.length - 1];
  if (previous?.kind === kind && previous.end === position) {
    previous.end += 1;
    return;
  }
  operations.push({ kind, start: position, end: position + 1 });
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}
