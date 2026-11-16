import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { createNativeInventoryOwner } from '../inventory-owner';
import type {
  InventoryExecuteRequest,
  InventoryReadRequest,
  NativeInventoryExecution,
} from '../../shared/inventory-command';
import type { InventoryLabelArtifact } from '../../shared/inventory-client';

type Command = 'inventory.execute' | 'inventory.prepare-label';
interface LabelContext {
  scope: InventoryReadRequest;
  projectId: string;
  owner: ReturnType<typeof createNativeInventoryOwner>;
  success<T>(label: string, command: Command, request: unknown): Promise<T>;
  call(
    label: string,
    command: Command,
    request: unknown
  ): Promise<{ status: number; body: { ok: boolean; result?: unknown } }>;
}

export async function runNativeLabelJourney(ctx: LabelContext) {
  const scope = { ...ctx.scope, inventoryId: 'inventory-labels' };
  const request: InventoryExecuteRequest = {
    ...scope,
    operationId: 'labels:literal-aliases',
    expectedRevision: 0,
    commands: [
      {
        kind: 'create-vessel',
        id: 'code-tube',
        name: 'Synthetic label target',
        placement: { kind: 'unplaced' },
      },
      {
        kind: 'receive-stock',
        id: 'label-stock',
        vesselId: 'code-tube',
        materialId: 'synthetic-material',
        quantity: { kind: 'known', value: '100', unit: 'uL' },
        quality: 'usable',
      },
      {
        kind: 'reserve-quantity',
        id: 'label-hold',
        stockId: 'label-stock',
        quantity: { value: '30', unit: 'uL' },
        deadline: null,
        purpose: 'Synthetic label rendering conservation',
      },
      {
        kind: 'report-item-missing',
        item: { kind: 'vessel', id: 'code-tube' },
        reason: 'Synthetic preparation must not locate the label target',
      },
      {
        kind: 'attach-item-code',
        id: 'label-literal',
        namespace: 'labels',
        value: ' 00123^FNC1^029ABCabc ',
        item: { kind: 'vessel', id: 'code-tube' },
        reason: 'Synthetic literal label encoding; no physical scan claim',
      },
      {
        kind: 'attach-item-code',
        id: 'label-long',
        namespace: 'labels',
        value: '0123456789'.repeat(51) + '01',
        item: { kind: 'vessel', id: 'code-tube' },
        reason: 'Synthetic valid alias that cannot fit the small media',
      },
    ],
  };
  expect(
    await ctx.success<NativeInventoryExecution>(
      'attach exact literal label fixtures',
      'inventory.execute',
      request
    )
  ).toMatchObject({ status: 'committed' });
  const state = ctx.owner.inspect(scope)!;
  const history = ctx.owner.history(scope);
  const unchanged = async <T>(work: () => Promise<T>) => {
    const result = await work();
    expect(ctx.owner.inspect(scope)).toEqual(state);
    expect(ctx.owner.history(scope)).toEqual(history);
    return result;
  };
  const artifact = await unchanged(() =>
    ctx.success<InventoryLabelArtifact>(
      'prepare exact literal QR label through the native read owner',
      'inventory.prepare-label',
      { ...scope, codeId: 'label-literal', mediaProfileId: 'qr-50x30-300dpi' }
    )
  );
  expect(artifact).toMatchObject({
    projectId: ctx.projectId,
    inventoryId: scope.inventoryId,
    sourceRevision: state.revision,
    binding: state.itemCodes['label-literal'],
  });
  expect(artifact.rendered.spec.binding.value).toBe(' 00123^FNC1^029ABCabc ');
  expect(artifact.svgSha256).toBe(
    `sha256:${createHash('sha256').update(artifact.rendered.svg).digest('hex')}`
  );
  expect(artifact.target.record).toEqual(state.vessels['code-tube']);
  expect(artifact.target.currentLocationPath).toBeNull();
  expect(artifact.target.custody.state.kind).toBe('missing');
  expect(artifact.target.stocks[0].stock.quantity).toEqual({
    kind: 'known',
    value: '100',
    unit: 'uL',
  });
  for (const [label, request, expectedCode] of [
    [
      'refuse unknown code label preparation',
      { ...scope, codeId: 'unknown-label-code', mediaProfileId: 'qr-50x30-300dpi' },
      'INVENTORY_ITEM_CODE_NOT_FOUND',
    ],
    [
      'refuse new preparation of a retired binding',
      {
        ...scope,
        inventoryId: 'inventory-item-codes',
        codeId: 'code-internal',
        mediaProfileId: 'qr-50x30-300dpi',
      },
      'INVENTORY_ITEM_CODE_RETIRED',
    ],
    [
      'refuse new preparation for a disposed physical target',
      {
        ...scope,
        inventoryId: 'inventory-item-codes',
        codeId: 'code-vendor',
        mediaProfileId: 'qr-50x30-300dpi',
      },
      'INVENTORY_LABEL_TARGET_DISPOSED',
    ],
    [
      'refuse long alias overflow instead of shortening identity',
      { ...scope, codeId: 'label-long', mediaProfileId: 'qr-50x30-300dpi' },
      'INVENTORY_LABEL_LAYOUT_OVERFLOW',
    ],
  ] as const) {
    const read = { project: request.project, inventoryId: request.inventoryId };
    const current = ctx.owner.inspect(read);
    const currentHistory = ctx.owner.history(read);
    const result = await ctx.call(label, 'inventory.prepare-label', request);
    expect(result, label).toMatchObject({
      status: 200,
      body: { ok: true, result: { ok: false, code: expectedCode, stateChanged: false } },
    });
    expect(ctx.owner.inspect(read)).toEqual(current);
    expect(ctx.owner.history(read)).toEqual(currentHistory);
  }
  return {
    scope,
    state,
    history,
    artifact,
    request: { ...scope, codeId: 'label-literal', mediaProfileId: 'qr-50x30-300dpi' },
  };
}

export async function verifyNativeLabelReopen(
  ctx: LabelContext,
  before: Awaited<ReturnType<typeof runNativeLabelJourney>>
) {
  expect(ctx.owner.inspect(before.scope)).toEqual(before.state);
  expect(ctx.owner.history(before.scope)).toEqual(before.history);
  const artifact = await ctx.success<InventoryLabelArtifact>(
    'prepare the exact label after native reopen without inventory mutation',
    'inventory.prepare-label',
    before.request
  );
  expect(artifact.rendered).toEqual(before.artifact.rendered);
  expect(artifact.svgSha256).toEqual(before.artifact.svgSha256);
  expect(ctx.owner.inspect(before.scope)).toEqual(before.state);
  expect(ctx.owner.history(before.scope)).toEqual(before.history);
  return {
    state: ctx.owner.inspect(before.scope),
    history: ctx.owner.history(before.scope),
    artifact,
  };
}
