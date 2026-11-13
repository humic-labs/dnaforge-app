import type { FeedbackError, FeedbackPayload } from './feedback';

export const FEEDBACK_TIMEOUT_MS = 10_000;
export const FEEDBACK_PROTOCOL = 'dnaforge.feedback.v1';

export interface FeedbackTransportPayload extends FeedbackPayload {
  submission_id: string;
  install_id?: string;
  user_agent?: string;
  timestamp?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function sendFeedbackTransport(
  item: FeedbackTransportPayload,
  url: string,
  controller: AbortController
): Promise<'accepted' | FeedbackError> {
  let timedOut = false;
  const deadline = new Promise<FeedbackError>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(timedOut ? 'timeout' : 'cancelled'), {
      once: true,
    });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FEEDBACK_TIMEOUT_MS);
  const request = (async (): Promise<'accepted' | FeedbackError> => {
    try {
      const capability = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!capability.ok) return 'service_unavailable';
      const protocol: unknown = await capability.json();
      if (!record(protocol) || protocol.protocol !== FEEDBACK_PROTOCOL)
        return 'service_unavailable';
      if (controller.signal.aborted) return timedOut ? 'timeout' : 'cancelled';
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          message: item.message,
          app_version: item.app_version,
          platform_info: item.platform_info,
          submission_id: item.submission_id,
          install_id: item.install_id,
          user_agent: item.user_agent,
          timestamp: item.timestamp,
        }),
      });
      if (response.ok) {
        const receipt: unknown = await response.json();
        return record(receipt) && receipt.submission_id === item.submission_id
          ? 'accepted'
          : 'delivery_unconfirmed';
      }
      if (
        response.status >= 400 &&
        response.status < 500 &&
        ![408, 425, 429].includes(response.status)
      )
        return 'permanent_refusal';
      return 'transport_unavailable';
    } catch {
      return controller.signal.aborted
        ? timedOut
          ? 'timeout'
          : 'cancelled'
        : 'transport_unavailable';
    }
  })();
  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
