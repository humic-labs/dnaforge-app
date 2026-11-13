import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import { MANAGED_WORKSPACE_MARKER } from '../shared/workspace-git-types';

const MANAGED_ROOT_BASENAME = 'managed-workspaces';
const MANAGED_REPO_BASENAME = 'repo';
const MAX_MARKER_BYTES = 64 * 1024;

export type DevProfilePathMigrationSkipReason =
  | 'counterpart-missing'
  | 'counterpart-escaped-root'
  | 'counterpart-invalid'
  | 'identity-mismatch'
  | 'path-conflict';

export interface DevProfilePathMigrationRows {
  workspaces: number;
  workspaceOrigins: number;
  indexedFiles: number;
  catalogEntities: number;
  catalogEntityFiles: number;
  catalogEntityEvents: number;
  conversations: number;
  agentOutputArtifacts: number;
  settings: number;
}

export interface DevProfilePathMigrationResult {
  action: 'not-dev-profile' | 'none' | 'migrated';
  migratedWorkspaces: number;
  migratedRows: DevProfilePathMigrationRows;
  skipped: Array<{ workspaceId: number; reason: DevProfilePathMigrationSkipReason }>;
}

interface DevProfileIdentity {
  parent: string;
  prefix: string;
  port: string;
}

interface WorkspaceRow {
  id: number;
  path: string;
  repo_uuid: string;
  origin_path: string | null;
}

interface PathRow {
  id: string | number;
  path: string;
}

interface ConversationPathRow {
  id: string;
  workspace_path: string | null;
}

interface CatalogEntityRow {
  id: string;
  locator: string;
  metadata: string | null;
}

interface CatalogEventRow {
  id: string;
  payload: string | null;
}

interface WorkspaceMigrationPlan {
  workspace: WorkspaceRow;
  newRepoPath: string;
  newOriginPath: string | null;
  indexedFiles: Array<PathRow & { nextPath: string }>;
  catalogEntities: Array<CatalogEntityRow & { nextLocator: string; nextMetadata: string | null }>;
  catalogEntityFiles: Array<PathRow & { nextPath: string }>;
  catalogEntityEvents: Array<CatalogEventRow & { nextPayload: string }>;
  conversations: Array<ConversationPathRow & { nextPath: string }>;
  agentOutputArtifacts: Array<PathRow & { nextPath: string }>;
  settingPath: string | null;
}

const emptyRows = (): DevProfilePathMigrationRows => ({
  workspaces: 0,
  workspaceOrigins: 0,
  indexedFiles: 0,
  catalogEntities: 0,
  catalogEntityFiles: 0,
  catalogEntityEvents: 0,
  conversations: 0,
  agentOutputArtifacts: 0,
  settings: 0,
});

export function migrateClonedDevProfileWorkspacePaths(
  db: Database.Database,
  currentUserData: string
): DevProfilePathMigrationResult {
  const currentProfile = parseDevProfile(currentUserData);
  if (!currentProfile) {
    return {
      action: 'not-dev-profile',
      migratedWorkspaces: 0,
      migratedRows: emptyRows(),
      skipped: [],
    };
  }

  const rows = db
    .prepare(
      `SELECT id, path, repo_uuid, origin_path
       FROM workspaces
       WHERE repo_uuid IS NOT NULL`
    )
    .all() as WorkspaceRow[];
  const plans: WorkspaceMigrationPlan[] = [];
  const skipped: DevProfilePathMigrationResult['skipped'] = [];

  for (const workspace of rows) {
    const source = clonedSourceForWorkspace(workspace, currentProfile);
    if (!source) continue;

    const newRepoPath = join(
      resolve(currentUserData),
      MANAGED_ROOT_BASENAME,
      workspace.repo_uuid,
      MANAGED_REPO_BASENAME
    );
    const validation = validateCounterpart(newRepoPath, currentUserData, workspace.repo_uuid);
    if (validation !== null) {
      skipped.push({ workspaceId: workspace.id, reason: validation });
      continue;
    }

    const conflict = db
      .prepare('SELECT id FROM workspaces WHERE path = ? AND id <> ? LIMIT 1')
      .get(newRepoPath, workspace.id) as { id: number } | undefined;
    if (conflict) {
      skipped.push({ workspaceId: workspace.id, reason: 'path-conflict' });
      continue;
    }

    const plan = buildWorkspacePlan(
      db,
      workspace,
      source.oldUserData,
      source.oldRepoPath,
      newRepoPath,
      currentUserData
    );
    if (
      hasCatalogPathConflict(db, plan.catalogEntityFiles) ||
      hasCatalogLocatorConflict(db, plan.catalogEntities)
    ) {
      skipped.push({ workspaceId: workspace.id, reason: 'path-conflict' });
      continue;
    }
    plans.push(plan);
  }

  if (plans.length === 0) {
    return {
      action: 'none',
      migratedWorkspaces: 0,
      migratedRows: emptyRows(),
      skipped,
    };
  }

  const migratedRows = emptyRows();
  db.transaction(() => {
    for (const plan of plans) {
      applyWorkspacePlan(db, plan, migratedRows);
    }
  })();

  return {
    action: 'migrated',
    migratedWorkspaces: plans.length,
    migratedRows,
    skipped,
  };
}

