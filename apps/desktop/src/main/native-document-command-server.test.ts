// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import { NativeDocumentCommandError } from '../shared/native-document-error';
import type { FileDocumentSnapshot } from '../shared/file-document';
import type { ImportReviewAgentInput } from '../shared/import-review-command';
import type { ImportReviewInspection } from '../shared/import-review';
import type { SequenceDocumentSnapshot } from '../shared/sequence-document';
import type {
  InventoryItemCodeLookupSnapshot,
  InventoryLabelArtifact,
} from '../shared/inventory-client';
import type { NativeInventoryOwner } from './inventory-owner';
import {
  createInventoryState,
  inventoryEquipmentCatalog,
  inventoryEquipmentCatalogUpdatePreview,
  inventoryStorageConditionsProjection,
} from '@waypoint/domain-services';

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function fixture(
  options: Pick<
    Parameters<typeof startNativeDocumentCommandServer>[0],
    'authorizeInventoryAgent'
  > = {}
) {
  const owner = {
    inspect: vi.fn(async () => ({ operationId: 'op-1' })),
    apply: vi.fn(async () => ({ status: 'blocked', reason: 'Fixture refusal' })),
    close: vi.fn(async () => undefined),
  };
  const authority = { ownerInstanceId: 'native-1', token: 'private-native-1' };
  const snapshot: FileDocumentSnapshot = {
    documentId: 'file-1',
    path: '/workspace/closed.txt',
    type: 'text',
    revision: 'draft-1',
    persistedRevision: 'saved-1',
    ready: true,
    readOnly: false,
    dirty: false,
    saving: false,
    canUndo: false,
    canRedo: false,
    capabilities: ['inspect', 'replace-text', 'save'],
    content: 'saved',
    persistedContent: 'saved',
    diskContent: 'saved',
    text: 'saved',
  };
  const fileOwner = { executeAgent: vi.fn(async () => snapshot) };
  const sequenceSnapshot: SequenceDocumentSnapshot = {
    documentId: 'sequence-1',
    path: '/workspace/pUC19.gb',
    workspaceRoot: '/workspace',
    revision: 'sequence-draft-v1:owner:sequence-1:3',
    persistedRevision: 'sequence-draft-v1:owner:sequence-1:3',
    version: 3,
    savedVersion: 3,
    ready: true,
    readOnly: false,
    dirty: false,
    saving: false,
    canUndo: false,
    canRedo: false,
    length: 2686,
    annotationCount: 0,
    capabilities: ['inspect', 'replace-bases', 'save'],
  };
  const sequenceOwner = {
    execute: vi.fn(async (): Promise<SequenceDocumentSnapshot> => sequenceSnapshot),
  };
  const notebookOwner = {
    executePublic: vi.fn(async () => ({
      documentId: 'notebook-1',
      blocks: [],
      revision: 'notebook-revision',
    })),
  };
  const review: ImportReviewInspection = {
    id: 'review-1',
    revision: 'review-revision',
    workspaceRoot: '/workspace',
    destinationDir: '/workspace',
    phase: 'applied',
    sourceName: 'source.csv',
    sourceFingerprint: 'source-hash',
    sourceKind: 'csv',
    columns: [],
    totalRecords: 0,
    records: [],
    nextOffset: null,
    canApply: false,
  };
  const importReviews = {
    executeAgent: vi.fn(
      async (
        _input: ImportReviewAgentInput,
        _agent: { identityId: string; capabilities: readonly string[] },
        _assertCurrent?: () => void
      ) => review
    ),
  };
  const getAuthority = vi.fn(() => authority);
  const inventory = {
    exportSnapshot: vi.fn(),
    previewImport: vi.fn(),
    applyImport: vi.fn(),
    previewTable: vi.fn(),
    applyTable: vi.fn(),
    previewStocktake: vi.fn(),
    previewHierarchy: vi.fn(),
    applyHierarchy: vi.fn(),
    applyStocktake: vi.fn(),
    previewSourceRevision: vi.fn(),
    acknowledgeSource: vi.fn(),
    execute: vi.fn(),
    inspect: vi.fn(() => null),
    availability: vi.fn(() => null),
    operation: vi.fn(() => null),
    history: vi.fn(() => []),
    projects: vi.fn(() => []),
    catalog: vi.fn(() => []),
    catalogUpdatePreview: vi.fn(() =>
      inventoryEquipmentCatalogUpdatePreview(createInventoryState(), inventoryEquipmentCatalog()[0])
    ),
    resolveItemCode: vi.fn(
      (): InventoryItemCodeLookupSnapshot => ({
        projectId: 'project-1',
        inventoryId: 'inventory-1',
        revision: 0,
        asOf: 1,
        principal: { kind: 'local-profile', profileKey: 'a'.repeat(64) },
        resolution: { kind: 'not-found' },
        targets: [],
      })
    ),
    prepareLabel: vi.fn<NativeInventoryOwner['prepareLabel']>(),
    storageConditions: vi.fn<NativeInventoryOwner['storageConditions']>(() => ({
      ...inventoryStorageConditionsProjection(createInventoryState(), {
        asOf: 1,
        freshnessMaxAgeMs: null,
      }),
      projectId: 'project-1',
      inventoryId: 'inventory-1',
      revision: 0,
      principal: { kind: 'local-profile', profileKey: 'a'.repeat(64) },
    })),
    materials: vi.fn(() => ({ items: [], nextCursor: null })),
  };
  const server = await startNativeDocumentCommandServer({
    owner,
    fileOwner,
    sequenceOwner,
    notebookOwner,
    importReviews,
    inventory,
    ...options,
    getAuthority,
  });
  servers.push(server);
  const body = {
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'annotation.inspect',
    target: { operationId: 'op-1', targetDocumentId: 'doc-1' },
    authority: { schema: 'opaque-authority-validated-by-owner' },
  };
  return {
    server,
    owner,
    fileOwner,
    sequenceSnapshot,
    sequenceOwner,
    notebookOwner,
    importReviews,
    inventory,
    authority,
    getAuthority,
    body,
    call: (
      input: unknown = body,
      token: string | null = authority.token,
      extra: HeadersInit = {}
    ) =>
      fetch(server.url + '/internal/native-documents/call', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-DNAForge-Native-Document-Authority': token } : {}),
          ...extra,
        },
      }),
  };
}

