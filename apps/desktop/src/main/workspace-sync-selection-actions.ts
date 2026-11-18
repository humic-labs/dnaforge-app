import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { WorkspaceSyncStoragePolicy } from '@waypoint/share-bundle';
import type { WorkspaceSyncSelectionUpdate } from '../shared/workspace-sync-selection';
import { parseWorkspaceSyncSelectionUpdate } from '../shared/workspace-sync-ipc';
import { acquireWorkspaceSyncMutationLease } from './workspace-sync-mutation-lease';
import { writeWorkspaceTextFileAtomicInMain } from './primer-artifact-files';
import { previewWorkspaceSyncUploadWithHeldMutationLease } from './workspace-sync-snapshotter';
import {
  approveWorkspaceSyncMembership,
  markWorkspaceSyncSelectionPending,
  readWorkspaceSyncMembership,
  WorkspaceSyncSelectionError,
} from './workspace-sync-membership';

export async function updateWorkspaceSyncSelection(
  db: Database.Database,
  input: {
    workspaceUuid: string;
    request: WorkspaceSyncSelectionUpdate;
    storagePolicy: WorkspaceSyncStoragePolicy;
  }
) {
  input = { ...input, request: parseWorkspaceSyncSelectionUpdate(input.request) };
  const workspace = db
    .prepare('SELECT path FROM workspaces WHERE repo_uuid = ?')
    .get(input.workspaceUuid) as { path: string } | undefined;
  if (!workspace) throw new WorkspaceSyncSelectionError('The project is unavailable.');
  const binding = db
    .prepare(
      'SELECT access_role, detached_reason FROM workspace_sync_bindings WHERE workspace_uuid = ?'
    )
    .get(input.workspaceUuid) as
    | { access_role: string | null; detached_reason: string | null }
    | undefined;
  if (binding?.access_role === 'viewer' || binding?.detached_reason)
    throw new WorkspaceSyncSelectionError(
      'This project does not permit changing shared file selection.'
    );
  const release = await acquireWorkspaceSyncMutationLease(workspace.path);
  try {
    const preview = await previewWorkspaceSyncUploadWithHeldMutationLease(db, input);
    if (preview.selection.revision !== input.request.expectedRevision)
      throw new WorkspaceSyncSelectionError(
        'The project contents or rules changed. Review the refreshed selection before applying it.'
      );
    if (input.request.kind === 'save-rules') {
      const existing = preview.selection.ruleFiles.find(
        (file) => file.relativePath === '.gitignore'
      );
      await writeWorkspaceTextFileAtomicInMain(
        {
          workspaceRoot: workspace.path,
          path: join(workspace.path, '.gitignore'),
          content: input.request.rootGitignore,
          mode: existing ? 'replace' : 'create',
          expectedContentHash: existing
            ? createHash('sha256').update(existing.content).digest('hex')
            : undefined,
          artifactNoun: 'project sync rules',
        },
        { durable: true }
      );
      const membership = await readWorkspaceSyncMembership(db, {
        workspaceUuid: input.workspaceUuid,
        repoPath: workspace.path,
      });
      markWorkspaceSyncSelectionPending(db, membership);
    } else {
      const membership = await readWorkspaceSyncMembership(db, {
        workspaceUuid: input.workspaceUuid,
        repoPath: workspace.path,
      });
      if (JSON.stringify(membership.ruleFiles) !== JSON.stringify(preview.selection.ruleFiles))
        throw new WorkspaceSyncSelectionError(
          'The project rules changed. Review the refreshed selection before applying it.'
        );
      approveWorkspaceSyncMembership(db, membership);
    }
    return await previewWorkspaceSyncUploadWithHeldMutationLease(db, input);
  } finally {
    release();
  }
}
