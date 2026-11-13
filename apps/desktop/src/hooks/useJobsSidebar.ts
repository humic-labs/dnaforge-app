import { userMessage, toUserMessage } from '@waypoint/user-messages';
import { beginJobManagement, jobManagementContext } from '../lib/jobs-management-telemetry';
import type {
  JobManagementAction,
  JobManagementContext,
  JobManagementObservation,
} from '../shared/jobs-management-telemetry';
import type { JobsSidebarJob, JobsSidebarSnapshot } from '../features/jobs/presentation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { confirmDialog } from '../components/confirm-dialog-store';
import { useCanvasStore } from '../features/canvas';
import {
  cancelHostedComputeJob,
  importHostedComputeJob,
  openHostedComputeResult,
} from '../features/compute/job-actions';
import { useComputeJobsStore } from '../features/compute/jobs-store';
import { useComputeStore } from '../features/compute/store';
import {
  combineJobsSnapshots,
  projectAgentJobsSnapshot,
  projectComputeJobsSnapshot,
  projectJobsSnapshot,
  projectManagedOperationActionPage,
  projectManagedOperationsSnapshot,
  type ManagedOperationReviewProjection,
  type JobsSidebarOwnerRef,
} from '../features/jobs';
import { useAgentJobsStore } from '../features/jobs/agent-jobs-store';
import { annotationOperationPresenters } from '../features/sequence/annotation-operation-presenter';
import { alignmentCoverageOperationPresenters } from '../features/sequence/alignment-coverage-operation-presenter';
import { alignmentIndexOperationPresenters } from '../features/sequence/alignment-index-operation-presenter';
import { genomeIndexOperationPresenters } from '../features/sequence/genome-index-operation-presenter';
import { useAnnotationReviewStore } from '../features/sequence/annotation-review-store';
import { useSequenceStore } from '../features/sequence';
import { variantSourceOperationPresenters } from '../features/sequence/variant-source-operation-presenter';
import { alignmentOperationPresenters } from '../features/alignment-manager';
import { isPairwiseSessionAlignmentResult } from '../features/alignment-manager/pairwise-session-operation-client';
import { isDesktopRuntime, isHostedBrowserRuntime } from '../utils/environment';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useToastStore } from '../stores/toast-store';
import { platform } from '../platform';
import { registeredOperationPresenter } from '../shared/managed-operation-presenters';
import {
  managedOperations,
  type ManagedOperationsRuntimeSource,
  type ManagedOperationsSnapshot,
} from '../services/managed-operations';
import { createHostedManagedOperationsRuntimeSource } from '../hosted/managed-operations-runtime';
import {
  recordedReceiptDependencies,
  recordSelectedAnnotationReceipt,
} from '../features/sequence/record-annotation-receipt';

const managedOperationsRuntimeSource: ManagedOperationsRuntimeSource = {
  getStatus: () => platform().config.getSidecarStatus(),
  getBaseUrl: () => platform().config.getApiUrl(),
  subscribeStatus: (listener) => platform().on('sidecar:status', listener),
};

type JobsSidebarHookOptions = {
  readonly activeView: string;
  readonly hostedWorkspaceId: string | null;
  readonly managedOperationsSnapshot: ManagedOperationsSnapshot;
};

function managementRow(
  snapshot: JobsSidebarSnapshot,
  owner: JobsSidebarOwnerRef
): JobsSidebarJob | undefined {
  const visit = (rows: readonly JobsSidebarJob[]): JobsSidebarJob | undefined => {
    for (const row of rows) {
      if (row.owner.kind === owner.kind && row.owner.nativeId === owner.nativeId) return row;
      const child = visit(row.children ?? []);
      if (child) return child;
    }
    return undefined;
  };
  return visit(snapshot.jobs);
}
type ObservationBinding = readonly [string | null, string | null, string | null, string];
function sameObservationBinding(left: ObservationBinding, right: ObservationBinding): boolean {
  return left.every((value, index) => value === right[index]);
}

type PendingStopObservation = {
  owner: JobsSidebarOwnerRef;
  observed: JobManagementObservation;
  accepted: boolean;
  epoch: number;
  binding: ObservationBinding;
  target: string | undefined;
  revision: string | undefined;
  instance: string | undefined;
};

