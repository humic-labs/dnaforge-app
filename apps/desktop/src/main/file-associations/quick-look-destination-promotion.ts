import type {
  PromoteQuickLookPackageRequest,
  PromoteQuickLookPackageResult,
  QuickLookPackageReceipt,
} from '../../shared/file-association-ipc';

export interface PreparedQuickLookWorkspace {
  readonly workspaceUuid: string;
  readonly repoPath: string;
  readonly displayName: string;
  readonly workspaceContainerPath: string;
  readonly ownerToken: string;
  readonly containerDevice: string;
  readonly containerInode: string;
  readonly journalPath: string;
  readonly releaseMutationBlock: () => void;
}

export interface QuickLookDestinationPromotionDeps {
  readonly prepareWorkspace: (name: string) => Promise<PreparedQuickLookWorkspace>;
  readonly activateWorkspace: (workspace: PreparedQuickLookWorkspace) => Promise<void>;
  readonly discardWorkspace: (workspace: PreparedQuickLookWorkspace) => Promise<void>;
  readonly promoteToRoot: (
    receipt: QuickLookPackageReceipt,
    targetRoot: string
  ) => Promise<
    Pick<PromoteQuickLookPackageResult, 'destPath' | 'relPath' | 'committed' | 'records'>
  >;
}

export async function promoteQuickLookToDestination(
  request: PromoteQuickLookPackageRequest,
  deps: QuickLookDestinationPromotionDeps
): Promise<PromoteQuickLookPackageResult> {
  let preparedWorkspace: PreparedQuickLookWorkspace | null = null;
  try {
    preparedWorkspace =
      request.destination.kind === 'new-workspace'
        ? await deps.prepareWorkspace(request.destination.name)
        : null;
    const targetRoot =
      preparedWorkspace?.repoPath ??
      (request.destination.kind === 'existing-workspace' ? request.destination.rootPath : null);
    if (!targetRoot) throw new Error('Quick Look promotion destination is unavailable.');

    const promoted = await deps.promoteToRoot(request.receipt, targetRoot);
    if (preparedWorkspace) await deps.activateWorkspace(preparedWorkspace);
    return {
      ...promoted,
      workspaceRoot: targetRoot,
      createdNewWorkspace: preparedWorkspace !== null,
      createdWorkspaceName: preparedWorkspace?.displayName ?? null,
    };
  } catch (error) {
    if (preparedWorkspace) {
      try {
        await deps.discardWorkspace(preparedWorkspace);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Quick Look promotion failed and its unpublished project could not be cleaned up.'
        );
      }
    }
    throw error;
  } finally {
    preparedWorkspace?.releaseMutationBlock();
  }
}
