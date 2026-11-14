import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const fixture = vi.hoisted(() => ({
  port: 0,
  directory: '',
  healthy: false,
  statuses: [] as string[],
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => fixture.directory,
    getAppPath: () => fixture.directory,
    getVersion: () => '1.0.0',
  },
  BrowserWindow: class {},
}));
vi.mock('./config', () => ({
  ensureApiPort: async () => undefined,
  getApiPort: () => String(fixture.port),
  getApiUrl: () => `http://127.0.0.1:${fixture.port}`,
}));
vi.mock('./sidecar-binary', () => ({
  resolveApiDir: () => fixture.directory,
  resolveDevPython: () => process.execPath,
}));
vi.mock('./sidecar-process-launch', () => ({
  resolveDevelopmentSidecarLaunch: () => ({
    executable: process.execPath,
    args: ['-e', fixture.healthy ? `
      const http = require('node:http');
      http.createServer((request, response) => {
        if (request.headers['x-dnaforge-session'] !== process.env.DNAFORGE_MCP_SESSION_TOKEN) {
          response.writeHead(403).end();
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
          app_version: '1.0.0', mcp_grant_capabilities: ['*'],
          runtime_capabilities: ['genome.pysam-htslib.v1'],
          route_features: ['tiles.coverage-readiness.v1', 'tiles.coverage-assembly.v1',
            'tiles.coverage-tile.v1', 'tiles.alignment.v1', 'tiles.annotation.v1',
            'auth.default-deny.v1'],
          mcp_http_internal_port: null
        }));
      }).listen(${fixture.port}, '127.0.0.1');
    ` : 'process.exit(1)'],
    ownerEnv: {},
  }),
}));
vi.mock('./crash-loop-runtime', () => ({
  crashLoopBreaker: { isSafeMode: () => false, record: vi.fn() },
  onCrashLoop: vi.fn(), processExitSnapshot: () => ({}), watchProcessMemory: vi.fn(),
}));
vi.mock('./analytics', () => ({ trackSidecarLifecycleEvent: vi.fn() }));
vi.mock('./sentry', () => ({ captureSidecarLifecycleEvent: vi.fn() }));
vi.mock('./diagnostics-upload', () => ({ reportBootOrCrashFailure: vi.fn() }));
vi.mock('./boot-log', () => ({ appendBootLog: vi.fn() }));
vi.mock('./sidecar-owner-reclaim', () => ({ reclaimAbandonedLockHolders: async () => undefined }));
vi.mock('./operation-connection-receipt', () => ({ retireOperationConnectionReceipt: vi.fn() }));
vi.mock('./compute/credentials', () => ({ deleteComputeCredential: vi.fn() }));
vi.mock('./compute/manifest-paths', () => ({
  computeManifestEnvironment: () => ({}),
  finalizeInterruptedComputeManifestRemovals: async () => ({ finalized: [], failures: [] }),
}));
vi.mock('./mcp-http-listener', () => ({
  mcpHttpAllowedHostsFile: () => join(fixture.directory, 'hosts'), setMcpHttpInternalPort: vi.fn(),
}));
vi.mock('./track-store', () => ({ trackStoreEnv: () => ({}) }));
vi.mock('./renderer-allowed-origins', () => ({ rendererAllowedOriginsEnv: () => ({}) }));
vi.mock('../shared/ipc-contract', () => ({
  sendRendererIpc: (_contents: unknown, _channel: string, status: string) => fixture.statuses.push(status),
}));

let supervisor: typeof import('./sidecar');

async function driveUntil(complete: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !complete(); attempt++) {
    await delay(5);
    await vi.advanceTimersByTimeAsync(500);
  }
  expect(complete()).toBe(true);
}

beforeEach(async () => {
  vi.resetModules();
  fixture.directory = mkdtempSync(join(tmpdir(), 'dnaforge-sidecar-lifecycle-'));
  fixture.healthy = false;
  fixture.statuses = [];
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  fixture.port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  supervisor = await import('./sidecar');
});

afterEach(async () => {
  let stopped = false;
  const shutdown = supervisor?.killSidecar().finally(() => { stopped = true; });
  if (shutdown) {
    await driveUntil(() => stopped);
    await shutdown;
  }
  vi.useRealTimers();
  rmSync(fixture.directory, { recursive: true, force: true });
});

it('settles exhausted restarts, recovers manually, restarts a crashed child and shuts down', async () => {
  const { sidecarSessionAuthority: authority } = await import('./sidecar-session-runtime');
  const outcomes: unknown[] = [];
  const waiting = authority.waitForReadySnapshot(300_000).then(
    (value) => outcomes.push(value), (error: unknown) => outcomes.push(error)
  );
  const window = { isDestroyed: () => false, webContents: {} };
  const starting = supervisor.startSidecar(window as never);
  await driveUntil(() => supervisor.getLastSidecarStatus() === 'error');
  await starting;
  expect(authority.snapshot().state).toBe('error');
  expect(outcomes).toEqual([expect.objectContaining({ code: 'SIDECAR_SESSION_UNAVAILABLE' })]);
  await waiting;
  await expect(authority.waitForReadySnapshot()).rejects.toMatchObject({ code: 'SIDECAR_SESSION_UNAVAILABLE' });
  expect(supervisor.getSidecarProcessPid()).toBeNull();
  const exhaustedGeneration = authority.snapshot().generation;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(authority.snapshot().generation).toBe(exhaustedGeneration);
  expect(fixture.statuses.at(-1)).toBe(authority.snapshot().state);

  fixture.healthy = true;
  const restarting = supervisor.restartSidecar();
  await driveUntil(() => supervisor.getLastSidecarStatus() === 'ready');
  await restarting;
  const firstReady = await authority.waitForReadySnapshot();
  const childPid = supervisor.getSidecarProcessPid();
  expect(childPid).not.toBeNull();
  expect(firstReady.generation).toBeGreaterThan(exhaustedGeneration);
  expect(authority.markReady(exhaustedGeneration)).toBe(false);
  const response = await fetch(`http://127.0.0.1:${fixture.port}/health`, {
    headers: { 'X-DNAForge-Session': authority.currentToken() },
  });
  expect(response.ok).toBe(true);

  process.kill(childPid!, 'SIGTERM');
  await driveUntil(() => authority.snapshot().generation > firstReady.generation && supervisor.getLastSidecarStatus() === 'ready');
  expect(supervisor.getSidecarProcessPid()).not.toBe(childPid);
  expect(authority.isCurrent(firstReady)).toBe(false);
  expect(fixture.statuses.at(-1)).toBe(authority.snapshot().state);

  let stopped = false;
  const shutdown = supervisor.killSidecar().then(() => { stopped = true; });
  expect(supervisor.getLastSidecarStatus()).toBe('stopped');
  await expect(authority.waitForReadySnapshot()).rejects.toMatchObject({ code: 'SIDECAR_SESSION_UNAVAILABLE' });
  await driveUntil(() => stopped);
  await shutdown;
  expect(supervisor.getSidecarProcessPid()).toBeNull();
  expect(fixture.statuses.at(-1)).toBe('stopped');
  await expect(fetch(`http://127.0.0.1:${fixture.port}/health`)).rejects.toThrow();
}, 15_000);
