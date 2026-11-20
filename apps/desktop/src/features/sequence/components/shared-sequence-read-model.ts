import type { Genome } from '@waypoint/genome-renderer';
import { reverseComplement, type TraceData } from '@waypoint/sequence-utils';
import type { CoordinateSpace } from '@waypoint/workspace-editor';
import type { SequenceViewProjection } from '../view-state/sequence-view-projection';
import { reverseComplementTrace, detectMixedCall, validateTraceQuality } from '../../trace/public';
import type { ChromatogramLaneOptions } from '../tracks/chromatogram-lane';

export interface SharedSequenceAxis {
  readonly length: number;
  readonly biologicalLength: number;
  bioToColumn(position: number): number | null;
  columnToBio(column: number): number | null;
}

export interface SharedAlignmentLane {
  readonly id: string;
  readonly kind: 'alignment';
  readonly label: string;
  readonly alignedReference: string;
  readonly alignedQuery: string;
  readonly sanger?: ChromatogramLaneOptions;
}

export interface SharedSangerLane {
  readonly id: string;
  readonly kind: 'sanger';
  readonly label: string;
  readonly trace: TraceData;
  readonly sequence: string;
  readonly quality?: ReadonlyArray<number>;
  readonly baseToColumn: ReadonlyArray<number>;
  readonly mutationColumns: ReadonlyArray<number>;
  readonly deletionColumns: ReadonlyArray<number>;
  readonly cycleLength?: number;
  readonly sourcePeakPositions?: ReadonlyArray<number>;
  readonly sourceBaseIndices?: ReadonlyArray<number>;
  readonly mixedCalls?: ReadonlyMap<number, string>;
}

export type SharedSequenceReadLane = SharedAlignmentLane | SharedSangerLane;

export interface SharedSequenceReadScene {
  readonly coordinateSpace?: CoordinateSpace;
  readonly inputColumnToDisplayColumn?: (column: number) => number;
  readonly genome: Genome;
  readonly axis: SharedSequenceAxis;
  readonly lanes: ReadonlyArray<SharedSequenceReadLane>;
}

export interface SharedSequenceReadSceneInput {
  readonly genome: Genome;
  readonly documentId: string;
  readonly coordinateSpace?: CoordinateSpace;
  readonly viewProjection?: SequenceViewProjection;
  readonly alignmentLanes?: ReadonlyArray<SharedAlignmentLane>;
  readonly directRead?: {
    readonly sourcePeakPositions?: ReadonlyArray<number>;
    readonly trace: TraceData;
    readonly sequence: string;
    readonly quality?: ReadonlyArray<number>;
  };
  readonly attachedReads?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly laneOptions: ChromatogramLaneOptions;
  }>;
}

export function buildSharedSequenceAxis(
  sequence: string,
  coordinateSpace?: CoordinateSpace
): SharedSequenceAxis {
  const biologicalLength = sequence.length;
  if (coordinateSpace?.mode !== 'gapped') {
    return {
      length: biologicalLength,
      biologicalLength,
      bioToColumn: (position) =>
        Number.isInteger(position) && position >= 0 && position < biologicalLength
          ? position
          : null,
      columnToBio: (column) =>
        Number.isInteger(column) && column >= 0 && column < biologicalLength ? column : null,
    };
  }

  const reference = coordinateSpace.gappedSequence;
  const query = coordinateSpace.alignedQuery;
  if (!reference || !query || reference.length !== query.length) {
    throw new Error('Alignment reference and query must have matching nonempty columns');
  }
  if (reference.replace(/-/g, '').toUpperCase() !== sequence.toUpperCase()) {
    throw new Error('Alignment reference does not match the open reference sequence');
  }

  const bioToColumn = new Int32Array(biologicalLength);
  const columnToBio = new Int32Array(reference.length).fill(-1);
  let bioPosition = 0;
  for (let column = 0; column < reference.length; column += 1) {
    if (reference[column] === '-') continue;
    bioToColumn[bioPosition] = column;
    columnToBio[column] = bioPosition;
    bioPosition += 1;
  }

  return {
    length: reference.length,
    biologicalLength,
    bioToColumn: (position) =>
      Number.isInteger(position) && position >= 0 && position < biologicalLength
        ? bioToColumn[position]
        : null,
    columnToBio: (column) =>
      Number.isInteger(column) && column >= 0 && column < reference.length
        ? columnToBio[column] < 0
          ? null
          : columnToBio[column]
        : null,
  };
}

