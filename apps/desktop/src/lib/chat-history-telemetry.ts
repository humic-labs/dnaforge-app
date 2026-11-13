import {
  trackRendererEvent,
  isAnalyticsCaptureReady,
  getAnalyticsIdentifiedAccountId,
} from './analytics';
import { getTelemetryCorrelationContext } from './telemetry-correlation';
import { CHAT_HISTORY_OBSERVED, type ChatHistoryObservedProps } from './analytics-events';
import type {
  HistoryAction,
  HistoryDetails,
  HistoryObservation,
  HistorySource,
  HistoryPhase,
} from '../shared/chat-history-telemetry';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function createHistoryCorrelationId(): string | null {
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 15) | 64;
    bytes[8] = (bytes[8]! & 63) | 128;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}
function safeId(value: string | null | undefined) {
  return value && UUID.test(value) ? value : null;
}

export function beginHistoryObservation(
  action: HistoryAction,
  source: HistorySource,
  paneGenerationId?: string | null,
  parentOperationId?: string | null
): HistoryObservation {
  const id = createHistoryCorrelationId();
  const paneId = safeId(paneGenerationId);
  const parentId = safeId(parentOperationId);
  let originalContext: { account: string | null; session: string; episode: string } | null = null;
  try {
    if (isAnalyticsCaptureReady()) {
      const current = getTelemetryCorrelationContext();
      originalContext = {
        account: getAnalyticsIdentifiedAccountId(),
        session: current.appSessionId,
        episode: current.episodeCorrelationId,
      };
    }
  } catch (ignoredError) {
    void ignoredError;
  }
  let storeSettled = false;
  let paneSettled = false;
  let available: NonNullable<HistoryDetails['availability']> = 'unknown';
  let replacement: NonNullable<HistoryDetails['replacement']> = 'not_applicable';
  const emit = (
    stage: 'operation' | 'store' | 'pane',
    phase: HistoryPhase,
    details: HistoryDetails
  ) => {
    if (!id || !originalContext) return;
    try {
      if (
        !isAnalyticsCaptureReady() ||
        getAnalyticsIdentifiedAccountId() !== originalContext.account
      )
        return;
      const currentContext = getTelemetryCorrelationContext();
      if (
        currentContext.appSessionId !== originalContext.session ||
        currentContext.episodeCorrelationId !== originalContext.episode
      )
        return;
      const presentedId = safeId(details.presentedGenerationId);
      trackRendererEvent(CHAT_HISTORY_OBSERVED, {
        feature_area: 'navigation',
        operation_id: id,
        occurred_at_ms: Date.now(),
        ...(paneId ? { history_pane_generation_id: paneId } : {}),
        ...(parentId ? { history_parent_operation_id: parentId } : {}),
        ...(presentedId ? { history_presented_generation_id: presentedId } : {}),
        history_action: action,
        history_source: source,
        history_stage: stage,
        history_phase: phase,
        history_result: details.result,
        history_authority: details.authority ?? 'not_attested',
        history_freshness: details.freshness ?? 'not_applicable',
        history_availability: details.availability ?? available,
        history_replacement: details.replacement ?? replacement,
        history_pane_role: details.paneRole ?? 'unknown',
        history_match_bucket: details.matches ?? 'not_applicable',
        history_pin_state: details.pinState ?? 'unknown',
        history_shadow_cleanup: 'NOT_ATTESTED',
      } satisfies ChatHistoryObservedProps);
    } catch (ignoredError) {
      void ignoredError;
    }
  };
  emit('operation', 'accepted', { result: 'started' });
  return {
    id,
    paneGenerationId: paneId,
    get availability() {
      return available;
    },
    get replacement() {
      return replacement;
    },
    store(details) {
      if (storeSettled) return;
      storeSettled = true;
      available = details.availability ?? available;
      replacement = details.replacement ?? replacement;
      emit('store', details.phase ?? 'result', details);
    },
    pane(details) {
      if (paneSettled) return;
      paneSettled = true;
      emit('pane', details.phase ?? 'result', details);
    },
  };
}
