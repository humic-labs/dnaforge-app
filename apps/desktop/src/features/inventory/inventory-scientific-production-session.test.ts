import { expect, it, vi } from 'vitest';
import {
  createInventoryState,
  inventoryScientificProductionChoices,
} from '@waypoint/domain-services';
import { recordedScientificProductionFixture } from '../../../../../packages/core/domain-services/src/inventory-scientific-production.fixtures';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import {
  inventoryApplyScientificProductionRequestSchema,
  inventoryPreviewScientificProductionRequestSchema,
  type InventoryScientificProductionPreviewSnapshot,
} from '../../shared/inventory-scientific-productions';
import {
  InventoryPendingCoordinator,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
import { InventoryScientificProductionSession } from './inventory-scientific-production-session';
const scope = { project: 'project', inventoryId: 'inventory' },
  resource = {
    projectId: 'project',
    workspaceScope: 'project',
    entityId: 'project::run',
    fileObjectUuid: 'file',
  };
const sha = `sha256:${'a'.repeat(64)}` as const;
function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
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
function attempt(): InventoryAttempt {
  return {
    summary: 'Completed production',
    request: inventoryApplyScientificProductionRequestSchema.parse({
      ...scope,
      kind: 'record-scientific-production',
      operationId: 'original-operation',
      expectedRevision: 102,
      expectedPlanDigest: sha,
      choices: {
        identity: {
          namespace: 'manual-scientific-production',
          productionId: 'original-production',
        },
        context: { kind: 'protocol-run', entityId: resource.entityId, sourceSha256: sha },
        design: {
          scientificWorkspaceId: 'scientific-project',
          revision: {
            kind: 'accepted-object',
            resourceId: 'design',
            resourceRevisionId: `rr_${'b'.repeat(64)}`,
            workspaceVersionId: `wv_${'c'.repeat(64)}`,
            contentSha256: 'd'.repeat(64),
          },
        },
        inputs: [{ stockId: 'input', quantity: { value: '1', unit: 'uL' } }],
        output: {
          vesselId: 'empty-output',
          quantity: { value: '5', unit: 'uL' },
          lotName: 'Measured batch',
        },
        method: 'Completed manual preparation',
        reason: 'Record existing work',
      },
    }),
  };
}
it('retains draft storage failure as a zero-RPC boundary', async () => {
  const client = unavailableInventoryClient();
  client.inspect = vi.fn();
  client.previewScientificProduction = vi.fn();
  const session = new InventoryScientificProductionSession(scope, resource, client, pending(), {
    getItem: () => null,
    setItem: () => {
      throw Error('Storage unavailable');
    },
  });
  await session.preview();
  expect(session.getSnapshot().phase.kind).toBe('failed');
  expect(client.inspect).not.toHaveBeenCalled();
  expect(client.previewScientificProduction).not.toHaveBeenCalled();
  session.detach();
});
it('refuses a pending production for another Run without claiming or changing its bytes', () => {
  const owner = pending(),
    original = attempt();
  owner.retain(original);
  const bytes = JSON.stringify(owner.peek(scope));
  const session = new InventoryScientificProductionSession(
    scope,
    { ...resource, entityId: 'project::other' },
    unavailableInventoryClient(),
    owner,
    storage()
  );
  expect(() => session.resume(original)).toThrow(/another Run/);
  expect(JSON.stringify(owner.peek(scope))).toBe(bytes);
  session.detach();
});
it('keeps wrong acknowledgements and an absent operation unknown, retrying the same raw request', async () => {
  const client = unavailableInventoryClient(),
    owner = pending(),
    original = attempt();
  owner.retain(original);
  client.applyScientificProduction = vi.fn(async () => ({
    status: 'rejected' as const,
    inventoryId: scope.inventoryId,
    operationId: 'another-operation',
    code: 'INVENTORY_SCIENTIFIC_PRODUCTION_NO_CHANGES',
    message: 'Already recorded',
    currentRevision: 103,
  }));
  client.operation = vi.fn(async () => null);
  client.scientificProduction = vi.fn(async () => ({
    kind: 'unavailable' as const,
    code: 'NOT_FOUND',
    message: 'Not confirmed',
    retryable: true,
  }));
  const session = new InventoryScientificProductionSession(
    scope,
    resource,
    client,
    owner,
    storage()
  );
  session.resume(original);
  const bytes = JSON.stringify(owner.peek(scope));
  await session.retry();
  expect(session.getSnapshot().phase.kind).toBe('unknown');
  expect(client.scientificProduction).not.toHaveBeenCalled();
  await session.checkStatus();
  expect(session.getSnapshot().phase.kind).toBe('unknown');
  expect(client.scientificProduction).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(owner.peek(scope))).toBe(bytes);
  await session.retry();
  expect(client.applyScientificProduction).toHaveBeenCalledTimes(2);
  expect(vi.mocked(client.applyScientificProduction).mock.calls[0][0]).toEqual(original.request);
  expect(vi.mocked(client.applyScientificProduction).mock.calls[1][0]).toEqual(original.request);
  session.detach();
});
it('canonicalizes explicit volume before the shared request and fences a late preview after editing', async () => {
  const client = unavailableInventoryClient();
  client.inspect = vi.fn(async () => createInventoryState());
  let resolve!: (value: InventoryScientificProductionPreviewSnapshot) => void;
  client.previewScientificProduction = vi.fn(
    () =>
      new Promise<InventoryScientificProductionPreviewSnapshot>((done) => {
        resolve = done;
      })
  );
  const session = new InventoryScientificProductionSession(
    scope,
    resource,
    client,
    pending(),
    storage()
  );
  const original = attempt().request;
  if (!('kind' in original) || original.kind !== 'record-scientific-production')
    throw Error('Expected production request');
  session.edit({
    ...session.getSnapshot().draft,
    sourceSha256: sha,
    design: original.choices.design,
    inputs: [{ key: 'row', stockId: 'input', amount: '1.000' }],
    outputVesselId: 'empty-output',
    outputAmount: '5',
    lotName: 'Measured batch',
    method: 'Manual preparation',
    reason: 'Original report',
    declaration: 'completed',
  });
  const running = session.preview();
  await vi.waitFor(() => expect(client.previewScientificProduction).toHaveBeenCalledTimes(1));
  expect(
    inventoryPreviewScientificProductionRequestSchema.parse(
      vi.mocked(client.previewScientificProduction).mock.calls[0][0]
    ).choices.inputs[0].quantity
  ).toEqual({ value: '1', unit: 'uL' });
  session.edit({ ...session.getSnapshot().draft, reason: 'Edited report' });
  resolve({
    kind: 'blocked',
    schema: 'dnaforge.inventory-scientific-production-preview.v1',
    inventoryId: scope.inventoryId,
    projectId: scope.project,
    revision: 0,
    target: {
      projectId: scope.project,
      inventoryId: scope.inventoryId,
      present: true,
      revision: 0,
    },
    productionId: null,
    intentSha256: null,
    sourceSha256: null,
    asOf: 1,
    principal: { kind: 'local-profile', profileKey: 'a'.repeat(64) },
    nextBoundaryAt: null,
    production: null,
    commands: [],
    planDigest: null,
    issues: [{ code: 'REVISION_CONFLICT', pointer: '/target', message: 'Changed' }],
  } as InventoryScientificProductionPreviewSnapshot);
  await running;
  expect(session.getSnapshot().phase.kind).toBe('editing');
  expect(session.getSnapshot().draft.reason).toBe('Edited report');
  session.detach();
});

