import { PresentationBoundary } from '../presentation/PresentationSurface';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandScopeProvider } from './CommandScopeProvider';
import { useCommandHandler } from './useCommandHandler';
import { useCommandScope } from './useCommandScope';
import { COMMAND_IDS, COMMAND_SCOPES } from './types';
import { getMountedCommandRegistry } from './mounted-command-registry';

function press(init: KeyboardEventInit) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: init.key ?? 'f',
        code: init.code ?? `Key${(init.key ?? 'f').toUpperCase()}`,
        metaKey: init.metaKey,
        ctrlKey: init.ctrlKey,
        shiftKey: init.shiftKey,
        altKey: init.altKey,
        bubbles: true,
      })
    );
  });
}

function GlobalSearchHandler({ onSearch }: { onSearch: () => void }) {
  useCommandHandler(COMMAND_IDS.workspaceSearch, () => {
    onSearch();
    return true;
  });
  return null;
}

function ContextMenuScope() {
  useCommandScope(COMMAND_SCOPES.menuContext, { claimOnMount: true });
  return null;
}

function InputEditorScope() {
  useCommandScope(COMMAND_SCOPES.inputEditor, { claimOnMount: true });
  return null;
}

function CommandInputFocusHandler({ onFocus }: { onFocus: () => void }) {
  useCommandHandler(COMMAND_IDS.appFocusCommandInput, () => {
    onFocus();
    return true;
  });
  return null;
}

function NewChatHandler({ onNewChat }: { onNewChat: () => void }) {
  useCommandHandler(COMMAND_IDS.appNewChat, () => {
    onNewChat();
    return true;
  });
  return null;
}

