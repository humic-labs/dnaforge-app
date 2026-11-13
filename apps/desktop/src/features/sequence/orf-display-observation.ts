import type { OrfPresentation, useORFs } from '@waypoint/workspace-editor';
import { getAnalyticsCaptureGeneration, trackRendererEvent } from '../../lib/analytics';
import {
  getTelemetryCorrelationContext,
  getTelemetryCorrelationRevision,
} from '../../lib/telemetry-correlation';
import {
  beginWorkflowAction,
  WORKFLOW_ACTION_OBSERVED,
  workflowCountBucket,
} from '../../lib/workflow-telemetry';
import type { OrfDisplayResult, OrfDisplaySurface } from '../../shared/orf-display-telemetry';

export const ORF_DISPLAY_OBSERVED = 'sequence_orf_display_observed' as const;
type Source = Parameters<
  NonNullable<NonNullable<Parameters<typeof useORFs>[2]>['observeDetection']>
>[0]['source'];
type Input = Readonly<{ parentActionId: string; source: Source; resultCount: number }>;
type Dependencies = Omit<NonNullable<Parameters<typeof beginWorkflowAction>[1]>, 'track'> & {
  track?: (event: typeof ORF_DISPLAY_OBSERVED, properties: Record<string, unknown>) => boolean;
};
const COMMON_PROPERTIES = new Set([
  'feature_area',
  'workflow',
  'workflow_action',
  'action_phase',
  'action_id',
  'effect_id',
  'occurred_at_ms',
  'duration_ms',
  'workflow_status',
  'error_class',
  'success',
  'app_session_id',
  'episode_correlation_id',
  'parent_action_id',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createOrfDisplayObserver(dependencies: Dependencies = {}) {
  const { track = trackRendererEvent, ...workflowDependencies } = dependencies;
  return (input: Input): OrfPresentation | undefined => {
    if (
      !UUID.test(input.parentActionId) ||
      !Number.isSafeInteger(input.resultCount) ||
      input.resultCount < 0
    )
      return;
    const generation = getAnalyticsCaptureGeneration();
    const context = getTelemetryCorrelationContext();
    const revision = getTelemetryCorrelationRevision();
    let result: OrfDisplayResult = 'pending';
    let surface: OrfDisplaySurface = 'pending';
    const operation = beginWorkflowAction(
      {
        workflow: 'content',
        action: 'view',
        initiator: 'system',
        parentActionId: input.parentActionId,
      },
      {
        ...workflowDependencies,
        track: (event, properties) => {
          try {
            const current = getTelemetryCorrelationContext();
            if (
              event !== WORKFLOW_ACTION_OBSERVED ||
              generation !== getAnalyticsCaptureGeneration() ||
              revision !== getTelemetryCorrelationRevision() ||
              context.appSessionId !== current.appSessionId ||
              context.episodeCorrelationId !== current.episodeCorrelationId ||
              properties.app_session_id !== context.appSessionId ||
              properties.episode_correlation_id !== context.episodeCorrelationId
            )
              return false;
            return track(ORF_DISPLAY_OBSERVED, {
              ...Object.fromEntries(
                Object.entries(properties).filter(([key]) => COMMON_PROPERTIES.has(key))
              ),
              orf_display_source: input.source,
              orf_display_result:
                properties.action_phase === 'cancel' && result === 'pending'
                  ? 'observation_interrupted'
                  : result,
              orf_display_surface: surface,
              orf_display_result_count_bucket: workflowCountBucket(input.resultCount),
            });
          } catch {
            return false;
          }
        },
      }
    );
    if (!operation.startAccepted) {
      operation.cancel();
      return;
    }
    return {
      presented(fact) {
        if (operation.consumed) return;
        result = fact.kind === 'empty_model' ? 'empty' : 'drawn';
        surface = fact.surface;
        operation.complete({
          status: result === 'empty' ? 'no_match' : 'viewed',
          valueDelivered: false,
          usableResult: false,
        });
      },
      retire(reason) {
        if (operation.consumed) return;
        result = reason;
        operation.cancel();
      },
    };
  };
}

export const observeOrfDisplay = createOrfDisplayObserver();
