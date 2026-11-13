import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AppServerLaunchError,
  EXPECTED_PROTOCOL_GENERATION,
  launchAppServer,
} from './app-server-launcher';
import type { ResolvedCodexAppServerBinary } from './app-server-binary';

const BINARY: ResolvedCodexAppServerBinary = {
  path: '/pinned/codex-app-server',
  version: '0.148.0',
  versionOutput: 'codex-app-server 0.148.0',
  triple: 'aarch64-apple-darwin',
  packageVersion: '0.9.0',
  sha256: 'a'.repeat(64),
};

let roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'launcher-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

function fakeSpawn(behavior: {
  readonly reply?: (request: Record<string, unknown>) => unknown;
  readonly replyFor?: (state: {
    spawnedWith: null | Record<string, unknown>;
  }) => (request: Record<string, unknown>) => unknown;
  readonly throwOnSpawn?: Error;
  readonly exitImmediately?: boolean;
  readonly silent?: boolean;
}) {
  const state = {
    killed: [] as string[],
    spawnedWith: null as null | Record<string, unknown>,
    exitChild: (): void => {},
  };
  const spawn = ((command: string, args: readonly string[], opts: Record<string, unknown>) => {
    if (behavior.throwOnSpawn) throw behavior.throwOnSpawn;
    state.spawnedWith = { command, args: [...args], ...opts };
    const stdout = new EventEmitter();
    const exit = new EventEmitter();
    const child = {
      stdin: {
        write: (chunk: string) => {
          if (behavior.silent) return;
          const request = JSON.parse(chunk) as Record<string, unknown>;
          const responder = behavior.replyFor?.(state) ?? behavior.reply;
          const payload = responder?.(request);
          if (payload === undefined) return;
          queueMicrotask(() =>
            stdout.emit('data', Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8'))
          );
        },
      },
      stdout,
      on: (event: 'exit', listener: () => void) => void exit.on(event, listener),
      kill: (signal = 'SIGTERM') => void state.killed.push(signal),
    };
    if (behavior.exitImmediately) queueMicrotask(() => exit.emit('exit'));
    state.exitChild = () => exit.emit('exit', 0, null);
    return child as never;
  }) as never;
  return { spawn, state };
}

function okReplyFor(state: { spawnedWith: null | Record<string, unknown> }) {
  return (request: Record<string, unknown>) => {
    const env = (state.spawnedWith?.env ?? {}) as NodeJS.ProcessEnv;
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        userAgent: 'dnaforge/0.148.0',
        codexHome: env.CODEX_HOME,
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    };
  };
}

function runtimeDirs(dir: string): string[] {
  const base = path.join(dir, 'hosted-codex-runtime');
  try {
    return readdirSync(base);
  } catch {
    return [];
  }
}

