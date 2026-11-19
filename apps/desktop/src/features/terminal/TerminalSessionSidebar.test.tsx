import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { TerminalSession } from '../../shared/terminal-ipc';
import { TerminalSessionSidebar } from './TerminalSessionSidebar';
import { TERMINAL_DRAG_TYPE } from './terminal-layout';
import type { TerminalListEntry } from './terminal-session-list';

it('creates a group, moves one shell into it, and collapses its row independently of selection', () => {
  const makeSession = (id: string): TerminalSession => ({
    id,
    title: id,
    cwd: '/work',
    pid: 123,
    profileId: 'sh',
    shellPath: '/bin/sh',
    cols: 80,
    rows: 24,
    exitCode: null,
    status: 'running',
    integration: true,
    alternateScreen: false,
    shellState: 'prompt',
    commands: [],
  });
  const sessions = new Map(['Build', 'Review'].map((id) => [id, makeSession(id)]));
  const select = vi.fn();
  function List() {
    const [entries, setEntries] = useState<TerminalListEntry[]>([...sessions.keys()]);
    return (
      <TerminalSessionSidebar
        entries={entries}
        setEntries={setEntries}
        sessions={sessions}
        activeId="Build"
        busy={false}
        bells={{}}
        onSelect={select}
        onNew={vi.fn()}
        onSplit={vi.fn()}
        onClose={vi.fn()}
        onMoveToTab={vi.fn()}
        onRename={vi.fn()}
        onContext={vi.fn()}
      />
    );
  }
  render(<List />);
  fireEvent.click(screen.getByRole('button', { name: 'New terminal group' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Group name' }), {
    target: { value: 'Project' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  const group = screen.getByRole('button', { name: 'Project' });
  fireEvent.drop(group, {
    dataTransfer: { getData: (type: string) => (type === TERMINAL_DRAG_TYPE ? 'Build' : '') },
  });
  fireEvent.click(group);
  expect(group).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('tab', { name: /Build/ })).toBeNull();
  expect(screen.getByRole('tab', { name: /Review/ })).toHaveAttribute('tabindex', '0');
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(group);
  expect(screen.getByRole('tab', { name: /Build/ })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('tab', { name: /Review/ }));
  expect(select).toHaveBeenCalledWith('Review');
});
