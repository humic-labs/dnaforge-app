import { afterEach, expect, it, vi } from 'vitest';
import {
  inventoryPlatePlanDefinitionSha256,
  inventoryPlatePlanVersionId,
  inventoryTableSha256,
  type InventoryPlatePlanVersion,
} from '@waypoint/domain-services';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import {
  inventoryPlatePlanVersionPreviewSnapshotSchema,
  inventoryPlatePlanVersionReadSchema,
  inventoryPlatePlanBindingPreviewSnapshotSchema,
} from '../../shared/inventory-plate-plans';
import {
  InventoryPendingCoordinator,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
import {
  InventoryPlatePlanDraftSession,
  platePlanDraftChoices,
} from './inventory-plate-plan-draft-session';
import { InventoryPlatePlanReadSession } from './inventory-plate-plan-read-session';
const scope = { project: 'project', inventoryId: 'inventory' };
const principal = { kind: 'local-profile' as const, profileKey: 'synthetic' };
function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
function pending() {
  let attempts: readonly InventoryAttempt[] = [];
  return new InventoryPendingCoordinator({
    read: () => attempts,
    write: (next) => {
      attempts = next;
    },
  });
}
function version(rows = 8): InventoryPlatePlanVersion {
  const definition = {
      schema: 'dnaforge.inventory-plate-plan-definition.v1' as const,
      title: 'Plan',
      layout: { kind: 'fixed-well' as const, rows, columns: 12 },
      sourceSlots: [{ key: 'template', label: 'Template' }],
      transfers: [
        {
          actionId: 'step',
          sourceSlotKey: 'template',
          destinationPosition: 'A3',
          quantity: { value: '4', unit: 'uL' as const },
          label: 'Add template',
        },
      ],
    },
    identity = { namespace: 'plans', planId: 'family' },
    definitionSha256 = inventoryPlatePlanDefinitionSha256(definition);
  return {
    identity,
    definition,
    definitionSha256,
    id: inventoryPlatePlanVersionId(identity, definitionSha256),
    at: 1,
    by: principal,
    reason: 'Original',
  };
}
function list(identity: unknown = null) {
  return {
    kind: 'ready' as const,
    projectId: scope.project,
    inventoryId: scope.inventoryId,
    revision: 96,
    identity,
    versions: [],
    nextCursor: null,
  };
}
afterEach(() => vi.useRealTimers());
it('persists the definition before preview and retries the exact prepared save after an unknown acknowledgement', async () => {
  const client = unavailableInventoryClient(),
    owner = pending(),
    v = version();
  client.platePlanVersions = vi.fn(async (request) => list(request.identity) as never);
  client.previewPlatePlanVersion = vi.fn(async () =>
    inventoryPlatePlanVersionPreviewSnapshotSchema.parse({
      kind: 'ready',
      schema: 'dnaforge.inventory-plate-plan-version-preview.v1',
      target: {
        projectId: scope.project,
        inventoryId: scope.inventoryId,
        present: true,
        revision: 96,
      },
      versionId: v.id,
      definitionSha256: v.definitionSha256,
      version: v,
      planDigest: `sha256:${'a'.repeat(64)}`,
      ...{
        projectId: scope.project,
        inventoryId: scope.inventoryId,
        revision: 96,
        asOf: 1,
        principal,
      },
    })
  );
  client.applyPlatePlanVersion = vi.fn(async () => {
    throw Error('Lost acknowledgement');
  });
  const storage = memory();
  const session = new InventoryPlatePlanDraftSession(
    scope,
    client,
    owner,
    storage,
    () => 'one-operation'
  );
  session.editVersion(v);
  const draft = session.getSnapshot().draft;
  session.edit({
    ...draft,
    reason: 'Save',
    transfers: draft.transfers.map((row) => ({ ...row, volume: '4.00' })),
  });
  expect(
    platePlanDraftChoices(session.getSnapshot().draft).definition.transfers[0]!.quantity.value
  ).toBe('4');
  await session.preview();
  const prepared = session.getSnapshot().save;
  expect(prepared.kind).toBe('previewed');
  if (prepared.kind !== 'previewed') throw Error('Preview absent');
  const reopened = new InventoryPlatePlanDraftSession(scope, client, owner, storage, () => {
    throw Error('Must reuse the prepared operation');
  });
  await reopened.preview();
  const restored = reopened.getSnapshot().save;
  expect(restored.kind).toBe('previewed');
  if (restored.kind !== 'previewed') throw Error('Prepared operation absent');
  expect(restored.request).toEqual(prepared.request);
  reopened.detach();
  await session.submit();
  expect(session.getSnapshot().save.kind).toBe('unknown');
  const raw = JSON.stringify(owner.peek(scope)!.request);
  expect(JSON.stringify(prepared.request)).toBe(raw);
  await session.retry();
  expect(client.applyPlatePlanVersion).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(vi.mocked(client.applyPlatePlanVersion).mock.calls[1]![0])).toBe(raw);
  session.detach();
});
it('does not call native preview or save when local definition retention fails', async () => {
  const client = unavailableInventoryClient();
  client.platePlanVersions = vi.fn();
  client.applyPlatePlanVersion = vi.fn();
  const session = new InventoryPlatePlanDraftSession(scope, client, pending(), {
    getItem: () => null,
    setItem: () => {
      throw Error('Unavailable');
    },
  });
  await session.preview();
  await session.submit();
  expect(session.getSnapshot().save.kind).toBe('failed');
  expect(client.platePlanVersions).not.toHaveBeenCalled();
  expect(client.applyPlatePlanVersion).not.toHaveBeenCalled();
});
it('expires a native observation at its deadline and clears all binding choices on exact version selection', async () => {
  vi.useFakeTimers();
  const client = unavailableInventoryClient(),
    a = version(),
    b = version(2);
  client.platePlanVersions = vi.fn(async () => list() as never);
  client.platePlanVersion = vi.fn(async (request) =>
    inventoryPlatePlanVersionReadSchema.parse({
      kind: 'available',
      projectId: scope.project,
      inventoryId: scope.inventoryId,
      revision: 96,
      version: request.versionId === a.id ? a : b,
      diagram: {
        kind: 'rendered',
        artifact: {
          versionId: request.versionId,
          definitionSha256: request.definitionSha256,
          svg: '<svg/>',
          sha256: inventoryTableSha256('<svg/>'),
          mediaType: 'image/svg+xml',
          fileName: `plate-plan-${request.versionId.slice('plate-plan-version:'.length)}.svg`,
        },
      },
    })
  );
  client.previewPlatePlanBinding = vi.fn(async (request) =>
    inventoryPlatePlanBindingPreviewSnapshotSchema.parse({
      kind: 'blocked',
      schema: 'dnaforge.inventory-plate-plan-binding-preview.v1',
      projectId: scope.project,
      inventoryId: scope.inventoryId,
      revision: 96,
      target: {
        projectId: scope.project,
        inventoryId: scope.inventoryId,
        present: true,
        revision: 96,
      },
      versionId: a.id,
      definitionSha256: a.definitionSha256,
      bindingSha256: inventoryTableSha256('binding'),
      asOf: 100,
      principal,
      nextBoundaryAt: 110,
      binding: request.binding,
      sources: [],
      issues: [
        { code: 'INVALID_INVENTORY_INPUT', pointer: '/binding', message: 'Recorded constraint' },
      ],
    })
  );
  const session = new InventoryPlatePlanReadSession(scope, client, {
    chooseDestination: async () => null,
    write: vi.fn(),
    read: vi.fn(),
  });
  await session.open();
  await session.select(a.id, a.definitionSha256);
  expect(session.getSnapshot().selected).toMatchObject({ kind: 'available' });
  session.bind('plate', { template: 'stock' });
  await session.previewBinding();
  expect(session.getSnapshot().feasibility.kind).toBe('observed');
  await vi.advanceTimersByTimeAsync(11);
  expect(session.getSnapshot().feasibility.kind).toBe('stale');
  await session.select(b.id, b.definitionSha256);
  expect(session.getSnapshot()).toMatchObject({
    destinationPlateId: '',
    sources: { template: '' },
    feasibility: { kind: 'draft' },
  });
  session.dispose();
});
