import type {
  ComputeRecoveryResult,
  ComputeImportDetails,
  ComputeJobsSnapshot,
  ComputeJobsSnapshotOptions,
  ComputeJobIntentInput,
  ComputeJobIntentReceipt,
  ComputeJobRecord,
  ComputeJobsListOptions,
} from '../compute-jobs-ipc';
import { defineGroup, invoke } from './contract';
import type {
  ComputeConnectResult,
  ComputeDisconnectResult,
  ComputeManifestInstallResult,
  ComputeManifestRemoveResult,
  ComputeProviderSummary,
} from '../compute-ipc';

export const computeContract = defineGroup('compute', {
  recoverLegacyResult: invoke<[id: string], ComputeRecoveryResult>(),
  markJobSubmissionUnknown: invoke<[id: string, error: string], ComputeJobRecord | null>(),
  listJobsSnapshot: invoke<[options?: ComputeJobsSnapshotOptions], ComputeJobsSnapshot>(),
  listProviders: invoke<[], ComputeProviderSummary[]>(),
  installManifest: invoke<[manifestJson: string], ComputeManifestInstallResult>(),
  removeCustomProvider: invoke<[providerId: string], ComputeManifestRemoveResult>(),
  connect: invoke<[providerId: string, secret: string], ComputeConnectResult>(),
  test: invoke<[providerId: string], ComputeConnectResult>(),
  disconnect: invoke<[providerId: string], ComputeDisconnectResult>(),
  recordJobIntent: invoke<[input: ComputeJobIntentInput], ComputeJobIntentReceipt>(),
  markJobSubmitted: invoke<[id: string, remoteId: string], ComputeJobRecord | null>(),
  markJobFailed: invoke<[id: string, error: string], ComputeJobRecord | null>(),
  markJobCanceled: invoke<[id: string, providerState: string], ComputeJobRecord | null>(),
  markJobImported: invoke<
    [id: string, paths: string[], details?: ComputeImportDetails | null],
    ComputeJobRecord | null
  >(),
  listJobs: invoke<[options?: ComputeJobsListOptions], ComputeJobRecord[]>(),
  findJob: invoke<[providerId: string, remoteId: string], ComputeJobRecord | null>(),
});
