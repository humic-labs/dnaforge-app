import { toUserMessage, type UserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlatformBridge } from '../../platform';
import type {
  BenchlingMigrationProgressEvent,
  BenchlingMigrationRunView,
} from '../../shared/benchling-migration-ipc';

const HIDDEN_STATES = new Set<BenchlingMigrationRunView['state']>(['unlocked', 'discarded']);
const SUBSCRIPTION_UNAVAILABLE_MESSAGE =
  'Live migration status is temporarily unavailable. Retrying automatically.';
const MAX_SUBSCRIPTION_RETRY_DELAY_MS = 10_000;

type BenchlingMigrationStatusBridge = Pick<
  PlatformBridge['benchlingMigration'],
  'getActiveRun' | 'subscribeProgress'
>;

export type BenchlingMigrationStatusSnapshot = {
  run: BenchlingMigrationRunView | null;
  message: string | null;
  completedItems: number | null;
  totalItems: number | null;
  warnings: string[];
  error: string | null;
};

const EMPTY_SNAPSHOT: BenchlingMigrationStatusSnapshot = {
  run: null,
  message: null,
  completedItems: null,
  totalItems: null,
  warnings: [],
  error: null,
};

function activeRun(run: BenchlingMigrationRunView | null): BenchlingMigrationRunView | null {
  if (!run || HIDDEN_STATES.has(run.state)) return null;
  if (
    run.scope.acquisition === 'local_bundle' &&
    (run.state === 'failed' ||
      (run.state === 'action_required' && run.lastError?.blocking === true))
  )
    return null;
  return run;
}

function errorMessage(cause: unknown): UserMessage {
  return toUserMessage(cause, 'benchling.failed');
}

function warningsForRun(run: BenchlingMigrationRunView | null): string[] {
  return run?.lastError?.message ? [run.lastError.message] : [];
}

function mergeWarnings(...warningGroups: readonly (readonly string[])[]): string[] {
  return [...new Set(warningGroups.flatMap((warnings) => warnings))];
}

