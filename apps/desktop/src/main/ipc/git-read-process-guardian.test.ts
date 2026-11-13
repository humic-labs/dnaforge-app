import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveGitReadProcessGuardian,
  resolveGitReadWorkerPath,
} from './git-read-process-guardian';

describe('resolveGitReadProcessGuardian', () => {
  it('resolves the development worker from a built main-process app path', () => {
    const appPath = resolve('repo', 'apps', 'desktop', 'out', 'main');
    expect(resolveGitReadWorkerPath(appPath)).toBe(
      resolve(appPath, '..', '..', 'resources', 'git-read-worker.cjs')
    );
  });

  it('is unnecessary outside Windows', () => {
    expect(
      resolveGitReadProcessGuardian({
        appPath: '/app',
        resourcesPath: '/app/Contents/Resources',
        isPackaged: true,
        platform: 'darwin',
        arch: 'arm64',
      })
    ).toBeUndefined();
  });

  it('resolves the packaged Windows helper outside resources', () => {
    expect(
      resolveGitReadProcessGuardian({
        appPath: 'C:\\DNAForge\\resources\\app.asar',
        resourcesPath: 'C:\\DNAForge\\resources',
        isPackaged: true,
        platform: 'win32',
        arch: 'x64',
      })
    ).toMatch(/DNAForge[\\/]Helpers[\\/]dna-process-guardian-x86_64-pc-windows-msvc\.exe$/);
  });

  it('honors an explicit development helper', () => {
    expect(
      resolveGitReadProcessGuardian({
        appPath: 'C:\\source\\apps\\desktop',
        resourcesPath: 'C:\\electron\\resources',
        isPackaged: false,
        explicitPath: ' C:\\ci\\guardian.exe ',
        platform: 'win32',
        arch: 'amd64',
      })
    ).toMatch(/ci[\\/]guardian\.exe$/);
  });

  it('ignores an ambient development override in a packaged app', () => {
    expect(
      resolveGitReadProcessGuardian({
        appPath: 'C:\\DNAForge\\resources\\app.asar',
        resourcesPath: 'C:\\DNAForge\\resources',
        isPackaged: true,
        explicitPath: 'C:\\stale\\guardian.exe',
        platform: 'win32',
        arch: 'x64',
      })
    ).toMatch(/DNAForge[\\/]Helpers[\\/]dna-process-guardian-x86_64-pc-windows-msvc\.exe$/);
  });

  it('fails closed on unsupported Windows architecture', () => {
    expect(() =>
      resolveGitReadProcessGuardian({
        appPath: 'C:\\source\\apps\\desktop',
        resourcesPath: 'C:\\electron\\resources',
        isPackaged: false,
        platform: 'win32',
        arch: 'arm64',
      })
    ).toThrow(/unsupported/i);
  });
});