it.each(['no-change', 'lost-ack'] as const)(
  'confirms exact existing business after %s without inventing a fresh-operation receipt',
  async (outcome) => {
    const fixture = recordedScientificProductionFixture(),
      choices = inventoryScientificProductionChoices(fixture.production);
    const localScope = {
      project: fixture.input.target.projectId,
      inventoryId: fixture.input.target.inventoryId,
    };
    const original: InventoryAttempt = {
      summary: 'Original completed production',
      request: inventoryApplyScientificProductionRequestSchema.parse({
        ...localScope,
        kind: 'record-scientific-production',
        operationId: 'fresh-duplicate-operation',
        expectedRevision: fixture.state.revision,
        expectedPlanDigest: fixture.preview.planDigest,
        choices,
      }),
    };
    const client = unavailableInventoryClient(),
      owner = pending();
    owner.retain(original);
    client.applyScientificProduction = vi.fn(async () => {
      if (outcome === 'lost-ack') throw Error('Acknowledgement lost');
      return {
        status: 'rejected' as const,
        inventoryId: localScope.inventoryId,
        operationId: original.request.operationId,
        code: 'INVENTORY_SCIENTIFIC_PRODUCTION_NO_CHANGES',
        message: 'Already recorded',
        currentRevision: fixture.recorded.revision,
      };
    });
    client.operation = vi.fn(async () => null);
    client.scientificProduction = vi.fn(async () => ({
      kind: 'available' as const,
      projectId: localScope.project,
      inventoryId: localScope.inventoryId,
      revision: fixture.recorded.revision,
      production: fixture.production,
    }));
    const session = new InventoryScientificProductionSession(
      localScope,
      {
        projectId: localScope.project,
        workspaceScope: localScope.project,
        entityId: choices.context.entityId,
        fileObjectUuid: fixture.source.fileObjectUuid,
      },
      client,
      owner,
      storage()
    );
    session.resume(original);
    await session.retry();
    if (outcome === 'lost-ack') {
      expect(session.getSnapshot().phase.kind).toBe('unknown');
      await session.checkStatus();
    }
    expect(session.getSnapshot().phase).toMatchObject({
      kind: 'recorded',
      outcome: 'existing',
      production: fixture.production,
    });
    expect(owner.peek(localScope)).toBeUndefined();
    expect(client.applyScientificProduction).toHaveBeenCalledTimes(1);
    const result = session.getSnapshot().phase;
    expect(result).not.toHaveProperty('receipt');
    session.detach();
  }
);
