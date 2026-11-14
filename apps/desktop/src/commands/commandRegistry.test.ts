import { afterEach, describe, expect, it } from 'vitest';
import {
  assertUniqueCommandDefinitions,
  isCommandBlockedByScope,
  getHighestActiveFocusScope,
  keyboardCommandBelongsToTarget,
  matchesCommandBinding,
  resolveCommandHandler,
} from './commandRegistry';
import { COMMAND_IDS, COMMAND_SCOPES, type CommandHandlerRegistration } from './types';
import { DEFAULT_COMMAND_BINDINGS } from './defaultBindings';

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: init.key ?? 'f',
    code: init.code ?? `Key${(init.key ?? 'f').toUpperCase()}`,
    metaKey: init.metaKey,
    ctrlKey: init.ctrlKey,
    shiftKey: init.shiftKey,
    altKey: init.altKey,
  });
}

function mockNavigatorPlatform(platform: string, userAgentDataPlatform?: string): void {
  Object.defineProperty(navigator, 'platform', {
    value: platform,
    configurable: true,
  });
  Object.defineProperty(navigator, 'userAgentData', {
    value: userAgentDataPlatform ? { platform: userAgentDataPlatform } : undefined,
    configurable: true,
  });
}

describe('commandRegistry', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'userAgentData', {
      value: undefined,
      configurable: true,
    });
  });

  it('shares terminal and exact nested shortcut ownership with deferred pane commands', () => {
    const terminal = document.createElement('div');
    terminal.dataset.terminalSurface = '';
    const button = document.createElement('button');
    terminal.append(button);
    const event = keydown({ key: 'Tab', ctrlKey: true });
    button.dispatchEvent(event);
    expect(keyboardCommandBelongsToTarget(event, COMMAND_IDS.canvasNextTab)).toBe(false);
    expect(keyboardCommandBelongsToTarget(event, COMMAND_IDS.canvasPreviousTab)).toBe(false);
    expect(keyboardCommandBelongsToTarget(event, COMMAND_IDS.fileSave)).toBe(true);
    expect(keyboardCommandBelongsToTarget(event, COMMAND_IDS.terminalNew)).toBe(false);
    terminal.removeAttribute('data-terminal-surface');
    terminal.dataset.commandShortcutOwner = COMMAND_IDS.canvasNextTab;
    expect(keyboardCommandBelongsToTarget(event, COMMAND_IDS.canvasNextTab)).toBe(true);
    expect(keyboardCommandBelongsToTarget(event, COMMAND_IDS.canvasPreviousTab)).toBe(false);
  });

  it('lets workspace tab cycling through terminal input while preserving other shell keys', () => {
    const terminal = document.createElement('div');
    terminal.dataset.terminalSurface = '';
    const input = document.createElement('textarea');
    terminal.append(input);
    const event = keydown({ key: 'Tab', ctrlKey: true });
    input.dispatchEvent(event);
    expect(keyboardCommandBelongsToTarget(event, COMMAND_IDS.canvasNextTab)).toBe(false);
    expect(keyboardCommandBelongsToTarget(event, COMMAND_IDS.canvasPreviousTab)).toBe(false);
    expect(keyboardCommandBelongsToTarget(event, COMMAND_IDS.fileSave)).toBe(true);
    terminal.removeAttribute('data-terminal-surface');
    expect(keyboardCommandBelongsToTarget(event, COMMAND_IDS.canvasNextTab)).toBe(true);
  });

  it('preserves the established editable exception for bindings that explicitly allow input', () => {
    const input = document.createElement('input');
    const event = keydown({ key: 's', metaKey: true });
    input.dispatchEvent(event);
    expect(keyboardCommandBelongsToTarget(event, COMMAND_IDS.fileSave)).toBe(true);
    expect(keyboardCommandBelongsToTarget(event, COMMAND_IDS.fileSave, true)).toBe(false);
  });

  it('rejects duplicate command ids', () => {
    expect(() =>
      assertUniqueCommandDefinitions([
        { id: COMMAND_IDS.workspaceSearch },
        { id: COMMAND_IDS.workspaceSearch },
      ])
    ).toThrow('Duplicate command id: workspace.search');
  });

  it('matches command bindings with exact modifiers', () => {
    const binding = {
      command: COMMAND_IDS.workspaceSearch,
      key: 'f',
      cmd: true,
      shift: true,
    };

    expect(
      matchesCommandBinding(
        keydown({ key: 'f', metaKey: true, shiftKey: true }),
        binding,
        'MacIntel'
      )
    ).toBe(true);
    expect(matchesCommandBinding(keydown({ key: 'f', metaKey: true }), binding, 'MacIntel')).toBe(
      false
    );
    expect(
      matchesCommandBinding(
        keydown({ key: 'f', metaKey: true, shiftKey: true, altKey: true }),
        binding,
        'MacIntel'
      )
    ).toBe(false);
    expect(
      matchesCommandBinding(keydown({ key: 'f', ctrlKey: true, shiftKey: true }), binding, 'Win32')
    ).toBe(true);
  });

  it('binds New Folder to Cmd/Ctrl+Shift+N on both platform families', () => {
    const binding = DEFAULT_COMMAND_BINDINGS.find(
      (candidate) => candidate.command === COMMAND_IDS.fileNewFolder
    );
    expect(binding).toBeTruthy();
    expect(
      matchesCommandBinding(
        keydown({ key: 'n', metaKey: true, shiftKey: true }),
        binding!,
        'MacIntel'
      )
    ).toBe(true);
    expect(
      matchesCommandBinding(keydown({ key: 'n', ctrlKey: true, shiftKey: true }), binding!, 'Win32')
    ).toBe(true);
  });

  it('binds undo and redo to the standard platform shortcuts', () => {
    const undo = DEFAULT_COMMAND_BINDINGS.find(
      (candidate) => candidate.command === COMMAND_IDS.editUndo
    );
    const redo = DEFAULT_COMMAND_BINDINGS.filter(
      (candidate) => candidate.command === COMMAND_IDS.editRedo
    );

    expect(undo).toBeTruthy();
    expect(matchesCommandBinding(keydown({ key: 'z', metaKey: true }), undo!, 'MacIntel')).toBe(
      true
    );
    expect(matchesCommandBinding(keydown({ key: 'z', ctrlKey: true }), undo!, 'Win32')).toBe(true);
    expect(
      redo.some((binding) =>
        matchesCommandBinding(
          keydown({ key: 'z', metaKey: true, shiftKey: true }),
          binding,
          'MacIntel'
        )
      )
    ).toBe(true);
    expect(
      redo.some((binding) =>
        matchesCommandBinding(keydown({ key: 'y', ctrlKey: true }), binding, 'Win32')
      )
    ).toBe(true);
  });

  it('uses navigator.platform over userAgentData when resolving Cmd/Ctrl bindings', () => {
    mockNavigatorPlatform('MacIntel', 'Windows');

    const binding = {
      command: COMMAND_IDS.appFocusCommandInput,
      key: 'k',
      cmd: true,
    };

    expect(matchesCommandBinding(keydown({ key: 'k', metaKey: true }), binding)).toBe(true);
    expect(matchesCommandBinding(keydown({ key: 'k', ctrlKey: true }), binding)).toBe(false);
  });

  it('chooses the highest-priority active scoped handler', () => {
    const globalHandler: CommandHandlerRegistration = {
      command: COMMAND_IDS.workspaceSearch,
      scope: COMMAND_SCOPES.appGlobal,
      handler: () => true,
    };
    const fileTreeHandler: CommandHandlerRegistration = {
      command: COMMAND_IDS.workspaceSearch,
      scope: COMMAND_SCOPES.sidebarFileTree,
      handler: () => true,
    };
    const sequenceHandler: CommandHandlerRegistration = {
      command: COMMAND_IDS.workspaceSearch,
      scope: COMMAND_SCOPES.tabSequence,
      handler: () => true,
    };

    expect(
      resolveCommandHandler(
        COMMAND_IDS.workspaceSearch,
        [globalHandler, sequenceHandler, fileTreeHandler],
        new Set([
          COMMAND_SCOPES.appGlobal,
          COMMAND_SCOPES.tabSequence,
          COMMAND_SCOPES.sidebarFileTree,
        ])
      )
    ).toBe(fileTreeHandler);
  });

  it('does not route stale lower-priority tab handlers after a higher-priority surface takes focus', () => {
    const sequenceHandler: CommandHandlerRegistration = {
      command: COMMAND_IDS.sequenceFind,
      scope: COMMAND_SCOPES.tabSequence,
      handler: () => true,
    };

    expect(
      resolveCommandHandler(
        COMMAND_IDS.sequenceFind,
        [sequenceHandler],
        new Set([COMMAND_SCOPES.appGlobal, COMMAND_SCOPES.sidebarFileTree])
      )
    ).toBeNull();
  });

  it('reports the highest-priority active focus surface', () => {
    expect(
      getHighestActiveFocusScope(
        new Set([
          COMMAND_SCOPES.appGlobal,
          COMMAND_SCOPES.tabSequence,
          COMMAND_SCOPES.sidebarFileTree,
        ])
      )
    ).toBe(COMMAND_SCOPES.sidebarFileTree);
  });

  it('blocks lower scopes when a context menu is active', () => {
    const globalHandler: CommandHandlerRegistration = {
      command: COMMAND_IDS.workspaceSearch,
      scope: COMMAND_SCOPES.appGlobal,
      handler: () => true,
    };

    expect(
      isCommandBlockedByScope(
        globalHandler,
        new Set([COMMAND_SCOPES.appGlobal, COMMAND_SCOPES.menuContext])
      )
    ).toBe(true);
  });
});
