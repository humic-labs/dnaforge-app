import { Button } from '../../../../shared/components/Button';
import { useRegistryTaskSelection } from './useRegistryTaskSelection';
import { toUserMessage } from '@waypoint/user-messages';
import { useRef } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { SearchIcon } from '../../../../components/icons/glyphs';
import {
  registrationStatusLabel,
  type LimsRegistrySort,
  type LimsRegistrySummary,
} from '../../../../shared/lims';
import { iconForLimsKind, registryTypeLabel, StatusPill } from '../registry-presenters';
import { RegistryFailedTag } from './RegistryFailedTag';
import { RegistryOpenButton } from './RegistryOpenButton';
import {
  registrySortDirection,
  registrySortForColumn,
  type RegistryColumnDef,
} from './registry-columns';
import { RegistryRecordValue } from './RegistryRecordFields';
import {
  registryRecordEditAccess,
  type RegistryEditWorkspaceFolder,
} from '../../registry-record-edit-access';

export function RegistryOverlayTable({
  columns,
  hasPreview,
  selectedEntityId,
  registryGridRowProps,
  registrySort,
  setRegistrySort,
  dateSort,
  sortDateField,
  openFilterKey,
  setOpenFilterKey,
  filterAnchor,
  setFilterAnchor,
  filterPopoverRef,
  columnHasFilter,
  getColumnTextFilter,
  setColumnTextFilter,
  describeColumnFilter,
  renderColumnFilterControl,
  registryColumnWidths,
  startRegistryColumnResize,
  registryOverlayShown,
  registryMorphing,
  registryScrollRef,
  registryRowRefs,
  registrySentinelRef,
  summaries,
  filtered = false,
  selectRegistrySummary,
  openRegistrySummary,
  handleRegistryRowKeyDown,
  registryLoading,
  registryHasMore,
  registryLoadingMore,
  totalCount,
  unconnectedEntityIds,
  workspaceFolders = [],
}: {
  columns: readonly RegistryColumnDef[];
  hasPreview: boolean;
  selectedEntityId: string | null;
  registryGridRowProps: (extra?: string) => { className: string; style: CSSProperties };
  registrySort: LimsRegistrySort;
  dateSort?: { fieldKey: string; direction: 'asc' | 'desc' };
  sortDateField(fieldKey: string): void;
  setRegistrySort: (sort: LimsRegistrySort) => void;
  openFilterKey: string | null;
  setOpenFilterKey: (key: string | null) => void;
  filterAnchor: { top: number; left: number } | null;
  setFilterAnchor: (anchor: { top: number; left: number } | null) => void;
  filterPopoverRef: RefObject<HTMLDivElement>;
  columnHasFilter: (key: string) => boolean;
  getColumnTextFilter: (key: string) => string;
  setColumnTextFilter: (key: string, value: string) => void;
  describeColumnFilter: (column: RegistryColumnDef) => string;
  renderColumnFilterControl: (column: RegistryColumnDef) => ReactNode;
  registryColumnWidths: Record<string, number>;
  startRegistryColumnResize: (key: string, startX: number, startWidth: number) => void;
  registryOverlayShown: boolean;
  registryMorphing: boolean;
  registryScrollRef: RefObject<HTMLDivElement>;
  registryRowRefs: RefObject<Map<string, HTMLDivElement>>;
  registrySentinelRef: RefObject<HTMLDivElement>;
  summaries: LimsRegistrySummary[];
  filtered?: boolean;
  selectRegistrySummary: (summary: LimsRegistrySummary) => void;
  openRegistrySummary: (summary: LimsRegistrySummary) => void;
  handleRegistryRowKeyDown: (
    event: ReactKeyboardEvent<HTMLDivElement>,
    summary: LimsRegistrySummary,
    index: number
  ) => void;
  registryLoading: boolean;
  registryHasMore: boolean;
  registryLoadingMore: boolean;
  totalCount: number;
  unconnectedEntityIds: ReadonlySet<string>;
  workspaceFolders?: readonly RegistryEditWorkspaceFolder[];
}) {
  const selection = useRegistryTaskSelection();
  const escapePressedRef = useRef(false);
  return (
    <div className={`flex min-h-0 min-w-0 flex-col ${hasPreview ? 'border-r border-border' : ''}`}>
      {}
      <div
        ref={registryScrollRef}
        data-testid="lims-registry-scroll"
        className="min-h-0 flex-1 overflow-auto"
      >
        <div className="min-w-max">
          <div
            data-testid="lims-registry-table-header"
            {...registryGridRowProps(
              'sticky top-0 z-20 border-b-2 border-border bg-bg-muted py-2 text-[11px] font-bold uppercase tracking-wider text-fg-muted'
            )}
          >
            {columns.map((column, columnIndex) => {
              const direction =
                column.filter === 'schema-date'
                  ? dateSort?.fieldKey === column.field?.key
                    ? dateSort?.direction
                    : null
                  : !dateSort && column.sort
                    ? registrySortDirection(column.sort, registrySort)
                    : null;

              const columnFiltered = column.filter ? columnHasFilter(column.key) : false;
              const textBoxVisible =
                column.filter === 'text' &&
                (openFilterKey === column.key || getColumnTextFilter(column.key).trim() !== '');
              const filterValueLabel =
                columnFiltered && column.filter !== 'text' ? describeColumnFilter(column) : '';
              return (
                <div
                  key={column.key}
                  className={`relative flex h-7 min-w-0 items-center gap-1 ${
                    registryOverlayShown && !registryMorphing
                      ? 'overflow-visible'
                      : 'overflow-hidden'
                  } ${column.align === 'right' ? 'justify-end' : 'justify-between'}`}
                >
                  {}
                  {textBoxVisible ? (
                    <input
                      autoFocus={openFilterKey === column.key}
                      data-testid={`lims-registry-filter-input-${column.key}`}
                      value={getColumnTextFilter(column.key)}
                      placeholder={column.label}
                      onChange={(event) => setColumnTextFilter(column.key, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape' || event.key === 'Enter') {
                          event.stopPropagation();
                          escapePressedRef.current = true;
                          setOpenFilterKey(null);
                          event.currentTarget.blur();
                        }
                      }}
                      onBlur={() => {
                        if (escapePressedRef.current) {
                          escapePressedRef.current = false;
                          return;
                        }

                        setColumnTextFilter(column.key, '');
                        setOpenFilterKey(null);
                      }}
                      className="h-6 min-w-0 flex-1 rounded border border-border bg-bg px-1.5 text-xs font-normal normal-case tracking-normal text-fg outline-none focus:border-accent placeholder:text-[11px] placeholder:font-bold placeholder:uppercase placeholder:tracking-wider placeholder:text-fg-subtle/50"
                    />
                  ) : column.sort || column.filter === 'schema-date' ? (
                    <button
                      type="button"
                      data-testid={`lims-registry-sort-${column.key}`}
                      aria-sort={
                        direction === 'asc'
                          ? 'ascending'
                          : direction === 'desc'
                            ? 'descending'
                            : 'none'
                      }
                      title={filterValueLabel || undefined}
                      className={`flex min-w-0 items-center gap-1 truncate uppercase tracking-wider transition-colors ${
                        direction ? 'font-bold text-accent' : 'text-fg-subtle wp-interactive'
                      }`}
                      onClick={() =>
                        column.filter === 'schema-date' && column.field
                          ? sortDateField(column.field.key)
                          : setRegistrySort(registrySortForColumn(column.sort!, registrySort))
                      }
                    >
                      {}
                      <span
                        className={`truncate ${
                          filterValueLabel ? 'normal-case tracking-normal text-accent' : ''
                        }`}
                      >
                        {filterValueLabel || column.label}
                      </span>
                      {}
                      <span className="flex flex-shrink-0 flex-col items-center leading-none">
                        <span
                          className={`text-[8px] leading-[7px] ${
                            direction === 'asc' ? 'text-accent' : 'text-fg-subtle/40'
                          }`}
                        >
                          ▲
                        </span>
                        <span
                          className={`text-[8px] leading-[7px] ${
                            direction === 'desc' ? 'text-accent' : 'text-fg-subtle/40'
                          }`}
                        >
                          ▼
                        </span>
                      </span>
                    </button>
                  ) : (
                    <span className="truncate">{column.label}</span>
                  )}
                  {}
                  {column.filter && !textBoxVisible && (
                    <span className="relative flex-shrink-0">
                      <button
                        type="button"
                        data-testid={`lims-registry-filter-toggle-${column.key}`}
                        aria-label={`Filter ${column.label}`}
                        title={`Filter ${column.label}`}
                        className={`flex h-4 w-4 items-center justify-center rounded transition-colors ${
                          columnFiltered ? 'text-accent' : 'text-fg-subtle wp-interactive'
                        }`}
                        onClick={(event) => {
                          event.stopPropagation();
                          const willOpen = openFilterKey !== column.key;
                          if (willOpen) {
                            const r = event.currentTarget.getBoundingClientRect();

                            setFilterAnchor({
                              top: r.bottom + 4,
                              left: Math.min(r.left, window.innerWidth - 208),
                            });
                          }
                          setOpenFilterKey(willOpen ? column.key : null);
                        }}
                      >
                        <SearchIcon size={14} strokeWidth={2.5} />
                      </button>
                      {openFilterKey === column.key &&
                        column.filter !== 'text' &&
                        filterAnchor &&
                        createPortal(
                          <div
                            ref={filterPopoverRef}
                            data-testid={`lims-registry-filter-popover-${column.key}`}
                            className="fixed z-50 w-48 rounded border border-border bg-bg p-2 text-left text-fg shadow-lg"
                            style={{ top: filterAnchor.top, left: filterAnchor.left }}
                            onClick={(event) => event.stopPropagation()}
                          >
                            {renderColumnFilterControl(column)}
                          </div>,
                          document.body
                        )}
                    </span>
                  )}
                  {columnIndex < columns.length - 1 && (
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      data-testid={`lims-registry-col-resize-${column.key}`}
                      title="Drag to resize"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        startRegistryColumnResize(
                          column.key,
                          event.clientX,
                          registryColumnWidths[column.key] ?? column.width
                        );
                      }}
                      className="group absolute right-0 top-0 z-10 flex h-full w-2 translate-x-full cursor-col-resize justify-center"
                    >
                      <span className="h-full w-0.5 rounded-full bg-fg-subtle/40 transition-colors group-hover:bg-accent" />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {summaries.map((summary, index) => (
            <div
              key={summary.id}
              ref={(node) => {
                if (node) registryRowRefs.current?.set(summary.id, node);
                else registryRowRefs.current?.delete(summary.id);
              }}
              role="button"
              tabIndex={0}
              data-testid={`lims-registry-row-${summary.id}`}
              data-archived={summary.archived ? 'true' : undefined}
              aria-current={summary.id === selectedEntityId ? 'true' : undefined}
              {...registryGridRowProps(
                `h-9 w-full border-b border-border text-left text-xs outline-none ${
                  summary.id === selectedEntityId
                    ? 'bg-accent/15 hover:bg-accent/20 focus:bg-accent/20'
                    : 'wp-interactive '
                } ${summary.archived ? 'opacity-50' : ''}`
              )}
              onClick={() => void selectRegistrySummary(summary)}
              onKeyDown={(event) => handleRegistryRowKeyDown(event, summary, index)}
            >
              {columns.map((column) => (
                <RegistryTableCell
                  key={column.key}
                  column={column}
                  summary={summary}
                  hasUnconnected={unconnectedEntityIds.has(summary.id)}
                  onOpen={openRegistrySummary}
                  selection={
                    selection.mode ? (
                      <input
                        aria-label={'Select ' + summary.name}
                        type="checkbox"
                        disabled={summary.archived || selection.busy}
                        checked={selection.checked(summary)}
                        onKeyDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => void selection.toggle(summary)}
                      />
                    ) : undefined
                  }
                  workspaceFolders={workspaceFolders}
                />
              ))}
            </div>
          ))}
          {!registryLoading && summaries.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-fg-muted">
              {filtered ? 'No matching records' : 'No registry records'}
            </div>
          )}
          {registryHasMore && (
            <div
              ref={registrySentinelRef}
              data-testid="lims-registry-scroll-sentinel"
              className="px-4 py-3 text-center text-[11px] text-fg-subtle"
            >
              {registryLoadingMore ? 'Loading more…' : 'Scroll to load more'}
            </div>
          )}
        </div>
      </div>
      <div
        data-testid="lims-registry-footer"
        className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-[11px] text-fg-subtle"
      >
        {registryLoading
          ? 'Refreshing registry'
          : `Showing ${summaries.length} of ${totalCount} registry rows`}
        {selection.mode ? (
          <>
            <span>{selection.items.length} selected</span>
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={!selection.items.length || selection.busy}
              onClick={selection.create}
            >
              Create linked task
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={selection.clear}>
              Cancel selection
            </Button>
          </>
        ) : (
          <Button
            type="button"
            className="ml-auto"
            size="xs"
            variant="ghost"
            onClick={selection.begin}
          >
            Select records
          </Button>
        )}
        {selection.error && (
          <span role="alert" className="text-error">
            {selection.error}
          </span>
        )}
      </div>
    </div>
  );
}

function RegistryTableCell({
  column,
  summary,
  hasUnconnected,
  onOpen,
  selection,
  workspaceFolders,
}: {
  column: RegistryColumnDef;
  summary: LimsRegistrySummary;
  hasUnconnected: boolean;
  onOpen: (summary: LimsRegistrySummary) => void;
  selection?: ReactNode;
  workspaceFolders: readonly RegistryEditWorkspaceFolder[];
}) {
  const editAccess = registryRecordEditAccess(summary, workspaceFolders);
  if (column.key === 'name') {
    return (
      <span className="flex min-w-0 items-center gap-2.5 font-medium text-fg">
        {selection}
        <span className="flex-shrink-0 text-fg-subtle">{iconForLimsKind(summary.kind)}</span>
        <span
          className="min-w-0 flex-1 truncate"
          title={
            editAccess.canEdit ? undefined : toUserMessage(editAccess.message, 'account.failed')
          }
        >
          {summary.name}
        </span>
        {hasUnconnected ? (
          <RegistryFailedTag testId={`lims-registry-failed-${summary.id}`} />
        ) : null}
      </span>
    );
  }
  if (column.key === 'registryId') {
    return (
      <span
        data-testid={`lims-registry-registry-id-${summary.id}`}
        className="min-w-0 truncate font-mono text-[11px] text-fg-subtle"
      >
        {summary.registryId ?? '-'}
      </span>
    );
  }
  if (column.key === 'kind') {
    return (
      <span
        className="min-w-0 truncate text-fg-muted"
        title={editAccess.canEdit ? undefined : toUserMessage(editAccess.message, 'account.failed')}
      >
        {summary.schemaDisplayName ?? registryTypeLabel(summary.kind)}
      </span>
    );
  }
  if (column.key === 'status') {
    return (
      <span className="min-w-0 overflow-hidden">
        <StatusPill status={summary.registrationStatus}>
          {registrationStatusLabel(summary.registrationStatus)}
        </StatusPill>
      </span>
    );
  }
  if (column.property) {
    return (
      <span
        className="min-w-0 truncate tabular-nums text-fg-muted"
        title="Calculated from the sequence"
      >
        <RegistryRecordValue
          type={column.property.type}
          value={summary.fieldValues[column.property.key]}
        />
      </span>
    );
  }
  if (column.field) {
    return (
      <span
        className="min-w-0 truncate text-fg-muted"
        title={editAccess.canEdit ? undefined : toUserMessage(editAccess.message, 'account.failed')}
      >
        <RegistryRecordValue
          type={column.field.type}
          value={summary.fieldValues[column.field.key]}
        />
      </span>
    );
  }
  return (
    <span className="min-w-0 overflow-hidden text-right">
      <RegistryOpenButton
        summary={summary}
        onOpen={onOpen}
        testId={`lims-registry-open-${summary.id}`}
      />
    </span>
  );
}