it('dispatches a private native inspection without a window or renderer bridge', async () => {
  const f = await fixture();
  expect(f.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await f.call();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    ownerInstanceId: 'native-1',
    result: { operationId: 'op-1' },
  });
  expect(f.owner.inspect).toHaveBeenCalledExactlyOnceWith(f.body.target, f.body.authority);
});

const inventoryRequest = {
  project: '/workspace',
  inventoryId: 'inventory-1',
  operationId: 'operation-1',
  expectedRevision: 0,
  commands: [{ kind: 'create-vessel', id: 'tube', name: 'Tube', placement: { kind: 'unplaced' } }],
};
const inventoryAgent = {
  identityId: 'agent-1',
  capabilities: ['read-workspace', 'write-workspace'],
};

it('uses current read authority for source revision preview and current write authority for source acknowledgement', async () => {
  const authorizeInventoryAgent = vi.fn(async () => {});
  const f = await fixture({ authorizeInventoryAgent });
  f.inventory.previewSourceRevision.mockReturnValue({ kind: 'ready', target: { revision: 0 } });
  f.inventory.acknowledgeSource.mockReturnValue({ status: 'committed', revision: 1 });
  const base = {
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    agent: { ...inventoryAgent, capabilities: ['read-workspace'] },
  };
  const scope = { project: '/workspace', inventoryId: 'inventory-1' };
  const options = {
    table: {
      namespace: 'source',
      delimiter: ',',
      materials: [],
      locations: [],
      vessels: [],
      skips: [],
    },
    acknowledgements: [],
  };
  const preview = { ...scope, format: 'receive-v1', sourceText: 'exact source\r\n', options };
  expect(
    await (
      await f.call({ ...base, command: 'inventory.preview-source-revision', request: preview })
    ).json()
  ).toMatchObject({ result: { kind: 'source-revision-preview', preview: { kind: 'ready' } } });
  expect(f.inventory.previewSourceRevision).toHaveBeenCalledWith(preview, {
    principal: { kind: 'agent', identityId: 'agent-1' },
  });
  expect(authorizeInventoryAgent).toHaveBeenCalledWith(base.agent, ['read-workspace']);
  const request = {
    kind: 'acknowledge-table-source',
    ...scope,
    operationId: 'source-once',
    expectedRevision: 0,
    sourceText: preview.sourceText,
    options: { ...options, preimages: [] },
    expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
  };
  expect(
    await (await f.call({ ...base, command: 'inventory.acknowledge-source', request })).json()
  ).toMatchObject({ result: { ok: false, code: 'INSUFFICIENT_SCOPE', stateChanged: false } });
  expect(f.inventory.acknowledgeSource).not.toHaveBeenCalled();
  const input = {
    ...base,
    agent: inventoryAgent,
    command: 'inventory.acknowledge-source',
    request,
  };
  expect(await (await f.call(input)).json()).toMatchObject({
    result: { kind: 'execution', execution: { status: 'committed' } },
  });
  expect(f.inventory.acknowledgeSource).toHaveBeenCalledWith(request, expect.any(Function), {
    actor: 'agent:agent-1',
    principal: { kind: 'agent', identityId: 'agent-1' },
  });
  expect(authorizeInventoryAgent).toHaveBeenLastCalledWith(inventoryAgent, [
    'read-workspace',
    'write-workspace',
  ]);
  expect(
    (
      await f.call({
        ...input,
        request: { ...request, principal: { kind: 'agent', identityId: 'other' } },
      })
    ).status
  ).toBe(400);
  authorizeInventoryAgent.mockRejectedValueOnce(new Error('Grant revoked.'));
  expect(await (await f.call(input)).json()).toMatchObject({
    result: { ok: false, code: 'INVENTORY_CAPABILITY_DENIED', stateChanged: false },
  });
  expect(f.inventory.acknowledgeSource).toHaveBeenCalledTimes(1);
});

it('uses current read authority for hierarchy preview and current write authority for atomic hierarchy acceptance', async () => {
  const authorizeInventoryAgent = vi.fn(async () => {});
  const f = await fixture({ authorizeInventoryAgent });
  f.inventory.previewHierarchy.mockReturnValue({ kind: 'ready', target: { revision: 0 } });
  f.inventory.applyHierarchy.mockReturnValue({ status: 'committed', revision: 1 });
  const base = {
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    agent: { ...inventoryAgent, capabilities: ['read-workspace'] },
  };
  const scope = { project: '/workspace', inventoryId: 'inventory-1' };
  const options = {
    namespace: 'source',
    delimiter: ',',
    parents: [],
    skips: [],
  };
  const preview = { ...scope, format: 'hierarchy-v1', sourceText: 'exact source\r\n', options };
  expect(
    await (
      await f.call({ ...base, command: 'inventory.preview-hierarchy', request: preview })
    ).json()
  ).toMatchObject({ result: { kind: 'hierarchy-preview', preview: { kind: 'ready' } } });
  expect(f.inventory.previewHierarchy).toHaveBeenCalledWith(preview, {
    principal: { kind: 'agent', identityId: 'agent-1' },
  });
  expect(authorizeInventoryAgent).toHaveBeenCalledWith(base.agent, ['read-workspace']);
  const request = {
    kind: 'import-hierarchy',
    ...scope,
    operationId: 'hierarchy-once',
    expectedRevision: 0,
    sourceText: preview.sourceText,
    options,
    expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
  };
  expect(
    await (await f.call({ ...base, command: 'inventory.apply-hierarchy', request })).json()
  ).toMatchObject({ result: { ok: false, code: 'INSUFFICIENT_SCOPE', stateChanged: false } });
  expect(f.inventory.applyHierarchy).not.toHaveBeenCalled();
  const input = { ...base, agent: inventoryAgent, command: 'inventory.apply-hierarchy', request };
  expect(await (await f.call(input)).json()).toMatchObject({
    result: { kind: 'execution', execution: { status: 'committed' } },
  });
  expect(f.inventory.applyHierarchy).toHaveBeenCalledWith(request, expect.any(Function), {
    actor: 'agent:agent-1',
    principal: { kind: 'agent', identityId: 'agent-1' },
  });
  expect(authorizeInventoryAgent).toHaveBeenLastCalledWith(inventoryAgent, [
    'read-workspace',
    'write-workspace',
  ]);
  expect(
    (
      await f.call({
        ...input,
        request: { ...request, principal: { kind: 'agent', identityId: 'other' } },
      })
    ).status
  ).toBe(400);
  authorizeInventoryAgent.mockRejectedValueOnce(new Error('Grant revoked.'));
  expect(await (await f.call(input)).json()).toMatchObject({
    result: { ok: false, code: 'INVENTORY_CAPABILITY_DENIED', stateChanged: false },
  });
  expect(f.inventory.applyHierarchy).toHaveBeenCalledTimes(1);
});

