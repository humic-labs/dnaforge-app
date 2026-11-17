export interface GenomeComparisonReference {
  readonly id: string;
  readonly length: number;
}

export type GenomeComparisonSide = 'target' | 'query';
export type GenomeComparisonCigarCode = 'M' | '=' | 'X' | 'I' | 'D';

export interface GenomeComparisonCigarOperation {
  readonly code: GenomeComparisonCigarCode;
  readonly length: number;
}

export interface GenomeComparisonInterval {
  readonly referenceId: string;
  readonly start: number;
  readonly end: number;
}

export interface GenomeComparisonColumnSegment {
  readonly code: GenomeComparisonCigarCode;
  readonly columnStart: number;
  readonly columnEnd: number;
  readonly targetStart: number;
  readonly targetEnd: number;
  readonly queryStart: number;
  readonly queryEnd: number;
}

export interface GenomeComparisonBlock {
  readonly id: string;
  readonly target: GenomeComparisonInterval;
  readonly query: GenomeComparisonInterval;
  readonly strand: '+' | '-';
  readonly matchingBases: number;
  readonly alignmentColumns: number;
  readonly ambiguousBases: number;
  readonly mappingQuality: number;
  readonly cigar: string;
  readonly columnLength: number;
  readonly segments: readonly GenomeComparisonColumnSegment[];
}

export interface GenomeComparison {
  readonly target: GenomeComparisonReference;
  readonly query: GenomeComparisonReference;
  readonly blocks: readonly GenomeComparisonBlock[];
}

export type GenomeComparisonColumnLocus =
  | { readonly kind: 'base'; readonly referenceId: string; readonly position: number }
  | { readonly kind: 'gap'; readonly referenceId: string; readonly boundary: number };

export type GenomeComparisonLayoutEntry =
  | {
      readonly kind: 'block';
      readonly block: GenomeComparisonBlock;
      readonly columnStart: number;
      readonly columnEnd: number;
    }
  | {
      readonly kind: 'unaligned-join';
      readonly previousBlockId: string;
      readonly nextBlockId: string;
      readonly columnStart: number;
      readonly columnEnd: number;
      readonly targetGap: Readonly<{ start: number; end: number }> | null;
      readonly queryGap: Readonly<{ start: number; end: number }> | null;
      readonly reason: 'unaligned' | 'overlap' | 'rearrangement';
    };

export interface GenomeComparisonLayout {
  readonly entries: readonly GenomeComparisonLayoutEntry[];
  readonly columnLength: number;
}

const MAX_PAF_CHARACTERS = 32 * 1024 * 1024;
const MAX_PAF_ROWS = 100_000;
const MAX_CIGAR_OPERATIONS = 1_000_000;

function integer(value: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`Invalid ${label}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${label}.`);
  return parsed;
}

function reference(value: GenomeComparisonReference): void {
  if (!value.id || /\s/u.test(value.id)) throw new Error('A comparison reference needs an exact ID.');
  if (!Number.isSafeInteger(value.length) || value.length < 1)
    throw new Error('A comparison reference needs a positive length.');
}

export function parseGenomeComparisonCigar(cigar: string): readonly GenomeComparisonCigarOperation[] {
  if (!cigar) throw new Error('A base-aligned comparison needs a CIGAR.');
  const operations: GenomeComparisonCigarOperation[] = [];
  let cursor = 0;
  while (cursor < cigar.length) {
    const start = cursor;
    const first = cigar.charCodeAt(cursor);
    if (first < 49 || first > 57) throw new Error('Unsupported or malformed comparison CIGAR.');
    cursor++;
    while (cursor < cigar.length) {
      const digit = cigar.charCodeAt(cursor);
      if (digit < 48 || digit > 57) break;
      cursor++;
    }
    const code = cigar[cursor];
    if (code === undefined || !'M=XID'.includes(code))
      throw new Error('Unsupported or malformed comparison CIGAR.');
    const length = integer(cigar.slice(start, cursor), 'CIGAR length');
    operations.push({ code: code as GenomeComparisonCigarCode, length });
    if (operations.length > MAX_CIGAR_OPERATIONS) throw new Error('Comparison CIGAR is too large.');
    cursor++;
  }
  return operations;
}

