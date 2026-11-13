import { withUserMessage } from '@waypoint/user-messages';
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type Database from 'better-sqlite3';
import type {
  IdentifyOriginalDefaultProjectRequest,
  OriginalDefaultProjectResolution,
} from '../shared/first-project';
import type { DatabaseRecoveryDependencies } from './database-recovery';
import {
  readOriginalProjectBackupEvidence,
  type OriginalProjectEvidence,
} from './original-default-project-backups';
import { isBundledSampleWorkspaceOriginPath } from '../shared/sample-workspace-ipc';

export const ORIGINAL_DEFAULT_PROJECT_SETTING = 'original_default_project_identity_v1';

interface ProjectRow {
  id: number;
  name: string;
  path: string;
  repo_uuid: string | null;
  created_at: number;
  access_mode: string;
  archived_at: number | null;
  trashed_at: number | null;
}

type UnresolvedReason = Extract<
  OriginalDefaultProjectResolution,
  { status: 'unresolved' }
>['reason'];

export type OriginalDefaultProjectIdentityResolution =
  | {
      status: 'identified';
      repoUuid: string;
      evidence: Extract<OriginalDefaultProjectResolution, { status: 'ready' }>['evidence'];
    }
  | Extract<OriginalDefaultProjectResolution, { status: 'unresolved' }>;

function unresolved(
  reason: UnresolvedReason,
  message: string
): Extract<OriginalDefaultProjectResolution, { status: 'unresolved' }> {
  return { status: 'unresolved', reason, message };
}

function storedIdentity(db: Database.Database): { repoUuid: string } | null | 'invalid' {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(ORIGINAL_DEFAULT_PROJECT_SETTING) as { value: string | null } | undefined;
  if (!row) return null;
  try {
    const value: unknown = JSON.parse(row.value ?? '');
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      value.version !== 1 ||
      !('repoUuid' in value) ||
      typeof value.repoUuid !== 'string' ||
      !value.repoUuid.trim()
    )
      return 'invalid';
    return { repoUuid: value.repoUuid };
  } catch {
    return 'invalid';
  }
}

function legacyProject(db: Database.Database): ProjectRow | undefined {
  return db
    .prepare(
      `SELECT w.* FROM workspaces w JOIN settings s ON s.value = w.path
     WHERE s.key = 'default_workspace_path'`
    )
    .get() as ProjectRow | undefined;
}

function backupIdentity(db: Database.Database): OriginalProjectEvidence | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get())
    return null;
  const stored = storedIdentity(db);
  if (stored === 'invalid') throw new Error('The retained identity is invalid.');
  if (stored) return stored;
  const legacy = db
    .prepare("SELECT value FROM settings WHERE key = 'default_workspace_path'")
    .get() as { value: string | null } | undefined;
  if (!legacy?.value) return null;
  const hasUuid = (db.pragma('table_info(workspaces)') as Array<{ name: string }>).some(
    (column) => column.name === 'repo_uuid'
  );
  if (hasUuid) {
    const project = db
      .prepare('SELECT repo_uuid FROM workspaces WHERE path = ?')
      .get(legacy.value) as { repo_uuid: string | null } | undefined;
    if (project?.repo_uuid) return { repoUuid: project.repo_uuid };
  }
  return { path: legacy.value };
}

