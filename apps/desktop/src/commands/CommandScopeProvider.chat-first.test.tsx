import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CommandScopeProvider } from './CommandScopeProvider';
import { useCommandHandler } from './useCommandHandler';
import { getMountedCommandRegistry } from './mounted-command-registry';
import { COMMAND_IDS } from './types';

vi.mock('../lib/chat-first-input', async (original) => ({
  ...(await original<typeof import('../lib/chat-first-input')>()),
  CHAT_FIRST_INPUT: true,
}));

it('blocks UI, shortcut and native-menu edits while allowing the same registered agent operation', () => {
  const edit = vi.fn(() => true);
  function EditorCommand() {
    useCommandHandler(COMMAND_IDS.fileNewText, edit);
    return null;
  }
  const mounted = render(
    <CommandScopeProvider>
      <EditorCommand />
    </CommandScopeProvider>
  );
  try {
    const registry = getMountedCommandRegistry();
    expect(registry).not.toBeNull();
    for (const source of ['ui', 'keyboard', 'electron-menu'] as const) {
      act(() => {
        expect(registry?.dispatchCommand(COMMAND_IDS.fileNewText, { source })).toMatchObject({
          handled: false,
          blocked: true,
        });
      });
    }
    expect(edit).not.toHaveBeenCalled();
    act(() => {
      expect(registry?.dispatchCommand(COMMAND_IDS.fileNewText, { source: 'agent' })).toMatchObject(
        { handled: true, blocked: false }
      );
    });
    expect(edit).toHaveBeenCalledOnce();
  } finally {
    mounted.unmount();
  }
});

it('permits Save only when focus is inside an explicitly opened manual editor', () => {
  const save = vi.fn(() => true);
  function Editor() {
    useCommandHandler(COMMAND_IDS.fileSave, save);
    return (
      <>
        <div data-ai-input-region="output">
          <input data-testid="inspect-field" />
        </div>
        <div data-ai-input-region="manual">
          <input data-testid="edit-field" />
        </div>
      </>
    );
  }
  const mounted = render(
    <CommandScopeProvider>
      <Editor />
    </CommandScopeProvider>
  );
  try {
    const registry = getMountedCommandRegistry();
    screen.getByTestId('inspect-field').focus();
    act(() => {
      expect(registry?.dispatchCommand(COMMAND_IDS.fileSave, { source: 'keyboard' })).toMatchObject(
        { blocked: true }
      );
    });
    screen.getByTestId('edit-field').focus();
    act(() => {
      expect(registry?.dispatchCommand(COMMAND_IDS.fileSave, { source: 'keyboard' })).toMatchObject(
        { handled: true, blocked: false }
      );
    });
    expect(save).toHaveBeenCalledOnce();
  } finally {
    mounted.unmount();
  }
});
