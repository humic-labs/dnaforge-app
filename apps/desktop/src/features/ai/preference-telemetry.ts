import { trackRendererEvent } from '../../lib/analytics';
import type { AssistantRouteSelection } from './assistant-routes';

type PreferenceStage = 'select' | 'persist' | 'restore' | 'discovery';
type PreferenceFailure =
  | 'persist-failed'
  | 'restore-invalid'
  | 'catalog-omitted'
  | 'presentation-mismatch'
  | 'none';

export function observeModelPreference(
  route: AssistantRouteSelection | null,
  stage: PreferenceStage,
  outcome: 'started' | 'succeeded' | 'failed',
  failure: PreferenceFailure = 'none',
  operationId: string = crypto.randomUUID(),
  modelSource: 'catalog' | 'custom' | 'default' = 'default'
): void {
  trackRendererEvent('model_preference_observed', {
    feature_area: 'settings',
    operation_id: operationId,
    occurred_at_ms: Date.now(),
    preference_stage: stage,
    preference_outcome: outcome,
    ...(route
      ? {
          preference_route_kind:
            route.kind === 'orchestrator' || route.kind === 'team' ? 'extension' : route.kind,
        }
      : {}),
    preference_selection_source: route ? 'explicit' : 'computed',
    preference_model_source: modelSource,
    preference_failure_code: failure,
  });
}
