import type { PairwiseSessionAlignmentResult } from '@waypoint/api-client/models';
import type { SequencePackageEvidenceRun } from '../db/sequence-package';

export const MAX_SEQUENCE_EVIDENCE_INPUT_BYTES = 25 * 1024 * 1024;

export const PAIRWISE_EVIDENCE_PARAMETERS = {
  algorithm: 'auto',
  threads: 4,
  timeoutSeconds: 300,
} as const;

export interface PublishSequenceAlignmentHistoryRequest {
  workspaceRoot: string;
  packageRoot: string;
  packageId: string;
  content: string;
  mutationToken?: string;
}

export interface PrepareSequenceEvidenceRunRequest {
  workspaceRoot: string;
  packageRoot: string;
  packageId: string;
  sourcePath: string;
  sessionId: string;
  session: { name: string; mode: 'one-per-clone' | 'multi-per-clone'; createdAt: string };
  runId: string;
  queries: Array<{ id: string; label: string; path: string }>;
  mutationToken?: string;
}

export interface PrepareSequenceEvidenceRunResult {
  run: SequencePackageEvidenceRun;

  referenceReadPath: string;
  queryPaths: Record<string, string>;
  attachedQueryPaths?: Record<string, string>;
  sourceRetirement?: { status: 'retained'; reason: 'view-only' };
  markerPath: string;
}

export interface CompleteSequenceEvidenceRunRequest {
  workspaceRoot: string;
  packageRoot: string;
  packageId: string;
  runId: string;
  managedOperationId: string;
  inputRevision: string;
  result: PairwiseSessionAlignmentResult;
  mutationToken?: string;
}

export interface ActivateSequenceEvidenceRunRequest {
  workspaceRoot: string;
  packageRoot: string;
  packageId: string;
  runId: string;
  managedOperationId: string;
  inputRevision: string;
  mutationToken?: string;
}

export interface CompleteSequenceEvidenceRunResult {
  run: SequencePackageEvidenceRun;
  resultPath: string;
  markerPath: string;
}

export interface FailSequenceEvidenceRunRequest {
  workspaceRoot: string;
  packageRoot: string;
  packageId: string;
  runId: string;
  status: 'failed' | 'canceled' | 'interrupted';
  managedOperationId?: string;
  inputRevision?: string;
  mutationToken?: string;
}

export interface SequenceEvidenceTrackState {
  queryId: string;
  label: string;
  alignment: {
    alignedReference: string;
    alignedQuery: string;
    identity: number;
    coverageStart: number;
    coverageEnd: number;
    algorithm: string;
  };
  mutations: unknown[];
  structuralAnalysis?: unknown;
  status: 'pass' | 'variants' | 'fail' | 'incomplete';
  userStatus?: 'pass' | 'variants' | 'fail' | 'incomplete';
  userOverrideReason?: string;
  checkedMutations?: string[];
  alignedAt: string;
}

export interface SequenceEvidenceSessionState {
  name: string;
  mode: 'one-per-clone' | 'multi-per-clone';
  createdAt: string;
  archived: boolean;
}

export interface AppendSequenceEvidenceStateRequest {
  workspaceRoot: string;
  packageRoot: string;
  packageId: string;
  runId: string;
  stateId: string;
  classifier: 'mutation-impact-v1';
  session?: SequenceEvidenceSessionState;
  tracks: SequenceEvidenceTrackState[];
  mutationToken?: string;
}

export type AppendSequenceEvidenceStateResult = SequencePackageEvidenceRun;
