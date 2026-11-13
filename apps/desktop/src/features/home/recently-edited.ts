import { platform } from '../../platform';
import { userEntityLabel, type UserEntityLabel } from '@waypoint/user-messages';
import {
  getRecentlyEditedCatalogEntities,
  type CatalogEntityType,
  type RecentlyEditedCatalogEntity,
} from '../../db/workspace-catalog';
import { gitRecentlyChangedFiles, gitRepoRootForDir } from '../workspace/public/git';
import { getTabTypeForFile } from '../../utils/fileTypes';
import { isVisibleManagedHeadFile } from '../../shared/catalog-file-kind';
import { isSequencePackageMetaPath } from '../../db/sequence-package';
import { findEnclosingSequencePackageRoot } from '../../db/sequence-package-io';
import { pathRelativeToBoundary } from '../../shared/path-boundary';
import type { TabType } from '../canvas/public/types';
import {
  workspaceCanContributeRecentEdits,
  type WorkspaceAccess,
} from '../../shared/workspace-access';

export type RecentlyEditedOpenTarget =
  | { kind: 'entity'; tabType: TabType; entityId: string }
  | { kind: 'file'; path: string; tabType: TabType };

export interface RecentlyEditedItem {
  id: string;
  title: UserEntityLabel;
  workspaceRoot: string | null;
  workspaceName: string | null;
  updatedAt: number;
  open: RecentlyEditedOpenTarget;
}

interface DBPageRow {
  id: string;
  title: string;
  updated_at: number;
}

interface DBCatalogEntityMini {
  id: string;
  type: string;
  workspace_id: number | null;
}

interface DBWorkspaceRow {
  id: number;
  name: string;
  path: string;
  last_opened_at?: number;
  archived_at?: number | null;
  trashed_at?: number | null;
  access_mode?: WorkspaceAccess;
}

