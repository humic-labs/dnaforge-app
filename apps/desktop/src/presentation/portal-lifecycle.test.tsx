import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createPortal } from 'react-dom';
import { PresentationBoundary, PresentationHost } from './PresentationSurface';
import { CloseConfirmationDialog } from '../features/canvas/components/CloseConfirmationDialog';

afterEach(cleanup);

it('keeps the chat portal visible when a canvas split remounts its panel', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const scene = (split: boolean) => (
    <>
      {createPortal(
        <PresentationHost id="retained-chat" parentId="retained-chat-panel" element={host}>
          <button type="button">Open copied file</button>
        </PresentationHost>,
        host
      )}
      <div key={split ? 'split' : 'single'}>
        <PresentationBoundary id="retained-chat-panel" focused>
          Chat panel
        </PresentationBoundary>
      </div>
    </>
  );
  try {
    const view = render(scene(false));
    const chip = screen.getByRole('button', { name: 'Open copied file' });
    view.rerender(scene(true));
    expect(host).not.toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: 'Open copied file' })).toBe(chip);
  } finally {
    host.remove();
  }
});

it('a portaled dialog suspends its entire backdrop and restores the same pending decision', () => {
  const onCancel = vi.fn();
  const content = createPortal(
    <CloseConfirmationDialog
      fileName="draft.gb"
      onSave={vi.fn()}
      onDontSave={vi.fn()}
      onCancel={onCancel}
    />,
    document.body
  );
  const view = render(
    <PresentationBoundary id="portal-source" focused>
      {content}
    </PresentationBoundary>
  );
  const dialog = screen.getByRole('dialog');
  const backdrop = dialog.closest<HTMLElement>('[data-presentation-surface]')!;
  expect(backdrop.dataset.presentationSurface).toBeTruthy();
  expect(backdrop).not.toHaveAttribute('inert');
  view.rerender(
    <PresentationBoundary id="portal-source" focused active={false}>
      {content}
    </PresentationBoundary>
  );
  expect(backdrop).toHaveAttribute('inert');
  expect(backdrop.style.contentVisibility).toBe('hidden');
  expect(backdrop.style.visibility).toBe('hidden');
  expect(onCancel).not.toHaveBeenCalled();
  view.rerender(
    <PresentationBoundary id="portal-source" focused>
      {content}
    </PresentationBoundary>
  );
  expect(backdrop.style.visibility).toBe('');
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(backdrop).not.toHaveAttribute('inert');
});
