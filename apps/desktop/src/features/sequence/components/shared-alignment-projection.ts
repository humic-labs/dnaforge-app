import type { CoordinateSpace } from '@waypoint/workspace-editor';
import { interpretReferenceAlignment } from '@waypoint/sequence-utils';
import type { SharedAlignmentLane } from './shared-sequence-read-model';

export interface AlignmentProjectionTrack {
  readonly id: string;
  readonly label: string;
  readonly alignedReference: string;
  readonly alignedQuery: string;
  readonly circularOffset?: number;
  readonly referenceLength?: number;
}

export interface SharedAlignmentProjection {
  readonly coordinateSpace: CoordinateSpace;
  readonly lanes: ReadonlyArray<SharedAlignmentLane>;
  readonly selectedTrackId: string;
  projectTrackColumn(trackId: string, column: number): number | null;
}

export function buildSharedAlignmentProjection(
  reference: string,
  tracks: ReadonlyArray<AlignmentProjectionTrack>,
  selectedTrackId?: string | null,
  topology: 'linear' | 'circular' = 'linear'
): SharedAlignmentProjection | null {
  if (!reference || tracks.length === 0) return null;
  const normalizedReference = reference.toUpperCase();
  const parsed = tracks.map((track) => {
    const alignedReference = track.alignedReference.toUpperCase();
    const alignedQuery = track.alignedQuery.toUpperCase();
    const interpreted = interpretReferenceAlignment(track, { sequence: reference, topology });
    if (interpreted.kind !== 'placed') return null;
    const observation = interpreted.value;
    const insertions: Array<Array<string | null>> = Array.from(
      { length: reference.length + 1 },
      () => []
    );
    const bases: Array<string | null> = Array.from({ length: reference.length }, () => null);
    const boundaryByColumn = new Int32Array(alignedReference.length);
    const insertionIndexByColumn = new Int32Array(alignedReference.length).fill(-1);
    for (let column = 0; column < alignedReference.length; column += 1) {
      const position = observation.referencePositions[column];
      const boundary = position === null ? observation.insertionBoundaries[column]! : position - 1;
      boundaryByColumn[column] = boundary;
      const query = observation.observedColumns[column] ? alignedQuery[column] : null;
      if (position === null) {
        insertionIndexByColumn[column] = insertions[boundary].length;
        insertions[boundary].push(query);
      } else {
        bases[position - 1] = query;
      }
    }
    return { track, observation, insertions, bases, boundaryByColumn, insertionIndexByColumn };
  });
  if (parsed.some((track) => track === null)) return null;
  const rows = parsed.filter((track): track is NonNullable<typeof track> => track !== null);
  const insertionWidths = Array.from({ length: reference.length + 1 }, (_, boundary) =>
    Math.max(...rows.map((row) => row.insertions[boundary].length))
  );
  const boundaryStart = new Int32Array(reference.length + 1);
  const referenceColumns: string[] = [];
  for (let boundary = 0; boundary <= reference.length; boundary += 1) {
    boundaryStart[boundary] = referenceColumns.length;
    for (let i = 0; i < insertionWidths[boundary]; i += 1) referenceColumns.push('-');
    if (boundary < reference.length) referenceColumns.push(normalizedReference[boundary]);
  }
  const sharedReference = referenceColumns.join('');
  const lanes: SharedAlignmentLane[] = rows.map((row) => {
    const queryColumns: Array<string | null> = [];
    for (let boundary = 0; boundary <= reference.length; boundary += 1) {
      queryColumns.push(...row.insertions[boundary]);
      for (let i = row.insertions[boundary].length; i < insertionWidths[boundary]; i += 1) {
        queryColumns.push(row.observation.completeInReferenceOrder ? '-' : null);
      }
      if (boundary < reference.length) queryColumns.push(row.bases[boundary]);
    }
    return {
      id: `alignment-query-${row.track.id}`,
      kind: 'alignment',
      label: row.track.label,
      alignedReference: sharedReference,
      ...(row.observation.completeInReferenceOrder
        ? { alignedQuery: queryColumns.join('') }
        : { queryColumns }),
    };
  });
  const selected = rows.find((row) => row.track.id === selectedTrackId) ?? rows[0];
  const selectedIndex = rows.indexOf(selected);
  return {
    coordinateSpace: {
      mode: 'gapped',
      gappedSequence: sharedReference,
      ...(lanes[selectedIndex].alignedQuery !== undefined
        ? { alignedQuery: lanes[selectedIndex].alignedQuery }
        : {}),
    },
    lanes,
    selectedTrackId: selected.track.id,
    projectTrackColumn: (trackId, column) => {
      const row = rows.find((candidate) => candidate.track.id === trackId);
      if (
        !row ||
        !Number.isInteger(column) ||
        column < 0 ||
        column >= row.boundaryByColumn.length
      ) {
        return null;
      }
      const boundary = row.boundaryByColumn[column];
      const insertionIndex = row.insertionIndexByColumn[column];
      return (
        boundaryStart[boundary] + (insertionIndex >= 0 ? insertionIndex : insertionWidths[boundary])
      );
    },
  };
}
