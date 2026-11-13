import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitAllIfDirty, hasWorkingChanges, initManagedRepo } from '../workspace-git';
import { executeManagedGit } from '../workspace-git/native';
import { hasWorkspaceSyncWorkingChanges } from '../workspace-sync-git-state';

describe('shared-content changes in a real managed Git repository', () => {
  let repoPath: string;
  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'dnaforge-sync-git-boundary-'));
    await initManagedRepo(repoPath);
    await writeFile(join(repoPath, 'sequence.fasta'), '>sequence\nACGT\n');
    await commitAllIfDirty(repoPath, 'Accepted shared sequence');
  });
  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('retains untracked operational data but refuses ownership of its staged index entry', async () => {
    await mkdir(join(repoPath, '.waypoint/lims'), { recursive: true });
    await writeFile(join(repoPath, '.waypoint/lims/manifest.json'), '{"localData":"retain"}\n');
    expect(await hasWorkingChanges(repoPath)).toBe(true);
    expect(await hasWorkspaceSyncWorkingChanges(repoPath)).toBe(false);
    await executeManagedGit(repoPath, ['add', '--', '.waypoint/lims/manifest.json']);
    expect(await hasWorkspaceSyncWorkingChanges(repoPath)).toBe(true);
  });

  it.each(['sequence.fasta', 'unrecognized.bin', 'build'])(
    'blocks an edit or untracked shared file at %s',
    async (path) => {
      await writeFile(join(repoPath, path), 'unacknowledged user bytes\n');
      expect(await hasWorkspaceSyncWorkingChanges(repoPath)).toBe(true);
    }
  );

  it('blocks moving a shared sequence into an operational directory', async () => {
    await mkdir(join(repoPath, '.waypoint/lims'), { recursive: true });
    await rename(join(repoPath, 'sequence.fasta'), join(repoPath, '.waypoint/lims/sequence.fasta'));
    expect(await hasWorkspaceSyncWorkingChanges(repoPath)).toBe(true);
  });
});
