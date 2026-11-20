import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EntityReferenceChip } from './EntityReferenceChip';
import type { EntityDiscoveryResolveRequest } from '../../shared/entity-discovery';
const resolve = vi.hoisted(() => vi.fn());
vi.mock('../../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform')>()),
  platform: () => ({ entityDiscovery: { resolve } }),
}));
import { emitRegistryChanged } from '../../shared/registry-events';
import type { EntityDescriptor } from '../../shared/entity-discovery';
import { ReferenceChip } from '../chat/ReferenceChip';
import { prepareEntityReferenceRow } from '../../shared/entity-reference-ipc';

describe('shared reference presentation', () => {
  it('keeps a notebook chip icon and name visible with its type in the real hover and focus tooltip', () => {
    const open = vi.fn();
    render(<EntityReferenceChip entityType="sequence" label="pUC19.gb" onOpen={open} />);
    const chip = screen.getByRole('link', { name: 'pUC19, Sequence' });
    expect(chip.textContent).toBe('pUC19');
    expect(chip).toHaveAccessibleName('pUC19, Sequence');
    fireEvent.mouseEnter(chip);
    expect(screen.getByRole('tooltip')).toHaveTextContent('pUC19 · Sequence');
    fireEvent.mouseLeave(chip);
    fireEvent.focus(chip);
    expect(screen.getByRole('tooltip')).toHaveTextContent('pUC19 · Sequence');
    fireEvent.blur(chip);
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
  ])(
    'keeps a generic %s reference a file when only its locator %s resembles a Track view',
    (entityType, detail) => {
      render(
        <EntityReferenceChip
          entityType={entityType}
          label="Whole-genome pileup"
          detail={detail}
          onOpen={vi.fn()}
        />
      );
      const chip = screen.getByRole('link', { name: 'Whole-genome pileup, File' });
      expect(chip).toHaveAttribute('data-entity-type', entityType);
      expect(chip.textContent).toBe('Whole-genome pileup');
      fireEvent.mouseEnter(chip);
      expect(screen.getByRole('tooltip')).toHaveTextContent('Whole-genome pileup · File');
      expect(chip.querySelector('[data-icon="genome-assembly"]')).toBeNull();
    }
  );

  it('preserves an explicit Track View identity and title', () => {
    render(
      <EntityReferenceChip entityType="track-view" label="Whole-genome pileup" onOpen={vi.fn()} />
    );
    const chip = screen.getByRole('link', { name: 'Whole-genome pileup, Track view' });
    expect(chip.textContent).toBe('Whole-genome pileup');
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

  it('opens an existing durable file reference using its stored identity even when its filename resembles a Track view', () => {
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
    const chip = screen.getByRole('link', { name: 'Whole-genome pileup, File' });
    expect(chip).toHaveAttribute('data-entity-type', 'file');
    expect(chip.querySelector('[data-icon="genome-assembly"]')).toBeNull();
    fireEvent.click(chip);
    expect(open).toHaveBeenCalledWith(reference);
  });
});

describe('stored link type resolution', () => {
  it('uses saved molecule metadata for the resolved notebook chip color', async () => {
    resolve.mockResolvedValueOnce({
      items: [
        {
          id: 'rna',
          status: 'available',
          entity: {
            id: 'rna',
            type: 'sequence',
            kindLabel: 'RNA sequence',
            iconKind: 'sequence',
            namedTypeKey: 'type:sequence',
            iconContext: { molecule: 'rna', path: 'sequence-a.gb' },
          },
        },
      ],
    });
    const { container } = render(
      <EntityReferenceChip
        entityType="sequence"
        label="Sequence A"
        typeLookup={{ entityId: 'rna' }}
        onOpen={vi.fn()}
      />
    );
    expect(await screen.findByRole('link', { name: 'Sequence A, RNA sequence' })).toBeVisible();
    expect(container.querySelector('svg')).toHaveAttribute('data-entity-color-family', 'rna');
    resolve.mockClear();
  });

  it('resolves saved chat and notebook links to the current custom schema in a single project lookup', async () => {
    const reference = prepareEntityReferenceRow({
      entityType: 'record',
      displayLabel: 'Calibration standard',
      locator: 'entity://lims/calibration',
      source: 'ai',
      workspaceScope: 'folders:["/projects/Lab"]',
      workspaceRootPath: '/projects/Lab',
    });
    let currentLabel = 'Instrument calibration';
    resolve.mockImplementation(async ({ ids }: EntityDiscoveryResolveRequest) => ({
      items: ids.map((id) => ({
        id,
        status: 'available',
        entity: { id, kindLabel: currentLabel, iconKind: 'record' } as EntityDescriptor,
      })),
      coverage: { catalog: 1, registry: 1, primers: 0, excluded: 0 },
      generation: 'current',
    }));
    try {
      render(
        <>
          <ReferenceChip reference={reference} onClick={vi.fn()} inline />
          <EntityReferenceChip
            entityType="record"
            label="Saved notebook link"
            typeLookup={{ entityId: 'calibration', projectRoot: '/projects/Lab' }}
            onOpen={vi.fn()}
          />
        </>
      );
      expect(
        await screen.findByRole('link', { name: 'Calibration standard, Instrument calibration' })
      ).toBeVisible();
      expect(
        screen.getByRole('link', { name: 'Saved notebook link, Instrument calibration' })
      ).toBeVisible();
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith({
        ids: ['calibration'],
        scope: { projectRoot: '/projects/Lab', includeArchived: true },
      });
      currentLabel = 'Lab calibration';
      act(() => emitRegistryChanged());
      expect(
        await screen.findByRole('link', { name: 'Calibration standard, Lab calibration' })
      ).toBeVisible();
      expect(
        screen.getByRole('link', { name: 'Saved notebook link, Lab calibration' })
      ).toBeVisible();
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      resolve.mockReset();
    }
  });
});
