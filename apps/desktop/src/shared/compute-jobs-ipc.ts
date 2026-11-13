import type { ComputeInputFileWitness, FrozenComputeRequest } from './compute-request';

export type ComputeJobState =
  | 'intent'
  | 'submission-unknown'
  | 'submitted'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'imported';

export const TERMINAL_COMPUTE_JOB_STATES: ReadonlySet<ComputeJobState> = new Set<ComputeJobState>([
  'completed',
  'failed',
  'canceled',
  'imported',
]);

export interface ComputeJobTerminalEvent {
  id: string;
  provider: string;
  toolId: string;

  remoteId: string | null;
  label: string | null;
  state: ComputeJobState;

  workspaceRoot: string | null;
  importedPaths: string[];
  lastError: string | null;
}

export interface ProteinInspectionComputeTarget {
  kind: 'protein-inspection';
  documentId: string;
  proteinKey: string;
  proteinSequenceSha256: string;
  continuationReferenceId?: string;
}

export function parseComputeResultTarget(value: unknown): ProteinInspectionComputeTarget {
  if (!value || typeof value !== 'object') throw new Error('Invalid compute result destination.');
  const target = value as Record<string, unknown>;
  if (
    target.kind !== 'protein-inspection' ||
    typeof target.documentId !== 'string' ||
    !target.documentId ||
    target.documentId.length > 500 ||
    typeof target.proteinKey !== 'string' ||
    !target.proteinKey ||
    target.proteinKey.length > 24000 ||
    typeof target.proteinSequenceSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(target.proteinSequenceSha256)
  )
    throw new Error('Invalid compute result destination.');
  if (
    target.continuationReferenceId !== undefined &&
    (typeof target.continuationReferenceId !== 'string' ||
      !target.continuationReferenceId ||
      target.continuationReferenceId.length > 200)
  )
    throw new Error('Invalid compute inspection continuation.');
  return {
    ...(typeof target.continuationReferenceId === 'string'
      ? { continuationReferenceId: target.continuationReferenceId }
      : {}),
    kind: 'protein-inspection',
    documentId: target.documentId,
    proteinKey: target.proteinKey,
    proteinSequenceSha256: target.proteinSequenceSha256,
  };
}

export interface ComputeJobRecord {
  id: string;
  provider: string;
  toolId: string;
  label: string | null;
  settingsHash: string;
  settings: Record<string, unknown>;

  requestHash?: string | null;
  idempotencyKey?: string | null;
  inputFiles?: ComputeInputFileWitness[];
  resultTarget?: ProteinInspectionComputeTarget | null;

  remoteId: string | null;
  state: ComputeJobState;
  providerState: string;
  costEstimate: number | null;
  costEstimateUnit: string | null;
  costActual: number | null;
  costActualUnit: string | null;
  workspaceRoot: string | null;
  sourcePath?: string | null;
  sourceName?: string | null;
  importedPaths: string[];
  lastError: string | null;
  pollCount: number;
  nextPollAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComputeJobIntentInput {
  provider: string;
  toolId: string;
  label: string | null;
  settings: Record<string, unknown>;
  files?: Record<string, string>;
  idempotencyKey?: string;
  resultTarget?: ProteinInspectionComputeTarget | null;
  costEstimate: number | null;
  costEstimateUnit: string | null;
  workspaceRoot: string | null;
  sourcePath?: string | null;
  sourceName?: string | null;

  termsSnapshot: { providerDisplayName: string; termsUrl: string; disclosure: string } | null;
}

export interface ComputeImportDetails {
  receipt: Record<string, unknown>;
  outputs: Array<{ name: string; content: string }>;
}

export interface ComputeJobIntentReceipt extends ComputeJobRecord {
  submissionRequest: FrozenComputeRequest;
}

export interface ComputeJobsListOptions {
  requestHash?: string;

  proteinSequence?: string;

  states?: ComputeJobState[];
  limit?: number;
}

export interface ComputeJobsSnapshotOptions {
  historyLimit?: number;
}

export interface ComputeJobsSnapshot {
  jobs: ComputeJobRecord[];
  jobCount: number;
  activeCount: number;
  terminalCount: number;
  activeComplete: true;
  historyComplete: boolean;
  historyLimit: number;
}

export interface ComputeRecoveryResult {
  kind: 'committed' | 'already-committed';
  operationId: string;
  targetRelativePath: string;
  retainedRelativePath: string;
}
