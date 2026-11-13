/**
 * @vitest-environment jsdom
 */

import { userMessage } from '@waypoint/user-messages';
import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SelectionsDrawer } from './SelectionsDrawer';

describe('SelectionsDrawer', () => {
  it('Escape dismisses the saved-selections drawer', () => {
    const onClose = vi.fn();
    render(
      <SelectionsDrawer
        isOpen
        onClose={onClose}
        highlightGroups={[]}
        onActivate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        triggerRef={createRef<HTMLDivElement>()}
      />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('exposes a missing or stale durable selection instead of silently dropping it', () => {
    render(
      <SelectionsDrawer
        isOpen
        onClose={vi.fn()}
        highlightGroups={[]}
        loadErrors={['selection-1: revision rev-2 is missing']}
        onActivate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        triggerRef={createRef<HTMLDivElement>()}
      />
    );

    expect(screen.getByTestId('saved-selection-load-errors')).toHaveTextContent(
      userMessage('structure.failed')
    );
    expect(screen.getByTestId('saved-selections-drawer')).toHaveAttribute(
      'data-overflow-y',
      'none'
    );
    expect(screen.getByTestId('saved-selections-drawer')).toHaveClass('overflow-y-clip');
  });

  it('restores a saved snapshot instead of toggling an independent visibility flag', () => {
    const onActivate = vi.fn();
    render(
      <SelectionsDrawer
        isOpen
        onClose={vi.fn()}
        highlightGroups={[
          {
            id: 'selection-1',
            label: 'Catalytic pocket',
            visible: false,
            selections: [{ chain: 'A', ranges: [[42, 44]] }],
          },
        ]}
        onActivate={onActivate}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        triggerRef={createRef<HTMLDivElement>()}
      />
    );

    const row = screen.getByTestId('highlight-group-selection-1');
    expect(row).toHaveAttribute('data-action', 'restore-selection');
    expect(row).toHaveAttribute('title', 'Restore as active selection');
    expect(row).not.toHaveAttribute('data-visible');

    fireEvent.click(row);
    expect(onActivate).toHaveBeenCalledOnce();
    expect(onActivate).toHaveBeenCalledWith('selection-1');
  });
});
