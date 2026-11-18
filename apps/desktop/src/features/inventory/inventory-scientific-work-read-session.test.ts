import { expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryProtocolRunSourceSha256,
  inventoryScientificTransferPreviewV2,
  inventoryWellId,
  type InventoryScientificWork,
  type InventoryProtocolRunSavedSource,
} from '@waypoint/domain-services';
import { unavailableInventoryClient, type InventoryChanged } from '../../shared/inventory-client';
import {
  inventoryScientificWorksForContextRequestSchema,
  type InventoryScientificWorksForContextRead,
} from '../../shared/inventory-scientific-read';
import { InventoryScientificWorkReadSession } from './inventory-scientific-work-read-session';

const resource = { projectId: 'project', workspaceScope: 'project', entityId: 'project::run' };
const context = { kind: 'protocol-run' as const, entityId: resource.entityId };
const principal = { kind: 'local-profile' as const, profileKey: 'profile' };
const source: InventoryProtocolRunSavedSource = {
  schema: 'dnaforge.protocol-run-saved-source.v1',
  projectId: resource.projectId,
  workspaceScope: resource.workspaceScope,
  runId: resource.entityId,
  fileObjectUuid: 'run-file',
  title: 'Saved Run',
  originalText: JSON.stringify({
    schema: 'dnaforge.protocol-run.v1',
    kind: 'protocol_run',
    id: 'run',
    title: 'Saved Run',
    status: 'in_progress',
    immutable: false,
    protocol: {
      sourceId: 'protocol',
      destinationId: 'project::protocol',
      name: 'Protocol',
      pinnedVersionId: 'source-v1',
      pinnedVersionHash: `sha256:${'a'.repeat(64)}`,
    },
    inputs: [],
    outputs: [],
    measurements: [],
    tables: [],
    links: [],
    startedAt: null,
    completedAt: null,
    amendments: [],
    provenance: { provider: 'dnaforge', immutableSource: false },
  }),
};
function work(index = 0): InventoryScientificWork {
  const initial = applyInventoryCommandBatch(
    createInventoryState(),
    {
      expectedRevision: 0,
      commands: [
        {
          kind: 'create-layout-storage',
          id: 'plate',
          name: 'Plate',
          layout: { kind: 'fixed-well', rows: 1, columns: 1 },
          placement: { kind: 'root' },
        },
        { kind: 'create-vessel', id: 'vial', name: 'Source vial', placement: { kind: 'unplaced' } },
        {
          kind: 'receive-stock',
          id: 'stock',
          vesselId: 'vial',
          materialId: 'dna',
          quantity: { kind: 'known', value: '100', unit: 'uL' },
          quality: 'usable',
        },
      ],
    },
    { at: 100, principal, authority: principal }
  );
  if (!initial.ok) throw Error(initial.message);
  const preview = inventoryScientificTransferPreviewV2(initial.state, {
    target: {
      projectId: 'project',
      inventoryId: 'actual-default',
      present: true,
      revision: initial.state.revision,
    },
    identity: { namespace: 'manual', workId: `once-${index}` },
    context: { ...context, sourceSha256: inventoryProtocolRunSourceSha256(source) },
    sourceStockId: 'stock',
    destinationVesselId: inventoryWellId('plate', 'A1'),
    quantity: { value: '10', unit: 'uL' },
    reason: 'Operator observed completed manual work',
    source,
    asOf: 110,
    principal,
    authority: principal,
  });
  if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
  return preview.work;
}
function ready(
  works: readonly InventoryScientificWork[] = [],
  revision = 7
): Extract<InventoryScientificWorksForContextRead, { kind: 'ready' }> {
  return {
    kind: 'ready',
    projectId: 'project',
    inventoryId: 'actual-default',
    context,
    revision,
    works,
    nextCursor: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function harness() {
  const native = unavailableInventoryClient();
  native.projects = vi.fn(async () => [
    {
      projectId: 'other',
      name: 'Other',
      path: '/other',
      pinned: false,
      defaultInventoryId: 'wrong',
    },
    {
      projectId: 'project',
      name: 'Project',
      path: '/project',
      pinned: false,
      defaultInventoryId: 'actual-default',
    },
  ]);
  native.scientificWorksForContext = vi.fn(async (request) => {
    inventoryScientificWorksForContextRequestSchema.parse(request);
    return ready();
  });
  let listener: (event: InventoryChanged) => void = () => {};
  native.onChanged = vi.fn((next) => {
    listener = next;
    return () => {
      listener = () => {};
    };
  });
  const navigate = vi.fn(async (_reference: unknown, _options: { signal: AbortSignal }) => {});
  const session = new InventoryScientificWorkReadSession(native, resource, navigate);
  return {
    native,
    navigate,
    session,
    event: (revision: number, projectId = 'project', inventoryId = 'actual-default') =>
      listener({ projectId, inventoryId, revision, operationId: 'operation' }),
  };
}
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

it('uses the owning project default inventory and separates loading, successful empty, absent and unavailable reads', async () => {
  const { native, session } = harness(),
    pending = deferred<InventoryScientificWorksForContextRead>();
  native.scientificWorksForContext = vi.fn(() => pending.promise);
  const opening = session.open();
  await tick();
  expect(session.getSnapshot().status.kind).toBe('loading');
  expect(native.scientificWorksForContext).toHaveBeenCalledWith({
    project: 'project',
    inventoryId: 'actual-default',
    context,
    limit: 20,
  });
  pending.resolve(ready());
  await opening;
  expect(session.getSnapshot().status).toMatchObject({ kind: 'ready', read: { works: [] } });
  native.scientificWorksForContext = vi.fn(async () => ({
    kind: 'inventory-absent' as const,
    projectId: 'project',
    inventoryId: 'actual-default',
    context,
  }));
  await session.refresh();
  expect(session.getSnapshot().status.kind).toBe('inventory-absent');
  native.scientificWorksForContext = vi.fn(async () => {
    throw Error('Unavailable query');
  });
  await session.refresh();
  expect(session.getSnapshot().status).toEqual({
    kind: 'unavailable',
    message: 'Unavailable query',
  });
  session.dispose();
});

it('discards disposed Run responses and refuses malformed or foreign scope instead of displaying empty success', async () => {
  const { native, session } = harness(),
    pending = deferred<InventoryScientificWorksForContextRead>();
  native.scientificWorksForContext = vi.fn(() => pending.promise);
  const old = session.open();
  await tick();
  session.dispose();
  const next = new InventoryScientificWorkReadSession(
    native,
    { ...resource, entityId: 'project::run-b' },
    vi.fn()
  );
  native.scientificWorksForContext = vi.fn(async () => ({
    ...ready(),
    context: { ...context, entityId: 'project::run-b' },
  }));
  await next.open();
  pending.resolve(ready([work()]));
  await old;
  expect(next.getSnapshot().status).toMatchObject({
    kind: 'ready',
    read: { works: [], context: { entityId: 'project::run-b' } },
  });
  native.scientificWorksForContext = vi.fn(async () => ready());
  await next.refresh();
  expect(next.getSnapshot().status.kind).toBe('unavailable');
  native.scientificWorksForContext = vi.fn(
    async () => ({ kind: 'ready' }) as InventoryScientificWorksForContextRead
  );
  await next.refresh();
  expect(next.getSnapshot().status.kind).toBe('unavailable');
  next.dispose();
});

it('fences a matching event during loading, coalesces bursts and ignores unrelated inventory events', async () => {
  const { native, session, event } = harness(),
    first = deferred<InventoryScientificWorksForContextRead>(),
    second = deferred<InventoryScientificWorksForContextRead>();
  native.scientificWorksForContext = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const opening = session.open();
  await tick();
  event(8, 'other');
  event(8, 'project', 'other-inventory');
  await tick();
  expect(native.scientificWorksForContext).toHaveBeenCalledTimes(1);
  event(8);
  event(9);
  await tick();
  expect(native.scientificWorksForContext).toHaveBeenCalledTimes(2);
  first.resolve(ready([work()], 7));
  await opening;
  expect(session.getSnapshot().status.kind).toBe('loading');
  second.resolve(ready([], 9));
  await tick();
  expect(session.getSnapshot().status).toMatchObject({
    kind: 'ready',
    read: { revision: 9, works: [] },
  });
  event(9);
  await tick();
  expect(native.scientificWorksForContext).toHaveBeenCalledTimes(2);
  session.dispose();
});

it('replaces bounded pages with the native cursor and restarts at page one on revision conflict', async () => {
  const { native, session } = harness(),
    saved = work();
  const rows = Array.from({ length: 20 }, (_, index) => work(index)).sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
  const cursor = {
    querySha256: `sha256:${'a'.repeat(64)}` as const,
    revision: 7,
    after: { at: rows[19]!.at, workId: rows[19]!.id },
  };
  native.scientificWorksForContext = vi
    .fn()
    .mockResolvedValueOnce({ ...ready(rows), nextCursor: cursor })
    .mockResolvedValueOnce(ready([{ ...saved, at: 200 }]))
    .mockResolvedValueOnce({ ...ready(rows), nextCursor: cursor })
    .mockResolvedValueOnce({
      kind: 'unavailable',
      code: 'INVENTORY_QUERY_REVISION_CHANGED',
      message: 'Changed',
      retryable: true,
    })
    .mockResolvedValueOnce(ready([], 8));
  await session.open();
  await session.next();
  expect(native.scientificWorksForContext).toHaveBeenNthCalledWith(2, {
    project: 'project',
    inventoryId: 'actual-default',
    context,
    limit: 20,
    cursor,
  });
  expect(session.getSnapshot().status).toMatchObject({
    kind: 'ready',
    read: { works: [{ at: 200 }] },
  });
  await session.refresh();
  await session.next();
  expect(native.scientificWorksForContext).toHaveBeenNthCalledWith(5, {
    project: 'project',
    inventoryId: 'actual-default',
    context,
    limit: 20,
  });
  expect(session.getSnapshot().status).toMatchObject({
    kind: 'ready',
    read: { revision: 8, works: [] },
    cursor: null,
  });
  session.dispose();
});

it('fences saved-source replies, checks the exact pin and aborts stale current-Run navigation without hiding history', async () => {
  const { native, session, navigate } = harness(),
    saved = work(),
    pending = deferred<Awaited<ReturnType<typeof native.scientificSource>>>();
  native.scientificWorksForContext = vi.fn(async () => ready([saved]));
  await session.open();
  native.scientificSource = vi.fn(() => pending.promise);
  const reading = session.viewSavedContext(saved.id);
  await session.refresh();
  pending.resolve({
    kind: 'available' as const,
    workId: saved.id,
    sourceSha256: saved.context.source.sha256,
    source,
  });
  await reading;
  expect(session.getSnapshot().source.kind).toBe('idle');
  native.scientificSource = vi.fn(async () => ({
    kind: 'available' as const,
    workId: saved.id,
    sourceSha256: `sha256:${'f'.repeat(64)}` as const,
    source,
  }));
  await session.viewSavedContext(saved.id);
  expect(session.getSnapshot().source.kind).toBe('unavailable');
  native.scientificSource = vi.fn(async () => ({
    kind: 'available' as const,
    workId: saved.id,
    sourceSha256: saved.context.source.sha256,
    source,
  }));
  await session.viewSavedContext(saved.id);
  expect(session.getSnapshot().source.kind).toBe('available');
  navigate.mockRejectedValueOnce(Error('Current Run unavailable'));
  await session.openCurrent(saved.id);
  expect(session.getSnapshot()).toMatchObject({
    status: { kind: 'ready', read: { works: [saved] } },
    source: { kind: 'available' },
    navigationError: 'Current Run unavailable',
  });
  const navigation = deferred<void>();
  navigate.mockReturnValueOnce(navigation.promise);
  const opening = session.openCurrent(saved.id),
    signal = navigate.mock.calls[1]![1].signal;
  await session.refresh();
  expect(signal.aborted).toBe(true);
  navigation.resolve();
  await opening;
  expect(session.getSnapshot().navigationError).toBeNull();
  session.dispose();
});
