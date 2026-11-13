import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TerminalCommandHistory } from './TerminalCommandHistory';

vi.mock('../../commands', () => ({
  COMMAND_SCOPES: { modal: 'modal' },
  useCommandScope: () => ({ release: vi.fn() }),
}));

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalScroll)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

it.each([
  { directory: undefined, name: 'Search terminal command history' },
  { directory: '/project', name: 'Search recent terminal directories' },
])(
  'focuses $name after native modal activation chooses its first button',
  ({ directory, name }) => {
    const showModal = HTMLDialogElement.prototype.showModal;
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (
      this: HTMLDialogElement
    ) {
      showModal.call(this);
      this.querySelector<HTMLButtonElement>('button')?.focus();
    });
    const onPick = vi.fn();
    render(
      <TerminalCommandHistory
        commands={[]}
        history={{
          previousCommands: [],
          directories: ['/project'],
          shellCommands: ['printf READY'],
        }}
        pinStorageKey="fixture-history-focus-test"
        directory={directory}
        running
        onPick={onPick}
        onClose={vi.fn()}
        onKindChange={vi.fn()}
        onViewOutput={vi.fn()}
        onReveal={vi.fn()}
      />
    );
    const input = screen.getByRole('combobox', { name });
    expect(input).toHaveFocus();
    const text = directory ?? 'printf READY';
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter', altKey: true });
    expect(onPick).toHaveBeenCalledWith(text, false);
  }
);
