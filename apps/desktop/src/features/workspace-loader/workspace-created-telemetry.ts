import { trackRendererEvent } from '../../lib/analytics';
import { platform } from '../../platform';
import type {
  CreateEmptyWorkspaceRequest,
  CreateEmptyWorkspaceResult,
} from '../../shared/workspace-git-types';

export function trackWorkspaceCreated(): void {
  try {
    trackRendererEvent('workspace_created', { feature_area: 'workspace' });
  } catch {}
}

export async function createTrackedEmptyWorkspace(
  request: CreateEmptyWorkspaceRequest
): Promise<CreateEmptyWorkspaceResult> {
  const created = await platform().workspace.createEmptyWorkspace(request);
  trackWorkspaceCreated();
  return created;
}
