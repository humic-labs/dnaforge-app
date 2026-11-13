import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createServer } from 'net';

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

let _config: Record<string, string> | null = null;

export interface RuntimeSidecarAuthority {
  readonly kind: 'e2e-owned';
  readonly port: number;
}

export function isExplicitE2eTestRuntime(
  argv: readonly string[],
  waypointTest: string | undefined
): boolean {
  if (waypointTest !== '1') return false;
  return (
    argv.includes('--e2e') ||
    argv.includes('--waypoint-e2e=1') ||
    argv.includes('--waypoint-test=1')
  );
}

function applyRuntimeSidecarAuthority(
  config: Record<string, string>,
  authority: RuntimeSidecarAuthority | undefined
): Record<string, string> {
  if (authority == null) return config;
  if (
    authority.kind !== 'e2e-owned' ||
    !Number.isSafeInteger(authority.port) ||
    authority.port < 1 ||
    authority.port > 65_535
  ) {
    throw new Error('[Config] Invalid explicit runtime sidecar authority');
  }
  return {
    ...config,
    API_PORT: String(authority.port),
    VITE_API_URL: `http://127.0.0.1:${authority.port}`,
  };
}

export function parseE2eOwnedSidecarAuthority(
  argv: readonly string[],
  enabled: boolean
): RuntimeSidecarAuthority | undefined {
  const prefix = '--e2e-owned-sidecar-port=';
  const matches = argv.filter((argument) => argument.startsWith(prefix));
  if (matches.length === 0) return undefined;
  if (!enabled) {
    throw new Error('[Config] --e2e-owned-sidecar-port requires the explicit E2E test runtime');
  }
  if (matches.length !== 1) {
    throw new Error('[Config] Exactly one --e2e-owned-sidecar-port is required');
  }
  const rawPort = matches[0].slice(prefix.length);
  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`[Config] Invalid --e2e-owned-sidecar-port: ${rawPort}`);
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`[Config] Invalid --e2e-owned-sidecar-port: ${rawPort}`);
  }
  return { kind: 'e2e-owned', port };
}

export function loadConfig(
  appPath: string,
  options?: { strict?: boolean; runtimeSidecarAuthority?: RuntimeSidecarAuthority }
): Record<string, string> {
  if (_config) return _config;

  const envLocalPath = join(appPath, '.env.local');

  if (!existsSync(envLocalPath)) {
    if (options?.strict) {
      throw new Error(
        `[Config] No .env.local found at ${envLocalPath}\n` +
          `  If in a worktree, run: gw <task-name>`
      );
    }
    console.warn(
      `[Config] No .env.local found at ${envLocalPath}\n` +
        `  Using defaults. If in a worktree, run: gw <task-name>`
    );
    _config = applyRuntimeSidecarAuthority({}, options?.runtimeSidecarAuthority);
    return _config;
  }

  const content = readFileSync(envLocalPath, 'utf8');
  _config = applyRuntimeSidecarAuthority(parseEnvFile(content), options?.runtimeSidecarAuthority);
  console.log(
    `[Config] Loaded from ${envLocalPath}:`,
    Object.keys(_config)
      .filter((k) => !k.includes('KEY') && !k.includes('SECRET') && !k.includes('PASSWORD'))
      .map((k) => `${k}=${_config![k]}`)
      .join(', ')
  );
  return _config;
}

export function resetConfig(): void {
  _config = null;
  _portPromise = null;
}

let _portPromise: Promise<void> | null = null;

export function ensureApiPort(): Promise<void> {
  if (_portPromise) return _portPromise;
  _portPromise = (async () => {
    if (!_config) {
      throw new Error('[Config] loadConfig() must be called before ensureApiPort()');
    }
    if (_config.API_PORT) return;
    const port = await new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const p = addr && typeof addr === 'object' ? addr.port : 0;
        srv.close(() => (p ? resolve(p) : reject(new Error('[Config] could not get a free port'))));
      });
    });
    _config.API_PORT = String(port);
    console.log(
      `[Config] Per-instance sidecar port ${port} (no explicit API_PORT; ` +
        `eliminates fixed-:8000 cross-instance contention)`
    );
  })();
  return _portPromise;
}

export function getApiPort(): string {
  if (!_config) {
    throw new Error('[Config] loadConfig() must be called before getApiPort()');
  }
  if (!_config.API_PORT) {
    throw new Error(
      '[Config] getApiPort() before ensureApiPort() resolved — refusing to ' +
        'fall back to the shared :8000 singleton (the contention bug). ' +
        'Await ensureApiPort() in the sidecar/IPC path first.'
    );
  }
  return _config.API_PORT;
}

export function getApiUrl(): string {
  if (!_config) {
    throw new Error('[Config] loadConfig() must be called before getApiUrl()');
  }
  return `http://127.0.0.1:${getApiPort()}`;
}
