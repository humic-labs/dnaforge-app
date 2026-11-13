import { describe, expect, it } from 'vitest';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import {
  openWorkspaceCount,
  openWorkspaceFolders,
  removalWouldLeaveNoWorkspace,
} from './workspace-existence-guard';

function folder(path: string, opts?: { pinned?: boolean }): WorkspaceFolder {
  return {
    path,
    name: path.split('/').filter(Boolean).pop() ?? path,
    ...(opts?.pinned ? { pinned: true } : {}),
  } as WorkspaceFolder;
}

describe('workspace-existence-guard  always-one-workspace)', () => {
  describe('openWorkspaceFolders / openWorkspaceCount', () => {
    it('counts only non-pinned folders — pinned dev roots never count', () => {
      const folders = [
        folder('/ws/a'),
        folder('/wp-assets', { pinned: true }),
        folder('/test-fixtures', { pinned: true }),
        folder('/ws/b'),
      ];
      expect(openWorkspaceFolders(folders).map((f) => f.path)).toEqual(['/ws/a', '/ws/b']);
      expect(openWorkspaceCount(folders)).toBe(2);
    });

    it('a store holding ONLY pinned dev roots counts as zero open workspaces', () => {
      expect(openWorkspaceCount([folder('/wp-assets', { pinned: true })])).toBe(0);
    });
  });

  describe('removalWouldLeaveNoWorkspace (the removal block)', () => {
    it('BLOCKS removing the sole open workspace', () => {
      expect(removalWouldLeaveNoWorkspace([folder('/ws/only')], '/ws/only')).toBe(true);
    });

    it('ALLOWS removing one workspace when another is open', () => {
      const folders = [folder('/ws/a'), folder('/ws/b')];
      expect(removalWouldLeaveNoWorkspace(folders, '/ws/a')).toBe(false);
      expect(removalWouldLeaveNoWorkspace(folders, '/ws/b')).toBe(false);
    });

    it('the sole workspace is unremovable even when pinned dev roots are also mounted', () => {
      const folders = [folder('/ws/only'), folder('/wp-assets', { pinned: true })];
      expect(removalWouldLeaveNoWorkspace(folders, '/ws/only')).toBe(true);
    });

    it('ALLOWS archiving a non-mounted library workspace while another is open', () => {
      expect(removalWouldLeaveNoWorkspace([folder('/ws/a')], '/ws/not-mounted')).toBe(false);
    });
  });
});
