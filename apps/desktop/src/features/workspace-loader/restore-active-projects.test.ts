import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { WorkspaceLibraryEntry } from './workspace-library';
import { restoreActiveProjects, restoreRegisteredActiveProjects } from './restore-active-projects';

function project(
  id: string,
  overrides: Partial<WorkspaceLibraryEntry> = {}
): WorkspaceLibraryEntry {
  return {
    repoUuid: id,
    repoPath: `/managed/${id}/repo`,
    name: `Project ${id}`,
    originPath: null,
    lastOpenedAt: 1,
    archivedAt: null,
    trashedAt: null,
    ...overrides,
  };
}

describe('restoreActiveProjects', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      folders: [],
      expandedPaths: new Set(),
      lastRemovedFolderPath: null,
    });
  });

  it('restores all six active projects without consulting tabs or a current-project preference', () => {
    const projects = Array.from({ length: 6 }, (_, index) => project(String(index)));
    restoreActiveProjects(projects);
    expect(useWorkspaceStore.getState().folders.map((folder) => folder.path)).toEqual(
      projects.map((entry) => entry.repoPath)
    );
  });

  it('preserves distinct projects with duplicate names and does not duplicate existing roots', () => {
    const projects = [project('a', { name: 'Same name' }), project('b', { name: 'Same name' })];
    useWorkspaceStore.getState().addFolder(projects[0].repoPath, projects[0].name);
    restoreActiveProjects(projects);
    restoreActiveProjects(projects);
    expect(useWorkspaceStore.getState().folders.map(({ path, name }) => ({ path, name }))).toEqual(
      projects.map(({ repoPath, name }) => ({ path: repoPath, name }))
    );
  });

  it('never restores archived or trashed projects and leaves sample provisioning to its owner', () => {
    restoreActiveProjects([
      project('active'),
      project('archived', { archivedAt: 1 }),
      project('trashed', { trashedAt: 1 }),
      project('sample', { originPath: '/profile/Sample Workspaces/standard-samples/v5/workspace' }),
    ]);
    expect(useWorkspaceStore.getState().folders.map((folder) => folder.path)).toEqual([
      '/managed/active/repo',
    ]);
  });

  it('keeps missing and inaccessible projects out of automatic native mounts', () => {
    restoreActiveProjects([
      project('missing', { rootState: 'missing' }),
      project('unavailable', { rootState: 'unavailable' }),
    ]);
    restoreRegisteredActiveProjects([
      { path: '/missing', lifecycle: 'active', rootState: 'missing' },
      { path: '/unavailable', lifecycle: 'active', rootState: 'unavailable' },
    ]);
    expect(useWorkspaceStore.getState().folders).toEqual([]);
  });

  it('preserves reference access rather than turning a reference project into a writable project', () => {
    useWorkspaceStore.getState().addFolder('/managed/reference/repo', 'Legacy preference');
    restoreActiveProjects([project('reference', { access: 'reference' })]);
    expect(useWorkspaceStore.getState().folders[0]).toMatchObject({
      path: '/managed/reference/repo',
      name: 'Project reference',
      pinned: true,
    });
    const restoredFolders = useWorkspaceStore.getState().folders;
    restoreActiveProjects([project('reference', { access: 'reference' })]);
    expect(useWorkspaceStore.getState().folders).toBe(restoredFolders);
  });

  it('restores legacy active projects as well as managed projects, excluding archive, trash and helper roots', () => {
    restoreRegisteredActiveProjects([
      { path: '/legacy/project', name: 'Legacy project', lifecycle: 'active', repoUuid: null },
      {
        path: '/managed/project',
        name: 'Managed project',
        lifecycle: 'active',
        repoUuid: 'project',
      },
      {
        path: '/managed/reference',
        name: 'Reference project',
        lifecycle: 'active',
        repoUuid: 'ref',
        pinned: true,
      },
      { path: '/archived', lifecycle: 'archived' },
      { path: '/trashed', lifecycle: 'trashed' },
      { path: '/restoring', lifecycle: 'restoring' },
      { path: '/dev-assets', lifecycle: 'active', pinned: true, repoUuid: null },
    ]);
    expect(
      useWorkspaceStore.getState().folders.map(({ path, pinned }) => ({ path, pinned }))
    ).toEqual([
      { path: '/legacy/project', pinned: undefined },
      { path: '/managed/project', pinned: undefined },
      { path: '/managed/reference', pinned: true },
    ]);
  });
});
