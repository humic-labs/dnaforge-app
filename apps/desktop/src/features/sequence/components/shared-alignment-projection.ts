import type { CoordinateSpace } from '@waypoint/workspace-editor';
import type { SharedAlignmentLane } from './shared-sequence-read-model';

export interface AlignmentProjectionTrack {
  readonly id: string;
  readonly label: string;
  readonly alignedReference: string;
  readonly alignedQuery: string;
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
  selectedTrackId?: string | null
): SharedAlignmentProjection | null {
  if (!reference || tracks.length === 0) return null;
  const normalizedReference = reference.toUpperCase();
  const parsed = tracks.map((track) => {
    const alignedReference = track.alignedReference.toUpperCase();
    const alignedQuery = track.alignedQuery.toUpperCase();
    if (
      alignedReference.length !== alignedQuery.length ||
      alignedReference.replace(/-/g, '') !== normalizedReference
    ) {
      return null;
    }
    const insertions: string[][] = Array.from({ length: reference.length + 1 }, () => []);
    const bases: string[] = [];
    const boundaryByColumn = new Int32Array(alignedReference.length);
    const insertionIndexByColumn = new Int32Array(alignedReference.length).fill(-1);
    let boundary = 0;
    for (let column = 0; column < alignedReference.length; column += 1) {
      boundaryByColumn[column] = boundary;
      if (alignedReference[column] === '-') {
        insertionIndexByColumn[column] = insertions[boundary].length;
        insertions[boundary].push(alignedQuery[column]);
      } else {
        bases.push(alignedQuery[column]);
        boundary += 1;
      }
    }
    return { track, insertions, bases, boundaryByColumn, insertionIndexByColumn };
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
    const queryColumns: string[] = [];
    for (let boundary = 0; boundary <= reference.length; boundary += 1) {
      queryColumns.push(...row.insertions[boundary]);
      for (let i = row.insertions[boundary].length; i < insertionWidths[boundary]; i += 1) {
        queryColumns.push('-');
      }
      if (boundary < reference.length) queryColumns.push(row.bases[boundary]);
    }
    return {
      id: `alignment-query-${row.track.id}`,
      kind: 'alignment',
      label: row.track.label,
      alignedReference: sharedReference,
      alignedQuery: queryColumns.join(''),
    };
  });
  const selected = rows.find((row) => row.track.id === selectedTrackId) ?? rows[0];
  const selectedIndex = rows.indexOf(selected);
  return {
    coordinateSpace: {
      mode: 'gapped',
      gappedSequence: sharedReference,
      alignedQuery: lanes[selectedIndex].alignedQuery,
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
