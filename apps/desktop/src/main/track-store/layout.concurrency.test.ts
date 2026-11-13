import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  readFile: mocks.readFile,
}));
import { listTracks } from './layout';

it('lists tracks with four concurrent readers, stable ordering and per-track errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'track-concurrency-'));
  const accession = 'NC_000913.3';
  const tracks = Array.from({ length: 9 }, (_, i) => `track-${i}`);
  const releases = new Map<string, () => void>();
  mocks.readFile.mockImplementation(
    (path: string) =>
      new Promise<string>((resolve) => {
        releases.set(path, () => resolve('invalid json'));
      })
  );
  try {
    await Promise.all(
      tracks.map((track) => mkdir(join(root, accession, track), { recursive: true }))
    );
    const listing = listTracks(root, accession);
    await vi.waitFor(() => expect(releases.size).toBe(4));
    for (const release of [...releases.values()].reverse()) release();
    await vi.waitFor(() => expect(releases.size).toBe(8));
    for (const release of releases.values()) release();
    await vi.waitFor(() => expect(releases.size).toBe(9));
    for (const release of releases.values()) release();
    const result = await listing;
    expect(result.map((track) => track.track)).toEqual(tracks);
    expect(
      result.every(
        (track) => track.current === null && track.meta === null && track.problems.length === 1
      )
    ).toBe(true);
  } finally {
    for (const release of releases.values()) release();
    await rm(root, { recursive: true, force: true });
  }
});
