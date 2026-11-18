import { useRef } from 'react';
import { MenuRow, MenuSeparator, MenuTrigger, useMenu } from '@waypoint/ui-components';
import { PortalMenu } from '../../../components/PortalMenu';
import { safeFocus } from '../../../shared/utils/safeFocus';

export interface FieldMappingOption {
  value: string;
  label: string;
  custom?: boolean;
  required?: boolean;
}

export function FieldMappingPicker({
  columnName,
  value,
  mappingMode,
  options,
  columnsByField,
  isDuplicate,
  onChange,
  onIgnore,
}: {
  columnName: string;
  value: string;
  mappingMode: 'mapped' | 'source_only' | 'ignored';
  options: readonly FieldMappingOption[];
  columnsByField: Map<string, string[]>;
  isDuplicate: boolean;
  onChange: (value: string | null) => void;
  onIgnore: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = value === '' ? undefined : options.find((option) => option.value === value);
  const isMapped = value !== '';
  const currentLabel = current?.label ?? (mappingMode === 'ignored' ? 'Ignored' : 'Custom field');
  const selectedId =
    mappingMode === 'ignored'
      ? 'action:ignore'
      : mappingMode === 'source_only'
        ? 'action:custom'
        : `option:${value}`;
  const menu = useMenu({
    items: [
      ...options.map((option) => ({ id: `option:${option.value}`, textValue: option.label })),
      { id: 'action:custom', textValue: 'Keep as custom field' },
      { id: 'action:ignore', textValue: 'Ignore this column' },
    ],
    selectedId,
    onActivate: (id) => {
      if (id === 'action:ignore') onIgnore();
      else if (id === 'action:custom') onChange(null);
      else {
        const option = options.find((candidate) => `option:${candidate.value}` === id);
        if (option) onChange(option.value === '' ? null : option.value);
      }
    },
    onFocusItem: (id) =>
      safeFocus(
        menuRef.current?.querySelector<HTMLButtonElement>(`[data-menu-item-id="${CSS.escape(id)}"]`)
      ),
  });
  const row = (id: string, testId: string, label: string, option?: FieldMappingOption) => {
    const selected = id === selectedId;
    const taken =
      option &&
      (columnsByField.get(option.value) ?? []).some((claimant) => claimant !== columnName);
    return (
      <MenuRow
        key={id}
        role="option"
        aria-selected={selected}
        data-testid={testId}
        data-menu-item-id={id}
        selected={selected}
        active={menu.activeId === id}
        tabIndex={menu.activeId === id ? 0 : -1}
        title={taken ? 'Already mapped by another column' : undefined}
        onFocus={() => menu.point(id)}
        onMouseMove={() => menu.point(id)}
        onClick={() => menu.activate(id)}
      >
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate">{label}</span>
          {option?.required ? (
            <span data-testid={`${testId}-required`} className="font-semibold text-error">
              *
            </span>
          ) : null}
          {option?.custom ? (
            <span
              data-testid={`${testId}-custom`}
              title="A custom field you added to this type (not a built-in registry field)"
              className="uppercase tracking-wide text-fg-subtle"
            >
              custom
            </span>
          ) : null}
          {taken && !selected ? (
            <span data-testid={`${testId}-inuse`} className="text-fg-subtle">
              In use
            </span>
          ) : null}
        </span>
      </MenuRow>
    );
  };

  return (
    <div className="mt-0.5 min-w-0">
      <MenuTrigger
        ref={triggerRef}
        density="compact"
        open={menu.isOpen}
        data-testid={`lims-import-colmap-${columnName}`}
        data-value={value}
        data-mapped={isMapped}
        aria-haspopup="listbox"
        aria-invalid={isDuplicate}
        aria-label={`Map column ${columnName} to a registry field`}
        icon={
          <FieldMarker
            mapped={isMapped}
            className={isDuplicate ? 'text-error' : isMapped ? 'text-accent' : 'text-fg-subtle'}
          />
        }
        onClick={() => (menu.isOpen ? menu.close('trigger') : menu.openMenu())}
        onKeyDown={menu.handleKeyDown}
      >
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate">{currentLabel}</span>
          {isMapped && current?.custom ? (
            <span
              data-testid={`lims-import-colmap-${columnName}-customtag`}
              className="uppercase tracking-wide text-fg-subtle"
            >
              custom
            </span>
          ) : null}
        </span>
      </MenuTrigger>
      <PortalMenu
        menu={menu}
        open={menu.isOpen}
        anchorRef={triggerRef}
        surfaceRef={menuRef}
        onRequestClose={menu.close}
        role="listbox"
        aria-label={`Registry fields for ${columnName}`}
        data-testid={`lims-import-colmenu-${columnName}`}
        density="compact"
        selection
        preferredSide="bottom"
        horizontalAlign="start"
        layout={{ minWidth: 216, maxHeight: '18rem' }}
      >
        {options.map((option) =>
          row(
            `option:${option.value}`,
            `lims-import-colopt-${columnName}-${option.value}`,
            option.label,
            option
          )
        )}
        <MenuSeparator />
        {row('action:custom', `lims-import-colopt-${columnName}-note`, 'Keep as custom field')}
        {row('action:ignore', `lims-import-colopt-${columnName}-ignore`, 'Ignore this column')}
      </PortalMenu>
    </div>
  );
}

function FieldMarker({ mapped, className = '' }: { mapped: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width="12"
      height="12"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {mapped ? (
        <path d="M6 1.5 10.5 6 6 10.5 1.5 6Z" fill="currentColor" stroke="none" />
      ) : (
        <circle cx="6" cy="6" r="4" strokeDasharray="2 1.6" />
      )}
    </svg>
  );
}
