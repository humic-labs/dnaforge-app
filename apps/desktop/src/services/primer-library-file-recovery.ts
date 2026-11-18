import { toUserMessage } from '@waypoint/user-messages';
import { platform } from '../platform';
import { useToastStore } from '../stores/toast-store';
import {
  WORKSPACE_FILES_CHANGED_EVENT,
  type WorkspaceFilesChangedDetail,
} from './workspace-files-changed-event';
import type { PrimerRecoveryInventory } from '../features/primers/public/primer-recovery-report';
import type { LegacyPrimerLibraryRecoveryResult } from '../shared/legacy-primer-library-recovery';

type ReportInventory = (inventory: PrimerRecoveryInventory) => void;
type RecoveryAttempt =
  | LegacyPrimerLibraryRecoveryResult
  | { status: 'failed'; error: unknown }
  | { status: 'cancelled' };
type IsCurrent = () => boolean | Promise<boolean>;

let recovery: Promise<RecoveryAttempt> | undefined;
export function saveLegacyPrimerLibraryAsFiles(
  reportInventory?: ReportInventory,
  isCurrent?: IsCurrent
): Promise<RecoveryAttempt> {
  if (recovery) return recovery;
  recovery = save(reportInventory, isCurrent).finally(() => {
    recovery = undefined;
  });
  return recovery;
}
async function save(
  reportInventory?: ReportInventory,
  isCurrent?: IsCurrent
): Promise<RecoveryAttempt> {
  const current = () =>
    Promise.resolve()
      .then(() => isCurrent?.() ?? true)
      .catch(() => false);
  if (isCurrent && !(await current())) return { status: 'cancelled' };
  const store = useToastStore.getState();
  const retry = () => saveLegacyPrimerLibraryAsFiles(reportInventory, isCurrent);
  const running = store.addRichToast({ definition: 'primer-library-file-recovery-running' });
  try {
    const result = await platform().workspace.recoverLegacyPrimerLibrary();
    if (isCurrent && !(await current())) return { status: 'cancelled' };
    if (result.status === 'empty') return result;
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
      if (isCurrent && !(await current())) return { status: 'cancelled' };
      const inventory = await refreshPrimerRecoveryInventory();
      if (isCurrent && !(await current())) return { status: 'cancelled' };
      reportInventory?.(inventory);
      store.addRichToast({ definition: 'primer-library-file-recovery-complete' });
    } else {
      store.addRichToast({
        definition: 'primer-library-file-recovery-pending',
        actions: [{ label: 'Retry primer recovery', onClick: retry }],
      });
    }
    return result;
  } catch (error) {
    if (isCurrent && !(await current())) return { status: 'cancelled' };
    store.addRichToast({
      definition: 'primer-library-file-recovery-pending',
      message: toUserMessage(error, 'primer.libraryFileRecoveryPending'),
      actions: [{ label: 'Retry primer recovery', onClick: retry }],
    });
    return { status: 'failed', error };
  } finally {
    store.removeToast(running);
  }
}
