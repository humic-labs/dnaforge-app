export const LIMS_ENTITY_KINDS = [
  'sequence',
  'oligo',
  'rna_oligo',
  'plasmid',
  'genome',
  'chromosome',
  'strain',
  'organism',
  'protein',
  'dna_sequence',
  'rna_sequence',

  'guide_rna',
  'allele',
  'locus',
  'part',
  'fragment',
  'marker',
  'external_ref',
  'notebook',
  'track-view',
  'molecular-document',
] as const;
export type LimsEntityKind = (typeof LIMS_ENTITY_KINDS)[number];

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
