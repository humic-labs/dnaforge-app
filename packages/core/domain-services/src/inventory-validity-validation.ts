import type {
  InventoryOpeningObservation,
  InventoryState,
  InventoryValidityFact,
  InventoryValidityOwner,
} from './inventory-types';

const fail = (message: string): never => {
  throw new TypeError(message);
};
const ownerKey = (owner: InventoryValidityOwner): string =>
  owner.kind === 'stock' ? `stock:${owner.stockId}` : `lot:${owner.lotId}`;

interface ChainFact {
  readonly id: string;
  readonly supersedesId: string | null;
  readonly at: number;
}

function chainHeads<T extends ChainFact>(
  rows: Readonly<Record<string, T>>,
  family: (row: T) => string,
  description: string
): ReadonlyMap<string, T> {
  const groups = new Map<string, T[]>();
  const children = new Map<string, string>();
  for (const [id, row] of Object.entries(rows)) {
    if (id !== row.id) fail(`${description} keys must match their exact fact IDs.`);
    const key = family(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
    if (row.supersedesId !== null) {
      const parent = rows[row.supersedesId];
      if (!parent || family(parent) !== key || parent.at > row.at)
        fail(`${description} corrections must follow an existing same-family fact.`);
      if (children.has(parent.id)) fail(`${description} correction chains cannot fork.`);
      children.set(parent.id, row.id);
    }
  }
  const result = new Map<string, T>();
  for (const [key, group] of groups) {
    const roots = group.filter((row) => row.supersedesId === null);
    const leaves = group.filter((row) => !children.has(row.id));
    if (roots.length !== 1 || leaves.length !== 1)
      fail(`${description} require one acyclic chain and one current head.`);
    const seen = new Set<string>();
    let row: T | undefined = roots[0];
    while (row) {
      if (seen.has(row.id)) fail(`${description} correction chains cannot cycle.`);
      seen.add(row.id);
      const child = children.get(row.id);
      row = child === undefined ? undefined : rows[child];
    }
    if (seen.size !== group.length) fail(`${description} cannot contain disconnected facts.`);
    result.set(key, leaves[0]);
  }
  return result;
}

export function validateInventoryValidityState(state: InventoryState): void {
  const recorded = (fact: { readonly at: number }) => {
    if (fact.at > state.lastRecordedAt)
      fail('Validity facts cannot exceed the recorded inventory clock.');
  };
  for (const fact of Object.values(state.openingObservations)) {
    recorded(fact);
    if (!Object.hasOwn(state.stocks, fact.stockId))
      fail('Opening observations require an existing stock episode.');
    if (fact.observedAt !== null && fact.observedAt > fact.at)
      fail('An observed opening cannot follow its native recording time.');
    if (fact.kind === 'initial') {
      if (fact.supersedesId !== null) fail('An initial opening observation cannot replace a fact.');
    } else {
      const parent = state.openingObservations[fact.supersedesId];
      if (!parent) fail('An opening correction requires its existing predecessor.');
      if (fact.kind === 'opening') {
        if (parent.value !== 'sealed' && parent.value !== 'unobserved')
          fail('First opening cannot be recorded again without an explicit correction.');
        if (
          parent.value === 'sealed' &&
          parent.observedAt !== null &&
          fact.observedAt !== null &&
          fact.observedAt < parent.observedAt
        )
          fail('An ordinary opening cannot precede its sealed observation.');
      }
    }
  }
  const openingHeads = chainHeads<InventoryOpeningObservation>(
    state.openingObservations,
    (row) => row.stockId,
    'Opening observations'
  );
  for (const stock of Object.values(state.stocks)) {
    const head = openingHeads.get(stock.id);
    if (!head) {
      if (stock.opening.kind !== 'unobserved' || stock.opening.observationId !== null)
        fail('Unobserved stock without facts must retain an explicit null opening head.');
    } else {
      const expected =
        head.value === 'sealed'
          ? 'sealed-observed'
          : head.value === 'opened'
            ? 'opened-observed'
            : 'unobserved';
      if (stock.opening.observationId !== head.id || stock.opening.kind !== expected)
        fail('Stock opening must select its exact current same-owner observation.');
    }
  }

  for (const fact of Object.values(state.validityFacts)) {
    recorded(fact);
    const owner =
      fact.owner.kind === 'stock' ? state.stocks[fact.owner.stockId] : state.lots[fact.owner.lotId];
    if (!owner) fail('Validity decisions require an existing exact stock or lot owner.');
    if (fact.supersedesId === null) {
      if (fact.id !== fact.rootId)
        fail('An initial validity decision must be its own family root.');
    } else {
      const parent = state.validityFacts[fact.supersedesId];
      if (!parent || ownerKey(parent.owner) !== ownerKey(fact.owner))
        fail('Validity corrections cannot change their original owner.');
    }
    if (
      fact.rule.kind === 'after-opening' &&
      (fact.owner.kind !== 'stock' || fact.rule.openingStockId !== fact.owner.stockId)
    )
      fail('After-opening rules must bind their original stock owner.');
  }
  const heads = chainHeads<InventoryValidityFact>(
    state.validityFacts,
    (row) => row.rootId,
    'Validity families'
  );
  const rootsByOwner = new Map<string, Set<string>>();
  for (const [rootId, head] of heads) {
    const root = state.validityFacts[rootId];
    if (!root || root.supersedesId !== null || root.rootId !== rootId)
      fail('Validity family roots must select their original initial decision.');
    if (ownerKey(root.owner) !== ownerKey(head.owner))
      fail('A validity family cannot change owners.');
    const key = ownerKey(root.owner);
    const roots = rootsByOwner.get(key) ?? new Set<string>();
    roots.add(rootId);
    rootsByOwner.set(key, roots);
  }
  for (const owner of [
    ...Object.values(state.stocks).map((stock) => ({
      key: `stock:${stock.id}`,
      row: stock,
      physical: true,
    })),
    ...Object.values(state.lots).map((lot) => ({
      key: `lot:${lot.id}`,
      row: lot,
      physical: false,
    })),
  ]) {
    const actual = rootsByOwner.get(owner.key) ?? new Set<string>();
    const declared = owner.row.validity.kind === 'managed' ? owner.row.validity.rootIds : [];
    if (actual.size !== declared.length || declared.some((rootId) => !actual.has(rootId)))
      fail('Validity management must retain every exact owned family root.');
    for (const ref of owner.row.inheritedValidity) {
      const root = state.validityFacts[ref.rootId];
      if (
        !root ||
        root.id !== root.rootId ||
        root.supersedesId !== null ||
        root.owner.kind !== 'stock'
      )
        fail('Inherited validity must reference an existing original stock-owned family.');
      if (owner.physical && ref.openingNoLaterThan === null)
        fail('Physical stock inheritance requires a recorded derivation-time bound.');
      if (
        ref.openingNoLaterThan !== null &&
        (ref.openingNoLaterThan > state.lastRecordedAt || ref.openingNoLaterThan < root.at)
      )
        fail('Inherited derivation bounds must follow the known family inside the recorded clock.');
    }
  }
}
