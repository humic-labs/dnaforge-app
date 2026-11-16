import { describe, expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  adoptInventoryState,
  applyInventoryTable,
  applyInventoryStocktake,
  inventoryStocktakePreview,
  applyInventorySourceRevision,
  applyInventoryHierarchy,
  inventoryHierarchyPreview,
  inventorySourceRevisionPreview,
  inventoryTablePreview,
  createInventoryState,
  inventoryAvailability,
  inventoryResolveItemCode,
  inventoryStorageConditionsProjection,
  type InventoryCommand,
  type InventoryEquipmentCatalogUpdatePreview,
  type InventoryReceiveTableFields,
  type InventoryState,
} from '@waypoint/domain-services';
import type {
  InventoryChanged,
  InventoryAvailabilitySnapshot,
  InventoryClient,
  InventoryProject,
  InventoryItemCodeLookupSnapshot,
} from '../../shared/inventory-client';
import type {
  InventoryAcceptedRequest,
  InventoryApplyImportRequest,
  NativeInventoryHistoryEntry,
  NativeInventoryReceipt,
} from '../../shared/inventory-command';
import {
  InventoryController,
  inventoryAttemptStorage,
  type InventoryAttempt,
  type InventoryAttemptStorage,
} from './inventory-controller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const project: InventoryProject = {
  projectId: 'project-a',
  defaultInventoryId: 'inventory-a',
  name: 'Project A',
  path: '/synthetic/a',
  pinned: false,
};
const other: InventoryProject = {
  projectId: 'project-b',
  defaultInventoryId: 'inventory-b',
  name: 'Project B',
  path: '/synthetic/b',
  pinned: false,
};
const principal = { kind: 'local-profile' as const, profileKey: 'test-profile' };
const useOne: InventoryCommand[] = [
  { kind: 'consume', stockId: 'stock', quantity: { value: '1', unit: 'uL' }, reason: 'Experiment' },
];

