import { getAnalyticsCaptureGeneration, trackRendererEvent } from '../../lib/analytics';
import {
  getTelemetryCorrelationContext,
  getTelemetryCorrelationRevision,
} from '../../lib/telemetry-correlation';
import {
  beginWorkflowAction,
  WORKFLOW_ACTION_OBSERVED,
  type WorkflowOperation,
} from '../../lib/workflow-telemetry';
import type { FrameTranslation } from './six-frame-translation';
import type {
  TranslationCopyCode,
  TranslationCopyLengthBucket,
  TranslationCopyResult,
} from '../../shared/translation-copy-telemetry';

export const TRANSLATION_COPY_OBSERVED = 'sequence_translation_copy_observed' as const;

type TranslationCopyRequest = Readonly<
  Pick<FrameTranslation, 'strand' | 'frame'> & {
    codeCategory: TranslationCopyCode;
    lengthBucket: TranslationCopyLengthBucket;
    write: () => Promise<void>;
  }
>;
type Dependencies = Omit<NonNullable<Parameters<typeof beginWorkflowAction>[1]>, 'track'> & {
  track?: (event: typeof TRANSLATION_COPY_OBSERVED, properties: Record<string, unknown>) => boolean;
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

function copyResult(properties: Record<string, unknown>): TranslationCopyResult {
  switch (properties.action_phase) {
    case 'start':
      return 'pending';
    case 'result':
      return 'delivered';
    case 'error':
      return properties.error_class === 'not_allowed' ? 'not_allowed' : 'write_failed';
    default:
      return 'observation_interrupted';
  }
}

function rejectionClass(error: unknown): 'not_allowed' | 'write_failed' {
  try {
    return (error instanceof Error || error instanceof DOMException) &&
      error.name === 'NotAllowedError'
      ? 'not_allowed'
      : 'write_failed';
  } catch {
    return 'write_failed';
  }
}

export function createTranslationCopyDelivery(dependencies: Dependencies = {}) {
  const { track = trackRendererEvent, ...workflowDependencies } = dependencies;
  return async (request: TranslationCopyRequest): Promise<void> => {
    let operation: WorkflowOperation | undefined;
    try {
      const generation = getAnalyticsCaptureGeneration();
      const context = getTelemetryCorrelationContext();
      const revision = getTelemetryCorrelationRevision();
      const metadata = {
        translation_copy_strand: request.strand,
        translation_copy_frame: String(request.frame),
        translation_copy_code: request.codeCategory,
        translation_copy_length_bucket: request.lengthBucket,
      };
      operation = beginWorkflowAction(
        { workflow: 'content', action: 'copy' },
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
              return track(TRANSLATION_COPY_OBSERVED, {
                ...Object.fromEntries(
                  Object.entries(properties).filter(([key]) => COMMON_PROPERTIES.has(key))
                ),
                ...metadata,
                translation_copy_result: copyResult(properties),
              });
            } catch {
              return false;
            }
          },
        }
      );
    } catch {
      operation = undefined;
    }
    try {
      await request.write();
    } catch (error) {
      try {
        operation?.fail(rejectionClass(error));
      } catch {}
      throw error;
    }
    try {
      operation?.complete({ valueDelivered: true, usableResult: false });
    } catch {}
  };
}

export const deliverTranslationCopy = createTranslationCopyDelivery();
