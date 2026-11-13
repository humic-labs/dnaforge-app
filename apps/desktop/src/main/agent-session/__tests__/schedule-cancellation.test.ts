import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: () => tmpdir(), getVersion: () => '1.0.0', isPackaged: false },
}));
vi.mock('../../analytics', () => ({ trackEvent: vi.fn() }));
import { createTestDb } from '../../__tests__/test-db';
import { ensureSchema } from '../../schema';
import { AgentSessionManager } from '../manager';
import { AgentScheduleRegistry } from '../agent-schedule-registry';
import type { QueryOptions } from '../../agent-sdk/query';
import type { AgentTraceToolCallShape } from '../../../shared/agent-runtime-ipc';
import { publicAgentTraceDisplay } from '../../../shared/agent-trace-display';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const context = {
  sessionId: 'session',
  conversationId: 'conversation',
  providerConversationId: 'provider-conversation',
  cwd: '/workspace',
};
function fixture(
  kind: 'cron' | 'wakeup',
  execute: (emit: (call: AgentTraceToolCallShape) => void) => Promise<void>
) {
  const root = mkdtempSync(join(tmpdir(), 'schedule-cancel-'));
  const file = join(root, 'schedules.json');
  const registry = new AgentScheduleRegistry(file, () => 1000);
  const db = createTestDb();
  ensureSchema(db, ':memory:');
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const name = kind === 'cron' ? 'CronCreate' : 'ScheduleWakeup';
  registry.observeTrace(context, {
    toolCalls: [
      {
        id: 'create',
        name,
        status: 'requested',
        input: { prompt: 'selected prompt', cron: '0 * * * *' },
      },
    ],
  });
  registry.observeTrace(context, {
    toolCalls: [
      {
        id: 'create',
        name,
        status: 'completed',
        output: kind === 'cron' ? { id: 'selected' } : { scheduledFor: 120000 },
      },
    ],
  });
  const query = vi.fn(async (_prompt: string, options: QueryOptions) => {
    let sequence = 0;
    await execute((call) =>
      options.traceSink?.({
        transport: 'claude-agent-sdk',
        sequence: sequence++,
        receivedAt: '2026-01-01T00:00:00.000Z',
        providerEventType: 'assistant',
        raw: {},
        display: publicAgentTraceDisplay({ kind: 'tool', title: call.name, status: call.status }),
        toolCalls: [call],
        versions: { sdkVersion: null, cliVersion: null },
      })
    );
    return { ok: true, text: 'Done', durationMs: 1, stopState: 'completed' as const };
  });
  const manager = new AgentSessionManager({
    db,
    releaseChannel: 'development',
    scheduleRegistry: registry,
    queryClaudeCode: query,
  });
  const selected = registry.list()[0].id;
  return { manager, registry, selected, query, file };
}
function deleted(
  emit: (call: AgentTraceToolCallShape) => void,
  requested: string,
  completed = requested
) {
  emit({ id: 'delete', name: 'CronDelete', status: 'requested', input: { id: requested } });
  emit({ id: 'delete', name: 'CronDelete', status: 'completed', output: { id: completed } });
}
it.each(['unrelated', 'mismatch', 'unrequested'])(
  'refuses %s deletion as selected schedule confirmation',
  async (mode) => {
    const f = fixture('cron', async (emit) => {
      if (mode === 'unrelated') deleted(emit, 'other');
      else if (mode === 'mismatch') deleted(emit, 'other', 'selected');
      else
        emit({ id: 'delete', name: 'CronDelete', status: 'completed', output: { id: 'selected' } });
    });
    expect(await f.manager.cancelSchedule(f.selected)).toMatchObject({ ok: false });
    expect(f.registry.get(f.selected)?.status).toBe('active');
    expect(new AgentScheduleRegistry(f.file).get(f.selected)?.status).toBe('active');
  }
);
it('confirms exactly the selected native deletion', async () => {
  const f = fixture('cron', async (emit) => deleted(emit, 'selected'));
  expect(await f.manager.cancelSchedule(f.selected)).toMatchObject({
    ok: true,
    schedule: { status: 'cancelled' },
  });
});
it.each([false, true])('requires unambiguous wakeup identity, ambiguous=%s', async (ambiguous) => {
  const f = fixture('wakeup', async (emit) => {
    emit({ id: 'list', name: 'CronList', status: 'requested', input: {} });
    const job = {
      id: 'native-wake',
      prompt: 'selected prompt',
      recurring: false,
      scheduledFor: 120000,
    };
    emit({
      id: 'list',
      name: 'CronList',
      status: 'completed',
      output: { jobs: ambiguous ? [job, { ...job, id: 'other-wake' }] : [job] },
    });
    deleted(emit, 'native-wake');
  });
  expect(await f.manager.cancelSchedule(f.selected)).toMatchObject({ ok: !ambiguous });
  expect(f.registry.get(f.selected)?.status).toBe(ambiguous ? 'active' : 'cancelled');
});
it('does not submit a second cancellation while the first is pending', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = fixture('cron', async (emit) => {
    await pending;
    deleted(emit, 'selected');
  });
  const first = f.manager.cancelSchedule(f.selected);
  const second = f.manager.cancelSchedule(f.selected);
  finish();
  expect(await first).toMatchObject({ ok: true });
  expect(await second).toMatchObject({ ok: false });
  expect(f.query).toHaveBeenCalledTimes(1);
});
