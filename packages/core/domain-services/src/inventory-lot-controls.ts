import type {
  InventoryCommand,
  InventoryErrorCode,
  InventoryExecutionContext,
  InventoryLot,
  InventoryLotOrigin,
  InventoryState,
} from './inventory-types';
import type {
  InventoryLotConstraints,
  InventoryLotRecall,
  InventoryStockEligibility,
} from './inventory-lot-controls-types';
import { inventoryStockValidity, inventoryUseStockIds } from './inventory-validity';
import { inventoryRecordIdExists } from './inventory-identity';

type Failure = { readonly ok: false; readonly code: InventoryErrorCode; readonly message: string };
const refuse = (code: InventoryErrorCode, message: string): Failure => ({
  ok: false,
  code,
  message,
});
const order = (first: string, second: string): number =>
  first < second ? -1 : first > second ? 1 : 0;

export function mergeInventoryLotConstraints(
  ...inputs: readonly InventoryLotConstraints[]
): InventoryLotConstraints {
  return {
    knowledge: inputs.some((input) => input.knowledge === 'legacy-partial')
      ? 'legacy-partial'
      : 'recorded',
    lotIds: [...new Set(inputs.flatMap((input) => input.lotIds))].sort(order),
  };
}

export function inventoryLotConstraints(
  lotId: string,
  ...inputs: readonly InventoryLotConstraints[]
): InventoryLotConstraints {
  return mergeInventoryLotConstraints({ knowledge: 'recorded', lotIds: [lotId] }, ...inputs);
}

function originLotIds(origin: InventoryLotOrigin): readonly string[] {
  const inputs =
    origin.kind === 'received'
      ? []
      : origin.kind === 'diluted'
        ? [origin.sample, origin.diluent]
        : origin.inputs;
  return [
    ...new Set(
      inputs.flatMap((input) => (input.source.kind === 'lot' ? [input.source.lotId] : []))
    ),
  ];
}

export function projectLegacyInventoryLotConstraints(state: InventoryState): InventoryState {
  const constraints = new Map<string, InventoryLotConstraints>();
  const parents = new Map<string, readonly string[]>();
  const pending = new Map<string, number>();
  const children = new Map<string, string[]>();
  const ready: string[] = [];
  for (const lot of Object.values(state.lots)) {
    const ids = originLotIds(lot.origin);
    parents.set(lot.id, ids);
    pending.set(lot.id, ids.length);
    if (!ids.length) ready.push(lot.id);
    for (const id of ids) {
      if (!Object.hasOwn(state.lots, id))
        throw new TypeError('Lot ancestry requires an existing lot.');
      const list = children.get(id) ?? [];
      list.push(lot.id);
      children.set(id, list);
    }
  }
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index];
    constraints.set(id, {
      knowledge: 'legacy-partial',
      lotIds: inventoryLotConstraints(
        id,
        ...parents.get(id)!.map((parent) => constraints.get(parent)!)
      ).lotIds,
    });
    for (const child of children.get(id) ?? []) {
      const remaining = pending.get(child)! - 1;
      pending.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
  }
  if (ready.length !== Object.keys(state.lots).length)
    throw new TypeError('Lot ancestry must not contain a cycle.');
  const lots: Record<string, InventoryLot> = Object.create(null);
  for (const [id, lot] of Object.entries(state.lots))
    lots[id] = { ...lot, lotConstraints: constraints.get(id)! };
  const stocks: Record<string, InventoryState['stocks'][string]> = Object.create(null);
  for (const [id, stock] of Object.entries(state.stocks)) {
    const lotConstraints =
      stock.source.kind === 'lot'
        ? constraints.get(stock.source.lotId)
        : { knowledge: 'legacy-partial' as const, lotIds: [] };
    if (!lotConstraints) throw new TypeError('Stock ancestry requires an existing lot.');
    stocks[id] = { ...stock, lotConstraints };
  }
  return { ...state, lots, stocks };
}

type EligibilityState = Pick<
  InventoryState,
  'stocks' | 'lots' | 'lotRecalls' | 'openingObservations' | 'validityFacts' | 'lastRecordedAt'
>;

export function inventoryStockEligibility(
  state: EligibilityState,
  stockId: string,
  asOf: number
): InventoryStockEligibility | null {
  const stock = Object.hasOwn(state.stocks, stockId) ? state.stocks[stockId] : undefined;
  if (!stock) return null;
  const lots = stock.lotConstraints.lotIds.map((lotId) => {
    if (!Object.hasOwn(state.lots, lotId))
      throw new TypeError('Stock ancestry requires an existing lot.');
    return { lotId, controls: structuredClone(state.lots[lotId].controls) };
  });
  const blockers: InventoryStockEligibility['blockers'][number][] = [];
  if (stock.quality !== 'usable') blockers.push({ code: 'STOCK_QUARANTINED' });
  const activeRecallIds: string[] = [];
  for (const { lotId, controls } of lots) {
    if (controls.kind === 'managed') {
      const assessment = controls.assessment;
      if (assessment.value !== 'released')
        blockers.push({ code: 'LOT_NOT_RELEASED', lotId, assessment: assessment.value });
      else if (assessment.by.kind === 'imported')
        blockers.push({ code: 'LOT_ASSESSMENT_IMPORTED', lotId });
    }
    const recallIds = Object.values(state.lotRecalls)
      .filter((recall) => recall.lotId === lotId && recall.lifecycle.kind === 'active')
      .map((recall) => recall.id)
      .sort(order);
    if (recallIds.length) {
      activeRecallIds.push(...recallIds);
      blockers.push({ code: 'LOT_RECALLED', lotId, recallIds });
    }
  }
  return {
    validity: inventoryStockValidity(state, stockId, asOf)!,
    stockId,
    stockQuality: stock.quality,
    lotConstraints: structuredClone(stock.lotConstraints),
    coverage:
      stock.lotConstraints.knowledge === 'legacy-partial'
        ? 'legacy-partial'
        : !lots.length
          ? 'unattributed'
          : lots.some((lot) => lot.controls.kind === 'legacy-untracked')
            ? 'legacy-untracked'
            : 'managed',
    lots,
    activeRecallIds: activeRecallIds.sort(order),
    blockers,
  };
}

