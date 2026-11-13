import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsIdentityContext } from '@waypoint/analytics-policy';
import {
  MainAnalyticsContextQueue,
  type MainAnalyticsQueuedEvent,
} from './analytics-context-queue';

const CONTEXT: AnalyticsIdentityContext = {
  distinctId: '550e8400-e29b-41d4-a716-446655440001',
  sessionId: '550e8400-e29b-41d4-a716-446655440002',
  kind: 'anonymous',
  generation: 3,
};

function event(name: MainAnalyticsQueuedEvent['event'], featureArea = 'lifecycle') {
  return { event: name, properties: { feature_area: featureArea } };
}

describe('main analytics renderer-context queue', () => {
  it('buffers consented events until a renderer context arrives, then preserves ID/session', () => {
    const emit = vi.fn();
    const queue = new MainAnalyticsContextQueue({ emit });

    queue.setConsent(true);
    queue.offer(event('app_session_started'));
    expect(emit).not.toHaveBeenCalled();

    expect(queue.syncContext(CONTEXT)).toBe(true);
    expect(emit).toHaveBeenCalledWith(event('app_session_started'), CONTEXT);
  });

  it('rejects malformed, same-generation, and stale identity updates', () => {
    const queue = new MainAnalyticsContextQueue({ emit: vi.fn() });
    queue.setConsent(true);

    expect(queue.syncContext(CONTEXT)).toBe(true);
    expect(queue.syncContext(CONTEXT)).toBe(false);
    expect(queue.syncContext({ ...CONTEXT, generation: 2 })).toBe(false);
    expect(queue.syncContext({ ...CONTEXT, generation: 4, distinctId: 'email@example.com' })).toBe(
      false
    );
    expect(queue.currentContext()).toEqual(CONTEXT);
  });

  it('accepts a fresh generation from a reloaded renderer document', () => {
    const queue = new MainAnalyticsContextQueue({ emit: vi.fn() });
    queue.setConsent(true);
    const beforeReload = {
      ...CONTEXT,
      generation: 8,
      rendererInstanceId: '550e8400-e29b-41d4-a716-446655440031',
    };
    const afterReload = {
      ...CONTEXT,
      generation: 1,
      distinctId: '550e8400-e29b-41d4-a716-446655440003',
      rendererInstanceId: '550e8400-e29b-41d4-a716-446655440032',
    };

    expect(queue.syncContext(beforeReload)).toBe(true);
    expect(queue.syncContext(afterReload)).toBe(true);
    expect(queue.currentContext()).toEqual(afterReload);
  });

  it('preserves every event in FIFO order while renderer identity is pending', () => {
    const emit = vi.fn();
    const queue = new MainAnalyticsContextQueue({ emit });
    queue.setConsent(true);

    queue.offer(event('app_session_started'));
    queue.offer(event('tool_opened', 'tool_usage'));
    queue.offer(event('file_opened', 'file'));
    queue.offer(event('workspace_opened', 'workspace'));

    expect(queue.pendingCount()).toBe(4);
    expect(queue.diagnostics()).toEqual({ overflowDrops: 0, deadlineDrops: 0 });
    queue.syncContext(CONTEXT);
    expect(emit.mock.calls.map(([queued]) => queued.event)).toEqual([
      'app_session_started',
      'tool_opened',
      'file_opened',
      'workspace_opened',
    ]);
  });

  it('flushes every queued event under one fresh per-launch fallback at deadline', () => {
    const emit = vi.fn();
    const fallback: AnalyticsIdentityContext = {
      distinctId: '550e8400-e29b-41d4-a716-446655440090',
      sessionId: '550e8400-e29b-41d4-a716-446655440091',
      kind: 'fallback',
      generation: 0,
    };
    let deadline: (() => void) | undefined;
    const queue = new MainAnalyticsContextQueue({
      emit,
      fallbackFactory: () => fallback,
      scheduleDeadline: (callback) => {
        deadline = callback;
        return 1;
      },
      cancelDeadline: vi.fn(),
    });

    queue.setConsent(true);
    queue.offer(event('app_first_opened'));
    queue.offer(event('app_session_started'));
    queue.offer(event('desktop_main_error_captured', 'reliability'));
    queue.offer(event('workspace_opened', 'workspace'));
    deadline?.();

    expect(emit.mock.calls.map(([queued]) => queued.event)).toEqual([
      'app_first_opened',
      'app_session_started',
      'desktop_main_error_captured',
      'workspace_opened',
    ]);
    expect(emit.mock.calls.every(([, context]) => context === fallback)).toBe(true);
    expect(queue.diagnostics()).toEqual({ overflowDrops: 0, deadlineDrops: 0 });
    expect(queue.currentContext()).toBeNull();
  });

  it('flushes startup-fatal events immediately when no renderer can ever provide identity', () => {
    const emit = vi.fn();
    const fallback: AnalyticsIdentityContext = {
      distinctId: '550e8400-e29b-41d4-a716-446655440092',
      sessionId: '550e8400-e29b-41d4-a716-446655440093',
      kind: 'fallback',
      generation: 0,
    };
    const queue = new MainAnalyticsContextQueue({
      emit,
      fallbackFactory: () => fallback,
    });

    queue.setConsent(true);
    queue.offer(event('app_schema_refused', 'reliability'));
    queue.flushPendingWithFallback();

    expect(emit).toHaveBeenCalledWith(event('app_schema_refused', 'reliability'), fallback);
    expect(queue.pendingCount()).toBe(0);
  });

  it('preserves each producer timestamp through delayed identity synchronization', () => {
    const emit = vi.fn();
    const queue = new MainAnalyticsContextQueue({ emit });
    const capturedAt = new Date('2026-07-25T21:15:00.123Z');
    const queued = { ...event('workspace_opened', 'workspace'), capturedAt };

    queue.setConsent(true);
    queue.offer(queued);
    queue.syncContext(CONTEXT);

    expect(emit).toHaveBeenCalledWith(queued, CONTEXT);
  });

  it('discards queued and future events immediately when consent turns off', () => {
    const emit = vi.fn();
    const queue = new MainAnalyticsContextQueue({ emit });
    queue.setConsent(true);
    queue.offer(event('app_session_started'));

    queue.setConsent(false);
    queue.syncContext(CONTEXT);
    queue.offer(event('desktop_main_error_captured', 'reliability'));

    expect(emit).not.toHaveBeenCalled();
    expect(queue.pendingCount()).toBe(0);
  });

  it('does not alias a fallback domain when renderer context arrives later', () => {
    const emit = vi.fn();
    let deadline: (() => void) | undefined;
    const queue = new MainAnalyticsContextQueue({
      emit,
      fallbackFactory: () => ({
        distinctId: '550e8400-e29b-41d4-a716-446655440090',
        sessionId: '550e8400-e29b-41d4-a716-446655440091',
        kind: 'fallback',
        generation: 0,
      }),
      scheduleDeadline: (callback) => {
        deadline = callback;
        return 1;
      },
      cancelDeadline: vi.fn(),
    });

    queue.setConsent(true);
    queue.offer(event('app_session_started'));
    deadline?.();
    queue.syncContext(CONTEXT);
    queue.offer(event('desktop_main_error_captured', 'reliability'));

    expect(emit.mock.calls[0][1].kind).toBe('fallback');
    expect(emit.mock.calls[1][1]).toEqual(CONTEXT);
  });
});