it('uses current read authority for stocktake preview and current write authority for atomic stocktake acceptance', async () => {
  const authorizeInventoryAgent = vi.fn(async () => {});
  const f = await fixture({ authorizeInventoryAgent });
  f.inventory.previewStocktake.mockReturnValue({ kind: 'ready', target: { revision: 0 } });
  f.inventory.applyStocktake.mockReturnValue({ status: 'committed', revision: 1 });
  const base = {
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    agent: { ...inventoryAgent, capabilities: ['read-workspace'] },
  };
  const scope = { project: '/workspace', inventoryId: 'inventory-1' };
  const options = {
    namespace: 'source',
    delimiter: ',',
    subjects: [],
    locations: [],
    decisions: [],
  };
  const preview = { ...scope, format: 'stocktake-v1', sourceText: 'exact source\r\n', options };
  expect(
    await (
      await f.call({ ...base, command: 'inventory.preview-stocktake', request: preview })
    ).json()
  ).toMatchObject({ result: { kind: 'stocktake-preview', preview: { kind: 'ready' } } });
  expect(f.inventory.previewStocktake).toHaveBeenCalledWith(preview, {
    principal: { kind: 'agent', identityId: 'agent-1' },
  });
  expect(authorizeInventoryAgent).toHaveBeenCalledWith(base.agent, ['read-workspace']);
  const request = {
    kind: 'apply-stocktake',
    ...scope,
    operationId: 'stocktake-once',
    expectedRevision: 0,
    sourceText: preview.sourceText,
    options,
    expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
  };
  expect(
    await (await f.call({ ...base, command: 'inventory.apply-stocktake', request })).json()
  ).toMatchObject({ result: { ok: false, code: 'INSUFFICIENT_SCOPE', stateChanged: false } });
  expect(f.inventory.applyStocktake).not.toHaveBeenCalled();
  const input = { ...base, agent: inventoryAgent, command: 'inventory.apply-stocktake', request };
  expect(await (await f.call(input)).json()).toMatchObject({
    result: { kind: 'execution', execution: { status: 'committed' } },
  });
  expect(f.inventory.applyStocktake).toHaveBeenCalledWith(request, expect.any(Function), {
    actor: 'agent:agent-1',
    principal: { kind: 'agent', identityId: 'agent-1' },
  });
  expect(authorizeInventoryAgent).toHaveBeenLastCalledWith(inventoryAgent, [
    'read-workspace',
    'write-workspace',
  ]);
  expect(
    (
      await f.call({
        ...input,
        request: { ...request, principal: { kind: 'agent', identityId: 'other' } },
      })
    ).status
  ).toBe(400);
  authorizeInventoryAgent.mockRejectedValueOnce(new Error('Grant revoked.'));
  expect(await (await f.call(input)).json()).toMatchObject({
    result: { ok: false, code: 'INVENTORY_CAPABILITY_DENIED', stateChanged: false },
  });
  expect(f.inventory.applyStocktake).toHaveBeenCalledTimes(1);
});

it('uses current read authority for table preview and current write authority for atomic table acceptance', async () => {
  const authorizeInventoryAgent = vi.fn(async () => {});
  const f = await fixture({ authorizeInventoryAgent });
  f.inventory.previewTable.mockReturnValue({ kind: 'ready', target: { revision: 0 } });
  f.inventory.applyTable.mockReturnValue({ status: 'committed', revision: 1 });
  const base = {
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    agent: { ...inventoryAgent, capabilities: ['read-workspace'] },
  };
  const scope = { project: '/workspace', inventoryId: 'inventory-1' };
  const options = {
    namespace: 'source',
    delimiter: ',',
    materials: [],
    locations: [],
    vessels: [],
    skips: [],
  };
  const preview = { ...scope, format: 'receive-v1', sourceText: 'exact source\r\n', options };
  expect(
    await (await f.call({ ...base, command: 'inventory.preview-table', request: preview })).json()
  ).toMatchObject({ result: { kind: 'table-preview', preview: { kind: 'ready' } } });
  expect(f.inventory.previewTable).toHaveBeenCalledWith(preview, {
    principal: { kind: 'agent', identityId: 'agent-1' },
  });
  expect(authorizeInventoryAgent).toHaveBeenCalledWith(base.agent, ['read-workspace']);
  const request = {
    kind: 'receive-table',
    ...scope,
    operationId: 'table-once',
    expectedRevision: 0,
    sourceText: preview.sourceText,
    options,
    expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
  };
  expect(
    await (await f.call({ ...base, command: 'inventory.apply-table', request })).json()
  ).toMatchObject({ result: { ok: false, code: 'INSUFFICIENT_SCOPE', stateChanged: false } });
  expect(f.inventory.applyTable).not.toHaveBeenCalled();
  const input = { ...base, agent: inventoryAgent, command: 'inventory.apply-table', request };
  expect(await (await f.call(input)).json()).toMatchObject({
    result: { kind: 'execution', execution: { status: 'committed' } },
  });
  expect(f.inventory.applyTable).toHaveBeenCalledWith(request, expect.any(Function), {
    actor: 'agent:agent-1',
    principal: { kind: 'agent', identityId: 'agent-1' },
  });
  expect(authorizeInventoryAgent).toHaveBeenLastCalledWith(inventoryAgent, [
    'read-workspace',
    'write-workspace',
  ]);
  expect(
    (
      await f.call({
        ...input,
        request: { ...request, principal: { kind: 'agent', identityId: 'other' } },
      })
    ).status
  ).toBe(400);
  authorizeInventoryAgent.mockRejectedValueOnce(new Error('Grant revoked.'));
  expect(await (await f.call(input)).json()).toMatchObject({
    result: { ok: false, code: 'INVENTORY_CAPABILITY_DENIED', stateChanged: false },
  });
  expect(f.inventory.applyTable).toHaveBeenCalledTimes(1);
});