describe('App Server launcher', () => {
  it('spawns the pinned binary into the isolated environment', async () => {
    const dir = root();
    const { spawn, state } = fakeSpawn({ replyFor: okReplyFor });
    const launched = await launchAppServer({ binary: BINARY, rootDir: dir, spawn, runId: 'r1' });

    expect(state.spawnedWith?.command).toBe('/pinned/codex-app-server');
    expect(state.spawnedWith?.cwd).toBe(launched.isolation.cwd);
    const env = state.spawnedWith?.env as NodeJS.ProcessEnv;
    expect(env.CODEX_HOME).toBe(launched.isolation.codexHome);
    expect(env).not.toHaveProperty('PATH');
    launched.dispose();
  });

  it('validates the real fail-closed model catalog before spawning a Hosted provider', async () => {
    const dir = root();
    const { spawn, state } = fakeSpawn({ replyFor: okReplyFor });
    const launched = await launchAppServer({
      binary: BINARY,
      rootDir: dir,
      spawn,
      runId: 'hosted-catalog',
      hostedProviderBaseUrl: 'http://127.0.0.1:49152/v1',
      injectedEnv: { OPENAI_API_KEY: 'ephemeral-loopback-bearer' },
    });

    const env = state.spawnedWith?.env as NodeJS.ProcessEnv;
    const home = env.CODEX_HOME;
    expect(home).toBe(launched.isolation.codexHome);
    expect(readdirSync(home ?? '').sort()).toEqual(['config.toml', 'model-catalog.json']);
    const catalog = JSON.parse(
      readFileSync(path.join(home ?? '', 'model-catalog.json'), 'utf8')
    ) as {
      models: Array<Record<string, unknown>>;
    };
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      slug: 'gpt-5-codex',
      shell_type: 'disabled',
      apply_patch_tool_type: null,
      supports_search_tool: false,
      experimental_supported_tools: [],
    });
    expect(readFileSync(path.join(home ?? '', 'config.toml'), 'utf8')).not.toContain(
      'ephemeral-loopback-bearer'
    );
    launched.dispose();
  });

  it('sends only the fields the protocol actually has', async () => {
    const dir = root();
    const seen: Record<string, unknown>[] = [];
    const { spawn } = fakeSpawn({
      replyFor: (state) => (request) => {
        seen.push(request);
        return okReplyFor(state)(request);
      },
    });
    const launched = await launchAppServer({ binary: BINARY, rootDir: dir, spawn, runId: 'r2' });

    const params = seen[0]?.params as Record<string, unknown>;
    expect(params).toEqual({
      clientInfo: { name: 'dnaforge', version: BINARY.packageVersion },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        optOutNotificationMethods: [],
        extensions: {},
      },
    });
    expect(Object.keys(params).sort()).toEqual(['capabilities', 'clientInfo']);
    launched.dispose();
  });

  it('leaves no process and no directory when the spawn itself fails', async () => {
    const dir = root();
    const { spawn } = fakeSpawn({ throwOnSpawn: new Error('ENOENT') });
    await expect(launchAppServer({ binary: BINARY, rootDir: dir, spawn })).rejects.toMatchObject({
      code: 'spawn_failed',
    });
    expect(runtimeDirs(dir)).toEqual([]);
  });

  it('refuses a child running against a Codex home this launch did not create', async () => {
    const dir = root();
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'not-our-home-'));
    roots.push(elsewhere);
    const { spawn, state } = fakeSpawn({
      reply: (request) => ({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          userAgent: 'dnaforge/0.148.0',
          codexHome: elsewhere,
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      }),
    });
    await expect(
      launchAppServer({ binary: BINARY, rootDir: dir, spawn, runId: 'r3' })
    ).rejects.toMatchObject({ code: 'protocol_mismatch' });
    expect(state.killed).toContain('SIGTERM');
    expect(runtimeDirs(dir)).toEqual([]);
  });

  it('takes its version guarantee from the artifact, not the handshake', () => {
    expect(BINARY.version).toBe('0.148.0');
    expect(BINARY.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses a handshake that answers with no result', async () => {
    const dir = root();
    const { spawn } = fakeSpawn({
      reply: (request) => ({ jsonrpc: '2.0', id: request.id, result: null }),
    });
    await expect(
      launchAppServer({ binary: BINARY, rootDir: dir, spawn, runId: 'r5' })
    ).rejects.toBeInstanceOf(AppServerLaunchError);
    expect(runtimeDirs(dir)).toEqual([]);
  });

  it('reports a child that dies during the handshake as an early exit', async () => {
    const dir = root();
    const { spawn } = fakeSpawn({ silent: true, exitImmediately: true });
    await expect(
      launchAppServer({ binary: BINARY, rootDir: dir, spawn, runId: 'r6' })
    ).rejects.toMatchObject({ code: 'child_exited_early' });
    expect(runtimeDirs(dir)).toEqual([]);
  });

  it('separates a handshake the live child refused from a child that died', async () => {
    const dir = root();
    const { spawn } = fakeSpawn({
      reply: (request) => ({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32603, message: 'initialize is not available' },
      }),
    });
    await expect(
      launchAppServer({ binary: BINARY, rootDir: dir, spawn, runId: 'r-refused' })
    ).rejects.toMatchObject({ code: 'handshake_failed' });
    expect(runtimeDirs(dir)).toEqual([]);
  });

  it('cleans up when the handshake times out rather than leaking the child', async () => {
    const dir = root();
    const { spawn, state } = fakeSpawn({ silent: true });
    await expect(
      launchAppServer({
        binary: BINARY,
        rootDir: dir,
        spawn,
        runId: 'r7',
        handshakeTimeoutMs: 20,
      })
    ).rejects.toBeInstanceOf(AppServerLaunchError);
    expect(state.killed).toContain('SIGTERM');
    expect(runtimeDirs(dir)).toEqual([]);
  });

  it('does not let the handshake bound become the bound on every later request', async () => {
    const dir = root();
    const { spawn } = fakeSpawn({
      replyFor: (state) => (request) =>
        request.method === 'initialize' ? okReplyFor(state)(request) : undefined,
    });
    const launched = await launchAppServer({
      binary: BINARY,
      rootDir: dir,
      spawn,
      runId: 'r-timeouts',
      handshakeTimeoutMs: 20,
      requestTimeoutMs: 5_000,
    });

    let settled = false;
    void launched.supervisor.request('thread/start').then(
      () => void (settled = true),
      () => void (settled = true)
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(settled).toBe(false);
    launched.dispose();
  });

  it('removes the private directory when the child exits on its own', async () => {
    const dir = root();
    const { spawn, state } = fakeSpawn({ replyFor: okReplyFor });
    await launchAppServer({ binary: BINARY, rootDir: dir, spawn, runId: 'r-exit' });
    expect(runtimeDirs(dir)).toHaveLength(1);

    state.exitChild();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtimeDirs(dir)).toEqual([]);
  });

  it('disposes idempotently, so a second stop is not an error', async () => {
    const dir = root();
    const { spawn, state } = fakeSpawn({ replyFor: okReplyFor });
    const launched = await launchAppServer({ binary: BINARY, rootDir: dir, spawn, runId: 'r8' });
    launched.dispose();
    launched.dispose();
    expect(state.killed.length).toBeGreaterThanOrEqual(1);
    expect(runtimeDirs(dir)).toEqual([]);
  });

  it('gives each run its own private directories', async () => {
    const dir = root();
    const a = await launchAppServer({
      binary: BINARY,
      rootDir: dir,
      spawn: fakeSpawn({ replyFor: okReplyFor }).spawn,
      runId: 'run-a',
    });
    const b = await launchAppServer({
      binary: BINARY,
      rootDir: dir,
      spawn: fakeSpawn({ replyFor: okReplyFor }).spawn,
      runId: 'run-b',
    });
    expect(a.isolation.codexHome).not.toBe(b.isolation.codexHome);
    a.dispose();
    b.dispose();
  });
});
