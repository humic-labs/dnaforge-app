export interface FeedbackPayload {
  message: string;
  app_version?: string;
  platform_info?: string;
  submission_id?: string;
}

export type FeedbackError =
  | 'invalid_payload'
  | 'submission_conflict'
  | 'queue_corrupt'
  | 'queue_full'
  | 'storage_unavailable'
  | 'service_unavailable'
  | 'transport_unavailable'
  | 'timeout'
  | 'permanent_refusal'
  | 'delivery_unconfirmed'
  | 'cancelled';

export interface FeedbackResult {
  success: boolean;
  queued?: boolean;
  submission_id?: string;
  error?: FeedbackError;
}

export interface FeedbackTelemetryOrigin {
  consentScope: string;
  contextId?: string;
  metricId: string;
  processId: string;
  classification: 'synthetic' | 'private' | 'unknown' | 'eligible_release';
}
export type FeedbackStage =
  | 'accepted_intent'
  | 'durable_queue'
  | 'backend_accepted'
  | 'retry'
  | 'deferred'
  | 'refused'
  | 'cancelled';
export interface FeedbackReceipt {
  origin: FeedbackTelemetryOrigin;
  operationId: string;
  stage: FeedbackStage;
  reason?: FeedbackError;
  originalAtMs: number;
  occurredAtMs: number;
  attempt: number;
}

export function sanitizeFeedbackText(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13;
    })
    .join('');
}
