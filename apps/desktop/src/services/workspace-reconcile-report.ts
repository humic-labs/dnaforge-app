import { useNotebookConflictStore } from '../features/page/public/notebook-conflict';
import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  toUserMessage,
} from '@waypoint/user-messages';
import { useToastStore } from '../stores/toast-store';
import type { WorkspaceReconcileResult } from './workspace-reconcile-result';
import { saveLegacyPrimerLibraryAsFiles } from './primer-library-file-recovery';
import type { EntityReconcileResult } from '../db/entity-substrate/reconcile-entities';
import {
  resolveOriginalProjectRecovery,
  type OriginalDefaultProjectResolution,
} from '../shared/first-project';
import {
  getLatestPrimerRecoveryInventory,
  refreshPrimerRecoveryInventory,
  type PrimerRecoveryInventory,
} from '../features/primers/public/primer-recovery-report';

const entityConflictToasts = new Map<string, string>();
const entityMigrationToasts = new Map<string, string>();
interface PrimerFailure {
  id: string;
  message: string;
  primerName?: string;
  restore?: PrimerRecoveryInventory['entries'][number]['restore'];
}
const provisionalPrimerFailures = new Map<string, PrimerFailure[]>();
let originalProjectToast: string | undefined;
let legacyLibraryToast: string | undefined;
let lastPrimerRestoreSelection = '[]';

export function reportEntityMigrationIssues(
  rootPath: string,
  result: Pick<WorkspaceReconcileResult, 'migrationIssues'>
): void {
  const store = useToastStore.getState();
  const previousId = entityMigrationToasts.get(rootPath);
  const issues = result.migrationIssues ?? [];
  if (issues.length === 0) {
    if (previousId) store.removeToast(previousId);
    entityMigrationToasts.delete(rootPath);
    return;
  }
  const first = issues[0];
  const target = first.path.startsWith(rootPath + '/')
    ? first.path.slice(rootPath.length + 1)
    : first.path;
  const message = userMessageWithValues('project.entityMigrationSummary', {
    count: userMessageValue(issues.length),
    target: userMessageValue(target),
    detail: userMessageValue(first.reason),
  });
  const previous = store.toasts.find(({ id }) => id === previousId);
  if (previous?.phase !== 'exiting' && previous?.message === message) return;
  if (previousId) store.removeToast(previousId);
  entityMigrationToasts.set(
    rootPath,
    store.addToast(message, { definition: 'entity-migration-needs-attention' })
  );
}

function reportOriginalProjectResolution(
  resolution: OriginalDefaultProjectResolution | undefined,
  unassignedRecoveryCount: number
): void {
  const store = useToastStore.getState();
  const action = resolveOriginalProjectRecovery(resolution, unassignedRecoveryCount > 0);
  if (action === 'identify') {
    for (const toast of store.toasts) {
      if (toast.definition === 'original-project-recovery-needed') store.removeToast(toast.id);
    }
    originalProjectToast = undefined;
    return;
  }
  if (action === 'clear' || !resolution || resolution.status === 'ready') {
    if (originalProjectToast) store.removeToast(originalProjectToast);
    originalProjectToast = undefined;
    return;
  }
  const message = toUserMessage(resolution.message, 'project.recoveryNeeded');
  if (
    store.toasts.some(
      (toast) =>
        toast.id === originalProjectToast && toast.phase !== 'exiting' && toast.message === message
    )
  )
    return;
  if (originalProjectToast) store.removeToast(originalProjectToast);
  originalProjectToast = store.addRichToast({
    definition: 'original-project-recovery-needed',
    message,
  });
}

