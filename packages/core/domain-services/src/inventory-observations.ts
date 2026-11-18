import type {
  InventoryCommand,
  InventoryPhysicalExecutionContext,
  InventoryState,
  InventoryTransition,
} from './inventory-types';
import type { InventoryObservation } from './inventory-observation-types';
import { inventoryObservationKey } from './inventory-observation-identity';
import { normalizeInventoryQuantity } from './inventory-volume';

type Failure = Extract<InventoryTransition, { ok: false }>;
type ObservationState = Pick<InventoryState, 'stocks' | 'storage' | 'vessels'> & {
  observations: Record<string, InventoryObservation>;
};
const refusal = (code: Failure['code'], message: string): Failure => ({ ok: false, code, message });

export function applyInventoryObservationCommand(
  state: ObservationState,
  command: InventoryCommand,
  context: InventoryPhysicalExecutionContext | undefined,
  apply: (command: InventoryCommand) => Failure | null
): Failure | null | undefined {
  if (
    command.kind !== 'record-inventory-observation' &&
    command.kind !== 'apply-inventory-observation'
  )
    return undefined;
  if (!context)
    return refusal('CONTEXT_REQUIRED', 'Inventory observations require native recording context.');
  if (command.kind === 'apply-inventory-observation') {
    const observation = Object.hasOwn(state.observations, command.observationKey)
      ? state.observations[command.observationKey]
      : undefined;
    if (!observation)
      return refusal('OBSERVATION_NOT_FOUND', 'The inventory observation does not exist.');
    if (observation.application.kind === 'applied')
      return refusal('OBSERVATION_ALREADY_APPLIED', 'This observation was already applied.');
    const fact = observation.fact;
    let correction: InventoryCommand;
    if (fact.kind === 'quantity') {
      if (observation.subject.kind !== 'stock')
        return refusal('INVALID_INVENTORY_INPUT', 'Quantity observations require stock subjects.');
      correction = {
        kind: 'reconcile',
        stockId: observation.subject.stockId,
        quantity: fact.quantity,
        reason: command.reason,
      };
    } else {
      if (observation.subject.kind !== 'item')
        return refusal(
          'INVALID_INVENTORY_INPUT',
          'Presence observations require physical subjects.'
        );
      correction =
        fact.value === 'missing'
          ? { kind: 'report-item-missing', item: observation.subject.item, reason: command.reason }
          : {
              kind: 'locate-item',
              item: observation.subject.item,
              destination: fact.destination,
              reason: command.reason,
            };
    }
    const invalid = apply(correction);
    if (invalid) return invalid;
    state.observations[command.observationKey] = {
      ...observation,
      application: {
        kind: 'applied',
        reason: command.reason,
        at: context.at,
        by: { ...context.principal },
      },
    };
    return null;
  }
  const key = inventoryObservationKey(command.namespace, command.observationId);
  if (Object.hasOwn(state.observations, key))
    return refusal('OBSERVATION_ALREADY_EXISTS', 'That exact observation identity already exists.');
  if (command.observedAt !== null && command.observedAt > context.at)
    return refusal(
      'OBSERVATION_TIME_FUTURE',
      'The observation time cannot follow native recording time.'
    );
  if (command.subject.kind === 'stock') {
    if (!Object.hasOwn(state.stocks, command.subject.stockId))
      return refusal('STOCK_NOT_FOUND', 'The observed stock does not exist.');
  } else if (
    !Object.hasOwn(
      command.subject.item.kind === 'storage' ? state.storage : state.vessels,
      command.subject.item.id
    )
  ) {
    return refusal(
      command.subject.item.kind === 'storage' ? 'STORAGE_NOT_FOUND' : 'VESSEL_NOT_FOUND',
      'The observed physical item does not exist.'
    );
  }
  if (command.fact.kind === 'presence' && command.fact.value === 'found') {
    const destination = command.fact.destination;
    const storageId =
      destination.kind === 'located'
        ? destination.storageId
        : destination.kind === 'stack-top'
          ? destination.stackId
          : null;
    if (storageId !== null && !Object.hasOwn(state.storage, storageId))
      return refusal('STORAGE_NOT_FOUND', 'The observed destination does not exist.');
  }
  const fact =
    command.fact.kind === 'quantity'
      ? { kind: 'quantity' as const, quantity: normalizeInventoryQuantity(command.fact.quantity) }
      : command.fact.value === 'found'
        ? { ...command.fact, destination: { ...command.fact.destination } }
        : { ...command.fact };
  state.observations[key] = {
    namespace: command.namespace,
    observationId: command.observationId,
    subject:
      command.subject.kind === 'stock'
        ? { ...command.subject }
        : { ...command.subject, item: { ...command.subject.item } },
    fact,
    observedAt: command.observedAt,
    reason: command.reason,
    at: context.at,
    by: { ...context.principal },
    application: { kind: 'unapplied' },
  };
  return null;
}
