import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { TerminalEditorTab } from './TerminalEditorTab';
import { TerminalGroupHost } from './TerminalGroupHost';
import { useTerminalEditorTargets } from './terminal-placement';
import {
  moveTerminalGroupToView,
  terminalGroupViewId,
  type TerminalGroup,
} from './terminal-layout';

it('keeps a visible editor terminal mounted when another editor pane has keyboard focus', () => {
  function Contents() {
    const target = useTerminalEditorTargets((state) => state.targets.analysis);
    return (
      <TerminalGroupHost target={target?.element} visible={Boolean(target?.visible)}>
        <input aria-label="live editor shell" defaultValue="unfinished input" />
      </TerminalGroupHost>
    );
  }
  const view = render(
    <>
      <TerminalEditorTab groupId="analysis" visible active={false} onFocus={() => undefined} />
      <Contents />
    </>
  );
  const input = screen.getByLabelText('live editor shell');
  expect(input).toBeVisible();
  view.rerender(
    <>
      <TerminalEditorTab groupId="analysis" visible active onFocus={() => undefined} />
      <Contents />
    </>
  );
  expect(screen.getByLabelText('live editor shell')).toBe(input);
  expect(input).toHaveValue('unfinished input');
});

it('preserves separate visible shells and their drafts when focus and app-tab ownership change', () => {
  const groups: TerminalGroup[] = [
    { id: 'first', sessions: ['shell-a'], viewId: 'view-a', placement: 'editor' },
    { id: 'second', sessions: ['shell-b'], viewId: 'view-b', placement: 'editor' },
  ];
  function Shells({ groups }: { groups: TerminalGroup[] }) {
    const targets = useTerminalEditorTargets((state) => state.targets);
    return groups.map((group) => {
      const target = targets[terminalGroupViewId(group)];
      return (
        <TerminalGroupHost
          key={group.id}
          target={target?.element}
          visible={Boolean(target?.visible)}
        >
          <input aria-label={group.sessions[0]} defaultValue={`draft ${group.id}`} />
        </TerminalGroupHost>
      );
    });
  }
  function Layout({ focused, groups }: { focused: string; groups: TerminalGroup[] }) {
    return (
      <>
        {['view-a', 'view-b'].map((id) => (
          <TerminalEditorTab
            key={id}
            groupId={id}
            visible
            active={focused === id}
            onFocus={() => undefined}
          />
        ))}
        <Shells groups={groups} />
      </>
    );
  }
  const view = render(<Layout focused="view-a" groups={groups} />);
  const a = screen.getByLabelText('shell-a');
  const b = screen.getByLabelText('shell-b');
  expect(a).toBeVisible();
  expect(b).toBeVisible();
  view.rerender(<Layout focused="view-b" groups={groups} />);
  expect(screen.getByLabelText('shell-a')).toBe(a);
  expect(screen.getByLabelText('shell-b')).toBe(b);
  view.rerender(
    <Layout focused="view-b" groups={moveTerminalGroupToView(groups, 'shell-a', 'view-b')} />
  );
  expect(screen.getByLabelText('shell-a')).toBe(a);
  expect(a).toHaveValue('draft first');
  expect(a.closest('.dnaforge-terminal-editor')).toBe(b.closest('.dnaforge-terminal-editor'));
});
