import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function findEnvLocalPath(cwd = process.cwd()) {
  let directory = resolve(cwd);
  while (true) {
    const candidate = join(directory, '.env.local');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function readEnvLocalValue(key, cwd = process.cwd()) {
  const envPath = findEnvLocalPath(cwd);
  if (!envPath) return undefined;

  const line = readFileSync(envPath, 'utf-8')
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(`${key}=`));
  if (!line) return undefined;

  return line
    .slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

function readCliPort(argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const candidate = argv[index];
    if (candidate === '--port') {
      const value = argv[index + 1];
      if (value == null || value.startsWith('--')) {
        throw new Error('--port requires a value');
      }
      values.push(value);
      index += 1;
      continue;
    }
    if (candidate.startsWith('--port=')) {
      values.push(candidate.slice('--port='.length));
    }
  }
  if (values.length > 1) {
    throw new Error(`--port may be specified only once (received ${values.length})`);
  }
  return values[0];
}

function requireTcpPort(value, source) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${source} must be an integer TCP port`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${source} must be between 1 and 65535`);
  }
  return String(parsed);
}

export function resolveDevCdpPort({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const cliPort = readCliPort(argv);
  if (cliPort != null) return requireTcpPort(cliPort, '--port');

  if (env.CDP_PORT != null) return requireTcpPort(env.CDP_PORT, 'CDP_PORT');

  const fileDebugPort = readEnvLocalValue('DESKTOP_DEBUG_PORT', cwd);
  if (fileDebugPort != null) return requireTcpPort(fileDebugPort, 'DESKTOP_DEBUG_PORT');

  const parsedDesktopDevPort = Number(resolveDesktopDevPort({ env, cwd }));
  if (parsedDesktopDevPort < 1421) return '9223';
  const cdpPort = parsedDesktopDevPort + 7800;
  if (cdpPort > 65_535) {
    throw new Error('DESKTOP_DEV_PORT + 7800 exceeds the TCP port range');
  }
  return String(cdpPort);
}

export function resolveDesktopDevPort({
  env = process.env,
  cwd = process.cwd(),
  fallback = '1420',
} = {}) {
  const desktopDevPort = readEnvLocalValue('DESKTOP_DEV_PORT', cwd) ?? env.DESKTOP_DEV_PORT;
  return requireTcpPort(desktopDevPort ?? fallback, 'DESKTOP_DEV_PORT');
}

export function cdpEndpointDescription(options = {}) {
  return `localhost:${resolveDevCdpPort(options)}`;
}

export function cdpJsonUrl(options = {}) {
  return `http://${cdpEndpointDescription(options)}/json`;
}
