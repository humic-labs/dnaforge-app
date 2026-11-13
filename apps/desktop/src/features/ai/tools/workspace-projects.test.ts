import { beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceLibraryEntry } from '../../workspace-loader/public/workspace-library';
import { createWorkspaceProjectsTool } from './workspace-projects';

const control = vi.hoisted(() => ({
  listWorkspaceLibrary: vi.fn(),
  restoreWorkspace: vi.fn(),
  restoreFromTrash: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('../../workspace-loader/public/workspace-project-control', () => ({
  getWorkspaceProjectControl: () => ({ refresh: control.refresh }),
  listWorkspaceLibrary: control.listWorkspaceLibrary,
  archiveWorkspaceByPath: vi.fn(),
  trashWorkspaceByPath: vi.fn(),
  renameWorkspaceByPath: vi.fn(),
  restoreWorkspace: control.restoreWorkspace,
  restoreFromTrash: control.restoreFromTrash,
  renameProject: vi.fn(),
  removalWouldLeaveNoWorkspace: () => false,
}));

const untracked: WorkspaceLibraryEntry = {
  repoUuid: null,
  name: 'Untracked lab notes',
  repoPath: '/projects/untracked-lab-notes',
  originPath: null,
  lastOpenedAt: null,
  archivedAt: 1,
  trashedAt: null,
};

beforeEach(() => {
  control.listWorkspaceLibrary.mockResolvedValue({
    active: [],
    archived: [untracked],
    trashed: [],
  });
  control.restoreWorkspace.mockReset().mockResolvedValue(1);
  control.restoreFromTrash.mockReset().mockResolvedValue(1);
  control.refresh.mockReset().mockResolvedValue(undefined);
});

async function run(operation: Record<string, unknown>) {
  return (await createWorkspaceProjectsTool().execute!({ operation } as never, {
    toolCallId: 'projects',
    messages: [],
  })) as Record<string, unknown>;
}

it('lists and restores an archived project that has no Git tracking by its folder', async () => {
  const listed = await run({ kind: 'list', offset: 0, limit: 25 });
  const [project] = (listed.projects ?? []) as Array<{ projectId: string; revision: string }>;
  expect(project.projectId).toBe(untracked.repoPath);

  const restored = await run({
    kind: 'restore',
    projectId: project.projectId,
    expectedRevision: project.revision,
  });

  expect(restored).toMatchObject({ applied: true, operation: 'restore' });
  expect(control.restoreWorkspace).toHaveBeenCalledWith(untracked);
  expect(control.restoreFromTrash).not.toHaveBeenCalled();
});
