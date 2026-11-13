// @vitest-environment jsdom

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { language as languageFacet } from '@codemirror/language';
import { CodeEditor } from './CodeEditor';
import { WorkspaceVisibilityContext } from '../features/canvas/workspace-visibility';
import { StrictMode } from 'react';

beforeAll(() => {
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  cleanup();
});

function renderEditor(props: Partial<React.ComponentProps<typeof CodeEditor>> = {}) {
  let view: EditorView | undefined;
  const onChange = vi.fn();
  const utils = render(
    <CodeEditor
      value={props.value ?? 'hello world'}
      onChange={props.onChange ?? onChange}
      language={props.language ?? 'plaintext'}
      darkMode={props.darkMode ?? false}
      showLineNumbers={props.showLineNumbers ?? true}
      wordWrap={props.wordWrap ?? true}
      readOnly={props.readOnly}
      onSave={props.onSave}
      onCursorLineChange={props.onCursorLineChange}
      onReady={(v) => {
        view = v;
      }}
    />
  );
  return { ...utils, getView: () => view as EditorView, onChange };
}

describe('CodeEditor', () => {
  it('preserves CRLF line endings in the controlled draft when a person edits', () => {
    const { getView, onChange } = renderEditor({ value: 'alpha\r\nbeta\r\n' });
    act(() => getView().dispatch({ changes: { from: 0, to: 5, insert: 'edited' } }));
    expect(onChange).toHaveBeenLastCalledWith('edited\r\nbeta\r\n');
  });
  it('reapplies a requested cursor position to the current editor after StrictMode recreation', () => {
    const result = render(
      <StrictMode>
        <CodeEditor
          value={'first line\nsecond line\nthird line'}
          onChange={vi.fn()}
          language="plaintext"
          darkMode={false}
          showLineNumbers
          wordWrap
          ariaLabel="Strict editor"
          revealPosition={{ line: 2, column: 3, requestId: 'strict-reveal' }}
        />
      </StrictMode>
    );
    const view = EditorView.findFromDOM(result.getByRole('textbox', { name: 'Strict editor' }))!;
    expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from + 2);
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it('keeps a cursor request pending while its workspace is hidden and focuses it once shown', () => {
    const editor = (visible: boolean) => (
      <WorkspaceVisibilityContext.Provider value={visible}>
        <CodeEditor
          value={'first line\nsecond line\nthird line'}
          onChange={vi.fn()}
          language="plaintext"
          darkMode={false}
          showLineNumbers
          wordWrap
          ariaLabel="Hidden editor"
          revealPosition={{ line: 2, column: 3, requestId: 'hidden-reveal' }}
        />
      </WorkspaceVisibilityContext.Provider>
    );
    const result = render(editor(false));
    const view = EditorView.findFromDOM(result.getByRole('textbox', { name: 'Hidden editor' }))!;
    expect(view.state.selection.main.head).toBe(0);
    expect(document.activeElement).not.toBe(view.contentDOM);
    result.rerender(editor(true));
    expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from + 2);
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it('mounts a CodeMirror editor with the initial value', () => {
    const { container, getView } = renderEditor({ value: 'const x = 1;' });

    expect(container.querySelector('.cm-editor')).toBeTruthy();
    expect(container.querySelector('.cm-content')).toBeTruthy();
    expect(getView().state.doc.toString()).toBe('const x = 1;');
  });

  it('calls onChange with the full document on a user edit', () => {
    const { getView, onChange } = renderEditor({ value: 'abc' });
    const view = getView();

    act(() => {
      view.dispatch({ changes: { from: 3, insert: 'def' } });
    });

    expect(onChange).toHaveBeenCalledWith('abcdef');
  });

  it('does NOT echo onChange when the value prop is synced externally', () => {
    const { getView, onChange, rerender } = renderEditor({ value: 'original' });

    act(() => {
      rerender(
        <CodeEditor
          value="changed externally"
          onChange={onChange}
          language="plaintext"
          darkMode={false}
          showLineNumbers
          wordWrap
        />
      );
    });

    expect(getView().state.doc.toString()).toBe('changed externally');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('applies a language extension for a supported language', () => {
    const { getView } = renderEditor({ language: 'python', value: 'def f():\n    pass\n' });
    expect(getView().state.facet(languageFacet)).not.toBeNull();
  });

  it('uses a plain surface (no language) for plaintext', () => {
    const { getView } = renderEditor({ language: 'plaintext', value: 'just text' });
    expect(getView().state.facet(languageFacet)).toBeNull();
  });

  it('reconfigures the language in place when the prop changes', () => {
    const { getView, rerender, onChange } = renderEditor({
      language: 'plaintext',
      value: 'x',
    });
    expect(getView().state.facet(languageFacet)).toBeNull();

    act(() => {
      rerender(
        <CodeEditor
          value="x"
          onChange={onChange}
          language="python"
          darkMode={false}
          showLineNumbers
          wordWrap
        />
      );
    });

    expect(getView().state.facet(languageFacet)).not.toBeNull();
  });

  it('switches the editor theme to dark iff darkMode is on', () => {
    const { getView, rerender, onChange } = renderEditor({
      darkMode: false,
      value: 'x',
    });
    const isDark = () => getView().state.facet(EditorView.darkTheme);

    expect(isDark()).toBe(false);

    act(() => {
      rerender(
        <CodeEditor
          value="x"
          onChange={onChange}
          language="plaintext"
          darkMode
          showLineNumbers
          wordWrap
        />
      );
    });
    expect(isDark()).toBe(true);

    act(() => {
      rerender(
        <CodeEditor
          value="x"
          onChange={onChange}
          language="plaintext"
          darkMode={false}
          showLineNumbers
          wordWrap
        />
      );
    });
    expect(isDark()).toBe(false);
  });

  it('shows the line-number gutter only when enabled', () => {
    const { container, rerender, onChange } = renderEditor({ showLineNumbers: true });
    expect(container.querySelector('.cm-lineNumbers')).toBeTruthy();

    act(() => {
      rerender(
        <CodeEditor
          value="hello world"
          onChange={onChange}
          language="plaintext"
          darkMode={false}
          showLineNumbers={false}
          wordWrap
        />
      );
    });

    expect(container.querySelector('.cm-lineNumbers')).toBeFalsy();
  });

  it('applies the line-wrapping class only when word wrap is on', () => {
    const { container, rerender, onChange } = renderEditor({ wordWrap: true });
    expect(container.querySelector('.cm-content')?.classList.contains('cm-lineWrapping')).toBe(
      true
    );

    act(() => {
      rerender(
        <CodeEditor
          value="hello world"
          onChange={onChange}
          language="plaintext"
          darkMode={false}
          showLineNumbers
          wordWrap={false}
        />
      );
    });

    expect(container.querySelector('.cm-content')?.classList.contains('cm-lineWrapping')).toBe(
      false
    );
  });

  it('renders a non-editable surface when readOnly', () => {
    const { container, getView } = renderEditor({ readOnly: true });
    expect(getView().state.facet(EditorView.editable)).toBe(false);
    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
    expect(container.querySelector('.cm-content')?.getAttribute('aria-readonly')).toBe('true');
  });

  it('invokes onSave via the high-precedence save keymap', () => {
    const onSave = vi.fn();
    const { getView } = renderEditor({ onSave });

    act(() => {
      getView().contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 's',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(onSave).toHaveBeenCalled();
  });

  it('reports the cursor line via onCursorLineChange', () => {
    const onCursorLineChange = vi.fn();
    const { getView } = renderEditor({
      value: 'line1\nline2\nline3',
      onCursorLineChange,
    });

    act(() => {
      const view = getView();
      view.dispatch({ selection: { anchor: view.state.doc.line(3).from } });
    });

    expect(onCursorLineChange).toHaveBeenCalledWith(3);
  });
});
