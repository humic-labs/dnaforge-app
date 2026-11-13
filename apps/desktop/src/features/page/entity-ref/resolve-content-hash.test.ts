// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { needsRehash, resolveReferenceContentHash } from './resolve-content-hash';

describe('needsRehash', () => {
  it('is true for a git: oid', () => {
    expect(needsRehash('git:9d2197d79abc')).toBe(true);
  });

  it('is true for a missing hash', () => {
    expect(needsRehash(null)).toBe(true);
    expect(needsRehash('')).toBe(true);
  });

  it('is true for an unprefixed value, which names no namespace', () => {
    expect(needsRehash('a'.repeat(64))).toBe(true);
  });

  it('is false for a real sha256 value', () => {
    expect(needsRehash(`sha256:${'a'.repeat(64)}`)).toBe(false);
  });

  it('re-hashes a malformed value that only has the sha256 prefix', () => {
    expect(needsRehash('sha256:not-a-digest')).toBe(true);
  });
});

describe('resolveReferenceContentHash', () => {
  it('re-hashes through main when the catalog carries a git: oid', async () => {
    const contentHash = vi.fn().mockResolvedValue(`sha256:${'b'.repeat(64)}`);

    const result = await resolveReferenceContentHash({
      catalogHash: 'git:deadbeef',
      workspaceRoot: '/ws/beta',
      workspaceRelativePath: 'a/b.gb',
      contentHash,
    });

    expect(contentHash).toHaveBeenCalledWith({
      workspaceRoot: '/ws/beta',
      workspaceRelativePath: 'a/b.gb',
    });
    expect(result).toBe(`sha256:${'b'.repeat(64)}`);
  });

  it('passes a usable sha256 through without touching main', async () => {
    const contentHash = vi.fn();
    const existing = `sha256:${'c'.repeat(64)}`;

    const result = await resolveReferenceContentHash({
      catalogHash: existing,
      workspaceRoot: '/ws/beta',
      workspaceRelativePath: 'a/b.gb',
      contentHash,
    });

    expect(contentHash).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });

  it('returns null rather than a WRONG hash when re-hashing fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const contentHash = vi.fn().mockRejectedValue(new Error('file vanished'));

    const result = await resolveReferenceContentHash({
      catalogHash: 'git:deadbeef',
      workspaceRoot: '/ws/beta',
      workspaceRelativePath: 'a/b.gb',
      contentHash,
    });

    expect(result).toBeNull();
    error.mockRestore();
  });

  it('never returns the git: value it was given', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await resolveReferenceContentHash({
      catalogHash: 'git:deadbeef',
      workspaceRoot: '/ws/beta',
      workspaceRelativePath: 'a/b.gb',
      contentHash: vi.fn().mockRejectedValue(new Error('nope')),
    });

    expect(result === null || !result.startsWith('git:')).toBe(true);
    expect(result).toBeNull();
    error.mockRestore();
  });

  it('returns null when there is no owning root to hash against', async () => {
    const contentHash = vi.fn();

    const result = await resolveReferenceContentHash({
      catalogHash: null,
      workspaceRoot: null,
      workspaceRelativePath: 'a/b.gb',
      contentHash,
    });

    expect(contentHash).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('rejects a main response that is not sha256-namespaced', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const contentHash = vi.fn().mockResolvedValue('deadbeef');

    const result = await resolveReferenceContentHash({
      catalogHash: null,
      workspaceRoot: '/ws/beta',
      workspaceRelativePath: 'a/b.gb',
      contentHash,
    });

    expect(result).toBeNull();
    error.mockRestore();
  });

  it('rejects a malformed main response that merely has the sha256 prefix', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await resolveReferenceContentHash({
      catalogHash: null,
      workspaceRoot: '/ws/beta',
      workspaceRelativePath: 'a/b.gb',
      contentHash: vi.fn().mockResolvedValue('sha256:short'),
    });

    expect(result).toBeNull();
    error.mockRestore();
  });
});
