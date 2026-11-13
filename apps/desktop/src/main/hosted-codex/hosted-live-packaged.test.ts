import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../__tests__/test-db';
import { createAgentStateCapsuleTable, AgentStateCapsuleStore } from './agent-state-capsule';
import { resolveCodexAppServerBinary } from './app-server-binary';
import { HOSTED_CODEX_MODEL_SLUG } from './app-server-config';
import { startHostedSession, type HostedSession } from './hosted-session';
import { canRunLive, liveApiKey, LIVE_MODELS } from './live-model-fixture';
import { createSupervisorDriver } from './supervisor-driver';
import { createUpstreamStep } from './upstream-responses';

const PACKAGED_RESOURCES = path.resolve(
  __dirname,
  '../../../dist-electron/mac-arm64/DNAForge.app/Contents/Resources'
);

const CAN_RUN = canRunLive() && existsSync(path.join(PACKAGED_RESOURCES, 'binaries'));

describe.skipIf(!CAN_RUN)('a turn through the packaged runtime', () => {
  let session: HostedSession | null = null;
  let root = '';

  afterEach(async () => {
    await session?.close();
    session = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('resolves and runs the App Server a user would get', async () => {
    const binary = resolveCodexAppServerBinary({
      isPackaged: true,
      resourcesPath: PACKAGED_RESOURCES,
    });
    expect(binary.path).toContain('dist-electron');
    expect(binary.path).not.toContain('node_modules');

    root = mkdtempSync(path.join(os.tmpdir(), 'hosted-packaged-'));
    const db = createTestDb();
    createAgentStateCapsuleTable(db);
    const store = new AgentStateCapsuleStore(db);

    session = await startHostedSession({
      binary,
      rootDir: root,
      runId: 'packaged-run',
      model: HOSTED_CODEX_MODEL_SLUG,
      store,
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 120_000,
      step: createUpstreamStep({
        apiKey: liveApiKey(),
        runId: 'packaged-run',
        providerModel: LIVE_MODELS.text,
      }) as never,
    });

    const driver = createSupervisorDriver({ supervisor: session.appServer.supervisor });
    const seen: string[] = [];
    let answer = '';
    const finished = new Promise<void>((resolve) => {
      driver.onNotification((notification) => {
        seen.push(notification.method);
        if (notification.method === 'item/agentMessage/delta') {
          const params = notification.params as { delta?: unknown } | null;
          if (typeof params?.delta === 'string') answer += params.delta;
        }
        if (notification.method === 'turn/completed' || notification.method === 'error') resolve();
      });
    });
    driver.onServerRequest((request) => request.refuse('not under test'));

    await driver.send('Reply with exactly one word: packaged.');
    await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 150_000))]);

    // eslint-disable-next-line no-console
    console.log(`[packaged] answer=${JSON.stringify(answer.slice(0, 80))} seen=${seen.length}`);

    expect(seen).toContain('turn/started');
    expect(seen).toContain('turn/completed');
    expect(seen).not.toContain('error');
    expect(answer.trim().length).toBeGreaterThan(0);
    expect(session.appServer.supervisor.isTerminated).toBe(false);

    expect(store.readActive('packaged-run')?.budget.providerAttempts ?? 0).toBeGreaterThan(0);
  }, 240_000);
});
