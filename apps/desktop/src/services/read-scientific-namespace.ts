import { parseWorkspaceIdentity, type ScientificWorkspaceCatalog } from '@waypoint/domain-services';
import { resolveWorkspaceScope } from '../db/workspace-catalog';
import { platform } from '../platform';
import { isBrowserOnly, isHostedBrowserRuntime } from '../utils/environment';

export async function readScientificNamespace(
  workspaceRoot: string
): Promise<(ScientificWorkspaceCatalog & { head: string }) | null> {
  if (isBrowserOnly() || isHostedBrowserRuntime()) return null;
  const scope = await resolveWorkspaceScope(workspaceRoot);
  if (!scope) throw new Error('The scientific object project is unavailable.');
  const catalog = await platform().scientificObjects.catalog({
    workspaceRoot,
    request: { workspace: parseWorkspaceIdentity(scope) },
  });
  return catalog.head === null ? null : { ...catalog, head: catalog.head };
}
