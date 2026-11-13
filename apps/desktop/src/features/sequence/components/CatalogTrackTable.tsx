import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, SearchIcon } from '../../../components/icons/glyphs';
import type { UcscCatalogLeaf } from '@waypoint/genome-data';
import {
  collectCatalogTableColumns,
  filterCatalogTableTracks,
  sortCatalogTableRows,
  trackFormatLabel,
  trackHeadline,
  trackSourceLabel,
  type CatalogColumnFilters,
  type CatalogTableSort,
} from '../ucsc-catalog-table';
import { collapseVersionFamilies } from '../ucsc-catalog-versions';
import { classifyUcscCatalogTrackSupport } from '../ucsc-track-support';

export interface CatalogTrackFailure {
  readonly message: UserMessage;
  readonly retryable: boolean;
}

interface CatalogTrackTableProps {
  readonly query: string;
  readonly tracks: ReadonlyArray<UcscCatalogLeaf>;
  readonly schemaTracks: ReadonlyArray<UcscCatalogLeaf>;
  readonly catalogSize: number | null;
  readonly countsAreComplete: boolean;
  readonly searching: boolean;
  readonly emptyText: string;
  readonly rowFailures: Readonly<Record<string, CatalogTrackFailure>>;
  readonly addingTrack: string | null;
  readonly addedCatalogIds: ReadonlySet<string>;
  readonly onAdd: (track: UcscCatalogLeaf) => void;
}

const SCROLL_BATCH_SIZE = 50;
const ACTION_WIDTH = 72;
const COLUMN_GAP = 16;
const COLUMN_WIDTHS_KEY = 'waypoint:ucsc-catalog-column-widths';
const controlClass =
  'inline-flex h-6 items-center rounded border border-border px-2 text-[11px] font-medium leading-none text-fg-muted hover:bg-bg-muted hover:text-fg disabled:opacity-40';

