import { afterEach, expect, it, vi } from 'vitest';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import type { NativeInventoryOwner } from './inventory-owner';

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

it('routes exact physical-work pages with current read authority and no write capability', async () => {
  const result = {
    kind: 'ready',
    projectId: 'project',
    inventoryId: 'inventory',
    context: { kind: 'protocol-run', entityId: 'project::run' },
    revision: 93,
    works: [],
    nextCursor: null,
  };
  const query = vi.fn(() => result),
    execute = vi.fn();
  const authorize = vi.fn(async () => {});
  const server = await startNativeDocumentCommandServer({
    owner: { inspect: vi.fn(), apply: vi.fn(), close: vi.fn() },
    inventory: { scientificWorksForContext: query, execute } as unknown as NativeInventoryOwner,
    authorizeInventoryAgent: authorize,
    getAuthority: () => ({ ownerInstanceId: 'read-owner', token: 'private-read-token' }),
  });
  servers.push(server);
  const request = {
    project: 'project',
    inventoryId: 'inventory',
    context: result.context,
    limit: 20,
    cursor: {
      querySha256: `sha256:${'a'.repeat(64)}`,
      revision: 93,
      after: { at: 100, workId: `scientific-work:${'b'.repeat(64)}` },
    },
  };
  const call = (input: unknown, capabilities = ['read-workspace']) =>
    fetch(`${server.url}/internal/native-documents/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DNAForge-Native-Document-Authority': 'private-read-token',
      },
      body: JSON.stringify({
        ownerInstanceId: 'read-owner',
        projectScope: { kind: 'app-following' },
        command: 'inventory.scientific-works-for-context',
        request: input,
        agent: { identityId: 'agent', capabilities },
      }),
    });
  const response = await call(request);
  expect(response.status).toBe(200);
  expect((await response.json()).result).toEqual({ kind: 'scientific-works-for-context', result });
  expect(query).toHaveBeenCalledExactlyOnceWith(request);
  expect(authorize).toHaveBeenCalledWith(
    { identityId: 'agent', capabilities: ['read-workspace'] },
    ['read-workspace']
  );
  expect(execute).not.toHaveBeenCalled();
  const malformed = await call({ ...request, limit: 51 });
  expect(malformed.status).toBe(400);
  expect(query).toHaveBeenCalledTimes(1);
  const denied = await call(request, []);
  expect((await denied.json()).result).toMatchObject({ ok: false, stateChanged: false });
  expect(query).toHaveBeenCalledTimes(1);
});
