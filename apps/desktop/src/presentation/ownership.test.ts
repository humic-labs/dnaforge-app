import { describe, expect, it } from 'vitest';
import { PresentationOwner } from './ownership';

function workspace() {
  const owner = new PresentationOwner();
  owner.dispatch({ type: 'attach', id: 'workspace', parentId: 'window', active: true });
  owner.dispatch({ type: 'attach', id: 'left', parentId: 'workspace', active: true });
  owner.dispatch({ type: 'attach', id: 'right', parentId: 'workspace', active: true });
  owner.dispatch({ type: 'focus', id: 'left' });
  return owner;
}

describe('presentation ownership', () => {
  it('suspends every descendant without disposing its state and restores eligibility on return', () => {
    const owner = workspace();
    const lease = owner.capture('left', 'keyboard');
    expect(owner.allows('left', 'keyboard')).toBe(true);
    owner.dispatch({ type: 'suspend', id: 'workspace' });
    expect(owner.allows('left', 'keyboard')).toBe(false);
    expect(owner.allows('right', 'pointer')).toBe(false);
    expect(owner.getSnapshot().surfaces.left.status).toBe('active');
    owner.dispatch({ type: 'activate', id: 'workspace' });
    expect(owner.allows('left', 'keyboard')).toBe(true);
    expect(owner.isCurrent(lease)).toBe(false);
  });

  it('routes keyboard by focus while both visible split panels retain pointer eligibility', () => {
    const owner = workspace();
    expect(owner.allows('left', 'keyboard')).toBe(true);
    expect(owner.allows('right', 'keyboard')).toBe(false);
    expect(owner.allows('right', 'pointer')).toBe(true);
    owner.dispatch({ type: 'focus', id: 'right' });
    expect(owner.allows('left', 'keyboard')).toBe(false);
    expect(owner.allows('right', 'keyboard')).toBe(true);
  });

  it('captures keyboard for nested menus without blocking unrelated pointer destinations', () => {
    const owner = workspace();
    owner.dispatch({
      type: 'attach',
      id: 'menu',
      parentId: 'left',
      active: true,
      capture: 'keyboard',
    });
    expect(owner.allows('left', 'keyboard')).toBe(false);
    expect(owner.allows('menu', 'keyboard')).toBe(true);
    expect(owner.allows('right', 'pointer')).toBe(true);
    owner.dispatch({
      type: 'attach',
      id: 'submenu',
      parentId: 'menu',
      active: true,
      capture: 'keyboard',
    });
    expect(owner.allows('menu', 'keyboard')).toBe(false);
    expect(owner.allows('submenu', 'keyboard')).toBe(true);
    owner.dispatch({ type: 'dispose', id: 'submenu' });
    expect(owner.allows('menu', 'keyboard')).toBe(true);
    owner.dispatch({ type: 'dispose', id: 'menu' });
    expect(owner.allows('left', 'keyboard')).toBe(true);
  });

  it('revokes modal descendants on workspace suspension and does not restore stale focus', () => {
    const owner = workspace();
    owner.dispatch({
      type: 'attach',
      id: 'dialog',
      parentId: 'left',
      active: true,
      capture: 'modal',
    });
    expect(owner.allows('right', 'pointer')).toBe(false);
    expect(owner.allows('dialog', 'pointer')).toBe(true);
    const lease = owner.capture('dialog', 'pointer');
    owner.dispatch({ type: 'suspend', id: 'workspace' });
    expect(owner.allows('dialog', 'pointer')).toBe(false);
    expect(owner.isCurrent(lease)).toBe(false);
    owner.dispatch({ type: 'attach', id: 'settings', parentId: 'window', active: true });
    owner.dispatch({ type: 'focus', id: 'settings' });
    owner.dispatch({ type: 'dispose', id: 'dialog' });
    expect(owner.getSnapshot().focusId).toBe('settings');
    expect(owner.allows('settings', 'keyboard')).toBe(true);
  });

  it('makes disposal final for old leases and refuses descendants of a missing parent', () => {
    const owner = workspace();
    const lease = owner.capture('left', 'pointer');
    owner.dispatch({ type: 'dispose', id: 'left' });
    owner.dispatch({ type: 'attach', id: 'left', parentId: 'workspace', active: true });
    expect(owner.isCurrent(lease)).toBe(false);
    owner.dispatch({ type: 'attach', id: 'orphan', parentId: 'missing', active: true });
    expect(owner.allows('orphan', 'pointer')).toBe(false);
  });
});
