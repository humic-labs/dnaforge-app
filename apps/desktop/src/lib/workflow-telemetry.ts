import type {
  WorkflowResultMetadata,
  WorkflowCountBucket,
  WorkflowActionInput,
  WorkflowOperation,
} from '../shared/workflow-operation';
export type {
  WorkflowResultMetadata,
  WorkflowCountBucket,
  WorkflowActionInput,
  WorkflowOperation,
} from '../shared/workflow-operation';
import {
  getMeaningfulActivityAuthority,
  getAnalyticsIdentifiedAccountId,
  isAnalyticsIdentityIdentified,
  subscribeAnalyticsCaptureReady,
  trackRendererEvent,
  type MeaningfulActivityActorKind,
  type MeaningfulActivityExecutionMode,
} from './analytics';
import {
  deliverPendingMeaningfulActivityReceipts,
  storePendingMeaningfulActivityReceipt,
  type PendingMeaningfulActivityInput,
} from './meaningful-activity-pending';
import { getTelemetryCorrelationContext } from './telemetry-correlation';
import {
  isQualifyingMeaningfulActivity,
  MEANINGFUL_ACTIVITY_COMPLETED,
} from '../shared/meaningful-activity.generated';
import type {
  ScientificWorkflow,
  ScientificWorkflowAction,
  WorkflowStatus,
} from '../shared/scientific-workflow-vocab';
import { tableObservationProperties } from '../shared/table-notebook-observation';

export type {
  ScientificWorkflow,
  ScientificWorkflowAction,
  WorkflowStatus,
} from '../shared/scientific-workflow-vocab';

export const WORKFLOW_ACTION_OBSERVED = 'workflow_action_observed' as const;
type WorkflowTelemetryEvent =
  | typeof WORKFLOW_ACTION_OBSERVED
  | 'loop_suppressed'
  | typeof MEANINGFUL_ACTIVITY_COMPLETED;

export function workflowCountBucket(count: number): WorkflowCountBucket {
  if (!Number.isFinite(count) || count < 0) return 'unknown';
  if (count === 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 20) return '6_20';
  if (count <= 100) return '21_100';
  return '100_plus';
}

interface WorkflowTelemetryDependencies {
  createId?: () => string;
  now?: () => number;
  track?: (event: WorkflowTelemetryEvent, properties: Record<string, unknown>) => boolean;
  isIdentified?: () => boolean;
  activityAuthority?: () => {
    actorKind: MeaningfulActivityActorKind;
    executionMode: MeaningfulActivityExecutionMode;
    impersonated: boolean;
  };
  storePending?: (receipt: PendingMeaningfulActivityInput) => Promise<void>;
}

const MAX_DURATION_MS = 86_400_000;
const openWorkflowActions = new Set<WorkflowOperation>();
type WorkflowTrack = NonNullable<WorkflowTelemetryDependencies['track']>;
const observationWindows = new WeakMap<
  WorkflowTrack,
  Map<string, { times: number[]; diagnosedAt?: number }>
>();

function captureWorkflowObservation(
  track: WorkflowTrack,
  properties: Record<string, unknown>,
  now: number
): { accepted: boolean; suppressed: boolean } {
  const failed = properties.action_phase === 'error' || properties.success === false;
  let windows = observationWindows.get(track);
  if (!windows) {
    windows = new Map();
    observationWindows.set(track, windows);
  }
  const origin = properties.workflow_origin ?? 'direct';
  const key = JSON.stringify([
    properties.workflow,
    properties.workflow_action,
    origin,
    ...(failed ? ['error', properties.error_class ?? 'unknown'] : []),
  ]);
  let group = windows.get(key);
  if (!group) {
    group = { times: [] };
    windows.set(key, group);
  }
  group.times = group.times.filter((time) => now - time < 60_000);
  if (group.times.length >= 60) {
    if (group.diagnosedAt === undefined || now - group.diagnosedAt >= 60_000) {
      if (
        track('loop_suppressed', {
          feature_area: 'scientific_workflow',
          workflow: properties.workflow,
          workflow_action: properties.workflow_action,
          workflow_origin: origin,
          ...(failed
            ? {
                success: false,
                workflow_status: properties.workflow_status,
                error_class: properties.error_class ?? 'unknown',
              }
            : {}),
        })
      )
        group.diagnosedAt = now;
    }
    return { accepted: false, suppressed: true };
  }
  const accepted = track(WORKFLOW_ACTION_OBSERVED, properties);
  if (accepted) group.times.push(now);
  return { accepted, suppressed: false };
}

