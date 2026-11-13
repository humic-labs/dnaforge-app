import type { SharedAlignmentProjection } from './shared-alignment-projection';
import type { SharedSequenceAxis } from './shared-sequence-read-model';
import {
  primaryBiologicalSelectionForColumns,
  type PrimarySequenceSelection,
} from './shared-sequence-read-selection';

export interface AlignmentMutationFocus {
  documentId: string;
  trackId?: string;
  position: number;
  highlightRange?: PrimarySequenceSelection;
  timestamp: number;
}

export interface SharedSequenceColumnNavigation {
  column: number;
  requestId: number;
  selection?: PrimarySequenceSelection;
  biologicalSelection?: PrimarySequenceSelection | null;
}

export function resolveAlignmentMutationNavigation(
  focus: AlignmentMutationFocus | null,
  documentId: string,
  projection: SharedAlignmentProjection | null,
  axis: SharedSequenceAxis
): {
  columnNavigation: SharedSequenceColumnNavigation;
  highlightRange: PrimarySequenceSelection | null;
  position: number;
} | null {
  if (!focus || focus.documentId !== documentId || !projection) return null;
  const trackId = focus.trackId ?? projection.selectedTrackId;
  const column = projection.projectTrackColumn(trackId, focus.position - 1);
  if (column === null) return null;
  let selection: PrimarySequenceSelection | undefined;
  if (focus.highlightRange) {
    const start = projection.projectTrackColumn(trackId, focus.highlightRange.start);
    const end = projection.projectTrackColumn(trackId, focus.highlightRange.end);
    if (start === null || end === null || start > end) return null;
    selection = { start, end };
  }
  const highlightRange = selection ? primaryBiologicalSelectionForColumns(axis, selection) : null;
  const preceding = primaryBiologicalSelectionForColumns(axis, { start: 0, end: column });
  return {
    columnNavigation: {
      column,
      requestId: focus.timestamp,
      selection,
      biologicalSelection: highlightRange,
    },
    highlightRange,
    position: preceding ? preceding.end + 1 : 1,
  };
}
