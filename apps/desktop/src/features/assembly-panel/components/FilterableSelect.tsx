'use client';

import { useLayoutEffect, useId, useMemo, useRef, useState } from 'react';
import { MenuRow, MenuSearchInput, MenuStatus, useMenu } from '@waypoint/ui-components';
import { PortalMenu } from '../../../components/PortalMenu';
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
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const previousQuery = useRef(query);
  const selectedLabel = options.find((option) => option.value === value)?.label ?? '';
  const visible = useMemo(() => filterOptions(options, query), [options, query]);
  const menu = useMenu({
    items: visible.map((option) => ({ id: option.value, textValue: option.label, disabled })),
    selectedId: value,
    onClose: () => setQuery(''),
    onActivate: (id) => {
      if (id !== value) onChange(id);
    },
  });
  useLayoutEffect(() => {
    if (previousQuery.current !== query) {
      previousQuery.current = query;
      if (visible[0]) menu.point(visible[0].value);
    }
  }, [query, visible, menu.point]);
  const openList = () => {
    if (!disabled && !menu.isOpen) menu.openMenu(value);
  };
  return (
    <div className="relative min-w-0 flex-1" data-testid={testId}>
      <MenuSearchInput
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={menu.isOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          menu.isOpen && menu.activeId !== null ? `${listId}-${menu.activeId}` : undefined
        }
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={menu.isOpen ? query : selectedLabel}
        placeholder={menu.isOpen ? selectedLabel || placeholder : placeholder}
        onMouseDown={(event) => {
          if (menu.isOpen) return;
          event.preventDefault();
          safeFocus(inputRef.current);
          openList();
        }}
        onFocus={openList}
        onChange={(event) => {
          setQuery(event.target.value);
          openList();
        }}
        onBlur={() => menu.close('handoff')}
        onKeyDown={menu.handleKeyDown}
      />
      <PortalMenu
        id={listId}
        menu={menu}
        open={menu.isOpen}
        anchorRef={inputRef}
        role="listbox"
        aria-label={label}
        preferredSide="bottom"
        horizontalAlign="start"
        selection
        onRequestClose={menu.close}
      >
        {visible.length === 0 ? <MenuStatus>{emptyMessage}</MenuStatus> : null}
        {visible.map((option) => (
          <MenuRow
            key={option.value}
            id={`${listId}-${option.value}`}
            role="option"
            aria-selected={option.value === value}
            selected={option.value === value}
            active={menu.activeId === option.value}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onPointerMove={() => menu.point(option.value)}
            onClick={() => menu.activate(option.value)}
            description={option.hint}
          >
            {option.label}
          </MenuRow>
        ))}
      </PortalMenu>
    </div>
  );
}
