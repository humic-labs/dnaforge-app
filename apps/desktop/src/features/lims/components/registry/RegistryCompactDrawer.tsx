import type { ReactNode, RefObject } from 'react';
import { ChevronRightIcon, SearchIcon } from '../../../../components/icons/glyphs';
import { formatLimsRelationshipType, type LimsRegistrySummary } from '../../../../shared/lims';
import { iconForLimsKind } from '../registry-presenters';
import { NavigationRow } from '../../../../components/ui';

export function RegistryCompactDrawer({
  registrySearch,
  setRegistrySearch,
  expandRegistry,
  actionsMenu,
  scopeControls,
  alternateBody,
  messageBar,
  registryCompactScrollRef,
  registryCompactSentinelRef,
  summaries,
  filtered = false,
  selectRegistrySummary,
  openRegistrySummary,
  registryLoading,
  registryHasMore,
  registryLoadingMore,
  bottomInset,
  unconnectedEntityIds,
}: {
  registrySearch: string;
  setRegistrySearch: (value: string) => void;
  expandRegistry: () => void;
  actionsMenu: ReactNode;
  scopeControls?: ReactNode;
  alternateBody?: ReactNode;
  messageBar: ReactNode;
  registryCompactScrollRef: RefObject<HTMLDivElement>;
  registryCompactSentinelRef: RefObject<HTMLDivElement>;
  summaries: LimsRegistrySummary[];
  filtered?: boolean;
  selectRegistrySummary: (summary: LimsRegistrySummary) => void;
  openRegistrySummary: (summary: LimsRegistrySummary) => void;
  registryLoading: boolean;
  registryHasMore: boolean;
  registryLoadingMore: boolean;

  bottomInset?: boolean;
  unconnectedEntityIds: ReadonlySet<string>;
}) {
  return (
    <div data-testid="lims-registry-compact" className="flex min-h-0 flex-1 flex-col">
      {}
      <div className="grid grid-cols-[auto_1fr_auto] items-center justify-items-end gap-2 border-b border-border px-4 py-3">
        <button
          type="button"
          data-testid="lims-registry-expand"
          title="Expand registry"
          aria-label="Expand registry"
          onClick={expandRegistry}
          className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded border border-border text-fg-muted hover:bg-bg-muted hover:text-fg"
        >
          <ChevronRightIcon className="h-4 w-4" />
        </button>
        <div className="relative col-span-full row-start-2 w-full min-w-0 justify-self-stretch">
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
          <input
            value={registrySearch}
            onChange={(event) => setRegistrySearch(event.target.value)}
            data-testid="lims-registry-compact-search"
            placeholder="Search registry"
            aria-label="Search registry"
            className="h-9 w-full min-w-0 rounded border border-border bg-bg pl-7 pr-2 text-sm text-fg outline-none focus:border-accent"
          />
        </div>
        {actionsMenu}
      </div>
      {scopeControls}
      {messageBar}
      {alternateBody ?? (
        <>
          {}
          {}
          <div
            data-testid="lims-registry-compact-header"
            className="flex items-center gap-x-2 border-b-2 border-border bg-bg-muted px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-fg-muted"
          >
            <div className="flex min-w-0 flex-1 items-center gap-x-4">
              <span className="flex h-7 min-w-0 flex-1 items-center truncate">Name</span>
              <span className="flex h-7 flex-shrink-0 items-center">ID</span>
            </div>
            <span className="flex h-7 w-12 flex-shrink-0 items-center justify-center">Open</span>
          </div>
          <div
            ref={registryCompactScrollRef}
            data-testid="lims-registry-compact-scroll"
            className={`min-h-0 flex-1 overflow-y-auto ${bottomInset ? 'pb-16' : ''}`}
          >
            {summaries.map((summary) => {
              const linkedEntries = summary.linkSummary.notable.map(
                (entry) => `${formatLimsRelationshipType(entry.type)} ${entry.label}`
              );
              return (
                <NavigationRow
                  key={summary.id}
                  role="group"
                  data-testid={`lims-registry-compact-row-${summary.id}`}
                  data-archived={summary.archived ? 'true' : undefined}
                  dimmed={summary.archived}
                  title={summary.name}
                  primaryLabel={`Show details for ${summary.name}`}
                  primaryTitle={summary.name}
                  leadingIcon={iconForLimsKind(summary.kind)}
                  metadata={summary.registryId ?? undefined}
                  metadataTestId={`lims-registry-compact-id-${summary.id}`}
                  detail={linkedEntries.length > 0 ? linkedEntries.join(' · ') : undefined}
                  detailTestId={`lims-registry-compact-links-${summary.id}`}
                  status={
                    unconnectedEntityIds.has(summary.id)
                      ? {
                          label: 'Failed',
                          tone: 'error',
                          testId: `lims-registry-compact-failed-${summary.id}`,
                        }
                      : undefined
                  }
                  selection={{ kind: 'none' }}
                  onActivate={() => selectRegistrySummary(summary)}
                  actions={[
                    {
                      id: 'open-record',
                      label: `Open ${summary.name}`,
                      text: 'Open',
                      testId: `lims-registry-compact-open-${summary.id}`,
                      disabled: !summary.representation.canOpen,
                      tooltip: summary.representation.canOpen
                        ? `Open ${summary.name}`
                        : `${summary.representation.label}. Select the row to inspect its details.`,
                      onInvoke: () => openRegistrySummary(summary),
                    },
                  ]}
                />
              );
            })}
            {!registryLoading && summaries.length === 0 && (
              <div
                data-testid="lims-registry-compact-empty"
                className="px-3 py-8 text-center text-xs text-fg-muted"
              >
                {registrySearch.trim() || filtered ? 'No matching records' : 'No registry records'}
              </div>
            )}
            {registryHasMore && (
              <div
                ref={registryCompactSentinelRef}
                data-testid="lims-registry-compact-sentinel"
                className="px-3 py-2 text-center text-[10px] text-fg-subtle"
              >
                {registryLoadingMore ? 'Loading more…' : 'Scroll for more'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
