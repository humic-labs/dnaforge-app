import { join } from 'node:path';
import { inspectBenchlingMigrationActionJournal } from './benchling-migration/action-journal';
import { readdir } from 'node:fs/promises';
export async function assertWorkspaceMigrationActionsSettled(workspacePath: string): Promise<void> {
  const directory = join(workspacePath, '.dnaforge/migration/actions');
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  );
  const actionIds = new Set<string>();
  for (const entry of entries) {
    if (!/\.json(?:\.pending)?$/u.test(entry.name)) continue;
    if (!entry.isFile())
      throw new Error('Workspace import recovery journal is not a regular file.');
    actionIds.add(entry.name.replace(/\.json(?:\.pending)?$/u, ''));
  }
  for (const actionId of actionIds) {
    const journal = await inspectBenchlingMigrationActionJournal(workspacePath, actionId);
    if (
      journal &&
      (journal.allocations.some((a) => a.installState !== 'complete') ||
        ((journal.allocations.length === 0 || journal.effectsCaptureSha256) &&
          !journal.completedAt))
    )
      throw new Error(
        'Workspace import recovery is incomplete. Finish or resolve the preserved import before editing or syncing this workspace.'
      );
  }
}
