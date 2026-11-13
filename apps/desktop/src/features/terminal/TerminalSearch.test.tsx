import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ISearchResultChangeEvent } from '@xterm/addon-search';
import { TerminalSearch } from './TerminalSearch';

afterEach(() =>
  document.querySelectorAll('[data-test-shell-input]').forEach((node) => node.remove())
);

function target() {
  const textarea = document.createElement('textarea');
  textarea.dataset.testShellInput = '';
  document.body.appendChild(textarea);
  let report: (event: ISearchResultChangeEvent) => void = () => undefined;
  return {
    terminal: { textarea, getSelection: () => 'selected text' },
    search: {
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => true),
      clearDecorations: vi.fn(),
      onDidChangeResults: vi.fn((listener: typeof report) => {
        report = listener;
        return { dispose: vi.fn() };
      }),
    },
    results: (event: ISearchResultChangeEvent) => report(event),
  };
}

it('finds through the upstream addon, reports counts and returns focus to the shell', () => {
  const context = target();
  const close = vi.fn();
  render(<TerminalSearch request={1} context={context} onClose={close} />);
  const input = screen.getByRole('textbox', { name: 'Find terminal text' });
  expect(input).toHaveValue('selected text');
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: 'needle' } });
  expect(context.search.findNext).toHaveBeenLastCalledWith(
    'needle',
    expect.objectContaining({ incremental: true, decorations: expect.any(Object) })
  );
  act(() => context.results({ resultIndex: 1, resultCount: 3 }));
  expect(screen.getByRole('status')).toHaveTextContent('2 of 3');
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  expect(context.search.findPrevious).toHaveBeenCalledWith(
    'needle',
    expect.objectContaining({ incremental: false })
  );
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(close).toHaveBeenCalledOnce();
  expect(context.terminal.textarea).toHaveFocus();
});

it('rejects an invalid regex locally and clears search state when hidden', () => {
  const context = target();
  const view = render(<TerminalSearch request={1} context={context} onClose={() => undefined} />);
  const input = screen.getByRole('textbox', { name: 'Find terminal text' });
  fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
  fireEvent.change(input, { target: { value: '[' } });
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('status')).toHaveTextContent(/invalid|unterminated/i);
  expect(context.search.findNext).not.toHaveBeenCalledWith('[', expect.anything());
  view.rerender(<TerminalSearch request={0} context={context} onClose={() => undefined} />);
  expect(screen.queryByRole('textbox', { name: 'Find terminal text' })).toBe(null);
  expect(context.search.clearDecorations).toHaveBeenCalled();
});

it('invalidates upstream match highlights before changing search options', () => {
  const context = target();
  render(<TerminalSearch request={1} context={context} onClose={() => undefined} />);
  context.search.clearDecorations.mockClear();
  context.search.findNext.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
  expect(context.search.clearDecorations).toHaveBeenCalledOnce();
  expect(context.search.clearDecorations.mock.invocationCallOrder[0]).toBeLessThan(
    context.search.findNext.mock.invocationCallOrder[0]!
  );
});