export function createGenomeComparisonBlock(input: {
  readonly id: string;
  readonly target: GenomeComparisonInterval;
  readonly query: GenomeComparisonInterval;
  readonly strand: '+' | '-';
  readonly matchingBases: number;
  readonly alignmentColumns: number;
  readonly ambiguousBases?: number;
  readonly mappingQuality: number;
  readonly cigar: string;
}): GenomeComparisonBlock {
  const ambiguousBases = input.ambiguousBases ?? 0;
  for (const interval of [input.target, input.query]) {
    if (
      !interval.referenceId ||
      !Number.isSafeInteger(interval.start) ||
      !Number.isSafeInteger(interval.end) ||
      interval.start < 0 ||
      interval.end <= interval.start
    )
      throw new Error('Comparison blocks need nonempty half-open biological intervals.');
  }
  if (!input.id || (input.strand !== '+' && input.strand !== '-'))
    throw new Error('Comparison blocks need an ID and an explicit strand.');
  if (
    !Number.isSafeInteger(input.matchingBases) ||
    !Number.isSafeInteger(input.alignmentColumns) ||
    input.matchingBases < 0 ||
    input.alignmentColumns < 1 ||
    input.matchingBases > input.alignmentColumns ||
    !Number.isSafeInteger(ambiguousBases) ||
    ambiguousBases < 0 ||
    !Number.isSafeInteger(input.mappingQuality) ||
    input.mappingQuality < 0 ||
    input.mappingQuality > 255
  )
    throw new Error('Comparison alignment statistics are invalid.');
  let column = 0;
  let target = input.target.start;
  let query = input.strand === '+' ? input.query.start : input.query.end;
  const segments = parseGenomeComparisonCigar(input.cigar).map((operation) => {
    const targetEnd = target + (operation.code === 'I' ? 0 : operation.length);
    const queryEnd =
      query + (operation.code === 'D' ? 0 : operation.length * (input.strand === '+' ? 1 : -1));
    const nextColumn = column + operation.length;
    if (![targetEnd, queryEnd, nextColumn].every(Number.isSafeInteger))
      throw new Error('Comparison CIGAR exceeds supported coordinates.');
    const segment = {
      code: operation.code,
      columnStart: column,
      columnEnd: nextColumn,
      targetStart: target,
      targetEnd,
      queryStart: Math.min(query, queryEnd),
      queryEnd: Math.max(query, queryEnd),
    };
    target = targetEnd;
    query = queryEnd;
    column = nextColumn;
    return segment;
  });
  if (
    target !== input.target.end ||
    query !== (input.strand === '+' ? input.query.end : input.query.start) ||
    column !== input.alignmentColumns + ambiguousBases
  )
    throw new Error('Comparison CIGAR does not consume its exact PAF intervals and alignment columns.');
  return { ...input, ambiguousBases, columnLength: column, segments };
}

export function parseGenomeComparisonPaf(
  text: string,
  options: {
    readonly target: GenomeComparisonReference;
    readonly query: GenomeComparisonReference;
    readonly minimumAlignmentColumns?: number;
    readonly primaryOnly?: boolean;
  }
): GenomeComparison {
  reference(options.target);
  reference(options.query);
  if (text.length > MAX_PAF_CHARACTERS) throw new Error('Comparison PAF exceeds its size bound.');
  const minimum = options.minimumAlignmentColumns ?? 0;
  if (!Number.isSafeInteger(minimum) || minimum < 0)
    throw new Error('Minimum alignment columns must be a nonnegative integer.');
  const lines = text.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length > MAX_PAF_ROWS) throw new Error('Comparison PAF has too many rows.');
  const blocks: GenomeComparisonBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const fields = lines[index].split('\t');
    if (fields.length < 12) throw new Error(`Comparison PAF row ${index + 1} is incomplete.`);
    const queryLength = integer(fields[1], 'query length');
    const targetLength = integer(fields[6], 'target length');
    if (
      fields[0] !== options.query.id ||
      fields[5] !== options.target.id ||
      queryLength !== options.query.length ||
      targetLength !== options.target.length
    )
      throw new Error(`Comparison PAF row ${index + 1} belongs to another reference.`);
    const queryStart = integer(fields[2], 'query start');
    const queryEnd = integer(fields[3], 'query end');
    const targetStart = integer(fields[7], 'target start');
    const targetEnd = integer(fields[8], 'target end');
    if (queryEnd > queryLength || targetEnd > targetLength)
      throw new Error(`Comparison PAF row ${index + 1} exceeds its reference.`);
    const alignmentColumns = integer(fields[10], 'alignment columns');
    const tags = fields.slice(12);
    if (options.primaryOnly !== false && tags.includes('tp:A:S')) continue;
    const cigars = tags.filter((tag) => tag.startsWith('cg:Z:'));
    if (cigars.length !== 1)
      throw new Error(`Comparison PAF row ${index + 1} needs one exact cg CIGAR tag.`);
    const ambiguousTags = tags.filter((tag) => tag.startsWith('nn:i:'));
    if (ambiguousTags.length > 1) throw new Error('Comparison PAF has duplicate ambiguity counts.');
    const block = createGenomeComparisonBlock({
      id: `paf-${index + 1}`,
      target: { referenceId: fields[5], start: targetStart, end: targetEnd },
      query: { referenceId: fields[0], start: queryStart, end: queryEnd },
      strand: fields[4] as '+' | '-',
      matchingBases: integer(fields[9], 'matching bases'),
      alignmentColumns,
      ambiguousBases: ambiguousTags.length ? integer(ambiguousTags[0].slice(5), 'ambiguous base count') : 0,
      mappingQuality: integer(fields[11], 'mapping quality'),
      cigar: cigars[0].slice(5),
    });
    if (alignmentColumns >= minimum) blocks.push(block);
  }
  return { target: options.target, query: options.query, blocks };
}

