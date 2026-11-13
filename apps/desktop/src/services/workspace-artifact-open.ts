import {
  applyAcceptedWorkspaceArtifactRepair,
  planWorkspaceArtifactRepair,
  resolveArtifactFile,
  type ResolvedWorkspaceArtifactSnapshot,
} from '../db/workspace-artifacts';
import { readStableWorkspaceGeneration } from './workspace-sync-renderer-generation';
import { withRendererWorkspaceMutation } from './workspace-mutation-transaction';
import { reconcileEntitySnapshot } from '../db/entity-substrate/adapter';
import { notebookEntityAdapter } from '../db/entity-substrate/notebook-adapter';
import { resolveWorkspaceId, resolveWorkspaceScope } from '../db/workspace-catalog';
import {
  isNotebookPackageMetaPath,
  notebookPackagePaths,
  NOTEBOOK_PACKAGE_SCHEMA,
  type NotebookPackageDocument,
} from '../db/notebook-package';
import { NotebookExternalConflictError } from '../db/notebook-package-migration';
import { reportEntityReconcileConflicts } from './workspace-reconcile-report';

export async function withWorkspaceArtifactOpen<T>(input: {
  path: string;
  workspaceRoot: string | null;
  notebookConflictResolution?: 'use-file';
  consume: (resolved: ResolvedWorkspaceArtifactSnapshot, mutationToken?: string) => Promise<T>;
}): Promise<T> {
  return readStableWorkspaceGeneration(input.workspaceRoot, () =>
    withRendererWorkspaceMutation(
      input.workspaceRoot,
      async (mutationToken) => {
        const repairPlan = await planWorkspaceArtifactRepair({
          path: input.path,
          workspaceRoot: input.workspaceRoot,
          mutationToken,
        });
        if (repairPlan.kind === 'conflict') {
          throw new Error(`Artifact repair conflict: ${repairPlan.reason}`);
        }
        let resolved: ResolvedWorkspaceArtifactSnapshot;
        if (repairPlan.kind === 'file-binding-repair' || repairPlan.kind === 'catalog-recovery') {
          const repaired = await applyAcceptedWorkspaceArtifactRepair(repairPlan, mutationToken);
          const snapshot = await resolveArtifactFile({
            path: input.path,
            workspaceRoot: input.workspaceRoot,
            mutationToken,
          });
          resolved = { ...snapshot, repaired: repaired.repaired };
        } else {
          resolved = await resolveArtifactFile({
            path: input.path,
            workspaceRoot: input.workspaceRoot,
            mutationToken,
          });
        }
        if (resolved.artifact.kind === 'notebook') {
          const artifact = resolved.artifact;
          const document: NotebookPackageDocument = {
            ...artifact.raw,
            schema: NOTEBOOK_PACKAGE_SCHEMA,
            kind: 'notebook',
            id: artifact.id,
            title: artifact.title,
            content: artifact.content,
            updatedAt:
              typeof artifact.raw.updatedAt === 'string'
                ? artifact.raw.updatedAt
                : '1970-01-01T00:00:00.000Z',
            storage: { type: 'database', table: 'pages', id: artifact.id },
          };
          const sourcePath =
            input.path.toLowerCase().endsWith('.wpnote.json') ||
            isNotebookPackageMetaPath(input.path)
              ? input.path
              : notebookPackagePaths(input.path).metaPath;
          const [workspaceId, workspaceScope] = await Promise.all([
            resolveWorkspaceId(input.workspaceRoot),
            resolveWorkspaceScope(input.workspaceRoot),
          ]);
          const result = await reconcileEntitySnapshot(
            notebookEntityAdapter,
            {
              document,
              fileMtimeMs: Date.parse(document.updatedAt) || 0,
            },
            sourcePath,
            {
              workspaceRoot: input.workspaceRoot ?? null,
              workspaceId,
              workspaceScope,
              mutationToken,
            },
            { conflictResolution: input.notebookConflictResolution }
          );
          if (result.outcome === 'conflict') {
            reportEntityReconcileConflicts(input.workspaceRoot ?? sourcePath, {
              scanned: 1,
              reconciled: 0,
              conflicts: 1,
              errors: [],
              conflictDetails: [
                {
                  id: result.id,
                  path: sourcePath,
                  reason: result.conflictReason ?? 'unknown-base',
                },
              ],
            });
            throw new NotebookExternalConflictError(sourcePath);
          }
        }
        return input.consume(resolved, mutationToken);
      },
      undefined,
      { waitForAvailability: true }
    )
  );
}
