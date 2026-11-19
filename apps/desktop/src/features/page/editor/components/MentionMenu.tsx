'use client';
import { MenuRow, MenuSurface } from '@waypoint/ui-components';
import { useMenuPointerSelection } from './use-menu-pointer-selection';

import {
  forwardRef,
  Fragment,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { ProjectRootIcon } from '../../../../components/icons/glyphs';
import { Button } from '../../../../components/ui';
import { Kbd } from '../../../../shared/components/Kbd';
import type { Entity, EntityGroup, EntityLinkCategory, EntityType } from '../lib/search';
import {
  entityLocationLabel,
  getEntityCategoryIcon,
  getEntityIcon,
  matchingEntityLinkCategories,
} from '../lib/search';
import type { EntityDiscoveryView } from '../lib/use-entity-discovery';

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
  categories?: readonly EntityLinkCategory[];
  activeCategory?: EntityLinkCategory | null;
  onBrowse?: (category: EntityLinkCategory) => void;
  onBack?: () => void;
  browseView?: boolean;
  allView?: boolean;
  onTypes?: () => void;
  onAll?: () => void;
  recentView?: boolean;
  onRecent?: () => void;
  status?: EntityDiscoveryView['status'];
  error?: string | null;
  onRetry?: () => void;
  nextCursor?: string | null;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  includeArchived?: boolean;
  onToggleArchived?: () => void;
  projectScope?: boolean;
  onToggleProjectScope?: () => void;
}

const NO_CATEGORIES: readonly EntityLinkCategory[] = [];
type Choice =
  | { kind: 'entity'; entity: Entity; group: EntityGroup }
  | { kind: 'category'; category: EntityLinkCategory }
  | { kind: 'browse' | 'all' | 'recent' };