function fixture(empty = false) {
  const initial = applyInventoryCommandBatch(createInventoryState(), {
    expectedRevision: 0,
    commands: [
      { kind: 'create-vessel', id: 'tube', name: 'Tube', placement: { kind: 'unplaced' } },
      {
        kind: 'receive-stock',
        id: 'stock',
        vesselId: 'tube',
        materialId: 'material',
        quantity: { kind: 'known', value: '2', unit: 'uL' },
        quality: 'usable',
      },
    ],
  });
  if (!initial.ok) throw new Error(initial.message);
  let state = empty ? createInventoryState() : initial.state;
  let saved: readonly InventoryAttempt[] = [];
  const entries: NativeInventoryHistoryEntry[] = [];
  const listeners = new Set<(event: InventoryChanged) => void>();
  const storage: InventoryAttemptStorage = {
    read: () => structuredClone(saved),
    write: vi.fn((attempts) => {
      saved = structuredClone(attempts);
    }),
  };
  const emit = (revision: number, operationId = 'external') => {
    for (const listener of listeners)
      listener({
        projectId: project.projectId,
        inventoryId: project.defaultInventoryId,
        revision,
        operationId,
      });
  };
  const commit = (request: InventoryAcceptedRequest): NativeInventoryReceipt => {
    const previous = entries.find((entry) => entry.receipt.operationId === request.operationId);
    if (previous) return previous.receipt;
    const result =
      'kind' in request
        ? request.kind === 'adopt-archive'
          ? adoptInventoryState(
              state.revision === 0 ? null : state,
              initial.state,
              {
                source: {
                  archiveSha256: `sha256:${'a'.repeat(64)}`,
                  projectId: 'source-project',
                  inventoryId: 'source-inventory',
                  revision: initial.state.revision,
                },
                materialBindings: Object.fromEntries(
                  request.options.bindings.map((binding) => [
                    binding.sourceMaterialId,
                    binding.destinationMaterialId,
                  ])
                ),
              },
              { at: 1, principal, authority: principal }
            )
          : request.kind === 'receive-table'
            ? applyInventoryTable(
                state.revision === 0 ? null : state,
                {
                  ...request,
                  target: {
                    projectId: request.project,
                    inventoryId: request.inventoryId,
                    present: state.revision !== 0,
                    revision: request.expectedRevision,
                  },
                  expectedPlanDigest: request.expectedPlanDigest as `sha256:${string}`,
                },
                { at: 1, principal, authority: principal },
                17 * 1024 * 1024
              )
            : request.kind === 'apply-stocktake'
              ? applyInventoryStocktake(
                  state.revision === 0 ? null : state,
                  {
                    ...request,
                    target: {
                      projectId: request.project,
                      inventoryId: request.inventoryId,
                      present: state.revision !== 0,
                      revision: request.expectedRevision,
                    },
                    expectedPlanDigest: request.expectedPlanDigest as `sha256:${string}`,
                  },
                  { at: 1, principal, authority: principal },
                  17 * 1024 * 1024
                )
              : request.kind === 'acknowledge-table-source'
                ? applyInventorySourceRevision(
                    state.revision === 0 ? null : state,
                    {
                      ...request,
                      target: {
                        projectId: request.project,
                        inventoryId: request.inventoryId,
                        present: state.revision !== 0,
                        revision: request.expectedRevision,
                      },
                    },
                    { at: 1, principal, authority: principal },
                    17 * 1024 * 1024
                  )
                : applyInventoryHierarchy(
                    state.revision === 0 ? null : state,
                    {
                      ...request,
                      target: {
                        projectId: request.project,
                        inventoryId: request.inventoryId,
                        present: state.revision !== 0,
                        revision: request.expectedRevision,
                      },
                    },
                    { at: 1, principal, authority: principal },
                    17 * 1024 * 1024
                  )
        : applyInventoryCommandBatch(state, {
            expectedRevision: request.expectedRevision,
            commands: request.commands,
          });
    if (!result.ok) throw new Error(result.message);
    state = result.state;
    const receipt: NativeInventoryReceipt = {
      status: 'committed',
      inventoryId: request.inventoryId,
      operationId: request.operationId,
      revision: state.revision,
      actor: 'synthetic-actor',
      recordedAt: 1,
      requestDigest: `sha256:${'0'.repeat(64)}`,
    };
    entries.push({ request: structuredClone(request), receipt });
    emit(state.revision, receipt.operationId);
    return receipt;
  };
  const client: InventoryClient = {
    projects: vi.fn(async () => [project]),
    materials: vi.fn(async () => ({ items: [], nextCursor: null })),
    catalog: vi.fn(async () => []),
    catalogUpdatePreview: vi.fn(async (): Promise<InventoryEquipmentCatalogUpdatePreview> => {
      throw new Error('Catalog preview is not used by this controller fixture.');
    }),
    resolveItemCode: vi.fn(async (request): Promise<InventoryItemCodeLookupSnapshot> => {
      const current = request.project === other.projectId ? createInventoryState() : state;
      return {
        projectId: request.project,
        inventoryId: request.inventoryId,
        revision: current.revision,
        asOf: 1,
        principal,
        resolution: inventoryResolveItemCode(current, request.query),
        targets: [],
      };
    }),
    prepareLabel: vi.fn(async () => {
      throw new Error('Label rendering is not used by this controller fixture.');
    }),
    exportSnapshot: vi.fn(async () => {
      throw new Error('Archive capture is not used by this controller fixture.');
    }),
    previewImport: vi.fn(async () => {
      throw new Error('Archive preview is not used by this controller fixture.');
    }),
    applyImport: vi.fn(async (request) => commit(request)),
    previewTable: vi.fn(async () => {
      throw new Error('Table preview is not used by this controller fixture.');
    }),
    applyTable: vi.fn(async (request) => commit(request)),
    previewStocktake: vi.fn(async () => {
      throw new Error('Stocktake preview is not used by this controller fixture.');
    }),
    applyStocktake: vi.fn(async (request) => commit(request)),
    previewSourceRevision: vi.fn(async () => {
      throw new Error('Source revision comparison is not used by this controller fixture.');
    }),
    acknowledgeSource: vi.fn(async (request) => commit(request)),
    previewHierarchy: vi.fn(async () => {
      throw new Error('Hierarchy preview is not used by this controller fixture.');
    }),
    applyHierarchy: vi.fn(async (request) => commit(request)),
    storageConditions: vi.fn(async (request) => {
      const current = request.project === other.projectId ? createInventoryState() : state;
      return {
        ...inventoryStorageConditionsProjection(current, {
          asOf: 1,
          freshnessMaxAgeMs: request.freshnessMaxAgeMs,
        }),
        projectId: request.project,
        inventoryId: request.inventoryId,
        revision: current.revision,
        principal,
      };
    }),
    inspect: vi.fn(async (request) =>
      request.project === other.projectId ? createInventoryState() : state
    ),
    availability: vi.fn(async (request) => {
      const current = request.project === other.projectId ? createInventoryState() : state;
      return {
        ...inventoryAvailability(current, principal, 1),
        revision: current.revision,
        asOf: 1,
        principal,
      };
    }),
    history: vi.fn(async () => entries),
    execute: vi.fn(async (request) => commit(request)),
    operation: vi.fn(
      async (request) =>
        entries.find((entry) => entry.receipt.operationId === request.operationId)?.receipt ?? null
    ),
    onChanged: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  let nextId = 0;
  const controller = new InventoryController(client, storage, () => `operation-${++nextId}`);
  return {
    client,
    storage,
    controller,
    emit,
    commit,
    state: () => state,
    saved: () => saved,
    entries,
  };
}

describe('inventory interaction controller', () => {
  it('resolves an exact code as a read without changing stock or pending mutations', async () => {
    const f = fixture();
    await f.controller.open();
    const before = structuredClone(f.state());
    await f.controller.resolveItemCode({ namespace: 'lab', value: ' 00AbC ' });
    expect(f.client.resolveItemCode).toHaveBeenCalledWith({
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
      query: { namespace: 'lab', value: ' 00AbC ' },
    });
    expect(f.controller.getSnapshot().itemCodeLookup).toMatchObject({
      kind: 'ready',
      lookup: { resolution: { kind: 'not-found' }, revision: before.revision },
    });
    expect(f.state()).toEqual(before);
    expect(f.client.execute).not.toHaveBeenCalled();
    expect(f.saved()).toEqual([]);
  });

  it('discards an older lookup after the raw input changes and another code is read', async () => {
    const f = fixture();
    await f.controller.open();
    const old = await f.client.resolveItemCode({
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
      query: { namespace: null, value: 'old' },
    });
    const pending = deferred<InventoryItemCodeLookupSnapshot>();
    vi.mocked(f.client.resolveItemCode).mockImplementationOnce(() => pending.promise);
    const first = f.controller.resolveItemCode({ namespace: null, value: 'old' });
    f.controller.clearItemCodeLookup();
    await f.controller.resolveItemCode({ namespace: null, value: 'new' });
    pending.resolve(old);
    await first;
    expect(f.controller.getSnapshot().itemCodeLookup).toMatchObject({
      kind: 'ready',
      query: { value: 'new' },
    });
  });

  it('discards lookup results after a project switch', async () => {
    const f = fixture();
    vi.mocked(f.client.projects).mockResolvedValue([project, other]);
    await f.controller.open();
    await f.controller.selectProject(project.projectId);
    const old = await f.client.resolveItemCode({
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
      query: { namespace: null, value: '001' },
    });
    const pending = deferred<InventoryItemCodeLookupSnapshot>();
    vi.mocked(f.client.resolveItemCode).mockImplementationOnce(() => pending.promise);
    const read = f.controller.resolveItemCode({ namespace: null, value: '001' });
    await f.controller.selectProject(other.projectId);
    pending.resolve(old);
    await read;
    expect(f.controller.getSnapshot().itemCodeLookup).toEqual({ kind: 'idle' });
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'ready',
      data: { project: { projectId: other.projectId } },
    });
  });

  it('discards a pending lookup when newer inventory and availability are loaded', async () => {
    const f = fixture();
    await f.controller.open();
    const old = await f.client.resolveItemCode({
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
      query: { namespace: null, value: '001' },
    });
    const pending = deferred<InventoryItemCodeLookupSnapshot>();
    vi.mocked(f.client.resolveItemCode).mockImplementationOnce(() => pending.promise);
    const read = f.controller.resolveItemCode({ namespace: null, value: '001' });
    f.commit({
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
      operationId: 'external-use',
      expectedRevision: f.state().revision,
      commands: useOne,
    });
    await f.controller.refresh();
    pending.resolve(old);
    await read;
    expect(f.controller.getSnapshot().itemCodeLookup).toEqual({ kind: 'idle' });
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'ready',
      data: { availability: { revision: old.revision + 1 } },
    });
  });

  it('reports unavailable rather than not found for a mismatched revision or failed lookup', async () => {
    const f = fixture();
    await f.controller.open();
    const response = await f.client.resolveItemCode({
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
      query: { namespace: null, value: '001' },
    });
    vi.mocked(f.client.resolveItemCode).mockResolvedValueOnce({
      ...response,
      revision: response.revision + 1,
    });
    await f.controller.resolveItemCode({ namespace: null, value: '001' });
    expect(f.controller.getSnapshot().itemCodeLookup.kind).toBe('unavailable');
    vi.mocked(f.client.resolveItemCode).mockRejectedValueOnce(new Error('Transport unavailable'));
    await f.controller.resolveItemCode({ namespace: null, value: '001' });
    expect(f.controller.getSnapshot().itemCodeLookup.kind).toBe('unavailable');
  });

  it('loads the equipment catalog lazily and retains its cache across stock mutations', async () => {
    const f = fixture();
    await f.controller.initialize();
    expect(f.client.catalog).not.toHaveBeenCalled();
    await f.controller.loadCatalog(project.projectId);
    expect(f.controller.getSnapshot().catalog).toEqual({
      kind: 'ready',
      projectId: project.projectId,
      entries: [],
    });
    await f.controller.submit(useOne, 'Use stock');
    await f.controller.loadCatalog(project.projectId);
    expect(f.client.catalog).toHaveBeenCalledTimes(1);
    expect(f.controller.getSnapshot().status.kind).toBe('ready');
    f.controller.dispose();
  });

  it('keeps stock ready when the independent equipment catalog fails', async () => {
    const f = fixture();
    await f.controller.initialize();
    vi.mocked(f.client.catalog).mockRejectedValueOnce(new Error('Catalog disconnected'));
    await f.controller.loadCatalog(project.projectId);
    expect(f.controller.getSnapshot().catalog).toMatchObject({
      kind: 'failed',
      projectId: project.projectId,
    });
    expect(f.controller.getSnapshot().status.kind).toBe('ready');
    expect(await f.controller.submit(useOne, 'Use stock')).toMatchObject({ status: 'committed' });
    f.controller.dispose();
  });

  it('discards a catalog response from a previously selected project', async () => {
    const f = fixture();
    vi.mocked(f.client.projects).mockResolvedValue([project, other]);
    await f.controller.initialize();
    await f.controller.selectProject(project.projectId);
    const pending = deferred<Awaited<ReturnType<InventoryClient['catalog']>>>();
    vi.mocked(f.client.catalog).mockReturnValueOnce(pending.promise);
    const loading = f.controller.loadCatalog(project.projectId);
    await f.controller.selectProject(other.projectId);
    pending.resolve([]);
    await loading;
    expect(f.controller.getSnapshot().catalog).toEqual({ kind: 'idle' });
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'ready',
      data: { project: { projectId: other.projectId } },
    });
    f.controller.dispose();
  });

  it('rereads state and availability together when their revisions differ', async () => {
    const f = fixture();
    const current = await f.client.availability({
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
    });
    vi.mocked(f.client.availability).mockResolvedValueOnce({ ...current!, revision: 2 });
    await f.controller.initialize();
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'ready',
      data: { state: { revision: 1 }, availability: { revision: 1, principal } },
    });
    expect(f.client.inspect).toHaveBeenCalledTimes(2);
    f.controller.dispose();
  });

  it('rereads temperature conditions with inventory instead of displaying a mixed revision', async () => {
    const f = fixture();
    const current = await f.client.storageConditions({
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
      freshnessMaxAgeMs: null,
    });
    vi.mocked(f.client.storageConditions).mockResolvedValueOnce({ ...current, revision: 2 });
    await f.controller.initialize();
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'ready',
      data: { state: { revision: 1 }, storageConditions: { revision: 1, freshnessMaxAgeMs: null } },
    });
    expect(f.client.inspect).toHaveBeenCalledTimes(2);
    expect(f.client.execute).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it('refuses foreign-scope temperature projections even at the same revision', async () => {
    const f = fixture();
    const current = await f.client.storageConditions({
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
      freshnessMaxAgeMs: null,
    });
    vi.mocked(f.client.storageConditions).mockResolvedValue({
      ...current,
      projectId: other.projectId,
    });
    await f.controller.initialize();
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'refused',
      code: 'INVENTORY_READ_FAILED',
    });
    expect(f.client.inspect).toHaveBeenCalledTimes(3);
    expect(f.client.execute).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it('keeps an explicit freshness policy within its project and inventory scope', async () => {
    const f = fixture();
    vi.mocked(f.client.projects).mockResolvedValue([project, other]);
    await f.controller.initialize();
    await f.controller.selectProject(project.projectId);
    expect(f.client.storageConditions).toHaveBeenLastCalledWith({
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
      freshnessMaxAgeMs: null,
    });
    await f.controller.setStorageFreshnessPolicy(60000);
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'ready',
      data: { storageConditions: { freshnessMaxAgeMs: 60000 } },
    });
    await f.controller.selectProject(other.projectId);
    expect(f.client.storageConditions).toHaveBeenLastCalledWith({
      project: other.projectId,
      inventoryId: other.defaultInventoryId,
      freshnessMaxAgeMs: null,
    });
    await f.controller.selectProject(project.projectId);
    expect(f.client.storageConditions).toHaveBeenLastCalledWith({
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
      freshnessMaxAgeMs: 60000,
    });
    expect(f.client.execute).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it('fences a delayed temperature projection after the project changes', async () => {
    const f = fixture();
    vi.mocked(f.client.projects).mockResolvedValue([project, other]);
    await f.controller.initialize();
    const current = await f.client.storageConditions({
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
      freshnessMaxAgeMs: null,
    });
    const delayed = deferred<typeof current>();
    vi.mocked(f.client.storageConditions).mockReturnValueOnce(delayed.promise);
    const selecting = f.controller.selectProject(project.projectId);
    await Promise.resolve();
    await f.controller.selectProject(other.projectId);
    delayed.resolve(current);
    await selecting;
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'ready',
      data: {
        project: { projectId: other.projectId },
        storageConditions: { projectId: other.projectId, revision: 0 },
      },
    });
    f.controller.dispose();
  });

  it('refuses readiness when availability never reaches the same revision as inventory', async () => {
    const f = fixture();
    const current = await f.client.availability({
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
    });
    vi.mocked(f.client.availability).mockResolvedValue({ ...current!, revision: 0 });
    await f.controller.initialize();
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'refused',
      code: 'INVENTORY_READ_FAILED',
    });
    expect(f.client.inspect).toHaveBeenCalledTimes(3);
    expect(f.client.execute).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it('fences delayed availability from a previously selected project', async () => {
    const f = fixture();
    vi.mocked(f.client.projects).mockResolvedValue([project, other]);
    await f.controller.initialize();
    const snapshot = await f.client.availability({
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
    });
    const delayed = deferred<InventoryAvailabilitySnapshot | null>();
    vi.mocked(f.client.availability).mockReturnValueOnce(delayed.promise);
    const selecting = f.controller.selectProject(project.projectId);
    await Promise.resolve();
    await f.controller.selectProject(other.projectId);
    delayed.resolve(snapshot);
    await selecting;
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'ready',
      data: {
        project: { projectId: other.projectId },
        state: { revision: 0 },
        availability: { revision: 0 },
      },
    });
    f.controller.dispose();
  });

  it('retains the committed receipt when availability refresh fails and never resends the mutation', async () => {
    const f = fixture();
    await f.controller.initialize();
    vi.mocked(f.client.availability).mockRejectedValueOnce(new Error('Availability disconnected'));
    await f.controller.submit(useOne, 'Use stock');
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'committed-refresh-failed',
      attempt: { receipt: { revision: 2 } },
    });
    expect(f.saved()[0].receipt?.revision).toBe(2);
    await f.controller.refresh();
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'ready',
      data: { state: { revision: 2 }, availability: { revision: 2 } },
    });
    expect(f.client.execute).toHaveBeenCalledTimes(1);
    expect(f.saved()).toEqual([]);
    f.controller.dispose();
  });

  it('validates a draft before retaining or sending it, then accepts a corrected draft', async () => {
    const f = fixture();
    await f.controller.initialize();
    for (const value of ['-1', '', '1e3']) {
      await f.controller.submit(
        [
          {
            kind: 'consume',
            stockId: 'stock',
            quantity: { value, unit: 'uL' },
            reason: 'Experiment',
          },
        ],
        'Use stock'
      );
      expect(f.controller.getSnapshot().status).toMatchObject({
        kind: 'refused',
        code: 'INVALID_INVENTORY_INPUT',
      });
    }
    expect(f.client.execute).not.toHaveBeenCalled();
    expect(f.storage.write).not.toHaveBeenCalled();
    expect(f.saved()).toEqual([]);
    expect(await f.controller.submit(useOne, 'Use stock')).toMatchObject({ status: 'committed' });
    expect(f.state().stocks.stock.quantity).toEqual({ kind: 'known', value: '1', unit: 'uL' });
    expect(f.client.execute).toHaveBeenCalledTimes(1);
    f.controller.dispose();
  });

  it('does not treat a changed event as acknowledgement and resolves a lost acknowledgement by receipt', async () => {
    const f = fixture();
    await f.controller.initialize();
    vi.mocked(f.client.execute).mockImplementationOnce(async (request) => {
      f.commit(request);
      throw new Error('Connection lost');
    });
    await f.controller.submit(useOne, 'Use stock');
    expect(f.controller.getSnapshot().status.kind).toBe('outcome-unknown');
    f.emit(2, 'operation-1');
    expect(f.controller.getSnapshot().status.kind).toBe('outcome-unknown');
    expect(f.saved()).toHaveLength(1);
    await f.controller.checkPending();
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'ready',
      data: { state: { revision: 2 } },
    });
    expect(f.state().stocks.stock.quantity).toEqual({ kind: 'known', value: '1', unit: 'uL' });
    expect(f.client.execute).toHaveBeenCalledTimes(1);
    expect(f.saved()).toEqual([]);
    f.controller.dispose();
  });

  it('retains exact command identity across controller recreation and retries only the original request', async () => {
    const f = fixture();
    await f.controller.initialize();
    vi.mocked(f.client.execute).mockRejectedValueOnce(new Error('No acknowledgement'));
    await f.controller.submit(useOne, 'Use stock');
    const original = structuredClone(f.saved()[0].request);
    f.controller.dispose();
    const reopened = new InventoryController(f.client, f.storage, () => 'must-not-be-minted');
    await reopened.initialize();
    expect(reopened.getSnapshot().status.kind).toBe('outcome-unknown');
    await reopened.retryPending();
    expect(vi.mocked(f.client.execute).mock.calls[1][0]).toEqual(original);
    expect(f.entries).toHaveLength(1);
    expect(f.state().stocks.stock.quantity).toEqual({ kind: 'known', value: '1', unit: 'uL' });
    expect(reopened.getSnapshot().status.kind).toBe('ready');
    reopened.dispose();
  });

  it('keeps committed knowledge visible while refresh is pending and after refresh failure', async () => {
    const f = fixture();
    await f.controller.initialize();
    const read = deferred<InventoryState | null>();
    vi.mocked(f.client.inspect).mockReturnValueOnce(read.promise);
    const submitted = f.controller.submit(useOne, 'Use stock');
    await Promise.resolve();
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'submitting',
      stage: 'refreshing',
      attempt: { receipt: { status: 'committed', revision: 2 } },
    });
    read.reject(new Error('Read failed'));
    await submitted;
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'committed-refresh-failed',
      attempt: { receipt: { revision: 2 } },
    });
    expect(f.saved()[0].receipt).toMatchObject({ revision: 2 });
    await f.controller.refresh();
    expect(f.controller.getSnapshot().status.kind).toBe('ready');
    expect(f.client.execute).toHaveBeenCalledTimes(1);
    expect(f.saved()).toEqual([]);
    f.controller.dispose();
  });

  it('latches an external revision arriving during a pending read and rereads before returning ready', async () => {
    const f = fixture();
    await f.controller.initialize();
    const old = f.state();
    const read = deferred<InventoryState | null>();
    vi.mocked(f.client.inspect).mockReturnValueOnce(read.promise);
    const refreshing = f.controller.refresh();
    f.commit({
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
      operationId: 'external-use',
      expectedRevision: 1,
      commands: useOne,
    });
    read.resolve(old);
    await refreshing;
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'ready',
      data: { state: { revision: 2, stocks: { stock: { quantity: { value: '1' } } } } },
    });
    expect(f.client.inspect).toHaveBeenCalledTimes(3);
    f.controller.dispose();
  });

  it('keeps a definitive rejection distinct from uncertainty when retry storage cannot be cleared', async () => {
    const f = fixture();
    await f.controller.initialize();
    vi.mocked(f.client.execute).mockImplementationOnce(async (request) => ({
      status: 'rejected',
      inventoryId: request.inventoryId,
      operationId: request.operationId,
      code: 'STOCK_QUARANTINED',
      message: 'Release this stock before use.',
    }));
    vi.mocked(f.storage.write).mockImplementation((attempts) => {
      if (attempts.length === 0) throw new Error('Storage unavailable');
    });
    await f.controller.submit(useOne, 'Use stock');
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'refused',
      code: 'STOCK_QUARANTINED',
      recoveryError: expect.any(String),
    });
    expect(f.client.operation).not.toHaveBeenCalled();
    expect(await f.controller.retryPending()).toBeNull();
    expect(f.client.execute).toHaveBeenCalledTimes(1);
    expect(f.state().revision).toBe(1);
    f.controller.dispose();
  });

  it('fences a pending operation from a newly selected project and retains its original scope', async () => {
    const f = fixture();
    vi.mocked(f.client.projects).mockResolvedValue([project, other]);
    await f.controller.initialize();
    await f.controller.selectProject(project.projectId);
    const result = deferred<NativeInventoryReceipt>();
    vi.mocked(f.client.execute).mockReturnValueOnce(result.promise);
    const submitted = f.controller.submit(useOne, 'Use stock');
    await f.controller.selectProject(other.projectId);
    const original = f.saved()[0].request;
    result.resolve(f.commit(original));
    await submitted;
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'ready',
      data: { project: { projectId: other.projectId }, state: { revision: 0 } },
    });
    expect(original.project).toBe(project.projectId);
    expect(original.inventoryId).toBe(project.defaultInventoryId);
    f.controller.dispose();
  });

  it('refreshes project metadata on view reopen without resetting an unresolved attempt or resubscribing', async () => {
    const f = fixture();
    await f.controller.open();
    vi.mocked(f.client.execute).mockRejectedValueOnce(new Error('Lost response'));
    await f.controller.submit(useOne, 'Use stock');
    const attempt = structuredClone(f.saved()[0]);
    vi.mocked(f.client.projects).mockResolvedValue([
      { ...project, name: 'Renamed project' },
      other,
    ]);
    await f.controller.open();
    expect(f.controller.getSnapshot().projects.map((item) => item.name)).toEqual([
      'Renamed project',
      'Project B',
    ]);
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'outcome-unknown',
      data: { project: { name: 'Renamed project' } },
      attempt,
    });
    expect(f.client.onChanged).toHaveBeenCalledTimes(1);
    expect(f.saved()).toEqual([attempt]);
    f.controller.dispose();
  });

  it('round trips recovery storage through the production request parser', () => {
    const values = new Map<string, string>();
    const storage = inventoryAttemptStorage({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    });
    const attempt: InventoryAttempt = {
      summary: 'Use stock',
      request: {
        project: project.projectId,
        inventoryId: project.defaultInventoryId,
        operationId: 'original',
        expectedRevision: 1,
        commands: useOne,
      },
    };
    storage.write([attempt]);
    expect(storage.read()).toEqual([attempt]);
  });

  it('recovers the original adopted receipt after a lost acknowledgement and controller restart', async () => {
    const f = fixture(true);
    await f.controller.initialize();
    vi.mocked(f.client.applyImport).mockImplementationOnce(async (request) => {
      f.commit(request);
      throw new Error('Lost adoption response');
    });
    const sourceText = '{"retained":"original archive"}\r\n';
    const options = {
      bindings: [
        {
          sourceMaterialId: 'material',
          destinationMaterialId: 'bound-material',
          fingerprint: `sha256:${'b'.repeat(64)}` as const,
        },
      ],
    };
    await f.controller.adoptArchive(sourceText, options, `sha256:${'a'.repeat(64)}`);
    expect(f.controller.getSnapshot().status).toMatchObject({ kind: 'outcome-unknown' });
    const original = structuredClone(f.saved()[0]);
    expect(original.request).toMatchObject({
      kind: 'adopt-archive',
      operationId: 'operation-1',
      expectedRevision: 0,
      sourceText,
      options,
    });
    expect(f.entries).toHaveLength(1);
    f.controller.dispose();
    const reopened = new InventoryController(f.client, f.storage, () => {
      throw new Error('Recovery must not allocate another operation');
    });
    await reopened.initialize();
    expect(reopened.getSnapshot().status).toMatchObject({
      kind: 'outcome-unknown',
      attempt: original,
    });
    await reopened.checkPending();
    expect(reopened.getSnapshot().status).toMatchObject({
      kind: 'ready',
      data: {
        state: {
          revision: 1,
          origin: { kind: 'archive-adoption' },
          stocks: { stock: { materialId: 'bound-material', quantity: { value: '2' } } },
        },
      },
    });
    expect(f.client.applyImport).toHaveBeenCalledOnce();
    expect(f.client.execute).not.toHaveBeenCalled();
    expect(f.saved()).toEqual([]);
    expect(f.entries).toHaveLength(1);
    reopened.dispose();
  });

  it('keeps an uncertain adoption request unchanged while new source intent is blocked', async () => {
    const f = fixture(true);
    await f.controller.initialize();
    vi.mocked(f.client.applyImport).mockRejectedValueOnce(new Error('Transport outcome unknown'));
    const sourceText = '{"source":"original"}\n';
    const options = {
      bindings: [
        {
          sourceMaterialId: 'material',
          destinationMaterialId: 'bound-material',
          fingerprint: `sha256:${'b'.repeat(64)}` as const,
        },
      ],
    };
    await f.controller.adoptArchive(sourceText, options, `sha256:${'a'.repeat(64)}`);
    const original = structuredClone(f.saved()[0].request);
    options.bindings[0].destinationMaterialId = 'changed-after-submit';
    expect(
      await f.controller.adoptArchive(
        'different source',
        { bindings: [] },
        `sha256:${'c'.repeat(64)}`
      )
    ).toBeNull();
    expect(f.client.applyImport).toHaveBeenCalledOnce();
    await f.controller.retryPending();
    expect(f.client.applyImport).toHaveBeenNthCalledWith(1, original);
    expect(f.client.applyImport).toHaveBeenNthCalledWith(2, original);
    expect(f.client.execute).not.toHaveBeenCalled();
    expect(f.saved()).toEqual([]);
    expect(f.entries).toHaveLength(1);
    f.controller.dispose();
  });

  it('does not send an adoption when recovery storage cannot retain its exact intent', async () => {
    const f = fixture(true);
    await f.controller.initialize();
    vi.mocked(f.storage.write).mockImplementationOnce(() => {
      throw new Error('Quota unavailable');
    });
    await f.controller.adoptArchive(
      '{"source":"unretained"}',
      { bindings: [] },
      `sha256:${'a'.repeat(64)}`
    );
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'refused',
      code: 'INVENTORY_RECOVERY_UNAVAILABLE',
    });
    expect(f.client.applyImport).not.toHaveBeenCalled();
    expect(f.client.execute).not.toHaveBeenCalled();
    expect(f.state().revision).toBe(0);
    expect(f.saved()).toEqual([]);
    f.controller.dispose();
  });

  it('round trips adopted intent with exact source text and resolved bindings through recovery storage', () => {
    const values = new Map<string, string>();
    const storage = inventoryAttemptStorage({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    });
    const request: InventoryApplyImportRequest = {
      kind: 'adopt-archive',
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
      operationId: 'original-adoption',
      expectedRevision: 0,
      sourceText: '{"literal":" 00123 ","unknown":null}\r\n',
      options: {
        bindings: [
          {
            sourceMaterialId: 'material',
            destinationMaterialId: 'bound-material',
            fingerprint: `sha256:${'b'.repeat(64)}`,
          },
        ],
      },
      expectedPlanDigest: `sha256:${'a'.repeat(64)}`,
    };
    const attempt: InventoryAttempt = { summary: 'Adopt inventory archive', request };
    storage.write([attempt]);
    expect(storage.read()).toEqual([attempt]);
  });

  function tablePlan() {
    const sourceText =
      'source_id,name,material_key,quantity_kind,quantity,unit,quality,vessel_kind,vessel_key,location_key,slot\r\n0007,Table tube,sample,known,80,uL,usable,new,,bench,\r\n';
    const plan = inventoryTablePreview(null, {
      target: {
        projectId: project.projectId,
        inventoryId: project.defaultInventoryId,
        present: false,
        revision: 0,
      },
      sourceText,
      options: {
        namespace: 'source-register',
        delimiter: ',',
        materials: [{ key: 'sample', materialId: 'material' }],
        locations: [{ key: 'bench', target: { kind: 'unplaced' } }],
        vessels: [],
        skips: [],
      },
      bindings: [
        {
          key: 'sample',
          materialId: 'material',
          kind: 'admitted',
          fingerprint: `sha256:${'b'.repeat(64)}`,
        },
      ],
      asOf: 1,
      principal,
      authority: principal,
      maxBytes: 17 * 1024 * 1024,
    });
    if (plan.kind !== 'ready') throw new Error(JSON.stringify(plan.issues));
    return { sourceText, plan };
  }

  it('recovers one received table operation after lost acknowledgement and controller restart', async () => {
    const f = fixture(true);
    await f.controller.initialize();
    const { sourceText, plan } = tablePlan();
    vi.mocked(f.client.applyTable).mockImplementationOnce(async (request) => {
      f.commit(request);
      throw new Error('Lost table response');
    });
    await f.controller.receiveTable(sourceText, plan.options, plan.planDigest);
    expect(f.controller.getSnapshot().status.kind).toBe('outcome-unknown');
    expect(f.entries).toHaveLength(1);
    const original = structuredClone(f.saved()[0]);
    expect(original.request).toMatchObject({
      kind: 'receive-table',
      sourceText,
      options: plan.options,
    });
    f.controller.dispose();
    const reopened = new InventoryController(f.client, f.storage, () => {
      throw new Error('Recovery must not allocate a new operation');
    });
    await reopened.initialize();
    await reopened.checkPending();
    expect(reopened.getSnapshot().status.kind).toBe('ready');
    expect(f.saved()).toEqual([]);
    expect(f.entries).toHaveLength(1);
    expect(Object.values(f.state().stocks)).toMatchObject([
      { quantity: { kind: 'known', value: '80', unit: 'uL' } },
    ]);
    expect(Object.values(f.state().tableBindings)).toMatchObject([
      { namespace: 'source-register', sourceId: '0007' },
    ]);
    expect(f.client.applyTable).toHaveBeenCalledOnce();
    expect(f.client.execute).not.toHaveBeenCalled();
    expect(f.client.applyImport).not.toHaveBeenCalled();
    reopened.dispose();
  });

  it('retries retained table bytes and choices while blocking replacement intent', async () => {
    const f = fixture(true);
    await f.controller.initialize();
    const { sourceText, plan } = tablePlan();
    const options = {
      ...plan.options,
      materials: plan.options.materials.map((item) => ({ ...item })),
    };
    vi.mocked(f.client.applyTable).mockRejectedValueOnce(new Error('Unknown outcome'));
    await f.controller.receiveTable(sourceText, options, plan.planDigest);
    const original = structuredClone(f.saved()[0].request);
    options.materials[0].materialId = 'changed-after-submit';
    expect(await f.controller.receiveTable('replacement', options, plan.planDigest)).toBeNull();
    await f.controller.retryPending();
    expect(f.client.applyTable).toHaveBeenNthCalledWith(1, original);
    expect(f.client.applyTable).toHaveBeenNthCalledWith(2, original);
    expect(f.entries).toHaveLength(1);
    expect(f.saved()).toEqual([]);
    f.controller.dispose();
  });

  it('never sends table stock when exact recovery intent cannot be retained', async () => {
    const f = fixture(true);
    await f.controller.initialize();
    const { sourceText, plan } = tablePlan();
    vi.mocked(f.storage.write).mockImplementationOnce(() => {
      throw new Error('Quota unavailable');
    });
    await f.controller.receiveTable(sourceText, plan.options, plan.planDigest);
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'refused',
      code: 'INVENTORY_RECOVERY_UNAVAILABLE',
    });
    expect(f.client.applyTable).not.toHaveBeenCalled();
    expect(f.state().revision).toBe(0);
    f.controller.dispose();
  });
});

