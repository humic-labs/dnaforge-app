import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../presentation/PresentationSurface';
import { useEffect, useId, useRef, useState } from 'react';
import type { ILink } from '@xterm/xterm';
import type { DetectedTerminalLinks } from './terminal-detected-links';

export interface TerminalLinksProps {
  result: DetectedTerminalLinks;
  loading: boolean;
  all: boolean;
  onExpand(): void;
  onClose(): void;
  onOpen(link: ILink): void;
}

export function TerminalLinks({
  result,
  loading,
  all,
  onExpand,
  onClose,
  onOpen,
}: TerminalLinksProps) {
  const presentationNativeDialog = usePresentationOverlay('modal');

  const dialog = useRef<HTMLDialogElement>(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const matches = result.links.filter((link) =>
    link.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  );
  const index = Math.min(selected, Math.max(0, matches.length - 1));
  const close = () => {
    dialog.current?.close();

    onClose();
  };
  const open = (link?: ILink) => {
    if (link) {
      dialog.current?.close();

      onOpen(link);
    }
  };
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index, listId, query]);
  return (
    <PresentationScopeContext.Provider value={presentationNativeDialog.scope}>
      <dialog
        ref={presentationNativeDialog.bindRef(dialog, '0')}
        data-terminal-surface
        aria-label="Open detected terminal link"
        className="dnaforge-terminal-command-picker bg-bg text-fg"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <div className="dnaforge-terminal-toolbar">
          <h2>Open detected link</h2>
          <button className="wp-interactive" onClick={close}>
            Close
          </button>
        </div>
        <input
          autoFocus
          role="combobox"
          aria-label="Search detected terminal links"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded="true"
          aria-activedescendant={matches.length ? `${listId}-${index}` : undefined}
          placeholder="Search links"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setSelected(
                matches.length
                  ? (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length
                  : 0
              );
            } else if (event.key === 'Enter') {
              event.preventDefault();
              open(matches[index]);
            }
          }}
        />
        <div
          role="listbox"
          id={listId}
          aria-label="Detected terminal links"
          className="dnaforge-terminal-history"
        >
          {matches.map((link, row) => (
            <button
              key={`${link.range.start.y}:${link.range.start.x}:${link.text}`}
              id={`${listId}-${row}`}
              role="option"
              aria-selected={row === index}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setSelected(row)}
              onClick={() => open(link)}
            >
              <span className="dnaforge-terminal-history-command">{link.text}</span>
              <span>
                {link.kind === 'search'
                  ? 'Search files'
                  : /^https?:/i.test(link.text)
                    ? 'Web'
                    : 'Local'}
              </span>
            </button>
          ))}
          {!matches.length && (
            <p role="status">{loading ? 'Finding links…' : 'No matching links.'}</p>
          )}
        </div>
        <div className="dnaforge-terminal-toolbar">
          <span>
            {result.atLimit
              ? 'Showing at most 1,000 links'
              : all
                ? 'Scrollback links'
                : 'Visible links'}
          </span>
          {!all && (
            <button className="wp-interactive" disabled={loading} onClick={onExpand}>
              Search scrollback
            </button>
          )}
          <button
            className="wp-interactive"
            disabled={!matches.length}
            onClick={() => open(matches[index])}
          >
            Open link
          </button>
        </div>
      </dialog>
    </PresentationScopeContext.Provider>
  );
}
