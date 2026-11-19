import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PresentationScopeContext } from '../../presentation/PresentationSurface';
import { PresentationOwner } from '../../presentation/ownership';
import { TerminalContextMenu } from './TerminalContextMenu';

it('opens terminal actions for the focused pane when the toolbar is a sibling surface', () => {
  const owner = new PresentationOwner();
  owner.dispatch({ type: 'attach', id: 'toolbar', parentId: 'window', active: true });
  owner.dispatch({ type: 'attach', id: 'pane', parentId: 'window', active: true });
  owner.dispatch({ type: 'focus', id: 'pane' });
  const selectAll = vi.fn();

  render(
    <PresentationScopeContext.Provider value={{ id: 'toolbar', owner }}>
      <TerminalContextMenu
        x={100}
        y={150}
        presentationParentId="pane"
        actions={[{ id: 'select-all', label: 'Select all terminal text', run: selectAll }]}
        onClose={() => {}}
      />
    </PresentationScopeContext.Provider>
  );

  fireEvent.click(screen.getByRole('menuitem', { name: 'Select all terminal text' }));
  expect(selectAll).toHaveBeenCalledOnce();
});
