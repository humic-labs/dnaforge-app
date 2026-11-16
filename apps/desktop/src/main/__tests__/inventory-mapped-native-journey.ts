import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { inventoryWellId, type InventoryMappedTableChoices } from '@waypoint/domain-services';
import type { createNativeInventoryOwner } from '../inventory-owner';
import type {
  InventoryAcceptedRequest,
  InventoryApplyMappedTableRequest,
  InventoryReadRequest,
  NativeInventoryExecution,
  NativeInventoryReceipt,
} from '../../shared/inventory-command';
import type {
  InventoryExportSnapshot,
  InventoryImportPreviewSnapshot,
  InventoryMappedTablePreviewSnapshot,
  InventorySourceRevisionPreviewSnapshot,
} from '../../shared/inventory-client';

type Command =
  | 'inventory.execute'
  | 'inventory.preview-mapped-table'
  | 'inventory.apply-mapped-table'
  | 'inventory.preview-source-revision'
  | 'inventory.export-snapshot'
  | 'inventory.preview-import'
  | 'inventory.apply-import';
interface MappedContext {
  scope: InventoryReadRequest;
  projectId: string;
  owner: ReturnType<typeof createNativeInventoryOwner>;
  success<T>(label: string, command: Command, request: unknown): Promise<T>;
  loseAcknowledgement(
    request: InventoryAcceptedRequest,
    evidenceKey?: string
  ): Promise<NativeInventoryReceipt>;
}

