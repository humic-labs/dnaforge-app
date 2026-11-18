import { expect, it, vi } from 'vitest';
import {
  unavailableInventoryClient,
  type InventoryScientificTransferV2PreviewSnapshot,
} from '../../shared/inventory-client';
import {
  InventoryScientificSession,
  type InventoryScientificDraft,
} from './inventory-scientific-session';
const scope = { project: 'project', inventoryId: 'inventory' };
const principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
const draft = (): InventoryScientificDraft => ({
  namespace: 'manual-observations',
  workId: 'observed-once',
  contextKind: 'notebook-page',
  entityId: 'project::page',
  expectedSourceSha256: `sha256:${'b'.repeat(64)}`,
  sourceStockId: 'source',
  destinationVesselId: 'well:plate#A1',
  quantity: '10',
  unit: 'uL',
  reason: 'Operator observed this completed transfer',
});
const response = (): InventoryScientificTransferV2PreviewSnapshot => ({
  schema: 'dnaforge.inventory-scientific-transfer-preview.v2',
  target: { projectId: 'project', inventoryId: 'inventory', revision: 7, present: true },
  projectId: 'project',
  inventoryId: 'inventory',
  revision: 7,
  asOf: 100,
  principal,
  workId: null,
  intentSha256: null,
  sourceSha256: null,
  kind: 'blocked',
  issues: [
    {
      code: 'CONTEXT_REQUIRED',
      pointer: '',
      message: 'Native admission refused this fixture',
    },
  ],
  work: null,
  commands: [],
  planDigest: null,
});
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
it('retains stable observation identity and sends exact saved page source and choices only for a native preview', async () => {
  const native = unavailableInventoryClient(),
    saved = storage();
  native.previewScientificTransferV2 = vi.fn(async () => response());
  const session = new InventoryScientificSession(native, scope, saved);
  session.edit(draft());
  await session.preview(7);
  expect(native.previewScientificTransferV2).toHaveBeenCalledExactlyOnceWith({
    ...scope,
    expectedRevision: 7,
    choices: {
      identity: { namespace: 'manual-observations', workId: 'observed-once' },
      context: {
        kind: 'notebook-page',
        entityId: 'project::page',
        sourceSha256: `sha256:${'b'.repeat(64)}`,
      },
      sourceStockId: 'source',
      destinationVesselId: 'well:plate#A1',
      quantity: { value: '10', unit: 'uL' },
      reason: 'Operator observed this completed transfer',
    },
  });
  const reopened = new InventoryScientificSession(native, scope, saved);
  expect(reopened.getSnapshot()).toEqual({ phase: 'editing', draft: draft() });
  expect(session.getSnapshot()).toMatchObject({ phase: 'previewed', preview: { kind: 'blocked' } });
});
it('discards late preview after an input edit and refuses a foreign scoped native result', async () => {
  const native = unavailableInventoryClient();
  let resolve!: (value: InventoryScientificTransferV2PreviewSnapshot) => void;
  native.previewScientificTransferV2 = vi.fn(
    () =>
      new Promise<InventoryScientificTransferV2PreviewSnapshot>((accept) => {
        resolve = accept;
      })
  );
  const session = new InventoryScientificSession(native, scope, storage());
  session.edit(draft());
  const waiting = session.preview(7);
  session.edit({ ...draft(), quantity: '11' });
  resolve(response());
  await waiting;
  expect(session.getSnapshot()).toMatchObject({ phase: 'editing', draft: { quantity: '11' } });
  native.previewScientificTransferV2 = vi.fn(async () => ({
    ...response(),
    target: { ...response().target, projectId: 'foreign' },
  }));
  await session.preview(7);
  expect(session.getSnapshot()).toMatchObject({
    phase: 'failed',
    message: expect.stringMatching(/another project/),
  });
});
it('never previews without persisted recovery and starts a separately identified observation deliberately', async () => {
  const native = unavailableInventoryClient();
  native.previewScientificTransferV2 = vi.fn(async () => response());
  const session = new InventoryScientificSession(native, scope, {
    getItem: () => null,
    setItem: () => {
      throw Error('quota');
    },
  });
  session.edit(draft());
  await session.preview(7);
  expect(native.previewScientificTransferV2).not.toHaveBeenCalled();
  expect(session.getSnapshot().phase).toBe('failed');
  const next = new InventoryScientificSession(native, scope, storage());
  next.edit(draft());
  next.newObservation();
  expect(next.getSnapshot().draft.workId).not.toBe('observed-once');
  expect(next.getSnapshot().draft.entityId).toBe('');
});
