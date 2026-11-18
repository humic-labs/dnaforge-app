import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../presentation/PresentationSurface';
import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { TerminalFileSearchResult } from '../../shared/terminal-ipc';

export interface TerminalFileSearchProps {
  query: string;
  loading: boolean;
  autoOpen: boolean;
  hasProjects: boolean;
  result: TerminalFileSearchResult;
  error?: string;
  onQueryChange(query: string): void;
  onClose(): void;
  onOpen(path: string): void;
}

export function TerminalFileSearch({
  query,
  loading,
  autoOpen,
  hasProjects,
  result,
  error,
  onQueryChange,
  onClose,
  onOpen,
}: TerminalFileSearchProps) {
  const presentationNativeDialog = usePresentationOverlay('modal');

  const dialog = useRef<HTMLDialogElement>(null);
  const openedRequest = useRef<string | null>(null);
  const listId = useId();
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, Math.max(0, result.paths.length - 1));
  const open = useCallback(
    (path?: string) => {
      if (!path || loading || openedRequest.current === result.requestId) return;
      openedRequest.current = result.requestId;
      dialog.current?.close();

      onOpen(path);
    },
    [loading, result.requestId, onOpen]
  );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    setSelected(0);
  }, [query]);
  useEffect(() => {
    if (autoOpen && !loading && !result.incomplete && result.paths.length === 1)
      open(result.paths[0]);
  }, [autoOpen, loading, result.incomplete, result.paths, open]);
  const close = () => {
    dialog.current?.close();

    onClose();
  };
  return (
    <PresentationScopeContext.Provider value={presentationNativeDialog.scope}>
      <dialog
        ref={presentationNativeDialog.bindRef(dialog, '0')}
        data-terminal-surface
        aria-label="Find terminal file"
        className="dnaforge-terminal-command-picker bg-bg text-fg"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <div className="dnaforge-terminal-toolbar">
          <h2>Find terminal file</h2>
          <button className="wp-interactive" onClick={close}>
            Close
          </button>
        </div>
        <input
          autoFocus
          role="combobox"
          aria-label="Search project filenames"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded="true"
          aria-activedescendant={result.paths.length ? `${listId}-${index}` : undefined}
          value={query}
          maxLength={1024}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setSelected(
                result.paths.length
                  ? (index + (event.key === 'ArrowDown' ? 1 : -1) + result.paths.length) %
                      result.paths.length
                  : 0
              );
            } else if (event.key === 'Enter') {
              event.preventDefault();
              open(result.paths[index]);
            }
          }}
        />
        <div
          role="listbox"
          id={listId}
          aria-label="Matching project files"
          className="dnaforge-terminal-history"
          aria-busy={loading}
        >
          {result.paths.map((path, row) => (
            <button
              key={path}
              id={`${listId}-${row}`}
              role="option"
              aria-selected={row === index}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setSelected(row)}
              onClick={() => open(path)}
            >
              <span className="dnaforge-terminal-history-command">{path}</span>
            </button>
          ))}
          {error ? (
            <p role="alert">{toUserMessage(error, 'operation.failed')}</p>
          ) : (
            !result.paths.length && (
              <p role="status">
                {!hasProjects
                  ? 'Open a project to search its files.'
                  : loading
                    ? 'Finding files…'
                    : 'No matching files.'}
              </p>
            )
          )}
        </div>
        <div className="dnaforge-terminal-toolbar">
          <span>
            {result.incomplete
              ? 'More files may match. Narrow the search.'
              : 'Files in open projects'}
          </span>
          <button
            className="wp-interactive"
            disabled={loading || !result.paths.length}
            onClick={() => open(result.paths[index])}
          >
            Open file
          </button>
        </div>
      </dialog>
    </PresentationScopeContext.Provider>
  );
}
