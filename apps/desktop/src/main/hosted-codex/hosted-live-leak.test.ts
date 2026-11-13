import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../__tests__/test-db';
import { createAgentStateCapsuleTable, AgentStateCapsuleStore } from './agent-state-capsule';
import { resolveCodexAppServerBinary } from './app-server-binary';
import { HOSTED_CODEX_MODEL_SLUG } from './app-server-config';
import { startHostedSession, type HostedSession } from './hosted-session';
import { canRunLive, LIVE_MODELS } from './live-model-fixture';
import { createSupervisorDriver } from './supervisor-driver';
import { assertNoInternalIdentifiers } from './user-visible-projection';

describe.skipIf(!canRunLive())('what a failing turn carries', () => {
  let session: HostedSession | null = null;
  let root = '';

  afterEach(async () => {
    await session?.close();
    session = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('does not put provider internals in front of the user', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'hosted-leak-'));
    const db = createTestDb();
    createAgentStateCapsuleTable(db);

    session = await startHostedSession({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'leak-run',
      model: HOSTED_CODEX_MODEL_SLUG,
      store: new AgentStateCapsuleStore(db),
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 60_000,
      step: (() =>
        (async function* () {
          throw new Error(
            'unexpected status 401 Unauthorized: Missing bearer, url: ' +
              'https://example-resource.openai.azure.com/openai/v1/responses, ' +
              'deployment: staging-model-auto, cf-ray: a2e484ad7dcf9d09-SJC'
          );
        })()) as never,
    });

    const driver = createSupervisorDriver({ supervisor: session.appServer.supervisor });
    const errorText: string[] = [];
    const settled = new Promise<void>((resolve) => {
      driver.onNotification((notification) => {
        if (notification.method === 'error') {
          errorText.push(JSON.stringify(notification.params));
        }
        if (notification.method === 'turn/completed' || notification.method === 'error') resolve();
      });
    });
    driver.onServerRequest((request) => request.refuse('not under test'));

    await driver.send('say something');
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 60_000))]);

    expect(
      errorText.length,
      'the turn did not fail, so there is nothing to inspect'
    ).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(`[leak] child saw: ${errorText[0]?.slice(0, 220)}`);

    const combined = errorText.join('\n');
    expect(combined).not.toContain('openai.azure.com');
    expect(combined).not.toContain('staging-model-auto');
    expect(combined).not.toContain('cf-ray');

    expect(() => assertNoInternalIdentifiers(combined, 'the error the child received')).toThrow(
      /internal identifier/u
    );
  }, 180_000);
});
