import type { ExtBucket, SizeBucket } from '../../shared/oversized-guard';
import { trackRendererEvent } from '../../lib/analytics';

export type OversizedDecision =
  | 'warned'
  | 'confirmed'
  | 'cancelled'
  | 'blocked'
  | 'indexed'
  | 'deferred-on-rehydrate'
  | 'missing'
  | 'stat-error';

export interface OversizedDecisionEvent {
  extBucket: ExtBucket;
  sizeBucket: SizeBucket;
  decision: OversizedDecision;
}

export function logOversizedDecision(event: OversizedDecisionEvent): void {
  trackRendererEvent('app_oversize_decision', {
    ext_bucket: event.extBucket,
    size_bucket: event.sizeBucket,
    decision: event.decision,
  });

  if (import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.log('[ oversize]', event);
  }
}
