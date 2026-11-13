import { toolFailure, type ToolStateChange } from '../../agent-bridge/public/tool-result';

                                                                                   
export function indexedViewToolFailure<Code extends string>(
  failure: { error: Code; message: string },
  stateChanged: ToolStateChange = false
) {
  return {
    ...toolFailure({
      code: failure.error,
      error: failure.message,
      retriable: false,
      stateChanged,
      partialEffects: [],
    }),
    code: failure.error,
    message: failure.message,
  };
}
