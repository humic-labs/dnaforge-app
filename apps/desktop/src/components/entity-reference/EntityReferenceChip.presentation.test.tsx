import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EntityReferenceChip } from './EntityReferenceChip';
import { ReferenceChip } from '../chat/ReferenceChip';
import { prepareEntityReferenceRow } from '../../shared/entity-reference-ipc';

describe('Shared reference presentation', () => {
  it('gives an ordinary notebook chip the same leading icon and visible type as chat', () => {
    const open = vi.fn();
    render(<EntityReferenceChip entityType="sequence" label="pUC19.gb" onOpen={open} />);
    const chip = screen.getByRole('link', { name: 'pUC19, Sequence' });
    expect(chip).toHaveTextContent('Sequence · pUC19');
    expect(chip.firstElementChild).toContainElement(chip.querySelector('svg'));
    expect(chip.querySelector('.entity-reference-chip__label')).toBe(chip.lastElementChild);
    fireEvent.click(chip);
    fireEvent.keyDown(chip, { key: 'Enter' });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['file', 'views/Whole-genome pileup.dnaforge-track-view.json'],
    ['text', '/projects/Experiment/views/Whole-genome pileup.dnaforge-track-view.json'],
    ['file', 'git://Experiment/views/Whole-genome pileup.dnaforge-track-view.json'],
  ])('recognizes a saved Track View behind generic %s metadata and %s', (entityType, detail) => {
    render(
      <EntityReferenceChip
        entityType={entityType}
        label="Whole-genome pileup"
        detail={detail}
        onOpen={vi.fn()}
      />
    );
    const chip = screen.getByRole('link', { name: 'Whole-genome pileup, Track View' });
    expect(chip).toHaveAttribute('data-entity-type', 'track-view');
    expect(chip).toHaveTextContent('Track View · Whole-genome pileup');
    expect(chip.querySelector('[data-icon="genome-assembly"]')).not.toBeNull();
  });

  it('preserves an explicit Track View identity and title', () => {
    render(
      <EntityReferenceChip entityType="track-view" label="Whole-genome pileup" onOpen={vi.fn()} />
    );
    const chip = screen.getByRole('link', { name: 'Whole-genome pileup, Track View' });
    expect(chip.querySelector('[data-icon="genome-assembly"]')).not.toBeNull();
  });

  it.each([
    {
      entityType: 'file',
      label: 'Measurements',
      detail: 'analyses/measurements.json',
      expected: 'File',
    },
    {
      entityType: 'folder',
      label: 'Results',
      detail: 'Results.dnaforge-track-view.json',
      expected: 'Folder',
    },
    {
      entityType: 'file',
      label: 'Title.dnaforge-track-view.json',
      detail: 'analyses/measurements.json',
      expected: 'File',
    },
  ])(
    'keeps $entityType identity when the resolved target is not a saved Track View',
    ({ entityType, label, detail, expected }) => {
      render(<EntityReferenceChip entityType={entityType} label={label} detail={detail} />);
      const chip = screen.getByTestId('entity-reference-chip');
      expect(chip).toHaveAttribute('data-entity-type', entityType);
      expect(chip.querySelector('[data-icon="genome-assembly"]')).toBeNull();
      expect(chip).toHaveAccessibleName(new RegExp(`, ${expected}$`));
    }
  );

  it('renders an existing durable file reference to a saved Track View with its actual kind', () => {
    const reference = prepareEntityReferenceRow({
      entityType: 'file',
      displayLabel: 'Whole-genome pileup',
      locator: 'git://Experiment/views/Whole-genome pileup.dnaforge-track-view.json',
      source: 'ai',
      workspaceScope: 'folders:["/projects/Experiment"]',
      workspaceRootPath: '/projects/Experiment',
    });
    const open = vi.fn();
    render(<ReferenceChip reference={reference} onClick={open} inline />);
    const chip = screen.getByRole('link', { name: 'Whole-genome pileup, Track View' });
    expect(chip).toHaveAttribute('data-entity-type', 'track-view');
    expect(chip.querySelector('[data-icon="genome-assembly"]')).not.toBeNull();
    fireEvent.click(chip);
    expect(open).toHaveBeenCalledWith(reference);
  });
});
