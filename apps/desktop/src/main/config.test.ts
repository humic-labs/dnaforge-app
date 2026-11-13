import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  parseEnvFile,
  loadConfig,
  resetConfig,
  ensureApiPort,
  getApiPort,
  getApiUrl,
  isExplicitE2eTestRuntime,
  parseE2eOwnedSidecarAuthority,
} from './config';

describe('parseEnvFile', () => {
  it('parses simple key=value pairs', () => {
    const result = parseEnvFile('API_PORT=8004\nVITE_API_URL=http://localhost:8004');
    expect(result.API_PORT).toBe('8004');
    expect(result.VITE_API_URL).toBe('http://localhost:8004');
  });

  it('handles quoted values (double quotes)', () => {
    const result = parseEnvFile('DATABASE_URL="postgresql://user:pass@localhost/db"');
    expect(result.DATABASE_URL).toBe('postgresql://user:pass@localhost/db');
  });

  it('handles single-quoted values', () => {
    const result = parseEnvFile("SECRET='my secret value'");
    expect(result.SECRET).toBe('my secret value');
  });

  it('skips comments and empty lines', () => {
    const content = `
# This is a comment
API_PORT=8004

# Another comment
VITE_API_URL=http://localhost:8004
    `;
    const result = parseEnvFile(content);
    expect(result.API_PORT).toBe('8004');
    expect(result.VITE_API_URL).toBe('http://localhost:8004');
    expect(Object.keys(result)).toHaveLength(2);
  });

  it('ignores lines without = sign', () => {
    const result = parseEnvFile('not a valid line\nAPI_PORT=8004');
    expect(result.API_PORT).toBe('8004');
    expect(Object.keys(result)).toHaveLength(1);
  });

  it('returns empty object for empty content', () => {
    expect(parseEnvFile('')).toEqual({});
  });

  it('handles values with = signs in them', () => {
    const result = parseEnvFile('DATABASE_URL=postgres://host?opt=val&other=2');
    expect(result.DATABASE_URL).toBe('postgres://host?opt=val&other=2');
  });

  it('trims whitespace from keys and values', () => {
    const result = parseEnvFile('  API_PORT = 8004  ');
    expect(result.API_PORT).toBe('8004');
  });
});

describe('loadConfig strict mode', () => {
  beforeEach(() => {
    resetConfig();
  });

  it('throws when .env.local is missing and strict=true', () => {
    expect(() => loadConfig('/nonexistent/path', { strict: true })).toThrow(/No .env.local found/);
  });

  it('returns empty config when .env.local is missing and strict=false', () => {
    resetConfig();
    const config = loadConfig('/nonexistent/path', { strict: false });
    expect(config).toEqual({});
  });

  it('returns empty config when .env.local is missing and no options', () => {
    resetConfig();
    const config = loadConfig('/nonexistent/path');
    expect(config).toEqual({});
  });
});

describe('envrc load order (root cause of direnv override bug)', () => {
  const envrcPath = resolve(__dirname, '../../../../.envrc');

  it.skipIf(!existsSync(envrcPath))(
    '.envrc loads .env.local AFTER .env (worktree overrides win)',
    () => {
      const envrc = readFileSync(envrcPath, 'utf8');

      const dotenvLocal = envrc.indexOf('dotenv_if_exists .env.local');
      const dotenvDefault = envrc.indexOf('dotenv_if_exists .env');

      expect(dotenvLocal).toBeGreaterThan(-1);
      expect(dotenvDefault).toBeGreaterThan(-1);

      expect(dotenvLocal).toBeGreaterThan(dotenvDefault);
    }
  );
});

