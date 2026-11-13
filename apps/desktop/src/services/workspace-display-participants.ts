import { throwInjectedWorkspaceOperationFailure } from './workspace-operation-test-injection';

export interface WorkspaceDisplayDeliveryContext {
  workspaceRoot: string;
  operationId: string;

  assertCurrent(): void;
}

export type WorkspaceDisplayParticipant = (
  context: WorkspaceDisplayDeliveryContext
) => Promise<void>;

export interface WorkspaceDisplayDeliveryReport {
  participants: number;
  errors: unknown[];
}

const participants = new Set<WorkspaceDisplayParticipant>();

export function registerWorkspaceDisplayParticipant(
  participant: WorkspaceDisplayParticipant
): () => void {
  participants.add(participant);
  return () => {
    participants.delete(participant);
  };
}

export function workspaceDisplayParticipantCount(): number {
  return participants.size;
}

export async function deliverWorkspaceDisplay(
  context: WorkspaceDisplayDeliveryContext
): Promise<WorkspaceDisplayDeliveryReport> {
  const snapshot = [...participants];
  const settled = await Promise.allSettled(
    snapshot.map((participant) => Promise.resolve().then(() => participant(context)))
  );
  return {
    participants: snapshot.length,
    errors: settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
  };
}

export type WorkspaceDisplayOutcome =
  | { state: 'completed'; participants: number }
  | { state: 'failed'; participants: number; errors: unknown[] };

export async function deliverWorkspaceDisplayOutcome(
  context: WorkspaceDisplayDeliveryContext
): Promise<WorkspaceDisplayOutcome> {
  try {
    throwInjectedWorkspaceOperationFailure('display', context.workspaceRoot);
  } catch (error) {
    return { state: 'failed', participants: 0, errors: [error] };
  }
  const report = await deliverWorkspaceDisplay(context);
  return report.errors.length === 0
    ? { state: 'completed', participants: report.participants }
    : { state: 'failed', participants: report.participants, errors: report.errors };
}
