// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { Feature } from '@waypoint/genome-renderer';
import {
  INITIAL_TRANSITION_STATE,
  type TransitionState,
  transitionReducer,
} from './annotation-transition-state';

function feat(id: number, identity: string): Feature {
  return {
    id,
    type: 'mRNA',
    start: 0,
    end: 100,
    direction: 'forward',
    qualifiers: { ID: identity },
  } as Feature;
}

describe('transitionReducer — hover-tooltip flicker regression guard', () => {
  it('returns SAME state reference when dispatched content-equal new map instances (the bug fix)', () => {
    const mapA1 = new Map<string, Feature>([['A', feat(1, 'A')]]);
    const lanesA1 = new Map<number, number>([[1, 0]]);
    const stateAfterFirst = transitionReducer(INITIAL_TRANSITION_STATE, {
      type: 'tile-commit',
      featuresByIdentity: mapA1,
      laneAssignments: lanesA1,
    });

    const mapA2 = new Map<string, Feature>([['A', feat(99, 'A')]]);
    const lanesA2 = new Map<number, number>([[1, 0]]);
    const stateAfterSecond = transitionReducer(stateAfterFirst, {
      type: 'tile-commit',
      featuresByIdentity: mapA2,
      laneAssignments: lanesA2,
    });

    expect(stateAfterFirst).toBeTruthy();
    expect(stateAfterFirst).not.toBe(INITIAL_TRANSITION_STATE);
    expect(stateAfterSecond).toBe(stateAfterFirst);
  });

  it('returns NEW state when the identity set changes (toggle expanded)', () => {
    const initialMap = new Map<string, Feature>([['A', feat(1, 'A')]]);
    const initialLanes = new Map<number, number>([[1, 0]]);
    const s1 = transitionReducer(INITIAL_TRANSITION_STATE, {
      type: 'tile-commit',
      featuresByIdentity: initialMap,
      laneAssignments: initialLanes,
    });

    const expandedMap = new Map<string, Feature>([
      ['A', feat(1, 'A')],
      ['B', feat(2, 'B')],
    ]);
    const expandedLanes = new Map<number, number>([
      [1, 0],
      [2, 1],
    ]);
    const s2 = transitionReducer(s1, {
      type: 'tile-commit',
      featuresByIdentity: expandedMap,
      laneAssignments: expandedLanes,
    });

    expect(s2).not.toBe(s1);
    expect(s2.previousAnnotationFeatures.size).toBe(2);
  });

  it('returns NEW state when a lane shifts (same identities, different lane numbers)', () => {
    const features = new Map<string, Feature>([['A', feat(1, 'A')]]);
    const lanesV1 = new Map<number, number>([[1, 0]]);
    const lanesV2 = new Map<number, number>([[1, 5]]);
    const s1 = transitionReducer(INITIAL_TRANSITION_STATE, {
      type: 'tile-commit',
      featuresByIdentity: features,
      laneAssignments: lanesV1,
    });
    const s2 = transitionReducer(s1, {
      type: 'tile-commit',
      featuresByIdentity: new Map(features),
      laneAssignments: lanesV2,
    });
    expect(s2).not.toBe(s1);
    expect(s2.previousLaneAssignments.get(1)).toBe(5);
  });

  it('filter-reset returns SAME state when already empty (no-op short-circuit)', () => {
    const s = transitionReducer(INITIAL_TRANSITION_STATE, { type: 'filter-reset' });
    expect(s).toBe(INITIAL_TRANSITION_STATE);
  });

  it('workspace-change returns SAME state when already empty (no-op short-circuit)', () => {
    const s = transitionReducer(INITIAL_TRANSITION_STATE, { type: 'workspace-change' });
    expect(s).toBe(INITIAL_TRANSITION_STATE);
  });

  it('filter-reset clears non-empty state', () => {
    const populated = transitionReducer(INITIAL_TRANSITION_STATE, {
      type: 'tile-commit',
      featuresByIdentity: new Map([['A', feat(1, 'A')]]),
      laneAssignments: new Map([[1, 0]]),
    });
    const reset = transitionReducer(populated, { type: 'filter-reset' });
    expect(reset.previousAnnotationFeatures.size).toBe(0);
    expect(reset.previousLaneAssignments.size).toBe(0);
  });

  it('many sequential tile-commits with content-equal input converge to a stable reference', () => {
    let state: TransitionState = INITIAL_TRANSITION_STATE;
    let priorState: TransitionState | null = null;
    for (let i = 0; i < 50; i++) {
      const features = new Map<string, Feature>([
        ['A', feat(1, 'A')],
        ['B', feat(2, 'B')],
        ['C', feat(3, 'C')],
      ]);
      const lanes = new Map<number, number>([
        [1, 0],
        [2, 0],
        [3, 1],
      ]);
      const next = transitionReducer(state, {
        type: 'tile-commit',
        featuresByIdentity: features,
        laneAssignments: lanes,
      });
      if (priorState !== null && i > 0) {
        expect(next).toBe(priorState);
      }
      priorState = next;
      state = next;
    }
    expect(state).toBeTruthy();
    expect(state).not.toBe(INITIAL_TRANSITION_STATE);
  });
});
