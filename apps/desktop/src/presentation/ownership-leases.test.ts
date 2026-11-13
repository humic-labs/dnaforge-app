import { describe, expect, it } from 'vitest';
import { PresentationOwner } from './ownership';

describe('scoped input leases', () => {
  it('unrelated view and closed-menu bookkeeping cannot interrupt the current gesture or focus work', () => {
    const owner = new PresentationOwner();
    owner.dispatch({ type: 'attach', id: 'document', parentId: 'window', active: true });
    owner.dispatch({ type: 'focus', id: 'document' });
    const pointer = owner.capture('document', 'pointer');
    const keyboard = owner.capture('document', 'keyboard');
    owner.dispatch({
      type: 'attach',
      id: 'closed-menu',
      parentId: 'window',
      active: false,
      capture: 'keyboard',
    });
    owner.dispatch({ type: 'attach', id: 'other-view', parentId: 'window', active: true });
    owner.dispatch({ type: 'dispose', id: 'closed-menu' });
    expect(owner.isCurrent(pointer)).toBe(true);
    expect(owner.isCurrent(keyboard)).toBe(true);
    owner.dispatch({ type: 'focus', id: 'other-view' });
    expect(owner.isCurrent(pointer)).toBe(true);
    expect(owner.isCurrent(keyboard)).toBe(false);
    owner.dispatch({ type: 'focus', id: 'document' });
    expect(owner.isCurrent(keyboard)).toBe(false);
  });

  it('a modal round trip permanently revokes old pointer work while a keyboard-only menu leaves pointer work alone', () => {
    const owner = new PresentationOwner();
    owner.dispatch({ type: 'attach', id: 'document', parentId: 'window', active: true });
    const pointer = owner.capture('document', 'pointer');
    owner.dispatch({
      type: 'attach',
      id: 'menu',
      parentId: 'document',
      active: true,
      capture: 'keyboard',
    });
    expect(owner.isCurrent(pointer)).toBe(true);
    owner.dispatch({
      type: 'attach',
      id: 'modal',
      parentId: 'window',
      active: true,
      capture: 'modal',
    });
    expect(owner.isCurrent(pointer)).toBe(false);
    owner.dispatch({ type: 'dispose', id: 'modal' });
    expect(owner.allows('document', 'pointer')).toBe(true);
    expect(owner.isCurrent(pointer)).toBe(false);
  });
});

it('one keyboard dispatch cannot acquire authority by closing its original modal', () => {
  const owner = new PresentationOwner();
  owner.dispatch({ type: 'attach', id: 'view', parentId: 'window', active: true });
  owner.dispatch({ type: 'focus', id: 'view' });
  owner.dispatch({ type: 'attach', id: 'modal', parentId: 'view', active: true, capture: 'modal' });
  const event = {};
  expect(owner.allowsEvent('modal', 'keyboard', event)).toBe(true);
  owner.dispatch({ type: 'dispose', id: 'modal' });
  expect(owner.allowsEvent('view', 'keyboard', event)).toBe(false);
  expect(owner.allowsEvent('view', 'keyboard', {})).toBe(true);
  const delayed = {};
  expect(owner.allowsEvent('view', 'keyboard', delayed)).toBe(true);
  owner.dispatch({ type: 'suspend', id: 'view' });
  owner.dispatch({ type: 'activate', id: 'view' });
  expect(owner.allowsEvent('view', 'keyboard', delayed)).toBe(false);
});
