export function inventoryFixtureMetadataDefaults(state) {
  return {
    schema: 'dnaforge.inventory.v16',
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
