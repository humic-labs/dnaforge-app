import {
  trackRendererEvent,
  isAnalyticsCaptureReady,
  getAnalyticsIdentifiedAccountId,
} from './analytics';
import { getTelemetryCorrelationContext } from './telemetry-correlation';
import { JOB_MANAGEMENT_OBSERVED, type JobManagementObservedProps } from './analytics-events';
import {
  JOB_MANAGEMENT_OWNERS,
  JOB_MANAGEMENT_FRESHNESS,
  JOB_MANAGEMENT_MODES,
  JOB_MANAGEMENT_AVAILABILITY,
  JOB_MANAGEMENT_STATES,
  JOB_MANAGEMENT_HISTORY,
  JOB_MANAGEMENT_SCOPES,
  type JobManagementAction,
  type JobManagementContext,
  type JobManagementDetails,
  type JobManagementObservation,
} from '../shared/jobs-management-telemetry';

const UNKNOWN: JobManagementContext = {
  owner: 'unknown',
  freshness: 'unknown',
  mode: 'unknown',
  availability: 'unknown',
  state: 'unknown',
};
function closed<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}
function context(value: Partial<JobManagementContext>): JobManagementContext {
  return {
    owner: closed(value.owner, JOB_MANAGEMENT_OWNERS, 'unknown'),
    freshness: closed(value.freshness, JOB_MANAGEMENT_FRESHNESS, 'unknown'),
    mode: closed(value.mode, JOB_MANAGEMENT_MODES, 'unknown'),
    availability: closed(value.availability, JOB_MANAGEMENT_AVAILABILITY, 'unknown'),
    state: closed(value.state, JOB_MANAGEMENT_STATES, 'unknown'),
    ...(typeof value.observedAtMs === 'number' &&
    Number.isFinite(value.observedAtMs) &&
    value.observedAtMs >= 0
      ? { observedAtMs: value.observedAtMs }
      : {}),
    history: closed(value.history, JOB_MANAGEMENT_HISTORY, 'unknown'),
    scope: closed(value.scope, JOB_MANAGEMENT_SCOPES, 'unknown'),
  };
}

export function jobManagementContext(
  job?: {
    owner: { kind: string };
    observation: { freshness: string; observedAtMs?: number };
    executionContext: { mode: string };
    result: { availability: string };
    state: string;
  },
  fallbackOwner?: string
): JobManagementContext {
  try {
    return context({
      owner: closed(job?.owner.kind ?? fallbackOwner, JOB_MANAGEMENT_OWNERS, 'unknown'),
      freshness: closed(job?.observation.freshness, JOB_MANAGEMENT_FRESHNESS, 'unknown'),
      mode: closed(job?.executionContext.mode, JOB_MANAGEMENT_MODES, 'unknown'),
      availability: closed(job?.result.availability, JOB_MANAGEMENT_AVAILABILITY, 'unknown'),
      state: closed(job?.state, JOB_MANAGEMENT_STATES, 'unknown'),
      observedAtMs: job?.observation.observedAtMs,
    });
  } catch {
    return { ...UNKNOWN };
  }
}

function actionId(): string | null {
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
export function beginJobManagement(
  action: JobManagementAction,
  input: Partial<JobManagementContext> = {}
): JobManagementObservation {
  const id = actionId();
  let initial: JobManagementContext;
  try {
    initial = context(input);
  } catch {
    initial = { ...UNKNOWN };
  }
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
  let confirmed = false;
  let settled = false;
  let recorded = false;
  const emit = (
    stage: 'intent' | 'confirmation' | 'request' | 'record',
    phase: JobManagementObservedProps['jobs_phase'],
    result: JobManagementObservedProps['jobs_result'],
    details: Partial<JobManagementDetails> = {}
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
      const ownerRecord = stage === 'record' && details.authority === 'owner_record';
      const input = { ...initial, ...details };
      if (stage === 'record' && !ownerRecord) {
        delete input.observedAtMs;
        input.freshness = details.freshness ?? 'unknown';
        input.availability = details.availability ?? 'unknown';
        input.state = details.state ?? 'unknown';
      }
      const safe = context(input);
      trackRendererEvent(JOB_MANAGEMENT_OBSERVED, {
        feature_area: 'navigation',
        operation_id: id,
        occurred_at_ms: Date.now(),
        jobs_action: action,
        jobs_stage: stage,
        jobs_phase: phase,
        jobs_result: result,
        jobs_authority: details.authority ?? 'not_attested',
        jobs_owner: safe.owner,
        jobs_freshness: safe.freshness,
        jobs_execution_mode: safe.mode,
        jobs_origin:
          safe.mode === 'recorded' ? 'recorded' : safe.mode === 'unknown' ? 'unknown' : 'live',
        jobs_result_availability: safe.availability,
        jobs_execution_state: safe.state,
        jobs_history_coverage: safe.history ?? 'unknown',
        jobs_scope: safe.scope ?? 'unknown',
        jobs_operation_relation: 'action_only_native_not_exported',
        jobs_context_basis: ownerRecord
          ? 'record_observation'
          : stage === 'record' ||
              [
                'owner',
                'freshness',
                'mode',
                'availability',
                'state',
                'observedAtMs',
                'history',
                'scope',
              ].some((key) => Object.prototype.hasOwnProperty.call(details, key))
            ? 'intent_and_outcome'
            : 'intent_snapshot',
        jobs_observation_clock: safe.observedAtMs === undefined ? 'unknown' : 'client_observed',
        ...(safe.observedAtMs === undefined ? {} : { jobs_observed_at_ms: safe.observedAtMs }),
      } satisfies JobManagementObservedProps);
    } catch (ignoredError) {
      void ignoredError;
    }
  };
  emit('intent', 'intent', 'management_requested', { authority: 'surface' });
  return {
    id,
    confirm(approved) {
      if (confirmed) return;
      confirmed = true;
      emit(
        'confirmation',
        approved ? 'confirmed' : 'cancelled',
        approved ? 'confirmation_accepted' : 'confirmation_cancelled',
        { authority: 'surface' }
      );
    },
    settle(details) {
      if (settled) return;
      settled = true;
      emit('request', details.phase, details.result, details);
    },
    record(details) {
      if (recorded) return;
      recorded = true;
      emit('record', details.phase, details.result, details);
    },
  };
}
