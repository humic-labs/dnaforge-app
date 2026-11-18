import {
  parseResourceId,
  parseResourceRevisionId,
  parseWorkspaceId,
  parseWorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import { normalizeInventoryAmount } from './inventory-amount';
import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256,
} from './inventory-table-binding';
import type { InventoryCanonicalAmount } from './inventory-amount';
import type {
  AcceptedDnaProductionSelection,
  InventoryScientificProduction,
  InventoryScientificProductionChoices,
  InventoryScientificProductionIdentity,
} from './inventory-scientific-production-types';

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new TypeError('Production choices require exactly their declared fields.');
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, trim = false): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    value.includes('\0') ||
    (trim && value.trim() !== value) ||
    new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(value)) !== value
  )
    throw new TypeError('Production requires bounded exact nonempty text.');
  return value;
}
function amount(value: unknown): InventoryCanonicalAmount {
  const row = object(value, ['value', 'unit']);
  const result = normalizeInventoryAmount(row as unknown as InventoryCanonicalAmount);
  if (result.value === '0' || result.value !== row.value || result.unit !== row.unit)
    throw new TypeError('Production requires a positive exact canonical amount.');
  return result;
}
export function parseAcceptedDnaProductionSelection(
  value: unknown
): AcceptedDnaProductionSelection {
  const row = object(value, ['scientificWorkspaceId', 'revision']);
  const revision = object(row.revision, [
    'kind',
    'resourceId',
    'resourceRevisionId',
    'workspaceVersionId',
    'contentSha256',
  ]);
  if (
    revision.kind !== 'accepted-object' ||
    typeof revision.contentSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(revision.contentSha256) ||
    !parseWorkspaceId(text(row.scientificWorkspaceId, 512, true)).ok ||
    !parseResourceId(text(revision.resourceId, 512, true)).ok ||
    !parseResourceRevisionId(text(revision.resourceRevisionId, 512, true)).ok ||
    !parseWorkspaceVersionId(text(revision.workspaceVersionId, 512, true)).ok
  )
    throw new TypeError('Production requires an exact accepted DNA revision selection.');
  return structuredClone(row) as unknown as AcceptedDnaProductionSelection;
}
export function inventoryScientificProductionId(
  identity: InventoryScientificProductionIdentity
): string {
  const row = object(identity, ['namespace', 'productionId']);
  return `scientific-production:${inventoryTableSha256(canonical(['dnaforge.inventory-scientific-production.v1', text(row.namespace, 1024), text(row.productionId, 1024)])).slice(7)}`;
}
export function inventoryScientificProductionLotId(
  identity: InventoryScientificProductionIdentity
): string {
  return `scientific-production-lot:${inventoryTableSha256(canonical(['dnaforge.inventory-scientific-production-lot.v1', inventoryScientificProductionId(identity)])).slice(7)}`;
}
export function inventoryScientificProductionStockId(
  identity: InventoryScientificProductionIdentity
): string {
  return `scientific-production-stock:${inventoryTableSha256(canonical(['dnaforge.inventory-scientific-production-stock.v1', inventoryScientificProductionId(identity)])).slice(7)}`;
}
export function parseInventoryScientificProductionChoices(
  value: unknown
): InventoryScientificProductionChoices {
  const row = object(value, [
    'identity',
    'context',
    'design',
    'inputs',
    'output',
    'method',
    'reason',
  ]);
  inventoryScientificProductionId(row.identity as InventoryScientificProductionIdentity);
  const context = object(row.context, ['kind', 'entityId', 'sourceSha256']);
  if (
    context.kind !== 'protocol-run' ||
    typeof context.sourceSha256 !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(context.sourceSha256)
  )
    throw new TypeError('Production requires an exact saved Protocol Run.');
  text(context.entityId, 1000, true);
  const design = parseAcceptedDnaProductionSelection(row.design);
  if (!Array.isArray(row.inputs) || row.inputs.length < 1 || row.inputs.length > 253)
    throw new TypeError('Production requires one to 253 distinct inputs.');
  const ids = new Set<string>();
  const inputs = row.inputs.map((value) => {
    const input = object(value, ['stockId', 'quantity']);
    const stockId = text(input.stockId, 512, true);
    if (ids.has(stockId)) throw new TypeError('Production input stocks must be distinct.');
    ids.add(stockId);
    return { stockId, quantity: amount(input.quantity) };
  });
  const output = object(row.output, ['vesselId', 'quantity', 'lotName']);
  return {
    identity: structuredClone(row.identity) as InventoryScientificProductionIdentity,
    context: structuredClone(context) as unknown as InventoryScientificProductionChoices['context'],
    design,
    inputs,
    output: {
      vesselId: text(output.vesselId, 1024, true),
      quantity: amount(output.quantity),
      lotName: text(output.lotName, 512),
    },
    method: text(row.method, 2000),
    reason: text(row.reason, 2000),
  };
}
export function inventoryScientificProductionIntentSha256(
  value: InventoryScientificProductionChoices
) {
  return inventoryTableSha256(
    canonical({
      schema: 'dnaforge.inventory-scientific-production-intent.v1',
      ...parseInventoryScientificProductionChoices(value),
    })
  );
}
export function inventoryScientificProductionChoices(
  record: InventoryScientificProduction
): InventoryScientificProductionChoices {
  return parseInventoryScientificProductionChoices({
    identity: record.identity,
    context: {
      kind: 'protocol-run',
      entityId: record.context.entityId,
      sourceSha256: record.context.source.sha256,
    },
    design: record.design.selection,
    inputs: record.inputs,
    output: {
      vesselId: record.output.vesselId,
      quantity: record.output.quantity,
      lotName: record.effects.lot.after.name,
    },
    method: record.method,
    reason: record.reason,
  });
}
