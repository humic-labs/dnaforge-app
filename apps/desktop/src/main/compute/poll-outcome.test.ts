import { afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: () => '1.0.0' },
}));
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { ComputeJobRegistry, POLL_BASE_MS } from './jobs';

const databases: ReturnType<typeof createTestDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

it.each(['broken-body', 'invalid-json', 'credential-failure'])(
  'records %s as a retry and permits another due job to progress',
  async (failure) => {
    const db = createTestDb();
    databases.push(db);
    ensureSchema(db, ':memory:');
    let now = 1_700_000_000_000;
    let requests = 0;
    const registry = new ComputeJobRegistry({
      db: () => db,
      now: () => now,
      random: () => 0,
      schedule: () => ({ cancel() {} }),
      grantedCapabilities: () => ['external-compute:discover'],
      readCredential: async (provider) => {
        if (provider === 'failing' && failure === 'credential-failure')
          throw new Error('credential unavailable');
        return 'fixture';
      },
      sidecarFetch: async (url) => {
        requests += 1;
        if (String(url).includes('/failing/')) {
          if (failure === 'invalid-json') return new Response('{', { status: 200 });
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('body reset'));
              },
            }),
            { status: 200 }
          );
        }
        return Response.json({
          state: 'completed',
          provider_state: 'complete',
          cost_amount: null,
          cost_unit: null,
          terminal: true,
        });
      },
    });
    const submit = (provider: string) => {
      const job = registry.recordIntent({
        provider,
        toolId: 'tool',
        label: provider,
        settings: {},
        workspaceRoot: '/fixture',
        costEstimate: null,
        costEstimateUnit: null,
        termsSnapshot: null,
      });
      registry.markSubmitted(job.id, `remote-${provider}`);
      return job.id;
    };
    const failedId = submit('failing');
    const goodId = submit('healthy');
    now += POLL_BASE_MS;
    await expect(registry.pollDue()).resolves.toBe(2);
    expect(registry.get(failedId)).toMatchObject({
      state: 'submitted',
      pollCount: 1,
      nextPollAt: new Date(now + POLL_BASE_MS).toISOString(),
      lastError: expect.any(String),
    });
    expect(registry.get(failedId)?.lastError).not.toBe('');
    expect(registry.get(goodId)).toMatchObject({ state: 'completed', nextPollAt: null });
    const before = requests;
    await expect(registry.pollDue()).resolves.toBe(0);
    expect(requests).toBe(before);
    registry.stop();
  }
);
