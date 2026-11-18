import { afterEach, expect, it, vi } from 'vitest';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import type { NativeInventoryOwner } from './inventory-owner';

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});
const digest = `sha256:${'a'.repeat(64)}`;
const scope = { project: 'project', inventoryId: 'inventory' };
const choices = {
  identity: { namespace: 'citations', citationId: 'saved-once' },
  workId: `scientific-work:${'b'.repeat(64)}`,
  workIntentSha256: digest,
  context: { kind: 'notebook-page', entityId: 'project::page', sourceSha256: digest },
  reinstates: null,
  reason: 'Saved supporting observation',
};
const withdrawalChoices = {
  identity: { namespace: 'citations', withdrawalId: 'withdraw-once' },
  citationId: `scientific-citation:${'c'.repeat(64)}`,
  citationIntentSha256: digest,
  workId: choices.workId,
  workIntentSha256: digest,
  reason: 'Supporting observation needs correction',
};
const preview = { ...scope, expectedRevision: 93, choices };
const apply = {
  ...preview,
  kind: 'record-scientific-citation',
  operationId: 'same-attempt',
  expectedPlanDigest: digest,
};
const withdrawalPreview = { ...scope, expectedRevision: 94, choices: withdrawalChoices };
const withdrawalApply = {
  ...withdrawalPreview,
  kind: 'withdraw-scientific-citation',
  operationId: 'same-withdrawal',
  expectedPlanDigest: digest,
};

