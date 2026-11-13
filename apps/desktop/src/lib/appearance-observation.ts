import { beginWorkflowAction, observeWorkflowAction } from './workflow-telemetry';
import {
  getAnalyticsIdentifiedAccountId,
  isAnalyticsCaptureReady,
  subscribeAnalyticsCaptureReady,
  trackRendererEvent,
} from './analytics';
import { getTelemetryCorrelationContext } from './telemetry-correlation';
import type { WorkflowOutcomeKind } from '../shared/scientific-workflow-vocab';

export type AppearanceCategory =
  | 'appearance_theme'
  | 'appearance_display'
  | 'appearance_webgl'
  | 'appearance_palette';
export type AppearanceOrigin = 'user' | 'system' | 'restore' | 'retry';
export function beginAppearanceObservation(
  category: AppearanceCategory,
  origin: AppearanceOrigin = 'user'
) {
  try {
    return createObservation(category, origin);
  } catch {
    return {
      stage: (_outcome: WorkflowOutcomeKind) => {},
      end: (_outcome: WorkflowOutcomeKind, _failed = false) => {},
    };
  }
}
function createObservation(category: AppearanceCategory, origin: AppearanceOrigin) {
  let live = isAnalyticsCaptureReady();
  let accepted = false;
  const episode = { ...getTelemetryCorrelationContext() };
  const account = getAnalyticsIdentifiedAccountId();
  const allowed = () => {
    const current = getTelemetryCorrelationContext();
    if (
      !isAnalyticsCaptureReady() ||
      getAnalyticsIdentifiedAccountId() !== account ||
      current.appSessionId !== episode.appSessionId ||
      current.episodeCorrelationId !== episode.episodeCorrelationId
    )
      live = false;
    return live;
  };
  const unsubscribe = subscribeAnalyticsCaptureReady(() => {
    try {
      allowed();
    } catch {
      live = false;
    }
  });
  const dependencies = {
    track: (
      event: Parameters<typeof trackRendererEvent>[0],
      properties: Record<string, unknown>
    ) => {
      if (!allowed()) return false;
      const result = trackRendererEvent(event, properties);
      if (properties.action_phase === 'start') accepted = result;
      return result;
    },
  };
  const action = origin === 'restore' ? 'restore' : origin === 'retry' ? 'run' : 'update';
  let operation: ReturnType<typeof beginWorkflowAction> | null = null;
  try {
    operation = beginWorkflowAction(
      {
        workflow: category,
        action,
        initiator: 'system',
        workflowOrigin: origin === 'system' || origin === 'restore' ? 'projection' : 'direct',
      },
      dependencies
    );
  } catch (_error) {
    void _error;
  }
  let ended = false;
  return {
    stage(outcome: WorkflowOutcomeKind) {
      if (ended || !accepted) return;
      try {
        observeWorkflowAction(
          {
            workflow: category,
            action,
            actionId: operation?.actionId,
            initiator: 'system',
            phase: 'commit',
            status: 'started',
            outcomeKind: outcome,
            workflowOrigin: origin === 'system' || origin === 'restore' ? 'projection' : 'direct',
          },
          dependencies
        );
      } catch (_error) {
        void _error;
      }
    },
    end(outcome: WorkflowOutcomeKind, failed = false) {
      if (ended) return;
      ended = true;
      try {
        if (outcome === 'preference_superseded')
          operation?.cancel({ status: 'cancelled', outcomeKind: outcome });
        else if (failed)
          operation?.fail('preference_unknown', { status: 'failed', outcomeKind: outcome });
        else operation?.complete({ status: 'completed', outcomeKind: outcome });
      } catch (_error) {
        void _error;
      } finally {
        live = false;
        try {
          unsubscribe();
        } catch (_error) {
          void _error;
        }
      }
    },
  };
}

export function observeAppearanceDecision(
  category: AppearanceCategory,
  decision: 'preference_noop' | 'preference_refused'
): void {
  try {
    if (!isAnalyticsCaptureReady()) return;
    observeWorkflowAction({
      workflow: category,
      action: 'update',
      initiator: 'system',
      phase: 'commit',
      status: decision === 'preference_noop' ? 'no_match' : 'blocked',
      outcomeKind: decision,
    });
  } catch (_error) {
    void _error;
  }
}
