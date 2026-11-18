import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import {
  MenuRow,
  MenuSeparator,
  MenuSectionLabel,
  useMenu,
  useMenuAim,
  type MenuCloseReason,
  type MenuCollections,
  type MenuDensity,
} from '@waypoint/ui-components';
import { PortalMenu } from './PortalMenu';
import { safeFocus } from '../shared/utils/safeFocus';

export interface ActionMenuInvocation {
  close: (reason?: MenuCloseReason) => void;
  anchor: DOMRect | null;
  isCurrent: () => boolean;
}

export type ActionMenuEntry =
  | { id: string; separator: true; label?: string }
  | {
      id: string;
      label: string;
      disabled?: boolean;
      icon?: ReactNode;
      shortcut?: ReactNode;
      description?: ReactNode;
      tone?: 'default' | 'danger';
      testId?: string;
      title?: string;
      role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';
      selected?: boolean;
      closeReason?: MenuCloseReason;
      closeOnSelect?: boolean;
      children?: readonly ActionMenuEntry[];
      submenuLabel?: string;
      submenuTestId?: string;
      submenuHeader?: ReactNode;
      submenuDataAttributes?: Record<`data-${string}`, string | undefined>;
      value?: string;
      onSelect?: (invocation: ActionMenuInvocation) => void;
    };

type Action = Exclude<ActionMenuEntry, { separator: true }>;

export interface ActionMenuProps {
  open: boolean;
  label: string;
  entries: readonly ActionMenuEntry[];
  onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
  anchorPoint?: { x: number; y: number };
  density?: MenuDensity;
  testId?: string;
  header?: ReactNode;
  dataAttributes?: Record<`data-${string}`, string | undefined>;
}

function childMenuId(menuId: string, itemId: string): string {
  return `${menuId}/${encodeURIComponent(itemId)}`;
}

