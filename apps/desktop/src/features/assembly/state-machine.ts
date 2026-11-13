import type { AssemblyState } from '../design/public/types';
import type { AssemblyCommand } from './commands';
import { isEditorCommand } from './commands';
import { err, ok, type RefusalReason, type Result } from './refusals';

export type AssemblySideEffect = { type: 'abort_pending' } | { type: 'validate' } | { type: 'run' };

export type AssemblyTransition = {
  next: AssemblyState;
  sideEffects: readonly AssemblySideEffect[];
};

export type AssemblyTransitionContext = {
  pendingDispatchId?: string | null;
};

export const ASSEMBLY_STATES = [
  'preflight',
  'drafting',
  'validating',
  'ready',
  'running',
  'assembled',
] as const satisfies readonly AssemblyState[];

export function transitionAssemblyState(
  currentState: AssemblyState,
  command: Pick<AssemblyCommand, 'type'>,
  context: AssemblyTransitionContext = {}
): Result<AssemblyTransition, RefusalReason> {
  try {
    if (!ASSEMBLY_STATES.includes(currentState)) {
      return err({
        kind: 'state_conflict',
        message: `Unknown assembly state: ${currentState}`,
        currentState,
      });
    }

    if (command.type === 'reset') {
      return ok({
        next: 'preflight',
        sideEffects: isTransient(currentState) ? [{ type: 'abort_pending' }] : [],
      });
    }

    if (isEditorCommand(command as AssemblyCommand)) {
      return ok({
        next: 'drafting',
        sideEffects: isTransient(currentState) ? [{ type: 'abort_pending' }] : [],
      });
    }

    if (command.type === 'validate') {
      if (context.pendingDispatchId || currentState === 'validating') {
        return err({
          kind: 'state_conflict',
          message: 'Validation is already in progress for this design.',
          currentState,
        });
      }

      if (currentState !== 'drafting' && currentState !== 'ready') {
        return err({
          kind: 'state_conflict',
          message: 'Assembly can only be validated from drafting or ready.',
          currentState,
        });
      }

      return ok({ next: 'validating', sideEffects: [{ type: 'validate' }] });
    }

    if (command.type === 'run') {
      if (context.pendingDispatchId || currentState === 'running') {
        return err({
          kind: 'state_conflict',
          message: 'Assembly run is already in progress for this design.',
          currentState,
        });
      }

      if (currentState !== 'ready') {
        return err({
          kind: 'state_conflict',
          message: 'Assembly can only run from ready.',
          currentState,
        });
      }

      return ok({ next: 'running', sideEffects: [{ type: 'run' }] });
    }

    return err({
      kind: 'bad_input',
      message: `Unknown assembly command: ${command.type}`,
      field: 'type',
    });
  } catch (error) {
    return err({
      kind: 'state_conflict',
      message: error instanceof Error ? error.message : 'State transition failed.',
      currentState,
    });
  }
}

function isTransient(state: AssemblyState): boolean {
  return state === 'validating' || state === 'running';
}