export function rebindWorkspaceRootInDb(
  db: Database.Database,
  workspace: WorkspaceRow,
  newRepoPath: string
): void {
  const plan = buildWorkspacePlan(
    db,
    workspace,
    workspace.path,
    workspace.path,
    newRepoPath,
    newRepoPath
  );
  if (
    hasCatalogPathConflict(db, plan.catalogEntityFiles) ||
    hasCatalogLocatorConflict(db, plan.catalogEntities) ||
    plan.indexedFiles.some((row) =>
      db
        .prepare('SELECT id FROM indexed_files WHERE path = ? AND id <> ? LIMIT 1')
        .get(row.nextPath, row.id)
    )
  )
    throw new Error('The selected folder already has conflicting file records.');
  db.transaction(() => {
    applyWorkspacePlan(db, plan, emptyRows());
    for (const row of db
      .prepare("SELECT key, value FROM settings WHERE key = 'default_workspace_path'")
      .all() as Array<{ key: string; value: string }>) {
      const next =
        remapRootedPath(row.value, workspace.path, newRepoPath) ??
        (row.value.startsWith('[') || row.value.startsWith('{')
          ? remapJsonDocument(row.value, workspace.path, newRepoPath)
          : null);
      if (next !== null)
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(next, row.key);
    }
    for (const row of db
      .prepare(
        'SELECT id, workspace_root_path, workspace_scope, locator, deep_link_params, data FROM entity_references'
      )
      .all() as Array<{
      id: string;
      workspace_root_path: string | null;
      workspace_scope: string | null;
      locator: string;
      deep_link_params: string | null;
      data: string | null;
    }>) {
      const scope = row.workspace_scope?.startsWith('folders:')
        ? remapJsonDocument(
            row.workspace_scope.slice('folders:'.length),
            workspace.path,
            newRepoPath
          )
        : null;
      const values = [
        remapRootedPath(row.workspace_root_path, workspace.path, newRepoPath) ??
          row.workspace_root_path,
        scope === null ? row.workspace_scope : `folders:${scope}`,
        remapStructuredString(row.locator, workspace.path, newRepoPath) ?? row.locator,
        remapJsonDocument(row.deep_link_params, workspace.path, newRepoPath) ??
          row.deep_link_params,
        remapJsonDocument(row.data, workspace.path, newRepoPath) ?? row.data,
      ];
      if (
        values.some(
          (value, index) =>
            value !==
            [
              row.workspace_root_path,
              row.workspace_scope,
              row.locator,
              row.deep_link_params,
              row.data,
            ][index]
        )
      )
        db.prepare(
          'UPDATE entity_references SET workspace_root_path=?, workspace_scope=?, locator=?, deep_link_params=?, data=? WHERE id=?'
        ).run(...values, row.id);
    }
    for (const row of db.prepare('SELECT id, fields FROM lims_entity').all() as Array<{
      id: string;
      fields: string;
    }>) {
      const next = remapJsonDocument(row.fields, workspace.path, newRepoPath);
      if (next !== null)
        db.prepare('UPDATE lims_entity SET fields = ? WHERE id = ?').run(next, row.id);
    }
  })();
}