export function ActionMenu({
  open,
  label,
  entries,
  onClose,
  anchorRef,
  anchorPoint,
  density = 'compact',
  testId,
  header,
  dataAttributes,
}: ActionMenuProps) {
  const rowRefs = useRef(new Map<string, { current: HTMLButtonElement | null }>());
  const panelRefs = useRef(new Map<string, { current: HTMLDivElement | null }>());
  const intentSequence = useRef(0);
  const alive = useRef(true);
  const menus: Record<string, readonly ActionMenuEntry[]> = {};
  const collections: Record<string, MenuCollections[string]> = {};
  const collect = (menuId: string, items: readonly ActionMenuEntry[]) => {
    menus[menuId] = items;
    collections[menuId] = items
      .filter((entry): entry is Action => !('separator' in entry))
      .map((entry) => {
        const submenuId = entry.children ? childMenuId(menuId, entry.id) : undefined;
        if (submenuId && entry.children) collect(submenuId, entry.children);
        return {
          id: entry.id,
          textValue: entry.label,
          disabled: entry.disabled,
          submenuId,
          closeOnActivate: false,
        };
      });
  };
  collect('root', entries);
  const rowRef = (menuId: string, itemId: string) => {
    const key = childMenuId(menuId, itemId);
    let ref = rowRefs.current.get(key);
    if (!ref) {
      ref = { current: null };
      rowRefs.current.set(key, ref);
    }
    return ref;
  };
  const panelRef = (menuId: string) => {
    let ref = panelRefs.current.get(menuId);
    if (!ref) {
      ref = { current: null };
      panelRefs.current.set(menuId, ref);
    }
    return ref;
  };
  const menu = useMenu({
    items: collections.root,
    menus: collections,
    defaultOpen: open,
    onClose,
    onActivate: (id, menuId) => {
      const action = menus[menuId]?.find(
        (entry): entry is Action => !('separator' in entry) && entry.id === id
      );
      if (!action || action.disabled || !action.onSelect) return;
      const session = menu.stateRef.current.session;
      const invocation: ActionMenuInvocation = {
        close: (reason = action.closeReason ?? 'handoff') => {
          if (alive.current) menu.close(reason, session);
        },
        anchor: rowRef(menuId, id).current?.getBoundingClientRect() ?? null,
        isCurrent: () =>
          alive.current &&
          menu.stateRef.current.session === session &&
          menu.stateRef.current.phase !== 'closed',
      };
      if (action.closeOnSelect !== false) invocation.close();
      action.onSelect(invocation);
    },
    onFocusItem: (id, menuId) => safeFocus(rowRef(menuId, id).current),
  });
  const aim = useMenuAim({ session: menu.state.session, enabled: menu.isOpen });
  const send = menu.send;
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (open && menu.stateRef.current.phase === 'closed') send({ type: 'open', menuId: 'root' });
    else if (!open)
      send({ type: 'close', session: menu.stateRef.current.session, reason: 'unmount' });
  }, [open, send, menu.stateRef]);

  const renderPanel = (
    menuId: string,
    panelLabel: string,
    trigger?: RefObject<HTMLButtonElement | null>,
    submenuTestId?: string,
    submenuHeader?: ReactNode,
    submenuDataAttributes?: Record<`data-${string}`, string | undefined>
  ): ReactNode => {
    const panelEntries = menus[menuId] ?? [];
    const actions = panelEntries.filter((entry): entry is Action => !('separator' in entry));
    const levelIndex = menu.state.levels.findIndex((level) => level.menuId === menuId);
    const level = menu.state.levels[levelIndex];
    const child = menu.state.levels[levelIndex + 1];
    return (
      <PortalMenu
        key={menuId}
        open={open && menu.isOpen && levelIndex >= 0}
        menu={menu}
        menuId={menuId}
        anchorRef={trigger ?? anchorRef}
        anchorPoint={menuId === 'root' ? anchorPoint : undefined}
        onRequestClose={menuId === 'root' ? menu.close : () => undefined}
        role="menu"
        aria-label={panelLabel}
        density={density}
        selection={actions.some(
          (entry) =>
            entry.role === 'menuitemradio' ||
            entry.role === 'menuitemcheckbox' ||
            entry.selected !== undefined
        )}
        icons={actions.some((entry) => entry.icon !== undefined)}
        shortcuts={actions.some((entry) => entry.shortcut !== undefined)}
        submenus={actions.some((entry) => Boolean(entry.children))}
        placement={menuId === 'root' ? 'dropdown' : 'submenu'}
        preferredSide="bottom"
        horizontalAlign="start"
        surfaceRef={panelRef(menuId)}
        data-testid={menuId === 'root' ? testId : submenuTestId}
        dataAttributes={menuId === 'root' ? dataAttributes : submenuDataAttributes}
      >
        {menuId === 'root' ? header : submenuHeader}
        {panelEntries.map((entry) =>
          'separator' in entry ? (
            <div key={entry.id} role="presentation">
              <MenuSeparator />
              {entry.label ? <MenuSectionLabel>{entry.label}</MenuSectionLabel> : null}
            </div>
          ) : (
            <MenuRow
              key={entry.id}
              ref={rowRef(menuId, entry.id)}
              role={entry.role ?? 'menuitem'}
              selected={entry.selected}
              aria-checked={
                entry.role === 'menuitemradio' || entry.role === 'menuitemcheckbox'
                  ? (entry.selected ?? false)
                  : undefined
              }
              title={entry.title}
              disabled={entry.disabled}
              active={level?.activeId === entry.id}
              icon={entry.icon}
              shortcut={entry.shortcut}
              description={entry.description}
              tone={entry.tone}
              submenu={Boolean(entry.children)}
              aria-haspopup={entry.children ? 'menu' : undefined}
              aria-expanded={
                entry.children ? child?.menuId === childMenuId(menuId, entry.id) : undefined
              }
              data-testid={entry.testId}
              data-menu-item-id={entry.id}
              data-value={entry.value}
              tabIndex={level?.activeId === entry.id ? 0 : -1}
              onPointerEnter={(event) => {
                if (entry.disabled) return;
                if (menuId !== 'root') {
                  aim.cancelPendingActivation();
                  menu.cancelIntent();
                }
                const request = ++intentSequence.current;
                const session = menu.state.session;
                send({ type: 'intent', session, menuId, candidateId: entry.id, request });
                aim.requestActivation({
                  pointer: event,
                  submenuElement: child ? panelRef(child.menuId).current : null,
                  isCurrent: () =>
                    menu.stateRef.current.session === session &&
                    menu.stateRef.current.phase !== 'closed',
                  activate: () => send({ type: 'intent-resolve', session, request }),
                });
              }}
              onClick={() => menu.activate(entry.id, menuId)}
            >
              {entry.label}
            </MenuRow>
          )
        )}
        {child && menus[child.menuId] && level?.activeId !== null && level?.activeId !== undefined
          ? renderPanel(
              child.menuId,
              actions.find((entry) => entry.id === level.activeId)?.submenuLabel ??
                actions.find((entry) => entry.id === level.activeId)?.label ??
                panelLabel,
              rowRef(menuId, level.activeId),
              actions.find((entry) => entry.id === level.activeId)?.submenuTestId,
              actions.find((entry) => entry.id === level.activeId)?.submenuHeader,
              actions.find((entry) => entry.id === level.activeId)?.submenuDataAttributes
            )
          : null}
      </PortalMenu>
    );
  };
  return renderPanel('root', label);
}
