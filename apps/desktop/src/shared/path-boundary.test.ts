// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  findContainingPathBoundary,
  isAbsolutePathLike,
  isPathInsideBoundary,
  isSafeWorkspaceRelativePath,
  normalizePathForBoundary,
  pathIsAtOrUnder,
  pathRelativeToBoundary,
  rebasePath,
  resolveContainingPathBoundary,
  stripTrailingSep,
} from './path-boundary';

describe('path boundary helpers', () => {
  it('treats Windows backslash descendants as inside the selected root', () => {
    expect(
      isPathInsideBoundary(
        'C:\\Users\\test\\AppData\\Roaming\\DNAForge\\managed-workspaces\\abc\\repo',
        'C:\\Users\\test\\AppData\\Roaming\\DNAForge',
        { platform: 'win32' }
      )
    ).toBe(true);
  });

  it('handles mixed Windows separators and drive-letter casing', () => {
    expect(
      isPathInsideBoundary('C:/Users/TEST/Documents/Project/file.gb', 'c:\\users\\test', {
        platform: 'win32',
      })
    ).toBe(true);
  });

  it('does not allow Windows sibling-prefix escapes', () => {
    expect(
      isPathInsideBoundary('C:\\Users\\tester\\Project', 'C:\\Users\\test', {
        platform: 'win32',
      })
    ).toBe(false);
  });

  it('handles Windows drive roots without creating a double-slash boundary', () => {
    expect(isPathInsideBoundary('C:\\Users\\test', 'C:\\', { platform: 'win32' })).toBe(true);
  });

  it('treats UNC share descendants as inside the share root', () => {
    expect(
      isPathInsideBoundary('\\\\server\\share\\folder\\file.gb', '\\\\server\\share', {
        platform: 'win32',
      })
    ).toBe(true);
    expect(
      isPathInsideBoundary('\\\\server\\share-other\\file.gb', '\\\\server\\share', {
        platform: 'win32',
      })
    ).toBe(false);
  });

  it('keeps POSIX boundaries case-sensitive and segment-aware', () => {
    expect(isPathInsideBoundary('/Users/test/project/file.gb', '/Users/test')).toBe(true);
    expect(isPathInsideBoundary('/Users/TEST/project/file.gb', '/Users/test')).toBe(false);
    expect(isPathInsideBoundary('/Users/tester/project', '/Users/test')).toBe(false);
  });

  it('finds the deepest matching workspace root', () => {
    const root = findContainingPathBoundary(
      [
        { path: 'C:\\Users\\test', name: 'home' },
        { path: 'C:\\Users\\test\\Documents\\Lab', name: 'lab' },
      ],
      'C:\\Users\\test\\Documents\\Lab\\pUC19.gb',
      { platform: 'win32' }
    );
    expect(root?.name).toBe('lab');
  });

  it('refuses duplicate mounted roots instead of selecting one by array order', () => {
    const entries = [
      { path: '/lab/project', name: 'first' },
      { path: '/lab/project/', name: 'second' },
    ];

    expect(findContainingPathBoundary(entries, '/lab/project/pUC19.gb')).toBeUndefined();
    expect(
      findContainingPathBoundary([...entries].reverse(), '/lab/project/pUC19.gb')
    ).toBeUndefined();
    expect(resolveContainingPathBoundary(entries, '/lab/project/pUC19.gb')).toEqual({
      status: 'ambiguous',
    });
    expect(resolveContainingPathBoundary(entries, '/outside/pUC19.gb')).toEqual({
      status: 'none',
    });
  });

  it('normalizes only for boundary comparison, not path display', () => {
    expect(normalizePathForBoundary('C:\\Users\\Test\\Project\\', { platform: 'win32' })).toBe(
      'c:/users/test/project'
    );
  });

  it('returns a separator-normalized relative path without requiring same-separator inputs', () => {
    expect(
      pathRelativeToBoundary(
        'C:\\Users\\test\\Documents\\Lab\\sequences\\pUC19.gb',
        'C:/Users/test/Documents/Lab',
        { platform: 'win32' }
      )
    ).toBe('sequences/pUC19.gb');
  });

  it('recognizes both POSIX and Windows absolute paths', () => {
    expect(isAbsolutePathLike('/Users/test/project')).toBe(true);
    expect(isAbsolutePathLike('C:\\Users\\test\\project')).toBe(true);
    expect(isAbsolutePathLike('C:/Users/test/project')).toBe(true);
    expect(isAbsolutePathLike('sequences/pUC19.gb')).toBe(false);
  });

  describe('isSafeWorkspaceRelativePath', () => {
    it('accepts a plain relative path', () => {
      expect(isSafeWorkspaceRelativePath('proteins/gfp-abc123.faa')).toBe(true);
    });

    it('rejects an absolute path', () => {
      expect(isSafeWorkspaceRelativePath('/etc/passwd')).toBe(false);
      expect(isSafeWorkspaceRelativePath('C:\\Windows\\system32')).toBe(false);
    });

    it('rejects a path with a traversal segment', () => {
      expect(isSafeWorkspaceRelativePath('../outside.faa')).toBe(false);
      expect(isSafeWorkspaceRelativePath('proteins/../../outside.faa')).toBe(false);
    });

    it('rejects an empty path', () => {
      expect(isSafeWorkspaceRelativePath('')).toBe(false);
    });
  });
});

describe('pathIsAtOrUnder', () => {
  it('is the boundary predicate (root itself + descendants, separator/case-aware)', () => {
    expect(pathIsAtOrUnder('/a/b', '/a')).toBe(true);
    expect(pathIsAtOrUnder('/a', '/a')).toBe(true);
    expect(pathIsAtOrUnder('/ab/c', '/a')).toBe(false);
    expect(pathIsAtOrUnder('C:\\a\\b', 'C:\\a')).toBe(true);
  });
});

describe('rebasePath', () => {
  it('rebases the root itself onto the new root', () => {
    expect(rebasePath('/old/dir', '/old/dir', '/new/dir')).toBe('/new/dir');
  });

  it('rebases a descendant by a raw byte slice of the tail', () => {
    expect(rebasePath('/old/dir/sub/x.gb', '/old/dir', '/new/dir')).toBe('/new/dir/sub/x.gb');
    expect(rebasePath('/w/a.gb', '/w/a.gb', '/w/b.gb')).toBe('/w/b.gb');
  });

  it('slices by oldRoot byte-length, preserving the descendant tail verbatim (incl. case)', () => {
    expect(rebasePath('/old/SUB/File.GB', '/old', '/new')).toBe('/new/SUB/File.GB');
  });
});

describe('stripTrailingSep', () => {
  it('strips trailing separators but never empties a root', () => {
    expect(stripTrailingSep('/a/b/')).toBe('/a/b');
    expect(stripTrailingSep('/a/b')).toBe('/a/b');
    expect(stripTrailingSep('C:\\a\\')).toBe('C:\\a');
    expect(stripTrailingSep('/')).toBe('/');
  });
});
