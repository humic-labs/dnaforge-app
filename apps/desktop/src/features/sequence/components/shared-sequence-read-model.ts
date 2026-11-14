import type { Genome } from '@waypoint/genome-renderer';
import type { TraceData } from '@waypoint/sequence-utils';
import type { CoordinateSpace } from '@waypoint/workspace-editor';
import { validateTraceQuality } from '../../trace/public';
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
}

export type SharedSequenceReadLane = SharedAlignmentLane | SharedSangerLane;

export interface SharedSequenceReadScene {
  readonly genome: Genome;
  readonly axis: SharedSequenceAxis;
  readonly lanes: ReadonlyArray<SharedSequenceReadLane>;
}

export interface SharedSequenceReadSceneInput {
  readonly genome: Genome;
  readonly documentId: string;
  readonly coordinateSpace?: CoordinateSpace;
  readonly alignmentLanes?: ReadonlyArray<SharedAlignmentLane>;
  readonly directRead?: {
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
  return {
    id,
    kind: 'sanger',
    label,
    trace: options.trace,
    sequence,
    quality: options.quality,
    baseToColumn: sourceColumns.map((column) => remapVirtualColumn(column, axis)),
    mutationColumns: (options.mutationColumns ?? []).map((column) =>
      remapVirtualColumn(column, axis)
    ),
    deletionColumns: (options.deletionColumns ?? []).map((column) =>
      remapVirtualColumn(column, axis)
    ),
    cycleLength: options.cycleLength ? axis.length : undefined,
  };
}

export function buildSharedSequenceReadScene(
  input: SharedSequenceReadSceneInput
): SharedSequenceReadScene {
  const {
    genome,
    documentId,
    coordinateSpace,
    alignmentLanes,
    directRead,
    attachedReads = [],
  } = input;
  if (!genome.sequence || genome.sequence.length !== genome.length) {
    throw new Error('Shared read viewer requires a complete ordinary reference sequence');
  }
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
  }
  if (directRead) {
    lanes.push(
      sangerLane(
        `sanger-direct-${documentId}`,
        'Sanger trace',
        { trace: directRead.trace, sequence: directRead.sequence, quality: directRead.quality },
        axis
      )
    );
  }
  for (const read of attachedReads) {
    lanes.push(sangerLane(`sanger-attached-${read.id}`, read.label, read.laneOptions, axis));
  }
  return { genome: displayedGenome, axis, lanes };
}
