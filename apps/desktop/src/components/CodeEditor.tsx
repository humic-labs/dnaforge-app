import { useEffect, useRef } from 'react';
import { EditorState, Compartment, Annotation, Prec, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  type ViewUpdate,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
  undoDepth,
  redoDepth,
  isolateHistory,
} from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { getCodeMirrorLanguage } from './codeEditorLanguage';
import { useWorkspaceVisibility } from '../features/canvas/workspace-visibility';

export const editorHistory = { undo, redo, undoDepth, redoDepth, isolateHistory };

export interface CodeEditorProps {
  revealPosition?: { line: number; column: number; requestId: string };

  value: string;

  onChange: (value: string) => void;

  language: string;

  darkMode: boolean;

  showLineNumbers: boolean;

  wordWrap: boolean;

  readOnly?: boolean;

  onSave?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;

  onCursorLineChange?: (line: number) => void;

  ariaLabel?: string;

  onReady?: (view: EditorView) => void;
}

function appChromeTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'hsl(var(--color-bg))',
        color: 'hsl(var(--color-fg))',
        fontSize: 'var(--text-sm)',
      },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.6',
        overflow: 'auto',
      },
      '.cm-content': {
        caretColor: 'hsl(var(--color-accent))',
        padding: 'var(--space-2) 0',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'hsl(var(--color-accent))',
        borderLeftWidth: '2px',
      },

      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'hsl(var(--color-accent) / 0.22)',
      },
      '.cm-activeLine': {
        backgroundColor: 'hsl(var(--color-bg-subtle))',
      },
      '.cm-gutters': {
        backgroundColor: 'hsl(var(--color-bg))',
        color: 'hsl(var(--color-fg-subtle))',
        border: 'none',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'hsl(var(--color-bg-subtle))',
        color: 'hsl(var(--color-fg-muted))',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 var(--space-3) 0 var(--space-2)',
      },
      '.cm-foldPlaceholder': {
        backgroundColor: 'hsl(var(--color-bg-muted))',
        border: 'none',
        color: 'hsl(var(--color-fg-muted))',
      },
    },
    { dark }
  );
}

const ExternalSync = Annotation.define<boolean>();

const BASE_EXTENSIONS: Extension = [
  history(),
  drawSelection(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
  EditorState.tabSize.of(2),
];

export function CodeEditor({
  value,
  onChange,
  language,
  darkMode,
  showLineNumbers,
  wordWrap,
  readOnly = false,
  onSave,
  onUndo,
  onRedo,
  onCursorLineChange,
  ariaLabel,
  onReady,
  revealPosition,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastRevealRequest = useRef<string | null>(null);
  const workspaceVisible = useWorkspaceVisibility();

  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onUndoRef = useRef(onUndo);
  const onRedoRef = useRef(onRedo);
  onUndoRef.current = onUndo;
  onRedoRef.current = onRedo;
  const onCursorLineChangeRef = useRef(onCursorLineChange);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onCursorLineChangeRef.current = onCursorLineChange;
  const lastCursorLine = useRef(-1);

  const languageConf = useRef(new Compartment());
  const themeConf = useRef(new Compartment());
  const lineNumbersConf = useRef(new Compartment());
  const wrapConf = useRef(new Compartment());
  const editableConf = useRef(new Compartment());

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged && !update.transactions.some((tr) => tr.annotation(ExternalSync))) {
        onChangeRef.current(update.state.sliceDoc());
      }
      if (update.docChanged || update.selectionSet) {
        const line = update.state.doc.lineAt(update.state.selection.main.head).number;
        if (line !== lastCursorLine.current) {
          lastCursorLine.current = line;
          onCursorLineChangeRef.current?.(line);
        }
      }
    });

    const saveKeymap = Prec.highest(
      keymap.of([
        {
          key: 'Mod-z',
          run: () => {
            if (!onUndoRef.current) return false;
            onUndoRef.current();
            return true;
          },
        },
        {
          key: 'Mod-Shift-z',
          run: () => {
            if (!onRedoRef.current) return false;
            onRedoRef.current();
            return true;
          },
        },
        {
          key: 'Mod-y',
          run: () => {
            if (!onRedoRef.current) return false;
            onRedoRef.current();
            return true;
          },
        },
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current?.();
            return true;
          },
        },
      ])
    );

    const initialLanguage = getCodeMirrorLanguage(language);

    const state = EditorState.create({
      doc: value,
      extensions: [
        BASE_EXTENSIONS,
        EditorState.lineSeparator.of(value.includes('\r\n') ? '\r\n' : '\n'),
        saveKeymap,
        updateListener,
        languageConf.current.of(initialLanguage ?? []),
        themeConf.current.of([
          appChromeTheme(darkMode),
          syntaxHighlighting(darkMode ? oneDarkHighlightStyle : defaultHighlightStyle),
        ]),
        lineNumbersConf.current.of(showLineNumbers ? lineNumbers() : []),
        wrapConf.current.of(wordWrap ? EditorView.lineWrapping : []),
        editableConf.current.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        EditorView.contentAttributes.of({
          'aria-label': ariaLabel ?? 'Code editor',
          'data-testid': 'code-editor-content',
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    lastRevealRequest.current = null;
    onReady?.(view);

    return () => {
      view.destroy();
      viewRef.current = null;
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = viewRef.current;
    if (
      !editor ||
      !workspaceVisible ||
      !revealPosition ||
      lastRevealRequest.current === revealPosition.requestId
    )
      return;
    lastRevealRequest.current = revealPosition.requestId;
    const line = editor.state.doc.line(
      Math.max(1, Math.min(editor.state.doc.lines, revealPosition.line))
    );
    const position = Math.min(line.to, line.from + Math.max(0, revealPosition.column - 1));
    editor.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: 'center' }),
    });
    if (editor.contentDOM.isConnected) editor.focus();
  }, [revealPosition, value, workspaceVisible]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.sliceDoc();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: ExternalSync.of(true),
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const ext = getCodeMirrorLanguage(language);
    view.dispatch({ effects: languageConf.current.reconfigure(ext ?? []) });
  }, [language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeConf.current.reconfigure([
        appChromeTheme(darkMode),
        syntaxHighlighting(darkMode ? oneDarkHighlightStyle : defaultHighlightStyle),
      ]),
    });
  }, [darkMode]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: lineNumbersConf.current.reconfigure(showLineNumbers ? lineNumbers() : []),
    });
  }, [showLineNumbers]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapConf.current.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    });
  }, [wordWrap]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableConf.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  return <div ref={hostRef} data-testid="text-editor" className="h-full w-full overflow-hidden" />;
}

export default CodeEditor;
