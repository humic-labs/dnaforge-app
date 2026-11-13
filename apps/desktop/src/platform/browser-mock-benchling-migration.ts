import type {
  BenchlingMigrationProgressEvent,
  BenchlingMigrationProgressSubscriptionStatus,
} from '../shared/benchling-migration-ipc';

export function createBrowserMockBenchlingMigrationBridge() {
  const unavailable = (): never => {
    throw new Error('Benchling ZIP migration is available only in the DNAForge desktop app.');
  };
  return {
    async getActiveRun() {
      return null;
    },
    async resolveProviderReference() {
      return {
        resolution: { status: 'pending' as const, reason: 'identity_missing' as const },
        target: null,
      };
    },
    async surveyImportDestinations() {
      return {
        preparedArchivePath: '/mock/Benchling export.zip',
        sourceDisplayName: 'Benchling export.zip',
        archiveObjectCount: 0,
        candidates: [],
      };
    },
    async getHistory() {
      return [];
    },
    async getHistoryDetail() {
      return unavailable();
    },
    async viewExternalSource() {
      return unavailable();
    },
    async importLocalBundle() {
      return { run: null };
    },
    async appendWorkspaceExports() {
      return { run: null };
    },
    async resolveImportDecision() {
      return unavailable();
    },
    async addLinkedItemExports() {
      return { run: null };
    },
    async openLinkedItemRecoveryLocation() {
      return { opened: true as const };
    },
    start: unavailable,
    pause: unavailable,
    resume: unavailable,
    cancelPreserved: unavailable,
    startOverPreserved: unavailable,
    async getReport() {
      return null;
    },
    unlock: unavailable,
    async discard(runId: string) {
      return { runId, discarded: true as const };
    },
    subscribeProgress(
      _runId: string,
      _callback: (event: BenchlingMigrationProgressEvent) => void,
      onStatus?: (status: BenchlingMigrationProgressSubscriptionStatus) => void
    ) {
      onStatus?.('ready');
      return () => undefined;
    },
    onRenderValidationRequest() {
      return () => undefined;
    },
    respondRenderValidation() {},
  };
}
