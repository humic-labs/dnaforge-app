import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { manifest } from '@waypoint/codex-app-server-contract';
import {
  resolveCodexAppServerBinary,
  resolveCodexAppServerBinaryAsync,
  verifyCodexAppServerVersion,
  buildCodexAppServerVersionCheckEnv,
  CodexAppServerResolveError,
} from './app-server-binary';

const KEY = 'darwin-arm64';
const TARGET = manifest.supportedTargets[KEY];
const ORIGINAL_TARGET = structuredClone(TARGET);

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function makeExecutableScript(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function makeFile(dir: string, name: string, body: string, mode = 0o644): string {
  const file = path.join(dir, name);
  writeFileSync(file, body, { mode });
  return file;
}

function stageInstalledLayout(root: string, binaryBody: string, packageJsonBody: string): string {
  const binaryDir = path.join(
    root,
    'node_modules',
    TARGET.aliasPackageName,
    'vendor',
    TARGET.triple,
    'bin'
  );
  const packageDir = path.join(
    root,
    'node_modules',
    TARGET.aliasPackageName,
    'vendor',
    TARGET.triple
  );
  mkdirSync(binaryDir, { recursive: true });
  const binary = makeExecutableScript(binaryDir, 'codex', binaryBody);
  makeFile(packageDir, 'codex-package.json', packageJsonBody, 0o644);
  return binary;
}

function stagePackagedLayout(root: string, binaryBody: string, packageJsonBody: string): string {
  const base = path.join(root, 'binaries', 'codex-app-server', TARGET.triple);
  const binaryDir = path.join(base, 'bin');
  mkdirSync(binaryDir, { recursive: true });
  const binary = makeExecutableScript(binaryDir, 'codex', binaryBody);
  makeFile(base, 'codex-package.json', packageJsonBody, 0o644);
  return binary;
}

function setManifestDigests(binaryBody: string, packageJsonBody: string) {
  TARGET.codexBinarySha256 = sha256(binaryBody);
  TARGET.codexPackageJsonSha256 = sha256(packageJsonBody);
  TARGET.resources = [
    {
      pathInPackage: TARGET.codexBinaryPathInPackage,
      sha256: sha256(binaryBody),
      executable: true,
    },
    {
      pathInPackage: TARGET.codexPackageJsonPathInPackage,
      sha256: sha256(packageJsonBody),
      executable: false,
    },
  ];
}

function restoreManifestTarget() {
  Object.assign(TARGET, structuredClone(ORIGINAL_TARGET));
}

describe('resolveCodexAppServerBinary', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-'));
  });

  afterEach(() => {
    restoreManifestTarget();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves an installed-layout binary and returns its metadata', () => {
    const binaryBody = '#!/bin/sh\necho "codex-cli 0.148.0"\n';
    const packageJsonBody = JSON.stringify({ version: '0.148.0', target: TARGET.triple });
    setManifestDigests(binaryBody, packageJsonBody);
    stageInstalledLayout(tmp, binaryBody, packageJsonBody);

    const resolved = resolveCodexAppServerBinary({
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: false,
      searchRoots: [tmp],
    });

    expect(resolved.version).toBe('0.148.0');
    expect(resolved.triple).toBe('aarch64-apple-darwin');
    expect(resolved.packageVersion).toBe('0.148.0-darwin-arm64');
    expect(resolved.sha256).toBe(TARGET.codexBinarySha256);
  });

  it('resolves a packaged-layout binary and returns its metadata', () => {
    const binaryBody = '#!/bin/sh\necho "codex-cli 0.148.0"\n';
    const packageJsonBody = JSON.stringify({ version: '0.148.0', target: TARGET.triple });
    setManifestDigests(binaryBody, packageJsonBody);
    stagePackagedLayout(tmp, binaryBody, packageJsonBody);

    const resolved = resolveCodexAppServerBinary({
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: true,
      resourcesPath: tmp,
    });

    expect(resolved.version).toBe('0.148.0');
    expect(resolved.triple).toBe('aarch64-apple-darwin');
    expect(resolved.packageVersion).toBe('0.148.0-darwin-arm64');
    expect(resolved.sha256).toBe(TARGET.codexBinarySha256);
  });

  it('streams packaged resource verification through the async resolver', async () => {
    const binaryBody = `#!/bin/sh\n${'x'.repeat(1024 * 1024)}\n`;
    const packageJsonBody = JSON.stringify({ version: '0.148.0', target: TARGET.triple });
    setManifestDigests(binaryBody, packageJsonBody);
    stagePackagedLayout(tmp, binaryBody, packageJsonBody);

    const resolved = await resolveCodexAppServerBinaryAsync({
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: true,
      resourcesPath: tmp,
    });

    expect(resolved.sha256).toBe(TARGET.codexBinarySha256);
  });

  it('rejects tampered bytes through the async resolver', async () => {
    const binaryBody = '#!/bin/sh\necho "ok"\n';
    const packageJsonBody = '{}';
    setManifestDigests(binaryBody, packageJsonBody);
    stagePackagedLayout(tmp, `${binaryBody}tampered\n`, packageJsonBody);

    await expect(
      resolveCodexAppServerBinaryAsync({
        platform: 'darwin',
        arch: 'arm64',
        isPackaged: true,
        resourcesPath: tmp,
      })
    ).rejects.toThrow(/digest mismatch/);
  });

  it('rejects a missing installed binary', () => {
    setManifestDigests('x', '{}');
    mkdirSync(
      path.join(tmp, 'node_modules', TARGET.aliasPackageName, 'vendor', TARGET.triple, 'bin'),
      { recursive: true }
    );

    expect(() =>
      resolveCodexAppServerBinary({
        platform: 'darwin',
        arch: 'arm64',
        isPackaged: false,
        searchRoots: [tmp],
      })
    ).toThrow(/Codex App Server binary is missing/);
  });

  it('rejects a missing packaged binary', () => {
    setManifestDigests('x', '{}');
    mkdirSync(path.join(tmp, 'binaries', 'codex-app-server', TARGET.triple, 'bin'), {
      recursive: true,
    });

    expect(() =>
      resolveCodexAppServerBinary({
        platform: 'darwin',
        arch: 'arm64',
        isPackaged: true,
        resourcesPath: tmp,
      })
    ).toThrow(/Codex App Server binary is missing/);
  });

  it('rejects a non-executable file', () => {
    const binaryBody = '#!/bin/sh\necho "no"\n';
    const packageJsonBody = '{}';
    setManifestDigests(binaryBody, packageJsonBody);
    const binaryDir = path.join(
      tmp,
      'node_modules',
      TARGET.aliasPackageName,
      'vendor',
      TARGET.triple,
      'bin'
    );
    mkdirSync(binaryDir, { recursive: true });
    makeFile(binaryDir, 'codex', binaryBody, 0o644);
    const packageDir = path.join(
      tmp,
      'node_modules',
      TARGET.aliasPackageName,
      'vendor',
      TARGET.triple
    );
    makeFile(packageDir, 'codex-package.json', packageJsonBody, 0o644);

    let err: unknown;
    try {
      resolveCodexAppServerBinary({
        platform: 'darwin',
        arch: 'arm64',
        isPackaged: false,
        searchRoots: [tmp],
      });
      throw new Error('expected a CodexAppServerResolveError');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodexAppServerResolveError);
    expect((err as CodexAppServerResolveError).code).toBe('NOT_EXECUTABLE');
  });

  it('rejects a tampered binary digest', () => {
    const binaryBody = '#!/bin/sh\necho "ok"\n';
    const packageJsonBody = '{}';
    setManifestDigests(binaryBody, packageJsonBody);
    stageInstalledLayout(tmp, binaryBody + '\n', packageJsonBody);

    expect(() =>
      resolveCodexAppServerBinary({
        platform: 'darwin',
        arch: 'arm64',
        isPackaged: false,
        searchRoots: [tmp],
      })
    ).toThrow(/digest mismatch/);
  });

  it('binds the binary pin to the digest already verified by the resource sweep', () => {
    const binaryBody = '#!/bin/sh\necho "ok"\n';
    const packageJsonBody = '{}';
    setManifestDigests(binaryBody, packageJsonBody);
    stageInstalledLayout(tmp, binaryBody, packageJsonBody);
    TARGET.codexBinarySha256 = '0'.repeat(64);

    expect(() =>
      resolveCodexAppServerBinary({
        platform: 'darwin',
        arch: 'arm64',
        isPackaged: false,
        searchRoots: [tmp],
      })
    ).toThrow(/binary digest mismatch/);
  });

  it('rejects a missing or changed codex-package.json digest', () => {
    const binaryBody = '#!/bin/sh\necho "ok"\n';
    const packageJsonBody = '{}';
    setManifestDigests(binaryBody, packageJsonBody);
    stageInstalledLayout(tmp, binaryBody, packageJsonBody);
    writeFileSync(
      path.join(
        tmp,
        'node_modules',
        TARGET.aliasPackageName,
        'vendor',
        TARGET.triple,
        'codex-package.json'
      ),
      '{"changed":true}'
    );

    expect(() =>
      resolveCodexAppServerBinary({
        platform: 'darwin',
        arch: 'arm64',
        isPackaged: false,
        searchRoots: [tmp],
      })
    ).toThrow(/Codex App Server package metadata/);
  });

  it('rejects a symlink that escapes the package root', () => {
    const binaryBody = '#!/bin/sh\necho "ok"\n';
    const packageJsonBody = '{}';
    setManifestDigests(binaryBody, packageJsonBody);

    const outside = path.join(os.tmpdir(), 'codex-app-server-escape');
    mkdirSync(outside, { recursive: true });
    const outsideBinary = makeExecutableScript(outside, 'codex', binaryBody);

    const binaryDir = path.join(
      tmp,
      'node_modules',
      TARGET.aliasPackageName,
      'vendor',
      TARGET.triple,
      'bin'
    );
    const packageDir = path.join(
      tmp,
      'node_modules',
      TARGET.aliasPackageName,
      'vendor',
      TARGET.triple
    );
    mkdirSync(binaryDir, { recursive: true });
    symlinkSync(outsideBinary, path.join(binaryDir, 'codex'));
    makeFile(packageDir, 'codex-package.json', packageJsonBody, 0o644);

    let err: unknown;
    try {
      resolveCodexAppServerBinary({
        platform: 'darwin',
        arch: 'arm64',
        isPackaged: false,
        searchRoots: [tmp],
      });
      throw new Error('expected a CodexAppServerResolveError');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodexAppServerResolveError);
    expect((err as CodexAppServerResolveError).code).toBe('PATH_ESCAPE');
    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a binary located under an app.asar path', () => {
    const binaryBody = '#!/bin/sh\necho "ok"\n';
    const packageJsonBody = '{}';
    setManifestDigests(binaryBody, packageJsonBody);

    const asarRoot = path.join(tmp, 'app.asar');
    const binaryDir = path.join(
      asarRoot,
      'node_modules',
      TARGET.aliasPackageName,
      'vendor',
      TARGET.triple,
      'bin'
    );
    const packageDir = path.join(
      asarRoot,
      'node_modules',
      TARGET.aliasPackageName,
      'vendor',
      TARGET.triple
    );
    mkdirSync(binaryDir, { recursive: true });
    makeExecutableScript(binaryDir, 'codex', binaryBody);
    makeFile(packageDir, 'codex-package.json', packageJsonBody, 0o644);

    let err: unknown;
    try {
      resolveCodexAppServerBinary({
        platform: 'darwin',
        arch: 'arm64',
        isPackaged: false,
        searchRoots: [asarRoot],
      });
      throw new Error('expected a CodexAppServerResolveError');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodexAppServerResolveError);
    expect((err as CodexAppServerResolveError).code).toBe('ASAR_PACKED');
  });

  it('rejects a missing target platform', () => {
    setManifestDigests('x', '{}');

    expect(() =>
      resolveCodexAppServerBinary({
        platform: 'freebsd',
        arch: 'arm64',
        isPackaged: false,
        searchRoots: [tmp],
      })
    ).toThrow(/not supported/);
  });

  it('fails closed when a verified architecture package is missing', () => {
    setManifestDigests('x', '{}');

    expect(() =>
      resolveCodexAppServerBinary({
        platform: 'darwin',
        arch: 'x64',
        isPackaged: false,
        searchRoots: [tmp],
      })
    ).toThrow(/binary is missing/);
  });
});