it('admits archive reads with current read authority and requires write authority for adoption', async () => {
  const authorizeInventoryAgent = vi.fn(async () => {});
  const f = await fixture({ authorizeInventoryAgent });
  f.inventory.exportSnapshot.mockReturnValue({ sourceText: 'exact archive text' });
  f.inventory.previewImport.mockReturnValue({ kind: 'ready', target: { revision: 0 } });
  f.inventory.applyImport.mockReturnValue({ status: 'committed', revision: 1 });
  const base = {
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    agent: { ...inventoryAgent, capabilities: ['read-workspace'] },
  };
  const scope = { project: '/workspace', inventoryId: 'inventory-1' };
  for (const [command, request, expected] of [
    [
      'inventory.export-snapshot',
      { ...scope, format: 'native-v1' },
      { kind: 'export-snapshot', artifact: { sourceText: 'exact archive text' } },
    ],
    [
      'inventory.preview-import',
      { ...scope, sourceText: 'exact archive text', options: { bindings: [] } },
      { kind: 'import-preview', preview: { kind: 'ready' } },
    ],
  ] as const) {
    expect(await (await f.call({ ...base, command, request })).json()).toMatchObject({
      result: expected,
    });
  }
  expect(authorizeInventoryAgent).toHaveBeenNthCalledWith(1, base.agent, ['read-workspace']);
  const request = {
    kind: 'adopt-archive',
    ...scope,
    operationId: 'adopt',
    expectedRevision: 0,
    sourceText: 'archive',
    options: { bindings: [] },
    expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
  };
  expect(
    await (await f.call({ ...base, command: 'inventory.apply-import', request })).json()
  ).toMatchObject({ result: { ok: false, code: 'INSUFFICIENT_SCOPE', stateChanged: false } });
  expect(f.inventory.applyImport).not.toHaveBeenCalled();
  const input = { ...base, agent: inventoryAgent, command: 'inventory.apply-import', request };
  expect(await (await f.call(input)).json()).toMatchObject({
    result: { kind: 'execution', execution: { status: 'committed' } },
  });
  expect(authorizeInventoryAgent).toHaveBeenLastCalledWith(inventoryAgent, [
    'read-workspace',
    'write-workspace',
  ]);
  expect(f.inventory.applyImport).toHaveBeenCalledWith(request, expect.any(Function), {
    actor: 'agent:agent-1',
    principal: { kind: 'agent', identityId: 'agent-1' },
  });
  expect((await f.call({ ...input, request: { ...request, recordedAt: 0 } })).status).toBe(400);
  authorizeInventoryAgent.mockRejectedValueOnce(new Error('Grant revoked.'));
  expect(await (await f.call(input)).json()).toMatchObject({
    result: { ok: false, code: 'INVENTORY_CAPABILITY_DENIED', stateChanged: false },
  });
  expect(f.inventory.applyImport).toHaveBeenCalledTimes(1);
});

it('requires current agent verification while retaining native inventory automation', async () => {
  const f = await fixture();
  const input = {
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'inventory.execute',
    request: inventoryRequest,
  };
  const denied = await f.call({ ...input, agent: inventoryAgent });
  expect(denied.status).toBe(200);
  expect(await denied.json()).toMatchObject({
    result: { ok: false, code: 'INVENTORY_CAPABILITY_DENIED', stateChanged: false },
  });
  expect(f.inventory.execute).not.toHaveBeenCalled();
  expect((await f.call(input)).status).toBe(200);
  expect(f.inventory.execute).toHaveBeenCalledExactlyOnceWith(
    inventoryRequest,
    expect.any(Function),
    undefined
  );
});

