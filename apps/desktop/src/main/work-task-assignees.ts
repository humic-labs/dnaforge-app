import type Database from 'better-sqlite3';
import type { WorkAssignee } from '@waypoint/domain-services';
import type { WorkAssigneeListing } from '../shared/work-tasks-ipc';
import { createWorkspaceSyncAccessClient } from './workspace-sync-access';
import { readWorkspaceSyncAccessBinding } from './workspace-sync-access-record';
import { withWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import {
  assertWorkProjectAtAcceptance,
  visibleWorkProjects,
  workRefused,
  type WorkProjectAccess,
} from './work-task-projects';

export async function workAssigneeListing(
  db: Database.Database,
  workspaceRoot: string
): Promise<WorkAssigneeListing> {
  const project = visibleWorkProjects(db, workspaceRoot)[0];
  if (!project) return workRefused('This project is unavailable.');
  const members = [{ principal: project.actor, label: 'Me' }];
  if (project.actor.kind === 'local') return { status: 'local', members };
  const binding = readWorkspaceSyncAccessBinding(db, project.registeredId);
  if (!binding?.remote_workspace_id) return { status: 'unavailable', members };
  let listing;
  try {
    listing = await createWorkspaceSyncAccessClient().listAccess(
      binding.remote_workspace_id,
      project.actor.id
    );
  } catch {
    return withWorkspaceSyncDatabaseFence(db, async () => {
      assertWorkProjectAtAcceptance(db, project, false);
      return { status: 'unavailable', members };
    });
  }
  return withWorkspaceSyncDatabaseFence(db, async () => {
    assertWorkProjectAtAcceptance(db, project, false);
    if (
      readWorkspaceSyncAccessBinding(db, project.registeredId)?.remote_workspace_id !==
        binding.remote_workspace_id ||
      listing.workspaceId !== binding.remote_workspace_id
    )
      return workRefused('The selected project changed.');
    const add = (accountId: string, label: string | null) => {
      if (!members.some((row) => row.principal.id === accountId))
        members.push({ principal: { kind: 'member', id: accountId }, label: label || accountId });
    };
    if (listing.owner.kind === 'personal')
      add(listing.owner.accountId, listing.owner.displayName || listing.owner.email);
    for (const person of listing.admins) add(person.accountId, person.displayName || person.email);
    for (const person of listing.grants)
      if (person.subjectKind === 'account' && person.accountId && person.role !== 'viewer')
        add(person.accountId, person.displayName || person.email);
    return { status: 'verified', members };
  });
}

export async function authorizeWorkAssignee(
  db: Database.Database,
  project: WorkProjectAccess,
  requested: WorkAssignee | null | undefined
) {
  if (!requested || (requested.kind === project.actor.kind && requested.id === project.actor.id))
    return;
  if (project.actor.kind !== 'member' || requested.kind !== 'member')
    workRefused('Choose a principal from this project.');
  const listing = await workAssigneeListing(db, project.root);
  if (listing.status !== 'verified')
    workRefused('Project membership is unavailable. Connect to verify this assignee.');
  if (!listing.members.some((m) => m.principal.id === requested.id))
    workRefused('This account is no longer an eligible project member.');
}
