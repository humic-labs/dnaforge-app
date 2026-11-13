import type { Feature } from '@waypoint/genome-renderer';

export interface TransitionState {
  previousAnnotationFeatures: ReadonlyMap<string, Feature>;
  previousLaneAssignments: ReadonlyMap<number, number>;
}

export type TransitionAction =
  | {
      type: 'tile-commit';
      featuresByIdentity: ReadonlyMap<string, Feature>;
      laneAssignments: ReadonlyMap<number, number>;
    }
  | { type: 'filter-reset' }
  | { type: 'workspace-change' };

export const INITIAL_TRANSITION_STATE: TransitionState = {
  previousAnnotationFeatures: new Map(),
  previousLaneAssignments: new Map(),
};

function transitionFeatureMapsEqual(
  a: ReadonlyMap<string, unknown>,
  b: ReadonlyMap<string, unknown>
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const k of a.keys()) if (!b.has(k)) return false;
  return true;
}

function transitionLaneMapsEqual(
  a: ReadonlyMap<number, number>,
  b: ReadonlyMap<number, number>
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

export function transitionReducer(
  state: TransitionState,
  action: TransitionAction
): TransitionState {
  switch (action.type) {
    case 'tile-commit': {
      const featuresUnchanged = transitionFeatureMapsEqual(
        state.previousAnnotationFeatures,
        action.featuresByIdentity
      );
      const lanesUnchanged = transitionLaneMapsEqual(
        state.previousLaneAssignments,
        action.laneAssignments
      );
      if (featuresUnchanged && lanesUnchanged) return state;
      return {
        previousAnnotationFeatures: featuresUnchanged
          ? state.previousAnnotationFeatures
          : action.featuresByIdentity,
        previousLaneAssignments: lanesUnchanged
          ? state.previousLaneAssignments
          : action.laneAssignments,
      };
    }
    case 'filter-reset':
    case 'workspace-change': {
      if (state.previousAnnotationFeatures.size === 0 && state.previousLaneAssignments.size === 0) {
        return state;
      }
      return INITIAL_TRANSITION_STATE;
    }
  }
}