it.each([
  ['inventory.execute', inventoryRequest, ['read-workspace', 'write-workspace']],
  ['inventory.inspect', { project: '/workspace', inventoryId: 'inventory-1' }, ['read-workspace']],
  [
    'inventory.availability',
    { project: '/workspace', inventoryId: 'inventory-1' },
    ['read-workspace'],
  ],
  [
    'inventory.operation',
    { project: '/workspace', inventoryId: 'inventory-1', operationId: 'operation-1' },
    ['read-workspace'],
  ],
  ['inventory.history', { project: '/workspace', inventoryId: 'inventory-1' }, ['read-workspace']],
  ['inventory.projects', {}, ['read-workspace']],
  ['inventory.catalog', { project: '/workspace' }, ['read-workspace']],
  [
    'inventory.catalog-update-preview',
    { project: '/workspace', inventoryId: 'inventory-1', catalogEntryId: 'catalog-entry' },
    ['read-workspace'],
  ],
  ['inventory.materials', { project: '/workspace', query: '' }, ['read-workspace']],
  [
    'inventory.storage-conditions',
    { project: '/workspace', inventoryId: 'inventory-1', freshnessMaxAgeMs: null },
    ['read-workspace'],
  ],
  [
    'inventory.resolve-item-code',
    {
      project: '/workspace',
      inventoryId: 'inventory-1',
      query: { namespace: null, value: ' 001a ' },
    },
    ['read-workspace'],
  ],
])('verifies current grant scopes for %s', async (command, request, required) => {
  const authorizeInventoryAgent = vi.fn(async () => {});
  const f = await fixture({ authorizeInventoryAgent });
  const response = await f.call({
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command,
    request,
    agent: inventoryAgent,
  });
  expect(response.status).toBe(200);
  expect(authorizeInventoryAgent).toHaveBeenCalledExactlyOnceWith(inventoryAgent, required);
  if (command === 'inventory.execute')
    expect(f.inventory.execute).toHaveBeenCalledExactlyOnceWith(
      inventoryRequest,
      expect.any(Function),
      { actor: 'agent:agent-1', principal: { kind: 'agent', identityId: 'agent-1' } }
    );
  if (command === 'inventory.availability')
    expect(f.inventory.availability).toHaveBeenCalledExactlyOnceWith(request, {
      principal: { kind: 'agent', identityId: 'agent-1' },
    });
  if (command === 'inventory.catalog-update-preview')
    expect(f.inventory.catalogUpdatePreview).toHaveBeenCalledExactlyOnceWith(request);
  if (command === 'inventory.resolve-item-code')
    expect(f.inventory.resolveItemCode).toHaveBeenCalledExactlyOnceWith(request, {
      principal: { kind: 'agent', identityId: 'agent-1' },
    });
  if (command === 'inventory.storage-conditions')
    expect(f.inventory.storageConditions).toHaveBeenCalledExactlyOnceWith(request, {
      principal: { kind: 'agent', identityId: 'agent-1' },
    });
});

it('routes conditions with a required explicit freshness policy and a current read-only grant', async () => {
  const authorizeInventoryAgent = vi.fn(async () => {});
  const f = await fixture({ authorizeInventoryAgent });
  const agent = { ...inventoryAgent, capabilities: ['read-workspace'] };
  const input = {
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'inventory.storage-conditions',
    request: { project: '/workspace', inventoryId: 'inventory-1', freshnessMaxAgeMs: null },
    agent,
  };
  const response = await f.call(input);
  expect(await response.json()).toMatchObject({
    result: {
      kind: 'storage-conditions',
      conditions: { revision: 0, asOf: 1, freshnessMaxAgeMs: null, equipment: {}, stocks: {} },
    },
  });
  expect(authorizeInventoryAgent).toHaveBeenCalledExactlyOnceWith(agent, ['read-workspace']);
  expect(f.inventory.storageConditions).toHaveBeenCalledExactlyOnceWith(input.request, {
    principal: { kind: 'agent', identityId: 'agent-1' },
  });
  const { freshnessMaxAgeMs: _policy, ...missingPolicy } = input.request;
  for (const request of [
    missingPolicy,
    { ...input.request, freshnessMaxAgeMs: -1 },
    { ...input.request, freshnessMaxAgeMs: 0.5 },
    { ...input.request, freshnessMaxAgeMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...input.request, freshnessMaxAgeMs: '100' },
    { ...input.request, asOf: 0 },
    { ...input.request, principal: { kind: 'agent', identityId: 'other' } },
  ])
    expect((await f.call({ ...input, request })).status).toBe(400);
  authorizeInventoryAgent.mockRejectedValueOnce(new Error('Grant was revoked.'));
  expect(await (await f.call(input)).json()).toMatchObject({
    result: { ok: false, code: 'INVENTORY_CAPABILITY_DENIED', stateChanged: false },
  });
  expect(f.inventory.storageConditions).toHaveBeenCalledTimes(1);
  expect(f.inventory.execute).not.toHaveBeenCalled();
});

it('routes catalog previews with read-only grants and preserves known no-write refusals', async () => {
  const authorizeInventoryAgent = vi.fn(async () => {});
  const f = await fixture({ authorizeInventoryAgent });
  const agent = { ...inventoryAgent, capabilities: ['read-workspace'] };
  const input = {
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'inventory.catalog-update-preview',
    request: {
      project: '/workspace',
      inventoryId: 'inventory-1',
      catalogEntryId: 'catalog-entry',
    },
    agent,
  };
  const response = await f.call(input);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    result: { kind: 'catalog-update-preview', preview: { revision: 0, canApply: true } },
  });
  expect(authorizeInventoryAgent).toHaveBeenCalledExactlyOnceWith(agent, ['read-workspace']);
  f.inventory.catalogUpdatePreview.mockImplementationOnce(() => {
    throw new NativeDocumentCommandError(
      'INVENTORY_CATALOG_ENTRY_NOT_FOUND',
      'Unknown catalog entry.',
      false
    );
  });
  const refused = await f.call(input);
  expect(await refused.json()).toMatchObject({
    ok: true,
    result: { ok: false, code: 'INVENTORY_CATALOG_ENTRY_NOT_FOUND', stateChanged: false },
  });
  const malformed = await f.call({ ...input, request: { ...input.request, commands: [] } });
  expect(malformed.status).toBe(400);
  expect(f.inventory.catalogUpdatePreview).toHaveBeenCalledTimes(2);
  expect(f.inventory.execute).not.toHaveBeenCalled();
});

