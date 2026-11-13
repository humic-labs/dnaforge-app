import { toUserMessage } from '@waypoint/user-messages';
import { type KeyboardEvent, type MouseEvent, useEffect, useId, useRef, useState } from 'react';
import { Tooltip } from '../../shared/components/Tooltip';
import { CheckIcon, CopyIcon } from '../icons';
import { beginFileExport } from '../../lib/file-export-telemetry';

interface CopyThreadButtonProps {
  createTextMarkdown: () => string | Promise<string>;
  createDetailedMarkdown: () => string | Promise<string>;
}

type CopyMode = 'text' | 'detailed';
type CopyState =
  | { kind: 'idle' }
  | { kind: 'copying'; mode: CopyMode }
  | { kind: 'copied'; mode: CopyMode }
  | { kind: 'preparation-error'; mode: CopyMode }
  | { kind: 'clipboard-error'; mode: CopyMode };

export function CopyThreadButton({
  createTextMarkdown,
  createDetailedMarkdown,
}: CopyThreadButtonProps) {
  const [copyState, setCopyState] = useState<CopyState>({ kind: 'idle' });
  const resetTimerRef = useRef<number | null>(null);
  const errorId = useId();

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    },
    []
  );

  const copyThread = async (mode: CopyMode) => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setCopyState({ kind: 'copying', mode });
    const telemetry = beginFileExport('markdown');
    if (!navigator.clipboard?.writeText) {
      telemetry?.fail('clipboard_unavailable');
      setCopyState({ kind: 'clipboard-error', mode });
      return;
    }

    let markdown: string;
    try {
      markdown = await (mode === 'text' ? createTextMarkdown() : createDetailedMarkdown());
    } catch {
      telemetry?.fail('serialize_failed');
      setCopyState({ kind: 'preparation-error', mode });
      return;
    }

    try {
      await navigator.clipboard.writeText(markdown);
      telemetry?.complete({ status: 'completed' });
      setCopyState({ kind: 'copied', mode });
      resetTimerRef.current = window.setTimeout(() => {
        setCopyState({ kind: 'idle' });
        resetTimerRef.current = null;
      }, 2_000);
    } catch {
      telemetry?.fail('clipboard_failed');
      setCopyState({ kind: 'clipboard-error', mode });
    }
  };

  const copyDetailedFromContextGesture = (
    event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    if (copyState.kind !== 'copying') void copyThread('detailed');
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      copyDetailedFromContextGesture(event);
    }
  };

  const copied = copyState.kind === 'copied';
  const failed = copyState.kind === 'preparation-error' || copyState.kind === 'clipboard-error';
  const accessibleLabel = copied
    ? copyState.mode === 'detailed'
      ? 'Transcript with metadata copied'
      : 'Transcript copied'
    : failed
      ? 'Try copying transcript again'
      : copyState.kind === 'copying'
        ? copyState.mode === 'detailed'
          ? 'Copying transcript with metadata'
          : 'Copying transcript'
        : 'Copy transcript';
  const errorMessage =
    copyState.kind === 'preparation-error'
      ? 'Could not prepare the complete thread. Reopen the chat, then try again.'
      : 'Could not copy. Check clipboard permission, then try again.';
  const tooltipContent =
    copyState.kind === 'idle' ? (
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">Copy transcript</span>{' '}
        <span className="text-fg-muted">Right-click to copy with metadata</span>
      </span>
    ) : (
      accessibleLabel
    );
  const copiedStatus =
    copied && copyState.mode === 'detailed'
      ? 'Transcript with metadata copied!'
      : 'Transcript copied!';

  return (
    <div className="flex min-w-0 items-center justify-end gap-2" data-copy-state={copyState.kind}>
      {failed && (
        <span id={errorId} role="alert" className="min-w-0 text-right text-[11px] text-error">
          {toUserMessage(errorMessage, 'operation.failed')}
        </span>
      )}
      <Tooltip content={tooltipContent} side="top" align="end" variant="info">
        <button
          type="button"
          onClick={() => void copyThread('text')}
          onContextMenu={copyDetailedFromContextGesture}
          onKeyDown={handleKeyDown}
          disabled={copyState.kind === 'copying'}
          aria-label={accessibleLabel}
          aria-busy={copyState.kind === 'copying'}
          aria-keyshortcuts="Shift+F10 ContextMenu"
          aria-describedby={failed ? errorId : undefined}
          data-testid="copy-thread-button"
          className={`inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md transition-colors hover:bg-bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-wait disabled:opacity-60 ${
            copied ? 'text-accent' : failed ? 'text-error' : 'text-fg-subtle hover:text-fg'
          }`}
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        </button>
      </Tooltip>
      {copied && (
        <span role="status" className="sr-only">
          {copiedStatus}
        </span>
      )}
    </div>
  );
}