function applyWorkspacePlan(
  db: Database.Database,
  plan: WorkspaceMigrationPlan,
  migratedRows: DevProfilePathMigrationRows
): void {
  for (const row of plan.indexedFiles) {
    migratedRows.indexedFiles += db
      .prepare('UPDATE indexed_files SET path = ? WHERE id = ?')
      .run(row.nextPath, row.id).changes;
  }
  for (const row of plan.catalogEntities) {
    migratedRows.catalogEntities += db
      .prepare('UPDATE catalog_entities SET locator = ?, metadata = ? WHERE id = ?')
      .run(row.nextLocator, row.nextMetadata, row.id).changes;
  }
  for (const row of plan.catalogEntityFiles) {
    migratedRows.catalogEntityFiles += db
      .prepare('UPDATE catalog_entity_files SET path = ? WHERE id = ?')
      .run(row.nextPath, row.id).changes;
  }
  for (const row of plan.catalogEntityEvents) {
    migratedRows.catalogEntityEvents += db
      .prepare('UPDATE catalog_entity_events SET payload = ? WHERE id = ?')
      .run(row.nextPayload, row.id).changes;
  }
  for (const row of plan.conversations) {
    migratedRows.conversations += db
      .prepare('UPDATE conversations SET workspace_path = ? WHERE id = ?')
      .run(row.nextPath, row.id).changes;
  }
  for (const row of plan.agentOutputArtifacts) {
    migratedRows.agentOutputArtifacts += db
      .prepare('UPDATE agent_output_artifacts SET path = ? WHERE id = ?')
      .run(row.nextPath, row.id).changes;
  }
  if (plan.settingPath !== null) {
    migratedRows.settings += db
      .prepare("UPDATE settings SET value = ? WHERE key = 'current_workspace_path'")
      .run(plan.settingPath).changes;
  }

  migratedRows.workspaces += db
    .prepare('UPDATE workspaces SET path = ?, origin_path = ? WHERE id = ?')
    .run(plan.newRepoPath, plan.newOriginPath, plan.workspace.id).changes;
  if (plan.newOriginPath !== plan.workspace.origin_path) {
    migratedRows.workspaceOrigins += 1;
  }
}

function parseDevProfile(userDataPath: string): DevProfileIdentity | null {
  if (!isAbsolute(userDataPath)) return null;
  const normalized = resolve(userDataPath);
  const match = /^(.*)-dev-(\d+)$/.exec(basename(normalized));
  if (!match || !match[1]) return null;
  return {
    parent: dirname(normalized),
    prefix: match[1],
    port: match[2],
  };
}

export function managedWorkspaceProfileRoot(workspace: {
  path: string;
  repo_uuid: string | null;
}): string | null {
  if (!workspace.repo_uuid || !isAbsolute(workspace.path)) return null;
  const oldRepoPath = resolve(workspace.path);
  if (basename(oldRepoPath) !== MANAGED_REPO_BASENAME) return null;
  const uuidDir = dirname(oldRepoPath);
  const managedRoot = dirname(uuidDir);
  const oldUserData = dirname(managedRoot);
  if (basename(managedRoot) !== MANAGED_ROOT_BASENAME) return null;
  if (basename(uuidDir) !== workspace.repo_uuid) return null;
  return oldUserData;
}

function clonedSourceForWorkspace(
  workspace: WorkspaceRow,
  currentProfile: DevProfileIdentity
): { oldUserData: string; oldRepoPath: string } | null {
  const oldUserData = managedWorkspaceProfileRoot(workspace);
  if (!oldUserData) return null;
  const oldRepoPath = resolve(workspace.path);
  const oldProfile = parseDevProfile(oldUserData);
  if (
    !oldProfile ||
    oldProfile.parent !== currentProfile.parent ||
    oldProfile.prefix !== currentProfile.prefix ||
    oldProfile.port === currentProfile.port
  ) {
    return null;
  }

  const canonicalOldRepo = join(
    oldUserData,
    MANAGED_ROOT_BASENAME,
    workspace.repo_uuid,
    MANAGED_REPO_BASENAME
  );
  if (canonicalOldRepo !== oldRepoPath) return null;
  return { oldUserData, oldRepoPath };
}

