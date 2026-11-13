import type { Annotation, NucleicAcid } from '@waypoint/sequence-utils';
export interface Selection {
  start: number;

  end: number;

  wraps?: boolean;
}

export interface HistoryEntry {
  sequence: string;

  cursor: number;

  annotations: Annotation[];

  insertedRanges: InsertedRange[];

  deletedRanges: DeletedRange[];

  substitutedRanges: SubstitutedRange[];
  pendingPrimerBindings: EditorPendingPrimerBinding[];
}

export interface EditorPastePrimerBinding {
  pendingId?: string;
  primerId: string;

  start: number;
  end: number;
  strand: 1 | -1;

  sourceWorkspaceRoot?: string;
}

export interface EditorPendingPrimerBinding extends EditorPastePrimerBinding {
  pendingId: string;
}

export interface EditorPasteFragment {
  sequence: string;

  annotations: Annotation[];

  primerBindings: EditorPastePrimerBinding[];
}

export interface InsertedRange {
  start: number;
  end: number;
}

export interface DeletedRange {
  start: number;
  end: number;
}

export interface SubstitutedRange {
  start: number;
  end: number;

  original: string;
}

export interface EditorState {
  sequence: string;
  nucleicAcid: NucleicAcid;

  annotations: Annotation[];

  cursor: number;

  selection: Selection | null;

  selectionAnchor: number | null;

  history: HistoryEntry[];

  historyIndex: number;

  isDirty: boolean;

  insertedRanges: InsertedRange[];

  deletedRanges: DeletedRange[];

  substitutedRanges: SubstitutedRange[];
  pendingPrimerBindings: EditorPendingPrimerBinding[];
}

export type EditorAction =
  | { type: 'SET_CURSOR'; position: number }
  | { type: 'MOVE_CURSOR'; delta: number }
  | { type: 'MOVE_CURSOR_LINE'; delta: number; charsPerLine: number }
  | { type: 'INSERT'; text: string }
  | { type: 'INSERT_FRAGMENT'; fragment: EditorPasteFragment }
  | { type: 'DELETE_BEFORE' }
  | { type: 'DELETE_AFTER' }
  | { type: 'DELETE_SELECTION' }
  | { type: 'SET_SELECTION'; selection: Selection | null }
  | { type: 'EXTEND_SELECTION'; position: number }
  | { type: 'CLEAR_SELECTION_ANCHOR' }
  | { type: 'SELECT_ALL' }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'MARK_SAVED' }
  | { type: 'SET_ANNOTATIONS'; annotations: Annotation[] }
  | { type: 'COMMIT' }
  | { type: 'DISCARD' }
  | { type: 'RESET'; sequence: string; annotations: Annotation[] };

export interface SequenceEditorSession {
  getState: () => EditorState;
  dispatch: (action: EditorAction) => void;
  subscribe: (listener: () => void) => () => void;
}
