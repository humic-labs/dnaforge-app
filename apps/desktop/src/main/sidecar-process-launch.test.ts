import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import {
  packagedSidecarOwnerEnv,
  resolveDevelopmentSidecarLaunch,
  resolvePackagedSidecarLaunch,
} from './sidecar-process-launch';

describe('resolveDevelopmentSidecarLaunch', () => {
  it.each(['darwin', 'linux'] as const)(
    'keeps the direct Electron owner through the shared source entrypoint and reload (%s)',
    (platform) => {
      expect(
        resolveDevelopmentSidecarLaunch({
          pythonPath: '/python with spaces/bin/python3',
          apiDir: '/repo with spaces/apps/api',
          apiPort: '9014',
          ownerPid: 1234,
          platform,
        })
      ).toEqual({
        executable: '/python with spaces/bin/python3',
        args: [
          join('/repo with spaces/apps/api', 'run_server.py'),
          '--port',
          '9014',
          '--host',
          '127.0.0.1',
          '--reload',
        ],
        ownerEnv: { DNAFORGE_SIDECAR_OWNER_PID: '1234' },
      });
    }
  );
});

describe('packagedSidecarOwnerEnv', () => {
  it('binds a POSIX packaged sidecar to its Electron parent', () => {
    expect(packagedSidecarOwnerEnv(1234, 'darwin')).toEqual({
      DNAFORGE_SIDECAR_OWNER_PID: '1234',
    });
    expect(packagedSidecarOwnerEnv(1234, 'linux')).toEqual({
      DNAFORGE_SIDECAR_OWNER_PID: '1234',
    });
  });

  it('leaves Windows to its Job Object guardian', () => {
    expect(packagedSidecarOwnerEnv(1234, 'win32')).toEqual({});
  });
});

describe('resolvePackagedSidecarLaunch', () => {
  it('puts the packaged Windows sidecar inside the native process guardian job', () => {
    expect(
      resolvePackagedSidecarLaunch({
        binaryPath: 'C:\\DNAForge\\resources\\binaries\\waypoint-api.exe',
        apiPort: '49152',
        guardianPath: 'C:\\DNAForge\\Helpers\\dna-process-guardian.exe',
        ownerPid: 1234,
        platform: 'win32',
      })
    ).toEqual({
      executable: 'C:\\DNAForge\\Helpers\\dna-process-guardian.exe',
      args: [
        '--owner-pid',
        '1234',
        '--',
        'C:\\DNAForge\\resources\\binaries\\waypoint-api.exe',
        '--port',
        '49152',
      ],
    });
  });

  it('launches the packaged sidecar directly outside Windows', () => {
    expect(
      resolvePackagedSidecarLaunch({
        binaryPath: '/Applications/DNAForge.app/Contents/Resources/binaries/waypoint-api',
        apiPort: '49152',
        ownerPid: 1234,
        platform: 'darwin',
      })
    ).toEqual({
      executable: '/Applications/DNAForge.app/Contents/Resources/binaries/waypoint-api',
      args: ['--port', '49152'],
    });
  });

  it('fails closed when the packaged Windows guardian is unavailable', () => {
    expect(() =>
      resolvePackagedSidecarLaunch({
        binaryPath: 'C:\\DNAForge\\resources\\binaries\\waypoint-api.exe',
        apiPort: '49152',
        ownerPid: 1234,
        platform: 'win32',
      })
    ).toThrow(/guardian is unavailable/i);
  });
});
