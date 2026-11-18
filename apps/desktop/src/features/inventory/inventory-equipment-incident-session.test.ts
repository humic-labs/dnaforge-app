import { recordedEquipmentIncidentFixture } from '../../../../../packages/core/domain-services/src/inventory-equipment-incident.fixtures';
import { expect, it, vi } from 'vitest';
import {
  createInventoryState,
  inventoryEquipmentIncidentSummary,
  inventoryEquipmentIncidentCurrentStatus,
} from '@waypoint/domain-services';
import { unavailableInventoryClient } from '../../shared/inventory-client';
import {
  inventoryApplyEquipmentIncidentActionRequestSchema,
  inventoryPreviewEquipmentIncidentActionRequestSchema,
  type InventoryEquipmentIncidentActionPreviewSnapshot,
} from '../../shared/inventory-equipment-incidents';
import {
  InventoryPendingCoordinator,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
import { InventoryEquipmentIncidentSession } from './inventory-equipment-incident-session';
const scope = { project: 'project', inventoryId: 'inventory' },
  equipmentId = 'storage',
  principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) },
  sha = `sha256:${'b'.repeat(64)}` as const;
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
function attempt(): InventoryAttempt {
  return {
    summary: 'Outage report',
    request: inventoryApplyEquipmentIncidentActionRequestSchema.parse({
      ...scope,
      kind: 'record-equipment-incident-action',
      expectedRevision: 103,
      operationId: 'original-operation',
      expectedPlanDigest: sha,
      choices: {
        identity: { namespace: 'manual-equipment-incidents', actionId: 'report-one' },
        action: {
          kind: 'report',
          equipment: { storageId: equipmentId, configurationRevision: 0 },
          noticedAt: null,
          description: 'Operator reports cooling outage',
          reason: 'Record observed outage',
        },
      },
    }),
  };
}
it('sends no RPC when the stable draft cannot be retained', async () => {
  const client = unavailableInventoryClient();
  client.inspect = vi.fn();
  client.previewEquipmentIncidentAction = vi.fn();
  const session = new InventoryEquipmentIncidentSession(scope, equipmentId, 0, client, pending(), {
    getItem: () => null,
    setItem: () => {
      throw Error('Storage unavailable');
    },
  });
  await session.preview();
  expect(session.getSnapshot().phase.kind).toBe('failed');
  expect(client.inspect).not.toHaveBeenCalled();
  expect(client.previewEquipmentIncidentAction).not.toHaveBeenCalled();
  session.detach();
});
it('does not claim a retained report for another equipment item', () => {
  const owner = pending(),
    original = attempt();
  owner.retain(original);
  const bytes = JSON.stringify(owner.peek(scope));
  const session = new InventoryEquipmentIncidentSession(
    scope,
    'other',
    0,
    unavailableInventoryClient(),
    owner,
    memory()
  );
  expect(() => session.resume(original)).toThrow(/another equipment/);
  expect(JSON.stringify(owner.peek(scope))).toBe(bytes);
  session.detach();
});
it('retains a mismatched rejection and missing operation as unknown, retrying the same raw report', async () => {
  const client = unavailableInventoryClient(),
    owner = pending(),
    original = attempt();
  owner.retain(original);
  client.applyEquipmentIncidentAction = vi.fn(async () => ({
    status: 'rejected' as const,
    inventoryId: scope.inventoryId,
    operationId: 'wrong-operation',
    code: 'INVENTORY_EQUIPMENT_INCIDENT_NO_CHANGES',
    message: 'Already exists',
    currentRevision: 104,
  }));
  client.operation = vi.fn(async () => null);
  client.equipmentIncident = vi.fn(async () => ({
    kind: 'unavailable' as const,
    code: 'NOT_CONFIRMED',
    message: 'Original report unavailable',
    retryable: true,
  }));
  const session = new InventoryEquipmentIncidentSession(
    scope,
    equipmentId,
    0,
    client,
    owner,
    memory()
  );
  session.resume(original);
  const bytes = JSON.stringify(owner.peek(scope));
  await session.retry();
  expect(client.equipmentIncident).not.toHaveBeenCalled();
  await session.checkStatus();
  expect(session.getSnapshot().phase.kind).toBe('unknown');
  expect(JSON.stringify(owner.peek(scope))).toBe(bytes);
  await session.retry();
  expect(vi.mocked(client.applyEquipmentIncidentAction).mock.calls.map((call) => call[0])).toEqual([
    original.request,
    original.request,
  ]);
  session.detach();
});
it.each(['no-change', 'lost-ack'] as const)(
  'confirms exact original business proof after %s without a fresh-operation receipt',
  async (outcome) => {
    const fixture = recordedEquipmentIncidentFixture();
    const client = unavailableInventoryClient(),
      owner = pending(),
      record = inventoryEquipmentIncidentSummary(fixture.incident),
      original: InventoryAttempt = {
        summary: 'Original report',
        request: inventoryApplyEquipmentIncidentActionRequestSchema.parse({
          ...scope,
          kind: 'record-equipment-incident-action',
          expectedRevision: fixture.state.revision,
          operationId: 'duplicate-operation',
          expectedPlanDigest: fixture.preview.planDigest,
          choices: fixture.choices,
        }),
      };
    owner.retain(original);
    client.applyEquipmentIncidentAction = vi.fn(async () => {
      if (outcome === 'lost-ack') throw Error('Lost acknowledgement');
      return {
        status: 'rejected' as const,
        inventoryId: scope.inventoryId,
        operationId: original.request.operationId,
        code: 'INVENTORY_EQUIPMENT_INCIDENT_NO_CHANGES',
        message: 'Already recorded',
        currentRevision: 104,
      };
    });
    client.operation = vi.fn(async () => null);
    client.equipmentIncident = vi.fn(async () => ({
      kind: 'available' as const,
      projectId: scope.project,
      inventoryId: scope.inventoryId,
      revision: fixture.recorded.revision,
      asOf: 101,
      principal,
      incident: record,
      current: inventoryEquipmentIncidentCurrentStatus(fixture.recorded, record.id),
    }));
    const session = new InventoryEquipmentIncidentSession(
      scope,
      record.binding.storageId,
      0,
      client,
      owner,
      memory()
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
      incident: record,
    });
    expect(session.getSnapshot().phase).not.toHaveProperty('receipt');
    expect(owner.peek(scope)).toBeUndefined();
    expect(client.applyEquipmentIncidentAction).toHaveBeenCalledTimes(1);
    session.detach();
  }
);
it('keeps noticed time separate and prevents a late preview replacing an edited draft', async () => {
  const client = unavailableInventoryClient();
  client.inspect = vi.fn(async () => createInventoryState());
  let resolve!: (value: InventoryEquipmentIncidentActionPreviewSnapshot) => void;
  client.previewEquipmentIncidentAction = vi.fn(
    () =>
      new Promise<InventoryEquipmentIncidentActionPreviewSnapshot>((done) => {
        resolve = done;
      })
  );
  const session = new InventoryEquipmentIncidentSession(
    scope,
    equipmentId,
    0,
    client,
    pending(),
    memory()
  );
  session.edit({ ...session.getSnapshot().draft, description: 'Outage', reason: 'Record it' });
  const running = session.preview();
  await vi.waitFor(() => expect(client.previewEquipmentIncidentAction).toHaveBeenCalledTimes(1));
  expect(
    inventoryPreviewEquipmentIncidentActionRequestSchema.parse(
      vi.mocked(client.previewEquipmentIncidentAction).mock.calls[0][0]
    ).choices.action
  ).toMatchObject({ kind: 'report', noticedAt: null });
  session.edit({ ...session.getSnapshot().draft, reason: 'Changed reason' });
  resolve({
    schema: 'dnaforge.inventory-equipment-incident-action-preview.v1',
    kind: 'blocked',
    projectId: scope.project,
    inventoryId: scope.inventoryId,
    revision: 0,
    target: {
      projectId: scope.project,
      inventoryId: scope.inventoryId,
      present: true,
      revision: 0,
    },
    actionId: null,
    intentSha256: null,
    incidentId: null,
    asOf: 1,
    principal,
    nextBoundaryAt: null,
    record: null,
    commands: [],
    planDigest: null,
    issues: [{ code: 'REVISION_CONFLICT', pointer: '/target', message: 'Changed' }],
  });
  await running;
  expect(session.getSnapshot().phase.kind).toBe('editing');
  expect(session.getSnapshot().draft.reason).toBe('Changed reason');
  session.detach();
});

