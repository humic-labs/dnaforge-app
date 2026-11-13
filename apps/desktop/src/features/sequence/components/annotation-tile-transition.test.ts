// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { Feature } from '@waypoint/genome-renderer';

import {
  buildRetainedIdentityMap,
  mergeWithTransitionContinuity,
  type TileTransitionInputs,
} from './annotation-tile-transition';

function f(
  id: number,
  identity: string,
  start: number,
  end: number,
  overrides: Partial<Feature> = {}
): Feature {
  return {
    id,
    type: 'mRNA',
    start,
    end,
    direction: 'forward',
    qualifiers: { ID: identity },
    ...overrides,
  } as Feature;
}

const identityOf = (feat: Feature): string | null => {
  const q = feat.qualifiers as { ID?: string } | undefined;
  return q?.ID ?? null;
};

describe('mergeWithTransitionContinuity', () => {
  it('returns current alone when previous is empty', () => {
    const current = new Map<string, Feature>([['a', f(1, 'A', 0, 100)]]);
    const out = mergeWithTransitionContinuity({
      current,
      previous: new Map(),
      activeRange: { start: 0, end: 1000 },
      identityOf,
    });
    expect(out.size).toBe(1);
    expect(out.get('a')?.id).toBe(1);
  });

  it('re-introduces previous features absent from current but inside active range', () => {
    const current = new Map<string, Feature>([['a', f(1, 'A', 0, 100)]]);
    const previous = new Map<string, Feature>([['B', f(2, 'B', 200, 300)]]);
    const out = mergeWithTransitionContinuity({
      current,
      previous,
      activeRange: { start: 0, end: 1000 },
      identityOf,
    });
    expect(out.size).toBe(2);
    expect(out.has('a')).toBe(true);
    expect(out.has('retained|B')).toBe(true);
    expect(out.get('retained|B')?.id).toBe(2);
  });

  it('does NOT re-introduce previous features outside active range', () => {
    const current = new Map<string, Feature>([['a', f(1, 'A', 0, 100)]]);
    const previous = new Map<string, Feature>([['B', f(2, 'B', 2000, 3000)]]);
    const out = mergeWithTransitionContinuity({
      current,
      previous,
      activeRange: { start: 0, end: 1000 },
      identityOf,
    });
    expect(out.size).toBe(1);
    expect(out.has('retained|B')).toBe(false);
  });

  it('current wins when same identity appears in both', () => {
    const currentFeat = f(1, 'A', 0, 100, { displayName: 'CURRENT' });
    const previousFeat = f(99, 'A', 0, 100, { displayName: 'PREVIOUS' });
    const current = new Map<string, Feature>([['a', currentFeat]]);
    const previous = new Map<string, Feature>([['A', previousFeat]]);
    const out = mergeWithTransitionContinuity({
      current,
      previous,
      activeRange: { start: 0, end: 1000 },
      identityOf,
    });
    expect(out.size).toBe(1);
    expect(out.get('a')?.displayName).toBe('CURRENT');
    expect(out.has('retained|A')).toBe(false);
  });

  it('drops previous features without identity', () => {
    const current = new Map<string, Feature>([['a', f(1, 'A', 0, 100)]]);
    const nameless = f(2, '', 200, 300);
    delete (nameless.qualifiers as { ID?: string }).ID;
    const previous = new Map<string, Feature>([['', nameless]]);
    const out = mergeWithTransitionContinuity({
      current,
      previous,
      activeRange: { start: 0, end: 1000 },
      identityOf,
    });
    expect(out.size).toBe(1);
  });

  it('null activeRange returns current-only (degenerate guard)', () => {
    const current = new Map<string, Feature>([['a', f(1, 'A', 0, 100)]]);
    const previous = new Map<string, Feature>([['B', f(2, 'B', 0, 100)]]);
    const out = mergeWithTransitionContinuity({
      current,
      previous,
      activeRange: null,
      identityOf,
    });
    expect(out.size).toBe(1);
  });

  it('invalid range (end <= start) returns current-only', () => {
    const current = new Map<string, Feature>([['a', f(1, 'A', 0, 100)]]);
    const previous = new Map<string, Feature>([['B', f(2, 'B', 0, 100)]]);
    const out = mergeWithTransitionContinuity({
      current,
      previous,
      activeRange: { start: 1000, end: 1000 },
      identityOf,
    });
    expect(out.size).toBe(1);
  });

  it('does NOT mutate the current or previous inputs', () => {
    const currentFeat = f(1, 'A', 0, 100);
    const previousFeat = f(2, 'B', 200, 300);
    const current = new Map<string, Feature>([['a', currentFeat]]);
    const previous = new Map<string, Feature>([['B', previousFeat]]);
    const currentSnapshot = [...current.entries()];
    const previousSnapshot = [...previous.entries()];
    mergeWithTransitionContinuity({
      current,
      previous,
      activeRange: { start: 0, end: 1000 },
      identityOf,
    });
    expect([...current.entries()]).toEqual(currentSnapshot);
    expect([...previous.entries()]).toEqual(previousSnapshot);
  });

  it('idempotent under Strict Mode double-invoke (same inputs => structurally-equal outputs)', () => {
    const inputs: TileTransitionInputs = {
      current: new Map([['a', f(1, 'A', 0, 100)]]),
      previous: new Map([
        ['B', f(2, 'B', 200, 300)],
        ['C', f(3, 'C', 5000, 6000)],
      ]),
      activeRange: { start: 0, end: 1000 },
      identityOf,
    };
    const out1 = mergeWithTransitionContinuity(inputs);
    const out2 = mergeWithTransitionContinuity(inputs);
    expect(out1).not.toBe(out2);
    expect([...out1.keys()].sort()).toEqual([...out2.keys()].sort());
    for (const [k, v] of out1) {
      expect(out2.get(k)).toEqual(v);
    }
  });
});

