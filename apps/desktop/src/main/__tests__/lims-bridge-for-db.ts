import { upgradeLegacyRegistryArtifactInMain } from '../legacy-registry-artifact-upgrade';

import type Database from 'better-sqlite3';
import type { PlatformBridge } from '../../platform/index';
import { ensureSchema } from '../schema';
import { reconstructLegacyAcceptedPlasmidInMain } from '../legacy-accepted-plasmid-reconstruction';
import { createTestDb } from './test-db';
import { createNativeImportReviews } from '../native-import-reviews';
import { withLimsScenarioSeedContext } from '../lims-scenario-context';
export { discoverWorkspaceArtifacts as discoverTestWorkspaceArtifacts } from '../workspace-artifact-discovery';
import {
  seedOriginalProjectFixture,
  type OriginalProjectFixture,
} from './original-project-fixture';
import { readNativeSequenceClassificationReview } from '../native-sequence-classification-review';
import { queryNativeRecordRelationshipTargets } from '../native-record-relationship-targets';
import { applyNativeSequenceClassification } from '../native-sequence-classification';
import {
  applyLimsImportBatchInDb,
  archiveLimsEntityInDb,
  attachGenomeHypothesisInDb,
  attachVerifiedLimsGenomeInDb,
  backfillLimsRegistryIdsInDb,
  countLimsEntitiesByKindInDb,
  defineLimsSchemaInDb,
  getAllLimsPrimersInDb,
  getLimsEntityHistoryInDb,
  getLimsIdSchemesInDb,
  getLimsRegistrationBadgeCandidatesInDb,
  getLimsRegistryPreviewInDb,
  getLimsStrainGenomeSummariesInDb,
  getLimsStrainGenomeSummaryInDb,
  linkLimsEntitiesInDb,
  replaceLimsOutgoingRelationshipsInDb,
  logLimsTelemetryInDb,
  queryLimsEntitiesInDb,
  queryLimsRegistrySummariesInDb,
  recordLimsStrainParentGenomeInDb,
  refineLimsSchemaInDb,
  registerLimsEntityInDb,
  repairLimsEntityProjectionFromAuditInDb,
  resetLimsRegistryInDb,
  restoreLimsEntityInDb,
  revertLimsEntityInDb,
  listLimsEntitySchemasInDb,
  seedLimsBuiltinsInDb,
  seedLimsDemoDatasetInDb,
  seedLimsMockDemoInDb,
  seedLimsPracticeDemoInDb,
  seedLimsStarterRegistryInDb,
  setLimsIdSchemeInDb,
  undoLimsImportBatchInDb,
  updateLimsEntityInDb,
} from '../lims';
import {
  confirmPendingRefInDb,
  derivePendingRefsInDb,
  dismissPendingRefInDb,
  rejectPendingRefCandidateInDb,
  restorePendingRefInDb,
} from '../lims-pending-refs';

import {
  readPrimerArtifactRevisionStateInMain,
  publishPrimerArtifactRevision,
  resumePrimerArtifactPublication,
} from '../primer-artifact-mutations';

type LimsBridge = PlatformBridge['lims'];

