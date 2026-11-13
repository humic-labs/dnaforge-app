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

describe.skipIf(!canRunLive())('restarting a run', () => {
  const open: HostedSession[] = [];
  let root = '';

  afterEach(async () => {
    for (const session of open.splice(0)) await session.close();
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  async function startFor(
    store: AgentStateCapsuleStore,
    runId: string,
    dir: string
  ): Promise<HostedSession> {
    const session = await startHostedSession({
      binary: resolveCodexAppServerBinary(),
      rootDir: dir,
      runId,
      model: HOSTED_CODEX_MODEL_SLUG,
      store,
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 120_000,
      step: createUpstreamStep({
        apiKey: liveApiKey(),
        runId,
        providerModel: LIVE_MODELS.text,
      }) as never,
    });
    open.push(session);
    return session;
  }

  async function runTurn(session: HostedSession, prompt: string): Promise<string[]> {
    const driver = createSupervisorDriver({ supervisor: session.appServer.supervisor });
    const seen: string[] = [];
    const finished = new Promise<void>((resolve) => {
      driver.onNotification((notification) => {
        seen.push(notification.method);
        if (notification.method === 'error') {
          // eslint-disable-next-line no-console
          console.log('[restart] error:', JSON.stringify(notification.params).slice(0, 260));
        }
        if (notification.method === 'turn/completed' || notification.method === 'error') resolve();
      });
    });
    driver.onServerRequest((request) => request.refuse('not under test'));
    await driver.send(prompt);
    await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 120_000))]);
    return seen;
  }

  it('lets a second session carry on the run the first one recorded', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'hosted-restart-'));
    const db = createTestDb();
    createAgentStateCapsuleTable(db);
    const store = new AgentStateCapsuleStore(db);

    const first = await startFor(store, 'restart-run', path.join(root, 'first'));
    const firstSeen = await runTurn(first, 'Reply with exactly one word: first.');
    // eslint-disable-next-line no-console
    console.log('[restart] first seen:', JSON.stringify(firstSeen));
    expect(firstSeen, 'the FIRST session failed').toContain('turn/completed');

    const afterFirst = store.readActive('restart-run');
    expect(afterFirst, 'the first session recorded nothing').not.toBeNull();
    const sequenceAfterFirst = afterFirst?.sequence ?? 0;
    const attemptsAfterFirst = afterFirst?.budget.providerAttempts ?? 0;
    expect(attemptsAfterFirst).toBeGreaterThan(0);

    await first.close();
    open.splice(open.indexOf(first), 1);

    const recovered = recoverTurn(store.readActive('restart-run'));
    expect(recovered.resumable, 'a completed run is not resumable').toBe(true);

    const second = await startFor(store, 'restart-run', path.join(root, 'second'));
    const secondSeen = await runTurn(second, 'Reply with exactly one word: second.');
    // eslint-disable-next-line no-console
    console.log('[restart] second seen:', JSON.stringify(secondSeen));
    expect(secondSeen, 'the SECOND session failed').toContain('turn/completed');

    const afterSecond = store.readActive('restart-run');

    // eslint-disable-next-line no-console
    console.log(
      `[restart] first: seq=${sequenceAfterFirst} attempts=${attemptsAfterFirst} | ` +
        `second: seq=${afterSecond?.sequence ?? 0} attempts=${afterSecond?.budget.providerAttempts ?? 0}`
    );

    expect(afterSecond?.sequence ?? 0).toBeGreaterThan(sequenceAfterFirst);
    expect(afterSecond?.budget.providerAttempts ?? 0).toBeGreaterThan(attemptsAfterFirst);
  }, 300_000);
});
