import { inventoryStoragePositions } from './inventory-layout';
import { normalizeInventoryMappedTable } from './inventory-mapped-source';
import { inventoryReceiveSourceKey } from './inventory-receive-source';
import { applyInventoryTable, inventoryTablePreview } from './inventory-table';
import { inventoryTableCanonicalJson, inventoryTableSha256 } from './inventory-table-binding';
import { parseInventoryState } from './inventory-validation';
import type {
  InventoryExecutionContext,
  InventoryState,
  InventoryTransition,
} from './inventory-types';
import type {
  InventoryTableBindingObservation,
  InventoryTableIssue,
} from './inventory-table-types';
import type {
  InventoryMappedTableApplication,
  InventoryMappedTablePreview,
  InventoryMappedTablePreviewInput,
  InventoryMappedTableRowPreview,
  InventoryResolvedMappedTableOptions,
} from './inventory-mapped-table-types';

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const digest = /^sha256:[a-f0-9]{64}$/u;
const issue = (code: string, pointer: string, message: string): InventoryTableIssue => ({
  code,
  pointer,
  message,
});

export function inventoryMappedTablePreview(
  state: InventoryState | null,
  input: InventoryMappedTablePreviewInput
): InventoryMappedTablePreview {
  const normalized = normalizeInventoryMappedTable(input.sourceText, input.options, input.maxBytes);
  const rows: InventoryMappedTableRowPreview[] = normalized.rows.map((row) => ({
    ...row,
    kind: row.kind === 'skipped' ? 'skipped' : 'blocked',
    stockId: null,
  }));
  const issues: InventoryTableIssue[] = normalized.kind === 'blocked' ? [...normalized.issues] : [];
  const facts = () => ({
    schema: 'dnaforge.inventory-mapped-table-preview.v1' as const,
    sourceSha256: normalized.sourceSha256,
    target: { ...input.target },
    headers: normalized.headers,
    sourceIds: normalized.sourceIds,
    sourcePlates: normalized.sourcePlates,
    rows,
    normalizedSourceText: normalized.normalizedSourceText,
  });
  const blocked = (
    innerPreview: InventoryMappedTablePreview['innerPreview'] = null
  ): InventoryMappedTablePreview => ({
    ...facts(),
    innerPreview,
    kind: 'blocked',
    issues,
    options: null,
    planDigest: null,
  });
  if (normalized.kind === 'blocked') return blocked();
  let previous: InventoryState | null;
  try {
    previous = state === null ? null : parseInventoryState(state);
  } catch (error) {
    issues.push(
      issue(
        'MAPPED_TARGET_INVALID',
        '/target',
        error instanceof Error ? error.message : 'The target inventory is invalid.'
      )
    );
    return blocked();
  }
  const selections = new Map(
    input.options.materials.map((choice) => [choice.sourceId, choice.materialId])
  );
  const observed = new Map<string, InventoryTableBindingObservation>();
  if (!Array.isArray(input.bindings)) {
    issues.push(
      issue(
        'MAPPED_BINDINGS_INVALID',
        '/bindings',
        'Scientific admission requires an explicit observation list.'
      )
    );
    return blocked();
  }
  for (const [index, observation] of input.bindings.entries()) {
    if (
      !observation ||
      !inventoryReceiveSourceKey(observation.sourceId) ||
      observed.has(observation.sourceId) ||
      selections.get(observation.sourceId) !== observation.materialId ||
      (observation.kind !== 'admitted' && observation.kind !== 'unavailable') ||
      (observation.kind === 'admitted' &&
        (typeof observation.fingerprint !== 'string' || !digest.test(observation.fingerprint))) ||
      (observation.kind === 'unavailable' && typeof observation.reason !== 'string')
    ) {
      issues.push(
        issue(
          'MAPPED_BINDING_INVALID',
          `/bindings/${index}`,
          'Each scientific admission must match one exact selected source identity and material.'
        )
      );
      continue;
    }
    observed.set(
      observation.sourceId,
      observation.kind === 'admitted'
        ? {
            key: observation.sourceId,
            materialId: observation.materialId,
            kind: 'admitted',
            fingerprint: observation.fingerprint,
          }
        : {
            key: observation.sourceId,
            materialId: observation.materialId,
            kind: 'unavailable',
            reason: observation.reason,
          }
    );
  }
  for (const row of normalized.rows) {
    if (row.kind !== 'normalized') continue;
    const plate = input.options.plates.find((choice) => choice.sourcePlate === row.sourcePlate);
    const storage =
      plate && previous && Object.hasOwn(previous.storage, plate.storageId)
        ? previous.storage[plate.storageId]
        : undefined;
    const vessel =
      row.vesselId && previous && Object.hasOwn(previous.vessels, row.vesselId)
        ? previous.vessels[row.vesselId]
        : undefined;
    if (
      !storage ||
      storage.layout.kind !== 'fixed-well' ||
      row.position === null ||
      !inventoryStoragePositions(storage).includes(row.position) ||
      !vessel ||
      vessel.kind !== 'fixed-well' ||
      vessel.placement.kind !== 'located' ||
      vessel.placement.storageId !== storage.id ||
      vessel.placement.slotId !== row.position
    ) {
      const error = issue(
        'MAPPED_PLATE_UNAVAILABLE',
        `/rows/${row.index}/plate`,
        'Choose an existing fixed-well plate and an explicitly mapped permanent position; dimensions and well labels are never inferred.'
      );
      issues.push(error);
      const target = rows.find((candidate) => candidate.index === row.index)!;
      rows[rows.indexOf(target)] = { ...target, issues: [...target.issues, error] };
    }
  }
  if (issues.length) return blocked();
  const needed = new Set(normalized.tableOptions.materials.map((choice) => choice.key));
  const innerPreview = inventoryTablePreview(previous, {
    target: input.target,
    sourceText: normalized.normalizedSourceText,
    options: normalized.tableOptions,
    bindings: [...observed.values()].filter((observation) => needed.has(observation.key)),
    asOf: input.asOf,
    principal: input.principal,
    authority: input.authority,
    maxBytes: input.maxBytes,
  });
  const innerRows = new Map(innerPreview.rows.map((row) => [row.sourceId, row]));
  for (const [index, row] of rows.entries()) {
    const inner = innerRows.get(row.sourceId);
    rows[index] = {
      ...row,
      kind: inner?.kind ?? (row.kind === 'skipped' ? 'skipped' : 'blocked'),
      stockId: inner?.stockId ?? null,
      vesselId: inner?.vesselId ?? row.vesselId,
      issues: [...row.issues, ...(inner?.issues ?? [])],
    };
  }
  if (innerPreview.kind === 'blocked') {
    issues.push(...innerPreview.issues);
    return blocked(innerPreview);
  }
  const options: InventoryResolvedMappedTableOptions = {
    namespace: input.options.namespace,
    delimiter: input.options.delimiter,
    columns: { ...input.options.columns },
    materials: innerPreview.options.materials.map((choice) => ({
      sourceId: choice.key,
      materialId: choice.materialId,
      fingerprint: choice.fingerprint,
    })),
    plates: [...input.options.plates]
      .sort((a, b) => order(a.sourcePlate, b.sourcePlate))
      .map((plate) => ({
        sourcePlate: plate.sourcePlate,
        storageId: plate.storageId,
        positions: [...plate.positions]
          .sort((a, b) => order(a.sourceWell, b.sourceWell))
          .map((position) => ({ ...position })),
      })),
    quantity: { ...input.options.quantity },
    qualities: [...input.options.qualities]
      .filter((choice) => needed.has(choice.sourceId))
      .sort((a, b) => order(a.sourceId, b.sourceId))
      .map((choice) => ({ ...choice })),
    evidenceOnlyColumns: [...input.options.evidenceOnlyColumns]
      .sort((a, b) => order(a.column, b.column))
      .map((choice) => ({ ...choice })),
    skips: [...input.options.skips]
      .sort((a, b) => order(a.sourceId, b.sourceId))
      .map((choice) => ({ ...choice })),
  };
  if (innerPreview.kind === 'no-change')
    return {
      ...facts(),
      innerPreview,
      kind: 'no-change',
      issues: [],
      options,
      planDigest: null,
    };
  return {
    ...facts(),
    innerPreview,
    kind: 'ready',
    issues: [],
    options,
    planDigest: inventoryTableSha256(
      inventoryTableCanonicalJson({
        format: 'dnaforge.inventory-mapped-plate.v1',
        sourceSha256: normalized.sourceSha256,
        target: input.target,
        options,
        normalizedSourceSha256: inventoryTableSha256(normalized.normalizedSourceText),
        innerPlanDigest: innerPreview.planDigest,
      })
    ),
  };
}

