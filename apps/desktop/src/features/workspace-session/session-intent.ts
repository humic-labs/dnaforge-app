import type { WorkspaceSessionController } from '@waypoint/domain-services';

export function captureSessionIntent(
  controller: Pick<WorkspaceSessionController, 'getState'>
): () => void {
  const principal = controller.getState().principal;
  if (!principal) throw new Error('Sign in before changing a hosted project.');
  return () => {
    if (controller.getState().principal !== principal) {
      throw new Error('The signed-in account or session changed. Retry from the current project.');
    }
  };
}
