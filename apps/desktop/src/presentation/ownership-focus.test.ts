import { describe, expect, it } from 'vitest';
import { PresentationOwner } from './ownership';

describe('presentation focus transitions', () => {
  it('clearing focus preserves the view while removing its keyboard eligibility', () => {
    const owner = new PresentationOwner();
    owner.dispatch({ type: 'attach', id: 'workspace', parentId: 'window', active: true });
    owner.dispatch({ type: 'focus', id: 'workspace' });
    owner.dispatch({ type: 'blur', id: 'workspace' });
    expect(owner.allows('workspace', 'presentation')).toBe(true);
    expect(owner.allows('workspace', 'pointer')).toBe(true);
    expect(owner.allows('workspace', 'keyboard')).toBe(false);
    expect(owner.allows('window', 'keyboard')).toBe(true);
  });

  it('closing a focused overlay restores the eligible previous branch', () => {
    const owner = new PresentationOwner();
    owner.dispatch({ type: 'attach', id: 'view', parentId: 'window', active: true });
    owner.dispatch({ type: 'focus', id: 'view' });
    owner.dispatch({
      type: 'attach',
      id: 'menu',
      parentId: 'view',
      active: true,
      capture: 'keyboard',
    });
    owner.dispatch({ type: 'focus', id: 'menu' });
    owner.dispatch({ type: 'dispose', id: 'menu' });
    expect(owner.getSnapshot().focusId).toBe('view');
    expect(owner.allows('view', 'keyboard')).toBe(true);
  });

  it('reattaching a view to another panel preserves its child scopes and revokes its old work', () => {
    const owner = new PresentationOwner();
    owner.dispatch({ type: 'attach', id: 'left', parentId: 'window', active: true });
    owner.dispatch({ type: 'attach', id: 'right', parentId: 'window', active: true });
    owner.dispatch({ type: 'attach', id: 'view', parentId: 'left', active: true });
    owner.dispatch({ type: 'attach', id: 'control', parentId: 'view', active: true });
    const lease = owner.capture('view', 'pointer');
    owner.dispatch({ type: 'attach', id: 'view', parentId: 'right', active: true });
    expect(owner.allows('control', 'pointer')).toBe(true);
    expect(owner.isCurrent(lease)).toBe(false);
  });
});

it('closing and reopening a retained native dialog restores focus without retaining its old lease', () => {
  const owner = new PresentationOwner();
  owner.dispatch({ type: 'attach', id: 'view', parentId: 'window', active: true });
  owner.dispatch({ type: 'focus', id: 'view' });
  owner.dispatch({
    type: 'attach',
    id: 'dialog',
    parentId: 'view',
    active: false,
    capture: 'modal',
  });
  owner.dispatch({ type: 'activate', id: 'dialog' });
  owner.dispatch({ type: 'focus', id: 'dialog' });
  const lease = owner.capture('dialog', 'keyboard');
  owner.dispatch({ type: 'suspend', id: 'dialog' });
  expect(owner.getSnapshot().focusId).toBe('view');
  expect(owner.allows('view', 'keyboard')).toBe(true);
  owner.dispatch({ type: 'activate', id: 'dialog' });
  expect(owner.allows('dialog', 'keyboard')).toBe(true);
  expect(owner.isCurrent(lease)).toBe(false);
});
