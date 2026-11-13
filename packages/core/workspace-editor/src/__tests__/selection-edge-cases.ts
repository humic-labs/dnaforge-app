export interface SelectionState {
  start: number;
  end: number;
  wraps?: boolean;
}

export interface ScrollState {
  cumulativeDelta: number;
  crossedOriginForward: boolean;
  crossedOriginBackward: boolean;
}

export interface SelectionTestCase {
  id: string;
  description: string;
  category: string;

  initialSelection: SelectionState | null;
  viewCursor?: number | null;
  scrollState: ScrollState;

  action:
    | { type: 'shift-click'; position: number }
    | { type: 'shift-click-annotation'; annStart: number; annEnd: number }
    | { type: 'handle-drag'; edge: 'start' | 'end'; newPosition: number };

  expected: SelectionState;

  notes?: string;
}

export const SEQUENCE_LENGTH = 10000;

export const SELECTION_TEST_CASES: SelectionTestCase[] = [
  {
    id: 'simple-extend-right',
    description: 'Simple extension to the right (no scroll)',
    category: 'simple',
    initialSelection: { start: 5000, end: 5500 },
    scrollState: { cumulativeDelta: 0, crossedOriginForward: false, crossedOriginBackward: false },
    action: { type: 'shift-click', position: 6000 },
    expected: { start: 5000, end: 6000 },
  },
  {
    id: 'simple-extend-left',
    description: 'Simple extension to the left (no scroll)',
    category: 'simple',
    initialSelection: { start: 5000, end: 5500 },
    scrollState: { cumulativeDelta: 0, crossedOriginForward: false, crossedOriginBackward: false },
    action: { type: 'shift-click', position: 4500 },
    expected: { start: 4500, end: 5500 },
  },

  {
    id: 'long-arc-forward-no-origin',
    description: 'Long arc (>50%) forward WITHOUT crossing origin',
    category: 'long-arc',
    initialSelection: { start: 1000, end: 2000 },
    scrollState: {
      cumulativeDelta: 5000,
      crossedOriginForward: false,
      crossedOriginBackward: false,
    },
    action: { type: 'shift-click', position: 8000 },
    expected: { start: 1000, end: 8000 },
    notes: 'Scrolled forward a lot but never crossed origin - use direct path',
  },
  {
    id: 'long-arc-backward-no-origin',
    description: 'Long arc (>50%) backward WITHOUT crossing origin',
    category: 'long-arc',
    initialSelection: { start: 8000, end: 9000 },
    scrollState: {
      cumulativeDelta: -6000,
      crossedOriginForward: false,
      crossedOriginBackward: false,
    },
    action: { type: 'shift-click', position: 2000 },
    expected: { start: 2000, end: 9000 },
    notes: 'Scrolled backward a lot but never crossed origin - use direct path',
  },

  {
    id: 'forward-through-origin',
    description: 'Extend forward through origin (short arc)',
    category: 'origin-crossing',
    initialSelection: { start: 9500, end: 9800 },
    scrollState: {
      cumulativeDelta: 1000,
      crossedOriginForward: true,
      crossedOriginBackward: false,
    },
    action: { type: 'shift-click', position: 200 },
    expected: { start: 9500, end: 200, wraps: true },
    notes: 'Selection goes 9500 -> end -> 0 -> 200',
  },
  {
    id: 'backward-through-origin',
    description: 'Extend backward through origin (short arc)',
    category: 'origin-crossing',
    initialSelection: { start: 100, end: 200 },
    scrollState: {
      cumulativeDelta: -2000,
      crossedOriginForward: false,
      crossedOriginBackward: true,
    },
    action: { type: 'shift-click', position: 9500 },
    expected: { start: 9500, end: 200, wraps: true },
    notes: 'Selection goes 9500 -> end -> 0 -> 200',
  },

  {
    id: 'extend-wrapping-forward',
    description: 'Continue extending a wrapping selection forward',
    category: 'extend-wrapping',
    initialSelection: { start: 9000, end: 500, wraps: true },
    scrollState: {
      cumulativeDelta: 2000,
      crossedOriginForward: true,
      crossedOriginBackward: false,
    },
    action: { type: 'shift-click', position: 1000 },
    expected: { start: 9000, end: 1000, wraps: true },
    notes: 'Selection was 9000->end->0->500, now extends to 9000->end->0->1000',
  },
  {
    id: 'extend-wrapping-backward',
    description: 'Extend wrapping selection backward (expand start)',
    category: 'extend-wrapping',
    initialSelection: { start: 9000, end: 500, wraps: true },
    scrollState: {
      cumulativeDelta: -1500,
      crossedOriginForward: false,
      crossedOriginBackward: false,
    },
    action: { type: 'shift-click', position: 8000 },
    expected: { start: 8000, end: 500, wraps: true },
    notes: 'Selection was 9000->end->0->500, now extends to 8000->end->0->500',
  },

  {
    id: 'contradictory-forward-click-behind',
    description: 'Scrolled forward but click is behind selection',
    category: 'contradictory',
    initialSelection: { start: 5000, end: 5500 },
    scrollState: {
      cumulativeDelta: 3000,
      crossedOriginForward: false,
      crossedOriginBackward: false,
    },
    action: { type: 'shift-click', position: 3000 },
    expected: { start: 3000, end: 5500 },
    notes: 'No origin crossing, so fall back to shorter arc (backward extension)',
  },
  {
    id: 'contradictory-backward-click-ahead',
    description: 'Scrolled backward but click is ahead of selection',
    category: 'contradictory',
    initialSelection: { start: 5000, end: 5500 },
    scrollState: {
      cumulativeDelta: -2000,
      crossedOriginForward: false,
      crossedOriginBackward: false,
    },
    action: { type: 'shift-click', position: 7000 },
    expected: { start: 5000, end: 7000 },
    notes: 'No origin crossing, so fall back to shorter arc (forward extension)',
  },

  {
    id: 'annotation-simple-right',
    description: 'Shift-click annotation to the right',
    category: 'annotation',
    initialSelection: { start: 1000, end: 2000 },
    scrollState: { cumulativeDelta: 0, crossedOriginForward: false, crossedOriginBackward: false },
    action: { type: 'shift-click-annotation', annStart: 3000, annEnd: 3500 },
    expected: { start: 1000, end: 3500 },
    notes: 'Should include original selection AND full annotation',
  },
  {
    id: 'annotation-simple-left',
    description: 'Shift-click annotation to the left',
    category: 'annotation',
    initialSelection: { start: 5000, end: 6000 },
    scrollState: { cumulativeDelta: 0, crossedOriginForward: false, crossedOriginBackward: false },
    action: { type: 'shift-click-annotation', annStart: 3000, annEnd: 3500 },
    expected: { start: 3000, end: 6000 },
    notes: 'Should include full annotation AND original selection',
  },
  {
    id: 'annotation-across-origin-forward',
    description: 'Shift-click annotation after scrolling forward through origin',
    category: 'annotation',
    initialSelection: { start: 9500, end: 9800 },
    scrollState: {
      cumulativeDelta: 1500,
      crossedOriginForward: true,
      crossedOriginBackward: false,
    },
    action: { type: 'shift-click-annotation', annStart: 200, annEnd: 400 },
    expected: { start: 9500, end: 400, wraps: true },
    notes: 'Wrapping selection that includes annotation at far end',
  },
  {
    id: 'annotation-across-origin-backward',
    description: 'Shift-click annotation after scrolling backward through origin',
    category: 'annotation',
    initialSelection: { start: 200, end: 500 },
    scrollState: {
      cumulativeDelta: -2000,
      crossedOriginForward: false,
      crossedOriginBackward: true,
    },
    action: { type: 'shift-click-annotation', annStart: 9500, annEnd: 9700 },
    expected: { start: 9500, end: 500, wraps: true },
    notes: 'Wrapping selection that includes annotation at start',
  },
  {
    id: 'annotation-no-create-over-100-percent',
    description: 'Annotation shift-click should NOT create >100% selection',
    category: 'annotation',
    initialSelection: { start: 500, end: 1000 },
    scrollState: {
      cumulativeDelta: -2000,
      crossedOriginForward: false,
      crossedOriginBackward: true,
    },
    action: { type: 'shift-click-annotation', annStart: 9500, annEnd: 9700 },
    expected: { start: 9500, end: 1000, wraps: true },
    notes: 'CRITICAL: Must NOT expand both ends and create overlapping selection',
  },

  {
    id: 'handle-drag-end-simple',
    description: 'Drag end handle to extend selection',
    category: 'handle-drag',
    initialSelection: { start: 1000, end: 2000 },
    scrollState: { cumulativeDelta: 0, crossedOriginForward: false, crossedOriginBackward: false },
    action: { type: 'handle-drag', edge: 'end', newPosition: 3000 },
    expected: { start: 1000, end: 3000 },
  },
  {
    id: 'handle-drag-start-simple',
    description: 'Drag start handle to extend selection',
    category: 'handle-drag',
    initialSelection: { start: 2000, end: 3000 },
    scrollState: { cumulativeDelta: 0, crossedOriginForward: false, crossedOriginBackward: false },
    action: { type: 'handle-drag', edge: 'start', newPosition: 1000 },
    expected: { start: 1000, end: 3000 },
  },
  {
    id: 'handle-drag-create-wrap',
    description: 'Drag handle to create wrapping selection',
    category: 'handle-drag',
    initialSelection: { start: 9000, end: 9500 },
    scrollState: { cumulativeDelta: 0, crossedOriginForward: false, crossedOriginBackward: false },
    action: { type: 'handle-drag', edge: 'end', newPosition: 500 },
    expected: { start: 9000, end: 500, wraps: true },
    notes: 'Dragging end past origin creates wrapping selection',
  },
  {
    id: 'handle-drag-preserve-wrap',
    description: 'Drag handle on wrapping selection should preserve wrap',
    category: 'handle-drag',
    initialSelection: { start: 9000, end: 500, wraps: true },
    scrollState: { cumulativeDelta: 0, crossedOriginForward: false, crossedOriginBackward: false },
    action: { type: 'handle-drag', edge: 'end', newPosition: 1000 },
    expected: { start: 9000, end: 1000, wraps: true },
    notes: 'Wrapping selection stays wrapping when extending end',
  },
  {
    id: 'handle-drag-wrapping-shrink-start',
    description: 'Shrink wrapping selection by dragging start',
    category: 'handle-drag',
    initialSelection: { start: 8000, end: 500, wraps: true },
    scrollState: { cumulativeDelta: 0, crossedOriginForward: false, crossedOriginBackward: false },
    action: { type: 'handle-drag', edge: 'start', newPosition: 9500 },
    expected: { start: 9500, end: 500, wraps: true },
    notes: 'Moving start forward shrinks the wrapping selection',
  },
  {
    id: 'handle-drag-unwrap',
    description: 'Drag handle to unwrap selection',
    category: 'handle-drag',
    initialSelection: { start: 9500, end: 500, wraps: true },
    scrollState: { cumulativeDelta: 0, crossedOriginForward: false, crossedOriginBackward: false },
    action: { type: 'handle-drag', edge: 'start', newPosition: 200 },
    expected: { start: 200, end: 500 },
    notes: 'Moving start past end unwraps to non-wrapping selection',
  },

  {
    id: 'from-cursor-simple',
    description: 'Shift-click from cursor position',
    category: 'from-cursor',
    initialSelection: null,
    viewCursor: 5000,
    scrollState: { cumulativeDelta: 0, crossedOriginForward: false, crossedOriginBackward: false },
    action: { type: 'shift-click', position: 6000 },
    expected: { start: 5000, end: 6000 },
  },
  {
    id: 'from-cursor-annotation',
    description: 'Shift-click annotation from cursor position',
    category: 'from-cursor',
    initialSelection: null,
    viewCursor: 5000,
    scrollState: { cumulativeDelta: 0, crossedOriginForward: false, crossedOriginBackward: false },
    action: { type: 'shift-click-annotation', annStart: 6000, annEnd: 6500 },
    expected: { start: 5000, end: 6500 },
    notes: 'Should extend from cursor to include full annotation',
  },

  {
    id: 'sequential-extend-1',
    description: 'First of sequential shift-clicks',
    category: 'sequential',
    initialSelection: { start: 5000, end: 5500 },
    scrollState: {
      cumulativeDelta: 500,
      crossedOriginForward: false,
      crossedOriginBackward: false,
    },
    action: { type: 'shift-click', position: 6000 },
    expected: { start: 5000, end: 6000 },
  },
  {
    id: 'sequential-extend-2',
    description: 'Second of sequential shift-clicks (continuing)',
    category: 'sequential',
    initialSelection: { start: 5000, end: 6000 },
    scrollState: {
      cumulativeDelta: 1500,
      crossedOriginForward: false,
      crossedOriginBackward: false,
    },
    action: { type: 'shift-click', position: 7000 },
    expected: { start: 5000, end: 7000 },
  },

  {
    id: 'annotation-spanning-selection-end',
    description: 'Annotation that spans the end of current selection',
    category: 'annotation-boundary',
    initialSelection: { start: 4000, end: 5000 },
    scrollState: { cumulativeDelta: 0, crossedOriginForward: false, crossedOriginBackward: false },
    action: { type: 'shift-click-annotation', annStart: 4800, annEnd: 5200 },
    expected: { start: 4000, end: 5200 },
    notes: 'Should extend to include full annotation even though it overlaps',
  },
  {
    id: 'annotation-inside-selection',
    description: 'Annotation entirely inside current selection',
    category: 'annotation-boundary',
    initialSelection: { start: 4000, end: 6000 },
    scrollState: { cumulativeDelta: 0, crossedOriginForward: false, crossedOriginBackward: false },
    action: { type: 'shift-click-annotation', annStart: 4500, annEnd: 5500 },
    expected: { start: 4000, end: 6000 },
    notes: 'Selection should remain unchanged (annotation already included)',
  },
];