it('retains a follow-up across close and resolves its exact fact after a lost duplicate acknowledgement', async () => {
  const { equipmentIncidentAction } =
    await import('../../../../../packages/core/domain-services/src/inventory-equipment-incident.fixtures');
  const { equipmentIncidentFollowUpDraft } =
    await import('./inventory-equipment-incident-action-draft');
  const f = recordedEquipmentIncidentFixture();
  const action = {
    kind: 'manual-temperature' as const,
    incident: { incidentId: f.incident.id, intentSha256: f.incident.intentSha256 },
    reading: {
      kind: 'measured' as const,
      temperature: { value: '-60', unit: 'C' as const },
      observedAt: 90,
      pointLabel: 'Upper rack manual probe',
    },
    supersedes: null,
    reason: 'Manual temperature report',
  };
  const seed = equipmentIncidentFollowUpDraft(action),
    storage = memory(),
    client = unavailableInventoryClient(),
    owner = pending();
  let session = new InventoryEquipmentIncidentSession(
    scope,
    f.incident.binding.storageId,
    0,
    client,
    owner,
    storage,
    () => 'manual-operation',
    seed
  );
  session.edit({ ...session.getSnapshot().draft, reason: action.reason });
  const stableId = session.getSnapshot().draft.actionId;
  session.detach();
  session = new InventoryEquipmentIncidentSession(
    scope,
    f.incident.binding.storageId,
    0,
    client,
    owner,
    storage,
    () => 'manual-operation',
    seed
  );
  expect(session.getSnapshot().draft.actionId).toBe(stableId);
  const choices = {
    identity: { namespace: 'manual-equipment-incidents', actionId: stableId },
    action,
  };
  const saved = equipmentIncidentAction(f.recorded, choices);
  const request = inventoryApplyEquipmentIncidentActionRequestSchema.parse({
    ...scope,
    kind: 'record-equipment-incident-action',
    expectedRevision: f.recorded.revision,
    operationId: 'manual-operation',
    expectedPlanDigest: saved.preview.planDigest,
    choices,
  });
  const original: InventoryAttempt = { summary: 'Manual observation', request };
  owner.retain(original);
  client.operation = vi.fn(async () => null);
  client.equipmentIncident = vi.fn(async () => ({
    kind: 'available' as const,
    ...scopeHeader(saved.state.revision),
    incident: inventoryEquipmentIncidentSummary(f.incident),
    current: inventoryEquipmentIncidentCurrentStatus(saved.state, f.incident.id),
  }));
  client.equipmentIncidentFacts = vi.fn(async (request) => {
    expect(request.query).toMatchObject({
      kind: 'fact',
      fact: {
        factId: saved.record.actionProof.actionId,
        intentSha256: saved.record.actionProof.intentSha256,
      },
    });
    return {
      kind: 'available' as const,
      ...scopeHeader(saved.state.revision),
      incident: action.incident,
      fact: saved.state.equipmentIncidentFacts[saved.record.actionProof.actionId],
      manual: null,
      freshnessMaxAgeMs: null,
      nextBoundaryAt: null,
    };
  });
  session.resume(original);
  session.newAction();
  expect(session.getSnapshot().phase.kind).toBe('unknown');
  await session.checkStatus();
  expect(session.getSnapshot().phase).toMatchObject({
    kind: 'recorded',
    outcome: 'existing',
    record: { kind: 'manual-temperature', actionProof: { choices } },
  });
  expect(owner.peek(scope)).toBeUndefined();
  session.detach();
  session = new InventoryEquipmentIncidentSession(
    scope,
    f.incident.binding.storageId,
    0,
    client,
    owner,
    storage,
    () => 'next-manual-operation',
    seed
  );
  expect(session.getSnapshot().phase).toMatchObject({ kind: 'recorded', outcome: 'existing' });
  expect(session.getSnapshot().draft.actionId).toBe(stableId);
  session.newAction();
  expect(session.getSnapshot().phase.kind).toBe('editing');
  expect(session.getSnapshot().draft.actionId).not.toBe(stableId);
  expect(session.getSnapshot().draft.reason).toBe('');
  session.detach();
});
function scopeHeader(revision: number) {
  return {
    projectId: scope.project,
    inventoryId: scope.inventoryId,
    revision,
    asOf: 101,
    principal,
  };
}

