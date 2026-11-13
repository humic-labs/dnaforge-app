import {
  captureAnalyticsOptionalOrigin,
  getAnalyticsCaptureGeneration,
  getAnalyticsIdentifiedAccountId,
  isAnalyticsCaptureReady,
  trackRendererEvent,
} from '../../../lib/analytics';
import { getTelemetryCorrelationContext } from '../../../lib/telemetry-correlation';
import { beginWorkflowAction, type WorkflowOperation } from '../../../lib/workflow-telemetry';
import type { WorkflowOutcomeKind } from '../../../shared/scientific-workflow-vocab';
import type { DocumentOpenResult, OpenStrategy } from '../../canvas/public/document-presentation';

export type ReferenceFailure =
  | 'handler_unavailable'
  | 'missing_owner'
  | 'ambiguous'
  | 'target_missing'
  | 'target_mismatch'
  | 'refused'
  | 'unsupported'
  | 'open_failed'
  | 'provider_unavailable';
type ReferenceDisposition =
  | { kind: 'document'; result: DocumentOpenResult }
  | { kind: 'registry_record' | 'registry_search' | 'provider_requested' | 'reveal_requested' }
  | { kind: 'failure'; reason: ReferenceFailure }
  | { kind: 'cancelled' | 'superseded' };

export interface ReferenceIntent {
  readonly finished: boolean;
  readonly placement?: OpenStrategy;
  finish(disposition: ReferenceDisposition): void;
}

const failures = {
  handler_unavailable: 'reference_open_failed',
  missing_owner: 'reference_missing_owner',
  ambiguous: 'reference_ambiguous',
  target_missing: 'reference_target_missing',
  target_mismatch: 'reference_target_mismatch',
  refused: 'reference_refused',
  unsupported: 'reference_unsupported',
  open_failed: 'reference_open_failed',
  provider_unavailable: 'reference_provider_unavailable',
} satisfies Record<ReferenceFailure, WorkflowOutcomeKind>;
let intents = new WeakMap<object, ReferenceIntent>();
let claimed = new WeakSet<Event>();

export function referenceIntent(key: object): ReferenceIntent {
  const existing = intents.get(key);
  if (existing) return existing;
  let operation: WorkflowOperation | undefined;
  try {
    const origin = captureAnalyticsOptionalOrigin();
    if (origin && isAnalyticsCaptureReady()) {
      const signature = JSON.stringify(origin);
      const generation = getAnalyticsCaptureGeneration();
      const account = getAnalyticsIdentifiedAccountId();
      const context = { ...getTelemetryCorrelationContext() };
      operation = beginWorkflowAction(
        { workflow: 'content', action: 'link' },
        {
          track: (event, properties) => {
            const current = getTelemetryCorrelationContext();
            return isAnalyticsCaptureReady() &&
              generation === getAnalyticsCaptureGeneration() &&
              account === getAnalyticsIdentifiedAccountId() &&
              signature === JSON.stringify(captureAnalyticsOptionalOrigin()) &&
              context.appSessionId === current.appSessionId &&
              context.episodeCorrelationId === current.episodeCorrelationId
              ? trackRendererEvent(event, properties)
              : false;
          },
        }
      );
    }
  } catch (error) {
    void error;
  }
  let finished = false;
  const intent: ReferenceIntent = {
    get finished() {
      return finished;
    },
    finish(disposition) {
      if (finished) return;
      finished = true;
      try {
        if (disposition.kind === 'failure') {
          operation?.fail('reference_failed', {
            status: disposition.reason === 'refused' ? 'blocked' : 'failed',
            outcomeKind: failures[disposition.reason],
            usableResult: false,
            valueDelivered: false,
          });
        } else if (disposition.kind === 'cancelled' || disposition.kind === 'superseded') {
          operation?.cancel({
            outcomeKind:
              disposition.kind === 'cancelled' ? 'reference_cancelled' : 'reference_superseded',
          });
        } else if (disposition.kind === 'document') {
          const result = disposition.result;
          if (result.status === 'cancelled') {
            operation?.cancel({ outcomeKind: 'reference_cancelled' });
          } else if (result.status !== 'presented') {
            operation?.fail('reference_failed', {
              status: result.status === 'blocked' ? 'blocked' : 'failed',
              outcomeKind:
                result.status === 'blocked'
                  ? 'reference_refused'
                  : result.status === 'unsupported'
                    ? 'reference_unsupported'
                    : 'reference_open_failed',
            });
          } else {
            if (result.content === 'missing') {
              operation?.fail('reference_failed', { outcomeKind: 'reference_target_missing' });
            } else if (result.content === 'error') {
              operation?.fail('reference_failed', { outcomeKind: 'reference_open_failed' });
            } else {
              const page = result.tabType === 'page';
              operation?.complete({
                status: result.content === 'ready' ? 'viewed' : 'needs_action',
                outcomeKind: page
                  ? result.disposition === 'reused'
                    ? 'reference_page_focused'
                    : 'reference_page_presented'
                  : result.tabType === 'sequence'
                    ? result.disposition === 'reused'
                      ? 'reference_file_focused'
                      : 'reference_file_presented'
                    : result.disposition === 'reused'
                      ? 'reference_document_focused'
                      : 'reference_document_presented',
                usableResult: result.content === 'ready',
                valueDelivered: result.content === 'ready',
              });
            }
          }
        } else {
          const record = disposition.kind === 'registry_record';
          operation?.complete({
            status: record ? 'viewed' : 'needs_action',
            outcomeKind: record
              ? 'reference_registry_presented'
              : disposition.kind === 'registry_search'
                ? 'reference_registry_search'
                : disposition.kind === 'provider_requested'
                  ? 'reference_provider_requested'
                  : 'reference_reveal_requested',
            usableResult: record,
            valueDelivered: record,
          });
        }
      } catch (error) {
        void error;
      }
    },
  };
  intents.set(key, intent);
  return intent;
}

export function claimReferenceIntent(event: Event): ReferenceIntent | null {
  if (claimed.has(event)) return null;
  claimed.add(event);
  return referenceIntent(event);
}

export function dispatchReferenceEvent(detail: object, intent: ReferenceIntent): boolean {
  const event = new CustomEvent('waypoint:open-entity', { detail });
  intents.set(event, intent);
  window.dispatchEvent(event);
  const accepted = claimed.has(event);
  if (!accepted) intent.finish({ kind: 'failure', reason: 'handler_unavailable' });
  return accepted;
}

export function resetReferenceIntentsForTests(): void {
  intents = new WeakMap();
  claimed = new WeakSet();
}
