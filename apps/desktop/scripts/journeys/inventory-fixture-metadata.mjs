export function inventoryFixtureMetadataDefaults(state) {
  if (state.schema !== 'dnaforge.inventory.v19')
    throw new Error(
      'Capture an exact current native fixture with refresh-fixture before resuming this journey.'
    );
  const {
    schema,
    vesselBindings,
    vessels,
    hierarchyBindings,
    stocks,
    observations,
    tableBindings,
    lots,
    lotRecalls,
  } = state;
  return {
    schema,
    vesselBindings,
    vessels,
    hierarchyBindings,
    stocks,
    observations,
    tableBindings,
    lots,
    lotRecalls,
  };
}
