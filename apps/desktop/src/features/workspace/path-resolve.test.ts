import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  registerAgentChatFilesRoot,
  resolveMultiRootPath,
  resolveWorkspacePath,
} from './path-resolve';

describe('workspace path resolution', () => {
  it('does not import AI tools, canvas state, or sequence stores', () => {
    const source = readFileSync('src/features/workspace/path-resolve.ts', 'utf8');
    expect(source).not.toMatch(/features\/ai/);
    expect(source).not.toMatch(/canvas\/store/);
    expect(source).not.toMatch(/sequence\/store/);
    expect(source).not.toMatch(/sequence-document-repository/);
  });

  it('resolves a relative path with folder data only', () => {
    expect(resolveWorkspacePath('/home/user/lab', 'notes/readme.txt')).toBe(
      '/home/user/lab/notes/readme.txt'
    );
  });

  it('never chooses a duplicate project name by mount order', () => {
    const folders = [
      { path: '/lab-a', name: 'Lab', addedAt: 0 },
      { path: '/lab-b', name: 'Lab', addedAt: 0 },
    ];
    for (const ordered of [folders, [...folders].reverse()]) {
      expect(() => resolveMultiRootPath(ordered, 'Lab/notes.txt')).toThrow('Could not determine');
      expect(resolveMultiRootPath(ordered, '/lab-b/notes.txt').folder.path).toBe('/lab-b');
    }
  });

  it('accepts files in agent chat folders without treating them as a project', () => {
    const folders = [{ path: '/data/managed/repo', name: 'My Project', addedAt: 0 }];
    registerAgentChatFilesRoot('/data/cli-scratch/chats');
    try {
      expect(resolveMultiRootPath(folders, '/data/cli-scratch/chats/conv-1/hits.fasta')).toEqual({
        folder: { path: '/data/cli-scratch/chats', name: 'Chat files', addedAt: 0 },
        absolutePath: '/data/cli-scratch/chats/conv-1/hits.fasta',
        relativePath: 'conv-1/hits.fasta',
      });
      expect(
        resolveMultiRootPath([], '/data/cli-scratch/chats/conv-1/hits.fasta').folder.name
      ).toBe('Chat files');
      expect(resolveMultiRootPath(folders, '/data/managed/repo/a.gb').folder.name).toBe(
        'My Project'
      );
      expect(() => resolveMultiRootPath(folders, '/data/cli-scratch/other/x.fasta')).toThrow(
        'outside every open project'
      );
    } finally {
      registerAgentChatFilesRoot(null);
    }
    expect(() =>
      resolveMultiRootPath(folders, '/data/cli-scratch/chats/conv-1/hits.fasta')
    ).toThrow('outside every open project');
  });
});
