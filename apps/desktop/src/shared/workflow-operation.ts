import type {
  ScientificWorkflow,
  ScientificWorkflowAction,
  WorkflowStatus,
  WorkflowOutcomeKind,
  WorkflowRevisionRelation,
  WorkflowOrigin,
  RecordWriteStatus,
  RecordProjectionStatus,
  RecordHistoryStatus,
  AssemblyComputeStage,
  AssemblyMaterialRoute,
  DigestTopology,
  DigestReadiness,
  DigestTrigger,
  AssemblyMethodTelemetry,
  ExportFormat,
} from './scientific-workflow-vocab';
import type { SafeFileTypeCategory } from '@waypoint/analytics-policy';
import type { TableOperationObservation } from './table-notebook-observation';
export interface WorkflowResultMetadata {
  tableObservation?: TableOperationObservation;
  operationId?: string;
  nativeActionId?: string;
  artifactCorrelationId?: string;
  searchEpisodeId?: string;
  searchQueryRevision?: number;
  searchActivityRole?: 'first_result' | 'continuation' | 'superseded';
  outcomeKind?: WorkflowOutcomeKind;
  workflowOrigin?: WorkflowOrigin;
  parentActionId?: string;
  recordWriteStatus?: RecordWriteStatus;
  recordProjectionStatus?: RecordProjectionStatus;
  recordHistoryStatus?: RecordHistoryStatus;
  assemblyComputeStage?: AssemblyComputeStage;
  assemblyMaterialRoute?: AssemblyMaterialRoute;
  pcrTemplateCount?: number;
  digestTopology?: DigestTopology;
  digestReadiness?: DigestReadiness;
  digestTrigger?: DigestTrigger;
  digestCutCount?: number;
  digestEnzymeCount?: number;
  resultCount?: number;
  selectedCount?: number;
  affectedCount?: number;
  stateRevision?: number;
  status?: WorkflowStatus;
  cached?: boolean;
  valueDelivered?: boolean;
  usableResult?: boolean;
  resultRank?: number;
  assemblyMethod?: AssemblyMethodTelemetry;
  exportFormat?: ExportFormat;
  fileTypeCategory?: SafeFileTypeCategory;
  basesInsertedBucket?: WorkflowCountBucket;
  basesDeletedBucket?: WorkflowCountBucket;
  basesSubstitutedBucket?: WorkflowCountBucket;
  saveAttemptCount?: number;
  attemptCount?: number;
  wrote?: boolean;
  dirty?: boolean;
  capturedRevision?: number;
  acknowledgedRevision?: number;
  revisionRelation?: WorkflowRevisionRelation;
  agentToolName?: string;
}

export type WorkflowCountBucket = '0' | '1' | '2_5' | '6_20' | '21_100' | '100_plus' | 'unknown';

export interface WorkflowActionInput extends WorkflowResultMetadata {
  workflow: ScientificWorkflow;
  action: ScientificWorkflowAction;
  actionId?: string;
  initiator?: 'user' | 'system';
}

export interface WorkflowOperation {
  readonly actionId: string;
  readonly consumed: boolean;
  readonly startAccepted?: boolean;
  complete(metadata?: WorkflowResultMetadata): boolean;
  fail(errorClass?: string, metadata?: WorkflowResultMetadata): boolean;
  cancel(metadata?: WorkflowResultMetadata): boolean;
}
export type BeginWorkflowAction = (input: WorkflowActionInput) => WorkflowOperation;
