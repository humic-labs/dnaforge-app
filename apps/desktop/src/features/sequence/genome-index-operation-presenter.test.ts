// @vitest-environment node

import type { OperationSnapshot } from '@waypoint/api-client';
import { describe, expect, it } from 'vitest';
import {
  createGenomeIndexOperationPresenter,
  genomeIndexOperationPresenters,
} from './genome-index-operation-presenter';

function operation(): OperationSnapshot {
  return {
    id: 'operation-1',
    kind: 'genome-indexing',
    kind_contract_version: 1,
    subject: {
      scope_id: 'scope-a',
      subject_id: `genome-source-v1:sha256:${'a'.repeat(64)}`,
      input_revision: `genome-index-v1:sha256:${'b'.repeat(64)}`,
    },
    state: 'succeeded',
    actor_kind: 'human',
    actor_id: 'local-human',
    channel: 'desktop_ui',
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

describe('genome-index operation presenter', () => {
  it('gives Jobs a domain title without claiming a standalone result viewer', () => {
    const presenter = createGenomeIndexOperationPresenter();
    const snapshot = operation();

    expect(presenter.title(snapshot)).toBe('Index genome');
    expect(presenter.targetLabel(snapshot)).toBeUndefined();
    expect(presenter.review(snapshot)).toEqual({ state: 'not-required' });
    expect(presenter.canOpenResult(snapshot)).toBe(false);
    expect(presenter.openResult).toBeNull();
  });

  it('registers under the compiled operation kind', () => {
    expect(genomeIndexOperationPresenters()).toHaveProperty('genome-indexing');
  });
});
