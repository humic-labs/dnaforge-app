import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DNAFORGE_REFERENCE_ASSET_ROOT_ENV } from '../reference-assets/reference-asset-cache-root';
import { ReferenceAssetRuntimeMutationError } from '../reference-assets/reference-asset-runtime-boundary';
import { beginQuickLookPromotionWrite } from '../workspace-git';
import { assertSafeWritablePath } from './path-allowlist';

const electronPaths = vi.hoisted(() => ({
  appData: '',
  home: '',
  userData: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath(name: keyof typeof electronPaths): string {
      return electronPaths[name];
    },
  },
}));

describe('writable IPC path canonicalization', () => {
  let temporaryRoot = '';
  let homeRoot = '';
  let referenceAssetCacheRoot = '';
  let previousReferenceAssetRoot: string | undefined;

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'dnaforge-path-allowlist-'));
    homeRoot = join(temporaryRoot, 'home');
    referenceAssetCacheRoot = join(homeRoot, 'prepared-reference-assets');
    electronPaths.home = homeRoot;
    electronPaths.userData = join(homeRoot, 'user-data');
    electronPaths.appData = join(homeRoot, 'app-data');
    previousReferenceAssetRoot = process.env[DNAFORGE_REFERENCE_ASSET_ROOT_ENV];
    process.env[DNAFORGE_REFERENCE_ASSET_ROOT_ENV] = referenceAssetCacheRoot;
    await Promise.all([
      mkdir(electronPaths.userData, { recursive: true }),
      mkdir(electronPaths.appData, { recursive: true }),
      mkdir(referenceAssetCacheRoot, { recursive: true }),
    ]);
  });

  afterAll(async () => {
    if (previousReferenceAssetRoot === undefined) {
      delete process.env[DNAFORGE_REFERENCE_ASSET_ROOT_ENV];
    } else {
      process.env[DNAFORGE_REFERENCE_ASSET_ROOT_ENV] = previousReferenceAssetRoot;
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('returns the canonical existing target that was admitted', async () => {
    const existingPath = join(homeRoot, 'workspace', 'existing.txt');
    await mkdir(join(homeRoot, 'workspace'), { recursive: true });
    await writeFile(existingPath, 'existing', 'utf8');

    await expect(assertSafeWritablePath(existingPath)).resolves.toBe(await realpath(existingPath));
  });

  it('canonicalizes a new child from its nearest existing symlinked parent', async () => {
    const actualParent = join(homeRoot, 'workspace-target');
    const aliasParent = join(homeRoot, 'workspace-alias');
    await mkdir(actualParent, { recursive: true });
    await symlink(actualParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(
      assertSafeWritablePath(join(aliasParent, 'new-directory', 'new.txt'))
    ).resolves.toBe(join(await realpath(actualParent), 'new-directory', 'new.txt'));
  });

  it('rejects existing and new targets reached through an alias into prepared assets', async () => {
    const preparedGeneration = join(referenceAssetCacheRoot, 'grch38', 'generation-a');
    const preparedAlias = join(homeRoot, 'prepared-alias');
    await mkdir(preparedGeneration, { recursive: true });
    await writeFile(join(preparedGeneration, 'manifest.json'), '{}', 'utf8');
    await symlink(
      referenceAssetCacheRoot,
      preparedAlias,
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    for (const candidatePath of [
      join(preparedAlias, 'grch38', 'generation-a', 'manifest.json'),
      join(preparedAlias, 'grch38', 'generation-b', 'manifest.json'),
    ]) {
      await expect(assertSafeWritablePath(candidatePath)).rejects.toBeInstanceOf(
        ReferenceAssetRuntimeMutationError
      );
    }
  });

  it('rejects renderer writes inside or above the main-owned Quick Look store', async () => {
    const quickLookStore = join(electronPaths.userData, 'quick-look-packages');
    await mkdir(join(quickLookStore, '.promotions'), { recursive: true });

    for (const candidatePath of [
      quickLookStore,
      join(quickLookStore, '.promotions', 'forged.json'),
    ]) {
      await expect(assertSafeWritablePath(candidatePath)).rejects.toThrow(
        'Renderer mutation of the main-owned Quick Look store is denied'
      );
    }
  });

  it('rejects mutation of the profile that contains multiple protected stores', async () => {
    await expect(assertSafeWritablePath(electronPaths.userData)).rejects.toThrow(
      /saved entity source store is read-only|main-owned Quick Look store is denied/
    );
  });

  it('blocks renderer mutation of an active promotion and its ancestors until every owner releases', async () => {
    const workspaceRoot = join(homeRoot, 'promotion-workspace');
    const candidateRoot = join(workspaceRoot, 'example');
    await mkdir(candidateRoot, { recursive: true });

    const outerLease = await beginQuickLookPromotionWrite(candidateRoot);
    const innerLease = await beginQuickLookPromotionWrite(candidateRoot);
    try {
      for (const candidatePath of [
        join(candidateRoot, 'example.gb'),
        candidateRoot,
        workspaceRoot,
      ]) {
        await expect(assertSafeWritablePath(candidatePath)).rejects.toThrow(
          'Renderer mutation of an active Quick Look promotion is denied'
        );
      }

      innerLease.release();
      await expect(assertSafeWritablePath(candidateRoot)).rejects.toThrow(
        'Renderer mutation of an active Quick Look promotion is denied'
      );
    } finally {
      innerLease.release();
      outerLease.release();
    }

    await expect(assertSafeWritablePath(candidateRoot)).resolves.toBe(
      await realpath(candidateRoot)
    );
  });
});