describe('buildRetainedIdentityMap', () => {
  it('keys features by identity', () => {
    const features = [f(1, 'A', 0, 100), f(2, 'B', 200, 300)];
    const out = buildRetainedIdentityMap(features, null, identityOf);
    expect(out.size).toBe(2);
    expect(out.get('A')?.id).toBe(1);
    expect(out.get('B')?.id).toBe(2);
  });

  it('drops features without identity', () => {
    const nameless = f(2, '', 200, 300);
    delete (nameless.qualifiers as { ID?: string }).ID;
    const features = [f(1, 'A', 0, 100), nameless];
    const out = buildRetainedIdentityMap(features, null, identityOf);
    expect(out.size).toBe(1);
    expect(out.has('A')).toBe(true);
  });

  it('drops features outside activeRange', () => {
    const features = [f(1, 'A', 0, 100), f(2, 'B', 500, 600), f(3, 'C', 5000, 6000)];
    const out = buildRetainedIdentityMap(features, { start: 0, end: 1000 }, identityOf);
    expect(out.size).toBe(2);
    expect(out.has('A')).toBe(true);
    expect(out.has('B')).toBe(true);
    expect(out.has('C')).toBe(false);
  });

  it('last write wins for duplicate identities', () => {
    const earlier = f(1, 'A', 0, 100, { displayName: 'EARLIER' });
    const later = f(2, 'A', 50, 150, { displayName: 'LATER' });
    const out = buildRetainedIdentityMap([earlier, later], null, identityOf);
    expect(out.size).toBe(1);
    expect(out.get('A')?.displayName).toBe('LATER');
  });

  it('produces a new Map (does not return mutated input)', () => {
    const features = [f(1, 'A', 0, 100)];
    const out1 = buildRetainedIdentityMap(features, null, identityOf);
    const out2 = buildRetainedIdentityMap(features, null, identityOf);
    expect(out1).not.toBe(out2);
    expect([...out1.entries()]).toEqual([...out2.entries()]);
  });
});