describe('config module structure', () => {
  it('exports parseEnvFile as a pure function', async () => {
    const mod = await import('./config');
    expect(typeof mod.parseEnvFile).toBe('function');
  });

  it('exports getApiPort and getApiUrl', async () => {
    const mod = await import('./config');
    expect(typeof mod.getApiPort).toBe('function');
    expect(typeof mod.getApiUrl).toBe('function');
  });

  it('does not import from electron at module level (lazy load)', () => {
    const { readFileSync } = require('fs');
    const { resolve } = require('path');
    const content = readFileSync(resolve(__dirname, 'config.ts'), 'utf8');

    expect(content).not.toMatch(/^import.*from ['"]electron['"]/m);
  });
});

describe('ensureApiPort — no shared :8000 singleton (contention-class structural fix)', () => {
  beforeEach(() => resetConfig());

  it('getApiPort() throws instead of falling back to :8000 when port unresolved', () => {
    loadConfig('/nonexistent/path', { strict: false });
    expect(() => getApiPort()).toThrow(/refusing to fall back to the shared :8000/);
  });

  it('resolves a per-instance ephemeral port (never :8000) when no explicit API_PORT', async () => {
    loadConfig('/nonexistent/path', { strict: false });
    await ensureApiPort();
    const port = getApiPort();
    expect(port).not.toBe('8000');
    const n = Number(port);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(1024);
    expect(n).toBeLessThan(65536);
  });

  it('uses IPv4 loopback for generated API URLs to match the sidecar bind host', async () => {
    loadConfig('/nonexistent/path', { strict: false });
    await ensureApiPort();
    expect(getApiUrl()).toBe(`http://127.0.0.1:${getApiPort()}`);
  });

  it('two resolutions in separate processes would differ — same process is stable + idempotent', async () => {
    loadConfig('/nonexistent/path', { strict: false });
    await ensureApiPort();
    const first = getApiPort();
    expect(first).toMatch(/^\d+$/);
    await ensureApiPort();
    expect(getApiPort()).toBe(first);
  });

  it('preserves an explicit API_PORT (dev/.env.local/gw worktree/CI unchanged)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-cfg-'));
    try {
      writeFileSync(join(dir, '.env.local'), 'API_PORT=8123\n');
      loadConfig(dir, { strict: false });
      await ensureApiPort();
      expect(getApiPort()).toBe('8123');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives the sidecar URL from the main-process port and IPv4 bind host', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-cfg-'));
    try {
      writeFileSync(
        join(dir, '.env.local'),
        'API_PORT=8124\nVITE_API_URL=https://wrong-host.example:9999/wrong-path\n'
      );
      loadConfig(dir, { strict: false });
      await ensureApiPort();
      expect(getApiUrl()).toBe('http://127.0.0.1:8124');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('explicit E2E-owned sidecar authority', () => {
  beforeEach(() => resetConfig());

  it('overrides file configuration only through the explicit test launch contract', async () => {
    const authority = parseE2eOwnedSidecarAuthority(
      ['electron', '--e2e', '--e2e-owned-sidecar-port=8129'],
      true
    );
    const dir = mkdtempSync(join(tmpdir(), 'wp-cfg-'));
    try {
      writeFileSync(join(dir, '.env.local'), 'API_PORT=8004\nVITE_API_URL=http://localhost:8004\n');
      loadConfig(dir, { strict: false, runtimeSidecarAuthority: authority });
      await ensureApiPort();
      expect(getApiPort()).toBe('8129');
      expect(getApiUrl()).toBe('http://127.0.0.1:8129');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects the override outside the explicit E2E runtime', () => {
    expect(() =>
      parseE2eOwnedSidecarAuthority(['electron', '--e2e-owned-sidecar-port=8129'], false)
    ).toThrow(/requires the explicit E2E test runtime/);
  });

  it.each(['0', '65536', 'not-a-port'] as const)('rejects invalid port %s', (port) => {
    expect(() =>
      parseE2eOwnedSidecarAuthority(['electron', '--e2e', `--e2e-owned-sidecar-port=${port}`], true)
    ).toThrow(/Invalid --e2e-owned-sidecar-port/);
  });

  it('does not accept ambient API_PORT as an override', () => {
    expect(parseE2eOwnedSidecarAuthority(['electron', '--e2e'], true)).toBeUndefined();
  });
});

describe('explicit E2E test runtime', () => {
  it.each(['--e2e', '--waypoint-e2e=1', '--waypoint-test=1'] as const)(
    'accepts %s only with the test-process marker',
    (argument) => {
      expect(isExplicitE2eTestRuntime(['electron', argument], '1')).toBe(true);
      expect(isExplicitE2eTestRuntime(['electron', argument], undefined)).toBe(false);
    }
  );

  it('rejects an ambient test-process marker without an explicit launch argument', () => {
    expect(isExplicitE2eTestRuntime(['electron'], '1')).toBe(false);
  });
});
