import {
  toolFailure,
  toolSuccess,
  type ToolPartialEffect,
  type ToolStateChange,
} from '../../agent-bridge/public/tool-result';

                                                                                                 
export class PaperToolEffects {
  stateChanged: ToolStateChange = false;
  readonly partialEffects: ToolPartialEffect[] = [];
  attemptedMutation(): void {
    this.stateChanged = 'unknown';
  }
  changed(effect: ToolPartialEffect): void {
    this.stateChanged = true;
    this.partialEffects.push(effect);
  }
}

export async function runPaperTool<T extends Record<string, unknown>>(
  code: string,
  operation: (effects: PaperToolEffects) => Promise<T>
) {
  const effects = new PaperToolEffects();
  try {
    return toolSuccess(await operation(effects));
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return toolFailure({
      code,
      error: (error instanceof Error ? error.message : String(error)) || 'Paper operation failed.',
      retriable: false,
      stateChanged: effects.stateChanged,
      partialEffects: effects.partialEffects,
    });
  }
}
