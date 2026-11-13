import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  AgentScheduleRecordShape,
  AgentTraceToolCallShape,
} from '../../shared/agent-runtime-ipc';

interface ScheduleContext {
  sessionId: string;
  conversationId: string | null;
  providerConversationId: string | null;
  cwd: string;
}

interface ScheduleTrace {
  toolCalls?: AgentTraceToolCallShape[];
}

interface PendingTool {
  context: ScheduleContext;
  input: Record<string, unknown>;
  name: string;
}

interface PersistedRegistry {
  version: 1;
  schedules: AgentScheduleRecordShape[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, 1_000) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPersistedSchedule(value: unknown): value is AgentScheduleRecordShape {
  const item = record(value);
  return Boolean(
    item &&
    typeof item.id === 'string' &&
    typeof item.nativeId === 'string' &&
    (item.kind === 'cron' || item.kind === 'wakeup') &&
    item.provider === 'claude-agent-sdk' &&
    typeof item.sessionId === 'string' &&
    typeof item.cwd === 'string' &&
    (item.status === 'active' || item.status === 'cancelling' || item.status === 'cancelled')
  );
}

type CancellationState =
  | { status: 'resolving' }
  | { status: 'requested'; nativeId: string }
  | { status: 'confirmed'; nativeId: string }
  | { status: 'failed' };

export class ScheduleCancellation {
  private state: CancellationState;
  private readonly pending = new Map<string, { name: string; input: Record<string, unknown> }>();

  constructor(private readonly schedule: AgentScheduleRecordShape) {
    this.state =
      schedule.kind === 'cron'
        ? { status: 'requested', nativeId: schedule.nativeId }
        : { status: 'resolving' };
  }

  get confirmed(): boolean {
    return this.state.status === 'confirmed';
  }

