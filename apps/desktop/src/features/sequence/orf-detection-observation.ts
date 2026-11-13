import type { useORFs } from '@waypoint/workspace-editor';
import { observeOrfDisplay } from './orf-display-observation';
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
import type {
  OrfDetectionCountBucket,
  OrfDetectionResult,
} from '../../shared/orf-detection-telemetry';

export const ORF_DETECTION_OBSERVED = 'sequence_orf_detection_observed' as const;
type Observer = NonNullable<NonNullable<Parameters<typeof useORFs>[2]>['observeDetection']>;
type Dependencies = Omit<NonNullable<Parameters<typeof beginWorkflowAction>[1]>, 'track'> & {
  track?: (event: typeof ORF_DETECTION_OBSERVED, properties: Record<string, unknown>) => boolean;
  observeDisplay?: typeof observeOrfDisplay;
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
]);

export function createOrfDetectionObserver(dependencies: Dependencies = {}): Observer {
  const { track = trackRendererEvent, observeDisplay, ...workflowDependencies } = dependencies;
  return (input) => {
    const generation = getAnalyticsCaptureGeneration();
    const context = getTelemetryCorrelationContext();
    const revision = getTelemetryCorrelationRevision();
    const metadata = {
      orf_detection_source: input.source,
      orf_detection_sequence_length_bucket: workflowCountBucket(input.sequenceLength),
    };
    let result: OrfDetectionResult = 'pending';
    let resultCountBucket: OrfDetectionCountBucket = 'unknown';
    const operation = beginWorkflowAction(
      { workflow: 'content', action: 'compute', initiator: 'system' },
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
            return track(ORF_DETECTION_OBSERVED, {
              ...Object.fromEntries(
                Object.entries(properties).filter(([key]) => COMMON_PROPERTIES.has(key))
              ),
              ...metadata,
              orf_detection_result:
                properties.action_phase === 'cancel' && result === 'pending'
                  ? 'observation_interrupted'
                  : result,
              orf_detection_result_count_bucket: resultCountBucket,
            });
          } catch {
            return false;
          }
        },
      }
    );
    return {
      detected(count) {
        if (operation.consumed) return;
        resultCountBucket = Number.isSafeInteger(count) ? workflowCountBucket(count) : 'unknown';
        if (resultCountBucket === 'unknown') {
          result = 'invalid_result';
          operation.fail('inspection_result_invalid');
          return;
        }
        result = count > 0 ? 'results' : 'empty';
        const accepted = operation.complete({
          status: count > 0 ? 'ready' : 'no_match',
          valueDelivered: false,
          usableResult: false,
        });
        const current = getTelemetryCorrelationContext();
        if (
          !accepted ||
          generation !== getAnalyticsCaptureGeneration() ||
          revision !== getTelemetryCorrelationRevision() ||
          context.appSessionId !== current.appSessionId ||
          context.episodeCorrelationId !== current.episodeCorrelationId
        )
          return;
        try {
          return observeDisplay?.({
            parentActionId: operation.actionId,
            source: input.source,
            resultCount: count,
          });
        } catch {
          return;
        }
      },
      failed(reason) {
        if (operation.consumed) return;
        result = reason;
        operation.fail(reason);
      },
      retire(reason) {
        if (operation.consumed) return;
        result = reason;
        operation.cancel();
      },
    };
  };
}

export const observeOrfDetection = createOrfDetectionObserver({
  observeDisplay: observeOrfDisplay,
});
