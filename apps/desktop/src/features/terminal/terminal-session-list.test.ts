import { expect, it } from 'vitest';
import {
  moveListSession,
  normalizeSessionList,
  type TerminalListEntry,
} from './terminal-session-list';
import { moveIndividualTerminalToView } from './terminal-layout';

it('restores standalone shells and groups independently of split membership and placement', () => {
  const group = { id: 'folder', name: 'Analysis', sessions: ['a', 'gone', 'a'], collapsed: true };
  expect(normalizeSessionList([group, 'b', 'a', { broken: true }], ['a', 'b', 'c'])).toEqual([
    { ...group, sessions: ['a'] },
    'b',
    'c',
  ]);
  expect(normalizeSessionList(undefined, ['b', 'a'])).toEqual(['b', 'a']);
});

it('moves and reorders an individual shell between a folder and the standalone list', () => {
  const folder = { id: 'folder', name: 'Analysis', collapsed: false, sessions: ['a', 'b'] };
  const list: TerminalListEntry[] = [folder, 'c'];
  const moved = moveListSession(list, 'c', 'folder', 'b', 'before');
  expect(moved).toEqual([{ ...folder, sessions: ['a', 'c', 'b'] }]);
  expect(moveListSession(moved, 'a', null)).toEqual([{ ...folder, sessions: ['c', 'b'] }, 'a']);
  expect(moveListSession(list, 'a', 'missing')).toEqual(list);
});

it('promotes just one split pane and preserves the sibling view and native sessions', () => {
  const groups = [
    {
      id: 'a',
      viewId: 'panel',
      placement: 'panel' as const,
      sessions: ['a', 'b', 'c'],
      sizes: { a: 30, b: 30, c: 40 },
    },
  ];
  const moved = moveIndividualTerminalToView(groups, 'a', 'new-view');
  expect(moved).toEqual([
    { ...groups[0], sessions: ['b', 'c'], sizes: { b: (30 * 100) / 70, c: (40 * 100) / 70 } },
    { id: 'new-view', viewId: 'new-view', placement: 'editor', sessions: ['a'] },
  ]);
  expect(moveIndividualTerminalToView(groups, 'gone', 'new-view')).toBe(groups);
});
