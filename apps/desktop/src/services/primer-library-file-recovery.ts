import { toUserMessage } from '@waypoint/user-messages';
import { platform } from '../platform';
import { useToastStore } from '../stores/toast-store';
import {
  WORKSPACE_FILES_CHANGED_EVENT,
  type WorkspaceFilesChangedDetail,
} from './workspace-files-changed-event';
import type { PrimerRecoveryInventory } from '../features/primers/public/primer-recovery-report';

type ReportInventory = (inventory: PrimerRecoveryInventory) => void;

let recovery: Promise<void> | undefined;
export function saveLegacyPrimerLibraryAsFiles(reportInventory?: ReportInventory): Promise<void> {
  if (recovery) return recovery;
  recovery = save(reportInventory).finally(() => {
    recovery = undefined;
  });
  return recovery;
}
async function save(reportInventory?: ReportInventory): Promise<void> {
  const store = useToastStore.getState();
  const retry = () => saveLegacyPrimerLibraryAsFiles(reportInventory);
  const running = store.addRichToast({ definition: 'primer-library-file-recovery-running' });
  try {
    const result = await platform().workspace.recoverLegacyPrimerLibrary();
    if (result.status === 'empty') return;
    window.dispatchEvent(
      new CustomEvent<WorkspaceFilesChangedDetail>(WORKSPACE_FILES_CHANGED_EVENT, {
        detail: {
          workspaceRoot: result.workspaceRoot,
          createdNewWorkspace: true,
          createdWorkspaceName: 'Recovered primers',
          revealPaths: [result.workspaceRoot.replace(/[\\/]+$/, '') + '/primers'],
        },
      })
    );
    if (result.status === 'complete') {
      const { refreshPrimerRecoveryInventory } =
        await import('../features/primers/public/primer-recovery-report');
      const inventory = await refreshPrimerRecoveryInventory();
      reportInventory?.(inventory);
      store.addRichToast({ definition: 'primer-library-file-recovery-complete' });
    } else {
      store.addRichToast({
        definition: 'primer-library-file-recovery-pending',
        actions: [{ label: 'Retry primer recovery', onClick: retry }],
      });
    }
  } catch (error) {
    store.addRichToast({
      definition: 'primer-library-file-recovery-pending',
      message: toUserMessage(error, 'primer.libraryFileRecoveryPending'),
      actions: [{ label: 'Retry primer recovery', onClick: retry }],
    });
  } finally {
    store.removeToast(running);
  }
}
