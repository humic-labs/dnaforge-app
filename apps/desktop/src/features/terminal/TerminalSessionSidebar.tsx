import { useState, type Dispatch, type DragEvent, type SetStateAction } from 'react';
import {
  ChevronRightIcon,
  CloseIcon,
  EllipsisIcon,
  ExclamationCircleIcon,
  FolderIcon,
  MoveToTabIcon,
  PlusIcon,
} from '../../components/icons';
import {
  NavigationAction,
  NavigationList,
  NavigationRow,
  UI_NAVIGATION_EMPTY_CLASS,
  UI_NAVIGATION_HEADER_CLASS,
  UI_NAVIGATION_PANEL_CLASS,
} from '../../components/ui';
import type { TerminalSession } from '../../shared/terminal-ipc';
import { safeFocus } from '../../shared/utils/safeFocus';
import { TerminalContextMenu } from './TerminalContextMenu';
import { TERMINAL_DRAG_TYPE } from './terminal-layout';
import {
  moveListSession,
  type TerminalListEntry,
  type TerminalListGroup,
} from './terminal-session-list';
import { terminalHostPlatform, terminalSplitShortcut } from './terminal-keyboard';
import './terminal-sidebar.css';

export function TerminalSessionSidebar({
  entries,
  setEntries,
  sessions,
  activeId,
  busy,
  bells,
  onSelect,
  onNew,
  onSplit,
  onClose,
  onMoveToTab,
  onRename,
  onContext,
}: {
  entries: TerminalListEntry[];
  setEntries: Dispatch<SetStateAction<TerminalListEntry[]>>;
  sessions: Map<string, TerminalSession>;
  activeId: string | null;
  busy: boolean;
  bells: Record<string, true>;
  onSelect(id: string): void;
  onNew(groupId?: string): void;
  onSplit(id: string): void;
  onClose(id: string): void;
  onMoveToTab(id: string): void;
  onRename(id: string): void;
  onContext(id: string, x: number, y: number): void;
}) {
  const [editing, setEditing] = useState<{ id?: string; name: string } | null>(null);
  const [menu, setMenu] = useState<{ group: TerminalListGroup; x: number; y: number } | null>(null);
  const visible = entries
    .flatMap((item) => (typeof item === 'string' ? [item] : item.collapsed ? [] : item.sessions))
    .filter((id) => sessions.has(id));
  const tabStop = activeId && visible.includes(activeId) ? activeId : visible[0];
  const drop = (event: DragEvent, groupId: string | null, anchor?: string) => {
    const id = event.dataTransfer.getData(TERMINAL_DRAG_TYPE);
    if (!sessions.has(id)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const side = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setEntries((current) => moveListSession(current, id, groupId, anchor, side));
  };
  const row = (id: string, groupId: string | null) => {
    const session = sessions.get(id);
    if (!session) return null;
    return (
      <NavigationRow
        key={id}
        data-terminal-tab-id={id}
        draggable
        title={
          session.status === 'exited'
            ? `${session.exitCode === null ? 'Stopped' : `(${session.exitCode})`} ${session.title}`
            : session.title
        }
        detail={session.cwd}
        status={{
          label:
            session.status === 'exited'
              ? 'Exited'
              : session.shellState === 'command'
                ? 'Running'
                : 'Ready',
          tone: session.status === 'exited' ? 'neutral' : 'success',
        }}
        leadingIcon={bells[id] ? <ExclamationCircleIcon className="w-3.5 h-3.5" /> : undefined}
        primaryTitle={
          session.cwd +
          '\nPID ' +
          session.pid +
          (session.shellState === 'command'
            ? '\n' + (session.commands.at(-1)?.command ?? 'Running')
            : '') +
          (bells[id] ? '\nTerminal bell' : '')
        }
        selection={{ kind: 'tab', selected: id === activeId, tabIndex: id === tabStop ? 0 : -1 }}
        onActivate={(event) => {
          onSelect(id);
          if (event.altKey) onSplit(id);
        }}
        onPrimaryDoubleClick={() => onRename(id)}
        onPrimaryKeyDown={(event) => {
          if (event.key === 'Delete') {
            event.preventDefault();
            onClose(id);
            return;
          }
          if (terminalSplitShortcut(terminalHostPlatform(), event)) {
            event.preventDefault();
            onSplit(id);
            return;
          }
          const delta = ['ArrowDown', 'ArrowRight'].includes(event.key)
            ? 1
            : ['ArrowUp', 'ArrowLeft'].includes(event.key)
              ? -1
              : event.key === 'Tab' && event.ctrlKey && !event.altKey && !event.metaKey
                ? event.shiftKey
                  ? -1
                  : 1
                : 0;
          const index =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? visible.length - 1
                : delta
                  ? (visible.indexOf(id) + visible.length + delta) % visible.length
                  : -1;
          const next = visible[index];
          if (!next) return;
          event.preventDefault();
          const list = event.currentTarget.closest('[role="tablist"]');
          onSelect(next);
          requestAnimationFrame(() =>
            safeFocus(
              list?.querySelector<HTMLElement>(
                `[data-terminal-tab-id="${CSS.escape(next)}"] [role="tab"]`
              )
            )
          );
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onContext(id, event.clientX, event.clientY);
        }}
        onDragStart={(event) => {
          event.dataTransfer.setData(TERMINAL_DRAG_TYPE, id);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDrop={(event) => drop(event, groupId, id)}
        actions={[
          {
            id: 'move-to-tab',
            label: 'Move terminal to tab',
            icon: <MoveToTabIcon className="w-3.5 h-3.5" />,
            onInvoke: () => onMoveToTab(id),
          },
          {
            id: 'close',
            label: 'Close terminal ' + session.title,
            icon: <CloseIcon className="w-3.5 h-3.5" />,
            onInvoke: () => onClose(id),
          },
        ]}
      />
    );
  };
  return (
    <div
      data-terminal-surface
      className={UI_NAVIGATION_PANEL_CLASS}
      onDrop={(event) => drop(event, null)}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(TERMINAL_DRAG_TYPE)) event.preventDefault();
      }}
    >
      <div className={UI_NAVIGATION_HEADER_CLASS}>
        <h2>Terminals</h2>
        <div className="flex gap-1">
          <NavigationAction
            id="new-group"
            label="New terminal group"
            icon={<FolderIcon />}
            onInvoke={() => setEditing({ name: '' })}
          />
          <NavigationAction
            id="new-terminal"
            label="New terminal"
            icon={<PlusIcon className="w-4 h-4" />}
            disabled={busy}
            onInvoke={() => onNew()}
          />
        </div>
      </div>
      {editing && (
        <form
          className="terminal-list-group-form"
          onSubmit={(event) => {
            event.preventDefault();
            const name = editing.name.trim();
            if (!name) return;
            if (editing.id)
              setEntries((items) =>
                items.map((item) =>
                  typeof item !== 'string' && item.id === editing.id ? { ...item, name } : item
                )
              );
            else {
              const id = crypto.randomUUID();
              setEntries((items) => [...items, { id, name, collapsed: false, sessions: [] }]);
            }
            setEditing(null);
          }}
        >
          <input
            autoFocus
            required
            maxLength={128}
            aria-label="Group name"
            placeholder="Group name"
            value={editing.name}
            onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setEditing(null);
              }
            }}
          />
          <button type="submit">Save</button>
          <button type="button" aria-label="Cancel group name" onClick={() => setEditing(null)}>
            <CloseIcon />
          </button>
        </form>
      )}
      <NavigationList role="tablist" aria-label="Terminal sessions" aria-orientation="vertical">
        {entries.map((item) =>
          typeof item === 'string' ? (
            row(item, null)
          ) : (
            <div
              key={item.id}
              data-terminal-list-group-id={item.id}
              onDrop={(event) => drop(event, item.id)}
            >
              <div
                className="terminal-list-group-heading"
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ group: item, x: event.clientX, y: event.clientY });
                }}
              >
                <button
                  type="button"
                  className="terminal-list-group-toggle wp-interactive"
                  aria-expanded={!item.collapsed}
                  onClick={() =>
                    setEntries((items) =>
                      items.map((entry) =>
                        typeof entry !== 'string' && entry.id === item.id
                          ? { ...entry, collapsed: !entry.collapsed }
                          : entry
                      )
                    )
                  }
                >
                  <ChevronRightIcon className={item.collapsed ? '' : 'rotate-90'} />
                  <span>{item.name}</span>
                </button>
                <NavigationAction
                  id="group-menu"
                  label={'Actions for ' + item.name}
                  icon={<EllipsisIcon />}
                  onInvoke={() => {
                    const rect = document.activeElement?.getBoundingClientRect();
                    setMenu({ group: item, x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
                  }}
                />
              </div>
              {!item.collapsed && (
                <div className="terminal-list-members">
                  {item.sessions.map((id) => row(id, item.id))}
                </div>
              )}
            </div>
          )
        )}
      </NavigationList>
      {!sessions.size && (
        <p className={UI_NAVIGATION_EMPTY_CLASS}>No terminals here. Use + to start a session.</p>
      )}
      {menu && (
        <TerminalContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          actions={[
            {
              id: 'new-in-group',
              label: 'New terminal in group',
              disabled: busy,
              run: () => onNew(menu.group.id),
            },
            {
              id: 'rename-group',
              label: 'Rename group',
              run: () => setEditing({ id: menu.group.id, name: menu.group.name }),
            },
            {
              id: 'ungroup',
              label: 'Ungroup terminals',
              run: () =>
                setEntries((items) =>
                  items.flatMap((entry) =>
                    typeof entry !== 'string' && entry.id === menu.group.id
                      ? entry.sessions
                      : [entry]
                  )
                ),
            },
          ]}
        />
      )}
    </div>
  );
}
