import type { useSequenceSearch } from '@waypoint/workspace-editor';
import { getAnalyticsCaptureGeneration, trackRendererEvent } from '../../lib/analytics';
import {
  getTelemetryCorrelationContext,
  getTelemetryCorrelationRevision,
} from '../../lib/telemetry-correlation';
import { beginWorkflowAction, WORKFLOW_ACTION_OBSERVED } from '../../lib/workflow-telemetry';
import {
  sequenceSearchCountBucket,
  type SequenceSearchResult,
  type SequenceSearchNavigationResult,
} from '../../shared/sequence-search-telemetry';

export const SEQUENCE_SEARCH_OBSERVED = 'sequence_search_observed' as const;
export const SEQUENCE_SEARCH_NAVIGATION_OBSERVED = 'sequence_search_navigation_observed' as const;

type Observer = NonNullable<Parameters<typeof useSequenceSearch>[0]['onSearchStart']>;
type Dependencies = Omit<NonNullable<Parameters<typeof beginWorkflowAction>[1]>, 'track'> & {
  track?: (
    event: typeof SEQUENCE_SEARCH_OBSERVED | typeof SEQUENCE_SEARCH_NAVIGATION_OBSERVED,
    properties: Record<string, unknown>
  ) => boolean;
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

export function createSequenceSearchObserver(dependencies: Dependencies = {}): Observer {
  const { track = trackRendererEvent, ...workflowDependencies } = dependencies;
  return (input) => {
    const generation = getAnalyticsCaptureGeneration();
    const correlation = getTelemetryCorrelationContext();
    const revision = getTelemetryCorrelationRevision();
    const isCurrent = () => {
      const current = getTelemetryCorrelationContext();
      return (
        generation === getAnalyticsCaptureGeneration() &&
        revision === getTelemetryCorrelationRevision() &&
        correlation.appSessionId === current.appSessionId &&
        correlation.episodeCorrelationId === current.episodeCorrelationId
      );
    };
    const emit = (
      event: typeof SEQUENCE_SEARCH_OBSERVED | typeof SEQUENCE_SEARCH_NAVIGATION_OBSERVED,
      properties: Record<string, unknown>,
      fields: Record<string, unknown>
    ) => {
      try {
        if (
          !isCurrent() ||
          properties.app_session_id !== correlation.appSessionId ||
          properties.episode_correlation_id !== correlation.episodeCorrelationId
        )
          return false;
        return track(event, {
          ...Object.fromEntries(
            Object.entries(properties).filter(([key]) => COMMON_PROPERTIES.has(key))
          ),
          ...fields,
        });
      } catch {
        return false;
      }
    };
    const context = {
      sequence_search_source: 'in_memory',
      sequence_search_mode:
        input.mode === 'nucleotide'
          ? 'nucleotide'
          : input.mode === 'aminoAcid'
            ? 'amino_acid'
            : 'unknown',
      sequence_search_topology: input.circular ? 'circular' : 'linear',
      sequence_search_query_length_bucket: sequenceSearchCountBucket(input.queryLength),
      sequence_search_sequence_length_bucket: sequenceSearchCountBucket(input.sequenceLength),
    };
    let result: SequenceSearchResult = 'pending';
    let matchCountBucket = sequenceSearchCountBucket(Number.NaN);
    let acceptedMatches = false;
    const operation = beginWorkflowAction(
      { workflow: 'search', action: 'search' },
      {
        ...workflowDependencies,
        track: (event, properties) =>
          event === WORKFLOW_ACTION_OBSERVED &&
          emit(SEQUENCE_SEARCH_OBSERVED, properties, {
            ...context,
            sequence_search_result: result,
            sequence_search_match_count_bucket: matchCountBucket,
          }),
      }
    );
    return {
      get consumed() {
        return operation.consumed;
      },
      complete(count) {
        if (operation.consumed) return false;
        matchCountBucket = sequenceSearchCountBucket(count);
        if (matchCountBucket === 'unknown') {
          result = 'unknown';
          return operation.fail('inspection_result_invalid');
        }
        result = count > 0 ? 'matches' : 'empty';
        const accepted = operation.complete({
          status: count > 0 ? 'ready' : 'no_match',
          valueDelivered: false,
          usableResult: false,
        });
        acceptedMatches = accepted && count > 0 && isCurrent();
        return accepted;
      },
      fail(reason) {
        if (operation.consumed) return false;
        result = reason;
        return operation.fail(reason);
      },
      cancel(reason) {
        if (operation.consumed) return false;
        result = reason;
        return operation.cancel();
      },
      beginNavigation() {
        if (!acceptedMatches || !isCurrent() || !UUID.test(operation.actionId)) return;
        let navigationResult: SequenceSearchNavigationResult = 'pending';
        let navigationSurface: 'sequence_canvas' | 'sequence_tracks' = 'sequence_canvas';
        const navigation = beginWorkflowAction(
          {
            workflow: 'content',
            action: 'view',
            initiator: 'system',
            parentActionId: operation.actionId,
          },
          {
            ...workflowDependencies,
            track: (event, properties) =>
              event === WORKFLOW_ACTION_OBSERVED &&
              emit(SEQUENCE_SEARCH_NAVIGATION_OBSERVED, properties, {
                sequence_search_navigation_result:
                  properties.action_phase === 'cancel' && navigationResult === 'pending'
                    ? 'observation_interrupted'
                    : navigationResult,
                sequence_search_navigation_surface:
                  navigationResult === 'presented' ? navigationSurface : 'pending',
              }),
          }
        );
        if (!navigation.startAccepted) {
          navigation.cancel();
          return;
        }
        return {
          get consumed() {
            return navigation.consumed;
          },
          presented(surface: 'sequence_canvas' | 'sequence_tracks' = 'sequence_canvas') {
            if (navigation.consumed) return false;
            navigationSurface = surface;
            navigationResult = 'presented';
            return navigation.complete({
              status: 'viewed',
              valueDelivered: false,
              usableResult: false,
            });
          },
          cancel() {
            if (navigation.consumed) return false;
            navigationResult = 'cancelled';
            return navigation.cancel();
          },
        };
      },
    };
  };
}

export const observeSequenceSearch: Observer = (input) => createSequenceSearchObserver()(input);