it('preserves raw code queries under a current read-only grant and rejects unknown query fields', async () => {
  const authorizeInventoryAgent = vi.fn(async () => {});
  const f = await fixture({ authorizeInventoryAgent });
  const agent = { ...inventoryAgent, capabilities: ['read-workspace'] };
  const input = {
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'inventory.resolve-item-code',
    request: {
      project: '/workspace',
      inventoryId: 'inventory-1',
      query: { namespace: 'Uppercase', value: ' 001a\r\n' },
    },
    agent,
  };
  const response = await f.call(input);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    result: {
      kind: 'item-code-resolution',
      lookup: { resolution: { kind: 'not-found' }, revision: 0 },
    },
  });
  expect(authorizeInventoryAgent).toHaveBeenCalledExactlyOnceWith(agent, ['read-workspace']);
  expect(f.inventory.resolveItemCode).toHaveBeenCalledExactlyOnceWith(input.request, {
    principal: { kind: 'agent', identityId: agent.identityId },
  });
  const malformed = await f.call({
    ...input,
    request: {
      ...input.request,
      query: { ...input.request.query, extra: true },
    },
  });
  expect(malformed.status).toBe(400);
  const denied = await f.call({ ...input, agent: { ...agent, capabilities: [] } });
  expect(await denied.json()).toMatchObject({
    result: { ok: false, code: 'INSUFFICIENT_SCOPE', stateChanged: false },
  });
  expect(f.inventory.resolveItemCode).toHaveBeenCalledTimes(1);
  expect(f.inventory.execute).not.toHaveBeenCalled();
});

it('prepares immutable label bytes under a current read grant and rejects caller-authored output options', async () => {
  const authorizeInventoryAgent = vi.fn(async () => {});
  const f = await fixture({ authorizeInventoryAgent });
  const agent = { ...inventoryAgent, capabilities: ['read-workspace'] };
  const artifact = {
    schema: 'dnaforge.inventory-label-artifact.v1',
    sourceRevision: 7,
    binding: { id: 'code-1', namespace: 'lab', value: ' 001a^FNC1 ' },
    rendered: { svg: '<svg>exact immutable bytes</svg>' },
    svgSha256: `sha256:${'a'.repeat(64)}`,
  } as unknown as InventoryLabelArtifact;
  f.inventory.prepareLabel.mockResolvedValue(artifact);
  const input = {
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'inventory.prepare-label',
    request: {
      project: '/workspace',
      inventoryId: 'inventory-1',
      codeId: 'code-1',
      mediaProfileId: 'qr-50x30-300dpi',
    },
    agent,
  };
  const response = await f.call(input);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    ownerInstanceId: 'native-1',
    result: { kind: 'label-artifact', artifact },
  });
  expect(authorizeInventoryAgent).toHaveBeenCalledTimes(2);
  expect(authorizeInventoryAgent).toHaveBeenLastCalledWith(agent, ['read-workspace']);
  expect(f.inventory.prepareLabel).toHaveBeenCalledExactlyOnceWith(input.request, {
    principal: { kind: 'agent', identityId: agent.identityId },
  });
  expect(f.inventory.inspect).toHaveBeenCalledExactlyOnceWith({
    project: '/workspace',
    inventoryId: 'inventory-1',
  });
  for (const extra of [
    { value: 'replacement' },
    { path: '/output.svg' },
    { templateId: 'custom' },
  ]) {
    const malformed = await f.call({ ...input, request: { ...input.request, ...extra } });
    expect(malformed.status).toBe(400);
  }
  const denied = await f.call({ ...input, agent: { ...agent, capabilities: [] } });
  expect(await denied.json()).toMatchObject({
    result: { ok: false, code: 'INSUFFICIENT_SCOPE', stateChanged: false },
  });
  f.inventory.prepareLabel.mockRejectedValueOnce(
    new NativeDocumentCommandError('INVENTORY_ITEM_CODE_RETIRED', 'Retired binding.', false)
  );
  expect(await (await f.call(input)).json()).toMatchObject({
    result: { ok: false, code: 'INVENTORY_ITEM_CODE_RETIRED', stateChanged: false },
  });
  expect(f.inventory.execute).not.toHaveBeenCalled();
});

it.each(['revoked', 'owner-changed', 'project-denied'] as const)(
  'withholds label bytes after %s during asynchronous preparation',
  async (change) => {
    let calls = 0;
    const authorizeInventoryAgent = vi.fn(async () => {
      calls += 1;
      if (calls === 2 && change === 'revoked')
        throw new Error('INVENTORY_CAPABILITY_DENIED: Revoked while preparing.');
    });
    const f = await fixture({ authorizeInventoryAgent });
    let complete: (() => void) | undefined;
    f.inventory.prepareLabel.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (complete = resolve));
      if (change === 'owner-changed') f.authority.ownerInstanceId = 'native-2';
      return { rendered: { svg: 'must not escape' } } as InventoryLabelArtifact;
    });
    if (change === 'project-denied')
      f.inventory.inspect.mockImplementationOnce(() => {
        throw new NativeDocumentCommandError(
          'PROJECT_ACCESS_DENIED',
          'Project unavailable.',
          false
        );
      });
    const pending = f.call({
      ownerInstanceId: 'native-1',
      projectScope: { kind: 'app-following' },
      command: 'inventory.prepare-label',
      request: {
        project: '/workspace',
        inventoryId: 'inventory-1',
        codeId: 'code-1',
        mediaProfileId: 'qr-50x30-300dpi',
      },
      agent: { ...inventoryAgent, capabilities: ['read-workspace'] },
    });
    await vi.waitFor(() => expect(complete).toBeDefined());
    complete!();
    const response = await pending;
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain('must not escape');
    if (change === 'owner-changed') {
      expect(response.status).toBe(409);
      expect(body).toMatchObject({
        accepted: false,
        error: { code: 'NATIVE_DOCUMENT_REQUEST_REFUSED' },
      });
    } else {
      expect(body).toMatchObject({
        result: {
          ok: false,
          code: change === 'revoked' ? 'INVENTORY_CAPABILITY_DENIED' : 'PROJECT_ACCESS_DENIED',
          stateChanged: false,
        },
      });
    }
    expect(f.inventory.execute).not.toHaveBeenCalled();
  }
);

