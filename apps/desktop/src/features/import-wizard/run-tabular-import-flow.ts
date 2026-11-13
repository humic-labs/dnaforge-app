import { userMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { applyAcceptedLimsImportPlan } from '../lims/public/ingress';
import { undoLimsImportBatch } from '../lims/public/operations';
import { useToastStore } from '../../stores/toast-store';
import {
  buildTabularImportPlans,
  type TabularImportEntry,
  type TabularImportFile,
} from './tabular-import';
import { openTabularImportWizard } from './tabular-import-store';
import {
  createImportAttemptId,
  importElapsedMs,
  importStartMark,
  trackImportCompleted,
  trackImportFailed,
  trackImportStarted,
} from './import-telemetry';
import { emitLimsRegistryChanged } from '../lims/public/events';

export interface TabularApplyResult {
  registered: number;
  links: number;
  batchIds: string[];
}

export class TabularApplyPartialError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly partialResult: TabularApplyResult
  ) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = 'TabularApplyPartialError';
  }
}

export async function applyTabularEntries(
  entries: readonly TabularImportEntry[]
): Promise<TabularApplyResult> {
  const batchIds: string[] = [];
  let registered = 0;
  let links = 0;
  for (const entry of entries) {
    if (!entry.plan || !entry.plan.canApply) continue;
    let result: Awaited<ReturnType<typeof applyAcceptedLimsImportPlan>>;
    try {
      result = await applyAcceptedLimsImportPlan(entry.plan, { actor: 'local-user' });
    } catch (error) {
      throw new TabularApplyPartialError(error, {
        registered,
        links,
        batchIds: [...batchIds],
      });
    }
    if (result.batchId) batchIds.push(result.batchId);
    registered += result.insertedEntities;
    links += result.insertedLinks;
  }
  return { registered, links, batchIds };
}

export async function undoTabularBatches(batchIds: readonly string[]): Promise<number> {
  let reversed = 0;
  for (const batchId of [...batchIds].reverse()) {
    const result = await undoLimsImportBatch({ batchId, actor: 'local-user' });
    reversed += result.tombstonedEntities;
  }
  return reversed;
}

function notifyRegistryChanged(): void {
  emitLimsRegistryChanged();
}

export async function runTabularImportFlow(
  files: readonly TabularImportFile[],
  deps: {
    buildPlans?: typeof buildTabularImportPlans;
    openWizard?: typeof openTabularImportWizard;
    apply?: typeof applyTabularEntries;
    undo?: typeof undoTabularBatches;
  } = {}
): Promise<void> {
  const buildPlans = deps.buildPlans ?? buildTabularImportPlans;
  const openWizard = deps.openWizard ?? openTabularImportWizard;
  const apply = deps.apply ?? applyTabularEntries;
  const undo = deps.undo ?? undoTabularBatches;

  const entries = await buildPlans(files);
  const confirmed = await openWizard(entries);
  if (!confirmed) return;

  const sourceNames = confirmed.map((entry) => entry.fileName);
  const operationId = createImportAttemptId();
  trackImportStarted(sourceNames, operationId);
  const startMark = importStartMark();

  let result: TabularApplyResult;
  try {
    result = await apply(confirmed);
  } catch (error) {
    const partialError =
      error instanceof TabularApplyPartialError && error.partialResult.registered > 0
        ? error
        : null;
    if (partialError) {
      const partial = partialError.partialResult;
      trackImportCompleted({
        operationId,
        sourcePaths: sourceNames,
        importedCount: partial.registered,
        durationMs: importElapsedMs(startMark),
      });
      trackImportFailed({
        operationId,
        stage: 'write',
        errorClass: 'import_item_write_failed',
      });

      useToastStore.getState().addRichToast({
        definition: 'tabular-import-partial-failure',
        variant: partial.batchIds.length > 0 ? 'with-undo' : 'default',
        message: userMessageWithValues('registry.partialImport', {
          count: userMessageValue(partial.registered),
          entities: userMessageValue(partial.registered === 1 ? 'entity' : 'entities'),
        }),
        actions:
          partial.batchIds.length > 0
            ? [
                {
                  label: 'Undo',
                  onClick: () => {
                    void (async () => {
                      await undo(partial.batchIds);
                      notifyRegistryChanged();
                      useToastStore.getState().addToast(userMessage('notice.import-undone'), {
                        definition: 'run-tabular-import-flow-import-undone',
                      });
                    })();
                  },
                },
              ]
            : undefined,
      });
    } else {
      trackImportFailed({
        operationId,
        stage: 'unknown',
        errorClass: 'import_execution_threw',
      });
    }
    notifyRegistryChanged();
    if (partialError) return;
    throw error instanceof TabularApplyPartialError ? error.originalError : error;
  }
  const { registered, links, batchIds } = result;
  notifyRegistryChanged();

  const toast = useToastStore.getState();
  if (registered === 0) {
    trackImportFailed({
      operationId,
      stage: 'validate',
      errorClass: 'import_nothing_registered',
    });
    toast.addToast(
      userMessage('notice.nothing-was-registered-every-row-was-a-duplicate-or-needs-your-attenti'),
      {
        definition:
          'run-tabular-import-flow-nothing-was-registered-every-row-was-a-duplicate-or-needs-your-attention',
      }
    );
    return;
  }

  trackImportCompleted({
    operationId,
    sourcePaths: sourceNames,
    importedCount: registered,
    durationMs: importElapsedMs(startMark),
  });
  toast.addRichToast({
    definition: 'tabular-import-registered',
    message: userMessageWithValues('notice.registered-value-valuevalue-to-the-registry', {
      value0: userMessageValue(registered),
      value1: userMessageValue(registered === 1 ? 'entity' : 'entities'),
      value2: userMessageValue(links > 0 ? ` + ${links} link${links === 1 ? '' : 's'}` : ''),
    }),
    actions: [
      {
        label: 'Undo',
        onClick: () => {
          void (async () => {
            await undo(batchIds);
            notifyRegistryChanged();
            useToastStore.getState().addToast(userMessage('notice.import-undone'), {
              definition: 'run-tabular-import-flow-import-undone',
            });
          })();
        },
      },
    ],
  });
}
