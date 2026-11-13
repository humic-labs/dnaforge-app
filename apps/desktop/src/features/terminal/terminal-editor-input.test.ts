import { EditorState, EditorSelection } from '@codemirror/state';
import { expect, it } from 'vitest';
import { terminalTextFromEditor } from './terminal-editor-input';

it('uses selected editor text or the actual cursor line without changing the document', () => {
  const text = "printf 'FIRST'\nprintf 'SECOND'\n";
  const selected = EditorState.create({
    doc: text,
    selection: EditorSelection.range(0, text.indexOf('\n') + 1),
  });
  expect(terminalTextFromEditor(selected)).toBe("printf 'FIRST'\n");
  const cursor = EditorState.create({ doc: text, selection: { anchor: text.indexOf('SECOND') } });
  expect(terminalTextFromEditor(cursor)).toBe("printf 'SECOND'");
  expect(cursor.doc.toString()).toBe(text);
});
