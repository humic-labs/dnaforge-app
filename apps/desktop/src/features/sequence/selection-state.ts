export type SelectionRange = {
  start: number;
  end: number;
  wraps?: boolean;
};

export type SelectionState =
  | { kind: 'none' }
  | { kind: 'cursor'; position: number }
  | ({ kind: 'range' } & SelectionRange);

export type SelectionAction =
  | { type: 'clear' }
  | { type: 'clearCursor' }
  | { type: 'clearRange' }
  | { type: 'setCursor'; position: number }
  | { type: 'setRange'; range: SelectionRange };

export const NONE: SelectionState = { kind: 'none' };

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'clear':
      return state.kind === 'none' ? state : NONE;
    case 'clearCursor':
      return state.kind === 'cursor' ? NONE : state;
    case 'clearRange':
      return state.kind === 'range' ? NONE : state;
    case 'setCursor':
      return { kind: 'cursor', position: action.position };
    case 'setRange':
      return {
        kind: 'range',
        start: action.range.start,
        end: action.range.end,
        wraps: action.range.wraps,
      };
  }
}

export function getCursor(state: SelectionState): number | null {
  return state.kind === 'cursor' ? state.position : null;
}

export function getRange(state: SelectionState): SelectionRange | null {
  if (state.kind !== 'range') return null;
  return { start: state.start, end: state.end, wraps: state.wraps };
}
