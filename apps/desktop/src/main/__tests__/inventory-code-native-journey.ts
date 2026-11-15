import { expect } from 'vitest';
import type {
  InventoryCommand,
  InventoryPrincipal,
  InventoryState,
} from '@waypoint/domain-services';
import type { createNativeInventoryOwner } from '../inventory-owner';
import type {
  InventoryExecuteRequest,
  InventoryReadRequest,
  NativeInventoryExecution,
  NativeInventoryReceipt,
} from '../../shared/inventory-command';
import type { InventoryItemCodeLookupSnapshot } from '../../shared/inventory-client';

type Command = 'inventory.inspect' | 'inventory.execute' | 'inventory.resolve-item-code';
export interface NativeItemCodeJourneyContext {
  scope: InventoryReadRequest;
  projectId: string;
  owner: ReturnType<typeof createNativeInventoryOwner>;
  principal: InventoryPrincipal;
  success<T>(label: string, command: Command, request: unknown): Promise<T>;
  loseAcknowledgement(
    request: InventoryExecuteRequest,
    evidenceKey?: string
  ): Promise<NativeInventoryReceipt>;
}

export async function runNativeItemCodeJourney(ctx: NativeItemCodeJourneyContext) {
  const scope = { ...ctx.scope, inventoryId: 'inventory-item-codes' };
  async function attempt(label: string, commands: readonly InventoryCommand[]) {
    const before = ctx.owner.inspect(scope);
    const history = ctx.owner.history(scope);
    const request = {
      ...scope,
      operationId: `codes:${label}`,
      expectedRevision: before?.revision ?? 0,
      commands,
    };
    const result = await ctx.success<NativeInventoryExecution>(label, 'inventory.execute', request);
    return { before, history, request, result };
  }
  async function commit(label: string, commands: readonly InventoryCommand[]) {
    const result = await attempt(label, commands);
    expect(result.result, label).toMatchObject({ status: 'committed' });
    return result;
  }
  async function refuse(label: string, commands: readonly InventoryCommand[]) {
    const result = await attempt(label, commands);
    expect(result.result, label).toMatchObject({ status: 'rejected' });
    expect(ctx.owner.inspect(scope), label).toEqual(result.before);
    expect(ctx.owner.history(scope), label).toEqual(result.history);
    expect(
      ctx.owner.operation({ ...scope, operationId: result.request.operationId }),
      label
    ).toBeNull();
  }
  async function lookup(label: string, namespace: string | null, value: string) {
    const before = ctx.owner.inspect(scope);
    const history = ctx.owner.history(scope);
    const result = await ctx.success<InventoryItemCodeLookupSnapshot>(
      label,
      'inventory.resolve-item-code',
      { ...scope, query: { namespace, value } }
    );
    expect(result).toMatchObject({
      projectId: ctx.projectId,
      inventoryId: scope.inventoryId,
      revision: before?.revision ?? 0,
      principal: ctx.principal,
    });
    expect(ctx.owner.inspect(scope), label).toEqual(before);
    expect(ctx.owner.history(scope), label).toEqual(history);
    for (const target of result.targets) {
      const record =
        target.item.kind === 'storage'
          ? before!.storage[target.item.id]
          : before!.vessels[target.item.id];
      expect(target.record).toEqual(record);
      for (const stock of target.stocks) {
        expect(stock.stock).toEqual(before!.stocks[stock.stock.id]);
        expect(stock.availability).toEqual(ctx.owner.availability(scope)!.stocks[stock.stock.id]);
      }
    }
    return result;
  }
  const code = (
    id: string,
    namespace: string,
    value: string,
    item: { kind: 'storage' | 'vessel'; id: string }
  ): InventoryCommand => ({
    kind: 'attach-item-code',
    id,
    namespace,
    value,
    item,
    reason: 'Synthetic exact item-code acceptance',
  });
  await commit('create empty and stocked physical code targets', [
    {
      kind: 'create-storage',
      id: 'code-freezer',
      name: 'Code freezer',
      slots: ['top'],
      placement: { kind: 'root' },
    },
    {
      kind: 'create-storage',
      id: 'code-box',
      name: 'Code box',
      slots: ['A1', 'A2'],
      placement: { kind: 'located', storageId: 'code-freezer', slotId: 'top' },
    },
    {
      kind: 'create-vessel',
      id: 'code-tube',
      name: 'Code stocked tube',
      placement: { kind: 'located', storageId: 'code-box', slotId: 'A1' },
    },
    {
      kind: 'create-vessel',
      id: 'code-empty',
      name: 'Code empty tube',
      placement: { kind: 'located', storageId: 'code-box', slotId: 'A2' },
    },
    {
      kind: 'receive-stock',
      id: 'code-stock',
      vesselId: 'code-tube',
      materialId: 'synthetic-material',
      quantity: { kind: 'known', value: '100', unit: 'uL' },
      quality: 'usable',
    },
  ]);
  const attachRequest: InventoryExecuteRequest = {
    ...scope,
    operationId: 'codes:lost-attachment',
    expectedRevision: ctx.owner.inspect(scope)!.revision,
    commands: [code('code-internal', 'internal', '00123', { kind: 'vessel', id: 'code-tube' })],
  };
  const attachReceipt = await ctx.loseAcknowledgement(attachRequest, 'itemCodeLostAcknowledgement');
  expect(ctx.owner.inspect(scope)!.itemCodes['code-internal'].assignedBy).toEqual(ctx.principal);
  await commit('attach exact aliases without code normalization', [
    code('code-vendor', 'vendor', '00123', { kind: 'vessel', id: 'code-empty' }),
    code('code-upper', 'internal', 'ABC', { kind: 'vessel', id: 'code-tube' }),
    code('code-lower', 'internal', 'abc', { kind: 'vessel', id: 'code-empty' }),
    code('code-spaces', 'internal', ' 00123 ', { kind: 'storage', id: 'code-box' }),
  ]);
  const exact = await lookup('resolve leading zeros exactly', 'internal', '00123');
  expect(exact.resolution).toMatchObject({
    kind: 'resolved',
    match: { id: 'code-internal', value: '00123', item: { kind: 'vessel', id: 'code-tube' } },
  });
  expect((await lookup('do not coerce code to a number', 'internal', '123')).resolution.kind).toBe(
    'not-found'
  );
  expect((await lookup('do not trim a different code', 'internal', '00123 ')).resolution.kind).toBe(
    'not-found'
  );
  expect(
    (await lookup('preserve leading and trailing spaces', 'internal', ' 00123 ')).resolution
  ).toMatchObject({ kind: 'resolved', match: { id: 'code-spaces' } });
  expect(
    (await lookup('preserve uppercase code identity', 'internal', 'ABC')).resolution
  ).toMatchObject({ kind: 'resolved', match: { id: 'code-upper' } });
  expect(
    (await lookup('preserve lowercase code identity', 'internal', 'abc')).resolution
  ).toMatchObject({ kind: 'resolved', match: { id: 'code-lower' } });
  expect(
    (await lookup('reject uppercase namespace rather than fold it', 'Internal', '00123')).resolution
      .kind
  ).toBe('invalid');
  expect(
    (await lookup('reject a native semantic control character', 'internal', '00123\n')).resolution
      .kind
  ).toBe('invalid');
  expect(
    (await lookup('treat a scanned URL as opaque text', null, 'https://example.invalid/code'))
      .resolution.kind
  ).toBe('not-found');
  expect(
    (await lookup('never fall back to scientific material lookup', null, 'synthetic-material'))
      .resolution.kind
  ).toBe('not-found');
  const empty = await lookup(
    'resolve an empty physical container without stock creation',
    'vendor',
    '00123'
  );
  expect(empty.targets).toHaveLength(1);
  expect(empty.targets[0].stocks).toEqual([]);
  const ambiguous = await lookup(
    'keep identical text in distinct namespaces ambiguous',
    null,
    '00123'
  );
  expect(ambiguous.resolution).toMatchObject({ kind: 'ambiguous' });
  if (ambiguous.resolution.kind !== 'ambiguous') throw new Error('Expected ambiguity.');
  expect(ambiguous.resolution.matches.map((row) => row.id).sort()).toEqual([
    'code-internal',
    'code-vendor',
  ]);
  await refuse('refuse a new duplicate attachment even to the same item', [
    code('duplicate-same', 'internal', '00123', { kind: 'vessel', id: 'code-tube' }),
  ]);
  await refuse('refuse assigning the same tuple to another item', [
    code('duplicate-other', 'internal', '00123', { kind: 'vessel', id: 'code-empty' }),
  ]);
  await refuse('roll back an entire mixed attachment batch', [
    {
      kind: 'create-vessel',
      id: 'code-rollback',
      name: 'Must not survive',
      placement: { kind: 'unplaced' },
    },
    code('duplicate-rollback', 'internal', '00123', { kind: 'vessel', id: 'code-rollback' }),
  ]);
  await commit('retain a quantity hold while identifying missing stock', [
    {
      kind: 'reserve-quantity',
      id: 'code-hold',
      stockId: 'code-stock',
      quantity: { value: '30', unit: 'uL' },
      deadline: null,
      purpose: 'Synthetic scan conservation',
    },
    {
      kind: 'report-item-missing',
      item: { kind: 'vessel', id: 'code-tube' },
      reason: 'Synthetic observed absence; scanning must not locate it',
    },
  ]);
  const missing = await lookup(
    'a code match does not locate missing material',
    'internal',
    '00123'
  );
  expect(missing.resolution.kind).toBe('resolved');
  expect(missing.targets[0]).toMatchObject({
    currentLocationPath: null,
    custody: { state: { kind: 'missing' } },
  });
  expect(missing.targets[0].stocks[0].stock.quantity).toEqual({
    kind: 'known',
    value: '100',
    unit: 'uL',
  });
  await commit('retire a binding without changing its target or custody', [
    {
      kind: 'retire-item-code',
      codeId: 'code-internal',
      reason: 'Synthetic retired label remains historically identifiable',
    },
  ]);
  const retired = await lookup(
    'resolve a retired binding to its original target',
    'internal',
    '00123'
  );
  expect(retired.resolution).toMatchObject({
    kind: 'retired',
    match: { id: 'code-internal', item: { kind: 'vessel', id: 'code-tube' } },
  });
  const mixed = await lookup('retired matches still participate in ambiguity', null, '00123');
  expect(mixed.resolution.kind).toBe('ambiguous');
  if (mixed.resolution.kind !== 'ambiguous') throw new Error('Expected retained ambiguity.');
  expect(mixed.resolution.matches.map((row) => row.lifecycle.kind).sort()).toEqual([
    'active',
    'retired',
  ]);
  await refuse('never reassign a retired tuple', [
    code('retired-reassignment', 'internal', '00123', { kind: 'vessel', id: 'code-empty' }),
  ]);
  await refuse('refuse repeated retirement under a new operation', [
    { kind: 'retire-item-code', codeId: 'code-internal', reason: 'Synthetic repeated retirement' },
  ]);
  await commit('dispose an empty target independently of code lifecycle', [
    { kind: 'dispose-vessel', id: 'code-empty', reason: 'Synthetic historical identity lookup' },
  ]);
  const disposed = await lookup(
    'identify a disposed target without retiring its code automatically',
    'vendor',
    '00123'
  );
  expect(disposed.resolution.kind).toBe('resolved');
  expect(disposed.targets[0].record.lifecycle).toBe('disposed');
  const otherScope = { ...scope, inventoryId: 'inventory-item-codes-other' };
  expect(
    await ctx.success<NativeInventoryExecution>(
      'assign the same bare item ID and tuple in another inventory explicitly',
      'inventory.execute',
      {
        ...otherScope,
        operationId: 'codes:other-inventory',
        expectedRevision: 0,
        commands: [
          {
            kind: 'create-vessel',
            id: 'code-tube',
            name: 'Different inventory tube',
            placement: { kind: 'unplaced' },
          },
          code('code-internal', 'internal', '00123', { kind: 'vessel', id: 'code-tube' }),
          code('code-other-only', 'internal', 'other-only', { kind: 'vessel', id: 'code-tube' }),
        ],
      }
    )
  ).toMatchObject({ status: 'committed' });
  const otherLookup = await ctx.success<InventoryItemCodeLookupSnapshot>(
    'resolve only inside the explicitly requested other inventory',
    'inventory.resolve-item-code',
    { ...otherScope, query: { namespace: 'internal', value: '00123' } }
  );
  expect(otherLookup).toMatchObject({
    inventoryId: otherScope.inventoryId,
    resolution: { kind: 'resolved' },
  });
  expect(otherLookup.targets[0].record.name).toBe('Different inventory tube');
  expect(
    (await lookup('never search another inventory implicitly', 'internal', 'other-only')).resolution
      .kind
  ).toBe('not-found');
  const state: InventoryState = ctx.owner.inspect(scope)!;
  expect(state.stocks['code-stock'].quantity).toEqual({ kind: 'known', value: '100', unit: 'uL' });
  expect(state.reservations['code-hold']).toMatchObject({ lifecycle: { kind: 'active' } });
  return {
    scope,
    state,
    history: ctx.owner.history(scope),
    availability: ctx.owner.availability(scope),
    attachRequest,
    attachReceipt,
    retiredLookup: await lookup('capture retired code before native restart', 'internal', '00123'),
    otherLookup,
  };
}

