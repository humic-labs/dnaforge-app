import type {
  InventoryCommand,
  InventoryErrorCode,
  InventoryPhysicalExecutionContext,
  InventoryLot,
  InventoryState,
  InventoryStock,
} from './inventory-types';
import type {
  InventoryEffectiveValidityFamily,
  InventoryInheritedValidity,
  InventoryOpeningObservation,
  InventoryStockValidity,
  InventoryValidityAdmission,
  InventoryValidityBlocker,
  InventoryValidityFact,
} from './inventory-validity-types';
import { inventoryItemContains } from './inventory-placement';
import { inventoryRecordIdExists } from './inventory-identity';

type Failure = { readonly ok: false; readonly code: InventoryErrorCode; readonly message: string };
const refuse = (code: InventoryErrorCode, message: string): Failure => ({
  ok: false,
  code,
  message,
});
const order = (first: string, second: string): number =>
  first < second ? -1 : first > second ? 1 : 0;
type ValidityState = Pick<
  InventoryState,
  'stocks' | 'lots' | 'openingObservations' | 'validityFacts' | 'lastRecordedAt'
>;

export function emptyInventoryStockValidity(): Pick<
  InventoryStock,
  'opening' | 'validity' | 'inheritedValidity' | 'incidentReviewRootIds'
> {
  return {
    incidentReviewRootIds: [],
    opening: { kind: 'unobserved', observationId: null },
    validity: { kind: 'legacy-untracked' },
    inheritedValidity: [],
  };
}
export function emptyInventoryLotValidity(): Pick<
  InventoryLot,
  'validity' | 'inheritedValidity' | 'incidentReviewRootIds'
> {
  return {
    validity: { kind: 'legacy-untracked' },
    inheritedValidity: [],
    incidentReviewRootIds: [],
  };
}
export function mergeInventoryInheritedValidity(
  ...collections: readonly (readonly InventoryInheritedValidity[])[]
): readonly InventoryInheritedValidity[] {
  const roots = new Map<string, number | null>();
  for (const collection of collections)
    for (const { rootId, openingNoLaterThan } of collection) {
      const previous = roots.get(rootId);
      roots.set(
        rootId,
        previous == null
          ? openingNoLaterThan
          : openingNoLaterThan === null
            ? previous
            : Math.min(previous, openingNoLaterThan)
      );
    }
  return [...roots]
    .sort(([a], [b]) => order(a, b))
    .map(([rootId, openingNoLaterThan]) => ({ rootId, openingNoLaterThan }));
}
export function bindInventoryInheritedValidity(
  refs: readonly InventoryInheritedValidity[],
  at: number
): readonly InventoryInheritedValidity[] {
  if (!Number.isSafeInteger(at) || at < 0)
    throw new TypeError('Validity derivation requires trusted safe time.');
  return mergeInventoryInheritedValidity(
    refs.map((ref) => ({
      ...ref,
      openingNoLaterThan:
        ref.openingNoLaterThan === null ? at : Math.min(at, ref.openingNoLaterThan),
    }))
  );
}
export function inventoryStockValidityInheritance(
  stock: InventoryStock,
  at: number | null
): readonly InventoryInheritedValidity[] {
  const refs = mergeInventoryInheritedValidity(
    stock.inheritedValidity,
    stock.validity.kind === 'managed'
      ? stock.validity.rootIds.map((rootId) => ({ rootId, openingNoLaterThan: null }))
      : []
  );
  return at === null ? refs : bindInventoryInheritedValidity(refs, at);
}

export function inventoryValidityFamilyHead(
  state: Pick<InventoryState, 'validityFacts'>,
  rootId: string
): InventoryValidityFact | null {
  const facts = Object.values(state.validityFacts).filter((fact) => fact.rootId === rootId);
  if (!facts.length) return null;
  const superseded = new Set(
    facts.flatMap((fact) => (fact.supersedesId === null ? [] : [fact.supersedesId]))
  );
  const heads = facts.filter((fact) => !superseded.has(fact.id));
  if (heads.length !== 1) throw new TypeError('A validity family requires one current head.');
  return heads[0];
}

const admission = (blockers: readonly InventoryValidityBlocker[]): InventoryValidityAdmission =>
  blockers.length
    ? { kind: 'blocked', blockers: [blockers[0], ...blockers.slice(1)] }
    : { kind: 'allowed' };

