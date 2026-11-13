import { platform } from '../../platform';
import { isDeveloperImportSourcePath } from '../../shared/developer-import-sources';
import { cooperateWithRendererInteraction } from '../../lib/renderer-interaction-activity';
import { resolveArtifactFile } from '../workspace-artifacts';
import { getCatalogEntity, resolveWorkspaceId, resolveWorkspaceScope } from '../workspace-catalog';
import {
  ensureNotebookRegisteredInLims,
  notebookPackageRootFromAdapterPath,
} from '../../features/lims/register-notebook-entity';
import { sequencePackageMetaPaths } from '../sequence-package';
import {
  getEntityAdapterForPath,
  reconcileEntityFile,
  type EntityReconcileContext,
  type EntityReconcileConflictReason,
} from './adapter';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules']);
const MAX_DEPTH = 40;

const MAX_DIRS = 5000;
const NOTEBOOK_META_REL = '.forge/notebook.json';

export interface EntityReconcileResult {
  scanned: number;
  reconciled: number;
  conflicts: number;
  conflictDetails?: Array<{ id: string; path: string; reason: EntityReconcileConflictReason }>;
  errors: Array<{ path: string; message: string }>;
}

function mtimeMs(stat: { mtime?: number | Date | null }): number {
  const m = stat.mtime;
  if (m instanceof Date) return m.getTime();
  if (typeof m === 'number') return m;
  return 0;
}

export async function reconcileWorkspaceEntities(
  rootPath: string,
  options: {
    signal?: AbortSignal;
    candidatePaths?: readonly string[];
    mutationToken?: string;

    acceptedPaths?: readonly string[];
  } = {}
): Promise<EntityReconcileResult> {
  const { signal, candidatePaths, mutationToken } = options;
  const acceptedPaths = new Set(options.acceptedPaths ?? []);
  signal?.throwIfAborted();
  if (isDeveloperImportSourcePath(rootPath)) {
    return { scanned: 0, reconciled: 0, conflicts: 0, errors: [] };
  }

  const [workspaceId, workspaceScope] = await Promise.all([
    resolveWorkspaceId(rootPath),
    resolveWorkspaceScope(rootPath),
  ]);
  signal?.throwIfAborted();
  const ctx: EntityReconcileContext = {
    workspaceRoot: rootPath,
    workspaceId,
    workspaceScope,
    mutationToken,
  };
  const result: EntityReconcileResult = {
    scanned: 0,
    reconciled: 0,
    conflicts: 0,
    errors: [],
  };
  const relationshipPass: Array<{
    adapter: NonNullable<ReturnType<typeof getEntityAdapterForPath>>;
    doc: unknown;
    id: string;
    path: string;
  }> = [];
  let dirsVisited = 0;
  let scanWorkUnits = 0;
  let capped = false;

  const reconcileOne = async (path: string): Promise<void> => {
    signal?.throwIfAborted();
    if (acceptedPaths.has(path)) return;
    if (isDeveloperImportSourcePath(path)) return;
    const adapter = getEntityAdapterForPath(path);
    if (!adapter) return;
    result.scanned++;
    try {
      let catalogBindOk = true;
      if (adapter.schema) {
        try {
          await resolveArtifactFile({ path, workspaceRoot: rootPath, mutationToken });
        } catch (err) {
          result.errors.push({
            path,
            message: `binding: ${err instanceof Error ? err.message : String(err)}`,
          });
          catalogBindOk = false;
        }
      }
      const [bytes, stat] = await Promise.all([
        platform().fs.readTextFile(path),
        platform().fs.stat(path),
      ]);
      signal?.throwIfAborted();

      const { id, outcome, conflictReason } = await reconcileEntityFile(
        adapter,
        bytes,
        path,
        mtimeMs(stat),
        ctx,
        { catalogBindOk }
      );
      if (outcome === 'created' || outcome === 'updated-from-file') result.reconciled++;
      else if (outcome === 'conflict') {
        result.conflicts++;
        (result.conflictDetails ??= []).push({
          id,
          path,
          reason: conflictReason ?? 'unknown-base',
        });
      }
      if (
        adapter.kind === 'notebook' &&
        catalogBindOk &&
        outcome !== 'skipped-unbound' &&
        outcome !== 'skipped-import-source'
      ) {
        try {
          const catalog = await getCatalogEntity(id);
          await ensureNotebookRegisteredInLims({
            id,
            name: catalog?.name ?? 'Untitled',
            packagePath: notebookPackageRootFromAdapterPath(path),
            workspaceId: ctx.workspaceId,
            mutationToken: ctx.mutationToken,
          });
        } catch {}
      }
      if (
        adapter.reconcileRelationships &&
        outcome !== 'conflict' &&
        outcome !== 'skipped-unbound' &&
        outcome !== 'skipped-import-source'
      ) {
        relationshipPass.push({ adapter, doc: await adapter.parse(bytes, path), id, path });
      }
    } catch (err) {
      result.errors.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  };

  const walk = async (dir: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (depth > MAX_DEPTH) return;
    if (dirsVisited >= MAX_DIRS) {
      if (!capped) {
        capped = true;
        console.warn(
          `[entity-reconcile] MAX_DIRS (${MAX_DIRS}) reached under ${rootPath}; coverage truncated`
        );
      }
      return;
    }
    dirsVisited++;
    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
    try {
      entries = await platform().fs.readDir(dir);
    } catch (err) {
      result.errors.push({ path: dir, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      await cooperateWithRendererInteraction(scanWorkUnits++, { signal });
      signal?.throwIfAborted();
      const path = `${dir.replace(/\/+$/, '')}/${entry.name}`;
      if (entry.isDirectory) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;

        const metaPath = `${path}/${NOTEBOOK_META_REL}`;
        let isPackage = false;
        try {
          isPackage = await platform().fs.exists(metaPath);
        } catch {
          isPackage = false;
        }
        if (isPackage) {
          await reconcileOne(metaPath);
          continue;
        }
        let sequenceMetaPath: string | null = null;
        for (const candidate of sequencePackageMetaPaths(path)) {
          try {
            if (await platform().fs.exists(candidate)) {
              sequenceMetaPath = candidate;
              break;
            }
          } catch {}
        }
        if (sequenceMetaPath) {
          await reconcileOne(sequenceMetaPath);
          continue;
        }
        await walk(path, depth + 1);
      } else if (entry.isFile) {
        if (getEntityAdapterForPath(path)) await reconcileOne(path);
      }
    }
  };

  if (candidatePaths === undefined) {
    await walk(rootPath, 0);
  } else {
    for (let index = 0; index < candidatePaths.length; index++) {
      await cooperateWithRendererInteraction(index, { signal });
      await reconcileOne(candidatePaths[index]);
    }
  }

  for (let index = 0; index < relationshipPass.length; index++) {
    await cooperateWithRendererInteraction(index, { signal });
    signal?.throwIfAborted();
    const item = relationshipPass[index];
    try {
      await item.adapter.reconcileRelationships?.(item.doc, item.id, item.path, ctx);
    } catch (err) {
      result.errors.push({
        path: item.path,
        message: `relationships: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  signal?.throwIfAborted();
  return result;
}
