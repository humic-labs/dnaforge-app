import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe.skipIf(!canRunLive())('a run that used a tool', () => {
  let session: HostedSession | null = null;
  let root = '';

  afterEach(async () => {
    await session?.close();
    session = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('counts the tool call the model made', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'hosted-mutation-'));
    const db = createTestDb();
    createAgentStateCapsuleTable(db);
    const store = new AgentStateCapsuleStore(db);
    let forwardedToolCalls = 0;

    session = await startHostedSession({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'mutation-run',
      model: HOSTED_CODEX_MODEL_SLUG,
      store,
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 120_000,
      step: ((accepted: never) => {
        const upstream = createUpstreamStep({
          apiKey: liveApiKey(),
          runId: 'mutation-run',
          providerModel: LIVE_MODELS.tools,
        });
        return (async function* () {
          for await (const event of upstream(accepted)) {
            if (event.event === 'tool_call') forwardedToolCalls += 1;
            yield event;
          }
        })();
      }) as never,
    });

    writeFileSync(
      path.join(session.appServer.isolation.cwd, 'READY.txt'),
      'the answer is kumquat\n',
      'utf8'
    );

    const driver = createSupervisorDriver({ supervisor: session.appServer.supervisor });
    const finished = new Promise<void>((resolve) => {
      driver.onNotification((notification) => {
        if (notification.method === 'turn/completed' || notification.method === 'error') resolve();
      });
    });
    driver.onServerRequest((request) => request.refuse('not under test'));

    await driver.send(
      'Use the exec_command tool to run `cat READY.txt` in the working directory. ' +
        'Do not describe it, call the tool, then report its exact output.'
    );
    await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 150_000))]);

    expect(forwardedToolCalls, 'the model never called a tool').toBeGreaterThan(0);

    const active = store.readActive('mutation-run');
    expect(active, 'no capsule for a run that used a tool').not.toBeNull();

    // eslint-disable-next-line no-console
    console.log(
      `[mutation] forwarded=${forwardedToolCalls} budget=${JSON.stringify(active?.budget ?? {})}`
    );

    expect(active?.budget.toolCalls ?? 0).toBeGreaterThan(0);

    expect(active?.budget.tokens ?? 0).toBeGreaterThan(0);
  }, 240_000);
});
