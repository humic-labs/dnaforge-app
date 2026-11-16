import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryEquipmentCatalog,
  inventoryStorageConditionsProjection,
  type InventoryCommand,
} from '@waypoint/domain-services';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import { InventoryController, type InventoryData } from './inventory-controller';
import { InventoryCatalogPreview } from './InventoryCatalogPreview';

const entry = inventoryEquipmentCatalog()[0];
const claim = entry.definitions.find((row) => row.kind === 'record-temperature-claim')!;
const principal = { kind: 'local-profile' as const, profileKey: 'synthetic-catalog' };

function fixture(commands: readonly InventoryCommand[]) {
  const result = applyInventoryCommandBatch(
    createInventoryState(),
    { expectedRevision: 0, commands },
    { at: 100, principal, authority: principal }
  );
  if (!result.ok) throw new Error(result.message);
  const data: InventoryData = {
    project: {
      projectId: 'project',
      defaultInventoryId: 'inventory',
      name: 'Synthetic catalog',
      path: '/synthetic',
      pinned: false,
    },
    state: result.state,
    history: [],
    availability: null,
    storageConditions: {
      ...inventoryStorageConditionsProjection(result.state, { asOf: 100, freshnessMaxAgeMs: null }),
      projectId: 'project',
      inventoryId: 'inventory',
      revision: result.state.revision,
      principal,
    },
  };
  const controller = new InventoryController(unavailableInventoryClient(), {
    read: () => [],
    write: () => {},
  });
  const submit = vi.spyOn(controller, 'submit').mockResolvedValue(null);
  return { data, controller, submit, status: { kind: 'ready' as const, data }, onClose: vi.fn() };
}

it('previews an advertised range with its source and applies only that selected new claim', () => {
  const f = fixture(entry.definitions.filter((row) => row.kind !== 'record-temperature-claim'));
  const before = structuredClone(f.data.state);
  const { container } = render(<InventoryCatalogPreview {...f} entry={entry} />);
  const row = container.querySelector(`[data-definition-id="${claim.id}"]`)! as HTMLElement;
  expect(row).toHaveAttribute('data-definition-status', 'new');
  expect(
    within(row).getByRole('heading', { name: 'Specified operating range' })
  ).toBeInTheDocument();
  expect(within(row).getByText('-86 to -50 °C (inclusive)')).toBeInTheDocument();
  expect(within(row).getByRole('link')).toHaveAttribute('href', claim.source?.url);
  fireEvent.click(within(row).getByRole('checkbox', { name: `Apply ${claim.id}` }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply selected definitions' }));
  expect(f.submit).toHaveBeenCalledWith([claim], 'Apply catalog definitions');
  expect(f.data.state).toEqual(before);
});

it('compares the actual saved temperature definition when source content conflicts', () => {
  if (claim.kind !== 'record-temperature-claim')
    throw new Error('Expected catalog temperature claim.');
  const f = fixture(entry.definitions);
  const proposed = {
    ...entry,
    definitions: entry.definitions.map((row) =>
      row.id === claim.id
        ? {
            ...claim,
            assertion: {
              kind: 'specified-setpoint-range' as const,
              range: {
                minimum: { value: '-90', unit: 'C' as const },
                maximum: { value: '-50', unit: 'C' as const },
              },
            },
          }
        : row
    ),
  };
  const { container } = render(<InventoryCatalogPreview {...f} entry={proposed} />);
  const row = container.querySelector(`[data-definition-id="${claim.id}"]`)! as HTMLElement;
  expect(row).toHaveAttribute('data-definition-status', 'conflicting');
  const saved = JSON.parse(row.querySelectorAll('pre')[0].textContent!);
  expect(saved).toEqual(claim);
  expect(screen.getByRole('button', { name: 'Apply selected definitions' })).toBeDisabled();
});

it('labels identical withdrawn temperature evidence without offering reactivation', () => {
  const f = fixture([
    ...entry.definitions,
    {
      kind: 'withdraw-temperature-claim',
      claimId: claim.id,
      reason: 'Withdrawn local source scope',
    },
  ]);
  const { container } = render(<InventoryCatalogPreview {...f} entry={entry} />);
  const row = container.querySelector(`[data-definition-id="${claim.id}"]`)! as HTMLElement;
  expect(row).toHaveAttribute('data-definition-status', 'identical');
  expect(row.querySelector('[data-temperature-claim-lifecycle]')).toHaveAttribute(
    'data-temperature-claim-lifecycle',
    'withdrawn'
  );
  expect(within(row).queryByRole('checkbox')).not.toBeInTheDocument();
  expect(row).toHaveTextContent('Withdrawn source evidence stays withdrawn');
  expect(f.submit).not.toHaveBeenCalled();
});
