import { mkdtemp, mkdir, writeFile, stat, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ReferenceGenerationRetention } from './reference-generation-retention';

describe('superseded reference generations', () => {
  it('retains the currently cataloged portable bundle while another profile hydrates it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reference-retention-catalog-'));
    const currentBundle = 'b'.repeat(64);
    const obsoleteBundle = 'a'.repeat(64);
    const family = join(root, 'grch38');
    const retention = new ReferenceGenerationRetention({
      cacheRoot: root,
      publicationRoots: [root],
      catalogIds: ['grch38'],
      pinnedVersions: [{ catalogId: 'grch38', generationId: currentBundle }],
      sessionPaths: () => [],
    });
    try {
      await mkdir(join(family, '.reference-version-history'), { recursive: true });
      for (const generation of [currentBundle, obsoleteBundle]) {
        await mkdir(join(family, 'generations', generation), { recursive: true });
        await writeFile(join(family, '.reference-version-history', `${generation}.json`), '{}');
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
      await mkdir(generationRoot, { recursive: true });
      await mkdir(join(family, '.reference-version-history'), { recursive: true });
      await writeFile(join(family, '.reference-version-history', `${generation}.json`), '{}');
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
      await mkdir(oldRoot, { recursive: true });
      await mkdir(currentRoot, { recursive: true });
      await mkdir(join(family, '.reference-version-history'), { recursive: true });
      await writeFile(join(family, '.reference-version-history', `${old}.json`), '{}');
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
      await mkdir(path, { recursive: true });
      await mkdir(join(root, 'grch38/.reference-version-history'), { recursive: true });
      await writeFile(join(root, 'grch38/.reference-version-history', `${generation}.json`), '{}');
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
  it('waits for canvas restoration and leaves uncommitted hydration folders alone', async () => {
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
      for (const id of [legacy, staging]) {
        await mkdir(generationRoot(id), { recursive: true });
        await writeFile(join(generationRoot(id), 'prepared-reference-definition.v1.json'), '{}');
      }
      expect(await retention.collect()).toEqual([]);
      expect((await stat(generationRoot(legacy))).isDirectory()).toBe(true);
      await retention.setRendererVersions(1, []);
      await retention.collect();
      await expect(stat(generationRoot(legacy))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(generationRoot(staging))).isDirectory()).toBe(true);
    } finally {
      await retention.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
