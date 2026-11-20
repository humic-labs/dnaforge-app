import type { WorkspaceSyncBundle, WorkspaceSyncFile } from '@waypoint/share-bundle';
import { REGISTRY_FILE_TYPES } from '../shared/registry-file-types';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  nativeWorkspaceEntityPrimaryFile,
  parseNativeWorkspaceManifest,
} from '../shared/native-workspace-manifest';
import { scientificPackageKindForMetaPath } from '../shared/scientific-package';
import { readVerifiedWorkspaceSyncFile } from './workspace-sync-blob-cache';

function documentFormat(path: string): { kind: string; packageRoot: string | null } | null {
  const normalized = path.toLowerCase();
  const format = REGISTRY_FILE_TYPES.find((type) =>
    normalized.endsWith(type.storage === 'dir-package' ? `/${type.suffix}` : type.suffix)
  );
  if (format?.storage === 'flat-file') return { kind: format.id, packageRoot: null };
  const kind = format?.id ?? scientificPackageKindForMetaPath(path);
  return kind ? { kind, packageRoot: path.slice(0, normalized.lastIndexOf('/.forge/')) } : null;
}

function documents(files: readonly WorkspaceSyncFile[]): Map<string, WorkspaceSyncFile[]> {
  const candidates = files.flatMap((file) => {
    const format = documentFormat(file.relativePath);
    return format ? [{ ...format, file }] : [];
  });
  const roots = new Set(
    candidates.flatMap(({ packageRoot }) => (packageRoot ? [packageRoot] : []))
  );
  const result = new Map<string, WorkspaceSyncFile[]>();
  for (const { file, kind, packageRoot } of candidates) {
    let directory = packageRoot ?? file.relativePath;
    let contained = false;
    while (directory.includes('/')) {
      directory = directory.slice(0, directory.lastIndexOf('/'));
      if (roots.has(directory)) {
        contained = true;
        break;
      }
    }
    if (contained) continue;
    const list = result.get(kind) ?? [];
    list.push(file);
    result.set(kind, list);
  }
  return result;
}

function missing(id: string): never {
  throw new Error(
    `Sync stopped because the merge would remove saved entity "${id}". Restore its document or reconcile the project that last saved it.`
  );
}

async function content(file: WorkspaceSyncFile): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true }).decode(
    await readVerifiedWorkspaceSyncFile(file)
  );
}

export async function assertReconciledEntitiesRetained(
  inputs: readonly (WorkspaceSyncBundle | null)[],
  output: readonly WorkspaceSyncFile[]
): Promise<void> {
  const outputByPath = new Map(output.map((file) => [file.relativePath, file]));
  const retained = documents(output);
  const outputCatalog = output.find((file) => file.relativePath === NATIVE_WORKSPACE_MANIFEST_PATH);
  const catalogs = new Map<string, ReturnType<typeof parseNativeWorkspaceManifest>>();
  const readCatalog = async (file: WorkspaceSyncFile) => {
    let catalog = catalogs.get(file.sha256);
    if (!catalog) {
      catalog = parseNativeWorkspaceManifest(await content(file));
      catalogs.set(file.sha256, catalog);
    }
    return catalog;
  };
  const outputEntities = new Map(
    (outputCatalog ? (await readCatalog(outputCatalog)).entities : []).map((entity) => [
      entity.id,
      entity,
    ])
  );
  const ids = new Map<string, string>();
  const documentId = async (file: WorkspaceSyncFile) => {
    let id = ids.get(file.sha256);
    if (id !== undefined) return id;
    const document: unknown = JSON.parse(await content(file));
    if (
      !document ||
      typeof document !== 'object' ||
      !('id' in document) ||
      typeof document.id !== 'string' ||
      !document.id.trim()
    ) {
      throw new Error(`Sync could not verify the saved entity identity in "${file.relativePath}".`);
    }
    id = document.id;
    ids.set(file.sha256, id);
    return id;
  };
  for (const input of inputs) {
    if (!input) continue;
    const catalogFile = input.files.find(
      (file) => file.relativePath === NATIVE_WORKSPACE_MANIFEST_PATH
    );
    if (catalogFile) {
      const inputPaths = new Set(input.files.map((file) => file.relativePath));
      for (const entity of (await readCatalog(catalogFile)).entities) {
        const after = outputEntities.get(entity.id);
        if (!after) missing(entity.id);
        const oldPath = nativeWorkspaceEntityPrimaryFile(entity);
        if (oldPath && inputPaths.has(oldPath)) {
          const path = nativeWorkspaceEntityPrimaryFile(after);
          if (!path || !outputByPath.has(path)) missing(entity.id);
        }
      }
    }
    for (const [kind, files] of documents(input.files)) {
      const candidates = retained.get(kind) ?? [];
      const hashes = new Set(candidates.map((file) => file.sha256));
      let remainingIds: Set<string> | undefined;
      for (const file of files) {
        if (hashes.has(file.sha256)) continue;
        const id = await documentId(file);
        const atSamePath = outputByPath.get(file.relativePath);
        if (atSamePath && candidates.includes(atSamePath) && (await documentId(atSamePath)) === id)
          continue;
        if (!remainingIds) {
          remainingIds = new Set();
          for (const candidate of candidates) remainingIds.add(await documentId(candidate));
        }
        if (!remainingIds.has(id)) missing(id);
      }
    }
  }
}
