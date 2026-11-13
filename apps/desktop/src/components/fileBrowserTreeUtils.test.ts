import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../hooks/useFileBrowser';
import {
  findParentEntryId,
  flattenVisibleEntries,
  rangeBetweenPaths,
  withPendingArtifacts,
  workspaceRelativePathForPath,
} from './fileBrowserTreeUtils';

const tree: FileEntry[] = [
  {
    kind: 'filesystem',
    entryId: 'filesystem:/workspace/alpha',
    name: 'alpha',
    path: '/workspace/alpha',
    isDirectory: true,
    isBiologyFile: false,
    children: [
      {
        kind: 'filesystem',
        entryId: 'filesystem:/workspace/alpha/nested.txt',
        name: 'nested.txt',
        path: '/workspace/alpha/nested.txt',
        isDirectory: false,
        isBiologyFile: false,
        extension: 'txt',
      },
    ],
  },
  {
    kind: 'filesystem',
    entryId: 'filesystem:/workspace/root.gb',
    name: 'root.gb',
    path: '/workspace/root.gb',
    isDirectory: false,
    isBiologyFile: true,
    extension: 'gb',
  },
];

describe('fileBrowserTreeUtils', () => {
  it('flattens only visible expanded descendants in tree order', () => {
    expect(flattenVisibleEntries(tree, new Set()).map((entry) => entry.entryId)).toEqual([
      'filesystem:/workspace/alpha',
      'filesystem:/workspace/root.gb',
    ]);

    expect(
      flattenVisibleEntries(tree, new Set(['/workspace/alpha'])).map((entry) => entry.entryId)
    ).toEqual([
      'filesystem:/workspace/alpha',
      'filesystem:/workspace/alpha/nested.txt',
      'filesystem:/workspace/root.gb',
    ]);
  });

  it('finds parent entry IDs for nested entries', () => {
    expect(findParentEntryId(tree, 'filesystem:/workspace/alpha/nested.txt')).toBe(
      'filesystem:/workspace/alpha'
    );
    expect(findParentEntryId(tree, 'filesystem:/workspace/alpha')).toBeNull();
    expect(findParentEntryId(tree, 'filesystem:/workspace/missing.txt')).toBeNull();
  });

  it('returns contiguous ranges in either direction', () => {
    const paths = ['a', 'b', 'c', 'd'];
    expect(rangeBetweenPaths(paths, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeBetweenPaths(paths, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeBetweenPaths(paths, 'missing', 'c')).toEqual(['c']);
  });

  it('computes real paths relative to the matched workspace root', () => {
    expect(
      workspaceRelativePathForPath(
        [{ path: '/workspace', name: 'Workspace', addedAt: 1 }],
        '/workspace/alpha/nested.txt'
      )
    ).toBe('alpha/nested.txt');

    expect(
      workspaceRelativePathForPath(
        [
          { path: '/workspace', name: 'Workspace', addedAt: 1 },
          { path: '/workspace/alpha', name: 'Alpha', addedAt: 2 },
        ],
        '/workspace/alpha/nested.txt'
      )
    ).toBe('nested.txt');

    expect(
      workspaceRelativePathForPath(
        [
          { path: '/workspace/project', name: 'Project', addedAt: 1 },
          { path: '/workspace/dev-assets', name: 'Dev Assets', addedAt: 2, pinned: true },
        ],
        '/workspace/dev-assets/sequences/local/pUC19.gb'
      )
    ).toBe('sequences/local/pUC19.gb');

    expect(
      workspaceRelativePathForPath(
        [{ path: '/workspace', name: 'Workspace', addedAt: 1 }],
        '/workspace'
      )
    ).toBe('.');

    expect(
      workspaceRelativePathForPath(
        [{ path: '/workspace', name: 'Workspace', addedAt: 1 }],
        '/elsewhere/file.txt'
      )
    ).toBeNull();
  });

  it('computes workspace-relative paths for Windows backslash drive paths', () => {
    expect(
      workspaceRelativePathForPath(
        [{ path: 'C:\\Users\\user\\project', name: 'Project', addedAt: 1 }],
        'C:\\Users\\user\\project\\seq.gb'
      )
    ).toBe('seq.gb');

    expect(
      workspaceRelativePathForPath(
        [{ path: 'C:\\Users\\user\\project', name: 'Project', addedAt: 1 }],
        'C:\\Users\\user\\project\\subdir\\seq.gb'
      )
    ).toBe('subdir/seq.gb');

    expect(
      workspaceRelativePathForPath([{ path: 'C:\\ws', name: 'ws', addedAt: 1 }], 'c:\\ws')
    ).toBe('.');

    expect(
      workspaceRelativePathForPath(
        [{ path: 'C:\\ws', name: 'ws', addedAt: 1 }],
        'D:\\other\\seq.gb'
      )
    ).toBeNull();
  });

  it('injects pending artifact rows under their target parent', () => {
    const withPending = withPendingArtifacts(tree, '/workspace', [
      {
        id: 'pending-1',
        kind: 'assembly',
        parentPath: '/workspace/alpha',
        path: '/workspace/alpha/Untitled.wpdesign.json',
        fileName: 'Untitled.wpdesign.json',
        workspaceRoot: '/workspace',
        context: { parentPath: '/workspace/alpha', workspaceRoot: '/workspace' },
      },
    ]);

    expect(withPending[0]?.children?.map((entry) => entry.path)).toEqual([
      '/workspace/alpha/nested.txt',
      '/workspace/alpha/Untitled.wpdesign.json',
    ]);
    expect(withPending[0]?.children?.[1]).toMatchObject({
      extension: 'json',
      isPending: true,
      isDirectory: false,
    });
  });
});
