// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { formatShortcut } from '@waypoint/ui-components/keyboard';
import { DEFAULT_COMMAND_BINDINGS } from '../commands/defaultBindings';
import { COMMAND_IDS, type CommandId } from '../commands/types';
import {
  APP_SHORTCUTS,
  SHORTCUT_AREAS,
  chordKey,
  commandBindingsFromRegistry,
  type AppShortcut,
} from './shortcutRegistry';

function keysOn(shortcut: AppShortcut, apple: boolean): string[] {
  return shortcut.chords.map((definition) => chordKey(definition, apple));
}

function overlaps(left: AppShortcut, right: AppShortcut): boolean {
  for (const apple of [true, false]) {
    const keys = new Set(keysOn(left, apple));
    if (keysOn(right, apple).some((key) => keys.has(key))) return true;
  }
  return false;
}

function bindingIdentity(binding: {
  command: string;
  key: string;
  cmd?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}): string {
  return [
    binding.command,
    binding.key.toLowerCase(),
    binding.cmd ? 'cmd' : '',
    binding.ctrl ? 'ctrl' : '',
    binding.shift ? 'shift' : '',
    binding.alt ? 'alt' : '',
  ].join('|');
}

describe('shortcut registry', () => {
  it('keeps ids unique and every row inside a known area', () => {
    const ids = APP_SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
    const areas = new Set(SHORTCUT_AREAS.map((area) => area.id));
    for (const shortcut of APP_SHORTCUTS) {
      expect(areas.has(shortcut.area)).toBe(true);
      expect(shortcut.chords.length).toBeGreaterThan(0);
    }
    for (const area of SHORTCUT_AREAS) {
      expect(APP_SHORTCUTS.some((shortcut) => shortcut.area === area.id)).toBe(true);
    }
    expect(APP_SHORTCUTS.some((shortcut) => shortcut.area === 'developer')).toBe(false);
    expect(SHORTCUT_AREAS.some((area) => area.id === 'developer')).toBe(false);
  });

  it('matches the seven shortcuts Settings already shows', () => {
    const legacy = [
      ['AI Chat', '⌘/', 'Ctrl+/'],
      ['Settings', '⌘,', 'Ctrl+,'],
      ['Explorer', '⌘⇧E', 'Ctrl+Shift+E'],
      ['Search', '⌘⇧F', 'Ctrl+Shift+F'],
      ['Toggle Sidebar', '⌘⇧B', 'Ctrl+Shift+B'],
      ['Dark Mode', '⌘⇧D', 'Ctrl+Shift+D'],
      ['Save', '⌘S', 'Ctrl+S'],
    ] as const;
    for (const [label, mac, windows] of legacy) {
      const shortcut = APP_SHORTCUTS.find((candidate) => candidate.label === label);
      expect(shortcut?.availability).toBe('active');
      expect(formatShortcut(shortcut?.chords[0], 'MacIntel')).toBe(mac);
      expect(formatShortcut(shortcut?.chords[0], 'Win32')).toBe(windows);
    }
  });

  it('covers every command binding and every command id', () => {
    const bound = commandBindingsFromRegistry().map(bindingIdentity).sort();
    expect(bound).toEqual(DEFAULT_COMMAND_BINDINGS.map(bindingIdentity).sort());
    expect(bound).toEqual(
      [
        `${COMMAND_IDS.appNewChat}|n|cmd|||`,
        `${COMMAND_IDS.appGoToFile}|p|cmd|||`,
        `${COMMAND_IDS.canvasCloseOtherTabs}|w|cmd|||alt`,
        `${COMMAND_IDS.workspaceRevealActiveFile}|e|cmd|||alt`,
        `${COMMAND_IDS.chatPrevious}|[|cmd|||alt`,
        `${COMMAND_IDS.chatNext}|]|cmd|||alt`,
        `${COMMAND_IDS.appFocusCommandInput}|/|cmd|||`,
        `${COMMAND_IDS.appOpenSettings}|,|cmd|||`,
        `${COMMAND_IDS.appToggleSidebar}|b|cmd||shift|`,
        `${COMMAND_IDS.appShowExplorer}|e|cmd||shift|`,
        `${COMMAND_IDS.workspaceSearch}|f|cmd||shift|`,
        `${COMMAND_IDS.editUndo}|z|cmd|||`,
        `${COMMAND_IDS.editRedo}|z|cmd||shift|`,
        `${COMMAND_IDS.editRedo}|y||ctrl||`,
        `${COMMAND_IDS.fileNewFolder}|n|cmd||shift|`,
        `${COMMAND_IDS.fileSave}|s|cmd|||`,
        `${COMMAND_IDS.sequenceFind}|f|cmd|||`,
        `${COMMAND_IDS.pdfZoomIn}|=|cmd|||`,
        `${COMMAND_IDS.pdfZoomIn}|+|cmd||shift|`,
        `${COMMAND_IDS.pdfZoomIn}|+|cmd|||`,
        `${COMMAND_IDS.pdfZoomIn}|=|cmd||shift|`,
        `${COMMAND_IDS.pdfZoomOut}|-|cmd|||`,
        `${COMMAND_IDS.pdfResetZoom}|0|cmd|||`,
        `${COMMAND_IDS.terminalToggle}|\`||ctrl||`,
        `${COMMAND_IDS.terminalNew}|\`||ctrl|shift|`,
      ].sort()
    );

    const covered = new Set<CommandId>(
      APP_SHORTCUTS.flatMap((shortcut) => shortcut.commandIds ?? [])
    );
    const commandsWithoutShortcuts = new Set<CommandId>([
      COMMAND_IDS.appShowRegistry,
      COMMAND_IDS.workspaceRevealPath,
      COMMAND_IDS.fileNewText,
      COMMAND_IDS.terminalRunSelection,
      COMMAND_IDS.terminalRunActiveFile,
    ]);
    const expectedCommands = Object.values(COMMAND_IDS).filter(
      (id) => !commandsWithoutShortcuts.has(id)
    );
    expect([...covered].sort()).toEqual(expectedCommands.sort());
  });

  it('does not pretend a suggestion is already bound', () => {
    for (const shortcut of APP_SHORTCUTS.filter(
      (candidate) => candidate.availability === 'suggested'
    )) {
      expect(shortcut.commandBindings).toBeUndefined();
      expect(shortcut.inAppMenu).toBeUndefined();
    }
  });

  it('keeps one active chord per scope, and records cross-scope clashes', () => {
    const active = APP_SHORTCUTS.filter((shortcut) => shortcut.availability === 'active');
    for (const scope of new Set(active.map((shortcut) => shortcut.scope))) {
      const seen = new Map<string, string>();
      for (const shortcut of active.filter((candidate) => candidate.scope === scope)) {
        for (const apple of [true, false]) {
          for (const key of keysOn(shortcut, apple)) {
            const id = `${apple}:${key}`;
            const previous = seen.get(id);
            expect(previous, `${shortcut.id} reuses ${key}`).toBeUndefined();
            seen.set(id, shortcut.id);
          }
        }
      }
    }

    for (const shortcut of active) {
      for (const other of active) {
        if (other.id === shortcut.id || !overlaps(shortcut, other)) continue;
        const mustShare =
          shortcut.scope === 'global' ||
          other.scope === 'global' ||
          shortcut.scope === 'development' ||
          other.scope === 'development';
        if (!mustShare) continue;
        expect(shortcut.sharesChordWith, shortcut.id).toContain(other.id);
        expect(other.sharesChordWith, other.id).toContain(shortcut.id);
      }
    }

    for (const shortcut of APP_SHORTCUTS) {
      for (const otherId of shortcut.sharesChordWith ?? []) {
        const other = APP_SHORTCUTS.find((candidate) => candidate.id === otherId);
        expect(other, otherId).toBeTruthy();
        expect(other?.sharesChordWith).toContain(shortcut.id);
        expect(overlaps(shortcut, other!)).toBe(true);
      }
    }
  });

  it('keeps suggestions off chords that already work in that scope or everywhere', () => {
    const active = APP_SHORTCUTS.filter((shortcut) => shortcut.availability === 'active');
    const suggested = APP_SHORTCUTS.filter((shortcut) => shortcut.availability === 'suggested');
    for (const suggestion of suggested) {
      for (const existing of active) {
        if (!overlaps(suggestion, existing)) continue;
        const blocked =
          suggestion.scope === 'global' ||
          existing.scope === 'global' ||
          suggestion.scope === existing.scope;
        expect(blocked, `${suggestion.id} collides with ${existing.id}`).toBe(false);
      }
    }
    for (let index = 0; index < suggested.length; index += 1) {
      for (const other of suggested.slice(index + 1)) {
        if (!overlaps(suggested[index], other)) continue;
        const blocked =
          suggested[index].scope === 'global' ||
          other.scope === 'global' ||
          suggested[index].scope === other.scope;
        expect(blocked, `${suggested[index].id} collides with ${other.id}`).toBe(false);
      }
    }
  });
});

it('declares pane cycling once and leaves its registered command dispatch in bubble phase', () => {
  const next = APP_SHORTCUTS.find((row) => row.id === 'tabs.next');
  const previous = APP_SHORTCUTS.find((row) => row.id === 'tabs.previous');
  expect(next).toMatchObject({
    availability: 'active',
    area: 'tabs',
    commandIds: [COMMAND_IDS.canvasNextTab],
  });
  expect(previous).toMatchObject({
    availability: 'active',
    area: 'tabs',
    commandIds: [COMMAND_IDS.canvasPreviousTab],
  });
  expect(chordKey(next!.chords[0], true)).toBe('ctrl+tab');
  expect(chordKey(previous!.chords[0], false)).toBe('ctrl+shift+tab');
  expect(
    commandBindingsFromRegistry().some(
      (row) =>
        row.command === COMMAND_IDS.canvasNextTab || row.command === COMMAND_IDS.canvasPreviousTab
    )
  ).toBe(false);
});
