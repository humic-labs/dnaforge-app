import type { PortableEntitySchemaRevisionSnapshot } from './entity-schema';

export function mapPortableRecordRelationships(
  fields: Record<string, unknown>,
  schema: PortableEntitySchemaRevisionSnapshot | undefined,
  mapIdentity: (id: string) => string
): Record<string, unknown> {
  const mapped = structuredClone(fields);
  for (const field of schema?.fields ?? []) {
    if (field.type !== 'record_relationship') continue;
    const value = mapped[field.key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'object' || Array.isArray(value) || !('destinationEntityId' in value))
      throw new Error(`Record relationship ${field.key} has no destination identity.`);
    if (value.destinationEntityId === null) continue;
    if (typeof value.destinationEntityId !== 'string' || !value.destinationEntityId)
      throw new Error(`Record relationship ${field.key} has an invalid destination identity.`);
    value.destinationEntityId = mapIdentity(value.destinationEntityId);
  }
  return mapped;
}
