import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMPUTE_USER_MANIFESTS_DIRECTORY,
  computeManifestEnvironment,
  computeUserManifestsDir,
  finalizeInterruptedComputeManifestRemovals,
} from './manifest-paths';

const temporaryProfiles: string[] = [];

async function temporaryProfile(): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), 'compute-manifest-recovery-'));
  temporaryProfiles.push(profile);
  return profile;
}

afterEach(async () => {
  await Promise.all(
    temporaryProfiles.splice(0).map((profile) => rm(profile, { recursive: true, force: true }))
  );
});

describe('compute manifest paths', () => {
  it('keeps user-installed manifests inside the active Electron profile', () => {
    expect(computeUserManifestsDir('/profiles/lab')).toBe(
      join('/profiles/lab', COMPUTE_USER_MANIFESTS_DIRECTORY)
    );
    expect(
      computeManifestEnvironment({ isPackaged: false, userDataPath: '/profiles/lab' })
    ).toEqual({
      DNAFORGE_COMPUTE_USER_MANIFESTS_DIR: join('/profiles/lab', 'compute-endpoints'),
    });
  });

  it('points a packaged sidecar at immutable bundled resources and profile-owned additions', () => {
    expect(
      computeManifestEnvironment({
        isPackaged: true,
        userDataPath: '/profiles/lab',
        resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
      })
    ).toEqual({
      DNAFORGE_COMPUTE_USER_MANIFESTS_DIR: join('/profiles/lab', 'compute-endpoints'),
      DNAFORGE_COMPUTE_MANIFESTS_DIR: join(
        '/Applications/DNAForge.app/Contents/Resources',
        'compute-endpoints',
        'manifests'
      ),
    });
  });

  it('fails closed when a packaged caller omits the resources directory', () => {
    expect(() =>
      computeManifestEnvironment({ isPackaged: true, userDataPath: '/profiles/lab' })
    ).toThrow(/resourcesPath is required/);
  });

  it('finishes an interrupted removal by deleting its credential before its tombstone', async () => {
    const profile = await temporaryProfile();
    const directory = computeUserManifestsDir(profile);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, '.lab-provider.123e4567-e89b-12d3-a456-426614174000.removed'),
      '{}'
    );
    await writeFile(join(directory, 'unrelated.json'), '{}');
    const deleteCredential = vi.fn(async () => true);

    await expect(
      finalizeInterruptedComputeManifestRemovals(profile, deleteCredential)
    ).resolves.toEqual({ finalized: ['lab-provider'], failures: [] });
    expect(deleteCredential).toHaveBeenCalledWith('lab-provider');
    await expect(readdir(directory)).resolves.toEqual(['unrelated.json']);
  });

  it('keeps a tombstone for retry when credential deletion fails', async () => {
    const profile = await temporaryProfile();
    const directory = computeUserManifestsDir(profile);
    await mkdir(directory, { recursive: true });
    const tombstone = '.lab-provider.123e4567-e89b-12d3-a456-426614174000.removed';
    await writeFile(join(directory, tombstone), '{}');

    await expect(
      finalizeInterruptedComputeManifestRemovals(profile, async () => {
        throw new Error('keychain locked');
      })
    ).resolves.toEqual({
      finalized: [],
      failures: [{ providerId: 'lab-provider', message: 'keychain locked' }],
    });
    await expect(readdir(directory)).resolves.toEqual([tombstone]);
  });

  it('ignores malformed markers and symlinks instead of deleting arbitrary files', async () => {
    const profile = await temporaryProfile();
    const directory = computeUserManifestsDir(profile);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '.bad.not-a-uuid.removed'), '{}');
    await writeFile(join(profile, 'outside'), '{}');
    await symlink(
      join(profile, 'outside'),
      join(directory, '.linked.123e4567-e89b-12d3-a456-426614174000.removed')
    );
    const deleteCredential = vi.fn(async () => true);

    const result = await finalizeInterruptedComputeManifestRemovals(profile, deleteCredential);

    expect(result).toEqual({ finalized: [], failures: [] });
    expect(deleteCredential).not.toHaveBeenCalled();
    await expect(readdir(directory)).resolves.toHaveLength(2);
  });
});
