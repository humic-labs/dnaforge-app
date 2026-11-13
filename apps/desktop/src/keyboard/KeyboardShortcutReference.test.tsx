import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandScopeProvider } from '../commands/CommandScopeProvider';
import { COMMAND_IDS, COMMAND_SCOPES } from '../commands/types';
import { useCommandHandler } from '../commands/useCommandHandler';
import { useCommandScope } from '../commands/useCommandScope';
import { KeyboardShortcutReference } from './KeyboardShortcutReference';

function SequenceFindProbe({ onFind }: { onFind: () => void }) {
  useCommandScope(COMMAND_SCOPES.tabSequence, { claimOnMount: true });
  useCommandHandler(
    COMMAND_IDS.sequenceFind,
    () => {
      onFind();
      return true;
    },
    { scope: COMMAND_SCOPES.tabSequence }
  );
  return null;
}

function pressFind(target: EventTarget = document.body) {
  fireEvent.keyDown(target, { key: 'f', metaKey: true });
}

describe('KeyboardShortcutReference', () => {
  it('renders working shortcuts by area and marks proposals', () => {
    render(<KeyboardShortcutReference showDevelopment={false} platform="MacIntel" />);

    expect(screen.queryByText('Not yet customizable.')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Window' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Explorer' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sequence viewer' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Page' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Ask AI' })).toBeTruthy();
    expect(screen.queryByText(/insert bases/i)).toBeNull();
    expect(screen.queryByText('File list')).toBeNull();
    const sequence = screen.getByTestId('shortcut-area-sequence').textContent ?? '';
    expect(sequence.indexOf('Invert selection')).toBeLessThan(sequence.indexOf('Insert a base'));
    expect(screen.queryByRole('heading', { name: 'Developer' })).toBeNull();

    const aiChat = screen.getByText('AI Chat', { exact: true });
    expect(aiChat.parentElement?.querySelectorAll('svg')).toHaveLength(1);
    expect(aiChat.parentElement).toHaveTextContent('/');
    expect(aiChat.parentElement).not.toHaveTextContent('Suggested');
    expect(screen.queryByText('Command palette')).toBeNull();
  });

  it('shows developer shortcuts only in a development build, and only when asked', async () => {
    render(<KeyboardShortcutReference showDevelopment platform="MacIntel" />);
    expect(await screen.findByRole('heading', { name: 'Developer' })).toBeTruthy();
    expect(screen.getByText('Dev Scenarios')).toBeTruthy();
    expect(screen.getByText('Command palette')).toBeTruthy();
  });

  it('finds a shortcut by its keys with Command-F and does not hide the rest', () => {
    render(<KeyboardShortcutReference showDevelopment={false} platform="Win32" />);
    expect(screen.queryByPlaceholderText('Filter shortcuts')).toBeNull();
    expect(screen.queryByTestId('shortcut-find')).toBeNull();

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    const find = screen.getByTestId('shortcut-find');
    fireEvent.change(find, { target: { value: 'shift b' } });

    expect(screen.getByText('Toggle Sidebar')).toBeTruthy();
    expect(screen.getByText('AI Chat')).toBeTruthy();
    expect(screen.getByTestId('shortcut-row-app.toggle-sidebar').className).toContain(
      'bg-warning/15'
    );
    expect(screen.getByTestId('shortcut-row-app.toggle-sidebar')).toHaveAttribute(
      'data-shortcut-match',
      'true'
    );
    expect(screen.getByTestId('shortcut-row-app.ai-chat').className).not.toContain('bg-warning/15');
  });

  it('matches the spoken key names on a Mac', () => {
    render(<KeyboardShortcutReference showDevelopment={false} platform="MacIntel" />);
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    fireEvent.change(screen.getByTestId('shortcut-find'), { target: { value: 'command shift d' } });

    expect(screen.getByTestId('shortcut-row-app.dark-mode')).toHaveAttribute(
      'data-shortcut-match',
      'true'
    );
    expect(screen.getByTestId('shortcut-row-app.toggle-sidebar')).not.toHaveAttribute(
      'data-shortcut-match'
    );
    expect(screen.getByTestId('shortcut-row-pages.move-down')).not.toHaveAttribute(
      'data-shortcut-match'
    );
    expect(screen.getByTestId('shortcut-row-pages.delete-block')).not.toHaveAttribute(
      'data-shortcut-match'
    );
    expect(screen.getByText('Toggle Sidebar')).toBeTruthy();
    expect(screen.getByText('Move block down')).toBeTruthy();
  });

  it('ignores Command-F while the list is hidden', () => {
    render(
      <div className="hidden">
        <KeyboardShortcutReference showDevelopment={false} platform="Win32" />
      </div>
    );
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(screen.queryByTestId('shortcut-find')).toBeNull();
  });

  it('takes Command-F from sequence find only while the list is on screen', () => {
    const previousPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    const onFind = vi.fn();
    const { rerender } = render(
      <CommandScopeProvider>
        <SequenceFindProbe onFind={onFind} />
      </CommandScopeProvider>
    );

    pressFind();
    expect(onFind).toHaveBeenCalledTimes(1);

    onFind.mockClear();
    rerender(
      <CommandScopeProvider>
        <SequenceFindProbe onFind={onFind} />
        <KeyboardShortcutReference showDevelopment={false} platform="MacIntel" />
      </CommandScopeProvider>
    );
    pressFind();
    expect(onFind).not.toHaveBeenCalled();
    expect(screen.getByTestId('shortcut-find')).toBeTruthy();

    onFind.mockClear();
    rerender(
      <CommandScopeProvider>
        <SequenceFindProbe onFind={onFind} />
        <div className="hidden">
          <KeyboardShortcutReference showDevelopment={false} platform="MacIntel" />
        </div>
      </CommandScopeProvider>
    );
    pressFind();
    expect(onFind).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('shortcut-find')).toBeNull();

    if (previousPlatform) Object.defineProperty(navigator, 'platform', previousPlatform);
  });
});
