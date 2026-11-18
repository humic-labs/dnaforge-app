import { safeFocus } from '../../../../shared/utils/safeFocus';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PortalMenu } from '../../../../components/PortalMenu';
import { Button, TextField } from '../../../../components/ui';
import { UI_SECONDARY_BUTTON_CLASS, UI_SURFACE_CLASS } from '../../../../components/ui/styles';
import { RegistryFilterPopover, type RegistryUpdatedFilter } from './RegistryFilterPopover';

export interface RegistryFilterChoice {
  value: string;
  label: string;
  count?: number;
}

export interface RegistryFilterFacet {
  key: string;
  label: string;
  searchLabel: string;
  options: RegistryFilterChoice[];
  selected: string[];
  onChange: (values: string[]) => void;
  single?: boolean;
  context?: boolean;
  defaultValue?: string;
  description?: string;
}

interface RegistryFilterChip {
  key: string;
  label: string;
  remove?: () => void;
  edit: () => void;
}

export function RegistryFilterChoices({ facet }: { facet: RegistryFilterFacet }) {
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setSearch('');
    safeFocus(inputRef.current, { preventScroll: true });
  }, [facet.key]);
  const normalized = search.trim().toLocaleLowerCase();
  const options = facet.options.filter((option) =>
    option.label.toLocaleLowerCase().includes(normalized)
  );
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <TextField
        ref={inputRef}
        type="search"
        aria-label={facet.searchLabel}
        placeholder={facet.searchLabel}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {facet.description ? (
        <p className="text-xs leading-5 text-fg-muted">{facet.description}</p>
      ) : null}
      <div className="max-h-64 space-y-0.5 overflow-y-auto" role="group" aria-label={facet.label}>
        {!facet.context ? (
          <button
            type="button"
            onClick={() => facet.onChange([])}
            className="mb-1 flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-fg-muted wp-interactive "
          >
            <span>Any {facet.label.toLocaleLowerCase()}</span>
            {facet.selected.length === 0 ? <span aria-hidden>✓</span> : null}
          </button>
        ) : null}
        {options.map((option) => (
          <label
            key={option.value}
            className={`flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-xs wp-interactive ${facet.selected.includes(option.value) ? 'bg-accent/5 text-fg' : 'text-fg-muted'}`}
          >
            <input
              type={facet.single ? 'radio' : 'checkbox'}
              name={facet.single ? `registry-filter-${facet.key}` : undefined}
              value={option.value}
              className="h-3.5 w-3.5 shrink-0 accent-accent"
              checked={facet.selected.includes(option.value)}
              onChange={() =>
                facet.onChange(
                  facet.single
                    ? [option.value]
                    : facet.selected.includes(option.value)
                      ? facet.selected.filter((value) => value !== option.value)
                      : [...facet.selected, option.value]
                )
              }
            />
            <span className="min-w-0 flex-1 break-words">{option.label}</span>
            {option.count !== undefined ? (
              <span aria-hidden className="text-fg-subtle">
                {option.count}
              </span>
            ) : null}
          </label>
        ))}
        {options.length === 0 ? (
          <p role="status" className="px-2 py-4 text-xs text-fg-muted">
            No matching choices
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function RegistryFilters({
  facets,
  textFilters,
  onTextFilterChange,
  updatedFilter,
  onUpdatedFilterChange,
  showArchived,
  onShowArchivedChange,
  unresolvedOnly,
  unresolvedCount,
  onUnresolvedChange,
  search,
  onClearSearch,
  onClearAll,
  open,
  onOpenChange,
  footer,
  actions,
}: {
  facets: RegistryFilterFacet[];
  textFilters: Record<string, string>;
  onTextFilterChange: (key: string, value: string) => void;
  updatedFilter?: RegistryUpdatedFilter | null;
  onUpdatedFilterChange?: React.Dispatch<React.SetStateAction<RegistryUpdatedFilter | null>>;
  showArchived: boolean;
  onShowArchivedChange: (value: boolean) => void;
  unresolvedOnly?: boolean;
  unresolvedCount?: number;
  onUnresolvedChange?: (value: boolean) => void;
  search: string;
  onClearSearch: () => void;
  onClearAll: () => void;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  footer?: ReactNode;
  actions?: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [activeKey, setActiveKey] = useState('project');
  const activeFacet = facets.find((facet) => facet.key === activeKey);
  useEffect(() => {
    if (
      !facets.some((facet) => facet.key === activeKey) &&
      !['text', 'updated', 'more'].includes(activeKey)
    )
      setActiveKey('project');
  }, [activeKey, facets]);
  const close = () => {
    onOpenChange(false);
    safeFocus(triggerRef.current, { preventScroll: true });
  };
  const edit = (key: string) => {
    setActiveKey(key);
    onOpenChange(true);
  };
  const chips: RegistryFilterChip[] = facets.flatMap((facet) =>
    facet.selected.flatMap((value) =>
      facet.context && value === facet.defaultValue
        ? []
        : [
            {
              key: `${facet.key}:${value}`,
              label: `${facet.context ? '' : `${facet.label}: `}${facet.options.find((option) => option.value === value)?.label ?? value}`,
              remove: facet.context
                ? undefined
                : () => facet.onChange(facet.selected.filter((item) => item !== value)),
              edit: () => edit(facet.key),
            },
          ]
    )
  );
  for (const [key, value] of Object.entries(textFilters)) {
    if (!value.trim()) continue;
    chips.push({
      key: `text:${key}`,
      label: `${key === 'registryId' ? 'ID' : key === 'name' ? 'Name' : 'Sequence'} contains “${value}”`,
      remove: () => onTextFilterChange(key, ''),
      edit: () => edit('text'),
    });
  }
  if (search.trim())
    chips.push({
      key: 'search',
      label: `Search: ${search}`,
      remove: onClearSearch,
      edit: () => edit('text'),
    });
  if (updatedFilter?.date)
    chips.push({
      key: 'updated',
      label: `Updated ${updatedFilter.mode} ${updatedFilter.date}`,
      remove: () => onUpdatedFilterChange?.(null),
      edit: () => edit('updated'),
    });
  if (showArchived)
    chips.push({
      key: 'archived',
      label: 'Including archived',
      remove: () => onShowArchivedChange(false),
      edit: () => edit('more'),
    });
  if (unresolvedOnly)
    chips.push({
      key: 'unresolved',
      label: 'Unresolved links',
      remove: () => onUnresolvedChange?.(false),
      edit: () => edit('more'),
    });
  const count = chips.filter((chip) => chip.remove).length;
  return (
    <div
      data-testid="lims-registry-filters"
      className="flex flex-wrap items-center gap-1.5 px-4 py-2"
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label="Filters"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className={`inline-flex items-center gap-2 ${UI_SECONDARY_BUTTON_CLASS}`}
      >
        <svg
          aria-hidden
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
        >
          <path d="M2 4h12M2 8h12M2 12h12" />
          <path d="M5 2v4M11 6v4M6 10v4" />
        </svg>
        Filters{count > 0 ? <span className="text-fg-muted">{count}</span> : null}
      </button>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className={`inline-flex max-w-full items-center rounded-md text-[11px] text-fg-muted ${UI_SURFACE_CLASS}`}
        >
          <button
            type="button"
            onClick={chip.edit}
            title={chip.label}
            className="min-w-0 truncate px-2 py-1.5 text-left wp-interactive"
          >
            {chip.label}
          </button>
          {chip.remove ? (
            <button
              type="button"
              aria-label={`Remove ${chip.label}`}
              onClick={chip.remove}
              className="shrink-0 rounded-r-md py-1.5 pl-0.5 pr-2 wp-interactive "
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
      {count > 0 ? (
        <button
          type="button"
          aria-label="Clear filters"
          data-testid="lims-registry-clear-filters"
          onClick={onClearAll}
          className="px-1 py-1 text-[11px] text-fg-subtle wp-interactive"
        >
          Clear all
        </button>
      ) : null}
      {actions}
      <PortalMenu
        open={open}
        anchorRef={triggerRef}
        onRequestClose={close}
        role="dialog"
        aria-label="Registry filters"
        data-testid="lims-registry-filter-panel"
        surfaceVariant="settings"
        preferredSide="bottom"
        horizontalAlign="start"
        layout={{ width: '29rem' }}
      >
        <div
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="text-sm font-semibold text-fg">Filters</h2>
            <button
              type="button"
              aria-label="Close filters"
              onClick={close}
              className="rounded px-2 py-1 text-fg-subtle wp-interactive "
            >
              ×
            </button>
          </div>
          <div className="grid min-h-64 grid-cols-[7rem_minmax(0,1fr)]">
            <nav aria-label="Filter categories" className="space-y-0.5 px-2 pb-3">
              {[
                ...facets.map(({ key, label, selected, context }) => ({
                  key,
                  label,
                  count: context ? 0 : selected.length,
                })),
                { key: 'text', label: 'Name / ID', count: 0 },
                ...(onUpdatedFilterChange
                  ? [{ key: 'updated', label: 'Last updated', count: updatedFilter?.date ? 1 : 0 }]
                  : []),
                { key: 'more', label: 'More', count: 0 },
              ].map((category) => (
                <button
                  key={category.key}
                  type="button"
                  aria-label={category.label}
                  aria-pressed={activeKey === category.key}
                  onClick={() => setActiveKey(category.key)}
                  className={`flex w-full items-center justify-between gap-1 rounded-md px-2 py-2 text-left text-xs ${activeKey === category.key ? 'bg-accent/10 font-medium text-accent' : 'text-fg-muted wp-interactive '}`}
                >
                  {category.label}
                  {category.count ? <span className="text-[10px]">{category.count}</span> : null}
                </button>
              ))}
            </nav>
            <div className="min-w-0 px-3 pb-4">
              {activeFacet ? (
                <RegistryFilterChoices key={activeFacet.key} facet={activeFacet} />
              ) : null}
              {activeKey === 'text' ? (
                <div className="space-y-3">
                  {[
                    { key: 'name', label: 'Name contains' },
                    { key: 'registryId', label: 'ID contains' },
                  ].map((field) => (
                    <label key={field.key} className="block space-y-1.5 text-xs text-fg-muted">
                      <span>{field.label}</span>
                      <TextField
                        aria-label={field.label}
                        value={textFilters[field.key] ?? ''}
                        onChange={(event) => onTextFilterChange(field.key, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
              ) : null}
              {activeKey === 'updated' && onUpdatedFilterChange ? (
                <RegistryFilterPopover
                  column={{ key: 'updated', label: 'Last updated', width: 140, filter: 'date' }}
                  getColumnCategoricalFilter={() => []}
                  setColumnCategoricalFilter={() => {}}
                  registryUpdatedFilter={updatedFilter ?? null}
                  setRegistryUpdatedFilter={onUpdatedFilterChange}
                />
              ) : null}
              {activeKey === 'more' ? (
                <div className="space-y-4 text-xs text-fg-muted">
                  <label className="flex items-center gap-2">
                    <input
                      data-testid="lims-registry-show-archived"
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-accent"
                      checked={showArchived}
                      onChange={(event) => onShowArchivedChange(event.target.checked)}
                    />
                    Include archived records
                  </label>
                  {onUnresolvedChange && (unresolvedCount || unresolvedOnly) ? (
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-3.5 w-3.5 accent-accent"
                        checked={Boolean(unresolvedOnly)}
                        onChange={(event) => onUnresolvedChange(event.target.checked)}
                      />
                      <span>
                        Only records with unresolved links{' '}
                        <span className="text-fg-subtle">({unresolvedCount ?? 0})</span>
                      </span>
                    </label>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 px-4 pb-3">
            <button
              type="button"
              disabled={count === 0}
              onClick={onClearAll}
              className="text-xs text-fg-muted wp-interactive disabled:opacity-40"
            >
              Clear all
            </button>
            <Button onClick={close}>Done</Button>
          </div>
          {footer ? <div className="px-4 pb-3">{footer}</div> : null}
        </div>
      </PortalMenu>
    </div>
  );
}
