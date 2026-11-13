import {
  crashLoopBreaker,
  onCrashLoop,
  processExitSnapshot,
  watchProcessMemory,
} from './crash-loop-runtime';
import { sendRendererIpc } from '../shared/ipc-contract';
import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname, delimiter } from 'path';
import { app, BrowserWindow } from 'electron';
import { getApiPort, getApiUrl, ensureApiPort } from './config';
import { buildCoverageCacheEnv } from './coverage-cache-env';
import { trackStoreEnv } from './track-store';
import { rendererAllowedOriginsEnv } from './renderer-allowed-origins';
import { trackSidecarLifecycleEvent } from './analytics';
import { captureSidecarLifecycleEvent } from './sentry';
import { reportBootOrCrashFailure } from './diagnostics-upload';
import { appendBootLog } from './boot-log';
import {
  buildSidecarGrantCapabilities,
  missingRequiredRendererExternalCapabilities,
} from './sidecar-capabilities';
import { subprocessEnv } from './agent-sdk/subprocess-env';
import { distributionSidecarEnv } from './distribution';
import { resolveApiDir, resolveDevPython, resolvePackagedSidecarPath } from './sidecar-binary';
import {
  assertDevGenomeRuntime,
  assertPackagedGenomeRuntime,
  GENOME_RUNTIME_CAPABILITY,
  shouldRequireGenomeRuntime,
  type PackagedGenomeRuntimeReceipt,
} from './sidecar-runtime-capability';
import {
  nativeDocumentCommandEnv,
  prepareSidecarSpawn,
  sidecarSessionAuthority,
} from './sidecar-session-runtime';
import type { SidecarSessionSnapshot } from './sidecar-session-authority';
import { stopChildProcessTree } from './sidecar-process-tree';
import { isSidecarOwnershipMismatch, readSidecarSessionErrorCode } from './sidecar-health-auth';
import { sidecarControlPlaneEnv, sidecarProfileLockPath } from './sidecar-control-plane-env';
import { reclaimAbandonedLockHolders } from './sidecar-owner-reclaim';
import { retireOperationConnectionReceipt } from './operation-connection-receipt';
import { mcpHttpAllowedHostsFile, setMcpHttpInternalPort } from './mcp-http-listener';
import { resolveProcessGuardianPath } from './process-guardian';
import {
  packagedSidecarOwnerEnv,
  resolveDevelopmentSidecarLaunch,
  resolvePackagedSidecarLaunch,
} from './sidecar-process-launch';
import {
  computeManifestEnvironment,
  finalizeInterruptedComputeManifestRemovals,
} from './compute/manifest-paths';
import { deleteComputeCredential } from './compute/credentials';

let sidecarProcess: ChildProcess | null = null;
const pendingSidecarStops = new Set<ChildProcess>();

async function stopOwnedSidecarProcess(child: ChildProcess): Promise<void> {
  pendingSidecarStops.add(child);
  await stopChildProcessTree(child);
  pendingSidecarStops.delete(child);
  if (sidecarProcess === child) sidecarProcess = null;
}
const STDERR_TAIL_LIMIT = 8000;
const MAX_AUTO_RESTART_ATTEMPTS = 5;
const RESTART_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000] as const;
let sidecarStderrTail = '';
const restartTerminatedLaunches = new Set<number>();
let restartPromise: Promise<void> | null = null;
let testHealthProbeLatchConsumed = false;
let testHealthProbeLatchBlocked = false;
let releaseTestHealthProbeLatch: (() => void) | null = null;
let testRefreshResultLatchConsumed = false;
let testRefreshResultLatchBlocked = false;
let releaseTestRefreshResultLatch: (() => void) | null = null;

export function getSidecarProcessPid(): number | null {
  const pid = sidecarProcess?.pid;
  return Number.isSafeInteger(pid) && Number(pid) > 0 ? Number(pid) : null;
}

interface SidecarSupervisorState {
  started: boolean;
  mainWindow: BrowserWindow | null;
  rendererBridge?: RendererBridgeConfig;
  intentionalStop: boolean;
  restartAttempts: number;
  restartTimer: NodeJS.Timeout | null;
  launchId: number;
  bootstrap: Promise<void> | null;
  starting: Promise<void> | null;
  shutdownRequested: boolean;
}

const supervisorState: SidecarSupervisorState = {
  started: false,
  mainWindow: null,
  intentionalStop: false,
  restartAttempts: 0,
  restartTimer: null,
  launchId: 0,
  bootstrap: null,
  starting: null,
  shutdownRequested: false,
};

function isSidecarTestHarness(): boolean {
  return !app.isPackaged && (process.env.NODE_ENV === 'test' || process.env.WAYPOINT_TEST === '1');
}

const REQUIRED_SIDECAR_ROUTE_FEATURES = [
  'tiles.coverage-readiness.v1',
  'tiles.coverage-assembly.v1',
  'tiles.coverage-tile.v1',
  'tiles.alignment.v1',
  'tiles.annotation.v1',
  'auth.default-deny.v1',
] as const;

const REQUIRED_SIDECAR_RUNTIME_CAPABILITIES = [GENOME_RUNTIME_CAPABILITY] as const;
let packagedGenomeRuntimeReceipt: PackagedGenomeRuntimeReceipt | undefined;

function genomeRuntimeRequired(): boolean {
  return shouldRequireGenomeRuntime({
    isPackaged: app.isPackaged,
    platform: process.platform,
    nodeEnv: process.env.NODE_ENV,
    waypointTest: process.env.WAYPOINT_TEST,
    allowIncompleteE2eRuntime: process.env.WAYPOINT_E2E_ALLOW_INCOMPLETE_GENOME_RUNTIME,
    packagedRuntimeReceipt: packagedGenomeRuntimeReceipt,
  });
}

export interface RendererBridgeConfig {
  url: string;
  sessionToken: string;
}