function SequenceFindHandler({ onFind }: { onFind: () => void }) {
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

function SequenceSurface({ onFind }: { onFind: () => void }) {
  const scope = useCommandScope(COMMAND_SCOPES.tabSequence, { claimOnMount: true });
  useCommandHandler(
    COMMAND_IDS.sequenceFind,
    () => {
      onFind();
      return true;
    },
    { scope: COMMAND_SCOPES.tabSequence }
  );
  return (
    <button type="button" {...scope.eventHandlers}>
      sequence surface
    </button>
  );
}

function FileTreeSurface() {
  const scope = useCommandScope(COMMAND_SCOPES.sidebarFileTree);
  return (
    <button type="button" {...scope.eventHandlers}>
      file tree surface
    </button>
  );
}

describe('CommandScopeProvider', () => {
  it('uses the same mounted handler for agents and releases it on unmount', () => {
    const onSearch = vi.fn();
    const view = render(
      <CommandScopeProvider>
        <GlobalSearchHandler onSearch={onSearch} />
      </CommandScopeProvider>
    );
    expect(
      getMountedCommandRegistry()!.dispatchCommand(COMMAND_IDS.workspaceSearch, { source: 'agent' })
    ).toMatchObject({ handled: true, blocked: false });
    expect(onSearch).toHaveBeenCalledOnce();
    view.unmount();
    expect(getMountedCommandRegistry()).toBeNull();
  });

  it('blocks agent navigation behind a modal', () => {
    const onSearch = vi.fn();
    render(
      <CommandScopeProvider>
        <GlobalSearchHandler onSearch={onSearch} />
        <PresentationBoundary capture="modal">
          <div role="dialog" aria-modal="true" />
        </PresentationBoundary>
      </CommandScopeProvider>
    );
    expect(
      getMountedCommandRegistry()!.dispatchCommand(COMMAND_IDS.workspaceSearch, { source: 'agent' })
    ).toMatchObject({ handled: false, blocked: true });
    expect(onSearch).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    Object.defineProperty(navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });
  });

  it('dispatches default workspace search binding to the global handler', () => {
    const onSearch = vi.fn();

    render(
      <CommandScopeProvider>
        <GlobalSearchHandler onSearch={onSearch} />
      </CommandScopeProvider>
    );

    press({ key: 'f', metaKey: true, shiftKey: true });

    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('does not let a context menu leak workspace search to lower scopes', () => {
    const onSearch = vi.fn();

    render(
      <CommandScopeProvider>
        <GlobalSearchHandler onSearch={onSearch} />
        <ContextMenuScope />
      </CommandScopeProvider>
    );

    press({ key: 'f', metaKey: true, shiftKey: true });

    expect(onSearch).not.toHaveBeenCalled();
  });

  it('routes Cmd+F to sequence find without treating Cmd+Shift+F as the same binding', () => {
    const onFind = vi.fn();
    const onSearch = vi.fn();

    render(
      <CommandScopeProvider>
        <GlobalSearchHandler onSearch={onSearch} />
        <SequenceFindHandler onFind={onFind} />
      </CommandScopeProvider>
    );

    press({ key: 'f', metaKey: true });
    press({ key: 'f', metaKey: true, shiftKey: true });

    expect(onFind).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('does not send local find to a stale sequence tab after the file tree takes focus', () => {
    const onFind = vi.fn();

    render(
      <CommandScopeProvider>
        <SequenceSurface onFind={onFind} />
        <FileTreeSurface />
      </CommandScopeProvider>
    );

    press({ key: 'f', metaKey: true });
    expect(onFind).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'file tree surface' }));
    press({ key: 'f', metaKey: true });
    expect(onFind).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByRole('button', { name: 'sequence surface' }));
    press({ key: 'f', metaKey: true });
    expect(onFind).toHaveBeenCalledTimes(2);
  });

  it('blocks ordinary command bindings while typing in an input', () => {
    const onSearch = vi.fn();
    const { getByLabelText } = render(
      <CommandScopeProvider>
        <GlobalSearchHandler onSearch={onSearch} />
        <input aria-label="name" />
      </CommandScopeProvider>
    );

    const input = getByLabelText('name');
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'f',
          code: 'KeyF',
          metaKey: true,
          shiftKey: true,
          bubbles: true,
        })
      );
    });

    expect(onSearch).not.toHaveBeenCalled();
  });

  it('allows the command input focus binding through the input-editor blocker only', () => {
    const onFocus = vi.fn();
    const { getByLabelText } = render(
      <CommandScopeProvider>
        <CommandInputFocusHandler onFocus={onFocus} />
        <InputEditorScope />
        <input aria-label="chat input" />
      </CommandScopeProvider>
    );

    const input = getByLabelText('chat input');
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '/',
          code: 'Slash',
          metaKey: true,
          bubbles: true,
        })
      );
    });

    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['macOS', 'MacIntel', { metaKey: true }],
    ['Windows', 'Win32', { ctrlKey: true }],
  ])('routes New Chat through an already-focused input on %s', (_name, platform, modifier) => {
    Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
    const onNewChat = vi.fn();
    const { getByLabelText } = render(
      <CommandScopeProvider>
        <NewChatHandler onNewChat={onNewChat} />
        <InputEditorScope />
        <input aria-label="active editor" />
      </CommandScopeProvider>
    );

    const input = getByLabelText('active editor');
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'n',
          code: 'KeyN',
          ...modifier,
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('blocks New Chat behind a true modal but not a non-modal dialog', () => {
    const onNewChat = vi.fn();
    const { rerender } = render(
      <CommandScopeProvider>
        <NewChatHandler onNewChat={onNewChat} />
        <PresentationBoundary capture="modal">
          <div role="dialog" aria-modal="true" />
        </PresentationBoundary>
      </CommandScopeProvider>
    );

    press({ key: 'n', metaKey: true });
    expect(onNewChat).not.toHaveBeenCalled();

    rerender(
      <CommandScopeProvider>
        <NewChatHandler onNewChat={onNewChat} />
        <div role="dialog" />
      </CommandScopeProvider>
    );
    press({ key: 'n', metaKey: true });
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('leaves an explicitly owned shortcut with the focused widget', () => {
    const onFind = vi.fn();
    const onLocalFind = vi.fn();
    const { getByLabelText } = render(
      <CommandScopeProvider>
        <SequenceFindHandler onFind={onFind} />
        <input
          aria-label="sequence find"
          data-command-shortcut-owner="sequence.find"
          onKeyDown={onLocalFind}
        />
      </CommandScopeProvider>
    );

    fireEvent.keyDown(getByLabelText('sequence find'), { key: 'f', metaKey: true });

    expect(onFind).not.toHaveBeenCalled();
    expect(onLocalFind).toHaveBeenCalledTimes(1);
  });

  it('handles app-global bindings before a local keydown handler stops propagation', () => {
    const onFocus = vi.fn();
    const { getByLabelText } = render(
      <CommandScopeProvider>
        <CommandInputFocusHandler onFocus={onFocus} />
        <input
          aria-label="chat input"
          onKeyDown={(event) => {
            event.stopPropagation();
          }}
        />
      </CommandScopeProvider>
    );

    const input = getByLabelText('chat input');
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '/',
          code: 'Slash',
          metaKey: true,
          bubbles: true,
        })
      );
    });

    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it('keeps modal and context menu blockers above allow-in-input bindings', () => {
    const onFocus = vi.fn();

    render(
      <CommandScopeProvider>
        <CommandInputFocusHandler onFocus={onFocus} />
        <ContextMenuScope />
        <InputEditorScope />
      </CommandScopeProvider>
    );

    press({ key: '/', code: 'Slash', metaKey: true });

    expect(onFocus).not.toHaveBeenCalled();
  });
});
