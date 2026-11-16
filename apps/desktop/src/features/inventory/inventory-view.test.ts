import { expect, it } from 'vitest';
import {
  createInventoryState,
  emptyInventoryPhysicalConfiguration,
  type InventoryStorage,
} from '@waypoint/domain-services';
import {
  inventoryLocationPathLabel,
  inventoryPrincipalLabel,
  locationPath,
} from './inventory-view';

function storage(
  id: string,
  name: string,
  placement: InventoryStorage['placement']
): InventoryStorage {
  return {
    id,
    name,
    placement,
    layout: { kind: 'named', slots: [] },
    lifecycle: 'active',
    custody: { kind: 'available' },
    configuration: emptyInventoryPhysicalConfiguration(),
  };
}

it('includes every ancestor slot and distinguishes same-named storage containers', () => {
  const state = {
    ...createInventoryState(),
    storage: {
      freezer: storage('freezer', 'Freezer', { kind: 'root' }),
      first: storage('first', 'Box', { kind: 'located', storageId: 'freezer', slotId: 'Shelf1' }),
      second: storage('second', 'Box', { kind: 'located', storageId: 'freezer', slotId: 'Shelf2' }),
      rack: storage('rack', 'Rack', { kind: 'located', storageId: 'first', slotId: 'Column3' }),
    },
  };

  expect(locationPath(state, 'freezer')).toBe('Freezer');
  expect(locationPath(state, 'first')).toBe('Freezer / Shelf1 / Box');
  expect(locationPath(state, 'second')).toBe('Freezer / Shelf2 / Box');
  expect(locationPath(state, 'rack')).toBe('Freezer / Shelf1 / Box / Column3 / Rack');
});

it('formats immutable absolute and relative observations with slots before child names', () => {
  const path = [
    { item: { kind: 'storage' as const, id: 'freezer' }, name: 'Freezer', position: null },
    { item: { kind: 'storage' as const, id: 'box' }, name: 'Box', position: 'A' },
    { item: { kind: 'vessel' as const, id: 'tube' }, name: 'Tube', position: 'T1' },
  ];
  expect(inventoryLocationPathLabel(path)).toBe('Freezer / A / Box / T1 / Tube');
  expect(inventoryLocationPathLabel(path.slice(2))).toBe('T1 / Tube');
});

it('labels a desktop profile only relative to a known local comparison principal', () => {
  const holder = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
  expect(inventoryPrincipalLabel(holder)).toBe('Desktop profile');
  expect(inventoryPrincipalLabel(holder, { kind: 'agent', identityId: 'current-agent' })).toBe(
    'Desktop profile'
  );
  expect(inventoryPrincipalLabel(holder, { ...holder })).toBe('This desktop profile');
  expect(
    inventoryPrincipalLabel(holder, { kind: 'local-profile', profileKey: 'b'.repeat(64) })
  ).toBe('Another desktop profile');
});

it('preserves imported and agent attribution regardless of current comparison identity', () => {
  const holder = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
  const imported = {
    kind: 'imported' as const,
    principal: holder,
    source: {
      archiveSha256: `sha256:${'b'.repeat(64)}`,
      projectId: 'source-project',
      inventoryId: 'source-inventory',
      revision: 3,
    },
  };
  expect(inventoryPrincipalLabel(imported, holder)).toBe(
    'Imported desktop profile · source-project / source-inventory'
  );
  expect(inventoryPrincipalLabel(imported)).toBe(
    'Imported desktop profile · source-project / source-inventory'
  );
  expect(inventoryPrincipalLabel({ kind: 'agent', identityId: 'recorded-agent' }, holder)).toBe(
    'Agent recorded-agent'
  );
});
