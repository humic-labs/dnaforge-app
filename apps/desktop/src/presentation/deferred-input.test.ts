import { afterEach, expect, it, vi } from 'vitest';
import { installPresentationInput } from './browser-input';
import { presentationOwner as owner } from './ownership';
import { scheduleFocus } from '../shared/utils/safeFocus';

let dispose: () => void = () => undefined;
afterEach(() => {
  dispose();
  owner.dispatch({ type: 'dispose', id: 'deferred-view' });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('a delayed focus cannot regain authority after a hidden view returns', () => {
  owner.dispatch({ type: 'attach', id: 'deferred-view', parentId: 'window', active: true });
  owner.dispatch({ type: 'focus', id: 'deferred-view' });
  dispose = installPresentationInput(document);
  const root = document.createElement('div');
  root.dataset.presentationSurface = 'deferred-view';
  const input = document.createElement('input');
  root.append(input);
  document.body.append(root);
  let callback: FrameRequestCallback = () => undefined;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((next) => {
    callback = next;
    return 1;
  });
  scheduleFocus(input);
  owner.dispatch({ type: 'suspend', id: 'deferred-view' });
  owner.dispatch({ type: 'activate', id: 'deferred-view' });
  callback(16);
  expect(document.activeElement).not.toBe(input);
  scheduleFocus(input);
  callback(32);
  expect(document.activeElement).toBe(input);
});

it('fresh control focus within the same surface revokes pending autofocus without interrupting a pointer lease', () => {
  owner.dispatch({ type: 'attach', id: 'deferred-view', parentId: 'window', active: true });
  owner.dispatch({ type: 'focus', id: 'deferred-view' });
  dispose = installPresentationInput(document);
  const root = document.createElement('div');
  root.dataset.presentationSurface = 'deferred-view';
  const pending = document.createElement('input');
  const chosen = document.createElement('input');
  root.append(pending, chosen);
  document.body.append(root);
  let callback: FrameRequestCallback = () => undefined;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((next) => {
    callback = next;
    return 1;
  });
  const pointer = owner.capture('deferred-view', 'pointer');
  const keyboard = owner.capture('deferred-view', 'keyboard');
  const focus = owner.captureFocus('deferred-view');
  scheduleFocus(pending);
  chosen.focus();
  callback(16);
  expect(document.activeElement).toBe(chosen);
  expect(owner.isCurrent(keyboard)).toBe(true);
  expect(owner.isCurrent(focus)).toBe(false);
  expect(owner.isCurrent(pointer)).toBe(true);
});