export function inventoryLotUseGuard(
  state: EligibilityState & Pick<InventoryState, 'storage' | 'vessels'>,
  command: InventoryCommand
): Failure | null {
  const { stockIds } = inventoryUseStockIds(state, command);
  for (const id of new Set(stockIds)) {
    const blocker = inventoryStockEligibility(state, id, state.lastRecordedAt)?.blockers.find(
      (entry) => entry.code !== 'STOCK_QUARANTINED'
    );
    if (blocker)
      return refuse(
        blocker.code,
        `Stock use is blocked by ${blocker.code} for lot ${blocker.lotId}.`
      );
  }
  return null;
}

type IdentityState = Pick<
  InventoryState,
  | 'storage'
  | 'vessels'
  | 'stocks'
  | 'reservations'
  | 'typeVersions'
  | 'recipeVersions'
  | 'fitEvidence'
  | 'itemCodes'
  | 'temperatureClaims'
  | 'openingObservations'
  | 'validityFacts'
>;
export interface InventoryLotControlDraft extends IdentityState {
  readonly lots: Record<string, InventoryLot>;
  readonly lotRecalls: Record<string, InventoryLotRecall>;
}

export function applyInventoryLotControlCommand(
  state: InventoryLotControlDraft,
  command: InventoryCommand,
  context?: InventoryExecutionContext
): Failure | null | undefined {
  if (
    command.kind !== 'manage-lot' &&
    command.kind !== 'assess-lot' &&
    command.kind !== 'record-lot-recall' &&
    command.kind !== 'withdraw-lot-recall'
  )
    return undefined;
  if (!context)
    return refuse('CONTEXT_REQUIRED', 'Lot controls require trusted recording context.');
  if (command.kind === 'withdraw-lot-recall') {
    const recall = Object.hasOwn(state.lotRecalls, command.recallId)
      ? state.lotRecalls[command.recallId]
      : undefined;
    if (!recall) return refuse('LOT_RECALL_NOT_FOUND', 'The lot recall does not exist.');
    if (recall.lifecycle.kind !== 'active')
      return refuse('LOT_RECALL_NOT_ACTIVE', 'Only an active recall can be withdrawn.');
    state.lotRecalls[recall.id] = {
      ...recall,
      lifecycle: {
        kind: 'withdrawn',
        at: context.at,
        by: { ...context.principal },
        reason: command.reason,
      },
    };
    return null;
  }
  const lot = Object.hasOwn(state.lots, command.lotId) ? state.lots[command.lotId] : undefined;
  if (!lot) return refuse('LOT_NOT_FOUND', 'The controlled lot does not exist.');
  if (command.kind === 'manage-lot') {
    if (lot.controls.kind === 'managed')
      return refuse('LOT_ALREADY_MANAGED', 'Lot management cannot be reset.');
    state.lots[lot.id] = {
      ...lot,
      controls: {
        kind: 'managed',
        assessment: {
          value: 'unassessed',
          at: context.at,
          by: { ...context.principal },
          reason: command.reason,
        },
      },
    };
    return null;
  }
  if (command.kind === 'assess-lot') {
    if (lot.controls.kind !== 'managed')
      return refuse(
        'LOT_MANAGEMENT_REQUIRED',
        'Start lot management before recording an assessment.'
      );
    const previous = lot.controls.assessment;
    if (
      previous.value === command.assessment &&
      !(command.assessment === 'released' && previous.by.kind === 'imported')
    )
      return refuse(
        'LOT_ASSESSMENT_UNCHANGED',
        'A local reassessment must change the recorded decision.'
      );
    state.lots[lot.id] = {
      ...lot,
      controls: {
        kind: 'managed',
        assessment: {
          value: command.assessment,
          at: context.at,
          by: { ...context.principal },
          reason: command.reason,
        },
      },
    };
    return null;
  }
  if (inventoryRecordIdExists(state, command.id))
    return refuse('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
  if (command.observedAt !== null && command.observedAt > context.at)
    return refuse(
      'OBSERVATION_TIME_FUTURE',
      'A recall observation cannot follow native recording time.'
    );
  state.lotRecalls[command.id] = {
    id: command.id,
    lotId: lot.id,
    observedAt: command.observedAt,
    source: command.source ? { ...command.source } : null,
    reason: command.reason,
    at: context.at,
    by: { ...context.principal },
    lifecycle: { kind: 'active' },
  };
  return null;
}
