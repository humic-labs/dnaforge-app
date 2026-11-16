import { expect } from 'vitest';
import type {
  InventoryCommand,
  InventoryPhysicalItem,
  InventoryTemperatureRange,
} from '@waypoint/domain-services';
import type { createNativeInventoryOwner } from '../inventory-owner';
import type {
  InventoryExecuteRequest,
  InventoryReadRequest,
  NativeInventoryExecution,
  NativeInventoryReceipt,
} from '../../shared/inventory-command';
import type { InventoryStorageConditionsSnapshot } from '../../shared/inventory-client';

type Command = 'inventory.execute' | 'inventory.storage-conditions';
interface TemperatureContext {
  scope: InventoryReadRequest;
  projectId: string;
  owner: ReturnType<typeof createNativeInventoryOwner>;
  success<T>(label: string, command: Command, request: unknown): Promise<T>;
  loseAcknowledgement(
    request: InventoryExecuteRequest,
    evidenceKey?: string
  ): Promise<NativeInventoryReceipt>;
}

const temperature = (value: string) => ({ value, unit: 'C' as const });
const range = (minimum: string, maximum: string): InventoryTemperatureRange => ({
  minimum: temperature(minimum),
  maximum: temperature(maximum),
});
const unknownDimensions = () => ({
  width: { kind: 'unknown' as const },
  height: { kind: 'unknown' as const },
  depth: { kind: 'unknown' as const },
});

