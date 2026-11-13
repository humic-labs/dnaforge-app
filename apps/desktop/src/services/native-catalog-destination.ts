import {
  getCatalogEntityForWorkspaceRoot,
  getCatalogFileForPath,
  getCatalogEntity,
  getWorkspaceRootById,
  getCurrentCatalogFileForEntity,
  resolveCatalogEntityIdForWorkspace,
  type CatalogEntityType,
  type DBCatalogEntity,
} from '../db/workspace-catalog';
import { isSequencePackageFileKind } from '../db/sequence-package';
import { resolveSequencePackageProductPath } from '../features/sequence/sequence-package-product';
import { pathIsAtOrUnder, pathRelativeToBoundary } from '../shared/path-boundary';
import { stripWorkspaceScope } from '../shared/workspace-scoped-identity';
import type { TabType } from '../features/canvas/types';
import {
  createMigrationDestinationResolver,
  readMigrationDestinationLinkIndex,
  type MigrationDestinationTabType,
} from '../shared/benchling-migration-destination-index';
import { platform } from '../platform';
import { getTabTypeForFile } from '../utils/fileTypes';
import { inferCatalogFileKind } from '../shared/catalog-file-kind';
import { isEntityRecordArtifactProjection } from '../shared/registry-file-types';
import type { FastaKindReadAuthority } from '../shared/fasta-kind';

export type NativeCatalogDestination = {
  source: 'native_catalog' | 'legacy_index';
  rawId: string;
  entityId: string;
  title: string;
  entityType: CatalogEntityType;
  locator:
    | {
        kind: 'workspace_path';
        absolutePath: string;
        relativePath: string | null;
        tabType: TabType;
      }
    | {
        kind: 'legacy_fasta';
        absolutePath: string;
        relativePath: string | null;
        authority: Exclude<FastaKindReadAuthority, { status: 'declared' }>;
      }
    | {
        kind: 'lims_entity';
        entityId: string;
      }
    | {
        kind: 'workspace_page';
        pageId: string;
      };
};

type ReadTextFileSlice = (
  path: string,
  maxBytes: number
) => Promise<{ text: string; bytesRead: number }>;

export async function resolveNativeCatalogDestination(input: {
  workspaceRoot: string;
  rawId: string;
  readTextFileSlice?: ReadTextFileSlice;
}): Promise<NativeCatalogDestination | null> {
  const entityId = await resolveCatalogEntityIdForWorkspace(input.workspaceRoot, input.rawId);
  const entity = await getCatalogEntityForWorkspaceRoot(entityId, input.workspaceRoot);
  const native = entity
    ? await nativeCatalogDestinationFromEntity({
        entity,
        entityId,
        rawId: input.rawId,
        workspaceRoot: input.workspaceRoot,
      })
    : null;
  if (native) return native;
  const exact = await resolveExactNativeCatalogDestination({
    workspaceRoot: input.workspaceRoot,
    entityId: input.rawId,
  });
  if (exact) return exact;
  if (!input.readTextFileSlice) return null;
  try {
    const legacyIndex = await readMigrationDestinationLinkIndex(
      input.workspaceRoot,
      input.readTextFileSlice
    );
    const legacy = createMigrationDestinationResolver(
      legacyIndex,
      input.workspaceRoot
    )(input.rawId);
    if (!legacy) return null;
    if (legacy.locator.kind === 'lims_entity') {
      return {
        source: 'legacy_index',
        rawId: input.rawId,
        entityId: legacy.destinationObjectId,
        title: legacy.title,
        entityType: 'file',
        locator: legacy.locator,
      };
    }
    return {
      source: 'legacy_index',
      rawId: input.rawId,
      entityId: legacy.destinationObjectId,
      title: legacy.title,
      entityType:
        inferCatalogFileKind(legacy.locator.absolutePath) === 'fasta' &&
        (legacy.locator.tabType === 'protein' || legacy.locator.tabType === 'sequence')
          ? 'file'
          : legacyEntityType(legacy.locator.tabType),
      locator: {
        kind: 'workspace_path',
        absolutePath: legacy.locator.absolutePath,
        relativePath: legacy.locator.relativePath,
        tabType: legacy.locator.tabType,
      },
    };
  } catch {
    return null;
  }
}

export async function resolveExactNativeCatalogDestination(input: {
  workspaceRoot: string;
  entityId: string;
}): Promise<NativeCatalogDestination | null> {
  const entity = await getCatalogEntityForWorkspaceRoot(input.entityId, input.workspaceRoot);
  if (!entity) return null;
  return nativeCatalogDestinationFromEntity({
    entity,
    entityId: input.entityId,
    rawId: stripWorkspaceScope(input.entityId),
    workspaceRoot: input.workspaceRoot,
  });
}

