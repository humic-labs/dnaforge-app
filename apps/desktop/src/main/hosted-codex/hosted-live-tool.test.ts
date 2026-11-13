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

describe.skipIf(!canRunLive())('a real model reaching for a tool', () => {
  let session: HostedSession | null = null;
  let root = '';

  afterEach(async () => {
    await session?.close();
    session = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('asks this runtime before it runs anything', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'hosted-live-tool-'));
    const db = createTestDb();
    createAgentStateCapsuleTable(db);
    const upstream = createUpstreamStep({
      apiKey: liveApiKey(),
      runId: 'live-tool-run',
      providerModel: LIVE_MODELS.tools,
    });

    let steps = 0;
    const toolsOffered: string[][] = [];
    session = await startHostedSession({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'live-tool-run',
      model: HOSTED_CODEX_MODEL_SLUG,
      store: new AgentStateCapsuleStore(db),
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 120_000,
      step: ((accepted: Parameters<ReturnType<typeof createUpstreamStep>>[0]) => {
        steps += 1;
        toolsOffered.push([...accepted.toolNames]);
        return upstream(accepted);
      }) as never,
    });

    writeFileSync(
      path.join(session.appServer.isolation.cwd, 'READY.txt'),
      'the answer is kumquat\n',
      'utf8'
    );

    const driver = createSupervisorDriver({ supervisor: session.appServer.supervisor });
    const asked: string[] = [];
    const seen: string[] = [];
    let answer = '';
    const settled = new Promise<void>((resolve) => {
      driver.onNotification((notification) => {
        seen.push(notification.method);
        if (notification.method === 'item/agentMessage/delta') {
          const p2 = notification.params as { delta?: unknown } | null;
          if (typeof p2?.delta === 'string') answer += p2.delta;
        }
        if (notification.method === 'error') {
          // eslint-disable-next-line no-console
          console.log('[live-tool] error:', JSON.stringify(notification.params).slice(0, 400));
        }
        if (notification.method === 'item/started' || notification.method === 'item/completed') {
          // eslint-disable-next-line no-console
          console.log('[live-tool] item:', JSON.stringify(notification.params).slice(0, 260));
        }
        if (notification.method === 'turn/completed' || notification.method === 'error') resolve();
      });
    });

    driver.onServerRequest((request) => {
      asked.push(request.method);
      request.refuse('declined by the live tool test');
    });

    await driver.send(
      'Use the exec_command tool to run `cat READY.txt` in the working directory. ' +
        'Do not describe what you are about to do and do not answer from memory: ' +
        'call the tool, then report its exact output.'
    );
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 180_000))]);

    // eslint-disable-next-line no-console
    console.log(
      `[live-tool] model=${LIVE_MODELS.tools} steps=${steps} asked=${JSON.stringify(asked)} ` +
        `tools=${JSON.stringify(toolsOffered[0] ?? [])}`
    );
    // eslint-disable-next-line no-console
    console.log('[live-tool] seen:', JSON.stringify(seen));
    // eslint-disable-next-line no-console
    console.log('[live-tool] answer:', JSON.stringify(answer.slice(0, 300)));

    expect(toolsOffered[0] ?? []).toContain('exec_command');

    expect(steps).toBe(2);

    expect(answer).toContain('kumquat');

    for (const method of asked) {
      expect(
        ['item/tool/call', 'item/commandExecution/requestApproval'],
        `unexpected ask: ${method}`
      ).toContain(method);
    }

    expect(session.appServer.supervisor.isTerminated).toBe(false);
  }, 300_000);
});
