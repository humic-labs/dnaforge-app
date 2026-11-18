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
    if ('contentsKnowledge' in row && row.contentsKnowledge.kind !== 'recorded')
      yield row.contentsKnowledge.by;
    if (row.configuration.geometryOverride) yield row.configuration.geometryOverride.by;
    if ('custody' in row && row.custody.kind !== 'available') {
      if (row.custody.holder) yield row.custody.holder;
      if (row.custody.kind === 'missing') yield row.custody.reportedBy;
    }
  }
  for (const binding of Object.values(state.tableBindings))
    for (const revision of binding.sourceRevisions) yield revision.by;
  for (const observation of Object.values(state.observations)) {
    yield observation.by;
    if (observation.application.kind === 'applied') yield observation.application.by;
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
  for (const row of [
    ...Object.values(state.expectedDeliveries),
    ...Object.values(state.arrivalAllocations),
    ...Object.values(state.reorderRules),
  ]) {
    yield row.by;
    if (row.lifecycle.kind !== 'open' && row.lifecycle.kind !== 'active') yield row.lifecycle.by;
  }
  for (const arrival of Object.values(state.arrivals)) yield arrival.by;
  for (const attribution of Object.values(state.runValueAttributions)) yield attribution.by;
  for (const withdrawal of Object.values(state.runValueAttributionWithdrawals)) yield withdrawal.by;
  for (const work of Object.values(state.scientificWorks)) yield work.by;
  for (const observation of Object.values(state.platePlanObservations)) yield observation.by;
  for (const version of Object.values(state.platePlanVersions)) yield version.by;
  for (const citation of Object.values(state.scientificCitations)) yield citation.by;
  for (const withdrawal of Object.values(state.scientificCitationWithdrawals)) yield withdrawal.by;
  for (const fact of [
    ...Object.values(state.openingObservations),
    ...Object.values(state.validityFacts),
  ])
    yield fact.by;
  for (const lot of Object.values(state.lots))
    if (lot.controls.kind === 'managed') yield lot.controls.assessment.by;
  for (const recall of Object.values(state.lotRecalls)) {
    yield recall.by;
    if (recall.lifecycle.kind === 'withdrawn') yield recall.lifecycle.by;
  }
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
