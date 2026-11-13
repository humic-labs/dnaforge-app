import { createHash } from 'node:crypto';
import type { SourceObject } from '../../shared/benchling-migration';
import type { ProjectableEntitySchemaRevisionSnapshot } from '../../shared/entity-schema';
import { classifyLimsEntityFieldIssues, type LimsRegisterEntityInput } from '../../shared/lims';
import { parseRegistrySchemaDefinition } from './registry-table-input';

export function nativeRegistrySourceRevisionKey(metadata: Record<string, unknown>): string {
  const registry = requireRecord(metadata.benchlingRegistry, 'metadata');
  const schema = requireRecord(registry.schemaRevision, 'schema revision');
  if (typeof schema.sourceSchemaId !== 'string' || typeof schema.sourceRevisionId !== 'string')
    throw new Error('Registry source schema identity is missing.');
  return JSON.stringify([schema.sourceSchemaId, schema.sourceRevisionId]);
}

export function nativeRegistryRecordInput(input: {
  source: SourceObject;
  scopeId: string;
  createdAt: number;
  resolveTarget: (relationshipId: string, sourceTargetId: string) => string | null;
}): LimsRegisterEntityInput {
  const registry = requireRecord(input.source.metadata.benchlingRegistry, 'metadata');
  const sourceSchema = parseRegistrySchemaDefinition(
    requireRecord(registry.schemaRevision, 'schema revision')
  );
  const fields = structuredClone(requireRecord(registry.fieldValues, 'fields'));
  if (!Array.isArray(registry.relationshipFields))
    throw new Error('Registry relationship fields are missing.');
  const declaredFields = new Map(
    sourceSchema.fields.map(({ definition }) => [definition.key, definition])
  );
  for (const raw of registry.relationshipFields) {
    const relationship = requireRecord(raw, 'relationship');
    const { fieldKey, sourceRelationshipId, sourceTargetId } = relationship;
    if (
      typeof fieldKey !== 'string' ||
      typeof sourceRelationshipId !== 'string' ||
      typeof sourceTargetId !== 'string' ||
      declaredFields.get(fieldKey)?.type !== 'record_relationship'
    )
      throw new Error('Registry relationship mapping is invalid.');
    const destinationEntityId = input.resolveTarget(sourceRelationshipId, sourceTargetId);
    if (destinationEntityId) {
      fields[fieldKey] = {
        sourceTargetId,
        destinationEntityId,
        relationType: fieldKey,
        label: sourceTargetId,
        resolution: 'exact',
      };
    }
  }
  const identity = createHash('sha256')
    .update(
      JSON.stringify([input.scopeId, sourceSchema.sourceSchemaId, sourceSchema.sourceRevisionId])
    )
    .digest('hex')
    .slice(0, 24);
  const kind = `imported_record_${identity}`;
  const schemaSnapshot: ProjectableEntitySchemaRevisionSnapshot = {
    schemaId: `schema-${identity}`,
    schemaRevisionId: `schema-${identity}-v1`,
    version: 1,
    name: kind,
    displayName: sourceSchema.displayName,
    baseKind: 'record',
    fields: sourceSchema.fields.map(({ definition }) => ({ ...definition })),
  };
  const issues = classifyLimsEntityFieldIssues(
    kind,
    fields,
    sourceSchema.fields.map(({ definition }) => definition)
  );
  if (issues.malformed.length)
    throw new Error(`Registry record ${input.source.stableId}: ${issues.malformed.join('; ')}`);
  return {
    kind,
    name: input.source.name,
    fields,
    schemaRevisionId: schemaSnapshot.schemaRevisionId,
    schemaSnapshot,
    registrationStatus: issues.incomplete.length ? 'unresolved' : 'registered',
    actor: 'migration',
    createdAt: input.createdAt,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Registry ${label} must be an object.`);
  return Object.fromEntries(Object.entries(value));
}
