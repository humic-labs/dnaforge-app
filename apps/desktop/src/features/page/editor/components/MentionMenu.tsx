'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { cn } from '@/shared/lib/cn';
import { SearchIcon } from '../../../../components/icons/glyphs';
import type { Entity, EntityGroup, EntityType } from '../lib/search';
import { getEntityIcon } from '../lib/search';

export interface MentionAttrs {
  entityType: EntityType;
  entityId: string;
  label: string;
  path?: string | null;
  contentHash?: string | null;
  objectUuid?: string | null;
  registryKind?: string | null;
  projectId?: string | null;
}

export interface MentionMenuRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export interface MentionMenuProps {
  items: EntityGroup[];
  query: string;
  command: (attrs: MentionAttrs) => void;
}

const ALL = 'all';
const ALL_VIEW_GROUP_LIMIT = 5;

function attrsFor(item: Entity): MentionAttrs {
  return {
    entityType: item.type,
    entityId: item.id,
    label: item.name,
    path: item.path ?? null,
    contentHash: item.contentHash ?? null,
    objectUuid: item.objectUuid ?? null,
    registryKind: item.registryKind ?? null,
    ...(item.projectId ? { projectId: item.projectId } : {}),
  };
}

function keepEditorFocus(event: MouseEvent) {
  event.preventDefault();
}

