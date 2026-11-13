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

describe.skipIf(!canRunLive())('when the child asks permission', () => {
  let session: HostedSession | null = null;
  let root = '';

  afterEach(async () => {
    await session?.close();
    session = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  async function runTurn(prompt: string): Promise<{
    asked: string[];
    seen: string[];
    answer: string;
  }> {
    root = mkdtempSync(path.join(os.tmpdir(), 'hosted-approval-'));
    const db = createTestDb();
    createAgentStateCapsuleTable(db);

    session = await startHostedSession({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'approval-run',
      model: HOSTED_CODEX_MODEL_SLUG,
      store: new AgentStateCapsuleStore(db),
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 120_000,
      step: createUpstreamStep({
        apiKey: liveApiKey(),
        runId: 'approval-run',
        providerModel: LIVE_MODELS.tools,
      }) as never,
    });

    const driver = createSupervisorDriver({ supervisor: session.appServer.supervisor });
    const asked: string[] = [];
    const seen: string[] = [];
    let answer = '';
    const settled = new Promise<void>((resolve) => {
      driver.onNotification((notification) => {
        seen.push(notification.method);
        if (notification.method === 'item/agentMessage/delta') {
          const params = notification.params as { delta?: unknown } | null;
          if (typeof params?.delta === 'string') answer += params.delta;
        }
        if (notification.method === 'turn/completed' || notification.method === 'error') resolve();
      });
    });

    driver.onServerRequest((request) => {
      asked.push(request.method);
      request.refuse('declined by the approval test');
    });

    await driver.send(prompt);
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 150_000))]);
    return { asked, seen, answer };
  }

  it('is consulted when the model reaches outside its sandbox', async () => {
    const outside = path.join(os.tmpdir(), `hosted-approval-escape-${process.pid}.txt`);
    const { asked, seen } = await runTurn(
      `Use the exec_command tool to run: printf escaped > ${outside}\n` +
        'Do not describe it, call the tool. Report the exact result.'
    );

    // eslint-disable-next-line no-console
    console.log(`[approval] asked=${JSON.stringify(asked)} seen=${seen.length}`);

    expect(session?.appServer.supervisor.isTerminated).toBe(false);

    for (const method of asked) {
      expect(
        [
          'item/tool/call',
          'item/commandExecution/requestApproval',
          'item/fileChange/requestApproval',
        ],
        `unexpected ask: ${method}`
      ).toContain(method);
    }

    const { existsSync } = await import('node:fs');
    expect(existsSync(outside), 'the model wrote outside the sandbox').toBe(false);
  }, 240_000);
});
