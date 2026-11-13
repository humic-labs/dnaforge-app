import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEntityOpenReceipt } from '../page/public/native-entity-links';
import type { DocumentContentState } from '../canvas/public/document-presentation';
import type { WorkflowOperation } from '../../shared/workflow-operation';
import { settleCatalogSearchOpen } from './search-open-outcome';

const operation = {
  complete: vi.fn<WorkflowOperation['complete']>(() => true),
  fail: vi.fn<WorkflowOperation['fail']>(() => true),
  cancel: vi.fn<WorkflowOperation['cancel']>(() => true),
};
const presented = (content: DocumentContentState): CatalogEntityOpenReceipt => ({
  kind: 'document',
  result: {
    status: 'presented',
    panelId: 'main',
    tabId: 'page',
    tabType: 'page',
    disposition: 'created',
    content,
  },
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  expect(
    operation.complete.mock.calls.length +
      operation.fail.mock.calls.length +
      operation.cancel.mock.calls.length
  ).toBe(1);
});

describe('catalog search open outcomes', () => {
  it.each([
    { content: 'ready', status: 'ready', usable: true },
    { content: 'loading', status: 'needs_action', usable: false },
  ] satisfies Array<{ content: DocumentContentState; status: string; usable: boolean }>)(
    'keeps presented $content content distinct from a usable result',
    ({ content, status, usable }) => {
      settleCatalogSearchOpen({ operation, outcome: presented(content) });
      expect(operation.complete).toHaveBeenCalledExactlyOnceWith({
        status,
        outcomeKind: 'catalog_presented',
        usableResult: usable,
        valueDelivered: usable,
      });
    }
  );

  it.each(['missing', 'error'] satisfies DocumentContentState[])(
    'refuses to count presented %s content as delivered',
    (content) => {
      settleCatalogSearchOpen({ operation, outcome: presented(content) });
      expect(operation.fail).toHaveBeenCalledExactlyOnceWith('open_failed', {
        outcomeKind: 'catalog_open_failed',
        usableResult: false,
        valueDelivered: false,
      });
    }
  );

  it.each(['blocked', 'unsupported', 'failed'] as const)(
    'retains the document owner %s terminal',
    (status) => {
      settleCatalogSearchOpen({
        operation,
        outcome: { kind: 'document', result: { status, message: 'Private document refused' } },
      });
      expect(operation.fail).toHaveBeenCalledExactlyOnceWith('open_failed', {
        status: status === 'blocked' ? 'blocked' : 'failed',
        outcomeKind: 'catalog_open_failed',
        usableResult: false,
        valueDelivered: false,
      });
    }
  );

  it('retains a cancelled document without claiming a failed or delivered open', () => {
    settleCatalogSearchOpen({
      operation,
      outcome: { kind: 'document', result: { status: 'cancelled', reason: 'Private reason' } },
    });
    expect(operation.cancel).toHaveBeenCalledExactlyOnceWith({
      outcomeKind: 'catalog_open_cancelled',
    });
  });

  it.each([
    { kind: 'cancelled', outcomeKind: 'catalog_open_cancelled' },
    { kind: 'superseded', outcomeKind: 'catalog_open_superseded' },
  ] as const)('retains a $kind reference terminal', ({ kind, outcomeKind }) => {
    settleCatalogSearchOpen({ operation, outcome: { kind } });
    expect(operation.cancel).toHaveBeenCalledExactlyOnceWith({ outcomeKind });
  });

  it.each([
    { reason: 'refused', status: 'blocked' },
    { reason: 'missing_owner', status: 'failed' },
    { reason: 'handler_unavailable', status: 'failed' },
  ] as const)('retains the $reason refusal without a ready result', ({ reason, status }) => {
    settleCatalogSearchOpen({ operation, outcome: { kind: 'failure', reason } });
    expect(operation.fail).toHaveBeenCalledExactlyOnceWith(reason, {
      status,
      outcomeKind: 'catalog_open_failed',
      usableResult: false,
      valueDelivered: false,
    });
  });

  it.each(['registry_record', 'registry_search'] as const)(
    'keeps %s separate from a presented document',
    (kind) => {
      settleCatalogSearchOpen({ operation, outcome: { kind } });
      expect(operation.complete).toHaveBeenCalledExactlyOnceWith({
        status: 'needs_action',
        outcomeKind: 'catalog_registry_requested',
        usableResult: false,
        valueDelivered: false,
      });
    }
  );

  it.each(['provider_requested', 'reveal_requested'] as const)(
    'does not treat %s as a catalog document open',
    (kind) => {
      settleCatalogSearchOpen({ operation, outcome: { kind } });
      expect(operation.fail).toHaveBeenCalledExactlyOnceWith('unsupported', {
        status: 'blocked',
        outcomeKind: 'catalog_open_failed',
        usableResult: false,
        valueDelivered: false,
      });
    }
  );
});