export async function verifyNativeItemCodeReopen(
  ctx: NativeItemCodeJourneyContext,
  before: Awaited<ReturnType<typeof runNativeItemCodeJourney>>
) {
  expect(ctx.owner.inspect(before.scope)).toEqual(before.state);
  expect(ctx.owner.history(before.scope)).toEqual(before.history);
  expect(ctx.owner.availability(before.scope)).toEqual(before.availability);
  const replay = ctx.owner.replay(before.scope);
  expect(replay).toEqual({ state: before.state, acceptedOperations: before.history.length });
  const retry = await ctx.success<NativeInventoryExecution>(
    'recover original attachment after retirement and native restart without reactivation',
    'inventory.execute',
    before.attachRequest
  );
  expect(retry).toEqual(before.attachReceipt);
  expect(ctx.owner.inspect(before.scope)).toEqual(before.state);
  const lookup = await ctx.success<InventoryItemCodeLookupSnapshot>(
    'read exact retired code snapshot after native reopen',
    'inventory.resolve-item-code',
    { ...before.scope, query: { namespace: 'internal', value: '00123' } }
  );
  expect(lookup).toEqual(before.retiredLookup);
  return {
    state: ctx.owner.inspect(before.scope),
    history: ctx.owner.history(before.scope),
    availability: ctx.owner.availability(before.scope),
    replay,
    receipt: retry,
    lookup,
  };
}
