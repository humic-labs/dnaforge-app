import type { InventoryState } from './inventory-types';
import type {
  InventoryRunValueAttribution,
  InventoryRunValuePhysicalSelection,
} from './inventory-run-value-attribution-types';
import {
  inventoryRunValueAttributionId,
  inventoryRunValueAttributionWithdrawalId,
  inventoryRunValueAttributionIntentSha256,
  inventoryRunValueAttributionWithdrawalIntentSha256,
  inventoryRunValueAttributionChoices,
  inventoryRunValueAttributionWithdrawalChoices,
  inventoryRunValueAttributionSemanticKey,
} from './inventory-run-value-attribution-identity';
import {
  inventoryRunValueRowSha256,
  parseInventoryRunValueSnapshot,
} from './inventory-run-value-attribution-value';

function valid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}
export function inventoryRunValueAttributionPhysicalMatches(
  state: Pick<InventoryState, 'platePlanObservations'>,
  physical: InventoryRunValuePhysicalSelection
): boolean {
  const observation = Object.hasOwn(state.platePlanObservations, physical.observationId)
    ? state.platePlanObservations[physical.observationId]
    : undefined;
  if (!observation || observation.intentSha256 !== physical.observationIntentSha256) return false;
  const subject = physical.subject;
  if (subject.kind === 'source-stock')
    return observation.effects.sources.some((row) => row.before.id === subject.stockId);
  if (subject.kind !== 'output-action') return false;
  const action = observation.actions.find((row) => row.actionId === subject.actionId),
    destination = observation.effects.destinations.find((row) => row.actionId === subject.actionId);
  return (
    action?.transfer.destination.stockId === subject.stockId &&
    destination?.after.id === subject.stockId
  );
}
export function inventoryRunValueAttributionSameChain(
  left: InventoryRunValueAttribution,
  right: InventoryRunValueAttribution
): boolean {
  return (
    left.runValue.entityId === right.runValue.entityId &&
    left.runValue.collection === right.runValue.collection &&
    left.runValue.key === right.runValue.key &&
    left.source.projectId === right.source.projectId &&
    left.source.workspaceScope === right.source.workspaceScope &&
    left.source.fileObjectUuid === right.source.fileObjectUuid
  );
}
export function validateInventoryRunValueAttributions(state: InventoryState): void {
  const semantic = new Set<string>(),
    withdrawals = new Set<string>(),
    successors = new Set<string>(),
    parents = new Map<string, string>();
  for (const [key, row] of Object.entries(state.runValueAttributionWithdrawals)) {
    const attribution = state.runValueAttributions[row.attributionId];
    valid(
      key === row.id &&
        row.id === inventoryRunValueAttributionWithdrawalId(row.identity) &&
        row.intentSha256 ===
          inventoryRunValueAttributionWithdrawalIntentSha256(
            inventoryRunValueAttributionWithdrawalChoices(row)
          ),
      'A Run value withdrawal requires its exact immutable identity and intent.'
    );
    valid(
      attribution &&
        attribution.intentSha256 === row.attributionIntentSha256 &&
        row.at >= attribution.at &&
        row.at <= state.lastRecordedAt,
      'A withdrawal must follow its exact recorded attribution.'
    );
    valid(
      !withdrawals.has(row.attributionId),
      'An attribution can have only one terminal withdrawal.'
    );
    withdrawals.add(row.attributionId);
  }
  for (const [key, row] of Object.entries(state.runValueAttributions)) {
    const choices = inventoryRunValueAttributionChoices(row),
      snapshot = parseInventoryRunValueSnapshot(row.valueSnapshot),
      observation = state.platePlanObservations[row.physical.observationId];
    valid(
      key === row.id &&
        row.id === inventoryRunValueAttributionId(row.identity) &&
        row.intentSha256 === inventoryRunValueAttributionIntentSha256(choices),
      'Run value attributions require exact immutable identities and intents.'
    );
    valid(
      snapshot.key === row.runValue.key &&
        inventoryRunValueRowSha256(row.runValue.collection, snapshot) === row.runValue.rowSha256,
      'The complete raw saved row must match its exact key and hash.'
    );
    valid(
      row.runValue.entityId.startsWith(`${row.source.workspaceScope}::`),
      'Run value attribution requires its original scoped Run identity.'
    );
    valid(
      inventoryRunValueAttributionPhysicalMatches(state, row.physical) &&
        row.at >= observation.at &&
        row.at <= state.lastRecordedAt,
      'Run value attribution must follow its exact retained physical subject.'
    );
    valid(
      row.origin.kind === 'local-actual' ||
        (row.origin.kind === 'frozen-declaration' &&
          row.runValue.collection !== 'measurements' &&
          /^sha256:[a-f0-9]{64}$/u.test(row.origin.definitionSha256)),
      'Run value origin must preserve its explicit local or frozen-declaration meaning.'
    );
    const semanticKey = inventoryRunValueAttributionSemanticKey(choices);
    valid(
      !semantic.has(semanticKey),
      'Equivalent attribution generations cannot be duplicated across history.'
    );
    semantic.add(semanticKey);
    if (!row.predecessor) continue;
    const pin = row.predecessor,
      parent = state.runValueAttributions[pin.attributionId],
      withdrawal = state.runValueAttributionWithdrawals[pin.withdrawalId];
    valid(
      parent &&
        withdrawal &&
        parent.id !== row.id &&
        parent.intentSha256 === pin.attributionIntentSha256 &&
        withdrawal.intentSha256 === pin.withdrawalIntentSha256 &&
        withdrawal.attributionId === parent.id &&
        withdrawal.attributionIntentSha256 === parent.intentSha256 &&
        inventoryRunValueAttributionSameChain(parent, row) &&
        row.at >= withdrawal.at,
      'A successor requires the exact withdrawn predecessor and same Run/file/slot identity.'
    );
    valid(
      !successors.has(parent.id) && !successors.has(withdrawal.id),
      'A terminal attribution can have only one successor.'
    );
    successors.add(parent.id);
    successors.add(withdrawal.id);
    parents.set(row.id, parent.id);
  }
  const visited = new Set<string>();
  for (const id of Object.keys(state.runValueAttributions)) {
    const path = new Set<string>();
    let current: string | undefined = id;
    while (current && !visited.has(current)) {
      valid(!path.has(current), 'Attribution correction generations cannot form a cycle.');
      path.add(current);
      current = parents.get(current);
    }
    for (const item of path) visited.add(item);
  }
}