async function fixture(
  owner: Record<string, unknown>,
  authorize = vi.fn(async (_agent: unknown, _required: readonly string[]) => {})
) {
  const authority = { ownerInstanceId: 'citation-owner', token: 'citation-token' };
  const server = await startNativeDocumentCommandServer({
    owner: { inspect: vi.fn(), apply: vi.fn(), close: vi.fn() },
    inventory: owner as NativeInventoryOwner,
    authorizeInventoryAgent: authorize,
    getAuthority: () => authority,
  });
  servers.push(server);
  return {
    authorize,
    call: async (command: string, request: unknown, capabilities = ['read-workspace']) => {
      const response = await fetch(`${server.url}/internal/native-documents/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DNAForge-Native-Document-Authority': authority.token,
        },
        body: JSON.stringify({
          ownerInstanceId: authority.ownerInstanceId,
          projectScope: { kind: 'app-following' },
          command: `inventory.${command}`,
          request,
          agent: { identityId: 'agent', capabilities },
        }),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

it('routes citation reads and previews with exact pins under read authority', async () => {
  const scientificCitations = vi.fn(() => ({ kind: 'ready', entries: [] }));
  const scientificCitationSource = vi.fn(() => ({
    kind: 'unavailable',
    code: 'SOURCE_MISSING',
    message: 'Unavailable',
  }));
  const previewScientificCitation = vi.fn(async () => ({
    kind: 'no-change',
    match: { kind: 'primary-context' },
  }));
  const previewScientificCitationWithdrawal = vi.fn(() => ({ kind: 'blocked', issues: [] }));
  const applyScientificCitation = vi.fn();
  const app = await fixture({
    scientificCitations,
    scientificCitationSource,
    previewScientificCitation,
    previewScientificCitationWithdrawal,
    applyScientificCitation,
  });
  const query = {
    ...scope,
    workId: choices.workId,
    workIntentSha256: digest,
    limit: 20,
    cursor: {
      querySha256: digest,
      revision: 93,
      after: { at: 100, citationId: withdrawalChoices.citationId },
    },
  };
  expect((await app.call('scientific-citations', query)).body.result).toEqual({
    kind: 'scientific-citations',
    result: { kind: 'ready', entries: [] },
  });
  expect(scientificCitations).toHaveBeenCalledExactlyOnceWith(query);
  const source = { ...scope, citationId: withdrawalChoices.citationId };
  expect((await app.call('scientific-citation-source', source)).body.result.kind).toBe(
    'scientific-citation-source'
  );
  expect(scientificCitationSource).toHaveBeenCalledExactlyOnceWith(source);
  expect((await app.call('preview-scientific-citation', preview)).body.result.kind).toBe(
    'scientific-citation-preview'
  );
  expect(previewScientificCitation).toHaveBeenCalledExactlyOnceWith(preview, {
    principal: { kind: 'agent', identityId: 'agent' },
  });
  expect(
    (await app.call('preview-scientific-citation-withdrawal', withdrawalPreview)).body.result.kind
  ).toBe('scientific-citation-withdrawal-preview');
  expect(previewScientificCitationWithdrawal).toHaveBeenCalledExactlyOnceWith(withdrawalPreview, {
    principal: { kind: 'agent', identityId: 'agent' },
  });
  expect(app.authorize).toHaveBeenCalledTimes(6);
  expect(
    app.authorize.mock.calls.every(
      (call) => JSON.stringify(call[1]) === JSON.stringify(['read-workspace'])
    )
  ).toBe(true);
  expect(applyScientificCitation).not.toHaveBeenCalled();
  expect((await app.call('scientific-citations', { ...query, limit: 51 })).status).toBe(400);
  expect(
    (
      await app.call('preview-scientific-citation', {
        ...preview,
        scientificSource: { content: 'caller body' },
      })
    ).status
  ).toBe(400);
  expect(scientificCitations).toHaveBeenCalledTimes(1);
  expect(previewScientificCitation).toHaveBeenCalledTimes(1);
});

it('requires current write authority for both metadata mutations and never admits caller witnesses', async () => {
  const committed = vi.fn();
  const native = vi.fn(async (request, assertCurrent, invocation) => {
    await invocation.beforeScientificCommit();
    assertCurrent();
    committed(request, invocation.principal);
    return {
      status: 'rejected',
      inventoryId: request.inventoryId,
      operationId: request.operationId,
      code: 'INVENTORY_SCIENTIFIC_CITATION_NO_CHANGES',
      message: 'Already recorded',
    };
  });
  const app = await fixture({
    applyScientificCitation: native,
    applyScientificCitationWithdrawal: native,
  });
  for (const [command, request] of [
    ['apply-scientific-citation', apply],
    ['apply-scientific-citation-withdrawal', withdrawalApply],
  ] as const) {
    const denied = await app.call(command, request);
    expect(denied.body.result).toMatchObject({ ok: false, stateChanged: false });
    expect(native).not.toHaveBeenCalled();
    expect(
      (
        await app.call(command, { ...request, scientificSource: { content: 'caller body' } }, [
          'read-workspace',
          'write-workspace',
        ])
      ).status
    ).toBe(400);
  }
  const first = await app.call('apply-scientific-citation', apply, [
    'read-workspace',
    'write-workspace',
  ]);
  expect(first.body.result).toMatchObject({
    kind: 'execution',
    execution: { status: 'rejected', operationId: 'same-attempt' },
  });
  await app.call('apply-scientific-citation-withdrawal', withdrawalApply, [
    'read-workspace',
    'write-workspace',
  ]);
  expect(committed.mock.calls).toEqual([
    [apply, { kind: 'agent', identityId: 'agent' }],
    [withdrawalApply, { kind: 'agent', identityId: 'agent' }],
  ]);
  expect(native.mock.calls.every((call) => call[2].actor === 'agent:agent')).toBe(true);
  expect(
    app.authorize.mock.calls.every(
      (call) => JSON.stringify(call[1]) === JSON.stringify(['read-workspace', 'write-workspace'])
    )
  ).toBe(true);
});

it('rechecks the grant after asynchronous preview and immediately before metadata commit', async () => {
  let permitted = true;
  const authorize = vi.fn(async (_agent: unknown, _required: readonly string[]) => {
    if (!permitted) throw new Error('INVENTORY_CAPABILITY_DENIED: Revoked');
  });
  const previewScientificCitation = vi.fn(async () => {
    permitted = false;
    return { kind: 'ready' };
  });
  const committed = vi.fn();
  const applyScientificCitationWithdrawal = vi.fn(async (_request, assertCurrent, invocation) => {
    permitted = false;
    await invocation.beforeScientificCommit();
    assertCurrent();
    committed();
  });
  const app = await fixture(
    { previewScientificCitation, applyScientificCitationWithdrawal },
    authorize
  );
  const read = await app.call('preview-scientific-citation', preview);
  expect(read.body.result).toMatchObject({
    ok: false,
    stateChanged: false,
    code: 'INVENTORY_CAPABILITY_DENIED',
  });
  permitted = true;
  const write = await app.call('apply-scientific-citation-withdrawal', withdrawalApply, [
    'read-workspace',
    'write-workspace',
  ]);
  expect(write.body.result).toMatchObject({
    ok: false,
    stateChanged: false,
    code: 'INVENTORY_CAPABILITY_DENIED',
  });
  expect(committed).not.toHaveBeenCalled();
  expect(authorize).toHaveBeenCalledTimes(4);
});
