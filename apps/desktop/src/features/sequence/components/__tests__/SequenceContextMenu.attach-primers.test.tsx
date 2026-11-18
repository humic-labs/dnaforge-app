// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { SequenceContextMenu } from '@waypoint/ui-components';
import { describe, expect, it, vi } from 'vitest';

function labelOf(text: string) {
  return screen.getByRole('menuitem', { name: text });
}

describe('SequenceContextMenu — Attach Primers ', () => {
  it('always labels the action "Attach Primers", even with a selection', () => {
    render(
      <SequenceContextMenu
        x={0}
        y={0}
        isOpen
        onClose={() => {}}
        hasSelection
        selectionRange={{ start: 10, end: 40 }}
        onAttachPrimers={vi.fn()}
      />
    );
    expect(labelOf('Attach Primers')).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: 'Attach Primers to selection' })).toBeNull();
  });

  it('labels the action "Attach Primers" with no selection too', () => {
    render(<SequenceContextMenu x={0} y={0} isOpen onClose={() => {}} onAttachPrimers={vi.fn()} />);
    expect(labelOf('Attach Primers')).toBeDefined();
  });

  it('renders the action with no selection and suppresses the "Select sequence first" hint', () => {
    render(<SequenceContextMenu x={0} y={0} isOpen onClose={() => {}} onAttachPrimers={vi.fn()} />);
    expect(labelOf('Attach Primers')).toBeDefined();
    expect(screen.queryByText('Select sequence first')).toBeNull();
  });

  it('invokes onAttachPrimers then closes when clicked', () => {
    const onAttachPrimers = vi.fn();
    const onClose = vi.fn();
    render(
      <SequenceContextMenu
        x={0}
        y={0}
        isOpen
        onClose={onClose}
        hasSelection
        selectionRange={{ start: 0, end: 5 }}
        onAttachPrimers={onAttachPrimers}
      />
    );
    fireEvent.mouseDown(labelOf('Attach Primers'));
    expect(onAttachPrimers).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('omits the action (and shows the empty hint) when onAttachPrimers is absent', () => {
    render(<SequenceContextMenu x={0} y={0} isOpen onClose={() => {}} />);
    expect(screen.queryByRole('menuitem', { name: /Attach Primers/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Design Primers' })).toBeNull();
    expect(screen.getByText('Select sequence first')).toBeDefined();
  });
});
