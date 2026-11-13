import type { EntityArtifactRelationshipV1 } from './entity-artifact';
import type { EntitySchemaFieldSnapshot } from './entity-schema';

export const SCHEMA_FIELD_LINK_SCHEMA = 'dnaforge.schema-field-link.v1';

export function entityRelationshipKey(
  link: Pick<EntityArtifactRelationshipV1, 'type' | 'fromEntityId' | 'toEntityId'>
): string {
  return JSON.stringify([link.fromEntityId, link.type, link.toEntityId]);
}

export function isSchemaFieldRelationship(
  link: EntityArtifactRelationshipV1,
  entityId: string
): boolean {
  return (
    link.fromEntityId === entityId &&
    link.payload.schema === SCHEMA_FIELD_LINK_SCHEMA &&
    link.payload.sourceEntityId === entityId
  );
}

export function schemaFieldRelationships(
  entityId: string,
  definitions: readonly EntitySchemaFieldSnapshot[],
  fields: Record<string, unknown>
): EntityArtifactRelationshipV1[] {
  const links = new Map<string, EntityArtifactRelationshipV1>();
  for (const field of definitions) {
    if (field.type !== 'record_relationship') continue;
    const value = fields[field.key];
    if (
      !value ||
      typeof value !== 'object' ||
      !('origin' in value) ||
      value.origin !== 'native' ||
      !('resolution' in value) ||
      value.resolution !== 'exact' ||
      !('destinationEntityId' in value) ||
      typeof value.destinationEntityId !== 'string' ||
      !('relationType' in value) ||
      typeof value.relationType !== 'string'
    )
      continue;
    const link: EntityArtifactRelationshipV1 = {
      type: value.relationType,
      fromEntityId: entityId,
      toEntityId: value.destinationEntityId,
      payload: { schema: SCHEMA_FIELD_LINK_SCHEMA, sourceEntityId: entityId, fieldKeys: [] },
    };
    const key = entityRelationshipKey(link);
    const grouped = links.get(key) ?? link;
    (grouped.payload.fieldKeys as string[]).push(field.key);
    links.set(key, grouped);
  }
  return [...links.values()].map((link) => ({
    ...link,
    payload: { ...link.payload, fieldKeys: (link.payload.fieldKeys as string[]).sort() },
  }));
}