export function abandonOpenWorkflowActions(): number {
  let abandoned = 0;
  for (const operation of [...openWorkflowActions]) {
    if (operation.cancel({ status: 'abandoned' })) abandoned += 1;
  }
  openWorkflowActions.clear();
  return abandoned;
}

export function beginWorkflowAction(
  input: WorkflowActionInput,
  dependencies: WorkflowTelemetryDependencies = {}
): WorkflowOperation {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? (() => crypto.randomUUID());
  const track = dependencies.track ?? trackRendererEvent;
  const isIdentified = dependencies.isIdentified ?? isAnalyticsIdentityIdentified;
  const activityAuthority = dependencies.activityAuthority ?? getMeaningfulActivityAuthority;
  const storePending = dependencies.storePending ?? storePendingMeaningfulActivityReceipt;
  const actionId = input.actionId ?? createId();
  const startedAt = now();
  const correlation = getTelemetryCorrelationContext();
  const joinProperties = {
    app_session_id: correlation.appSessionId,
    episode_correlation_id: correlation.episodeCorrelationId,
  };
  let consumed = false;

  const startCapture = captureWorkflowObservation(
    track,
    {
      feature_area: 'scientific_workflow',
      workflow: input.workflow,
      workflow_action: input.action,
      action_phase: 'start',
      action_id: actionId,
      occurred_at_ms: startedAt,
      workflow_status: 'started',
      ...optionalCorrelationProperties(input),
      ...(input.tableObservation ? tableObservationProperties(input.tableObservation) : {}),
      ...(input.capturedRevision !== undefined
        ? { captured_revision: input.capturedRevision }
        : {}),
      ...joinProperties,
    },
    startedAt
  );
  const startAccepted = startCapture.accepted;

  const terminal = (
    phase: 'result' | 'error' | 'cancel',
    success: boolean,
    metadata: WorkflowResultMetadata = {},
    errorClass?: string
  ): boolean => {
    if (consumed) return false;
    consumed = true;
    openWorkflowActions.delete(operation);
    if (!startAccepted && !(startCapture.suppressed && phase === 'error')) return false;
    const terminalAt = now();
    const workflowStatus =
      metadata.status ?? (phase === 'cancel' ? 'cancelled' : success ? 'success' : 'failed');
    const { accepted } = captureWorkflowObservation(
      track,
      {
        feature_area: 'scientific_workflow',
        workflow: input.workflow,
        workflow_action: input.action,
        action_phase: phase,
        action_id: actionId,
        effect_id: createId(),
        occurred_at_ms: terminalAt,
        duration_ms: boundedDuration(terminalAt - startedAt),
        workflow_status: workflowStatus,
        success,
        ...optionalResultProperties({ ...input, ...metadata }, errorClass),
        ...joinProperties,
      },
      terminalAt
    );
    if (
      accepted &&
      input.initiator !== 'system' &&
      input.workflowOrigin !== 'projection' &&
      metadata.recordWriteStatus !== 'existing'
    ) {
      projectMeaningfulActivity(
        {
          workflow: input.workflow,
          action: input.action,
          status: workflowStatus,
          success,
          valueDelivered: metadata.valueDelivered,
          usableResult: metadata.usableResult,
          selectedCount: metadata.selectedCount,
          initiatedAtMs: startedAt,
          qualifiedAtMs: terminalAt,
          actionId,
          appSessionId: correlation.appSessionId,
        },
        track,
        isIdentified,
        activityAuthority,
        storePending
      );
    }
    return accepted;
  };

  const operation: WorkflowOperation = {
    actionId,
    get startAccepted() {
      return startAccepted;
    },
    get consumed() {
      return consumed;
    },
    complete: (metadata) => terminal('result', true, metadata),
    fail: (errorClass = 'unknown', metadata) =>
      terminal('error', false, metadata, normalizeErrorClass(errorClass)),
    cancel: (metadata) => terminal('cancel', false, metadata),
  };
  if (startAccepted) openWorkflowActions.add(operation);
  return operation;
}

