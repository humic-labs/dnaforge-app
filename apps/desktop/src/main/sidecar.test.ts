import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ScriptTarget, transpileModule } from 'typescript';
import { SidecarSessionAuthority } from './sidecar-session-authority';

const sidecarContent = readFileSync(resolve(__dirname, 'sidecar.ts'), 'utf8');
const sidecarProcessTreeContent = readFileSync(
  resolve(__dirname, 'sidecar-process-tree.ts'),
  'utf8'
);
const sidecarRuntimeCapabilityContent = readFileSync(
  resolve(__dirname, 'sidecar-runtime-capability.ts'),
  'utf8'
);
const sidecarBinaryContent = readFileSync(resolve(__dirname, 'sidecar-binary.ts'), 'utf8');
const sidecarCapabilitiesContent = readFileSync(
  resolve(__dirname, 'sidecar-capabilities.ts'),
  'utf8'
);
const coverageCacheEnvContent = readFileSync(resolve(__dirname, 'coverage-cache-env.ts'), 'utf8');
const sidecarCapabilitiesJsonContent = readFileSync(
  resolve(__dirname, 'sidecar-capabilities.json'),
  'utf8'
);
const ipcIndexContent = readFileSync(resolve(__dirname, 'ipc/index.ts'), 'utf8');
const preloadContent = readFileSync(resolve(__dirname, '../preload/index.ts'), 'utf8');
const configContractContent = readFileSync(
  resolve(__dirname, '../shared/ipc/config.contract.ts'),
  'utf8'
);
const generatedInvokeContractContent = readFileSync(
  resolve(__dirname, '../shared/ipc-invoke-contract.generated.ts'),
  'utf8'
);
const preloadTypesContent = readFileSync(resolve(__dirname, '../preload/index.d.ts'), 'utf8');
const mainIndexContent = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
const bootstrapContent = readFileSync(resolve(__dirname, 'bootstrap.ts'), 'utf8');
const electronPreReadyContent = readFileSync(resolve(__dirname, 'electron-pre-ready.ts'), 'utf8');
const apiMainContent = readFileSync(resolve(__dirname, '../../../api/src/main.py'), 'utf8');

describe('sidecar status after native shutdown', () => {
  it.each([
    ['ready', true, false, 'stopped'],
    ['ready', false, true, 'stopped'],
    ['error', true, true, 'stopped'],
    ['ready', false, false, 'ready'],
  ] as const)(
    'reports %s with shutdown=%s and stopped owner=%s as %s',
    async (cached, shutdownRequested, stopped, expected) => {
      const start = sidecarContent.indexOf('export async function refreshSidecarStatus');
      const end = sidecarContent.indexOf('function sendStatus', start);
      const compiled = transpileModule(
        sidecarContent.slice(start, end).replace('export async', 'async'),
        {
          compilerOptions: { target: ScriptTarget.ES2022 },
        }
      ).outputText;
      const authority = new SidecarSessionAuthority({ initialToken: 'session-sentinel' });
      authority.markReady(authority.snapshot().generation);
      if (stopped) authority.markStopped();
      const ensureApiPort = vi.fn();
      const probe = vi.fn();
      const refresh = new Function(
        'lastSidecarStatus',
        'supervisorState',
        'sidecarSessionAuthority',
        'ensureApiPort',
        'probeSidecarHealth',
        'waitForTestRefreshResultLatch',
        'sendStatus',
        `${compiled}; return refreshSidecarStatus;`
      )(cached, { shutdownRequested }, authority, ensureApiPort, probe, vi.fn(), vi.fn());
      expect(await refresh()).toBe(expected);
      expect(ensureApiPort).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
    }
  );
});

describe('Jev credential projection preserves the owned sidecar launches', () => {
  const spawnBody = sidecarContent.slice(
    sidecarContent.indexOf('function spawnSidecarProcess('),
    sidecarContent.indexOf('type SidecarHealthBody =')
  );
  const packagedOffset = spawnBody.indexOf('const binaryPath = resolveSidecarPath()');
  const sourceSpawn = spawnBody.slice(0, packagedOffset);
  const packagedSpawn = spawnBody.slice(packagedOffset);

  it.each([
    ['source', sourceSpawn],
    ['packaged', packagedSpawn],
  ])('projects only the explicit nonempty Jev key after generic scrubbing (%s)', (_mode, code) => {
    const projection =
      /process\.env\.TYPESAFE_API_KEY\s*\?\s*\{\s*TYPESAFE_API_KEY:\s*process\.env\.TYPESAFE_API_KEY\s*\}\s*:\s*\{\}/;
    expect(code).toMatch(projection);
    expect(code.indexOf("...subprocessEnv('sidecar')")).toBeGreaterThan(-1);
    expect(code.indexOf('TYPESAFE_API_KEY')).toBeGreaterThan(
      code.indexOf("...subprocessEnv('sidecar')")
    );
    expect(code.match(/TYPESAFE_API_KEY:\s*process\.env\.TYPESAFE_API_KEY/g)).toHaveLength(1);
    expect(code).not.toMatch(/\.\.\.process\.env\b/);
    expect(code).not.toMatch(
      /(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|JEV_TOKEN|TYPESAFE_FUTURE_TOKEN)\s*:/
    );
    expect(code).toContain('...agentSessionEnv(snapshot)');
    expect(code).toContain('...sidecarControlPlaneEnv({');
    expect(code).toContain('...computeManifestEnvironment({');
  });

  it('retains the shared source entrypoint, owner watchdog and packaged guardian launch', () => {
    expect(sourceSpawn).toContain('resolveDevelopmentSidecarLaunch({');
    expect(sourceSpawn).toContain('return spawn(sourceLaunch.executable, [...sourceLaunch.args]');
    expect(sourceSpawn).toContain('...sourceLaunch.ownerEnv');
    expect(packagedSpawn).toContain('resolvePackagedSidecarLaunch({');
    expect(packagedSpawn).toContain('return spawn(launch.executable, [...launch.args]');
    expect(packagedSpawn).toContain('...packagedSidecarOwnerEnv(process.pid)');
    expect(packagedSpawn).toContain('guardianPath: resolveProcessGuardianPath({');
  });
});

