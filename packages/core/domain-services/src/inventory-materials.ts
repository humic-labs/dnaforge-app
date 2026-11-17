import type {
  InventoryCommand,
  InventoryContribution,
  InventoryErrorCode,
  InventoryExecutionContext,
  InventoryLot,
  InventoryQuantity,
  InventoryReservation,
  InventorySourceIdentity,
  InventoryState,
  InventoryStock,
  InventoryStockSource,
  InventoryVessel,
  InventoryVesselLimits,
  InventoryWithdrawal,
} from './inventory-types';
import {
  mixInventoryCompositions,
  normalizeInventoryConcentration,
  type InventoryComposition,
  type InventoryConcentration,
} from './inventory-concentration';
import {
  addInventoryVolumes,
  compareInventoryVolumes,
  normalizeInventoryQuantity,
  normalizeInventoryVolume,
  normalizeInventoryVolumeQuantity,
} from './inventory-volume';
import {
  addInventoryAmounts,
  normalizeInventoryAmount,
  subtractInventoryAmounts,
  type InventoryAmount,
  type InventoryCanonicalAmount,
} from './inventory-amount';
import { inventoryVesselStockAdmission } from './inventory-contents';
import { inventoryLotConstraints, mergeInventoryLotConstraints } from './inventory-lot-controls';
import { inventoryRecordIdExists } from './inventory-identity';
import {
  bindInventoryInheritedValidity,
  emptyInventoryLotValidity,
  emptyInventoryStockValidity,
  inventoryStockValidityInheritance,
  mergeInventoryInheritedValidity,
} from './inventory-validity';
import type { InventoryInheritedValidity } from './inventory-validity-types';

export interface InventoryMaterialDraft {
  readonly temperatureClaims: InventoryState['temperatureClaims'];
  readonly itemCodes: InventoryState['itemCodes'];
  readonly typeVersions: InventoryState['typeVersions'];
  readonly recipeVersions: InventoryState['recipeVersions'];
  readonly fitEvidence: InventoryState['fitEvidence'];
  readonly stocks: Record<string, InventoryStock>;
  readonly lots: Record<string, InventoryLot>;
  readonly lotRecalls: InventoryState['lotRecalls'];
  readonly openingObservations: InventoryState['openingObservations'];
  readonly validityFacts: InventoryState['validityFacts'];
  readonly vessels: Record<string, InventoryVessel>;
  readonly storage: InventoryState['storage'];
  readonly reservations: Readonly<Record<string, InventoryReservation>>;
}

type Refusal = { readonly ok: false; readonly code: InventoryErrorCode; readonly message: string };
const refuse = (code: InventoryErrorCode, message: string): Refusal => ({
  ok: false,
  code,
  message,
});

export function unknownInventoryVesselLimits(): InventoryVesselLimits {
  return { capacity: { kind: 'unknown' }, deadVolume: { kind: 'unknown' } };
}

export function inventoryCapacityFailure(
  vessel: InventoryVessel,
  quantity: InventoryQuantity
): Refusal | null {
  if (
    quantity.kind === 'known' &&
    quantity.unit === 'uL' &&
    vessel.limits.capacity.kind === 'known' &&
    compareInventoryVolumes(
      { value: quantity.value, unit: quantity.unit },
      vessel.limits.capacity
    ) > 0
  )
    return refuse(
      'CAPACITY_EXCEEDED',
      'The recorded quantity exceeds this container’s known capacity.'
    );
  return null;
}

