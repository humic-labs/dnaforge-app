import { userEntityLabel, userMessage, type UserMessageKey } from '@waypoint/user-messages';
import type {
  OperationActionPage,
  OperationActionRecord,
  OperationRecordedProvenance,
  OperationSnapshot,
} from '@waypoint/api-client';
import type { ManagedOperationsSnapshot } from '../../services/managed-operations';
import {
  operationKindTitle,
  primaryRecordedInput,
  registeredOperationPresenter,
  type ManagedOperationPresenterRegistry,
} from '../../shared/managed-operation-presenters';
import type {
  JobsSidebarActionHistory,
  JobsSidebarExecutionState,
  JobsSidebarJob,
  JobsSidebarRecordedProvenance,
  JobsSidebarSnapshot,
} from './presentation';

export type { ManagedOperationReviewProjection } from '../../shared/managed-operation-presenters';

export interface ManagedOperationsPresentationOptions {
  readonly nowMs: number;
  readonly presentersByKind: ManagedOperationPresenterRegistry;
}

function executionState(operation: OperationSnapshot): JobsSidebarExecutionState {
  return operation.state === 'canceled' ? 'cancelled' : operation.state;
}

function secondsToMilliseconds(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value * 1_000 : undefined;
}

function labelIdentifier(value: string): string {
  const label = value.split('_').filter(Boolean).join(' ');
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function actorLabel(id: string, kind: string) {
  return userEntityLabel(
    id,
    kind === 'agent' ? 'identity.agent' : kind === 'system' ? 'identity.service' : 'identity.user'
  );
}

function actionLabel(action: string) {
  const keys: Record<string, UserMessageKey> = {
    import_recorded: 'jobs.action.import',
    release_result: 'jobs.action.release',
    start: 'jobs.action.start',
    cancel: 'jobs.action.stop',
  };
  return userMessage(keys[action] ?? 'jobs.action.unknown');
}

function outcomeLabel(outcome: string) {
  const keys: Record<string, UserMessageKey> = {
    imported: 'jobs.outcome.imported',
    released: 'jobs.outcome.released',
  };
  return userMessage(keys[outcome] ?? 'jobs.outcome.updated');
}

function channelLabel(channel: string): string {
  const labels: Record<string, string> = {
    desktop_ui: 'DNAForge',
    hosted_browser: 'Web app',
    managed_cli: 'Managed CLI',
    agent: 'Agent',
    runtime: 'Runtime',
  };
  return labels[channel] ?? 'DNAForge';
}

function recordedProvenance(
  provenance: OperationRecordedProvenance | null | undefined
): JobsSidebarRecordedProvenance | undefined {
  if (!provenance) return undefined;
  const inputs = provenance.inputs ?? [];
  const outputs = provenance.outputs ?? [];
  const input = inputs.find((artifact) => artifact.role === 'primary') ?? inputs[0];
  const outputArtifact = outputs.find((artifact) => artifact.role === 'primary') ?? outputs[0];
  const references = Object.entries(provenance.resources ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => `${name}: ${version ?? 'version not reported'}`)
    .concat(provenance.resource_manifest ? [`manifest: ${provenance.resource_manifest}`] : [])
    .join(' · ');
  const output = [outputArtifact?.format, outputArtifact?.path].filter(Boolean).join(' · ');
  const inputSize =
    input?.size !== null && input?.size !== undefined
      ? `${input.size.toLocaleString('en-US')} ${input.size_unit ?? 'units'}`
      : undefined;
  const inputSummary = [input?.identity, inputSize, input?.sha256].filter(Boolean).join(' · ');
  const runtimeThreads = provenance.runtime?.threads;

  return {
    sourceLabel: 'Self-reported receipt',
    runId: provenance.reported_run_id,
    tool: `${provenance.tool_name} ${provenance.tool_version}`,
    startedAt: provenance.reported_started_at,
    finishedAt: provenance.reported_finished_at,
    input: inputSummary || 'Input details not reported',
    ...(input?.path ? { inputPath: input.path } : {}),
    ...(output ? { output } : {}),
    ...(references ? { referenceVersions: references } : {}),
    ...(runtimeThreads !== null && runtimeThreads !== undefined
      ? { runtime: `${runtimeThreads} ${runtimeThreads === 1 ? 'thread' : 'threads'}` }
      : {}),
  };
}

function actionFor(action: OperationActionRecord) {
  return {
    id: action.id,
    label: actionLabel(action.action),
    outcomeLabel: outcomeLabel(action.outcome),
    actorLabel: actorLabel(action.actor_id, action.actor_kind),
    actorKindLabel: labelIdentifier(action.actor_kind),
    channelLabel: channelLabel(action.channel),
    atMs: action.recorded_at * 1_000,
  };
}

export function projectManagedOperationActionPage(
  page: OperationActionPage
): JobsSidebarActionHistory {
  return {
    actions: page.actions.map(actionFor),
    total: page.total,
    truncated: page.next_offset !== null && page.next_offset !== undefined,
    ...(page.omitted_count !== undefined ? { omittedCount: page.omitted_count } : {}),
    ...(page.history_complete !== undefined ? { historyComplete: page.history_complete } : {}),
  };
}

function jobFor(
  managed: ManagedOperationsSnapshot,
  record: ManagedOperationsSnapshot['records'][number],
  options: ManagedOperationsPresentationOptions
): JobsSidebarJob {
  const operation = record.snapshot;
  const current = record.observation.freshness === 'current';
  const canStopState = operation.state === 'queued' || operation.state === 'running';
  const recorded = operation.origin === 'recorded';
  const descriptor = managed.kindCatalogByKind[operation.kind];
  const presenter = registeredOperationPresenter(operation.kind, options.presentersByKind);
  const recordedInput = primaryRecordedInput(operation);
  const hosted = operation.channel === 'hosted_browser';

  return {
    id: `operation:${operation.id}`,
    owner: { kind: 'managed-operation', nativeId: operation.id },
    title: presenter?.title(operation) ?? operationKindTitle(operation.kind, descriptor),
    target:
      presenter?.targetLabel(operation) ??
      (recorded ? recordedInput?.identity?.trim() || undefined : undefined),
    targetIdentity: operation.subject.subject_id,
    scopeId: operation.subject.scope_id,
    state: executionState(operation),
    observation: record.observation,
    result: {
      availability: operation.result_status ?? 'none',
      ...(operation.result_status === 'expired'
        ? { reason: 'The execution owner reports that this result has expired.' }
        : operation.result_status === 'released'
          ? { reason: 'The retained result was released. Execution history remains.' }
          : {}),
    },
    review: presenter?.review(operation) ?? { state: 'not-required' },
    executionContext: recorded
      ? { mode: 'recorded' }
      : {
          mode: 'managed',
          ownerLabel: userMessage(hosted ? 'jobs.owner.web' : 'jobs.owner.local'),
          ownerInstanceId: operation.owner_instance_id,
          locationLabel: hosted ? 'DNAForge hosted service' : 'This computer',
          lifetimeLabel: hosted
            ? 'Persists independently of this browser tab'
            : 'Runs while DNAForge is open',
        },
    actorLabel: actorLabel(operation.actor_id, operation.actor_kind),
    actorActionLabel: recorded ? 'Imported by' : 'Started by',
    actorChannelLabel: channelLabel(operation.channel),
    createdAtMs: operation.created_at * 1_000,
    startedAtMs: secondsToMilliseconds(operation.started_at),
    finishedAtMs: secondsToMilliseconds(operation.settled_at),
    ...(recorded ? { durationLabel: 'Recorded result' } : {}),
    canStop:
      !recorded && current && canStopState && operation.cancellation_availability === 'available',
    canOpenResult:
      current &&
      operation.result_status === 'available' &&
      presenter?.openResult !== null &&
      presenter?.openResult !== undefined &&
      (presenter?.canOpenResult(operation) ?? false),
    canReleaseResult:
      current &&
      operation.result_status === 'available' &&
      descriptor?.actions.includes('release_result') === true,
    canLoadActions: true,
    ...(record.cancelResponse?.reason
      ? { stopUnavailableReason: record.cancelResponse.reason }
      : {}),
    inputRevision: String(operation.subject.input_revision),
    ...(recorded
      ? { recordedProvenance: recordedProvenance(operation.provenance) }
      : {
          toolVersion: 'Not reported by execution owner',
          dataVersion: 'Not reported by execution owner',
        }),
    error: operation.error?.message,
  };
}

function collectionObservation(
  managed: ManagedOperationsSnapshot
): JobsSidebarSnapshot['collectionObservation'] {
  if (managed.status === 'connected') return { state: 'current' };
  if (managed.status === 'connecting') {
    return {
      state: 'connecting',
      ...(managed.reason ? { reason: managed.reason } : {}),
    };
  }

  const observedAtMs = managed.records.reduce<number | undefined>((latest, record) => {
    const observed = record.observation.observedAtMs;
    return latest === undefined || observed > latest ? observed : latest;
  }, undefined);
  return {
    state: 'unavailable',
    ...(observedAtMs !== undefined ? { observedAtMs } : {}),
    ...(managed.reason ? { reason: managed.reason } : {}),
    ...(managed.reconnectAvailable ? { canReconnect: true } : {}),
  };
}

export function projectManagedOperationsSnapshot(
  managed: ManagedOperationsSnapshot,
  options: ManagedOperationsPresentationOptions
): JobsSidebarSnapshot {
  return {
    nowMs: options.nowMs,
    collectionObservation: collectionObservation(managed),
    ...(managed.historySummary ? { historySummary: managed.historySummary } : {}),
    jobs: managed.records.map((record) => jobFor(managed, record, options)),
  };
}
