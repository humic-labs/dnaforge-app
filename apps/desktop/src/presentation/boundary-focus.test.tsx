import { cleanup, render, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createPortal } from 'react-dom';
import {
  PresentationBoundary,
  PresentationHost,
  PresentationScopeContext,
} from './PresentationSurface';
import { PresentationOwner } from './ownership';

afterEach(cleanup);

it('the selected panel gains keyboard ownership when its suspended workspace becomes visible', () => {
  const owner = new PresentationOwner();
  owner.dispatch({ type: 'attach', id: 'sidebar', parentId: 'window', active: true });
  owner.dispatch({ type: 'focus', id: 'sidebar' });
  const scene = (active: boolean) => (
    <PresentationScopeContext.Provider value={{ id: 'window', owner }}>
      <PresentationBoundary id="return-workspace" active={active}>
        <PresentationBoundary id="return-panel" focused>
          <input />
        </PresentationBoundary>
      </PresentationBoundary>
    </PresentationScopeContext.Provider>
  );
  const view = render(scene(false));
  expect(owner.allows('return-panel', 'keyboard')).toBe(false);
  expect(owner.allows('sidebar', 'keyboard')).toBe(true);
  view.rerender(scene(true));
  expect(owner.allows('return-panel', 'keyboard')).toBe(true);
});

it('nested surface capture does not revoke the existing leaf keyboard owner', () => {
  const owner = new PresentationOwner();
  render(
    <PresentationScopeContext.Provider value={{ id: 'window', owner }}>
      <PresentationBoundary id="outer">
        <PresentationBoundary id="leaf">
          <canvas data-testid="owned-canvas" />
        </PresentationBoundary>
      </PresentationBoundary>
    </PresentationScopeContext.Provider>
  );
  owner.dispatch({ type: 'focus', id: 'leaf' });
  const keyboard = owner.capture('leaf', 'keyboard');
  fireEvent.pointerDown(screen.getByTestId('owned-canvas'));
  expect(owner.getSnapshot().focusId).toBe('leaf');
  expect(owner.isCurrent(keyboard)).toBe(true);
});

it('a portaled host remains the keyboard owner through logical ancestor capture', () => {
  const owner = new PresentationOwner();
  const element = document.createElement('div');
  document.body.append(element);
  const view = render(
    <PresentationScopeContext.Provider value={{ id: 'window', owner }}>
      <PresentationBoundary id="outer">
        <PresentationHost id="leaf" element={element}>
          {createPortal(<canvas data-testid="portal-canvas" />, element)}
        </PresentationHost>
      </PresentationBoundary>
    </PresentationScopeContext.Provider>
  );
  owner.dispatch({ type: 'focus', id: 'leaf' });
  const keyboard = owner.capture('leaf', 'keyboard');
  fireEvent.pointerDown(screen.getByTestId('portal-canvas'));
  expect(owner.getSnapshot().focusId).toBe('leaf');
  expect(owner.isCurrent(keyboard)).toBe(true);
  view.unmount();
  element.remove();
});
