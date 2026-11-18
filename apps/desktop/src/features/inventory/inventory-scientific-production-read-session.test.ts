import { expect, it, vi } from 'vitest';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import type { InventoryScientificProductionsRead } from '../../shared/inventory-scientific-productions';
import { InventoryScientificProductionReadSession } from './inventory-scientific-production-read-session';
const scope = { project: 'project', inventoryId: 'inventory' };
it('replaces a stale next page with the first page using the actual native stale code', async () => {
  const client = unavailableInventoryClient(),
    cursor = {
      querySha256: `sha256:${'a'.repeat(64)}` as const,
      revision: 4,
      after: { at: 1, productionId: 'production' },
    };
  const ready = {
    kind: 'ready' as const,
    projectId: scope.project,
    inventoryId: scope.inventoryId,
    revision: 4,
    filters: { context: null },
    productions: [],
    nextCursor: cursor,
  };
  client.scientificProductions = vi
    .fn()
    .mockResolvedValueOnce(ready)
    .mockResolvedValueOnce({
      kind: 'unavailable',
      code: 'INVENTORY_QUERY_STALE',
      message: 'Revision changed',
      retryable: true,
    })
    .mockResolvedValueOnce({ ...ready, revision: 5, nextCursor: null });
  const session = new InventoryScientificProductionReadSession(client, scope, {}, vi.fn());
  await session.open();
  await session.next();
  expect(client.scientificProductions).toHaveBeenCalledTimes(3);
  expect(vi.mocked(client.scientificProductions).mock.calls[1][0]).toEqual({
    ...scope,
    limit: 20,
    cursor,
  });
  expect(vi.mocked(client.scientificProductions).mock.calls[2][0]).toEqual({ ...scope, limit: 20 });
  expect(session.getSnapshot()).toMatchObject({
    cursor: null,
    list: { kind: 'ready', revision: 5 },
  });
  session.dispose();
});
it('does not publish a late result after leaving the production read scope', async () => {
  const client = unavailableInventoryClient();
  let resolve!: (value: InventoryScientificProductionsRead) => void;
  client.scientificProductions = vi.fn(
    () =>
      new Promise<InventoryScientificProductionsRead>((done) => {
        resolve = done;
      })
  );
  const session = new InventoryScientificProductionReadSession(client, scope, {}, vi.fn());
  const running = session.open();
  session.dispose();
  resolve({
    kind: 'ready',
    projectId: scope.project,
    inventoryId: scope.inventoryId,
    revision: 1,
    filters: { context: null },
    productions: [],
    nextCursor: null,
  });
  await running;
  expect(session.getSnapshot().list.kind).toBe('loading');
});
