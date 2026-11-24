import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_IDS } from '../commands/types';
import {
  aiOnlyCommandAllowed,
  installAiOnlyHumanInputGuard,
  isAiOnlyInputEnabled,
} from './ai-only-input';

let dispose = () => {};
afterEach(() => {
  dispose();
  document.body.innerHTML = '';
});

describe('AI-only input experiment', () => {
  it('requires explicit opt-in and excludes hosted and release builds', () => {
    expect(isAiOnlyInputEnabled({ DEV: true, MODE: 'test', VITE_AI_ONLY_INPUT: '1' })).toBe(true);
    for (const env of [
      { DEV: true, MODE: 'development' },
      { DEV: true, MODE: 'hosted', VITE_AI_ONLY_INPUT: '1' },
      { DEV: false, MODE: 'production', VITE_AI_ONLY_INPUT: '1' },
      { DEV: false, MODE: 'staging', VITE_AI_ONLY_INPUT: '1' },
    ])
      expect(isAiOnlyInputEnabled(env)).toBe(false);
  });

  it('allows agent commands but rejects manual authoring and execution sources', () => {
    for (const command of [
      COMMAND_IDS.fileSave,
      COMMAND_IDS.fileRename,
      COMMAND_IDS.fileNewText,
      COMMAND_IDS.editUndo,
      COMMAND_IDS.terminalNew,
    ]) {
      expect(aiOnlyCommandAllowed(command, 'agent')).toBe(true);
      for (const source of ['ui', 'keyboard', 'electron-menu', 'test'] as const)
        expect(aiOnlyCommandAllowed(command, source)).toBe(false);
    }
    expect(aiOnlyCommandAllowed(COMMAND_IDS.canvasSelectTab, 'ui')).toBe(true);
    expect(aiOnlyCommandAllowed(COMMAND_IDS.appFocusCommandInput, 'keyboard')).toBe(true);
  });

  it('blocks manual edits, drops and portalled controls, keeps chat and navigation, and cleans up', () => {
    document.body.innerHTML =
      '<div data-ai-input-region="conversation"><textarea></textarea></div><div data-ai-input-region="navigation"><button>View</button></div><div contenteditable="true">Output</div><button id="portal">Rename</button>';
    const output = document.querySelector('[contenteditable]');
    const chat = document.querySelector('textarea');
    const navigation = document.querySelector('[data-ai-input-region="navigation"] button');
    const portal = document.getElementById('portal');
    const edited = vi.fn();
    output?.addEventListener('beforeinput', edited);
    dispose = installAiOnlyHumanInputGuard(document);
    for (const type of [
      'beforeinput',
      'paste',
      'cut',
      'drop',
      'dragstart',
      'click',
      'dblclick',
      'contextmenu',
    ]) {
      expect(output?.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))).toBe(
        false
      );
      expect(chat?.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))).toBe(true);
    }
    expect(edited).not.toHaveBeenCalled();
    expect(
      portal?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    ).toBe(false);
    expect(
      navigation?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    ).toBe(true);
    expect(
      navigation?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    ).toBe(true);
    expect(
      output?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
      )
    ).toBe(false);
    dispose();
    expect(
      output?.dispatchEvent(new Event('beforeinput', { bubbles: true, cancelable: true }))
    ).toBe(true);
    expect(edited).toHaveBeenCalledOnce();
  });
});
