// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostHog } from 'posthog-node';
import { startPostHogTestCollector } from '../../../../tools/devops/analytics/posthog-test-collector.mjs';
import {
  captureAndConfirmAnalyticsBatch,
  ANALYTICS_CAPTURE_QUEUE_WAIT_MS,
} from './analytics-outbox-sdk';
import type { AnalyticsOutboxEvent } from './analytics-outbox';

type Capture = Parameters<PostHog['capture']>[0];
function event(): AnalyticsOutboxEvent {
  const id = randomUUID();
  return {
    eventId: id,
    eventName: 'feedback_stage',
    payloadSchemaVersion: 1,
    referenceKind: 'feedback_stage',
    referenceId: id,
    createdAtMs: 100,
    properties: { $insert_id: id, feature_area: 'settings', feedback_stage: 'durable_queue' },
    sendAttempts: 0,
    lastAttemptAtMs: null,
    sentAtMs: null,
    authority: null,
  };
}
const identity = '55700000-0000-4000-8000-000000000011';
function prepare(row: AnalyticsOutboxEvent, at: number): Capture {
  return {
    distinctId: identity,
    event: row.eventName,
    uuid: row.eventId,
    timestamp: new Date(row.createdAtMs),
    properties: { ...row.properties, emitted_at_ms: at },
  };
}

class SchedulingClient {
  listeners = new Map<string, Set<(value: unknown) => void>>();
  messages: object[] = [];
  mode: 'exact' | 'empty' | 'copied' | 'partial' | 'drop' = 'exact';
  on(name: string, callback: (value: unknown) => void) {
    const set = this.listeners.get(name) ?? new Set();
    set.add(callback);
    this.listeners.set(name, set);
    return () => {
      set.delete(callback);
    };
  }
  emit(name: string, value: unknown) {
    this.listeners.get(name)?.forEach((callback) => callback(value));
  }
  capture(input: Capture) {
    if (this.mode === 'drop') return;
    queueMicrotask(() => {
      const message = { ...input, distinct_id: input.distinctId };
      this.messages.push(message);
      this.emit('capture', message);
    });
  }
  async flush() {
    this.emit(
      'flush',
      this.mode === 'empty'
        ? []
        : this.mode === 'copied'
          ? this.messages.map((message) => ({ ...message }))
          : this.mode === 'partial'
            ? this.messages.slice(0, 1)
            : this.messages
    );
  }
  count() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}
afterEach(() => vi.useRealTimers());