export function observeWorkflowAction(
  input: WorkflowActionInput & {
    phase?: 'result' | 'commit';
    success?: boolean;
    errorClass?: string;
    initiatedAtMs?: number;
  },
  dependencies: WorkflowTelemetryDependencies = {}
): boolean {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? (() => crypto.randomUUID());
  const track = dependencies.track ?? trackRendererEvent;
  const isIdentified = dependencies.isIdentified ?? isAnalyticsIdentityIdentified;
  const activityAuthority = dependencies.activityAuthority ?? getMeaningfulActivityAuthority;
  const storePending = dependencies.storePending ?? storePendingMeaningfulActivityReceipt;
  const correlation = getTelemetryCorrelationContext();
  const occurredAtMs = now();
  const initiatedAtMs =
    Number.isSafeInteger(input.initiatedAtMs) &&
    (input.initiatedAtMs as number) >= 0 &&
    (input.initiatedAtMs as number) <= occurredAtMs
      ? (input.initiatedAtMs as number)
      : occurredAtMs;
  const actionId = input.actionId ?? createId();
  const workflowStatus = input.status ?? (input.success === false ? 'failed' : 'success');
  const success = input.success ?? true;
  const { accepted } = captureWorkflowObservation(
    track,
    {
      feature_area: 'scientific_workflow',
      workflow: input.workflow,
      workflow_action: input.action,
      action_phase: input.phase ?? 'commit',
      action_id: actionId,
      effect_id: createId(),
      occurred_at_ms: occurredAtMs,
      workflow_status: workflowStatus,
      success,
      ...optionalResultProperties(
        input,
        input.errorClass ? normalizeErrorClass(input.errorClass) : undefined
      ),
      app_session_id: correlation.appSessionId,
      episode_correlation_id: correlation.episodeCorrelationId,
    },
    occurredAtMs
  );
  if (
    accepted &&
    input.initiator !== 'system' &&
    input.workflowOrigin !== 'projection' &&
    input.recordWriteStatus !== 'existing'
  ) {
    projectMeaningfulActivity(
      {
        workflow: input.workflow,
        action: input.action,
        status: workflowStatus,
        success,
        valueDelivered: input.valueDelivered,
        usableResult: input.usableResult,
        selectedCount: input.selectedCount,
        initiatedAtMs,
        qualifiedAtMs: occurredAtMs,
        actionId,
        appSessionId: correlation.appSessionId,
      },
      track,
      isIdentified,
      activityAuthority,
      storePending
    );
  }
  return accepted;
}

export async function runWorkflowAction<T>(
  input: WorkflowActionInput,
  run: () => Promise<T>,
  resultMetadata: (result: T) => WorkflowResultMetadata = () => ({ status: 'success' })
): Promise<T> {
  const operation = beginWorkflowAction(input);
  try {
    const result = await run();
    operation.complete(resultMetadata(result));
    return result;
  } catch (error) {
    operation.fail(errorClassFor(error));
    throw error;
  }
}

function boundedDuration(durationMs: number): number {
  return Math.min(MAX_DURATION_MS, Math.max(0, Math.round(durationMs)));
}

