import { afterEach, expect, it, vi } from 'vitest';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import type { NativeProtocolInvocation } from './native-protocol-packages';

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function fixture() {
  const authority = { ownerInstanceId: 'protocol-owner', token: 'private-protocol-token' };
  let granted = ['read-workspace', 'write-workspace', 'create-entity'];
  const authorizeProtocolsAgent = vi.fn(async (_agent: unknown, required: readonly string[]) => {
    if (required.some((capability) => !granted.includes(capability))) throw Error('GRANT_REVOKED');
  });
  const protocols = {
    createProtocol: vi.fn(async (_request: unknown, invocation?: NativeProtocolInvocation) => {
      await invocation?.beforeCommit?.();
      invocation?.assertCurrent?.();
      return {
        kind: 'pending' as const,
        requestId: 'original',
        entityId: 'project::protocol',
        path: '/project/Protocol',
        message: 'Retained file pending catalog',
      };
    }),
    startRun: vi.fn(),
    savePackage: vi.fn(),
    recoverCreation: vi.fn(),
    inspectCreation: vi.fn(async () => ({ kind: 'missing' as const, requestId: 'original' })),
    readPackage: vi.fn(),
    readSavedProtocol: vi.fn(),
    listPackages: vi.fn(async () => []),
  };
  const owner = { inspect: vi.fn(), apply: vi.fn(), close: vi.fn() };
  const server = await startNativeDocumentCommandServer({
    owner,
    protocols,
    authorizeProtocolsAgent,
    getAuthority: () => authority,
  });
  servers.push(server);
  const call = (operation: Record<string, unknown>, capabilities = ['read-workspace']) =>
    fetch(`${server.url}/internal/native-documents/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DNAForge-Native-Document-Authority': authority.token,
      },
      body: JSON.stringify({
        ownerInstanceId: authority.ownerInstanceId,
        projectScope: { kind: 'app-following' },
        command: 'protocols.execute',
        request: { operation },
        agent: { identityId: 'agent', capabilities },
      }),
    });
  return {
    protocols,
    call,
    authorizeProtocolsAgent,
    revoke: () => {
      granted = [];
    },
  };
}

it('reads explicit package kinds with read access and refuses creation without creation capability', async () => {
  const f = await fixture();
  const read = await f.call({
    kind: 'list-packages',
    project: 'project',
    packageKind: 'protocol-run',
  });
  expect(read.status).toBe(200);
  expect((await read.json()).result).toEqual({ kind: 'packages', packages: [] });
  expect(f.protocols.listPackages).toHaveBeenCalledExactlyOnceWith({
    project: 'project',
    kind: 'protocol-run',
  });
  const refused = await f.call(
    { kind: 'create-protocol', project: 'project', requestId: 'original', title: 'Protocol' },
    ['read-workspace', 'write-workspace']
  );
  expect(refused.status).toBe(200);
  expect((await refused.json()).result).toMatchObject({
    ok: false,
    code: 'PROTOCOL_CAPABILITY_DENIED',
    stateChanged: false,
  });
  expect(f.protocols.createProtocol).not.toHaveBeenCalled();
});

it('passes stable creation identity and repeats current grant checks before native commit', async () => {
  const f = await fixture();
  const operation = {
    kind: 'create-protocol',
    project: 'project',
    requestId: 'original',
    title: 'Protocol',
  };
  const capabilities = ['read-workspace', 'write-workspace', 'create-entity'];
  const result = await f.call(operation, capabilities);
  expect(result.status).toBe(200);
  expect((await result.json()).result).toMatchObject({ kind: 'pending', requestId: 'original' });
  expect(f.protocols.createProtocol.mock.calls[0][0]).toEqual({
    project: 'project',
    requestId: 'original',
    title: 'Protocol',
  });
  expect(f.protocols.createProtocol.mock.calls[0][1]?.actor).toBe('agent:agent');
  expect(f.authorizeProtocolsAgent).toHaveBeenCalledTimes(3);
  f.protocols.createProtocol.mockImplementationOnce(async (_request, invocation) => {
    f.revoke();
    await invocation?.beforeCommit?.();
    throw Error('A revoked grant cannot reach publication');
  });
  const revoked = await f.call(operation, capabilities);
  expect(revoked.status).not.toBe(200);
});

it('rejects caller-supplied frozen source fields before dispatch', async () => {
  const f = await fixture();
  const response = await f.call(
    {
      kind: 'start-run',
      project: 'project',
      requestId: 'original',
      title: 'Run',
      protocolId: 'project::protocol',
      expectedSourceSha256: `sha256:${'a'.repeat(64)}`,
      frozenProtocol: { originalText: 'caller-authored' },
    },
    ['read-workspace', 'write-workspace', 'create-entity']
  );
  expect(response.status).toBe(400);
  expect(f.protocols.startRun).not.toHaveBeenCalled();
});
