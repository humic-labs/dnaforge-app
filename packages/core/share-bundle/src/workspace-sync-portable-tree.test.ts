import { describe, expect, it } from 'vitest';
import {
  parseWorkspaceSyncManifest,
  validateWorkspaceSyncManifestTree,
  type WorkspaceSyncManifestV1,
} from './workspace-sync-manifest';

function manifest(paths: string[]): WorkspaceSyncManifestV1 {
  return {
    schemaVersion: 1,
    files: paths.map((path) => ({
      path,
      contentSha256: 'a'.repeat(64),
      sizeBytes: 1,
      contentType: 'application/octet-stream',
    })),
  };
}

describe('new manifest portable-tree admission', () => {
  it.each([
    ['file ancestor', ['a', 'a/b']],
    ['case-folded file ancestor', ['A', 'a/b']],
    ['case-folded implicit directory alias', ['Vector/a.txt', 'vector/nested/b.txt']],
    ['full Unicode implicit directory alias', ['ss/a.txt', 'ß/b.txt']],
    [
      'nested directory spelling alias',
      ['Sequences/Construct/a.gb', 'sequences/construct/extra.txt'],
    ],
    ['Windows device name', ['CON.gb']],
    ['superscript Windows device name', ['COM¹.gb']],
    ['normalization collision', ['é.gb', 'e\u0301.gb']],
    ['full Unicode folding collision', ['ss.gb', 'ß.gb']],
    ['trailing dot', ['notes./a.txt']],
    ['lone surrogate', ['bad\ud800.gb']],
  ])('rejects %s without changing historical reading', (_label, paths) => {
    const value = manifest(paths as string[]);
    expect(validateWorkspaceSyncManifestTree(value)).toMatchObject({ ok: false });
    expect(parseWorkspaceSyncManifest(value)).toMatchObject({ ok: true });
  });

  it('accepts disjoint portable files and preserves Unicode bytes exactly', () => {
    const value = manifest([
      'é.gb',
      'folder/notes.txt',
      'folder/nested/other.txt',
      'a',
      'ab/b.txt',
    ]);
    expect(validateWorkspaceSyncManifestTree(value)).toEqual({ ok: true });
    expect(value.files[0]?.path).toBe('é.gb');
  });

  it('rejects a noncanonical spelling instead of silently relocating it', () => {
    expect(validateWorkspaceSyncManifestTree(manifest(['e\u0301.gb']))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('NFC')]),
    });
  });
});
