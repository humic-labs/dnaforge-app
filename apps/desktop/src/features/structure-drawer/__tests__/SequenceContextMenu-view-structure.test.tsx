// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Annotation } from '@waypoint/sequence-utils';
import { SequenceContextMenu } from '@waypoint/ui-components';

const cdsAnnotation: Annotation = {
  name: 'thrL',
  type: 'CDS',
  start: 1,
  end: 66,
  direction: 1,
};

const rnaAnnotation: Annotation = {
  name: '16S ribosomal RNA',
  type: 'rRNA',
  start: 100,
  end: 1641,
  direction: 1,
};

describe('SequenceContextMenu — View Structure', () => {
  it('shows enabled "View Structure" item when clickedCDS + onViewStructure are present', () => {
    const onViewStructure = vi.fn();
    render(
      <SequenceContextMenu
        x={0}
        y={0}
        isOpen
        onClose={() => {}}
        clickedCDS={cdsAnnotation}
        onViewStructure={onViewStructure}
      />
    );
    const item = screen.getByRole('menuitem', { name: /View Structure \(thrL\)/ });
    expect(item).toBeInTheDocument();
    fireEvent.mouseDown(item);
    expect(onViewStructure).toHaveBeenCalledOnce();
  });

  it('shows enabled "View Structure" item for RNA structure annotations without a CDS hit', () => {
    const onViewStructure = vi.fn();
    render(
      <SequenceContextMenu
        x={0}
        y={0}
        isOpen
        onClose={() => {}}
        structureAnnotation={rnaAnnotation}
        onViewStructure={onViewStructure}
      />
    );
    const item = screen.getByRole('menuitem', { name: /View Structure \(16S ribosomal RNA\)/ });
    expect(item).toBeInTheDocument();
    fireEvent.mouseDown(item);
    expect(onViewStructure).toHaveBeenCalledOnce();
  });

  it('omits unavailable structure actions instead of offering a disabled menu item', () => {
    const onViewStructure = vi.fn();
    render(
      <SequenceContextMenu
        x={0}
        y={0}
        isOpen
        onClose={() => {}}
        clickedCDS={cdsAnnotation}
        onViewStructure={onViewStructure}
        viewStructureDisabled
      />
    );
    expect(screen.queryByText(/View Structure/)).not.toBeInTheDocument();
    expect(onViewStructure).not.toHaveBeenCalled();
  });

  it('omits the menu item entirely when no CDS is right-clicked', () => {
    render(
      <SequenceContextMenu x={0} y={0} isOpen onClose={() => {}} onViewStructure={() => {}} />
    );
    expect(screen.queryByText(/View Structure/)).not.toBeInTheDocument();
  });

  it('omits the menu item when onViewStructure is not provided', () => {
    render(
      <SequenceContextMenu x={0} y={0} isOpen onClose={() => {}} clickedCDS={cdsAnnotation} />
    );
    expect(screen.queryByText(/View Structure/)).not.toBeInTheDocument();
  });
});
