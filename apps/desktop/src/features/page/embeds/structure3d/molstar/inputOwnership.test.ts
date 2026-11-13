// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { InputObserver } from 'molstar/lib/mol-util/input/input-observer';
import { installInputOwnership } from '@waypoint/platform/input-ownership';
import { PresentationOwner } from '../../../../../presentation/ownership';
import { installMolstarInputOwnership } from './inputOwnership';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

function observer() {
  const root = document.createElement('div');
  const canvas = document.createElement('canvas');
  root.append(canvas);
  document.body.append(root);
  Object.defineProperties(canvas, {
    clientWidth: { value: 200 },
    clientHeight: { value: 200 },
    getBoundingClientRect: {
      value: () => ({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200 }),
    },
  });
  const input = InputObserver.fromElement(canvas);
  installMolstarInputOwnership(input, canvas);
  cleanups.push(() => input.dispose());
  const move = (buttons = 0) =>
    canvas.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 40, buttons })
    );
  return { root, canvas, input, move };
}

it('a cached detached Molstar input observer cannot retain global keyboard control', () => {
  const { root, input, move } = observer();
  const keys: string[] = [];
  input.keyDown.subscribe((event) => keys.push(event.key));
  move();
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, key: 'f', code: 'KeyF' })
  );
  expect(keys).toEqual(['f']);
  root.remove();
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, key: 'r', code: 'KeyR' })
  );
  expect(keys).toEqual(['f']);
  document.body.append(root);
  move();
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, key: 'x', code: 'KeyX' })
  );
  expect(keys).toEqual(['f', 'x']);
});

it('keyboard capture leaves visible pointer input available and suspension permanently cancels a drag', () => {
  const allowed = { keyboard: true, pointer: true };
  const epochs = { keyboard: 0, pointer: 0 };
  const listeners = new Set<() => void>();
  const dispose = installInputOwnership(document, {
    allows: (_target, kind) => allowed[kind],
    capture: (_target, kind) => {
      const epoch = epochs[kind];
      return () => allowed[kind] && epochs[kind] === epoch;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  cleanups.push(dispose);
  const { canvas, input, move } = observer();
  const keys: string[] = [];
  const drags: boolean[] = [];
  let clicks = 0;
  input.keyDown.subscribe((event) => keys.push(event.key));
  input.drag.subscribe((event) => drags.push(event.isStart));
  input.click.subscribe(() => clicks++);
  allowed.keyboard = false;
  epochs.keyboard++;
  for (const listener of listeners) listener();
  move();
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, key: 'f', code: 'KeyF' })
  );
  expect(keys).toEqual([]);
  canvas.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, clientX: 20, clientY: 20, buttons: 1 })
  );
  move(1);
  expect(drags).toEqual([true]);
  allowed.pointer = false;
  epochs.pointer++;
  for (const listener of listeners) listener();
  allowed.pointer = true;
  epochs.pointer++;
  for (const listener of listeners) listener();
  move(1);
  canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 20, clientY: 20 }));
  expect(drags).toEqual([true]);
  expect(clicks).toBe(0);
  canvas.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, clientX: 20, clientY: 20, buttons: 1 })
  );
  canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 20, clientY: 20 }));
  expect(clicks).toBe(1);
  input.dispose();
  expect(listeners.size).toBe(0);
});

it('revoking only keyboard authority does not end a visible pointer drag', () => {
  let keyboard = true;
  let epoch = 0;
  const listeners = new Set<() => void>();
  cleanups.push(
    installInputOwnership(document, {
      allows: (_target, kind) => kind === 'pointer' || keyboard,
      capture: (_target, kind) => {
        const captured = epoch;
        return () => kind === 'pointer' || (keyboard && epoch === captured);
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    })
  );
  const { canvas, input, move } = observer();
  const drags: boolean[] = [];
  let keyboardResets = 0;
  input.keyboardReset.subscribe(() => keyboardResets++);
  input.drag.subscribe((event) => drags.push(event.isStart));
  canvas.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, clientX: 20, clientY: 20, buttons: 1 })
  );
  move(1);
  keyboard = false;
  epoch++;
  for (const listener of listeners) listener();
  canvas.dispatchEvent(
    new MouseEvent('mousemove', { bubbles: true, clientX: 60, clientY: 50, buttons: 1 })
  );
  expect(drags).toEqual([true, false]);
  expect(keyboardResets).toBe(1);
});

it('a fresh click in the same surface preserves held keyboard input', () => {
  const owner = new PresentationOwner();
  owner.dispatch({ type: 'attach', id: 'view', parentId: 'window', active: true });
  owner.dispatch({ type: 'attach', id: 'other', parentId: 'window', active: true });
  owner.dispatch({ type: 'focus', id: 'view' });
  cleanups.push(
    installInputOwnership(document, {
      allows: (_target, kind) => owner.allows('view', kind),
      capture: (_target, kind) => {
        const lease = owner.capture('view', kind);
        return () => owner.isCurrent(lease);
      },
      subscribe: owner.subscribe,
    })
  );
  const { root, input, move } = observer();
  const keys: string[] = [];
  let resets = 0;
  input.keyDown.subscribe((event) => keys.push(event.key));
  input.keyboardReset.subscribe(() => resets++);
  move();
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, key: 'w', code: 'KeyW' })
  );
  expect(keys).toEqual(['w']);
  owner.dispatch({ type: 'focus', id: 'view', inputIntent: true });
  expect(resets).toBe(0);
  const control = document.createElement('input');
  root.append(control);
  control.focus();
  owner.dispatch({ type: 'focus', id: 'view', inputIntent: true });
  expect(resets).toBe(1);
  owner.dispatch({ type: 'focus', id: 'other' });
  expect(resets).toBe(2);
});
