import type { ToolErrorReasonCode } from '../shared/tool-error-reasons';
import {
  trackToolActionCompleted,
  trackToolActionStarted,
  trackToolOperationError,
} from './analytics';
import type {
  ToolUsageAction,
  ToolUsageErrorClass,
  ToolUsageSurface,
  ToolUsageToolId,
} from './analytics-events';
import {
  abandonOpenWorkflowActions,
  beginWorkflowAction,
  type ScientificWorkflow,
  type ScientificWorkflowAction,
  type WorkflowOperation,
  type WorkflowResultMetadata,
} from './workflow-telemetry';

type OperationAction = Exclude<ToolUsageAction, 'opened' | 'completed' | 'failed' | 'cancelled'>;

export interface ToolOperationInput {
  toolId: ToolUsageToolId;
  surface: ToolUsageSurface;
  action: OperationAction;
  workflowMetadata?: Pick<
    WorkflowResultMetadata,
    | 'operationId'
    | 'artifactCorrelationId'
    | 'assemblyComputeStage'
    | 'assemblyMaterialRoute'
    | 'pcrTemplateCount'
  >;
}

interface ToolOperationDependencies {
  createId?: () => string;
  now?: () => number;
}

export interface ToolOperation {
  readonly operationId: string;
  readonly consumed: boolean;
  complete: (terminalAt?: number, metadata?: WorkflowResultMetadata) => boolean;
  fail: (
    errorClass: ToolUsageErrorClass,
    terminalAt?: number,
    metadata?: WorkflowResultMetadata,
    workflowErrorClass?: string,
    reasonCode?: ToolErrorReasonCode
  ) => boolean;
  cancel: (terminalAt?: number, metadata?: WorkflowResultMetadata) => boolean;
}

const MAX_DURATION_MS = 86_400_000;
const openToolOperations = new Set<ToolOperation>();

export function abandonOpenTelemetryOperations(): number {
  let abandoned = 0;
  for (const operation of [...openToolOperations]) {
    if (operation.cancel(undefined, { status: 'abandoned' })) abandoned += 1;
  }
  openToolOperations.clear();
  return abandoned + abandonOpenWorkflowActions();
}

export function installTelemetryAbandonmentOnExit(target: Window = window): () => void {
  const abandon = (): void => {
    abandonOpenTelemetryOperations();
  };
  target.addEventListener('pagehide', abandon, { capture: true });
  return () => target.removeEventListener('pagehide', abandon, { capture: true });
}

export function beginToolOperation(
  input: ToolOperationInput,
  dependencies: ToolOperationDependencies = {}
): ToolOperation {
  const now = dependencies.now ?? monotonicNow;
  const operationId = (dependencies.createId ?? createOperationId)();
  const startedAt = now();
  let consumed = false;
  const workflowInput = scientificWorkflowInput(input);
  const workflowOperation: WorkflowOperation | null = workflowInput
    ? beginWorkflowAction({
        ...workflowInput,
        ...input.workflowMetadata,
        actionId: operationId,
      })
    : null;

  trackToolActionStarted(input.toolId, input.surface, input.action, operationId);

  const duration = (terminalAt = now()): number =>
    Math.min(MAX_DURATION_MS, Math.max(0, Math.round(terminalAt - startedAt)));
  const consume = (emit: (durationMs: number) => void, terminalAt?: number): boolean => {
    if (consumed) return false;
    consumed = true;
    openToolOperations.delete(operation);
    emit(duration(terminalAt));
    return true;
  };

  const operation: ToolOperation = {
    operationId,
    get consumed() {
      return consumed;
    },
    complete: (terminalAt, metadata) =>
      consume((durationMs) => {
        trackToolActionCompleted(
          input.toolId,
          input.surface,
          input.action,
          operationId,
          durationMs
        );
        workflowOperation?.complete({ status: 'completed', ...metadata });
      }, terminalAt),
    fail: (errorClass, terminalAt, metadata, workflowErrorClass, reasonCode) =>
      consume((durationMs) => {
        trackToolOperationError({
          toolId: input.toolId,
          surface: input.surface,
          attemptedAction: input.action,
          outcomeAction: 'failed',
          errorClass,
          ...(reasonCode ? { reasonCode } : {}),
          operationId,
          durationMs,
        });
        workflowOperation?.fail(workflowErrorClass ?? errorClass, metadata);
      }, terminalAt),
    cancel: (terminalAt, metadata) =>
      consume((durationMs) => {
        trackToolOperationError({
          toolId: input.toolId,
          surface: input.surface,
          attemptedAction: input.action,
          outcomeAction: 'cancelled',
          errorClass: 'cancelled',
          operationId,
          durationMs,
        });
        workflowOperation?.cancel(metadata);
      }, terminalAt),
  };
  openToolOperations.add(operation);
  return operation;
}

function scientificWorkflowInput(input: ToolOperationInput): {
  workflow: ScientificWorkflow;
  action: ScientificWorkflowAction;
} | null {
  const workflow: ScientificWorkflow | null =
    input.toolId === 'assembly'
      ? 'assembly'
      : input.toolId === 'primers' || input.toolId === 'primer_design'
        ? 'primer'
        : input.toolId === 'lims'
          ? 'registry'
          : input.toolId === 'structure_viewer'
            ? 'structure'
            : input.toolId === 'agent_chat'
              ? 'ask_ai'
              : null;
  if (!workflow) return null;
  const action: ScientificWorkflowAction =
    input.action === 'created'
      ? 'create'
      : input.action === 'searched'
        ? 'search'
        : input.action === 'imported'
          ? 'import'
          : input.action === 'exported'
            ? 'export'
            : input.action === 'computed'
              ? 'compute'
              : 'run';
  return { workflow, action };
}

function createOperationId(): string {
  return crypto.randomUUID();
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}