describe('verifyCodexAppServerVersion', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-version-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps required Windows system variables without inheriting user overrides', () => {
    const env = buildCodexAppServerVersionCheckEnv(
      {
        PATH: 'C:\\untrusted',
        CODEX_HOME: 'C:\\secret',
        NODE_OPTIONS: '--require malware.js',
        SystemRoot: 'C:\\Windows',
        windir: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      },
      'win32'
    );

    expect(env).toEqual({
      PATH: '',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(env).not.toHaveProperty('CODEX_HOME');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
  });

  it('accepts the exact expected --version output', async () => {
    const body = '#!/bin/sh\necho "codex-cli 0.148.0"\n';
    const binary = makeExecutableScript(tmp, 'codex', body);
    await verifyCodexAppServerVersion({
      path: binary,
      version: '0.148.0',
      versionOutput: 'codex-cli 0.148.0',
      triple: 'aarch64-apple-darwin',
      packageVersion: '0.148.0-darwin-arm64',
      sha256: 'dummy',
    });
  });

  it('rejects a different --version output', async () => {
    const body = '#!/bin/sh\necho "codex-cli 0.147.0"\n';
    const binary = makeExecutableScript(tmp, 'codex', body);

    await expect(
      verifyCodexAppServerVersion({
        path: binary,
        version: '0.148.0',
        versionOutput: 'codex-cli 0.148.0',
        triple: 'aarch64-apple-darwin',
        packageVersion: '0.148.0-darwin-arm64',
        sha256: 'dummy',
      })
    ).rejects.toThrow(/version mismatch/);
  });
});
