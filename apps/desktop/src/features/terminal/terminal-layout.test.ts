import { expect, it } from 'vitest';
import {
  terminalPaneSizes,
  reorderTerminalGroups,
  moveTerminalPane,
  unsplitTerminalPane,
  splitTerminalPane,
  resizeTerminalPaneSizes,
  migrateTerminalGroupViews,
  terminalGroupViewId,
  moveTerminalGroupToView,
  type TerminalGroup,
} from './terminal-layout';

it('migrates old layouts without collapsing explicit independent app-tab ownership', () => {
  const legacy: TerminalGroup[] = [
    { id: 'one', sessions: ['a', 'b'] },
    { id: 'two', sessions: ['c'] },
  ];
  expect(migrateTerminalGroupViews(legacy, 'sessions').map(terminalGroupViewId)).toEqual([
    'terminal-workspace',
    'terminal-workspace',
  ]);
  expect(migrateTerminalGroupViews(legacy, 'tabs').map(terminalGroupViewId)).toEqual([
    'one',
    'two',
  ]);
  const independent = legacy.map((group, index) => ({ ...group, viewId: `view-${index}` }));
  expect(migrateTerminalGroupViews(independent, 'sessions').map(terminalGroupViewId)).toEqual([
    'view-0',
    'view-1',
  ]);
});

it('restores each sidebar shell or split as its own tab and keeps existing nested shells together', () => {
  expect(
    migrateTerminalGroupViews([
      { id: 'a', sessions: ['a'], placement: 'panel', viewId: 'terminal-workspace' },
      { id: 'b', sessions: ['b', 'c'], placement: 'panel', viewId: 'terminal-workspace' },
      { id: 'd', sessions: ['d'], placement: 'editor', viewId: 'tools' },
      { id: 'e', sessions: ['e'], placement: 'editor', viewId: 'tools' },
    ]).map((group) => [group.viewId, group.sessions])
  ).toEqual([
    ['a', ['a']],
    ['b', ['b', 'c']],
    ['tools', ['d']],
    ['tools', ['e']],
  ]);
});

it('moves a whole split subtab to another app tab while preserving other subtabs and native IDs', () => {
  const groups: TerminalGroup[] = [
    {
      id: 'one',
      sessions: ['a', 'b'],
      viewId: 'view-a',
      sizes: { a: 30, b: 70 },
    },
    { id: 'two', sessions: ['c'], viewId: 'view-a' },
    { id: 'three', sessions: ['d'], viewId: 'view-b' },
  ];
  const moved = moveTerminalGroupToView(groups, 'b', 'view-c');
  expect(moved[0]).toEqual({ ...groups[0], viewId: 'view-c' });
  expect(moved[1]).toBe(groups[1]);
  expect(moved[2]).toBe(groups[2]);
  expect(splitTerminalPane(moved, 'a', 'new')[0]).toMatchObject({
    viewId: 'view-c',
    sessions: ['a', 'new', 'b'],
  });
  expect(unsplitTerminalPane(moved, 'b', 'separate').at(-1)).toMatchObject({
    viewId: 'view-c',
    sessions: ['b'],
  });
});

it('restores a terminal-only native window into its original floating window, without canvas app tabs', () => {
  const groups: TerminalGroup[] = [{ id: 'floating', sessions: ['a', 'b'] }];
  expect(migrateTerminalGroupViews(groups, undefined, 'floating')).toMatchObject([
    { id: 'floating', sessions: ['a', 'b'], viewId: 'floating' },
  ]);
});

it('resizes the active pane against its neighbor in cell-sized pixels with the upstream minimum', () => {
  expect(resizeTerminalPaneSizes(['a', 'b'], { a: 60, b: 40 }, 'a', false, 40, 1000)).toEqual({
    a: 64,
    b: 36,
  });
  expect(resizeTerminalPaneSizes(['a', 'b'], { a: 60, b: 40 }, 'b', true, 40, 1000)).toEqual({
    a: 56,
    b: 44,
  });
  expect(
    resizeTerminalPaneSizes(['a', 'b', 'c'], { a: 20, b: 40, c: 40 }, 'b', true, 40, 1000)
  ).toEqual({ a: 20, b: 36, c: 44 });
  expect(resizeTerminalPaneSizes(['a', 'b'], { a: 90, b: 10 }, 'a', false, 40, 1000)).toEqual({
    a: 92,
    b: 8,
  });
  expect(resizeTerminalPaneSizes(['a', 'b'], { a: 8, b: 92 }, 'a', true, 40, 1000)).toBe(null);
  expect(resizeTerminalPaneSizes(['a'], { a: 100 }, 'a', false, 40, 1000)).toBe(null);
  expect(resizeTerminalPaneSizes(['a', 'b'], { a: 50, b: 50 }, 'missing', false, 40, 1000)).toBe(
    null
  );
});

