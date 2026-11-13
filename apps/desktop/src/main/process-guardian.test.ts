import { describe, expect, it } from 'vitest';

import { resolveProcessGuardianPath } from './process-guardian';

describe('resolveProcessGuardianPath', () => {
  it('resolves the packaged Windows helper beside the app resources directory', () => {
    expect(
      resolveProcessGuardianPath({
        appPath: 'C:\\DNAForge\\resources\\app.asar',
        resourcesPath: 'C:\\DNAForge\\resources',
        isPackaged: true,
        platform: 'win32',
        arch: 'x64',
      })
    ).toMatch(/DNAForge[\\/]Helpers[\\/]dna-process-guardian-x86_64-pc-windows-msvc\.exe$/);
  });

  it('is unnecessary outside Windows', () => {
    expect(
      resolveProcessGuardianPath({
        appPath: '/Applications/DNAForge.app/Contents/Resources/app.asar',
        resourcesPath: '/Applications/DNAForge.app/Contents/Resources',
        isPackaged: true,
        platform: 'darwin',
        arch: 'arm64',
      })
    ).toBeUndefined();
  });
});
