import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import { safeFocus } from '../../shared/utils/safeFocus';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { SearchAddon, ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search';

export interface TerminalSearchContext {
  terminal: Pick<Terminal, 'textarea' | 'getSelection'>;
  search: Pick<
    SearchAddon,
    'findNext' | 'findPrevious' | 'clearDecorations' | 'onDidChangeResults'
  >;
}

export function TerminalSearch({
  request,
  context,
  onClose,
}: {
  request: number;
  context: TerminalSearchContext;
  onClose(): void;
}) {
  const { terminal, search } = context;
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [results, setResults] = useState<ISearchResultChangeEvent>({
    resultIndex: -1,
    resultCount: 0,
  });
  const [error, setError] = useState('');
  const find = useCallback(
    (backward = false, incremental = false) => {
      if (!query) {
        search.clearDecorations();
        setResults({ resultIndex: -1, resultCount: 0 });
        setError('');
        return;
      }
      try {
        if (regex) new RegExp(query);
        setError('');
        const options: ISearchOptions = {
          caseSensitive,
          regex,
          wholeWord,
          incremental,
          decorations: {
            matchBorder: '#6488dd',
            matchOverviewRuler: '#6488dd',
            activeMatchBorder: '#cba54b',
            activeMatchColorOverviewRuler: '#cba54b',
          },
        };
        search[backward ? 'findPrevious' : 'findNext'](query, options);
      } catch (failure) {
        search.clearDecorations();
        setResults({ resultIndex: -1, resultCount: 0 });
        setError(
          failure instanceof SyntaxError
            ? userMessage('sequenceSearch.invalidPattern')
            : toUserMessage(failure, 'operation.failed')
        );
      }
    },
    [query, regex, caseSensitive, wholeWord, search]
  );
  useEffect(() => {
    const listener = search.onDidChangeResults(setResults);
    return () => {
      listener.dispose();
      search.clearDecorations();
    };
  }, [search]);
  useEffect(() => {
    if (!request) {
      search.clearDecorations();
      return;
    }
    const selected = terminal.getSelection();
    if (selected && !/[\r\n]/.test(selected)) setQuery(selected);
    safeFocus(input.current);
    input.current?.select();
  }, [request, terminal, search]);
  useEffect(() => {
    if (request) {
      search.clearDecorations();
      find(false, true);
    }
  }, [request, find, search]);
  const close = () => {
    search.clearDecorations();
    onClose();
    safeFocus(terminal.textarea, { preventScroll: true });
  };
  if (!request) return null;
  return (
    <div
      className="dnaforge-terminal-toolbar dnaforge-terminal-search bg-bg text-fg"
      role="search"
      aria-label="Search terminal output"
    >
      <input
        ref={input}
        aria-label="Find terminal text"
        aria-invalid={Boolean(error)}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            find(event.shiftKey);
          } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
            event.preventDefault();
            event.stopPropagation();
            input.current?.select();
          }
        }}
      />
      <button
        className="wp-interactive"
        aria-label="Match case"
        aria-pressed={caseSensitive}
        onClick={() => setCaseSensitive((value) => !value)}
      >
        Aa
      </button>
      <button
        className="wp-interactive"
        aria-label="Match whole word"
        aria-pressed={wholeWord}
        onClick={() => setWholeWord((value) => !value)}
      >
        Word
      </button>
      <button
        className="wp-interactive"
        aria-label="Use regular expression"
        aria-pressed={regex}
        onClick={() => setRegex((value) => !value)}
      >
        .*
      </button>
      <span role="status" aria-live="polite">
        {error
          ? toUserMessage(error, 'failure.no-matches')
          : !query
            ? ''
            : !results.resultCount
              ? userMessage('failure.no-matches')
              : userMessageWithValues('notice.value-of-valuevalue', {
                  value0: userMessageValue(results.resultIndex < 0 ? '–' : results.resultIndex + 1),
                  value1: userMessageValue(results.resultCount),
                  value2: userMessageValue(results.resultCount === 1000 ? ' (limit)' : ''),
                })}
      </span>
      <button
        className="wp-interactive"
        aria-label="Previous terminal match"
        disabled={!query || Boolean(error)}
        onClick={() => find(true)}
      >
        ↑
      </button>
      <button
        className="wp-interactive"
        aria-label="Next terminal match"
        disabled={!query || Boolean(error)}
        onClick={() => find()}
      >
        ↓
      </button>
      <button className="wp-interactive" aria-label="Close terminal search" onClick={close}>
        ×
      </button>
    </div>
  );
}
