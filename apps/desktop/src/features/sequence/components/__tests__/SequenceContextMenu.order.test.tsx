/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { Annotation } from '@waypoint/sequence-utils';
import { SequenceContextMenu } from '@waypoint/ui-components';
import { describe, expect, it, vi } from 'vitest';

const cdsAnnotation: Annotation = {
  name: 'thrL',
  type: 'CDS',
  start: 1,
  end: 66,
  direction: 1,
};

function buttonLabels(): string[] {
  return screen.getAllByRole('button').map((button) => {
    const shortcut = button.querySelector('[data-testid="sequence-context-menu-shortcut"]');
    const shortcutText = shortcut?.textContent ?? '';
    const full = button.textContent ?? '';
    return shortcutText && full.endsWith(shortcutText)
      ? full.slice(0, full.length - shortcutText.length)
      : full;
  });
}

describe('SequenceContextMenu — action ordering', () => {
  it('orders copy/translation, structure, annotation, primer, then view-orientation actions', () => {
    render(
      <SequenceContextMenu
        x={0}
        y={0}
        isOpen
        onClose={() => {}}
        hasSelection
        selectionRange={{ start: 4, end: 18 }}
        clickedAnnotation={cdsAnnotation}
        clickedCDS={cdsAnnotation}
        structureAnnotation={cdsAnnotation}
        isOnNucleotideRow
        onCopySequence={vi.fn()}
        onCopyReverseComplement={vi.fn()}
        onCopyTranslation={vi.fn()}
        onCopyCDSTranslation={vi.fn()}
        onViewStructure={vi.fn()}
        onAttachPrimers={vi.fn()}
        onCreateForwardPrimer={vi.fn()}
        onCreateReversePrimer={vi.fn()}
        onAddAnnotation={vi.fn()}
        onEditAnnotation={vi.fn()}
        onDeleteAnnotation={vi.fn()}
        onReverseComplementAssemblyPart={vi.fn()}
        onInvertSelection={vi.fn()}
        onReindexHere={vi.fn()}
        onFlipOrientation={vi.fn()}
        onResetSequenceView={vi.fn()}
        isSequenceViewTransformed
        onEditSequence={vi.fn()}
      />
    );

    expect(buttonLabels()).toEqual([
      'Copy Sequence',
      'Copy Sequence (Reverse Complement)',
      'Copy Translation',
      'Copy CDS Translation (thrL)',
      'View Structure (thrL)',
      'Add Annotation',
      'Edit Annotation',
      'Delete Annotation',
      'Attach Primers',
      'Create Forward Primer →',
      'Create Reverse Primer ←',
      'Flip assembly part (reverse complement)',
      'Select inverse',
      'Re-index here',
      'Reverse complement viewing direction',
      'Reset sequence view',
      'Edit Sequence',
    ]);
    expect(screen.getByRole('button', { name: 'Attach Primers' })).toHaveStyle({
      color: 'hsl(var(--color-fg))',
    });
    for (const label of [
      'Create Forward Primer →',
      'Create Reverse Primer ←',
      'Add Annotation',
      'Edit Annotation',
      'Edit Sequence',
    ]) {
      expect(screen.getByRole('button', { name: label })).toHaveStyle({
        color: 'hsl(var(--color-success))',
        fontWeight: '600',
      });
    }
    expect(screen.getByRole('button', { name: 'Delete Annotation' })).toHaveStyle({
      color: 'hsl(var(--color-error))',
    });
    const addButton = screen.getByRole('button', { name: 'Add Annotation' });
    expect(addButton.previousElementSibling).toHaveAttribute(
      'data-testid',
      'sequence-context-menu-divider'
    );
    expect(addButton.nextElementSibling).toHaveTextContent('Edit Annotation');
    expect(
      screen.getByRole('button', { name: 'Edit Annotation' }).nextElementSibling
    ).toHaveTextContent('Delete Annotation');
    const targetLabels = screen.getAllByTestId('sequence-context-menu-target');
    expect(targetLabels.map((target) => target.textContent?.trim())).toEqual(['(thrL)', '(thrL)']);
    expect(targetLabels[0]).toHaveStyle({
      color: 'hsl(var(--color-success))',
      fontSize: '12px',
      maxWidth: 'none',
    });
  });

  it('invokes the assembly-part mutation only from its explicit context-menu item', () => {
    const onReverseComplementAssemblyPart = vi.fn();
    render(
      <SequenceContextMenu
        x={0}
        y={0}
        isOpen
        onClose={() => {}}
        onReverseComplementAssemblyPart={onReverseComplementAssemblyPart}
      />
    );

    fireEvent.mouseDown(
      screen.getByRole('button', {
        name: 'Flip assembly part (reverse complement)',
      })
    );

    expect(onReverseComplementAssemblyPart).toHaveBeenCalledTimes(1);
  });

  it('invokes onCopyTranslation (opens the modal) when "Copy Translation" is clicked', () => {
    const onCopyTranslation = vi.fn();
    render(
      <SequenceContextMenu
        x={0}
        y={0}
        isOpen
        onClose={() => {}}
        hasSelection
        selectionRange={{ start: 4, end: 18 }}
        isOnNucleotideRow
        onCopySequence={vi.fn()}
        onCopyReverseComplement={vi.fn()}
        onCopyTranslation={onCopyTranslation}
      />
    );

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Copy Translation' }));
    expect(onCopyTranslation).toHaveBeenCalledTimes(1);
  });
});
