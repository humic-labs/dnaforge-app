import { expect, it } from 'vitest';
import {
  matchesTerminalHistory,
  parseTerminalHistoryPins,
  terminalHistoryPinKey,
  historyEntriesWithPins,
} from './terminal-history-picker';

it('offers ordered fuzzy matching while retaining literal matching by default', () => {
  expect(matchesTerminalHistory('git checkout feature', 'gcf', false)).toBe(false);
  expect(matchesTerminalHistory('git checkout feature', 'gcf', true)).toBe(true);
  expect(matchesTerminalHistory('git checkout feature', 'fcg', true)).toBe(false);
  expect(matchesTerminalHistory('A[1];$(literal)', '[1];$', false)).toBe(true);
  expect(matchesTerminalHistory('anything', '', true)).toBe(true);
});

it('restores bounded pins separately for workspace, shell family and picker kind', () => {
  expect(parseTerminalHistoryPins('["echo one",4,"echo one","echo two"]')).toEqual([
    'echo one',
    'echo two',
  ]);
  expect(parseTerminalHistoryPins('malformed')).toEqual([]);
  expect(terminalHistoryPinKey('/workspace', '/bin/zsh', 'command')).toBe(
    terminalHistoryPinKey('/workspace', '/usr/local/bin/zsh', 'command')
  );
  expect(terminalHistoryPinKey('/workspace', '/bin/zsh', 'command')).not.toBe(
    terminalHistoryPinKey('/other', '/bin/zsh', 'command')
  );
  expect(terminalHistoryPinKey('/workspace', '/bin/zsh', 'command')).not.toBe(
    terminalHistoryPinKey('/workspace', '/bin/zsh', 'directory')
  );
  const entries = [{ text: 'new command' }, { text: 'old command' }];
  expect(historyEntriesWithPins(entries, ['old command'], '')).toEqual([
    { text: 'old command', pinned: true },
    { text: 'new command', pinned: false },
    { text: 'old command', pinned: false },
  ]);
  expect(historyEntriesWithPins(entries, ['old command'], 'old')).toEqual(
    entries.map((entry) => ({ ...entry, pinned: false }))
  );
});
