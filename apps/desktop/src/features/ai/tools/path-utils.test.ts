import { beforeEach, describe, expect, it } from 'vitest';
import {
  normalizePath,
  resolveWorkspacePath,
  resolveMultiRootPath,
  resolveUniqueOpenTabWorkspaceBasename,
  getUserFolders,
  hasNoUserWorkspace,
} from './path-utils';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resetCanvasStore, setCanvasTabs } from './test-helpers';

describe('hasNoUserWorkspace ', () => {
  it('is true when there are no folders at all', () => {
    expect(hasNoUserWorkspace([])).toBe(true);
  });

  it('is true when only pinned dev folders are mounted (pinned-vs-null asymmetry)', () => {
    const folders: WorkspaceFolder[] = [
      { name: 'Dev Assets', path: '/dev', addedAt: 0, pinned: true },
      { name: 'Test Fixtures', path: '/fix', addedAt: 1, pinned: true },
    ];
    expect(hasNoUserWorkspace(folders)).toBe(true);
  });

  it('is false when a real (non-pinned) user folder is mounted', () => {
    const folders: WorkspaceFolder[] = [
      { name: 'Dev Assets', path: '/dev', addedAt: 0, pinned: true },
      { name: 'Lab Data', path: '/lab', addedAt: 1 },
    ];
    expect(hasNoUserWorkspace(folders)).toBe(false);
  });
});

describe('normalizePath', () => {
  it('resolves . and .. segments', () => {
    expect(normalizePath('/a/b/../c')).toBe('/a/c');
    expect(normalizePath('/a/./b/./c')).toBe('/a/b/c');
    expect(normalizePath('/a/b/c/../../d')).toBe('/a/d');
  });

  it('preserves leading slash for absolute paths', () => {
    expect(normalizePath('/a/b/c')).toBe('/a/b/c');
  });

  it('handles relative paths', () => {
    expect(normalizePath('a/b/../c')).toBe('a/c');
  });

  it('handles empty segments (double slashes)', () => {
    expect(normalizePath('/a//b///c')).toBe('/a/b/c');
  });
});

describe('resolveWorkspacePath', () => {
  const ws = '/home/user/lab';

  it('resolves a simple relative path', () => {
    expect(resolveWorkspacePath(ws, 'data/seq.gb')).toBe('/home/user/lab/data/seq.gb');
  });

  it('resolves paths with benign ..', () => {
    expect(resolveWorkspacePath(ws, 'foo/../bar')).toBe('/home/user/lab/bar');
  });

  it('rejects paths that escape workspace', () => {
    expect(() => resolveWorkspacePath(ws, '../../etc/passwd')).toThrow(/project boundary/i);
    expect(() => resolveWorkspacePath(ws, 'foo/../../etc')).toThrow(/project boundary/i);
  });

  it('rejects absolute paths', () => {
    expect(() => resolveWorkspacePath(ws, '/etc/passwd')).toThrow(/absolute/i);
    expect(() => resolveWorkspacePath(ws, 'C:\\Windows')).toThrow(/absolute/i);
  });

  it('prevents prefix confusion (e.g. /home/user/laboratory)', () => {
    expect(() => resolveWorkspacePath(ws, '../laboratory/evil')).toThrow(/project boundary/i);
  });

  it('rejects deeply nested traversal', () => {
    expect(() => resolveWorkspacePath(ws, 'a/b/c/../../../../etc/shadow')).toThrow(
      /project boundary/i
    );
  });

  it('rejects path that resolves to workspace root exactly', () => {
    expect(resolveWorkspacePath(ws, '.')).toBe('/home/user/lab');
    expect(resolveWorkspacePath(ws, 'foo/..')).toBe('/home/user/lab');
  });

  it('rejects Windows-style absolute paths', () => {
    expect(() => resolveWorkspacePath(ws, 'D:\\data\\file.txt')).toThrow(/absolute/i);
  });
});

