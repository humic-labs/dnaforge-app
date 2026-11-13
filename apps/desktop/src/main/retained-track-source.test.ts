import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as fsPromises from 'node:fs/promises';
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, copyFile: vi.fn(actual.copyFile) };
});

import { retainTrackSource } from './retained-track-source';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('retains an independent, digest-verified source through removal of the original checkout and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retained-track-'));
  roots.push(root);
  const path = join(root, 'fixture.bw');
  const bytes = Buffer.from('complete track bytes');
  await writeFile(path, bytes);
  const input = {
    path,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const retained = await retainTrackSource(join(root, 'assets'), input);
  await writeFile(path, 'changed original source');
  expect(await readFile(retained)).toEqual(bytes);
  await rm(path);
  expect(await retainTrackSource(join(root, 'assets'), input)).toBe(retained);
  expect(await readFile(retained)).toEqual(bytes);
});

it('rejects truncated and wrong-content sources without publishing partial data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retained-track-'));
  roots.push(root);
  const path = join(root, 'fixture.bw');
  await writeFile(path, 'bad');
  const sha256 = createHash('sha256').update('good').digest('hex');
  for (const sizeBytes of [4, 3]) {
    await expect(
      retainTrackSource(join(root, 'assets'), { path, sizeBytes, sha256 })
    ).rejects.toThrow(/expected/);
    expect(await readdir(join(root, 'assets', sha256))).toEqual([]);
  }
});

it('preserves a destination created by another writer during retention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retained-track-concurrent-'));
  roots.push(root);
  const path = join(root, 'fixture.bw');
  const bytes = Buffer.from('complete track bytes');
  await writeFile(path, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const destination = join(root, 'assets', sha256, 'fixture.bw');
  const originalCopy = (
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  ).copyFile;
  vi.mocked(fsPromises.copyFile).mockImplementationOnce(async (...args) => {
    await originalCopy(...args);
    await writeFile(destination, 'another writer', { flag: 'wx' });
  });
  await expect(
    retainTrackSource(join(root, 'assets'), { path, sha256, sizeBytes: bytes.length })
  ).rejects.toThrow(/expected/);
  expect(await readFile(destination, 'utf8')).toBe('another writer');
  expect(await readFile(path)).toEqual(bytes);
});
