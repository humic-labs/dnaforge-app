import { expect, it, vi } from 'vitest';
import {
  inventoryPlatePlanDefinitionSha256,
  inventoryPlatePlanVersionId,
  type InventoryPlatePlanVersion,
} from '@waypoint/domain-services';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import {
  inventoryApplyPlatePlanObservationRequestSchema,
  inventoryPlatePlanObservationPreviewSnapshotSchema,
  type InventoryPlatePlanObservationPreviewSnapshot,
} from '../../shared/inventory-plate-plan-observations';
import {
  InventoryPendingCoordinator,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
import { InventoryPlatePlanObservationSession } from './inventory-plate-plan-observation-session';
import { InventoryPlatePlanObservationReadSession } from './inventory-plate-plan-observation-read-session';
const scope = { project: 'project', inventoryId: 'inventory' },
  principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}
function pending() {
  let values: readonly InventoryAttempt[] = [];
  return new InventoryPendingCoordinator({
    read: () => values,
    write: (next) => {
      values = next;
    },
  });
}
function version(): InventoryPlatePlanVersion {
  const definition = {
      schema: 'dnaforge.inventory-plate-plan-definition.v1' as const,
      title: 'Plan',
      layout: { kind: 'fixed-well' as const, rows: 2, columns: 3 },
      sourceSlots: [{ key: 'template', label: 'Template' }],
      transfers: [
        {
          actionId: 'action',
          sourceSlotKey: 'template',
          destinationPosition: 'A3',
          quantity: { value: '4', unit: 'uL' as const },
          label: 'Transfer',
        },
      ],
    },
    identity = { namespace: 'plans', planId: 'family' },
    definitionSha256 = inventoryPlatePlanDefinitionSha256(definition);
  return {
    id: inventoryPlatePlanVersionId(identity, definitionSha256),
    identity,
    definition,
    definitionSha256,
    at: 1,
    by: principal,
    reason: 'Reusable',
  };
}
function attempt(v = version()): InventoryAttempt {
  return {
    summary: 'Manual plan',
    request: inventoryApplyPlatePlanObservationRequestSchema.parse({
      ...scope,
      kind: 'record-plate-plan-observation',
      operationId: 'same-operation',
      expectedRevision: 98,
      expectedPlanDigest: `sha256:${'b'.repeat(64)}`,
      choices: {
        identity: { namespace: 'manual-plate-plan-reports', observationId: 'occurrence' },
        context: {
          kind: 'protocol-run',
          entityId: 'project::run',
          sourceSha256: `sha256:${'c'.repeat(64)}`,
        },
        binding: {
          versionId: v.id,
          definitionSha256: v.definitionSha256,
          destinationPlateId: 'plate',
          sources: [{ sourceSlotKey: 'template', stockId: 'stock' }],
        },
        reason: 'Completed manually',
      },
    }),
  };
}
it('does not send a partial or uncertain physical report to native preview or apply', async () => {
  const client = unavailableInventoryClient();
  client.platePlanVersions = vi.fn();
  client.previewPlatePlanObservation = vi.fn();
  client.applyPlatePlanObservation = vi.fn();
  const session = new InventoryPlatePlanObservationSession(
    scope,
    version(),
    client,
    pending(),
    memory()
  );
  session.edit({ ...session.getSnapshot().draft, declaration: 'uncertain' });
  await session.preview();
  await session.submit();
  expect(session.getSnapshot().phase.kind).toBe('failed');
  expect(client.platePlanVersions).not.toHaveBeenCalled();
  expect(client.previewPlatePlanObservation).not.toHaveBeenCalled();
  expect(client.applyPlatePlanObservation).not.toHaveBeenCalled();
});
it('preserves the exact pending occurrence on a foreign rejection and retries only the same accepted bytes', async () => {
  const client = unavailableInventoryClient(),
    owner = pending(),
    original = attempt();
  client.applyPlatePlanObservation = vi.fn(
    async () =>
      ({
        status: 'rejected',
        inventoryId: 'foreign',
        operationId: 'other-operation',
        code: 'REVISION_CONFLICT',
        message: 'Other result',
      }) as const
  );
  owner.retain(original);
  const session = new InventoryPlatePlanObservationSession(
    scope,
    version(),
    client,
    owner,
    memory()
  );
  session.resume(original);
  const bytes = JSON.stringify(owner.peek(scope)!.request);
  await session.retry();
  expect(session.getSnapshot().phase.kind).toBe('unknown');
  expect(JSON.stringify(owner.peek(scope)!.request)).toBe(bytes);
  await session.retry();
  expect(client.applyPlatePlanObservation).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(vi.mocked(client.applyPlatePlanObservation).mock.calls[1]![0])).toBe(bytes);
  session.detach();
});
it('refuses recovery under a different exact version pin', () => {
  const client = unavailableInventoryClient(),
    owner = pending(),
    original = attempt();
  owner.retain(original);
  const v = version(),
    other = { ...v, id: 'different-version' };
  const session = new InventoryPlatePlanObservationSession(scope, other, client, owner, memory());
  expect(() => session.resume(original)).toThrow(/another inventory or plan version/);
  expect(session.getSnapshot().phase.kind).toBe('editing');
  expect(owner.peek(scope)!.request).toEqual(original.request);
});
it('fences an earlier native preview after a local report choice changes', async () => {
  let resolve!: (value: InventoryPlatePlanObservationPreviewSnapshot) => void;
  const client = unavailableInventoryClient();
  client.platePlanVersions = vi.fn(async () => ({
    kind: 'ready' as const,
    projectId: scope.project,
    inventoryId: scope.inventoryId,
    revision: 98,
    identity: null,
    versions: [],
    nextCursor: null,
  }));
  client.previewPlatePlanObservation = vi.fn(
    () =>
      new Promise<InventoryPlatePlanObservationPreviewSnapshot>((yes) => {
        resolve = yes as typeof resolve;
      })
  );
  const session = new InventoryPlatePlanObservationSession(
    scope,
    version(),
    client,
    pending(),
    memory()
  );
  session.resume(attempt());
  session.edit({ ...session.getSnapshot().draft, reason: 'Not allowed during unknown' });
  const clean = new InventoryPlatePlanObservationSession(
    scope,
    version(),
    client,
    pending(),
    memory()
  );
  clean.edit({
    ...clean.getSnapshot().draft,
    destinationPlateId: 'plate',
    sources: { template: 'stock' },
    declaration: 'whole',
    entityId: 'project::run',
    sourceSha256: `sha256:${'c'.repeat(64)}`,
    reason: 'Full report',
  });
  const preview = clean.preview();
  await vi.waitFor(() => expect(client.previewPlatePlanObservation).toHaveBeenCalledOnce());
  clean.edit({ ...clean.getSnapshot().draft, reason: 'Changed after request' });
  resolve(
    inventoryPlatePlanObservationPreviewSnapshotSchema.parse({
      kind: 'blocked',
      schema: 'dnaforge.inventory-plate-plan-observation-preview.v1',
      ...{ projectId: scope.project, inventoryId: scope.inventoryId, revision: 98 },
      target: {
        projectId: scope.project,
        inventoryId: scope.inventoryId,
        present: true,
        revision: 98,
      },
      observationId: null,
      intentSha256: null,
      sourceSha256: null,
      asOf: 1,
      principal,
      nextBoundaryAt: null,
      issues: [
        {
          code: 'INVALID_INVENTORY_INPUT',
          pointer: '/binding',
          message: 'Earlier blocked response',
        },
      ],
      observation: null,
      commands: [],
      planDigest: null,
    })
  );
  await preview;
  expect(clean.getSnapshot().phase.kind).toBe('editing');
  expect(clean.getSnapshot().draft.reason).toBe('Changed after request');
  clean.detach();
  session.detach();
});
it('shows unavailable rather than a false empty list when a read response has another scope', async () => {
  const client = unavailableInventoryClient();
  client.platePlanObservations = vi.fn(async () => ({
    kind: 'ready' as const,
    projectId: 'foreign',
    inventoryId: scope.inventoryId,
    revision: 98,
    filters: { version: null, context: null },
    observations: [],
    nextCursor: null,
  }));
  const session = new InventoryPlatePlanObservationReadSession(client, scope, {}, vi.fn());
  await session.open();
  expect(session.getSnapshot().list.kind).toBe('unavailable');
  session.dispose();
});
