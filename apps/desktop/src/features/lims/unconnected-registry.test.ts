// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { LimsPendingRef } from '../../shared/lims';
import { sourceFieldIsUnconnected, unconnectedEntityIds } from './unconnected-registry';

function ref(overrides: Partial<LimsPendingRef> & Pick<LimsPendingRef, 'status'>): LimsPendingRef {
  return {
    key: 'k',
    referrerEntityId: 'strain-1',
    referrerName: 'PCY602',
    type: 'associated_with',
    targetKind: null,
    targetName: 'Triple reporter integrated',
    normalizedTargetName: 'triple reporter integrated',
    sourceBatchId: 'batch',
    candidateEntityIds: [],
    candidates: [],
    ...overrides,
  };
}

describe('unconnected registry mentions', () => {
  it('counts each entity once and ignores connected or dismissed mentions', () => {
    const ids = unconnectedEntityIds([
      ref({ status: 'open', referrerEntityId: 'a', key: '1' }),
      ref({ status: 'draft', referrerEntityId: 'a', key: '2' }),
      ref({ status: 'ambiguous', referrerEntityId: 'b', key: '3' }),
      ref({ status: 'resolved', referrerEntityId: 'c', key: '4' }),
      ref({ status: 'dismissed', referrerEntityId: 'd', key: '5' }),
    ]);
    expect(ids).toEqual(['a', 'b']);
  });

  it('marks a source field when one comma-separated part is an unconnected target', () => {
    const refs = [ref({ status: 'open' })];
    expect(
      sourceFieldIsUnconnected('GEM-ZQX-Sundew integrated Chr XI, Triple reporter integrated', refs)
    ).toBe(true);
    expect(sourceFieldIsUnconnected('PCY552', refs)).toBe(false);
    expect(
      sourceFieldIsUnconnected('Triple reporter integrated', [ref({ status: 'resolved' })])
    ).toBe(false);
  });
});
