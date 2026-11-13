import type { CatalogEntityOpenReceipt } from '../page/public/native-entity-links';
import type { WorkflowOperation } from '../../shared/workflow-operation';

export function settleCatalogSearchOpen({
  operation,
  outcome,
}: {
  operation: Pick<WorkflowOperation, 'complete' | 'fail' | 'cancel'>;
  outcome: CatalogEntityOpenReceipt;
}): void {
  switch (outcome.kind) {
    case 'document': {
      const result = outcome.result;
      if (result.status === 'cancelled') {
        operation.cancel({ outcomeKind: 'catalog_open_cancelled' });
      } else if (result.status !== 'presented') {
        operation.fail('open_failed', {
          status: result.status === 'blocked' ? 'blocked' : 'failed',
          outcomeKind: 'catalog_open_failed',
          usableResult: false,
          valueDelivered: false,
        });
      } else if (result.content === 'missing' || result.content === 'error') {
        operation.fail('open_failed', {
          outcomeKind: 'catalog_open_failed',
          usableResult: false,
          valueDelivered: false,
        });
      } else {
        const ready = result.content === 'ready';
        operation.complete({
          status: ready ? 'ready' : 'needs_action',
          outcomeKind: 'catalog_presented',
          usableResult: ready,
          valueDelivered: ready,
        });
      }
      return;
    }
    case 'failure':
      operation.fail(outcome.reason, {
        status: outcome.reason === 'refused' ? 'blocked' : 'failed',
        outcomeKind: 'catalog_open_failed',
        usableResult: false,
        valueDelivered: false,
      });
      return;
    case 'registry_record':
    case 'registry_search':
      operation.complete({
        status: 'needs_action',
        outcomeKind: 'catalog_registry_requested',
        usableResult: false,
        valueDelivered: false,
      });
      return;
    case 'cancelled':
    case 'superseded':
      operation.cancel({
        outcomeKind:
          outcome.kind === 'cancelled' ? 'catalog_open_cancelled' : 'catalog_open_superseded',
      });
      return;
    case 'provider_requested':
    case 'reveal_requested':
      operation.fail('unsupported', {
        status: 'blocked',
        outcomeKind: 'catalog_open_failed',
        usableResult: false,
        valueDelivered: false,
      });
      return;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
