import { afterEach, beforeEach, expect, it } from 'vitest';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PreviewCache, type PreviewCacheKey } from './preview-cache';

let dir: string, roots: { sequence: string; source: string }, now: number;
const a: PreviewCacheKey = `sequence:${'a'.repeat(64)}`;
const b: PreviewCacheKey = `source:${'b'.repeat(64)}`;
const path = (key: PreviewCacheKey) =>
  join(roots[key.startsWith('sequence:') ? 'sequence' : 'source'], key.split(':')[1]);
const open = () => new PreviewCache(roots, join(dir, 'journal.json'), 15, () => now, 20);
async function create(key: PreviewCacheKey) {
  await mkdir(path(key), { recursive: true });
  await writeFile(join(path(key), 'member'), '0123456789');
  if (key.startsWith('sequence:'))
    await writeFile(
      join(path(key), 'quick-look.json'),
      JSON.stringify({ version: 3, sourceContentHash: 'a'.repeat(64), records: [] })
    );
  else {
    await mkdir(join(path(key), '.forge'));
    await writeFile(
      join(path(key), '.forge/source-document.json'),
      JSON.stringify({ schema: 'dnaforge.source-document.v1', packageId: key.split(':')[1] })
    );
  }
}
const exists = (key: PreviewCacheKey) =>
  access(path(key)).then(
    () => true,
    () => false
  );
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'preview-leases-'));
  roots = { sequence: join(dir, 'seq'), source: join(dir, 'source') };
  now = 100;
});
afterEach(() => rm(dir, { recursive: true, force: true }));

it('reclaims a closed generation only after its last live window or acquisition releases it', async () => {
  const cache = open();
  await create(a);
  await cache.run(async () => {
    const claim = await cache.acquire(1, a);
    await cache.sync(1, 'workspace-canvas', [a]);
    await cache.sync(2, 'workspace-canvas', [a]);
    await cache.release(2, claim);
    await cache.sync(1, 'workspace-canvas', []);
    now += 21;
    await cache.sweep(true);
    expect(await exists(a)).toBe(true);
    await cache.sync(2, 'workspace-canvas', []);
    await cache.sweep(true);
    expect(await exists(a)).toBe(true);
    await cache.release(1, claim);
    now += 21;
    await cache.sweep();
    expect(await exists(a)).toBe(false);
  });
});

it('keeps recovered windows and old untracked generations safe during late hydration', async () => {
  const previous = open();
  await create(a);
  await create(b);
  await previous.run(() => previous.sync(1, 'workspace-canvas', [a]));
  now += 1000;
  const restarted = open();
  await restarted.run(async () => {
    await restarted.sweep(true);
    expect(await exists(a)).toBe(true);
    await restarted.sync(9, 'workspace-canvas', []);
    await restarted.sweep(true);
    expect(await exists(a)).toBe(true);
    expect(await exists(b)).toBe(true);
    await restarted.sync(13, 'workspace-canvas', [a]);
    now += 21;
    await restarted.sweep();
    expect(await exists(a)).toBe(true);
    expect(await exists(b)).toBe(false);
  });
});

it('refuses a new generation when protected snapshots occupy the budget', async () => {
  const cache = open();
  await create(a);
  await cache.run(async () => {
    await cache.sync(1, 'workspace-canvas', [a]);
    const before = new Set((await cache.packages()).keys());
    await create(b);
    await expect(cache.admit(b, before)).rejects.toThrow('storage is full');
    expect(await exists(a)).toBe(true);
    expect(await exists(b)).toBe(false);
  });
});

it('hands an old caller’s acquisition to the published tabs and preserves an unrelated directory', async () => {
  const cache = open();
  await create(a);
  await create(b);
  await rm(join(path(b), '.forge/source-document.json'));
  await cache.run(async () => {
    await cache.acquire(1, a, true);
    await cache.sync(1, 'workspace-canvas', [a]);
    await cache.sync(1, 'workspace-canvas', []);
    await cache.sweep();
    now += 21;
    await cache.sweep();
    expect(await exists(a)).toBe(false);
    expect(await exists(b)).toBe(true);
  });
});
