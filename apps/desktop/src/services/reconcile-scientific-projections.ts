import { parseWorkspaceIdentity } from '@waypoint/domain-services';
import { resolveWorkspaceScope } from '../db/workspace-catalog';
import { platform } from '../platform';
import { isBrowserOnly } from '../utils/environment';

export async function reconcileAcceptedScientificProjections(
  workspaceRoot: string,
  mutationToken?: string
): Promise<{ paths: readonly string[]; resourceIds: readonly string[] }> {
  if (isBrowserOnly()) return { paths: [], resourceIds: [] };
  const scope = await resolveWorkspaceScope(workspaceRoot);
  if (scope === null) return { paths: [], resourceIds: [] };
  const result = await platform().scientificObjects.reconcileProjections({
    workspaceRoot,
    request: { workspace: parseWorkspaceIdentity(scope) },
    ...(mutationToken ? { mutationToken } : {}),
  });
  return {
    paths: result.projectedPaths.map((path) => `${workspaceRoot.replace(/\/+$/u, '')}/${path}`),
    resourceIds: result.acceptedResourceIds ?? [],
  };
}
