import { isAbsolute } from 'node:path';
import type Database from 'better-sqlite3';
import type { WorkAssignee } from '@waypoint/domain-services';
import type { WorkProject } from '../shared/work-tasks-ipc';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import {
  createRegisteredProjectAuthority,
  type RegisteredProject,
} from './registered-project-authority';
import { readSelectedAccountContextNow } from './auth/session-store';
import { readOrCreateWorkspaceSyncDeviceId } from './workspace-sync-device';
import { scientificHistoryWorkspaceIdentity } from './scientific-history-identity';
import { hasScientificCloudHistoryBinding } from './scientific-cloud-admission';

export function workRefused(reason: string): never {
  throw new Error(`WORK_TASK_REFUSED: ${reason}`);
}

export interface WorkProjectAccess extends WorkProject {
  registeredId: string;
  actor: WorkAssignee;
  writable: boolean;
}

export function publicWorkProject(project: WorkProjectAccess): WorkProject {
  const { id, workspaceId, root, name, actor, writable } = project;
  return { id, workspaceId, root, name, actor, writable };
}

function activeAccount(): string | null {
  const account = readSelectedAccountContextNow();
  return account.kind === 'account' ? account.accountId : null;
}

export function workProfile(db: Database.Database): WorkAssignee {
  return { kind: 'local', id: readOrCreateWorkspaceSyncDeviceId(db) };
}

interface ProjectBinding {
  repo_uuid: string | null;
  path: string;
  access_mode: string;
  owner_account_id: string | null;
  access_role: string | null;
  detached_reason: string | null;
}

function readProjectBinding(db: Database.Database, id: number) {
  return db
    .prepare(
      `SELECT w.repo_uuid,w.path,w.access_mode,b.owner_account_id,b.access_role,b.detached_reason
    FROM workspaces w LEFT JOIN workspace_sync_bindings b ON b.workspace_id=w.id
    WHERE w.id=? AND w.archived_at IS NULL AND w.trashed_at IS NULL`
    )
    .get(id) as ProjectBinding | undefined;
}

function projectAccess(
  db: Database.Database,
  p: RegisteredProject,
  profile: WorkAssignee,
  account: string | null
): WorkProjectAccess | null {
  const row = readProjectBinding(db, p.id);
  if (
    !row ||
    row.detached_reason !== null ||
    (row.owner_account_id && row.owner_account_id !== account)
  )
    return null;
  const team = row.owner_account_id !== null;
  const actor: WorkAssignee = team ? { kind: 'member', id: row.owner_account_id! } : profile;
  return {
    id: scientificHistoryWorkspaceIdentity(db, p.id),
    registeredId: p.projectId,
    workspaceId: p.id,
    root: row.path,
    name: p.name,
    actor,
    writable:
      !p.pinned &&
      (!team ||
        (hasScientificCloudHistoryBinding(db, p.id) &&
          ['owner', 'manager', 'editor'].includes(row.access_role ?? ''))),
  };
}

export function visibleWorkProjects(db: Database.Database, root?: string): WorkProjectAccess[] {
  const auth = createRegisteredProjectAuthority({ db: () => db });
  const projects =
    root === undefined
      ? auth.list()
      : isAbsolute(root)
        ? [auth.resolve(root)].filter(
            (p) => p !== null && p.path === workspaceMutationRootIdentity(root)
          )
        : [];
  const profile = workProfile(db);
  const account = activeAccount();
  return projects.flatMap((project) => {
    if (!project) return [];
    const resolved = projectAccess(db, project, profile, account);
    return resolved ? [resolved] : [];
  });
}

export function assertWorkProjectAtAcceptance(
  db: Database.Database,
  project: WorkProjectAccess,
  mutating: boolean
) {
  const row = readProjectBinding(db, project.workspaceId);
  if (
    !row ||
    row.path !== project.root ||
    workspaceScopeKey(row.repo_uuid, project.workspaceId) !== project.registeredId ||
    scientificHistoryWorkspaceIdentity(db, project.workspaceId) !== project.id ||
    row.detached_reason !== null ||
    (mutating && row.access_mode !== 'writable')
  )
    workRefused('Project access changed.');
  if (project.actor.kind === 'member') {
    if (
      row.owner_account_id !== project.actor.id ||
      activeAccount() !== project.actor.id ||
      (mutating &&
        (!hasScientificCloudHistoryBinding(db, project.workspaceId) ||
          !['owner', 'manager', 'editor'].includes(row.access_role ?? '')))
    )
      workRefused('Project access changed.');
  } else if (row.owner_account_id !== null) workRefused('Project ownership changed.');
}
