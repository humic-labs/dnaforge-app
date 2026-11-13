import { withUserMessage } from '@waypoint/user-messages';
// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { renameProject, type RenameProjectDeps } from './rename-project';

function deps(overrides: Partial<RenameProjectDeps> = {}): RenameProjectDeps {
  return {
    promptForName: vi.fn().mockResolvedValue('Lab Notebook'),
    rename: vi.fn().mockResolvedValue(1),
    renameMountedFolder: vi.fn(),
    refreshLibrary: vi.fn().mockResolvedValue(undefined),
    toast: vi.fn(),
    ...overrides,
  };
}

const input = { repoPath: '/managed/a/repo', currentName: 'My Project' };

describe('renameProject', () => {
  it('renames the row, then the mounted folder label, then refreshes the library', async () => {
    const d = deps();
    await expect(renameProject(input, d)).resolves.toBe('renamed');
    expect(d.rename).toHaveBeenCalledWith('/managed/a/repo', 'Lab Notebook');
    expect(d.renameMountedFolder).toHaveBeenCalledWith('/managed/a/repo', 'Lab Notebook');
    expect(d.refreshLibrary).toHaveBeenCalledTimes(1);
    expect(d.toast).not.toHaveBeenCalled();
  });

  it('does nothing when the prompt is dismissed', async () => {
    const d = deps({ promptForName: vi.fn().mockResolvedValue(null) });
    await expect(renameProject(input, d)).resolves.toBe('cancelled');
    expect(d.rename).not.toHaveBeenCalled();
    expect(d.renameMountedFolder).not.toHaveBeenCalled();
    expect(d.refreshLibrary).not.toHaveBeenCalled();
  });

  it('does nothing when the name is unchanged', async () => {
    const d = deps({ promptForName: vi.fn().mockResolvedValue('My Project') });
    await expect(renameProject(input, d)).resolves.toBe('unchanged');
    expect(d.rename).not.toHaveBeenCalled();
  });

  it('surfaces a rejected rename as an error toast and leaves the folder alone', async () => {
    const d = deps({
      rename: vi
        .fn()
        .mockRejectedValue(
          withUserMessage(new Error('A project name cannot be empty.'), 'validation.compatible.43')
        ),
    });
    await expect(renameProject(input, d)).resolves.toBe('failed');
    expect(d.toast).toHaveBeenCalledWith('A project name cannot be empty.', 'error');
    expect(d.renameMountedFolder).not.toHaveBeenCalled();
    expect(d.refreshLibrary).not.toHaveBeenCalled();
  });

  it('warns when no active managed row matched instead of relabeling the folder', async () => {
    const d = deps({ rename: vi.fn().mockResolvedValue(0) });
    await expect(renameProject(input, d)).resolves.toBe('not-managed');
    expect(d.toast).toHaveBeenCalledWith(
      `Couldn't rename "My Project" — it isn't an active managed project.`,
      'warning'
    );
    expect(d.renameMountedFolder).not.toHaveBeenCalled();
  });
});
