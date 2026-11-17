import { render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createInventoryState,
  inventoryAvailability,
  inventoryStorageConditionsProjection,
} from '@waypoint/domain-services';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import { inventoryScientificContextsRequestSchema } from '../../shared/inventory-command';
import { InventoryController, type InventoryData } from './inventory-controller';
import { InventoryScientificForm } from './InventoryScientificForm';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it('lists saved notebook contexts through the actual native request limit', async () => {
  const scope = { project: 'project', inventoryId: 'inventory' },
    principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) },
    state = createInventoryState(),
    client = unavailableInventoryClient(),
    admitted: unknown[] = [];
  client.scientificContexts = vi.fn(async (input) => {
    admitted.push(inventoryScientificContextsRequestSchema.parse(input));
    return {
      projectId: scope.project,
      inventoryId: scope.inventoryId,
      revision: 0,
      asOf: 100,
      principal,
      pages: [],
    };
  });
  const data: InventoryData = {
    project: {
      projectId: scope.project,
      defaultInventoryId: scope.inventoryId,
      name: 'Project',
      path: '/synthetic',
      pinned: false,
    },
    state,
    history: [],
    availability: {
      ...inventoryAvailability(state, principal, 100),
      projectId: scope.project,
      inventoryId: scope.inventoryId,
      revision: 0,
      asOf: 100,
      principal,
    },
    storageConditions: {
      ...inventoryStorageConditionsProjection(state, { asOf: 100, freshnessMaxAgeMs: null }),
      projectId: scope.project,
      inventoryId: scope.inventoryId,
      revision: 0,
      principal,
    },
  };
  const controller = new InventoryController(client, { read: () => [], write: () => {} });
  render(
    <InventoryScientificForm
      dialog={{ kind: 'scientific-transfer' }}
      data={data}
      status={{ kind: 'ready', data }}
      controller={controller}
      client={client}
      onClose={() => {}}
    />
  );
  await waitFor(() => expect(admitted).toHaveLength(1));
  expect(admitted[0]).toMatchObject({ ...scope, limit: 50 });
});
