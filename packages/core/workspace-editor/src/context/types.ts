import type { Annotation } from '@waypoint/sequence-utils';
import type { InsertedRange, DeletedRange, Selection } from '../types';

export interface DraftEdit {
  type: 'insert' | 'delete';
  position: number;
  text?: string;
  length?: number;
}

export interface SequenceState {
  baseSequence: string;
  baseAnnotations: Annotation[];

  currentSequence: string;
  insertedRanges: InsertedRange[];
  deletedRanges: DeletedRange[];
  cursor: number;
  selection: Selection | null;
  hasPendingChanges: boolean;

  adjustedAnnotations: Annotation[];

  insert: (text: string) => void;
  deleteBefore: () => void;
  deleteAfter: () => void;
  deleteSelection: () => void;
  setCursor: (position: number) => void;
  moveCursor: (delta: number) => void;
  setSelection: (selection: Selection | null) => void;
  selectAll: () => void;
  undo: () => void;
  redo: () => void;
  commit: () => void;
  discard: () => void;
  reset: (sequence: string, annotations: Annotation[]) => void;
}

export interface SequenceStateProviderProps {
  initialSequence: string;
  initialAnnotations: Annotation[];
  onSequenceChange?: (sequence: string) => void;
  onAnnotationsChange?: (annotations: Annotation[]) => void;
  onCursorChange?: (position: number) => void;
  onPendingChangesChange?: (hasPending: boolean) => void;
  onCommit?: () => void;
  onDiscard?: () => void;
  children: React.ReactNode;
}
