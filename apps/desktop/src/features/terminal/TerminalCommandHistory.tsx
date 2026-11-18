import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../presentation/PresentationSurface';
import { toUserMessage } from '@waypoint/user-messages';
import { safeFocus } from '../../shared/utils/safeFocus';
import { useEffect, useId, useRef, useState } from 'react';
import type { TerminalCommand, TerminalHistoryData } from '../../shared/terminal-ipc';
import { historyEntriesWithPins, matchesTerminalHistory } from './terminal-history-picker';
import { useTerminalHistoryPins } from './use-terminal-history-pins';

interface HistoryEntry {
  text: string;
  cwd: string;
  status: string;
  command?: TerminalCommand;
}

export function TerminalCommandHistory({
  commands,
  history,
  pinStorageKey,
  directory,
  running,
  onPick,
  onClose,
  onKindChange,
  onViewOutput,
  onReveal,
}: {
  commands: TerminalCommand[];
  history?: TerminalHistoryData;
  pinStorageKey: string;
  directory?: string;
  running: boolean;
  onPick(text: string, execute: boolean): void;
  onClose(): void;
  onKindChange(): void;
  onViewOutput(commandId: string): void;
  onReveal(commandId: string): void;
}) {
  const presentationNativeDialog = usePresentationOverlay('modal');

  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [fuzzy, setFuzzy] = useState(false);
  const { pins, toggle: togglePin, error: pinError } = useTerminalHistoryPins(pinStorageKey);
  const seen = new Set<string>();
  const entries: HistoryEntry[] =
    directory === undefined
      ? [
          ...commands
            .slice()
            .reverse()
            .map((command) => ({
              text: command.command,
              cwd: command.cwd,
              command,
              status:
                command.finishedAt === null
                  ? 'Running'
                  : command.exitCode === null
                    ? 'Finished'
                    : `Exit ${command.exitCode}`,
            })),
          ...(history?.previousCommands ?? []).map((command) => ({
            text: command.command,
            cwd: command.cwd,
            status: 'Previous session',
          })),
          ...(history?.shellCommands ?? []).map((command) => ({
            text: command,
            cwd: '',
            status: 'Shell history',
          })),
        ].filter((entry) => {
          if (seen.has(entry.text)) return false;
          seen.add(entry.text);
          return true;
        })
      : [
          ...new Set([
            directory,
            ...commands
              .slice()
              .reverse()
              .map((command) => command.cwd),
            ...(history?.directories ?? []),
          ]),
        ].map((path) => ({ text: path, cwd: path, status: '' }));
  const matches = historyEntriesWithPins(entries, pins, query).filter((entry) =>
    matchesTerminalHistory(entry.text, query, fuzzy)
  );
  const index = Math.min(selected, Math.max(0, matches.length - 1));
  const close = () => {
    dialog.current?.close();

    onClose();
  };
  const pick = (command: (typeof entries)[number] | undefined, execute: boolean) => {
    if (!command || !running) return;
    dialog.current?.close();

    onPick(command.text, execute);
  };
  useEffect(() => {
    dialog.current?.showModal();
    safeFocus(input.current);
  }, []);
  useEffect(() => {
    document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index, listId, query]);
  return (
    <PresentationScopeContext.Provider value={presentationNativeDialog.scope}>
      <dialog
        ref={presentationNativeDialog.bindRef(dialog, '0')}
        data-terminal-surface
        aria-label={directory === undefined ? 'Run recent command' : 'Go to recent directory'}
        className="dnaforge-terminal-command-picker bg-bg text-fg"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <div className="dnaforge-terminal-toolbar">
          <h2>{directory === undefined ? 'Run recent command' : 'Go to recent directory'}</h2>
          <button className="wp-interactive" onClick={onKindChange}>
            {directory === undefined ? 'Directories' : 'Commands'}
          </button>
          <button
            className="wp-interactive"
            aria-label="Fuzzy search"
            aria-pressed={fuzzy}
            title="Match characters in order with gaps"
            onClick={() => {
              setFuzzy((value) => !value);
              setSelected(0);
              safeFocus(input.current);
            }}
          >
            Fuzzy search
          </button>
          <button
            className="wp-interactive"
            aria-label={
              directory === undefined
                ? 'Close terminal command history'
                : 'Close terminal directory history'
            }
            onClick={close}
          >
            Close
          </button>
        </div>
        <input
          ref={input}
          aria-label={
            directory === undefined
              ? 'Search terminal command history'
              : 'Search recent terminal directories'
          }
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded="true"
          aria-activedescendant={matches.length ? `${listId}-${index}` : undefined}
          autoFocus
          placeholder={directory === undefined ? 'Search commands' : 'Search directories'}
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
              pick(matches[index], !event.altKey);
            }
          }}
        />
        <div
          id={listId}
          role="listbox"
          aria-label={
            directory === undefined ? 'Recent terminal commands' : 'Recent terminal directories'
          }
          className="dnaforge-terminal-history"
        >
          {matches.map((command, row) => (
            <button
              key={row}
              id={`${listId}-${row}`}
              role="option"
              aria-selected={row === index}
              tabIndex={-1}
              disabled={!running}
              title={command.cwd}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setSelected(row)}
              onClick={(event) => pick(command, !event.altKey)}
            >
              <span className="dnaforge-terminal-history-command">{command.text}</span>
              <span>
                {command.pinned ? `Pinned${command.status ? ' · ' : ''}` : ''}
                {command.status}
              </span>
            </button>
          ))}
          {!matches.length && (
            <p role="status">
              {directory !== undefined
                ? 'No matching directories.'
                : entries.length
                  ? 'No matching commands.'
                  : 'No commands recorded for this shell type.'}
            </p>
          )}
        </div>
        {pinError && <p role="alert">{toUserMessage(pinError, 'operation.failed')}</p>}
        <div className="dnaforge-terminal-toolbar">
          <span>
            {directory === undefined ? 'Enter to run' : 'Enter to change directory'} · Alt+Enter to
            insert
          </span>
          <button
            className="wp-interactive"
            disabled={!matches.length}
            onClick={() => {
              const entry = matches[index];
              if (entry) togglePin(entry.text);
              setSelected(0);
              safeFocus(input.current);
            }}
          >
            {pins.includes(matches[index]?.text ?? '') ? 'Unpin' : 'Pin'}{' '}
            {directory === undefined ? 'command' : 'directory'}
          </button>
          {directory === undefined && (
            <>
              <button
                className="wp-interactive"
                disabled={!matches[index]?.command?.id || !matches[index]?.command?.range}
                onClick={() => {
                  const commandId = matches[index]?.command?.id;
                  if (!commandId) return;
                  dialog.current?.close();

                  onReveal(commandId);
                }}
              >
                Go to command
              </button>
              <button
                className="wp-interactive"
                disabled={matches[index]?.command?.range?.endLine === undefined}
                onClick={() => {
                  const commandId = matches[index]?.command?.id;
                  if (!commandId) return;
                  dialog.current?.close();

                  onViewOutput(commandId);
                }}
              >
                View command output
              </button>
            </>
          )}
          <button
            className="wp-interactive"
            disabled={!running || !matches.length}
            onClick={() => pick(matches[index], false)}
          >
            {directory === undefined ? 'Insert command' : 'Insert directory change'}
          </button>
          <button
            className="wp-interactive"
            disabled={!running || !matches.length}
            onClick={() => pick(matches[index], true)}
          >
            {directory === undefined ? 'Run command' : 'Change directory'}
          </button>
        </div>
      </dialog>
    </PresentationScopeContext.Provider>
  );
}