export function inventoryWithdrawalResult(
  stock: InventoryStock,
  vessel: InventoryVessel,
  amount: InventoryAmount
): Refusal | { readonly quantity: InventoryQuantity } {
  if (vessel.lifecycle !== 'active')
    return refuse('VESSEL_DISPOSED', 'Disposed stock cannot be withdrawn.');
  if (stock.quality !== 'usable')
    return refuse('STOCK_QUARANTINED', 'Quarantined stock must be released before use.');
  if (stock.quantity.kind === 'unknown')
    return refuse(
      'QUANTITY_UNKNOWN',
      'Measure and reconcile an unknown stock quantity before use.'
    );
  const result = subtractInventoryAmounts(stock.quantity, amount);
  if (result.kind === 'incompatible')
    return refuse(
      'QUANTITY_DIMENSION_MISMATCH',
      'A withdrawal must use the stock’s declared measurement dimension.'
    );
  if (result.kind === 'non-positive')
    return refuse('INVALID_QUANTITY', 'A withdrawal requires a positive amount.');
  if (result.kind === 'insufficient')
    return refuse('INSUFFICIENT_QUANTITY', 'The stock does not contain the requested amount.');
  if (
    result.quantity.unit === 'uL' &&
    vessel.limits.deadVolume.kind === 'known' &&
    compareInventoryVolumes(
      { value: result.quantity.value, unit: result.quantity.unit },
      vessel.limits.deadVolume
    ) < 0
  )
    return refuse(
      'DEAD_VOLUME_REQUIRED',
      'The withdrawal would use the container’s recorded dead volume.'
    );
  return { quantity: { kind: 'known', ...result.quantity } };
}

function physicalValidity(
  refs: readonly InventoryInheritedValidity[],
  context: InventoryExecutionContext | undefined
): readonly InventoryInheritedValidity[] | Refusal {
  if (refs.length && !context)
    return refuse(
      'CONTEXT_REQUIRED',
      'Inherited validity requires trusted physical recording time.'
    );
  return context ? bindInventoryInheritedValidity(refs, context.at) : [];
}

function sameSource(first: InventoryStockSource, second: InventoryStockSource): boolean {
  return first.kind === 'lot'
    ? second.kind === 'lot' && first.lotId === second.lotId
    : second.kind === 'unattributed' && first.rootStockId === second.rootStockId;
}

function identity(stock: InventoryStock): InventorySourceIdentity {
  return {
    stockId: stock.id,
    materialId: stock.materialId,
    source: { ...stock.source },
    composition: structuredClone(stock.composition),
  };
}

function emptyVessel(state: InventoryMaterialDraft, id: string): InventoryVessel | Refusal {
  return inventoryVesselStockAdmission(state, id);
}

function contribution(
  state: InventoryMaterialDraft,
  input: InventoryWithdrawal
):
  | {
      contribution: InventorySourceIdentity & { readonly quantity: InventoryCanonicalAmount };
      remaining: InventoryQuantity;
    }
  | Refusal {
  const stock = state.stocks[input.stockId];
  if (!stock) return refuse('STOCK_NOT_FOUND', 'A source stock does not exist.');
  const vessel = state.vessels[stock.vesselId];
  if (!vessel) return refuse('VESSEL_NOT_FOUND', 'A source container does not exist.');
  const result = inventoryWithdrawalResult(stock, vessel, input.quantity);
  if ('ok' in result) return result;
  return {
    contribution: { ...identity(stock), quantity: normalizeInventoryAmount(input.quantity) },
    remaining: result.quantity,
  };
}

export function inventoryMixingDimensionFailure(
  state: Pick<InventoryMaterialDraft, 'stocks'>,
  command: InventoryCommand
): Refusal | null {
  if (command.kind !== 'pool' && command.kind !== 'dilute') return null;
  return inventoryCommandWithdrawals(command).some(
    (input) => state.stocks[input.stockId] && state.stocks[input.stockId].quantity.unit !== 'uL'
  )
    ? refuse('MIXING_REQUIRES_VOLUME', 'Pooling and dilution require volume-based source stocks.')
    : null;
}

