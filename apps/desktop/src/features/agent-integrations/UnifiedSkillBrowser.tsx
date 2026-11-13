import { userEntityLabel, toUserMessage } from '@waypoint/user-messages';

import { useMemo, useState, type ReactNode } from 'react';

import type {
  AgentSkillCatalogEntry,
  AgentSkillCatalogSnapshot,
  AgentSkillPackSummary,
} from '../../shared/agent-capability-controls';
import {
  SETTINGS_FIELD_CLASS,
  SETTINGS_SECONDARY_BUTTON_CLASS,
  SETTINGS_SURFACE_CLASS,
  SettingsSelect,
  SettingsSwitch,
} from '../../components/SettingsSubsection';
import { agentRuntimeLabel, type InstalledSkillRow } from './skill-library-model';

export interface CatalogSkillReference {
  pack: AgentSkillPackSummary;
  snapshot: AgentSkillCatalogSnapshot;
  entry: AgentSkillCatalogEntry;
}

export interface UnifiedSkillRow {
  key: string;
  name: string;
  description: string;
  sourceKey: string;
  sourceLabel: string;
  hostLabel: string;
  state: 'enabled' | 'disabled' | 'available';
  installed: InstalledSkillRow | null;
  catalog: CatalogSkillReference | null;
}

function catalogKey(packId: string, skillId: string): string {
  return `catalog:${packId}:${skillId}`;
}

export function buildUnifiedSkillRows(
  installedRows: readonly InstalledSkillRow[],
  packs: readonly AgentSkillPackSummary[],
  snapshots: readonly AgentSkillCatalogSnapshot[]
): UnifiedSkillRow[] {
  const packById = new Map(packs.map((pack) => [pack.id, pack]));
  const catalogByKey = new Map<string, CatalogSkillReference>();
  for (const snapshot of snapshots) {
    const pack = packById.get(snapshot.packId);
    if (!pack) continue;
    for (const entry of snapshot.skills) {
      catalogByKey.set(catalogKey(snapshot.packId, entry.id), { pack, snapshot, entry });
    }
  }

  const rows = new Map<string, UnifiedSkillRow>();
  const installedCatalogKeys = new Set<string>();
  for (const installed of installedRows) {
    const source = installed.managedSkill?.source;
    const sourceCatalogKey = source ? catalogKey(source.packId, source.skillPath) : null;
    if (sourceCatalogKey) installedCatalogKeys.add(sourceCatalogKey);
    const key = sourceCatalogKey
      ? `${sourceCatalogKey}:installed:${installed.managedSkill!.id}`
      : installed.nativeSkill
        ? `native:${installed.nativeSkill.control.provider}:${installed.nativeSkill.control.nativeId}`
        : `managed:${installed.managedSkill?.id ?? installed.key}`;
    const catalog = sourceCatalogKey ? (catalogByKey.get(sourceCatalogKey) ?? null) : null;
    const sourceLabel = source
      ? `${source.publisher} · ${source.packName}`
      : installed.managedSkill
        ? 'DNAForge · Local'
        : installed.sourceLabel;
    const hostLabel = installed.managedSkill
      ? installed.managedSkill.provider === 'all'
        ? installed.runtimes.length === 3
          ? 'All AI hosts'
          : installed.runtimes.map(agentRuntimeLabel).join(', ')
        : agentRuntimeLabel(installed.managedSkill.provider)
      : installed.nativeSkill
        ? agentRuntimeLabel(installed.nativeSkill.control.provider)
        : '';
    rows.set(key, {
      key,
      name: installed.name,
      description: installed.description,
      sourceKey: source
        ? `catalog:${source.packId}`
        : installed.managedSkill
          ? 'dnaforge-local'
          : `native:${installed.nativeSkill?.control.provider ?? installed.sourceKey}`,
      sourceLabel,
      hostLabel,
      state: installed.enabled ? 'enabled' : 'disabled',
      installed,
      catalog,
    });
  }

  for (const [key, catalog] of catalogByKey) {
    if (installedCatalogKeys.has(key)) continue;
    rows.set(key, {
      key,
      name: catalog.entry.name,
      description: catalog.entry.hasScripts
        ? `${catalog.entry.fileCount} files · Includes scripts`
        : `${catalog.entry.fileCount} files · Instructions only`,
      sourceKey: `catalog:${catalog.pack.id}`,
      sourceLabel: `${catalog.pack.publisher} · ${catalog.pack.name}`,
      hostLabel: 'Not installed',
      state: 'available',
      installed: null,
      catalog,
    });
  }

  return [...rows.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.sourceLabel.localeCompare(right.sourceLabel)
  );
}

