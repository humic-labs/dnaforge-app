import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import type { WorkspaceLibraryEntry } from './workspace-library';
import {
  basenameForDisplay,
  deriveMountedWorkspaceProjects,
  deriveWorkspaceProjectForPath,
  formatWorkspaceRelativeTime,
  reconcileManagedWorkspaceFolderNames,
  workspaceLocationDisplayName,
} from './workspace-projects';

vi.mock('../../platform', () => ({
  platform: () => {
    throw new Error('workspace project helper tests must not cross the platform boundary');
  },
}));

const folders: WorkspaceFolder[] = [
  { path: '/managed/a/repo', name: 'Repo folder A', addedAt: 1 },
  { path: '/fixtures', name: 'Test Fixtures', addedAt: 2, pinned: true },
];

const library: WorkspaceLibraryEntry[] = [
  {
    repoUuid: 'uuid-a',
    name: 'Library Project A',
    repoPath: '/managed/a/repo',
    originPath: '/Users/me/origin-a',
    lastOpenedAt: 1_000,
    archivedAt: null,
  },
  {
    repoUuid: 'uuid-b',
    name: 'Library Project B',
    repoPath: '/managed/b/repo',
    originPath: '/Users/me/origin-b',
    lastOpenedAt: 2_000,
    archivedAt: null,
  },
];

describe('workspace project helpers', () => {
  it('does not expose retired workspace compatibility helpers while preserving live project derivation', async () => {
    const workspaceProjectApi = await import('./workspace-projects');
    for (const retiredExport of [
      'shortenWorkspacePath',
      'activeWorkspacePath',
      'deriveActiveWorkspaceProject',
      'formatMountedProjectsTitle',
      'formatMountedProjectsSubtitle',
    ]) {
      expect(workspaceProjectApi).not.toHaveProperty(retiredExport);
    }
    expect(workspaceProjectApi.deriveMountedWorkspaceProjects).toBe(deriveMountedWorkspaceProjects);
  });

  it('derives every mounted root as a project while preserving fixture access', () => {
    const mounted = deriveMountedWorkspaceProjects({
      folders: [
        ...folders,
        { path: '/managed/b/repo', name: 'Repo folder B', addedAt: 3 },
        { path: '/fixtures/extra', name: 'Extra Fixtures', addedAt: 4, pinned: true },
      ],
      libraryEntries: library,
    });

    expect(mounted.map((project) => project.repoPath)).toEqual([
      '/managed/a/repo',
      '/fixtures',
      '/managed/b/repo',
      '/fixtures/extra',
    ]);
    expect(mounted.map((project) => project.name)).toEqual([
      'Library Project A',
      'Test Fixtures',
      'Library Project B',
      'Extra Fixtures',
    ]);
    expect(mounted.map((project) => project.access)).toEqual([
      'writable',
      'reference',
      'writable',
      'reference',
    ]);
  });

  it('derives a project for a specific mounted path without requiring global activity', () => {
    expect(deriveWorkspaceProjectForPath('/managed/b/repo', folders, library)).toMatchObject({
      repoPath: '/managed/b/repo',
      name: 'Library Project B',
      originPath: '/Users/me/origin-b',
    });
  });

  it('repairs managed root labels from path-matched active library rows', () => {
    expect(
      reconcileManagedWorkspaceFolderNames({
        folders: [
          { path: '/managed/caspian-id/repo', name: 'repo', addedAt: 1 },
          { path: '/managed/other-id/repo', name: 'repo', addedAt: 2 },
          { path: '/fixtures', name: 'Fixtures', addedAt: 3, pinned: true },
          { path: '/external/repo', name: 'repo', addedAt: 4 },
        ],
        activeLibraryEntries: [
          {
            repoUuid: 'caspian-id',
            name: 'caspian',
            repoPath: '/managed/caspian-id/repo',
            originPath: null,
            lastOpenedAt: 1,
            archivedAt: null,
            trashedAt: null,
          },
          {
            repoUuid: 'other-id',
            name: 'caspian',
            repoPath: '/managed/other-id/repo',
            originPath: null,
            lastOpenedAt: 2,
            archivedAt: null,
            trashedAt: null,
          },
        ],
      })
    ).toEqual([
      { path: '/managed/caspian-id/repo', name: 'caspian' },
      { path: '/managed/other-id/repo', name: 'caspian' },
    ]);
  });

  it('does not replace labels with blank names or touch pinned and unmanaged roots', () => {
    expect(
      reconcileManagedWorkspaceFolderNames({
        folders: [
          { path: '/managed/blank/repo', name: 'Local fallback', addedAt: 1 },
          { path: '/managed/pinned/repo', name: 'Pinned reference', addedAt: 2, pinned: true },
          { path: '/external/repo', name: 'External repo', addedAt: 3 },
        ],
        activeLibraryEntries: [
          {
            repoUuid: 'blank',
            name: '   ',
            repoPath: '/managed/blank/repo',
            originPath: null,
            lastOpenedAt: 1,
            archivedAt: null,
            trashedAt: null,
          },
          {
            repoUuid: 'pinned',
            name: 'Managed but pinned',
            repoPath: '/managed/pinned/repo',
            originPath: null,
            lastOpenedAt: 2,
            archivedAt: null,
            trashedAt: null,
          },
        ],
      })
    ).toEqual([]);
  });

  it('ignores archived and trashed rows even if a stale folder remains mounted', () => {
    expect(
      reconcileManagedWorkspaceFolderNames({
        folders: [
          { path: '/managed/archived/repo', name: 'Mounted archive', addedAt: 1 },
          { path: '/managed/trashed/repo', name: 'Mounted trash', addedAt: 2 },
        ],
        activeLibraryEntries: [
          {
            repoUuid: 'archived',
            name: 'Archived canonical name',
            repoPath: '/managed/archived/repo',
            originPath: null,
            lastOpenedAt: 1,
            archivedAt: 100,
            trashedAt: null,
          },
          {
            repoUuid: 'trashed',
            name: 'Trashed canonical name',
            repoPath: '/managed/trashed/repo',
            originPath: null,
            lastOpenedAt: 2,
            archivedAt: null,
            trashedAt: 200,
          },
        ],
      })
    ).toEqual([]);
  });

  it('formats compact relative timestamps', () => {
    expect(formatWorkspaceRelativeTime(10_000, 20_000)).toBe('just now');
    expect(formatWorkspaceRelativeTime(60_000, 5 * 60_000)).toBe('4m ago');
    expect(formatWorkspaceRelativeTime(0, 5 * 60_000)).toBe('not opened yet');
  });

  it('formats historical Unix-second timestamps on the same timeline as milliseconds', () => {
    const now = 1_787_000_060_000;
    expect(formatWorkspaceRelativeTime(1_787_000_000, now)).toBe('1m ago');
    expect(formatWorkspaceRelativeTime(1_787_000_000_000, now)).toBe('1m ago');
  });

  it('extracts display basenames', () => {
    expect(basenameForDisplay('/managed/a/repo')).toBe('repo');
    expect(basenameForDisplay('C:\\Users\\user\\DNAForge\\beta-run')).toBe('beta-run');
  });

  it('shows project-location display names without leaking Windows absolute paths', () => {
    expect(workspaceLocationDisplayName('C:\\Users\\user\\DNAForge\\beta-run')).toBe('beta-run');
    expect(workspaceLocationDisplayName('/Users/me/project-a')).toBe('project-a');
    expect(workspaceLocationDisplayName(null, 'Project A')).toBe('Project A');
  });
});