describe('stocktake recovery', () => {
  function stocktakePlan(state: InventoryState) {
    const sourceText =
      'observation_id,subject_key,observed_at,quantity_kind,quantity,unit,presence,location_key,slot,reason\n0001,sample,unknown,known,1,uL,not-observed,,,Measured remaining volume\n';
    const plan = inventoryStocktakePreview(state, {
      target: {
        projectId: project.projectId,
        inventoryId: project.defaultInventoryId,
        present: true,
        revision: state.revision,
      },
      sourceText,
      options: {
        namespace: 'stocktake-register',
        delimiter: ',',
        subjects: [{ key: 'sample', subject: { kind: 'stock', stockId: 'stock' } }],
        locations: [],
        decisions: [
          { observationId: '0001', choice: { kind: 'apply', reason: 'Apply measured quantity' } },
        ],
      },
      asOf: 1,
      principal,
      authority: principal,
      maxBytes: 17 * 1024 * 1024,
    });
    if (plan.kind !== 'ready') throw new Error(JSON.stringify(plan.issues));
    return { sourceText, plan };
  }
  it('recovers the original stocktake receipt after a lost response and controller restart', async () => {
    const f = fixture();
    await f.controller.initialize();
    const { sourceText, plan } = stocktakePlan(f.state());
    vi.mocked(f.client.applyStocktake).mockImplementationOnce(async (request) => {
      f.commit(request);
      throw new Error('Lost stocktake response');
    });
    await f.controller.applyStocktake(sourceText, plan.options, plan.planDigest);
    expect(f.controller.getSnapshot().status.kind).toBe('outcome-unknown');
    const original = structuredClone(f.saved()[0]);
    expect(original.request).toMatchObject({
      kind: 'apply-stocktake',
      sourceText,
      options: plan.options,
    });
    f.controller.dispose();
    const reopened = new InventoryController(f.client, f.storage, () => {
      throw new Error('Recovery cannot allocate another operation');
    });
    await reopened.initialize();
    await reopened.checkPending();
    expect(reopened.getSnapshot().status.kind).toBe('ready');
    expect(f.saved()).toEqual([]);
    expect(f.entries).toHaveLength(1);
    expect(f.state().stocks.stock.quantity).toEqual({ kind: 'known', value: '1', unit: 'uL' });
    expect(Object.values(f.state().observations)).toMatchObject([
      { namespace: 'stocktake-register', observationId: '0001', application: { kind: 'applied' } },
    ]);
    expect(f.client.applyStocktake).toHaveBeenCalledOnce();
    expect(f.client.execute).not.toHaveBeenCalled();
    expect(f.client.applyTable).not.toHaveBeenCalled();
    reopened.dispose();
  });
  it('retries exact retained stocktake bytes and choices without accepting replacement intent', async () => {
    const f = fixture();
    await f.controller.initialize();
    const { sourceText, plan } = stocktakePlan(f.state());
    const options = structuredClone(plan.options);
    vi.mocked(f.client.applyStocktake).mockRejectedValueOnce(new Error('Unknown outcome'));
    await f.controller.applyStocktake(sourceText, options, plan.planDigest);
    const original = structuredClone(f.saved()[0].request);
    (options as { namespace: string }).namespace = 'edited-after-submit';
    expect(await f.controller.applyStocktake('replacement', options, plan.planDigest)).toBeNull();
    await f.controller.retryPending();
    expect(f.client.applyStocktake).toHaveBeenNthCalledWith(1, original);
    expect(f.client.applyStocktake).toHaveBeenNthCalledWith(2, original);
    expect(f.entries).toHaveLength(1);
    expect(f.saved()).toEqual([]);
    f.controller.dispose();
  });
  it('does not send a stocktake whose recovery intent cannot be retained', async () => {
    const f = fixture();
    await f.controller.initialize();
    const { sourceText, plan } = stocktakePlan(f.state());
    vi.mocked(f.storage.write).mockImplementationOnce(() => {
      throw new Error('Quota unavailable');
    });
    await f.controller.applyStocktake(sourceText, plan.options, plan.planDigest);
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'refused',
      code: 'INVENTORY_RECOVERY_UNAVAILABLE',
    });
    expect(f.client.applyStocktake).not.toHaveBeenCalled();
    expect(f.state().observations).toEqual({});
    f.controller.dispose();
  });
});

