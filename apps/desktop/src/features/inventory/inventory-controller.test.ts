import { describe, expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  type InventoryCommand,
  type InventoryState,
} from '@waypoint/domain-services';
import type {
  InventoryChanged,
  InventoryAvailabilitySnapshot,
  InventoryClient,
  InventoryProject,
} from '../../shared/inventory-client';
import type {
  InventoryExecuteRequest,
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

function fixture() {
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
  let state = initial.state;
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
  const commit = (request: InventoryExecuteRequest): NativeInventoryReceipt => {
    const previous = entries.find((entry) => entry.receipt.operationId === request.operationId);
    if (previous) return previous.receipt;
    const result = applyInventoryCommandBatch(state, {
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
});
