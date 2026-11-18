import type {
  InventoryCommand,
  InventoryPhysicalExecutionContext,
  InventoryState,
  InventoryTransition,
  InventoryVessel,
} from './inventory-types';
import type { InventoryVesselContents } from './inventory-contents-types';

type ContentsState = Pick<InventoryState, 'vessels' | 'stocks'>;
type ContentsDraft = Omit<ContentsState, 'vessels'> & {
  readonly vessels: Record<string, InventoryVessel>;
};
type Failure = Extract<InventoryTransition, { readonly ok: false }>;
const refuse = (code: Failure['code'], message: string): Failure => ({ ok: false, code, message });

function project(vessel: InventoryVessel, stockId: string | undefined): InventoryVesselContents {
  if (vessel.contentsKnowledge.kind !== 'recorded')
    return structuredClone(vessel.contentsKnowledge);
  return stockId ? { kind: 'identified', stockId } : { kind: 'declared-empty' };
}

export function inventoryVesselContents(
  state: ContentsState,
  vesselId: string
): InventoryVesselContents | null {
  const vessel = Object.hasOwn(state.vessels, vesselId) ? state.vessels[vesselId] : undefined;
  if (!vessel) return null;
  const stock = Object.values(state.stocks).find((stock) => stock.vesselId === vesselId);
  return project(vessel, stock?.id);
}

export function inventoryVesselContentsProjection(
  state: ContentsState
): Readonly<Record<string, InventoryVesselContents>> {
  const stocks = new Map(Object.values(state.stocks).map((stock) => [stock.vesselId, stock.id]));
  return Object.fromEntries(
    Object.values(state.vessels).map((vessel) => [
      vessel.id,
      project(vessel, stocks.get(vessel.id)),
    ])
  );
}

export function inventoryVesselStockAdmission(
  state: ContentsState,
  vesselId: string,
  mode: 'receive' | 'identify' = 'receive'
): InventoryVessel | Failure {
  const vessel = Object.hasOwn(state.vessels, vesselId) ? state.vessels[vesselId] : undefined;
  if (!vessel) return refuse('VESSEL_NOT_FOUND', 'The destination vessel does not exist.');
  if (vessel.lifecycle !== 'active')
    return refuse('VESSEL_DISPOSED', 'The destination vessel has been disposed.');
  if (Object.values(state.stocks).some((stock) => stock.vesselId === vesselId))
    return refuse('STOCK_ALREADY_PRESENT', 'The vessel already has an identified stock record.');
  if (mode === 'identify')
    return vessel.contentsKnowledge.kind === 'recorded'
      ? refuse(
          'VESSEL_CONTENTS_RECORDED',
          'Identify existing contents only after recording unresolved contents.'
        )
      : vessel;
  return vessel.contentsKnowledge.kind === 'recorded'
    ? vessel
    : refuse('VESSEL_CONTENTS_UNRESOLVED', 'Resolve the vessel contents before adding material.');
}

export function applyInventoryContentsCommand(
  state: ContentsDraft,
  command: InventoryCommand,
  context?: InventoryPhysicalExecutionContext
): Failure | null | undefined {
  if (
    command.kind !== 'record-vessel-contents' &&
    command.kind !== 'record-vessels-contents' &&
    command.kind !== 'declare-vessel-empty'
  )
    return undefined;
  if (!context)
    return refuse('CONTEXT_REQUIRED', 'Contents declarations require a trusted actor and clock.');
  const ids = command.kind === 'record-vessels-contents' ? command.vesselIds : [command.vesselId];
  const occupied = new Set(Object.values(state.stocks).map((stock) => stock.vesselId));
  for (const id of ids) {
    const vessel = Object.hasOwn(state.vessels, id) ? state.vessels[id] : undefined;
    if (!vessel) return refuse('VESSEL_NOT_FOUND', 'The vessel does not exist.');
    if (vessel.lifecycle !== 'active')
      return refuse('VESSEL_DISPOSED', 'A disposed vessel cannot be inventoried.');
    if (occupied.has(id))
      return refuse(
        'STOCK_ALREADY_PRESENT',
        'Contents declarations cannot erase an identified stock, including known zero.'
      );
  }
  for (const id of ids) {
    state.vessels[id] = {
      ...state.vessels[id],
      contentsKnowledge:
        command.kind === 'declare-vessel-empty'
          ? { kind: 'recorded' }
          : {
              kind: command.knowledge,
              reason: command.reason,
              at: context.at,
              by: { ...context.principal },
            },
    };
  }
  return null;
}
