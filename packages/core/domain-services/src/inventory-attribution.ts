import type {
  InventoryPrincipal,
  InventoryRecordedPrincipal,
  InventoryState,
} from './inventory-types';

export function inventoryPrincipalMatchesActor(
  recorded: InventoryRecordedPrincipal,
  actor: InventoryPrincipal | undefined
): boolean {
  if (!actor || recorded.kind === 'imported' || recorded.kind !== actor.kind) return false;
  return recorded.kind === 'agent'
    ? actor.kind === 'agent' && recorded.identityId === actor.identityId
    : actor.kind === 'local-profile' && recorded.profileKey === actor.profileKey;
}

function* recordedPrincipals(state: InventoryState): Generator<InventoryRecordedPrincipal> {
  for (const row of [...Object.values(state.storage), ...Object.values(state.vessels)]) {
    if (row.configuration.geometryOverride) yield row.configuration.geometryOverride.by;
    if ('custody' in row && row.custody.kind !== 'available') {
      if (row.custody.holder) yield row.custody.holder;
      if (row.custody.kind === 'missing') yield row.custody.reportedBy;
    }
  }
  for (const reservation of Object.values(state.reservations)) yield reservation.holder;
  for (const code of Object.values(state.itemCodes)) {
    yield code.assignedBy;
    if (code.lifecycle.kind === 'retired') yield code.lifecycle.by;
  }
  for (const version of [
    ...Object.values(state.typeVersions),
    ...Object.values(state.recipeVersions),
  ]) {
    yield version.publishedBy;
    if (version.selection.kind === 'retired') yield version.selection.by;
  }
  for (const evidence of Object.values(state.fitEvidence)) yield evidence.by;
  for (const claim of Object.values(state.temperatureClaims)) {
    yield claim.by;
    if (claim.lifecycle.kind === 'withdrawn') yield claim.lifecycle.by;
  }
  for (const fact of [
    ...Object.values(state.equipmentSetpoints),
    ...Object.values(state.storageRequirements),
    ...Object.values(state.thermalContexts),
  ])
    yield fact.by;
}

export function inventoryHasImportedAttribution(state: InventoryState): boolean {
  for (const principal of recordedPrincipals(state)) if (principal.kind === 'imported') return true;
  return Object.values(state.reservations).some(
    (reservation) =>
      reservation.lifecycle.kind === 'cancelled' &&
      reservation.lifecycle.authority.kind === 'imported'
  );
}