export function reportPrimerRecoveryInventory(report: PrimerRecoveryInventory): void {
  const store = useToastStore.getState();
  if (report.entries.some((entry) => entry.status === 'legacy-library')) {
    if (
      !store.toasts.some((toast) => toast.id === legacyLibraryToast && toast.phase !== 'exiting')
    ) {
      legacyLibraryToast = store.addRichToast({
        definition: 'primer-library-file-recovery',
        message: userMessage('primer.libraryFileRecoveryNeeded'),
        actions: [
          {
            label: 'Save library primers as files',
            onClick: () => saveLegacyPrimerLibraryAsFiles(reportPrimerRecoveryInventory),
          },
        ],
      });
    }
  } else if (legacyLibraryToast) {
    store.removeToast(legacyLibraryToast);
    legacyLibraryToast = undefined;
  }
  reportOriginalProjectResolution(
    report.originalProject,
    report.entries.filter((entry) => entry.workspaceId === null && entry.status === 'needs-review')
      .length
  );
  const knownIds = new Set(report.entries.map((entry) => entry.id));
  for (const [root, failures] of provisionalPrimerFailures) {
    const remaining = failures.filter((failure) => !knownIds.has(failure.id));
    if (remaining.length) provisionalPrimerFailures.set(root, remaining);
    else provisionalPrimerFailures.delete(root);
  }
  const failures = report.entries
    .filter(
      (entry) =>
        entry.status === 'needs-review' &&
        !(
          entry.workspaceId === null &&
          report.originalProject?.status === 'unresolved' &&
          entry.message === report.originalProject.message
        )
    )
    .map((entry) => ({
      id: entry.id,
      message: entry.message ?? userMessage('primer.recoveryReview'),
      primerName: entry.name,
      restore: entry.restore,
    }));
  showPrimerRecoveryFailures(failures);
}

function showPrimerRecoveryFailures(inventory: PrimerFailure[]): void {
  const store = useToastStore.getState();
  const records = [...provisionalPrimerFailures.values()].flat().concat(inventory);
  const failures = [...new Map(records.map((failure) => [failure.id, failure])).values()];
  const names =
    failures.length <= 2 && failures.every((f) => f.primerName)
      ? failures.map((failure) => `"${failure.primerName}"`).join(' and ')
      : '';
  const message = failures.length
    ? userMessageWithValues('primer.recoverySummary', {
        subject: userMessageValue(names ? ` for ${names}` : ''),
        count: userMessageValue(failures.length),
        noun: userMessageValue(failures.length === 1 ? 'issue' : 'issues'),
        detail: userMessageValue(toUserMessage(failures[0].message, 'primer.recoveryReview')),
      })
    : null;
  const restore = failures.flatMap((failure) => (failure.restore ? [failure.restore] : []));
  const restoreKey = JSON.stringify(restore);
  const previous = store.toasts.filter((toast) => toast.definition === 'primer-recovery-failed');
  const unchanged = previous.find(
    (toast) =>
      toast.phase !== 'exiting' &&
      toast.message === message &&
      restoreKey === lastPrimerRestoreSelection
  );
  lastPrimerRestoreSelection = restoreKey;
  for (const toast of previous) {
    if (toast !== unchanged) store.removeToast(toast.id);
  }
  if (!message || unchanged) return;
  if (!restore.length) {
    store.addToast(message, { definition: 'primer-recovery-failed' });
    return;
  }
  store.addRichToast({
    definition: 'primer-recovery-failed',
    message,
    actions: [
      {
        label: 'Restore saved copies',
        onClick: async () => {
          const { restoreSavedPrimerDocument } =
            await import('../features/primers/primer-artifact-service');
          let failed = false;
          for (const selection of restore) {
            try {
              await restoreSavedPrimerDocument(selection);
            } catch {
              failed = true;
            }
          }
          reportPrimerRecoveryInventory(await refreshPrimerRecoveryInventory());
          if (failed) store.addToast(userMessage('primer.recoveryRestoreFailed'), 'error');
        },
      },
    ],
  });
}

