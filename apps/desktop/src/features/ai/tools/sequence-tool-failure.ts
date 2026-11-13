import { toolFailure } from '../../agent-bridge/public/tool-result';

                                                                                         
export function selectionToolFailure<T extends { error: string; message: string }>(failure: T) {
  return {
    ...failure,
    ...toolFailure({
      code: failure.error,
      error: failure.error,
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    }),
  };
}

export function sequenceReadFailure(code: string, error: string) {
  return toolFailure({ code, error, retriable: false, stateChanged: false, partialEffects: [] });
}
