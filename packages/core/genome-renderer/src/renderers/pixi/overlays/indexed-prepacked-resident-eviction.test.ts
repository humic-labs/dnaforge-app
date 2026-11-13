import { describe, expect, it } from 'vitest';
import {
  pickDisposableCachedResident,
  selectProtectedInteractionResident,
} from './indexed-prepacked-resident-eviction';

describe('pickDisposableCachedResident', () => {
  it('returns undefined when every resident is protected', () => {
    expect(
      pickDisposableCachedResident(
        [
          { ownerKey: 'a', lastUsed: 1 },
          { ownerKey: 'b', lastUsed: 2 },
        ],
        new Set(['a', 'b'])
      )
    ).toBeUndefined();
  });

  it('evicts the oldest unprotected resident, breaking ties by owner key', () => {
    expect(
      pickDisposableCachedResident(
        [
          { ownerKey: 'keep', lastUsed: 0 },
          { ownerKey: 'z', lastUsed: 1 },
          { ownerKey: 'a', lastUsed: 1 },
          { ownerKey: 'newer', lastUsed: 9 },
        ],
        new Set(['keep'])
      )?.ownerKey
    ).toBe('a');
  });
});

describe('selectProtectedInteractionResident', () => {
  it('prefers the compiled candidate, then the compiled owner, then the newest lastUsed', () => {
    const residents = [
      { ownerKey: 'old', lastUsed: 1 },
      { ownerKey: 'fresh', lastUsed: 9 },
      { ownerKey: 'compiled', lastUsed: 2 },
      { ownerKey: 'candidate', lastUsed: 3 },
    ];
    expect(
      selectProtectedInteractionResident({
        candidates: residents,
        compiledCandidateOwnerKey: 'candidate',
        compiledOwnerKey: 'compiled',
      })?.ownerKey
    ).toBe('candidate');
    expect(
      selectProtectedInteractionResident({
        candidates: residents,
        compiledCandidateOwnerKey: 'missing',
        compiledOwnerKey: 'compiled',
      })?.ownerKey
    ).toBe('compiled');
    expect(
      selectProtectedInteractionResident({
        candidates: residents,
      })?.ownerKey
    ).toBe('fresh');
  });
});
