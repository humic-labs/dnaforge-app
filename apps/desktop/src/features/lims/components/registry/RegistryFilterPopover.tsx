import type { RegistryColumnDef } from './registry-columns';

export interface RegistryUpdatedFilter {
  mode: 'before' | 'on' | 'after';
  date: string;
}

export function RegistryFilterPopover({
  column,
  getColumnCategoricalFilter,
  setColumnCategoricalFilter,
  registryUpdatedFilter,
  setRegistryUpdatedFilter,
}: {
  column: RegistryColumnDef;
  getColumnCategoricalFilter: (key: string) => string[];
  setColumnCategoricalFilter: (key: string, values: string[]) => void;
  registryUpdatedFilter: RegistryUpdatedFilter | null;
  setRegistryUpdatedFilter: React.Dispatch<React.SetStateAction<RegistryUpdatedFilter | null>>;
}) {
  if (column.filter === 'categorical') {
    const selected = getColumnCategoricalFilter(column.key);
    const opts = column.options ?? [];
    return (
      <div className="space-y-1 text-xs font-normal normal-case">
        <div className="flex items-center justify-between gap-2 border-b border-border pb-1">
          <button
            type="button"
            data-testid={`lims-registry-filter-selectall-${column.key}`}
            className="text-accent hover:underline"
            onClick={() =>
              setColumnCategoricalFilter(
                column.key,
                opts.map((option) => option.value)
              )
            }
          >
            Select all
          </button>
          <button
            type="button"
            data-testid={`lims-registry-filter-clearcol-${column.key}`}
            className="text-fg-subtle hover:text-fg hover:underline"
            onClick={() => setColumnCategoricalFilter(column.key, [])}
          >
            Clear
          </button>
        </div>
        {opts.map((option) => {
          const checked = selected.includes(option.value);
          return (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-2 text-fg hover:text-accent"
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-accent"
                data-testid={`lims-registry-filter-option-${column.key}-${option.value}`}
                checked={checked}
                onChange={() =>
                  setColumnCategoricalFilter(
                    column.key,
                    checked
                      ? selected.filter((value) => value !== option.value)
                      : [...selected, option.value]
                  )
                }
              />
              {option.label}
            </label>
          );
        })}
      </div>
    );
  }
  return (
    <div className="space-y-2 text-xs font-normal normal-case">
      <div className="flex gap-1">
        {(['before', 'on', 'after'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            data-testid={`lims-registry-filter-datemode-${mode}`}
            onClick={() =>
              setRegistryUpdatedFilter((current) => ({ mode, date: current?.date ?? '' }))
            }
            className={`flex-1 rounded border px-1 py-0.5 capitalize ${
              registryUpdatedFilter?.mode === mode
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border text-fg-muted wp-interactive'
            }`}
          >
            {mode}
          </button>
        ))}
      </div>
      <input
        type="date"
        data-testid="lims-registry-filter-date-input"
        value={registryUpdatedFilter?.date ?? ''}
        onChange={(event) =>
          setRegistryUpdatedFilter(
            event.target.value
              ? { mode: registryUpdatedFilter?.mode ?? 'on', date: event.target.value }
              : null
          )
        }
        className="h-7 w-full rounded border border-border bg-bg px-2 text-fg outline-none focus:border-accent"
      />
      {registryUpdatedFilter?.date && (
        <button
          type="button"
          data-testid="lims-registry-filter-date-clear"
          className="text-fg-subtle hover:text-fg hover:underline"
          onClick={() => setRegistryUpdatedFilter(null)}
        >
          Clear date
        </button>
      )}
    </div>
  );
}
