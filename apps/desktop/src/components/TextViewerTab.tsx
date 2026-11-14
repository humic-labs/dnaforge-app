import { reportSaveFailure } from '../lib/report-save-failure';
import { useDocumentLifecycle } from '../shared/use-document-lifecycle';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { captureWorkspaceSessionIntent } from '../features/workspace-session/public/electron-session';
import { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense } from 'react';
import { getLanguageForFile, isBinaryContent, getFilename } from '../utils/fileTypes';
import { useCanvasStore } from '../features/canvas/store';
import { useDarkMode } from '../shared/context/DarkModeContext';
import { findPreservedMigrationRawSource } from '../shared/benchling-migration-raw-source';
import { platform } from '../platform';
import { isBrowserOnly, isHostedBrowserRuntime } from '../utils/environment';
import { preservedMigrationRawSourceTabType } from '../shared/benchling-migration-preserved-source-routing';
import { commitReadableContent, failReadableContent } from '../lib/readable-content-telemetry';
import { fingerprintText, useUnsavedDraftRecovery } from '../shared/unsaved-draft-recovery';
import { useToastStore } from '../stores/toast-store';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { isPathInsideBoundary } from '../shared/path-boundary';
import type { EditorView } from '@codemirror/view';
import {
  FileDocumentDraft,
  waitForFileDocumentSaves,
} from '../features/workspace/public/file-document-draft';
import {
  FileDocumentClient,
  getFileDocumentClient,
} from '../features/workspace/public/file-document-client';
import { terminalTextFromEditor } from '../features/terminal/terminal-editor-input';
import { runInIntegratedTerminal } from '../features/terminal/terminal-events';
import { COMMAND_IDS, COMMAND_SCOPES, useCommandHandler } from '../commands';

const CodeEditor = lazy(() => import('./CodeEditor'));

const MAX_FULL_TEXT_FILE_SIZE = 2 * 1024 * 1024;
const MAX_LARGE_PREVIEW_SOURCE_BYTES = 16 * 1024 * 1024;
const LARGE_PREVIEW_BYTES = 128 * 1024;
const MAX_PRESERVED_RAW_SOURCE_VERIFICATION_BYTES = 64 * 1024 * 1024;

interface TextViewerTabProps {
  filePath: string;
  canvasTabId?: string;

  sourceFileName?: string;

  readOnly?: boolean;

  textCursor?: { line: number; column: number; requestId: string };

  onCloseRequest?: (options: {
    save: () => Promise<void>;
    discard: () => void;
    cancel: () => void;
  }) => void;
}

interface LargeTextPreview {
  fileSizeBytes: number;
  previewText: string | null;
  previewBytes: number;
  previewSkipped: boolean;
  previewError?: string;
}

type PreservedRawSourceVerification =
  | { status: 'none' }
  | { status: 'checking' }
  | { status: 'ready' }
  | { status: 'invalid'; message: string };

function EditorLoading() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full mx-auto mb-2" />
        <p className="text-sm text-fg-muted">Loading file...</p>
      </div>
    </div>
  );
}

