import type { CatalogEntityType } from '@waypoint/scientific-artifacts/shared/entity-types';

export {
  CATALOG_ENTITY_TYPES,
  type CatalogEntityType,
} from '@waypoint/scientific-artifacts/shared/entity-types';

export const SEQUENCE_DOCUMENT_ENTITY_TYPES = [
  'sequence',
  'construct',
  'trace',
] as const satisfies readonly CatalogEntityType[];
export type SequenceDocumentEntityType = (typeof SEQUENCE_DOCUMENT_ENTITY_TYPES)[number];

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
