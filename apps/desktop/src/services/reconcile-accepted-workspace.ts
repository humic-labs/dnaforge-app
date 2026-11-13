import { stripTrailingSep } from '../shared/path-boundary';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { deliverWorkspaceDisplayOutcome } from './workspace-display-participants';
import { throwInjectedWorkspaceOperationFailure } from './workspace-operation-test-injection';
import { runTrackedWorkspaceReconcile } from './workspace-reconcile-lifecycle';
import { notifyWorkspaceReconciled } from './workspace-reconciled-event';
import { reconcileAcceptedScientificProjections } from './reconcile-scientific-projections';

export async function reconcileAcceptedWorkspaceAfterFilesChanged(input: {
  workspaceRoot: string;
  mutationToken?: string;
  assertCurrent?(): void;

  nativeProjectionComplete?: boolean;
}): Promise<void> {
  const workspaceRoot = stripTrailingSep(input.workspaceRoot);
  const operationId = `scientific-reconcile:${crypto.randomUUID()}`;
  const assertCurrent = () => input.assertCurrent?.();
  await runTrackedWorkspaceReconcile(
    workspaceRoot,
    async () => {
      assertCurrent();
      throwInjectedWorkspaceOperationFailure('reconstruction', workspaceRoot);
      if (!input.nativeProjectionComplete)
        await reconcileAcceptedScientificProjections(workspaceRoot, input.mutationToken);
      assertCurrent();
    },
    { ordered: !input.mutationToken }
  );
  useWorkspaceStore.getState().bumpFileTreeRefresh();
  notifyWorkspaceReconciled(workspaceRoot);
  const display = await deliverWorkspaceDisplayOutcome({
    workspaceRoot,
    operationId,
    assertCurrent,
  });
  assertCurrent();
  if (display.state === 'failed') {
    console.warn(
      `[WorkspaceOperations] ${display.errors.length} display participant(s) could not refresh after ${operationId}; durable records are complete:`,
      display.errors
    );
  }
}
