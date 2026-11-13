export const CATALOG_ENTITY_TYPES = [
  'track-view',
  'molecular-document',
  'sequence',
  'primer',
  'notebook',
  'design',
  'alignment',
  'trace',
  'report',
  'construct',
  'sample',
  'record',
  'selection',
  'structure',
  'protein',
  'protocol',
  'protocol_run',
  'file',
  'folder',
] as const;
export type CatalogEntityType = (typeof CATALOG_ENTITY_TYPES)[number];

export const CATALOG_RECORD_PRESENTATION_KINDS = ['strain', 'sequence', 'record'] as const;
export type CatalogRecordPresentationKind = (typeof CATALOG_RECORD_PRESENTATION_KINDS)[number];

export function isCatalogRecordPresentationKind(
  value: unknown
): value is CatalogRecordPresentationKind {
  return CATALOG_RECORD_PRESENTATION_KINDS.some((kind) => kind === value);
}

export function isActiveWorkspaceDnaCatalogEntity(
  entity: { type: CatalogEntityType; status: string; workspace_id: number | null },
  workspaceId: number
): boolean {
  return (
    entity.type === 'sequence' && entity.status === 'active' && entity.workspace_id === workspaceId
  );
}
