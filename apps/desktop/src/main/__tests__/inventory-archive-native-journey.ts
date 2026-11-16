import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { InventoryCommand, InventoryPrincipal } from '@waypoint/domain-services';
import type { createNativeInventoryOwner } from '../inventory-owner';
import type {
  InventoryAcceptedRequest,
  InventoryApplyImportRequest,
  InventoryReadRequest,
  NativeInventoryExecution,
  NativeInventoryReceipt,
} from '../../shared/inventory-command';
import type {
  InventoryExportSnapshot,
  InventoryImportPreviewSnapshot,
} from '../../shared/inventory-client';

type Command =
  | 'inventory.execute'
  | 'inventory.export-snapshot'
  | 'inventory.preview-import'
  | 'inventory.apply-import';
const agent = {
  identityId: 'synthetic-inventory-writer',
  capabilities: ['read-workspace', 'write-workspace'],
};
const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
interface ArchiveContext {
  scope: InventoryReadRequest;
  projectId: string;
  owner: ReturnType<typeof createNativeInventoryOwner>;
  success<T>(
    label: string,
    command: Command,
    request: unknown,
    options?: { agent?: typeof agent }
  ): Promise<T>;
  loseAcknowledgement(
    request: InventoryAcceptedRequest,
    evidenceKey?: string
  ): Promise<NativeInventoryReceipt>;
}

