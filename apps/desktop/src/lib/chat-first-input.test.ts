import { describe, expect, it } from 'vitest';
import { COMMAND_IDS } from '../commands/types';
import { chatFirstCommandAllowed, isChatFirstInputEnabled } from './chat-first-input';

describe('Chat-first input experiment', () => {
  it('requires explicit opt-in and excludes hosted and release builds', () => {
    expect(isChatFirstInputEnabled({ DEV: true, MODE: 'test', VITE_CHAT_FIRST_INPUT: '1' })).toBe(
      true
    );
    for (const env of [
      { DEV: true, MODE: 'development' },
      { DEV: true, MODE: 'hosted', VITE_CHAT_FIRST_INPUT: '1' },
      { DEV: false, MODE: 'production', VITE_CHAT_FIRST_INPUT: '1' },
      { DEV: false, MODE: 'staging', VITE_CHAT_FIRST_INPUT: '1' },
    ])
      expect(isChatFirstInputEnabled(env)).toBe(false);
  });

  it('allows agent commands but rejects manual authoring and execution sources', () => {
    for (const command of [
      COMMAND_IDS.fileSave,
      COMMAND_IDS.fileRename,
      COMMAND_IDS.fileNewText,
      COMMAND_IDS.editUndo,
      COMMAND_IDS.terminalNew,
    ]) {
      expect(chatFirstCommandAllowed(command, 'agent')).toBe(true);
      for (const source of ['ui', 'keyboard', 'electron-menu', 'test'] as const)
        expect(chatFirstCommandAllowed(command, source)).toBe(false);
    }
    expect(chatFirstCommandAllowed(COMMAND_IDS.canvasSelectTab, 'ui')).toBe(true);
    expect(chatFirstCommandAllowed(COMMAND_IDS.appFocusCommandInput, 'keyboard')).toBe(true);
  });

  it('allows native edits and saves from a document', () => {
    expect(chatFirstCommandAllowed(COMMAND_IDS.fileSave, 'keyboard', true)).toBe(true);
    expect(chatFirstCommandAllowed(COMMAND_IDS.editUndo, 'electron-menu', true)).toBe(true);
    expect(chatFirstCommandAllowed(COMMAND_IDS.terminalNew, 'ui', true)).toBe(false);
  });
});