function agentSessionEnv(snapshot: SidecarSessionSnapshot): Record<string, string> {
  const humanOperationToken = sidecarSessionAuthority.humanOperationToken(snapshot);
  const nativeDocumentAuthority = sidecarSessionAuthority.nativeDocumentAuthority(snapshot);
  const configuredGrant = process.env.DNAFORGE_MCP_GRANT_CAPABILITIES;
  const missingRequired = missingRequiredRendererExternalCapabilities(configuredGrant);
  if (configuredGrant && missingRequired.length > 0) {
    console.warn(
      `[Sidecar] Extending inherited DNAFORGE_MCP_GRANT_CAPABILITIES with renderer-required ` +
        `capabilities: ${missingRequired.join(', ')}`
    );
  }
  return {
    DNAFORGE_MCP_SESSION_TOKEN: snapshot.token,
    ...(humanOperationToken ? { DNAFORGE_HUMAN_OPERATION_TOKEN: humanOperationToken } : {}),
    ...(nativeDocumentAuthority
      ? {
          DNAFORGE_NATIVE_DOCUMENT_TOKEN: nativeDocumentAuthority.token,
          DNAFORGE_NATIVE_DOCUMENT_OWNER_ID: nativeDocumentAuthority.ownerInstanceId,
          ...nativeDocumentCommandEnv(snapshot),
        }
      : {}),
    DNAFORGE_OPERATION_URL: getApiUrl(),
    DNAFORGE_MCP_HTTP_ALLOWED_HOSTS_FILE: mcpHttpAllowedHostsFile(),
    DNAFORGE_MCP_HTTP_INTERNAL_PORT: '0',
    DNAFORGE_SIDECAR_SESSION_GENERATION: String(snapshot.generation),
    DNAFORGE_MCP_GRANT_CAPABILITIES: buildSidecarGrantCapabilities(configuredGrant),
    DNAFORGE_MCP_AGENT_IDENTITY: process.env.DNAFORGE_MCP_AGENT_IDENTITY ?? 'local-agent',
  };
}

function agentToolsManifestEnv(agentToolsDir: string): Record<string, string> {
  return { DNAFORGE_AGENT_TOOLS_DIR: agentToolsDir };
}

function trustedFixtureRootsEnv(apiDir: string): Record<string, string> {
  const worktreeRoot = dirname(dirname(apiDir));
  const wpAssets = join(dirname(worktreeRoot), 'wp-assets');
  const roots: string[] = [];
  const inherited = process.env.WAYPOINT_TRUSTED_FIXTURE_ROOTS?.trim();
  if (inherited) roots.push(inherited);
  if (existsSync(wpAssets)) roots.push(wpAssets);
  if (roots.length === 0) return {};
  return { WAYPOINT_TRUSTED_FIXTURE_ROOTS: roots.join(delimiter) };
}

function coverageCacheEnv(): Record<string, string> {
  return buildCoverageCacheEnv({
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
    homePath: app.getPath('home'),
    env: {
      WAYPOINT_ALIGNMENT_INDEX_DIR: process.env.WAYPOINT_ALIGNMENT_INDEX_DIR,
      WAYPOINT_COVERAGE_CACHE_DIR: process.env.WAYPOINT_COVERAGE_CACHE_DIR,
      WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR: process.env.WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR,
      WAYPOINT_COVERAGE_PYRAMID_LEGACY_DIRS: process.env.WAYPOINT_COVERAGE_PYRAMID_LEGACY_DIRS,
      WAYPOINT_INDEXED_TRACK_RANGE_CACHE_DIR: process.env.WAYPOINT_INDEXED_TRACK_RANGE_CACHE_DIR,
      WAYPOINT_INDEXED_TRACK_RANGE_CACHE_BYTES:
        process.env.WAYPOINT_INDEXED_TRACK_RANGE_CACHE_BYTES,
    },
  });
}

function helperBinariesEnv(apiDir?: string): Record<string, string> {
  if (process.env.DNAFORGE_HELPERS_DIR?.trim()) return {};
  if (app.isPackaged) {
    return { DNAFORGE_HELPERS_DIR: join(dirname(process.resourcesPath), 'Helpers') };
  }
  if (!apiDir) return {};
  const worktreeRoot = dirname(dirname(apiDir));
  return {
    DNAFORGE_HELPERS_DIR: join(worktreeRoot, 'apps/desktop/resources/helpers'),
  };
}

export function preflightSidecarRuntime(): void {
  if (app.isPackaged) {
    const executable = resolveSidecarPath();
    const receipt = assertPackagedGenomeRuntime(executable, {
      env: helperBinariesEnv(),
    });
    packagedGenomeRuntimeReceipt = receipt;
    if (receipt.schema === 'dnaforge.genome-runtime-unavailable.v1') {
      console.log(
        `[Sidecar] Packaged BAM/CRAM runtime is intentionally unavailable ` +
          `for ${receipt.target}; genome routes will report capability unavailable.`
      );
      return;
    }
    console.log(
      `[Sidecar] Packaged BAM/CRAM runtime preflight passed ` +
        `(pysam ${receipt.pysamVersion}; ${receipt.coverageEngineIdentity})`
    );
    return;
  }
  if (genomeRuntimeRequired()) {
    const apiDir = resolveApiDir(app.getAppPath());
    const python = resolveDevPython(apiDir);
    const receipt = assertDevGenomeRuntime(python, {
      cwd: apiDir,
      env: helperBinariesEnv(apiDir),
    });
    console.log(
      `[Sidecar] BAM/CRAM runtime preflight passed ` +
        `(pysam ${receipt.pysamVersion}; ${receipt.coverageEngineIdentity})`
    );
  }
}

export type SidecarStatus = 'starting' | 'ready' | 'stopped' | 'error' | 'timeout' | 'restarting';

let lastSidecarStatus: SidecarStatus = 'starting';

export function getLastSidecarStatus(): SidecarStatus {
  return lastSidecarStatus;
}

