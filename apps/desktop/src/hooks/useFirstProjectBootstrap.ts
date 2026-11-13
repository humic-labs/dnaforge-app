import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useRef } from 'react';
import { platform } from '../platform';
import { isBrowserOnly, isDesktopRuntime } from '../utils/environment';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useToastStore } from '../stores/toast-store';
import { openWorkspaceCount } from '../features/workspace-loader/workspace-existence-guard';
import type { ProjectEditFolder } from '../features/workspace-loader/project-edit-folders';
import {
  DEFAULT_PROJECT_DISPLAY_NAME,
  resolveFirstProjectEnsure,
  type FirstProjectEnsurePhase,
} from '../shared/first-project';
import { refreshPrimerRecoveryInventory } from '../features/primers/public/primer-recovery-report';
import { reportPrimerRecoveryInventory } from '../services/workspace-reconcile-report';
import {
  beginProjectLifecycle,
  bindProjectLifecycle,
} from '../features/workspace-loader/workspace-telemetry';

interface FirstProjectBootstrapOptions {
  libraryLoaded: boolean;
  workspaceLoading: boolean;
  workspacePath: string | null;
  registeredProjectFolders: readonly ProjectEditFolder[];
  activeProjects: readonly { repoPath: string; name: string }[];
  e2e: boolean;
  setWorkspacePath(path: string): unknown;
  refreshWorkspaceLibrary(): Promise<unknown>;
}

export function useFirstProjectBootstrap({
  libraryLoaded,
  workspaceLoading,
  workspacePath,
  registeredProjectFolders,
  activeProjects,
  e2e,
  setWorkspacePath,
  refreshWorkspaceLibrary,
}: FirstProjectBootstrapOptions): void {
  const firstProjectEnsurePhaseRef = useRef<FirstProjectEnsurePhase>('idle');
  const primerRecoveryInventoryStarted = useRef(false);
  useEffect(() => {
    if (
      !isDesktopRuntime() ||
      !libraryLoaded ||
      workspaceLoading ||
      primerRecoveryInventoryStarted.current
    )
      return;
    primerRecoveryInventoryStarted.current = true;
    void refreshPrimerRecoveryInventory()
      .then(reportPrimerRecoveryInventory)
      .catch((error: unknown) => {
        console.warn('[PrimerRecovery] Could not refresh the recovery inventory:', error);
      });
  }, [libraryLoaded, workspaceLoading]);

  useEffect(() => {
    if (isBrowserOnly() || !libraryLoaded || workspaceLoading) return;

    if (e2e) return;

    const decision = resolveFirstProjectEnsure(
      firstProjectEnsurePhaseRef.current,
      registeredProjectFolders.some((project) => project.lifecycle === 'active' && !project.pinned)
    );
    firstProjectEnsurePhaseRef.current = decision.phase;
    if (decision.action === 'wait') return;

    if (decision.action === 'mount') {
      if (workspacePath || openWorkspaceCount(useWorkspaceStore.getState().folders) > 0) return;
      const mostRecent = activeProjects[0];
      if (!mostRecent) return;
      useWorkspaceStore.getState().addFolder(mostRecent.repoPath, mostRecent.name);
      setWorkspacePath(mostRecent.repoPath);
      return;
    }

    const lifecycle = beginProjectLifecycle({
      source: 'bootstrap',
      mode: 'add',
      intent: 'unknown',
    });
    lifecycle.stage('materialization');
    void (async () => {
      const minted = await platform().workspace.createEmptyWorkspace({
        name: DEFAULT_PROJECT_DISPLAY_NAME,
        originalDefaultProject: true,
      });

      lifecycle.authority('writable');
      lifecycle.phase('minted');

      lifecycle.stage('registration');
      lifecycle.phase('registered');
      firstProjectEnsurePhaseRef.current = 'awaiting-library';

      const nothingMounted = openWorkspaceCount(useWorkspaceStore.getState().folders) === 0;
      lifecycle.stage('mount');
      bindProjectLifecycle(minted.rootPath, lifecycle);
      useWorkspaceStore.getState().addFolder(minted.rootPath, minted.displayName);
      lifecycle.phase('mounted');
      if (nothingMounted) setWorkspacePath(minted.rootPath);
      await refreshWorkspaceLibrary();
    })().catch((err) => {
      lifecycle.phase('failed');

      if (firstProjectEnsurePhaseRef.current === 'creating') {
        firstProjectEnsurePhaseRef.current = 'idle';
      }
      // eslint-disable-next-line no-console
      console.error('[FirstProject] failed to create the first project', err);
      useToastStore.getState().addToast(toUserMessage(err, 'operation.failed'), {
        definition:
          'app-dnaforge-couldn-t-create-your-first-project-create-one-from-the-projects-menu',
      });
    });
  }, [
    e2e,
    libraryLoaded,
    workspaceLoading,
    workspacePath,
    activeProjects,
    registeredProjectFolders,
    setWorkspacePath,
    refreshWorkspaceLibrary,
  ]);
}
