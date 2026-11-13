import type {
  EditorState,
  EditorAction,
  HistoryEntry,
  InsertedRange,
  DeletedRange,
  SubstitutedRange,
  EditorPendingPrimerBinding,
  SequenceEditorSession,
} from './editor-state-types';
import {
  adjustAnnotationsForDelete,
  adjustAnnotationsForInsert,
  IUPAC_REGEX_CLASS,
  toNucleicAcid,
  type NucleicAcid,
  type Annotation,
} from '@waypoint/sequence-utils';
export { adjustAnnotationsForDelete, adjustAnnotationsForInsert } from '@waypoint/sequence-utils';
const MAX_HISTORY_SIZE = 100;
const VALID_NUCLEOTIDE_CODES = new Set(Object.keys(IUPAC_REGEX_CLASS));
function normalizeInsertedBases(text: string, acid: NucleicAcid): string {
  return [...toNucleicAcid(text.toUpperCase(), acid)]
    .filter((base) => VALID_NUCLEOTIDE_CODES.has(base))
    .join('');
}
function adjustPendingPrimerBindingsForInsert(
  bindings: readonly EditorPendingPrimerBinding[],
  insertPos: number,
  insertLen: number
): EditorPendingPrimerBinding[] {
  return bindings.flatMap((binding) => {
    if (insertPos <= binding.start) {
      return [{ ...binding, start: binding.start + insertLen, end: binding.end + insertLen }];
    }
    if (insertPos < binding.end) return [];
    return [binding];
  });
}
export function adjustPendingPrimerBindingsForDelete(
  bindings: readonly EditorPendingPrimerBinding[],
  deleteStart: number,
  deleteEnd: number
): EditorPendingPrimerBinding[] {
  const deleteLen = deleteEnd - deleteStart;
  return bindings.flatMap((binding) => {
    if (binding.end <= deleteStart) return [binding];
    if (binding.start >= deleteEnd) {
      return [{ ...binding, start: binding.start - deleteLen, end: binding.end - deleteLen }];
    }
    return [];
  });
}
function adjustInsertedRangesForInsert(
  ranges: InsertedRange[],
  insertPos: number,
  insertLen: number
): InsertedRange[] {
  let insertionCovered = false;
  const adjusted = ranges.map((range) => {
    if (range.start > insertPos) {
      return { start: range.start + insertLen, end: range.end + insertLen };
    }
    if (range.start <= insertPos && range.end >= insertPos) {
      insertionCovered = true;
      return { start: range.start, end: range.end + insertLen };
    }
    return range;
  });
  if (!insertionCovered) {
    const newRange = { start: insertPos, end: insertPos + insertLen };
    let merged = false;
    for (let i = 0; i < adjusted.length; i++) {
      if (adjusted[i].end === newRange.start) {
        adjusted[i] = { start: adjusted[i].start, end: newRange.end };
        merged = true;
        break;
      }
      if (adjusted[i].start === newRange.end) {
        adjusted[i] = { start: newRange.start, end: adjusted[i].end };
        merged = true;
        break;
      }
    }
    if (!merged) {
      adjusted.push(newRange);
    }
  }
  return adjusted.sort((a, b) => a.start - b.start);
}
function adjustInsertedRangesForDelete(
  ranges: InsertedRange[],
  deleteStart: number,
  deleteEnd: number
): InsertedRange[] {
  const deleteLen = deleteEnd - deleteStart;
  return ranges
    .map((range) => {
      if (range.start >= deleteEnd) {
        return { start: range.start - deleteLen, end: range.end - deleteLen };
      }
      if (range.end <= deleteStart) {
        return range;
      }
      if (range.start >= deleteStart && range.end <= deleteEnd) {
        return null;
      }
      if (range.start < deleteStart && range.end > deleteStart && range.end <= deleteEnd) {
        return { start: range.start, end: deleteStart };
      }
      if (range.start >= deleteStart && range.start < deleteEnd && range.end > deleteEnd) {
        return { start: deleteStart, end: range.end - deleteLen };
      }
      if (range.start < deleteStart && range.end > deleteEnd) {
        return { start: range.start, end: range.end - deleteLen };
      }
      return range;
    })
    .filter((r): r is InsertedRange => r !== null && r.end > r.start);
}
function isPositionInInsertedRange(pos: number, ranges: InsertedRange[]): boolean {
  return ranges.some((range) => pos >= range.start && pos < range.end);
}
function isPositionInDeletedRange(pos: number, ranges: DeletedRange[]): boolean {
  return ranges.some((range) => pos >= range.start && pos < range.end);
}
function addToDeletedRanges(ranges: DeletedRange[], pos: number): DeletedRange[] {
  if (isPositionInDeletedRange(pos, ranges)) {
    return ranges;
  }
  const newRange = { start: pos, end: pos + 1 };
  const result: DeletedRange[] = [];
  let merged = false;
  for (const range of ranges) {
    if (range.end === newRange.start) {
      result.push({ start: range.start, end: newRange.end });
      merged = true;
    } else if (range.start === newRange.end) {
      result.push({ start: newRange.start, end: range.end });
      merged = true;
    } else {
      result.push(range);
    }
  }
  if (!merged) {
    result.push(newRange);
  }
  result.sort((a, b) => a.start - b.start);
  const merged_result: DeletedRange[] = [];
  for (const range of result) {
    if (merged_result.length === 0) {
      merged_result.push(range);
    } else {
      const last = merged_result[merged_result.length - 1];
      if (last.end >= range.start) {
        last.end = Math.max(last.end, range.end);
      } else {
        merged_result.push(range);
      }
    }
  }
  return merged_result;
}
function _addRangeToDeletedRanges(
  ranges: DeletedRange[],
  start: number,
  end: number
): DeletedRange[] {
  const newRange = { start, end };
  const result = [...ranges, newRange];
  result.sort((a, b) => a.start - b.start);
  const merged: DeletedRange[] = [];
  for (const range of result) {
    if (merged.length === 0) {
      merged.push({ ...range });
    } else {
      const last = merged[merged.length - 1];
      if (last.end >= range.start) {
        last.end = Math.max(last.end, range.end);
      } else {
        merged.push({ ...range });
      }
    }
  }
  return merged;
}
function adjustDeletedRangesForDelete(
  ranges: DeletedRange[],
  deleteStart: number,
  deleteEnd: number
): DeletedRange[] {
  const deleteLen = deleteEnd - deleteStart;
  return ranges
    .map((range) => {
      if (range.start >= deleteEnd) {
        return { start: range.start - deleteLen, end: range.end - deleteLen };
      }
      if (range.end <= deleteStart) {
        return range;
      }
      if (range.start >= deleteStart && range.end <= deleteEnd) {
        return null;
      }
      if (range.start < deleteStart && range.end > deleteStart && range.end <= deleteEnd) {
        return { start: range.start, end: deleteStart };
      }
      if (range.start >= deleteStart && range.start < deleteEnd && range.end > deleteEnd) {
        return { start: deleteStart, end: range.end - deleteLen };
      }
      if (range.start < deleteStart && range.end > deleteEnd) {
        return { start: range.start, end: range.end - deleteLen };
      }
      return range;
    })
    .filter((r): r is DeletedRange => r !== null && r.end > r.start);
}
function addToSubstitutedRanges(
  ranges: SubstitutedRange[],
  pos: number,
  originalChar: string
): SubstitutedRange[] {
  const result: SubstitutedRange[] = [];
  let merged = false;
  for (const range of ranges) {
    if (!merged && range.end === pos) {
      result.push({ start: range.start, end: pos + 1, original: range.original + originalChar });
      merged = true;
    } else if (!merged && range.start === pos + 1) {
      result.push({ start: pos, end: range.end, original: originalChar + range.original });
      merged = true;
    } else {
      result.push(range);
    }
  }
  if (!merged) {
    result.push({ start: pos, end: pos + 1, original: originalChar });
  }
  return result.sort((a, b) => a.start - b.start);
}
function mergeAdjacentSubstitutedRanges(ranges: SubstitutedRange[]): SubstitutedRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: SubstitutedRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous?.end === range.start) {
      previous.end = range.end;
      previous.original += range.original;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}
