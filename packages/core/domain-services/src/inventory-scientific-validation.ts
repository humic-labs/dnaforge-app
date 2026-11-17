import type { InventoryState } from './inventory-types';
import { subtractInventoryAmounts } from './inventory-amount';
import {
  inventoryScientificStockId,
  inventoryScientificTransferIntentSha256,
  inventoryScientificWorkId,
} from './inventory-scientific-source';
import { inventoryTableCanonicalJson } from './inventory-table-binding';

function invalid(message: string): never {
  throw new TypeError(message);
}
function same(left: unknown, right: unknown): boolean {
  return inventoryTableCanonicalJson(left) === inventoryTableCanonicalJson(right);
}

export function validateInventoryScientificState(state: InventoryState): void {
  for (const [key, work] of Object.entries(state.scientificWorks)) {
    const transfer = work.transfer,
      source = work.effects.source,
      destination = work.effects.destination;
    if (key !== work.id || work.id !== inventoryScientificWorkId(work.identity))
      invalid('Scientific work must retain its exact stable observation identity.');
    if (work.at > state.lastRecordedAt)
      invalid('Scientific work cannot exceed the native recorded inventory clock.');
    if (
      !work.context.pageId.startsWith(`${work.context.workspaceScope}::`) ||
      work.reason !== transfer.reason
    )
      invalid('Scientific work requires its scoped notebook identity and original reason.');
    if (
      work.intentSha256 !==
      inventoryScientificTransferIntentSha256({
        identity: work.identity,
        pageId: work.context.pageId,
        expectedSourceSha256: work.context.source.sha256,
        sourceStockId: transfer.sourceStockId,
        destinationVesselId: transfer.destination.vesselId,
        quantity: transfer.quantity,
        reason: work.reason,
      })
    )
      invalid('Scientific work intent must match its immutable source pin and transfer choices.');
    if (
      transfer.destination.stockId !== inventoryScientificStockId(work.identity) ||
      source.before.id !== transfer.sourceStockId ||
      source.after.id !== transfer.sourceStockId ||
      destination.after.id !== transfer.destination.stockId ||
      source.before.id === destination.after.id
    )
      invalid(
        'Scientific work effects must identify the original source and distinct new aliquot.'
      );
    if (
      source.before.vesselId !== source.vessel.id ||
      source.after.vesselId !== source.vessel.id ||
      destination.after.vesselId !== destination.vessel.id ||
      destination.vessel.id !== transfer.destination.vesselId ||
      source.vessel.id === destination.vessel.id
    )
      invalid('Scientific work must retain the exact distinct source and destination vessels.');
    for (const observation of [source, destination]) {
      if (!Object.hasOwn(state.vessels, observation.vessel.id))
        invalid('Scientific work vessel observations must retain their physical identities.');
      if (!Object.hasOwn(state.stocks, observation.after.id))
        invalid('Scientific work stock observations must retain their physical identities.');
      if (
        observation.vessel.kind === 'fixed-well' &&
        observation.vessel.placement.kind !== 'located'
      )
        invalid('An observed permanent well must retain its plate position.');
      if (
        observation.vessel.placement.kind === 'located' &&
        !Object.hasOwn(state.storage, observation.vessel.placement.storageId)
      )
        invalid('Observed scientific work positions must retain their storage identity.');
    }
    if (
      source.before.quantity.kind !== 'known' ||
      source.after.quantity.kind !== 'known' ||
      destination.after.quantity.kind !== 'known' ||
      transfer.quantity.value === '0'
    )
      invalid('A completed scientific transfer requires positive known compatible amounts.');
    const remaining = subtractInventoryAmounts(source.before.quantity, transfer.quantity);
    if (
      remaining.kind !== 'remaining' ||
      !same(remaining.quantity, {
        value: source.after.quantity.value,
        unit: source.after.quantity.unit,
      }) ||
      !same(transfer.quantity, {
        value: destination.after.quantity.value,
        unit: destination.after.quantity.unit,
      })
    )
      invalid('Scientific work must preserve its exact source debit and destination credit.');
    if (!same({ ...source.before, quantity: source.after.quantity }, source.after))
      invalid('A scientific transfer cannot rewrite other source stock facts.');
    if (
      destination.after.materialId !== source.before.materialId ||
      destination.after.quality !== 'usable' ||
      !same(destination.after.source, source.before.source) ||
      !same(destination.after.composition, source.before.composition) ||
      !same(destination.after.lotConstraints, source.before.lotConstraints)
    )
      invalid('The observed aliquot must preserve its scientific identity and lot provenance.');
  }
}
