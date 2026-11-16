import { mkdtemp, mkdir, writeFile, stat, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ReferenceGenerationRetention } from './reference-generation-retention';
import { createReferenceGenerationId } from './reference-generation-ownership';
import { parseReferenceAssetPublicationV1 } from '../../features/sequence/reference-asset-publication';

describe('superseded reference generations', () => {
  it('retains the currently cataloged portable bundle while another profile hydrates it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reference-retention-catalog-'));
    const currentBundle = 'b'.repeat(64);
    const obsoleteBundle = 'a'.repeat(64);
    const family = join(root, 'grch38');
    const retention = new ReferenceGenerationRetention({
      cacheRoot: root,
      publicationRoots: [root],
      catalogIds: [],
      pinnedVersions: [{ catalogId: 'grch38', generationId: currentBundle }],
      sessionPaths: () => [],
    });
    try {
      await writeCurrent(root);
      await mkdir(join(family, '.reference-version-history'), { recursive: true });
      for (const generation of [currentBundle, obsoleteBundle]) {
        await mkdir(join(family, 'generations', generation), { recursive: true });
        await writeFile(
          join(family, '.reference-version-history', `${generation}.json`),
          versionHistory(generation)
        );
      }
      await retention.setRendererVersions(1, []);
      const leaseDirectory = join(root, '.reference-generation-leases');
      const leaseFile = (await readdir(leaseDirectory)).find((name) => name.endsWith('.json'));
      expect(leaseFile).toBeDefined();
      const lease = JSON.parse(await readFile(join(leaseDirectory, leaseFile!), 'utf8')) as {
        versions: Array<{ catalogId: string; generationId: string }>;
      };
      expect(lease.versions).toContainEqual({ catalogId: 'grch38', generationId: currentBundle });
      await retention.collect();
      expect((await stat(join(family, 'generations', currentBundle))).isDirectory()).toBe(true);
      await expect(stat(join(family, 'generations', obsoleteBundle))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await retention.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains pending opens and preparation until their readers release the old version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reference-retention-pending-'));
    const generation = 'a'.repeat(64);
    const family = join(root, 'grch38');
    const generationRoot = join(family, 'generations', generation);
    const version = { catalogId: 'grch38', generationId: generation };
    const retention = new ReferenceGenerationRetention({
      cacheRoot: root,
      publicationRoots: [root],
      catalogIds: ['grch38'],
      sessionPaths: () => [],
    });
    try {
      await writeCurrent(root);
      await mkdir(generationRoot, { recursive: true });
      await mkdir(join(family, '.reference-version-history'), { recursive: true });
      await writeFile(
        join(family, '.reference-version-history', `${generation}.json`),
        versionHistory(generation)
      );
      await retention.pinOpening(1, version);
      await retention.setRendererVersions(1, []);
      await retention.collect();
      expect((await stat(generationRoot)).isDirectory()).toBe(true);

      await retention.setRendererVersions(1, [version]);
      const releasePreparation = await retention.retainPreparation(generationRoot);
      await retention.setRendererVersions(1, []);
      await retention.collect();
      expect((await stat(generationRoot)).isDirectory()).toBe(true);

      releasePreparation();
      await retention.collect();
      await expect(stat(generationRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await retention.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps current, open-tab, and session versions, then collects the released version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reference-retention-'));
    const old = 'a'.repeat(64),
      current = 'b'.repeat(64);
    const family = join(root, 'grch38');
    const oldRoot = join(family, 'generations', old);
    const currentRoot = join(family, 'generations', current);
    let sessionPaths: string[] = [];
    const retention = new ReferenceGenerationRetention({
      cacheRoot: root,
      publicationRoots: [root],
      catalogIds: ['grch38'],
      sessionPaths: () => sessionPaths,
    });
    try {
      await writeCurrent(root, current);
      await mkdir(oldRoot, { recursive: true });
      await mkdir(currentRoot, { recursive: true });
      await mkdir(join(family, '.reference-version-history'), { recursive: true });
      await writeFile(
        join(family, '.reference-version-history', `${old}.json`),
        versionHistory(old)
      );
      await writeFile(
        join(family, 'current-reference-assets.v1.json'),
        JSON.stringify({
          contract: 'reference-asset-publication.v1',
          assetCacheKey: 'grch38',
          publicationId: current,
          sourceMaterializationFingerprint: 'c'.repeat(64),
          publishedAtMs: 1,
        })
      );
      await retention.setRendererVersions(7, [{ catalogId: 'grch38', generationId: old }]);
      await retention.collect();
      expect((await stat(oldRoot)).isDirectory()).toBe(true);
      sessionPaths = [join(oldRoot, 'prepared/chr1/chr1.fa')];
      await retention.setRendererVersions(7, []);
      await retention.collect();
      expect((await stat(oldRoot)).isDirectory()).toBe(true);
      sessionPaths = [];
      await retention.collect();
      await expect(stat(oldRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(currentRoot)).isDirectory()).toBe(true);
    } finally {
      await retention.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('honors another live process lease and ignores dead-process leases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reference-retention-process-'));
    const generation = 'a'.repeat(64);
    const path = join(root, 'grch38', 'generations', generation);
    const retention = new ReferenceGenerationRetention({
      cacheRoot: root,
      publicationRoots: [root],
      catalogIds: ['grch38'],
      sessionPaths: () => [],
    });
    try {
      await writeCurrent(root);
      await mkdir(path, { recursive: true });
      await mkdir(join(root, 'grch38/.reference-version-history'), { recursive: true });
      await writeFile(
        join(root, 'grch38/.reference-version-history', `${generation}.json`),
        versionHistory(generation)
      );
      const leaseDir = join(root, '.reference-generation-leases');
      await mkdir(leaseDir, { recursive: true });
      const lease = join(leaseDir, 'other.json');
      await writeFile(
        lease,
        JSON.stringify({
          pid: process.pid,
          versions: [{ catalogId: 'grch38', generationId: generation }],
        })
      );
      await retention.setRendererVersions(1, []);
      await retention.collect();
      expect((await stat(path)).isDirectory()).toBe(true);
      await writeFile(
        lease,
        JSON.stringify({
          pid: 2147483647,
          versions: [{ catalogId: 'grch38', generationId: generation }],
        })
      );
      await retention.collect();
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await retention.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('waits for canvas restoration and leaves generations without collection ownership alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reference-retention-startup-'));
    const legacy = '00000000-0000-4000-8000-000000000001';
    const staging = 'd'.repeat(64);
    const generationRoot = (id: string) => join(root, 'grch38', 'generations', id);
    const retention = new ReferenceGenerationRetention({
      cacheRoot: root,
      publicationRoots: [root],
      catalogIds: ['grch38'],
      sessionPaths: () => [],
    });
    try {
      await writeCurrent(root);
      for (const id of [legacy, staging]) {
        await mkdir(generationRoot(id), { recursive: true });
        await writeFile(join(generationRoot(id), 'prepared-reference-definition.v1.json'), '{}');
      }
      expect(await retention.collect()).toEqual([]);
      expect((await stat(generationRoot(legacy))).isDirectory()).toBe(true);
      await retention.setRendererVersions(1, []);
      await retention.collect();
      expect((await stat(generationRoot(legacy))).isDirectory()).toBe(true);
      expect((await stat(generationRoot(staging))).isDirectory()).toBe(true);
    } finally {
      await retention.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves another stopped profile current generation without a live reader lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reference-retention-stopped-profile-'));
    const cache = join(root, 'cache');
    const publicationRoot = join(root, 'profile-publications');
    const generation = '00000000-0000-4000-8000-000000000519';
    const generationRoot = join(cache, 'grch38', 'generations', generation);
    const retention = new ReferenceGenerationRetention({
      cacheRoot: cache,
      publicationRoots: [cache],
      catalogIds: ['grch38'],
      sessionPaths: () => [],
    });
    try {
      await writeCurrent(cache);
      await mkdir(generationRoot, { recursive: true });
      await writeFile(join(generationRoot, 'prepared-reference-definition.v1.json'), '{}');
      await mkdir(join(publicationRoot, 'grch38'), { recursive: true });
      await writeFile(
        join(publicationRoot, 'grch38', 'current-reference-assets.v1.json'),
        JSON.stringify({
          contract: 'reference-asset-publication.v1',
          assetCacheKey: 'grch38',
          publicationId: generation,
          sourceMaterializationFingerprint: 'f'.repeat(64),
          publishedAtMs: 1,
        })
      );
      await retention.setRendererVersions(1, []);
      await retention.collect();
      expect((await stat(generationRoot)).isDirectory()).toBe(true);
    } finally {
      await retention.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not treat a malformed version history as collection ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reference-retention-invalid-history-'));
    const generation = 'e'.repeat(64);
    const generationRoot = join(root, 'grch38', 'generations', generation);
    const retention = new ReferenceGenerationRetention({
      cacheRoot: root,
      publicationRoots: [root],
      catalogIds: ['grch38'],
      sessionPaths: () => [],
    });
    try {
      await writeCurrent(root);
      await mkdir(generationRoot, { recursive: true });
      await mkdir(join(root, 'grch38', '.reference-version-history'), { recursive: true });
      await writeFile(
        join(root, 'grch38', '.reference-version-history', `${generation}.json`),
        '{}'
      );
      await retention.setRendererVersions(1, []);
      await retention.collect();
      expect((await stat(generationRoot)).isDirectory()).toBe(true);
    } finally {
      await retention.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('collects only its own superseded profile generation after the last reader releases it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reference-retention-profile-scope-'));
    const cache = join(root, 'cache');
    const ownedRoot = join(root, 'profile-a');
    const foreignRoot = join(root, 'profile-b');
    const family = join(cache, 'grch38');
    const current = createReferenceGenerationId(join(ownedRoot, 'grch38'));
    const old = createReferenceGenerationId(join(ownedRoot, 'grch38'));
    const foreign = createReferenceGenerationId(join(foreignRoot, 'grch38'));
    const shared = 'a'.repeat(64);
    const generationRoot = (id: string) => join(family, 'generations', id);
    const retention = new ReferenceGenerationRetention({
      cacheRoot: cache,
      ownedPublicationRoot: ownedRoot,
      publicationRoots: [ownedRoot, cache],
      catalogIds: [],
      sessionPaths: () => [],
    });
    try {
      for (const id of [current, old, foreign, shared]) {
        await mkdir(generationRoot(id), { recursive: true });
        await writeFile(join(generationRoot(id), 'prepared-reference-definition.v1.json'), '{}');
      }
      await mkdir(join(family, '.reference-version-history'), { recursive: true });
      await writeFile(
        join(family, '.reference-version-history', `${shared}.json`),
        versionHistory(shared)
      );
      for (const [publicationRoot, publicationId] of [
        [ownedRoot, current],
        [foreignRoot, foreign],
      ]) {
        await mkdir(join(publicationRoot, 'grch38'), { recursive: true });
        await writeFile(
          join(publicationRoot, 'grch38', 'current-reference-assets.v1.json'),
          JSON.stringify(publication(publicationId))
        );
      }
      expect(parseReferenceAssetPublicationV1(publication(current), 'grch38')).not.toBeNull();
      expect(current).not.toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      await retention.setRendererVersions(1, [{ catalogId: 'grch38', generationId: old }]);
      await retention.collect();
      expect((await stat(generationRoot(old))).isDirectory()).toBe(true);
      await retention.setRendererVersions(1, []);
      await retention.collect();
      await expect(stat(generationRoot(old))).rejects.toMatchObject({ code: 'ENOENT' });
      for (const id of [current, foreign, shared]) {
        expect((await stat(generationRoot(id))).isDirectory()).toBe(true);
      }
    } finally {
      await retention.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reclaims superseded prepared generations owned by the shared publication root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reference-retention-owned-shared-'));
    const family = join(root, 'grch38');
    const current = createReferenceGenerationId(family);
    const old = createReferenceGenerationId(family);
    const retention = new ReferenceGenerationRetention({
      cacheRoot: root,
      ownedPublicationRoot: root,
      publicationRoots: [root],
      catalogIds: [],
      sessionPaths: () => [],
    });
    try {
      for (const id of [current, old]) {
        const path = join(family, 'generations', id);
        await mkdir(path, { recursive: true });
        await writeFile(join(path, 'prepared-reference-definition.v1.json'), '{}');
      }
      await writeFile(
        join(family, 'current-reference-assets.v1.json'),
        JSON.stringify(publication(current))
      );
      await retention.setRendererVersions(1, []);
      await retention.collect();
      expect((await stat(join(family, 'generations', current))).isDirectory()).toBe(true);
      await expect(stat(join(family, 'generations', old))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await retention.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'malformed', 'dangling'] as const)(
    'retains its profile generations while the owned current pointer is %s',
    async (state) => {
      const root = await mkdtemp(join(tmpdir(), 'reference-retention-unreadable-owner-'));
      const cache = join(root, 'cache');
      const ownedRoot = join(root, 'profile-publications');
      const id = createReferenceGenerationId(join(ownedRoot, 'grch38'));
      const generationRoot = join(cache, 'grch38', 'generations', id);
      const retention = new ReferenceGenerationRetention({
        cacheRoot: cache,
        ownedPublicationRoot: ownedRoot,
        publicationRoots: [ownedRoot, cache],
        catalogIds: ['grch38'],
        sessionPaths: () => [],
      });
      try {
        await mkdir(generationRoot, { recursive: true });
        await writeFile(join(generationRoot, 'prepared-reference-definition.v1.json'), '{}');
        if (state !== 'missing') {
          await mkdir(join(ownedRoot, 'grch38'), { recursive: true });
          await writeFile(
            join(ownedRoot, 'grch38', 'current-reference-assets.v1.json'),
            state === 'malformed'
              ? '{}'
              : JSON.stringify(publication(createReferenceGenerationId(join(ownedRoot, 'grch38'))))
          );
        }
        await retention.setRendererVersions(1, []);
        await retention.collect();
        expect((await stat(generationRoot)).isDirectory()).toBe(true);
      } finally {
        await retention.stop();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each(['missing', 'malformed', 'dangling'] as const)(
    'retains shared history generations while the owned current pointer is %s',
    async (state) => {
      const root = await mkdtemp(join(tmpdir(), 'reference-retention-unreadable-shared-'));
      const family = join(root, 'grch38');
      const old = 'a'.repeat(64);
      const generationRoot = join(family, 'generations', old);
      const retention = new ReferenceGenerationRetention({
        cacheRoot: root,
        ownedPublicationRoot: root,
        publicationRoots: [root],
        catalogIds: ['grch38'],
        sessionPaths: () => [],
      });
      try {
        await mkdir(generationRoot, { recursive: true });
        await mkdir(join(family, '.reference-version-history'), { recursive: true });
        await writeFile(
          join(family, '.reference-version-history', `${old}.json`),
          versionHistory(old)
        );
        if (state !== 'missing') {
          await writeFile(
            join(family, 'current-reference-assets.v1.json'),
            state === 'malformed' ? '{}' : JSON.stringify(publication('f'.repeat(64)))
          );
        }
        await retention.setRendererVersions(1, []);
        await retention.collect();
        expect((await stat(generationRoot)).isDirectory()).toBe(true);
      } finally {
        await retention.stop();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('does not collect an unpublished profile generation while its preparation holds the writer lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reference-retention-busy-writer-'));
    const cache = join(root, 'cache');
    const ownedRoot = join(root, 'profile-publications');
    const family = join(cache, 'grch38');
    const current = createReferenceGenerationId(join(ownedRoot, 'grch38'));
    const preparing = createReferenceGenerationId(join(ownedRoot, 'grch38'));
    const generationRoot = join(family, 'generations', preparing);
    let writerHeld = false;
    const retention = new ReferenceGenerationRetention({
      cacheRoot: cache,
      ownedPublicationRoot: ownedRoot,
      publicationRoots: [ownedRoot, cache],
      catalogIds: ['grch38'],
      sessionPaths: () => [],
      acquireWriterLease: async () => {
        if (writerHeld)
          throw new Error('Reference asset refresh is already running in another process.');
        return {
          assertOwned: async () => {},
          commitPointer: async () => {},
          acceptReconciledCommit: async () => {},
          release: async () => {},
        };
      },
    });
    try {
      await retention.setRendererVersions(1, []);
      await retention.collect();
      await mkdir(generationRoot, { recursive: true });
      await writeFile(join(generationRoot, 'prepared-reference-definition.v1.json'), '{}');
      await mkdir(join(family, 'generations', current), { recursive: true });
      await writeFile(
        join(family, 'generations', current, 'prepared-reference-definition.v1.json'),
        '{}'
      );
      await mkdir(join(ownedRoot, 'grch38'), { recursive: true });
      await writeFile(
        join(ownedRoot, 'grch38', 'current-reference-assets.v1.json'),
        JSON.stringify(publication(current))
      );
      writerHeld = true;
      await expect(retention.collect()).rejects.toThrow('already running in another process');
      expect((await stat(generationRoot)).isDirectory()).toBe(true);
    } finally {
      await retention.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function publication(publicationId: string) {
  return {
    contract: 'reference-asset-publication.v1',
    assetCacheKey: 'grch38',
    publicationId,
    sourceMaterializationFingerprint: 'f'.repeat(64),
    publishedAtMs: 1,
  };
}

async function writeCurrent(root: string, id = 'f'.repeat(64)): Promise<void> {
  const family = join(root, 'grch38');
  const generationRoot = join(family, 'generations', id);
  await mkdir(generationRoot, { recursive: true });
  await writeFile(join(generationRoot, 'prepared-reference-definition.v1.json'), '{}');
  await writeFile(
    join(family, 'current-reference-assets.v1.json'),
    JSON.stringify(publication(id))
  );
}

function versionHistory(bundleFingerprint: string): string {
  return JSON.stringify({
    bundleFingerprint,
    sequenceIdentity: '1'.repeat(64),
    annotationIdentity: '2'.repeat(64),
    assetGenerations: [],
  });
}
