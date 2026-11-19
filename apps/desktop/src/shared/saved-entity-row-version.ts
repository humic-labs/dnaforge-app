export const SAVED_ENTITY_ROW_SOURCES = [
  'workspaces',
  'catalog_entities',
  'catalog_entity_files',
  'catalog_entity_links',
  'catalog_entity_events',
  'catalog_workspace_placements',
  'catalog_provider_bindings',
  'lims_schema',
  'lims_schema_revision',
  'lims_entity',
  'lims_link',
  'lims_audit',
  'primers',
  'primer_bindings',
  'primer_pairs',
  'features',
  'graph_nodes',
  'graph_edges',
  'sequences',
  'pages',
  'entity_references',
  'entity_reference_revisions',
  'message_references',
  'compute_jobs',
  'agent_output_artifacts',
  'molecular_catalog_molecules',
  'molecular_catalog_coordinates',
  'molecular_catalog_observations',
  'molecular_catalog_prediction_requests',
  'molecular_catalog_chains',
  'molecular_catalog_mappings',
  'scientific_workspace_identities',
  'scientific_revision_records',
  'scientific_revision_refs',
  'scientific_revision_blobs',
] as const;

export type SavedEntityRowSource = (typeof SAVED_ENTITY_ROW_SOURCES)[number];

export interface SavedEntityRowVersionQuery {
  source: SavedEntityRowSource;
  identity?: string[];
  beforeVersion?: number;
  generation?: string;
  limit?: number;
}

export interface SavedEntityRowVersion {
  version: number;
  revisionId: string;
  source: SavedEntityRowSource;
  identity: string[];
  recordedAt: number;
}

export interface SavedRowRecoveryRequest {
  source: SavedEntityRowSource;
  revisionId: string;
  generation?: string;
}