function validateCounterpart(
  candidateRepo: string,
  currentUserData: string,
  expectedUuid: string
): DevProfilePathMigrationSkipReason | null {
  const uuidDir = dirname(candidateRepo);
  if (!existsSync(uuidDir)) return 'counterpart-missing';
  try {
    if (lstatSync(uuidDir).isSymbolicLink()) return 'counterpart-escaped-root';
  } catch {
    return 'counterpart-missing';
  }
  if (!existsSync(candidateRepo)) return 'counterpart-missing';

  try {
    const candidateStat = lstatSync(candidateRepo);
    if (candidateStat.isSymbolicLink()) return 'counterpart-escaped-root';
    if (!candidateStat.isDirectory()) return 'counterpart-invalid';

    const managedRoot = join(resolve(currentUserData), MANAGED_ROOT_BASENAME);
    const managedRootReal = realpathSync(managedRoot);
    const candidateReal = realpathSync(candidateRepo);
    if (!isSameOrDescendant(candidateReal, managedRootReal)) {
      return 'counterpart-escaped-root';
    }

    const markerPath = join(candidateRepo, MANAGED_WORKSPACE_MARKER);
    const markerStat = lstatSync(markerPath);
    if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size > MAX_MARKER_BYTES) {
      return 'counterpart-invalid';
    }
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      schema?: unknown;
      workspaceUuid?: unknown;
    };
    if (marker.schema !== 1 || marker.workspaceUuid !== expectedUuid) {
      return 'identity-mismatch';
    }
    if (!existsSync(join(candidateRepo, '.git'))) return 'counterpart-invalid';
  } catch {
    return 'counterpart-invalid';
  }
  return null;
}

function buildWorkspacePlan(
  db: Database.Database,
  workspace: WorkspaceRow,
  oldUserData: string,
  oldRepoPath: string,
  newRepoPath: string,
  currentUserData: string
): WorkspaceMigrationPlan {
  const indexedFiles = (
    db
      .prepare('SELECT id, path FROM indexed_files WHERE workspace_id = ?')
      .all(workspace.id) as PathRow[]
  ).flatMap((row) => remapPathRow(row, oldRepoPath, newRepoPath));
  const catalogEntityFiles = (
    db
      .prepare('SELECT id, path FROM catalog_entity_files WHERE workspace_id = ?')
      .all(workspace.id) as PathRow[]
  ).flatMap((row) => remapPathRow(row, oldRepoPath, newRepoPath));
  const catalogEntities = (
    db
      .prepare('SELECT id, locator, metadata FROM catalog_entities WHERE workspace_id = ?')
      .all(workspace.id) as CatalogEntityRow[]
  ).flatMap((row) => {
    const nextLocator = remapStructuredString(row.locator, oldRepoPath, newRepoPath);
    const nextMetadata = remapJsonDocument(row.metadata, oldRepoPath, newRepoPath);
    return nextLocator === null && nextMetadata === null
      ? []
      : [
          {
            ...row,
            nextLocator: nextLocator ?? row.locator,
            nextMetadata: nextMetadata ?? row.metadata,
          },
        ];
  });
  const catalogEntityEvents = (
    db
      .prepare(
        `SELECT event.id, event.payload
         FROM catalog_entity_events event
         JOIN catalog_entities entity ON entity.id = event.entity_id
         WHERE entity.workspace_id = ? AND event.payload IS NOT NULL`
      )
      .all(workspace.id) as CatalogEventRow[]
  ).flatMap((row) => {
    const nextPayload = remapJsonDocument(row.payload, oldRepoPath, newRepoPath);
    return nextPayload === null ? [] : [{ ...row, nextPayload }];
  });
  const conversations = (
    db
      .prepare('SELECT id, workspace_path FROM conversations WHERE workspace_path IS NOT NULL')
      .all() as ConversationPathRow[]
  ).flatMap((row) => {
    const nextPath = remapRootedPath(row.workspace_path, oldRepoPath, newRepoPath);
    return nextPath === null ? [] : [{ ...row, nextPath }];
  });
  const agentOutputArtifacts = (
    db.prepare('SELECT id, path FROM agent_output_artifacts').all() as PathRow[]
  ).flatMap((row) => remapPathRow(row, oldRepoPath, newRepoPath));
  const currentWorkspace = db
    .prepare("SELECT value FROM settings WHERE key = 'current_workspace_path'")
    .get() as { value: string } | undefined;

  return {
    workspace,
    newRepoPath,
    newOriginPath: remapProfileLocalPath(workspace.origin_path, oldUserData, currentUserData),
    indexedFiles,
    catalogEntities,
    catalogEntityFiles,
    catalogEntityEvents,
    conversations,
    agentOutputArtifacts,
    settingPath: currentWorkspace
      ? remapRootedPath(currentWorkspace.value, oldRepoPath, newRepoPath)
      : null,
  };
}

