'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import {
  MenuRow,
  MenuStatus,
  MenuSurface,
  INTERACTION_CLASS,
  useMenu,
  type MenuCloseReason,
} from '@waypoint/ui-components';
import {
  usePresentationSurface,
  usePresentationScope,
} from '../../../../presentation/PresentationSurface';
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
  close: (reason: MenuCloseReason) => void;
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export interface MentionMenuProps {
  presentationParentId?: string;
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
  { items, query, command, presentationParentId },
  ref
) {
  const [filter, setFilter] = useState(ALL);
  const origin = usePresentationScope();
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

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
    return selected;
  }, [groups, activeFilter]);

  const rows = useMemo(
    () =>
      visibleGroups.flatMap(({ group, shown }) =>
        shown.map((item) => ({
          id: JSON.stringify([group.key, item.type, item.id]),
          item,
        }))
      ),
    [visibleGroups]
  );
  const menuItems = useMemo(
    () =>
      rows.length > 0
        ? rows.map(({ id, item }) => ({ id, textValue: item.name, closeOnActivate: false }))
        : query
          ? [{ id: 'create-page', textValue: query, closeOnActivate: false }]
          : [],
    [rows, query]
  );
  const menu = useMenu({
    items: menuItems,
    defaultOpen: true,
    onActivate: (id) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row && (id !== 'create-page' || !query)) return;
      menu.close('handoff');
      command(row ? attrsFor(row.item) : { entityType: 'page', entityId: 'new', label: query });
    },
  });
  const presentation = usePresentationSurface({
    parentId: presentationParentId,
    active: menu.isOpen,
  });
  const activeId = menuItems.some((item) => item.id === menu.activeId)
    ? menu.activeId
    : (menuItems[0]?.id ?? null);
  const bindSurface = useCallback(
    (node: HTMLDivElement | null) => {
      presentation.bindRef(node);
      menu.bindSurface(node);
    },
    [presentation.bindRef, menu.bindSurface]
  );
  useLayoutEffect(() => menu.positioned(), [menu.positioned]);
  useEffect(() => {
    if (activeId !== null) itemRefs.current.get(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);
  const setItemRef = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) itemRefs.current.set(id, node);
    else itemRefs.current.delete(id);
  }, []);
  const cycleFilter = useCallback(
    (step: number) => {
      const index = filterKeys.indexOf(activeFilter);
      setFilter(filterKeys[(index + step + filterKeys.length) % filterKeys.length]);
    },
    [filterKeys, activeFilter]
  );

  useImperativeHandle(ref, () => ({
    close: menu.close,
    onKeyDown: ({ event }) => {
      if (
        !menu.isOpen ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        !presentation.owner.allowsEvent(presentationParentId ?? origin.id, 'keyboard', event)
      )
        return false;
      if (event.key === 'Tab') {
        event.preventDefault();
        cycleFilter(event.shiftKey ? -1 : 1);
        return true;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter')
        return menu.handleKeyDown(event, { wrap: true });
      return false;
    },
  }));

  const groupLabel = (key: string) =>
    key === ALL ? 'All' : (groups.find((group) => group.key === key)?.label ?? key);
  const groupCount = (key: string) =>
    key === ALL ? totalCount : (groups.find((group) => group.key === key)?.items.length ?? 0);

  if (!menu.isOpen) return null;

  return (
    <MenuSurface
      surface="workspace"
      ref={bindSurface}
      density="form"
      content="panel"
      selection={false}
      icons
      data-menu-id="root"
      data-presentation-surface={presentation.id}
      layout={{
        width: '24rem',
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'min(28rem, calc(100vh - 16px))',
        flexDirection: 'column',
        overflow: 'hidden',
        display: presentation.visible ? 'flex' : 'none',
      }}
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
                  `${INTERACTION_CLASS} rounded-full px-2 py-0.5 text-xs transition-colors`,
                  key === activeFilter
                    ? 'bg-accent/15 text-accent'
                    : `bg-bg-muted text-fg-muted ${INTERACTION_CLASS}`
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
          <MenuRow
            role="option"
            active={activeId === 'create-page'}
            aria-selected={activeId === 'create-page'}
            icon="+"
            onMouseDown={keepEditorFocus}
            onClick={() => menu.activate('create-page')}
          >
            Create &quot;{query}&quot;
          </MenuRow>
        ) : rows.length === 0 ? (
          <MenuStatus>No items to reference</MenuStatus>
        ) : (
          visibleGroups.map(({ group, shown, hidden }) => (
            <div key={group.key} data-testid={`mention-group-${group.key}`}>
              <div className="flex items-center justify-between gap-2 px-2 pt-2 pb-1 text-xs text-fg-subtle">
                <span className="font-medium uppercase tracking-wide truncate">{group.label}</span>
                <span>{group.source === 'registry' ? 'Registry' : 'Project'}</span>
              </div>
              {shown.map((item) => {
                const id = JSON.stringify([group.key, item.type, item.id]);
                return (
                  <MenuRow
                    key={id}
                    active={id === activeId}
                    icon={getEntityIcon(item)}
                    role="option"
                    aria-selected={id === activeId}
                    ref={(el) => setItemRef(id, el)}
                    data-testid="mention-menu-item"
                    data-entity-type={item.type}
                    onMouseDown={keepEditorFocus}
                    onMouseEnter={() => menu.point(id)}
                    onClick={() => menu.activate(id)}
                  >
                    <span className="flex min-w-0 items-center gap-2">
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
                    </span>
                  </MenuRow>
                );
              })}
              {hidden > 0 && (
                <button
                  type="button"
                  onMouseDown={keepEditorFocus}
                  onClick={() => setFilter(group.key)}
                  className={`${INTERACTION_CLASS} w-full px-2 py-1 text-left text-xs text-fg-muted rounded`}
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
    </MenuSurface>
  );
});
