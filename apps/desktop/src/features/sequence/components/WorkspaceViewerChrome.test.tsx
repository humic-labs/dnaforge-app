import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceViewerEditModeBar } from './WorkspaceViewerChrome';

describe('WorkspaceViewerEditModeBar', () => {
  it('supports durable hosted saves without forking the desktop edit chrome', () => {
    const onCommit = vi.fn();
    const onDiscard = vi.fn();
    const { rerender } = render(
      <WorkspaceViewerEditModeBar
        isEditMode
        onDiscard={onDiscard}
        onCommit={onCommit}
        commitDisabled
        commitLabel="Save revision"
      />
    );

    expect(screen.getByTestId('edit-mode-bar')).toBeVisible();
    expect(screen.getByTestId('edit-mode-save-btn')).toHaveTextContent('Save revision');
    expect(screen.getByTestId('edit-mode-save-btn')).toBeDisabled();

    rerender(
      <WorkspaceViewerEditModeBar
        isEditMode
        onDiscard={onDiscard}
        onCommit={onCommit}
        commitLabel="Save revision"
      />
    );
    fireEvent.click(screen.getByTestId('edit-mode-save-btn'));
    fireEvent.click(screen.getByTestId('edit-mode-discard-btn'));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