export function createNativeImportReviewBridgeForDb(
  db: Database.Database,
  profileDirectory: string
): PlatformBridge['importReview'] & { settle(): Promise<void> } {
  const service = createNativeImportReviews({
    db: () => db,
    workspaceRoots: () =>
      (
        db.prepare('SELECT path FROM workspaces WHERE path IS NOT NULL').all() as { path: string }[]
      ).map((workspace) => workspace.path),
    profileDirectory: () => profileDirectory,
  });
  const pending = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation)
    );
    return operation;
  };
  return {
    call: (request) => track(service.call(request)),
    snapshot: (id) => track(service.snapshot(id)),
    onChanged: (listener) => service.subscribe(listener),
    async settle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

export function createLimsBridgeForDb(
  db: Database.Database,
  originalProject?: OriginalProjectFixture
): LimsBridge {
  const seedScenario = <T>(seed: () => T): T =>
    originalProject
      ? withLimsScenarioSeedContext(
          db,
          {
            workspaceId: originalProject.workspaceId,
            repoPath: originalProject.rootPath,
            createdFiles: new Set(),
          },
          seed
        )
      : seed();
  const publicationContext = {
    db,
    runDatabase: <T>(operation: () => T): T => operation(),
    getActiveAccountId: async () => null,
  };
  const bridge: LimsBridge = {
    readCommittedPrimerSource: async ({ entityId }) =>
      (await import('../primer-committed-source')).readCommittedPrimerSource(
        db,
        (read) => read(),
        entityId
      ),
    readPrimerArtifactRevisionState: ({ entityId }) =>
      readPrimerArtifactRevisionStateInMain({ ...publicationContext, entityId }),
    revisePrimerArtifact: ({ mutationToken: _mutationToken, ...request }) =>
      publishPrimerArtifactRevision({ ...publicationContext, request }),
    resumePrimerArtifactPublication: ({ entityId, operationId }) =>
      resumePrimerArtifactPublication({ ...publicationContext, entityId, operationId }),
    reviewClassification: async (entityId) => readNativeSequenceClassificationReview(db, entityId),
    applyClassification: async (input) =>
      applyNativeSequenceClassification({
        db,
        runDatabase: (operation) => operation(),
        input,
      }),
    ensureSeeded: async () => seedLimsBuiltinsInDb(db),
    listSchemas: async () => listLimsEntitySchemasInDb(db),
    defineSchema: async (input) => defineLimsSchemaInDb(db, input),
    refineSchema: async (input) => refineLimsSchemaInDb(db, input),
    registerEntity: async (input) => registerLimsEntityInDb(db, input),
    repairEntityProjectionFromAudit: async (entityId) =>
      repairLimsEntityProjectionFromAuditInDb(db, entityId),
    reconstructLegacyAcceptedPlasmid: (input) =>
      reconstructLegacyAcceptedPlasmidInMain({ db, input, runDatabase: (work) => work() }),
    upgradeLegacyEntityArtifact: async (input) =>
      upgradeLegacyRegistryArtifactInMain({ db, runDatabase: (work) => work(), input }),
    updateEntity: async (input) => updateLimsEntityInDb(db, input),
    revertEntity: async (input) => revertLimsEntityInDb(db, input),
    archiveEntity: async (input) => archiveLimsEntityInDb(db, input),
    restoreEntity: async (input) => restoreLimsEntityInDb(db, input),
    getEntityHistory: async (input) => getLimsEntityHistoryInDb(db, input),
    linkEntities: async (input) => linkLimsEntitiesInDb(db, input),
    replaceOutgoingRelationships: async (input) => replaceLimsOutgoingRelationshipsInDb(db, input),
    queryEntities: async (input) => queryLimsEntitiesInDb(db, input ?? {}),
    countEntitiesByKind: async () => countLimsEntitiesByKindInDb(db),
    queryRegistrySummaries: async (input) => queryLimsRegistrySummariesInDb(db, input ?? {}),
    getRegistryPreview: async (input) => getLimsRegistryPreviewInDb(db, input),
    queryRecordRelationshipTargets: (input) =>
      queryNativeRecordRelationshipTargets(db, input, (operation) => operation()),
    getIdSchemes: async () => getLimsIdSchemesInDb(db),
    setIdScheme: async (input) => setLimsIdSchemeInDb(db, input),
    backfillRegistryIds: async (input) => backfillLimsRegistryIdsInDb(db, input ?? {}),
    getStrainGenomeSummaries: async (input) => getLimsStrainGenomeSummariesInDb(db, input),
    applyImportBatch: async (input) => applyLimsImportBatchInDb(db, input),
    undoImportBatch: async (input) => undoLimsImportBatchInDb(db, input),
    pendingRefs: async () => derivePendingRefsInDb(db),
    confirmPendingRef: async (input) => confirmPendingRefInDb(db, input),
    rejectPendingRefCandidate: async (input) => rejectPendingRefCandidateInDb(db, input),
    dismissPendingRef: async (input) => dismissPendingRefInDb(db, input),
    restorePendingRef: async (input) => restorePendingRefInDb(db, input),
    getRegistrationBadgeCandidates: async (input) =>
      getLimsRegistrationBadgeCandidatesInDb(db, input),
    getAllPrimers: async () => getAllLimsPrimersInDb(db),
    seedDemoDataset: async (input) => seedScenario(() => seedLimsDemoDatasetInDb(db, input ?? {})),
    seedMockDemo: async (input) => seedScenario(() => seedLimsMockDemoInDb(db, input ?? {})),
    seedPracticeDemo: async (input) =>
      seedScenario(() => seedLimsPracticeDemoInDb(db, input ?? {})),
    seedStarterRegistry: async (input) =>
      seedScenario(() => seedLimsStarterRegistryInDb(db, input ?? {})),
    resetRegistry: async () => resetLimsRegistryInDb(db),
    recordStrainParentGenome: async (input) => recordLimsStrainParentGenomeInDb(db, input),
    attachGenomeHypothesis: async (input) => attachGenomeHypothesisInDb(db, input),
    attachVerifiedGenome: async (input) => attachVerifiedLimsGenomeInDb(db, input),
    getStrainGenomeSummary: async (input) => getLimsStrainGenomeSummaryInDb(db, input),
    logTelemetry: async (input) => logLimsTelemetryInDb(db, input),
  };
  return bridge;
}

export function createLimsTestBridge(options: { withOriginalProject?: boolean } = {}): {
  db: Database.Database;
  lims: LimsBridge;
  originalProject?: OriginalProjectFixture;
} {
  const db = createTestDb();
  ensureSchema(db, ':memory:');
  const originalProject =
    options.withOriginalProject !== false ? seedOriginalProjectFixture(db) : undefined;
  return { db, lims: createLimsBridgeForDb(db, originalProject), originalProject };
}
