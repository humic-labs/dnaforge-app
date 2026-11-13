export const EXTERNAL_RESOURCES_INVALIDATE_CHANNEL = 'external-resources:invalidate' as const;

export const MAX_IDS_PER_BATCH = 100;

export type InvalidationReason = 'refreshed' | 'evicted' | 'deleted';

export interface InvalidationEntry {
  provider: string;
  externalId: string;
  newVersion: string | null;
}

export interface InvalidationPayload {
  event: 'invalidate';
  reason: InvalidationReason;
  entries: InvalidationEntry[];
}

export type InvalidationHandler = (payload: InvalidationPayload) => void;

const subscribers = new Set<InvalidationHandler>();

export function subscribeToExternalResourceInvalidations(handler: InvalidationHandler): () => void {
  subscribers.add(handler);
  let active = true;
  return () => {
    if (!active) return;
    subscribers.delete(handler);
    active = false;
  };
}

export function dispatchExternalResourceInvalidation(payload: InvalidationPayload): void {
  if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
    return;
  }
  const snapshot = Array.from(subscribers);
  for (let i = 0; i < payload.entries.length; i += MAX_IDS_PER_BATCH) {
    const slice = payload.entries.slice(i, i + MAX_IDS_PER_BATCH);
    const batched: InvalidationPayload = {
      event: payload.event,
      reason: payload.reason,
      entries: slice,
    };
    for (const handler of snapshot) {
      try {
        handler(batched);
      } catch {}
    }
  }
}

export function _resetSubscribersForTesting(): void {
  subscribers.clear();
}