export function applyInventoryMaterialCommand(
  state: InventoryMaterialDraft,
  command: InventoryCommand,
  context?: InventoryExecutionContext
): Refusal | null | undefined {
  const mixingFailure = inventoryMixingDimensionFailure(state, command);
  if (mixingFailure) return mixingFailure;
  switch (command.kind) {
    case 'create-lot': {
      if (inventoryRecordIdExists(state, command.id))
        return refuse('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
      let origin: InventoryLot['origin'];
      if (command.origin.kind === 'received') origin = { ...command.origin };
      else {
        const inputs: InventorySourceIdentity[] = [];
        for (const id of command.origin.sourceStockIds) {
          const stock = state.stocks[id];
          if (!stock)
            return refuse('STOCK_NOT_FOUND', 'A preparation source stock does not exist.');
          inputs.push(identity(stock));
        }
        origin = { kind: 'prepared', inputs, method: command.origin.method };
      }
      state.lots[command.id] = {
        ...emptyInventoryLotValidity(),
        id: command.id,
        materialId: command.materialId,
        name: command.name,
        origin,
        controls: { kind: 'legacy-untracked' },
        lotConstraints: inventoryLotConstraints(
          command.id,
          ...(command.origin.kind === 'prepared'
            ? command.origin.sourceStockIds.map((id) => state.stocks[id].lotConstraints)
            : [])
        ),
        inheritedValidity: mergeInventoryInheritedValidity(
          ...(command.origin.kind === 'prepared'
            ? command.origin.sourceStockIds.map((id) =>
                inventoryStockValidityInheritance(state.stocks[id], null)
              )
            : [])
        ),
      };
      return null;
    }
    case 'receive-lot-stock': {
      if (inventoryRecordIdExists(state, command.id))
        return refuse('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
      const lot = state.lots[command.lotId];
      if (!lot) return refuse('LOT_NOT_FOUND', 'The receiving lot does not exist.');
      const vessel = emptyVessel(state, command.vesselId);
      if ('ok' in vessel) return vessel;
      const quantity = normalizeInventoryQuantity(command.quantity);
      const invalid = inventoryCapacityFailure(vessel, quantity);
      if (invalid) return invalid;
      const inheritedValidity = physicalValidity(lot.inheritedValidity, context);
      if ('ok' in inheritedValidity) return inheritedValidity;
      state.stocks[command.id] = {
        ...emptyInventoryStockValidity(),
        inheritedValidity,
        id: command.id,
        vesselId: command.vesselId,
        materialId: lot.materialId,
        source: { kind: 'lot', lotId: lot.id },
        lotConstraints: mergeInventoryLotConstraints(lot.lotConstraints),
        quantity,
        quality: command.quality,
        composition: { kind: 'unknown' },
      };
      return null;
    }
    case 'record-composition': {
      const stock = state.stocks[command.stockId];
      if (!stock) return refuse('STOCK_NOT_FOUND', 'The stock does not exist.');
      if (state.vessels[stock.vesselId].lifecycle !== 'active')
        return refuse('VESSEL_DISPOSED', 'Disposed stock cannot be measured.');
      let composition: InventoryComposition = { kind: 'unknown' };
      if (command.composition.kind === 'homogeneous') {
        const analytes: Record<string, InventoryConcentration> = Object.create(null);
        for (const [id, value] of Object.entries(command.composition.analytes))
          analytes[id] =
            value.kind === 'unknown'
              ? { kind: 'unknown', reason: 'reason' in value ? value.reason : 'unmeasured' }
              : 'numerator' in value
                ? { ...value }
                : normalizeInventoryConcentration(value);
        composition = { kind: 'homogeneous', analytes };
      }
      state.stocks[stock.id] = { ...stock, composition };
      return null;
    }
    case 'associate-stock-lot': {
      const stock = state.stocks[command.stockId];
      if (!stock) return refuse('STOCK_NOT_FOUND', 'The stock does not exist.');
      if (state.vessels[stock.vesselId].lifecycle !== 'active')
        return refuse('VESSEL_DISPOSED', 'Disposed stock cannot be attributed to another lot.');
      const lot = state.lots[command.lotId];
      if (!lot) return refuse('LOT_NOT_FOUND', 'The lot does not exist.');
      if (lot.materialId !== stock.materialId)
        return refuse(
          'INCOMPATIBLE_PROVENANCE',
          'The stock and lot must identify the same material.'
        );
      const inheritedValidity = physicalValidity(
        mergeInventoryInheritedValidity(stock.inheritedValidity, lot.inheritedValidity),
        context
      );
      if ('ok' in inheritedValidity) return inheritedValidity;
      state.stocks[stock.id] = {
        ...stock,
        source: { kind: 'lot', lotId: lot.id },
        lotConstraints: mergeInventoryLotConstraints(stock.lotConstraints, lot.lotConstraints),
        inheritedValidity,
      };
      return null;
    }
    case 'set-vessel-limits': {
      const vessel = state.vessels[command.vesselId];
      if (!vessel) return refuse('VESSEL_NOT_FOUND', 'The container does not exist.');
      if (vessel.lifecycle !== 'active')
        return refuse('VESSEL_DISPOSED', 'Disposed containers cannot be changed.');
      const limits = {
        capacity: normalizeInventoryVolumeQuantity(command.limits.capacity),
        deadVolume: normalizeInventoryVolumeQuantity(command.limits.deadVolume),
      };
      if (
        limits.capacity.kind === 'known' &&
        limits.deadVolume.kind === 'known' &&
        compareInventoryVolumes(limits.deadVolume, limits.capacity) > 0
      )
        return refuse('INVALID_QUANTITY', 'Dead volume cannot exceed known capacity.');
      const updated = { ...vessel, limits };
      const stock = Object.values(state.stocks).find((stock) => stock.vesselId === vessel.id);
      const invalid = stock ? inventoryCapacityFailure(updated, stock.quantity) : null;
      if (invalid) return invalid;
      state.vessels[vessel.id] = updated;
      return null;
    }
    case 'transfer': {
      const debit = contribution(state, {
        stockId: command.sourceStockId,
        quantity: command.quantity,
      });
      if ('ok' in debit) return debit;
      const source = state.stocks[command.sourceStockId];
      const incomingValidity = physicalValidity(
        inventoryStockValidityInheritance(source, null),
        context
      );
      if ('ok' in incomingValidity) return incomingValidity;
      let destination: InventoryStock;
      if (command.destination.kind === 'new-stock') {
        if (inventoryRecordIdExists(state, command.destination.stockId))
          return refuse('ID_ALREADY_EXISTS', 'The destination stock identifier already exists.');
        const vessel = emptyVessel(state, command.destination.vesselId);
        if ('ok' in vessel) return vessel;
        destination = {
          ...emptyInventoryStockValidity(),
          inheritedValidity: incomingValidity,
          id: command.destination.stockId,
          vesselId: vessel.id,
          materialId: source.materialId,
          source: { ...source.source },
          lotConstraints: mergeInventoryLotConstraints(source.lotConstraints),
          quantity: { kind: 'known', ...debit.contribution.quantity },
          quality: 'usable',
          composition: structuredClone(source.composition),
        };
      } else {
        const stock = state.stocks[command.destination.stockId];
        if (!stock) return refuse('STOCK_NOT_FOUND', 'The destination stock does not exist.');
        if (stock.id === source.id)
          return refuse('INVALID_PLACEMENT', 'A stock cannot transfer to itself.');
        if (stock.materialId !== source.materialId || !sameSource(stock.source, source.source))
          return refuse(
            'INCOMPATIBLE_PROVENANCE',
            'An existing destination must have the same material and lot or unattributed root.'
          );
        const vessel = state.vessels[stock.vesselId];
        if (vessel.lifecycle !== 'active')
          return refuse('VESSEL_DISPOSED', 'The destination container has been disposed.');
        if (stock.quality !== 'usable')
          return refuse('STOCK_QUARANTINED', 'The destination stock is quarantined.');
        if (stock.quantity.kind !== 'known')
          return refuse(
            'QUANTITY_UNKNOWN',
            'Measure the destination quantity before transferring into it.'
          );
        const combined = addInventoryAmounts(
          [stock.quantity, debit.contribution.quantity],
          stock.quantity.unit
        );
        if (combined.kind === 'incompatible')
          return refuse(
            'QUANTITY_DIMENSION_MISMATCH',
            'A transfer must preserve the destination stock’s measurement dimension.'
          );
        if (stock.quantity.unit !== 'uL' && 'mixing' in command && command.mixing === 'homogeneous')
          return refuse(
            'MIXING_REQUIRES_VOLUME',
            'Homogeneous mixing requires volume-based source and destination stocks.'
          );
        const existingValidity = physicalValidity(
          inventoryStockValidityInheritance(stock, null),
          context
        );
        if ('ok' in existingValidity) return existingValidity;
        destination = {
          ...stock,
          inheritedValidity: mergeInventoryInheritedValidity(existingValidity, incomingValidity),
          lotConstraints: mergeInventoryLotConstraints(stock.lotConstraints, source.lotConstraints),
          composition:
            stock.quantity.unit !== 'uL'
              ? { kind: 'unknown' }
              : stock.quantity.value === '0'
                ? 'mixing' in command && command.mixing === 'homogeneous'
                  ? structuredClone(source.composition)
                  : { kind: 'unknown' }
                : mixInventoryCompositions(
                    [
                      {
                        composition: stock.composition,
                        quantity: { value: stock.quantity.value, unit: 'uL' },
                      },
                      {
                        ...debit.contribution,
                        quantity: { value: debit.contribution.quantity.value, unit: 'uL' },
                      },
                    ],
                    'mixing' in command ? command.mixing : 'unknown'
                  ),
          quantity: {
            kind: 'known',
            ...combined.quantity,
          },
        };
      }
      const invalid = inventoryCapacityFailure(
        state.vessels[destination.vesselId],
        destination.quantity
      );
      if (invalid) return invalid;
      state.stocks[source.id] = { ...source, quantity: debit.remaining };
      state.stocks[destination.id] = destination;
      return null;
    }
    case 'pool':
    case 'dilute': {
      if (
        command.stockId === command.lotId ||
        inventoryRecordIdExists(state, command.stockId) ||
        inventoryRecordIdExists(state, command.lotId)
      )
        return refuse(
          'ID_ALREADY_EXISTS',
          'A new lot and stock require distinct unused identifiers.'
        );
      const vessel = emptyVessel(state, command.vesselId);
      if ('ok' in vessel) return vessel;
      const inputs = command.kind === 'pool' ? command.inputs : [command.sample, command.diluent];
      if (new Set(inputs.map((input) => input.stockId)).size !== inputs.length)
        return refuse(
          'INVALID_INVENTORY_INPUT',
          'Each contribution must identify a different source stock.'
        );
      const contributions: InventoryContribution[] = [];
      const remaining = new Map<string, InventoryQuantity>();
      for (const input of inputs) {
        const debit = contribution(state, input);
        if ('ok' in debit) return debit;
        contributions.push({
          ...debit.contribution,
          quantity: normalizeInventoryVolume(input.quantity),
        });
        remaining.set(input.stockId, debit.remaining);
      }
      const quantity = normalizeInventoryQuantity({
        kind: 'known' as const,
        ...addInventoryVolumes(contributions.map((input) => input.quantity)),
      });
      const invalid = inventoryCapacityFailure(vessel, quantity);
      if (invalid) return invalid;
      const composition = mixInventoryCompositions(
        contributions,
        'mixing' in command ? command.mixing : 'unknown'
      );
      const inheritedValidity = physicalValidity(
        mergeInventoryInheritedValidity(
          ...inputs.map((input) =>
            inventoryStockValidityInheritance(state.stocks[input.stockId], null)
          )
        ),
        context
      );
      if ('ok' in inheritedValidity) return inheritedValidity;
      const origin: InventoryLot['origin'] =
        command.kind === 'pool'
          ? { kind: 'pooled', inputs: contributions }
          : { kind: 'diluted', sample: contributions[0], diluent: contributions[1] };
      for (const [id, quantity] of remaining) state.stocks[id] = { ...state.stocks[id], quantity };
      state.lots[command.lotId] = {
        ...emptyInventoryLotValidity(),
        inheritedValidity,
        id: command.lotId,
        materialId: command.materialId,
        name: command.name,
        origin,
        controls: { kind: 'legacy-untracked' },
        lotConstraints: inventoryLotConstraints(
          command.lotId,
          ...inputs.map((input) => state.stocks[input.stockId].lotConstraints)
        ),
      };
      state.stocks[command.stockId] = {
        ...emptyInventoryStockValidity(),
        inheritedValidity,
        id: command.stockId,
        vesselId: vessel.id,
        materialId: command.materialId,
        source: { kind: 'lot', lotId: command.lotId },
        lotConstraints: mergeInventoryLotConstraints(state.lots[command.lotId].lotConstraints),
        quantity,
        quality: 'usable',
        composition,
      };
      return null;
    }
    default:
      return undefined;
  }
}

export function inventoryCommandWithdrawals(
  command: InventoryCommand
): readonly InventoryWithdrawal[] {
  switch (command.kind) {
    case 'consume':
      return [{ stockId: command.stockId, quantity: command.quantity }];
    case 'transfer':
      return [{ stockId: command.sourceStockId, quantity: command.quantity }];
    case 'pool':
      return command.inputs;
    case 'dilute':
      return [command.sample, command.diluent];
    default:
      return [];
  }
}
