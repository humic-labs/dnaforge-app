import { toUserMessage, type UserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BenchlingMigrationLinkedItemRecoveryLocationKind,
  BenchlingMigrationRunView,
} from '../../shared/benchling-migration-ipc';
import type {
  BenchlingImportDestinationChoice,
  BenchlingImportDestinationSelection,
  BenchlingMigrationWizardBridge,
  BenchlingMigrationWizardView,
} from './types';
import {
  isCoordinatorDrivenLocalImport,
  isFinalizingNativeZipImport,
  isLocalBundleRunView,
} from './migration-progress';

const EMPTY_VIEW: BenchlingMigrationWizardView = {
  run: null,
  report: null,
  createdObjects: [],
};

const POLLED_STATES = new Set<BenchlingMigrationRunView['state']>([
  'export_pending',
  'downloading',
  'parsing',
  'offline_resolution',
  'targeted_reads',
  'projecting',
  'validating',
]);
const MIGRATION_RECONCILE_WATCHDOG_MS = 4_000;
const ACTIVE_LINKED_ITEM_RECOVERY_STATES = new Set([
  'copying',
  'parsing',
  'awaiting_conflict_resolution',
  'reconciling',
  'validating',
]);
const RECONCILE_BLOCKED_ACTIONS = new Set<MigrationWizardAction>([
  'unlock',
  'discard',
  'start_new',
  'start_over',
  'retry_without_file',
]);

function preserveTransientLinkedItemWork(
  current: BenchlingMigrationWizardView,
  next: BenchlingMigrationWizardView
): BenchlingMigrationWizardView {
  const currentRun = current.run;
  const nextRun = next.run;
  const currentRecovery = currentRun?.linkedItemRecovery;
  const nextRecovery = nextRun?.linkedItemRecovery;
  if (
    (!currentRecovery?.work && !currentRecovery?.startedAt) ||
    !currentRun ||
    !nextRun ||
    !nextRecovery ||
    currentRun.id !== nextRun.id ||
    currentRecovery.attemptId !== nextRecovery.attemptId ||
    !ACTIVE_LINKED_ITEM_RECOVERY_STATES.has(nextRecovery.state)
  ) {
    return next;
  }

  return {
    ...next,
    run: {
      ...nextRun,
      linkedItemRecovery: {
        ...nextRecovery,
        ...(currentRecovery.startedAt ? { startedAt: currentRecovery.startedAt } : {}),
        ...(currentRecovery.state === nextRecovery.state && currentRecovery.work
          ? { work: currentRecovery.work }
          : {}),
      },
    },
  };
}

export type MigrationWizardAction =
  | 'create'
  | 'retry_without_file'
  | 'choose_export'
  | 'survey'
  | 'recover_linked_items'
  | 'append_workspace_exports'
  | 'resolve_import_decision'
  | 'start'
  | 'pause'
  | 'cancel'
  | 'start_over'
  | 'start_new'
  | 'discard'
  | 'resume'
  | 'unlock';

