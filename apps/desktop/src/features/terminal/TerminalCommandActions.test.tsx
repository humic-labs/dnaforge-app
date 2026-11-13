import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TerminalCommandActions } from './TerminalCommandActions';
import type { TerminalCommand } from '../../shared/terminal-ipc';

vi.mock('../../commands', () => ({
  COMMAND_SCOPES: { modal: 'modal' },
  useCommandScope: () => ({ release: vi.fn() }),
}));
const command: TerminalCommand = {
  id: 'failed-git',
  command: 'git sttaus --short',
  cwd: '/project',
  startedAt: 1,
  finishedAt: 2,
  exitCode: 1,
};
const output = 'The most similar command is\n\tstatus\n';

it('reads selected native command output and runs a correction only after an explicit choice', async () => {
  const requestOutput = vi.fn(async () => output);
  const onQuickFix = vi.fn();
  const onClose = vi.fn();
  render(
    <TerminalCommandActions
      command={command}
      running
      shellPath="/bin/bash"
      requestOutput={requestOutput}
      onQuickFix={onQuickFix}
      onAction={vi.fn()}
      onClose={onClose}
    />
  );
  const button = await screen.findByRole('button', { name: 'Run git status --short', exact: true });
  expect(requestOutput).toHaveBeenCalledExactlyOnceWith(command.id);
  expect(onQuickFix).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(onClose).toHaveBeenCalledOnce();
  expect(onQuickFix).toHaveBeenCalledExactlyOnceWith({
    kind: 'command',
    command: 'git status --short',
  });
});

it('discards a delayed output response after selection changes', async () => {
  let deliver: (value: string) => void = () => {};
  const requestOutput = vi.fn((id: string) =>
    id === command.id
      ? new Promise<string>((resolve) => {
          deliver = resolve;
        })
      : Promise.resolve('ordinary output\n')
  );
  const props = {
    running: true,
    shellPath: '/bin/bash',
    requestOutput,
    onQuickFix: vi.fn(),
    onAction: vi.fn(),
    onClose: vi.fn(),
  };
  const view = render(<TerminalCommandActions {...props} command={command} />);
  view.rerender(
    <TerminalCommandActions
      {...props}
      command={{ ...command, id: 'different', command: 'git status -short' }}
    />
  );
  deliver(output);
  await waitFor(() => expect(requestOutput).toHaveBeenCalledTimes(2));
  expect(
    screen.queryByRole('button', { name: 'Run git status --short', exact: true })
  ).not.toBeInTheDocument();
  expect(props.onQuickFix).not.toHaveBeenCalled();
});
