export function inventoryFixtureMetadataDefaults(state) {
  return {
    schema: 'dnaforge.inventory.v17',
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
    observations: state.observations ?? {},
    tableBindings: Object.fromEntries(
      Object.entries(state.tableBindings ?? {}).map(([key, binding]) => [
        key,
        { ...binding, sourceRevisions: binding.sourceRevisions ?? [] },
      ])
    ),
  };
}