export function CatalogTrackTable({
  query,
  tracks,
  schemaTracks,
  catalogSize,
  countsAreComplete,
  searching,
  emptyText,
  rowFailures,
  addingTrack,
  addedCatalogIds,
  onAdd,
}: CatalogTrackTableProps) {
  const discovered = useMemo(() => collectCatalogTableColumns(schemaTracks), [schemaTracks]);
  const [columns, setColumns] = useState(discovered);
  useEffect(() => {
    setColumns((current) => {
      const known = new Set(current.map((c) => c.id));
      const additional = discovered.filter((c) => !known.has(c.id));
      const release = discovered.find((c) => c.id === 'release');
      const updated = current.map((c) =>
        c.id === 'release' && release?.defaultVisible && !c.defaultVisible ? release : c
      );
      return additional.length || updated.some((c, i) => c !== current[i])
        ? [...updated, ...additional]
        : current;
    });
  }, [discovered]);
  const [visibleIds, setVisibleIds] = useState<ReadonlyArray<string> | null>(null);
  const [filters, setFilters] = useState<CatalogColumnFilters>({});
  const [sort, setSort] = useState<CatalogTableSort | null>(null);
  const [chosenVersions, setChosenVersions] = useState<Readonly<Record<string, string>>>({});
  const [openFilterId, setOpenFilterId] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY) ?? '{}');
      return stored && typeof stored === 'object'
        ? Object.fromEntries(
            Object.entries(stored).filter(
              ([, width]) => typeof width === 'number' && Number.isFinite(width) && width >= 48
            )
          )
        : {};
    } catch {
      return {};
    }
  });
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const sentinelRef = useRef<HTMLTableRowElement>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [columnQuery, setColumnQuery] = useState('');
  const chooserRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const revealColumnRef = useRef<string | null>(null);
  const defaultIds = columns.filter((c) => c.defaultVisible).map((c) => c.id);
  const effectiveIds = visibleIds ?? defaultIds;
  const visibleColumns = columns.filter((c) => effectiveIds.includes(c.id));
  const activeFilters = Object.entries(filters).filter(([, value]) => value.trim());
  const filtered = useMemo(
    () => filterCatalogTableTracks(tracks, columns, filters),
    [tracks, columns, filters]
  );
  const families = useMemo(() => collapseVersionFamilies(filtered), [filtered]);
  const rows = useMemo(
    () => sortCatalogTableRows(families, columns, sort, chosenVersions),
    [families, columns, sort, chosenVersions]
  );
  const [scrollWindow, setScrollWindow] = useState({ rows, count: SCROLL_BATCH_SIZE });
  const count = scrollWindow.rows === rows ? scrollWindow.count : SCROLL_BATCH_SIZE;
  const visibleRows = rows.slice(0, count);
  const hasMore = visibleRows.length < rows.length;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const widths = visibleColumns.map((c) => columnWidths[c.id] ?? c.width);
  const gridStyle = {
    gridTemplateColumns: [...widths, ACTION_WIDTH].map((width) => `${width}px`).join(' '),
    columnGap: COLUMN_GAP,
  };
  const tableWidth =
    widths.reduce((sum, width) => sum + width, ACTION_WIDTH) +
    visibleColumns.length * COLUMN_GAP +
    32;

  useEffect(() => {
    setScrollWindow({ rows, count: SCROLL_BATCH_SIZE });
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [rows]);
  useEffect(() => {
    if (!hasMore || !sentinelRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (rowsRef.current !== rows || !entries.some((entry) => entry.isIntersecting)) return;
        setScrollWindow((current) => ({
          rows,
          count: Math.min(
            rows.length,
            (current.rows === rows ? current.count : SCROLL_BATCH_SIZE) + SCROLL_BATCH_SIZE
          ),
        }));
      },
      { root: scrollRef.current, rootMargin: '200px' }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [rows, hasMore, count]);
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const resizeColumn = (id: string, startX: number, startWidth: number) => {
    resizeCleanupRef.current?.();
    const move = (event: PointerEvent) =>
      setColumnWidths((current) => ({
        ...current,
        [id]: Math.max(48, startWidth + event.clientX - startX),
      }));
    const detach = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      resizeCleanupRef.current = null;
    };
    const finish = () => {
      detach();
      setColumnWidths((current) => {
        localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(current));
        return current;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    resizeCleanupRef.current = detach;
  };
  useEffect(() => {
    const id = revealColumnRef.current;
    if (!id) return;
    const heading = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>('thead th[data-column-id]') ?? []
    ).find((element) => element.dataset.columnId === id);
    heading?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
    revealColumnRef.current = null;
  }, [visibleIds]);
  useEffect(() => {
    if (!columnsOpen) return;
    const close = (event: PointerEvent) => {
      if (!chooserRef.current?.contains(event.target as Node)) setColumnsOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [columnsOpen]);

  const toggleColumn = (id: string) => {
    if (id === 'track') return;
    const shown = effectiveIds.includes(id);
    if (!shown) revealColumnRef.current = id;
    setVisibleIds(shown ? effectiveIds.filter((value) => value !== id) : [...effectiveIds, id]);
    if (shown) {
      setFilters((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      if (sort?.columnId === id) setSort(null);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" aria-busy={searching}>
      <div className="relative mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
        <p
          data-testid="ucsc-catalog-result-summary"
          data-match-count={filtered.length}
          data-catalog-size={catalogSize}
          aria-live="polite"
          className="text-[11px] text-fg-subtle"
        >
          {searching && catalogSize === null
            ? 'Loading catalog…'
            : countsAreComplete
              ? catalogSize === null
                ? null
                : `${filtered.length.toLocaleString()} of ${catalogSize.toLocaleString()} tracks · ${rows.length.toLocaleString()} datasets`
              : `${filtered.length.toLocaleString()} matches · ${rows.length.toLocaleString()} datasets. Catalog incomplete; counts are lower bounds.`}
        </p>
        <div className="flex items-center gap-2">
          <select
            aria-label="Sort results"
            title={
              query.trim()
                ? 'Relevance ranks exact IDs, names, descriptions, then metadata'
                : 'Sort catalog results'
            }
            value={sort ? `${sort.columnId}:${sort.direction}` : 'relevance'}
            onChange={(event) => {
              if (event.target.value === 'relevance') {
                setSort(null);
                return;
              }
              const [columnId, direction] = event.target.value.split(':');
              if (columnId && (direction === 'asc' || direction === 'desc')) {
                setSort({ columnId, direction });
              }
            }}
            className="h-6 rounded border border-border bg-bg px-1.5 text-[11px] font-medium text-fg-muted outline-none focus:border-accent"
          >
            <option value="relevance">{query.trim() ? 'Relevance' : 'Catalog order'}</option>
            <option value="track:asc">Track A–Z</option>
            <option value="track:desc">Track Z–A</option>
            <option value="scientificKind:asc">Track type A–Z</option>
            <option value="collection:asc">Collection A–Z</option>
            <option value="source:asc">Source A–Z</option>
          </select>
          {activeFilters.length ? (
            <button
              type="button"
              aria-label="Clear column filters"
              onClick={() => setFilters({})}
              className={controlClass}
            >
              Clear column filters ({activeFilters.length})
            </button>
          ) : null}
          <div
            ref={chooserRef}
            className="relative"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && columnsOpen) {
                event.stopPropagation();
                setColumnsOpen(false);
              }
            }}
          >
            <button
              type="button"
              aria-label="Choose table columns"
              aria-expanded={columnsOpen}
              onClick={() => setColumnsOpen((current) => !current)}
              className={controlClass}
            >
              Columns
            </button>
            {columnsOpen ? (
              <div
                className="absolute right-0 top-full z-30 mt-1 flex max-h-[min(28rem,55vh)] w-72 flex-col rounded border border-border bg-bg p-3 shadow-xl"
                role="group"
                aria-label="Table columns"
              >
                <input
                  autoFocus
                  aria-label="Find a column"
                  value={columnQuery}
                  onChange={(event) => setColumnQuery(event.target.value)}
                  placeholder="Find a column…"
                  className="mb-2 rounded border border-border bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent"
                />
                <div className="min-h-0 overflow-y-auto">
                  {columns
                    .filter((c) =>
                      c.label.toLocaleLowerCase().includes(columnQuery.toLocaleLowerCase())
                    )
                    .map((column) => (
                      <label
                        key={column.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-xs text-fg hover:bg-bg-muted"
                      >
                        <input
                          type="checkbox"
                          aria-label={`Show ${column.label} column`}
                          checked={effectiveIds.includes(column.id)}
                          disabled={column.id === 'track'}
                          onChange={() => toggleColumn(column.id)}
                        />
                        <span className="min-w-0 truncate" title={column.label}>
                          {column.label}
                        </span>
                      </label>
                    ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setVisibleIds(null);
                    setFilters({});
                    setSort(null);
                    setColumnQuery('');
                    setOpenFilterId(null);
                    setColumnWidths({});
                    localStorage.removeItem(COLUMN_WIDTHS_KEY);
                  }}
                  className={`${controlClass} mt-2`}
                >
                  Restore default columns
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div
        ref={scrollRef}
        data-testid="ucsc-catalog-table-scroll"
        className="min-h-0 flex-1 overflow-auto"
      >
        <table
          aria-label="Public genomic data"
          data-testid="ucsc-catalog-table"
          className="block text-left text-xs"
          style={{ minWidth: tableWidth }}
        >
          <thead className="sticky top-0 z-20 block border-b-2 border-border bg-bg-muted">
            <tr
              className="grid items-center px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-fg-muted"
              style={gridStyle}
            >
              {visibleColumns.map((column) => {
                const direction = sort?.columnId === column.id ? sort.direction : null;
                const textBoxVisible = openFilterId === column.id || !!filters[column.id]?.trim();
                return (
                  <th
                    key={column.id}
                    data-column-id={column.id}
                    scope="col"
                    aria-sort={
                      direction === 'asc'
                        ? 'ascending'
                        : direction === 'desc'
                          ? 'descending'
                          : 'none'
                    }
                    className="relative flex h-7 min-w-0 items-center justify-between gap-1 font-bold"
                  >
                    {textBoxVisible ? (
                      <input
                        autoFocus={openFilterId === column.id}
                        aria-label={`Filter ${column.label}`}
                        value={filters[column.id] ?? ''}
                        placeholder={column.label}
                        onChange={(event) =>
                          setFilters((current) => ({ ...current, [column.id]: event.target.value }))
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Escape' || event.key === 'Enter') {
                            event.stopPropagation();
                            setOpenFilterId(null);
                            event.currentTarget.blur();
                          }
                        }}
                        onBlur={() => setOpenFilterId(null)}
                        className="h-6 min-w-0 flex-1 rounded border border-border bg-bg px-1.5 text-xs font-normal normal-case tracking-normal text-fg outline-none focus:border-accent placeholder:text-[11px] placeholder:font-bold placeholder:uppercase placeholder:tracking-wider placeholder:text-fg-subtle/50"
                      />
                    ) : (
                      <button
                        type="button"
                        aria-label={`Sort by ${column.label}`}
                        onClick={() =>
                          setSort((current) => ({
                            columnId: column.id,
                            direction:
                              current?.columnId === column.id && current.direction === 'asc'
                                ? 'desc'
                                : 'asc',
                          }))
                        }
                        className={`flex min-w-0 items-center gap-1 truncate uppercase tracking-wider transition-colors ${direction ? 'font-bold text-accent' : 'text-fg-subtle hover:text-fg'}`}
                      >
                        <span className="truncate">{column.label}</span>
                        <span
                          aria-hidden="true"
                          className="flex flex-shrink-0 flex-col items-center leading-none"
                        >
                          <span
                            className={`text-[8px] leading-[7px] ${direction === 'asc' ? 'text-accent' : 'text-fg-subtle/40'}`}
                          >
                            ▲
                          </span>
                          <span
                            className={`text-[8px] leading-[7px] ${direction === 'desc' ? 'text-accent' : 'text-fg-subtle/40'}`}
                          >
                            ▼
                          </span>
                        </span>
                      </button>
                    )}
                    {!textBoxVisible && (
                      <button
                        type="button"
                        aria-label={`Filter ${column.label}`}
                        title={`Filter ${column.label}`}
                        onClick={() => setOpenFilterId(column.id)}
                        className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:text-fg"
                      >
                        <SearchIcon size={14} strokeWidth={2.5} />
                      </button>
                    )}
                    <span
                      role="separator"
                      aria-label={`Resize ${column.label} column`}
                      aria-orientation="vertical"
                      title="Drag to resize"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        resizeColumn(
                          column.id,
                          event.clientX,
                          columnWidths[column.id] ?? column.width
                        );
                      }}
                      className="group absolute right-0 top-0 z-10 flex h-full w-2 translate-x-full cursor-col-resize justify-center"
                    >
                      <span className="h-full w-0.5 rounded-full bg-fg-subtle/40 transition-colors group-hover:bg-accent" />
                    </span>
                  </th>
                );
              })}
              <th
                scope="col"
                className="sticky right-0 z-30 flex h-7 items-center justify-end bg-bg-muted"
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="block">
            {visibleRows.map((row) => {
              const track =
                row.versions.find(
                  (entry) => entry.track.catalogId === chosenVersions[row.track.catalogId]
                )?.track ?? row.track;
              const failure: CatalogTrackFailure | undefined = rowFailures[track.catalogId];
              const unavailable = failure?.retryable === false;
              const support = classifyUcscCatalogTrackSupport(track);
              const provenance = [
                track.track,
                trackSourceLabel(track),
                trackFormatLabel(track.formatId),
                track.experimentAccession,
                track.fileAccession,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <Fragment key={row.track.catalogId}>
                  <tr
                    data-testid={`ucsc-track-result-${track.track}`}
                    className="group grid h-9 w-full items-center border-b border-border px-4 text-left text-xs hover:bg-bg-muted focus-within:bg-bg-muted"
                    style={gridStyle}
                  >
                    {visibleColumns.map((column) => (
                      <td
                        key={column.id}
                        data-column-id={column.id}
                        data-value={column.value(track)}
                        className={`min-w-0 truncate ${column.id === 'track' ? 'font-medium text-fg' : column.id === 'trackId' ? 'font-mono text-[11px] text-fg-subtle' : 'text-fg-muted'}`}
                        title={
                          column.id === 'track'
                            ? `${trackHeadline(track)} · ${provenance}`
                            : column.value(track)
                        }
                      >
                        {column.id === 'track' ? (
                          <span className="flex min-w-0 items-center gap-2.5">
                            <span
                              aria-hidden="true"
                              className={`h-2.5 w-2.5 flex-shrink-0 rounded-full border ${track.catalogColor ? 'border-border' : 'border-transparent'}`}
                              style={{
                                backgroundColor: track.catalogColor
                                  ? `rgb(${track.catalogColor})`
                                  : undefined,
                              }}
                            />
                            <span className="min-w-0 truncate">{trackHeadline(track)}</span>
                          </span>
                        ) : column.id === 'release' && row.versions.length > 1 ? (
                          <select
                            data-testid={`ucsc-track-version-${row.track.track}`}
                            aria-label={`Release of ${row.track.shortLabel}`}
                            value={track.catalogId}
                            disabled={addingTrack !== null}
                            onChange={(event) =>
                              setChosenVersions((current) => ({
                                ...current,
                                [row.track.catalogId]: event.target.value,
                              }))
                            }
                            className="max-w-full rounded border border-border bg-bg px-1 py-0.5 text-[11px] text-fg outline-none focus:border-accent disabled:opacity-40"
                          >
                            {row.versions.map((entry, index) => (
                              <option key={entry.track.catalogId} value={entry.track.catalogId}>
                                {index === 0 ? `${entry.label} (newest)` : entry.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span
                            data-testid={
                              column.id === 'collection'
                                ? `ucsc-track-context-${track.track}`
                                : undefined
                            }
                          >
                            {column.value(track) || '—'}
                          </span>
                        )}
                      </td>
                    ))}
                    <td className="sticky right-0 z-10 min-w-0 overflow-hidden bg-bg text-right group-hover:bg-bg-muted group-focus-within:bg-bg-muted">
                      {addedCatalogIds.has(track.catalogId) ? (
                        <span
                          data-testid={`ucsc-track-added-${track.track}`}
                          title={`${track.shortLabel} is in this view`}
                          className="inline-flex h-5 items-center justify-end text-[11px] font-medium leading-none text-success"
                        >
                          <span aria-hidden="true" className="inline-flex items-center gap-1">
                            <CheckIcon size={12} />
                            Added
                          </span>
                          <span className="sr-only">{`${track.shortLabel} is in this view`}</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={!support.supported || addingTrack !== null || unavailable}
                          title={
                            failure
                              ? failure.message
                              : !support.supported
                                ? userMessage('tracks.cannotAdd')
                                : userMessageWithValues('tracks.addNamed', {
                                    track: userMessageValue(trackHeadline(track)),
                                  })
                          }
                          onClick={() => onAdd(track)}
                          className="inline-flex h-5 items-center rounded border border-border px-2 text-[11px] font-medium leading-none text-fg-muted hover:bg-bg hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {addingTrack === track.catalogId
                            ? 'Adding…'
                            : unavailable
                              ? 'Unavailable'
                              : failure
                                ? 'Retry'
                                : 'Add'}
                        </button>
                      )}
                    </td>
                  </tr>
                  {failure ? (
                    <tr className="block border-b border-border bg-error/5">
                      <td colSpan={visibleColumns.length + 1} className="block px-4 py-2">
                        <div role="alert" className="text-xs text-error">
                          {failure.message}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {!visibleRows.length ? (
              <tr className="block">
                <td
                  colSpan={visibleColumns.length + 1}
                  className="block px-4 py-8 text-center text-sm text-fg-muted"
                >
                  {searching
                    ? 'Loading catalog…'
                    : activeFilters.length
                      ? 'No tracks match these column filters.'
                      : emptyText}
                </td>
              </tr>
            ) : null}
            {hasMore ? (
              <tr ref={sentinelRef} data-testid="ucsc-catalog-scroll-sentinel" className="block">
                <td
                  colSpan={visibleColumns.length + 1}
                  className="block px-4 py-3 text-center text-[11px] text-fg-subtle"
                >
                  Scroll to load more
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div
        data-testid="ucsc-catalog-footer"
        className="shrink-0 border-t border-border px-4 py-2 text-[11px] text-fg-subtle"
      >
        {searching
          ? 'Refreshing catalog'
          : `Showing ${visibleRows.length.toLocaleString()} of ${rows.length.toLocaleString()} datasets`}
      </div>
    </div>
  );
}