function projectFeatureIntervals(
  intervals: ReadonlyArray<{ start: number; end: number }> | undefined,
  axis: SharedSequenceAxis
): Array<{ start: number; end: number }> | undefined {
  return intervals?.flatMap((interval) => {
    const start = axis.bioToColumn(interval.start - 1);
    const last = axis.bioToColumn(interval.end - 1);
    return start === null || last === null ? [] : [{ start: start + 1, end: last + 1 }];
  });
}

function requireAlignmentColumns(value: string | undefined): string {
  if (!value) throw new Error('Alignment reference and query must have matching nonempty columns');
  return value;
}

function remapVirtualColumn(column: number, axis: SharedSequenceAxis): number {
  if (axis.length === axis.biologicalLength) return column;
  const cycle = Math.floor(column / axis.biologicalLength);
  const biologicalPosition =
    ((column % axis.biologicalLength) + axis.biologicalLength) % axis.biologicalLength;
  const mapped = axis.bioToColumn(biologicalPosition);
  if (mapped === null) {
    throw new Error(`Read column ${column} is outside the reference`);
  }
  return cycle * axis.length + mapped;
}

function sangerLane(
  id: string,
  label: string,
  options: ChromatogramLaneOptions,
  axis: SharedSequenceAxis
): SharedSangerLane {
  const peakCount = options.trace.peakPositions.length;
  const sequence = options.sequence ?? '';
  const sourceColumns = options.baseToColumn ?? Array.from({ length: peakCount }, (_, i) => i);
  if (sourceColumns.length !== peakCount || (sequence && sequence.length !== peakCount)) {
    throw new Error(`Sanger read ${label} has inconsistent called-base and peak counts`);
  }
  validateTraceQuality(options.quality, peakCount);
  const mixedCalls = new Map<number, string>();
  options.trace.peakPositions.forEach((sample, index) => {
    const call = detectMixedCall(options.trace.channels, sample, options.iupacThreshold);
    if (call.iupacCode !== call.dominant) mixedCalls.set(index, call.iupacCode);
    else if (/^[NRYSWKMBDHV]$/i.test(sequence[index] ?? ''))
      mixedCalls.set(index, sequence[index].toUpperCase());
  });
  const projectedColumns = sourceColumns.map((column) => remapVirtualColumn(column, axis));
  for (const { peak, boundary, index } of options.insertionPeaks ?? []) {
    const length = axis.biologicalLength;
    const turn = options.cycleLength ? Math.floor(boundary / length) : 0;
    const canonical = boundary - turn * length;
    const previous = canonical === 0 ? -1 : axis.bioToColumn(canonical - 1);
    if (previous === null) throw new Error('Inserted peak has no reference boundary.');
    projectedColumns[peak] = turn * axis.length + previous + 1 + index;
  }
  return {
    id,
    kind: 'sanger',
    label,
    trace: options.trace,
    sequence,
    quality: options.quality,
    baseToColumn: projectedColumns,
    mixedCalls,
    sourceBaseIndices: options.sourceBaseIndices,
    sourcePeakPositions: options.sourcePeakPositions ?? options.trace.peakPositions,
    mutationColumns: (options.mutationColumns ?? []).map((column) =>
      remapVirtualColumn(column, axis)
    ),
    deletionColumns: (options.deletionColumns ?? []).map((column) =>
      remapVirtualColumn(column, axis)
    ),
    cycleLength: options.cycleLength ? axis.length : undefined,
  };
}

