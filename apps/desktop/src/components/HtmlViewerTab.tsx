import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getFilename } from '../utils/fileTypes';
import { platform } from '../platform';
import { resolveFilePathWithFallback } from '../hooks/resolveFilePath';
import { commitReadableContent, failReadableContent } from '../lib/readable-content-telemetry';

type ViewMode = 'rendered' | 'source';
type HtmlReadState =
  | { filePath: string; phase: 'loading' }
  | { filePath: string; phase: 'ready'; html: string }
  | { filePath: string; phase: 'failed'; message: string };

interface HtmlViewerTabProps {
  filePath: string;
}

export function HtmlViewerTab({ filePath }: HtmlViewerTabProps) {
  const [read, setRead] = useState<HtmlReadState>({ filePath, phase: 'loading' });
  const current: HtmlReadState = read.filePath === filePath ? read : { filePath, phase: 'loading' };
  const html = current.phase === 'ready' ? current.html : null;
  const loading = current.phase === 'loading';
  const error = current.phase === 'failed' ? current.message : null;
  const [mode, setMode] = useState<ViewMode>('rendered');
  const [allowScripts, setAllowScripts] = useState(false);

  const filename = useMemo(() => getFilename(filePath), [filePath]);

  useEffect(() => {
    let cancelled = false;
    setRead({ filePath, phase: 'loading' });
    setAllowScripts(false);

    (async () => {
      try {
        const resolved = resolveFilePathWithFallback(filePath);
        const content = await platform().fs.readTextFile(resolved);
        if (cancelled) return;
        setRead({ filePath, phase: 'ready', html: content });
        commitReadableContent(filePath);
      } catch (err) {
        if (cancelled) return;
        failReadableContent(filePath);
        console.error('[HtmlViewerTab] Failed to read HTML file:', err);
        setRead({
          filePath,
          phase: 'failed',
          message: toUserMessage(err, 'failure.failed-to-read-file'),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(filePath);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  }, [filePath]);

  const sandbox = allowScripts ? 'allow-scripts' : '';

  if (loading && html === null) {
    return (
      <div className="h-full flex items-center justify-center bg-bg-inset">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full mx-auto mb-2" />
          <p className="text-sm text-fg-muted">Loading HTML…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-bg-inset p-4">
        <div className="text-center max-w-md">
          <div className="text-4xl mb-4">🌐</div>
          <div className="text-lg font-medium text-fg mb-2">Failed to open HTML</div>
          <div className="text-sm text-fg-muted">{toUserMessage(error, 'document.openFailed')}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-bg-inset" data-testid="html-viewer">
      {}
      <div className="tab-chrome-surface flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="font-medium text-sm text-fg truncate min-w-0" title={filePath}>
          {filename}
        </span>

        <div className="flex items-center gap-2 flex-shrink-0">
          {}
          <div className="flex items-center rounded overflow-hidden border border-border">
            {(['rendered', 'source'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                data-testid={`html-viewer-mode-${m}`}
                aria-pressed={mode === m}
                className={`px-2 py-1 text-xs transition-colors ${
                  mode === m
                    ? 'bg-accent/10 text-accent'
                    : 'text-fg-muted hover:text-fg hover:bg-bg-muted'
                }`}
              >
                {m === 'rendered' ? 'Rendered' : 'Source'}
              </button>
            ))}
          </div>

          {}
          {mode === 'rendered' && (
            <label
              className="flex items-center gap-1 text-xs text-fg-muted cursor-pointer select-none"
              title="Run scripts inside the page. The page stays sandboxed in an opaque origin and cannot access the app, your files, or the network origin."
            >
              <input
                type="checkbox"
                data-testid="html-viewer-enable-scripts"
                checked={allowScripts}
                onChange={(e) => setAllowScripts(e.target.checked)}
                className="accent-accent"
              />
              Enable scripts
            </label>
          )}

          <button
            onClick={handleCopyPath}
            className="px-2 py-1 text-xs text-fg-muted hover:text-fg hover:bg-bg-muted rounded transition-colors"
            title={filePath}
          >
            Copy Path
          </button>
        </div>
      </div>

      {}
      {mode === 'rendered' ? (
        <iframe
          key={sandbox}
          data-testid="html-viewer-iframe"
          title={filename}
          srcDoc={html ?? ''}
          sandbox={sandbox}
          referrerPolicy="no-referrer"
          className="flex-1 w-full border-0 bg-white"
        />
      ) : (
        <pre
          data-testid="html-viewer-source"
          className="flex-1 overflow-auto p-4 text-xs font-mono text-fg whitespace-pre-wrap break-words"
        >
          {html}
        </pre>
      )}

      {}
      <div className="px-3 py-1.5 border-t border-border bg-bg-subtle text-xs text-fg-muted text-center">
        {mode === 'rendered'
          ? allowScripts
            ? 'Sandboxed (scripts enabled, opaque origin) — the page cannot access the app or your files.'
            : 'Sandboxed preview — scripts are disabled. Enable scripts for interactive pages.'
          : 'Raw HTML source.'}
      </div>
    </div>
  );
}