function SkillSwitch({
  row,
  busy,
  onToggle,
}: {
  row: UnifiedSkillRow;
  busy: boolean;
  onToggle: (skill: InstalledSkillRow) => void;
}) {
  const installed = row.installed;
  if (!installed) return null;
  const enabled = row.state === 'enabled';
  return (
    <SettingsSwitch
      checked={enabled}
      label={`${enabled ? 'Turn off' : 'Turn on'} ${row.name} from ${installed.sourceLabel}`}
      disabled={busy || !installed.toggleable}
      onChange={() => onToggle(installed)}
    />
  );
}

export function UnifiedSkillBrowser({
  rows,
  query,
  selectedKey,
  busy,
  loading,
  catalogState,
  catalogFailures,
  onRetryCatalog,
  actions,
  detail,
  onQueryChange,
  onSelect,
  onClearSelection,
  onToggle,
  onAdd,
}: {
  rows: readonly UnifiedSkillRow[];
  query: string;
  selectedKey: string | null;
  busy: boolean;
  loading: boolean;
  catalogState: 'idle' | 'loading' | 'ready' | 'partial' | 'error';
  catalogFailures: readonly { packId: string; label: string; error: string }[];
  onRetryCatalog: () => void;
  actions?: ReactNode;
  detail: ReactNode;
  onQueryChange: (query: string) => void;
  onSelect: (row: UnifiedSkillRow) => void;
  onClearSelection: () => void;
  onToggle: (skill: InstalledSkillRow) => void;
  onAdd: (catalog: CatalogSkillReference, rowKey: string) => void;
}) {
  const [browserView, setBrowserView] = useState<'installed' | 'available'>('installed');
  const [sourceFilter, setSourceFilter] = useState('all');
  const viewRows = useMemo(
    () =>
      rows.filter((row) =>
        browserView === 'installed' ? row.state !== 'available' : row.state === 'available'
      ),
    [browserView, rows]
  );
  const sourceOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const row of viewRows) options.set(row.sourceKey, row.sourceLabel);
    return [...options.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [viewRows]);
  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return viewRows.filter((row) => {
      if (sourceFilter !== 'all' && row.sourceKey !== sourceFilter) return false;
      if (!needle) return true;
      return [row.name, row.description, row.sourceLabel, row.hostLabel]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [query, sourceFilter, viewRows]);

  const changeView = (nextView: 'installed' | 'available') => {
    if (nextView === browserView) return;
    setBrowserView(nextView);
    setSourceFilter('all');
    onQueryChange('');
    onClearSelection();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="skill-browser">
      <div
        className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3"
        data-testid="skill-browser-toolbar"
      >
        <div className="flex items-center gap-1" aria-label="Skill collection">
          <button
            type="button"
            aria-label="Installed skills"
            aria-pressed={browserView === 'installed'}
            onClick={() => changeView('installed')}
            className={`rounded-md px-3 py-2 text-xs font-medium transition-colors ${
              browserView === 'installed'
                ? 'bg-fg text-bg'
                : 'text-fg-muted hover:bg-black/[0.04] hover:text-fg dark:hover:bg-white/[0.055]'
            }`}
          >
            Installed
          </button>
          <button
            type="button"
            aria-label="Available skills"
            aria-pressed={browserView === 'available'}
            onClick={() => changeView('available')}
            className={`rounded-md px-3 py-2 text-xs font-medium transition-colors ${
              browserView === 'available'
                ? 'bg-fg text-bg'
                : 'text-fg-muted hover:bg-black/[0.04] hover:text-fg dark:hover:bg-white/[0.055]'
            }`}
          >
            Available
          </button>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div
        className="grid shrink-0 gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]"
        data-testid="skill-browser-controls"
      >
        <label className="grid gap-1 text-[11px] text-fg-muted">
          Search
          <input
            type="search"
            aria-label="Search skills"
            placeholder="Search skills and sources"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            className={SETTINGS_FIELD_CLASS}
          />
        </label>
        <label className="grid gap-1 text-[11px] text-fg-muted">
          Source
          <SettingsSelect
            ariaLabel="Filter skills by source"
            value={sourceFilter}
            onValueChange={setSourceFilter}
            options={[
              { value: 'all', label: 'All sources' },
              ...sourceOptions.map(([value, label]) => ({ value, label })),
            ]}
          />
        </label>
      </div>

      {browserView === 'available' && catalogState === 'ready' ? (
        <button
          type="button"
          disabled={busy}
          onClick={onRetryCatalog}
          className={SETTINGS_SECONDARY_BUTTON_CLASS}
        >
          Refresh skill sources
        </button>
      ) : null}
      {browserView === 'available' && catalogState !== 'ready' ? (
        <div
          role={catalogState === 'error' || catalogState === 'partial' ? 'alert' : 'status'}
          className="mt-3 text-xs text-fg-muted"
        >
          {catalogState === 'idle' || catalogState === 'loading' ? (
            <p>Loading available skills…</p>
          ) : (
            <>
              <p>
                {catalogState === 'partial'
                  ? 'Some skill sources could not be loaded.'
                  : viewRows.length
                    ? 'Skill sources could not be refreshed. Previously loaded skills are retained.'
                    : 'Skill sources could not be loaded.'}
              </p>
              <ul>
                {catalogFailures.map((failure) => (
                  <li key={failure.packId}>
                    {userEntityLabel(failure.label)}:{' '}
                    {toUserMessage(failure.error, 'assistant.failed')}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={onRetryCatalog}
                disabled={busy}
                className={SETTINGS_SECONDARY_BUTTON_CLASS}
              >
                Retry skill sources
              </button>
            </>
          )}
        </div>
      ) : null}
      <div className="mt-3 grid min-h-0 flex-1 items-stretch gap-3 overflow-hidden md:grid-cols-[minmax(18rem,0.9fr)_minmax(22rem,1.1fr)]">
        <div
          className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md ${SETTINGS_SURFACE_CLASS}`}
        >
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            data-testid="skill-inventory-scroll"
          >
            {filteredRows.length === 0 ? (
              <p className="px-4 py-10 text-center text-xs text-fg-subtle">
                {browserView === 'available'
                  ? catalogState === 'loading' || catalogState === 'idle'
                    ? 'Loading available skills…'
                    : catalogState === 'error'
                      ? 'Available skills are unavailable.'
                      : catalogState === 'partial'
                        ? 'No matches in the loaded skill sources.'
                        : viewRows.length === 0
                          ? 'No available skills.'
                          : 'No matching skills.'
                  : loading
                    ? 'Loading skills…'
                    : viewRows.length === 0
                      ? 'No installed skills.'
                      : 'No matching skills.'}
              </p>
            ) : (
              <ul aria-label="Skill inventory" className="space-y-0.5 p-1.5">
                {filteredRows.map((row) => {
                  const selected = row.key === selectedKey;
                  return (
                    <li
                      key={row.key}
                      className={`flex min-h-14 items-center gap-2 rounded-md px-3 transition-colors ${
                        selected
                          ? 'bg-black/[0.07] dark:bg-white/[0.09]'
                          : 'hover:bg-black/[0.05] dark:hover:bg-white/[0.07]'
                      }`}
                    >
                      <button
                        type="button"
                        aria-label={`View ${row.name}`}
                        onClick={() => onSelect(row)}
                        className="min-w-0 flex-1 py-2 text-left"
                      >
                        <span className="block truncate text-xs font-medium text-fg">
                          {row.name}
                        </span>
                        <span className="mt-0.5 block truncate text-[10px] text-fg-muted">
                          {row.description}
                        </span>
                        <span className="mt-0.5 block truncate text-[10px] text-fg-subtle">
                          {row.sourceLabel}
                          {row.hostLabel && row.hostLabel !== row.sourceLabel
                            ? ` · ${row.hostLabel}`
                            : ''}
                        </span>
                      </button>
                      {row.state === 'available' && row.catalog ? (
                        <button
                          type="button"
                          aria-label={`Add ${row.name}`}
                          disabled={busy}
                          onClick={() => onAdd(row.catalog!, row.key)}
                          className={`${SETTINGS_SECONDARY_BUTTON_CLASS} shrink-0 px-2.5 py-1.5 text-[11px]`}
                        >
                          Add
                        </button>
                      ) : (
                        <SkillSwitch row={row} busy={busy} onToggle={onToggle} />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        <div
          className={`min-h-0 min-w-0 overflow-y-auto overscroll-contain rounded-md ${SETTINGS_SURFACE_CLASS}`}
          data-testid="skill-details-column"
        >
          {detail}
        </div>
      </div>
    </div>
  );
}
