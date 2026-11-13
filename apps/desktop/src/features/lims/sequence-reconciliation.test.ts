// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  isProvablyExact,
  reconcileSequenceToRegistry,
  type ReconcileCandidate,
  type ReconcileEntity,
} from './sequence-reconciliation';

function entity(overrides: Partial<ReconcileEntity>): ReconcileEntity {
  return { id: 'e1', name: 'entity', ...overrides };
}

function candidate(overrides: Partial<ReconcileCandidate>): ReconcileCandidate {
  return { name: 'candidate', ...overrides };
}

describe('isProvablyExact', () => {
  it('matches on identical non-empty normalizedSequenceHash', () => {
    expect(
      isProvablyExact(
        candidate({ normalizedSequenceHash: 'seqhash-abc' }),
        entity({ normalizedSequenceHash: 'seqhash-abc' })
      )
    ).toBe(true);
  });

  it('matches on identical non-empty fileContentHash', () => {
    expect(
      isProvablyExact(
        candidate({ fileContentHash: 'file-123' }),
        entity({ fileContentHash: 'file-123' })
      )
    ).toBe(true);
  });

  it('matches when accessionKey sets intersect', () => {
    expect(
      isProvablyExact(
        candidate({ accessionKeys: ['addgene:12345', 'genbank:u00096'] }),
        entity({ accessionKeys: ['refseq:nc_000913', 'addgene:12345'] })
      )
    ).toBe(true);
  });

  it('does not match when nothing overlaps', () => {
    expect(
      isProvablyExact(
        candidate({
          normalizedSequenceHash: 'seqhash-a',
          fileContentHash: 'file-a',
          accessionKeys: ['addgene:1'],
        }),
        entity({
          normalizedSequenceHash: 'seqhash-b',
          fileContentHash: 'file-b',
          accessionKeys: ['addgene:2'],
        })
      )
    ).toBe(false);
  });

  it('never matches on empty-string hashes (degenerate guard)', () => {
    expect(
      isProvablyExact(
        candidate({ normalizedSequenceHash: '', fileContentHash: '' }),
        entity({ normalizedSequenceHash: '', fileContentHash: '' })
      )
    ).toBe(false);
  });

  it('never matches on whitespace-only hashes', () => {
    expect(
      isProvablyExact(
        candidate({ normalizedSequenceHash: '   ' }),
        entity({ normalizedSequenceHash: '   ' })
      )
    ).toBe(false);
  });

  it('never matches on null / undefined hashes', () => {
    expect(
      isProvablyExact(
        candidate({ normalizedSequenceHash: null, fileContentHash: undefined }),
        entity({ normalizedSequenceHash: null, fileContentHash: undefined })
      )
    ).toBe(false);
  });

  it('never matches on empty accessionKey sets', () => {
    expect(isProvablyExact(candidate({ accessionKeys: [] }), entity({ accessionKeys: [] }))).toBe(
      false
    );
  });

  it('ignores empty-string accession tokens (no false intersection)', () => {
    expect(
      isProvablyExact(
        candidate({ accessionKeys: ['', '  '] }),
        entity({ accessionKeys: ['', '  '] })
      )
    ).toBe(false);
  });
});

describe('reconcileSequenceToRegistry', () => {
  it('auto-links a provably-exact hash match (same_as, accepted)', () => {
    const registry: ReconcileEntity[] = [
      entity({ id: 'reg-pDEMO026', name: 'pDEMO026', normalizedSequenceHash: 'h-pcy026' }),
    ];
    const result = reconcileSequenceToRegistry(
      candidate({ name: 'pDEMO026', normalizedSequenceHash: 'h-pcy026' }),
      registry
    );
    expect(result).toEqual({
      verdict: 'exact-auto',
      matchId: 'reg-pDEMO026',
      link: { type: 'same_as', accepted: true },
    });
  });

  it('suggests (never auto) a fuzzy different-hash name match — THE TRUST GATE', () => {
    const registry: ReconcileEntity[] = [
      entity({ id: 'reg-pDEMO026', name: 'pDEMO026', normalizedSequenceHash: 'h-pcy026' }),
    ];
    const result = reconcileSequenceToRegistry(
      candidate({ name: 'pDEMO026 v2', normalizedSequenceHash: 'h-different' }),
      registry
    );

    expect(result.verdict).toBe('fuzzy-suggest');
    expect(result.verdict).not.toBe('exact-auto');
    expect(result.link).toEqual({ type: 'associated_with', accepted: false });
    expect(result.link?.accepted).toBe(false);
    expect(result.matchId).toBe('reg-pDEMO026');
  });

  it('a degenerate empty-hash candidate that only name-matches is fuzzy-suggest, never exact-auto', () => {
    const registry: ReconcileEntity[] = [
      entity({ id: 'reg-pDEMO026', name: 'pDEMO026', normalizedSequenceHash: '' }),
    ];
    const result = reconcileSequenceToRegistry(
      candidate({ name: 'pDEMO026', normalizedSequenceHash: '' }),
      registry
    );
    expect(result.verdict).toBe('fuzzy-suggest');
    expect(result.verdict).not.toBe('exact-auto');
    expect(result.link?.accepted).toBe(false);
  });

  it('matches fuzzily on case-insensitive normalized name equality', () => {
    const registry: ReconcileEntity[] = [entity({ id: 'reg-x', name: '  pDEMO026  ' })];
    const result = reconcileSequenceToRegistry(candidate({ name: 'pdemo026' }), registry);
    expect(result.verdict).toBe('fuzzy-suggest');
    expect(result.matchId).toBe('reg-x');
  });

  it('matches fuzzily when one name contains the other as a token', () => {
    const registry: ReconcileEntity[] = [entity({ id: 'reg-x', name: 'pDEMO026 backbone clone' })];
    const result = reconcileSequenceToRegistry(candidate({ name: 'pDEMO026' }), registry);
    expect(result.verdict).toBe('fuzzy-suggest');
  });

  it('prefers exact-auto over a fuzzy match elsewhere in the registry', () => {
    const registry: ReconcileEntity[] = [
      entity({ id: 'reg-fuzzy', name: 'pDEMO026 v2', normalizedSequenceHash: 'h-other' }),
      entity({ id: 'reg-exact', name: 'unrelated-name', normalizedSequenceHash: 'h-match' }),
    ];
    const result = reconcileSequenceToRegistry(
      candidate({ name: 'pDEMO026', normalizedSequenceHash: 'h-match' }),
      registry
    );
    expect(result.verdict).toBe('exact-auto');
    expect(result.matchId).toBe('reg-exact');
    expect(result.link).toEqual({ type: 'same_as', accepted: true });
  });

  it('returns none when there is neither an exact nor a fuzzy match', () => {
    const registry: ReconcileEntity[] = [
      entity({ id: 'reg-x', name: 'something-else', normalizedSequenceHash: 'h-x' }),
    ];
    const result = reconcileSequenceToRegistry(
      candidate({ name: 'pDEMO026', normalizedSequenceHash: 'h-y' }),
      registry
    );
    expect(result).toEqual({ verdict: 'none' });
  });

  it('returns none against an empty registry', () => {
    expect(reconcileSequenceToRegistry(candidate({ name: 'pDEMO026' }), [])).toEqual({
      verdict: 'none',
    });
  });
});