export function inventoryStockValidity(
  state: ValidityState,
  stockId: string,
  asOf: number
): InventoryStockValidity | null {
  if (!Number.isSafeInteger(asOf) || asOf < state.lastRecordedAt)
    throw new TypeError(
      'Validity time must be a safe timestamp at or after the recorded clock floor.'
    );
  const stock = Object.hasOwn(state.stocks, stockId) ? state.stocks[stockId] : undefined;
  if (!stock) return null;
  const lots = stock.lotConstraints.lotIds.map((id) => state.lots[id]);
  const ownRoots = stock.validity.kind === 'managed' ? stock.validity.rootIds : [];
  const refs = mergeInventoryInheritedValidity(
    stock.inheritedValidity,
    ownRoots.map((rootId) => ({ rootId, openingNoLaterThan: null })),
    lots.flatMap((lot) =>
      lot.validity.kind === 'managed'
        ? lot.validity.rootIds.map((rootId) => ({ rootId, openingNoLaterThan: null }))
        : []
    )
  );
  const reserve: InventoryValidityBlocker[] = [];
  const withdraw: InventoryValidityBlocker[] = [];
  const families: InventoryEffectiveValidityFamily[] = [];
  const both = (blocker: InventoryValidityBlocker) => {
    reserve.push(blocker);
    withdraw.push(blocker);
  };
  for (const ref of refs) {
    const fact = inventoryValidityFamilyHead(state, ref.rootId);
    if (!fact) throw new TypeError('Applicable validity requires an existing family.');
    const ids = { rootId: fact.rootId, headId: fact.id };
    let deadlineAt: number | null = null;
    let familyState: InventoryEffectiveValidityFamily['state'] = 'unresolved';
    let opening: InventoryEffectiveValidityFamily['opening'] = null;
    if (fact.by.kind === 'imported') both({ code: 'VALIDITY_ASSESSMENT_IMPORTED', ...ids });
    switch (fact.rule.kind) {
      case 'unresolved':
        both({ code: 'VALIDITY_UNRESOLVED', ...ids });
        break;
      case 'not-required':
        familyState = 'not-required';
        break;
      case 'absolute':
        deadlineAt = fact.rule.deadlineAt;
        break;
      case 'after-opening': {
        const owner = state.stocks[fact.rule.openingStockId];
        if (!owner)
          throw new TypeError('An opening-dependent policy requires its retained stock owner.');
        const observation =
          owner.opening.observationId === null
            ? null
            : state.openingObservations[owner.opening.observationId];
        opening = {
          stockId: owner.id,
          state: structuredClone(owner.opening),
          observation: observation ? structuredClone(observation) : null,
        };
        const openingIds = {
          ...ids,
          openingStockId: owner.id,
          observationId: owner.opening.observationId,
        };
        if (owner.opening.kind === 'unobserved') both({ code: 'VALIDITY_UNRESOLVED', ...ids });
        else if (!observation || observation.observedAt === null)
          both({ code: 'OPENING_TIME_UNKNOWN', ...openingIds });
        else if (
          ref.openingNoLaterThan !== null &&
          (owner.opening.kind === 'sealed-observed' ||
            observation.observedAt > ref.openingNoLaterThan)
        )
          both({
            code: 'VALIDITY_CHRONOLOGY_CONFLICT',
            ...openingIds,
            openingNoLaterThan: ref.openingNoLaterThan,
          });
        else if (owner.opening.kind === 'sealed-observed') {
          familyState = 'awaiting-opening';
          withdraw.push({ code: 'OPENING_REQUIRED', ...ids, openingStockId: owner.id });
        } else {
          const cutoff = observation.observedAt + fact.rule.elapsedMs;
          if (!Number.isSafeInteger(cutoff)) both({ code: 'VALIDITY_UNRESOLVED', ...ids });
          else deadlineAt = cutoff;
        }
        break;
      }
    }
    if (deadlineAt !== null) {
      familyState = asOf >= deadlineAt ? 'expired' : 'current';
      if (familyState === 'expired') both({ code: 'MATERIAL_EXPIRED', ...ids, deadlineAt });
    }
    families.push({
      ...ids,
      owner: structuredClone(fact.owner),
      rule: structuredClone(fact.rule),
      authority: fact.by.kind === 'imported' ? 'imported' : 'local',
      state: familyState,
      deadlineAt,
      openingNoLaterThan: ref.openingNoLaterThan,
      opening,
    });
  }
  const untracked =
    stock.validity.kind === 'legacy-untracked' ||
    lots.some((lot) => lot.validity.kind === 'legacy-untracked');
  const coverage = !refs.length ? 'legacy-untracked' : untracked ? 'mixed' : 'managed';
  const deadlines = families.flatMap((family) =>
    family.deadlineAt === null ? [] : [family.deadlineAt]
  );
  const future = deadlines.filter((at) => at > asOf);
  return {
    asOf,
    coverage,
    state: !refs.length
      ? 'legacy-untracked'
      : families.some((family) => family.state === 'expired')
        ? 'expired'
        : withdraw.length
          ? 'unresolved'
          : 'current',
    effectiveDeadlineAt: deadlines.length ? Math.min(...deadlines) : null,
    nextBoundaryAt: future.length ? Math.min(...future) : null,
    reserve: admission(reserve),
    withdraw: admission(withdraw),
    families,
  };
}