describe('source revision recovery', () => {
  function sourcePlan(f: ReturnType<typeof fixture>) {
    const columns =
      'source_id,name,material_key,quantity_kind,quantity,unit,quality,vessel_kind,vessel_key,location_key,slot';
    const fields: InventoryReceiveTableFields = {
      source_id: '0007',
      name: 'External tube',
      material_key: 'sample',
      quantity_kind: 'known',
      quantity: '80',
      unit: 'uL',
      quality: 'usable',
      vessel_kind: 'new',
      vessel_key: '',
      location_key: 'bench',
      slot: '',
    };
    const tableText = columns + '\n0007,External tube,sample,known,80,uL,usable,new,,bench,\n';
    const table = {
      namespace: 'source-register',
      delimiter: ',' as const,
      materials: [{ key: 'sample', materialId: 'material' }],
      locations: [{ key: 'bench', target: { kind: 'unplaced' as const } }],
      vessels: [],
      skips: [],
    };
    const tableTarget = {
      projectId: project.projectId,
      inventoryId: project.defaultInventoryId,
      present: true,
      revision: f.state().revision,
    };
    const receive = inventoryTablePreview(f.state(), {
      target: tableTarget,
      sourceText: tableText,
      options: table,
      bindings: [
        { ...table.materials[0], kind: 'admitted', fingerprint: `sha256:${'a'.repeat(64)}` },
      ],
      asOf: 1,
      principal,
      authority: principal,
      maxBytes: 17 * 1024 * 1024,
    });
    if (receive.kind !== 'ready') throw new Error('Expected source receiving plan.');
    f.commit({
      kind: 'receive-table',
      project: project.projectId,
      inventoryId: project.defaultInventoryId,
      operationId: 'source-receive',
      expectedRevision: tableTarget.revision,
      sourceText: tableText,
      options: receive.options,
      expectedPlanDigest: receive.planDigest,
    });
    const binding = Object.values(f.state().tableBindings)[0];
    const sourceText = tableText
      .replace('External tube', 'Revised external label')
      .replace(',80,uL,usable,', ',90,uL,quarantined,')
      .replaceAll('\n', '\r\n');
    const plan = inventorySourceRevisionPreview(f.state(), {
      target: { ...tableTarget, revision: f.state().revision },
      sourceText,
      options: {
        table,
        acknowledgements: [
          {
            sourceId: '0007',
            expectedPreviousRowSha256: binding.rowSha256,
            reason: 'Accept revised external register without changing stock',
          },
        ],
      },
      preimages: [{ sourceId: '0007', fields }],
      asOf: 1,
      principal,
      authority: principal,
      maxBytes: 17 * 1024 * 1024,
    });
    if (plan.kind !== 'ready') throw new Error('Expected source revision plan.');
    return { sourceText, plan, binding };
  }

  it('recovers the original acknowledgement receipt without repeating or changing physical stock', async () => {
    const f = fixture();
    const { sourceText, plan, binding } = sourcePlan(f);
    const before = structuredClone(f.state());
    await f.controller.initialize();
    vi.mocked(f.client.acknowledgeSource).mockImplementationOnce(async (request) => {
      f.commit(request);
      throw new Error('Lost acknowledgement response');
    });
    await f.controller.acknowledgeSourceRevision(sourceText, plan.options, plan.planDigest);
    expect(f.controller.getSnapshot().status.kind).toBe('outcome-unknown');
    expect(f.saved()[0].request).toMatchObject({
      kind: 'acknowledge-table-source',
      sourceText,
      options: plan.options,
    });
    const original = structuredClone(f.saved()[0].request);
    f.controller.dispose();
    const reopened = new InventoryController(
      f.client,
      f.storage,
      () => 'must-not-replace-original'
    );
    await reopened.initialize();
    await reopened.checkPending();
    expect(reopened.getSnapshot().status.kind).toBe('ready');
    expect(f.saved()).toEqual([]);
    expect(f.state().stocks).toEqual(before.stocks);
    expect(f.state().vessels).toEqual(before.vessels);
    expect(f.state().reservations).toEqual(before.reservations);
    expect(f.state().observations).toEqual(before.observations);
    expect(
      f.state().tableBindings[Object.keys(before.tableBindings)[0]].sourceRevisions
    ).toHaveLength(1);
    expect(f.state().stocks[binding.stockId].quantity).toEqual({
      kind: 'known',
      value: '80',
      unit: 'uL',
    });
    expect(f.client.acknowledgeSource).toHaveBeenCalledOnce();
    expect(f.client.acknowledgeSource).toHaveBeenCalledWith(original);
    expect(f.client.applyStocktake).not.toHaveBeenCalled();
    reopened.dispose();
  });

  it('retries the same retained source, preimage and expected baseline instead of replacement intent', async () => {
    const f = fixture();
    const { sourceText, plan } = sourcePlan(f);
    await f.controller.initialize();
    const options = structuredClone(plan.options);
    vi.mocked(f.client.acknowledgeSource).mockRejectedValueOnce(new Error('Unknown outcome'));
    await f.controller.acknowledgeSourceRevision(sourceText, options, plan.planDigest);
    const original = structuredClone(f.saved()[0].request);
    (options as { table: { namespace: string } }).table.namespace = 'edited-after-submit';
    expect(
      await f.controller.acknowledgeSourceRevision('replacement', options, plan.planDigest)
    ).toBeNull();
    await f.controller.retryPending();
    expect(f.client.acknowledgeSource).toHaveBeenNthCalledWith(1, original);
    expect(f.client.acknowledgeSource).toHaveBeenNthCalledWith(2, original);
    expect(f.saved()).toEqual([]);
    expect(
      f.entries.filter(
        (entry) => 'kind' in entry.request && entry.request.kind === 'acknowledge-table-source'
      )
    ).toHaveLength(1);
    f.controller.dispose();
  });

  it('does not acknowledge a source revision when its retry intent cannot be saved', async () => {
    const f = fixture();
    const { sourceText, plan } = sourcePlan(f);
    await f.controller.initialize();
    vi.mocked(f.storage.write).mockImplementationOnce(() => {
      throw new Error('Quota unavailable');
    });
    await f.controller.acknowledgeSourceRevision(sourceText, plan.options, plan.planDigest);
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'refused',
      code: 'INVENTORY_RECOVERY_UNAVAILABLE',
    });
    expect(f.client.acknowledgeSource).not.toHaveBeenCalled();
    expect(Object.values(f.state().tableBindings)[0].sourceRevisions).toEqual([]);
    f.controller.dispose();
  });
});