export async function runNativeMappedJourney(ctx: MappedContext) {
  const scope = { ...ctx.scope, inventoryId: 'inventory-mapped-spreadsheet' };
  const adopted = { ...ctx.scope, inventoryId: 'inventory-mapped-adopted' };
  const sourceText = readFileSync(
    new URL(
      '../../../../../test-fixtures/lims-import/walkthrough/primers-messy.csv',
      import.meta.url
    ),
    'utf8'
  );
  await ctx.success('prepare explicitly sized plates for mapped source', 'inventory.execute', {
    ...scope,
    operationId: 'mapped:plates',
    expectedRevision: 0,
    commands: ['7', '8'].map((number) => ({
      kind: 'create-layout-storage',
      id: `mapped-plate-${number}`,
      name: `Synthetic explicitly sized Plate-${number}`,
      layout: { kind: 'fixed-well', rows: 2, columns: 2 },
      placement: { kind: 'root' },
    })),
  });
  const options: InventoryMappedTableChoices = {
    namespace: 'synthetic:mapped:primer-register',
    delimiter: ',',
    columns: { sourceId: 'Primer ID', plate: 'Plate', well: 'Well' },
    materials: ['MP001', 'MP002', 'MP003'].map((sourceId) => ({
      sourceId,
      materialId: 'synthetic-material',
    })),
    plates: [
      {
        sourcePlate: 'Plate-7',
        storageId: 'mapped-plate-7',
        positions: [
          { sourceWell: 'A01', position: 'A1' },
          { sourceWell: 'A02', position: 'A2' },
        ],
      },
      {
        sourcePlate: 'Plate-8',
        storageId: 'mapped-plate-8',
        positions: [{ sourceWell: 'B01', position: 'B1' }],
      },
    ],
    quantity: {
      kind: 'unknown',
      reason: 'The representative source contains no volume measurements',
    },
    qualities: ['MP001', 'MP002', 'MP003'].map((sourceId) => ({
      sourceId,
      quality: sourceId === 'MP002' ? 'quarantined' : 'usable',
      reason: 'Explicit synthetic quality decision independent from source QC text',
    })),
    evidenceOnlyColumns: [
      'Oligo Sequence',
      'Owner',
      'Order Date',
      'Supplier',
      'Project',
      'Notes',
      'Melting Temp',
      'QC Flag',
      'Freezer Box',
      'Legacy ID',
    ].map((column) => ({
      column,
      reason: 'Retain original source evidence without inferring a physical inventory fact',
    })),
    skips: [],
  };
  const inspect = () => ctx.owner.inspect(scope)!;
  const initial = inspect();
  const preview = (text = sourceText, choices = options, target = scope) =>
    ctx.success<InventoryMappedTablePreviewSnapshot>(
      'preview exact representative primer spreadsheet interpretation',
      'inventory.preview-mapped-table',
      { ...target, format: 'mapped-plate-v1', sourceText: text, options: choices }
    );
  const blocked = await preview(sourceText, {
    ...options,
    materials: [],
    plates: [],
    qualities: [],
    evidenceOnlyColumns: [],
  });
  expect(blocked.kind).toBe('blocked');
  expect(inspect()).toEqual(initial);
  const plan = await preview();
  if (plan.kind !== 'ready')
    throw new Error(`Expected explicit mapped receipt: ${JSON.stringify(plan.issues)}`);
  expect(plan.rows).toHaveLength(3);
  expect(plan.rows.map((row) => row.sourceId)).toEqual(['MP001', 'MP002', 'MP003']);
  expect(plan.headers).toHaveLength(13);
  const request: InventoryApplyMappedTableRequest = {
    ...scope,
    kind: 'receive-mapped-table',
    operationId: 'mapped:receive-once',
    expectedRevision: 1,
    sourceText,
    options: plan.options,
    expectedPlanDigest: plan.planDigest,
  };
  const receipt = await ctx.loseAcknowledgement(request, 'mappedTableLostAcknowledgement');
  expect(
    await ctx.success(
      'retry exact mapped receipt after lost response',
      'inventory.apply-mapped-table',
      request
    )
  ).toEqual(receipt);
  expect(
    await ctx.success<NativeInventoryExecution>(
      'same mapped operation conflicts with changed source bytes',
      'inventory.apply-mapped-table',
      { ...request, sourceText: sourceText + '\n' }
    )
  ).toMatchObject({ status: 'rejected', code: 'INVENTORY_OPERATION_CONFLICT' });
  const received = inspect();
  const bindings = Object.values(received.tableBindings).filter(
    (binding) => binding.namespace === options.namespace
  );
  expect(bindings).toHaveLength(3);
  for (const binding of bindings)
    expect(received.stocks[binding.stockId].quantity).toEqual({ kind: 'unknown' });
  expect(bindings.find((binding) => binding.sourceId === 'MP001')!.vesselId).toBe(
    inventoryWellId('mapped-plate-7', 'A1')
  );
  expect(bindings.find((binding) => binding.sourceId === 'MP002')!.vesselId).toBe(
    inventoryWellId('mapped-plate-7', 'A2')
  );
  expect(bindings.find((binding) => binding.sourceId === 'MP003')!.vesselId).toBe(
    inventoryWellId('mapped-plate-8', 'B1')
  );
  expect(
    received.stocks[bindings.find((binding) => binding.sourceId === 'MP002')!.stockId].quality
  ).toBe('quarantined');
  const lines = sourceText.trimEnd().split('\n');
  const reordered = [lines[0], ...lines.slice(1).reverse()].join('\n') + '\n';
  expect((await preview(reordered)).kind).toBe('no-change');
  const binding = bindings.find((binding) => binding.sourceId === 'MP001')!;
  await ctx.success(
    'measure and use physical stock after unknown source receipt',
    'inventory.execute',
    {
      ...scope,
      operationId: 'mapped:later-measurement-and-use',
      expectedRevision: received.revision,
      commands: [
        {
          kind: 'reconcile',
          stockId: binding.stockId,
          quantity: { kind: 'known', value: '10', unit: 'uL' },
          reason: 'Synthetic later measurement separate from unknown source',
        },
        {
          kind: 'consume',
          stockId: binding.stockId,
          quantity: { value: '2', unit: 'uL' },
          reason: 'Synthetic later use must survive spreadsheet reimport',
        },
      ],
    }
  );
  const state = inspect();
  expect(state.stocks[binding.stockId].quantity).toEqual({ kind: 'known', value: '8', unit: 'uL' });
  expect((await preview()).kind).toBe('no-change');
  const evidenceOnly = await preview(
    sourceText.replace('M13 forward control', 'Revised source note only')
  );
  expect(evidenceOnly.kind).toBe('no-change');
  expect(inspect()).toEqual(state);
  expect(
    (
      await preview(sourceText, {
        ...options,
        plates: options.plates.map((plate) =>
          plate.sourcePlate === 'Plate-7'
            ? {
                ...plate,
                positions: plate.positions.map((position) =>
                  position.sourceWell === 'A01' ? { ...position, position: 'B2' } : position
                ),
              }
            : plate
        ),
      })
    ).kind
  ).toBe('blocked');
  const normalized = plan.normalizedSourceText!;
  const normalizedOptions = {
    namespace: options.namespace,
    delimiter: ',' as const,
    materials: options.materials.map((material) => ({
      key: material.sourceId,
      materialId: material.materialId,
    })),
    locations: [],
    vessels: bindings.map((binding) => ({ key: binding.sourceId, vesselId: binding.vesselId })),
    skips: [],
  };
  const comparison = await ctx.success<InventorySourceRevisionPreviewSnapshot>(
    'discover physical source preimages from retained raw mapped request',
    'inventory.preview-source-revision',
    {
      ...scope,
      format: 'receive-v1',
      sourceText: normalized,
      options: { table: normalizedOptions, acknowledgements: [] },
    }
  );
  expect(comparison.kind).toBe('no-change');
  expect(comparison.rows.every((row) => row.previousFields !== null)).toBe(true);
  const artifact = await ctx.success<InventoryExportSnapshot>(
    'export original thirteen-column source and every explicit mapping decision',
    'inventory.export-snapshot',
    { ...scope, format: 'native-v1' }
  );
  const saved = JSON.parse(artifact.sourceText)
    .content.history.map((entry: { requestJson: string }) => JSON.parse(entry.requestJson))
    .find((entry: InventoryAcceptedRequest) => entry.operationId === request.operationId);
  expect(saved).toEqual({ ...request, project: ctx.projectId });
  const adoption = await ctx.success<InventoryImportPreviewSnapshot>(
    'preview archive containing mapped spreadsheet receipts',
    'inventory.preview-import',
    {
      ...adopted,
      sourceText: artifact.sourceText,
      options: {
        bindings: [
          { sourceMaterialId: 'synthetic-material', destinationMaterialId: 'synthetic-material' },
        ],
      },
    }
  );
  if (adoption.kind !== 'ready') throw new Error('Expected mapped receipt archive adoption.');
  await ctx.success(
    'adopt mapped physical stocks without regenerating identities',
    'inventory.apply-import',
    {
      ...adopted,
      kind: 'adopt-archive',
      operationId: 'mapped:adopt',
      expectedRevision: 0,
      sourceText: artifact.sourceText,
      options: adoption.options,
      expectedPlanDigest: adoption.planDigest,
    }
  );
  const adoptedState = ctx.owner.inspect(adopted)!;
  expect(adoptedState.tableBindings).toEqual(state.tableBindings);
  expect((await preview(reordered, options, adopted)).kind).toBe('no-change');
  return {
    scope,
    adopted,
    sourceText,
    reordered,
    options,
    request,
    receipt,
    initial,
    received,
    state,
    history: ctx.owner.history(scope),
    adoptedState,
    artifact,
    comparison,
    evidenceOnly,
    normalized,
  };
}

