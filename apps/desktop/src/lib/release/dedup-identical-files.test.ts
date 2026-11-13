// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { dedupToCanonical, countIdenticalCopies, countLargeRegularCopies, directorySizeBytes } =
  require('../../../scripts/lib/dedup-identical-files.cjs') as {
    dedupToCanonical: (
      dir: string,
      canonicalName: string
    ) => {
      deduped: number;
      bytesSaved: number;
      canonicalHash: string | null;
      alreadySymlinked: number;
      skipped: number;
    };
    countIdenticalCopies: (dir: string, canonicalName: string) => number;
    countLargeRegularCopies: (dir: string, canonicalName: string, tolerance?: number) => number;
    directorySizeBytes: (dir: string) => number;
  };

const CANON = 'git';
const CANON_BYTES = Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 7 + 13) % 256));
const DISTINCT_SAME_SIZE = Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 11 + 29) % 256));

let dir: string;

function lstat(p: string): fs.Stats {
  return fs.lstatSync(p);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('dedupToCanonical (symlink dedup)', () => {
  it('replaces every byte-identical copy with a relative symlink to the canonical and leaves distinct files alone', () => {
    fs.writeFileSync(path.join(dir, CANON), CANON_BYTES, { mode: 0o755 });
    for (const name of ['git-version', 'git-worktree', 'git-status']) {
      fs.writeFileSync(path.join(dir, name), CANON_BYTES, { mode: 0o755 });
    }
    fs.writeFileSync(path.join(dir, 'git-lfs'), DISTINCT_SAME_SIZE, { mode: 0o755 });

    expect(countIdenticalCopies(dir, CANON)).toBe(3);

    const result = dedupToCanonical(dir, CANON);

    expect(result.deduped).toBe(3);
    expect(result.bytesSaved).toBe(3 * CANON_BYTES.length);
    expect(result.canonicalHash).toMatch(/^[0-9a-f]{64}$/);

    expect(lstat(path.join(dir, CANON)).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(dir, CANON)).equals(CANON_BYTES)).toBe(true);

    for (const name of ['git-version', 'git-worktree', 'git-status']) {
      const st = lstat(path.join(dir, name));
      expect(st.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(path.join(dir, name))).toBe(CANON);
      expect(fs.readFileSync(path.join(dir, name)).equals(CANON_BYTES)).toBe(true);
    }

    expect(lstat(path.join(dir, 'git-lfs')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'git-lfs')).equals(DISTINCT_SAME_SIZE)).toBe(true);

    expect(countIdenticalCopies(dir, CANON)).toBe(0);
  });

  it('never touches pre-existing symlinks', () => {
    fs.writeFileSync(path.join(dir, CANON), CANON_BYTES, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'git-copy'), CANON_BYTES, { mode: 0o755 });
    fs.symlinkSync('somewhere-else', path.join(dir, 'git-alien'));

    const result = dedupToCanonical(dir, CANON);

    expect(result.deduped).toBe(1);
    expect(fs.readlinkSync(path.join(dir, 'git-alien'))).toBe('somewhere-else');
  });

  it('is idempotent — a second run dedups nothing and reports files already symlinked', () => {
    fs.writeFileSync(path.join(dir, CANON), CANON_BYTES, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'git-version'), CANON_BYTES, { mode: 0o755 });

    const first = dedupToCanonical(dir, CANON);
    expect(first.deduped).toBe(1);

    const second = dedupToCanonical(dir, CANON);
    expect(second.deduped).toBe(0);
    expect(second.bytesSaved).toBe(0);
    expect(second.alreadySymlinked).toBe(1);
  });

  it('returns a no-op result (does not throw) when the canonical file is absent', () => {
    fs.writeFileSync(path.join(dir, 'git-version'), CANON_BYTES);
    const result = dedupToCanonical(dir, CANON);
    expect(result.deduped).toBe(0);
    expect(result.canonicalHash).toBeNull();
  });

  it('shrinks the directory footprint: the deduped copies no longer occupy their own bytes', () => {
    fs.writeFileSync(path.join(dir, CANON), CANON_BYTES);
    for (const name of ['a', 'b', 'c', 'd']) {
      fs.writeFileSync(path.join(dir, name), CANON_BYTES);
    }
    const before = directorySizeBytes(dir);
    dedupToCanonical(dir, CANON);
    const after = directorySizeBytes(dir);
    expect(after).toBeLessThan(before / 2);
  });
});

describe('countLargeRegularCopies (signing-agnostic re-bloat metric)', () => {
  it('counts regular files within the size tolerance and ignores symlinks and small/large files', () => {
    fs.writeFileSync(path.join(dir, CANON), CANON_BYTES);
    fs.writeFileSync(path.join(dir, 'near-same-size'), Buffer.alloc(8192 - 100, 1));
    fs.writeFileSync(path.join(dir, 'way-bigger'), Buffer.alloc(8192 * 4, 1));
    fs.writeFileSync(path.join(dir, 'tiny'), Buffer.alloc(10, 1));
    fs.symlinkSync(CANON, path.join(dir, 'a-symlink'));

    expect(countLargeRegularCopies(dir, CANON, 0.1)).toBe(1);
  });

  it('drops to 0 once identical copies are replaced by symlinks (survives even if bytes had diverged)', () => {
    fs.writeFileSync(path.join(dir, CANON), CANON_BYTES);
    for (const name of ['git-version', 'git-worktree']) {
      fs.writeFileSync(path.join(dir, name), CANON_BYTES);
    }
    expect(countLargeRegularCopies(dir, CANON)).toBe(2);
    dedupToCanonical(dir, CANON);
    expect(countLargeRegularCopies(dir, CANON)).toBe(0);
  });
});
