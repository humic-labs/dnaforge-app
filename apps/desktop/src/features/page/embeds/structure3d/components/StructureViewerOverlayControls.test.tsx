/**
 * @vitest-environment jsdom
 */

import { userMessage } from '@waypoint/user-messages';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ResidueInteractionState } from '../types';
import { StructureViewerOverlayControls } from './StructureViewerOverlayControls';

const SELECTED_INTERACTION: ResidueInteractionState = {
  hovered: null,
  selected: [{ chain: 'A', position: 42 }],
};

describe('StructureViewerOverlayControls', () => {
  it('keeps label Enter and Escape from reaching the notebook editor', () => {
    const parentKey = vi.fn();
    render(
      <div onKeyDown={parentKey}>
        <StructureViewerOverlayControls
          interactionState={SELECTED_INTERACTION}
          onSaveSelection={vi.fn()}
        />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const input = screen.getByTestId('structure-selection-save-label');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(parentKey).not.toHaveBeenCalled();
  });

  it('puts document actions on the left and AI and settings on the right', () => {
    render(
      <StructureViewerOverlayControls
        onAskAgent={vi.fn()}
        onToggleSettings={vi.fn()}
        interactionState={{ hovered: null, selected: [] }}
        presentationControls={
          <>
            <button>Notebook</button>
            <button>History</button>
            <button>Save</button>
          </>
        }
      />
    );
    expect(
      within(screen.getByTestId('structure-primary-overlay-controls'))
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label') ?? b.textContent)
    ).toEqual(['Notebook', 'History', 'Save', 'Ask Agent', 'Advanced settings']);
  });
  it('extends the color legend with selection targeting, saving and clearing', () => {
    const onCenterSelection = vi.fn();
    const onClearSelection = vi.fn();
    render(
      <StructureViewerOverlayControls
        interactionState={SELECTED_INTERACTION}
        onCenterSelection={onCenterSelection}
        onClearSelection={onClearSelection}
        onSaveSelection={vi.fn()}
      />
    );

    const legend = screen.getByRole('group', { name: 'Structure color key' });
    expect(within(legend).getByText('1 residue selected')).toBeVisible();
    fireEvent.click(within(legend).getByRole('button', { name: 'Target selection' }));
    expect(onCenterSelection).toHaveBeenCalledOnce();
    expect(within(legend).getByRole('button', { name: 'Save' })).toBeVisible();
    fireEvent.click(within(legend).getByRole('button', { name: 'Clear' }));
    expect(onClearSelection).toHaveBeenCalledOnce();
    expect(screen.queryByText('Side chains')).toBeNull();
    expect(screen.queryByText('Center')).toBeNull();
  });

  it('shows saved selections in the legend and targets the chosen group independently', () => {
    const activate = vi.fn();
    const target = vi.fn();
    render(
      <StructureViewerOverlayControls
        interactionState={SELECTED_INTERACTION}
        highlightGroups={[
          {
            id: 'pocket',
            label: 'Pocket',
            color: '#ff8800',
            selections: [{ chain: 'B', ranges: [[12, 14]] }],
            visible: true,
          },
        ]}
        onActivateSelection={activate}
        onTargetSavedSelection={target}
      />
    );
    const legend = screen.getByRole('group', { name: 'Structure color key' });
    fireEvent.click(within(legend).getByRole('button', { name: 'Select Pocket' }));
    expect(activate).toHaveBeenCalledWith('pocket');
    fireEvent.click(within(legend).getByRole('button', { name: 'Target Pocket' }));
    expect(target).toHaveBeenCalledWith('pocket');
    expect(activate).toHaveBeenCalledOnce();
  });

  it('keeps the active selection until durable persistence completes', async () => {
    let completeSave: (() => void) | undefined;
    const onSaveSelection = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completeSave = resolve;
        })
    );
    const onClearSelection = vi.fn();
    render(
      <StructureViewerOverlayControls
        interactionState={SELECTED_INTERACTION}
        onSaveSelection={onSaveSelection}
        onClearSelection={onClearSelection}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.change(screen.getByTestId('structure-selection-save-label'), {
      target: { value: 'Catalytic residue' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSaveSelection).toHaveBeenCalledOnce();
    expect(onClearSelection).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    await act(async () => completeSave?.());

    expect(onClearSelection).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('structure-selection-save-label')).not.toBeInTheDocument();
  });

  it('surfaces persistence failure and preserves the selection for retry', async () => {
    const onClearSelection = vi.fn();
    const onSaveSelection = vi.fn().mockRejectedValue(new Error('workspace write failed'));
    render(
      <StructureViewerOverlayControls
        interactionState={SELECTED_INTERACTION}
        onSaveSelection={onSaveSelection}
        onClearSelection={onClearSelection}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.change(screen.getByTestId('structure-selection-save-label'), {
      target: { value: 'Catalytic residue' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    expect(onClearSelection).not.toHaveBeenCalled();
    expect(screen.getByTestId('structure-selection-save-error')).toHaveTextContent(
      userMessage('structure.failed')
    );
    expect(screen.getByTestId('structure-selection-save-label')).toHaveValue('Catalytic residue');
  });
});
