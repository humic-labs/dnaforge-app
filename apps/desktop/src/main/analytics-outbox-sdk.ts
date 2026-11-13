import type {
  MainAnalyticsSdkCapture,
  MainAnalyticsSdkClient,
} from './analytics-outbox-sdk-contract';
import type { AnalyticsOutboxEvent } from './analytics-outbox';

type Capture = MainAnalyticsSdkCapture;
type Client = MainAnalyticsSdkClient;
export const ANALYTICS_CAPTURE_QUEUE_WAIT_MS = 1_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function captureAndConfirmAnalyticsBatch(
  client: Client,
  events: readonly AnalyticsOutboxEvent[],
  admissible: (event: AnalyticsOutboxEvent) => boolean,
  prepare: (event: AnalyticsOutboxEvent, attemptedAtMs: number) => Capture | null,
  beginAttempt: (eventId: string, attemptedAtMs: number) => boolean,
  nowMs = Date.now
): Promise<readonly string[]> {
  if (events.length === 0) return [];
  const expected = new Map<string, { event: AnalyticsOutboxEvent; capture: Capture }>();
  const queued = new Map<string, object>();
  const acknowledged = new Set<string>();
  const removeListeners: (() => void)[] = [];
  let offersComplete = false;
  let failed = false;
  let resolveQueued: () => void = () => {};
  const queuedReady = new Promise<void>((resolve) => {
    resolveQueued = resolve;
  });
  const timer = setTimeout(resolveQueued, ANALYTICS_CAPTURE_QUEUE_WAIT_MS);
  let primaryPresent = false;
  let primaryError: unknown;
  let cleanupPresent = false;
  let cleanupError: unknown;
  let result: readonly string[] = [];
  const ready = () => {
    if (failed || (offersComplete && queued.size === expected.size)) resolveQueued();
  };
  const matches = (message: Record<string, unknown>, capture: Capture) => {
    const properties = record(message.properties);
    return (
      message.uuid === capture.uuid &&
      message.event === capture.event &&
      message.distinct_id === capture.distinctId &&
      properties !== null &&
      Object.entries(capture.properties ?? {}).every(([key, value]) => properties[key] === value) &&
      (message.timestamp instanceof Date
        ? message.timestamp.getTime()
        : typeof message.timestamp === 'string'
          ? Date.parse(message.timestamp)
          : NaN) === capture.timestamp?.getTime()
    );
  };
  try {
    removeListeners.push(
      client.on('capture', (value: unknown) => {
        const message = record(value);
        const item =
          message && typeof message.uuid === 'string' ? expected.get(message.uuid) : undefined;
        if (!item || !message || !matches(message, item.capture)) return;
        if (!admissible(item.event)) failed = true;
        else queued.set(item.event.eventId, message);
        ready();
      })
    );
    removeListeners.push(
      client.on('flush', (value: unknown) => {
        if (failed || !Array.isArray(value)) return;
        for (const candidate of value) {
          const message = record(candidate);
          const id = message?.uuid;
          if (typeof id !== 'string') continue;
          const item = expected.get(id);
          if (
            item &&
            message === queued.get(id) &&
            matches(message, item.capture) &&
            admissible(item.event)
          ) {
            acknowledged.add(id);
          }
        }
      })
    );
    removeListeners.push(
      client.on('error', () => {
        failed = true;
        ready();
      })
    );
    for (const event of events) {
      if (!admissible(event)) continue;
      const atMs = nowMs();
      const capture = prepare(event, atMs);
      if (!capture || !admissible(event) || !beginAttempt(event.eventId, atMs)) continue;
      expected.set(event.eventId, { event, capture });
      client.capture(capture);
    }
    offersComplete = true;
    ready();
    await queuedReady;
    if (
      !failed &&
      queued.size === expected.size &&
      expected.size > 0 &&
      [...expected.values()].every(({ event }) => admissible(event))
    ) {
      await client.flush();
      if (!failed) {
        result = [...acknowledged].filter((id) => {
          const item = expected.get(id);
          return item !== undefined && admissible(item.event);
        });
      }
    }
  } catch (error) {
    primaryPresent = true;
    primaryError = error;
  } finally {
    clearTimeout(timer);
    for (const remove of removeListeners) {
      try {
        remove();
      } catch (error) {
        if (!cleanupPresent) {
          cleanupPresent = true;
          cleanupError = error;
        }
      }
    }
  }
  if (primaryPresent) throw primaryError;
  if (cleanupPresent) throw cleanupError;
  return result;
}
