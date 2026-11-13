import { getTelemetryCorrelationContext } from './telemetry-correlation';
import {
  trackRendererEvent,
  getAnalyticsIdentifiedAccountId,
  isAnalyticsCaptureReady,
} from './analytics';
import {
  SKILL_OPERATION_OBSERVED,
  skillOperationProperties,
  type SkillAction,
  type SkillObservationContext,
  type SkillOperationProperties,
} from '../shared/skill-operation-telemetry';
function observationId(): string | null {
  try {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 15) | 64;
    b[8] = (b[8]! & 63) | 128;
    const h = Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  } catch {
    return null;
  }
}
export function beginSkillObservation(action: SkillAction, context: SkillObservationContext = {}) {
  let id: string | null = null;
  let account: string | null = null;
  let originalEpisode: string | null = null;
  let originalSession: string | null = null;
  try {
    if (isAnalyticsCaptureReady()) {
      account = getAnalyticsIdentifiedAccountId();
      const origin = getTelemetryCorrelationContext();
      originalEpisode = origin.episodeCorrelationId;
      originalSession = origin.appSessionId;
      id = observationId();
    }
  } catch (ignoredError) {
    void ignoredError;
  }
  let settled = false;
  let readback = false;
  const emit = (
    stage: SkillOperationProperties['skills_stage'],
    result: SkillOperationProperties['skills_result'],
    details: SkillObservationContext
  ) => {
    if (!id) return;
    try {
      if (!isAnalyticsCaptureReady() || getAnalyticsIdentifiedAccountId() !== account) return;
      const current = getTelemetryCorrelationContext();
      if (
        current.episodeCorrelationId !== originalEpisode ||
        current.appSessionId !== originalSession
      )
        return;
      trackRendererEvent(SKILL_OPERATION_OBSERVED, {
        ...skillOperationProperties(id, action, stage, result, details),
      });
    } catch (ignoredError) {
      void ignoredError;
    }
  };
  emit('intent', 'requested', { ...context, authority: 'surface', freshness: 'intent' });
  return {
    id,
    settle(
      stage: SkillOperationProperties['skills_stage'],
      result: SkillOperationProperties['skills_result'],
      details: SkillObservationContext = {}
    ) {
      if (settled) return;
      settled = true;
      emit(stage, result, { ...context, ...details });
    },
    readback(
      result: SkillOperationProperties['skills_result'],
      details: SkillObservationContext = {}
    ) {
      if (readback) return;
      readback = true;
      emit('readback', result, { ...context, ...details });
    },
  };
}
