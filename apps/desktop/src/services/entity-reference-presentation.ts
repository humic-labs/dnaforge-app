import type { DBEntityReference } from '../db/entity-references';
import type { EntityColorContext } from '../shared/entity-color-family';
import { catalogIconContext } from '../shared/catalog-icon-context';
import { referenceJsonObject } from '../shared/entity-reference-ipc';

export async function resolveEntityReferenceIconContext(
  reference: Pick<DBEntityReference, 'entity_type' | 'locator' | 'data'>
): Promise<EntityColorContext | undefined> {
  if (reference.entity_type !== 'primer')
    return catalogIconContext({ kind: reference.entity_type, metadata: reference.data });
  const data = referenceJsonObject(reference.data);
  if (
    typeof data?.registryEntityId !== 'string' ||
    reference.locator !== `entity://primer/${data.registryEntityId}`
  )
    return undefined;
  const { getCanonicalOligoEntity } = await import('../features/primers/primer-references');
  const entity = await getCanonicalOligoEntity(data.registryEntityId);
  return { kind: entity.kind };
}