  observe(trace: ScheduleTrace): void {
    for (const call of trace.toolCalls ?? []) {
      if (this.state.status === 'confirmed' || this.state.status === 'failed') return;
      if (call.status === 'requested' || call.status === 'running') {
        const input = record(call.input);
        if (input) this.pending.set(call.id, { name: call.name, input });
        continue;
      }
      const pending = this.pending.get(call.id);
      this.pending.delete(call.id);
      if (call.status !== 'completed' || pending?.name !== call.name) continue;
      const output = record(call.output);
      if (call.name === 'CronList' && this.state.status === 'resolving') {
        const jobs = output?.jobs;
        const candidates = Array.isArray(jobs)
          ? jobs
              .map(record)
              .filter(
                (job) =>
                  job &&
                  typeof job.id === 'string' &&
                  job.id.length > 0 &&
                  job.prompt === this.schedule.prompt &&
                  job.recurring === false &&
                  this.schedule.scheduledFor !== null &&
                  job.scheduledFor === this.schedule.scheduledFor
              )
          : [];
        this.state =
          candidates.length === 1
            ? { status: 'requested', nativeId: candidates[0]!.id as string }
            : { status: 'failed' };
      } else if (call.name === 'CronDelete') {
        if (
          this.state.status !== 'requested' ||
          !output ||
          pending.input.id !== this.state.nativeId ||
          (output.id !== undefined && output.id !== this.state.nativeId) ||
          output.ok === false ||
          output.error
        ) {
          this.state = { status: 'failed' };
        } else {
          this.state = { status: 'confirmed', nativeId: this.state.nativeId };
        }
      }
    }
  }
}

export class AgentScheduleRegistry {
  private readonly schedules = new Map<string, AgentScheduleRecordShape>();
  private readonly pending = new Map<string, PendingTool>();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      const root = record(parsed);
      if (root?.version !== 1 || !Array.isArray(root.schedules)) return;
      for (const schedule of root.schedules) {
        if (isPersistedSchedule(schedule))
          this.schedules.set(
            schedule.id,
            schedule.status === 'cancelling' ? { ...schedule, status: 'active' } : schedule
          );
      }
    } catch {}
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    const payload: PersistedRegistry = {
      version: 1,
      schedules: [...this.schedules.values()],
    };
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  list(): AgentScheduleRecordShape[] {
    return [...this.schedules.values()]
      .filter((schedule) => schedule.status !== 'cancelled')
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  get(id: string): AgentScheduleRecordShape | null {
    return this.schedules.get(id) ?? null;
  }

  attachProviderConversationId(sessionId: string, providerConversationId: string): void {
    let changed = false;
    for (const [id, schedule] of this.schedules) {
      if (schedule.sessionId !== sessionId || schedule.providerConversationId) continue;
      this.schedules.set(id, { ...schedule, providerConversationId, updatedAt: this.now() });
      changed = true;
    }
    if (changed) this.persist();
  }

  beginCancel(id: string): AgentScheduleRecordShape | null {
    const schedule = this.schedules.get(id);
    if (!schedule || schedule.status !== 'active') return null;
    const next = { ...schedule, status: 'cancelling' as const, updatedAt: this.now() };
    this.schedules.set(id, next);
    this.persist();
    return next;
  }

  failCancel(id: string): void {
    const schedule = this.schedules.get(id);
    if (!schedule || schedule.status !== 'cancelling') return;
    this.schedules.set(id, { ...schedule, status: 'active', updatedAt: this.now() });
    this.persist();
  }

  completeCancellation(id: string): void {
    const schedule = this.schedules.get(id);
    if (!schedule) return;
    this.schedules.set(id, { ...schedule, status: 'cancelled', updatedAt: this.now() });
    this.persist();
  }

  observeTrace(context: ScheduleContext, trace: ScheduleTrace): void {
    for (const call of trace.toolCalls ?? []) {
      if (call.status === 'requested' || call.status === 'running') {
        const input = record(call.input);
        if (input) this.pending.set(call.id, { context, input, name: call.name });
        continue;
      }
      if (call.status !== 'completed') {
        this.pending.delete(call.id);
        continue;
      }
      const pending = this.pending.get(call.id);
      this.pending.delete(call.id);
      const output = record(call.output);
      if (call.name === 'CronCreate' && pending?.name === call.name && output) {
        this.captureCron(pending, output);
      } else if (call.name === 'ScheduleWakeup' && pending?.name === call.name && output) {
        this.captureWakeup(call.id, pending, output);
      } else if (call.name === 'CronDelete' && output && pending?.name === call.name) {
        const nativeId = text(pending.input.id);
        if (
          nativeId &&
          (output.id === undefined || output.id === nativeId) &&
          output.ok !== false &&
          !output.error
        ) {
          this.markNativeIdCancelled(nativeId);
        }
      } else if (call.name === 'CronList' && output && pending) {
        this.reconcileCronList(pending.context, output.jobs);
      }
    }
  }

  private captureCron(pending: PendingTool, output: Record<string, unknown>): void {
    const nativeId = text(output.id);
    if (!nativeId) return;
    const timestamp = this.now();
    const id = `claude-agent-sdk:${nativeId}`;
    const existing = this.schedules.get(id);
    this.schedules.set(id, {
      id,
      nativeId,
      kind: 'cron',
      provider: 'claude-agent-sdk',
      sessionId: pending.context.sessionId,
      conversationId: pending.context.conversationId,
      providerConversationId: pending.context.providerConversationId,
      cwd: pending.context.cwd,
      prompt: text(pending.input.prompt),
      cron: text(pending.input.cron) || null,
      humanSchedule: text(output.humanSchedule, text(pending.input.cron, 'Scheduled task')),
      recurring: bool(output.recurring, bool(pending.input.recurring, true)),
      durable: bool(output.durable, bool(pending.input.durable, false)),
      scheduledFor: null,
      status: 'active',
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    this.persist();
  }

  private captureWakeup(
    callId: string,
    pending: PendingTool,
    output: Record<string, unknown>
  ): void {
    const nativeId = `wakeup:${pending.context.sessionId}:${callId}`;
    const timestamp = this.now();
    const id = `claude-agent-sdk:${nativeId}`;
    this.schedules.set(id, {
      id,
      nativeId,
      kind: 'wakeup',
      provider: 'claude-agent-sdk',
      sessionId: pending.context.sessionId,
      conversationId: pending.context.conversationId,
      providerConversationId: pending.context.providerConversationId,
      cwd: pending.context.cwd,
      prompt: text(pending.input.prompt),
      cron: null,
      humanSchedule: text(pending.input.reason, 'Scheduled wake-up'),
      recurring: false,
      durable: false,
      scheduledFor: numberOrNull(output.scheduledFor),
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.persist();
  }

  private markNativeIdCancelled(nativeId: string): void {
    let changed = false;
    for (const [id, schedule] of this.schedules) {
      if (schedule.nativeId !== nativeId) continue;
      this.schedules.set(id, { ...schedule, status: 'cancelled', updatedAt: this.now() });
      changed = true;
    }
    if (changed) this.persist();
  }

  private reconcileCronList(context: ScheduleContext, value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const candidate of value) {
      const job = record(candidate);
      if (!job) continue;
      this.captureCron(
        {
          context,
          name: 'CronCreate',
          input: {
            cron: job.cron,
            prompt: job.prompt,
            recurring: job.recurring,
            durable: job.durable,
          },
        },
        job
      );
    }
  }
}
