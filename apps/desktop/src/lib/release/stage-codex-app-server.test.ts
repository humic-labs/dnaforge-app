// @vitest-environment node

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { stageCodexAppServer, runCodexAppServerStaging } =
  require('../../../scripts/stage-codex-app-server.cjs') as {
    stageCodexAppServer: (options: {
      platform: string;
      arch: string;
      manifest: object;
      searchRoots: string[];
      resourcesRoot: string;
      licenseRoot: string;
    }) => void;
    runCodexAppServerStaging: (options: {
      bestEffort: boolean;
      stageOptions: Parameters<typeof stageCodexAppServer>[0];
    }) => { status: 'staged'; destination: string } | { status: 'skipped'; reason: string };
  };

function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

describe('stageCodexAppServer', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'codex-stage-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function manifestFor(binary: string, metadata: string) {
    return {
      supportedTargets: {
        'darwin-arm64': {
          verified: true,
          triple: 'aarch64-apple-darwin',
          aliasPackageName: '@openai/codex-test',
          codexBinaryPathInPackage: 'vendor/aarch64-apple-darwin/bin/codex',
          codexPackageJsonPathInPackage: 'vendor/aarch64-apple-darwin/codex-package.json',
          resources: [
            {
              pathInPackage: 'vendor/aarch64-apple-darwin/bin/codex',
              sha256: sha256(binary),
              executable: true,
            },
            {
              pathInPackage: 'vendor/aarch64-apple-darwin/codex-package.json',
              sha256: sha256(metadata),
              executable: false,
            },
          ],
        },
      },
      license: { files: [] },
    };
  }

  it('fails closed when the supported package is not installed', () => {
    expect(() =>
      stageCodexAppServer({
        platform: 'darwin',
        arch: 'arm64',
        manifest: manifestFor('binary', '{}'),
        searchRoots: [path.join(tmp, 'missing')],
        resourcesRoot: path.join(tmp, 'resources'),
        licenseRoot: tmp,
      })
    ).toThrow(/installed package not found/);
  });

  it('lets postinstall skip only a missing optional platform package', () => {
    const stageOptions = {
      platform: 'darwin',
      arch: 'arm64',
      manifest: manifestFor('binary', '{}'),
      searchRoots: [path.join(tmp, 'missing')],
      resourcesRoot: path.join(tmp, 'resources'),
      licenseRoot: tmp,
    };

    expect(runCodexAppServerStaging({ bestEffort: true, stageOptions })).toMatchObject({
      status: 'skipped',
      reason: expect.stringMatching(/installed package not found/),
    });
    expect(() => runCodexAppServerStaging({ bestEffort: false, stageOptions })).toThrow(
      /installed package not found/
    );
  });

  it('keeps best-effort staging fail-closed for a present but changed artifact', () => {
    const binary = 'changed';
    const metadata = '{}';
    const packageRoot = path.join(tmp, 'node_modules', '@openai', 'codex-test');
    const vendorRoot = path.join(packageRoot, 'vendor', 'aarch64-apple-darwin');
    mkdirSync(path.join(vendorRoot, 'bin'), { recursive: true });
    writeFileSync(path.join(vendorRoot, 'bin', 'codex'), binary, { mode: 0o755 });
    writeFileSync(path.join(vendorRoot, 'codex-package.json'), metadata);

    expect(() =>
      runCodexAppServerStaging({
        bestEffort: true,
        stageOptions: {
          platform: 'darwin',
          arch: 'arm64',
          manifest: manifestFor('expected', metadata),
          searchRoots: [path.join(tmp, 'node_modules')],
          resourcesRoot: path.join(tmp, 'resources'),
          licenseRoot: tmp,
        },
      })
    ).toThrow(/digest mismatch/);
  });

  it('stages only the complete digest-verified inventory', () => {
    const binary = 'binary';
    const metadata = '{}';
    const packageRoot = path.join(tmp, 'node_modules', '@openai', 'codex-test');
    const vendorRoot = path.join(packageRoot, 'vendor', 'aarch64-apple-darwin');
    mkdirSync(path.join(vendorRoot, 'bin'), { recursive: true });
    writeFileSync(path.join(vendorRoot, 'bin', 'codex'), binary, {
      mode: 0o755,
    });
    writeFileSync(path.join(vendorRoot, 'codex-package.json'), metadata);

    const resourcesRoot = path.join(tmp, 'resources');
    const stale = path.join(resourcesRoot, 'codex-app-server', 'stale-triple', 'bin');
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, 'codex'), 'stale');

    stageCodexAppServer({
      platform: 'darwin',
      arch: 'arm64',
      manifest: manifestFor(binary, metadata),
      searchRoots: [path.join(tmp, 'node_modules')],
      resourcesRoot,
      licenseRoot: tmp,
    });

    const stagedRoot = path.join(resourcesRoot, 'codex-app-server', 'aarch64-apple-darwin');
    expect(readFileSync(path.join(stagedRoot, 'bin', 'codex'), 'utf8')).toBe(binary);
    expect(existsSync(path.join(resourcesRoot, 'codex-app-server', 'stale-triple'))).toBe(false);
  });

  it('restages immediately before every package-builder path', () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };
    for (const name of ['package', 'package:dir', 'package:local']) {
      const script = packageJson.scripts[name];
      expect(script.indexOf('node scripts/stage-codex-app-server.cjs')).toBeGreaterThan(-1);
      expect(script.indexOf('node scripts/stage-codex-app-server.cjs')).toBeLessThan(
        script.indexOf('node scripts/run-electron-builder.cjs')
      );
      expect(script).not.toContain('stage-codex-app-server.cjs --best-effort');
    }
    expect(packageJson.scripts.postinstall).toContain(
      'node scripts/stage-codex-app-server.cjs --best-effort'
    );
  });

  it('limits the signing exclusion to the exact staged runtime tree', () => {
    const config = readFileSync(path.resolve(process.cwd(), 'electron-builder.yml'), 'utf8');
    const match = config.match(/signIgnore:\s*\n\s*-\s+'([^']+)'/u);
    expect(match?.[1]).toBe('^.*/Contents/Resources/binaries/codex-app-server(?:/|$)');

    const signingExclusion = new RegExp(match?.[1] ?? '');
    expect(
      signingExclusion.test(
        '/DNAForge.app/Contents/Resources/binaries/codex-app-server/aarch64/bin/codex'
      )
    ).toBe(true);
    expect(
      signingExclusion.test('/DNAForge.app/Contents/Resources/binaries/other-codex-app-server')
    ).toBe(false);
    expect(
      signingExclusion.test('/DNAForge.app/Contents/Resources/helpers/codex-app-server-helper')
    ).toBe(false);
  });
});
