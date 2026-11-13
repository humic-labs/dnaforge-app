import type { AssemblyWorkbenchEditableField } from '../AssemblyWorkbenchContract';
import {
  resolveEditableFieldCommand,
  type EditableFieldCommandResolveOptions,
  type EditableFieldCommandResolveResult,
} from '../editable-field-command';

export interface SourceRegisterGestureState {
  kind: 'source-register';
  status: 'active' | 'cancelled' | 'committed';
  field: AssemblyWorkbenchEditableField;
  pointerId: number | null;
  startClientX: number;
  latestClientX: number;
  startValue: number;
  latestValue: number;
  renderedValue: number;
  visualOffsetPx: number;
  pxPerBase: number;
  moveCount: number;
}

export interface SourceRegisterGestureUpdate {
  state: SourceRegisterGestureState;
  visualOffsetChanged: boolean;
  snappedValueChanged: boolean;
}

export type SourceRegisterGestureCommitResult =
  | {
      status: 'committed';
      state: SourceRegisterGestureState;
      field: AssemblyWorkbenchEditableField;
      value: number;
      command: Extract<EditableFieldCommandResolveResult, { status: 'resolved' }>['command'];
    }
  | {
      status: 'rejected';
      state: SourceRegisterGestureState;
      field: AssemblyWorkbenchEditableField;
      value: number;
      reason: Extract<EditableFieldCommandResolveResult, { status: 'rejected' }>['reason'];
      message: string;
    };

export function beginSourceRegisterGesture(input: {
  field: AssemblyWorkbenchEditableField;
  pointerId: number | null;
  startClientX: number;
  pxPerBase: number;
}): SourceRegisterGestureState {
  assertSourceRegisterField(input.field);
  const startValue = numericBpValue(input.field);
  return {
    kind: 'source-register',
    status: 'active',
    field: input.field,
    pointerId: input.pointerId,
    startClientX: input.startClientX,
    latestClientX: input.startClientX,
    startValue,
    latestValue: startValue,
    renderedValue: startValue,
    visualOffsetPx: 0,
    pxPerBase: normalizePxPerBase(input.pxPerBase),
    moveCount: 0,
  };
}

export function updateSourceRegisterGesture(
  state: SourceRegisterGestureState,
  clientX: number
): SourceRegisterGestureUpdate {
  assertActiveGesture(state);
  const visualOffsetPx = clampVisualOffsetPx(state, clientX - state.startClientX);
  const latestValue = valueForVisualOffset(state, visualOffsetPx);
  return {
    state: {
      ...state,
      latestClientX: clientX,
      latestValue,
      visualOffsetPx,
      moveCount: state.moveCount + 1,
    },
    visualOffsetChanged: visualOffsetPx !== state.visualOffsetPx,
    snappedValueChanged: latestValue !== state.latestValue,
  };
}

export function cancelSourceRegisterGesture(
  state: SourceRegisterGestureState
): SourceRegisterGestureState {
  return {
    ...state,
    status: 'cancelled',
    latestClientX: state.startClientX,
    latestValue: state.startValue,
    renderedValue: state.startValue,
    visualOffsetPx: 0,
  };
}

export function updateSourceRegisterRenderedValue(
  state: SourceRegisterGestureState,
  renderedValue: number
): SourceRegisterGestureState {
  const nextRenderedValue = clampEditableBpValue(state.field, renderedValue);
  if (nextRenderedValue === state.renderedValue) return state;
  return {
    ...state,
    renderedValue: nextRenderedValue,
  };
}

export function sourceRegisterPresentationOffsetPx(state: SourceRegisterGestureState): number {
  const renderedOffsetPx = (state.startValue - state.renderedValue) * state.pxPerBase;
  return state.visualOffsetPx - renderedOffsetPx;
}

export function commitSourceRegisterGesture(
  state: SourceRegisterGestureState,
  options: EditableFieldCommandResolveOptions = {}
): SourceRegisterGestureCommitResult {
  const committedState: SourceRegisterGestureState = {
    ...state,
    status: 'committed',
  };
  const resolved = resolveEditableFieldCommand(state.field, state.latestValue, options);
  if (resolved.status === 'rejected') {
    return {
      status: 'rejected',
      state: committedState,
      field: state.field,
      value: state.latestValue,
      reason: resolved.reason,
      message: resolved.message,
    };
  }
  return {
    status: 'committed',
    state: committedState,
    field: state.field,
    value: resolved.value as number,
    command: resolved.command,
  };
}

export function valueForVisualOffset(
  state: Pick<SourceRegisterGestureState, 'field' | 'startValue' | 'pxPerBase'>,
  visualOffsetPx: number
): number {
  const nextValue = state.startValue - visualOffsetPx / state.pxPerBase;
  return clampEditableBpValue(state.field, nextValue);
}

function assertSourceRegisterField(field: AssemblyWorkbenchEditableField): void {
  if (field.kind !== 'sourceContributionBoundary') {
    throw new Error(`Editable field ${field.id} is not a source contribution boundary.`);
  }
  if (field.units !== 'bp' || typeof field.value !== 'number') {
    throw new Error(`Editable field ${field.id} is not a numeric bp source boundary.`);
  }
}

function assertActiveGesture(state: SourceRegisterGestureState): void {
  if (state.status !== 'active') {
    throw new Error(`Source register gesture is not active: ${state.status}.`);
  }
}

function numericBpValue(field: AssemblyWorkbenchEditableField): number {
  if (field.units !== 'bp' || typeof field.value !== 'number') {
    throw new Error(`Editable field ${field.id} is not a numeric bp field.`);
  }
  return clampEditableBpValue(field, field.value);
}

function clampEditableBpValue(field: AssemblyWorkbenchEditableField, value: number): number {
  const rounded = Math.round(value);
  if (!field.range) return rounded;
  return Math.max(field.range.min, Math.min(field.range.max, rounded));
}

function clampVisualOffsetPx(state: SourceRegisterGestureState, visualOffsetPx: number): number {
  const range = state.field.range;
  if (!range) return visualOffsetPx;
  const minDx = (state.startValue - range.max) * state.pxPerBase;
  const maxDx = (state.startValue - range.min) * state.pxPerBase;
  return Math.max(minDx, Math.min(maxDx, visualOffsetPx));
}

function normalizePxPerBase(pxPerBase: number): number {
  return Number.isFinite(pxPerBase) && pxPerBase > 0 ? pxPerBase : 1;
}