it('refuses inventory authority rotated during asynchronous grant verification', async () => {
  let completeAuthorization: (() => void) | undefined;
  const authorizeInventoryAgent = vi.fn(
    () => new Promise<void>((resolve) => (completeAuthorization = resolve))
  );
  const f = await fixture({ authorizeInventoryAgent });
  const response = f.call({
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'inventory.execute',
    request: inventoryRequest,
    agent: inventoryAgent,
  });
  await vi.waitFor(() => expect(authorizeInventoryAgent).toHaveBeenCalledOnce());
  f.authority.token = 'rotated-native-token';
  if (!completeAuthorization) throw new Error('Grant verification did not start.');
  completeAuthorization();
  const refused = await response;
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ ok: false, accepted: false });
  expect(f.inventory.execute).not.toHaveBeenCalled();
});

it('limits no-effect grant refusals to authorization before inventory dispatch', async () => {
  const authorizeInventoryAgent = vi.fn(async () => {
    throw new Error('INVENTORY_CAPABILITY_DENIED: The current grant was revoked.');
  });
  const f = await fixture({ authorizeInventoryAgent });
  const input = {
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'inventory.execute',
    request: inventoryRequest,
    agent: inventoryAgent,
  };
  const denied = await f.call(input);
  expect(denied.status).toBe(200);
  expect(await denied.json()).toMatchObject({
    result: { ok: false, code: 'INVENTORY_CAPABILITY_DENIED', stateChanged: false },
  });
  expect(f.inventory.execute).not.toHaveBeenCalled();
  authorizeInventoryAgent.mockResolvedValue(undefined);
  f.inventory.execute.mockImplementation(() => {
    throw new Error('INVENTORY_CAPABILITY_DENIED: A post-commit observation failed.');
  });
  const uncertain = await f.call(input);
  expect(uncertain.status).toBe(500);
  expect(await uncertain.json()).toMatchObject({
    ok: false,
    accepted: true,
    error: { code: 'NATIVE_DOCUMENT_OUTCOME_UNCONFIRMED' },
  });
});

it('routes bounded public notebook commands directly to the native owner and refuses UI transactions', async () => {
  const f = await fixture();
  const request = { pageId: 'notebook-1', operation: { kind: 'inspect' } };
  const response = await f.call({
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'notebook.execute',
    request,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    result: { documentId: 'notebook-1', revision: 'notebook-revision', blocks: [] },
  });
  expect(f.notebookOwner.executePublic).toHaveBeenCalledExactlyOnceWith({
    ...request,
    operation: { kind: 'inspect', offset: 0, limit: 20 },
  });
  const privateInput = await f.call({
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'notebook.execute',
    request: { documentId: 'notebook-1', operation: { kind: 'apply-steps', steps: [] } },
  });
  expect(privateInput.status).toBe(400);
  expect(f.notebookOwner.executePublic).toHaveBeenCalledOnce();
});

it('dispatches a native file request without a canvas tab or renderer bridge', async () => {
  const f = await fixture();
  const input = { target: { path: '/workspace/closed.txt' }, operation: { kind: 'inspect' } };
  const response = await f.call({
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'file.execute',
    agent: { identityId: 'agent-1', capabilities: ['read-workspace', 'write-workspace'] },
    request: input,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    result: { documentId: 'file-1', text: 'saved' },
  });
  expect(f.fileOwner.executeAgent).toHaveBeenCalledExactlyOnceWith(
    {
      ...input,
      operation: {
        kind: 'inspect',
        offset: 0,
        limit: 2000,
        rowOffset: 0,
        rowLimit: 20,
        columnOffset: 0,
        columnLimit: 20,
      },
    },
    { identityId: 'agent-1', capabilities: ['read-workspace', 'write-workspace'] }
  );
  expect(f.owner.inspect).not.toHaveBeenCalled();
});

it('returns the next native sequence mutation input to agents without private save state', async () => {
  const f = await fixture();
  const execute = (operation: Record<string, unknown>, expectedVersion?: number) =>
    f.call({
      ownerInstanceId: 'native-1',
      projectScope: { kind: 'app-following' },
      command: 'sequence.execute',
      request: { documentId: 'sequence-1', expectedVersion, operation },
    });
  const inspected = await execute({ kind: 'inspect' });
  expect(inspected.status).toBe(200);
  const inspection = (await inspected.json()) as { result: Record<string, unknown> };
  expect(inspection.result).toMatchObject({
    documentId: 'sequence-1',
    version: 3,
    nextMutationInput: { documentId: 'sequence-1', expectedVersion: 3 },
  });
  expect(inspection.result).not.toHaveProperty('outcome');
  f.sequenceOwner.execute.mockResolvedValueOnce({
    ...f.sequenceSnapshot,
    version: 4,
    savedVersion: 4,
    saved: true,
    captureId: 'capture-1',
    history: { status: 'committed' },
  });
  const saved = (await (await execute({ kind: 'save' }, 3)).json()) as {
    result: Record<string, unknown>;
  };
  expect(saved.result).toMatchObject({
    saved: true,
    outcome: 'saved',
    history: { status: 'committed' },
    nextMutationInput: { documentId: 'sequence-1', expectedVersion: 4 },
  });
  expect(saved.result).not.toHaveProperty('captureId');
  f.sequenceOwner.execute.mockResolvedValueOnce({ ...f.sequenceSnapshot, readOnly: true });
  const readOnly = (await (await execute({ kind: 'inspect' })).json()) as {
    result: Record<string, unknown>;
  };
  expect(readOnly.result.nextMutationInput).toBeNull();
});

it('requires trusted current authority when dispatching retained import actions', async () => {
  const f = await fixture();
  const request = {
    project: '/workspace',
    operation: { kind: 'execute', id: 'review-1', command: { kind: 'inspect' } },
  };
  const body = {
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'import-review.execute',
    request,
  };
  expect((await f.call(body)).status).toBe(400);
  expect(f.importReviews.executeAgent).not.toHaveBeenCalled();
  const agent = { identityId: 'agent-1', capabilities: ['read-workspace'] };
  expect((await f.call({ ...body, agent })).status).toBe(200);
  expect(f.importReviews.executeAgent).toHaveBeenCalledExactlyOnceWith(
    request,
    agent,
    expect.any(Function)
  );
  const assertCurrent = f.importReviews.executeAgent.mock.calls[0][2];
  expect(assertCurrent).toBeTypeOf('function');
  f.authority.token = 'rotated';
  expect(() => assertCurrent?.()).toThrow('NATIVE_DOCUMENT_OWNER_CHANGED');
});

