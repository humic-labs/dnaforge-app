export const WORKSPACE_RECONCILED_EVENT = 'waypoint:workspace-reconciled';

export interface WorkspaceReconciledEventDetail {
  path: string | null;
  workspaceRoot: string;
}

export function notifyWorkspaceReconciled(workspaceRoot: string, path: string | null = null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<WorkspaceReconciledEventDetail>(WORKSPACE_RECONCILED_EVENT, {
      detail: { path, workspaceRoot },
    })
  );
}
