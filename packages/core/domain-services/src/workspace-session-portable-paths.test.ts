import { describe, expect, it } from 'vitest';
import {
  mergeWorkspaceSessionFiles,
  type WorkspaceSessionFileReplacement,
} from './workspace-sessions';

function file(path: string): WorkspaceSessionFileReplacement {
  return {
    path,
    resourceId: null,
    contentRevision: 'revision-one',
    contentSha256: 'a'.repeat(64),
    sizeBytes: 1,
    contentType: 'text/plain',
  };
}

describe('workspace session portable file tree', () => {
  it.each([
    ['a', 'a/child.txt'],
    ['A', 'a/child.txt'],
    ['Folder/one.txt', 'folder/two.txt'],
    ['ss/one.txt', 'ß/two.txt'],
    ['CON'],
    ['COM¹.txt'],
    ['C:drive.txt'],
    ['folder/notes.'],
    ['bad\u0001.txt'],
  ])('rejects an unmaterializable tree %j', (...paths: string[]) => {
    expect(() => mergeWorkspaceSessionFiles([], paths.map(file))).toThrow();
  });
  it('preserves valid Unicode paths, ordinary assets and a sibling prefix', () => {
    const paths = ['a', 'ab/child.txt', 'Lab notes/assets/figure.png', 'é.txt'];
    const merged = mergeWorkspaceSessionFiles([], paths.map(file));
    expect(merged.map((entry) => entry.path).sort()).toEqual([...paths].sort());
  });
  it('permits replacement after explicitly removing a file ancestor', () => {
    expect(
      mergeWorkspaceSessionFiles([{ ...file('a'), resourceId: null }], [file('a/child.txt')], {
        removePaths: ['a'],
      }).map((entry) => entry.path)
    ).toEqual(['a/child.txt']);
  });
});