export async function refreshSidecarStatus(): Promise<SidecarStatus> {
  if (supervisorState.shutdownRequested || sidecarSessionAuthority.snapshot().state === 'stopped')
    return 'stopped';
  if (lastSidecarStatus === 'ready' || lastSidecarStatus === 'restarting') {
    return lastSidecarStatus;
  }

  try {
    await ensureApiPort();
    const statusAtProbeStart = lastSidecarStatus;
    const snapshot = sidecarSessionAuthority.snapshot();
    const result = await probeSidecarHealth(snapshot);
    await waitForTestRefreshResultLatch();
    if (lastSidecarStatus !== statusAtProbeStart || !sidecarSessionAuthority.isCurrent(snapshot)) {
      return lastSidecarStatus;
    }
    if (result.state === 'ok') {
      if (!sidecarSessionAuthority.markReady(snapshot.generation)) return lastSidecarStatus;
      const mainWindow = supervisorState.mainWindow;
      setMcpHttpInternalPort(result.body.mcp_http_internal_port);
      sendStatus(mainWindow, 'ready');
    } else if (result.state === 'mismatch') {
      if (lastSidecarStatus !== 'error') {
        console.warn(
          `[Sidecar] Status refresh rejected sidecar: ${describeHealthProbeFailure(result)}`
        );
      }
      const mainWindow = supervisorState.mainWindow;
      sendStatus(mainWindow, 'error');
    }
  } catch (err) {
    console.warn(
      '[Sidecar] Status refresh failed:',
      err instanceof Error ? err.message : String(err)
    );
  }

  return lastSidecarStatus;
}

function sendStatus(win: BrowserWindow | null, status: SidecarStatus): void {
  if (status !== lastSidecarStatus || status === 'ready') appendBootLog(`sidecar_status=${status}`);
  lastSidecarStatus = status;
  if (status !== 'ready') setMcpHttpInternalPort(null);
  if (win && !win.isDestroyed()) {
    sendRendererIpc(win.webContents, 'sidecar:status', status);
  }
}

