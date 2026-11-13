'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { safeFocus } from '../../../shared/utils/safeFocus';

export interface FilterableSelectOption {
  value: string;
  label: string;
  hint?: string;
}

export interface FilterableSelectProps {
  label: string;
  value: string;
  options: FilterableSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  testId?: string;
  emptyMessage?: string;
}

function filterOptions(options: FilterableSelectOption[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options
    .map((option) => {
      const haystacks = [option.label, option.hint ?? ''];
      const positions = haystacks
        .map((text) => text.toLowerCase().indexOf(needle))
        .filter((index) => index >= 0);
      return positions.length ? { option, rank: Math.min(...positions) } : null;
    })
    .filter((entry): entry is { option: FilterableSelectOption; rank: number } => entry !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.option);
}

export function FilterableSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = 'Choose…',
  testId,
  emptyMessage = 'No matches',
}: FilterableSelectProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedLabel = options.find((option) => option.value === value)?.label ?? '';
  const visible = useMemo(() => filterOptions(options, query), [options, query]);
  const activeIndex = visible.findIndex((option) => option.value === activeValue);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const commit = (option: FilterableSelectOption) => {
    setOpen(false);
    setQuery('');
    if (option.value !== value) onChange(option.value);
  };

  const openList = () => {
    if (disabled || open) return;
    setOpen(true);
    setActiveValue(value || (options[0]?.value ?? null));
  };

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1" data-testid={testId}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={open ? query : selectedLabel}
        placeholder={open ? selectedLabel || placeholder : placeholder}
        className="h-8 w-full min-w-0 rounded border border-border bg-bg px-2 text-xs text-fg outline-none focus:border-accent disabled:opacity-60"
        onMouseDown={(event) => {
          if (open) return;
          event.preventDefault();
          safeFocus(inputRef.current);
          openList();
        }}
        onFocus={openList}
        onChange={(event) => {
          setQuery(event.target.value);
          if (!open) setOpen(true);
          const next = filterOptions(options, event.target.value);
          setActiveValue(next[0]?.value ?? null);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            if (!open) return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            return;
          }
          if (event.key === 'Enter') {
            if (!open) return;
            event.preventDefault();
            if (activeIndex >= 0) commit(visible[activeIndex]);
            return;
          }
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          if (!open) {
            openList();
            return;
          }
          if (!visible.length) return;
          const next =
            event.key === 'ArrowDown'
              ? Math.min(activeIndex + 1, visible.length - 1)
              : activeIndex < 0
                ? visible.length - 1
                : Math.max(0, activeIndex - 1);
          setActiveValue(visible[next].value);
        }}
      />
      {}
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute left-0 right-0 top-9 z-50 max-h-56 overflow-y-auto overscroll-contain rounded border border-border bg-bg p-1 shadow-lg"
        >
          {visible.length === 0 ? (
            <p className="px-2 py-3 text-center text-[11px] text-fg-muted">{emptyMessage}</p>
          ) : null}
          {visible.map((option, index) => (
            <button
              key={option.value}
              type="button"
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onPointerMove={() => setActiveValue(option.value)}
              onClick={() => commit(option)}
              className={`flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-bg-muted ${
                index === activeIndex ? 'bg-bg-muted ring-1 ring-inset ring-accent/40' : ''
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-fg">{option.label}</span>
              {option.hint ? (
                <span className="shrink-0 truncate text-[11px] text-fg-muted">{option.hint}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