function projectResolution(
  row: ProjectRow | undefined,
  evidence: Extract<OriginalDefaultProjectResolution, { status: 'ready' }>['evidence']
): OriginalDefaultProjectResolution {
  if (!row) return unresolved('project-missing', 'The original My Project is missing.');
  if (row.trashed_at != null)
    return unresolved(
      'project-trashed',
      'Restore the original My Project from Trash before recovery.'
    );
  if (row.archived_at != null)
    return unresolved(
      'project-archived',
      'Restore the original My Project from the archive before recovery.'
    );
  if (row.access_mode !== 'writable')
    return unresolved(
      'project-read-only',
      'The original My Project must be writable before recovery.'
    );
  try {
    if (!isAbsolute(row.path)) throw new Error('Project path is not absolute.');
    const stat = lstatSync(row.path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Project is not a directory.');
  } catch {
    return unresolved(
      'project-unavailable',
      'The original My Project is unavailable on this device.'
    );
  }
  if (!row.repo_uuid)
    return unresolved('invalid-identity', 'The original My Project has no stable identity.');
  return {
    status: 'ready',
    project: {
      workspaceId: row.id,
      repoUuid: row.repo_uuid,
      rootPath: row.path,
      displayName: row.name,
      createdAt: row.created_at,
    },
    evidence,
  };
}

export function readOriginalDefaultProjectIdentity(
  db: Database.Database,
  deps: Pick<DatabaseRecoveryDependencies, 'openDatabase'> = {}
): OriginalDefaultProjectIdentityResolution {
  const stored = storedIdentity(db);
  if (stored === 'invalid')
    return unresolved('invalid-identity', 'The original My Project identity could not be read.');
  if (stored) {
    return { status: 'identified', repoUuid: stored.repoUuid, evidence: 'stored-identity' };
  }
  const legacy = legacyProject(db);
  const backups = readOriginalProjectBackupEvidence(db.name, backupIdentity, deps);
  const identities = [...backups.identities];
  if (legacy?.repo_uuid) identities.push({ repoUuid: legacy.repo_uuid });
  const candidates = new Map<string, string | null>();
  for (const identity of identities) {
    const row = (
      'repoUuid' in identity
        ? db.prepare('SELECT * FROM workspaces WHERE repo_uuid = ?').get(identity.repoUuid)
        : db.prepare('SELECT * FROM workspaces WHERE path = ?').get(identity.path)
    ) as ProjectRow | undefined;
    const repoUuid = row?.repo_uuid ?? ('repoUuid' in identity ? identity.repoUuid : null);
    const key = repoUuid
      ? `uuid:${repoUuid}`
      : 'repoUuid' in identity
        ? `uuid:${identity.repoUuid}`
        : `path:${identity.path}`;
    candidates.set(key, repoUuid);
  }
  if (candidates.size > 1)
    return unresolved(
      'conflicting-evidence',
      'Retained settings identify different original projects. Identify the original My Project before recovery.'
    );
  if (backups.unreadable)
    return unresolved(
      'evidence-unreadable',
      'Some retained original-project evidence could not be read. Identify the original My Project before recovery.'
    );
  if (candidates.size === 1) {
    const repoUuid = [...candidates.values()][0];
    if (!repoUuid) return unresolved('project-missing', 'The original My Project is missing.');
    return {
      status: 'identified',
      repoUuid,
      evidence: legacy ? 'legacy-default-path' : 'legacy-backup',
    };
  }
  if (legacy) {
    if (!legacy.repo_uuid)
      return unresolved('invalid-identity', 'The original My Project has no stable identity.');
    return { status: 'identified', repoUuid: legacy.repo_uuid, evidence: 'legacy-default-path' };
  }
  return unresolved('identity-not-recorded', 'The original My Project has not been identified.');
}

export function resolveOriginalDefaultProject(
  db: Database.Database,
  deps: Pick<DatabaseRecoveryDependencies, 'openDatabase'> = {}
): OriginalDefaultProjectResolution {
  const identity = readOriginalDefaultProjectIdentity(db, deps);
  if (identity.status === 'unresolved') return identity;
  const row = db.prepare('SELECT * FROM workspaces WHERE repo_uuid = ?').get(identity.repoUuid) as
    | ProjectRow
    | undefined;
  return projectResolution(row, identity.evidence);
}

export function rememberOriginalDefaultProject(db: Database.Database, workspaceId: number): void {
  db.transaction(() => {
    const project = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as
      | ProjectRow
      | undefined;
    if (!project?.repo_uuid)
      throw new Error('The original My Project requires a stable project identity.');
    const stored = storedIdentity(db);
    if (stored === 'invalid')
      throw new Error('The original My Project identity could not be read.');
    if (stored && stored.repoUuid !== project.repo_uuid)
      throw new Error('The original My Project is already identified; it cannot be replaced.');
    const legacy = legacyProject(db);
    if (!stored && legacy?.repo_uuid && legacy.repo_uuid !== project.repo_uuid)
      throw new Error(
        'The original My Project is already identified by its former default setting.'
      );
    if (stored) return;
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)`).run(
      ORIGINAL_DEFAULT_PROJECT_SETTING,
      JSON.stringify({ version: 1, repoUuid: project.repo_uuid }),
      Date.now()
    );
  })();
}

export function identifyOriginalDefaultProject(
  db: Database.Database,
  request: IdentifyOriginalDefaultProjectRequest,
  deps: Pick<DatabaseRecoveryDependencies, 'openDatabase'> = {}
): OriginalDefaultProjectResolution {
  return db.transaction(() => {
    if (!Number.isSafeInteger(request.workspaceId) || request.workspaceId < 1 || !request.repoUuid)
      throw new Error('Choose the existing original project.');
    const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(request.workspaceId) as
      | (ProjectRow & { origin_path: string | null })
      | undefined;
    if (row?.repo_uuid !== request.repoUuid)
      throw withUserMessage(
        new Error('The selected project identity changed. Refresh the project list.'),
        'guidance.the-selected-project-identity-changed-refresh-the-project-list'
      );
    if (isBundledSampleWorkspaceOriginPath(row.origin_path))
      throw new Error('The bundled Samples project cannot be the original My Project.');
    const selected = projectResolution(row, 'stored-identity');
    if (selected.status !== 'ready') throw new Error(selected.message);
    const current = resolveOriginalDefaultProject(db, deps);
    if (current.status === 'ready') {
      if (current.project.repoUuid !== request.repoUuid)
        throw new Error('The original My Project is already identified; it cannot be replaced.');
      rememberOriginalDefaultProject(db, request.workspaceId);
      return resolveOriginalDefaultProject(db, deps);
    }
    if (
      !['identity-not-recorded', 'conflicting-evidence', 'evidence-unreadable'].includes(
        current.reason
      )
    )
      throw new Error(current.message);
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      ORIGINAL_DEFAULT_PROJECT_SETTING,
      JSON.stringify({ version: 1, repoUuid: request.repoUuid }),
      Date.now()
    );
    return selected;
  })();
}