function appendStderrTail(chunk: string): void {
  sidecarStderrTail = `${sidecarStderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
}

function clearRestartTimer(): void {
  if (supervisorState.restartTimer) {
    clearTimeout(supervisorState.restartTimer);
    supervisorState.restartTimer = null;
  }
}

let sidecarSpawnedAtMs: number | null = null;

function recordSidecarLifecycle(
  eventClass: string,
  opts: {
    pid?: number;
    spawnedAt?: number;
    code?: number | null;
    signal?: NodeJS.Signals | null;
    retryAttempt?: number;
    reason?: string;
    manual?: boolean;
    fatal?: boolean;
    success?: boolean;
  } = {}
): void {
  trackSidecarLifecycleEvent(eventClass, {
    fatal: opts.fatal,
    handled: true,
    success: opts.success,
    manual: opts.manual,
    retryAttempt: opts.retryAttempt,
    exitCode: opts.code,
    reason: opts.signal ? 'killed' : opts.code === 0 ? 'clean-exit' : 'abnormal-exit',
    ...processExitSnapshot(
      opts.pid ?? sidecarProcess?.pid,
      opts.spawnedAt ?? sidecarSpawnedAtMs ?? undefined
    ),
    signal: opts.signal,
    elapsedMs: sidecarSpawnedAtMs === null ? undefined : Date.now() - sidecarSpawnedAtMs,
  });
  captureSidecarLifecycleEvent(eventClass, {
    ...processExitSnapshot(
      opts.pid ?? sidecarProcess?.pid,
      opts.spawnedAt ?? sidecarSpawnedAtMs ?? undefined
    ),
    port: safeApiPort(),
    code: opts.code,
    signal: opts.signal,
    retryAttempt: opts.retryAttempt,
    reason:
      opts.reason ?? (opts.signal ? 'killed' : opts.code === 0 ? 'clean-exit' : 'abnormal-exit'),
    manual: opts.manual,
    fatal: opts.fatal,
    stderrTail: sidecarStderrTail || undefined,
  });
  if (opts.fatal) {
    reportFatalSidecarFailure(eventClass);
  }
}

export function reportFatalSidecarFailure(eventClass: string): void {
  reportBootOrCrashFailure(`sidecar_${eventClass}`, 'crash', `sidecar_${eventClass}`);
}

function safeApiPort(): string | undefined {
  try {
    return getApiPort();
  } catch {
    return undefined;
  }
}

function getSidecarBasePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'binaries')
    : join(app.getAppPath(), 'resources/binaries');
}

function getPackagedAgentToolsDir(): string {
  return join(process.resourcesPath, 'agent-tools');
}

function resolveSidecarPath(): string {
  return resolvePackagedSidecarPath({ resourcesPath: process.resourcesPath });
}

async function reclaimAbandonedProfileLock(): Promise<void> {
  const apiDir = app.isPackaged ? undefined : resolveApiDir(app.getAppPath());
  const lockPath = sidecarProfileLockPath({
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
    apiDir,
    env: {
      DNAFORGE_GRANT_ENVIRONMENT_ID: process.env.DNAFORGE_GRANT_ENVIRONMENT_ID,
      DNAFORGE_SIDECAR_ENVIRONMENT_ID: process.env.DNAFORGE_SIDECAR_ENVIRONMENT_ID,
      DNAFORGE_GRANT_CREATED_BY: process.env.DNAFORGE_GRANT_CREATED_BY,
      DNAFORGE_SIDECAR_DB_PATH: process.env.DNAFORGE_SIDECAR_DB_PATH,
    },
  });
  await reclaimAbandonedLockHolders({
    lockPath,
    appPid: process.pid,
    currentChildPid: getSidecarProcessPid(),
  });
}

function spawnSidecarProcess(
  snapshot: SidecarSessionSnapshot,
  rendererBridge?: RendererBridgeConfig
): ChildProcess {
  const apiPort = getApiPort();

  if (!app.isPackaged) {
    const apiDir = resolveApiDir(app.getAppPath());
    const python = resolveDevPython(apiDir);
    const agentToolsDir = join(apiDir, '../../packages/core/agent-tools');
    const sourceLaunch = resolveDevelopmentSidecarLaunch({
      pythonPath: python,
      apiDir,
      apiPort,
      ownerPid: process.pid,
    });

    console.log(
      `[Sidecar] Dev mode: spawning uvicorn from ${apiDir} on port ${apiPort} (python: ${python})`
    );
    return spawn(sourceLaunch.executable, [...sourceLaunch.args], {
      cwd: apiDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...subprocessEnv('sidecar'),
        ...distributionSidecarEnv(),
        ...(process.env.TYPESAFE_API_KEY ? { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY } : {}),
        ...agentSessionEnv(snapshot),
        ...rendererAllowedOriginsEnv(),
        ...agentToolsManifestEnv(agentToolsDir),
        ...computeManifestEnvironment({
          isPackaged: false,
          userDataPath: app.getPath('userData'),
        }),
        ...sidecarControlPlaneEnv({
          isPackaged: false,
          userDataPath: app.getPath('userData'),
          apiDir,
          env: {
            DNAFORGE_GRANT_ENVIRONMENT_ID: process.env.DNAFORGE_GRANT_ENVIRONMENT_ID,
            DNAFORGE_SIDECAR_ENVIRONMENT_ID: process.env.DNAFORGE_SIDECAR_ENVIRONMENT_ID,
            DNAFORGE_GRANT_CREATED_BY: process.env.DNAFORGE_GRANT_CREATED_BY,
            DNAFORGE_SIDECAR_DB_PATH: process.env.DNAFORGE_SIDECAR_DB_PATH,
          },
        }),
        ...trustedFixtureRootsEnv(apiDir),
        ...sourceLaunch.ownerEnv,
        ...(rendererBridge
          ? {
              DNAFORGE_RENDERER_BRIDGE_URL: rendererBridge.url,
              DNAFORGE_RENDERER_BRIDGE_TOKEN: rendererBridge.sessionToken,
              DNAFORGE_EXTERNAL_ACCESS_OBSERVATIONS: '1',
            }
          : {}),
        WAYPOINT_APP_VERSION: app.getVersion(),
        ...helperBinariesEnv(apiDir),
        ...coverageCacheEnv(),
        ...trackStoreEnv(),
      },
    });
  }

  const binaryPath = resolveSidecarPath();
  console.log(`[Sidecar] Starting binary: ${binaryPath} on port ${apiPort}`);
  const launch = resolvePackagedSidecarLaunch({
    binaryPath,
    apiPort,
    guardianPath: resolveProcessGuardianPath({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      isPackaged: true,
    }),
    ownerPid: process.pid,
  });
  const binariesPath = getSidecarBasePath();
  const agentToolsDir = getPackagedAgentToolsDir();
  return spawn(launch.executable, [...launch.args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...subprocessEnv('sidecar'),
      ...distributionSidecarEnv(),
      ...(process.env.TYPESAFE_API_KEY ? { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY } : {}),
      ...agentSessionEnv(snapshot),
      ...rendererAllowedOriginsEnv(),
      ...agentToolsManifestEnv(agentToolsDir),
      ...computeManifestEnvironment({
        isPackaged: true,
        userDataPath: app.getPath('userData'),
        resourcesPath: process.resourcesPath,
      }),
      ...sidecarControlPlaneEnv({
        isPackaged: true,
        userDataPath: app.getPath('userData'),
        env: {
          DNAFORGE_GRANT_ENVIRONMENT_ID: process.env.DNAFORGE_GRANT_ENVIRONMENT_ID,
          DNAFORGE_SIDECAR_ENVIRONMENT_ID: process.env.DNAFORGE_SIDECAR_ENVIRONMENT_ID,
          DNAFORGE_GRANT_CREATED_BY: process.env.DNAFORGE_GRANT_CREATED_BY,
          DNAFORGE_SIDECAR_DB_PATH: process.env.DNAFORGE_SIDECAR_DB_PATH,
        },
      }),
      ...packagedSidecarOwnerEnv(process.pid),
      ...(rendererBridge
        ? {
            DNAFORGE_RENDERER_BRIDGE_URL: rendererBridge.url,
            DNAFORGE_RENDERER_BRIDGE_TOKEN: rendererBridge.sessionToken,
            DNAFORGE_EXTERNAL_ACCESS_OBSERVATIONS: '1',
          }
        : {}),
      WAYPOINT_BINARIES_PATH: binariesPath,
      ...helperBinariesEnv(),
      WAYPOINT_APP_VERSION: app.getVersion(),
      ...coverageCacheEnv(),
      ...trackStoreEnv(),
    },
  });
}

type SidecarHealthBody = {
  app_version?: string;
  sidecar_source_fingerprint?: string | null;
  mcp_grant_capabilities?: string[] | null;
  route_features?: string[] | null;
  runtime_capabilities?: string[] | null;
  mcp_http_internal_port?: number | null;
};

type HealthProbe =
  | { state: 'ok'; body: SidecarHealthBody }
  | { state: 'unreachable'; reason: string }
  | {
      state: 'mismatch';
      reason:
        | 'missing-capabilities-field'
        | 'invalid-capabilities-field'
        | 'missing-capabilities'
        | 'invalid-route-features-field'
        | 'missing-route-features'
        | 'invalid-runtime-capabilities-field'
        | 'missing-runtime-capabilities'
        | 'sidecar-source-mismatch'
        | 'version-mismatch'
        | 'session-mismatch';
      details?: Record<string, unknown>;
    };

function describeHealthProbeFailure(result: Exclude<HealthProbe, { state: 'ok' }>): string {
  if (result.state === 'unreachable') {
    return `unreachable: ${result.reason}`;
  }

  const details = result.details ? ` ${JSON.stringify(result.details)}` : '';
  return `${result.reason}${details}`;
}

async function probeSidecarHealth(
  snapshot: SidecarSessionSnapshot,
  timeoutMs?: number
): Promise<HealthProbe> {
  const effectiveTimeout = timeoutMs ?? (isSidecarTestHarness() ? 5000 : 1000);
  try {
    const healthUrl = new URL(`http://127.0.0.1:${getApiPort()}/health`);
    const res = await fetch(healthUrl, {
      headers: { 'X-DNAForge-Session': snapshot.token },
      redirect: 'manual',
      signal: AbortSignal.timeout(effectiveTimeout),
    });
    if (!res.ok) {
      let failureBody: unknown = null;
      try {
        failureBody = await res.json();
      } catch {}
      if (!isSidecarOwnershipMismatch(res.status, failureBody)) {
        return { state: 'unreachable', reason: `HTTP ${res.status}` };
      }
      return {
        state: 'mismatch',
        reason: 'session-mismatch',
        details: {
          status: res.status,
          code: readSidecarSessionErrorCode(failureBody),
        },
      };
    }

    const body = (await res.json()) as SidecarHealthBody;

    if (!Object.prototype.hasOwnProperty.call(body, 'mcp_grant_capabilities')) {
      return { state: 'mismatch', reason: 'missing-capabilities-field' };
    }
    const grant = body.mcp_grant_capabilities;
    if (
      grant !== null &&
      (!Array.isArray(grant) || grant.some((capability) => typeof capability !== 'string'))
    ) {
      return {
        state: 'mismatch',
        reason: 'invalid-capabilities-field',
        details: { actualType: typeof grant },
      };
    }
    const missingCapabilities =
      grant === null || grant.includes('*')
        ? []
        : missingRequiredRendererExternalCapabilities(grant.join(','));
    if (missingCapabilities.length > 0) {
      return {
        state: 'mismatch',
        reason: 'missing-capabilities',
        details: { missing: missingCapabilities },
      };
    }

    if (!Array.isArray(body.route_features)) {
      return {
        state: 'mismatch',
        reason: 'invalid-route-features-field',
        details: { actualType: typeof body.route_features },
      };
    }
    const routeFeatures = new Set(body.route_features);
    const missingRouteFeatures = REQUIRED_SIDECAR_ROUTE_FEATURES.filter(
      (feature) => !routeFeatures.has(feature)
    );
    if (missingRouteFeatures.length > 0) {
      return {
        state: 'mismatch',
        reason: 'missing-route-features',
        details: { missing: missingRouteFeatures },
      };
    }

    if (genomeRuntimeRequired()) {
      if (!Array.isArray(body.runtime_capabilities)) {
        return {
          state: 'mismatch',
          reason: 'invalid-runtime-capabilities-field',
          details: { actualType: typeof body.runtime_capabilities },
        };
      }
      const runtimeCapabilities = new Set(body.runtime_capabilities);
      const missingRuntimeCapabilities = REQUIRED_SIDECAR_RUNTIME_CAPABILITIES.filter(
        (capability) => !runtimeCapabilities.has(capability)
      );
      if (missingRuntimeCapabilities.length > 0) {
        return {
          state: 'mismatch',
          reason: 'missing-runtime-capabilities',
          details: { missing: missingRuntimeCapabilities },
        };
      }
    }

    if (isSidecarTestHarness() && process.env.WAYPOINT_E2E_REQUIRE_SESSION_MATCH !== '1') {
      return { state: 'ok', body };
    }

    if (body.sidecar_source_fingerprint !== __WAYPOINT_SIDECAR_SOURCE_FINGERPRINT__) {
      return {
        state: 'mismatch',
        reason: 'sidecar-source-mismatch',
        details: {
          expected: __WAYPOINT_SIDECAR_SOURCE_FINGERPRINT__,
          actual: body.sidecar_source_fingerprint ?? null,
        },
      };
    }

    const expectedVersion = app.getVersion();
    if (body.app_version !== expectedVersion) {
      return {
        state: 'mismatch',
        reason: 'version-mismatch',
        details: { expected: expectedVersion, actual: body.app_version ?? null },
      };
    }

    return { state: 'ok', body };
  } catch (err) {
    return {
      state: 'unreachable',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getSidecarSourceFingerprint(): Promise<string | null> {
  await ensureApiPort();
  const snapshot = sidecarSessionAuthority.snapshot();
  const result = await probeSidecarHealth(snapshot);
  if (!sidecarSessionAuthority.isCurrent(snapshot) || result.state !== 'ok') return null;
  const fingerprint = result.body.sidecar_source_fingerprint;
  return typeof fingerprint === 'string' && /^[0-9a-f]{64}$/.test(fingerprint) ? fingerprint : null;
}

async function probeAlreadyRunning(snapshot: SidecarSessionSnapshot): Promise<HealthProbe> {
  const result = await probeSidecarHealth(snapshot);
  if (result.state === 'mismatch') {
    console.warn(
      `[Sidecar] Rejecting orphaned sidecar on port ${getApiPort()}: ` +
        `${describeHealthProbeFailure(result)}. ` +
        `Quit other DNAForge instances if this persists.`
    );
  }
  return result;
}

function reportExistingSidecarMismatch(
  mainWindow: BrowserWindow | null,
  result: Extract<HealthProbe, { state: 'mismatch' }>
): void {
  const reason = describeHealthProbeFailure(result);
  recordSidecarLifecycle('health_mismatch', {
    reason,
    fatal: true,
    success: false,
    retryAttempt: supervisorState.restartAttempts,
  });
  sendStatus(mainWindow, 'error');
}

export function startSidecar(
  mainWindow: BrowserWindow | null,
  rendererBridge?: RendererBridgeConfig
): Promise<void> {
  if (supervisorState.bootstrap) return supervisorState.bootstrap;
  const bootstrap = startSidecarBootstrap(mainWindow, rendererBridge);
  supervisorState.bootstrap = bootstrap;
  const clearBootstrap = (): void => {
    if (supervisorState.bootstrap === bootstrap) supervisorState.bootstrap = null;
  };
  void bootstrap.then(clearBootstrap, clearBootstrap);
  return bootstrap;
}

async function startSidecarBootstrap(
  mainWindow: BrowserWindow | null,
  rendererBridge?: RendererBridgeConfig
): Promise<void> {
  supervisorState.started = true;
  supervisorState.mainWindow = mainWindow;
  supervisorState.rendererBridge = rendererBridge;
  if (supervisorState.shutdownRequested) return;
  if (crashLoopBreaker.isSafeMode()) return;

  try {
    const manifestRecovery = await finalizeInterruptedComputeManifestRemovals(
      app.getPath('userData'),
      deleteComputeCredential
    );
    for (const providerId of manifestRecovery.finalized) {
      console.log(`[Compute] Completed interrupted removal for ${providerId}`);
    }
    for (const failure of manifestRecovery.failures) {
      console.error(
        `[Compute] Could not complete interrupted removal for ${failure.providerId}: ${failure.message}`
      );
    }
  } catch (error) {
    console.error(
      `[Compute] Could not inspect interrupted provider removals: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (supervisorState.shutdownRequested) return;
  if (crashLoopBreaker.isSafeMode()) return;

  await ensureApiPort();
  if (supervisorState.shutdownRequested) return;
  if (crashLoopBreaker.isSafeMode()) return;
  await waitForTestPreSpawnDelay();
  if (supervisorState.shutdownRequested) return;
  if (crashLoopBreaker.isSafeMode()) return;

  const existingSession = sidecarSessionAuthority.snapshot();
  const existingProbe = await probeAlreadyRunning(existingSession);
  if (supervisorState.shutdownRequested) return;
  if (crashLoopBreaker.isSafeMode()) return;
  if (existingProbe.state === 'mismatch') {
    reportExistingSidecarMismatch(mainWindow, existingProbe);
    return;
  }
  if (existingProbe.state === 'ok') {
    console.log('[Sidecar] Already running, skipping spawn');
    clearRestartTimer();
    supervisorState.restartAttempts = 0;
    recordSidecarLifecycle('already_running', { success: true });
    if (!sidecarSessionAuthority.markReady(existingSession.generation)) return;
    setMcpHttpInternalPort(existingProbe.body.mcp_http_internal_port);
    sendStatus(mainWindow, 'ready');
    return;
  }

  await launchSidecar('initial');
}

async function launchSidecar(reason: 'initial' | 'respawn' | 'manual_restart'): Promise<void> {
  const mainWindow = supervisorState.mainWindow;
  if (!supervisorState.started) {
    throw new Error('[Sidecar] Cannot launch sidecar before its host is registered');
  }
  if (supervisorState.shutdownRequested) return;
  if (crashLoopBreaker.isSafeMode()) return;

  if (supervisorState.starting) {
    return supervisorState.starting;
  }

  const launchPromise = (async () => {
    if (supervisorState.shutdownRequested) return;
    if (crashLoopBreaker.isSafeMode()) return;
    clearRestartTimer();
    const launchId = ++supervisorState.launchId;
    const launchSession = prepareSidecarSpawn(reason);
    if (supervisorState.shutdownRequested) return;
    if (crashLoopBreaker.isSafeMode()) return;
    supervisorState.intentionalStop = false;
    sidecarStderrTail = '';

    sendStatus(mainWindow, reason === 'initial' ? 'starting' : 'restarting');
    recordSidecarLifecycle(reason, {
      manual: reason === 'manual_restart',
      retryAttempt: supervisorState.restartAttempts,
      success: true,
    });

    try {
      await reclaimAbandonedProfileLock();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Sidecar] Could not clear an abandoned profile lock: ${message}`);
      recordSidecarLifecycle('reclaim_failed', {
        reason: message,
        fatal: true,
        success: false,
        retryAttempt: supervisorState.restartAttempts,
      });
      sendStatus(mainWindow, 'error');
      return;
    }

    let launchedChild: ChildProcess;
    try {
      launchedChild = spawnSidecarProcess(launchSession, supervisorState.rendererBridge);
      watchProcessMemory(launchedChild.pid);
      sidecarSpawnedAtMs = Date.now();
      sidecarProcess = launchedChild;
    } catch (err) {
      console.error(`[Sidecar] Failed to resolve sidecar:`, err);
      recordSidecarLifecycle('resolve_failed', {
        reason: err instanceof Error ? err.message : String(err),
        fatal: true,
        success: false,
      });
      sendStatus(mainWindow, 'error');
      return;
    }

    const launchedAt = sidecarSpawnedAtMs ?? Date.now();
    try {
      launchedChild.stdout?.on('data', (data: Buffer) => {
        console.log(`[Sidecar stdout] ${data.toString().trim()}`);
      });

      launchedChild.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        appendStderrTail(chunk);
        console.error(`[Sidecar stderr] ${chunk.trim()}`);
      });

      launchedChild.on('exit', (code, signal) => {
        console.log(`[Sidecar] Process terminated: code=${code}, signal=${signal}`);
        retireOperationConnectionReceipt(launchSession.token);
        if (restartTerminatedLaunches.delete(launchId) || launchId !== supervisorState.launchId) {
          recordSidecarLifecycle('stopped', {
            pid: launchedChild.pid,
            spawnedAt: launchedAt,
            code,
            signal,
            success: true,
          });
          return;
        }

        if (sidecarProcess === launchedChild) sidecarProcess = null;
        if (supervisorState.intentionalStop) {
          recordSidecarLifecycle('stopped', {
            spawnedAt: launchedAt,
            pid: launchedChild.pid,
            code,
            signal,
            success: true,
          });
          sendStatus(mainWindow, 'stopped');
          return;
        }

        crashLoopBreaker.record({
          process_type: 'sidecar',
          reason: signal ? 'killed' : code === 0 ? 'clean-exit' : 'abnormal-exit',
          exitCode: code,
          signal,
          ...processExitSnapshot(launchedChild.pid, sidecarSpawnedAtMs ?? undefined),
        });
        recordSidecarLifecycle('exit', {
          spawnedAt: launchedAt,
          pid: launchedChild.pid,
          code,
          signal,
          retryAttempt: supervisorState.restartAttempts,
          fatal: true,
          success: false,
        });
        scheduleRestart('exit', launchId);
      });

      launchedChild.on('error', (err) => {
        console.error(`[Sidecar] Failed to spawn: ${err.message}`);
        if (launchId !== supervisorState.launchId) return;
        if (sidecarProcess === launchedChild) sidecarProcess = null;
        recordSidecarLifecycle('spawn_error', {
          reason: err.message,
          retryAttempt: supervisorState.restartAttempts,
          fatal: true,
          success: false,
        });
        scheduleRestart('spawn_error', launchId);
      });

      await pollHealthCheck(mainWindow, launchId, launchSession, launchedChild);
    } catch (err) {
      console.error(`[Sidecar] Start failed:`, err);
      recordSidecarLifecycle('start_failed', {
        reason: err instanceof Error ? err.message : String(err),
        retryAttempt: supervisorState.restartAttempts,
        fatal: true,
        success: false,
      });
      if (await terminateCurrentSidecarForRestart(launchId, launchedChild, 'start_failed')) {
        scheduleRestart('start_failed', launchId);
      }
    }
  })();

  supervisorState.starting = launchPromise;
  try {
    await launchPromise;
  } finally {
    if (supervisorState.starting === launchPromise) {
      supervisorState.starting = null;
    }
  }
}

