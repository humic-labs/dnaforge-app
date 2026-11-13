import { readSequencePackageHistoryIndex } from '../../db/sequence-package-history-io';
import { sequencePackagePaths } from '../../db/sequence-package';
import { platform } from '../../platform';
import { pathRelativeToBoundary } from '../../shared/path-boundary';
import type {
  SequenceRestoreApplyRequest,
  SequenceRestoreApplyResult,
} from '../../shared/sequence-package-revision';
import { assertWorkspaceEditorsSettled } from '../../services/workspace-editor-mutation-state';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { runWorkspaceReconcileOperation } from '../../services/workspace-operations';
import { useCanvasStore } from '../canvas/public/store';
import { gitCommitPaths, gitRepoRoot } from '../workspace/public/git';
import { useSequenceStore } from './public/store';

export interface SequenceRestoreDeliveredResult extends SequenceRestoreApplyResult {
  delivery: {
    registry: 'completed';
    git: 'committed' | 'not-a-repository' | 'failed' | 'unverified-replay';
    gitError?: string;
  };
}

export async function applySequencePackageRestoreWithDelivery(
  request: SequenceRestoreApplyRequest
): Promise<SequenceRestoreDeliveredResult> {
  const assertEditorsSettled = () => {
    const sequenceTabIds = Object.values(useCanvasStore.getState().panels).flatMap((panel) =>
      panel.tabs.flatMap((tab) =>
        tab.type === 'sequence' &&
        ((tab.sequenceDocument?.kind === 'managed-sequence' &&
          tab.sequenceDocument.packageId === request.packageId) ||
          tab.entityId === request.packageId)
          ? [tab.entityId]
          : []
      )
    );
    assertWorkspaceEditorsSettled({
      workspaceRoot: request.packageRoot,
      affectedEntityIds: [request.packageId, ...sequenceTabIds],
    });
    if (
      [request.packageId, ...sequenceTabIds].some((id) => useSequenceStore.getState().isDirty(id))
    ) {
      throw new Error('Save or discard current sequence edits before Restore.');
    }
  };

  assertEditorsSettled();
  const published = await withRendererWorkspaceMutation(
    request.workspaceRoot,
    async (mutationToken) => {
      assertEditorsSettled();
      const index = await readSequencePackageHistoryIndex({
        packageRoot: request.packageRoot,
        workspaceRoot: request.workspaceRoot,
        expectedPackageId: request.packageId,
        fs: platform().fs,
      });
      assertEditorsSettled();
      const result = await platform().fs.applySequenceRestore({ ...request, mutationToken });

      await runWorkspaceReconcileOperation({
        workspaceRoot: request.workspaceRoot,
        operationId: `restore:${request.operationId}`,
        mutationToken,
        strict: true,
        catalogSource: 'working-tree',

        healManagedHead: false,
        displayDelivery: 'optional',
        filesChanged: { revealPath: request.packageRoot, notifyGitStatus: true },
      });
      let git: SequenceRestoreDeliveredResult['delivery']['git'] = 'not-a-repository';
      let gitError: string | undefined;
      try {
        const repositoryRoot = await gitRepoRoot(index.productPath, mutationToken);
        if (repositoryRoot && result.alreadyPublished) {
          git = 'unverified-replay';
        } else if (repositoryRoot) {
          const packagePaths = [
            index.productPath,
            sequencePackagePaths(request.packageRoot).metaPath,
            ...result.snapshotPaths,
            sequencePackagePaths(request.packageRoot).revisionJournalPath,
          ];
          const relativePaths = result.publicationPaths ?? [
            ...new Set(
              packagePaths
                .map((path) => pathRelativeToBoundary(path, repositoryRoot))
                .filter((path): path is string => Boolean(path))
            ),
          ];
          await gitCommitPaths(
            repositoryRoot,
            `Restore sequence version ${result.revisionId}`,
            relativePaths,
            mutationToken
          );
          git = 'committed';
        }
      } catch (error) {
        git = 'failed';
        gitError = error instanceof Error ? error.message : String(error);
        console.warn('[SequencePackageRestore] Published, but Git history failed:', error);
      }
      return { ...result, delivery: { registry: 'completed' as const, git, gitError } };
    },
    undefined,
    { waitForAvailability: true }
  );

  window.dispatchEvent(
    new CustomEvent('waypoint:workspace-files-changed', {
      detail: { path: request.packageRoot, revisionId: published.revisionId },
    })
  );
  return published;
}
