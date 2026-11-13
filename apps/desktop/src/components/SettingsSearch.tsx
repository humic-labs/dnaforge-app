import { useId, useRef, type KeyboardEvent } from 'react';
import { safeFocus } from '../shared/utils/safeFocus';
import { SETTINGS_FIELD_CLASS, SETTINGS_SECONDARY_BUTTON_CLASS } from './SettingsSubsection';
import { SETTINGS_SECTIONS, type SettingsSearchResult } from './settings-catalog';

export function SettingsSearch({
  query,
  onQueryChange,
  results,
  groups,
  onSelect,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  results: SettingsSearchResult[];
  groups: ReadonlyMap<string, string>;
  onSelect: (result: SettingsSearchResult) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const resultsId = useId();
  const searching = query.trim().length > 0;
  const clear = () => {
    onQueryChange('');
    safeFocus(inputRef.current, { preventScroll: true });
  };
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && query) {
      event.preventDefault();
      event.stopPropagation();
      clear();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const buttons = Array.from(
        resultsRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []
      );
      if (!buttons.length) return;
      event.preventDefault();
      event.stopPropagation();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = index + (event.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) safeFocus(inputRef.current, { preventScroll: true });
      else safeFocus(buttons[Math.min(next, buttons.length - 1)]);
    } else if (event.key === 'Enter' && event.target === inputRef.current && results[0]) {
      event.preventDefault();
      event.stopPropagation();
      onSelect(results[0]);
    }
  }
  return (
    <div className="mb-5" onKeyDown={handleKeyDown} role="search" aria-label="Settings">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="search"
          aria-label="Search settings"
          placeholder="Search settings…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          aria-controls={searching ? resultsId : undefined}
          className={SETTINGS_FIELD_CLASS}
        />
        {query ? (
          <button type="button" onClick={clear} className={SETTINGS_SECONDARY_BUTTON_CLASS}>
            Clear
          </button>
        ) : null}
      </div>
      {searching ? (
        <div id={resultsId} ref={resultsRef} className="mt-3">
          <p role="status" className="mb-2 text-xs text-fg-muted">
            {results.length
              ? `${results.length} ${results.length === 1 ? 'result' : 'results'}`
              : 'No settings found.'}
          </p>
          <ul className="space-y-1" aria-label="Settings search results">
            {results.map((result) => (
              <li key={result.id}>
                <button
                  type="button"
                  onClick={() => onSelect(result)}
                  data-settings-result={result.id}
                  className="w-full rounded-md bg-black/[0.025] p-3 text-left hover:bg-black/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 dark:bg-white/[0.035] dark:hover:bg-white/[0.075]"
                >
                  <span className="block text-xs text-fg-muted">
                    {groups.get(result.section)} · {SETTINGS_SECTIONS[result.section].label}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm font-medium text-fg">{result.title}</span>
                    {result.scope ? (
                      <span className="text-xs text-fg-muted">{result.scope}</span>
                    ) : null}
                    {!result.available ? (
                      <span className="text-xs text-fg-muted">Not available yet</span>
                    ) : null}
                  </span>
                  {result.description ? (
                    <span className="mt-1 block text-xs leading-5 text-fg-muted">
                      {result.description}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
