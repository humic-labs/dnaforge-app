import { subtractInventoryAmounts } from './inventory-amount';
import { inventoryTableCanonicalJson as canonical } from './inventory-table-binding';
import { inventoryLotConstraints, mergeInventoryLotConstraints } from './inventory-lot-controls';
import {
  emptyInventoryLotValidity,
  emptyInventoryStockValidity,
  inventoryStockValidityInheritance,
  mergeInventoryInheritedValidity,
  bindInventoryInheritedValidity,
} from './inventory-validity';
import {
  inventoryScientificProductionId,
  inventoryScientificProductionLotId,
  inventoryScientificProductionStockId,
  inventoryScientificProductionChoices,
  inventoryScientificProductionIntentSha256,
} from './inventory-scientific-production-identity';
import type { InventoryState, InventorySourceIdentity } from './inventory-types';

function valid(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function validateInventoryScientificProductions(state: InventoryState): void {
  for (const [key, row] of Object.entries(state.scientificProductions)) {
    const choices = inventoryScientificProductionChoices(row),
      lotId = inventoryScientificProductionLotId(row.identity),
      stockId = inventoryScientificProductionStockId(row.identity);
    valid(
      key === row.id &&
        row.id === inventoryScientificProductionId(row.identity) &&
        row.intentSha256 === inventoryScientificProductionIntentSha256(choices),
      'Production identity and original intent must match.'
    );
    valid(
      row.at <= state.lastRecordedAt &&
        row.context.entityId.startsWith(`${row.context.workspaceScope}::`) &&
        row.context.projectId === row.design.owner.projectId &&
        row.context.workspaceScope === row.design.owner.workspaceScope &&
        row.design.selection.scientificWorkspaceId === row.design.owner.scientificWorkspaceId,
      'Production must retain its original Run and accepted design owners.'
    );
    valid(
      row.materialBinding.sourceMaterialId === row.design.selection.revision.resourceId &&
        row.effects.sources.length === row.inputs.length,
      'Production requires the exact original design material and ordered sources.'
    );
    const sourceIds = new Set<string>(),
      sourceVessels = new Set<string>();
    const identities: InventorySourceIdentity[] = [];
    for (const [index, input] of row.inputs.entries()) {
      const effect = row.effects.sources[index];
      valid(
        effect.before.id === input.stockId &&
          !sourceIds.has(input.stockId) &&
          Object.hasOwn(state.stocks, input.stockId),
        'Production requires distinct retained source stock identities.'
      );
      sourceIds.add(input.stockId);
      sourceVessels.add(effect.before.vesselId);
      valid(effect.before.quantity.kind === 'known', 'Production source quantity must be known.');
      const remainder = subtractInventoryAmounts(effect.before.quantity, input.quantity);
      valid(
        remainder.kind === 'remaining' &&
          same(effect.after, {
            ...effect.before,
            quantity: { kind: 'known', ...remainder.quantity },
          }),
        'Production must preserve the exact source debit and all other source facts.'
      );
      valid(
        effect.vessel.id === effect.before.vesselId &&
          Object.hasOwn(state.vessels, effect.vessel.id),
        'Production source vessel must be retained.'
      );
      identities.push({
        stockId: effect.before.id,
        materialId: effect.before.materialId,
        source: effect.before.source,
        composition: effect.before.composition,
      });
    }
    valid(
      row.output.lotId === lotId &&
        row.output.stockId === stockId &&
        !sourceIds.has(stockId) &&
        !sourceVessels.has(row.output.vesselId) &&
        Object.hasOwn(state.lots, lotId) &&
        Object.hasOwn(state.stocks, stockId) &&
        Object.hasOwn(state.vessels, row.output.vesselId),
      'Production requires distinct deterministic output identities and retained empty destination.'
    );
    for (const vessel of [
      ...row.effects.sources.map((effect) => effect.vessel),
      row.effects.stock.vessel,
    ]) {
      valid(
        vessel.kind !== 'fixed-well' || vessel.placement.kind === 'located',
        'Historical permanent production wells retain their placement.'
      );
      if (vessel.placement.kind === 'located')
        valid(
          Object.hasOwn(state.storage, vessel.placement.storageId),
          'Historical production placements retain their storage identity.'
        );
    }
    const lot = row.effects.lot.after;
    const inheritedValidity = mergeInventoryInheritedValidity(
      ...row.effects.sources.map((effect) => inventoryStockValidityInheritance(effect.before, null))
    );
    valid(
      same(lot, {
        ...emptyInventoryLotValidity(),
        inheritedValidity,
        id: lotId,
        materialId: row.materialBinding.destinationMaterialId,
        name: choices.output.lotName,
        origin: { kind: 'prepared', inputs: identities, method: row.method },
        controls: {
          kind: 'managed',
          assessment: { value: 'unassessed', at: row.at, by: row.by, reason: row.reason },
        },
        lotConstraints: inventoryLotConstraints(
          lotId,
          ...row.effects.sources.map((effect) => effect.before.lotConstraints)
        ),
      }),
      'Production lot must retain exact prepared lineage and initial unassessed controls.'
    );
    valid(
      row.effects.stock.vessel.id === row.output.vesselId &&
        same(row.effects.stock.after, {
          ...emptyInventoryStockValidity(),
          inheritedValidity: bindInventoryInheritedValidity(lot.inheritedValidity, row.at),
          id: stockId,
          vesselId: row.output.vesselId,
          materialId: row.materialBinding.destinationMaterialId,
          source: { kind: 'lot', lotId },
          lotConstraints: mergeInventoryLotConstraints(lot.lotConstraints),
          quantity: { kind: 'known', ...row.output.quantity },
          quality: 'quarantined',
          composition: { kind: 'unknown' },
        }),
      'Production stock must retain its measured output and initial quarantine without inferred composition.'
    );
  }
}
