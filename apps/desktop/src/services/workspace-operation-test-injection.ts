import { stripTrailingSep } from '../shared/path-boundary';

export type WorkspaceOperationStage = 'reconstruction' | 'display';

export class WorkspaceOperationInjectedFailure extends Error {
  override readonly name = 'WorkspaceOperationInjectedFailure';
}

interface ArmedFailure {
  stage: WorkspaceOperationStage;
  workspaceRoot: string | null;
  pending: boolean;
  hits: number;
}

let armed: ArmedFailure | null = null;

export function armWorkspaceOperationFailure(input: {
  stage: WorkspaceOperationStage;
  workspaceRoot?: string | null;
}): void {
  if (armed?.pending) throw new Error('A workspace operation failure is already armed.');
  armed = {
    stage: input.stage,
    workspaceRoot: input.workspaceRoot ? stripTrailingSep(input.workspaceRoot) : null,
    pending: true,
    hits: 0,
  };
}

export function disarmWorkspaceOperationFailure(): void {
  armed = null;
}

export function workspaceOperationFailureState(): {
  stage: WorkspaceOperationStage;
  workspaceRoot: string | null;
  pending: boolean;
  hits: number;
} | null {
  return armed ? { ...armed } : null;
}

export function throwInjectedWorkspaceOperationFailure(
  stage: WorkspaceOperationStage,
  workspaceRoot: string
): void {
  if (!armed || armed.stage !== stage || !armed.pending) return;
  if (armed.workspaceRoot && armed.workspaceRoot !== stripTrailingSep(workspaceRoot)) return;
  armed.pending = false;
  armed.hits += 1;
  throw new WorkspaceOperationInjectedFailure(`Injected workspace ${stage} failure`);
}
