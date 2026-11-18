'use client';

import {
  forwardRef,
  useCallback,
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
}

export const SlashCommandMenu = forwardRef<SlashCommandMenuRef, SlashCommandMenuProps>(
  function SlashCommandMenu({ items, command }, ref) {
    const [selectedColumn, setSelectedColumn] = useState<'left' | 'right'>('left');
    const [selectedRow, setSelectedRow] = useState(0);
    const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

    const grouped = useMemo(() => groupCommandsByCategory(items), [items]);

    const leftColumn = useMemo(
      () => [...(grouped.format || []), ...(grouped.insert || [])],
      [grouped]
    );
    const rightColumn = useMemo(() => grouped.embed || [], [grouped]);

    const selectedCommand = useMemo(() => {
      const column = selectedColumn === 'left' ? leftColumn : rightColumn;
      return column[selectedRow];
    }, [selectedColumn, selectedRow, leftColumn, rightColumn]);

    useEffect(() => {
      const key = `${selectedColumn}-${selectedRow}`;
      const el = itemRefs.current.get(key);
      if (el) {
        el.scrollIntoView({ block: 'nearest' });
      }
    }, [selectedColumn, selectedRow]);

    const setItemRef = useCallback(
      (column: 'left' | 'right', row: number, el: HTMLButtonElement | null) => {
        const key = `${column}-${row}`;
        if (el) {
          itemRefs.current.set(key, el);
        } else {
          itemRefs.current.delete(key);
        }
      },
      []
    );

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        const currentColumn = selectedColumn === 'left' ? leftColumn : rightColumn;

        if (currentColumn.length === 0) {
          if (selectedColumn === 'left' && rightColumn.length > 0) {
            setSelectedColumn('right');
            setSelectedRow(0);
          } else if (selectedColumn === 'right' && leftColumn.length > 0) {
            setSelectedColumn('left');
            setSelectedRow(0);
          }
          return false;
        }

        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSelectedRow((r) => (r + 1) % currentColumn.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSelectedRow((r) => (r - 1 + currentColumn.length) % currentColumn.length);
          return true;
        }
        if (event.key === 'ArrowRight' && selectedColumn === 'left' && rightColumn.length > 0) {
          event.preventDefault();
          setSelectedColumn('right');
          setSelectedRow((r) => Math.min(r, rightColumn.length - 1));
          return true;
        }
        if (event.key === 'ArrowLeft' && selectedColumn === 'right' && leftColumn.length > 0) {
          event.preventDefault();
          setSelectedColumn('left');
          setSelectedRow((r) => Math.min(r, leftColumn.length - 1));
          return true;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          if (selectedCommand) command(selectedCommand);
          return true;
        }
        return false;
      },
    }));

    useEffect(() => {
      if (leftColumn.length > 0) {
        setSelectedColumn('left');
        setSelectedRow(0);
      } else if (rightColumn.length > 0) {
        setSelectedColumn('right');
        setSelectedRow(0);
      } else {
        setSelectedColumn('left');
        setSelectedRow(0);
      }
    }, [items, leftColumn.length, rightColumn.length]);

    if (items.length === 0) {
      return (
        <div className="bg-bg-subtle text-fg rounded-lg shadow-md p-2 w-72 max-w-[calc(100vw-16px)]">
          <div className="text-sm text-fg-muted px-2 py-1">No matching commands</div>
        </div>
      );
    }

    const renderCommand = (cmd: SlashCommand, column: 'left' | 'right', row: number) => {
      const isSelected = selectedColumn === column && selectedRow === row;
      return (
        <button
          key={cmd.name}
          ref={(el) => setItemRef(column, row, el)}
          onClick={() => command(cmd)}
          className={cn(
            'w-full px-2 py-1.5 text-left rounded flex items-center gap-2 transition-colors',
            isSelected ? 'bg-accent/10 text-accent' : 'hover:bg-bg-muted'
          )}
        >
          <span className="w-5 h-5 flex items-center justify-center text-sm flex-shrink-0">
            {cmd.icon}
          </span>
          <span className="text-sm font-medium truncate">{cmd.label}</span>
        </button>
      );
    };

    const hasBothColumns = leftColumn.length > 0 && rightColumn.length > 0;

    return (
      <div
        className={cn(
          'bg-bg-subtle text-fg rounded-lg shadow-md p-1.5 max-w-[calc(100vw-16px)] max-h-[min(20rem,calc(100vh-16px))] overflow-auto',
          hasBothColumns ? 'w-[420px]' : 'w-52'
        )}
      >
        {hasBothColumns ? (
          <div className="flex gap-1.5">
            {}
            <div className="flex-1 min-w-0">
              <div className="px-2 py-1 text-xs text-fg-subtle font-medium uppercase tracking-wide">
                Format
              </div>
              {leftColumn.map((cmd, i) => renderCommand(cmd, 'left', i))}
            </div>

            {}
            <div className="w-px bg-border-subtle" />

            {}
            <div className="flex-1 min-w-0">
              <div className="px-2 py-1 text-xs text-fg-subtle font-medium uppercase tracking-wide">
                Embed
              </div>
              {rightColumn.map((cmd, i) => renderCommand(cmd, 'right', i))}
            </div>
          </div>
        ) : (
          <div>
            {leftColumn.length > 0 && (
              <>
                <div className="px-2 py-1 text-xs text-fg-subtle font-medium uppercase tracking-wide">
                  Format
                </div>
                {leftColumn.map((cmd, i) => renderCommand(cmd, 'left', i))}
              </>
            )}
            {rightColumn.length > 0 && (
              <>
                <div className="px-2 py-1 text-xs text-fg-subtle font-medium uppercase tracking-wide">
                  Embed
                </div>
                {rightColumn.map((cmd, i) => renderCommand(cmd, 'right', i))}
              </>
            )}
          </div>
        )}
      </div>
    );
  }
);