function orientAttachment(
  options: ChromatogramLaneOptions,
  view?: SequenceViewProjection
): ChromatogramLaneOptions {
  if (!view || view.isIdentity || !options.baseToColumn?.length) return options;
  const reverse = view.orientation === 'reverse-complement';
  const length = view.sourceLength;
  const canonicalBase = (base: number) =>
    view.sourceIndexToView(((base % length) + length) % length);
  const boundaryAt = (boundary: number) => {
    if (!view.circular && boundary === length) return reverse ? 0 : length;
    const next = canonicalBase(boundary);
    return reverse ? (view.circular ? (next + 1) % length : next + 1) : next;
  };
  const sourceColumns = options.baseToColumn;
  const indices = sourceColumns.map((_, index) => index);
  if (reverse) indices.reverse();
  const insertions = new Map(
    options.insertionPeaks?.map((insertion) => [insertion.peak, insertion])
  );
  const insertionPeaks: NonNullable<ChromatogramLaneOptions['insertionPeaks']>[number][] = [];
  let turn = 0;
  let previous = -1;
  let lastInsertionBoundary = -1;
  let insertionIndex = 0;
  const baseToColumn = indices.map((sourcePeak, peak) => {
    const insertion = insertions.get(sourcePeak);
    const position = insertion
      ? boundaryAt(insertion.boundary)
      : canonicalBase(sourceColumns[sourcePeak]);
    if (position < previous) turn += length;
    previous = position;
    const column = position + turn;
    if (insertion) {
      if (lastInsertionBoundary !== column) insertionIndex = 0;
      insertionPeaks.push({ peak, boundary: column, index: insertionIndex++ });
      lastInsertionBoundary = column;
    }
    return column;
  });
  return {
    ...options,
    baseToColumn,
    insertionPeaks,
    trace: reverse ? reverseComplementTrace(options.trace) : options.trace,
    sequence: reverse && options.sequence ? reverseComplement(options.sequence) : options.sequence,
    quality: reverse ? options.quality?.slice().reverse() : options.quality,
    sourcePeakPositions: indices.map(
      (i) => options.sourcePeakPositions?.[i] ?? options.trace.peakPositions[i]
    ),
    sourceBaseIndices: indices.map((i) => options.sourceBaseIndices?.[i] ?? i),
    mutationColumns: options.mutationColumns?.map(canonicalBase),
    deletionColumns: options.deletionColumns?.map(canonicalBase),
    cycleLength: turn ? length : undefined,
  };
}

function includeInsertionColumns(
  reference: string,
  space: CoordinateSpace | undefined,
  lanes: readonly SharedAlignmentLane[] | undefined,
  reads: readonly ChromatogramLaneOptions[]
) {
  const source = space?.mode === 'gapped' ? space.gappedSequence : reference;
  if (!source || !reads.some((read) => read.insertionPeaks?.length)) return { space, lanes };
  const widths = new Map<number, number>();
  for (const read of reads) {
    for (const insertion of read.insertionPeaks ?? []) {
      const boundary = read.cycleLength
        ? insertion.boundary % reference.length
        : insertion.boundary;
      widths.set(boundary, Math.max(widths.get(boundary) ?? 0, insertion.index + 1));
    }
  }
  const additional = new Map<number, number>();
  let boundary = 0;
  let gaps = 0;
  for (let column = 0; column <= source.length; column++) {
    if (source[column] === '-') {
      gaps++;
      continue;
    }
    const count = (widths.get(boundary) ?? 0) - gaps;
    if (count > 0) additional.set(column, count);
    boundary++;
    gaps = 0;
  }
  if (!additional.size) return { space, lanes };
  const expand = (row: string) =>
    Array.from(row, (base, i) => '-'.repeat(additional.get(i) ?? 0) + base).join('') +
    '-'.repeat(additional.get(source.length) ?? 0);
  const alignedReference = expand(source);
  const inputColumns = new Int32Array(source.length);
  let offset = 0;
  for (let column = 0; column < source.length; column++) {
    offset += additional.get(column) ?? 0;
    inputColumns[column] = column + offset;
  }
  return {
    inputColumnToDisplayColumn: (column: number) => inputColumns[column] ?? column,
    space: {
      mode: 'gapped' as const,
      gappedSequence: alignedReference,
      alignedQuery: expand(space?.alignedQuery ?? reference),
    },
    lanes: (
      lanes ??
      (space?.mode === 'gapped'
        ? [
            {
              id: 'alignment-query',
              kind: 'alignment' as const,
              label: 'Aligned query',
              alignedReference: source,
              alignedQuery: space.alignedQuery!,
            },
          ]
        : [])
    ).map((lane) => ({ ...lane, alignedReference, alignedQuery: expand(lane.alignedQuery) })),
  };
}

