import { describe, expect, it } from 'vitest';

import { spawnSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { sidecarControlPlaneEnv, sidecarProfileLockPath } from './sidecar-control-plane-env';

describe('sidecarControlPlaneEnv', () => {
  it('gives each packaged user-data profile a distinct stable runtime scope', () => {
    const first = sidecarControlPlaneEnv({
      isPackaged: true,
      userDataPath: '/tmp/dnaforge-profile-a',
      env: {},
    });
    const firstAgain = sidecarControlPlaneEnv({
      isPackaged: true,
      userDataPath: '/tmp/dnaforge-profile-a',
      env: {},
    });
    const second = sidecarControlPlaneEnv({
      isPackaged: true,
      userDataPath: '/tmp/dnaforge-profile-b',
      env: {},
    });

    expect(first).toEqual(firstAgain);
    expect(first.DNAFORGE_SIDECAR_ENVIRONMENT_ID).toMatch(/^packaged-profile-[a-f0-9]{12}$/u);
    expect(first.DNAFORGE_SIDECAR_ENVIRONMENT_ID).not.toBe(second.DNAFORGE_SIDECAR_ENVIRONMENT_ID);
    expect(first.DNAFORGE_GRANT_ENVIRONMENT_ID).toBe(first.DNAFORGE_SIDECAR_ENVIRONMENT_ID);
    expect(first.DNAFORGE_GRANT_CREATED_BY).toBe('electron-packaged');
    expect(first).not.toHaveProperty('DNAFORGE_SIDECAR_DB_PATH');
  });

  it('preserves configured authority and the existing dev database layout', () => {
    const result = sidecarControlPlaneEnv({
      isPackaged: false,
      userDataPath: '/tmp/dnaforge-dev-profile',
      apiDir: '/worktrees/dnaforge/apps/api',
      env: {
        DNAFORGE_SIDECAR_ENVIRONMENT_ID: 'configured environment',
        DNAFORGE_GRANT_CREATED_BY: 'configured-owner',
      },
    });

    expect(result).toEqual({
      DNAFORGE_GRANT_ENVIRONMENT_ID: 'configured environment',
      DNAFORGE_SIDECAR_ENVIRONMENT_ID: 'configured environment',
      DNAFORGE_GRANT_CREATED_BY: 'configured-owner',
      DNAFORGE_SIDECAR_DB_PATH:
        '/tmp/dnaforge-dev-profile/dev-control-planes/configured-environment/sidecar-control-plane.sqlite3',
    });
  });

  it('names the same lock file Python opens for that profile', () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), 'lock-path-')), 'sidecar.sqlite3');
    const scope = 'packaged-profile-probe';
    const python = spawnSync(
      'python3',
      [
        '-c',
        [
          'import hashlib, sys',
          'from pathlib import Path',
          'resolved = Path(sys.argv[1]).expanduser().resolve()',
          'digest = hashlib.sha256(sys.argv[2].encode()).hexdigest()[:20]',
          'print(resolved.with_name(f".{resolved.name}.operation-owner-{digest}.lock"))',
        ].join('\n'),
        databasePath,
        scope,
      ],
      { encoding: 'utf8' }
    );
    expect(python.status, python.stderr).toBe(0);
    expect(
      sidecarProfileLockPath({
        isPackaged: true,
        userDataPath: '/tmp/unused-profile',
        env: { DNAFORGE_SIDECAR_DB_PATH: databasePath, DNAFORGE_SIDECAR_ENVIRONMENT_ID: scope },
      })
    ).toBe(python.stdout.trim());
  });

  it('requires an API directory only for a dev sidecar', () => {
    expect(() =>
      sidecarControlPlaneEnv({
        isPackaged: false,
        userDataPath: '/tmp/dnaforge-dev-profile',
        env: {},
      })
    ).toThrow('Dev sidecar control-plane env requires apiDir');
  });
});
