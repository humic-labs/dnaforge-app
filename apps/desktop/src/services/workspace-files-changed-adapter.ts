import { stripTrailingSep } from '../shared/path-boundary';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { resolveSequencePackageRootForProductPath } from '../features/sequence/sequence-package-product';
import { isPathInsideBoundary } from '../shared/path-boundary';
import {
  reconcileWorkspaceAfterFilesChanged,
  resolveReconcileWorkspaceRoot,
} from './workspace-operations';
import {
  WORKSPACE_FILES_CHANGED_EVENT,
  type WorkspaceFilesChangedDetail,
} from './workspace-files-changed-event';

export {
  WORKSPACE_FILES_CHANGED_EVENT,
  type WorkspaceFilesChangedDetail,
} from './workspace-files-changed-event';

function isMounted(workspaceRoot: string): boolean {
  const wanted = stripTrailingSep(workspaceRoot);
  return useWorkspaceStore
    .getState()
    .folders.some((folder) => stripTrailingSep(folder.path) === wanted);
}

export function installWorkspaceFilesChangedAdapter(): () => void {
  const onFilesChanged = (event: Event): void => {
    const detail = (event as CustomEvent<WorkspaceFilesChangedDetail | undefined>).detail;
    if (detail?.createdNewWorkspace) return;
    const workspaceRoot = resolveReconcileWorkspaceRoot(detail?.workspaceRoot, detail?.path);
    if (!workspaceRoot) return;
    if (detail?.revealPaths) {
      const revealPaths = detail.revealPaths;
      const roots = [
        ...new Set(detail.workspaceRoots?.length ? detail.workspaceRoots : [workspaceRoot]),
      ];
      const guardedRoots = new Set(roots.filter(isMounted));
      void (async () => {
        const results = await Promise.allSettled(
          roots.map((root) =>
            reconcileWorkspaceAfterFilesChanged({
              workspaceRoot: root,
              notifyGitStatus: true,
              assertCurrent: guardedRoots.has(root)
                ? () => {
                    if (!isMounted(root))
                      throw new Error(`Workspace ${root} was removed during reconciliation.`);
                  }
                : undefined,
            })
          )
        );
        for (const result of results) {
          if (result.status === 'rejected') {
            console.warn(
              '[WorkspaceOperations] Failed to reconcile workspace root after a file change:',
              result.reason
            );
          }
        }
        const paths = await Promise.all(
          revealPaths.map(
            async (path) =>
              (await resolveSequencePackageRootForProductPath(path).catch(() => null)) ?? path
          )
        );
        useWorkspaceStore
          .getState()
          .revealPaths(
            paths.filter((path) =>
              roots.some(
                (root) =>
                  isPathInsideBoundary(path, root) && (!guardedRoots.has(root) || isMounted(root))
              )
            )
          );
      })().catch((error: unknown) => {
        console.warn('[WorkspaceOperations] Failed to reveal imported files:', error);
      });
      return;
    }
    const guardMount = isMounted(workspaceRoot);
    const revealPath = detail?.revealPath ?? null;
    void reconcileWorkspaceAfterFilesChanged({
      workspaceRoot,
      revealPath,
      notifyGitStatus: true,
      assertCurrent: guardMount
        ? () => {
            if (!isMounted(workspaceRoot)) {
              throw new Error(`Workspace ${workspaceRoot} was removed during reconciliation.`);
            }
          }
        : undefined,
    }).catch((error: unknown) => {
      console.warn(
        '[WorkspaceOperations] Failed to reconcile workspace root after a file change:',
        error
      );
      if (revealPath && (!guardMount || isMounted(workspaceRoot))) {
        useWorkspaceStore.getState().revealPath(revealPath);
      }
    });
  };
  window.addEventListener(WORKSPACE_FILES_CHANGED_EVENT, onFilesChanged);
  return () => window.removeEventListener(WORKSPACE_FILES_CHANGED_EVENT, onFilesChanged);
}