describe('resolveMultiRootPath', () => {
  const makeFolder = (name: string, path: string): WorkspaceFolder => ({
    name,
    path,
    addedAt: Date.now(),
  });

  describe('single folder (backward compat)', () => {
    const folders = [makeFolder('Lab Data', '/home/user/lab')];

    it('resolves without prefix', () => {
      const result = resolveMultiRootPath(folders, 'plasmids/pUC19.gb');
      expect(result.folder.name).toBe('Lab Data');
      expect(result.absolutePath).toBe('/home/user/lab/plasmids/pUC19.gb');
      expect(result.relativePath).toBe('plasmids/pUC19.gb');
    });

    it('resolves root path', () => {
      const result = resolveMultiRootPath(folders, '.');
      expect(result.absolutePath).toBe('/home/user/lab');
      expect(result.relativePath).toBe('');
    });

    it('also works with folder name prefix', () => {
      const result = resolveMultiRootPath(folders, 'Lab Data/plasmids/pUC19.gb');
      expect(result.folder.name).toBe('Lab Data');
      expect(result.absolutePath).toBe('/home/user/lab/plasmids/pUC19.gb');
      expect(result.relativePath).toBe('plasmids/pUC19.gb');
    });
  });

  describe('multiple folders', () => {
    const folders = [
      makeFolder('Lab Data', '/home/user/lab'),
      makeFolder('Shared Plasmids', '/shared/plasmids'),
    ];

    it('resolves with folder name prefix', () => {
      const result = resolveMultiRootPath(folders, 'Lab Data/seq.gb');
      expect(result.folder.name).toBe('Lab Data');
      expect(result.absolutePath).toBe('/home/user/lab/seq.gb');
      expect(result.relativePath).toBe('seq.gb');
    });

    it('resolves second folder', () => {
      const result = resolveMultiRootPath(folders, 'Shared Plasmids/pUC19.gb');
      expect(result.folder.name).toBe('Shared Plasmids');
      expect(result.absolutePath).toBe('/shared/plasmids/pUC19.gb');
      expect(result.relativePath).toBe('pUC19.gb');
    });

    it('matches folder name case-insensitively', () => {
      const result = resolveMultiRootPath(folders, 'lab data/seq.gb');
      expect(result.folder.name).toBe('Lab Data');
    });

    it('refuses duplicate project display names instead of selecting the first', () => {
      const duplicateNames = [
        makeFolder('Shared', '/projects/first'),
        makeFolder('Shared', '/projects/second'),
      ];
      expect(() => resolveMultiRootPath(duplicateNames, 'Shared/seq.gb')).toThrow(
        /could not determine/i
      );
    });

    it('resolves folder root (no subpath)', () => {
      const result = resolveMultiRootPath(folders, 'Lab Data');
      expect(result.absolutePath).toBe('/home/user/lab');
      expect(result.relativePath).toBe('');
    });

    it('normalizes an absolute path inside a known workspace to its folder-relative form', () => {
      const result = resolveMultiRootPath(folders, '/shared/plasmids/crispr/pSpCas9/pSpCas9.gb');
      expect(result).toEqual({
        folder: folders[1],
        absolutePath: '/shared/plasmids/crispr/pSpCas9/pSpCas9.gb',
        relativePath: 'crispr/pSpCas9/pSpCas9.gb',
      });
    });

    it('rejects an absolute path outside every known workspace', () => {
      expect(() => resolveMultiRootPath(folders, '/tmp/outside.gb')).toThrow(
        /outside every open project/i
      );
    });

    it('normalizes dot segments before checking an absolute workspace boundary', () => {
      expect(() => resolveMultiRootPath(folders, '/home/user/lab/../../outside.gb')).toThrow(
        /outside every open project/i
      );
    });

    it('throws when path is ambiguous', () => {
      expect(() => resolveMultiRootPath(folders, 'unknown/file.gb')).toThrow(
        /could not determine/i
      );
      expect(() => resolveMultiRootPath(folders, 'unknown/file.gb')).toThrow(/Lab Data/);
      expect(() => resolveMultiRootPath(folders, 'unknown/file.gb')).toThrow(/Shared Plasmids/);
    });

    it('throws for bare filename with multiple folders', () => {
      expect(() => resolveMultiRootPath(folders, 'seq.gb')).toThrow(/could not determine/i);
    });
  });

  it('throws when no folders available', () => {
    expect(() => resolveMultiRootPath([], 'anything')).toThrow(/no project folders/i);
  });

  describe('with pinned dev folders ', () => {
    it('one user folder + pinned dev folders resolves like single-folder', () => {
      const folders: WorkspaceFolder[] = [
        { name: 'workspace', path: '/mock/workspace', addedAt: 0 },
        { name: 'Dev Assets', path: '/dev/assets', addedAt: 1, pinned: true },
        { name: 'Test Fixtures', path: '/dev/fixtures', addedAt: 2, pinned: true },
      ];
      const result = resolveMultiRootPath(folders, 'plasmids/pUC19.gb');
      expect(result.folder.name).toBe('workspace');
      expect(result.absolutePath).toBe('/mock/workspace/plasmids/pUC19.gb');
      expect(result.relativePath).toBe('plasmids/pUC19.gb');
    });

    it('two user folders + pinned dev folders still throws on bare relative path', () => {
      const folders: WorkspaceFolder[] = [
        { name: 'workspace', path: '/mock/workspace', addedAt: 0 },
        { name: 'Lab Data', path: '/home/user/lab', addedAt: 1 },
        { name: 'Dev Assets', path: '/dev/assets', addedAt: 2, pinned: true },
      ];
      expect(() => resolveMultiRootPath(folders, 'seq.gb')).toThrow(/could not determine/i);
    });

    it('error message lists only user folders, not pinned ones', () => {
      const folders: WorkspaceFolder[] = [
        { name: 'workspace', path: '/mock/workspace', addedAt: 0 },
        { name: 'Lab Data', path: '/home/user/lab', addedAt: 1 },
        { name: 'Dev Assets', path: '/dev/assets', addedAt: 2, pinned: true },
      ];
      const err = (() => {
        try {
          resolveMultiRootPath(folders, 'unknown/x.gb');
          return null;
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeTruthy();
      expect(err!.message).toMatch(/"workspace"/);
      expect(err!.message).toMatch(/"Lab Data"/);
      expect(err!.message).not.toMatch(/"Dev Assets"/);
    });

    it('pinned-only set falls back to listing all folders in error', () => {
      const folders: WorkspaceFolder[] = [
        { name: 'Dev Assets', path: '/dev/assets', addedAt: 0, pinned: true },
        { name: 'Test Fixtures', path: '/dev/fixtures', addedAt: 1, pinned: true },
      ];
      expect(() => resolveMultiRootPath(folders, 'unknown/x.gb')).toThrow(
        /"Dev Assets".*"Test Fixtures"|"Test Fixtures".*"Dev Assets"/
      );
    });

    it('explicit folder-name prefix still wins over pinned filter', () => {
      const folders: WorkspaceFolder[] = [
        { name: 'workspace', path: '/mock/workspace', addedAt: 0 },
        { name: 'Dev Assets', path: '/dev/assets', addedAt: 1, pinned: true },
      ];
      const result = resolveMultiRootPath(folders, 'Dev Assets/sample.gb');
      expect(result.folder.name).toBe('Dev Assets');
      expect(result.absolutePath).toBe('/dev/assets/sample.gb');
    });
  });
});

describe('resolveUniqueOpenTabWorkspaceBasename', () => {
  const folders: WorkspaceFolder[] = [
    { name: 'Lab Data', path: '/home/user/lab', addedAt: 1 },
    { name: 'Shared', path: '/shared/plasmids', addedAt: 2 },
    { name: 'Dev Assets', path: '/dev/assets', addedAt: 3, pinned: true },
  ];

  function setOpenFileTabs(paths: string[]): void {
    setCanvasTabs(
      paths.map((entityId, index) => ({
        id: `tab-${index}`,
        type: 'file',
        entityId,
        label: `Sequence ${index}`,
      }))
    );
  }

  beforeEach(() => resetCanvasStore());

  it('resolves one open basename inside a mounted user root', async () => {
    setOpenFileTabs(['/shared/plasmids/pUC19.gb']);

    expect(await resolveUniqueOpenTabWorkspaceBasename(folders, 'pUC19.gb')).toEqual({
      folder: folders[1],
      absolutePath: '/shared/plasmids/pUC19.gb',
      relativePath: 'pUC19.gb',
      documentId: null,
    });
  });

  it('deduplicates two tabs that point to the same exact file', async () => {
    setOpenFileTabs(['/shared/plasmids/pUC19.gb', '/shared/plasmids/pUC19.gb']);

    expect((await resolveUniqueOpenTabWorkspaceBasename(folders, 'pUC19.gb'))?.absolutePath).toBe(
      '/shared/plasmids/pUC19.gb'
    );
  });

  it('does not choose between distinct open files with the same basename', async () => {
    setOpenFileTabs(['/home/user/lab/pUC19.gb', '/shared/plasmids/pUC19.gb']);

    expect(await resolveUniqueOpenTabWorkspaceBasename(folders, 'pUC19.gb')).toBeNull();
  });

  it('ignores open tabs outside user roots or inside pinned roots', async () => {
    setOpenFileTabs(['/outside/pUC19.gb', '/dev/assets/pUC19.gb']);

    expect(await resolveUniqueOpenTabWorkspaceBasename(folders, 'pUC19.gb')).toBeNull();
  });

  it('does not reinterpret a relative path with directories as a basename', async () => {
    setOpenFileTabs(['/shared/plasmids/pUC19.gb']);

    expect(
      await resolveUniqueOpenTabWorkspaceBasename(folders, 'plasmids/pUC19.gb')
    ).toBeNull();
  });
});

describe('getUserFolders ', () => {
  it('returns all folders when none are pinned', () => {
    const folders: WorkspaceFolder[] = [
      { name: 'A', path: '/a', addedAt: 0 },
      { name: 'B', path: '/b', addedAt: 1 },
    ];
    expect(getUserFolders(folders)).toEqual(folders);
  });

  it('filters out pinned folders', () => {
    const folders: WorkspaceFolder[] = [
      { name: 'user', path: '/u', addedAt: 0 },
      { name: 'Dev', path: '/d', addedAt: 1, pinned: true },
    ];
    expect(getUserFolders(folders)).toEqual([folders[0]]);
  });

  it('returns empty array when all folders are pinned', () => {
    const folders: WorkspaceFolder[] = [
      { name: 'Dev', path: '/d', addedAt: 0, pinned: true },
      { name: 'Test', path: '/t', addedAt: 1, pinned: true },
    ];
    expect(getUserFolders(folders)).toEqual([]);
  });
});
