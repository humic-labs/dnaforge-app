import { spawn as defaultSpawn } from 'node:child_process';
import { realpathSync } from 'node:fs';

import {
  AppServerSupervisor,
  type AppServerSupervisorOptions,
  type SupervisedChild,
} from './app-server-supervisor';
import {
  assertCodexRuntimeIsolation,
  createCodexRuntimeIsolation,
  type CodexRuntimeIsolation,
} from './runtime-isolation';
import {
  assertHostedCodexAppServerConfig,
  configureHostedCodexAppServer,
  HOSTED_CODEX_MODEL_CATALOG_FILENAME,
  type HostedCodexAppServerConfig,
} from './app-server-config';
import type { ResolvedCodexAppServerBinary } from './app-server-binary';
import {
  ANSWERABLE_SERVER_REQUESTS,
  PINNED_PROTOCOL_NOTIFICATIONS,
  REFUSED_SERVER_REQUESTS,
} from './app-server-protocol';

export type LaunchFailureCode =
  | 'spawn_failed'
  | 'handshake_failed'
  | 'protocol_mismatch'
  | 'version_mismatch'
  | 'child_exited_early';

export class AppServerLaunchError extends Error {
  constructor(
    readonly code: LaunchFailureCode,
    message: string
  ) {
    super(message);
    this.name = 'AppServerLaunchError';
  }
}

export interface LaunchedAppServer {
  readonly supervisor: AppServerSupervisor;
  readonly isolation: CodexRuntimeIsolation;
  readonly dispose: () => void;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export const ALLOWED_APP_SERVER_NOTIFICATIONS: readonly string[] = PINNED_PROTOCOL_NOTIFICATIONS;

export const EXPECTED_PROTOCOL_GENERATION = 'protocol-v1';

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'pipe' }
) => SupervisedChild;

export interface LaunchAppServerOptions {
  readonly binary: ResolvedCodexAppServerBinary;
  readonly rootDir: string;
  readonly runId?: string;
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnLike;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly hostedProviderBaseUrl?: string;
  readonly injectedEnv?: Readonly<Record<string, string>>;
  readonly configToml?: string;
  readonly onServerRequest?: AppServerSupervisorOptions['onServerRequest'];
  readonly onNotification?: AppServerSupervisorOptions['onNotification'];
}

interface InitializeResult {
  readonly userAgent?: unknown;
  readonly codexHome?: unknown;
  readonly platformFamily?: unknown;
  readonly platformOs?: unknown;
}

export async function launchAppServer(options: LaunchAppServerOptions): Promise<LaunchedAppServer> {
  const isolation = createCodexRuntimeIsolation({
    configToml: options.configToml,
    rootDir: options.rootDir,
    runId: options.runId,
    hostEnv: options.hostEnv,
    platform: options.platform,
  });
  assertCodexRuntimeIsolation(isolation);
  let hostedConfig: HostedCodexAppServerConfig | undefined;
  if (options.hostedProviderBaseUrl) {
    hostedConfig = configureHostedCodexAppServer(isolation, options.hostedProviderBaseUrl);
  }

  let child: SupervisedChild;
  try {
    if (hostedConfig) {
      assertCodexRuntimeIsolation(isolation, ['config.toml', HOSTED_CODEX_MODEL_CATALOG_FILENAME]);
      assertHostedCodexAppServerConfig(hostedConfig);
    } else {
      assertCodexRuntimeIsolation(isolation);
    }
    const spawnFn: SpawnLike =
      options.spawn ?? ((command, args, spawnOptions) => defaultSpawn(command, args, spawnOptions));
    child = spawnFn(options.binary.path, ['app-server'], {
      cwd: isolation.cwd,
      env: { ...isolation.env, ...options.injectedEnv },
      stdio: 'pipe',
    });
  } catch (cause) {
    isolation.dispose();
    throw new AppServerLaunchError(
      'spawn_failed',
      `could not start the Codex App Server: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }

  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (process.env.HOSTED_E2E_DIAGNOSTICS !== '1') return;
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
    console.error('[HostedCodex] App Server stderr bytes:', bytes);
  });
  if (process.env.HOSTED_E2E_DIAGNOSTICS === '1') {
    console.error('[HostedCodex] App Server child:', { pid: child.pid ?? null });
  }

  const supervisor = new AppServerSupervisor({
    child,
    allowedNotifications: ALLOWED_APP_SERVER_NOTIFICATIONS,
    answerableRequests: ANSWERABLE_SERVER_REQUESTS,
    refusedRequests: REFUSED_SERVER_REQUESTS,
    onServerRequest: options.onServerRequest,
    onNotification: options.onNotification,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });
  child.on('exit', (code, signal) => {
    if (process.env.HOSTED_E2E_DIAGNOSTICS === '1') {
      console.error('[HostedCodex] App Server exit:', {
        code,
        signal,
        supervisorReason: supervisor.terminationReason,
      });
    }
  });

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    supervisor.shutdown();
    isolation.dispose();
  };

  child.on('exit', () => dispose());

  try {
    const result = (await withDeadline(
      supervisor.request('initialize', {
        clientInfo: { name: 'dnaforge', version: options.binary.packageVersion },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
          optOutNotificationMethods: [],
          extensions: {},
        },
      }),
      options.handshakeTimeoutMs ?? options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    )) as InitializeResult | null;

    if (result === null || typeof result !== 'object') {
      throw new AppServerLaunchError(
        'handshake_failed',
        'the Codex App Server did not answer initialize with a result'
      );
    }

    if (!sameDirectory(result.codexHome, isolation.codexHome)) {
      throw new AppServerLaunchError(
        'protocol_mismatch',
        `the Codex App Server is running against ${String(
          result.codexHome
        )}, not the private home this launch created`
      );
    }
  } catch (cause) {
    const terminatedBy = supervisor.terminationReason;
    dispose();
    if (cause instanceof AppServerLaunchError) throw cause;
    throw new AppServerLaunchError(
      terminatedBy === 'child_exit' ? 'child_exited_early' : 'handshake_failed',
      `the Codex App Server handshake failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }

  return { supervisor, isolation, dispose };
}

function sameDirectory(reported: unknown, expected: string): boolean {
  if (typeof reported !== 'string' || reported.length === 0) return false;
  try {
    return realpathSync(reported) === realpathSync(expected);
  } catch {
    return false;
  }
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AppServerLaunchError(
          'handshake_failed',
          `the Codex App Server did not complete the handshake within ${timeoutMs}ms`
        )
      );
    }, timeoutMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    );
  });
}
