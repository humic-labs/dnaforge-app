import { mkdtempSync, rmSync } from 'node:fs';
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

describe.skipIf(!canRunLive())('stopping a live turn', () => {
  let session: HostedSession | null = null;
  let root = '';

  afterEach(async () => {
    await session?.close();
    session = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('winds a running turn down through the protocol rather than killing the child', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'hosted-stop-'));
    const db = createTestDb();
    createAgentStateCapsuleTable(db);
    const store = new AgentStateCapsuleStore(db);

    session = await startHostedSession({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'stop-run',
      model: HOSTED_CODEX_MODEL_SLUG,
      store,
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 120_000,
      step: createUpstreamStep({
        apiKey: liveApiKey(),
        runId: 'stop-run',
        providerModel: LIVE_MODELS.tools,
      }) as never,
    });

    const driver = createSupervisorDriver({ supervisor: session.appServer.supervisor });
    const seen: string[] = [];
    const started = new Promise<void>((resolve) => {
      driver.onNotification((notification) => {
        seen.push(notification.method);
        if (notification.method === 'turn/started') resolve();
      });
    });
    driver.onServerRequest((request) => request.refuse('not under test'));

    await driver.send('Count slowly from 1 to 200, one number per line, with no other text.');
    await Promise.race([started, new Promise((resolve) => setTimeout(resolve, 60_000))]);
    expect(seen, 'the turn never started, so there was nothing to stop').toContain('turn/started');

    const threadId = driver.threadId;
    const turnId = driver.turnId;
    expect(threadId, 'no thread to interrupt').not.toBeNull();
    expect(turnId, 'no turn to interrupt').not.toBeNull();

    session.appServer.supervisor.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 8_000));

    expect(session.appServer.supervisor.isTerminated).toBe(false);

    const after = seen.filter((method) => method === 'turn/completed' || method === 'error');
    expect(after.length, 'the turn never ended after the interrupt').toBeGreaterThan(0);
  }, 240_000);
});