export function inventoryUseStockIds(
  state: Pick<InventoryState, 'stocks' | 'storage' | 'vessels'>,
  command: InventoryCommand
): { readonly stockIds: readonly string[]; readonly action: 'reserve' | 'withdraw' } {
  switch (command.kind) {
    case 'consume':
      return { stockIds: [command.stockId], action: 'withdraw' };
    case 'reserve-quantity':
      return { stockIds: [command.stockId], action: 'reserve' };
    case 'transfer':
      return {
        stockIds: [
          command.sourceStockId,
          ...(command.destination.kind === 'existing-stock' ? [command.destination.stockId] : []),
        ],
        action: 'withdraw',
      };
    case 'pool':
      return { stockIds: command.inputs.map((input) => input.stockId), action: 'withdraw' };
    case 'dilute':
      return { stockIds: [command.sample.stockId, command.diluent.stockId], action: 'withdraw' };
    case 'reserve-item':
      return {
        stockIds: Object.values(state.stocks)
          .filter((stock) =>
            inventoryItemContains(state, command.item, { kind: 'vessel', id: stock.vesselId })
          )
          .map((stock) => stock.id),
        action: 'reserve',
      };
    case 'fulfill-reservations':
      return inventoryUseStockIds(state, command.withdrawal);
    default:
      return { stockIds: [], action: 'withdraw' };
  }
}

export function inventoryValidityUseGuard(
  state: ValidityState & Pick<InventoryState, 'storage' | 'vessels'>,
  command: InventoryCommand,
  context?: InventoryPhysicalExecutionContext
): Failure | null {
  const { stockIds, action } = inventoryUseStockIds(state, command);
  for (const id of new Set(stockIds)) {
    const validity = inventoryStockValidity(state, id, context?.at ?? state.lastRecordedAt);
    if (!validity || validity.coverage === 'legacy-untracked') continue;
    if (!context)
      return refuse('CONTEXT_REQUIRED', 'Managed validity requires trusted execution time.');
    const result = validity[action];
    if (result.kind === 'blocked')
      return refuse(
        result.blockers[0].code,
        `Stock use is blocked by ${result.blockers[0].code} for validity family ${result.blockers[0].rootId}.`
      );
  }
  return null;
}

export interface InventoryValidityDraft extends Omit<
  InventoryState,
  'schema' | 'revision' | 'stocks' | 'lots' | 'openingObservations' | 'validityFacts'
> {
  readonly stocks: Record<string, InventoryStock>;
  readonly lots: Record<string, InventoryLot>;
  readonly openingObservations: Record<string, InventoryOpeningObservation>;
  readonly validityFacts: Record<string, InventoryValidityFact>;
}