function adjustSubstitutedRangesForInsert(
  ranges: SubstitutedRange[],
  insertPos: number,
  insertLen: number
): SubstitutedRange[] {
  return ranges.flatMap((range) => {
    if (insertPos <= range.start) {
      return [{ ...range, start: range.start + insertLen, end: range.end + insertLen }];
    }
    if (insertPos >= range.end) return [range];
    const splitOffset = insertPos - range.start;
    return [
      {
        start: range.start,
        end: insertPos,
        original: range.original.slice(0, splitOffset),
      },
      {
        start: insertPos + insertLen,
        end: range.end + insertLen,
        original: range.original.slice(splitOffset),
      },
    ];
  });
}
function adjustSubstitutedRangesForDelete(
  ranges: SubstitutedRange[],
  deleteStart: number,
  deleteEnd: number
): SubstitutedRange[] {
  const deleteLen = deleteEnd - deleteStart;
  const adjusted = ranges.flatMap((range) => {
    if (range.end <= deleteStart) return [range];
    if (range.start >= deleteEnd) {
      return [{ ...range, start: range.start - deleteLen, end: range.end - deleteLen }];
    }
    const pieces: SubstitutedRange[] = [];
    const leftEnd = Math.min(range.end, deleteStart);
    if (range.start < leftEnd) {
      pieces.push({
        start: range.start,
        end: leftEnd,
        original: range.original.slice(0, leftEnd - range.start),
      });
    }
    const rightStart = Math.max(range.start, deleteEnd);
    if (rightStart < range.end) {
      pieces.push({
        start: rightStart - deleteLen,
        end: range.end - deleteLen,
        original: range.original.slice(rightStart - range.start),
      });
    }
    return pieces;
  });
  return mergeAdjacentSubstitutedRanges(adjusted);
}
function removeFromDeletedRanges(ranges: DeletedRange[], pos: number): DeletedRange[] {
  const result: DeletedRange[] = [];
  for (const range of ranges) {
    if (pos < range.start || pos >= range.end) {
      result.push(range);
    } else if (range.start === pos && range.end === pos + 1) {
      continue;
    } else if (range.start === pos) {
      result.push({ start: pos + 1, end: range.end });
    } else if (range.end === pos + 1) {
      result.push({ start: range.start, end: pos });
    } else {
      result.push({ start: range.start, end: pos });
      result.push({ start: pos + 1, end: range.end });
    }
  }
  return result.filter((r) => r.end > r.start);
}
export function createInitialState(
  sequence: string,
  annotations: Annotation[] = [],
  nucleicAcid: NucleicAcid = 'dna'
): EditorState {
  return {
    sequence,
    nucleicAcid,
    annotations,
    cursor: 0,
    selection: null,
    selectionAnchor: null,
    history: [
      {
        sequence,
        cursor: 0,
        annotations,
        insertedRanges: [],
        deletedRanges: [],
        substitutedRanges: [],
        pendingPrimerBindings: [],
      },
    ],
    historyIndex: 0,
    isDirty: false,
    insertedRanges: [],
    deletedRanges: [],
    substitutedRanges: [],
    pendingPrimerBindings: [],
  };
}
export function hasUncommittedSequenceEdits(
  state: Pick<EditorState, 'insertedRanges' | 'deletedRanges' | 'substitutedRanges'>
): boolean {
  return (
    state.insertedRanges.length > 0 ||
    state.deletedRanges.length > 0 ||
    state.substitutedRanges.length > 0
  );
}
function pushHistory(state: EditorState, entry: HistoryEntry): EditorState {
  const history = state.history.slice(0, state.historyIndex + 1);
  history.push(entry);
  if (history.length > MAX_HISTORY_SIZE) {
    history.shift();
  }
  return {
    ...state,
    history,
    historyIndex: history.length - 1,
  };
}
function recordReplacement(before: EditorState, after: EditorState): EditorState {
  if (before.selection?.wraps) return after;
  return pushHistory(
    { ...after, history: before.history, historyIndex: before.historyIndex },
    after.history[after.historyIndex]
  );
}
function reduceInsertAction(
  state: EditorState,
  action: Extract<
    EditorAction,
    {
      type: 'INSERT';
    }
  >,
  reduce: (state: EditorState, action: EditorAction) => EditorState
): EditorState {
  const validChars = normalizeInsertedBases(action.text, state.nucleicAcid);
  if (validChars.length === 0) return state;
  if (!state.selection && validChars.length === 1) {
    const cursorPos = state.cursor;
    if (isPositionInDeletedRange(cursorPos, state.deletedRanges)) {
      const deletedChar = state.sequence[cursorPos];
      if (deletedChar && deletedChar.toLowerCase() === validChars.toLowerCase()) {
        const newDeletedRanges = removeFromDeletedRanges(state.deletedRanges, cursorPos);
        const newCursor = cursorPos + 1;
        const newState: EditorState = {
          ...state,
          cursor: newCursor,
          selection: null,
          isDirty: true,
          deletedRanges: newDeletedRanges,
        };
        return pushHistory(newState, {
          sequence: state.sequence,
          cursor: newCursor,
          annotations: state.annotations,
          insertedRanges: state.insertedRanges,
          deletedRanges: newDeletedRanges,
          substitutedRanges: state.substitutedRanges,
          pendingPrimerBindings: state.pendingPrimerBindings,
        });
      }
      if (deletedChar) {
        const newDeletedRanges = removeFromDeletedRanges(state.deletedRanges, cursorPos);
        const newSequence =
          state.sequence.slice(0, cursorPos) + validChars + state.sequence.slice(cursorPos + 1);
        const newCursor = cursorPos + 1;
        const newSubstitutedRanges = addToSubstitutedRanges(
          state.substitutedRanges,
          cursorPos,
          deletedChar
        );
        const newState: EditorState = {
          ...state,
          sequence: newSequence,
          cursor: newCursor,
          selection: null,
          isDirty: true,
          deletedRanges: newDeletedRanges,
          substitutedRanges: newSubstitutedRanges,
        };
        return pushHistory(newState, {
          sequence: newSequence,
          cursor: newCursor,
          annotations: state.annotations,
          insertedRanges: state.insertedRanges,
          deletedRanges: newDeletedRanges,
          substitutedRanges: newSubstitutedRanges,
          pendingPrimerBindings: state.pendingPrimerBindings,
        });
      }
    }
  }
  if (state.selection) {
    const afterDelete = reduce(state, { type: 'DELETE_SELECTION' });
    return recordReplacement(state, reduce(afterDelete, { type: 'INSERT', text: validChars }));
  }
  const newDeletedRanges = state.deletedRanges.flatMap((range) => {
    if (range.start >= state.cursor) {
      return [{ start: range.start + validChars.length, end: range.end + validChars.length }];
    }
    if (range.end > state.cursor) {
      return [
        { start: range.start, end: state.cursor },
        { start: state.cursor + validChars.length, end: range.end + validChars.length },
      ];
    }
    return [range];
  });
  const newSequence =
    state.sequence.slice(0, state.cursor) + validChars + state.sequence.slice(state.cursor);
  const newCursor = state.cursor + validChars.length;
  const newAnnotations = state.annotations.flatMap((annotation) => {
    const originalSegments = annotation.segments?.length ? annotation.segments : [annotation];
    if (
      annotation.start > annotation.end ||
      !originalSegments.every((segment) =>
        state.deletedRanges.some(
          (range) => range.start <= segment.start - 1 && range.end >= segment.end
        )
      )
    )
      return adjustAnnotationsForInsert(
        [annotation],
        state.cursor,
        validChars.length,
        state.sequence.length
      );
    const segments = originalSegments.flatMap((segment) => {
      if (segment.end <= state.cursor) return [segment];
      if (segment.start > state.cursor)
        return [{ start: segment.start + validChars.length, end: segment.end + validChars.length }];
      return [
        { start: segment.start, end: state.cursor },
        { start: state.cursor + validChars.length + 1, end: segment.end + validChars.length },
      ];
    });
    if (
      segments.length === originalSegments.length &&
      segments.every((segment, index) => segment === originalSegments[index])
    )
      return [annotation];
    return adjustAnnotationsForInsert(
      [annotation],
      state.cursor,
      validChars.length,
      state.sequence.length
    ).map((adjusted) => ({
      ...adjusted,
      start: Math.min(...segments.map((segment) => segment.start)),
      end: Math.max(...segments.map((segment) => segment.end)),
      ...(annotation.segments?.length || segments.length > 1 ? { segments } : {}),
    }));
  });
  const newInsertedRanges = adjustInsertedRangesForInsert(
    state.insertedRanges,
    state.cursor,
    validChars.length
  );
  const newSubstitutedRanges = adjustSubstitutedRangesForInsert(
    state.substitutedRanges,
    state.cursor,
    validChars.length
  );
  const newPendingPrimerBindings = adjustPendingPrimerBindingsForInsert(
    state.pendingPrimerBindings,
    state.cursor,
    validChars.length
  );
  const newState: EditorState = {
    ...state,
    sequence: newSequence,
    annotations: newAnnotations,
    cursor: newCursor,
    selection: null,
    isDirty: true,
    insertedRanges: newInsertedRanges,
    deletedRanges: newDeletedRanges,
    substitutedRanges: newSubstitutedRanges,
    pendingPrimerBindings: newPendingPrimerBindings,
  };
  return pushHistory(newState, {
    sequence: newSequence,
    cursor: newCursor,
    annotations: newAnnotations,
    insertedRanges: newInsertedRanges,
    deletedRanges: newDeletedRanges,
    substitutedRanges: newSubstitutedRanges,
    pendingPrimerBindings: newPendingPrimerBindings,
  });
}
function reduceInsertFragmentAction(
  state: EditorState,
  action: Extract<
    EditorAction,
    {
      type: 'INSERT_FRAGMENT';
    }
  >,
  reduce: (state: EditorState, action: EditorAction) => EditorState
): EditorState {
  const normalizedSequence = normalizeInsertedBases(action.fragment.sequence, state.nucleicAcid);
  if (!normalizedSequence) return state;
  const afterDelete = state.selection ? reduce(state, { type: 'DELETE_SELECTION' }) : state;
  const insertionStart = afterDelete.cursor;
  const inserted = reduce(afterDelete, { type: 'INSERT', text: normalizedSequence });
  const pastedAnnotations = action.fragment.annotations.map((annotation) => {
    const qualifiers = annotation.qualifiers ? { ...annotation.qualifiers } : undefined;
    if (qualifiers) {
      delete qualifiers._locationString;
      delete qualifiers.dnaforge_ann_id;
    }
    return {
      ...annotation,
      qualifiers,
      start: annotation.start + insertionStart,
      end: annotation.end + insertionStart,
      segments: annotation.segments?.map((segment) => ({
        start: segment.start + insertionStart,
        end: segment.end + insertionStart,
      })),
    };
  });
  const pendingPrimerBindings = [
    ...inserted.pendingPrimerBindings,
    ...action.fragment.primerBindings.map((binding) => ({
      ...binding,
      pendingId: binding.pendingId ?? globalThis.crypto.randomUUID(),
      start: binding.start + insertionStart,
      end: binding.end + insertionStart,
    })),
  ];
  const annotations = [...inserted.annotations, ...pastedAnnotations];
  const history = [...inserted.history];
  history[inserted.historyIndex] = {
    ...history[inserted.historyIndex],
    annotations,
    pendingPrimerBindings,
  };
  const next = {
    ...inserted,
    annotations,
    pendingPrimerBindings,
    history,
  };
  return state.selection ? recordReplacement(state, next) : next;
}
function reduceDeleteBeforeAction(
  state: EditorState,
  reduce: (state: EditorState, action: EditorAction) => EditorState
): EditorState {
  if (state.selection) return reduce(state, { type: 'DELETE_SELECTION' });
  if (state.cursor === 0) return state;
  const deletePos = state.cursor - 1;
  if (isPositionInDeletedRange(deletePos, state.deletedRanges)) {
    return { ...state, cursor: deletePos };
  }
  if (isPositionInInsertedRange(deletePos, state.insertedRanges)) {
    const newSequence = state.sequence.slice(0, deletePos) + state.sequence.slice(state.cursor);
    const newCursor = deletePos;
    const newAnnotations = adjustAnnotationsForDelete(
      state.annotations,
      deletePos,
      state.cursor,
      state.sequence.length
    );
    const newInsertedRanges = adjustInsertedRangesForDelete(
      state.insertedRanges,
      deletePos,
      state.cursor
    );
    const newDeletedRanges = adjustDeletedRangesForDelete(
      state.deletedRanges,
      deletePos,
      state.cursor
    );
    const newSubstitutedRanges = adjustSubstitutedRangesForDelete(
      state.substitutedRanges,
      deletePos,
      state.cursor
    );
    const newPendingPrimerBindings = adjustPendingPrimerBindingsForDelete(
      state.pendingPrimerBindings,
      deletePos,
      state.cursor
    );
    const newState: EditorState = {
      ...state,
      sequence: newSequence,
      annotations: newAnnotations,
      cursor: newCursor,
      isDirty: true,
      insertedRanges: newInsertedRanges,
      deletedRanges: newDeletedRanges,
      substitutedRanges: newSubstitutedRanges,
      pendingPrimerBindings: newPendingPrimerBindings,
    };
    return pushHistory(newState, {
      sequence: newSequence,
      cursor: newCursor,
      annotations: newAnnotations,
      insertedRanges: newInsertedRanges,
      deletedRanges: newDeletedRanges,
      substitutedRanges: newSubstitutedRanges,
      pendingPrimerBindings: newPendingPrimerBindings,
    });
  }
  const newDeletedRanges = addToDeletedRanges(state.deletedRanges, deletePos);
  const newState: EditorState = {
    ...state,
    cursor: deletePos,
    isDirty: true,
    deletedRanges: newDeletedRanges,
  };
  return pushHistory(newState, {
    sequence: state.sequence,
    cursor: deletePos,
    annotations: state.annotations,
    insertedRanges: state.insertedRanges,
    deletedRanges: newDeletedRanges,
    substitutedRanges: state.substitutedRanges,
    pendingPrimerBindings: state.pendingPrimerBindings,
  });
}
function reduceDeleteAfterAction(
  state: EditorState,
  reduce: (state: EditorState, action: EditorAction) => EditorState
): EditorState {
  if (state.selection) return reduce(state, { type: 'DELETE_SELECTION' });
  if (state.cursor >= state.sequence.length) return state;
  const deletePos = state.cursor;
  if (isPositionInDeletedRange(deletePos, state.deletedRanges)) {
    return { ...state, cursor: Math.min(state.cursor + 1, state.sequence.length) };
  }
  if (isPositionInInsertedRange(deletePos, state.insertedRanges)) {
    const newSequence = state.sequence.slice(0, deletePos) + state.sequence.slice(deletePos + 1);
    const newAnnotations = adjustAnnotationsForDelete(
      state.annotations,
      deletePos,
      deletePos + 1,
      state.sequence.length
    );
    const newInsertedRanges = adjustInsertedRangesForDelete(
      state.insertedRanges,
      deletePos,
      deletePos + 1
    );
    const newDeletedRanges = adjustDeletedRangesForDelete(
      state.deletedRanges,
      deletePos,
      deletePos + 1
    );
    const newSubstitutedRanges = adjustSubstitutedRangesForDelete(
      state.substitutedRanges,
      deletePos,
      deletePos + 1
    );
    const newPendingPrimerBindings = adjustPendingPrimerBindingsForDelete(
      state.pendingPrimerBindings,
      deletePos,
      deletePos + 1
    );
    const newState: EditorState = {
      ...state,
      sequence: newSequence,
      annotations: newAnnotations,
      isDirty: true,
      insertedRanges: newInsertedRanges,
      deletedRanges: newDeletedRanges,
      substitutedRanges: newSubstitutedRanges,
      pendingPrimerBindings: newPendingPrimerBindings,
    };
    return pushHistory(newState, {
      sequence: newSequence,
      cursor: state.cursor,
      annotations: newAnnotations,
      insertedRanges: newInsertedRanges,
      deletedRanges: newDeletedRanges,
      substitutedRanges: newSubstitutedRanges,
      pendingPrimerBindings: newPendingPrimerBindings,
    });
  }
  const newDeletedRanges = addToDeletedRanges(state.deletedRanges, deletePos);
  const newState: EditorState = {
    ...state,
    isDirty: true,
    deletedRanges: newDeletedRanges,
  };
  return pushHistory(newState, {
    sequence: state.sequence,
    cursor: state.cursor,
    annotations: state.annotations,
    insertedRanges: state.insertedRanges,
    deletedRanges: newDeletedRanges,
    substitutedRanges: state.substitutedRanges,
    pendingPrimerBindings: state.pendingPrimerBindings,
  });
}
function reduceDeleteSelectionAction(state: EditorState): EditorState {
  if (!state.selection) return state;
  const ranges = state.selection.wraps
    ? [
        { start: state.selection.start, end: state.sequence.length },
        { start: 0, end: state.selection.end + 1 },
      ]
    : [
        {
          start: Math.min(state.selection.start, state.selection.end),
          end: Math.max(state.selection.start, state.selection.end) + 1,
        },
      ];
  let newCursor = ranges[0].start;
  let newSequence = state.sequence;
  let newAnnotations = state.annotations;
  let newInsertedRanges = state.insertedRanges;
  let newDeletedRanges = state.deletedRanges;
  let newSubstitutedRanges = state.substitutedRanges;
  let newPendingPrimerBindings = state.pendingPrimerBindings;
  for (const range of ranges) {
    for (let pos = range.end - 1; pos >= range.start; pos--) {
      if (isPositionInDeletedRange(pos, state.deletedRanges)) continue;
      if (isPositionInInsertedRange(pos, newInsertedRanges)) {
        newAnnotations = adjustAnnotationsForDelete(
          newAnnotations,
          pos,
          pos + 1,
          newSequence.length
        );
        newSequence = newSequence.slice(0, pos) + newSequence.slice(pos + 1);
        newInsertedRanges = adjustInsertedRangesForDelete(newInsertedRanges, pos, pos + 1);
        newDeletedRanges = adjustDeletedRangesForDelete(newDeletedRanges, pos, pos + 1);
        newSubstitutedRanges = adjustSubstitutedRangesForDelete(newSubstitutedRanges, pos, pos + 1);
        newPendingPrimerBindings = adjustPendingPrimerBindingsForDelete(
          newPendingPrimerBindings,
          pos,
          pos + 1
        );
        if (pos < newCursor) newCursor--;
      } else {
        newDeletedRanges = addToDeletedRanges(newDeletedRanges, pos);
      }
    }
  }
  const newState: EditorState = {
    ...state,
    sequence: newSequence,
    annotations: newAnnotations,
    cursor: newCursor,
    selection: null,
    isDirty: true,
    insertedRanges: newInsertedRanges,
    deletedRanges: newDeletedRanges,
    substitutedRanges: newSubstitutedRanges,
    pendingPrimerBindings: newPendingPrimerBindings,
  };
  if (newSequence !== state.sequence || newDeletedRanges !== state.deletedRanges) {
    return pushHistory(newState, {
      sequence: newSequence,
      cursor: newCursor,
      annotations: newAnnotations,
      insertedRanges: newInsertedRanges,
      deletedRanges: newDeletedRanges,
      substitutedRanges: newSubstitutedRanges,
      pendingPrimerBindings: newPendingPrimerBindings,
    });
  }
  return newState;
}
function applySoftDeletions(state: EditorState): {
  sequence: string;
  annotations: Annotation[];
  pendingPrimerBindings: EditorPendingPrimerBinding[];
  cursor: number;
} {
  let newSequence = state.sequence;
  let newAnnotations = state.annotations;
  let newCursor = state.cursor;
  let newPendingPrimerBindings = state.pendingPrimerBindings;
  const sortedDeletions = [...state.deletedRanges].sort((a, b) => b.start - a.start);
  for (const range of sortedDeletions) {
    newAnnotations = adjustAnnotationsForDelete(
      newAnnotations,
      range.start,
      range.end,
      newSequence.length
    );
    newSequence = newSequence.slice(0, range.start) + newSequence.slice(range.end);
    newPendingPrimerBindings = adjustPendingPrimerBindingsForDelete(
      newPendingPrimerBindings,
      range.start,
      range.end
    );
    if (newCursor > range.end) {
      newCursor -= range.end - range.start;
    } else if (newCursor > range.start) {
      newCursor = range.start;
    }
  }
  newCursor = Math.max(0, Math.min(newCursor, newSequence.length));
  return {
    sequence: newSequence,
    annotations: newAnnotations,
    pendingPrimerBindings: newPendingPrimerBindings,
    cursor: newCursor,
  };
}
function reduceCommitAction(state: EditorState): EditorState {
  const {
    sequence: newSequence,
    annotations: newAnnotations,
    cursor: newCursor,
  } = applySoftDeletions(state);
  return {
    ...state,
    sequence: newSequence,
    annotations: newAnnotations,
    cursor: newCursor,
    selection: null,
    history: [
      {
        sequence: newSequence,
        cursor: newCursor,
        annotations: newAnnotations,
        insertedRanges: [],
        deletedRanges: [],
        substitutedRanges: [],
        pendingPrimerBindings: [],
      },
    ],
    historyIndex: 0,
    isDirty: false,
    insertedRanges: [],
    deletedRanges: [],
    substitutedRanges: [],
    pendingPrimerBindings: [],
  };
}
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'SET_CURSOR': {
      const position = Math.max(0, Math.min(action.position, state.sequence.length));
      return {
        ...state,
        cursor: position,
        selection: null,
      };
    }
    case 'MOVE_CURSOR': {
      const newPos = Math.max(0, Math.min(state.cursor + action.delta, state.sequence.length));
      return {
        ...state,
        cursor: newPos,
        selection: null,
      };
    }
    case 'MOVE_CURSOR_LINE': {
      const currentLine = Math.floor(state.cursor / action.charsPerLine);
      const posInLine = state.cursor % action.charsPerLine;
      const newLine = currentLine + action.delta;
      const maxLine = Math.floor(state.sequence.length / action.charsPerLine);
      if (newLine < 0 || newLine > maxLine) {
        return state;
      }
      const newPos = Math.min(newLine * action.charsPerLine + posInLine, state.sequence.length);
      return {
        ...state,
        cursor: newPos,
        selection: null,
      };
    }
    case 'INSERT':
      return reduceInsertAction(state, action, editorReducer);
    case 'INSERT_FRAGMENT':
      return reduceInsertFragmentAction(state, action, editorReducer);
    case 'DELETE_BEFORE':
      return reduceDeleteBeforeAction(state, editorReducer);
    case 'DELETE_AFTER':
      return reduceDeleteAfterAction(state, editorReducer);
    case 'DELETE_SELECTION':
      return reduceDeleteSelectionAction(state);
    case 'SET_SELECTION': {
      return {
        ...state,
        selection: action.selection,
        selectionAnchor: null,
        cursor: action.selection ? action.selection.end : state.cursor,
      };
    }
    case 'EXTEND_SELECTION': {
      const anchor = state.selectionAnchor ?? state.cursor;
      const focus = action.position;
      return {
        ...state,
        selectionAnchor: anchor,
        selection: {
          start: Math.min(anchor, focus),
          end: Math.max(anchor, focus),
        },
        cursor: focus,
      };
    }
    case 'CLEAR_SELECTION_ANCHOR': {
      return { ...state, selectionAnchor: null };
    }
    case 'SELECT_ALL': {
      if (state.sequence.length === 0) return state;
      return {
        ...state,
        selection: { start: 0, end: state.sequence.length - 1 },
        cursor: state.sequence.length,
      };
    }
    case 'UNDO': {
      if (state.historyIndex <= 0) return state;
      const entry = state.history[state.historyIndex - 1];
      return {
        ...state,
        sequence: entry.sequence,
        annotations: entry.annotations,
        cursor: entry.cursor,
        selection: null,
        historyIndex: state.historyIndex - 1,
        isDirty: true,
        insertedRanges: entry.insertedRanges,
        deletedRanges: entry.deletedRanges,
        substitutedRanges: entry.substitutedRanges,
        pendingPrimerBindings: entry.pendingPrimerBindings,
      };
    }
    case 'REDO': {
      if (state.historyIndex >= state.history.length - 1) return state;
      const entry = state.history[state.historyIndex + 1];
      return {
        ...state,
        sequence: entry.sequence,
        annotations: entry.annotations,
        cursor: entry.cursor,
        selection: null,
        historyIndex: state.historyIndex + 1,
        isDirty: true,
        insertedRanges: entry.insertedRanges,
        deletedRanges: entry.deletedRanges,
        substitutedRanges: entry.substitutedRanges,
        pendingPrimerBindings: entry.pendingPrimerBindings,
      };
    }
    case 'MARK_SAVED': {
      return {
        ...state,
        isDirty: false,
      };
    }
    case 'SET_ANNOTATIONS': {
      if (action.annotations === state.annotations) return state;
      const newState: EditorState = { ...state, annotations: action.annotations, isDirty: true };
      return pushHistory(newState, {
        sequence: state.sequence,
        cursor: state.cursor,
        annotations: action.annotations,
        insertedRanges: state.insertedRanges,
        deletedRanges: state.deletedRanges,
        substitutedRanges: state.substitutedRanges,
        pendingPrimerBindings: state.pendingPrimerBindings,
      });
    }
    case 'COMMIT':
      return reduceCommitAction(state);
    case 'DISCARD': {
      if (state.history.length === 0) return state;
      const baseline = state.history[0];
      return {
        ...state,
        sequence: baseline.sequence,
        annotations: baseline.annotations,
        cursor: baseline.cursor,
        selection: null,
        history: [baseline],
        historyIndex: 0,
        isDirty: false,
        insertedRanges: [],
        deletedRanges: [],
        substitutedRanges: [],
        pendingPrimerBindings: baseline.pendingPrimerBindings,
      };
    }
    case 'RESET': {
      return createInitialState(action.sequence, action.annotations, state.nucleicAcid);
    }
    default:
      return state;
  }
}
export function cleanSequenceFromEditorState(state: EditorState): {
  sequence: string;
  annotations: Annotation[];
  pendingPrimerBindings: EditorPendingPrimerBinding[];
} {
  const { sequence, annotations, pendingPrimerBindings } = applySoftDeletions(state);
  return { sequence, annotations, pendingPrimerBindings };
}
export function createEditorSession(initial: EditorState): SequenceEditorSession {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: (action) => {
      const next = editorReducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type {
  EditorState,
  EditorAction,
  DeletedRange,
  InsertedRange,
  SubstitutedRange,
  EditorPendingPrimerBinding,
  SequenceEditorSession,
} from './editor-state-types';
