import {
  toolFailure,
  type ToolOperationResult,
  type ToolPartialEffect,
  type ToolStateChange,
  type ToolFailure,
} from '../../agent-bridge/public/tool-result';

                                                                             
export class DesignToolEffects {
  stateChanged: ToolStateChange = false;
  readonly partialEffects: ToolPartialEffect[] = [];
  attemptedMutation(): void {
    this.stateChanged = 'unknown';
  }
  unchanged(): void {
    this.stateChanged = false;
  }
  changed(effect: ToolPartialEffect): void {
    this.stateChanged = true;
    this.partialEffects.push(effect);
  }
}

                                                                          
export function designToolFailure<T extends Record<string, unknown>>(
  fallbackCode: string,
  data: T,
  effects: DesignToolEffects = new DesignToolEffects()
) {
  const message =
    typeof data.error === 'string'
      ? data.error
      : typeof data.message === 'string'
        ? data.message
        : 'The design operation was rejected.';
  return {
    ...data,
    ...toolFailure({
      code: typeof data.code === 'string' ? data.code : fallbackCode,
      error: message || 'The design operation was rejected.',
      retriable: data.retriable === true,
      stateChanged: effects.stateChanged,
      partialEffects: effects.partialEffects,
      details: data,
    }),
  };
}

export async function runDesignTool<T extends ToolOperationResult>(
  code: string,
  operation: (effects: DesignToolEffects) => Promise<T>
): Promise<T | ToolFailure> {
  const effects = new DesignToolEffects();
  try {
    return await operation(effects);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return designToolFailure(
      code,
      { error: error instanceof Error ? error.message : String(error) },
      effects
    );
  }
}
