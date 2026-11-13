'use client';

import { useEffect, useRef, useState } from 'react';
import { TelemetryBlockedSurface } from '../../../../../components/TelemetryBlockedSurface';

interface TableToolbarProps {
  rows: number;
  cols: number;
  hasFilters?: boolean;
  readOnly?: boolean;
  onAddRow: () => void;
  onRemoveRow: () => void;
  onAddColumn: () => void;
  onRemoveColumn: () => void;
  onClearFilters?: () => void;
  onExportCSV: () => void;
  onCopyToClipboard: () => Promise<void>;
  onReplaceTable?: (text: string, html?: string) => boolean;
}

export function TableToolbar({
  rows,
  cols,
  hasFilters,
  readOnly = false,
  onAddRow,
  onRemoveRow,
  onAddColumn,
  onRemoveColumn,
  onClearFilters,
  onExportCSV,
  onCopyToClipboard,
  onReplaceTable,
}: TableToolbarProps) {
  const [copyState, setCopyState] = useState<'idle' | 'pending' | 'copied' | 'failed'>('idle');
  const [replacementOpen, setReplacementOpen] = useState(false);
  const [replacement, setReplacement] = useState({ text: '', html: '' });
  const [replacementError, setReplacementError] = useState(false);
  const active = useRef(true);
  const copying = useRef(false);
  const generation = useRef(0);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current += 1;
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const handleCopy = async () => {
    if (copying.current) return;
    copying.current = true;
    const request = ++generation.current;
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    setCopyState('pending');
    try {
      await onCopyToClipboard();
      if (!active.current || request !== generation.current) return;
      setCopyState('copied');
      copiedTimer.current = setTimeout(() => {
        if (active.current && request === generation.current) setCopyState('idle');
      }, 1500);
    } catch {
      if (active.current && request === generation.current) setCopyState('failed');
    } finally {
      copying.current = false;
    }
  };

  const closeReplacement = () => {
    setReplacementOpen(false);
    setReplacement({ text: '', html: '' });
    setReplacementError(false);
  };
  const handleReplace = (event: React.FormEvent) => {
    event.preventDefault();
    if (readOnly) {
      setReplacementError(true);
      return;
    }
    try {
      if (!onReplaceTable?.(replacement.text, replacement.html)) {
        setReplacementError(true);
        return;
      }
      closeReplacement();
    } catch {
      setReplacementError(true);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2 bg-bg-subtle border-t border-border text-xs">
      {}
      <div className="flex items-center gap-1">
        <span className="text-fg-muted mr-1">Rows:</span>
        <button
          onClick={onRemoveRow}
          disabled={readOnly || rows <= 1}
          className="px-1.5 py-0.5 rounded hover:bg-bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
          title="Remove last row"
          aria-label="Remove row"
        >
          −
        </button>
        <span className="w-6 text-center font-medium">{rows}</span>
        <button
          onClick={onAddRow}
          disabled={readOnly}
          className="px-1.5 py-0.5 rounded hover:bg-bg-muted"
          title="Add row"
          aria-label="Add row"
        >
          +
        </button>
      </div>

      <div className="w-px h-4 bg-border" />

      {}
      <div className="flex items-center gap-1">
        <span className="text-fg-muted mr-1">Cols:</span>
        <button
          onClick={onRemoveColumn}
          disabled={readOnly || cols <= 1}
          className="px-1.5 py-0.5 rounded hover:bg-bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
          title="Remove last column"
          aria-label="Remove column"
        >
          −
        </button>
        <span className="w-6 text-center font-medium">{cols}</span>
        <button
          onClick={onAddColumn}
          disabled={readOnly}
          className="px-1.5 py-0.5 rounded hover:bg-bg-muted"
          title="Add column"
          aria-label="Add column"
        >
          +
        </button>
      </div>

      {}
      {hasFilters && onClearFilters && (
        <>
          <div className="w-px h-4 bg-border" />
          <button
            onClick={onClearFilters}
            className="px-2 py-0.5 rounded text-fg-muted hover:bg-bg-muted hover:text-fg"
            title="Clear all filters"
          >
            Clear filters
          </button>
        </>
      )}

      {}
      <div className="flex-1" />

      {}
      <div className="flex items-center gap-1">
        <button
          onClick={() => {
            void handleCopy();
          }}
          disabled={copyState === 'pending'}
          className="px-2 py-0.5 rounded text-fg-muted hover:bg-bg-muted hover:text-fg"
          title="Copy table as CSV"
        >
          {copyState === 'pending'
            ? 'Copying…'
            : copyState === 'copied'
              ? '✓ Copied'
              : copyState === 'failed'
                ? 'Retry copy'
                : 'Copy'}
        </button>
        <button
          onClick={onExportCSV}
          className="px-2 py-0.5 rounded text-fg-muted hover:bg-bg-muted hover:text-fg"
          title="Download as CSV"
        >
          Export
        </button>
      </div>

      {onReplaceTable && (
        <button
          type="button"
          disabled={readOnly}
          onClick={() => setReplacementOpen(true)}
          className="px-2 py-0.5 rounded text-fg-muted hover:bg-bg-muted hover:text-fg"
        >
          Replace table…
        </button>
      )}
      {copyState === 'failed' && (
        <span role="alert">Could not copy. Clipboard access may be unavailable. Try again.</span>
      )}

      {}
      <div className="w-px h-4 bg-border" />
      <span className="text-fg-muted/60" title="Type =SUM(A1:A5) for formulas">
        fx
      </span>
      {replacementOpen && onReplaceTable && (
        <TelemetryBlockedSurface
          as="form"
          onSubmit={handleReplace}
          aria-label="Replace table"
          className="basis-full space-y-2 rounded border border-border p-3"
          data-ph-mask="true"
        >
          <p>
            Replace all cells with pasted CSV, TSV, or an HTML table. The table name and layout are
            kept. Undo restores the previous cells and size.
          </p>
          <textarea
            aria-label="Replacement table data"
            rows={4}
            value={replacement.text}
            className="w-full rounded border border-border bg-bg p-2 text-fg"
            data-ph-mask="true"
            data-ph-no-capture="true"
            data-analytics-block="true"
            onChange={(event) => {
              setReplacement({ text: event.target.value, html: '' });
              setReplacementError(false);
            }}
            onPaste={(event) => {
              event.preventDefault();
              setReplacement({
                text:
                  event.clipboardData.getData('text/plain') || event.clipboardData.getData('text'),
                html: event.clipboardData.getData('text/html'),
              });
              setReplacementError(false);
            }}
          />
          {replacementError && (
            <p role="alert">Replacement was not confirmed. Keep this data and retry, or cancel.</p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={readOnly || (!replacement.text && !replacement.html)}
              className="rounded bg-bg-muted px-2 py-1"
            >
              Replace all cells
            </button>
            <button type="button" onClick={closeReplacement} className="rounded px-2 py-1">
              Cancel
            </button>
          </div>
        </TelemetryBlockedSurface>
      )}
    </div>
  );
}