export function TextViewerTab({
  filePath,
  canvasTabId,
  sourceFileName,
  readOnly: requestedReadOnly = false,
  textCursor,
}: TextViewerTabProps) {
  const projectAvailable = useWorkspaceStore((state) =>
    state.folders.some((folder) => isPathInsideBoundary(filePath, folder.path))
  );
  const [originalContent, setOriginalContent] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState<string | null>(null);
  const [largePreview, setLargePreview] = useState<LargeTextPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [wordWrap, setWordWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const lastSaveError = useRef<string | null>(null);
  const offeredNativeRecovery = useRef<string | null>(null);
  const lastNativeError = useRef<string | null>(null);
  const [nativeReadOnly, setNativeReadOnly] = useState(false);
  const readOnly = requestedReadOnly || nativeReadOnly;
  const document = useMemo(
    () =>
      isBrowserOnly() || isHostedBrowserRuntime() || (requestedReadOnly && Boolean(sourceFileName))
        ? new FileDocumentDraft(filePath)
        : getFileDocumentClient(filePath),
    [filePath, requestedReadOnly, sourceFileName]
  );
  useEffect(() => {
    setNativeReadOnly(
      document instanceof FileDocumentClient && document.snapshot?.readOnly === true
    );
    if (!(document instanceof FileDocumentClient)) return;
    return document.subscribe(() => {
      setNativeReadOnly(document.snapshot?.readOnly === true);
      setOriginalContent(document.persistedContent);
      setEditedContent(document.content);
      setSaving(document.saving);
      if (document.error && document.error !== lastNativeError.current) {
        lastNativeError.current = document.error;
        useToastStore.getState().addToast(toUserMessage(document.error, 'document.openFailed'), {
          definition: 'text-viewer-tab-save-failed',
        });
      }
      const recoveryId = document.snapshot?.recoveryId;
      if (recoveryId && offeredNativeRecovery.current !== recoveryId) {
        offeredNativeRecovery.current = recoveryId;
        useToastStore.getState().addRichToast({
          definition: 'unsaved-draft-recovery-available',
          message: userMessage(
            'notice.this-file-has-an-unsaved-native-working-copy-from-a-previous-session'
          ),
          actions: [
            {
              label: 'Restore',
              onClick: async () => {
                await document.execute({ kind: 'restore-recovery', recoveryId });
              },
            },
            { label: 'Discard', onClick: () => document.execute({ kind: 'discard' }) },
          ],
        });
      }
    });
  }, [document]);
  const currentDocumentRef = useRef(document);
  currentDocumentRef.current = document;
  const updateEditedContent = useCallback(
    (content: string | null) => {
      document.change(content);
      setEditedContent(content);
      setSaveSuccess(false);
    },
    [document]
  );
  const updateOriginalContent = useCallback(
    (content: string | null) => {
      setOriginalContent(content);
    },
    [document]
  );
  const [cursorLine, setCursorLine] = useState(1);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const terminalAvailable = Boolean(platform().terminal);
  const terminalFileAvailable =
    terminalAvailable &&
    (filePath.startsWith('/') || /^[a-z]:[\\/]/i.test(filePath) || filePath.startsWith('\\\\'));
  const activeTextEditor = useCanvasStore((state) => {
    const panel = state.focusedPanelId ? state.panels[state.focusedPanelId] : undefined;
    return (
      panel?.tabs.some(
        (tab) => tab.id === panel.activeTabId && tab.type === 'text' && tab.entityId === filePath
      ) ?? false
    );
  });
  const runSelection = useCallback(
    (fresh = false) => {
      if (!editorView || !terminalAvailable) return;
      runInIntegratedTerminal({
        text: terminalTextFromEditor(editorView.state),
        cwd: filePath.replace(/[\\/][^\\/]*$/, '') || '/',
        fresh,
      });
    },
    [editorView, terminalAvailable, filePath]
  );
  useCommandHandler(COMMAND_IDS.terminalRunSelection, () => runSelection(), {
    scope: COMMAND_SCOPES.tabText,
    active: activeTextEditor && terminalAvailable,
  });
  const runFile = useCallback(() => {
    if (terminalFileAvailable) runInIntegratedTerminal({ filePath });
  }, [terminalFileAvailable, filePath]);
  useCommandHandler(COMMAND_IDS.terminalRunActiveFile, runFile, {
    scope: COMMAND_SCOPES.tabText,
    active: activeTextEditor && terminalFileAvailable && !loading && !error && !isBinary,
    label: 'Run Saved File in Active Terminal',
  });
  const [preservedRawSourceVerification, setPreservedRawSourceVerification] =
    useState<PreservedRawSourceVerification>({ status: 'none' });

  const filename = useMemo(
    () => getFilename(sourceFileName ?? filePath),
    [filePath, sourceFileName]
  );
  const language = useMemo(
    () => getLanguageForFile(sourceFileName ?? filePath),
    [filePath, sourceFileName]
  );
  const { darkMode } = useDarkMode();

  const openInFocusedPanel = useCanvasStore((s) => s.openInFocusedPanel);
  const preservedRawSource = useMemo(
    () => (originalContent ? findPreservedMigrationRawSource(originalContent) : null),
    [originalContent]
  );
  const preservedRawSourcePath = useMemo(
    () =>
      preservedRawSource
        ? preservedRawSourceAbsolutePath(filePath, preservedRawSource.relativePath)
        : null,
    [filePath, preservedRawSource]
  );

  useEffect(() => {
    let cancelled = false;
    if (!preservedRawSource) {
      setPreservedRawSourceVerification({ status: 'none' });
      return () => {
        cancelled = true;
      };
    }
    if (!preservedRawSourcePath) {
      setPreservedRawSourceVerification({
        status: 'invalid',
        message: 'Preserved source metadata is outside this migrated project.',
      });
      return () => {
        cancelled = true;
      };
    }

    setPreservedRawSourceVerification({ status: 'checking' });
    void (async () => {
      try {
        const bytes = await platform().fs.readFileBounded(
          preservedRawSourcePath,
          MAX_PRESERVED_RAW_SOURCE_VERIFICATION_BYTES
        );
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const sha256 = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0')
        ).join('');
        if (sha256 !== preservedRawSource.sha256) {
          throw new Error('Preserved source failed SHA-256 verification.');
        }
        if (!cancelled) setPreservedRawSourceVerification({ status: 'ready' });
      } catch (verificationError) {
        if (!cancelled) {
          setPreservedRawSourceVerification({
            status: 'invalid',
            message: toUserMessage(
              verificationError,
              'failure.preserved-source-verification-failed'
            ),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [preservedRawSource, preservedRawSourcePath]);

  const handleOpenPreservedRawSource = useCallback(() => {
    if (!preservedRawSource || !preservedRawSourcePath) return;
    openInFocusedPanel(
      preservedMigrationRawSourceTabType(preservedRawSource.fileName),
      preservedRawSourcePath,
      preservedRawSource.fileName,
      { sourceFileName: preservedRawSource.fileName, readOnly: true }
    );
  }, [openInFocusedPanel, preservedRawSource, preservedRawSourcePath]);

  const isDirty = useMemo(() => {
    if (originalContent === null || editedContent === null) return false;
    return !readOnly && originalContent !== editedContent;
  }, [editedContent, originalContent, readOnly]);

  const recoveryBaseline = useMemo(
    () => (originalContent === null ? null : fingerprintText(originalContent)),
    [originalContent]
  );
  const { flushDraft } = useUnsavedDraftRecovery<string>({
    key: readOnly || document instanceof FileDocumentClient ? null : `text:${filePath}`,
    name: (sourceFileName ?? filePath).split(/[\\/]/).filter(Boolean).pop() ?? 'This file',
    baseline: recoveryBaseline,
    dirty: isDirty,
    payload: editedContent ?? '',
    onRestore: updateEditedContent,
    discardTarget: { kind: 'file', filePath },
  });

  useEffect(() => {
    let cancelled = false;

    async function loadFile() {
      setLoading(true);
      setError(null);
      setIsBinary(false);
      setLargePreview(null);

      await waitForFileDocumentSaves(filePath);
      if (cancelled) return;

      const loadFromPlatform = async ({
        emptyFileIsReal,
      }: {
        emptyFileIsReal: boolean;
      }): Promise<boolean> => {
        const fileStat = await platform().fs.stat(filePath);
        if (!emptyFileIsReal && fileStat.size === 0) {
          return false;
        }

        if (fileStat.size > MAX_FULL_TEXT_FILE_SIZE) {
          if (!cancelled) {
            if (fileStat.size > MAX_LARGE_PREVIEW_SOURCE_BYTES) {
              updateOriginalContent(null);
              updateEditedContent(null);
              setLargePreview({
                fileSizeBytes: fileStat.size,
                previewText: null,
                previewBytes: 0,
                previewSkipped: true,
              });
              setLoading(false);
              return true;
            }

            try {
              const bytes = await platform().fs.readFile(filePath);
              if (cancelled) return true;
              const previewBytes = bytes.slice(0, Math.min(bytes.byteLength, LARGE_PREVIEW_BYTES));
              if (isBinaryContent(previewBytes)) {
                setIsBinary(true);
                updateOriginalContent(null);
                updateEditedContent(null);
                setLoading(false);
                return true;
              }
              const decoder = new TextDecoder('utf-8');
              const previewText = decoder.decode(previewBytes);
              updateOriginalContent(null);
              updateEditedContent(null);
              setLargePreview({
                fileSizeBytes: fileStat.size,
                previewText,
                previewBytes: previewBytes.byteLength,
                previewSkipped: false,
              });
            } catch (previewErr) {
              updateOriginalContent(null);
              updateEditedContent(null);
              setLargePreview({
                fileSizeBytes: fileStat.size,
                previewText: null,
                previewBytes: 0,
                previewSkipped: false,
                previewError:
                  previewErr instanceof Error ? previewErr.message : 'Failed to read preview',
              });
            }
            setLoading(false);
          }
          return true;
        }

        const bytes = await platform().fs.readFile(filePath);

        if (cancelled) return true;

        if (!emptyFileIsReal && fileStat.size === 0 && bytes.byteLength === 0) {
          return false;
        }

        if (isBinaryContent(bytes)) {
          setIsBinary(true);
          updateOriginalContent(null);
          updateEditedContent(null);
          setLoading(false);
          return true;
        }

        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        const text = decoder.decode(bytes);

        await document.load(text);
        if (cancelled) return true;
        updateOriginalContent(document.persistedContent);
        updateEditedContent(document.content);
        setLargePreview(null);
        setLoading(false);
        return true;
      };

      try {
        if (isBrowserOnly()) {
          try {
            const loaded = await loadFromPlatform({ emptyFileIsReal: false });
            if (loaded) return;
          } catch {}

          await new Promise((r) => setTimeout(r, 300));
          if (!cancelled) {
            const mockContent = `// Mock content for ${filename}\n// Running in browser mode\n\nfunction hello() {\n  console.log("Hello, world!");\n}\n`;
            await document.load(mockContent);
            updateOriginalContent(mockContent);
            updateEditedContent(mockContent);
            setLoading(false);
          }
          return;
        }

        await loadFromPlatform({ emptyFileIsReal: true });
      } catch (err) {
        if (!cancelled) {
          console.error('[TextViewerTab] Failed to load file:', err);
          setError(toUserMessage(err, 'failure.failed-to-load-file'));
          setLoading(false);
        }
      }
    }

    loadFile();

    return () => {
      cancelled = true;
    };
  }, [document, filePath, filename, projectAvailable, updateEditedContent, updateOriginalContent]);

  useEffect(() => {
    if (loading) return;
    if (error || isBinary || (editedContent === null && largePreview?.previewText == null)) {
      failReadableContent(filePath);
      return;
    }
    commitReadableContent(filePath);
  }, [editedContent, error, filePath, isBinary, largePreview, loading]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (readOnly) return true;
    if (document.content === null) return false;
    setSaving(true);
    setSaveSuccess(false);
    lastSaveError.current = null;
    try {
      const assertSessionCurrent = isHostedBrowserRuntime()
        ? captureWorkspaceSessionIntent()
        : () => {};
      await document.save(
        async (input) => {
          assertSessionCurrent();
          await platform().fs.writeTextFileAtomic(input);
          assertSessionCurrent();
        },
        () => {
          if (!mountedRef.current || currentDocumentRef.current !== document)
            throw new Error('That file editor has closed.');
        },
        async () => {
          if (mountedRef.current && currentDocumentRef.current === document) {
            await flushDraft(
              document.content !== null && document.content !== document.persistedContent
                ? {
                    baseline: fingerprintText(document.persistedContent!),
                    payload: document.content,
                  }
                : null
            );
          }
          if (mountedRef.current && currentDocumentRef.current === document) {
            updateOriginalContent(document.persistedContent);
            setSaveSuccess(!document.dirty);
            setTimeout(() => {
              if (mountedRef.current && currentDocumentRef.current === document) {
                setSaveSuccess(false);
              }
            }, 2000);
          }
        }
      );
      return true;
    } catch (error) {
      reportSaveFailure('[TextViewerTab] Save failed:', { filePath }, error);
      lastSaveError.current = error instanceof Error ? error.message : 'Failed to save file';
      if (mountedRef.current && currentDocumentRef.current === document) {
        useToastStore.getState().addToast(toUserMessage(error, 'failure.failed-to-save-file'), {
          definition: 'text-viewer-tab-save-failed',
        });
      }
      return false;
    } finally {
      if (mountedRef.current && currentDocumentRef.current === document) setSaving(document.saving);
    }
  }, [document, filePath, flushDraft, readOnly, updateOriginalContent]);

  const handleDiscard = useCallback(() => {
    if (document.persistedContent === null) return;
    if (document instanceof FileDocumentClient) document.discard();
    else document.change(document.persistedContent);
    setEditedContent(document.persistedContent);
  }, [document]);

  const handleEditorChange = useCallback(
    (next: string) => {
      if (!readOnly) updateEditedContent(next);
    },
    [readOnly, updateEditedContent]
  );

  useDocumentLifecycle({
    target: { kind: 'file', filePath },
    tabId: canvasTabId,
    isDirty: () => !readOnly && document.content !== document.persistedContent,
    save: async () => {
      let success: boolean;
      do {
        success = await handleSave();
        if (!mountedRef.current || currentDocumentRef.current !== document) return false;
      } while (success && !readOnly && document.content !== document.persistedContent);
      return success;
    },
    discard: () => {
      if (document instanceof FileDocumentClient) document.discard();
      else document.change(document.persistedContent);
    },
  });

  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(filePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  }, [filePath]);

  const lineCount = useMemo(() => {
    if (!editedContent) return 0;
    let lines = 1;
    for (let i = 0; i < editedContent.length; i++) {
      if (editedContent.charCodeAt(i) === 10) lines++;
    }
    return lines;
  }, [editedContent]);

  if (loading) {
    return <EditorLoading />;
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <div className="text-4xl mb-4">⚠️</div>
          <div className="text-lg font-medium text-fg mb-2">Failed to load file</div>
          <div className="text-sm text-fg-muted">{toUserMessage(error, 'document.openFailed')}</div>
        </div>
      </div>
    );
  }

  if (isBinary) {
    return (
      <div className="h-full flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <div className="text-4xl mb-4">📦</div>
          <div className="text-lg font-medium text-fg mb-2">Binary File</div>
          <div className="text-sm text-fg-muted">
            This file contains binary data and cannot be displayed as text.
          </div>
          <button
            onClick={handleCopyPath}
            className="mt-4 px-3 py-1.5 text-sm bg-bg-muted hover:bg-bg-subtle rounded transition-colors"
          >
            Copy Path
          </button>
        </div>
      </div>
    );
  }

  if (largePreview) {
    return (
      <LargeTextPreviewView
        filename={filename}
        filePath={filePath}
        preview={largePreview}
        copied={copied}
        onCopyPath={handleCopyPath}
      />
    );
  }

  return (
    <div data-testid="text-viewer-tab" className="h-full flex flex-col bg-bg">
      {}
      <div className="tab-chrome-surface flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <span data-testid="text-editor-filename" className="font-medium text-sm text-fg truncate">
            {filename}
          </span>
          <span data-testid="text-editor-language" className="text-xs text-fg-muted uppercase">
            {language}
          </span>
          {isDirty && <span className="text-xs text-warning font-medium">Modified</span>}
          {saveSuccess && <span className="text-xs text-success font-medium">Saved!</span>}
        </div>

        <div className="flex items-center gap-2">
          {}
          {isDirty && (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-2 py-1 text-xs bg-accent text-white hover:bg-accent/90 rounded transition-colors disabled:opacity-50"
                title="Save (Cmd+S)"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={handleDiscard}
                className="px-2 py-1 text-xs text-fg-muted hover:text-fg hover:bg-bg-muted rounded transition-colors"
                title="Discard changes"
              >
                Discard
              </button>
              <div className="w-px h-4 bg-border" />
            </>
          )}

          {}
          {terminalAvailable && (
            <>
              {terminalFileAvailable && (
                <button
                  aria-label="Run Saved File in Active Terminal"
                  title="Run the saved file in the active terminal"
                  disabled={loading || Boolean(error) || isBinary}
                  onClick={runFile}
                  className="px-2 py-1 text-xs text-fg-muted hover:text-fg hover:bg-bg-muted rounded"
                >
                  Run saved file
                </button>
              )}
              <button
                aria-label="Run Selection in Active Terminal"
                disabled={!editorView}
                onClick={() => runSelection()}
                className="px-2 py-1 text-xs text-fg-muted hover:text-fg hover:bg-bg-muted rounded"
              >
                Run selection
              </button>
              <button
                aria-label="Run Selection in New Terminal"
                disabled={!editorView}
                onClick={() => runSelection(true)}
                className="px-2 py-1 text-xs text-fg-muted hover:text-fg hover:bg-bg-muted rounded"
              >
                Run in new terminal
              </button>
            </>
          )}
          <button
            onClick={handleCopyPath}
            className="px-2 py-1 text-xs text-fg-muted hover:text-fg hover:bg-bg-muted rounded transition-colors"
            title={filePath}
          >
            {copied ? 'Copied!' : 'Copy Path'}
          </button>

          {preservedRawSourceVerification.status === 'checking' && (
            <span data-testid="preserved-raw-source-checking" className="text-xs text-fg-muted">
              Checking legacy preserved source…
            </span>
          )}

          {preservedRawSourceVerification.status === 'invalid' && (
            <span
              data-testid="preserved-raw-source-invalid"
              className="text-xs text-error"
              title={toUserMessage(preservedRawSourceVerification.message, 'operation.failed')}
            >
              Legacy preserved source unavailable
            </span>
          )}

          {preservedRawSourceVerification.status === 'ready' && preservedRawSourcePath && (
            <button
              data-testid="open-preserved-raw-source"
              onClick={handleOpenPreservedRawSource}
              className="px-2 py-1 text-xs text-accent hover:bg-accent/10 rounded transition-colors"
              title={`Open captured ${preservedRawSource?.fileName ?? 'source'}`}
            >
              Open legacy preserved source
            </button>
          )}

          {}
          <button
            onClick={() => setShowLineNumbers(!showLineNumbers)}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              showLineNumbers
                ? 'bg-accent/10 text-accent'
                : 'text-fg-muted hover:text-fg hover:bg-bg-muted'
            }`}
            title="Toggle line numbers"
          >
            #
          </button>

          {}
          <button
            onClick={() => setWordWrap(!wordWrap)}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              wordWrap
                ? 'bg-accent/10 text-accent'
                : 'text-fg-muted hover:text-fg hover:bg-bg-muted'
            }`}
            title="Toggle word wrap"
          >
            ↩
          </button>
        </div>
      </div>

      {}
      <div className="flex-1 overflow-hidden">
        <Suspense fallback={<EditorLoading />}>
          <CodeEditor
            value={editedContent ?? ''}
            onChange={handleEditorChange}
            language={language}
            darkMode={darkMode}
            showLineNumbers={showLineNumbers}
            wordWrap={wordWrap}
            readOnly={readOnly}
            onSave={handleSave}
            onUndo={
              document instanceof FileDocumentClient
                ? () => {
                    void document.execute({ kind: 'undo' }).catch(() => {});
                  }
                : undefined
            }
            onRedo={
              document instanceof FileDocumentClient
                ? () => {
                    void document.execute({ kind: 'redo' }).catch(() => {});
                  }
                : undefined
            }
            onCursorLineChange={setCursorLine}
            ariaLabel={`Code editor for ${filename}`}
            revealPosition={textCursor}
            onReady={setEditorView}
          />
        </Suspense>
      </div>

      {}
      <div
        data-testid="text-editor-status"
        className="flex items-center justify-between px-3 py-1 border-t border-border bg-bg-subtle text-xs text-fg-muted"
      >
        <div className="flex items-center gap-3">
          <span>Ln {cursorLine}</span>
          <span>{lineCount} lines</span>
        </div>
        <div className="flex items-center gap-3">
          <span>UTF-8</span>
          {isDirty && <span className="text-warning">Unsaved</span>}
        </div>
      </div>
    </div>
  );
}

function preservedRawSourceAbsolutePath(
  artifactPath: string,
  relativeRawSourcePath: string
): string | null {
  const normalizedArtifactPath = artifactPath.replace(/\\/g, '/');
  const marker = '/Benchling Imports/';
  const markerIndex = normalizedArtifactPath.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const workspaceRoot = normalizedArtifactPath.slice(0, markerIndex);
  if (!workspaceRoot || !relativeRawSourcePath.startsWith('.dnaforge/migration/archive/')) {
    return null;
  }
  return `${workspaceRoot}/${relativeRawSourcePath}`;
}

function LargeTextPreviewView({
  filename,
  filePath,
  preview,
  copied,
  onCopyPath,
}: {
  filename: string;
  filePath: string;
  preview: LargeTextPreview;
  copied: boolean;
  onCopyPath: () => void;
}) {
  return (
    <div data-testid="large-text-preview" className="h-full flex flex-col bg-bg">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border bg-bg-subtle">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-medium text-sm text-fg truncate" title={filePath}>
              {filename}
            </span>
            <span className="text-xs text-fg-muted">Large text preview</span>
            <span className="text-xs text-fg-muted">{formatBytes(preview.fileSizeBytes)}</span>
          </div>
          <div className="text-xs text-fg-muted mt-0.5">
            Full editing is disabled above {formatBytes(MAX_FULL_TEXT_FILE_SIZE)} to keep the
            renderer responsive.
          </div>
        </div>
        <button
          onClick={onCopyPath}
          className="px-2 py-1 text-xs text-fg-muted hover:text-fg hover:bg-bg-muted rounded transition-colors flex-shrink-0"
          title={filePath}
        >
          {copied ? 'Copied!' : 'Copy Path'}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto bg-bg-inset">
        {preview.previewText !== null ? (
          <>
            <div className="px-4 py-2 border-b border-border text-xs text-fg-muted bg-bg">
              Showing the first {formatBytes(preview.previewBytes)}
              {preview.fileSizeBytes > preview.previewBytes ? ' of this file.' : '.'}
            </div>
            <pre className="p-4 text-xs font-mono text-fg whitespace-pre-wrap">
              {preview.previewText}
            </pre>
          </>
        ) : (
          <div className="h-full flex items-center justify-center p-4">
            <div className="max-w-md text-center">
              <div className="text-lg font-medium text-fg mb-2">Preview unavailable</div>
              <div className="text-sm text-fg-muted">
                {preview.previewSkipped
                  ? `Preview is skipped for files above ${formatBytes(
                      MAX_LARGE_PREVIEW_SOURCE_BYTES
                    )}.`
                  : preview.previewError || 'The file could not be sampled.'}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-3 py-1 border-t border-border bg-bg-subtle text-xs text-fg-muted">
        <span>UTF-8 preview</span>
        <span>read-only</span>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  return `${(kib / 1024).toFixed(1)} MB`;
}
