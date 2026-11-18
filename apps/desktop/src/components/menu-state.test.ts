import { describe, expect, it } from 'vitest';
import {
  createMenuState,
  transitionMenu,
  type MenuCollections,
  type MenuEvent,
  type MenuState,
} from '@waypoint/ui-components';

const collections: MenuCollections = {
  root: [
    { id: 'alpha', textValue: 'Alpha' },
    { id: 'disabled', textValue: 'Disabled', disabled: true },
    { id: 'branch', textValue: 'Branch', submenuId: 'child' },
    { id: 'omega', textValue: 'Omega' },
  ],
  child: [
    { id: 'unavailable', textValue: 'Unavailable', disabled: true },
    { id: 'copy', textValue: 'Copy' },
    { id: 'paste', textValue: 'Paste' },
  ],
};

function open(preferredId = 'alpha') {
  const positioning = transitionMenu(
    createMenuState(),
    { type: 'open', menuId: 'root', preferredId },
    collections
  ).state;
  return transitionMenu(
    positioning,
    { type: 'positioned', session: positioning.session },
    collections
  ).state;
}

function step(state: MenuState, event: MenuEvent, items = collections) {
  return transitionMenu(state, event, items);
}

describe('shared menu state', () => {
  it('waits for current placement before opening and rejects an earlier session', () => {
    const first = step(createMenuState(), { type: 'open', menuId: 'root' }).state;
    expect(first.phase).toBe('positioning');
    const closed = step(first, { type: 'close', session: first.session, reason: 'escape' }).state;
    const second = step(closed, { type: 'open', menuId: 'root' }).state;
    expect(second.session).toBeGreaterThan(first.session);
    expect(step(second, { type: 'positioned', session: first.session })).toEqual({
      state: second,
      effects: [],
    });
    expect(step(second, { type: 'positioned', session: second.session }).state.phase).toBe('open');
  });

  it('retains item identity across reordering and skips disabled items', () => {
    let state = open('branch');
    state = step(
      state,
      { type: 'reconcile', session: state.session },
      {
        ...collections,
        root: [...collections.root].reverse(),
      }
    ).state;
    expect(state.levels[0].activeId).toBe('branch');
    state = step(state, { type: 'move', session: state.session, direction: 'previous' }).state;
    expect(state.levels[0].activeId).toBe('alpha');
    state = step(state, { type: 'move', session: state.session, direction: 'last' }).state;
    expect(state.levels[0].activeId).toBe('omega');
    state = step(state, { type: 'move', session: state.session, direction: 'first' }).state;
    expect(state.levels[0].activeId).toBe('alpha');
  });

  it('reconciles removal and disabled active items to the first enabled identity', () => {
    const state = open('branch');
    const removed = step(
      state,
      { type: 'reconcile', session: state.session },
      {
        root: collections.root.filter((item) => item.id !== 'branch'),
      }
    ).state;
    expect(removed.levels[0].activeId).toBe('alpha');
    const disabled = step(
      state,
      { type: 'reconcile', session: state.session },
      {
        root: collections.root.map((item) => ({ ...item, disabled: item.id !== 'omega' })),
      }
    ).state;
    expect(disabled.levels[0].activeId).toBe('omega');
    const empty = step(state, { type: 'reconcile', session: state.session }, { root: [] }).state;
    expect(empty.levels[0].activeId).toBeNull();
    expect(
      step(
        empty,
        {
          type: 'activate',
          session: empty.session,
          menuId: 'root',
          itemId: 'branch',
        },
        { root: [] }
      ).effects
    ).toEqual([]);
  });

  it('never invokes disabled or removed rows and invokes a live command only once', () => {
    const state = open();
    for (const itemId of ['disabled', 'removed']) {
      expect(
        step(state, { type: 'activate', session: state.session, menuId: 'root', itemId }).effects
      ).toEqual([]);
    }
    const activated = step(state, {
      type: 'activate',
      session: state.session,
      menuId: 'root',
      itemId: 'alpha',
    });
    expect(activated.effects.filter((effect) => effect.type === 'invoke')).toEqual([
      { type: 'invoke', session: state.session, menuId: 'root', itemId: 'alpha' },
    ]);
    expect(activated.state.phase).toBe('closed');
    expect(activated.state.closeReason).toBe('selection');
    expect(
      step(activated.state, {
        type: 'activate',
        session: state.session,
        menuId: 'root',
        itemId: 'alpha',
      }).effects
    ).toEqual([]);
  });

  it('opens a keyboard submenu on its first enabled item and returns to its parent', () => {
    const parent = open('branch');
    const child = step(parent, { type: 'submenu-open', session: parent.session }).state;
    expect(child.levels).toEqual([
      { menuId: 'root', activeId: 'branch' },
      { menuId: 'child', activeId: 'copy' },
    ]);
    const returned = step(child, { type: 'submenu-close', session: child.session });
    expect(returned.state.levels).toEqual([{ menuId: 'root', activeId: 'branch' }]);
    expect(returned.effects).toContainEqual({
      type: 'focus-item',
      menuId: 'root',
      itemId: 'branch',
    });
  });

  it('pointer activation opens a child without stealing keyboard focus and replaces old descendants', () => {
    const state = open();
    const pointed = step(state, {
      type: 'point',
      session: state.session,
      menuId: 'root',
      itemId: 'branch',
    });
    expect(pointed.state.levels).toEqual([
      { menuId: 'root', activeId: 'branch' },
      { menuId: 'child', activeId: null },
    ]);
    expect(pointed.effects.some((effect) => effect.type === 'focus-item')).toBe(false);
    const sibling = step(pointed.state, {
      type: 'point',
      session: state.session,
      menuId: 'root',
      itemId: 'omega',
    });
    expect(sibling.state.levels).toEqual([{ menuId: 'root', activeId: 'omega' }]);
  });

  it('moves the focused parent level even when pointer hover has opened a child', () => {
    const state = open('branch');
    const hovered = step(state, {
      type: 'point',
      session: state.session,
      menuId: 'root',
      itemId: 'branch',
    }).state;
    const moved = step(hovered, {
      type: 'move',
      session: state.session,
      menuId: 'root',
      direction: 'next',
    });
    expect(moved.state.levels).toEqual([{ menuId: 'root', activeId: 'omega' }]);
    expect(moved.effects).toContainEqual({ type: 'focus-item', menuId: 'root', itemId: 'omega' });
    const entered = step(hovered, {
      type: 'submenu-open',
      session: state.session,
      menuId: 'root',
    });
    expect(entered.state.levels).toEqual([
      { menuId: 'root', activeId: 'branch' },
      { menuId: 'child', activeId: 'copy' },
    ]);
    expect(entered.effects).toContainEqual({ type: 'focus-item', menuId: 'child', itemId: 'copy' });
  });

  it('removes a child when its parent no longer owns an enabled submenu', () => {
    const state = open('branch');
    const child = step(state, { type: 'submenu-open', session: state.session }).state;
    const updated = step(
      child,
      { type: 'reconcile', session: state.session },
      {
        ...collections,
        root: collections.root.map((item) =>
          item.id === 'branch' ? { ...item, disabled: true } : item
        ),
      }
    ).state;
    expect(updated.levels).toEqual([{ menuId: 'root', activeId: 'alpha' }]);
  });

  it('requires the latest intent request and a still-enabled candidate', () => {
    const state = open('branch');
    const waiting = step(state, {
      type: 'intent',
      session: state.session,
      menuId: 'root',
      candidateId: 'omega',
      request: 2,
    }).state;
    expect(
      step(waiting, { type: 'intent-resolve', session: state.session, request: 1 }).state
    ).toEqual(waiting);
    const resolved = step(waiting, {
      type: 'intent-resolve',
      session: state.session,
      request: 2,
    }).state;
    expect(resolved.levels[0].activeId).toBe('omega');
    expect(resolved.intent.phase).toBe('idle');
    const removed = step(
      waiting,
      { type: 'intent-resolve', session: state.session, request: 2 },
      {
        ...collections,
        root: collections.root.filter((item) => item.id !== 'omega'),
      }
    );
    expect(removed.state.levels[0].activeId).not.toBe('omega');
    expect(removed.effects.some((effect) => effect.type === 'invoke')).toBe(false);
  });

  it('rejects old-session pointer, timer, activation and close events after reopening', () => {
    const old = open();
    const closed = step(old, {
      type: 'close',
      session: old.session,
      reason: 'outside-pointer',
    }).state;
    const reopened = step(closed, { type: 'open', menuId: 'root', preferredId: 'omega' }).state;
    const stale: MenuEvent[] = [
      { type: 'point', session: old.session, menuId: 'root', itemId: 'alpha' },
      { type: 'intent-resolve', session: old.session, request: 1 },
      { type: 'activate', session: old.session, menuId: 'root', itemId: 'alpha' },
      { type: 'close', session: old.session, reason: 'window-blur' },
    ];
    for (const event of stale) {
      expect(step(reopened, event)).toEqual({ state: reopened, effects: [] });
    }
  });
});
