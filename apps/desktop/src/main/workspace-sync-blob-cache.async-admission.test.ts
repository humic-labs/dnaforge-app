// @vitest-environment node
import { createHash } from 'node:crypto';
import { realpathSync, utimesSync, writeFileSync, type Stats } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { captureWorkspaceSyncBlob, workspaceSyncBlobPath } from './workspace-sync-blob-cache';

const copy = vi.hoisted(() => {
  let sources = new Set<string>();
  let signal = () => {};
  let release = () => {};
  let admitted = Promise.resolve();
  let permitted = Promise.resolve();
  let completed = 0;
  return {
    reset(paths: readonly string[]) {
      sources = new Set(paths);
      completed = 0;
      admitted = new Promise<void>((resolve) => {
        signal = resolve;
      });
      permitted = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    applies(source: unknown) {
      return typeof source === 'string' && sources.has(source);
    },
    enter() {
      signal();
    },
    complete() {
      completed++;
    },
    get completed() {
      return completed;
    },
    get admitted() {
      return admitted;
    },
    get permitted() {
      return permitted;
    },
    release() {
      release();
    },
    stop() {
      sources.clear();
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
      if (!copy.applies(args[0])) return actual.copyFileSync(...args);
      copy.enter();
      try {
        return actual.copyFileSync(...args);
      } finally {
        copy.complete();
      }
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      if (!copy.applies(args[0])) return actual.copyFile(...args);
      copy.enter();
      await copy.permitted;
      try {
        return await actual.copyFile(...args);
      } finally {
        copy.complete();
      }
    },
  };
});

type CaptureOutcome =
  | { kind: 'fulfilled'; value: Awaited<ReturnType<typeof captureWorkspaceSyncBlob>> }
  | { kind: 'rejected'; reason: unknown };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fixture(
  run: (context: {
    source: string;
    peer: string;
    cacheRoot: string;
    bytes: Buffer;
    before: Stats;
    outcome: Promise<CaptureOutcome>;
    admitted: () => Promise<void>;
  }) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), 'capture-async-admission-'));
  let outcome: Promise<CaptureOutcome> | undefined;
  try {
    const source = join(root, 'source.bin');
    const peer = join(root, 'peer.txt');
    const cacheRoot = join(root, 'cache');
    const bytes = Buffer.alloc(64, 91);
    await writeFile(source, bytes);
    await writeFile(peer, 'peer work');
    const before = await lstat(source);
    copy.reset([source, realpathSync(source)]);
    outcome = captureWorkspaceSyncBlob(source, {
      cacheRoot,
      maxBytes: bytes.length,
      expectedIdentity: before,
      expectedSha256: digest(bytes),
    }).then(
      (value): CaptureOutcome => ({ kind: 'fulfilled', value }),
      (reason): CaptureOutcome => ({ kind: 'rejected', reason })
    );
    const pending = outcome;
    await run({
      source,
      peer,
      cacheRoot,
      bytes,
      before,
      outcome,
      admitted: async () => {
        const boundary = await Promise.race([
          copy.admitted.then(() => 'admitted'),
          pending.then(() => 'settled'),
        ]);
        expect(boundary, 'SOURCE_COPY_ADMISSION_NOT_OBSERVED').toBe('admitted');
      },
    });
  } finally {
    copy.release();
    if (outcome) await outcome;
    copy.stop();
    await rm(root, { recursive: true, force: true });
  }
}

describe('workspace blob capture copy admission', () => {
  it('allows peer work before an admitted source copy settles while retaining independent bytes', async () => {
    await fixture(async ({ source, peer, cacheRoot, bytes, before, outcome, admitted }) => {
      await admitted();
      let schedulingFailure: unknown;
      try {
        expect(copy.completed, 'SOURCE_COPY_SETTLED_BEFORE_ASYNC_ADMISSION').toBe(0);
        expect(await readFile(peer, 'utf8')).toBe('peer work');
        expect(copy.completed, 'SOURCE_COPY_SETTLED_BEFORE_PEER_WORK').toBe(0);
      } catch (error) {
        schedulingFailure = error;
      } finally {
        copy.release();
      }
      const settled = await outcome;
      if (settled.kind === 'rejected') throw settled.reason;
      expect(settled.value).toEqual({ sha256: digest(bytes), sizeBytes: bytes.length });
      const cached = await workspaceSyncBlobPath(settled.value.sha256, cacheRoot);
      expect(await readFile(cached)).toEqual(bytes);
      const cachedStat = await lstat(cached);
      expect(cachedStat.ino).not.toBe(before.ino);
      expect(await lstat(source)).toMatchObject({
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
      });
      await writeFile(source, Buffer.alloc(bytes.length, 29));
      expect(await readFile(cached)).toEqual(bytes);
      if (schedulingFailure !== undefined) throw schedulingFailure;
    });
  });

  it('rejects a source changed during admitted capture without publishing partial retained bytes', async () => {
    await fixture(async ({ source, cacheRoot, bytes, before, outcome, admitted }) => {
      await admitted();
      writeFileSync(source, Buffer.alloc(bytes.length, 37));
      utimesSync(source, before.atime, new Date(before.mtimeMs + 1000));
      copy.release();
      const settled = await outcome;
      expect(settled.kind).toBe('rejected');
      if (settled.kind !== 'rejected') throw new Error('Changed source was retained.');
      expect(settled.reason).toBeInstanceOf(Error);
      if (!(settled.reason instanceof Error)) throw settled.reason;
      expect(settled.reason.message).toMatch(/changed/i);
      expect(await readdir(cacheRoot)).toEqual([]);
    });
  });
});
