import { describe, expect, it } from 'vitest';
import {
  findAnnotationTrackIdentity,
  resolveAnnotationTrackIdentity,
} from './annotation-track-identity';

describe('annotation track identity', () => {
  it('prefers an exact scientific identity when a case-folded peer exists', () => {
    const candidates = ['transposon:Dm88', 'transposon:DM88'];
    expect(resolveAnnotationTrackIdentity('transposon:DM88', candidates, String)).toEqual({
      status: 'matched',
      matchKind: 'exact',
      value: 'transposon:DM88',
    });
  });

  it('preserves one unambiguous historical case-insensitive alias', () => {
    expect(resolveAnnotationTrackIdentity('mrna', ['mRNA'], String)).toEqual({
      status: 'matched',
      matchKind: 'unique-case-insensitive-alias',
      value: 'mRNA',
    });
  });

  it('fails closed when a case-insensitive request has two scientific spellings', () => {
    const candidates = ['transposon:Dm88', 'transposon:DM88'];
    expect(resolveAnnotationTrackIdentity('transposon:dm88', candidates, String)).toEqual({
      status: 'ambiguous',
    });
    expect(findAnnotationTrackIdentity('transposon:dm88', candidates, String)).toBeNull();
  });

  it('does not treat repeated candidates with one exact identity as ambiguous', () => {
    const candidates = [
      { trackType: 'mRNA', theme: 'light' },
      { trackType: 'mRNA', theme: 'dark' },
    ];
    expect(
      findAnnotationTrackIdentity('mrna', candidates, (candidate) => candidate.trackType)
    ).toBe(candidates[0]);
  });
});