export const MentionMenu = forwardRef<MentionMenuRef, MentionMenuProps>(function MentionMenu(
  { items, query, command },
  ref
) {
  const [filter, setFilter] = useState(ALL);
  const [selection, setSelection] = useState<{ rows: Entity[] | null; index: number }>({
    rows: null,
    index: 0,
  });
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  const groups = useMemo(() => items.filter((group) => group.items.length > 0), [items]);
  const activeFilter = groups.some((group) => group.key === filter) ? filter : ALL;
  const filterKeys = useMemo(() => [ALL, ...groups.map((group) => group.key)], [groups]);
  const totalCount = useMemo(
    () => groups.reduce((count, group) => count + group.items.length, 0),
    [groups]
  );
  const partial = groups.some((group) => group.partial);

  const visibleGroups = useMemo(() => {
    const selected =
      activeFilter === ALL
        ? groups.map((group) => ({
            group,
            shown: group.items.slice(0, ALL_VIEW_GROUP_LIMIT),
            hidden: Math.max(0, group.items.length - ALL_VIEW_GROUP_LIMIT),
          }))
        : groups
            .filter((group) => group.key === activeFilter)
            .map((group) => ({ group, shown: group.items, hidden: 0 }));
    let offset = 0;
    return selected.map((entry) => {
      const start = offset;
      offset += entry.shown.length;
      return { ...entry, offset: start };
    });
  }, [groups, activeFilter]);

  const rows = useMemo(() => visibleGroups.flatMap((entry) => entry.shown), [visibleGroups]);
  const selectedIndex = selection.rows === rows ? selection.index : 0;
  const setSelectedIndex = useCallback(
    (update: (current: number) => number) =>
      setSelection((previous) => ({
        rows,
        index: update(previous.rows === rows ? previous.index : 0),
      })),
    [rows]
  );

  useEffect(() => {
    itemRefs.current.get(selectedIndex)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const setItemRef = useCallback((index: number, el: HTMLButtonElement | null) => {
    if (el) itemRefs.current.set(index, el);
    else itemRefs.current.delete(index);
  }, []);

  const createPage = useCallback(
    () => command({ entityType: 'page', entityId: 'new', label: query }),
    [command, query]
  );

  const cycleFilter = useCallback(
    (step: number) => {
      const index = filterKeys.indexOf(activeFilter);
      setFilter(filterKeys[(index + step + filterKeys.length) % filterKeys.length]);
    },
    [filterKeys, activeFilter]
  );

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      const max = rows.length > 0 ? rows.length : 1;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((i) => (i + 1) % max);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((i) => (i - 1 + max) % max);
        return true;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        cycleFilter(event.shiftKey ? -1 : 1);
        return true;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const item = rows[selectedIndex];
        if (item) command(attrsFor(item));
        else if (query) createPage();
        return true;
      }
      return false;
    },
  }));

  const groupLabel = (key: string) =>
    key === ALL ? 'All' : (groups.find((group) => group.key === key)?.label ?? key);
  const groupCount = (key: string) =>
    key === ALL ? totalCount : (groups.find((group) => group.key === key)?.items.length ?? 0);

  return (
    <div
      className="bg-bg text-fg border border-border rounded-lg shadow-lg w-96 max-w-[calc(100vw-16px)] max-h-[min(28rem,calc(100vh-16px))] flex flex-col overflow-hidden"
      data-testid="mention-menu"
    >
      <div className="p-2 border-b border-border flex flex-col gap-2">
        <div
          className="flex items-center gap-2 rounded-md border border-border bg-bg-muted px-2 py-1.5 text-sm"
          data-testid="mention-menu-search"
        >
          <SearchIcon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
          {query ? (
            <span className="truncate" data-testid="mention-menu-query">
              {query}
            </span>
          ) : (
            <span className="truncate text-fg-subtle">Search the Registry and every project</span>
          )}
        </div>
        {groups.length > 1 && (
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter by kind">
            {filterKeys.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={key === activeFilter}
                data-testid={`mention-filter-${key}`}
                onMouseDown={keepEditorFocus}
                onClick={() => setFilter(key)}
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs transition-colors',
                  key === activeFilter
                    ? 'bg-accent/15 text-accent'
                    : 'bg-bg-muted text-fg-muted hover:text-fg'
                )}
              >
                {groupLabel(key)} <span className="tabular-nums">{groupCount(key)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="overflow-auto p-1 min-h-0" role="listbox">
        {rows.length === 0 && query ? (
          <button
            type="button"
            onMouseDown={keepEditorFocus}
            onClick={createPage}
            className="w-full px-2 py-1.5 text-left text-sm rounded flex items-center gap-2 bg-accent/10 text-accent"
          >
            <span className="text-fg-muted">+</span>
            <span>Create &quot;{query}&quot;</span>
          </button>
        ) : rows.length === 0 ? (
          <div className="text-sm text-fg-muted px-2 py-1">No items to reference</div>
        ) : (
          visibleGroups.map(({ group, shown, hidden, offset }) => (
            <div key={group.key} data-testid={`mention-group-${group.key}`}>
              <div className="flex items-center justify-between gap-2 px-2 pt-2 pb-1 text-xs text-fg-subtle">
                <span className="font-medium uppercase tracking-wide truncate">{group.label}</span>
                <span>{group.source === 'registry' ? 'Registry' : 'Project'}</span>
              </div>
              {shown.map((item, position) => {
                const index = offset + position;
                return (
                  <button
                    key={`${group.key}:${item.id}`}
                    type="button"
                    role="option"
                    aria-selected={index === selectedIndex}
                    ref={(el) => setItemRef(index, el)}
                    data-testid="mention-menu-item"
                    data-entity-type={item.type}
                    onMouseDown={keepEditorFocus}
                    onMouseEnter={() => setSelectedIndex(() => index)}
                    onClick={() => command(attrsFor(item))}
                    className={cn(
                      'w-full px-2 py-1.5 text-left text-sm rounded flex items-center gap-2 transition-colors',
                      index === selectedIndex ? 'bg-accent/10 text-accent' : 'hover:bg-bg-muted'
                    )}
                  >
                    <span className="shrink-0">{getEntityIcon(item)}</span>
                    <span className="truncate flex-1">{item.name}</span>
                    {item.projectName && (
                      <span
                        className="shrink-0 max-w-[40%] truncate text-xs text-fg-subtle"
                        data-testid="mention-menu-item-project"
                      >
                        {item.projectName}
                      </span>
                    )}
                    {item.registryId && (
                      <span className="shrink-0 text-xs text-fg-subtle tabular-nums">
                        {item.registryId}
                      </span>
                    )}
                  </button>
                );
              })}
              {hidden > 0 && (
                <button
                  type="button"
                  onMouseDown={keepEditorFocus}
                  onClick={() => setFilter(group.key)}
                  className="w-full px-2 py-1 text-left text-xs text-fg-muted hover:text-fg rounded"
                  data-testid={`mention-more-${group.key}`}
                >
                  {hidden} more
                </button>
              )}
            </div>
          ))
        )}
      </div>

      <div className="border-t border-border px-2 py-1 text-[11px] text-fg-subtle flex justify-between gap-2">
        <span>↑↓ choose · ↵ insert · Tab filter</span>
        {partial && <span>More matches: keep typing</span>}
      </div>
    </div>
  );
});
