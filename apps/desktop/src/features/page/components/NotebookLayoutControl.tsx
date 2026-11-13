import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  getNotebookLayout,
  NOTEBOOK_LAYOUTS,
  type NotebookLayoutChoice,
} from '../editor/extensions/notebook-layout';
import './notebook-layout.css';

function readLayoutState(editor: Editor) {
  return {
    layout: getNotebookLayout(editor.state),
    editable: editor.isEditable,
    available: editor.can().setNotebookLayout('two-columns'),
  };
}

export function NotebookLayoutControl({ editor }: { editor: Editor }) {
  const [state, setState] = useState(() => readLayoutState(editor));
  useEffect(() => {
    const update = () => setState(readLayoutState(editor));
    editor.on('transaction', update);
    editor.on('update', update);
    update();
    return () => {
      editor.off('transaction', update);
      editor.off('update', update);
    };
  }, [editor]);

  return (
    <label className="flex items-center gap-1 px-1 text-xs text-fg-muted">
      Layout
      <select
        aria-label="Notebook layout"
        value={state.layout}
        disabled={!state.editable || !state.available}
        onChange={(event) =>
          editor
            .chain()
            .focus()
            .setNotebookLayout(event.target.value as NotebookLayoutChoice)
            .run()
        }
        className="h-6 rounded border border-border bg-bg px-1 text-xs text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
      >
        <option value="single-column">One column</option>
        {NOTEBOOK_LAYOUTS.map((layout) => (
          <option key={layout.id} value={layout.id}>
            {layout.label}
          </option>
        ))}
      </select>
    </label>
  );
}
