import { toUserMessage, type UserMessage } from '@waypoint/user-messages';
import { useId, useRef, useState, type ReactNode } from 'react';
import { MenuRow, MenuSearchInput, MenuTrigger, useMenu } from '@waypoint/ui-components';
import { PortalMenu } from '../../components/PortalMenu';
import { safeFocus } from '../utils/safeFocus';

export type DownwardSelectOption<T extends string> = {
  value: T;
  label: string;
  labelNode?: ReactNode;
  detail?: UserMessage | null;
  emphasis?: boolean;
  warn?: boolean;
  testId?: string;
  data?: Record<string, string>;
};

export function DownwardSelect<T extends string>({
  value,
  label,
  warn = false,
  warnIcon,
  options,
  onChange,
  disabled = false,
  title,
  testId,
  ariaLabel,
  privateContent = false,
  searchable = false,
  searchLabel = 'Search options',
}: {
  value: T;
  label: string;
  warn?: boolean;
  warnIcon?: ReactNode;
  options: readonly DownwardSelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  title?: string;
  testId?: string;
  ariaLabel?: string;
  privateContent?: boolean;
  searchable?: boolean;
  searchLabel?: string;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const filteredOptions =
    searchable && search.trim()
      ? options.filter((option) => option.label.toLowerCase().includes(search.trim().toLowerCase()))
      : options;
  const menu = useMenu({
    items: filteredOptions.map((option) => ({
      id: option.value,
      textValue: option.label,
      disabled,
    })),
    selectedId: value,
    onActivate: (next) => {
      const option = options.find((candidate) => candidate.value === next);
      if (option) onChange(option.value);
    },
    onFocusItem: searchable
      ? undefined
      : (next) =>
          safeFocus(
            menuRef.current?.querySelector<HTMLButtonElement>(
              `[data-menu-item-id="${CSS.escape(next)}"]`
            )
          ),
  });

  return (
    <div className="relative min-w-0 max-w-full">
      <MenuTrigger
        ref={triggerRef}
        density="compact"
        data-testid={testId}
        data-value={value}
        aria-haspopup={searchable ? 'dialog' : 'listbox'}
        aria-expanded={menu.isOpen}
        open={menu.isOpen}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => {
          if (menu.isOpen) menu.close('trigger');
          else {
            setSearch('');
            menu.openMenu(value);
          }
        }}
        onKeyDown={menu.handleKeyDown}
      >
        {label}
        {warn && warnIcon ? (
          <span data-testid={testId ? `${testId}-warn` : undefined}>{warnIcon}</span>
        ) : null}
      </MenuTrigger>
      <PortalMenu
        density="compact"
        selection
        menu={menu}
        open={menu.isOpen}
        anchorRef={triggerRef}
        surfaceRef={menuRef}
        initialFocusRef={searchable ? searchRef : undefined}
        role={searchable ? 'dialog' : 'listbox'}
        aria-label={ariaLabel}
        onRequestClose={menu.close}
        preferredSide="bottom"
        allowFlip={false}
        horizontalAlign="start"
        data-testid={testId ? `${testId}-menu` : undefined}
        privateContent={privateContent}
      >
        {searchable ? (
          <div className="sticky top-0 z-10 bg-bg p-1">
            <MenuSearchInput
              ref={searchRef}
              type="search"
              role="combobox"
              aria-label={searchLabel}
              aria-expanded={menu.isOpen}
              aria-controls={`${id}-options`}
              aria-activedescendant={menu.activeId !== null ? `${id}-${menu.activeId}` : undefined}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        ) : null}
        <div
          id={`${id}-options`}
          role={searchable ? 'listbox' : 'presentation'}
          aria-label={searchable ? ariaLabel : undefined}
        >
          {filteredOptions.map((option) => (
            <MenuRow
              key={option.value}
              id={`${id}-${option.value}`}
              role="option"
              aria-selected={option.value === value}
              selected={option.value === value}
              active={option.value === menu.activeId}
              tabIndex={searchable ? -1 : menu.activeId === option.value ? 0 : -1}
              data-menu-item-id={option.value}
              data-testid={option.testId}
              data-value={option.value}
              {...option.data}
              onPointerMove={() => menu.point(option.value)}
              onMouseDown={searchable ? (event) => event.preventDefault() : undefined}
              onClick={() => menu.activate(option.value)}
              description={
                option.detail ? (
                  <span>
                    {option.warn ? warnIcon : null}
                    {toUserMessage(option.detail, 'operation.failed')}
                  </span>
                ) : undefined
              }
            >
              <span className={option.emphasis ? 'font-medium text-accent' : undefined}>
                {option.labelNode ?? option.label}
              </span>
            </MenuRow>
          ))}
          {filteredOptions.length === 0 ? (
            <div role="status" className="px-3 py-2 text-xs text-fg-muted">
              No matches
            </div>
          ) : null}
        </div>
      </PortalMenu>
    </div>
  );
}