function choiceKey(choice: Choice): string {
  if (choice.kind === 'entity') return `entity:${choice.entity.id}`;
  if (choice.kind === 'category') return `category:${choice.category.key}`;
  return choice.kind;
}

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
  {
    items,
    query,
    command,
    categories = NO_CATEGORIES,
    activeCategory = null,
    onBrowse,
    onBack,
    browseView = false,
    allView = false,
    onTypes,
    onAll,
    recentView = false,
    onRecent,
    status = 'ready',
    error = null,
    onRetry,
    nextCursor,
    onLoadMore,
    loadingMore = false,
    includeArchived = false,
    onToggleArchived,
    projectScope = false,
    onToggleProjectScope,
  },
  ref
) {
  const home = !query.trim() && !activeCategory && !recentView && !browseView && !allView;
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const pointerSelection = useMenuPointerSelection(setActiveKey);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const rows = useMemo<Choice[]>(() => {
    const entities = items.flatMap((group) =>
      group.items.map((entity): Choice => ({ kind: 'entity', entity, group }))
    );
    const matches =
      onBrowse && !activeCategory && !recentView && (!home || !onTypes)
        ? browseView
          ? matchingEntityLinkCategories(
              categories.filter((category) => category.browse !== false),
              query
            )
          : matchingEntityLinkCategories(categories, query)
        : [];
    const categoryRows = matches.map((category): Choice => ({ kind: 'category', category }));
    if (browseView) return [...(onAll ? [{ kind: 'all' } as const] : []), ...categoryRows];
    if (home)
      return [
        ...(onTypes ? [{ kind: 'browse' } as const] : categoryRows),
        ...entities.slice(0, 4),
        ...(onRecent ? [{ kind: 'recent' } as const] : []),
      ];
    return [...entities, ...categoryRows];
  }, [
    items,
    query,
    categories,
    activeCategory,
    onBrowse,
    recentView,
    browseView,
    home,
    onTypes,
    onAll,
    onRecent,
  ]);
  const selectedKey = rows.some((row) => choiceKey(row) === activeKey)
    ? activeKey
    : rows[0]
      ? choiceKey(rows[0])
      : null;
  const selectedIndex = rows.findIndex((row) => choiceKey(row) === selectedKey);

  useEffect(() => {
    if (selectedKey) itemRefs.current.get(selectedKey)?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);

  const choose = useCallback(
    (choice: Choice | undefined) => {
      if (choice?.kind === 'entity') {
        if (status === 'ready') command(attrsFor(choice.entity));
      } else if (choice?.kind === 'category') onBrowse?.(choice.category);
      else if (choice?.kind === 'browse') onTypes?.();
      else if (choice?.kind === 'all') onAll?.();
      else if (choice?.kind === 'recent') onRecent?.();
    },
    [command, onBrowse, onTypes, onAll, onRecent, status]
  );

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.isComposing || event.keyCode === 229) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const available = status === 'ready' ? rows : rows.filter((row) => row.kind !== 'entity');
        if (!available.length) {
          if (status !== 'loading') return false;
          event.preventDefault();
          return true;
        }
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const index = available.findIndex((row) => choiceKey(row) === selectedKey);
        const next =
          index < 0
            ? direction > 0
              ? 0
              : available.length - 1
            : (index + direction + available.length) % available.length;
        setActiveKey(choiceKey(available[next]));
        return true;
      }
      if (event.key === 'Enter' && selectedIndex >= 0) {
        event.preventDefault();
        choose(rows[selectedIndex]);
        return true;
      }
      return false;
    },
  }));

  return (
    <MenuSurface
      surface="inline-workspace"
      content="panel"
      selection={false}
      icons
      shortcuts
      submenus
      density="form"
      layout={{
        width: '24rem',
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'min(28rem,calc(100vh - 16px))',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
      data-testid="mention-menu"
    >
      {(onBack || activeCategory || onToggleProjectScope || onToggleArchived) && (
        <div className="flex min-w-0 items-center gap-2 px-2 py-1">
          {onBack && (
            <Button
              type="button"
              onMouseDown={keepEditorFocus}
              onClick={onBack}
              variant="toolbar"
              aria-label="Back"
              title="Backspace when search is empty"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              Back
              {!query && (
                <Kbd>
                  <span>Backspace</span>
                </Kbd>
              )}
            </Button>
          )}
          {activeCategory && (
            <span
              className="min-w-0 truncate text-xs text-fg-subtle"
              data-testid="mention-active-category"
            >
              {activeCategory.label}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {onToggleProjectScope && (
              <Button
                type="button"
                onMouseDown={keepEditorFocus}
                onClick={onToggleProjectScope}
                aria-label="Limit to this project"
                aria-pressed={projectScope}
                title="Limit to this project"
                variant="toolbar"
              >
                <ProjectRootIcon className="h-4 w-4" />
              </Button>
            )}
            {onToggleArchived && (
              <Button
                type="button"
                aria-pressed={includeArchived}
                onMouseDown={keepEditorFocus}
                onClick={onToggleArchived}
                variant="toolbar"
              >
                {includeArchived ? 'Including archived' : 'Active only'}
              </Button>
            )}
          </div>
        </div>
      )}
      <div className="min-h-0 overflow-auto p-1">
        <div
          role="listbox"
          aria-label="Entity links"
          aria-busy={status === 'loading' || loadingMore}
        >
          {rows.length === 0 && status === 'ready' && (
            <div className="px-3 py-2 text-sm text-fg-muted">
              {recentView || home ? 'No recently viewed entities' : 'No matching entities'}
            </div>
          )}
          {rows.map((choice, index) => {
            const key = choiceKey(choice);
            const selected = key === selectedKey;
            const category = choice.kind === 'category' ? choice.category : null;
            const entity = choice.kind === 'entity' ? choice.entity : null;
            const location = entity ? entityLocationLabel(entity) : null;
            const icon = entity
              ? getEntityIcon(entity)
              : category
                ? getEntityCategoryIcon(category)
                : null;
            const section =
              home && entity && rows[index - 1]?.kind !== 'entity' ? 'Recently viewed' : null;
            const label =
              choice.kind === 'entity'
                ? choice.entity.name
                : choice.kind === 'category'
                  ? choice.category.label
                  : choice.kind === 'browse'
                    ? 'Browse types'
                    : choice.kind === 'all'
                      ? 'Browse all'
                      : home
                        ? 'All recently viewed'
                        : 'Recently viewed';
            return (
              <Fragment key={key}>
                {section && (
                  <div
                    className="px-3 pt-2 pb-1 text-xs text-fg-subtle"
                    data-testid="mention-menu-section"
                  >
                    {section}
                  </div>
                )}
                <MenuRow
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={choice.kind === 'entity' && status !== 'ready' ? true : undefined}
                  aria-label={category ? `Browse ${category.label}` : entity ? undefined : label}
                  ref={(element) => {
                    if (element) itemRefs.current.set(key, element);
                    else itemRefs.current.delete(key);
                  }}
                  data-testid={
                    entity
                      ? 'mention-menu-item'
                      : category
                        ? 'mention-browse-category'
                        : choice.kind === 'recent'
                          ? 'mention-recently-viewed'
                          : 'mention-browse-types'
                  }
                  data-entity-type={entity?.type}
                  data-category-key={category?.key}
                  onMouseDown={keepEditorFocus}
                  {...pointerSelection(key)}
                  onClick={() => choose(choice)}
                  active={selected}
                  icon={icon}
                  shortcut={entity?.registryId}
                  submenu={!entity}
                  description={
                    choice.kind === 'entity' && (
                      <>
                        {entity?.kindLabel ?? choice.group.label}
                        {location && (
                          <>
                            {' '}
                            · <span data-testid="mention-menu-item-project">{location}</span>
                          </>
                        )}
                        {entity?.archived ? ' · Archived' : null}
                      </>
                    )
                  }
                >
                  {label}
                </MenuRow>
              </Fragment>
            );
          })}
          {status === 'loading' && (
            <div
              className={rows.length ? 'sr-only' : 'px-3 py-2 text-sm text-fg-muted'}
              role="status"
            >
              Loading entities…
            </div>
          )}
        </div>
      </div>
      {error && (
        <div className="px-3 py-2 text-sm text-fg-muted" role="alert">
          {error}
          {onRetry && (
            <span className="ml-2 text-fg">
              <Button type="button" onMouseDown={keepEditorFocus} onClick={onRetry} variant="link">
                {status === 'refresh-required' ? 'Refresh' : 'Retry'}
              </Button>
            </span>
          )}
        </div>
      )}
      {nextCursor && status === 'ready' && (
        <MenuRow
          onMouseDown={keepEditorFocus}
          onClick={onLoadMore}
          disabled={loadingMore}
          data-testid="mention-load-more"
        >
          {loadingMore ? 'Loading…' : 'Load more results'}
        </MenuRow>
      )}
    </MenuSurface>
  );
});