export async function verifyNativeMappedReopen(
  ctx: MappedContext,
  before: Awaited<ReturnType<typeof runNativeMappedJourney>>
) {
  expect(ctx.owner.inspect(before.scope)).toEqual(before.state);
  expect(ctx.owner.history(before.scope)).toEqual(before.history);
  expect(ctx.owner.replay(before.scope)).toEqual({
    state: before.state,
    acceptedOperations: before.state.revision,
  });
  expect(ctx.owner.inspect(before.adopted)).toEqual(before.adoptedState);
  expect(ctx.owner.replay(before.adopted)).toEqual({
    state: before.adoptedState,
    acceptedOperations: before.adoptedState.revision,
  });
  expect(
    await ctx.success(
      'reopened mapped exact retry returns original receipt',
      'inventory.apply-mapped-table',
      before.request
    )
  ).toEqual(before.receipt);
  const preview = await ctx.success<InventoryMappedTablePreviewSnapshot>(
    'reopened mapped source cannot reset later measured stock',
    'inventory.preview-mapped-table',
    {
      ...before.adopted,
      format: 'mapped-plate-v1',
      sourceText: before.reordered,
      options: before.options,
    }
  );
  expect(preview.kind).toBe('no-change');
  const artifact = await ctx.success<InventoryExportSnapshot>(
    'reopened mapped archive keeps exact original raw source',
    'inventory.export-snapshot',
    { ...before.scope, format: 'native-v1' }
  );
  expect(artifact.sourceText).toBe(before.artifact.sourceText);
  return { state: ctx.owner.inspect(before.scope), preview, artifact };
}
