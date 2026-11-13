// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { resolveFirstProjectEnsure, type FirstProjectEnsurePhase } from './first-project';

describe('resolveFirstProjectEnsure', () => {
  it('creates once while repeated renders still see the stale pre-creation library', () => {
    let decision = resolveFirstProjectEnsure('idle', false);
    expect(decision).toEqual({ phase: 'creating', action: 'create' });

    let phase: FirstProjectEnsurePhase = 'awaiting-library';
    for (let render = 0; render < 69; render += 1) {
      decision = resolveFirstProjectEnsure(phase, false);
      expect(decision).toEqual({ phase: 'awaiting-library', action: 'wait' });
      phase = decision.phase;
    }

    expect(resolveFirstProjectEnsure(phase, true)).toEqual({ phase: 'idle', action: 'mount' });
  });

  it('permits a replacement only after every active project is actually gone', () => {
    const observed = resolveFirstProjectEnsure('awaiting-library', true);
    expect(observed.phase).toBe('idle');
    expect(resolveFirstProjectEnsure(observed.phase, false)).toEqual({
      phase: 'creating',
      action: 'create',
    });
  });
});