export function reportEntityReconcileConflicts(
  rootPath: string,
  result: EntityReconcileResult
): void {
  const store = useToastStore.getState();
  const previousId = entityConflictToasts.get(rootPath);
  if (result.conflicts === 0) {
    if (previousId) store.removeToast(previousId);
    entityConflictToasts.delete(rootPath);
    return;
  }
  const path = result.conflictDetails?.[0]?.path;
  const relativePath = path?.startsWith(`${rootPath}/`) ? path.slice(rootPath.length + 1) : path;
  const target = relativePath ? `"${relativePath}"` : 'a saved document';
  const message = userMessageWithValues('document.conflictSummary', {
    count: userMessageValue(result.conflicts),
    noun: userMessageValue(result.conflicts === 1 ? 'conflict' : 'conflicts'),
    target: userMessageValue(target),
  });
  const previous = store.toasts.find(({ id }) => id === previousId);
  if (previous?.phase !== 'exiting' && previous?.message === message) return;
  if (previousId) store.removeToast(previousId);
  const notebook = result.conflictDetails?.find((detail) =>
    /\/\.forge\/notebook\.json$|\.wpnote\.json$/i.test(detail.path)
  );
  entityConflictToasts.set(
    rootPath,
    notebook && typeof store.addRichToast === 'function'
      ? store.addRichToast({
          definition: 'entity-reconcile-conflict',
          message,
          actions: [
            {
              label: 'Compare versions',
              onClick: () => useNotebookConflictStore.getState().open(notebook.id),
            },
          ],
        })
      : store.addToast(message, { definition: 'entity-reconcile-conflict' })
  );
}

export function reportPrimerReconcileFailures(
  rootPath: string,
  result: WorkspaceReconcileResult
): void {
  const inventory = getLatestPrimerRecoveryInventory();
  const recoveryErrors = result.primerArtifactErrors.filter(
    (error) =>
      /^(registry|legacy-primer):/.test(error.path) &&
      !(
        inventory?.originalProject?.status === 'unresolved' &&
        error.message === inventory.originalProject.message
      )
  );
  if (recoveryErrors.length)
    provisionalPrimerFailures.set(
      rootPath,
      recoveryErrors.map((error) => ({
        id: error.path.slice(error.path.indexOf(':') + 1),
        message: error.message,
        primerName: error.primerName,
      }))
    );
  else provisionalPrimerFailures.delete(rootPath);
  if (inventory) reportPrimerRecoveryInventory(inventory);
  else showPrimerRecoveryFailures([]);
  if (result.primerArtifactErrors.length === 0) return;

  const artifactErrors = result.primerArtifactErrors.filter((error) =>
    error.path.toLowerCase().endsWith('.primer.json')
  );
  const discoveryErrors = result.primerArtifactErrors.filter(
    (error) =>
      !error.path.toLowerCase().endsWith('.primer.json') &&
      !/^(registry|legacy-primer):/.test(error.path)
  );
  if (discoveryErrors.length > 0) {
    console.warn(
      `[WorkspaceOperations] Primer discovery for ${rootPath} hit ${
        discoveryErrors.length
      } non-artifact scan limit(s) (not a data problem):`,
      discoveryErrors
    );
  }
  if (artifactErrors.length === 0) return;
  const paths = [...new Set(artifactErrors.map((error) => error.path))];
  console.warn(
    `[WorkspaceOperations] Primer workspace reconciliation reported ${artifactErrors.length} artifact error(s):`,
    artifactErrors
  );

  const relToRoot = (p: string) => {
    if (rootPath && p.startsWith(rootPath)) {
      const rel = p.slice(rootPath.length).replace(/^[/\\]/, '');
      return rel || p;
    }
    return p;
  };
  const first = relToRoot(paths[0]);
  useToastStore
    .getState()
    .addToast(
      paths.length === 1
        ? userMessageWithValues(
            'notice.primer-file-value-couldn-t-be-added-to-your-primer-registry-it-may-be-',
            { value0: userMessageValue(first) }
          )
        : userMessageWithValues(
            'notice.value-primer-files-couldn-t-be-added-to-your-primer-registry-e-g-value',
            { value0: userMessageValue(paths.length), value1: userMessageValue(first) }
          ),
      { definition: 'primer-reconcile-failed' }
    );
}