describe('exact queued SDK acknowledgment', () => {
  it.each(['empty', 'copied'] as const)(
    'keeps %s/old or unrelated resolved flushes pending',
    async (mode) => {
      const client = new SchedulingClient();
      client.mode = mode;
      const row = event();
      const attempt = vi.fn(() => true);
      expect(
        await captureAndConfirmAnalyticsBatch(
          client,
          [row],
          () => true,
          prepare,
          attempt,
          () => 200
        )
      ).toEqual([]);
      expect(attempt).toHaveBeenCalledWith(row.eventId, 200);
      expect(client.count()).toBe(0);
    }
  );
  it('acknowledges only the exact partial batch and preserves original versus emission clocks', async () => {
    const client = new SchedulingClient();
    client.mode = 'partial';
    const rows = [event(), event()];
    expect(
      await captureAndConfirmAnalyticsBatch(
        client,
        rows,
        () => true,
        prepare,
        () => true,
        () => 200
      )
    ).toEqual([rows[0]!.eventId]);
    expect(client.messages[0]).toMatchObject({
      timestamp: new Date(100),
      properties: { emitted_at_ms: 200 },
    });
    expect(JSON.stringify(client.messages)).not.toContain('sent_at_ms');
    expect(client.count()).toBe(0);
  });
  it('bounds a dropped asynchronous capture and removes listeners/timer', async () => {
    vi.useFakeTimers();
    const client = new SchedulingClient();
    client.mode = 'drop';
    const result = captureAndConfirmAnalyticsBatch(
      client,
      [event()],
      () => true,
      prepare,
      () => true
    );
    await vi.advanceTimersByTimeAsync(ANALYTICS_CAPTURE_QUEUE_WAIT_MS);
    expect(await result).toEqual([]);
    expect(client.count()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves a frozen flush failure and removes every listener', async () => {
    const client = new SchedulingClient();
    const failure = Object.freeze(new Error('controlled flush failure'));
    client.flush = async () => {
      throw failure;
    };
    await expect(
      captureAndConfirmAnalyticsBatch(
        client,
        [event()],
        () => true,
        prepare,
        () => true
      )
    ).rejects.toBe(failure);
    expect(client.count()).toBe(0);
  });
  it('retains registration failure presence/value and removes an earlier listener', async () => {
    const client = new SchedulingClient();
    const original = client.on.bind(client);
    client.on = (name, callback) => {
      if (name === 'flush') throw undefined;
      return original(name, callback);
    };
    let caught = false;
    let value: unknown = 'not thrown';
    try {
      await captureAndConfirmAnalyticsBatch(
        client,
        [event()],
        () => true,
        prepare,
        () => true
      );
    } catch (error) {
      caught = true;
      value = error;
    }
    expect(caught).toBe(true);
    expect(value).toBeUndefined();
    expect(client.count()).toBe(0);
  });
});

async function realSdk(
  body: (
    client: PostHog,
    collector: Awaited<ReturnType<typeof startPostHogTestCollector>>
  ) => Promise<void>,
  extra: ConstructorParameters<typeof PostHog>[1] = {}
) {
  const collector = await startPostHogTestCollector({ apiKey: 'phc_f17_local_sdk_control' });
  let client: PostHog | undefined;
  let primaryPresent = false;
  let primary: unknown;
  const remember = (error: unknown) => {
    if (!primaryPresent) {
      primaryPresent = true;
      primary = error;
    }
  };
  try {
    client = new PostHog('phc_f17_local_sdk_control', {
      ...extra,
      host: collector.url,
      flushAt: 1000,
      flushInterval: 0,
      fetchRetryCount: 0,
      disableGeoip: true,
    });
    await body(client, collector);
  } catch (error) {
    remember(error);
  } finally {
    if (client) {
      try {
        await client.optOut();
      } catch (error) {
        remember(error);
      }
      try {
        client.setPersistedProperty('queue' as Parameters<PostHog['setPersistedProperty']>[0], []);
      } catch (error) {
        remember(error);
      }
      try {
        await client.shutdown();
      } catch (error) {
        remember(error);
      }
    }
    try {
      await collector.close();
    } catch (error) {
      remember(error);
    }
  }
  if (primaryPresent) throw primary;
}

describe('installed real posthog-node and contained collector', () => {
  it('waits for actual asynchronous SDK enqueue and exact successful HTTP batch', async () => {
    await realSdk(async (client, collector) => {
      const row = event();
      const calls: number[] = [];
      const originalOn = client.on.bind(client);
      let liveListeners = 0;
      const on = vi.spyOn(client, 'on').mockImplementation((name, callback) => {
        liveListeners++;
        const remove = originalOn(name, callback);
        return () => {
          try {
            remove();
          } finally {
            liveListeners--;
          }
        };
      });
      let result: readonly string[] = [];
      try {
        result = await captureAndConfirmAnalyticsBatch(
          client,
          [row],
          () => true,
          prepare,
          (_id, at) => {
            calls.push(at);
            return true;
          },
          () => 200
        );
        expect(liveListeners).toBe(0);
      } finally {
        on.mockRestore();
      }
      expect(result).toEqual([row.eventId]);
      expect(calls).toEqual([200]);
      const accepted = await collector.waitForAcceptedEvent('feedback_stage');
      expect(accepted.uuid).toBe(row.eventId);
      expect(accepted.properties).toMatchObject({ $insert_id: row.eventId, emitted_at_ms: 200 });
      expect(Date.parse(String(accepted.timestamp))).toBe(100);
      expect(
        collector
          .requestsSince(0)
          .filter((request: { responseStatus: number }) => request.responseStatus === 200).length
      ).toBeGreaterThan(0);
    });
  });
  it('leaves a real429 attempt pending and acknowledges a same-UUID successful retry only', async () => {
    await realSdk(async (client, collector) => {
      const row = event();
      collector.rateLimitNext(1);
      await expect(
        captureAndConfirmAnalyticsBatch(
          client,
          [row],
          () => true,
          prepare,
          () => true,
          () => 200
        )
      ).rejects.toBeDefined();
      expect(
        await captureAndConfirmAnalyticsBatch(
          client,
          [row],
          () => true,
          prepare,
          () => true,
          () => 300
        )
      ).toEqual([row.eventId]);
      const accepted = await collector.waitForAcceptedEvent('feedback_stage');
      expect(accepted.uuid).toBe(row.eventId);
      expect(accepted.properties?.emitted_at_ms).toBe(300);
      expect(
        collector
          .requestsSince(0)
          .map((request: { responseStatus: number }) => request.responseStatus)
      ).toEqual([429, 200]);
    });
  });
  it('closes authority at the real capture boundary before any explicit flush', async () => {
    await realSdk(async (client, collector) => {
      let current = true;
      const remove = client.on('capture', () => {
        current = false;
      });
      try {
        expect(
          await captureAndConfirmAnalyticsBatch(
            client,
            [event()],
            () => current,
            prepare,
            () => true
          )
        ).toEqual([]);
        expect(collector.requestsSince(0)).toEqual([]);
      } finally {
        remove();
      }
    });
  });
  it('does not acknowledge success that resolves after authority closes in flight', async () => {
    let enter: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    await realSdk(
      async (client, collector) => {
        let current = true;
        const row = event();
        const sending = captureAndConfirmAnalyticsBatch(
          client,
          [row],
          () => current,
          prepare,
          () => true
        );
        try {
          await entered;
          current = false;
        } finally {
          release();
        }
        expect(await sending).toEqual([]);
        expect((await collector.waitForAcceptedEvent('feedback_stage')).uuid).toBe(row.eventId);
      },
      {
        fetch: async (url, options) => {
          const response = await fetch(url, options);
          enter();
          await released;
          return response;
        },
      }
    );
  });
});