export function useJobsSidebar({
  activeView,
  hostedWorkspaceId,
  managedOperationsSnapshot,
}: JobsSidebarHookOptions) {
  const [importingRecordedRun, setImportingRecordedRun] = useState(false);
  const includeNativeJobs = !isHostedBrowserRuntime();

  const tabLabelsByEntityId = useCanvasStore(
    useShallow((state) => {
      const labels: Record<string, string> = {};
      for (const panel of Object.values(state.panels ?? {})) {
        const seenInPanel = new Set<string>();
        for (const tab of panel?.tabs ?? []) {
          if (!tab || typeof tab.entityId !== 'string') continue;
          if (seenInPanel.has(tab.entityId)) continue;
          seenInPanel.add(tab.entityId);
          if (labels[tab.entityId] !== undefined) continue;
          const label = typeof tab.label === 'string' ? tab.label.trim() : '';
          if (label) labels[tab.entityId] = label;
        }
      }
      return labels;
    })
  );
  const loadedSequences = useSequenceStore((state) => state.sequences);
  const savedSequences = useSequenceStore((state) => state.savedSequences);
  const annotationReviewSessions = useAnnotationReviewStore((state) => state.sessions);
  const operationReviews = useMemo(() => {
    const reviews: Record<string, ManagedOperationReviewProjection> = {};
    for (const [operationId, session] of Object.entries(annotationReviewSessions)) {
      if (session.operationId !== operationId) continue;
      reviews[operationId] = session.blockedReason
        ? { state: 'blocked', reason: session.blockedReason }
        : { state: session.disposition ?? 'in-review' };
    }
    for (const record of managedOperationsSnapshot.records) {
      if (reviews[record.snapshot.id]) continue;
      const saved = savedSequences[record.snapshot.subject.subject_id];
      const applied = saved?.annotations?.some((annotation) =>
        annotation.qualifiers?.dnaforge_operation_id?.includes(record.snapshot.id)
      );
      if (applied) reviews[record.snapshot.id] = { state: 'applied' };
    }
    return reviews;
  }, [annotationReviewSessions, managedOperationsSnapshot.records, savedSequences]);
  const operationPresenters = useMemo(
    () => ({
      ...annotationOperationPresenters({
        reviewByOperationId: operationReviews,
        targetLabel: (operation) => {
          const subjectId = operation.subject.subject_id;
          const label = tabLabelsByEntityId[subjectId];
          if (label) return label;
          return loadedSequences[subjectId]?.name?.trim() || undefined;
        },
      }),
      ...alignmentOperationPresenters(),
      ...alignmentCoverageOperationPresenters(),
      ...alignmentIndexOperationPresenters(),
      ...genomeIndexOperationPresenters(),
      ...variantSourceOperationPresenters(),
    }),
    [tabLabelsByEntityId, loadedSequences, operationReviews]
  );
  const managedJobsSnapshot = useMemo(
    () =>
      projectManagedOperationsSnapshot(managedOperationsSnapshot, {
        nowMs: Date.now(),
        presentersByKind: operationPresenters,
      }),
    [managedOperationsSnapshot, operationPresenters]
  );

  const computeJobs = useComputeJobsStore((state) => state.jobs);
  const computeJobsLoading = useComputeJobsStore((state) => state.loading);
  const computeJobsError = useComputeJobsStore((state) => state.error);
  const computeJobsObservedAtMs = useComputeJobsStore((state) => state.observedAtMs);
  const computeJobsCollectionStale = useComputeJobsStore((state) => state.collectionStale);
  const computeJobsCoverage = useComputeJobsStore((state) => state.coverage);
  const refreshComputeJobs = useComputeJobsStore((state) => state.refresh);
  const computeProviders = useComputeStore((state) => state.providers);
  const refreshComputeProviders = useComputeStore((state) => state.refresh);
  const cancellationByProvider = useMemo(() => {
    const capabilities: Record<
      string,
      { readonly mode: 'provider' | 'unavailable'; readonly note: string }
    > = {};
    for (const provider of computeProviders) {
      capabilities[provider.id] = {
        mode: provider.cancellationMode,
        note: provider.cancellationNote,
      };
    }
    return capabilities;
  }, [computeProviders]);
  const computeJobsSnapshot = useMemo(
    () =>
      projectComputeJobsSnapshot(
        {
          jobs: computeJobs,
          loading: computeJobsLoading,
          error: computeJobsError,
          observedAtMs: computeJobsObservedAtMs,
          collectionStale: computeJobsCollectionStale,
          coverage: computeJobsCoverage,
        },
        { nowMs: Date.now(), historyLimit: 200, cancellationByProvider }
      ),
    [
      cancellationByProvider,
      computeJobs,
      computeJobsError,
      computeJobsLoading,
      computeJobsObservedAtMs,
      computeJobsCollectionStale,
      computeJobsCoverage,
    ]
  );

  const agentJobs = useAgentJobsStore((state) => state.jobs);
  const agentJobCount = useAgentJobsStore((state) => state.jobCount);
  const activeAgentJobCount = useAgentJobsStore((state) => state.activeCount);
  const terminalAgentJobCount = useAgentJobsStore((state) => state.terminalCount);
  const agentJobsHistoryComplete = useAgentJobsStore((state) => state.historyComplete);
  const agentJobsLoading = useAgentJobsStore((state) => state.loading);
  const agentJobsError = useAgentJobsStore((state) => state.error);
  const agentJobsObservedAtMs = useAgentJobsStore((state) => state.observedAtMs);
  const agentJobsCollectionStale = useAgentJobsStore((state) => state.collectionStale);
  const refreshAgentJobs = useAgentJobsStore((state) => state.refresh);
  const agentJobsSnapshot = useMemo(
    () =>
      projectAgentJobsSnapshot(
        {
          jobs: agentJobs,
          jobCount: agentJobCount,
          activeCount: activeAgentJobCount,
          terminalCount: terminalAgentJobCount,
          historyComplete: agentJobsHistoryComplete,
          loading: agentJobsLoading,
          error: agentJobsError,
          observedAtMs: agentJobsObservedAtMs,
          collectionStale: agentJobsCollectionStale,
        },
        { nowMs: Date.now() }
      ),
    [
      activeAgentJobCount,
      agentJobCount,
      agentJobs,
      agentJobsError,
      agentJobsHistoryComplete,
      agentJobsLoading,
      agentJobsObservedAtMs,
      agentJobsCollectionStale,
      terminalAgentJobCount,
    ]
  );
  const jobsSnapshot = useMemo(
    () =>
      combineJobsSnapshots(
        [
          { label: 'Managed operations', snapshot: managedJobsSnapshot },
          ...(includeNativeJobs
            ? [
                { label: 'Hosted compute', snapshot: computeJobsSnapshot },
                { label: 'Agent jobs', snapshot: agentJobsSnapshot },
              ]
            : []),
        ],
        { nowMs: Date.now() }
      ),
    [agentJobsSnapshot, computeJobsSnapshot, includeNativeJobs, managedJobsSnapshot]
  );
  const jobsProjection = useMemo(() => projectJobsSnapshot(jobsSnapshot), [jobsSnapshot]);

  const latestJobs = useRef(jobsSnapshot);
  latestJobs.current = jobsSnapshot;
  const observationEpoch = useRef(0);
  const latestBinding = useRef<ObservationBinding>([
    hostedWorkspaceId,
    managedOperationsSnapshot.scopeId,
    managedOperationsSnapshot.ownerInstanceId,
    activeView,
  ]);
  latestBinding.current = [
    hostedWorkspaceId,
    managedOperationsSnapshot.scopeId,
    managedOperationsSnapshot.ownerInstanceId,
    activeView,
  ];

  const pendingStopObservations = useRef<PendingStopObservation[]>([]);
  const retireObservations = useCallback((reason: 'surface_closed' | 'runtime_changed') => {
    observationEpoch.current += 1;
    const pending = pendingStopObservations.current;
    pendingStopObservations.current = [];
    for (const item of pending)
      item.observed.record({
        phase: 'cancelled',
        result: reason,
        authority: 'not_attested',
        freshness: 'superseded',
      });
  }, []);
  const observeStopRecords = useCallback(() => {
    try {
      pendingStopObservations.current = pendingStopObservations.current.filter((item) => {
        if (
          item.epoch !== observationEpoch.current ||
          !sameObservationBinding(item.binding, latestBinding.current)
        ) {
          item.observed.record({
            phase: 'cancelled',
            result: 'runtime_changed',
            freshness: 'superseded',
          });
          return false;
        }
        const row = managementRow(latestJobs.current, item.owner);
        if (!row) {
          item.observed.record({
            phase: 'refused',
            result: 'owner_record_unavailable',
            authority: 'not_attested',
          });
          return false;
        }
        if (
          row.targetIdentity !== item.target ||
          row.inputRevision !== item.revision ||
          row.executionContext.ownerInstanceId !== item.instance
        ) {
          item.observed.record({
            phase: 'cancelled',
            result: 'owner_identity_changed',
            freshness: 'superseded',
          });
          return false;
        }
        if (
          !item.accepted ||
          row.observation.freshness !== 'current' ||
          row.executionContext.mode === 'recorded'
        )
          return true;
        const terminal = {
          cancelled: 'terminal_cancelled',
          succeeded: 'terminal_succeeded',
          failed: 'terminal_failed',
          interrupted: 'terminal_interrupted',
        } as const;
        if (!(row.state in terminal)) return true;
        item.observed.record({
          ...jobManagementContext(row),
          phase: 'observed',
          result: terminal[row.state as keyof typeof terminal],
          authority: 'owner_record',
        });
        return false;
      });
    } catch (ignoredError) {
      void ignoredError;
    }
  }, []);
  const beginManagement = useCallback(
    (action: JobManagementAction, owner: JobsSidebarOwnerRef): JobManagementObservation => {
      const epoch = observationEpoch.current;
      const binding = latestBinding.current;
      let value: JobManagementContext;
      try {
        value = jobManagementContext(managementRow(latestJobs.current, owner), owner.kind);
      } catch {
        value = jobManagementContext(undefined, owner.kind);
      }
      const observed = beginJobManagement(action, value);
      return {
        ...observed,
        settle(details) {
          observed.settle({
            ...details,
            ...(epoch === observationEpoch.current &&
            sameObservationBinding(binding, latestBinding.current)
              ? {}
              : { freshness: 'superseded' as const }),
          });
        },
      };
    },
    []
  );
  const rememberStop = useCallback(
    (owner: JobsSidebarOwnerRef, observed: JobManagementObservation) => {
      try {
        const row = managementRow(latestJobs.current, owner);
        if (
          !observed.id ||
          !row ||
          row.observation.freshness !== 'current' ||
          row.executionContext.mode === 'recorded' ||
          !row.canStop ||
          !['queued', 'running'].includes(row.state)
        )
          return;
        pendingStopObservations.current = pendingStopObservations.current.filter((item) => {
          if (item.owner.kind !== owner.kind || item.owner.nativeId !== owner.nativeId) return true;
          item.observed.record({
            phase: 'cancelled',
            result: 'superseded',
            freshness: 'superseded',
          });
          return false;
        });
        pendingStopObservations.current.push({
          owner: { ...owner },
          observed,
          accepted: false,
          epoch: observationEpoch.current,
          binding: latestBinding.current,
          target: row.targetIdentity,
          revision: row.inputRevision,
          instance: row.executionContext.ownerInstanceId,
        });
      } catch (ignoredError) {
        void ignoredError;
      }
    },
    []
  );
  const finishStop = useCallback(
    (observed: JobManagementObservation, accepted: boolean) => {
      try {
        const item = pendingStopObservations.current.find(
          (candidate) => candidate.observed === observed
        );
        if (item && accepted) {
          item.accepted = true;
          observeStopRecords();
          return;
        }
        pendingStopObservations.current = pendingStopObservations.current.filter(
          (candidate) => candidate.observed !== observed
        );
        observed.record({
          phase: 'result',
          result: 'terminal_not_attested',
          authority: 'not_attested',
        });
      } catch (ignoredError) {
        void ignoredError;
      }
    },
    [observeStopRecords]
  );
  const currentCollectionContext = useCallback((): JobManagementContext => {
    try {
      const managed = managedOperations.getSnapshot();
      const compute = useComputeJobsStore.getState();
      const agent = useAgentJobsStore.getState();
      const current =
        managed.status === 'connected' &&
        managed.records.every((record) => record.observation.freshness === 'current') &&
        (!includeNativeJobs ||
          (compute.coverage?.activeComplete === true &&
            !compute.loading &&
            !compute.error &&
            !compute.collectionStale &&
            compute.observedAtMs !== null &&
            !agent.loading &&
            !agent.error &&
            !agent.collectionStale &&
            agent.observedAtMs !== null));
      const times = (
        includeNativeJobs
          ? [compute.observedAtMs, agent.observedAtMs]
          : managed.records.map((record) => record.observation.observedAtMs)
      ).filter((value): value is number => value !== null && Number.isFinite(value));
      return {
        owner: 'federated',
        freshness: current ? 'current' : 'stale',
        mode: 'unknown',
        availability: 'unknown',
        state: 'unknown',
        ...(times.length ? { observedAtMs: Math.min(...times) } : {}),
      };
    } catch {
      return {
        owner: 'federated',
        freshness: 'unknown',
        mode: 'unknown',
        availability: 'unknown',
        state: 'unknown',
      };
    }
  }, [includeNativeJobs]);
  useEffect(() => {
    if (activeView !== 'jobs') retireObservations('surface_closed');
  }, [activeView, retireObservations]);
  useEffect(() => {
    retireObservations('runtime_changed');
  }, [
    hostedWorkspaceId,
    managedOperationsSnapshot.scopeId,
    managedOperationsSnapshot.ownerInstanceId,
    retireObservations,
  ]);
  useEffect(observeStopRecords, [jobsSnapshot, observeStopRecords]);
  useEffect(() => () => retireObservations('surface_closed'), [retireObservations]);

  const handleStopWorkflow = useCallback(
    (owner: JobsSidebarOwnerRef) => {
      const observed = beginManagement('stop', owner);
      rememberStop(owner, observed);
      if (owner.kind === 'hosted-compute') {
        void (async () => {
          const job = useComputeJobsStore
            .getState()
            .jobs.find((candidate) => candidate.id === owner.nativeId);
          if (!job) {
            observed.settle({ phase: 'refused', result: 'owner_record_unavailable' });
            throw new Error('This hosted job is no longer in the local job registry.');
          }
          const confirmed = await confirmDialog({
            title: userMessage('dialog.stop-hosted-compute-job'),
            message: userMessage('jobs.cancelConfirm'),
            confirmLabel: userMessage('dialog.stop-job'),
            cancelLabel: userMessage('dialog.keep-running'),
            tone: 'danger',
            safeDefault: true,
          });
          observed.confirm(confirmed);
          if (!confirmed) {
            observed.settle({
              phase: 'cancelled',
              result: 'confirmation_cancelled',
              authority: 'surface',
            });
            finishStop(observed, false);
            return;
          }
          await cancelHostedComputeJob(job);
          observed.settle({ phase: 'accepted', result: 'stop_accepted', authority: 'owner_ack' });
          finishStop(observed, true);
          useToastStore.getState().addToast(userMessage('notice.hosted-compute-job-stopped'), {
            definition: 'app-hosted-compute-job-stopped',
          });
        })().catch((error: unknown) => {
          observed.settle({ phase: 'error', result: 'request_rejected' });
          finishStop(observed, false);
          useToastStore
            .getState()
            .addToast(toUserMessage(error, 'failure.could-not-stop-the-job'), {
              definition: 'app-could-not-stop-the-job',
            });
        });
        return;
      }
      let request:
        | ReturnType<typeof managedOperations.requestCancel>
        | ReturnType<ReturnType<typeof useAgentJobsStore.getState>['cancel']>
        | null;
      try {
        request =
          owner.kind === 'managed-operation'
            ? managedOperations.requestCancel(owner.nativeId)
            : owner.kind === 'agent-action'
              ? useAgentJobsStore.getState().cancel(owner.nativeId)
              : null;
      } catch (error) {
        observed.settle({ phase: 'error', result: 'request_rejected' });
        finishStop(observed, false);
        throw error;
      }
      if (!request) {
        observed.settle({ phase: 'refused', result: 'unsupported_owner' });
        finishStop(observed, false);
        return;
      }
      void request
        .then((response) => {
          if (owner.kind === 'managed-operation') {
            try {
              const receipt = response as Awaited<
                ReturnType<typeof managedOperations.requestCancel>
              >;
              if (receipt.snapshot.id !== owner.nativeId) {
                observed.settle({ phase: 'refused', result: 'owner_identity_changed' });
                finishStop(observed, false);
                return;
              }
              const accepted =
                receipt.disposition === 'accepted' || receipt.disposition === 'already_requested';
              observed.settle({
                phase: accepted ? 'accepted' : 'refused',
                result:
                  receipt.disposition === 'accepted'
                    ? 'stop_accepted'
                    : receipt.disposition === 'already_requested'
                      ? 'stop_already_requested'
                      : receipt.disposition === 'already_settled'
                        ? 'stop_already_settled'
                        : 'stop_unavailable',
                authority: 'owner_ack',
              });
              finishStop(observed, accepted);
            } catch {
              observed.settle({
                phase: 'refused',
                result: 'terminal_not_attested',
                authority: 'not_attested',
              });
              finishStop(observed, false);
            }
          } else {
            observed.settle({ phase: 'accepted', result: 'stop_accepted', authority: 'owner_ack' });
            finishStop(observed, true);
          }
        })
        .catch((error: unknown) => {
          observed.settle({ phase: 'error', result: 'request_rejected' });
          finishStop(observed, false);
          useToastStore
            .getState()
            .addToast(toUserMessage(error, 'failure.could-not-stop-the-job'), {
              definition: 'app-could-not-stop-the-job',
            });
        });
    },
    [beginManagement, finishStop, rememberStop]
  );

  const handleImportWorkflowResult = useCallback(
    (owner: JobsSidebarOwnerRef) => {
      const observed = beginManagement('import', owner);
      if (owner.kind !== 'hosted-compute') {
        observed.settle({ phase: 'refused', result: 'unsupported_owner' });
        return;
      }
      void (async () => {
        const job = useComputeJobsStore
          .getState()
          .jobs.find((candidate) => candidate.id === owner.nativeId);
        if (!job) throw new Error('This hosted job is no longer in the local job registry.');
        const imported = await importHostedComputeJob(job, useWorkspaceStore.getState().folders);
        observed.settle({
          phase: imported === true ? 'result' : 'refused',
          result: imported === true ? 'import_returned_true' : 'import_not_applied',
          authority: 'adapter_return',
        });
      })().catch((error: unknown) => {
        observed.settle({ phase: 'error', result: 'request_rejected' });
        useToastStore
          .getState()
          .addToast(toUserMessage(error, 'failure.could-not-import-the-hosted-job-result'), {
            definition: 'app-could-not-import-the-hosted-job-result',
          });
      });
    },
    [beginManagement]
  );

  const handleOpenWorkflowResult = useCallback(
    (owner: JobsSidebarOwnerRef) => {
      const observed = beginManagement('open', owner);
      if (owner.kind === 'hosted-compute') {
        void (async () => {
          const job = useComputeJobsStore
            .getState()
            .jobs.find((candidate) => candidate.id === owner.nativeId);
          if (!job) throw new Error('This hosted job is no longer in the local job registry.');
          const opened = await openHostedComputeResult(job, useWorkspaceStore.getState().folders);
          observed.settle({
            phase:
              opened?.status === 'presented'
                ? 'result'
                : opened?.status === 'cancelled'
                  ? 'cancelled'
                  : 'refused',
            result:
              opened?.status === 'presented'
                ? 'open_presented'
                : opened?.status === 'cancelled'
                  ? 'open_cancelled'
                  : opened
                    ? 'open_refused'
                    : 'open_unavailable',
            authority: 'presenter_return',
          });
        })().catch((error: unknown) => {
          observed.settle({ phase: 'error', result: 'request_rejected' });
          useToastStore
            .getState()
            .addToast(toUserMessage(error, 'failure.could-not-open-the-hosted-job-result'), {
              definition: 'app-could-not-open-the-hosted-job-result',
            });
        });
        return;
      }
      if (owner.kind !== 'managed-operation') {
        observed.settle({ phase: 'refused', result: 'unsupported_owner' });
        return;
      }
      void (async () => {
        const operation = await managedOperations.getOperation(owner.nativeId);
        const presenter = registeredOperationPresenter(operation.kind, operationPresenters);
        if (!presenter?.openResult || !presenter.canOpenResult(operation)) {
          throw new Error('This job result has no available application view.');
        }
        await presenter.openResult(operation);
        observed.settle({
          phase: operation.id === owner.nativeId ? 'result' : 'refused',
          result:
            operation.id === owner.nativeId
              ? 'presenter_returned_not_attested'
              : 'owner_identity_changed',
          authority: 'presenter_return',
        });
      })().catch((error: unknown) => {
        observed.settle({ phase: 'error', result: 'request_rejected' });
        useToastStore
          .getState()
          .addToast(toUserMessage(error, 'failure.could-not-open-the-job-result'), {
            definition: 'app-could-not-open-the-job-result',
          });
      });
    },
    [beginManagement, operationPresenters]
  );

  const handleReleaseWorkflowResult = useCallback(
    (owner: JobsSidebarOwnerRef) => {
      const observed = beginManagement('release', owner);
      if (owner.kind !== 'managed-operation') {
        observed.settle({ phase: 'refused', result: 'unsupported_owner' });
        return;
      }
      void (async () => {
        const confirmed = await confirmDialog({
          title: userMessage('dialog.release-retained-result'),
          message: userMessage(
            'dialog.this-permanently-deletes-the-retained-scientific-output-for-this-job-i'
          ),
          confirmLabel: userMessage('dialog.release-result'),
          cancelLabel: userMessage('dialog.keep-result'),
          tone: 'danger',
          safeDefault: true,
        });
        observed.confirm(confirmed);
        if (!confirmed) {
          observed.settle({
            phase: 'cancelled',
            result: 'confirmation_cancelled',
            authority: 'surface',
          });
          return;
        }
        const response = await managedOperations.releaseResult(owner.nativeId);
        try {
          const same = response.snapshot.id === owner.nativeId;
          observed.settle({
            phase: !same || response.disposition === 'unavailable' ? 'refused' : 'result',
            result: !same
              ? 'owner_identity_changed'
              : response.disposition === 'released'
                ? 'release_returned'
                : response.disposition === 'already_released'
                  ? 'already_released'
                  : 'release_unavailable',
            authority: 'owner_ack',
            availability: same ? (response.snapshot.result_status ?? 'none') : 'unknown',
          });
        } catch {
          observed.settle({
            phase: 'refused',
            result: 'terminal_not_attested',
            authority: 'not_attested',
          });
        }
        useToastStore.getState().addToast(toUserMessage(response.reason), {
          definition: 'job-release-result',
          variant: response.disposition === 'unavailable' ? 'error' : 'success',
        });
      })().catch((error: unknown) => {
        observed.settle({ phase: 'error', result: 'request_rejected' });
        useToastStore
          .getState()
          .addToast(toUserMessage(error, 'failure.could-not-release-the-job-result'), {
            definition: 'app-could-not-release-the-job-result',
          });
      });
    },
    [beginManagement]
  );

  const handleReconnectWorkflowOwners = useCallback(() => {
    const observed = beginJobManagement('reconnect', currentCollectionContext());
    const epoch = observationEpoch.current;
    const binding = latestBinding.current;
    void Promise.all([
      managedOperations.reconnect(),
      ...(includeNativeJobs
        ? [refreshComputeJobs({ limit: 200 }), refreshComputeProviders(), refreshAgentJobs()]
        : []),
    ])
      .then(() => {
        const same =
          epoch === observationEpoch.current &&
          sameObservationBinding(binding, latestBinding.current);
        observed.settle({
          phase: 'result',
          result: 'reconnect_returned',
          authority: 'request_return',
          ...(same ? {} : { freshness: 'superseded' as const }),
        });
        if (!same) {
          observed.record({
            phase: 'cancelled',
            result: 'runtime_changed',
            freshness: 'superseded',
          });
          return;
        }
        const current = currentCollectionContext();
        observed.record({
          ...current,
          phase: 'observed',
          result: current.freshness === 'current' ? 'collection_current' : 'collection_unavailable',
          authority: 'owner_record',
        });
      })
      .catch((error: unknown) => {
        observed.settle({ phase: 'error', result: 'request_rejected' });
        useToastStore
          .getState()
          .addToast(toUserMessage(error, 'failure.could-not-reconnect-jobs'), {
            definition: 'app-could-not-reconnect-jobs',
          });
      });
  }, [
    currentCollectionContext,
    includeNativeJobs,
    refreshAgentJobs,
    refreshComputeJobs,
    refreshComputeProviders,
  ]);

  const handleLoadWorkflowActions = useCallback(async (owner: JobsSidebarOwnerRef) => {
    if (owner.kind !== 'managed-operation') {
      throw new Error('This workflow owner does not expose action history.');
    }
    const history = projectManagedOperationActionPage(
      await managedOperations.getActions(owner.nativeId)
    );
    const record = managedOperations
      .getSnapshot()
      .records.find(({ snapshot }) => snapshot.id === owner.nativeId);
    if (
      record?.snapshot.origin !== 'managed' ||
      record.snapshot.kind !== 'pairwise-session-alignment' ||
      record.snapshot.result_status !== 'available'
    ) {
      return history;
    }

    const result = await managedOperations.getResult(owner.nativeId);
    if (
      result.operation_id !== owner.nativeId ||
      result.kind !== record.snapshot.kind ||
      result.status !== 'available' ||
      !isPairwiseSessionAlignmentResult(result.result, result.result_schema_version) ||
      result.result.inputRevision !== record.snapshot.subject.input_revision
    ) {
      throw new Error('The operation owner returned different alignment result details.');
    }
    if (result.result.tool) {
      return {
        ...history,
        toolVersion: `${result.result.tool.name} ${result.result.tool.version}`,
      };
    }
    if (result.result_schema_version !== 1) {
      throw new Error('The retained alignment result is missing its execution tool identity.');
    }
    return history;
  }, []);

  const canImportRecordedRun =
    managedOperationsSnapshot.status === 'connected' &&
    managedOperationsSnapshot.supportedActionsByKind?.annotation?.includes('import_recorded') ===
      true;
  const handleImportRecordedRun = useCallback(() => {
    if (importingRecordedRun) return;
    const observed = beginJobManagement('record_completed', {
      owner: 'managed-operation',
      mode: 'recorded',
    });
    setImportingRecordedRun(true);
    void recordSelectedAnnotationReceipt(recordedReceiptDependencies(managedOperations.getSnapshot))
      .then((result) => {
        observed.settle({
          phase: result.status === 'recorded' ? 'result' : 'cancelled',
          result:
            result.status === 'recorded' ? 'recorded_history_added' : 'record_picker_cancelled',
          authority: result.status === 'recorded' ? 'owner_ack' : 'surface',
          mode: 'recorded',
          state: result.status === 'recorded' ? 'succeeded' : 'unknown',
        });
        if (result.status === 'recorded') {
          useToastStore.getState().addToast(userMessage('notice.completed-run-recorded-in-jobs'), {
            definition: 'app-completed-run-recorded-in-jobs',
          });
        }
      })
      .catch((error: unknown) => {
        observed.settle({ phase: 'error', result: 'request_rejected' });
        useToastStore
          .getState()
          .addToast(toUserMessage(error, 'failure.could-not-record-the-completed-run'), {
            definition: 'app-could-not-record-the-completed-run',
          });
      })
      .finally(() => setImportingRecordedRun(false));
  }, [importingRecordedRun]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    return managedOperations.attach(managedOperationsRuntimeSource);
  }, []);
  useEffect(() => {
    if (!isHostedBrowserRuntime() || !hostedWorkspaceId) return;
    return managedOperations.attach(createHostedManagedOperationsRuntimeSource(hostedWorkspaceId));
  }, [hostedWorkspaceId]);
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const retire = () => {
      retireObservations('runtime_changed');
      useComputeJobsStore.getState().invalidateRuntime();
      useAgentJobsStore.getState().invalidateRuntime();
    };
    const refresh = () =>
      void Promise.all([
        refreshComputeJobs({ limit: 200 }),
        refreshComputeProviders(),
        refreshAgentJobs(),
      ]);

    const unsubscribe = platform().on('sidecar:status', (status) => {
      retire();
      if (status === 'ready') refresh();
    });
    refresh();
    return () => {
      unsubscribe();
      retire();
    };
  }, [refreshAgentJobs, refreshComputeJobs, refreshComputeProviders, retireObservations]);
  useEffect(() => {
    if (!isDesktopRuntime() || activeView !== 'jobs') return;
    const refresh = () =>
      void Promise.all([refreshComputeJobs({ limit: 200 }), refreshAgentJobs()]);
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [activeView, refreshAgentJobs, refreshComputeJobs]);

  return {
    jobsSnapshot,
    jobsProjection,
    importingRecordedRun,
    canImportRecordedRun,
    handleStopWorkflow,
    handleImportWorkflowResult,
    handleOpenWorkflowResult,
    handleReleaseWorkflowResult,
    handleReconnectWorkflowOwners,
    handleLoadWorkflowActions,
    handleImportRecordedRun,
  };
}
