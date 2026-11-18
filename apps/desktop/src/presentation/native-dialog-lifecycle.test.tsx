import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PresentationBoundary, usePresentationOverlay } from './PresentationSurface';
import { presentationOwner, PresentationOwner } from './ownership';
import { OverlayBinding } from './overlay-binding';

function NativeDialog({ onCancel }: { onCancel: () => void }) {
  const overlay = usePresentationOverlay('modal');
  return (
    <dialog
      ref={overlay.bindRef(undefined, 'dialog')}
      data-testid="native-dialog"
      onCancel={onCancel}
    >
      <button>Continue</button>
    </dialog>
  );
}

beforeEach(() => {
  vi.stubGlobal('HTMLDialogElement', window.HTMLDialogElement);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      const event = new Event('beforetoggle', { cancelable: true });
      Object.defineProperty(event, 'newState', { value: 'open' });
      if (this.dispatchEvent(event)) this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      const event = new Event('beforetoggle');
      Object.defineProperty(event, 'newState', { value: 'closed' });
      this.dispatchEvent(event);
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('modal focus recovery yields to a child overlay and stops when its owner closes', async () => {
  const owner = new PresentationOwner();
  const card = document.createElement('div');
  const input = document.createElement('input');
  card.append(input);
  const outside = document.createElement('button');
  const child = document.createElement('button');
  document.body.append(card, outside, child);
  const modal = new OverlayBinding(owner, 'window', 'modal', 'modal');
  const menu = new OverlayBinding(owner, 'modal', 'child-menu', 'keyboard');
  try {
    modal.bind('card', card);
    input.focus();
    outside.focus();
    expect(document.activeElement).toBe(outside);
    await Promise.resolve();
    expect(document.activeElement).toBe(input);
    menu.bind('child', child);
    child.focus();
    await Promise.resolve();
    expect(document.activeElement).toBe(child);
    menu.bind('child', null);
    input.focus();
    outside.focus();
    modal.bind('card', null);
    await Promise.resolve();
    expect(document.activeElement).toBe(outside);
  } finally {
    menu.bind('child', null);
    modal.bind('card', null);
    card.remove();
    outside.remove();
    child.remove();
  }
});

it('a retained closed native dialog grants no capture until the platform opens it', () => {
  render(<NativeDialog onCancel={vi.fn()} />);
  const dialog = screen.getByTestId('native-dialog') as HTMLDialogElement;
  expect(presentationOwner.allows('window', 'keyboard')).toBe(true);
  act(() => dialog.showModal());
  expect(presentationOwner.allows('window', 'keyboard')).toBe(false);
  act(() => dialog.close());
  expect(presentationOwner.allows('window', 'keyboard')).toBe(true);
});

it('parent suspension releases native modality without answering the pending decision', () => {
  const onCancel = vi.fn();
  const view = render(
    <PresentationBoundary id="dialog-source" focused>
      <NativeDialog onCancel={onCancel} />
    </PresentationBoundary>
  );
  const dialog = screen.getByTestId('native-dialog') as HTMLDialogElement;
  act(() => dialog.showModal());
  const lease = presentationOwner.capture(dialog.dataset.presentationSurface!, 'pointer');
  view.rerender(
    <PresentationBoundary id="dialog-source" active={false} focused>
      <NativeDialog onCancel={onCancel} />
    </PresentationBoundary>
  );
  expect(dialog.open).toBe(false);
  expect(onCancel).not.toHaveBeenCalled();
  view.rerender(
    <PresentationBoundary id="dialog-source" focused>
      <NativeDialog onCancel={onCancel} />
    </PresentationBoundary>
  );
  expect(dialog.open).toBe(true);
  expect(presentationOwner.isCurrent(lease)).toBe(false);
});

it.each([false, true])(
  'queued native focus restoration retains its original view lease (suspended=%s)',
  async (suspended) => {
    const owner = new PresentationOwner();
    owner.dispatch({ type: 'attach', id: 'source', parentId: 'window', active: true });
    owner.dispatch({ type: 'focus', id: 'source' });
    const source = document.createElement('div');
    source.dataset.presentationSurface = 'source';
    const target = document.createElement('button');
    source.append(target);
    const dialog = document.createElement('dialog');
    const field = document.createElement('input');
    dialog.append(field);
    document.body.append(source, dialog);
    const binding = new OverlayBinding(owner, 'source', 'native-focus', 'modal');
    try {
      target.focus();
      binding.bind('dialog', dialog);
      dialog.showModal();
      field.focus();
      binding.bind('dialog', null);
      dialog.remove();
      if (suspended) {
        owner.dispatch({ type: 'suspend', id: 'source' });
        owner.dispatch({ type: 'activate', id: 'source' });
      }
      await Promise.resolve();
      if (suspended) expect(document.activeElement).not.toBe(target);
      else expect(document.activeElement).toBe(target);
    } finally {
      source.remove();
      dialog.remove();
    }
  }
);