describe('hierarchy import recovery', () => {
  function hierarchyPlan(f: ReturnType<typeof fixture>) {
    const sourceText =
      'source_id,name,layout_kind,positions,rows,columns,capacity,parent_kind,parent_key,slot\r\nplate,Imported plate,fixed-well,,2,3,,root,,\r\n';
    const state = f.state();
    const plan = inventoryHierarchyPreview(state, {
      target: {
        projectId: project.projectId,
        inventoryId: project.defaultInventoryId,
        present: true,
        revision: state.revision,
      },
      sourceText,
      options: { namespace: 'source-hierarchy', delimiter: ',', parents: [], skips: [] },
      asOf: 1,
      principal,
      authority: principal,
      maxBytes: 17 * 1024 * 1024,
    });
    if (plan.kind !== 'ready') throw new Error('Expected hierarchy plan.');
    return { sourceText, plan };
  }

  it('recovers the original hierarchy receipt without recreating locations or wells', async () => {
    const f = fixture();
    const { sourceText, plan } = hierarchyPlan(f);
    await f.controller.initialize();
    vi.mocked(f.client.applyHierarchy).mockImplementationOnce(async (request) => {
      f.commit(request);
      throw new Error('Lost hierarchy response');
    });
    await f.controller.importHierarchy(sourceText, plan.options, plan.planDigest);
    expect(f.controller.getSnapshot().status.kind).toBe('outcome-unknown');
    const original = structuredClone(f.saved()[0].request);
    expect(original).toMatchObject({
      kind: 'import-hierarchy',
      sourceText,
      options: plan.options,
      expectedPlanDigest: plan.planDigest,
    });
    f.controller.dispose();
    const reopened = new InventoryController(
      f.client,
      f.storage,
      () => 'must-not-replace-original'
    );
    await reopened.initialize();
    await reopened.checkPending();
    expect(reopened.getSnapshot().status.kind).toBe('ready');
    expect(f.saved()).toEqual([]);
    expect(f.client.applyHierarchy).toHaveBeenCalledOnce();
    expect(f.client.applyHierarchy).toHaveBeenCalledWith(original);
    expect(Object.values(f.state().hierarchyBindings)).toHaveLength(1);
    expect(Object.values(f.state().vessels).filter((v) => v.kind === 'fixed-well')).toHaveLength(6);
    expect(f.client.acknowledgeSource).not.toHaveBeenCalled();
    reopened.dispose();
  });

  it('retries the same hierarchy bytes and parent decisions instead of edited intent', async () => {
    const f = fixture();
    const { sourceText, plan } = hierarchyPlan(f);
    await f.controller.initialize();
    const options = structuredClone(plan.options);
    vi.mocked(f.client.applyHierarchy).mockRejectedValueOnce(new Error('Unknown outcome'));
    await f.controller.importHierarchy(sourceText, options, plan.planDigest);
    const original = structuredClone(f.saved()[0].request);
    (options as { namespace: string }).namespace = 'edited-after-submit';
    expect(await f.controller.importHierarchy('replacement', options, plan.planDigest)).toBeNull();
    await f.controller.retryPending();
    expect(f.client.applyHierarchy).toHaveBeenNthCalledWith(1, original);
    expect(f.client.applyHierarchy).toHaveBeenNthCalledWith(2, original);
    expect(f.saved()).toEqual([]);
    expect(
      f.entries.filter((e) => 'kind' in e.request && e.request.kind === 'import-hierarchy')
    ).toHaveLength(1);
    f.controller.dispose();
  });

  it('does not import a hierarchy when original retry intent cannot be stored', async () => {
    const f = fixture();
    const { sourceText, plan } = hierarchyPlan(f);
    await f.controller.initialize();
    vi.mocked(f.storage.write).mockImplementationOnce(() => {
      throw new Error('Quota unavailable');
    });
    await f.controller.importHierarchy(sourceText, plan.options, plan.planDigest);
    expect(f.controller.getSnapshot().status).toMatchObject({
      kind: 'refused',
      code: 'INVENTORY_RECOVERY_UNAVAILABLE',
    });
    expect(f.client.applyHierarchy).not.toHaveBeenCalled();
    expect(Object.values(f.state().hierarchyBindings)).toEqual([]);
    f.controller.dispose();
  });
});
