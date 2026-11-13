import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manifest } from '@waypoint/codex-app-server-contract';
import { resolveCodexAppServerBinary, verifyCodexAppServerVersion } from './app-server-binary';

const require = createRequire(import.meta.url);
const { stageCodexAppServer } = require('../../../scripts/stage-codex-app-server.cjs') as {
  stageCodexAppServer: (options: {
    platform: string;
    arch: string;
    manifest: object;
    searchRoots: string[];
    resourcesRoot: string;
    licenseRoot: string;
  }) => string;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const IS_DARWIN_ARM64 = process.platform === 'darwin' && process.arch === 'arm64';

describe.skipIf(!IS_DARWIN_ARM64)('real Codex App Server arm64 artifact', () => {
  let tmp: string;
  let resourcesPath: string;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'codex-real-artifact-'));
    resourcesPath = path.join(tmp, 'Resources');
    stageCodexAppServer({
      platform: 'darwin',
      arch: 'arm64',
      manifest,
      searchRoots: [
        path.join(REPO_ROOT, 'apps', 'desktop', 'node_modules'),
        path.join(REPO_ROOT, 'node_modules'),
      ],
      resourcesRoot: path.join(resourcesPath, 'binaries'),
      licenseRoot: path.join(REPO_ROOT, 'packages', 'core', 'codex-app-server-contract'),
    });
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('passes the package verifier integration and reports the pinned version', async () => {
    const verification = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, 'apps', 'desktop', 'scripts', 'verify-package.cjs'),
        '--codex-app-server-only',
        resourcesPath,
        '--platform',
        'darwin',
        '--arch',
        'arm64',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15_000 }
    );
    expect(verification.status, verification.stderr).toBe(0);
    expect(verification.stdout).toContain('complete and digest-verified');

    const binary = resolveCodexAppServerBinary({
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: true,
      resourcesPath,
    });
    await verifyCodexAppServerVersion(binary);
  });

  it('initializes, accepts initialized, and exits cleanly when stdin closes', async () => {
    const binary = resolveCodexAppServerBinary({
      platform: 'darwin',
      arch: 'arm64',
      isPackaged: true,
      resourcesPath,
    });
    const codexHome = path.join(tmp, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    const child = spawn(binary.path, ['app-server'], {
      cwd: tmp,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        HOME: tmp,
        CODEX_HOME: codexHome,
        PATH: '',
      },
    });

    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for initialize response')),
        10_000
      );
      lines.on('line', (line) => {
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.id === 1) {
            clearTimeout(timer);
            lines.close();
            resolve(message);
          }
        } catch {}
      });
      child.once('error', reject);
    });

    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'dnaforge-runtime-smoke',
            title: 'DNAForge Runtime Smoke',
            version: '0.0.0',
          },
        },
      })}\n`
    );
    const initialize = await response;
    expect(initialize).toHaveProperty('result');

    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Codex App Server did not exit after stdin closed'));
      }, 10_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.once('error', reject);
    });
    expect(exitCode).toBe(0);
  });
});
