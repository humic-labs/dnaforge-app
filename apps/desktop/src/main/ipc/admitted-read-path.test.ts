import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../shared/file-associations', () => ({
  QUICK_LOOK_PACKAGE_STORE_DIRECTORY: 'QuickLookPackages',
}));
vi.mock('../reference-assets/reference-asset-cache-root', () => ({
  resolveReferenceAssetCacheRoot: () => join(electronPaths.appData, 'prepared-reference-assets'),
}));
vi.mock('../reference-assets/reference-asset-runtime-boundary', () => ({
  assertReferenceAssetRuntimeWriteAllowed: () => undefined,
}));
vi.mock('../workspace-git', () => ({
  acquireQuickLookRendererMutationLease: () => () => undefined,
  isQuickLookPromotionMutationBlocked: () => false,
}));

import { assertAdmittedReadPath } from './path-allowlist';

describe('assertAdmittedReadPath', () => {
  let temporaryRoot = '';
  let home = '';
  let project = '';
  let privateDir = '';

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'fixture-admitted-read-'));
    home = join(temporaryRoot, 'home');
    project = join(home, 'project');
    privateDir = join(home, 'private');
    electronPaths.home = home;
    electronPaths.userData = join(home, 'user-data');
    electronPaths.appData = join(home, 'app-data');
    await mkdir(project, { recursive: true });
    await mkdir(privateDir, { recursive: true });
    await mkdir(electronPaths.userData, { recursive: true });
    await mkdir(electronPaths.appData, { recursive: true });
    await writeFile(join(project, 'notes.txt'), 'IN_PROJECT');
    await writeFile(join(privateDir, 'audit.txt'), 'AUDIT_ONLY_OUTSIDE_PROJECT');
    await symlink(privateDir, join(project, 'linked-private'), 'dir');
  });

  afterAll(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('allows an ordinary project file after canonicalizing the project root', async () => {
    const admitted = await assertAdmittedReadPath(join(project, 'notes.txt'), {
      projectRoots: [project],
      grantedFiles: [],
    });
    expect(admitted).toBe(await realpath(join(project, 'notes.txt')));
  });

  it('refuses a project symlink that resolves outside the trusted project', async () => {
    await expect(
      assertAdmittedReadPath(join(project, 'linked-private', 'audit.txt'), {
        projectRoots: [project],
        grantedFiles: [],
      })
    ).rejects.toThrow(/outside the trusted project/i);
  });

  it('allows an explicit granted external file', async () => {
    const granted = join(privateDir, 'audit.txt');
    const admitted = await assertAdmittedReadPath(granted, {
      projectRoots: [project],
      grantedFiles: [granted],
    });
    expect(admitted).toBe(await realpath(granted));
  });
});
