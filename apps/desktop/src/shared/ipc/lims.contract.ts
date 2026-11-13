import { defineGroup, invoke } from './contract';
import type {
  LegacyAcceptedPlasmidReconstructionInput,
  LegacyAcceptedPlasmidReconstructionResult,
} from '../legacy-accepted-plasmid-reconstruction';
import type {
  ApplyOligoClassificationRequest,
  ApplyOligoClassificationResult,
  OligoClassificationReview,
} from '../oligo-classification';
import type {
  LimsBackfillRegistryIdsInput,
  LimsBackfillRegistryIdsResult,
  LimsEntity,
  LimsQueryEntitiesInput,
  LimsQueryRegistrySummariesInput,
  LimsRecordRelationshipTargetPage,
  LimsRecordRelationshipTargetQuery,
  LimsRegistrySummaryPage,
  LimsSeedDemoDatasetInput,
  LimsSeedDemoDatasetResult,
  LimsSeedMockDemoInput,
  LimsSeedMockDemoResult,
  LimsSeedPracticeDemoInput,
  LimsSeedPracticeDemoResult,
  LimsSeedStarterRegistryInput,
  LimsSeedStarterRegistryResult,
} from '../lims';

export const limsContract = defineGroup('lims', {
  ensureSeeded: invoke<[mutationToken?: string], void>(),
  defineSchema: invoke<
    [input: import('../lims').LimsDefineSchemaInput],
    import('../lims').LimsSchemaRow
  >(),
  refineSchema: invoke<
    [input: import('../lims').LimsRefineSchemaInput],
    import('../lims').LimsSchemaRow
  >(),
  registerEntity: invoke<
    [input: import('../lims').LimsRegisterEntityInput, mutationToken?: string],
    import('../lims').LimsEntity
  >(),
  repairEntityProjectionFromAudit: invoke<[entityId: string, mutationToken?: string], boolean>(),
  reconstructLegacyAcceptedPlasmid: invoke<
    [input: LegacyAcceptedPlasmidReconstructionInput, mutationToken?: string],
    LegacyAcceptedPlasmidReconstructionResult
  >(),
  upgradeLegacyEntityArtifact: invoke<
    [
      input: import('../legacy-registry-artifact-upgrade').LegacyRegistryArtifactUpgradeInput,
      mutationToken: string,
    ],
    import('../legacy-registry-artifact-upgrade').LegacyRegistryArtifactUpgradeResult
  >(),
  updateEntity: invoke<
    [input: import('../lims').LimsUpdateEntityInput, mutationToken?: string],
    import('../lims').LimsEntity
  >(),
  revertEntity: invoke<
    [input: import('../lims').LimsEntityActionInput],
    import('../lims').LimsRevertEntityResult
  >(),
  archiveEntity: invoke<
    [input: import('../lims').LimsEntityActionInput, mutationToken?: string],
    import('../lims').LimsEntity
  >(),
  restoreEntity: invoke<
    [input: import('../lims').LimsEntityActionInput, mutationToken?: string],
    import('../lims').LimsEntity
  >(),
  getEntityHistory: invoke<
    [input: import('../lims').LimsEntityHistoryInput],
    import('../lims').LimsEntityHistoryEntry[]
  >(),
  linkEntities: invoke<
    [input: import('../lims').LimsLinkEntitiesInput, mutationToken?: string],
    import('../lims').LimsLink
  >(),
  replaceOutgoingRelationships: invoke<
    [input: import('../lims').LimsReplaceOutgoingRelationshipsInput, mutationToken?: string],
    import('../lims').LimsReplaceOutgoingRelationshipsResult
  >(),
  countEntitiesByKind: invoke<[], Record<string, number>>(),
  getRegistryPreview: invoke<
    [input: import('../lims').LimsRegistryPreviewInput],
    import('../lims').LimsRegistryPreview
  >(),
  getIdSchemes: invoke<[], import('../lims').LimsIdScheme[]>(),
  listSchemas: invoke<[], import('../lims').LimsSchemaDefinitionView[]>(),
  setIdScheme: invoke<
    [input: import('../lims').LimsSetIdSchemeInput],
    import('../lims').LimsIdScheme
  >(),
  getStrainGenomeSummaries: invoke<
    [input: import('../lims').LimsStrainGenomeSummariesInput],
    import('../lims').LimsStrainGenomeSummariesResult
  >(),
  applyImportBatch: invoke<
    [input: import('../lims').LimsApplyImportBatchInput, mutationToken?: string],
    import('../lims').LimsApplyImportBatchResult
  >(),
  undoImportBatch: invoke<
    [input: import('../lims').LimsUndoImportBatchInput],
    import('../lims').LimsUndoImportBatchResult
  >(),
  pendingRefs: invoke<[], import('../lims').LimsPendingRef[]>(),
  confirmPendingRef: invoke<[input: import('../lims').LimsConfirmPendingRefInput], void>(),
  rejectPendingRefCandidate: invoke<
    [input: import('../lims').LimsRejectPendingRefCandidateInput],
    void
  >(),
  dismissPendingRef: invoke<[input: import('../lims').LimsPendingRefActionInput], void>(),
  restorePendingRef: invoke<[input: import('../lims').LimsPendingRefActionInput], void>(),
  getRegistrationBadgeCandidates: invoke<
    [input: import('../lims').LimsRegistrationBadgeInput],
    import('../lims').LimsRegistrationBadgeCandidate[]
  >(),
  getAllPrimers: invoke<[], import('../lims').LimsPrimerUnionRow[]>(),
  resetRegistry: invoke<[], import('../lims').LimsResetRegistryResult>(),
  recordStrainParentGenome: invoke<
    [input: import('../lims').LimsRecordStrainParentGenomeInput],
    import('../lims').LimsRecordStrainParentGenomeResult
  >(),
  attachGenomeHypothesis: invoke<
    [input: import('../lims').LimsAttachGenomeHypothesisInput],
    import('../lims').LimsAttachGenomeHypothesisResult
  >(),
  attachVerifiedGenome: invoke<
    [input: import('../lims').LimsAttachVerifiedGenomeInput],
    import('../lims').LimsAttachVerifiedGenomeResult
  >(),
  getStrainGenomeSummary: invoke<
    [input: import('../lims').LimsStrainGenomeSummaryInput],
    import('../lims').LimsStrainGenomeSummary
  >(),
  logTelemetry: invoke<
    [input: import('../lims').LimsTelemetryInput],
    import('../lims').LimsAuditRow
  >(),
  reviewClassification: invoke<[entityId: string], OligoClassificationReview>(),
  applyClassification: invoke<
    [input: ApplyOligoClassificationRequest],
    ApplyOligoClassificationResult
  >(),
  queryEntities: invoke<[input: LimsQueryEntitiesInput], LimsEntity[]>().withDefault(0, {}),
  queryRegistrySummaries: invoke<
    [input: LimsQueryRegistrySummariesInput],
    LimsRegistrySummaryPage
  >().withDefault(0, {}),
  queryRecordRelationshipTargets: invoke<
    [input: LimsRecordRelationshipTargetQuery],
    LimsRecordRelationshipTargetPage
  >(),
  backfillRegistryIds: invoke<
    [input: LimsBackfillRegistryIdsInput],
    LimsBackfillRegistryIdsResult
  >().withDefault(0, {}),
  seedDemoDataset: invoke<
    [input: LimsSeedDemoDatasetInput],
    LimsSeedDemoDatasetResult
  >().withDefault(0, {}),
  seedMockDemo: invoke<[input: LimsSeedMockDemoInput], LimsSeedMockDemoResult>().withDefault(0, {}),
  seedStarterRegistry: invoke<
    [input: LimsSeedStarterRegistryInput],
    LimsSeedStarterRegistryResult
  >().withDefault(0, {}),
  seedPracticeDemo: invoke<
    [input: LimsSeedPracticeDemoInput],
    LimsSeedPracticeDemoResult
  >().withDefault(0, {}),
});
