import type {
  BenchlingMigrationAddLinkedItemExportsRequest,
  BenchlingMigrationAddLinkedItemExportsResult,
  BenchlingMigrationAppendWorkspaceExportsRequest,
  BenchlingMigrationAppendWorkspaceExportsResult,
  BenchlingMigrationDiscardResult,
  BenchlingMigrationHistoryDetailView,
  BenchlingMigrationHistorySummaryView,
  BenchlingMigrationImportDestinationSurveyView,
  BenchlingMigrationImportLocalBundleRequest,
  BenchlingMigrationImportLocalBundleResult,
  BenchlingMigrationOpenLinkedItemRecoveryLocationRequest,
  BenchlingMigrationOpenLinkedItemRecoveryLocationResult,
  BenchlingMigrationReportView,
  BenchlingMigrationResolveImportDecisionRequest,
  BenchlingMigrationResolveImportDecisionResult,
  BenchlingMigrationResolveProviderReferenceRequest,
  BenchlingMigrationResolveProviderReferenceResult,
  BenchlingMigrationRunView,
  BenchlingMigrationSurveyImportDestinationsRequest,
  BenchlingMigrationUnlockResult,
} from '../benchling-migration-ipc';
import type {
  ExternalProviderSourceRequest,
  ExternalProviderSourceResult,
} from '../benchling-migration-raw-source';
import { defineGroup, invoke } from './contract';

export const benchlingMigrationContract = defineGroup('benchlingMigration', {
  getActiveRun: invoke<[], BenchlingMigrationRunView | null>(),
  resolveProviderReference: invoke<
    [request: BenchlingMigrationResolveProviderReferenceRequest],
    BenchlingMigrationResolveProviderReferenceResult
  >(),
  surveyImportDestinations: invoke<
    [request: BenchlingMigrationSurveyImportDestinationsRequest],
    BenchlingMigrationImportDestinationSurveyView
  >(),
  getHistory: invoke<[], BenchlingMigrationHistorySummaryView[]>(),
  getHistoryDetail: invoke<[runId: string], BenchlingMigrationHistoryDetailView>(),
  viewExternalSource: invoke<
    [request: ExternalProviderSourceRequest],
    ExternalProviderSourceResult
  >(),
  importLocalBundle: invoke<
    [request?: BenchlingMigrationImportLocalBundleRequest],
    BenchlingMigrationImportLocalBundleResult
  >(),
  addLinkedItemExports: invoke<
    [request: BenchlingMigrationAddLinkedItemExportsRequest],
    BenchlingMigrationAddLinkedItemExportsResult
  >(),
  appendWorkspaceExports: invoke<
    [request: BenchlingMigrationAppendWorkspaceExportsRequest],
    BenchlingMigrationAppendWorkspaceExportsResult
  >(),
  resolveImportDecision: invoke<
    [request: BenchlingMigrationResolveImportDecisionRequest],
    BenchlingMigrationResolveImportDecisionResult
  >(),
  openLinkedItemRecoveryLocation: invoke<
    [request: BenchlingMigrationOpenLinkedItemRecoveryLocationRequest],
    BenchlingMigrationOpenLinkedItemRecoveryLocationResult
  >(),
  start: invoke<[runId: string], BenchlingMigrationRunView>(),
  pause: invoke<[runId: string], BenchlingMigrationRunView>(),
  resume: invoke<[runId: string], BenchlingMigrationRunView>(),
  cancelPreserved: invoke<[runId: string], BenchlingMigrationRunView>(),
  startOverPreserved: invoke<[runId: string], BenchlingMigrationRunView>(),
  getReport: invoke<[runId: string], BenchlingMigrationReportView | null>(),
  unlock: invoke<[runId: string], BenchlingMigrationUnlockResult>(),
  discard: invoke<[runId: string], BenchlingMigrationDiscardResult>(),
});
