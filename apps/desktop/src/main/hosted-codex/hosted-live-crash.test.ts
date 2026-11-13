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
import { recoverTurn } from './turn-recovery';
import { createUpstreamStep } from './upstream-responses';

describe.skipIf(!canRunLive())('after the child dies mid-turn', () => {
  let session: HostedSession | null = null;
  let root = '';

  afterEach(async () => {
    await session?.close();
    session = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('leaves a record a later process can act on', async () => {
    let stepStarted = false;
    root = mkdtempSync(path.join(os.tmpdir(), 'hosted-crash-'));
    const db = createTestDb();
    createAgentStateCapsuleTable(db);
    const store = new AgentStateCapsuleStore(db);

    session = await startHostedSession({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'crash-run',
      model: HOSTED_CODEX_MODEL_SLUG,
      store,
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 120_000,
      step: ((accepted: never) => {
        stepStarted = true;
        return createUpstreamStep({
          apiKey: liveApiKey(),
          runId: 'crash-run',
          providerModel: LIVE_MODELS.tools,
        })(accepted);
      }) as never,
    });

    const driver = createSupervisorDriver({ supervisor: session.appServer.supervisor });
    const started = new Promise<void>((resolve) => {
      driver.onNotification((notification) => {
        if (notification.method === 'turn/started') resolve();
      });
    });
    driver.onServerRequest((request) => request.refuse('not under test'));

    await driver.send('Count slowly from 1 to 200, one number per line, with no other text.');
    await Promise.race([started, new Promise((resolve) => setTimeout(resolve, 90_000))]);

    const deadline = Date.now() + 60_000;
    while (!stepStarted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(stepStarted, 'the turn never reached the gateway').toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const pid = session.appServer.supervisor.childPid;
    expect(pid, 'no child pid, so nothing specific to kill').toBeGreaterThan(0);

    process.kill(pid as number, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    expect(session.appServer.supervisor.isTerminated).toBe(true);

    const recovered = recoverTurn(store.readActive('crash-run'));
    expect(recovered.spentBudget.providerAttempts ?? 0).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(
      `[crash] resumable=${recovered.resumable} refusal=${String(recovered.refusal)} ` +
        `unknownEffects=${JSON.stringify(recovered.unknownEffects)} ` +
        `outcome=${String(recovered.outcome)} budget=${JSON.stringify(recovered.spentBudget)}`
    );

    expect(recovered.unknownEffects).toEqual([]);

    expect(recovered.spentBudget.providerAttempts).toBe(1);
    expect(recovered.resumable).toBe(true);
  }, 240_000);
});
