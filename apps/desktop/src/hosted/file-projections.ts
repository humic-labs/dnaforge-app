import { registerLimsEntityArtifactAdapter } from '../db/entity-substrate/lims-entity-adapter';
import { reconcileWorkspaceEntities } from '../db/entity-substrate/reconcile-entities';
import { reconcilePrimerArtifactsInWorkspace } from '../features/primers/primer-artifact-service';
import { emitRegistryChanged } from '../shared/registry-events';
import { hostedWorkspaceSessionController } from './controller';
import { hostedAbsolutePath, hostedWorkspaceRoot } from './paths';
import { resolveWorkspaceId } from '../db/workspace-catalog';

export interface HostedFileProjectionResult {
  primers: number;
  entities: number;
  errors: Array<{ path: string; message: string }>;
}

export async function rebuildHostedFileProjections(
  workspaceId: string,
  relativePaths: readonly string[]
): Promise<HostedFileProjectionResult> {
  const root = hostedWorkspaceRoot(workspaceId);
  const absolute = (suffix: string) =>
    relativePaths
      .filter((path) => path.toLowerCase().endsWith(suffix))
      .map((path) => hostedAbsolutePath(workspaceId, path));
  const primerPaths = absolute('.primer.json');
  const entityPaths = absolute('.entity.json');
  const result: HostedFileProjectionResult = { primers: 0, entities: 0, errors: [] };
  if (primerPaths.length > 0) {
    await resolveWorkspaceId(root);
    const primers = await reconcilePrimerArtifactsInWorkspace(root, {
      candidatePaths: primerPaths,
    });
    result.primers = primers.reconciled;
    result.errors.push(...primers.errors);
  }
  if (entityPaths.length > 0) {
    registerLimsEntityArtifactAdapter();
    const entities = await reconcileWorkspaceEntities(root, { candidatePaths: entityPaths });
    result.entities = entities.reconciled;
    result.errors.push(...entities.errors);
  }
  if (result.primers > 0 || result.entities > 0) emitRegistryChanged();
  return result;
}

export function startHostedFileProjections(): () => void {
  const rebuilt = new Set<string>();
  const rebuild = () => {
    const { principal, snapshot } = hostedWorkspaceSessionController.getState();
    if (!principal?.id || !snapshot) return;
    const key = `${principal.id}:${snapshot.workspaceId}`;
    if (rebuilt.has(key)) return;
    rebuilt.add(key);
    void rebuildHostedFileProjections(
      snapshot.workspaceId,
      snapshot.files.map((file) => file.path)
    ).then(
      ({ errors }) => {
        if (errors.length > 0) {
          console.warn('[Hosted projections] Some project records could not be rebuilt:', errors);
        }
      },
      (error: unknown) => {
        rebuilt.delete(key);
        console.warn('[Hosted projections] Project records could not be rebuilt:', error);
      }
    );
  };
  rebuild();
  return hostedWorkspaceSessionController.subscribe(rebuild);
}
