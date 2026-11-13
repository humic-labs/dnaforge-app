// @vitest-environment node

import type { OperationSnapshot } from '@waypoint/api-client';
import { describe, expect, it } from 'vitest';
import {
  alignmentOperationPresenters,
  createMultipleSequenceAlignmentOperationPresenter,
  createPairwiseSessionAlignmentOperationPresenter,
} from './managed-operation-presenter';

function operation(): OperationSnapshot {
  return {
    id: 'operation-1',
    kind: 'multiple-sequence-alignment',
    kind_contract_version: 1,
    subject: {
      scope_id: 'scope-a',
      subject_id: 'msa:action-1',
      input_revision: `msa-v1:sha256:${'a'.repeat(64)}`,
    },
    state: 'succeeded',
    actor_kind: 'agent',
    actor_id: 'agent-a',
    channel: 'agent',
    owner_instance_id: 'owner-a',
    version: 2,
    created_at: 1,
    updated_at: 2,
    settled_at: 2,
    cancellation_mode: 'cooperative',
    cancellation_availability: 'already_settled',
    result_status: 'available',
  };
}

describe('multiple-sequence-alignment operation presenter', () => {
  it('gives Jobs a domain title without claiming an unavailable MSA viewer', () => {
    const presenter = createMultipleSequenceAlignmentOperationPresenter();
    const snapshot = operation();

    expect(presenter.title(snapshot)).toBe('Multiple sequence alignment');
    expect(presenter.targetLabel(snapshot)).toBeUndefined();
    expect(presenter.review(snapshot)).toEqual({ state: 'not-required' });
    expect(presenter.canOpenResult(snapshot)).toBe(false);
    expect(presenter.openResult).toBeNull();
  });

  it('registers under the compiled operation kind', () => {
    expect(alignmentOperationPresenters()).toHaveProperty('multiple-sequence-alignment');
    expect(alignmentOperationPresenters()).toHaveProperty('pairwise-session-alignment');
  });

  it('gives pairwise session work its product title in Jobs', () => {
    const snapshot = {
      ...operation(),
      kind: 'pairwise-session-alignment',
      actor_kind: 'human' as const,
      channel: 'desktop_ui' as const,
    };

    const presenter = createPairwiseSessionAlignmentOperationPresenter();
    expect(presenter.title(snapshot)).toBe('Align verification session');
    expect(presenter.review(snapshot)).toEqual({ state: 'not-required' });
    expect(presenter.canOpenResult(snapshot)).toBe(false);
  });
});
