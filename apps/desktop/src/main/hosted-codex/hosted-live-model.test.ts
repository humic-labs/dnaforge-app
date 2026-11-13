import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../__tests__/test-db';
import { recoverTurn } from './turn-recovery';
import { createAgentStateCapsuleTable, AgentStateCapsuleStore } from './agent-state-capsule';
import { resolveCodexAppServerBinary } from './app-server-binary';
import { HOSTED_CODEX_MODEL_SLUG } from './app-server-config';
import { startHostedSession, type HostedSession } from './hosted-session';
import { canRunLive, liveApiKey, LIVE_MODELS } from './live-model-fixture';
import { createSupervisorDriver } from './supervisor-driver';
import { createUpstreamStep } from './upstream-responses';

describe.skipIf(!canRunLive())('a real model through the local Hosted adapter', () => {
  let session: HostedSession | null = null;
  let root = '';

  afterEach(async () => {
    await session?.close();
    session = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('completes a turn and reports what it cost', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'hosted-live-model-'));
    const db = createTestDb();
    createAgentStateCapsuleTable(db);
    const store = new AgentStateCapsuleStore(db);

    const upstream = createUpstreamStep({
      apiKey: liveApiKey(),
      runId: 'live-model-run',
      providerModel: LIVE_MODELS.text,
    });
    let steps = 0;
    let reportedInputTokens: number | null = null;
    let reportedOutputTokens: number | null = null;
    let instructionBytes = 0;

    session = await startHostedSession({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'live-model-run',
      model: HOSTED_CODEX_MODEL_SLUG,
      store,
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 120_000,
      step: ((accepted: Parameters<ReturnType<typeof createUpstreamStep>>[0]) => {
        steps += 1;
        instructionBytes = Buffer.byteLength(accepted.instructions ?? '', 'utf8');
        return (async function* () {
          for await (const event of upstream(accepted)) {
            if (event.event === 'finish') {
              reportedInputTokens = event.usage.inputTokens;
              reportedOutputTokens = event.usage.outputTokens;
            }
            yield event;
          }
        })();
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
        if (notification.method === 'error') {
          // eslint-disable-next-line no-console
          console.log('[live-model] error:', JSON.stringify(notification.params).slice(0, 500));
        }
        if (notification.method === 'turn/completed' || notification.method === 'error') resolve();
      });
    });
    driver.onServerRequest((request) => request.refuse('not under test'));

    await driver.send('Reply with exactly the word: pineapple. Do not use any tool.');
    await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 180_000))]);

    // eslint-disable-next-line no-console
    console.log(
      `[live-model] model=${LIVE_MODELS.text} steps=${steps} instructionBytes=${instructionBytes} ` +
        `inputTokens=${String(reportedInputTokens)} outputTokens=${String(reportedOutputTokens)} ` +
        `answer=${JSON.stringify(answer.slice(0, 120))}`
    );

    // eslint-disable-next-line no-console
    console.log('[live-model] seen:', JSON.stringify(seen));
    expect(seen).toContain('turn/started');
    expect(seen).toContain('turn/completed');
    expect(seen).not.toContain('error');
    expect(session.appServer.supervisor.isTerminated).toBe(false);

    expect(answer.trim().length).toBeGreaterThan(0);

    expect(steps).toBe(1);

    expect(reportedInputTokens ?? 0).toBeGreaterThan(0);
    expect(reportedOutputTokens ?? 0).toBeGreaterThan(0);

    const recovered = recoverTurn(store.readActive('live-model-run'));
    expect(recovered.spentBudget.providerAttempts ?? 0).toBe(1);
    expect(recovered.unknownEffects).toEqual([]);
    if (instructionBytes > 0) {
      expect(reportedInputTokens ?? 0).toBeGreaterThan(instructionBytes / 8);
    }
  }, 300_000);
});
