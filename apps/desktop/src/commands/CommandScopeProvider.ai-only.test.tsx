import React from 'react';
import { act, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CommandScopeProvider } from './CommandScopeProvider';
import { useCommandHandler } from './useCommandHandler';
import { getMountedCommandRegistry } from './mounted-command-registry';
import { COMMAND_IDS } from './types';

vi.mock('../lib/ai-only-input', async (original) => ({
  ...(await original<typeof import('../lib/ai-only-input')>()),
  AI_ONLY_INPUT: true,
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
