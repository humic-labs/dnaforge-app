import type {
  BenchlingMigrationImportDestinationCandidateView,
  BenchlingMigrationLinkedItemRecoveryLocationKind,
  BenchlingMigrationCreatedObjectView,
  BenchlingMigrationProgressEvent,
  BenchlingMigrationProgressSubscriptionStatus,
  BenchlingMigrationReportView,
  BenchlingMigrationRunView,
} from '../../shared/benchling-migration-ipc';

export type BenchlingImportDestinationCandidate = BenchlingMigrationImportDestinationCandidateView;

export type BenchlingImportDestinationSelection = {
  registryTables?: readonly import('../../shared/benchling-registry-table-review').RegistryTableReviewCandidate[];
  sourcePath: string;
  archiveName: string;
  archiveObjectCount: number;
  candidates: readonly BenchlingImportDestinationCandidate[];
};

export type BenchlingImportDestinationChoice = {
  reviewedTables?: readonly import('../../shared/benchling-registry-table-review').RegistryTableMappingDecision[];
} & (
  | { kind: 'new_workspace'; workspaceName: string }
  | { kind: 'existing_workspace'; workspaceDbId: number }
);

export type BenchlingMigrationWizardView = {
  run: BenchlingMigrationRunView | null;
  report: BenchlingMigrationReportView | null;
  createdObjects: readonly BenchlingMigrationCreatedObjectView[];
};

export interface BenchlingMigrationWizardBridge {
  load(runId?: string): Promise<BenchlingMigrationWizardView>;
  subscribeProgress(
    runId: string,
    callback: (event: BenchlingMigrationProgressEvent) => void,
    onStatus?: (status: BenchlingMigrationProgressSubscriptionStatus) => void
  ): () => void;
  importLocalBundle(runId?: string): Promise<BenchlingMigrationWizardView>;
  retryWithoutFailedFile(runId: string): Promise<BenchlingMigrationWizardView>;
  chooseLocalBundle(): Promise<string | null>;
  prepareLocalBundle(sourcePath: string): Promise<BenchlingImportDestinationSelection>;
  importPreparedLocalBundle(
    selection: BenchlingImportDestinationSelection,
    destination: BenchlingImportDestinationChoice
  ): Promise<BenchlingMigrationWizardView>;
  importDroppedLocalBundle(
    sourcePath: string,
    runId?: string
  ): Promise<BenchlingMigrationWizardView>;
  addLinkedItemExports(
    runId: string,
    sourcePaths?: string[]
  ): Promise<BenchlingMigrationWizardView>;
  appendWorkspaceExports(
    runId: string,
    sourcePaths?: string[]
  ): Promise<BenchlingMigrationWizardView>;
  resolveImportDecision(
    runId: string,
    attemptId: string,
    decision: import('../../shared/benchling-import-decision').ImportDecision
  ): Promise<BenchlingMigrationWizardView>;
  openLinkedItemRecoveryLocation(
    runId: string,
    kind: BenchlingMigrationLinkedItemRecoveryLocationKind,
    sourceId: string
  ): Promise<void>;
  start(runId: string): Promise<BenchlingMigrationWizardView>;
  pause(runId: string): Promise<BenchlingMigrationWizardView>;
  cancelPreserved(runId: string): Promise<BenchlingMigrationWizardView>;
  startOverPreserved(runId: string): Promise<BenchlingMigrationWizardView>;
  startNewMigration(runId: string): Promise<BenchlingMigrationWizardView>;
  discard(runId: string): Promise<BenchlingMigrationWizardView>;
  resume(runId: string): Promise<BenchlingMigrationWizardView>;
  unlock(runId: string): Promise<BenchlingMigrationWizardView>;
}
