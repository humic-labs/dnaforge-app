import { afterEach, expect, it } from 'vitest';
import { installPresentationInput } from './browser-input';
import { presentationOwner as owner } from './ownership';
import { safeFocus } from '../shared/utils/safeFocus';

const ids = ['tabs', 'pane', 'hidden', 'picker'];
let dispose: () => void = () => undefined;
afterEach(() => {
  dispose();
  for (const id of ids) owner.dispatch({ type: 'dispose', id });
  document.body.replaceChildren();
});

function surface(id: string): HTMLInputElement {
  const root = document.createElement('div');
  root.dataset.presentationSurface = id;
  const input = document.createElement('input');
  root.append(input);
  document.body.append(root);
  return input;
}

it('focus moves from a focused control strip into a visible sibling pane', () => {
  dispose = installPresentationInput(document);
  owner.dispatch({ type: 'attach', id: 'tabs', parentId: 'window', active: true });
  owner.dispatch({ type: 'attach', id: 'pane', parentId: 'window', active: true });
  owner.dispatch({ type: 'attach', id: 'hidden', parentId: 'window', active: false });
  const tab = surface('tabs');
  const terminal = surface('pane');
  const retained = surface('hidden');
  tab.focus();
  expect(owner.getSnapshot().focusId).toBe('tabs');
  expect(safeFocus(retained)).toBe(false);
  expect(safeFocus(terminal)).toBe(true);
  expect(document.activeElement).toBe(terminal);
  expect(owner.getSnapshot().focusId).toBe('pane');
});

it('an open modal overlay still keeps focus from leaving it', () => {
  dispose = installPresentationInput(document);
  owner.dispatch({ type: 'attach', id: 'tabs', parentId: 'window', active: true });
  owner.dispatch({ type: 'attach', id: 'pane', parentId: 'window', active: true });
  const tab = surface('tabs');
  const terminal = surface('pane');
  tab.focus();
  owner.dispatch({
    type: 'attach',
    id: 'picker',
    parentId: 'tabs',
    active: true,
    capture: 'modal',
  });
  const filter = surface('picker');
  filter.focus();
  expect(safeFocus(terminal)).toBe(false);
  expect(document.activeElement).toBe(filter);
  owner.dispatch({ type: 'suspend', id: 'picker' });
  expect(safeFocus(terminal)).toBe(true);
  expect(document.activeElement).toBe(terminal);
});