export async function runNativeArchiveJourney(ctx: ArchiveContext) {
  const source = { ...ctx.scope, inventoryId: 'inventory-archive-source' };
  const target = { ...ctx.scope, inventoryId: 'inventory-archive-adopted' };
  const again = { ...ctx.scope, inventoryId: 'inventory-archive-re-adopted' };
  const literal = ' 00123^FNC1^029ABCabc ';
  const setup = await ctx.success<NativeInventoryExecution>(
    'create source facts with real granted agent responsibility',
    'inventory.execute',
    {
      ...source,
      operationId: 'archive:source-fixture',
      expectedRevision: 0,
      commands: [
        {
          kind: 'create-storage',
          id: 'archive-freezer',
          name: 'Synthetic archive environment',
          slots: ['A', 'B'],
          placement: { kind: 'root' },
        },
        {
          kind: 'create-vessel',
          id: 'archive-tube',
          name: 'Synthetic archive tube',
          placement: { kind: 'located', storageId: 'archive-freezer', slotId: 'A' },
        },
        {
          kind: 'create-lot',
          id: 'archive-lot',
          materialId: 'synthetic-material',
          name: 'Synthetic archive formulation',
          origin: { kind: 'received', supplier: 'Synthetic acceptance', lotNumber: 'ARCHIVE-1' },
        },
        {
          kind: 'receive-lot-stock',
          id: 'archive-stock',
          vesselId: 'archive-tube',
          lotId: 'archive-lot',
          quantity: { kind: 'known', value: '100', unit: 'uL' },
          quality: 'usable',
        },
        {
          kind: 'reserve-quantity',
          id: 'archive-hold',
          stockId: 'archive-stock',
          quantity: { value: '25', unit: 'uL' },
          deadline: null,
          purpose: 'Synthetic source responsibility',
        },
        {
          kind: 'checkout-item',
          item: { kind: 'vessel', id: 'archive-tube' },
          dueAt: null,
          reason: 'Synthetic source custody is not destination authority',
        },
        {
          kind: 'attach-item-code',
          id: 'archive-code',
          namespace: 'archive',
          value: literal,
          item: { kind: 'vessel', id: 'archive-tube' },
          reason: 'Synthetic exact item alias',
        },
        {
          kind: 'record-thermal-context',
          item: { kind: 'storage', id: 'archive-freezer' },
          value: { kind: 'self' },
          observedAt: null,
          source: null,
          reason: 'Synthetic explicit independent temperature control',
        },
        {
          kind: 'record-equipment-setpoint',
          item: { kind: 'storage', id: 'archive-freezer' },
          value: { kind: 'known', temperature: { value: '-80', unit: 'C' } },
          observedAt: null,
          source: null,
          reason: 'Synthetic operator report',
        },
        {
          kind: 'record-storage-requirement',
          target: { kind: 'lot', id: 'archive-lot' },
          value: {
            kind: 'specified',
            range: { minimum: { value: '-85', unit: 'C' }, maximum: { value: '-75', unit: 'C' } },
          },
          observedAt: null,
          source: null,
          reason: 'Synthetic formulation requirement',
        },
      ] satisfies readonly InventoryCommand[],
    },
    { agent }
  );
  expect(setup).toMatchObject({
    status: 'committed',
    context: { principal: { kind: 'agent', identityId: agent.identityId } },
  });
  const sourceState = ctx.owner.inspect(source)!;
  const sourceHistory = ctx.owner.history(source);
  const artifact = await ctx.success<InventoryExportSnapshot>(
    'export one raw source state and complete journal snapshot',
    'inventory.export-snapshot',
    { ...source, format: 'native-v1' }
  );
  expect(artifact.source).toMatchObject({
    projectId: ctx.projectId,
    inventoryId: source.inventoryId,
    revision: 1,
    storedSchema: 'dnaforge.inventory.v16',
  });
  expect(hash(artifact.sourceText)).toBe(artifact.sourceSha256);
  const document = JSON.parse(artifact.sourceText);
  expect(JSON.parse(document.content.state.json)).toEqual(sourceState);
  expect(JSON.parse(document.content.history[0].requestJson)).toEqual(sourceHistory[0].request);
  expect(JSON.parse(document.content.history[0].receiptJson)).toEqual(sourceHistory[0].receipt);
  const repeated = await ctx.success<InventoryExportSnapshot>(
    'capture unchanged source without incidental file timestamp',
    'inventory.export-snapshot',
    { ...source, format: 'native-v1' }
  );
  expect(repeated.sourceText).toBe(artifact.sourceText);
  expect(repeated.sourceSha256).toBe(artifact.sourceSha256);
  const blocked = await ctx.success<InventoryImportPreviewSnapshot>(
    'preview missing scientific binding without creating destination',
    'inventory.preview-import',
    { ...target, sourceText: artifact.sourceText, options: { bindings: [] } }
  );
  expect(blocked.kind).toBe('blocked');
  expect(blocked.scientificReferences.map((reference) => reference.materialId)).toEqual([
    'synthetic-material',
  ]);
  expect(ctx.owner.inspect(target)).toBeNull();
  const options = {
    bindings: [
      { sourceMaterialId: 'synthetic-material', destinationMaterialId: 'synthetic-material' },
    ],
  };
  const previewRequest = { ...target, sourceText: artifact.sourceText, options };
  const preview = await ctx.success<InventoryImportPreviewSnapshot>(
    'preview explicit admitted scientific binding and foreign responsibilities',
    'inventory.preview-import',
    previewRequest
  );
  expect(preview.kind).toBe('ready');
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  expect(preview.responsibilities.activeReservationIds).toEqual(['archive-hold']);
  expect(preview.responsibilities.unavailableItems).toContainEqual({
    kind: 'vessel',
    id: 'archive-tube',
  });
  expect(ctx.owner.inspect(target)).toBeNull();
  const request: InventoryApplyImportRequest = {
    kind: 'adopt-archive',
    ...target,
    operationId: 'archive:lost-adoption',
    expectedRevision: 0,
    sourceText: artifact.sourceText,
    options: preview.options,
    expectedPlanDigest: preview.planDigest,
  };
  const receipt = await ctx.loseAcknowledgement(request, 'archiveLostAcknowledgement');
  expect(receipt).toMatchObject({ revision: 1 });
  const adopted = ctx.owner.inspect(target)!;
  expect(adopted.origin).toMatchObject({
    kind: 'archive-adoption',
    source: {
      archiveSha256: artifact.sourceSha256,
      projectId: ctx.projectId,
      inventoryId: source.inventoryId,
      revision: 1,
    },
    at: receipt.recordedAt,
    by: receipt.context!.principal,
  });
  expect(adopted.stocks).toEqual(sourceState.stocks);
  expect(adopted.vessels['archive-tube'].custody).toMatchObject({
    kind: 'checked-out',
    holder: { kind: 'imported', principal: { kind: 'agent', identityId: agent.identityId } },
  });
  expect(adopted.reservations['archive-hold'].holder).toMatchObject({
    kind: 'imported',
    principal: { kind: 'agent', identityId: agent.identityId },
  });
  expect(adopted.itemCodes['archive-code'].value).toBe(literal);
  expect(adopted.thermalContexts['storage:archive-freezer'].by.kind).toBe('imported');
  const principal: InventoryPrincipal = { kind: 'agent', identityId: agent.identityId };
  const availability = ctx.owner.availability(target, { principal })!;
  expect(availability.reservations['archive-hold'].mine).toBe(false);
  const beforeRefusals = ctx.owner.inspect(target)!;
  const historyBeforeRefusals = ctx.owner.history(target);
  for (const [label, command, input] of [
    [
      'same current agent cannot release an imported hold',
      'inventory.execute',
      {
        ...target,
        operationId: 'archive:no-agent-alias-ownership',
        expectedRevision: 1,
        commands: [
          {
            kind: 'release-reservation',
            reservationId: 'archive-hold',
            reason: 'Synthetic raw identity collision must not own source hold',
          },
        ],
      },
    ],
    [
      'same archive under a new operation cannot duplicate stock',
      'inventory.apply-import',
      { ...request, operationId: 'archive:no-duplicate-adoption', expectedRevision: 1 },
    ],
    [
      'changed archive bytes cannot reuse the committed operation identity',
      'inventory.apply-import',
      { ...request, sourceText: request.sourceText + '\n' },
    ],
  ] as const) {
    const result = await ctx.success<NativeInventoryExecution>(label, command, input, { agent });
    expect(result.status, label).toBe('rejected');
    expect(ctx.owner.inspect(target), label).toEqual(beforeRefusals);
    expect(ctx.owner.history(target), label).toEqual(historyBeforeRefusals);
  }
  const correction = await ctx.success<NativeInventoryExecution>(
    'local explicit cancellation and custody recovery remain reasoned native actions',
    'inventory.execute',
    {
      ...target,
      operationId: 'archive:explicit-destination-recovery',
      expectedRevision: 1,
      commands: [
        {
          kind: 'cancel-reservation',
          reservationId: 'archive-hold',
          reason: 'Synthetic explicit local cancellation of retained foreign responsibility',
        },
        {
          kind: 'return-item',
          item: { kind: 'vessel', id: 'archive-tube' },
          destination: { kind: 'located', storageId: 'archive-freezer', slotId: 'A' },
          reason: 'Synthetic explicit local recovery of retained foreign custody',
        },
      ],
    }
  );
  expect(correction.status).toBe('committed');
  expect(
    await ctx.success(
      'retry original lost adoption after later local corrections',
      'inventory.apply-import',
      request
    )
  ).toEqual(receipt);
  const finalState = ctx.owner.inspect(target)!;
  expect(finalState.stocks['archive-stock'].quantity).toEqual({
    kind: 'known',
    value: '100',
    unit: 'uL',
  });
  const finalHistory = ctx.owner.history(target);
  expect(finalHistory).toHaveLength(2);
  expect(finalHistory[0].request).toEqual({ ...request, project: ctx.projectId });
  expect(ctx.owner.replay(target)).toEqual({ state: finalState, acceptedOperations: 2 });
  const reexport = await ctx.success<InventoryExportSnapshot>(
    're-export destination while retaining nested original source bytes',
    'inventory.export-snapshot',
    { ...target, format: 'native-v1' }
  );
  const reexportDocument = JSON.parse(reexport.sourceText);
  expect(JSON.parse(reexportDocument.content.history[0].requestJson).sourceText).toBe(
    artifact.sourceText
  );
  const againPreview = await ctx.success<InventoryImportPreviewSnapshot>(
    'validate recursive accepted adoption and flat attribution on a fresh target',
    'inventory.preview-import',
    { ...again, sourceText: reexport.sourceText, options }
  );
  expect(againPreview.kind).toBe('ready');
  if (againPreview.kind !== 'ready') throw new Error(JSON.stringify(againPreview));
  const againRequest: InventoryApplyImportRequest = {
    kind: 'adopt-archive',
    ...again,
    operationId: 'archive:re-adopt',
    expectedRevision: 0,
    sourceText: reexport.sourceText,
    options: againPreview.options,
    expectedPlanDigest: againPreview.planDigest,
  };
  expect(
    await ctx.success<NativeInventoryExecution>(
      'adopt re-export without nesting foreign principal wrappers',
      'inventory.apply-import',
      againRequest
    )
  ).toMatchObject({ status: 'committed' });
  const againState = ctx.owner.inspect(again)!;
  expect(againState.reservations['archive-hold'].holder).toEqual(
    finalState.reservations['archive-hold'].holder
  );
  expect(ctx.owner.inspect(source)).toEqual(sourceState);
  expect(ctx.owner.history(source)).toEqual(sourceHistory);
  return {
    source,
    target,
    again,
    sourceState,
    sourceHistory,
    artifact,
    previewRequest,
    preview,
    request,
    receipt,
    finalState,
    finalHistory,
    reexport,
    againState,
    againHistory: ctx.owner.history(again),
  };
}