export function useBenchlingMigrationStatus(
  bridge: BenchlingMigrationStatusBridge,
  enabled: boolean
) {
  const [snapshot, setSnapshot] = useState<BenchlingMigrationStatusSnapshot>(EMPTY_SNAPSHOT);
  const [completedRun, setCompletedRun] = useState<BenchlingMigrationRunView | null>(null);
  const observedRuns = useRef(new Map<string, BenchlingMigrationRunView>());
  const recordCompletion = useCallback((run: BenchlingMigrationRunView | null) => {
    if (!run) return;
    const previous = observedRuns.current.get(run.id);
    if (previous && previous.updatedAt > run.updatedAt) return;
    observedRuns.current.set(run.id, run);
    if (
      previous &&
      run.state === 'unlocked' &&
      (!run.linkedItemRecovery || run.linkedItemRecovery.state === 'completed') &&
      (previous.state !== 'unlocked' ||
        (previous.linkedItemRecovery && previous.linkedItemRecovery.state !== 'completed'))
    )
      setCompletedRun(run);
  }, []);
  const nextRequest = useRef(0);
  const lastAppliedRequest = useRef(0);
  const observedWizardRunId = useRef<string | null>(null);
  const subscribedRunId = useRef<string | null>(null);
  const subscriptionUnavailable = useRef(false);
  const subscriptionFailures = useRef(0);
  const [subscriptionGeneration, setSubscriptionGeneration] = useState(0);

  const reconcile = useCallback(async () => {
    if (!enabled) return;
    const requestId = ++nextRequest.current;
    try {
      const observed = await bridge.getActiveRun();
      if (requestId < lastAppliedRequest.current) return;
      recordCompletion(observed);
      const run = activeRun(observed);
      lastAppliedRequest.current = requestId;
      setSnapshot((current) => {
        const samePhase =
          run !== null && current.run?.id === run.id && current.run.state === run.state;
        const nextSnapshot = {
          run,
          message: samePhase ? current.message : null,
          completedItems: samePhase ? current.completedItems : null,
          totalItems: samePhase ? current.totalItems : null,
          warnings: samePhase
            ? mergeWarnings(current.warnings, warningsForRun(run))
            : warningsForRun(run),
          error: subscriptionUnavailable.current ? SUBSCRIPTION_UNAVAILABLE_MESSAGE : null,
        };
        if (
          current.run?.id === nextSnapshot.run?.id &&
          current.run?.updatedAt === nextSnapshot.run?.updatedAt &&
          current.run?.state === nextSnapshot.run?.state &&
          current.message === nextSnapshot.message &&
          current.completedItems === nextSnapshot.completedItems &&
          current.totalItems === nextSnapshot.totalItems &&
          current.warnings.length === nextSnapshot.warnings.length &&
          current.warnings.every((warning, index) => warning === nextSnapshot.warnings[index]) &&
          current.error === nextSnapshot.error
        ) {
          return current;
        }
        return nextSnapshot;
      });
    } catch (cause) {
      if (requestId < lastAppliedRequest.current) return;
      lastAppliedRequest.current = requestId;
      setSnapshot((current) => ({ ...current, error: errorMessage(cause) }));
    }
  }, [bridge, enabled, recordCompletion]);

  useEffect(() => {
    if (!enabled) {
      subscribedRunId.current = null;
      subscriptionUnavailable.current = false;
      subscriptionFailures.current = 0;
      setSnapshot(EMPTY_SNAPSHOT);
      setCompletedRun(null);
      observedRuns.current.clear();
      return;
    }
    void reconcile();
  }, [enabled, reconcile]);

  const runId = snapshot.run?.id ?? null;
  useEffect(() => {
    if (!enabled || runId === null) return;
    if (subscribedRunId.current !== runId) {
      subscribedRunId.current = runId;
      subscriptionFailures.current = 0;
    }
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = bridge.subscribeProgress(
      runId,
      (event: BenchlingMigrationProgressEvent) => {
        if (event.runId !== runId) return;
        subscriptionUnavailable.current = false;
        subscriptionFailures.current = 0;
        lastAppliedRequest.current = ++nextRequest.current;
        recordCompletion(event.run);
        const run = activeRun(event.run);
        if (!run) {
          subscribedRunId.current = null;
          void reconcile();
          return;
        }
        setSnapshot({
          run,
          message: event.message,
          completedItems: event.completedItems,
          totalItems: event.totalItems,
          warnings: mergeWarnings(event.warnings, warningsForRun(run)),
          error: null,
        });
      },
      (status) => {
        if (disposed) return;
        if (status === 'ready') {
          subscriptionUnavailable.current = false;
          subscriptionFailures.current = 0;
          setSnapshot((current) =>
            current.error === SUBSCRIPTION_UNAVAILABLE_MESSAGE
              ? { ...current, error: null }
              : current
          );
          void reconcile();
          return;
        }
        subscriptionUnavailable.current = true;
        subscriptionFailures.current += 1;
        setSnapshot((current) => ({
          ...current,
          error: SUBSCRIPTION_UNAVAILABLE_MESSAGE,
        }));
        void reconcile();
        const retryDelay = Math.min(
          1_000 * 2 ** (subscriptionFailures.current - 1),
          MAX_SUBSCRIPTION_RETRY_DELAY_MS
        );
        retryTimer = setTimeout(() => {
          setSubscriptionGeneration((generation) => generation + 1);
        }, retryDelay);
      }
    );
    if (observedWizardRunId.current !== runId) void reconcile();
    return () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [bridge, enabled, reconcile, recordCompletion, runId, subscriptionGeneration]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => void reconcile();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled, reconcile]);

  const observeRun = useCallback(
    (nextRun: BenchlingMigrationRunView | null) => {
      recordCompletion(nextRun);
      const run = activeRun(nextRun);
      observedWizardRunId.current = run?.id ?? null;
      lastAppliedRequest.current = ++nextRequest.current;
      if (run === null) {
        void reconcile();
        return;
      }
      setSnapshot((current) => {
        const statusError = subscriptionUnavailable.current
          ? SUBSCRIPTION_UNAVAILABLE_MESSAGE
          : null;
        if (current.run?.id === run.id && run.updatedAt < current.run.updatedAt) {
          return current.error === statusError ? current : { ...current, error: statusError };
        }
        const samePhase = current.run?.id === run.id && current.run.state === run.state;
        return {
          run,
          message: samePhase ? current.message : null,
          completedItems: samePhase ? current.completedItems : null,
          totalItems: samePhase ? current.totalItems : null,
          warnings: samePhase
            ? mergeWarnings(current.warnings, warningsForRun(run))
            : warningsForRun(run),
          error: statusError,
        };
      });
    },
    [recordCompletion, reconcile]
  );

  const clear = useCallback(() => {
    observedWizardRunId.current = null;
    subscribedRunId.current = null;
    subscriptionUnavailable.current = false;
    subscriptionFailures.current = 0;
    lastAppliedRequest.current = ++nextRequest.current;
    setSnapshot(EMPTY_SNAPSHOT);
    setCompletedRun(null);
    observedRuns.current.clear();
  }, []);

  return { snapshot, completedRun, observeRun, clear, reconcile };
}
