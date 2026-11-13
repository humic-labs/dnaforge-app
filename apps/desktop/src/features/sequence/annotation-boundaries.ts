export type ViewerSelectionRange = { start: number; end: number; wraps?: boolean };
export type AnnotationBoundaryRange = { start: number; end: number };

export function viewerSelectionForAnnotationBoundaryState(
  selection: ViewerSelectionRange | null | undefined
): ViewerSelectionRange | null {
  if (!selection) return null;
  return {
    start: selection.start,
    end: selection.end,
    ...(selection.wraps ? { wraps: true } : {}),
  };
}

export function selectionToAnnotationBoundaryRange(
  selection: ViewerSelectionRange | null | undefined
): AnnotationBoundaryRange | null {
  if (!selection || selection.wraps) return null;
  return {
    start: Math.min(selection.start, selection.end) + 1,
    end: Math.max(selection.start, selection.end) + 1,
  };
}

export function selectionToAskAiRange(
  selection: ViewerSelectionRange | null | undefined
): ViewerSelectionRange | null {
  if (!selection) return null;
  if (selection.wraps) {
    return { start: selection.start + 1, end: selection.end + 1, wraps: true };
  }
  return {
    start: Math.min(selection.start, selection.end) + 1,
    end: Math.max(selection.start, selection.end) + 1,
  };
}
