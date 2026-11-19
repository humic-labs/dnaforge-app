'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import {
  MenuRow,
  MenuStatus,
  MenuSurface,
  useMenu,
  type MenuCloseReason,
} from '@waypoint/ui-components';
import {
  usePresentationSurface,
  usePresentationScope,
} from '../../../../presentation/PresentationSurface';
import type { SlashCommand } from '../lib/commands';
import { groupCommandsByCategory } from '../lib/commands';

export interface SlashCommandMenuRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
  close: (reason: MenuCloseReason) => void;
}

export interface SlashCommandMenuProps {
  items: SlashCommand[];
  command: (cmd: SlashCommand) => void;
  presentationParentId?: string;
}

export const SlashCommandMenu = forwardRef<SlashCommandMenuRef, SlashCommandMenuProps>(
  function SlashCommandMenu({ items, command, presentationParentId }, ref) {
    const itemRefs = useRef(new Map<string, HTMLButtonElement>());
    const origin = usePresentationScope();
    const grouped = useMemo(() => groupCommandsByCategory(items), [items]);
    const leftColumn = useMemo(
      () => [...(grouped.format ?? []), ...(grouped.insert ?? [])],
      [grouped]
    );
    const rightColumn = useMemo(() => grouped.embed ?? [], [grouped]);
    const commands = useMemo(() => [...leftColumn, ...rightColumn], [leftColumn, rightColumn]);
    const menuItems = useMemo(
      () =>
        commands.map((item) => ({ id: item.name, textValue: item.label, closeOnActivate: false })),
      [commands]
    );
    const menu = useMenu({
      items: menuItems,
      defaultOpen: true,
      onActivate: (id) => {
        const item = commands.find((candidate) => candidate.name === id);
        if (!item) return;
        menu.close('handoff');
        command(item);
      },
    });
    const presentation = usePresentationSurface({
      parentId: presentationParentId,
      active: menu.isOpen,
    });
    const activeId = commands.some((item) => item.name === menu.activeId)
      ? menu.activeId
      : (commands[0]?.name ?? null);
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
        const inLeft = leftColumn.some((item) => item.name === activeId);
        const currentColumn = inLeft ? leftColumn : rightColumn;
        if (currentColumn.length === 0) return false;
        const otherColumn =
          event.key === 'ArrowRight' && inLeft
            ? rightColumn
            : event.key === 'ArrowLeft' && !inLeft
              ? leftColumn
              : null;
        if (otherColumn?.length) {
          event.preventDefault();
          const index = currentColumn.findIndex((item) => item.name === activeId);
          menu.point(otherColumn[Math.max(0, Math.min(index, otherColumn.length - 1))].name);
          return true;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter')
          return menu.handleKeyDown(event, {
            wrap: true,
            itemIds: currentColumn.map((item) => item.name),
          });
        return false;
      },
    }));
    if (!menu.isOpen) return null;
    const hasBothColumns = leftColumn.length > 0 && rightColumn.length > 0;
    const renderCommand = (item: SlashCommand) => (
      <MenuRow
        key={item.name}
        ref={(node) => {
          if (node) itemRefs.current.set(item.name, node);
          else itemRefs.current.delete(item.name);
        }}
        role="option"
        tabIndex={-1}
        active={activeId === item.name}
        aria-selected={activeId === item.name}
        icon={item.icon}
        data-command-name={item.name}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => menu.point(item.name)}
        onClick={() => menu.activate(item.name)}
      >
        {item.label}
      </MenuRow>
    );
    return (
      <MenuSurface
        surface="workspace"
        ref={bindSurface}
        density="form"
        selection={false}
        icons
        role="listbox"
        aria-label="Notebook commands"
        data-menu-id="root"
        data-presentation-surface={presentation.id}
        layout={{
          width: hasBothColumns ? 420 : '13rem',
          maxWidth: 'calc(100vw - 16px)',
          maxHeight: 'min(20rem, calc(100vh - 16px))',
          overflow: 'auto',
          display: presentation.visible ? undefined : 'none',
        }}
      >
        {commands.length === 0 ? (
          <MenuStatus>No matching commands</MenuStatus>
        ) : (
          <div className={hasBothColumns ? 'flex gap-1.5' : undefined}>
            {leftColumn.length > 0 && (
              <div className="flex-1 min-w-0" role="group" aria-label="Format">
                <div className="px-2 py-1 text-xs text-fg-subtle font-medium uppercase tracking-wide">
                  Format
                </div>
                {leftColumn.map(renderCommand)}
              </div>
            )}
            {hasBothColumns && <div className="w-px bg-border-subtle" />}
            {rightColumn.length > 0 && (
              <div className="flex-1 min-w-0" role="group" aria-label="Embed">
                <div className="px-2 py-1 text-xs text-fg-subtle font-medium uppercase tracking-wide">
                  Embed
                </div>
                {rightColumn.map(renderCommand)}
              </div>
            )}
          </div>
        )}
      </MenuSurface>
    );
  }
);
