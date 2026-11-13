import { notebookPackagePaths } from '../../db/notebook-package';
import {
  nativeWorkspaceEntityPhysicalRoot,
  parseNativeWorkspaceManifest,
  type NativeWorkspaceManifestAnyEntity,
} from '../../shared/native-workspace-manifest';

const NATIVE_CATALOG_PATH = '.forge/catalog.json';

export type BenchlingMigrationLandingAsset =
  | {
      kind: 'notebook';
      openRelativePath: string;
      revealRelativePath: string;
      label: string;
    }
  | {
      kind: 'sequence';
      openRelativePath: string;
      revealRelativePath: string;
      label: string;
    };

export function parseBenchlingMigrationLandingAsset(
  manifestText: string,
  sourceIds?: readonly string[]
): BenchlingMigrationLandingAsset | null {
  let manifest: ReturnType<typeof parseNativeWorkspaceManifest>;
  try {
    manifest = parseNativeWorkspaceManifest(manifestText);
  } catch {
    return null;
  }

  const entityById = new Map(manifest.entities.map((entity) => [entity.id, entity]));
  const childrenByFolderId = new Map<string, string[]>();
  for (const link of manifest.links) {
    if (link.relation !== 'contains') continue;
    const children = childrenByFolderId.get(link.sourceId) ?? [];
    children.push(link.targetId);
    childrenByFolderId.set(link.sourceId, children);
  }
  for (const children of childrenByFolderId.values()) children.sort();

  const selectedRootIds = manifest.entities
    .filter((entity) => entity.type === 'folder' && entity.metadata?.selectedRoot === true)
    .map((entity) => entity.id)
    .sort();
  const visited = new Set<string>();
  const reachableNotebooks: NativeWorkspaceManifestAnyEntity[] = [];
  const reachableSequences: NativeWorkspaceManifestAnyEntity[] = [];
  const queue = [...selectedRootIds];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const entity = entityById.get(id);
    if (entity?.type === 'notebook') reachableNotebooks.push(entity);
    if (entity?.type === 'sequence') reachableSequences.push(entity);
    queue.push(...(childrenByFolderId.get(id) ?? []));
  }

  const latestImportByEntityId = new Map<string, { createdAt: number; order: number }>();
  for (const [order, event] of (manifest.events ?? []).entries()) {
    if (event.eventType !== 'imported') continue;
    const previous = latestImportByEntityId.get(event.entityId);
    if (!previous || event.createdAt >= previous.createdAt) {
      latestImportByEntityId.set(event.entityId, { createdAt: event.createdAt, order });
    }
  }
  const sourceSet = sourceIds?.length ? new Set(sourceIds) : null;
  const belongsToAction = (entity: NativeWorkspaceManifestAnyEntity) =>
    !sourceSet ||
    ('migrationSource' in entity &&
      entity.migrationSource !== undefined &&
      sourceSet.has(entity.migrationSource.sourceId));
  const actionNotebooks = reachableNotebooks.filter(belongsToAction);
  const actionSequences = reachableSequences.filter(belongsToAction);
  const manifestNotebooks = manifest.entities.filter(
    (entity) => entity.type === 'notebook' && belongsToAction(entity)
  );
  const manifestSequences = manifest.entities.filter(
    (entity) => entity.type === 'sequence' && belongsToAction(entity)
  );
  const candidates = actionNotebooks.length
    ? actionNotebooks
    : actionSequences.length
      ? actionSequences
      : manifestNotebooks.length
        ? manifestNotebooks
        : manifestSequences;
  const landingAsset = candidates.sort((left, right) => {
    const leftImport = latestImportByEntityId.get(left.id);
    const rightImport = latestImportByEntityId.get(right.id);
    const byImportTime = (rightImport?.createdAt ?? 0) - (leftImport?.createdAt ?? 0);
    const byManifestOrder = (rightImport?.order ?? -1) - (leftImport?.order ?? -1);
    return (
      byImportTime ||
      byManifestOrder ||
      (nativeWorkspaceEntityPhysicalRoot(left) ?? '').localeCompare(
        nativeWorkspaceEntityPhysicalRoot(right) ?? ''
      )
    );
  })[0];
  if (!landingAsset) return null;
  if (landingAsset.type !== 'notebook' && landingAsset.type !== 'sequence') return null;
  const physicalRoot = nativeWorkspaceEntityPhysicalRoot(landingAsset);
  if (!physicalRoot) return null;

  return {
    kind: landingAsset.type,
    openRelativePath:
      landingAsset.type === 'notebook' ? notebookPackagePaths(physicalRoot).metaPath : physicalRoot,
    revealRelativePath: physicalRoot,
    label: landingAsset.name,
  };
}

export async function resolveBenchlingMigrationLandingAsset(
  workspacePath: string,
  readTextFile: (path: string) => Promise<string>,
  sourceIds?: readonly string[]
): Promise<BenchlingMigrationLandingAsset | null> {
  const root = workspacePath.replace(/[\\/]+$/u, '');
  try {
    return parseBenchlingMigrationLandingAsset(
      await readTextFile(`${root}/${NATIVE_CATALOG_PATH}`),
      sourceIds
    );
  } catch {
    return null;
  }
}