export function buildSharedSequenceReadScene(
  input: SharedSequenceReadSceneInput
): SharedSequenceReadScene {
  const {
    genome,
    documentId,
    coordinateSpace: inputSpace,
    alignmentLanes: inputLanes,
    directRead,
    attachedReads: attachments = [],
  } = input;
  if (!genome.sequence || genome.sequence.length !== genome.length) {
    throw new Error('Shared read viewer requires a complete ordinary reference sequence');
  }
  const attachedReads = attachments.map((read) => ({
    ...read,
    laneOptions: orientAttachment(read.laneOptions, input.viewProjection),
  }));
  const {
    space: coordinateSpace,
    lanes: alignmentLanes,
    inputColumnToDisplayColumn,
  } = includeInsertionColumns(
    genome.sequence,
    inputSpace,
    inputLanes,
    attachedReads.map((read) => read.laneOptions)
  );
  const axis = buildSharedSequenceAxis(genome.sequence, coordinateSpace);
  const alignmentSpace = coordinateSpace?.mode === 'gapped' ? coordinateSpace : null;
  const gappedReference = alignmentSpace
    ? requireAlignmentColumns(alignmentSpace.gappedSequence)
    : null;
  const gappedQuery = alignmentSpace ? requireAlignmentColumns(alignmentSpace.alignedQuery) : null;
  const displayedGenome: Genome = {
    ...genome,
    sourceIdentity: documentId,
    length: axis.length,
    circular: gappedReference ? false : genome.circular,
    sequence: gappedReference ?? genome.sequence,
    ...(gappedReference
      ? {
          formatRulerLabel: (column: number) => {
            const base = axis.columnToBio(column);
            return base === null ? null : String(base + 1);
          },
        }
      : {}),
    features: gappedReference
      ? genome.features?.flatMap((feature) => {
          const start = axis.bioToColumn(feature.start);
          const last = axis.bioToColumn(feature.end - 1);
          return start === null || last === null
            ? []
            : [
                {
                  ...feature,
                  start,
                  end: last + 1,
                  segments: projectFeatureIntervals(feature.segments, axis),
                  exons: projectFeatureIntervals(feature.exons, axis),
                  cds: projectFeatureIntervals(feature.cds, axis),
                },
              ];
        })
      : genome.features,
  };
  const lanes: SharedSequenceReadLane[] = [];
  if (gappedReference && gappedQuery) {
    const visibleAlignmentLanes = alignmentLanes ?? [
      {
        id: `alignment-query-${documentId}`,
        kind: 'alignment' as const,
        label: 'Aligned query',
        alignedReference: gappedReference,
        alignedQuery: gappedQuery,
      },
    ];
    for (const lane of visibleAlignmentLanes) {
      if (lane.alignedReference !== gappedReference || lane.alignedQuery.length !== axis.length) {
        throw new Error(`Alignment row ${lane.label} does not match the shared reference columns`);
      }
    }
    lanes.push(...visibleAlignmentLanes);
    for (const lane of alignmentLanes ?? []) {
      if (lane.sanger) lanes.push(sangerLane(`sanger-${lane.id}`, lane.label, lane.sanger, axis));
    }
  }
  if (directRead) {
    lanes.push(
      sangerLane(
        `sanger-direct-${documentId}`,
        'Sanger trace',
        {
          ...directRead,
          sourceBaseIndices:
            input.viewProjection && !input.viewProjection.isIdentity
              ? directRead.trace.peakPositions.map((_, index) =>
                  input.viewProjection!.viewIndexToSource(index)
                )
              : undefined,
        },
        axis
      )
    );
  }
  for (const read of attachedReads) {
    lanes.push(sangerLane(`sanger-attached-${read.id}`, read.label, read.laneOptions, axis));
  }
  return { genome: displayedGenome, axis, lanes, coordinateSpace, inputColumnToDisplayColumn };
}
