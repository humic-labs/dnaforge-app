import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { CheckIcon, SearchIcon, XIcon } from '../../../../../components/icons';
import { safeFocus } from '../../../../../shared/utils/safeFocus';
import type { molViewSpecStorySteps } from '../utils/molViewSpecStory';

const ROW_HEIGHT = 28;
const OVERSCAN = 3;
const MAX_VIEWPORT_HEIGHT = 340;

export function MolecularViewLibrary({
  steps,
  activeIndex,
  disabled,
  onSelect,
  onClose,
}: {
  steps: ReturnType<typeof molViewSpecStorySteps>;
  activeIndex: number;
  disabled: boolean;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(activeIndex);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(MAX_VIEWPORT_HEIGHT);
  const search = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const listId = useId();
  const showSearch = steps.length > 8;
  const matches = useMemo(() => {
    const terms = (showSearch ? query : '').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return steps.filter((step) => {
      const text = `${step.index + 1} ${step.title} ${step.description ?? ''}`.toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }, [steps, query, showSearch]);
  const focusIndex = Math.max(0, Math.min(matches.length - 1, focused));
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(matches.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  useEffect(() => {
    safeFocus(search.current ?? viewport.current, { preventScroll: true });
    const element = viewport.current;
    if (!element) return;
    const measure = () =>
      setHeight(Math.min(element.clientHeight || MAX_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [showSearch]);

  const reveal = useCallback(
    (index: number) => {
      const element = viewport.current;
      if (!element) return;
      const top = index * ROW_HEIGHT;
      const actualHeight = Math.min(element.clientHeight || height, MAX_VIEWPORT_HEIGHT);
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + ROW_HEIGHT > element.scrollTop + actualHeight)
        element.scrollTop = Math.max(0, top + ROW_HEIGHT - actualHeight);
      setScrollTop(element.scrollTop);
    },
    [height]
  );
  useLayoutEffect(() => {
    const selected = matches.findIndex((step) => step.index === activeIndex);
    if (selected < 0) return;
    setFocused(selected);
    reveal(selected);
  }, [activeIndex, matches, reveal]);

  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    let next = focusIndex;
    if (event.key === 'ArrowDown') next += 1;
    else if (event.key === 'ArrowUp') next -= 1;
    else if (event.key === 'PageDown') next += Math.max(1, Math.floor(height / ROW_HEIGHT));
    else if (event.key === 'PageUp') next -= Math.max(1, Math.floor(height / ROW_HEIGHT));
    else if (event.key === 'Home' && !query) next = 0;
    else if (event.key === 'End' && !query) next = matches.length - 1;
    else if (event.key === 'Enter') {
      event.preventDefault();
      if (!disabled && matches[focusIndex]) onSelect(matches[focusIndex].index);
      return;
    } else return;
    event.preventDefault();
    setKeyboardFocus(true);
    next = Math.max(0, Math.min(matches.length - 1, next));
    setFocused(next);
    reveal(next);
  };

  return (
    <section
      role="region"
      aria-label="View library"
      data-testid="molecular-view-library"
      className="pointer-events-auto flex min-h-0 w-full shrink-0 flex-col overflow-hidden rounded-md border border-border/60 bg-bg/95 p-1 text-xs shadow-sm"
      style={{
        height: Math.min(
          MAX_VIEWPORT_HEIGHT,
          Math.max(matches.length, 1) * ROW_HEIGHT +
            10 +
            (showSearch ? 36 : 0) +
            (showSearch && query ? 18 : 0)
        ),
        maxHeight: '100%',
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={() => setKeyboardFocus(false)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        } else if (event.target === search.current || event.target === viewport.current)
          keyDown(event);
      }}
    >
      {showSearch ? (
        <div className="relative mb-1 shrink-0">
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              title="Clear search"
              onClick={() => {
                setQuery('');
                safeFocus(search.current, { preventScroll: true });
              }}
              className="absolute right-1 top-1 z-10 rounded p-1 text-fg-muted wp-interactive "
            >
              <XIcon size={12} />
            </button>
          )}
          <SearchIcon
            size={14}
            className="pointer-events-none absolute left-2 top-2 text-fg-subtle"
          />
          <input
            ref={search}
            role="combobox"
            aria-label="Search views"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              matches[focusIndex] && focusIndex >= first && focusIndex < last
                ? `${listId}-${matches[focusIndex].index}`
                : undefined
            }
            placeholder="Search views…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setFocused(0);
              if (viewport.current) viewport.current.scrollTop = 0;
              setScrollTop(0);
            }}
            className="h-8 w-full rounded border-0 bg-bg-muted/70 pl-7 pr-7 text-xs text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/30"
          />
        </div>
      ) : null}
      {showSearch && query && (
        <p role="status" className="shrink-0 px-2 py-0.5 text-[10px] text-fg-subtle">
          {`${matches.length} of ${steps.length} views`}
        </p>
      )}
      <div
        ref={viewport}
        id={listId}
        role="listbox"
        aria-label="Visualization views"
        tabIndex={showSearch ? -1 : 0}
        aria-activedescendant={
          !showSearch && matches[focusIndex] && focusIndex >= first && focusIndex < last
            ? `${listId}-${matches[focusIndex].index}`
            : undefined
        }
        data-testid="molecular-view-list"
        className="structure-color-legend min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-none"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {matches.length ? (
          <div className="relative" style={{ height: matches.length * ROW_HEIGHT }}>
            {matches.slice(first, last).map((step, offset) => {
              const current = activeIndex === step.index;
              return (
                <button
                  key={step.index}
                  id={`${listId}-${step.index}`}
                  role="option"
                  type="button"
                  tabIndex={-1}
                  aria-selected={activeIndex === step.index}
                  aria-label={step.title}
                  aria-posinset={first + offset + 1}
                  aria-setsize={matches.length}
                  data-view-index={step.index}
                  data-keyboard-focused={
                    (keyboardFocus && focusIndex === first + offset) || undefined
                  }
                  disabled={disabled}
                  title={[step.title, step.description].filter(Boolean).join('\n')}
                  onClick={() => onSelect(step.index)}
                  className={`absolute left-0 flex w-full min-w-0 cursor-pointer items-center gap-2 rounded px-2 text-left text-fg-muted wp-interactive active:bg-black/[0.1] dark:active:bg-white/[0.13] ${current ? 'bg-bg-muted/70 font-medium text-fg' : ''} ${keyboardFocus && focusIndex === first + offset ? 'bg-bg-muted ring-1 ring-inset ring-accent/50' : ''} disabled:cursor-default disabled:opacity-40`}
                  style={{ top: (first + offset) * ROW_HEIGHT, height: ROW_HEIGHT }}
                >
                  <span
                    data-view-number
                    aria-hidden="true"
                    className="shrink-0 text-right text-[10px] tabular-nums text-fg-subtle"
                    style={{ minWidth: `${String(steps.length).length}ch` }}
                  >
                    {step.index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs leading-4">{step.title}</span>
                  <span className="w-3.5 shrink-0 text-accent" aria-hidden="true">
                    {current && <CheckIcon size={14} />}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="flex h-7 items-center justify-center px-2 text-xs text-fg-muted">
            No matching views
          </p>
        )}
      </div>
    </section>
  );
}
