import { platform } from '../platform';
import { entityArtifactSchemaSnapshot } from '../shared/entity-artifact';
import type { LimsFieldDefinition } from '../shared/lims';

export async function resolveEntityArtifactSchemaFields(
  kind: string
): Promise<readonly LimsFieldDefinition[]> {
  return (await resolveEntityArtifactSchemaSnapshot(kind)).fields as LimsFieldDefinition[];
}

export async function resolveEntityArtifactSchemaSnapshot(
  kind: string,
  selection?: { schemaId: string; expectedRevisionId: string }
) {
  if (selection && (!selection.schemaId || !selection.expectedRevisionId)) {
    throw new Error('Select a schema and its current version before creating the record.');
  }
  const schemas = await platform().lims.listSchemas();
  const matches = schemas.filter(
    (schema) => schema.entityKind === kind && (!selection || schema.schemaId === selection.schemaId)
  );
  if (matches.length !== 1)
    throw new Error(`No unique Registry schema is provisioned for ${kind}.`);
  if (selection && matches[0].currentRevisionId !== selection.expectedRevisionId) {
    throw new Error('This schema changed. Reopen the creation form before saving.');
  }
  return entityArtifactSchemaSnapshot(matches[0]);
}
