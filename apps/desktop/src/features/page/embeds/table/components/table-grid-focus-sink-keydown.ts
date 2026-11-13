import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject, RefObject } from 'react';
import type { CellPosition, SelectionRange } from '../types';
import { safeFocus } from '../../../../../shared/utils/safeFocus';

export type FocusSinkEditingState = {
  position: CellPosition;
  value: string;
  cursorPosition: number;
};

type LabelSelection = { startCol: number; endCol: number } | null;

const NAV_KEYS = [
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Tab',
  'PageUp',
  'PageDown',
  'Home',
  'End',
];

export function consumeFocusSinkWhileEditing(
  e: ReactKeyboardEvent,
  args: {
    editingStateRef: MutableRefObject<FocusSinkEditingState | null>;
    editInputRef: RefObject<HTMLInputElement | null>;
    focusSinkRef: RefObject<HTMLInputElement | null>;
    setEditingState: (next: FocusSinkEditingState) => void;
  }
): boolean {
  const currentState = args.editingStateRef.current;
  if (!currentState) return false;

  e.preventDefault();
  if (args.focusSinkRef.current) {
    args.focusSinkRef.current.value = '';
  }

  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const newValue = currentState.value + e.key;
    const newState = {
      ...currentState,
      value: newValue,
      cursorPosition: newValue.length,
    };
    args.editingStateRef.current = newState;
    args.setEditingState(newState);
  }

  if (safeFocus(args.editInputRef.current)) {
    const len = args.editingStateRef.current?.value.length ?? 0;
    args.editInputRef.current?.setSelectionRange(len, len);
  }
  return true;
}

export function consumeTableGridFormatShortcut(
  e: ReactKeyboardEvent,
  args: {
    readOnly: boolean;
    onCellFormat?: unknown;
    toggleBold: () => void;
    toggleItalic: () => void;
    toggleUnderline: () => void;
    toggleStrikethrough: () => void;
  }
): boolean {
  if (args.readOnly || !args.onCellFormat || !(e.ctrlKey || e.metaKey) || e.altKey) {
    return false;
  }
  if (!e.shiftKey && (e.key === 'b' || e.key === 'B')) {
    e.preventDefault();
    e.stopPropagation();
    args.toggleBold();
    return true;
  }
  if (!e.shiftKey && (e.key === 'i' || e.key === 'I')) {
    e.preventDefault();
    e.stopPropagation();
    args.toggleItalic();
    return true;
  }
  if (!e.shiftKey && (e.key === 'u' || e.key === 'U')) {
    e.preventDefault();
    e.stopPropagation();
    args.toggleUnderline();
    return true;
  }
  if (e.shiftKey && (e.key === 'x' || e.key === 'X')) {
    e.preventDefault();
    e.stopPropagation();
    args.toggleStrikethrough();
    return true;
  }
  return false;
}

export function consumeLabelSelectionKeys(
  e: ReactKeyboardEvent,
  args: {
    labelSelection: LabelSelection;
    labelOnlySelection: boolean;
    canEditColumnLabels: boolean;
    startColumnLabelEdit: (column: number) => void;
    setActiveSelection: (next: { kind: 'cells' }) => void;
  }
): boolean {
  if (!args.labelSelection) return false;
  if (e.key === 'Escape') {
    e.preventDefault();
    args.setActiveSelection({ kind: 'cells' });
    return true;
  }
  if (
    args.labelOnlySelection &&
    (e.key === 'Enter' || e.key === 'F2') &&
    args.canEditColumnLabels &&
    args.labelSelection.startCol === args.labelSelection.endCol
  ) {
    e.preventDefault();
    args.startColumnLabelEdit(args.labelSelection.startCol);
    return true;
  }
  if (e.key === 'Enter' || e.key === 'F2') {
    e.preventDefault();
    return true;
  }
  if (args.labelOnlySelection && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    return true;
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    return true;
  }
  return false;
}

export function isTableGridNavigationKey(key: string): boolean {
  return NAV_KEYS.includes(key);
}

export function consumeUndoRedoShortcut(
  e: ReactKeyboardEvent,
  args: {
    readOnly: boolean;
    onUndo?: () => SelectionRange | void | null;
    onRedo?: () => SelectionRange | void | null;
    setActiveSelection: (next: { kind: 'cells' }) => void;
    setSelection: (range: SelectionRange) => void;
  }
): boolean {
  if (args.readOnly || !(e.ctrlKey || e.metaKey)) return false;
  if (e.key === 'z') {
    e.preventDefault();
    e.stopPropagation();
    const changedRange = e.shiftKey ? args.onRedo?.() : args.onUndo?.();
    if (changedRange) {
      args.setActiveSelection({ kind: 'cells' });
      args.setSelection(changedRange);
    }
    return true;
  }
  if (e.key === 'y') {
    e.preventDefault();
    e.stopPropagation();
    const changedRange = args.onRedo?.();
    if (changedRange) {
      args.setActiveSelection({ kind: 'cells' });
      args.setSelection(changedRange);
    }
    return true;
  }
  return false;
}
