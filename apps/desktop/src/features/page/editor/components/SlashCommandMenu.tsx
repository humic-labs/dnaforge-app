'use client';
import { MenuRow, MenuSurface } from '@waypoint/ui-components';

import {
  Fragment,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '@/shared/lib/cn';

import type { SlashCommand } from '../lib/commands';
import { groupCommandsByCategory } from '../lib/commands';

export interface SlashCommandMenuRef {
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
    const [selectedName, setSelectedName] = useState<string | null>(null);
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
    const selectedColumn =
      columns.find((column) => column.commands.some((item) => item.name === selectedName)) ??
      columns[0];
    const selectedRow = Math.max(
      0,
      selectedColumn?.commands.findIndex((item) => item.name === selectedName) ?? 0
    );
    const selectedCommandName = selectedColumn?.commands[selectedRow]?.name ?? null;

    useEffect(() => {
      setSelectedName(selectedCommandName);
      if (selectedCommandName)
        itemRefs.current.get(selectedCommandName)?.scrollIntoView({ block: 'nearest' });
    }, [selectedCommandName]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (event.isComposing || event.keyCode === 229 || !selectedColumn) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          const row =
            (selectedRow + direction + selectedColumn.commands.length) %
            selectedColumn.commands.length;
          setSelectedName(selectedColumn.commands[row].name);
          return true;
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          const index = columns.indexOf(selectedColumn);
          const direction = event.key === 'ArrowRight' ? 1 : -1;
          const next = columns[(index + direction + columns.length) % columns.length];
          setSelectedName(next.commands[Math.min(selectedRow, next.commands.length - 1)].name);
          return true;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          const selected = selectedColumn.commands[selectedRow];
          if (selected) command(selected);
          return true;
        }
        return false;
      },
    }));

    return (
      <MenuSurface
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
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onRetry}
                className="ml-2 text-fg underline"
              >
                Retry
              </button>
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
                        onMouseEnter={() => setSelectedName(cmd.name)}
                        onClick={() => command(cmd)}
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