function optionalResultProperties(
  metadata: WorkflowResultMetadata,
  errorClass?: string
): Record<string, number | boolean | string> {
  return {
    ...optionalCorrelationProperties(metadata),
    ...(metadata.tableObservation ? tableObservationProperties(metadata.tableObservation) : {}),
    ...(metadata.digestTopology ? { digest_topology: metadata.digestTopology } : {}),
    ...(metadata.digestReadiness ? { digest_readiness: metadata.digestReadiness } : {}),
    ...(metadata.digestTrigger ? { digest_trigger: metadata.digestTrigger } : {}),
    ...(metadata.digestCutCount !== undefined ? { digest_cut_count: metadata.digestCutCount } : {}),
    ...(metadata.digestEnzymeCount !== undefined
      ? { digest_enzyme_count: metadata.digestEnzymeCount }
      : {}),
    ...(metadata.recordWriteStatus ? { record_write_status: metadata.recordWriteStatus } : {}),
    ...(metadata.recordProjectionStatus
      ? { record_projection_status: metadata.recordProjectionStatus }
      : {}),
    ...(metadata.recordHistoryStatus
      ? { record_history_status: metadata.recordHistoryStatus }
      : {}),
    ...(metadata.outcomeKind !== undefined ? { outcome_kind: metadata.outcomeKind } : {}),
    ...(metadata.resultCount !== undefined ? { result_count: metadata.resultCount } : {}),
    ...(metadata.selectedCount !== undefined ? { selected_count: metadata.selectedCount } : {}),
    ...(metadata.affectedCount !== undefined ? { affected_count: metadata.affectedCount } : {}),
    ...(metadata.stateRevision !== undefined ? { state_revision: metadata.stateRevision } : {}),
    ...(metadata.cached !== undefined ? { cached: metadata.cached } : {}),
    ...(metadata.valueDelivered !== undefined ? { value_delivered: metadata.valueDelivered } : {}),
    ...(metadata.usableResult !== undefined ? { usable_result: metadata.usableResult } : {}),
    ...(metadata.resultRank !== undefined ? { result_rank: metadata.resultRank } : {}),
    ...(metadata.basesInsertedBucket
      ? { bases_inserted_bucket: metadata.basesInsertedBucket }
      : {}),
    ...(metadata.basesDeletedBucket ? { bases_deleted_bucket: metadata.basesDeletedBucket } : {}),
    ...(metadata.basesSubstitutedBucket
      ? { bases_substituted_bucket: metadata.basesSubstitutedBucket }
      : {}),
    ...(metadata.saveAttemptCount !== undefined
      ? { save_attempt_count: metadata.saveAttemptCount }
      : {}),
    ...(metadata.attemptCount !== undefined ? { attempt_count: metadata.attemptCount } : {}),
    ...(metadata.wrote !== undefined ? { wrote: metadata.wrote } : {}),
    ...(metadata.dirty !== undefined ? { dirty: metadata.dirty } : {}),
    ...(metadata.capturedRevision !== undefined
      ? { captured_revision: metadata.capturedRevision }
      : {}),
    ...(metadata.acknowledgedRevision !== undefined
      ? { acknowledged_revision: metadata.acknowledgedRevision }
      : {}),
    ...(metadata.revisionRelation !== undefined
      ? { revision_relation: metadata.revisionRelation }
      : {}),
    ...(errorClass !== undefined ? { error_class: errorClass } : {}),
  };
}

function optionalCorrelationProperties(
  metadata: WorkflowResultMetadata
): Record<string, string | number> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return {
    ...(metadata.assemblyComputeStage
      ? { assembly_compute_stage: metadata.assemblyComputeStage }
      : {}),
    ...(metadata.assemblyMaterialRoute
      ? { assembly_material_route: metadata.assemblyMaterialRoute }
      : {}),
    ...(metadata.pcrTemplateCount !== undefined
      ? { pcr_template_count: metadata.pcrTemplateCount }
      : {}),
    ...(metadata.assemblyMethod ? { assembly_method: metadata.assemblyMethod } : {}),
    ...(metadata.exportFormat ? { export_format: metadata.exportFormat } : {}),
    ...(metadata.fileTypeCategory ? { file_type_category: metadata.fileTypeCategory } : {}),
    ...(metadata.agentToolName ? { agent_tool_name: metadata.agentToolName } : {}),
    ...(metadata.workflowOrigin ? { workflow_origin: metadata.workflowOrigin } : {}),
    ...(metadata.parentActionId && uuid.test(metadata.parentActionId)
      ? { parent_action_id: metadata.parentActionId.toLowerCase() }
      : {}),
    ...(metadata.searchEpisodeId && uuid.test(metadata.searchEpisodeId)
      ? { search_episode_id: metadata.searchEpisodeId.toLowerCase() }
      : {}),
    ...(Number.isSafeInteger(metadata.searchQueryRevision) &&
    (metadata.searchQueryRevision as number) > 0
      ? { search_query_revision: metadata.searchQueryRevision as number }
      : {}),
    ...(metadata.searchActivityRole !== undefined
      ? { search_activity_role: metadata.searchActivityRole }
      : {}),
    ...(metadata.operationId && uuid.test(metadata.operationId)
      ? { operation_id: metadata.operationId.toLowerCase() }
      : {}),
    ...(metadata.nativeActionId && uuid.test(metadata.nativeActionId)
      ? { native_action_id: metadata.nativeActionId.toLowerCase() }
      : {}),
    ...(metadata.artifactCorrelationId && uuid.test(metadata.artifactCorrelationId)
      ? { artifact_correlation_id: metadata.artifactCorrelationId.toLowerCase() }
      : {}),
  };
}

