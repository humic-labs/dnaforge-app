import { expect, it, vi } from 'vitest';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import type { InventoryEquipmentIncidentsRead } from '../../shared/inventory-equipment-incidents';
import { InventoryEquipmentIncidentReadSession } from './inventory-equipment-incident-read-session';
const scope = { project: 'project', inventoryId: 'inventory' },
  principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
it('uses native stale-code first-page replacement without accumulating incident pages', async () => {
  const client = unavailableInventoryClient(),
    cursor = {
      querySha256: `sha256:${'b'.repeat(64)}` as const,
      revision: 3,
      after: { at: 1, incidentId: 'incident' },
    };
  const page = {
    kind: 'ready' as const,
    projectId: scope.project,
    inventoryId: scope.inventoryId,
    revision: 3,
    asOf: 10,
    principal,
    filters: { equipmentId: null, status: null },
    incidents: [],
    nextCursor: cursor,
  };
  client.equipmentIncidents = vi
    .fn()
    .mockResolvedValueOnce(page)
    .mockResolvedValueOnce({
      kind: 'unavailable',
      code: 'INVENTORY_QUERY_STALE',
      message: 'Changed',
      retryable: true,
    })
    .mockResolvedValueOnce({ ...page, revision: 4, nextCursor: null });
  const reader = new InventoryEquipmentIncidentReadSession(client, scope);
  await reader.open();
  await reader.next();
  expect(client.equipmentIncidents).toHaveBeenCalledTimes(3);
  expect(vi.mocked(client.equipmentIncidents).mock.calls[2][0]).toEqual({ ...scope, limit: 20 });
  expect(reader.getSnapshot()).toMatchObject({
    listCursor: null,
    list: { kind: 'ready', revision: 4 },
  });
  reader.dispose();
});
it('does not publish an old scope response after leaving its incident view', async () => {
  const client = unavailableInventoryClient();
  let resolve!: (value: InventoryEquipmentIncidentsRead) => void;
  client.equipmentIncidents = vi.fn(
    () =>
      new Promise<InventoryEquipmentIncidentsRead>((done) => {
        resolve = done;
      })
  );
  const reader = new InventoryEquipmentIncidentReadSession(client, scope),
    running = reader.open();
  reader.dispose();
  resolve({
    kind: 'ready',
    projectId: scope.project,
    inventoryId: scope.inventoryId,
    revision: 3,
    asOf: 10,
    principal,
    filters: { equipmentId: null, status: null },
    incidents: [],
    nextCursor: null,
  });
  await running;
  expect(reader.getSnapshot().list.kind).toBe('loading');
});