export async function verifyNativeArchiveReopen(
  ctx: ArchiveContext,
  before: Awaited<ReturnType<typeof runNativeArchiveJourney>>
) {
  expect(ctx.owner.inspect(before.source)).toEqual(before.sourceState);
  expect(ctx.owner.history(before.source)).toEqual(before.sourceHistory);
  expect(ctx.owner.inspect(before.target)).toEqual(before.finalState);
  expect(ctx.owner.history(before.target)).toEqual(before.finalHistory);
  expect(ctx.owner.inspect(before.again)).toEqual(before.againState);
  expect(ctx.owner.history(before.again)).toEqual(before.againHistory);
  expect(
    await ctx.success(
      'recover original archive adoption receipt after SQLite/server reopen',
      'inventory.apply-import',
      before.request
    )
  ).toEqual(before.receipt);
  const artifact = await ctx.success<InventoryExportSnapshot>(
    're-export exact destination after native reopen',
    'inventory.export-snapshot',
    { ...before.target, format: 'native-v1' }
  );
  expect(artifact.sourceText).toBe(before.reexport.sourceText);
  expect(artifact.sourceSha256).toBe(before.reexport.sourceSha256);
  const replay = ctx.owner.replay(before.target);
  expect(replay).toEqual({
    state: before.finalState,
    acceptedOperations: before.finalHistory.length,
  });
  return {
    state: ctx.owner.inspect(before.target),
    history: ctx.owner.history(before.target),
    artifact,
    replay,
  };
}
