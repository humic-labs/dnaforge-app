// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { baseNameOf, isValidMoveTarget, parentDirOf, pathIsWithinDir } from './move-target';

describe('parentDirOf', () => {
  it('returns the parent directory', () => {
    expect(parentDirOf('/ws/a/notes.txt')).toBe('/ws/a');
    expect(parentDirOf('/ws/a')).toBe('/ws');
  });
  it('returns / for a top-level path', () => {
    expect(parentDirOf('/ws')).toBe('/');
  });
});

describe('baseNameOf', () => {
  it('returns the final segment', () => {
    expect(baseNameOf('/ws/a/notes.txt')).toBe('notes.txt');
    expect(baseNameOf('/ws/a')).toBe('a');
  });
});

describe('pathIsWithinDir (drop-group membership)', () => {
  it('includes the directory itself', () => {
    expect(pathIsWithinDir('/ws/a', '/ws/a')).toBe(true);
  });
  it('includes direct and nested children', () => {
    expect(pathIsWithinDir('/ws/a/f.txt', '/ws/a')).toBe(true);
    expect(pathIsWithinDir('/ws/a/sub/deep.txt', '/ws/a')).toBe(true);
  });
  it('excludes items outside the directory', () => {
    expect(pathIsWithinDir('/ws/b/f.txt', '/ws/a')).toBe(false);
  });
  it('does not match a sibling whose name is a prefix', () => {
    expect(pathIsWithinDir('/ws/a2/f.txt', '/ws/a')).toBe(false);
  });
});

describe('isValidMoveTarget', () => {
  it('allows moving into a different folder', () => {
    expect(isValidMoveTarget('/ws/a/notes.txt', '/ws/b')).toBe(true);
  });

  it('allows moving a subfolder item back to the project root', () => {
    expect(isValidMoveTarget('/ws/a/notes.txt', '/ws')).toBe(true);
  });

  it('rejects an empty destination', () => {
    expect(isValidMoveTarget('/ws/a/notes.txt', '')).toBe(false);
  });

  it('rejects moving into the source itself', () => {
    expect(isValidMoveTarget('/ws/a', '/ws/a')).toBe(false);
  });

  it('rejects moving into a descendant of the source', () => {
    expect(isValidMoveTarget('/ws/a', '/ws/a/sub')).toBe(false);
  });

  it('rejects a no-op move into the source current parent', () => {
    expect(isValidMoveTarget('/ws/notes.txt', '/ws')).toBe(false);
    expect(isValidMoveTarget('/ws/a/notes.txt', '/ws/a')).toBe(false);
  });

  it('does not false-reject a sibling whose name is a prefix', () => {
    expect(isValidMoveTarget('/ws/a/sub', '/ws/a/sub2')).toBe(true);
  });
});
