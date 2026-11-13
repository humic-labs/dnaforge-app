import {
  catalogJsonObject,
  requireCatalogText,
  type CatalogEntityPresentationInput,
} from './catalog-associations';
import { canonicalJson } from './canonical-json';
import type { CatalogEntityRow } from './catalog-registration';

const IDENTITY_METADATA_FIELDS = new Set([
  'id',
  'type',
  'locator',
  'storageType',
  'storage_type',
  'workspaceId',
  'workspace_id',
  'workspaceRoot',
  'portableId',
  'documentId',
  'packageId',
  'packageRoot',
  'path',
  'relativePath',
  'fileKind',
  'placement',
  'migrationSource',
  'sourceIdentities',
  'provider',
  'stableObjectId',
  'objectClass',
  '_managedSequenceDocument',
  'constructId',
]);

function sameJson(left: unknown, right: unknown): boolean {
  return (
    left === right ||
    (left !== undefined && right !== undefined && canonicalJson(left) === canonicalJson(right))
  );
}

export function parseCatalogEntityPresentation(
  input: CatalogEntityPresentationInput
): CatalogEntityPresentationInput {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !['entityId', 'name', 'metadataPatch'].includes(key))
  )
    throw new Error('Catalog presentation request is invalid.');
  return {
    entityId: requireCatalogText(input.entityId, 'entity identity'),
    ...(input.name !== undefined ? { name: requireCatalogText(input.name, 'name') } : {}),
    ...(input.metadataPatch !== undefined
      ? { metadataPatch: catalogJsonObject(input.metadataPatch, 'metadata patch') }
      : {}),
  };
}

export function planCatalogEntityPresentation(
  entity: CatalogEntityRow,
  input: CatalogEntityPresentationInput,
  authority: {
    sourceName?: string;
    sourceMetadata?: Record<string, unknown> | null;
    readSourceNames: () => ReadonlySet<string> | null;
    assertMutable: () => void;
    now: number;
  }
): CatalogEntityRow {
  const request = parseCatalogEntityPresentation(input);
  if (request.entityId !== entity.id) throw new Error('Catalog presentation identity differs.');
  const existing =
    entity.metadata === null
      ? {}
      : catalogJsonObject(JSON.parse(entity.metadata), 'stored metadata');
  const patch = request.metadataPatch;
  const source = authority.sourceMetadata;
  if (patch)
    for (const [key, value] of Object.entries(patch)) {
      if (!IDENTITY_METADATA_FIELDS.has(key) || sameJson(existing[key], value)) continue;
      if (key === 'constructId' && value === entity.id) continue;
      if (!source || !Object.hasOwn(source, key) || !sameJson(source[key], value)) {
        throw new Error('Catalog identity-bearing metadata requires its authoritative source.');
      }
    }
  const exactSourcePatch =
    patch &&
    source &&
    Object.entries(patch).every(
      ([key, value]) => Object.hasOwn(source, key) && sameJson(source[key], value)
    );
  const exactSourceName = request.name !== undefined && request.name === authority.sourceName;
  if ((patch && !exactSourcePatch) || (request.name !== undefined && !exactSourceName)) {
    authority.assertMutable();
  }
  if (request.name !== undefined && request.name !== entity.name) {
    const names = authority.readSourceNames();
    if (names && !names.has(request.name) && !exactSourceName) {
      throw new Error('Catalog projection name must match its authoritative source.');
    }
  }
  return {
    ...entity,
    name: request.name ?? entity.name,
    metadata: patch ? JSON.stringify({ ...existing, ...patch }) : entity.metadata,
    updated_at: authority.now,
  };
}