export function applyInventoryMappedTable(
  state: InventoryState | null,
  application: InventoryMappedTableApplication,
  context: InventoryExecutionContext,
  maxBytes: number
): InventoryTransition {
  const preview = inventoryMappedTablePreview(state, {
    ...application,
    bindings: application.options.materials.map((material) => ({
      ...material,
      kind: 'admitted' as const,
    })),
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
    maxBytes,
  });
  if (
    preview.kind !== 'ready' ||
    preview.planDigest !== application.expectedPlanDigest ||
    inventoryTableCanonicalJson(preview.options) !==
      inventoryTableCanonicalJson(application.options) ||
    preview.innerPreview?.kind !== 'ready' ||
    preview.normalizedSourceText === null
  )
    return {
      ok: false,
      code: 'INVALID_INVENTORY_INPUT',
      message:
        preview.kind === 'blocked'
          ? (preview.issues[0]?.message ?? 'The mapped spreadsheet is blocked.')
          : 'The mapped plan changed or contains no new physical stock. Preview it again.',
    };
  return applyInventoryTable(
    state,
    {
      target: application.target,
      sourceText: preview.normalizedSourceText,
      options: preview.innerPreview.options,
      expectedPlanDigest: preview.innerPreview.planDigest,
    },
    context,
    maxBytes
  );
}