it('retains an explicit native file stale refusal without implying a write occurred', async () => {
  const f = await fixture();
  f.fileOwner.executeAgent.mockRejectedValue(
    new NativeDocumentCommandError('STALE_FILE_DRAFT', 'The human edited this file.', false)
  );
  const response = await f.call({
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'file.execute',
    agent: { identityId: 'agent-1', capabilities: ['read-workspace', 'write-workspace'] },
    request: {
      target: { documentId: 'file-1' },
      operation: { kind: 'save' },
      expectedRevision: 'old',
    },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    result: {
      ok: false,
      code: 'STALE_FILE_DRAFT',
      stateChanged: false,
      partialEffects: [],
    },
  });
});

it('refuses an untyped native file mutation before calling its owner', async () => {
  const f = await fixture();
  const response = await f.call({
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'file.execute',
    agent: { identityId: 'agent-1', capabilities: ['read-workspace', 'write-workspace'] },
    request: {
      target: { path: '/workspace/closed.txt' },
      operation: { kind: 'shell', command: 'arbitrary' },
    },
  });
  expect(response.status).toBe(400);
  expect(f.fileOwner.executeAgent).not.toHaveBeenCalled();
});

it('does not infer no effect from an untyped FILE_CHANGED message after acceptance', async () => {
  const f = await fixture();
  f.fileOwner.executeAgent.mockRejectedValue(
    new Error('FILE_CHANGED: A post-publication observation failed.')
  );
  const response = await f.call({
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'file.execute',
    agent: { identityId: 'agent-1', capabilities: ['read-workspace', 'write-workspace'] },
    request: {
      target: { documentId: 'file-1' },
      operation: { kind: 'save' },
      expectedRevision: 'old',
    },
  });
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({
    ok: false,
    accepted: true,
    error: { code: 'NATIVE_DOCUMENT_OUTCOME_UNCONFIRMED' },
  });
});

it('refuses ordinary, expired and browser-origin credentials before any dispatch', async () => {
  const f = await fixture();
  for (const token of [null, 'human-operation-token', 'old-native']) {
    expect((await f.call(f.body, token)).status).toBe(403);
  }
  expect(
    (await f.call(f.body, f.authority.token, { Origin: 'http://localhost:3000' })).status
  ).toBe(403);
  expect(f.owner.inspect).not.toHaveBeenCalled();
});

it('binds each request to the expected native owner and a bounded typed input', async () => {
  const f = await fixture();
  expect((await f.call({ ...f.body, ownerInstanceId: 'old-owner' })).status).toBe(409);
  expect((await f.call({ ...f.body, command: 'run-shell-command' })).status).toBe(400);
  expect((await f.call({ ...f.body, actorId: 'forged' })).status).toBe(400);
  const oversized = await f.call({ ...f.body, authority: 'x'.repeat(18 * 1024 * 1024) });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toEqual({
    ok: false,
    accepted: false,
    error: { code: 'INVALID_NATIVE_DOCUMENT_REQUEST' },
  });
  expect(f.owner.inspect).not.toHaveBeenCalled();
});

it('can carry a retained result larger than the old renderer bridge request limit', async () => {
  const f = await fixture();
  const body = { ...f.body, authority: { retainedResult: 'x'.repeat(2 * 1024 * 1024) } };
  expect((await f.call(body)).status).toBe(200);
  expect(f.owner.inspect).toHaveBeenCalledOnce();
});

it('forwards only an admitted Apply request and preserves its concrete result', async () => {
  const f = await fixture();
  const request = {
    actionId: 'action-1',
    requestSha256: `sha256:${'a'.repeat(64)}`,
    selection: {
      ...f.body.target,
      expectedOperationVersion: 1,
      expectedResultSha256: `sha256:${'b'.repeat(64)}`,
      expectedTargetDocumentRevision: `annotation-document-v1:sha256:${'c'.repeat(64)}`,
      selectedCandidateIds: ['op-1:0'],
    },
  };
  const response = await f.call({
    ownerInstanceId: 'native-1',
    projectScope: { kind: 'app-following' },
    command: 'annotation.apply',
    request,
  });
  expect(response.status).toBe(200);
  expect(f.owner.apply).toHaveBeenCalledExactlyOnceWith(request);
  expect(await response.json()).toMatchObject({
    result: { status: 'blocked', reason: 'Fixture refusal' },
  });
});

it('does not label a missing completion as permission to repeat an accepted save', async () => {
  const f = await fixture();
  f.owner.inspect.mockRejectedValue(new Error('private internal failure'));
  const response = await f.call();
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({
    ok: false,
    accepted: true,
    error: { code: 'NATIVE_DOCUMENT_OUTCOME_UNCONFIRMED' },
  });
});

it('refuses authority rotated while a request body was still arriving', async () => {
  const f = await fixture();
  const payload = JSON.stringify(f.body);
  let finish: (() => void) | undefined;
  const completed = new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      f.server.url + '/internal/native-documents/call',
      {
        method: 'POST',
        headers: {
          'Content-Length': Buffer.byteLength(payload),
          'X-DNAForge-Native-Document-Authority': f.authority.token,
        },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      }
    );
    req.once('error', reject);
    req.write(payload.slice(0, 10));
    finish = () => req.end(payload.slice(10));
  });
  await vi.waitFor(() => expect(f.getAuthority).toHaveBeenCalledOnce());
  f.authority.token = 'rotated-native-token';
  if (!finish) throw new Error('The fixture request did not start');
  finish();
  expect(await completed).toBe(409);
  expect(f.owner.inspect).not.toHaveBeenCalled();
});