function projectMeaningfulActivity(
  input: {
    workflow: ScientificWorkflow;
    action: ScientificWorkflowAction;
    status: WorkflowStatus;
    success: boolean;
    valueDelivered?: boolean;
    usableResult?: boolean;
    selectedCount?: number;
    initiatedAtMs: number;
    qualifiedAtMs: number;
    actionId: string;
    appSessionId: string;
  },
  track: (event: WorkflowTelemetryEvent, properties: Record<string, unknown>) => boolean,
  isIdentified: () => boolean,
  activityAuthority: () => {
    actorKind: MeaningfulActivityActorKind;
    executionMode: MeaningfulActivityExecutionMode;
    impersonated: boolean;
  },
  storePending: (receipt: PendingMeaningfulActivityInput) => Promise<void>
): void {
  if (!isQualifyingMeaningfulActivity(input)) return;
  const authority = activityAuthority();
  if (
    authority.actorKind === 'test' ||
    authority.executionMode !== 'interactive' ||
    authority.impersonated
  ) {
    return;
  }
  if (!isIdentified()) {
    void storePending({
      actionId: input.actionId,
      workflow: input.workflow,
      action: input.action,
      status: input.status,
      initiatedAtMs: input.initiatedAtMs,
      qualifiedAtMs: input.qualifiedAtMs,
      valueDelivered: input.valueDelivered,
      usableResult: input.usableResult,
      selectedCount: input.selectedCount,
      appSessionId: input.appSessionId,
    }).catch(() => undefined);
    return;
  }
  if (authority.actorKind !== 'external' && authority.actorKind !== 'internal') {
    return;
  }
  track(MEANINGFUL_ACTIVITY_COMPLETED, {
    feature_area: 'scientific_workflow',
    workflow: input.workflow,
    workflow_action: input.action,
    workflow_status: input.status,
    identity_kind: 'identified',
    actor_kind: authority.actorKind,
    execution_mode: authority.executionMode,
    workspace_kind: 'unknown',
    historical: false,
    identity_resolution: 'direct_session',
    impersonated: authority.impersonated,
    action_id: input.actionId,
    $insert_id: input.actionId,
    initiated_at_ms: input.initiatedAtMs,
    qualified_at_ms: input.qualifiedAtMs,
    ...(input.valueDelivered !== undefined ? { value_delivered: input.valueDelivered } : {}),
    ...(input.usableResult !== undefined ? { usable_result: input.usableResult } : {}),
  });
}

export async function flushCurrentSessionPendingMeaningfulActivity(): Promise<number> {
  const accountId = getAnalyticsIdentifiedAccountId();
  if (!accountId) return 0;
  return deliverPendingMeaningfulActivityReceipts({
    accountId,
    appSessionId: getTelemetryCorrelationContext().appSessionId,
    authority: getMeaningfulActivityAuthority(),
    binding: 'same_session',
    emit: (properties) => trackRendererEvent(MEANINGFUL_ACTIVITY_COMPLETED, properties),
  });
}

export async function explicitlyBindHistoricalMeaningfulActivity(
  confirmed: boolean
): Promise<number> {
  const accountId = getAnalyticsIdentifiedAccountId();
  if (!accountId) return 0;
  return deliverPendingMeaningfulActivityReceipts({
    accountId,
    appSessionId: getTelemetryCorrelationContext().appSessionId,
    authority: getMeaningfulActivityAuthority(),
    binding: 'explicit',
    explicitConfirmation: confirmed,
    emit: (properties) => trackRendererEvent(MEANINGFUL_ACTIVITY_COMPLETED, properties),
  });
}

subscribeAnalyticsCaptureReady(() => {
  void flushCurrentSessionPendingMeaningfulActivity().catch(() => undefined);
});

export function errorClassFor(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  if (error.name === 'AbortError') return 'cancelled';
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(code)) {
    return normalizeErrorClass(code);
  }
  return normalizeErrorClass(error.name || 'unknown');
}

function normalizeErrorClass(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'unknown';
}