it('keeps a follow-up pending when the original fact has a different action proof', async () => {
  const { equipmentIncidentAction } =
    await import('../../../../../packages/core/domain-services/src/inventory-equipment-incident.fixtures');
  const { equipmentIncidentFollowUpDraft } =
    await import('./inventory-equipment-incident-action-draft');
  const f = recordedEquipmentIncidentFixture(),
    action = {
      kind: 'resolve' as const,
      incident: { incidentId: f.incident.id, intentSha256: f.incident.intentSha256 },
      resolution: 'reported-resolved' as const,
      reason: 'Equipment repair reported',
    };
  const saved = equipmentIncidentAction(f.recorded, {
    identity: { namespace: 'manual-equipment-incidents', actionId: 'original' },
    action,
  });
  const wrong = equipmentIncidentAction(f.recorded, {
    identity: { namespace: 'manual-equipment-incidents', actionId: 'other' },
    action,
  });
  const original: InventoryAttempt = {
    summary: 'Resolve',
    request: inventoryApplyEquipmentIncidentActionRequestSchema.parse({
      ...scope,
      kind: 'record-equipment-incident-action',
      expectedRevision: f.recorded.revision,
      operationId: 'resolve-original',
      expectedPlanDigest: saved.preview.planDigest,
      choices: saved.record.actionProof.choices,
    }),
  };
  const client = unavailableInventoryClient(),
    owner = pending();
  owner.retain(original);
  client.operation = vi.fn(async () => null);
  client.equipmentIncident = vi.fn(async () => ({
    kind: 'available' as const,
    ...scopeHeader(saved.state.revision),
    incident: inventoryEquipmentIncidentSummary(f.incident),
    current: inventoryEquipmentIncidentCurrentStatus(saved.state, f.incident.id),
  }));
  client.equipmentIncidentFacts = vi.fn(async () => ({
    kind: 'available' as const,
    ...scopeHeader(wrong.state.revision),
    incident: action.incident,
    fact: wrong.state.equipmentIncidentFacts[wrong.record.actionProof.actionId],
    manual: null,
    freshnessMaxAgeMs: null,
    nextBoundaryAt: null,
  }));
  const session = new InventoryEquipmentIncidentSession(
    scope,
    f.incident.binding.storageId,
    0,
    client,
    owner,
    memory(),
    undefined,
    equipmentIncidentFollowUpDraft(action)
  );
  session.resume(original);
  await session.checkStatus();
  expect(session.getSnapshot().phase.kind).toBe('unknown');
  expect(owner.peek(scope)?.request).toEqual(original.request);
  session.detach();
});