async function pollHealthCheck(
  mainWindow: BrowserWindow | null,
  launchId: number,
  launchSession: SidecarSessionSnapshot,
  launchedChild: ChildProcess
): Promise<void> {
  const maxAttempts = 120;
  const intervalMs = 500;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (
      !sidecarProcess ||
      sidecarProcess !== launchedChild ||
      launchId !== supervisorState.launchId ||
      supervisorState.shutdownRequested
    ) {
      console.log('[Sidecar] Process exited or launch was superseded, aborting health check');
      return;
    }
    await waitForTestHealthProbeLatch();
    if (
      sidecarProcess !== launchedChild ||
      launchId !== supervisorState.launchId ||
      supervisorState.shutdownRequested
    ) {
      return;
    }
    const result = await probeSidecarHealth(launchSession, 2000);
    if (
      sidecarProcess !== launchedChild ||
      launchId !== supervisorState.launchId ||
      supervisorState.shutdownRequested
    ) {
      return;
    }
    if (result.state === 'ok') {
      if (!sidecarSessionAuthority.markReady(launchSession.generation)) {
        console.warn(
          `[Sidecar] Ignoring ready result from stale session generation ${launchSession.generation}`
        );
        return;
      }
      console.log(`[Sidecar] Health check passed (attempt ${attempt})`);
      supervisorState.restartAttempts = 0;
      recordSidecarLifecycle('ready', { success: true });
      setMcpHttpInternalPort(result.body.mcp_http_internal_port);
      sendStatus(mainWindow, 'ready');
      return;
    }
    if (result.state === 'mismatch') {
      console.error(
        `[Sidecar] A different sidecar is bound to port ${getApiPort()}: ` +
          `${describeHealthProbeFailure(result)}. ` +
          `Quit other DNAForge instances and relaunch.`
      );
      recordSidecarLifecycle('health_mismatch', {
        reason: describeHealthProbeFailure(result),
        fatal: true,
        success: false,
        retryAttempt: supervisorState.restartAttempts,
      });
      sendStatus(mainWindow, 'error');
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    if (
      sidecarProcess !== launchedChild ||
      launchId !== supervisorState.launchId ||
      supervisorState.shutdownRequested
    ) {
      return;
    }
  }

  if (
    sidecarProcess !== launchedChild ||
    launchId !== supervisorState.launchId ||
    supervisorState.shutdownRequested
  ) {
    return;
  }
  console.error(`[Sidecar] Health check timed out after ${maxAttempts} attempts`);
  recordSidecarLifecycle('health_timeout', {
    fatal: true,
    success: false,
    retryAttempt: supervisorState.restartAttempts,
  });
  sendStatus(mainWindow, 'timeout');
  if (await terminateCurrentSidecarForRestart(launchId, launchedChild, 'health_timeout')) {
    scheduleRestart('health_timeout', launchId);
  }
}

