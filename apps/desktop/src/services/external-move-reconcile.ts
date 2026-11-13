import { platform } from '../platform';
import { getCatalogFilesUnderPath } from '../db/workspace-catalog';
import {
  relinkByFileContentHash,
  type RelinkMissingEntity,
  type RelinkAppearedFile,
} from '../features/lims/content-relink';

export interface ExternalMoveReconcileResult {
  relinked: number;
  ambiguous: number;
  errors: Array<{ oldPath: string; newPath: string; message: string }>;
}

export interface CurrentRegistryFile {
  path: string;
  contentHash: string | null;
}

function emptyResult(): ExternalMoveReconcileResult {
  return { relinked: 0, ambiguous: 0, errors: [] };
}

export async function applyExternalMovesForRoot(
  rootPath: string,
  currentFiles: readonly CurrentRegistryFile[],
  mutationToken?: string
): Promise<ExternalMoveReconcileResult> {
  const result = emptyResult();

  const catalog = await getCatalogFilesUnderPath(rootPath);
  const currentPaths = new Set(currentFiles.map((f) => f.path));
  const catalogPaths = new Set(catalog.map((r) => r.path));

  const missing: RelinkMissingEntity[] = catalog
    .filter(
      (r) => r.status !== 'historical' && r.file_kind !== 'folder' && !currentPaths.has(r.path)
    )
    .map((r) => ({ id: r.entity_id, oldPath: r.path, fileContentHash: r.content_hash }));

  const appeared: RelinkAppearedFile[] = currentFiles
    .filter((f) => !catalogPaths.has(f.path))
    .map((f) => ({ path: f.path, fileContentHash: f.contentHash }));

  if (missing.length === 0 || appeared.length === 0) return result;

  const { relinks, ambiguous } = relinkByFileContentHash(missing, appeared);
  result.ambiguous = ambiguous.length;

  for (const pair of relinks) {
    try {
      await platform().workspace.relinkMovedEntityFile({
        workspaceRoot: rootPath,
        oldPath: pair.oldPath,
        newPath: pair.newPath,
        ...(mutationToken ? { mutationToken } : {}),
      });
      result.relinked++;
    } catch (err) {
      result.errors.push({
        oldPath: pair.oldPath,
        newPath: pair.newPath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.ambiguous > 0 || result.errors.length > 0) {
    console.warn(
      `[external-move-reconcile] ${rootPath}: ${result.relinked} relinked, ` +
        `${result.ambiguous} ambiguous, ${result.errors.length} error(s)`,
      result.errors
    );
  }

  return result;
}
