import type { EditorState } from '@codemirror/state';

export function terminalTextFromEditor(state: EditorState): string {
  const range = state.selection.main;
  return range.empty
    ? state.doc.lineAt(range.head).text
    : state.doc.sliceString(range.from, range.to);
}
