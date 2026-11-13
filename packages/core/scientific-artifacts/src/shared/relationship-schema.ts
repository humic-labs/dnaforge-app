import {
  isProjectableEntitySchemaRevisionSnapshot,
  type ProjectableEntitySchemaRevisionSnapshot,
} from './entity-schema';
import type { LimsRelationshipTypeDefinition } from './lims-kinds';

export interface ProjectableRelationshipSchemaRevisionSnapshot extends ProjectableEntitySchemaRevisionSnapshot {
  schemaKind: 'relationship_type';
  relationship?: LimsRelationshipTypeDefinition;
}

export function isProjectableRelationshipSchemaRevisionSnapshot(
  value: unknown
): value is ProjectableRelationshipSchemaRevisionSnapshot {
  if (!isProjectableEntitySchemaRevisionSnapshot(value) || value.schemaKind !== 'relationship_type')
    return false;
  const definition = value.relationship;
  if (definition === undefined) return true;
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition))
    return false;
  const r = definition as Record<string, unknown>;
  return (
    r.name === value.name &&
    typeof r.displayName === 'string' &&
    r.displayName.length > 0 &&
    typeof r.description === 'string' &&
    typeof r.directional === 'boolean' &&
    typeof r.builtin === 'boolean' &&
    ['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many'].includes(String(r.cardinality)) &&
    ['inverseName', 'fromKindHint', 'toKindHint', 'ontologyMapping'].every(
      (key) => r[key] === undefined || (typeof r[key] === 'string' && r[key].length > 0)
    )
  );
}
