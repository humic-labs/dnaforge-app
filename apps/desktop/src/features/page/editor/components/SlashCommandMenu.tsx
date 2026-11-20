'use client';
import { MenuRow, MenuSurface, useMenu, type MenuCloseReason } from '@waypoint/ui-components';
import { useMenuPointerSelection } from './use-menu-pointer-selection';

import { Fragment, forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Button } from '../../../../components/ui';
import { cn } from '@/shared/lib/cn';

import type { SlashCommand } from '../lib/commands';
import { groupCommandsByCategory } from '../lib/commands';

export interface SlashCommandMenuRef {
  close: (reason: MenuCloseReason) => void;
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export interface SlashCommandMenuProps {
  items: SlashCommand[];
  command: (cmd: SlashCommand) => void;
  error?: string | null;
  onRetry?: () => void;
}

export const SlashCommandMenu = forwardRef<SlashCommandMenuRef, SlashCommandMenuProps>(
  function SlashCommandMenu({ items, command, error, onRetry }, ref) {
    const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
    const columns = useMemo(() => {
      const grouped = groupCommandsByCategory(items);
      return [
        {
          key: 'format' as const,
          label: 'Format',
          commands: items.filter(
            (item) => item.category === 'format' || item.category === 'insert'
          ),
        },
        { key: 'embed' as const, label: 'Embed', commands: grouped.embed },
        { key: 'entity' as const, label: 'Entity', commands: grouped.entity },
      ].filter((column) => column.commands.length);
    }, [items]);
    const menuItems = useMemo(
      () =>
        columns.flatMap((column) =>
          column.commands.map((item) => ({
            id: item.name,
            textValue: item.label,
            closeOnActivate: false,
          }))
        ),
      [columns]
    );
    const menu = useMenu({
      items: menuItems,
      defaultOpen: true,
      onActivate: (id) => {
        const selected = items.find((item) => item.name === id);
        if (selected) command(selected);
      },
    });
    const selectedName = menu.activeId;
    const pointerSelection = useMenuPointerSelection(menu.point);
    const selectedColumn =
      columns.find((column) => column.commands.some((item) => item.name === selectedName)) ??
      columns[0];
    const selectedRow = Math.max(
      0,
      selectedColumn?.commands.findIndex((item) => item.name === selectedName) ?? 0
    );
    const selectedCommandName = selectedColumn?.commands[selectedRow]?.name ?? null;

    useEffect(() => {
      if (selectedCommandName)
        itemRefs.current.get(selectedCommandName)?.scrollIntoView({ block: 'nearest' });
    }, [selectedCommandName]);

    useImperativeHandle(ref, () => ({
      close: menu.close,
      onKeyDown: ({ event }) => {
        if (
          !menu.isOpen ||
          event.defaultPrevented ||
          event.isComposing ||
          event.keyCode === 229 ||
          !selectedColumn
        )
          return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          menu.move(event.key === 'ArrowDown' ? 'next' : 'previous', 'root', {
            wrap: true,
            itemIds: selectedColumn.commands.map((item) => item.name),
          });
          return true;
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          const index = columns.indexOf(selectedColumn);
          const direction = event.key === 'ArrowRight' ? 1 : -1;
          const next = columns[(index + direction + columns.length) % columns.length];
          menu.point(next.commands[Math.min(selectedRow, next.commands.length - 1)].name);
          return true;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          const selected = selectedColumn.commands[selectedRow];
          if (selected) menu.activate(selected.name);
          return true;
        }
        return false;
      },
    }));

    return (
      <MenuSurface
        role="listbox"
        aria-label="Notebook commands"
        ref={menu.bindSurface}
        surface="inline-workspace"
        selection={false}
        icons
        submenus
        density="form"
        layout={{
          width: Math.max(1, columns.length) * 220,
          maxWidth: 'calc(100vw - 16px)',
          maxHeight: 'min(24rem,calc(100vh - 16px))',
          overflow: 'auto',
        }}
        data-testid="slash-command-menu"
      >
        {error && (
          <div role="alert" className="px-3 py-2 text-xs text-fg-muted">
            {error}
            {onRetry && (
              <span className="ml-2 text-fg">
                <Button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={onRetry}
                  variant="link"
                >
                  Retry
                </Button>
              </span>
            )}
          </div>
        )}
        {columns.length === 0 ? (
          <div className="px-3 py-2 text-sm text-fg-muted">No matching commands or categories</div>
        ) : (
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0,1fr))` }}
          >
            {columns.map((column, columnIndex) => (
              <div
                key={column.key}
                role="group"
                aria-label={column.label}
                className={cn(
                  'min-w-0',
                  column.key === 'entity' && 'grid grid-cols-[minmax(0,1fr)_auto] content-start',
                  columnIndex > 0 && 'border-l border-border-subtle pl-1'
                )}
              >
                <div className="px-3 py-2 text-xs text-fg-subtle">{column.label}</div>
                {column.commands.map((cmd, row) => (
                  <Fragment key={cmd.name}>
                    {cmd.section === 'layout' && column.commands[row - 1]?.section !== 'layout' && (
                      <div className="mt-1 border-t border-border-subtle px-3 pt-3 pb-2 text-xs text-fg-subtle">
                        Layout
                      </div>
                    )}
                    <div
                      className={
                        cmd.name === 'entity-link'
                          ? 'col-start-2 row-start-1 self-center'
                          : 'col-span-full'
                      }
                    >
                      <MenuRow
                        data-command-name={cmd.name}
                        ref={(element) => {
                          if (element) itemRefs.current.set(cmd.name, element);
                          else itemRefs.current.delete(cmd.name);
                        }}
                        aria-label={cmd.name === 'entity-link' ? cmd.label : undefined}
                        title={cmd.name === 'entity-link' ? cmd.label : undefined}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={(event) => pointerSelection(event, cmd.name)}
                        onMouseMove={(event) => pointerSelection(event, cmd.name)}
                        role="option"
                        aria-selected={selectedCommandName === cmd.name}
                        onClick={() => menu.activate(cmd.name)}
                        active={selectedColumn?.key === column.key && selectedRow === row}
                        icon={cmd.icon}
                        submenu={column.key === 'entity' && cmd.name !== 'entity-link'}
                      >
                        {cmd.name !== 'entity-link' && cmd.label}
                      </MenuRow>
                    </div>
                  </Fragment>
                ))}
              </div>
            ))}
          </div>
        )}
      </MenuSurface>
    );
  }
);
