import type { LimsEntityKind } from './entity-types';
export { LIMS_ENTITY_KINDS, type LimsEntityKind } from './entity-types';

export interface LimsRelationshipTypeDefinition {
  name: string;
  displayName: string;
  inverseName?: string;
  fromKindHint?: LimsEntityKind | 'any';
  toKindHint?: LimsEntityKind | 'any';
  cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  directional: boolean;
  description: string;
  ontologyMapping?: string;
  builtin: boolean;
}
