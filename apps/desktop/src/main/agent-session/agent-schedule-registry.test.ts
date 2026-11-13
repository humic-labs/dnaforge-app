// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentScheduleRegistry } from './agent-schedule-registry';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('AgentScheduleRegistry', () => {
  it('captures native IDs from completed Claude schedule tools and survives restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'fixture-schedules-'));
    tempRoots.push(root);
    const file = join(root, 'agent-schedules.json');
    const registry = new AgentScheduleRegistry(file, () => 1_700_000_000_000);
    const context = {
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      providerConversationId: null,
      cwd: '/workspace',
    };

    registry.observeTrace(context, {
      toolCalls: [
        {
          id: 'tool-1',
          name: 'CronCreate',
          status: 'requested',
          input: {
            cron: '0 9 * * 1-5',
            prompt: 'Check the overnight run.',
            recurring: true,
            durable: true,
          },
        },
      ],
    });
    registry.observeTrace(context, {
      toolCalls: [
        {
          id: 'tool-1',
          name: 'CronCreate',
          status: 'completed',
          output: {
            id: 'cron-native-1',
            humanSchedule: 'weekdays at 9:00 AM',
            recurring: true,
            durable: true,
          },
        },
      ],
    });
    registry.attachProviderConversationId('session-1', 'claude-session-1');

    expect(new AgentScheduleRegistry(file).list()).toEqual([
      expect.objectContaining({
        id: 'claude-agent-sdk:cron-native-1',
        nativeId: 'cron-native-1',
        providerConversationId: 'claude-session-1',
        prompt: 'Check the overnight run.',
        status: 'active',
      }),
    ]);
  });

  it('records wakeups and removes a schedule only after native CronDelete completes', () => {
    const root = mkdtempSync(join(tmpdir(), 'fixture-schedules-'));
    tempRoots.push(root);
    const registry = new AgentScheduleRegistry(join(root, 'agent-schedules.json'), () => 42);
    const context = {
      sessionId: 'session-2',
      conversationId: null,
      providerConversationId: 'claude-session-2',
      cwd: '/workspace',
    };
    registry.observeTrace(context, {
      toolCalls: [
        {
          id: 'wake-1',
          name: 'ScheduleWakeup',
          status: 'requested',
          input: { delaySeconds: 120, reason: 'Wait for the build.', prompt: 'Recheck the build.' },
        },
      ],
    });
    registry.observeTrace(context, {
      toolCalls: [
        {
          id: 'wake-1',
          name: 'ScheduleWakeup',
          status: 'completed',
          output: { scheduledFor: 162_000, clampedDelaySeconds: 120, wasClamped: false },
        },
      ],
    });
    expect(registry.list()).toEqual([
      expect.objectContaining({ kind: 'wakeup', scheduledFor: 162_000, status: 'active' }),
    ]);

    const cronContext = { ...context, sessionId: 'session-3' };
    registry.observeTrace(cronContext, {
      toolCalls: [
        {
          id: 'create-2',
          name: 'CronCreate',
          status: 'requested',
          input: { cron: '5 * * * *', prompt: 'Poll.' },
        },
      ],
    });
    registry.observeTrace(cronContext, {
      toolCalls: [
        {
          id: 'create-2',
          name: 'CronCreate',
          status: 'completed',
          output: { id: 'cron-2', humanSchedule: 'hourly', recurring: true },
        },
      ],
    });
    expect(registry.beginCancel('claude-agent-sdk:cron-2')?.status).toBe('cancelling');
    registry.observeTrace(cronContext, {
      toolCalls: [
        { id: 'delete-2', name: 'CronDelete', status: 'requested', input: { id: 'cron-2' } },
      ],
    });
    registry.observeTrace(cronContext, {
      toolCalls: [
        { id: 'delete-2', name: 'CronDelete', status: 'completed', output: { id: 'cron-2' } },
      ],
    });
    expect(registry.list().map((schedule) => schedule.nativeId)).not.toContain('cron-2');
  });
});
