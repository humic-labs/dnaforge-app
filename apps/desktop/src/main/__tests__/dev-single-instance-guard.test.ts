import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { resolve } from 'path';
import { prepareTerminalShell } from '../terminal/shell-launch';

const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8'));
const guardScript = readFileSync(
  resolve(__dirname, '../../../scripts/dev-single-instance-guard.cjs'),
  'utf8'
);
const electronViteConfig = readFileSync(
  resolve(__dirname, '../../../electron.vite.config.ts'),
  'utf8'
);
const desktopHtml = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8');
const { HOSTED_STAGING_PROFILE } = require('../../../scripts/dev-launch-profile.cjs') as {
  HOSTED_STAGING_PROFILE: { name: string; webBaseUrl: string; gatewayOrigin: string };
};
const guard = require(resolve(__dirname, '../../../scripts/dev-single-instance-guard.cjs')) as {
  parseRequiredDesktopDevPort: (raw: string | undefined) => number;
  resolveDesktopDevPort: (
    raw: string | undefined,
    options?: { allowBuildFallback?: boolean }
  ) => number;
  evaluateRuntimeSourceFreshness: (options: {
    debugPids: number[];
    newestSource?: { path: string; mtimeMs: number };
    getProcessStartTimeMs?: (pid: number) => number | undefined;
    staleToleranceMs?: number;
  }) => {
    stale: boolean;
    newestSource?: { path: string; mtimeMs: number };
    oldestProcessStart?: { pid: number; startMs: number };
  };
  isRuntimeSourceFile: (filePath: string) => boolean;
  tcpPortAcceptsConnections: (port: number, timeoutMs?: number) => Promise<boolean>;
  devChildEnv: (options?: {
    env?: NodeJS.ProcessEnv;
    appDir?: string;
    repoRoot?: string;
    launchTarget?: typeof HOSTED_STAGING_PROFILE | null;
  }) => NodeJS.ProcessEnv;
  assertRequestedLaunchTarget: (
    requested: typeof HOSTED_STAGING_PROFILE | null,
    running: string | null
  ) => void;
  ensureWindowsGitReadGuardian: (options?: {
    platform?: NodeJS.Platform;
    appDir?: string;
    guardianPath?: string;
    pathExists?: (filePath: string) => boolean;
    execute?: (
      command: string,
      args: string[],
      options: { cwd: string; env?: NodeJS.ProcessEnv; stdio: string }
    ) => void;
    build?: () => void;
  }) => string | null;
  ensureBundledGitRuntime: (options?: {
    appDir?: string;
    execute?: (command: string, args: string[], options: { cwd: string; stdio: string }) => void;
  }) => string;
  runHostedStagingReadinessPreflight: (
    target: typeof HOSTED_STAGING_PROFILE | null,
    get?: (url: string, timeoutMs: number) => Promise<{ ok: boolean; status: number; body: string }>
  ) => Promise<{ deployedGitSha: string; campaignId: string; catalogVersion: string } | null>;
  probe: (
    rendererPort: number,
    debugPort: number
  ) => Promise<{
    kind: string;
    targetPage?: { url: string };
    devLaunchTarget?: string | null;
    runtimeFreshness?: { stale: boolean };
  }>;
  printState: (state: {
    rendererPort: number;
    debugPort: number;
    debugPids: number[];
    rendererPids: number[];
    targetPage?: { url: string };
  }) => void;
};

const servers: Server[] = [];

function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      servers.push(server);
      resolvePort((server.address() as AddressInfo).port);
    });
  });
}

async function listenIfAvailable(server: Server, host: string): Promise<number | undefined> {
  try {
    return await listen(server, host);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') return undefined;
    throw error;
  }
}

function rendererServer(target?: string): Server {
  return createServer((_req, res) => {
    res.statusCode = 200;
    res.end(
      '<!doctype html><title>DNAForge</title>' +
        (target ? `<meta name="dnaforge-dev-target" content="${target}" />` : '')
    );
  });
}