async function nativeCatalogDestinationFromEntity(input: {
  entity: DBCatalogEntity;
  entityId: string;
  rawId: string;
  workspaceRoot: string;
}): Promise<NativeCatalogDestination | null> {
  if (input.entity.status !== 'active') return null;
  const file = await getCurrentCatalogFileForEntity(input.entityId);
  if (file) {
    if (file.workspace_id !== input.entity.workspace_id) return null;
    if (!pathIsAtOrUnder(file.path, input.workspaceRoot)) return null;
    let absolutePath = file.path;
    let relativePath = file.relative_path;
    if (file.file_kind === 'waypoint-entity') {
      const [record] = await platform().lims.queryEntities({
        id: input.entityId,
        includeArchived: true,
        limit: 1,
      });
      const artifact = record?.fields.artifact;
      if (
        !record ||
        record.workspaceId !== file.workspace_id ||
        record.tombstone ||
        record.archivedAt !== null ||
        !isEntityRecordArtifactProjection(record.fields) ||
        !artifact ||
        typeof artifact !== 'object' ||
        !('relativePath' in artifact) ||
        artifact.relativePath !== relativePath
      )
        return null;
      return {
        source: 'native_catalog',
        rawId: input.rawId,
        entityId: input.entityId,
        title: input.entity.name,
        entityType: input.entity.type,
        locator: { kind: 'lims_entity', entityId: input.entityId },
      };
    }
    if (isSequencePackageFileKind(file.file_kind)) {
      try {
        absolutePath = await resolveSequencePackageProductPath(file.path);
      } catch {
        return null;
      }
      relativePath = pathRelativeToBoundary(absolutePath, input.workspaceRoot);
      if (relativePath === null) return null;
    }
    if (
      file.file_kind === 'fasta' &&
      (input.entity.type === 'sequence' || input.entity.type === 'protein')
    ) {
      const authority = await resolveNativeFastaSourceAuthority(absolutePath);
      if (!authority || authority.entityId !== input.entityId || authority.bindingId !== file.id)
        return null;
      if (authority.status !== 'declared')
        return {
          source: 'native_catalog',
          rawId: input.rawId,
          entityId: input.entityId,
          title: input.entity.name,
          entityType: 'file',
          locator: { kind: 'legacy_fasta', absolutePath, relativePath, authority },
        };
      if (authority.kind !== input.entity.type)
        throw new Error('The FASTA kind declaration contradicts its current catalog identity.');
    }
    return {
      source: 'native_catalog',
      rawId: input.rawId,
      entityId: input.entityId,
      title: input.entity.name,
      entityType: input.entity.type,
      locator: {
        kind: 'workspace_path',
        absolutePath,
        relativePath,
        tabType: nativeTabType(input.entity.type, absolutePath),
      },
    };
  }
  if (
    input.entity.type === 'notebook' &&
    input.entity.locator === `entity://page/${input.entityId}` &&
    input.entity.storage_type === 'database'
  ) {
    const pageRows = await platform().db.select<{ id: string }[]>(
      'SELECT id FROM pages WHERE id = ? LIMIT 1',
      [input.entityId]
    );
    if (pageRows.length === 0) return null;
    return {
      source: 'native_catalog',
      rawId: input.rawId,
      entityId: input.entityId,
      title: input.entity.name,
      entityType: input.entity.type,
      locator: { kind: 'workspace_page', pageId: input.entityId },
    };
  }
  if (
    input.entity.locator === `entity://lims/${input.entityId}` &&
    input.entity.storage_type === 'database'
  ) {
    return {
      source: 'native_catalog',
      rawId: input.rawId,
      entityId: input.entityId,
      title: input.entity.name,
      entityType: input.entity.type,
      locator: { kind: 'lims_entity', entityId: input.entityId },
    };
  }
  return null;
}

export async function resolveNativeFastaSourceAuthority(
  path: string,
  expectedWorkspaceRoot?: string
): Promise<FastaKindReadAuthority | null> {
  const binding = await getCatalogFileForPath(path);
  if (!binding) return null;
  const entity = await getCatalogEntity(binding.entity_id);
  if (entity && binding.workspace_id === null && entity.workspace_id === null) return null;
  const workspaceRoot = await getWorkspaceRootById(binding.workspace_id);
  if (
    !entity ||
    !workspaceRoot ||
    entity.status !== 'active' ||
    (entity.type !== 'sequence' && entity.type !== 'protein') ||
    entity.workspace_id !== binding.workspace_id ||
    binding.file_kind !== 'fasta' ||
    binding.status !== 'current'
  )
    throw new Error('The FASTA source does not match its exact current project binding.');
  const authority = await platform().db.getFastaKindReadAuthority({
    path,
    workspaceRoot: expectedWorkspaceRoot ?? workspaceRoot,
  });
  if (
    authority.entityId !== entity.id ||
    authority.bindingId !== binding.id ||
    authority.objectUuid !== binding.object_uuid ||
    (authority.status === 'declared' ? authority.kind : authority.storedKind) !== entity.type
  )
    throw new Error('The FASTA source does not match its exact current project binding.');
  return authority;
}

export function nativeTabType(type: CatalogEntityType, path: string): TabType {
  if (type === 'sequence') return 'sequence';
  if (type === 'notebook') return 'page';
  if (type === 'protein') return 'protein';
  if (type === 'protocol' || type === 'protocol_run') return 'scientific-document';
  if (type === 'design') return 'design';
  if (type === 'structure') return 'structure';
  return getTabTypeForFile(path);
}

function legacyEntityType(tabType: MigrationDestinationTabType): CatalogEntityType {
  if (tabType === 'sequence') return 'sequence';
  if (tabType === 'protein') return 'protein';
  if (tabType === 'page') return 'notebook';
  if (tabType === 'design') return 'design';
  return 'file';
}
