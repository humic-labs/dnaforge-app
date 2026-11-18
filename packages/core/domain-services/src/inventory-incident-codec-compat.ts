const legacySnapshotSchemas = new Set([
  'dnaforge.inventory.v20',
  'dnaforge.inventory.v21',
  'dnaforge.inventory.v22',
  'dnaforge.inventory.v23',
  'dnaforge.inventory.v24',
  'dnaforge.inventory.v25',
  'dnaforge.inventory.v26',
  'dnaforge.inventory.v27',
  'dnaforge.inventory.v28',
  'dnaforge.inventory.v29',
]);

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rows(value: unknown): unknown[] {
  return record(value) ? Object.values(value) : [];
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function effects(value: unknown): Record<string, unknown> | null {
  return record(value) && record(value.effects) ? value.effects : null;
}

export function inventoryIncidentTypedSnapshots(
  state: Record<string, unknown>
): readonly Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const add = (value: unknown) => {
    if (record(value)) result.push(value);
  };
  const pair = (value: unknown) => {
    if (!record(value)) return;
    add(value.before);
    add(value.after);
  };

  for (const value of rows(state.stocks)) add(value);
  for (const value of rows(state.lots)) add(value);
  for (const value of rows(state.scientificWorks)) {
    const effect = effects(value);
    if (!effect) continue;
    pair(effect.source);
    if (record(effect.destination)) add(effect.destination.after);
  }
  for (const value of rows(state.platePlanObservations)) {
    const effect = effects(value);
    if (!effect) continue;
    for (const source of list(effect.sources)) pair(source);
    for (const destination of list(effect.destinations)) {
      if (record(destination)) add(destination.after);
    }
  }
  for (const value of rows(state.scientificProductions)) {
    const effect = effects(value);
    if (!effect) continue;
    for (const source of list(effect.sources)) pair(source);
    if (record(effect.lot)) add(effect.lot.after);
    if (record(effect.stock)) add(effect.stock.after);
  }
  return result;
}

export function upcastInventoryIncidentSnapshots(
  state: Record<string, unknown>
): Record<string, unknown> {
  const copy = structuredClone(state);
  if (typeof copy.schema !== 'string' || !legacySnapshotSchemas.has(copy.schema)) return copy;
  for (const row of inventoryIncidentTypedSnapshots(copy)) {
    if (!Object.hasOwn(row, 'incidentReviewRootIds')) row.incidentReviewRootIds = [];
  }
  return copy;
}
