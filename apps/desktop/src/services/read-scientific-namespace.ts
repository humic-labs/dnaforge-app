import { parseWorkspaceIdentity, type ScientificWorkspaceCatalog } from '@waypoint/domain-services';
import { resolveWorkspaceScope } from '../db/workspace-catalog';
import { platform } from '../platform';
import { isBrowserOnly, isHostedBrowserRuntime } from '../utils/environment';

export async function readScientificCatalog(
  workspaceRoot: string
): Promise<ScientificWorkspaceCatalog | null> {
  if (isBrowserOnly() || isHostedBrowserRuntime()) return null;
  const scope = await resolveWorkspaceScope(workspaceRoot);
  if (!scope) throw new Error('The scientific object project is unavailable.');
  const catalog = await platform().scientificObjects.catalog({
    workspaceRoot,
    request: { workspace: parseWorkspaceIdentity(scope) },
  });
  return catalog;
}

export async function readScientificNamespace(
  workspaceRoot: string
): Promise<(ScientificWorkspaceCatalog & { head: string }) | null> {
  const catalog = await readScientificCatalog(workspaceRoot);
  return !catalog || catalog.head === null ? null : { ...catalog, head: catalog.head };
}
