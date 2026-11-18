import { expect, it, vi } from 'vitest';
import { inventoryRunValueRowSha256 } from '@waypoint/domain-services';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import { InventoryRunValueAttributionReadSession } from './inventory-run-value-attribution-read-session';
import type { NativeProtocolPackageChanged } from '../../shared/protocol-packages';
const scope = { project: 'project', inventoryId: 'inventory' };
const sha = (letter: string) => `sha256:${letter.repeat(64)}`;
function candidates(value: number, source: string) {
  const row = { key: 'result', label: 'Result', value: { type: 'number', value } };
  return {
    kind: 'ready',
    projectId: scope.project,
    inventoryId: scope.inventoryId,
    revision: 99,
    asOf: 1,
    run: {
      entityId: 'project::run',
      projectId: 'project',
      workspaceScope: 'project',
      fileObjectUuid: 'file',
      title: 'Run',
      sourceSha256: sha(source),
    },
    filter: { collection: null },
    rows: [
      {
        ordinal: 0,
        collection: 'outputs',
        key: 'result',
        rowSha256: inventoryRunValueRowSha256('outputs', row),
        row,
        origin: { kind: 'local-actual' },
        eligibility: { kind: 'eligible', valueKind: 'number' },
      },
    ],
    nextCursor: null,
  };
}
it('fences late saved-value replies when a Run changes without an inventory revision', async () => {
  const native = unavailableInventoryClient();
  native.runValueAttributions = vi.fn().mockResolvedValue({
    kind: 'ready',
    projectId: 'project',
    inventoryId: 'inventory',
    revision: 99,
    filters: { run: { entityId: 'project::run' }, slot: null },
    entries: [],
    nextCursor: null,
  });
  let change: ((event: NativeProtocolPackageChanged) => void) | undefined;
  let resolveOld!: (value: unknown) => void;
  native.runValueCandidates = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    )
    .mockResolvedValue(candidates(1, 'b'));
  const session = new InventoryRunValueAttributionReadSession(
    scope,
    'project::run',
    native,
    {
      onChanged: (callback) => {
        change = callback;
        return () => {};
      },
    },
    vi.fn()
  );
  const opening = session.open();
  await vi.waitFor(() => expect(native.runValueCandidates).toHaveBeenCalledTimes(1));
  change!({ projectId: 'project', entityId: 'project::run' } as NativeProtocolPackageChanged);
  await vi.waitFor(() =>
    expect(session.getSnapshot().candidates).toMatchObject({
      kind: 'ready',
      rows: [{ row: { value: { value: 1 } } }],
    })
  );
  resolveOld(candidates(0, 'a'));
  await opening;
  expect(session.getSnapshot().candidates).toMatchObject({
    kind: 'ready',
    revision: 99,
    rows: [{ row: { value: { value: 1 } } }],
  });
  session.dispose();
});
it('detaches an in-flight source read instead of publishing it in another view', async () => {
  const native = unavailableInventoryClient();
  let resolve!: (value: unknown) => void;
  native.runValueCandidates = vi.fn().mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const session = new InventoryRunValueAttributionReadSession(
    scope,
    'project::run',
    native,
    { onChanged: () => () => {} },
    vi.fn()
  );
  const reading = session.refreshCandidates();
  session.dispose();
  resolve(candidates(0, 'a'));
  await reading;
  expect(session.getSnapshot().candidates.kind).toBe('loading');
});
it('restarts a stale native history cursor at the first page and preserves invalid cursor errors', async () => {
  const native = unavailableInventoryClient();
  const first = {
    kind: 'ready',
    projectId: 'project',
    inventoryId: 'inventory',
    revision: 99,
    filters: { run: { entityId: 'project::run' }, slot: null },
    entries: [],
    nextCursor: {
      querySha256: sha('a'),
      revision: 99,
      after: { at: 1, attributionId: `run-value-attribution:${'b'.repeat(64)}` },
    },
  };
  native.runValueAttributions = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce({
      kind: 'unavailable',
      code: 'INVENTORY_QUERY_STALE',
      message: 'Inventory changed. Read the first page again.',
      retryable: true,
    })
    .mockResolvedValueOnce({ ...first, revision: 100 })
    .mockResolvedValueOnce({
      kind: 'unavailable',
      code: 'INVENTORY_QUERY_CURSOR_INVALID',
      message: 'Invalid cursor',
      retryable: false,
    });
  const session = new InventoryRunValueAttributionReadSession(
    scope,
    'project::run',
    native,
    { onChanged: () => () => {} },
    vi.fn()
  );
  await session.refresh();
  await session.next();
  expect(native.runValueAttributions).toHaveBeenNthCalledWith(2, {
    ...scope,
    run: { entityId: 'project::run' },
    limit: 20,
    cursor: first.nextCursor,
  });
  expect(native.runValueAttributions).toHaveBeenNthCalledWith(3, {
    ...scope,
    run: { entityId: 'project::run' },
    limit: 20,
  });
  expect(session.getSnapshot().list).toMatchObject({ kind: 'ready', revision: 100 });
  await session.next();
  expect(native.runValueAttributions).toHaveBeenCalledTimes(4);
  expect(session.getSnapshot().list).toMatchObject({
    kind: 'unavailable',
    code: 'INVENTORY_QUERY_CURSOR_INVALID',
  });
  session.dispose();
});