function remapPathRow<T extends PathRow>(
  row: T,
  oldRoot: string,
  newRoot: string
): Array<T & { nextPath: string }> {
  const nextPath = remapRootedPath(row.path, oldRoot, newRoot);
  return nextPath === null ? [] : [{ ...row, nextPath }];
}

function remapRootedPath(path: string | null, oldRoot: string, newRoot: string): string | null {
  if (path === null) return null;
  if (path === oldRoot) return newRoot;
  if (!path.startsWith(`${oldRoot}${sep}`)) return null;
  return `${newRoot}${path.slice(oldRoot.length)}`;
}

function remapStructuredString(value: string, oldRoot: string, newRoot: string): string | null {
  const rootedPath = remapRootedPath(value, oldRoot, newRoot);
  if (rootedPath !== null) return rootedPath;

  const literalFileRoot = `file://${oldRoot}`;
  if (value === literalFileRoot) return `file://${newRoot}`;
  if (value.startsWith(`${literalFileRoot}${sep}`)) {
    return `file://${newRoot}${value.slice(literalFileRoot.length)}`;
  }

  const encodedFileRoot = pathToFileURL(oldRoot).href.replace(/\/$/, '');
  if (value === encodedFileRoot) return pathToFileURL(newRoot).href.replace(/\/$/, '');
  if (value.startsWith(`${encodedFileRoot}/`)) {
    const encodedNewRoot = pathToFileURL(newRoot).href.replace(/\/$/, '');
    return `${encodedNewRoot}${value.slice(encodedFileRoot.length)}`;
  }
  return null;
}

function remapJsonDocument(
  document: string | null,
  oldRoot: string,
  newRoot: string
): string | null {
  if (document === null) return null;
  const escapedOldRoot = JSON.stringify(oldRoot).slice(1, -1);
  const literalFileRoot = `file://${oldRoot}`;
  const encodedFileRoot = pathToFileURL(oldRoot).href.replace(/\/$/, '');
  if (
    !document.includes(oldRoot) &&
    !document.includes(escapedOldRoot) &&
    !document.includes(literalFileRoot) &&
    !document.includes(encodedFileRoot)
  ) {
    return null;
  }
  const remapped = remapJsonValue(JSON.parse(document) as unknown, oldRoot, newRoot);
  return remapped.changed ? JSON.stringify(remapped.value) : null;
}

function remapJsonValue(
  value: unknown,
  oldRoot: string,
  newRoot: string
): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const remapped = remapStructuredString(value, oldRoot, newRoot);
    return remapped === null ? { value, changed: false } : { value: remapped, changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const remapped = remapJsonValue(entry, oldRoot, newRoot);
      changed ||= remapped.changed;
      return remapped.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const next = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const remapped = remapJsonValue(entry, oldRoot, newRoot);
        changed ||= remapped.changed;
        return [key, remapped.value];
      })
    );
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}

function remapProfileLocalPath(
  path: string | null,
  oldUserData: string,
  currentUserData: string
): string | null {
  if (path === null) return null;
  const oldRoot = resolve(oldUserData);
  const resolvedPath = resolve(path);
  if (!isSameOrDescendant(resolvedPath, oldRoot)) return path;

  const candidate = join(resolve(currentUserData), relative(oldRoot, resolvedPath));
  if (!existsSync(candidate)) return path;
  try {
    const currentRootReal = realpathSync(currentUserData);
    const candidateReal = realpathSync(candidate);
    return isSameOrDescendant(candidateReal, currentRootReal) ? candidate : path;
  } catch {
    return path;
  }
}

function hasCatalogPathConflict(
  db: Database.Database,
  rows: Array<PathRow & { nextPath: string }>
): boolean {
  const findConflict = db.prepare(
    'SELECT id FROM catalog_entity_files WHERE path = ? AND id <> ? LIMIT 1'
  );
  return rows.some((row) => Boolean(findConflict.get(row.nextPath, row.id)));
}

function hasCatalogLocatorConflict(
  db: Database.Database,
  rows: Array<CatalogEntityRow & { nextLocator: string }>
): boolean {
  const findConflict = db.prepare(
    'SELECT id FROM catalog_entities WHERE locator = ? AND id <> ? LIMIT 1'
  );
  return rows.some((row) => Boolean(findConflict.get(row.nextLocator, row.id)));
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
