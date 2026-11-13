import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { HostedStreamEvent } from '@waypoint/hosted-ai-contract';
import { createTestDb } from '../__tests__/test-db';
import { createAgentStateCapsuleTable, AgentStateCapsuleStore } from './agent-state-capsule';
import { resolveCodexAppServerBinary } from './app-server-binary';
import { HOSTED_CODEX_MODEL_SLUG } from './app-server-config';
import { startHostedSession, type HostedSession } from './hosted-session';
import { canRunLive, liveApiKey, LIVE_MODELS } from './live-model-fixture';
import { createSupervisorDriver } from './supervisor-driver';
import { recoverTurn } from './turn-recovery';
import { createUpstreamStep } from './upstream-responses';

const RESERVATION = '5d0f9e18-5f0a-4d9c-9e0e-0f2a2c3b4d5e';

describe.skipIf(!canRunLive())('the capsule after a real turn', () => {
  let session: HostedSession | null = null;
  let root = '';

  afterEach(async () => {
    await session?.close();
    session = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('records a turn a real model completed', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'hosted-capsule-'));
    const db = createTestDb();
    createAgentStateCapsuleTable(db);
    const store = new AgentStateCapsuleStore(db);

    session = await startHostedSession({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'capsule-run',
      model: HOSTED_CODEX_MODEL_SLUG,
      store,
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 120_000,
      step: createUpstreamStep({
        apiKey: liveApiKey(),
        runId: 'capsule-run',
        providerModel: LIVE_MODELS.text,
      }) as never,
    });

    const driver = createSupervisorDriver({ supervisor: session.appServer.supervisor });
    const finished = new Promise<void>((resolve) => {
      driver.onNotification((notification) => {
        if (notification.method === 'turn/completed' || notification.method === 'error') resolve();
      });
    });
    driver.onServerRequest((request) => request.refuse('not under test'));

    await driver.send('Reply with exactly one word: recorded.');
    await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 120_000))]);

    const active = store.readActive('capsule-run');
    expect(active, 'no capsule was written for a turn that completed').not.toBeNull();

    expect(active?.bindings).toMatchObject({ runId: 'capsule-run' });

    expect(active?.generations).toMatchObject({ model: HOSTED_CODEX_MODEL_SLUG });
    expect(String(active?.generations.catalog ?? '')).not.toBe('');

    expect(active?.budget.providerAttempts ?? 0).toBe(1);

    expect(active?.sequence ?? 0).toBeGreaterThan(1);
  }, 180_000);

  it('leaves a recoverable record when the provider fails mid-turn', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'hosted-capsule-fail-'));
    const db = createTestDb();
    createAgentStateCapsuleTable(db);
    const store = new AgentStateCapsuleStore(db);

    session = await startHostedSession({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'capsule-fail-run',
      model: HOSTED_CODEX_MODEL_SLUG,
      store,
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
      step: (() =>
        (async function* (): AsyncGenerator<HostedStreamEvent> {
          yield {
            v: 2,
            seq: 1,
            requestId: 'r',
            runId: 'run',
            turnId: 't',
            stepSequence: 1,
            event: 'accepted',
            reservationId: RESERVATION,
            tier: 'auto',
            catalogVersion: '1.0.0',
            rateCardVersion: '1.0.0',
          };
          throw new Error('the provider went away');
        })()) as never,
    });

    const driver = createSupervisorDriver({ supervisor: session.appServer.supervisor });
    const settled = new Promise<void>((resolve) => {
      driver.onNotification((notification) => {
        if (notification.method === 'turn/completed' || notification.method === 'error') resolve();
      });
    });
    driver.onServerRequest((request) => request.refuse('not under test'));

    await driver.send('say something');
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 40_000))]);

    const recovered = recoverTurn(store.readActive('capsule-fail-run'));

    expect(store.readActive('capsule-fail-run')?.sequence ?? 0).toBeGreaterThan(1);

    expect(recovered.spentBudget.providerAttempts ?? 0).toBeGreaterThan(0);

    expect(recovered.unknownEffects).toEqual([]);
    expect(recovered.outcome).not.toBe('outcome_unknown');
  }, 120_000);
});