function cdpServer(pageUrl: string): Server {
  return createServer((req, res) => {
    if (req.url !== '/json/list') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ type: 'page', url: pageUrl }]));
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        })
    )
  );
});

describe('desktop dev single-instance guard', () => {
  it('fails closed instead of defaulting to the installed-app profile when DESKTOP_DEV_PORT is absent', () => {
    expect(() => guard.parseRequiredDesktopDevPort(undefined)).toThrow(/DESKTOP_DEV_PORT/);
    expect(() => guard.parseRequiredDesktopDevPort('')).toThrow(/DESKTOP_DEV_PORT/);
    expect(guard.parseRequiredDesktopDevPort('1452')).toBe(1452);
  });

  it('lets only the non-launching build assertion use the clean-CI probe port', () => {
    expect(guard.resolveDesktopDevPort(undefined, { allowBuildFallback: true })).toBe(1420);
    expect(guard.resolveDesktopDevPort('', { allowBuildFallback: true })).toBe(1420);
    expect(() => guard.resolveDesktopDevPort(undefined)).toThrow(/DESKTOP_DEV_PORT/);
    expect(() => guard.resolveDesktopDevPort('not-a-port', { allowBuildFallback: true })).toThrow(
      /DESKTOP_DEV_PORT/
    );
  });

  it('resolves the build-only fallback in a clean-environment subprocess', () => {
    const guardPath = resolve(__dirname, '../../../scripts/dev-single-instance-guard.cjs');
    const probe = [
      `const guard = require(${JSON.stringify(guardPath)});`,
      'process.stdout.write(String(guard.resolveDesktopDevPort(process.env.DESKTOP_DEV_PORT, { allowBuildFallback: true })));',
    ].join('\n');
    const result = spawnSync(process.execPath, ['-e', probe], {
      encoding: 'utf8',
      env: { ...process.env, DESKTOP_DEV_PORT: '' },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('1420');
  });

  it('makes the default dev command use the guard, not raw electron-vite', () => {
    expect(packageJson.scripts.dev).toBe('node scripts/dev-single-instance-guard.cjs');
    expect(packageJson.scripts.predev).toBeUndefined();
    expect(packageJson.scripts['dev:status']).toBe(
      'node scripts/dev-single-instance-guard.cjs --status'
    );
    expect(packageJson.scripts['dev:restart-stale']).toBe(
      'node scripts/dev-single-instance-guard.cjs --restart-stale'
    );
    expect(packageJson.scripts['dev:hosted-staging']).toBe(
      'node scripts/dev-single-instance-guard.cjs --target=hosted-staging'
    );
    expect(packageJson.scripts['dev:hosted-local']).toBe(
      'node scripts/dev-single-instance-guard.cjs --target=hosted-local'
    );
    expect(packageJson.scripts['dev:raw']).toBe('electron-vite dev');
  });

  it('builds the Git read guardian before the first Windows development launch', () => {
    const guardianPath = 'C:\\source\\resources\\helpers\\guardian.exe';
    let built = false;
    const resolved = guard.ensureWindowsGitReadGuardian({
      platform: 'win32',
      guardianPath,
      pathExists: () => built,
      build: () => {
        built = true;
      },
    });

    expect(built).toBe(true);
    expect(resolved).toBe(guardianPath);
  });

  it('runs the canonical bundled Git provisioner and propagates readiness failure', () => {
    const appDir = resolve('repo', 'apps', 'desktop');
    let invocation:
      | { command: string; args: string[]; options: { cwd: string; stdio: string } }
      | undefined;

    const provisioner = guard.ensureBundledGitRuntime({
      appDir,
      execute: (command, args, options) => {
        invocation = { command, args, options };
      },
    });
    expect(provisioner).toBe(resolve(appDir, 'scripts', 'ensure-dugite-git.cjs'));
    expect(invocation).toEqual({
      command: process.execPath,
      args: [provisioner],
      options: { cwd: appDir, stdio: 'inherit', timeout: 120000, killSignal: 'SIGKILL' },
    });

    expect(() =>
      guard.ensureBundledGitRuntime({
        appDir,
        execute: () => {
          throw new Error('runtime unavailable');
        },
      })
    ).toThrow(/runtime unavailable/);
  });

  it('refreshes an existing Windows Git read guardian before development launch', () => {
    let buildCount = 0;
    const guardianPath = 'C:\\source\\resources\\helpers\\guardian.exe';
    const resolved = guard.ensureWindowsGitReadGuardian({
      platform: 'win32',
      guardianPath,
      pathExists: () => true,
      build: () => {
        buildCount += 1;
      },
    });

    expect(buildCount).toBe(1);
    expect(resolved).toBe(guardianPath);
  });

  it('lets the helper builder own the worktree-local Cargo target on Windows', () => {
    const appDir = resolve('repo', 'apps', 'desktop');
    const guardianPath = resolve(appDir, 'resources', 'helpers', 'guardian.exe');
    let invocation:
      | {
          command: string;
          args: string[];
          options: { cwd: string; env?: NodeJS.ProcessEnv; stdio: string };
        }
      | undefined;

    const resolved = guard.ensureWindowsGitReadGuardian({
      platform: 'win32',
      appDir,
      guardianPath,
      pathExists: () => true,
      execute: (command, args, options) => {
        invocation = { command, args, options };
      },
    });

    expect(resolved).toBe(guardianPath);
    expect(invocation).toEqual({
      command: process.execPath,
      args: [resolve(appDir, 'scripts', 'build-helpers.cjs'), 'dna-process-guardian'],
      options: expect.objectContaining({
        cwd: appDir,
        stdio: 'inherit',
      }),
    });
    expect(invocation?.options).not.toHaveProperty('env');
  });

  it('keeps the generated Windows Git read guardian out of source status', () => {
    const repositoryRoot = resolve(__dirname, '../../../../..');
    const generatedGuardian =
      'apps/desktop/resources/helpers/dna-process-guardian-x86_64-pc-windows-msvc.exe';
    const result = spawnSync('git', ['check-ignore', '--quiet', generatedGuardian], {
      cwd: repositoryRoot,
    });

    expect(result.status).toBe(0);
  });

  it('does not run the Windows guardian build on other platforms', () => {
    let built = false;
    expect(
      guard.ensureWindowsGitReadGuardian({
        platform: 'darwin',
        build: () => {
          built = true;
        },
      })
    ).toBeNull();
    expect(built).toBe(false);
  });

  it('records the active launch target in renderer HTML', () => {
    expect(desktopHtml).toContain(
      '<meta name="dnaforge-dev-target" content="%VITE_DNAFORGE_DEV_TARGET%" />'
    );
  });

  it('applies the Hosted staging profile after file-owned worktree identity', () => {
    const env = guard.devChildEnv({
      env: {},
      launchTarget: HOSTED_STAGING_PROFILE,
    });

    expect(env.WAYPOINT_WEB_BASE_URL).toBe('https://staging.dnaforge.com');
    expect(env.DNAFORGE_HOSTED_AI_GATEWAY_URL).toBe(
      'https://hosted-ai-gateway-staging.up.railway.app'
    );
    expect(env.DNAFORGE_DEV_TARGET).toBe('hosted-staging');
    expect(env.VITE_DNAFORGE_DEV_TARGET).toBe('hosted-staging');
  });

  it('gives the normal Electron child a matched real-account and Hosted service pair', () => {
    const env = guard.devChildEnv({
      env: { DESKTOP_DEV_PORT: '1606' },
      appDir: '/virtual-dnaforge-test/app',
      repoRoot: '/virtual-dnaforge-test',
    });
    expect(env).toMatchObject({
      DESKTOP_DEV_PORT: '1606',
      DESKTOP_DEBUG_PORT: '9406',
      WAYPOINT_WEB_BASE_URL: 'https://dnaforge.com',
      DNAFORGE_HOSTED_AI_GATEWAY_URL: 'https://hosted-ai.dnaforge.com',
      DNAFORGE_DEV_TARGET: 'unmanaged',
    });
  });

  it('keeps a local test account service isolated from the production gateway', () => {
    const env = guard.devChildEnv({
      env: { DESKTOP_DEV_PORT: '1606', WAYPOINT_WEB_BASE_URL: 'http://localhost:3108' },
      appDir: '/virtual-dnaforge-test/app',
      repoRoot: '/virtual-dnaforge-test',
    });
    expect(env.WAYPOINT_WEB_BASE_URL).toBe('http://localhost:3108');
    expect(env.DNAFORGE_HOSTED_AI_GATEWAY_URL).toBeUndefined();
  });

  it('does not pass inherited color suppression to the dev app', () => {
    const env = guard.devChildEnv({
      env: {
        DESKTOP_DEV_PORT: '1606',
        NO_COLOR: '1',
        CI: 'true',
        DNAFORGE_BACKGROUND_WINDOW: '1',
        LS_COLORS: '*.py=35',
        PATH: '/fixture/bin',
      },
      appDir: '/virtual-dnaforge-test/app',
      repoRoot: '/virtual-dnaforge-test',
    });
    expect(env.NO_COLOR).toBeUndefined();
    expect(env).toMatchObject({
      CI: 'true',
      DNAFORGE_BACKGROUND_WINDOW: '1',
      LS_COLORS: '*.py=35',
      PATH: '/fixture/bin',
    });
  });

  it('preserves terminal color choices after the normal dev launch', async () => {
    const env = guard.devChildEnv({
      env: { DESKTOP_DEV_PORT: '1606', NO_COLOR: '1' },
      appDir: '/virtual-dnaforge-test/app',
      repoRoot: '/virtual-dnaforge-test',
    });
    const profile = { id: 'zsh', name: 'zsh', path: '/bin/zsh', args: ['-c', 'true'] };
    const normal = await prepareTerminalShell(profile, null, env);
    expect(normal.env.NO_COLOR).toBeUndefined();
    expect(normal.env.CLICOLOR).toBe('1');
    expect(normal.env.LS_COLORS).toContain('*.fasta=32');
    expect(normal.env.LS_COLORS).toContain('*.py=33');
    const disabled = await prepareTerminalShell({ ...profile, env: { NO_COLOR: '1' } }, null, env);
    expect(disabled.env.NO_COLOR).toBe('1');
    expect(disabled.env.LS_COLORS).toBeUndefined();
    expect(disabled.env.CLICOLOR).toBeUndefined();
  });

  it('refuses a Hosted staging request when the running renderer is local-only', () => {
    expect(() => guard.assertRequestedLaunchTarget(HOSTED_STAGING_PROFILE, null)).toThrow(
      /ELECTRON_DEV_TARGET_MISMATCH/
    );
    expect(() => guard.assertRequestedLaunchTarget(HOSTED_STAGING_PROFILE, 'local')).toThrow(
      /ELECTRON_DEV_TARGET_MISMATCH/
    );
    expect(() =>
      guard.assertRequestedLaunchTarget(HOSTED_STAGING_PROFILE, 'hosted-staging')
    ).not.toThrow();
    expect(() => guard.assertRequestedLaunchTarget(null, 'hosted-staging')).not.toThrow();
  });

  const hostedCampaignContract = resolve(
    __dirname,
    '../../../../../.ci/hosted-codex-harness-qualification.json'
  );

  it.skipIf(!existsSync(hostedCampaignContract))(
    'checks the exact public staging readiness URL before launch',
    async () => {
      const get = async (url: string, timeoutMs: number) => {
        expect(url).toBe('https://hosted-ai-gateway-staging.up.railway.app/readyz');
        expect(timeoutMs).toBe(10_000);
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            status: 'ready',
            environment: 'staging',
            runtimeEnvironment: 'staging',
            mode: 'canary',
            trafficEnabled: true,
            qualificationTrafficEnabled: false,
            catalogVersion: 'staging-catalog-v1',
            deployedGitSha: 'a'.repeat(40),
            canary: {
              campaignId: `fixture-human64-${'a'.repeat(40)}`,
              maxProviderStarts: 64,
              reservationCeilingMicrousd: 10_000_000,
              maxProviderStreamAttempts: 1,
            },
            checks: {
              configuration: true,
              database: true,
              provider: true,
              launchState: 'active',
              maintenance: {
                ready: true,
                recovery: true,
                retention: true,
                deletion: true,
              },
            },
          }),
        };
      };

      await expect(
        guard.runHostedStagingReadinessPreflight(HOSTED_STAGING_PROFILE, get)
      ).resolves.toEqual({
        deployedGitSha: 'a'.repeat(40),
        campaignId: `fixture-human64-${'a'.repeat(40)}`,
        catalogVersion: 'staging-catalog-v1',
      });
      await expect(guard.runHostedStagingReadinessPreflight(null, get)).resolves.toBeNull();
    }
  );

  it('has explicit attach and stale-lock states', () => {
    expect(guardScript).toContain('ELECTRON_DEV_ATTACHED');
    expect(guardScript).toContain("kind: 'stale-renderer'");
    expect(guardScript).toContain("kind: 'stale-debug-port'");
    expect(guardScript).toContain("kind: 'stale-runtime'");
    expect(guardScript).toContain('--restart-stale');
    expect(guardScript).toContain('ELECTRON_DEV_OUTPUT_IN_USE');
    expect(guardScript).toContain("args.has('--assert-stopped')");
    expect(guardScript).toContain('ELECTRON_DEV_TARGET_MISMATCH');
    expect(guardScript).toContain('runHostedStagingReadinessPreflight');
  });

  it('blocks every electron-vite build while dev is using hashed out/main workers', () => {
    expect(electronViteConfig).toContain("command === 'build'");
    expect(electronViteConfig).toContain("'--assert-stopped'");
    expect(electronViteConfig).toContain('dev-single-instance-guard.cjs');
  });

  it('keeps status/attach probes non-mutating by moving predev into startRawDev', () => {
    expect(guardScript).toMatch(/function\s+runStartPreflight\(\s*launchTarget\s*[,)]/);

    const startRawDevBlock = guardScript.slice(
      guardScript.indexOf('function startRawDev('),
      guardScript.indexOf('async function terminatePids')
    );
    expect(startRawDevBlock).toContain('runStartPreflight(launchTarget)');

    const startPreflightBlock = guardScript.slice(
      guardScript.indexOf('function runStartPreflight('),
      guardScript.indexOf('function reportIdentityFailure')
    );
    expect(startPreflightBlock).toContain('prepare-opendataloader-runtime.cjs');
    expect(startRawDevBlock).toContain('ensureAppEnvLocal({ allowExampleCopy: true })');
    expect(startRawDevBlock).toContain('assertWorktreeIdentity');
  });

  it('does not kill existing Electron processes unless restart-stale is requested', () => {
    const staleBranch = guardScript.slice(
      guardScript.indexOf("state.kind === 'stale-renderer'"),
      guardScript.indexOf("state.kind === 'debug-port-conflict'")
    );

    expect(staleBranch).toContain("args.has('--restart-stale')");
    expect(staleBranch).toContain('No process was killed');
    expect(staleBranch).toContain('stopWorktreeStack');
  });

  it('detects a loopback listener even when process ownership is unavailable', async () => {
    const apiPort = await listen(createServer(), '127.0.0.1');

    await expect(guard.tcpPortAcceptsConnections(apiPort)).resolves.toBe(true);
    expect(guardScript).toContain('ELECTRON_DEV_API_PORT_CONFLICT');
    expect(guardScript).toContain('No app was launched and no process was killed');
  });

  it('treats an IPv6 localhost renderer as a healthy attach target', async () => {
    const rendererPort = await listenIfAvailable(rendererServer(), '::1');
    if (rendererPort === undefined) return;

    const debugPort = await listen(cdpServer(`http://localhost:${rendererPort}/`), '127.0.0.1');

    const state = await guard.probe(rendererPort, debugPort);

    expect(state.kind).toBe('healthy');
    expect(state.targetPage?.url).toBe(`http://localhost:${rendererPort}/`);
  });

  it('treats an IPv4 renderer as a healthy attach target', async () => {
    const rendererPort = await listen(rendererServer('hosted-staging'), '127.0.0.1');
    const debugPort = await listen(cdpServer(`http://127.0.0.1:${rendererPort}/`), '127.0.0.1');

    const state = await guard.probe(rendererPort, debugPort);

    expect(state.kind).toBe('healthy');
    expect(state.targetPage?.url).toBe(`http://127.0.0.1:${rendererPort}/`);
    expect(state.devLaunchTarget).toBe('hosted-staging');
  });

  it('reports the guarded renderer origin to attach clients without query credentials', async () => {
    const rendererPort = await listen(rendererServer(), '127.0.0.1');
    const debugPort = await listen(
      cdpServer(`http://127.0.0.1:${rendererPort}/?session=private-test-value`),
      '127.0.0.1'
    );
    const state = await guard.probe(rendererPort, debugPort);
    expect(state.kind).toBe('healthy');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      guard.printState({
        rendererPort,
        debugPort,
        debugPids: [],
        rendererPids: [],
        targetPage: state.targetPage,
      });
      const lines = output.mock.calls.map(([line]) => String(line));
      expect(lines).toContain(`Desktop renderer: http://127.0.0.1:${rendererPort}/`);
      expect(lines.join('\n')).not.toContain('private-test-value');
    } finally {
      output.mockRestore();
    }
  });

  it('reports stale-renderer only when CDP points at a renderer that cannot be reached', async () => {
    const closedRenderer = rendererServer();
    const rendererPort = await listen(closedRenderer, '127.0.0.1');
    servers.pop();
    await new Promise<void>((resolveClose) => closedRenderer.close(() => resolveClose()));

    const debugPort = await listen(cdpServer(`http://localhost:${rendererPort}/`), '127.0.0.1');

    const state = await guard.probe(rendererPort, debugPort);

    expect(state.kind).toBe('stale-renderer');
  });

  it('marks a renderer/CDP target stale when runtime source is newer than Electron main', () => {
    const freshness = guard.evaluateRuntimeSourceFreshness({
      debugPids: [101, 202],
      newestSource: {
        path: resolve(__dirname, '../../lims.ts'),
        mtimeMs: 50_000,
      },
      getProcessStartTimeMs: (pid) => (pid === 101 ? 10_000 : 20_000),
      staleToleranceMs: 1000,
    });

    expect(freshness.stale).toBe(true);
    expect(freshness.oldestProcessStart).toEqual({ pid: 101, startMs: 10_000 });
  });

  it('does not mark runtime source stale when Electron started after the latest source edit', () => {
    const freshness = guard.evaluateRuntimeSourceFreshness({
      debugPids: [101],
      newestSource: {
        path: resolve(__dirname, '../../lims.ts'),
        mtimeMs: 50_000,
      },
      getProcessStartTimeMs: () => 51_000,
      staleToleranceMs: 1000,
    });

    expect(freshness.stale).toBe(false);
  });

  it('checks only runtime source files for stale-main detection', () => {
    expect(guard.isRuntimeSourceFile(resolve(__dirname, '../../lims.ts'))).toBe(true);
    expect(guard.isRuntimeSourceFile(resolve(__dirname, '../../../preload/index.ts'))).toBe(true);
    expect(guard.isRuntimeSourceFile(resolve(__dirname, '../../__tests__/lims.test.ts'))).toBe(
      false
    );
    expect(guard.isRuntimeSourceFile(resolve(__dirname, '../../lims.spec.ts'))).toBe(false);
    expect(guard.isRuntimeSourceFile(resolve(__dirname, '../../fixtures.json'))).toBe(false);
  });
});
