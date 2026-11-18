import type { InventoryPlatePlanVersion } from './inventory-plate-plan-types';
import type { InventoryState } from './inventory-types';
import {
  inventoryPlatePlanFamilyId,
  inventoryPlatePlanDefinitionSha256,
  inventoryPlatePlanVersionId,
  inventoryPlatePlanVersionSaveIntentSha256,
  inventoryPlatePlanVersionChoices,
} from './inventory-plate-plan-identity';

export function validateInventoryPlatePlanVersion(version: InventoryPlatePlanVersion): void {
  const hash = inventoryPlatePlanDefinitionSha256(version.definition);
  if (
    hash !== version.definitionSha256 ||
    version.id !== inventoryPlatePlanVersionId(version.identity, hash)
  )
    throw new TypeError(
      'A plate plan version must retain its exact family and complete definition hash.'
    );
  inventoryPlatePlanVersionSaveIntentSha256(inventoryPlatePlanVersionChoices(version));
}

export function validateInventoryPlatePlans(state: InventoryState): void {
  const versions = new Set<string>();
  for (const [id, version] of Object.entries(state.platePlanVersions)) {
    validateInventoryPlatePlanVersion(version);
    if (id !== version.id)
      throw new TypeError('A plate plan map key must match the exact version identifier.');
    if (version.at > state.lastRecordedAt)
      throw new TypeError('A plate plan version cannot exceed the recorded inventory clock.');
    const content = `${inventoryPlatePlanFamilyId(version.identity)}:${version.definitionSha256}`;
    if (versions.has(content))
      throw new TypeError('A family can retain only one immutable version of the same definition.');
    versions.add(content);
  }
}