export async function getRecentlyEditedPages(limit: number): Promise<RecentlyEditedItem[]> {
  const db = platform().db;
  const [pageRows, entityRows, workspaceRows] = await Promise.all([
    db.select<DBPageRow[]>('SELECT * FROM pages'),
    db.select<DBCatalogEntityMini[]>('SELECT * FROM catalog_entities'),
    db.select<DBWorkspaceRow[]>('SELECT * FROM workspaces'),
  ]);
  const pages = pageRows ?? [];
  const entities = entityRows ?? [];
  const workspaces = workspaceRows ?? [];
  const notebookEntityById = new Map(
    entities.filter((e) => e.type === 'notebook').map((e) => [e.id, e])
  );
  const workspaceById = new Map(workspaces.map((w) => [w.id, w]));

  const isWorkspaceHidden = (workspaceId: number | null | undefined) => {
    if (workspaceId == null) return false;
    const workspace = workspaceById.get(workspaceId);
    return (
      !!workspace &&
      (!workspaceCanContributeRecentEdits(workspace.access_mode) ||
        !!workspace.archived_at ||
        !!workspace.trashed_at)
    );
  };

  return pages
    .flatMap((page) => {
      const entity = notebookEntityById.get(page.id);
      if (isWorkspaceHidden(entity?.workspace_id)) return [];
      const workspace =
        entity?.workspace_id != null ? workspaceById.get(entity.workspace_id) : null;
      return [
        {
          id: page.id,
          title: userEntityLabel(page.title),
          workspaceRoot: workspace?.path ?? null,
          workspaceName: workspace?.name ?? null,
          updatedAt: page.updated_at,
          open: { kind: 'entity', tabType: 'page', entityId: page.id } as const,
        },
      ];
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

const CATALOG_TYPE_TO_TAB_TYPE: Partial<Record<CatalogEntityType, TabType>> = {
  sequence: 'sequence',
  design: 'design',
  structure: 'structure',
};

const FILE_LOCATOR_PREFIX = 'file://';

function stripFileLocator(locator: string): string | null {
  return locator.startsWith(FILE_LOCATOR_PREFIX) ? locator.slice(FILE_LOCATOR_PREFIX.length) : null;
}

export async function getRecentlyEditedThings(limit: number): Promise<RecentlyEditedItem[]> {
  const entities = await getRecentlyEditedCatalogEntities(limit);
  return catalogRecentItems(entities);
}

function catalogRecentItems(
  entities: readonly RecentlyEditedCatalogEntity[]
): RecentlyEditedItem[] {
  const items: RecentlyEditedItem[] = [];
  for (const entity of entities) {
    const tabType = CATALOG_TYPE_TO_TAB_TYPE[entity.type];
    if (!tabType) continue;

    if (entity.storage_type === 'file') {
      const path = entity.current_file_path ?? stripFileLocator(entity.locator);
      if (!path) continue;
      items.push({
        id: entity.id,
        title: userEntityLabel(entity.name),
        workspaceRoot: entity.workspace_path,
        workspaceName: entity.workspace_name,
        updatedAt: entity.updated_at,
        open: { kind: 'file', path, tabType },
      });
      continue;
    }

    items.push({
      id: entity.id,
      title: userEntityLabel(entity.name),
      workspaceRoot: entity.workspace_path,
      workspaceName: entity.workspace_name,
      updatedAt: entity.updated_at,
      open: { kind: 'entity', tabType, entityId: entity.id },
    });
  }
  return items;
}

function joinWorkspacePath(root: string, relative: string): string {
  const usesBackslash = root.includes('\\') && !root.includes('/');
  const sep = usesBackslash ? '\\' : '/';
  const trimmedRoot = root.replace(/[\\/]+$/, '');
  const normalizedRelative = usesBackslash ? relative.replace(/\//g, '\\') : relative;
  return `${trimmedRoot}${sep}${normalizedRelative}`;
}

const MAX_GIT_CANDIDATES_TO_CHECK = 200;

export async function getRecentlyEditedGitFiles(
  workspaces: Array<{ path: string; name: string }>,
  perWorkspaceCommitDepth: number
): Promise<RecentlyEditedItem[]> {
  const perWorkspace = await Promise.all(
    workspaces.map(async (ws) => {
      const [repoRoot, entries] = await Promise.all([
        gitRepoRootForDir(ws.path),
        gitRecentlyChangedFiles(ws.path, perWorkspaceCommitDepth),
      ]);
      const joinRoot = repoRoot ?? ws.path;
      return entries
        .filter(
          (entry) => isVisibleManagedHeadFile(entry.path) || isSequencePackageMetaPath(entry.path)
        )
        .map((entry) => ({
          entry,
          workspace: ws,
          joinRoot,
          updatedAt: new Date(entry.date).getTime(),
        }));
    })
  );
  const fs = platform().fs;
  const metadataExists = new Map<string, Promise<boolean>>();
  const packageOwners = new Map<string, Promise<string | null | undefined>>();
  const packageFs = {
    exists: (path: string) => {
      let result = metadataExists.get(path);
      if (!result) {
        result = fs.exists(path);
        metadataExists.set(path, result);
      }
      return result;
    },
  };
  const candidates: Array<
    RecentlyEditedItem & { open: Extract<RecentlyEditedOpenTarget, { kind: 'file' }> }
  > = [];
  const seenPaths = new Set<string>();
  for (const { entry, workspace, joinRoot, updatedAt } of perWorkspace
    .flat()
    .sort((a, b) => b.updatedAt - a.updatedAt)) {
    const directory = joinWorkspacePath(joinRoot, entry.path.split(/[\\/]/).slice(0, -1).join('/'));
    let owner = packageOwners.get(directory);
    if (!owner) {
      owner = findEnclosingSequencePackageRoot(directory, packageFs).catch(() => undefined);
      packageOwners.set(directory, owner);
    }
    const packageRoot = await owner;
    if (packageRoot === undefined) continue;
    const packageRelativePath =
      packageRoot !== null ? pathRelativeToBoundary(packageRoot, joinRoot) : null;
    const relativePath = packageRelativePath ?? entry.path;
    if (!isVisibleManagedHeadFile(relativePath)) continue;
    const path = joinWorkspacePath(joinRoot, relativePath);
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    candidates.push({
      id: `${workspace.path}::${relativePath}`,
      title: userEntityLabel(relativePath.split(/[\\/]/).pop() || workspace.name),
      workspaceRoot: workspace.path,
      workspaceName: workspace.name,
      updatedAt,
      open: {
        kind: 'file',
        path,
        tabType: packageRelativePath !== null ? 'sequence' : getTabTypeForFile(entry.path),
      },
    });
    if (candidates.length >= MAX_GIT_CANDIDATES_TO_CHECK) break;
  }

  const stillExists = await Promise.all(
    candidates.map((item) => fs.exists(item.open.path).catch(() => false))
  );
  return candidates.filter((_, index) => stillExists[index]);
}

const RECENT_WORKSPACE_SCAN_LIMIT = 5;
const GIT_COMMIT_SCAN_DEPTH = 30;

export async function getRecentlyEdited(limit: number = 8): Promise<RecentlyEditedItem[]> {
  const db = platform().db;
  const workspaceRows = (await db.select<DBWorkspaceRow[]>('SELECT * FROM workspaces')) ?? [];
  const recentWorkspaces = workspaceRows
    .filter(
      (w) => workspaceCanContributeRecentEdits(w.access_mode) && !w.archived_at && !w.trashed_at
    )
    .sort((a, b) => (b.last_opened_at ?? 0) - (a.last_opened_at ?? 0))
    .slice(0, RECENT_WORKSPACE_SCAN_LIMIT)
    .map((w) => ({ path: w.path, name: w.name }));

  const [pages, catalogRows, gitFiles] = await Promise.all([
    getRecentlyEditedPages(limit),
    getRecentlyEditedCatalogEntities(limit),
    getRecentlyEditedGitFiles(recentWorkspaces, GIT_COMMIT_SCAN_DEPTH),
  ]);
  const things = catalogRecentItems(catalogRows);
  const fileNames = new Map<string, UserEntityLabel>();
  for (const entity of catalogRows) {
    if (entity.current_file_path)
      fileNames.set(entity.current_file_path, userEntityLabel(entity.name));
  }
  const namedGitFiles = gitFiles.map((item) => ({
    ...item,
    title: item.open.kind === 'file' ? (fileNames.get(item.open.path) ?? item.title) : item.title,
  }));
  const merged = [...pages, ...things, ...namedGitFiles].sort((a, b) => b.updatedAt - a.updatedAt);
  const seen = new Set<string>();
  const deduped: RecentlyEditedItem[] = [];
  for (const item of merged) {
    const key =
      item.open.kind === 'file' ? `file:${item.open.path}` : `entity:${item.open.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

let recentlyEditedSnapshot: RecentlyEditedItem[] = [];
const recentlyEditedListeners = new Set<(items: RecentlyEditedItem[]) => void>();

export function peekRecentlyEditedSnapshot(): RecentlyEditedItem[] {
  return recentlyEditedSnapshot;
}

export function publishRecentlyEditedSnapshot(items: RecentlyEditedItem[]): void {
  recentlyEditedSnapshot = items;
  for (const listener of recentlyEditedListeners) listener(items);
}

export function subscribeRecentlyEditedSnapshot(
  listener: (items: RecentlyEditedItem[]) => void
): () => void {
  recentlyEditedListeners.add(listener);
  listener(recentlyEditedSnapshot);
  return () => {
    recentlyEditedListeners.delete(listener);
  };
}

let recentlyEditedInFlight: Promise<RecentlyEditedItem[]> | null = null;
let recentlyEditedRefreshDirty = false;

export function resetRecentlyEditedSnapshotForTests(): void {
  recentlyEditedSnapshot = [];
  recentlyEditedListeners.clear();
  recentlyEditedInFlight = null;
  recentlyEditedRefreshDirty = false;
}

export function refreshRecentlyEdited(limit: number = 50): Promise<RecentlyEditedItem[]> {
  if (recentlyEditedInFlight) {
    recentlyEditedRefreshDirty = true;
    return recentlyEditedInFlight;
  }
  const run = (async () => {
    try {
      do {
        recentlyEditedRefreshDirty = false;
        const items = await getRecentlyEdited(limit);
        publishRecentlyEditedSnapshot(items);
      } while (recentlyEditedRefreshDirty);
      return peekRecentlyEditedSnapshot();
    } finally {
      recentlyEditedInFlight = null;
    }
  })();
  recentlyEditedInFlight = run;
  return run;
}