export function validateSelection(
  actual: SelectionState | null,
  expected: SelectionState,
  testId: string
): { pass: boolean; message: string } {
  if (!actual) {
    return { pass: false, message: `${testId}: Expected selection but got null` };
  }

  if (actual.start !== expected.start) {
    return {
      pass: false,
      message: `${testId}: start mismatch - expected ${expected.start}, got ${actual.start}`,
    };
  }

  if (actual.end !== expected.end) {
    return {
      pass: false,
      message: `${testId}: end mismatch - expected ${expected.end}, got ${actual.end}`,
    };
  }

  const actualWraps = actual.wraps ?? false;
  const expectedWraps = expected.wraps ?? false;
  if (actualWraps !== expectedWraps) {
    return {
      pass: false,
      message: `${testId}: wraps mismatch - expected ${expectedWraps}, got ${actualWraps}`,
    };
  }

  return { pass: true, message: `${testId}: PASS` };
}

export function getSelectionLength(sel: SelectionState, seqLen: number): number {
  if (sel.wraps) {
    return seqLen - sel.start + (sel.end + 1);
  } else {
    return sel.end - sel.start + 1;
  }
}

export function validateNotOver100Percent(
  sel: SelectionState,
  seqLen: number,
  testId: string
): { pass: boolean; message: string } {
  const length = getSelectionLength(sel, seqLen);
  if (length > seqLen) {
    return {
      pass: false,
      message: `${testId}: Selection exceeds 100% - length ${length} > seqLen ${seqLen}`,
    };
  }
  return { pass: true, message: `${testId}: Selection length OK (${length}/${seqLen})` };
}