export function useBenchlingMigrationWizard(
  bridge: BenchlingMigrationWizardBridge,
  selectedRunId?: string,
  startFresh = false
) {
  const [view, setView] = useState<BenchlingMigrationWizardView>(EMPTY_VIEW);
  const [retryCreatedRunId, setRetryCreatedRunId] = useState<string | null>(null);
  const effectiveSelectedRunId = retryCreatedRunId ?? selectedRunId;
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<MigrationWizardAction | null>(null);
  const [pendingImport, setPendingImport] = useState<BenchlingImportDestinationSelection | null>(
    null
  );
  const [error, setError] = useState<UserMessage | null>(null);
  const nextRequest = useRef(0);
  const lastAppliedRequest = useRef(0);
  const pendingActionRef = useRef<MigrationWizardAction | null>(null);

  const applyRequest = useCallback(async (request: () => Promise<BenchlingMigrationWizardView>) => {
    const requestId = ++nextRequest.current;
    const nextView = await request();
    if (requestId >= lastAppliedRequest.current) {
      lastAppliedRequest.current = requestId;
      setView((current) => preserveTransientLinkedItemWork(current, nextView));
    }
    return nextView;
  }, []);

  const refresh = useCallback(async () => {
    if (startFresh && !retryCreatedRunId) {
      setView(EMPTY_VIEW);
      setError(null);
      setLoading(false);
      return;
    }
    try {
      await applyRequest(() => bridge.load(effectiveSelectedRunId));
    } catch (cause) {
      setError(toUserMessage(cause, 'benchling.failed'));
    } finally {
      setLoading(false);
    }
  }, [applyRequest, bridge, effectiveSelectedRunId, retryCreatedRunId, startFresh]);

  useEffect(() => void refresh(), [refresh]);

  const reconcile = useCallback(
    async (runId?: string) => {
      if (
        pendingActionRef.current !== null &&
        RECONCILE_BLOCKED_ACTIONS.has(pendingActionRef.current)
      ) {
        return;
      }
      try {
        await applyRequest(async () => {
          const activeView = await bridge.load(effectiveSelectedRunId);
          if (activeView.run || !runId || effectiveSelectedRunId) return activeView;
          return bridge.load(runId);
        });
      } catch (cause) {
        setError(toUserMessage(cause, 'benchling.failed'));
      } finally {
        setLoading(false);
      }
    },
    [applyRequest, bridge, effectiveSelectedRunId]
  );

  const runId = view.run?.id ?? null;
  useEffect(() => {
    if (!runId) return;
    let reconcilePending = false;
    const reconcileOnce = () => {
      if (reconcilePending) return;
      reconcilePending = true;
      void reconcile(runId).finally(() => {
        reconcilePending = false;
      });
    };
    return bridge.subscribeProgress(
      runId,
      (event) => {
        if (event.runId !== runId) return;
        if (event.run.linkedItemRecovery?.work || event.run.linkedItemRecovery?.startedAt) {
          lastAppliedRequest.current = ++nextRequest.current;
          setView((current) =>
            current.run?.id === runId ? { ...current, run: event.run } : current
          );
          return;
        }
        reconcileOnce();
      },
      (status) => {
        if (status === 'ready') reconcileOnce();
      }
    );
  }, [bridge, reconcile, runId]);

  const shouldWatchdog = view.run
    ? POLLED_STATES.has(view.run.state) ||
      Boolean(view.run.bestEffortRecoveryPending) ||
      isFinalizingNativeZipImport(view.run) ||
      isCoordinatorDrivenLocalImport(view.run) ||
      (isLocalBundleRunView(view.run) && view.run.localBundleState === 'copying') ||
      Boolean(
        view.run.linkedItemRecovery &&
        !['completed', 'failed'].includes(view.run.linkedItemRecovery.state)
      )
    : false;
  useEffect(() => {
    if (!shouldWatchdog) return;
    const interval = window.setInterval(
      () => void reconcile(runId ?? undefined),
      MIGRATION_RECONCILE_WATCHDOG_MS
    );
    return () => window.clearInterval(interval);
  }, [reconcile, runId, shouldWatchdog]);

  const runAction = useCallback(
    async (
      action: MigrationWizardAction,
      request: () => Promise<BenchlingMigrationWizardView>
    ): Promise<BenchlingMigrationWizardView | null> => {
      if (pendingActionRef.current !== null) return null;
      pendingActionRef.current = action;
      setPendingAction(action);
      setError(null);
      let actionFailed = false;
      try {
        return await applyRequest(request);
      } catch (cause) {
        actionFailed = true;
        setError(
          action === 'recover_linked_items'
            ? toUserMessage(cause, 'benchling.linkedItemsFailed')
            : toUserMessage(cause, 'benchling.failed')
        );
        return null;
      } finally {
        pendingActionRef.current = null;
        setPendingAction(null);
        if (actionFailed && RECONCILE_BLOCKED_ACTIONS.has(action)) {
          void reconcile();
        }
      }
    },
    [applyRequest, reconcile]
  );

  const surveyLocalBundle = useCallback(
    async (sourcePath: string) => {
      if (pendingActionRef.current !== null) return null;
      pendingActionRef.current = 'survey';
      setPendingAction('survey');
      setError(null);
      try {
        const selection = await bridge.prepareLocalBundle(sourcePath);
        if (selection) setPendingImport(selection);
        return selection;
      } catch (cause) {
        setError(toUserMessage(cause, 'benchling.failed'));
        return null;
      } finally {
        pendingActionRef.current = null;
        setPendingAction(null);
      }
    },
    [bridge]
  );
  const chooseLocalBundle = useCallback(async () => {
    if (pendingActionRef.current !== null) return null;
    pendingActionRef.current = 'choose_export';
    setPendingAction('choose_export');
    setError(null);
    try {
      const sourcePath = await bridge.chooseLocalBundle();
      if (sourcePath === null) return null;
      pendingActionRef.current = 'survey';
      setPendingAction('survey');
      const selection = await bridge.prepareLocalBundle(sourcePath);
      setPendingImport(selection);
      return selection;
    } catch (cause) {
      setError(toUserMessage(cause, 'benchling.failed'));
      return null;
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  }, [bridge]);
  const importPreparedLocalBundle = useCallback(
    async (destination: BenchlingImportDestinationChoice) => {
      if (!pendingImport) return null;
      const result = await runAction('create', () =>
        bridge.importPreparedLocalBundle(pendingImport, destination)
      );
      if (result) setPendingImport(null);
      return result;
    },
    [bridge, pendingImport, runAction]
  );
  const cancelPreparedLocalBundle = useCallback(() => {
    if (pendingActionRef.current !== null) return;
    setPendingImport(null);
    setError(null);
  }, []);

  const importLocalBundle = useCallback(
    (selectedRunId?: string) => runAction('create', () => bridge.importLocalBundle(selectedRunId)),
    [bridge, runAction]
  );
  const retryWithoutFailedFile = useCallback(async () => {
    if (!runId) return null;
    const result = await runAction('retry_without_file', () =>
      bridge.retryWithoutFailedFile(runId)
    );
    if (result?.run) setRetryCreatedRunId(result.run.id);
    return result;
  }, [bridge, runAction, runId]);
  const importDroppedLocalBundle = useCallback(
    (sourcePath: string, selectedRunId?: string) =>
      runAction('create', () => bridge.importDroppedLocalBundle(sourcePath, selectedRunId)),
    [bridge, runAction]
  );
  const addLinkedItemExports = useCallback(
    (sourcePaths?: string[]) =>
      runId
        ? runAction('recover_linked_items', () => bridge.addLinkedItemExports(runId, sourcePaths))
        : Promise.resolve(null),
    [bridge, runAction, runId]
  );
  const appendWorkspaceExports = useCallback(
    (sourcePaths?: string[]) =>
      runId
        ? runAction('append_workspace_exports', () =>
            bridge.appendWorkspaceExports(runId, sourcePaths)
          )
        : Promise.resolve(null),
    [bridge, runAction, runId]
  );
  const resolveImportDecision = useCallback(
    (
      attemptId: string,
      decision: import('../../shared/benchling-import-decision').ImportDecision
    ) =>
      runId
        ? runAction('resolve_import_decision', () =>
            bridge.resolveImportDecision(runId, attemptId, decision)
          )
        : Promise.resolve(null),
    [bridge, runAction, runId]
  );
  const openLinkedItemRecoveryLocation = useCallback(
    async (kind: BenchlingMigrationLinkedItemRecoveryLocationKind, sourceId: string) => {
      if (!runId) return;
      setError(null);
      try {
        await bridge.openLinkedItemRecoveryLocation(runId, kind, sourceId);
      } catch (cause) {
        setError(toUserMessage(cause, 'benchling.failed'));
      }
    },
    [bridge, runId]
  );
  const invokeRunAction = useCallback(
    (
      action: Exclude<
        MigrationWizardAction,
        | 'create'
        | 'retry_without_file'
        | 'choose_export'
        | 'survey'
        | 'recover_linked_items'
        | 'append_workspace_exports'
        | 'resolve_import_decision'
      >
    ) => {
      if (!runId) return Promise.resolve(null);
      const request = {
        start: bridge.start,
        pause: bridge.pause,
        cancel: bridge.cancelPreserved,
        start_over: bridge.startOverPreserved,
        start_new: bridge.startNewMigration,
        discard: bridge.discard,
        resume: bridge.resume,
        unlock: bridge.unlock,
      }[action].bind(bridge);
      return runAction(action, () => request(runId));
    },
    [bridge, runAction, runId]
  );

  return {
    view,
    loading,
    pendingAction,
    pendingImport,
    error,
    refresh,
    chooseLocalBundle,
    prepareLocalBundle: surveyLocalBundle,
    importPreparedLocalBundle,
    cancelPreparedLocalBundle,
    importLocalBundle,
    retryWithoutFailedFile,
    importDroppedLocalBundle,
    addLinkedItemExports,
    appendWorkspaceExports,
    resolveImportDecision,
    openLinkedItemRecoveryLocation,
    start: () => invokeRunAction('start'),
    pause: () => invokeRunAction('pause'),
    cancelPreserved: () => invokeRunAction('cancel'),
    startOverPreserved: () => invokeRunAction('start_over'),
    startNewMigration: () => invokeRunAction('start_new'),
    discard: () => invokeRunAction('discard'),
    resume: () => invokeRunAction('resume'),
    unlock: () => invokeRunAction('unlock'),
  };
}
