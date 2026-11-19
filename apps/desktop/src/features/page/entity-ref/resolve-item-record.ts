import { isSequencePackageFileKind } from '../../../db/sequence-package-contract';
import type { ManagedSequenceDocumentRef } from '../../../shared/managed-sequence-document';
import {
  isSafeWorkspaceRelativePath,
  pathIsAtOrUnder,
  pathRelativeToBoundary,
  stripTrailingSep,
} from '../../../shared/path-boundary';
import { resolveReferenceContentHash, type ContentHashFn } from './resolve-content-hash';
import type { ReferenceContext } from './reference-context';

export interface ChosenItem {
  entityType: string;
  entityId: string | null;
  label: string;
}

export interface ItemRecord {
  path: string | null;
  contentHash: string | null;
}

export interface CatalogFileLookup {
  (
    entityId: string
  ): Promise<{
    path: string;
    relative_path: string | null;
    content_hash: string | null;
    file_kind?: string;
  } | null>;
}

const EMPTY: ItemRecord = { path: null, contentHash: null };

export async function resolveItemRecord(
  item: ChosenItem,
  ctx: ReferenceContext | null,
  deps: { lookupCatalogFile: CatalogFileLookup; contentHash: ContentHashFn }
): Promise<ItemRecord> {
  if (!ctx || !item.entityId) return EMPTY;

  if (item.entityType === 'page') return EMPTY;

  const root = stripTrailingSep(ctx.owningRoot);
  const resolved = await resolvePath(item.entityId, root, deps.lookupCatalogFile);
  if (!resolved) return EMPTY;

  const contentHash = await resolveReferenceContentHash({
    catalogHash: resolved.catalogHash,
    workspaceRoot: root,
    workspaceRelativePath: resolved.path,
    managedDocument: resolved.managedDocument,
    contentHash: deps.contentHash,
  });

  return { path: resolved.path, contentHash };
}

async function resolvePath(
  entityId: string,
  root: string,
  lookupCatalogFile: CatalogFileLookup
): Promise<{
  path: string;
  catalogHash: string | null;
  managedDocument?: ManagedSequenceDocumentRef;
} | null> {
  let file: Awaited<ReturnType<CatalogFileLookup>>;
  try {
    file = await lookupCatalogFile(entityId);
  } catch (error) {
    console.error('[reference] Catalog lookup failed for', entityId, error);
    return null;
  }

  if (!file) {
    return looksLikeWorkspacePath(entityId) ? { path: entityId, catalogHash: null } : null;
  }

  if (!pathIsAtOrUnder(file.path, root)) return null;

  const relative = file.relative_path ?? pathRelativeToBoundary(file.path, root);
  if (!relative || !isSafeWorkspaceRelativePath(relative)) return null;

  return {
    path: relative,
    catalogHash: file.content_hash,
    managedDocument: isSequencePackageFileKind(file.file_kind)
      ? { kind: 'managed-sequence', packageId: entityId, packageRoot: file.path }
      : undefined,
  };
}

export function looksLikeWorkspacePath(candidate: string): boolean {
  if (!isSafeWorkspaceRelativePath(candidate)) return false;
  return candidate.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(candidate);
}