export async function runNativeTemperatureJourney(ctx: TemperatureContext) {
  const scope = { ...ctx.scope, inventoryId: 'inventory-temperature' };
  const cold: InventoryPhysicalItem = { kind: 'storage', id: 'cold' };
  const warm: InventoryPhysicalItem = { kind: 'storage', id: 'warm' };
  const box: InventoryPhysicalItem = { kind: 'storage', id: 'box' };
  async function commit(label: string, commands: readonly InventoryCommand[]) {
    const request: InventoryExecuteRequest = {
      ...scope,
      operationId: `temperature:${label}`,
      expectedRevision: ctx.owner.inspect(scope)?.revision ?? 0,
      commands,
    };
    const result = await ctx.success<NativeInventoryExecution>(label, 'inventory.execute', request);
    expect(result, label).toMatchObject({ status: 'committed' });
    return { request, result };
  }
  async function read(label: string, freshnessMaxAgeMs: number | null = null) {
    const state = ctx.owner.inspect(scope);
    const history = ctx.owner.history(scope);
    const result = await ctx.success<InventoryStorageConditionsSnapshot>(
      label,
      'inventory.storage-conditions',
      { ...scope, freshnessMaxAgeMs }
    );
    expect(result).toMatchObject({
      projectId: ctx.projectId,
      inventoryId: scope.inventoryId,
      revision: state?.revision ?? 0,
      freshnessMaxAgeMs,
    });
    expect(ctx.owner.inspect(scope), label).toEqual(state);
    expect(ctx.owner.history(scope), label).toEqual(history);
    return result;
  }
  await commit('create formulation in nested physical storage', [
    {
      kind: 'define-physical-type',
      id: 'temperature-freezer:v1',
      typeId: 'temperature-freezer',
      name: 'Synthetic temperature environment',
      description: 'Synthetic exact configuration; no hardware qualification.',
      fields: [{ key: 'assetTag', label: 'Asset tag', type: 'text' }],
      sources: [],
      definition: {
        kind: 'storage',
        layout: { kind: 'named', slots: ['A'] },
        childPolicy: { kind: 'any-legal' },
        positionRules: {},
        geometry: { external: unknownDimensions(), usable: unknownDimensions() },
      },
    },
    ...[cold, warm].map(
      (item): InventoryCommand => ({
        kind: 'instantiate-physical-type',
        id: item.id,
        typeVersionId: 'temperature-freezer:v1',
        name: `Synthetic ${item.id} environment`,
        destination: { kind: 'root' },
        metadata: { assetTag: item.id },
        reason: 'Synthetic storage conditions native acceptance',
      })
    ),
    ...[cold, warm].map(
      (item): InventoryCommand => ({
        kind: 'record-thermal-context',
        item,
        value: { kind: 'self' },
        observedAt: null,
        source: null,
        reason: 'Synthetic explicit independent temperature-control boundary',
      })
    ),
    {
      kind: 'create-storage',
      id: 'box',
      name: 'Synthetic ordinary holder',
      slots: ['tube'],
      placement: { kind: 'located', storageId: cold.id, slotId: 'A' },
    },
    {
      kind: 'create-vessel',
      id: 'tube',
      name: 'Synthetic formulation tube',
      placement: { kind: 'located', storageId: box.id, slotId: 'tube' },
    },
    {
      kind: 'create-lot',
      id: 'temperature-lot',
      materialId: 'synthetic-material',
      name: 'Synthetic temperature requirement formulation',
      origin: { kind: 'received', supplier: 'Synthetic fixture', lotNumber: 'TEMP-1' },
    },
    {
      kind: 'receive-lot-stock',
      id: 'temperature-stock',
      vesselId: 'tube',
      lotId: 'temperature-lot',
      quantity: { kind: 'known', value: '100', unit: 'uL' },
      quality: 'usable',
    },
    {
      kind: 'reserve-quantity',
      id: 'temperature-hold',
      stockId: 'temperature-stock',
      quantity: { value: '30', unit: 'uL' },
      deadline: null,
      purpose: 'Conservation through temperature facts',
    },
    {
      kind: 'record-storage-requirement',
      target: { kind: 'lot', id: 'temperature-lot' },
      value: { kind: 'specified', range: range('-82.00', '-78.000') },
      observedAt: null,
      source: null,
      reason: 'Synthetic actual formulation requirement; no material design inference',
    },
  ]);
  const conserved = ctx.owner.inspect(scope)!;
  const lostRequest: InventoryExecuteRequest = {
    ...scope,
    operationId: 'temperature:lost-capability',
    expectedRevision: conserved.revision,
    commands: [
      {
        kind: 'record-temperature-claim',
        id: 'cold-capability',
        subject: { kind: 'type-version', versionId: 'temperature-freezer:v1' },
        assertion: { kind: 'specified-setpoint-range', range: range('-86', '-50') },
        observedAt: null,
        source: null,
        reason: 'Synthetic model capability, not installed qualification',
      },
      {
        kind: 'record-equipment-setpoint',
        item: cold,
        value: { kind: 'known', temperature: temperature('-80.000') },
        observedAt: conserved.lastRecordedAt,
        source: null,
        reason: 'Synthetic explicit operator target report',
      },
      {
        kind: 'record-equipment-setpoint',
        item: warm,
        value: { kind: 'known', temperature: temperature('-20') },
        observedAt: null,
        source: null,
        reason: 'Synthetic second target with unknown observation time',
      },
      {
        kind: 'record-temperature-claim',
        id: 'cold-qualification',
        subject: {
          kind: 'installed',
          item: cold,
          configurationRevision: conserved.storage.cold.configuration.revision,
        },
        assertion: {
          kind: 'qualified-envelope',
          scope: 'physical-and-thermal-arrangement',
          range: range('-81', '-79'),
          atSetpoint: temperature('-80'),
          assumptions:
            'Synthetic stable closed chamber, declared load and ambient; no real measurement.',
        },
        observedAt: null,
        source: null,
        reason: 'Synthetic scoped qualification fixture only',
      },
    ],
  };
  const originalReceipt = await ctx.loseAcknowledgement(
    lostRequest,
    'temperatureLostAcknowledgement'
  );
  let conditions = await read('compare three independent temperature questions', 1_000);
  const supported = conditions.stocks['temperature-stock'];
  expect(supported.requirement).toMatchObject({
    inheritedFromLotId: 'temperature-lot',
    reason: 'lot-inheritance',
  });
  expect(supported.environment).toEqual({ kind: 'known', item: cold });
  expect(supported.capability.state).toBe('supported');
  expect(supported.reportedTarget.state).toBe('supported');
  expect(supported.qualifiedSupport.state).toBe('supported');
  expect(conditions.equipment['storage:cold'].setpointFreshness.state).toBe('fresh');
  expect(conditions.equipment['storage:warm'].setpointFreshness).toMatchObject({
    state: 'unknown',
    observedAt: null,
    reason: 'time-unknown',
  });
  const observations: unknown[] = [{ label: 'supported-independent-assessments', conditions }];
  await commit('declare a controlled inner holder without borrowing its parent target', [
    {
      kind: 'record-thermal-context',
      item: box,
      value: { kind: 'self' },
      observedAt: null,
      source: null,
      reason: 'Synthetic independent inner temperature-control boundary',
    },
    {
      kind: 'record-temperature-claim',
      id: 'inner-capability',
      subject: {
        kind: 'installed',
        item: box,
        configurationRevision: conserved.storage.box.configuration.revision,
      },
      assertion: { kind: 'specified-setpoint-range', range: range('-86', '-50') },
      observedAt: null,
      source: null,
      reason: 'Synthetic sole evidence for controlled inner holder',
    },
  ]);
  conditions = await read('controlled holder needs its own reported target');
  expect(conditions.stocks['temperature-stock'].environment).toEqual({ kind: 'known', item: box });
  expect(conditions.stocks['temperature-stock'].reportedTarget.state).toBe('unknown');
  await commit('withdraw sole inner claim without changing physical control', [
    {
      kind: 'withdraw-temperature-claim',
      claimId: 'inner-capability',
      reason: 'Synthetic withdrawal cannot erase control boundary',
    },
  ]);
  conditions = await read('evidence withdrawal cannot fall through to the enclosing freezer');
  expect(conditions.stocks['temperature-stock'].environment).toEqual({ kind: 'known', item: box });
  expect(conditions.stocks['temperature-stock'].capability.state).toBe('unknown');
  observations.push({ label: 'withdrawn-evidence-retains-explicit-inner-control', conditions });
  await commit('declare unknown inner thermal relationship', [
    {
      kind: 'record-thermal-context',
      item: box,
      value: { kind: 'unknown' },
      observedAt: null,
      source: null,
      reason: 'Synthetic unknown relationship must block enclosing freezer',
    },
  ]);
  conditions = await read('unknown thermal relationship is a separate state');
  expect(conditions.stocks['temperature-stock'].environment).toEqual({
    kind: 'unknown',
    reason: 'thermal-context-unknown',
  });
  await commit('explicitly inherit the enclosing freezer again', [
    {
      kind: 'record-thermal-context',
      item: box,
      value: { kind: 'inherit' },
      observedAt: null,
      source: null,
      reason: 'Synthetic explicit relationship correction',
    },
  ]);
  conditions = await read('explicit inheritance restores the matching enclosing context');
  expect(conditions.stocks['temperature-stock'].environment).toEqual({ kind: 'known', item: cold });
  expect(conditions.stocks['temperature-stock'].qualifiedSupport.state).toBe('supported');
  await commit('record mismatching target without stock mutation', [
    {
      kind: 'record-equipment-setpoint',
      item: cold,
      value: { kind: 'known', temperature: temperature('-20') },
      observedAt: null,
      source: null,
      reason: 'Synthetic target mismatch is an observation, not quarantine',
    },
  ]);
  conditions = await read('mismatching target invalidates setpoint-specific qualification');
  expect(conditions.stocks['temperature-stock'].capability.state).toBe('supported');
  expect(conditions.stocks['temperature-stock'].reportedTarget.state).toBe('incompatible');
  expect(conditions.stocks['temperature-stock'].qualifiedSupport.state).toBe('unknown');
  expect(
    conditions.equipment['storage:cold'].claims.find((row) => row.claim.id === 'cold-qualification')
      ?.applicability
  ).toBe('setpoint-changed');
  observations.push({ label: 'target-mismatch-with-capability-independent', conditions });
  await commit('restore explicit target and correct metadata', [
    {
      kind: 'record-equipment-setpoint',
      item: cold,
      value: { kind: 'known', temperature: temperature('-80') },
      observedAt: null,
      source: null,
      reason: 'Synthetic explicit target correction',
    },
    {
      kind: 'configure-item',
      item: cold,
      typeVersionId: 'temperature-freezer:v1',
      metadata: { assetTag: 'cold-corrected' },
      orientation: conserved.storage.cold.configuration.orientation,
      unavailablePositions: conserved.storage.cold.configuration.unavailablePositions,
      reason: 'Synthetic metadata-only correction preserves physical qualification',
    },
    {
      kind: 'record-temperature-claim',
      id: 'conflicting-capability',
      subject: { kind: 'type-version', versionId: 'temperature-freezer:v1' },
      assertion: { kind: 'specified-setpoint-range', range: range('-90', '-85') },
      observedAt: null,
      source: null,
      reason: 'Synthetic competing equal-scope source; never latest-wins',
    },
  ]);
  conditions = await read('keep equal-scope source conflicts explicit');
  expect(ctx.owner.inspect(scope)!.storage.cold.configuration.revision).toBe(
    conserved.storage.cold.configuration.revision
  );
  expect(conditions.stocks['temperature-stock'].capability.state).toBe('conflicting');
  expect(conditions.stocks['temperature-stock'].qualifiedSupport.state).toBe('supported');
  observations.push({ label: 'equal-scope-conflict-metadata-preserved', conditions });
  await commit('withdraw conflicting source and override requirement unknown', [
    {
      kind: 'withdraw-temperature-claim',
      claimId: 'conflicting-capability',
      reason: 'Synthetic explicit source withdrawal',
    },
    {
      kind: 'record-storage-requirement',
      target: { kind: 'stock', id: 'temperature-stock' },
      value: { kind: 'unknown' },
      observedAt: null,
      source: null,
      reason: 'Synthetic explicit unknown overrides inherited formulation knowledge',
    },
  ]);
  conditions = await read('explicit unknown suppresses lot inheritance');
  expect(conditions.stocks['temperature-stock'].requirement).toMatchObject({
    value: { kind: 'unknown' },
    inheritedFromLotId: null,
  });
  expect(conditions.stocks['temperature-stock'].capability.state).toBe('unknown');
  await commit('return to lot inheritance and move whole holder', [
    {
      kind: 'record-storage-requirement',
      target: { kind: 'stock', id: 'temperature-stock' },
      value: { kind: 'inherit' },
      observedAt: null,
      source: null,
      reason: 'Synthetic explicit return to lot requirement',
    },
    {
      kind: 'move-storage',
      id: box.id,
      placement: { kind: 'located', storageId: warm.id, slotId: 'A' },
    },
  ]);
  conditions = await read('whole-holder move derives descendant temperature context');
  expect(conditions.stocks['temperature-stock'].environment).toEqual({ kind: 'known', item: warm });
  expect(conditions.stocks['temperature-stock'].reportedTarget.state).toBe('incompatible');
  await commit('check out whole holder without former freezer inheritance', [
    {
      kind: 'checkout-item',
      item: box,
      dueAt: null,
      reason: 'Synthetic temporary custody',
    },
  ]);
  conditions = await read('checked-out contents have unknown current thermal environment');
  expect(conditions.stocks['temperature-stock'].environment).toEqual({
    kind: 'unknown',
    reason: 'custody-unavailable',
  });
  observations.push({ label: 'custody-suppresses-former-environment', conditions });
  await commit('return holder and change physical arrangement', [
    {
      kind: 'return-item',
      item: box,
      destination: { kind: 'located', storageId: cold.id, slotId: 'A' },
      reason: 'Synthetic return',
    },
    {
      kind: 'reconfigure-storage',
      storageId: cold.id,
      layout: { kind: 'named', slots: ['A', 'B'] },
      reason: 'Synthetic physical arrangement change',
    },
  ]);
  conditions = await read('physical change retains old qualification as inapplicable');
  expect(
    conditions.equipment['storage:cold'].claims.find((row) => row.claim.id === 'cold-qualification')
      ?.applicability
  ).toBe('configuration-changed');
  expect(conditions.stocks['temperature-stock'].qualifiedSupport.state).toBe('unknown');
  await commit('withdraw original capability after its acknowledgement was lost', [
    {
      kind: 'withdraw-temperature-claim',
      claimId: 'cold-capability',
      reason: 'Synthetic historical receipt must not reactivate source',
    },
  ]);
  expect(
    await ctx.success(
      'retry original lost fact batch after corrections',
      'inventory.execute',
      lostRequest
    )
  ).toEqual(originalReceipt);
  const state = ctx.owner.inspect(scope)!;
  expect(state.stocks).toEqual(conserved.stocks);
  expect(state.reservations).toEqual(conserved.reservations);
  expect(state.lots).toEqual(conserved.lots);
  expect(state.temperatureClaims['cold-capability'].lifecycle.kind).toBe('withdrawn');
  conditions = await read('final historical source assessment');
  const history = ctx.owner.history(scope);
  expect(ctx.owner.replay(scope)).toEqual({ state, acceptedOperations: history.length });
  return { scope, state, history, conditions, observations, lostRequest, originalReceipt };
}

export async function verifyNativeTemperatureReopen(
  ctx: TemperatureContext,
  before: Awaited<ReturnType<typeof runNativeTemperatureJourney>>
) {
  expect(ctx.owner.inspect(before.scope)).toEqual(before.state);
  expect(ctx.owner.history(before.scope)).toEqual(before.history);
  const conditions = await ctx.success<InventoryStorageConditionsSnapshot>(
    'read exact temperature conditions after native reopen',
    'inventory.storage-conditions',
    { ...before.scope, freshnessMaxAgeMs: null }
  );
  expect(conditions).toEqual(before.conditions);
  expect(
    await ctx.success(
      'retry lost temperature receipt after restart',
      'inventory.execute',
      before.lostRequest
    )
  ).toEqual(before.originalReceipt);
  expect(ctx.owner.inspect(before.scope)).toEqual(before.state);
  expect(ctx.owner.history(before.scope)).toEqual(before.history);
  const replay = ctx.owner.replay(before.scope);
  expect(replay).toEqual({ state: before.state, acceptedOperations: before.history.length });
  return {
    state: ctx.owner.inspect(before.scope),
    history: ctx.owner.history(before.scope),
    conditions,
    replay,
  };
}