describe('sidecar port delegation', () => {
  it('imports getApiPort from config module (delegates port logic)', () => {
    expect(sidecarContent).toMatch(/import\s*\{[^}]*\bgetApiPort\b[^}]*\}\s*from\s*'\.\/config'/);
  });

  it('does NOT define its own getApiPort function', () => {
    expect(sidecarContent).not.toContain('function getApiPort');
  });

  it('does NOT use __ENV_API_PORT__ build-time injection', () => {
    expect(sidecarContent).not.toContain('__ENV_API_PORT__');
  });

  it('does NOT use __dirname for path resolution', () => {
    expect(sidecarContent).not.toContain('__dirname');
  });

  it('does NOT parse .env.local itself', () => {
    expect(sidecarContent).not.toMatch(/readFileSync\([^)]*\.env\.local/);
    expect(sidecarContent).not.toContain('.env.local');
  });
});

describe('sidecar version handshake', () => {
  it('isAlreadyRunning parses app_version from the health response', () => {
    expect(sidecarContent).toMatch(/app_version/);
  });

  it('isAlreadyRunning delegates authenticated health refusals to the ownership classifier', () => {
    expect(sidecarContent).toContain('isSidecarOwnershipMismatch(res.status, failureBody)');
    expect(sidecarContent).toMatch(/reason: 'session-mismatch'/);
  });

  it('isAlreadyRunning compares the sidecar version against app.getVersion()', () => {
    expect(sidecarContent).toMatch(/app\.getVersion\(\)/);
  });

  it('isAlreadyRunning proves ownership with one non-redirecting authenticated health request', () => {
    const probe = sidecarContent.slice(
      sidecarContent.indexOf('async function probeSidecarHealth'),
      sidecarContent.indexOf('async function isAlreadyRunning')
    );
    expect(probe).toContain("'X-DNAForge-Session': snapshot.token");
    expect(probe).toContain("redirect: 'manual'");
    expect(probe).not.toContain('health_proof');
  });

  it('spawned sidecar process receives WAYPOINT_APP_VERSION in its env', () => {
    expect(sidecarContent).toContain('WAYPOINT_APP_VERSION');
  });

  it('finishes interrupted custom-provider removals before probing or launching the sidecar', () => {
    const bootstrap = sidecarContent.slice(
      sidecarContent.indexOf('async function startSidecarBootstrap'),
      sidecarContent.indexOf('async function launchSidecar')
    );
    expect(bootstrap).toContain('finalizeInterruptedComputeManifestRemovals');
    expect(bootstrap.indexOf('finalizeInterruptedComputeManifestRemovals')).toBeLessThan(
      bootstrap.indexOf('probeAlreadyRunning')
    );
  });

  it('binds authenticated health to an intrinsic sidecar source identity', () => {
    expect(sidecarContent).not.toContain('WAYPOINT_BUILD_SOURCE_FINGERPRINT:');
    expect(sidecarContent).toContain('__WAYPOINT_SIDECAR_SOURCE_FINGERPRINT__');
    expect(sidecarContent).toContain("reason: 'sidecar-source-mismatch'");
    expect(sidecarContent).toContain('export async function getSidecarSourceFingerprint()');
  });

  it('spawned sidecar process receives the coverage-pyramid cache env the API reads', () => {
    expect(sidecarContent).toContain('buildCoverageCacheEnv');
    const pyramidEnvMatches =
      coverageCacheEnvContent.match(/WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR/g) ?? [];
    expect(pyramidEnvMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('spawned sidecar process receives the persistent indexed-track range cache route', () => {
    expect(coverageCacheEnvContent).toContain('WAYPOINT_INDEXED_TRACK_RANGE_CACHE_DIR');
    expect(coverageCacheEnvContent).toContain('WAYPOINT_INDEXED_TRACK_RANGE_CACHE_BYTES');
  });

  it('spawned sidecar process receives the packaged helper binary directory', () => {
    expect(sidecarContent).toContain('function helperBinariesEnv');
    expect(sidecarContent).toContain('DNAFORGE_HELPERS_DIR');
    expect(sidecarContent).toContain("join(dirname(process.resourcesPath), 'Helpers')");
    expect(sidecarContent).toContain('apps/desktop/resources/helpers');
  });

  it('spawned sidecar process receives an MCP session token', () => {
    expect(sidecarContent).toContain('function agentSessionEnv');
    expect(sidecarContent).toContain('DNAFORGE_MCP_SESSION_TOKEN');
    expect(sidecarContent).toContain('DNAFORGE_SIDECAR_SESSION_GENERATION');
    expect(sidecarContent).toContain('DNAFORGE_MCP_GRANT_CAPABILITIES');
    expect(sidecarContent).toContain('snapshot.token');
    expect(sidecarContent).not.toContain(
      'process.env.DNAFORGE_MCP_SESSION_TOKEN ?? rendererBridge?.sessionToken'
    );
  });

  it('default sidecar grants cover the shipped structure resolver and viewer routes', () => {
    expect(sidecarContent).toContain('buildSidecarGrantCapabilities');
    expect(sidecarCapabilitiesJsonContent).toContain('"external-fetch:annotation"');
    expect(sidecarCapabilitiesJsonContent).toContain('"external-fetch:xref-resolution"');
    expect(sidecarCapabilitiesJsonContent).toContain('"external-fetch:structure"');
    expect(sidecarCapabilitiesJsonContent).toContain('"external-fetch:homology-search"');
  });

  it('health handshake rejects sidecars missing required tile route features', () => {
    expect(sidecarContent).toMatch(/route_features/);
    expect(sidecarContent).toContain('REQUIRED_SIDECAR_ROUTE_FEATURES');
    expect(sidecarContent).toContain('tiles.coverage-readiness.v1');
    expect(sidecarContent).toContain('tiles.coverage-assembly.v1');
    expect(sidecarContent).toContain("reason: 'missing-route-features'");
    expect(sidecarContent).toContain('details: { missing: missingRouteFeatures }');
  });

  it('binds runtime provenance to the sidecar process supervised by Electron', () => {
    expect(sidecarContent).toContain('export function getSidecarProcessPid(): number | null');
    expect(sidecarContent).toContain('const pid = sidecarProcess?.pid');
    expect(ipcIndexContent).toContain('sidecarPid: getSidecarProcessPid()');
  });

  it('health handshake still rejects sidecars whose grants cannot load structures', () => {
    expect(sidecarContent).toMatch(/mcp_grant_capabilities/);
    expect(sidecarContent).toContain("reason: 'missing-capabilities'");
    expect(sidecarContent).toContain('details: { missing: missingCapabilities }');
  });

  it('health handshake rejects a sidecar that exposes tile routes without a BAM runtime', () => {
    expect(sidecarContent).toMatch(/runtime_capabilities/);
    expect(sidecarContent).toContain('REQUIRED_SIDECAR_RUNTIME_CAPABILITIES');
    expect(sidecarRuntimeCapabilityContent).toContain('genome.pysam-htslib.v1');
    expect(sidecarContent).toContain("reason: 'missing-runtime-capabilities'");
    expect(sidecarContent).toContain('details: { missing: missingRuntimeCapabilities }');
  });

  it('scopes the missing-runtime exception to the explicit non-BAM E2E lane', () => {
    expect(sidecarContent).toContain('shouldRequireGenomeRuntime');
    expect(sidecarContent).toContain('WAYPOINT_E2E_ALLOW_INCOMPLETE_GENOME_RUNTIME');
    expect(sidecarContent).toMatch(/if \(genomeRuntimeRequired\(\)\)/);
  });

  it('preflights the exact dev Python runtime before BrowserWindow creation', () => {
    const preflight = mainIndexContent.indexOf('preflightSidecarRuntime();');
    const windowCreations = [
      ...mainIndexContent.matchAll(/const mainWindow = await createWindow\(\);/g),
    ].map((match) => match.index);
    const cutoverGuard = mainIndexContent.indexOf('if (isMacTeamIdCutoverBuild())');
    const cutoverWindowLog = mainIndexContent.indexOf(
      "appendBootLog('mac_team_id_cutover_window_created')"
    );
    const normalWindowLog = mainIndexContent.indexOf("appendBootLog('main_window_created')");

    expect(preflight).toBeGreaterThan(0);
    expect(windowCreations).toHaveLength(2);
    expect(windowCreations[0]).toBeGreaterThan(cutoverGuard);
    expect(windowCreations[0]).toBeLessThan(cutoverWindowLog);
    expect(windowCreations[0]).toBeLessThan(preflight);
    expect(windowCreations[1]).toBeGreaterThan(preflight);
    expect(windowCreations[1]).toBeLessThan(normalWindowLog);
    expect(sidecarContent).toContain('assertDevGenomeRuntime(python, {');
    expect(sidecarContent).toContain('assertPackagedGenomeRuntime(executable, {');
    expect(sidecarContent).toContain('packagedGenomeRuntimeReceipt = receipt');
    expect(sidecarContent).toContain('dnaforge.genome-runtime-unavailable.v1');
  });

  it('spawned sidecar process receives packaged-safe agent manifest path', () => {
    expect(sidecarContent).toContain('function agentToolsManifestEnv');
    expect(sidecarContent).toContain('DNAFORGE_AGENT_TOOLS_DIR');
    expect(sidecarContent).toContain("join(process.resourcesPath, 'agent-tools')");
    expect(sidecarContent).toContain("join(apiDir, '../../packages/core/agent-tools')");
  });

  it('logs a clear rejection message when a mismatched sidecar is found', () => {
    expect(sidecarContent).toContain('describeHealthProbeFailure');
    expect(sidecarContent).toMatch(/Rejecting orphaned sidecar|session-mismatch/i);
  });

  it('version check is bypassed in the explicit E2E test harness (CI-preboot compatibility)', () => {
    expect(sidecarContent).toMatch(/NODE_ENV.*['"]test['"]/);
    expect(sidecarContent).toMatch(/WAYPOINT_TEST.*['"]1['"]/);
    expect(sidecarContent).toContain('isSidecarTestHarness');
  });

  it('lets identity-sensitive E2E tests require the real session ownership handshake', () => {
    expect(sidecarContent).toContain('WAYPOINT_E2E_REQUIRE_SESSION_MATCH');
    expect(sidecarContent).toMatch(/isSidecarTestHarness\(\).*WAYPOINT_E2E_REQUIRE_SESSION_MATCH/s);
  });

  it('already-running detection honors the CI/test health timeout', () => {
    const alreadyRunningStart = sidecarContent.indexOf('async function probeAlreadyRunning');
    const alreadyRunningEnd = sidecarContent.indexOf('export async function startSidecar');
    const alreadyRunningBlock = sidecarContent.slice(alreadyRunningStart, alreadyRunningEnd);

    expect(alreadyRunningBlock).toContain('probeSidecarHealth(snapshot)');
    expect(alreadyRunningBlock).not.toContain('probeSidecarHealth(1000)');
  });

  it('does not spawn after an existing listener fails the ownership handshake', () => {
    const bootstrapStart = sidecarContent.indexOf('async function startSidecarBootstrap');
    const bootstrapEnd = sidecarContent.indexOf('async function launchSidecar', bootstrapStart);
    const bootstrap = sidecarContent.slice(bootstrapStart, bootstrapEnd);
    const mismatch = bootstrap.indexOf("existingProbe.state === 'mismatch'");
    const launch = bootstrap.indexOf("launchSidecar('initial')");

    expect(mismatch).toBeGreaterThan(0);
    expect(bootstrap.slice(mismatch, launch)).toContain('reportExistingSidecarMismatch');
    expect(bootstrap.slice(mismatch, launch)).toContain('return');
  });

  it('pull-on-demand status refresh promotes a healthy sidecar to ready', () => {
    const refreshStart = sidecarContent.indexOf('export async function refreshSidecarStatus');
    const refreshEnd = sidecarContent.indexOf('function sendStatus', refreshStart);
    const refreshBlock = sidecarContent.slice(refreshStart, refreshEnd);

    expect(refreshBlock).toContain('probeSidecarHealth(snapshot)');
    expect(refreshBlock).toContain("result.state === 'ok'");
    expect(refreshBlock).toContain("result.state === 'mismatch'");
    expect(refreshBlock).toContain("sendStatus(mainWindow, 'ready')");
    expect(refreshBlock).not.toContain("lastSidecarStatus = 'ready'");
  });

  it('pollHealthCheck reuses the version check via probeSidecarHealth', () => {
    expect(sidecarContent).toMatch(/probeSidecarHealth/);
    expect(sidecarContent).toMatch(/state: ['"]ok['"]/);
    expect(sidecarContent).toMatch(/state: ['"]mismatch['"]/);
    expect(sidecarContent).toMatch(/state: ['"]unreachable['"]/);
  });

  it('health mismatch diagnostics expose the exact failed contract', () => {
    expect(sidecarContent).toContain('function describeHealthProbeFailure');
    expect(sidecarContent).toContain("reason: 'missing-route-features'");
    expect(sidecarContent).toContain("reason: 'version-mismatch'");
    expect(sidecarContent).toContain("reason: 'session-mismatch'");
    expect(sidecarContent).toContain('reason: describeHealthProbeFailure(result)');
  });

  it('pollHealthCheck fails loudly on version mismatch (does not mark ready)', () => {
    const pollBlock = sidecarContent.match(/async function pollHealthCheck[\s\S]*?^\}/m);
    expect(pollBlock).not.toBeNull();
    expect(pollBlock![0]).toMatch(/mismatch/);

    expect(pollBlock![0]).toMatch(/sendStatus\([^,]+,\s*['"]error['"]\)/);
  });
});

describe('agent tool manifest packaging', () => {
  const buildSidecarScript = readFileSync(
    resolve(__dirname, '../../../api/scripts/build-sidecar.sh'),
    'utf8'
  );
  const builderConfig = readFileSync(resolve(__dirname, '../../electron-builder.yml'), 'utf8');
  const verifyPackageScript = readFileSync(
    resolve(__dirname, '../../scripts/verify-package.cjs'),
    'utf8'
  );

  it('bundles shared manifests into both sidecar and Electron package resources', () => {
    expect(buildSidecarScript).toContain('packages/core/agent-tools');
    expect(buildSidecarScript).toContain(
      '--include-data-dir="$AGENT_TOOLS_DIR=packages/core/agent-tools"'
    );
    expect(builderConfig).toContain('../../packages/core/agent-tools/');
    expect(builderConfig).toContain('to: agent-tools/');
    expect(verifyPackageScript).toContain('Resources/agent-tools/');
    expect(verifyPackageScript).toContain('renderer-tool-manifest.json');
    expect(verifyPackageScript).toContain('workflow-manifest.json');
  });

  it('packages and verifies the compute provider catalog beside the sidecar', () => {
    expect(builderConfig).toContain('../../packages/core/compute-endpoints/manifests/');
    expect(builderConfig).toContain('to: compute-endpoints/manifests/');
    expect(verifyPackageScript).toContain('Resources/compute-endpoints/manifests/');
    expect(verifyPackageScript).toContain('replicate.json');
  });

  it('does not follow sentry_sdk into the frozen sidecar bundle', () => {
    expect(buildSidecarScript).toContain('--nofollow-import-to=sentry_sdk');
  });

  it('executes the frozen MCP import and stdio path during package verification', () => {
    expect(verifyPackageScript).toContain("spawnSync(packagedSidecar, ['--mcp-stdio']");
    expect(verifyPackageScript).toContain("input: ''");
    expect(verifyPackageScript).toContain('verify_packaged_mcp.py');
    expect(verifyPackageScript).toContain('raw 2024 legacy, and real grant/job route MCP calls');
    expect(verifyPackageScript).not.toContain("spawnSync(packagedSidecar, ['--help']");
  });
});

describe('sidecar dev mode python resolution', () => {
  it('checks local venv first, then primary repo venv via the shared resolver', () => {
    expect(sidecarBinaryContent).toContain("join(apiDir, '.venv', 'bin', 'python3')");
    expect(sidecarBinaryContent).toContain("join(apiDir, '.venv', 'Scripts', 'python.exe')");

    expect(sidecarBinaryContent).toContain("['worktree', 'list', '--porcelain']");
  });

  it('uses git worktree list to find main repo python', () => {
    expect(sidecarBinaryContent).toContain(
      "execFileSync('git', ['worktree', 'list', '--porcelain']"
    );
    expect(sidecarBinaryContent).toContain('cwd: apiDir');
    expect(sidecarBinaryContent).toContain("readFileSync(join(worktreeRoot, '.git')");
  });

  it('fails loudly with setup instructions when NO venv found anywhere', () => {
    expect(sidecarBinaryContent).toContain('Python venv not found');
    expect(sidecarBinaryContent).toContain('uv sync --extra dev');
  });

  it('does NOT silently fall back to system python3', () => {
    expect(sidecarBinaryContent).not.toMatch(/['"]python3['"]\s*;/);
    expect(sidecarBinaryContent).not.toContain("? localVenv : 'python3'");
  });

  it('resolves api dir as sibling of desktop (dirname once)', () => {
    expect(sidecarBinaryContent).toContain("join(dirname(appPath), 'api')");
    expect(sidecarBinaryContent).not.toContain('dirname(dirname(appPath))');
  });

  it('logs which python path it is using', () => {
    expect(sidecarContent).toContain('python:');
  });
});

describe('sidecar health check guards', () => {
  it('aborts health check if sidecar process already exited', () => {
    expect(sidecarContent).toContain('!sidecarProcess');
    expect(sidecarContent).toContain('aborting health check');
  });

  it('checks process is still alive during health check polling', () => {
    const healthCheckFn = sidecarContent.slice(
      sidecarContent.indexOf('function pollHealthCheck'),
      sidecarContent.indexOf('export async function killSidecar')
    );

    expect(healthCheckFn).toContain('for (');
    const forLoopStart = healthCheckFn.indexOf('for (');
    const processCheck = healthCheckFn.indexOf('!sidecarProcess', forLoopStart);
    expect(processCheck).toBeGreaterThan(forLoopStart);
  });

  it('binds health polling and timeout cleanup to the exact launch child', () => {
    const healthCheckFn = sidecarContent.slice(
      sidecarContent.indexOf('async function pollHealthCheck'),
      sidecarContent.indexOf('function scheduleRestart')
    );
    expect(healthCheckFn).toContain('sidecarProcess !== launchedChild');
    expect(healthCheckFn).toContain('launchId !== supervisorState.launchId');
    expect(healthCheckFn).toMatch(
      /terminateCurrentSidecarForRestart\(\s*launchId,\s*launchedChild,\s*'health_timeout'/
    );
    expect(healthCheckFn).toMatch(
      /if \(launchId !== supervisorState\.launchId \|\| sidecarProcess !== launchedChild\) return/
    );
  });
});

describe(' sidecar telemetry crash hardening', () => {
  it('does not import or initialize sentry_sdk inside the Python sidecar', () => {
    expect(apiMainContent).not.toContain('import sentry_sdk');
    expect(apiMainContent).not.toContain('sentry_sdk.init');
  });

  it('main-process sidecar telemetry captures lifecycle events and stderr tail', () => {
    expect(sidecarContent).toContain('trackSidecarLifecycleEvent');
    expect(sidecarContent).toContain('captureSidecarLifecycleEvent');
    expect(sidecarContent).toContain('appendStderrTail');
    expect(sidecarContent).toContain('sidecarStderrTail');
  });
});

describe(' sidecar supervisor', () => {
  it('bounds auto-respawn attempts and schedules restarts with backoff', () => {
    expect(sidecarContent).toContain('MAX_AUTO_RESTART_ATTEMPTS');
    expect(sidecarContent).toContain('RESTART_BACKOFF_MS');
    expect(sidecarContent).toContain('function scheduleRestart');
    expect(sidecarContent).toContain('restartAttempts');
    expect(sidecarContent).toContain('originatingLaunchId !== supervisorState.launchId');
  });

  it('does not respawn during intentional app shutdown', () => {
    expect(sidecarContent).toContain('intentionalStop');
    expect(sidecarContent).toMatch(/supervisorState\.intentionalStop\s*=\s*true/);
    expect(sidecarContent).toMatch(
      /if\s*\(\s*!supervisorState\.started\s*\|\|\s*supervisorState\.intentionalStop\s*\|\|\s*supervisorState\.shutdownRequested\s*\)\s*return/
    );
  });

  it('exposes a manual restart IPC path through preload types', () => {
    expect(sidecarContent).toContain('export function restartSidecar(): Promise<void>');
    expect(ipcIndexContent).toContain('restartSidecar:');
    expect(configContractContent).toContain('restartSidecar: invoke<[], string>()');
    expect(preloadContent).toContain('...createClient(configContract)');
    expect(preloadTypesContent).toContain('config: ClientOf<typeof configContract>');
  });

  it('manual restart does not reuse a stale in-flight launch promise', () => {
    const restart = sidecarContent.slice(
      sidecarContent.indexOf('async function performRestartSidecar'),
      sidecarContent.indexOf('export async function killSidecar')
    );
    const clearStarting = restart.indexOf('supervisorState.starting = null');
    expect(clearStarting).toBeGreaterThan(restart.indexOf('await stopOwnedSidecarProcess(child)'));
    expect(clearStarting).toBeLessThan(restart.indexOf("await launchSidecar('manual_restart')"));
    expect(restart).toMatch(
      /supervisorState\.starting\s*=\s*null;[\s\S]*await launchSidecar\('manual_restart'\)/
    );
  });

  it('coalesces overlapping manual restarts behind one replacement launch', () => {
    expect(sidecarContent).toContain('let restartPromise: Promise<void> | null = null');
    expect(sidecarContent).toContain('if (restartPromise) return restartPromise');
    expect(sidecarContent).toContain('const tracked = performRestartSidecar()');
    expect(sidecarContent).toContain("sendStatus(mainWindow, 'error')");
  });

  it('latches shutdown across bootstrap awaits and performs a final child sweep', () => {
    expect(sidecarContent).toContain('shutdownRequested: boolean');
    expect(sidecarContent).toMatch(
      /await ensureApiPort\(\);\s+if \(supervisorState\.shutdownRequested\) return/
    );
    expect(sidecarContent).toMatch(
      /await waitForTestPreSpawnDelay\(\);\s+if \(supervisorState\.shutdownRequested\) return/
    );
    expect(sidecarContent).toMatch(
      /await stopCurrentChild\(\);[\s\S]*Promise\.allSettled\(inFlight\)[\s\S]*await stopCurrentChild\(\)/
    );
  });

  it('manual restart preserves only an externally owned compatible sidecar', () => {
    const restartStart = sidecarContent.indexOf('async function performRestartSidecar');
    const killCheck = sidecarContent.indexOf('if (sidecarProcess)', restartStart);
    const compatibleCheck = sidecarContent.indexOf(
      'await probeAlreadyRunning(currentSession)',
      restartStart
    );
    const manualLaunch = sidecarContent.indexOf(
      "await launchSidecar('manual_restart')",
      restartStart
    );

    expect(compatibleCheck).toBeGreaterThan(killCheck);
    expect(compatibleCheck).toBeLessThan(manualLaunch);
    expect(sidecarContent.slice(killCheck, compatibleCheck)).toContain(
      "currentSession.owner === 'external'"
    );
    expect(sidecarContent.slice(compatibleCheck, manualLaunch)).toContain(
      "sendStatus(mainWindow, 'ready')"
    );
    expect(sidecarContent.slice(compatibleCheck, manualLaunch)).toContain(
      'reportExistingSidecarMismatch'
    );
  });

  it('manual restart reports restarting before async cleanup or launch work can fail', () => {
    const restartStart = sidecarContent.indexOf('async function performRestartSidecar');
    const restartBlock = sidecarContent.slice(
      restartStart,
      sidecarContent.indexOf('export async function killSidecar', restartStart)
    );

    expect(restartBlock.indexOf("sendStatus(mainWindow, 'restarting')")).toBeGreaterThan(-1);
    expect(restartBlock.indexOf("sendStatus(mainWindow, 'restarting')")).toBeLessThan(
      restartBlock.indexOf('if (sidecarProcess)')
    );
  });

  it('manual restart reports a terminal error when cleanup or launch work fails', () => {
    const restartStart = sidecarContent.indexOf('export function restartSidecar');
    const restartEnd = sidecarContent.indexOf('async function performRestartSidecar', restartStart);
    const restartBlock = sidecarContent.slice(restartStart, restartEnd);

    expect(restartBlock).toContain("recordSidecarLifecycle('manual_restart_failed'");
    expect(restartBlock).toContain("sendStatus(mainWindow, 'error')");
    expect(restartBlock.indexOf("sendStatus(mainWindow, 'error')")).toBeLessThan(
      restartBlock.indexOf('throw error')
    );
  });

  it('awaits process-tree termination before automatic respawn and app shutdown', () => {
    const timeoutTermination = sidecarContent.indexOf(
      "await terminateCurrentSidecarForRestart(launchId, launchedChild, 'health_timeout')"
    );
    const timeoutRestart = sidecarContent.indexOf(
      "scheduleRestart('health_timeout', launchId)",
      timeoutTermination
    );
    const shutdownStart = sidecarContent.indexOf('export async function killSidecar');
    const shutdownEnd = sidecarContent.length;

    expect(timeoutTermination).toBeGreaterThan(-1);
    expect(timeoutRestart).toBeGreaterThan(timeoutTermination);
    expect(sidecarContent.slice(shutdownStart, shutdownEnd)).toContain(
      'await stopOwnedSidecarProcess(child)'
    );
    expect(sidecarProcessTreeContent).toContain('const pids = sidecarProcessTree(child)');
    expect(sidecarProcessTreeContent).toContain("signalPids(stillLive, 'SIGKILL')");
    expect(sidecarProcessTreeContent).toContain('surviving PIDs');
  });

  it('restart IPC acknowledges the request instead of returning a transient launch failure', () => {
    const handlerStart = ipcIndexContent.indexOf('restartSidecar: () =>');
    const handlerEnd = ipcIndexContent.indexOf('\n  });', handlerStart);
    const handlerBlock = ipcIndexContent.slice(handlerStart, handlerEnd);

    expect(handlerBlock).toContain('void restartSidecar().catch');
    expect(handlerBlock).toContain('return getLastSidecarStatus()');
    expect(handlerBlock).not.toContain('await restartSidecar()');
  });

  it('status IPC refreshes health instead of serving a stale failed cache', () => {
    const handlerStart = ipcIndexContent.indexOf('getSidecarStatus: ');
    const handlerEnd = ipcIndexContent.indexOf('restartSidecar: () =>', handlerStart);
    const handlerBlock = ipcIndexContent.slice(handlerStart, handlerEnd);

    expect(handlerBlock).toContain('refreshSidecarStatus()');
    expect(handlerBlock).not.toContain('getLastSidecarStatus()');
  });

  it('does not let a status poll promote the terminating generation during restart', () => {
    const refreshStart = sidecarContent.indexOf('export async function refreshSidecarStatus');
    const refreshEnd = sidecarContent.indexOf('function sendStatus', refreshStart);
    const refreshBlock = sidecarContent.slice(refreshStart, refreshEnd);

    expect(refreshBlock).toContain("lastSidecarStatus === 'restarting'");
    expect(refreshBlock.indexOf("lastSidecarStatus === 'restarting'")).toBeLessThan(
      refreshBlock.indexOf('probeSidecarHealth')
    );
    expect(refreshBlock).toContain('sidecarSessionAuthority.isCurrent(snapshot)');
    expect(refreshBlock.indexOf('sidecarSessionAuthority.isCurrent(snapshot)')).toBeLessThan(
      refreshBlock.indexOf("result.state === 'ok'")
    );
  });

  it('manual restart cleanup consumes suppressed exits even after a new launch starts', () => {
    const exitHandlerStart = sidecarContent.indexOf("launchedChild.on('exit'");
    const errorHandlerStart = sidecarContent.indexOf("launchedChild.on('error'", exitHandlerStart);
    const exitHandler = sidecarContent.slice(exitHandlerStart, errorHandlerStart);

    expect(exitHandler.indexOf('restartTerminatedLaunches.delete(launchId)')).toBeGreaterThan(-1);
    expect(exitHandler.indexOf('restartTerminatedLaunches.delete(launchId)')).toBeLessThan(
      exitHandler.indexOf('launchId !== supervisorState.launchId')
    );
  });
});

describe('main/index.ts wiring', () => {
  const indexContent = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');

  it('imports loadConfig', () => {
    expect(indexContent).toMatch(/import\s+\{[^}]*\bloadConfig\b[^}]*\}\s+from\s+'\.\/config'/);
  });

  it('calls loadConfig before other initialization', () => {
    const initBlock = indexContent.slice(indexContent.indexOf('async function init'));
    const loadConfigPos = initBlock.indexOf('loadConfig');
    const registerPos = initBlock.indexOf('registerAllIpcHandlers');
    const sidecarPos = initBlock.indexOf('startSidecar');

    expect(loadConfigPos).toBeGreaterThan(0);
    expect(registerPos).toBeGreaterThan(loadConfigPos);
    expect(sidecarPos).toBeGreaterThan(loadConfigPos);
  });

  it('resolves the sidecar port before the request interceptor can read its URL', () => {
    const initBlock = indexContent.slice(indexContent.indexOf('async function init'));
    const loadConfigPos = initBlock.indexOf('loadConfig');
    const ensureApiPortPos = initBlock.indexOf('await ensureApiPort();');
    const interceptorPos = initBlock.indexOf('onBeforeSendHeaders');
    const normalWindowPos = initBlock.lastIndexOf('await createWindow()');

    expect(ensureApiPortPos).toBeGreaterThan(loadConfigPos);
    expect(interceptorPos).toBeGreaterThan(ensureApiPortPos);
    expect(normalWindowPos).toBeGreaterThan(ensureApiPortPos);
  });

  it('delivers a CLI workspace through the renderer-listener readiness handshake', () => {
    const deliveryStart = indexContent.indexOf('function sendWorkspacePathToRenderer');
    const deliveryEnd = indexContent.indexOf('async function init', deliveryStart);
    const deliveryBlock = indexContent.slice(deliveryStart, deliveryEnd);

    expect(deliveryBlock).toContain('workspaceSetPathDelivery.queue');
    expect(deliveryBlock).not.toContain('setTimeout');
    expect(indexContent).toContain("mainIpc.on('workspace:set-path-listener-ready'");
    expect(indexContent).toContain('workspaceSetPathDelivery.markReady(event.sender)');
    expect(preloadContent).toContain("rendererIpc.send('workspace:set-path-listener-ready')");
  });

  it('keeps the sidecar token out of renderer preload and injects it at the network boundary', () => {
    const headerHook = mainIndexContent.slice(
      mainIndexContent.indexOf('session.defaultSession.webRequest.onBeforeSendHeaders('),
      mainIndexContent.indexOf('session.defaultSession.webRequest.onHeadersReceived(')
    );
    const headerHandlerContent = readFileSync(
      resolve(__dirname, 'compute/credential-injection.ts'),
      'utf8'
    );
    expect(preloadContent).not.toContain('sidecarSession:');
    expect(preloadTypesContent).not.toContain('sidecarSession: string | null');
    expect(mainIndexContent).toContain('isTrustedSidecarRequestOwner');
    expect(headerHook).toMatch(
      /onBeforeSendHeaders\(\s*SIDECAR_AUTH_REQUEST_FILTER,\s*createSidecarRequestHeaderHandler\(\{/
    );
    expect(headerHook).toContain('authority: sidecarSessionAuthority');
    expect(headerHandlerContent).toContain('injectReadySidecarSessionHeader({');
    expect(headerHandlerContent).toContain('callback({ cancel: true })');
  });

  it('has EPIPE protection on process.stdout before any app logic', () => {
    expect(indexContent).toContain("process.stdout.on('error'");
    expect(indexContent).toContain("process.stderr.on('error'");
    expect(indexContent).toContain("process.on('uncaughtException'");

    const stdoutHandler = indexContent.indexOf("process.stdout.on('error'");
    const whenReady = indexContent.indexOf('.whenReady()');
    expect(stdoutHandler).toBeGreaterThan(-1);
    expect(whenReady).toBeGreaterThan(-1);
    expect(stdoutHandler).toBeLessThan(whenReady);
  });

  it('enables Linux plaintext safeStorage for WAYPOINT_TEST/--e2e before ready', () => {
    expect(electronPreReadyContent).toContain('setUsePlainTextEncryption(true)');
    expect(electronPreReadyContent).toContain('configureLinuxTestSafeStorage');
    expect(electronPreReadyContent).not.toContain('app.whenReady()');
    const configureCall = bootstrapContent.indexOf('configureElectronBeforeReady()');
    const whenReady = bootstrapContent.indexOf('app.whenReady()');
    expect(configureCall).toBeGreaterThan(-1);
    expect(configureCall).toBeLessThan(whenReady);
  });

  it('passes deterministic renderer bridge settings only in WAYPOINT_TEST mode', () => {
    const testHooksContent = readFileSync(resolve(__dirname, 'features/test-hooks.ts'), 'utf8');
    expect(testHooksContent).toContain('function testRendererBridgeOptions');
    expect(testHooksContent).toContain("process.env.WAYPOINT_TEST !== '1'");
    expect(testHooksContent).toContain('DNAFORGE_RENDERER_BRIDGE_PORT');
    expect(testHooksContent).toContain('DNAFORGE_RENDERER_BRIDGE_TOKEN');
    const bridgeContent = readFileSync(
      resolve(__dirname, 'features/agent-tools-bridge.ts'),
      'utf8'
    );
    expect(bridgeContent).toMatch(
      /startAgentToolsBridge\(mainWindow,\s*\{\s*\.\.\.testRendererBridgeOptions\(\),/u
    );
    expect(indexContent).toContain('startBridge: () => agentToolsBridge.start(mainWindow),');
  });

  it('allows packaged E2E to opt into a visible first BrowserWindow', () => {
    expect(indexContent).toContain('WAYPOINT_PACKAGED_E2E_SHOW_WINDOW');
    expect(indexContent).toContain('show: showWindow');
  });
});

describe('agent tools bridge test observer', () => {
  const bridgeContent = readFileSync(resolve(__dirname, 'agent-tools-bridge.ts'), 'utf8');
  const observerContent = readFileSync(resolve(__dirname, 'renderer-ui-observation.ts'), 'utf8');

  it('keeps test observer endpoints test-only and session-authenticated', () => {
    expect(bridgeContent).toContain('/__test/ui-observation');
    expect(bridgeContent).toContain('/__test/reference-navigation');
    expect(bridgeContent).toContain("process.env.WAYPOINT_TEST !== '1'");
    expect(bridgeContent).toContain("readHeader(req, 'x-dnaforge-session')");
    expect(bridgeContent).toContain('observeRendererUi');
    expect(bridgeContent).toContain('navigateRendererReference');
    expect(observerContent).toContain('designState');
    expect(observerContent).toContain('getDesignStore');
  });

  it('observes rendered tab DOM labels as independent UI evidence', () => {
    expect(observerContent).toContain('document.querySelectorAll(\'[role="tab"]\')');
    expect(observerContent).toContain('data-tab-label');
    expect(observerContent).toContain('domVisible');
    expect(observerContent).toContain('visibleTabLabels');
  });
});

describe('private MCP port readiness', () => {
  it.each(['current', 'stale', 'wrong-session'] as const)(
    'publishes a port only for accepted current health (%s)',
    async (mode) => {
      const start = sidecarContent.indexOf('export async function refreshSidecarStatus');
      const end = sidecarContent.indexOf('function appendStderrTail', start);
      const compiled = transpileModule(
        sidecarContent.slice(start, end).replace('export async', 'async'),
        { compilerOptions: { target: ScriptTarget.ES2022 } }
      ).outputText;
      const authority = new SidecarSessionAuthority({ initialToken: 'private-port-session' });
      const port = vi.fn();
      const probe = vi.fn(async () => {
        if (mode === 'stale') authority.prepareManagedSpawn('manual_restart');
        return mode === 'wrong-session'
          ? { state: 'mismatch', reason: 'session-mismatch' }
          : { state: 'ok', body: { mcp_http_internal_port: 35769 } };
      });
      const refresh = new Function(
        'lastSidecarStatus',
        'supervisorState',
        'sidecarSessionAuthority',
        'ensureApiPort',
        'probeSidecarHealth',
        'waitForTestRefreshResultLatch',
        'setMcpHttpInternalPort',
        'appendBootLog',
        'describeHealthProbeFailure',
        'console',
        `${compiled}; return refreshSidecarStatus;`
      )(
        'starting',
        { mainWindow: null },
        authority,
        vi.fn(),
        probe,
        vi.fn(),
        port,
        vi.fn(),
        () => 'session-mismatch',
        { warn: vi.fn() }
      );
      expect(await refresh()).toBe(
        mode === 'current' ? 'ready' : mode === 'stale' ? 'starting' : 'error'
      );
      expect(port.mock.calls).toEqual(
        mode === 'current' ? [[35769]] : mode === 'stale' ? [] : [[null]]
      );
    }
  );
});