it('inserts a split directly after its parent and distributes all pane sizes', () => {
  const groups: TerminalGroup[] = [
    {
      id: 'one',
      sessions: ['a', 'b'],
      direction: 'vertical',
      sizes: { a: 20, b: 80 },
    },
    { id: 'two', sessions: ['c'] },
  ];
  const split = splitTerminalPane(groups, 'a', 'new');
  expect(split[0]).toEqual({
    ...groups[0],
    sessions: ['a', 'new', 'b'],
    sizes: { a: 100 / 3, new: 100 / 3, b: 100 / 3 },
  });
  expect(split[1]).toBe(groups[1]);
  expect(groups[0]?.sessions).toEqual(['a', 'b']);
  expect(splitTerminalPane(groups, 'missing', 'new')).toBe(groups);
  expect(splitTerminalPane(groups, 'a', 'c')).toBe(groups);
});

it('preserves relative pane sizes when a session leaves and rejects invalid saved sizes', () => {
  expect(terminalPaneSizes(['a', 'c'], { a: 20, b: 40, c: 40 })).toEqual({
    a: 100 / 3,
    c: 200 / 3,
  });
  expect(terminalPaneSizes(['a', 'b'], { a: NaN, b: -1 })).toEqual({ a: 50, b: 50 });
  expect(terminalPaneSizes(['a', 'b'], { a: 0, b: 0 })).toEqual({ a: 50, b: 50 });
});

it('moves a whole group in the persisted order without breaking its split', () => {
  const groups: TerminalGroup[] = [
    { id: 'one', sessions: ['a', 'b'], sizes: { a: 30, b: 70 } },
    { id: 'two', sessions: ['c'] },
    { id: 'three', sessions: ['d'] },
  ];
  const moved = reorderTerminalGroups(groups, 'b', 'd', 'after');
  expect(moved.map((group) => group.id)).toEqual(['two', 'three', 'one']);
  expect(moved[2]).toEqual(groups[0]);
  expect(groups.map((group) => group.id)).toEqual(['one', 'two', 'three']);
  expect(reorderTerminalGroups(groups, 'b', 'a', 'before')[0]?.sessions).toEqual(['b', 'a']);
  expect(reorderTerminalGroups(groups, 'missing', 'c')).toBe(groups);
});

it('moves a live pane between groups, removes empty groups and preserves target placement', () => {
  const groups: TerminalGroup[] = [
    { id: 'one', sessions: ['a', 'b'], sizes: { a: 30, b: 70 } },
    { id: 'two', sessions: ['c'], direction: 'vertical' },
  ];
  const moved = moveTerminalPane(groups, 'a', 'c', 'before');
  expect(moved[0]?.sessions).toEqual(['b']);
  expect(moved[0]?.sizes).toEqual({ b: 100 });
  expect(moved[1]).toMatchObject({
    sessions: ['a', 'c'],
    direction: 'vertical',
  });
  const joined = moveTerminalPane(moved, 'b', 'c', 'after');
  expect(joined.map((group) => group.sessions)).toEqual([['a', 'c', 'b']]);
  expect(moveTerminalPane(joined, 'b', 'a', 'before')[0]?.sessions).toEqual(['b', 'a', 'c']);
  expect(moveTerminalPane(groups, 'missing', 'c', 'before')).toBe(groups);
  expect(moveTerminalPane(groups, 'a', 'a', 'after')).toBe(groups);
});

it('unsplits exactly one pane into its own persisted group without losing other panes', () => {
  const groups: TerminalGroup[] = [{ id: 'one', sessions: ['a', 'b'] }];
  expect(unsplitTerminalPane(groups, 'b', 'new')).toEqual([
    { id: 'one', sessions: ['a'], sizes: { a: 100 } },
    { id: 'new', sessions: ['b'], viewId: 'one' },
  ]);
  expect(unsplitTerminalPane(groups, 'b', 'one')).toBe(groups);
  expect(unsplitTerminalPane([{ id: 'one', sessions: ['a'] }], 'a', 'new')).toEqual([
    { id: 'one', sessions: ['a'] },
  ]);
});
