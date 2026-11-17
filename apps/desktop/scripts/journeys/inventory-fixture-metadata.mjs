export function inventoryFixtureMetadataDefaults(state) {
  return {
    schema: 'dnaforge.inventory.v18',
    vesselBindings: state.vesselBindings ?? {},
    vessels: Object.fromEntries(
      Object.entries(state.vessels).map(([key, vessel]) => [
        key,
        {
          ...vessel,
          contentsKnowledge: vessel.contentsKnowledge ?? { kind: 'recorded' },
        },
      ])
    ),
    hierarchyBindings: state.hierarchyBindings ?? {},
    stocks: Object.fromEntries(
      Object.entries(state.stocks).map(([id, stock]) => [
        id,
        {
          ...stock,
          quantity:
            stock.quantity.kind === 'unknown' && !('unit' in stock.quantity)
              ? { kind: 'unknown', unit: 'uL' }
              : stock.quantity,
        },
      ])
    ),
    observations: Object.fromEntries(
      Object.entries(state.observations ?? {}).map(([key, observation]) => [
        key,
        observation.fact.kind === 'quantity' &&
        observation.fact.quantity.kind === 'unknown' &&
        !('unit' in observation.fact.quantity)
          ? {
              ...observation,
              fact: { kind: 'quantity', quantity: { kind: 'unknown', unit: 'uL' } },
            }
          : observation,
      ])
    ),
    tableBindings: Object.fromEntries(
      Object.entries(state.tableBindings ?? {}).map(([key, binding]) => [
        key,
        { ...binding, sourceRevisions: binding.sourceRevisions ?? [] },
      ])
    ),
  };
}
