import { normalizeInventoryAmount } from './inventory-amount';
import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256,
} from './inventory-table-binding';
import type { InventoryTableSha256 } from './inventory-table-types';
import type {
  InventoryNotebookSavedSource,
  InventoryScientificTransferChoices,
  InventoryScientificTransferChoicesV2,
  InventoryProtocolRunSavedSource,
  InventoryScientificWorkIdentity,
} from './inventory-scientific-types';

function text(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new TypeError(`The scientific transfer requires ${field}.`);
  return value;
}
export function inventoryNotebookSourceSha256(
  source: InventoryNotebookSavedSource
): InventoryTableSha256 {
  return inventoryTableSha256(canonical(source));
}
export function inventoryProtocolRunSourceSha256(
  source: InventoryProtocolRunSavedSource
): InventoryTableSha256 {
  return inventoryTableSha256(canonical(source));
}
export function inventoryScientificWorkId(identity: InventoryScientificWorkIdentity): string {
  return `scientific-work:${inventoryTableSha256(
    canonical([
      'dnaforge.inventory-scientific-work.v1',
      text(identity.namespace, 'a work namespace'),
      text(identity.workId, 'a stable work identity'),
    ])
  ).slice(7)}`;
}
export function inventoryScientificStockId(identity: InventoryScientificWorkIdentity): string {
  return `scientific-stock:${inventoryScientificWorkId(identity).slice('scientific-work:'.length)}`;
}
export function inventoryScientificTransferIntentSha256(
  input: InventoryScientificTransferChoices
): InventoryTableSha256 {
  const quantity = normalizeInventoryAmount(input.quantity);
  if (quantity.value === '0')
    throw new TypeError('A completed transfer requires a positive amount.');
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.expectedSourceSha256))
    throw new TypeError('The scientific transfer requires the exact saved-source SHA-256.');
  return inventoryTableSha256(
    canonical({
      schema: 'dnaforge.inventory-scientific-transfer-intent.v1',
      identity: {
        namespace: text(input.identity.namespace, 'a work namespace'),
        workId: text(input.identity.workId, 'a stable work identity'),
      },
      pageId: text(input.pageId, 'the canonical notebook page'),
      expectedSourceSha256: input.expectedSourceSha256,
      sourceStockId: text(input.sourceStockId, 'the exact source stock'),
      destinationVesselId: text(input.destinationVesselId, 'the exact destination vessel'),
      quantity,
      reason: text(input.reason, 'the completed manual-transfer observation reason'),
    })
  );
}
export function inventoryScientificTransferNotebookChoices(
  input: InventoryScientificTransferChoicesV2
): InventoryScientificTransferChoices {
  if (input.context.kind !== 'notebook-page')
    throw new TypeError('Notebook transfer compatibility requires an explicit Notebook context.');
  return {
    identity: input.identity,
    pageId: input.context.entityId,
    expectedSourceSha256: input.context.sourceSha256,
    sourceStockId: input.sourceStockId,
    destinationVesselId: input.destinationVesselId,
    quantity: input.quantity,
    reason: input.reason,
  };
}
export function inventoryScientificTransferIntentSha256V2(
  input: InventoryScientificTransferChoicesV2
): InventoryTableSha256 {
  if (input.context.kind === 'notebook-page')
    return inventoryScientificTransferIntentSha256(
      inventoryScientificTransferNotebookChoices(input)
    );
  if (input.context.kind !== 'protocol-run')
    throw new TypeError('Choose a supported explicit scientific context.');
  const quantity = normalizeInventoryAmount(input.quantity);
  if (quantity.value === '0')
    throw new TypeError('A completed transfer requires a positive amount.');
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.context.sourceSha256))
    throw new TypeError('The scientific transfer requires the exact saved-source SHA-256.');
  return inventoryTableSha256(
    canonical({
      schema: 'dnaforge.inventory-scientific-transfer-intent.v2',
      identity: {
        namespace: text(input.identity.namespace, 'a work namespace'),
        workId: text(input.identity.workId, 'a stable work identity'),
      },
      context: {
        kind: 'protocol-run',
        entityId: text(input.context.entityId, 'the canonical Protocol Run'),
        sourceSha256: input.context.sourceSha256,
      },
      sourceStockId: text(input.sourceStockId, 'the exact source stock'),
      destinationVesselId: text(input.destinationVesselId, 'the exact destination vessel'),
      quantity,
      reason: text(input.reason, 'the completed manual-transfer observation reason'),
    })
  );
}