export function alignmentColumnToLocus(
  block: GenomeComparisonBlock,
  side: GenomeComparisonSide,
  column: number
): GenomeComparisonColumnLocus | null {
  if (!Number.isSafeInteger(column) || column < 0 || column >= block.columnLength) return null;
  let low = 0;
  let high = block.segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const segment = block.segments[middle];
    if (column < segment.columnStart) high = middle - 1;
    else if (column >= segment.columnEnd) low = middle + 1;
    else {
      const interval = block[side];
      const start = side === 'target' ? segment.targetStart : segment.queryStart;
      const end = side === 'target' ? segment.targetEnd : segment.queryEnd;
      if (start === end) return { kind: 'gap', referenceId: interval.referenceId, boundary: start };
      const offset = column - segment.columnStart;
      return {
        kind: 'base',
        referenceId: interval.referenceId,
        position: side === 'query' && block.strand === '-' ? end - 1 - offset : start + offset,
      };
    }
  }
  return null;
}

export function alignmentLocusToColumn(
  block: GenomeComparisonBlock,
  side: GenomeComparisonSide,
  position: number
): number | null {
  const interval = block[side];
  if (!Number.isSafeInteger(position) || position < interval.start || position >= interval.end)
    return null;
  for (const segment of block.segments) {
    const start = side === 'target' ? segment.targetStart : segment.queryStart;
    const end = side === 'target' ? segment.targetEnd : segment.queryEnd;
    if (position >= start && position < end)
      return (
        segment.columnStart +
        (side === 'query' && block.strand === '-' ? end - 1 - position : position - start)
      );
  }
  return null;
}

export function buildGenomeComparisonLayout(
  blocks: readonly GenomeComparisonBlock[],
  joinWidth = 32
): GenomeComparisonLayout {
  if (!Number.isSafeInteger(joinWidth) || joinWidth < 1)
    throw new Error('Unaligned comparison joins need a positive display width.');
  const ids = new Set<string>();
  for (const block of blocks) {
    if (ids.has(block.id)) throw new Error('Comparison block IDs must be unique.');
    ids.add(block.id);
    if (
      block.target.referenceId !== blocks[0].target.referenceId ||
      block.query.referenceId !== blocks[0].query.referenceId
    )
      throw new Error('A comparison layout cannot mix reference pairs.');
  }
  const ordered = [...blocks].sort(
    (a, b) => a.target.start - b.target.start || a.target.end - b.target.end || a.id.localeCompare(b.id)
  );
  const entries: GenomeComparisonLayoutEntry[] = [];
  let column = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const block = ordered[index];
    const previous = ordered[index - 1];
    if (previous) {
      const targetGap =
        previous.target.end < block.target.start
          ? { start: previous.target.end, end: block.target.start }
          : null;
      const queryGap =
        previous.strand === block.strand &&
        (block.strand === '+'
          ? previous.query.end < block.query.start
          : block.query.end < previous.query.start)
          ? block.strand === '+'
            ? { start: previous.query.end, end: block.query.start }
            : { start: block.query.end, end: previous.query.start }
          : null;
      const targetOverlaps = previous.target.end > block.target.start;
      const collinear =
        previous.strand === block.strand &&
        (block.strand === '+'
          ? previous.query.end <= block.query.start
          : block.query.end <= previous.query.start);
      entries.push({
        kind: 'unaligned-join',
        previousBlockId: previous.id,
        nextBlockId: block.id,
        columnStart: column,
        columnEnd: column + joinWidth,
        targetGap,
        queryGap,
        reason: targetOverlaps ? 'overlap' : collinear ? 'unaligned' : 'rearrangement',
      });
      column += joinWidth;
    }
    if (!Number.isSafeInteger(column + block.columnLength))
      throw new Error('Comparison layout exceeds supported display columns.');
    entries.push({ kind: 'block', block, columnStart: column, columnEnd: column + block.columnLength });
    column += block.columnLength;
  }
  return { entries, columnLength: column };
}