async function terminateCurrentSidecarForRestart(
  launchId: number,
  launchedChild: ChildProcess,
  reason: string
): Promise<boolean> {
  if (launchId !== supervisorState.launchId || sidecarProcess !== launchedChild) return false;
  restartTerminatedLaunches.add(launchId);
  sidecarProcess = null;
  recordSidecarLifecycle('terminate_for_restart', {
    reason,
    retryAttempt: supervisorState.restartAttempts,
    success: true,
  });
  try {
    await stopOwnedSidecarProcess(launchedChild);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Sidecar] Process-tree termination failed: ${message}`);
    recordSidecarLifecycle('termination_failed', {
      reason: message,
      fatal: true,
      success: false,
      retryAttempt: supervisorState.restartAttempts,
    });
    const mainWindow = supervisorState.mainWindow;
    sendStatus(mainWindow, 'error');
    return false;
  }
}

function scheduleRestart(reason: string, originatingLaunchId: number): void {
  const mainWindow = supervisorState.mainWindow;
  if (originatingLaunchId !== supervisorState.launchId) return;
  if (
    !supervisorState.started ||
    supervisorState.intentionalStop ||
    supervisorState.shutdownRequested
  )
    return;
  if (crashLoopBreaker.isSafeMode()) return;
  sidecarSessionAuthority.markRestarting();
  if (supervisorState.restartTimer) return;

  if (supervisorState.restartAttempts >= MAX_AUTO_RESTART_ATTEMPTS) {
    console.error(
      `[Sidecar] Restart attempts exhausted after ${MAX_AUTO_RESTART_ATTEMPTS} failures (${reason})`
    );
    recordSidecarLifecycle('restart_exhausted', {
      reason,
      retryAttempt: supervisorState.restartAttempts,
      fatal: true,
      success: false,
    });
    sendStatus(mainWindow, 'error');
    return;
  }

  const attempt = supervisorState.restartAttempts + 1;
  const delay = RESTART_BACKOFF_MS[Math.min(attempt - 1, RESTART_BACKOFF_MS.length - 1)];
  supervisorState.restartAttempts = attempt;
  console.warn(`[Sidecar] Scheduling restart attempt ${attempt} in ${delay}ms (${reason})`);
  recordSidecarLifecycle('restart_scheduled', {
    reason,
    retryAttempt: attempt,
    success: true,
  });
  sendStatus(mainWindow, 'restarting');
  supervisorState.restartTimer = setTimeout(() => {
    supervisorState.restartTimer = null;
    void launchSidecar('respawn');
  }, delay);
}

export function restartSidecar(): Promise<void> {
  if (restartPromise) return restartPromise;
  if (supervisorState.shutdownRequested) {
    return Promise.reject(new Error('[Sidecar] Cannot restart during shutdown'));
  }
  const tracked = performRestartSidecar()
    .catch((error: unknown) => {
      const mainWindow = supervisorState.mainWindow;
      if (!supervisorState.shutdownRequested && supervisorState.started) {
        recordSidecarLifecycle('manual_restart_failed', {
          manual: true,
          fatal: true,
          success: false,
          reason: error instanceof Error ? error.message : String(error),
        });
        sendStatus(mainWindow, 'error');
      }
      throw error;
    })
    .finally(() => {
      if (restartPromise === tracked) restartPromise = null;
    });
  restartPromise = tracked;
  return tracked;
}

async function performRestartSidecar(): Promise<void> {
  const mainWindow = supervisorState.mainWindow;
  if (!supervisorState.started) {
    throw new Error('[Sidecar] Cannot restart before sidecar has been started once');
  }
  clearRestartTimer();
  supervisorState.restartAttempts = 0;
  recordSidecarLifecycle('manual_restart_requested', { manual: true, success: true });
  sidecarSessionAuthority.markRestarting();
  sendStatus(mainWindow, 'restarting');
  await waitForTestManualRestartDelay();
  if (sidecarProcess) {
    supervisorState.intentionalStop = true;
    const oldLaunchId = supervisorState.launchId;
    restartTerminatedLaunches.add(oldLaunchId);
    const child = sidecarProcess;
    sidecarProcess = null;
    await stopOwnedSidecarProcess(child);
  }
  failManualRestartForTest();
  const currentSession = sidecarSessionAuthority.snapshot();
  if (currentSession.owner === 'external' && !sidecarProcess) {
    const existingProbe = await probeAlreadyRunning(currentSession);
    if (supervisorState.shutdownRequested) return;
    if (crashLoopBreaker.isSafeMode()) return;
    if (existingProbe.state === 'mismatch') {
      reportExistingSidecarMismatch(mainWindow, existingProbe);
      return;
    }
    if (existingProbe.state === 'ok') {
      supervisorState.intentionalStop = false;
      if (!sidecarSessionAuthority.markReady(currentSession.generation)) return;
      setMcpHttpInternalPort(existingProbe.body.mcp_http_internal_port);
      sendStatus(mainWindow, 'ready');
      return;
    }
  }
  if (supervisorState.shutdownRequested) return;
  if (crashLoopBreaker.isSafeMode()) return;
  supervisorState.starting = null;
  supervisorState.intentionalStop = false;
  await ensureApiPort();
  await launchSidecar('manual_restart');
}

export async function killSidecar(): Promise<void> {
  supervisorState.shutdownRequested = true;
  supervisorState.intentionalStop = true;
  sidecarSessionAuthority.markStopped();
  clearRestartTimer();
  const stopCurrentChild = async (): Promise<void> => {
    const children = new Set(pendingSidecarStops);
    if (sidecarProcess) children.add(sidecarProcess);
    for (const child of children) {
      console.log('[Sidecar] Killing sidecar process on exit');
      await stopOwnedSidecarProcess(child);
    }
  };
  await stopCurrentChild();
  const inFlight = [supervisorState.bootstrap, supervisorState.starting, restartPromise].filter(
    (promise): promise is Promise<void> => promise !== null
  );
  if (inFlight.length > 0) await Promise.allSettled(inFlight);
  await stopCurrentChild();
  supervisorState.intentionalStop = true;
  sidecarSessionAuthority.markStopped();
}

async function waitForTestPreSpawnDelay(): Promise<void> {
  if (!isSidecarTestHarness()) return;
  const delayMs = Number(process.env.DNAFORGE_TEST_SIDECAR_PRE_SPAWN_DELAY_MS ?? 0);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 30_000)));
}

async function waitForTestHealthProbeLatch(): Promise<void> {
  if (
    !isSidecarTestHarness() ||
    process.env.DNAFORGE_TEST_SIDECAR_HEALTH_PROBE_LATCH !== '1' ||
    testHealthProbeLatchConsumed
  ) {
    return;
  }
  testHealthProbeLatchConsumed = true;
  testHealthProbeLatchBlocked = true;
  await new Promise<void>((resolve) => {
    releaseTestHealthProbeLatch = resolve;
  });
  releaseTestHealthProbeLatch = null;
  testHealthProbeLatchBlocked = false;
}

async function waitForTestRefreshResultLatch(): Promise<void> {
  const requiredStatus = process.env.DNAFORGE_TEST_SIDECAR_REFRESH_RESULT_LATCH_STATUS;
  if (
    !isSidecarTestHarness() ||
    process.env.DNAFORGE_TEST_SIDECAR_REFRESH_RESULT_LATCH !== '1' ||
    (requiredStatus && lastSidecarStatus !== requiredStatus) ||
    testRefreshResultLatchConsumed
  ) {
    return;
  }
  testRefreshResultLatchConsumed = true;
  testRefreshResultLatchBlocked = true;
  await new Promise<void>((resolve) => {
    releaseTestRefreshResultLatch = resolve;
  });
  releaseTestRefreshResultLatch = null;
  testRefreshResultLatchBlocked = false;
}

async function waitForTestManualRestartDelay(): Promise<void> {
  if (!isSidecarTestHarness()) return;
  const delayMs = Number(process.env.DNAFORGE_TEST_SIDECAR_MANUAL_RESTART_DELAY_MS ?? 0);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 30_000)));
}

function failManualRestartForTest(): void {
  if (isSidecarTestHarness() && process.env.DNAFORGE_TEST_SIDECAR_MANUAL_RESTART_FAILURE === '1') {
    throw new Error('[Sidecar] Injected manual restart failure');
  }
}

export function getTestHealthProbeLatchState(): { blocked: boolean; consumed: boolean } {
  return {
    blocked: testHealthProbeLatchBlocked,
    consumed: testHealthProbeLatchConsumed,
  };
}

export function releaseTestHealthProbe(): void {
  releaseTestHealthProbeLatch?.();
}

export function getTestRefreshResultLatchState(): { blocked: boolean; consumed: boolean } {
  return {
    blocked: testRefreshResultLatchBlocked,
    consumed: testRefreshResultLatchConsumed,
  };
}

export function releaseTestRefreshResult(): void {
  releaseTestRefreshResultLatch?.();
}

export function setTestSidecarStatus(status: SidecarStatus): void {
  if (!isSidecarTestHarness()) {
    throw new Error('[Sidecar] Test status override is unavailable outside the test harness');
  }
  lastSidecarStatus = status;
}

onCrashLoop(() => {
  clearRestartTimer();
  void killSidecar().catch((error: unknown) =>
    console.error('[Sidecar] Safe-mode shutdown failed', error)
  );
});
