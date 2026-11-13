export const PAGE_LOCATOR_PREFIX = 'entity://page/';

export interface ProjectionIdColumn {
  table: string;
  column: string;
  hardRef: boolean;
}

export interface ProjectionLocatorColumn {
  table: string;
  column: string;
  prefix: string;
}

export const NOTEBOOK_PROJECTION_ID_COLUMNS: readonly ProjectionIdColumn[] = [
  { table: 'catalog_entity_files', column: 'entity_id', hardRef: true },
  { table: 'catalog_entity_events', column: 'entity_id', hardRef: true },
  { table: 'catalog_entity_links', column: 'source_entity_id', hardRef: true },
  { table: 'catalog_entity_links', column: 'target_entity_id', hardRef: true },
  { table: 'catalog_provider_bindings', column: 'entity_id', hardRef: true },
  { table: 'catalog_workspace_placements', column: 'entity_id', hardRef: true },
  { table: 'pages', column: 'id', hardRef: false },
];

export const NOTEBOOK_PROJECTION_LOCATOR_COLUMNS: readonly ProjectionLocatorColumn[] = [
  { table: 'entity_references', column: 'locator', prefix: PAGE_LOCATOR_PREFIX },
];
