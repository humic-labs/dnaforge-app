import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { missingInternalTrackPath, internalTrackFixturePath } from './internal-track-recovery';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('checks a narrowly identified former checkout without renderer workspace access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'old-track-checkout-'));
  roots.push(root);
  const relativePath = 'test-fixtures/indexed/signal.bw';
  const path = join(root, relativePath);
  expect(await missingInternalTrackPath(path, relativePath)).toBe(true);
  await mkdir(join(root, 'test-fixtures/indexed'), { recursive: true });
  await writeFile(path, 'existing scientific data');
  expect(await missingInternalTrackPath(path, relativePath)).toBe(false);
  await expect(missingInternalTrackPath(join(root, 'other.bw'), relativePath)).rejects.toThrow();
  await expect(
    missingInternalTrackPath(`relative/${relativePath}`, relativePath)
  ).rejects.toThrow();
});

it('resolves fixtures from both development and compiled Electron launch directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'track-fixture-root-'));
  roots.push(root);
  await mkdir(join(root, '.git'));
  const relativePath = 'test-fixtures/indexed/signal.bw';
  for (const start of [join(root, 'apps/desktop'), join(root, 'apps/desktop/out/main')]) {
    expect(internalTrackFixturePath([start], relativePath)).toBe(join(root, relativePath));
  }
});
