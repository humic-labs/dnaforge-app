import type {
  InventoryCatalogEligibility,
  InventoryCatalogProjection,
  InventoryCatalogSelectionBlocker,
  InventoryCatalogTarget,
  InventoryCatalogVersionStatus,
  InventoryPhysicalItem,
  InventoryRecipeComponent,
  InventoryState,
} from './inventory-types';

type CatalogState = Pick<InventoryState, 'typeVersions' | 'recipeVersions'>;

export function inventoryCatalogRecipeEligibility(
  state: CatalogState,
  recipeVersionId: string,
  components: readonly InventoryRecipeComponent[],
  componentKeys?: readonly string[]
): InventoryCatalogEligibility {
  const target: InventoryCatalogTarget = { kind: 'recipe-version', versionId: recipeVersionId };
  const blockers: InventoryCatalogSelectionBlocker[] = [];
  if (state.recipeVersions[recipeVersionId]?.selection.kind === 'retired')
    blockers.push({ code: 'CATALOG_VERSION_RETIRED', target });
  const selected = new Set(componentKeys ?? components.map((component) => component.key));
  const byKey = new Map(components.map((component) => [component.key, component]));
  for (const key of selected) {
    const parent = byKey.get(key)?.parentKey;
    if (parent !== null && parent !== undefined) selected.add(parent);
  }
  const retired = [
    ...new Set(
      components
        .filter((component) => selected.has(component.key))
        .map((component) => component.typeVersionId)
        .filter((id) => state.typeVersions[id]?.selection.kind === 'retired')
    ),
  ].sort();
  if (retired.length)
    blockers.push({ code: 'CATALOG_DEPENDENCY_RETIRED', target, typeVersionIds: retired });
  return blockers.length ? { kind: 'blocked', blockers } : { kind: 'selectable' };
}

export function inventoryCatalogVersionStatus(
  state: CatalogState,
  target: InventoryCatalogTarget,
  componentKeys?: readonly string[]
): InventoryCatalogVersionStatus | null {
  const row =
    target.kind === 'type-version'
      ? state.typeVersions[target.versionId]
      : state.recipeVersions[target.versionId];
  if (!row) return null;
  const family =
    target.kind === 'type-version'
      ? Object.values(state.typeVersions).filter(
          (entry) => entry.typeId === state.typeVersions[target.versionId].typeId
        )
      : Object.values(state.recipeVersions).filter(
          (entry) => entry.recipeId === state.recipeVersions[target.versionId].recipeId
        );
  const head = family.reduce((latest, entry) => (entry.version > latest.version ? entry : latest));
  const eligibility: InventoryCatalogEligibility =
    target.kind === 'recipe-version'
      ? inventoryCatalogRecipeEligibility(
          state,
          row.id,
          state.recipeVersions[row.id].components,
          componentKeys
        )
      : row.selection.kind === 'retired'
        ? {
            kind: 'blocked',
            blockers: [{ code: 'CATALOG_VERSION_RETIRED', target: { ...target } }],
          }
        : { kind: 'selectable' };
  return {
    target: { ...target },
    selection: structuredClone(row.selection),
    relationship: row.id === head.id ? 'current' : 'superseded',
    headVersionId: head.id,
    eligibility,
    actions: {
      retire: row.selection.kind === 'available',
      restore: row.selection.kind === 'retired',
    },
  };
}

export function inventoryCatalogProjection(state: CatalogState): InventoryCatalogProjection {
  const typeVersions: Record<string, InventoryCatalogVersionStatus> = Object.create(null);
  const recipeVersions: Record<string, InventoryCatalogVersionStatus> = Object.create(null);
  for (const versionId of Object.keys(state.typeVersions))
    typeVersions[versionId] = inventoryCatalogVersionStatus(state, {
      kind: 'type-version',
      versionId,
    })!;
  for (const versionId of Object.keys(state.recipeVersions))
    recipeVersions[versionId] = inventoryCatalogVersionStatus(state, {
      kind: 'recipe-version',
      versionId,
    })!;
  return { typeVersions, recipeVersions };
}

export function inventoryCatalogTypeAdoption(
  state: CatalogState & Pick<InventoryState, 'storage' | 'vessels'>,
  item: InventoryPhysicalItem,
  typeVersionId: string | null
): InventoryCatalogEligibility | null {
  const row = item.kind === 'storage' ? state.storage[item.id] : state.vessels[item.id];
  if (!row) return null;
  if (typeVersionId === null || row.configuration.typeVersionId === typeVersionId)
    return { kind: 'selectable' };
  return (
    inventoryCatalogVersionStatus(state, { kind: 'type-version', versionId: typeVersionId })
      ?.eligibility ?? null
  );
}
