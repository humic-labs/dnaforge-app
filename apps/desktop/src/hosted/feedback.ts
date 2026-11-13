import type { FeedbackPayload, FeedbackResult } from '../shared/feedback';
import type { FeedbackPort } from '../shared/ipc/feedback.contract';
import { sendFeedbackTransport } from '../shared/feedback-transport';

export function createHostedFeedback(): FeedbackPort {
  const active = new Map<string, Set<AbortController>>();
  return {
    async send(payload: FeedbackPayload): Promise<FeedbackResult> {
      const id = payload.submission_id ?? crypto.randomUUID();
      const controller = new AbortController();
      const controllers = active.get(id) ?? new Set<AbortController>();
      active.set(id, controllers);
      controllers.add(controller);
      try {
        const outcome = await sendFeedbackTransport(
          {
            message: payload.message,
            app_version: payload.app_version,
            platform_info: payload.platform_info,
            submission_id: id,
          },
          '/api/feedback',
          controller
        );
        return outcome === 'accepted'
          ? { success: true, submission_id: id }
          : { success: false, submission_id: id, error: outcome };
      } finally {
        controllers.delete(controller);
        if (!controllers.size) active.delete(id);
      }
    },
    async cancel(id: string): Promise<FeedbackResult> {
      for (const controller of active.get(id) ?? []) controller.abort();
      return { success: false, submission_id: id, error: 'cancelled' };
    },
  };
}