export function applyInventoryValidityCommand(
  state: InventoryValidityDraft,
  command: InventoryCommand,
  context?: InventoryPhysicalExecutionContext
): Failure | null | undefined {
  if (
    command.kind !== 'record-stock-opening' &&
    command.kind !== 'correct-stock-opening' &&
    command.kind !== 'record-validity-decision' &&
    command.kind !== 'correct-validity-decision'
  )
    return undefined;
  if (!context)
    return refuse(
      'CONTEXT_REQUIRED',
      'Opening and validity facts require trusted recording context.'
    );
  if (inventoryRecordIdExists(state, command.id))
    return refuse('ID_ALREADY_EXISTS', 'That inventory identifier already exists.');
  if (command.kind === 'record-stock-opening' || command.kind === 'correct-stock-opening') {
    const stock = Object.hasOwn(state.stocks, command.stockId)
      ? state.stocks[command.stockId]
      : undefined;
    if (!stock) return refuse('STOCK_NOT_FOUND', 'The opening stock does not exist.');
    if (command.observedAt !== null && command.observedAt > context.at)
      return refuse(
        'OBSERVATION_TIME_FUTURE',
        'Opening observation time cannot follow native recording time.'
      );
    const previous =
      stock.opening.observationId === null
        ? null
        : state.openingObservations[stock.opening.observationId];
    const facts = {
      id: command.id,
      stockId: stock.id,
      source: command.source ? { ...command.source } : null,
      reason: command.reason,
      at: context.at,
      by: { ...context.principal },
    };
    let observation: InventoryOpeningObservation;
    if (command.kind === 'correct-stock-opening') {
      if (!Object.hasOwn(state.openingObservations, command.supersedesId))
        return refuse('OPENING_NOT_FOUND', 'The corrected opening observation does not exist.');
      if (!previous || previous.id !== command.supersedesId)
        return refuse(
          'OPENING_STALE_HEAD',
          'Correct the current observation for this exact stock.'
        );
      observation =
        command.value === 'unobserved'
          ? {
              ...facts,
              kind: 'correction',
              value: 'unobserved',
              observedAt: null,
              supersedesId: previous.id,
            }
          : {
              ...facts,
              kind: 'correction',
              value: 'opened',
              observedAt: command.observedAt,
              supersedesId: previous.id,
            };
    } else {
      if (
        (command.value === 'sealed' && previous !== null) ||
        stock.opening.kind === 'opened-observed'
      )
        return refuse(
          'OPENING_ALREADY_RECORDED',
          'Opening history cannot be reset or resealed by ordinary recording.'
        );
      if (
        stock.opening.kind === 'sealed-observed' &&
        previous?.observedAt !== null &&
        previous?.observedAt !== undefined &&
        command.observedAt !== null &&
        command.observedAt < previous.observedAt
      )
        return refuse(
          'OPENING_TIME_CONFLICT',
          'An ordinary opening cannot precede the recorded sealed observation.'
        );
      observation =
        previous === null
          ? {
              ...facts,
              kind: 'initial',
              value: command.value,
              observedAt: command.observedAt,
              supersedesId: null,
            }
          : {
              ...facts,
              kind: 'opening',
              value: 'opened',
              observedAt: command.observedAt,
              supersedesId: previous.id,
            };
    }
    state.openingObservations[observation.id] = observation;
    state.stocks[stock.id] = {
      ...stock,
      opening: {
        kind:
          observation.value === 'sealed'
            ? 'sealed-observed'
            : observation.value === 'opened'
              ? 'opened-observed'
              : 'unobserved',
        observationId: observation.id,
      },
    };
    return null;
  }
  let previous: InventoryValidityFact | null = null;
  if (command.kind === 'correct-validity-decision') {
    previous = Object.hasOwn(state.validityFacts, command.supersedesId)
      ? state.validityFacts[command.supersedesId]
      : null;
    if (!previous)
      return refuse('VALIDITY_FACT_NOT_FOUND', 'The corrected validity fact does not exist.');
    if (inventoryValidityFamilyHead(state, previous.rootId)?.id !== previous.id)
      return refuse('VALIDITY_STALE_HEAD', 'Correct the current head of the validity family.');
  }
  const owner = command.kind === 'record-validity-decision' ? command.owner : previous!.owner;
  const target = owner.kind === 'stock' ? state.stocks[owner.stockId] : state.lots[owner.lotId];
  if (!target)
    return refuse(
      owner.kind === 'stock' ? 'STOCK_NOT_FOUND' : 'LOT_NOT_FOUND',
      'The validity owner does not exist.'
    );
  if (
    command.rule.kind === 'after-opening' &&
    (owner.kind !== 'stock' || command.rule.openingStockId !== owner.stockId)
  )
    return refuse(
      'INVALID_VALIDITY_RULE',
      'An after-opening rule must name its original stock owner.'
    );
  const fact: InventoryValidityFact = {
    id: command.id,
    rootId: previous?.rootId ?? command.id,
    supersedesId: previous?.id ?? null,
    owner: { ...owner },
    rule: { ...command.rule },
    sourceText: command.sourceText,
    sourcePrecision: command.sourcePrecision,
    source: command.source ? { ...command.source } : null,
    reason: command.reason,
    at: context.at,
    by: { ...context.principal },
  };
  state.validityFacts[fact.id] = fact;
  if (previous === null) {
    const rootIds = [
      ...(target.validity.kind === 'managed' ? target.validity.rootIds : []),
      fact.rootId,
    ].sort(order);
    if (owner.kind === 'stock')
      state.stocks[owner.stockId] = {
        ...state.stocks[owner.stockId],
        validity: { kind: 'managed', rootIds },
      };
    else
      state.lots[owner.lotId] = {
        ...state.lots[owner.lotId],
        validity: { kind: 'managed', rootIds },
      };
  }
  return null;
}
