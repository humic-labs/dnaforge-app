import { afterEach, expect, it } from 'vitest';
import { installPresentationInput } from './browser-input';
import { presentationOwner as owner } from './ownership';

let dispose = () => {};
afterEach(() => {
  dispose();
  owner.dispatch({ type: 'dispose', id: 'wheel-view' });
  document.body.replaceChildren();
});

it('revoked momentum stays observable at capture while only fresh input can reach the view', () => {
  owner.dispatch({ type: 'attach', id: 'wheel-view', parentId: 'window', active: true });
  const root = document.createElement('div');
  root.dataset.presentationSurface = 'wheel-view';
  document.body.append(root);
  dispose = installPresentationInput(document);
  const delivered: WheelEvent[] = [];
  const observed: WheelEvent[] = [];
  const observe = (event: WheelEvent) => observed.push(event);
  window.addEventListener('wheel', observe, true);
  root.addEventListener('wheel', (event) => delivered.push(event));
  try {
    const fresh = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 8 });
    root.dispatchEvent(fresh);
    owner.dispatch({ type: 'suspend', id: 'wheel-view' });
    owner.dispatch({ type: 'activate', id: 'wheel-view' });
    const momentum = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 4 });
    Object.defineProperty(momentum, 'momentum', { value: true });
    root.dispatchEvent(momentum);
    const next = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 1 });
    root.dispatchEvent(next);
    expect(observed).toEqual([fresh, momentum, next]);
    expect(momentum.defaultPrevented).toBe(true);
    expect(delivered).toEqual([fresh, next]);
  } finally {
    window.removeEventListener('wheel', observe, true);
  }
});
