import { scientificArtifactPort } from '../../services/scientific-artifact-port';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { reconcileEntityFile } from '../../db/entity-substrate/adapter';
import { limsEntityArtifactAdapter } from '../../db/entity-substrate/lims-entity-adapter';
import {
  bindCatalogEntityToFile,
  registerCatalogEntity,
  resolveWorkspaceId,
} from '../../db/workspace-catalog';
import { beginWorkflowAction } from '../../lib/workflow-telemetry';
import { platform } from '../../platform';
import { gitCommitPaths, gitStatus, isGitRepo } from '../workspace/public/git';
import { emitLimsRegistrationChanged } from './events';
import { getLimsSchemas } from './operations';
import { createEntityArtifactOwner } from './entity-artifact-owner';
export * from './entity-artifact-owner';
const owner = createEntityArtifactOwner({
  scientific: scientificArtifactPort,
  withRendererWorkspaceMutation,
  queryLimsEntities: (input) => platform().lims.queryEntities(input),
  beginWorkflowAction,
  io: platform,
  gitCommitPaths,
  gitStatus,
  isGitRepo,
  emitLimsRegistrationChanged,
  getLimsSchemas,
  projectArtifact: async (artifact, content, artifactPath, input) => {
    const id = artifact.id;
    const workspaceId = await resolveWorkspaceId(input.workspaceRoot);
    const stat = await platform().fs.stat(artifactPath);
    const catalog = await registerCatalogEntity({
      id,
      type: 'file',
      name: artifact.name,
      locator: `file://${artifactPath}`,
      storageType: 'file',
      workspaceRoot: input.workspaceRoot,
    });
    if (catalog.id !== id || catalog.workspace_id !== workspaceId)
      throw new Error('Registry record file is bound to another catalog identity.');
    const projection = await reconcileEntityFile(
      limsEntityArtifactAdapter,
      content,
      artifactPath,
      stat.mtime,
      { workspaceRoot: input.workspaceRoot, workspaceId, mutationToken: input.mutationToken }
    );
    if (projection.outcome !== 'created' && projection.outcome !== 'in-sync') {
      throw new Error(`Unexpected projection outcome: ${projection.outcome}`);
    }
    if (artifact.relationships.length)
      await limsEntityArtifactAdapter.reconcileRelationships?.(artifact, id, artifactPath, {
        workspaceRoot: input.workspaceRoot,
        workspaceId,
        mutationToken: input.mutationToken,
      });

    await bindCatalogEntityToFile({
      entityId: id,
      path: artifactPath,
      fileKind: 'waypoint-entity',
      workspaceRoot: input.workspaceRoot,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime,
      mutationToken: input.mutationToken,
    });
  },
});
export const {
  resolveEntityArtifactSchemaFields,
  resolveEntityArtifactSchemaSnapshot,
  recordEntityArtifact,
} = owner;
