import type { WorkspaceSyncSelectionUpdate } from '../shared/workspace-sync-selection';
import type {
  AppendProjectMemoryEventInput,
  ProjectMemorySnapshot,
} from '../db/project-memory-owner';
import type { SaveAllResult } from '../shared/save-all-result';
import type { SqliteIpcValue } from '../shared/sqlite-ipc';
import type { ArtifactFiles, ArtifactDatabase, ArtifactRegistryIO } from '../shared/artifact-io';
import type {
  NativeNotebookRequest,
  NotebookDocumentSnapshot,
  NativeNotebookCreateRequest,
  NativeNotebookCreateResult,
} from '../shared/notebook-document';
import type {
  FileDocumentClientFlush,
  FileDocumentClientFlushAck,
} from '../shared/file-document-client-sync';
import type {
  LegacyFileDraft,
  LegacyFileDraftRetention,
} from '../shared/file-document-legacy-recovery';
import type {
  ImportReviewChanged,
  ImportReviewDocument,
  ImportReviewInspection,
  ImportReviewRequest,
} from '../shared/import-review';
import type { FileDocumentRequest, FileDocumentSnapshot } from '../shared/file-document';
import type {
  SequenceDocumentRequest,
  SequenceDocumentSnapshot,
} from '../shared/sequence-document';
import type {
  LegacySequenceDraft,
  LegacySequenceDraftRetention,
} from '../shared/sequence-document';
import type {
  AdministrationEvent,
  AdministrationRequest,
  AdministrationResult,
} from '../shared/administration';
import type { EntityNavigationTarget } from '../shared/entity-navigation';
import type { ClientOf } from '../shared/ipc/contract';
import type { entityNavigationContract } from '../shared/ipc/entity-navigation.contract';
import type { ScientificRecoveryPort } from '../shared/ipc/scientific-recovery.contract';
import type { AgentFeedbackInput, AgentFeedbackResult } from '../shared/agent-feedback';
import type { RemoteHostsPort } from '../shared/remote-hosts';
import type { OriginalProjectPort } from '../shared/ipc/original-project.contract';
import type {
  InternalAssemblyFixtureMaterializeRequest,
  InternalAssemblyFixtureMaterializeResult,
  InternalAssemblyFixtureStatusRequest,
  InternalAssemblyFixtureStatusResult,
} from '../shared/internal-fixtures';
import type {
  ComputeImportDetails,
  ComputeJobIntentInput,
  ComputeJobIntentReceipt,
  ComputeJobRecord,
  ComputeJobsListOptions,
  ComputeJobsSnapshot,
  ComputeJobsSnapshotOptions,
} from '../shared/compute-jobs-ipc';
import type {
  ComputeConnectResult,
  ComputeDisconnectResult,
  ComputeManifestInstallResult,
  ComputeManifestRemoveResult,
  ComputeProviderSummary,
} from '../shared/compute-ipc';
import type {
  GenomeSourceCredentialInput,
  GenomeSourceCredentialRemovalResult,
  GenomeSourceCredentialStatus,
  GenomeSourceCredentialSummary,
} from '../shared/genome-source-credentials';
import type { ShellReadinessBridge } from '../shared/shell-readiness';
import type {
  RemoteAlignmentConnectRequestV1,
  RemoteAlignmentMaterializationV1,
  RemoteSignalConnectRequestV1,
  RemoteSignalMaterializationV1,
  RemoteEndpointProfileV1,
  RemoteExplorerSessionV1,
  RemoteExplorerClosedEventV1,
  RemoteDirectoryListingV1,
  RemoteSshAuthPromptV1,
  RemoteGenomicsRuntimeStatusEventV1,
  RemoteGenomicsRuntimeStatusV1,
} from '../shared/remote-genomics-ipc';
import type { NativeDocumentWorkspaceRootsRequest } from '../shared/native-document-workspaces';
import type { WorkspaceRendererMutationEvents } from '../shared/workspace-renderer-mutation';
import type {
  OligoClassificationReview,
  ApplyOligoClassificationRequest,
  ApplyOligoClassificationResult,
} from '../shared/oligo-classification';
import type { GenericMainSendChannel, MainSendArguments } from '../shared/ipc-contract';
import type { DirtyWorkState } from '../shared/dirty-work-state';
import type {
  SequenceDocumentHistoryInput,
  SequenceDocumentHistoryResult,
  SequenceDocumentSaveInput,
  SequenceDocumentSaveResult,
} from '../shared/sequence-edit-lineage';
import type {
  AcceptedAssemblyRevisionPublicationRequest,
  AcceptedAssemblyRevisionPublicationResult,
  SequenceRestoreApplyRequest,
  SequenceRestoreApplyResult,
  SequenceRestorePreviewRequest,
  SequenceRestorePreviewResult,
  SequenceMetadataRevisionRequest,
  SequenceMetadataRevisionResult,
  SequenceUserAttachmentMutationRequest,
  SequenceUserAttachmentMutationResult,
} from '../shared/sequence-package-revision';
import type {
  ActivateSequenceEvidenceRunRequest,
  AppendSequenceEvidenceStateRequest,
  AppendSequenceEvidenceStateResult,
  CompleteSequenceEvidenceRunRequest,
  CompleteSequenceEvidenceRunResult,
  FailSequenceEvidenceRunRequest,
  PublishSequenceAlignmentHistoryRequest,
  PrepareSequenceEvidenceRunRequest,
  PrepareSequenceEvidenceRunResult,
} from '../shared/sequence-package-evidence';
import type { AgentHelperLifecycleSnapshot } from '../shared/agent-helper-lifecycle';
import type { ExternalMcpRegistrationSnapshot } from '../shared/external-mcp-registration';
import type { McpHttpSettings, McpHttpStatus } from '../shared/mcp-http';
import type {
  AgentCapabilityDiscoveryRequest,
  AgentCapabilityMutationResult,
  AgentCapabilityRecordRemovalRequest,
  AgentCapabilitySelection,
  AgentCapabilitySelectionResult,
  AgentCapabilitySnapshot,
  AgentConversationForkRequest,
  AgentConversationForkResult,
  AgentManagedCommandSaveRequest,
  AgentManagedExtensionsListRequest,
  AgentManagedExtensionsSnapshot,
  AgentManagedMemorySaveRequest,
  AgentManagedSkillEnabledRequest,
  AgentManagedSkillImportRequest,
  AgentManagedSkillSaveRequest,
  AgentProviderSkillEnabledRequest,
  AgentProviderMemoryResetRequest,
  AgentProviderPluginInspectionResult,
  AgentProviderPluginManagementRequest,
  AgentProviderPluginRemovalRequest,
  AgentSkillCatalogBrowseRequest,
  AgentSkillCatalogBrowseResult,
  AgentSkillCatalogInstallRequest,
  AgentSkillCatalogInstallResult,
  AgentSkillCatalogReviewRequest,
  AgentSkillCatalogReviewResult,
  AgentSkillInspectionRequest,
  AgentSkillInspectionResult,
  AgentSkillPackSummary,
} from '../shared/agent-capability-controls';
import type {
  AgentAttachmentCaptureRequest,
  AgentAttachmentCaptureResult,
  AgentAttachmentReadRequest,
  AgentAttachmentReadResult,
} from '../shared/agent-attachments';
import type {
  FileActivationDelivery,
  FileAssociationDefaultRequestResult,
  FileAssociationHandlerStatus,
  MaterializeQuickLookPackageRequest,
  PrepareQuickLookPackageRequest,
  PromoteQuickLookPackageRequest,
  PromoteQuickLookPackageResult,
  QuickLookPackageReceipt,
} from '../shared/file-association-ipc';
import type { FileAssociationFamilyId } from '../shared/file-associations';

import type { AdmittedTextFileReadRequest } from '../shared/admitted-file-read';
import type { UpdateInstallResult, UpdateSimulationArguments } from '../shared/update-ipc';
import type { PrepackedAnnotationSceneLoadInput } from '@waypoint/genome-renderer';
import type { UnpackedPartitionedTranscriptSceneBinaryV4 } from '@waypoint/genome-renderer/pure';
import type {
  AssemblyAnnotationRasterReadRequestV2,
  AssemblyAnnotationRasterReadResultV2,
  AssemblyCompiledBroadRasterCellsRequestV1,
  AssemblyCompiledBroadRasterCellsResultV1,
  AssemblyCompiledBroadRasterManifestRequestV1,
  AssemblyCompiledBroadRasterManifestResultV1,
  AssemblyCompiledBroadInteractionHitResultV1,
  AssemblyOverviewRequest,
  AssemblyOverviewResult,
  AssemblyOverviewTextureReadResult,
  AssemblyTextureReadRequest,
  AssemblyTextureWriteRequest,
  AssemblyTextureWriteResult,
  AssemblyAnnotationProductSetInventoryReadRequestV1,
  AssemblyAnnotationProductSetInventoryReadResultV1,
  AssemblyAnnotationSceneDetailReadResultV1,
  AssemblyAnnotationSceneDetailReadRequestV1,
  AssemblyAnnotationSceneReadRequest,
  AssemblyAnnotationSceneReadResult,
  AssemblyReferenceAssetGenerationV1,
  AssemblyAnnotationSearchCancelRequestV1,
  AssemblyAnnotationSearchQueryRequestV1,
  AssemblyAnnotationSearchQueryResultV1,
  AssemblyProteinSearchCancelRequestV1,
  AssemblyProteinSearchQueryRequestV1,
  AssemblyProteinSearchQueryResultV1,
  AssemblySequenceSearchRequestV1,
  AssemblySequenceSearchResultV1,
  AssemblyAnnotationSceneWriteRequest,
  AssemblyAnnotationSceneWriteResult,
  AssemblyFeaturesReadRequest,
  AssemblyOverviewFeaturesReadResult,
  AssemblyFeaturesWriteRequest,
  AssemblyFeaturesWriteResult,
  GenomeDataInitResult,
  GenomeAnnotationTileRequest,
  GenomeCancelRequestResult,
  GenomeDebugSnapshot,
  GenomeFeature,
  GenomeFeatureDetails,
  GenomeFeatureDetailsRequest,
  GenomeOpenSource,
  GenomeSearchHit,
  GenomeSearchOptions,
  GenomeSearchRequestIdentityV1,
  GenomeSequenceWindow,
  GenomeSequenceWindowRequest,
  GenomeSessionShell,
  GenomeSessionReleaseResult,
  GenomeTileRequest,
  GenomeTrackTile,
  IndexedGenomeManifest,
} from '../shared/indexed-genome';
import type { PackageScratchLeaseSet } from '../shared/package-scratch-capability';

import type {
  ResolveInlineReferenceTargetRequest,
  ResolveInlineReferenceTargetResult,
} from '../shared/inline-reference-ipc';

export interface GenomeSearchRequestControlV1 extends GenomeSearchRequestIdentityV1 {
  signal?: AbortSignal;
}

export type TrustedAssemblyAnnotationSceneV4 = UnpackedPartitionedTranscriptSceneBinaryV4 & {
  rendererAdmissionCapability: NonNullable<
    PrepackedAnnotationSceneLoadInput['trustedRendererAdmissionV4']
  >;
  rendererAdmissionProvenance: NonNullable<
    PrepackedAnnotationSceneLoadInput['trustedRendererAdmissionProvenanceV4']
  >;
  rendererAdmissionLoadIdentity: NonNullable<
    PrepackedAnnotationSceneLoadInput['trustedRendererAdmissionLoadIdentityV4']
  >;
  colorRoles?: PrepackedAnnotationSceneLoadInput['colorRoles'];
};
import type {
  CreateSampleWorkspaceInstanceRequest,
  SampleWorkspaceInstanceResult,
} from '../shared/sample-workspace-ipc';
import type {
  CreateEmptyWorkspaceRequest,
  CreateEmptyWorkspaceResult,
  ImportContentRequest,
  ImportFileRequest,
  ImportFileResult,
  ImportManagedWorkspaceRequest,
  ImportManagedWorkspaceResult,
  ResolveProjectRootRequest,
  ResolvedProjectRoot,
  ImportProgressEvent,
  ImportSequenceContentRequest,
  ImportSequenceContentResult,
  ManagedCatalogHeadIndex,
  ManagedCatalogHeadIndexRequest,
  ManagedHeadIndex,
  ManagedWorkspaceLifecycleRequest,
  ManagedWorkspaceRenameRequest,
  ManagedWorkspaceRenameResult,
  ManagedWorkspaceLifecycleResult,
  PurgeTrashedWorkspaceResult,
  SequenceImportPreviewRequest,
  SequenceImportPreviewResult,
  WorkspaceArtifactDiscoveryRequest,
  WorkspaceArtifactDiscoveryResult,
  RegisterImportedSequenceFromContentRequest,
  RegisterImportedSequenceRequest,
  RegisterImportedSequenceResult,
} from '../shared/workspace-git-types';
import type {
  IdentifyOriginalDefaultProjectRequest,
  OriginalDefaultProjectResolution,
} from '../shared/first-project';
import type {
  RelocateEntityFileInput,
  RelocateEntityFileResult,
} from '../shared/workspace-relocate-types';
import type {
  WorkspaceListChildrenRequest,
  NativeCatalogRecordReconcileRequest,
  WorkspaceListChildrenResult,
} from '../shared/workspace-browser-types';
import type { TrackStoreBridge } from '../shared/track-store';
import type { TrackViewsBridge } from '../shared/track-view';
import type { MolecularDocumentsBridge } from '../shared/molecular-document';
import type { ReferenceAssetsBridge } from './reference-assets';
import type {
  CommitChatTurnTerminalStateRequest,
  CommitChatTurnTerminalStateResult,
  CreateChatTurnWithUserMessageRequest,
} from '../shared/chat-turn-ipc';

import type { TextFileAtomicWriteInput } from '../shared/text-file-atomic';
import type {
  MigrateNotebookPackageAtPathInput,
  PrepareNotebookPackageRenameInput,
  PublishNotebookPackageResult,
  RecoverNotebookPackageRenameInput,
  SerializablePublishNotebookPackageInput,
} from '../shared/notebook-package-ipc';

import type {
  AgentUserInputRequest,
  AgentUserInputResponse,
  DestructiveFileConfirmRequest,
  DestructiveFileConfirmResponse,
} from '../shared/agent-confirm-types';
import type {
  LargeFileImportDialogRequest,
  LargeFileImportDialogResponse,
} from '../shared/large-file-import-dialog';
import type { RuntimeProfile, RuntimeProvenance } from '../shared/runtime-profile';
import type { MemoryPressureLevel, MemoryPressureSnapshot } from '../shared/memory-pressure';
import type { ResourcePressureSnapshot } from '../shared/resource-pressure';
import type {
  AnalyticsIdentityContext,
  AnalyticsIdentitySyncResult,
  AnalyticsRuntimeConfig,
  RendererWorkflowTelemetryRequest,
} from '../shared/analytics-types';
import type {
  CloudSyncBackupResult,
  CloudSyncRestoreResult,
  CloudSyncShareResult,
  CloudSyncSnapshotSummary,
  CloudSyncWorkspaceRequest,
} from '../shared/cloud-sync-types';
import type {
  WorkspaceSyncAccessListingResult,
  WorkspaceSyncConflictResolution,
  WorkspaceSyncCopyShareLinkResult,
  WorkspaceSyncCreateOrganizationRequest,
  WorkspaceSyncCreateOrganizationResult,
  WorkspaceSyncDeleteCloudCopyResult,
  WorkspaceSyncDeleteOrganizationResult,
  WorkspaceSyncEnableOptions,
  WorkspaceSyncForceSyncResult,
  WorkspaceSyncInviteRequest,
  WorkspaceSyncInviteResult,
  WorkspaceSyncMergeConflictResult,
  WorkspaceSyncOpenProjectResult,
  WorkspaceSyncOrgDirectoryResult,
  WorkspaceSyncOrganizationAuditResult,
  WorkspaceSyncOrganizationProvisioningStatusResult,
  WorkspaceSyncOpenOrganizationProvisioningPortalResult,
  WorkspaceSyncSetOrganizationProvisioningGroupRoleRequest,
  WorkspaceSyncSetOrganizationProvisioningGroupRoleResult,
  WorkspaceSyncOrgInviteRequest,
  WorkspaceSyncOrgInviteResult,
  WorkspaceSyncOrgMemberMutationResult,
  WorkspaceSyncOrgRole,
  WorkspaceSyncOrganizationsResult,
  WorkspaceSyncTransferOrganizationOwnershipResult,
  WorkspaceSyncUpdateOrganizationRequest,
  WorkspaceSyncUpdateOrganizationResult,
  WorkspaceSyncProjectSummary,
  WorkspaceSyncReconcileResult,
  WorkspaceSyncReplicaLifecycleEvent,
  WorkspaceSyncResolveConflictResult,
  WorkspaceSyncResolveMergeRequest,
  WorkspaceSyncRevokeInviteResult,
  WorkspaceSyncSetAccessRequest,
  WorkspaceSyncSetAccessResult,
  WorkspaceSyncSetEnabledResult,
  WorkspaceSyncStatusEvent,
  WorkspaceSyncUploadPreviewResult,
} from '../shared/workspace-sync-ipc';
import type {
  OrganizationDeletionImpactResult,
  OrganizationRegistryClaimPreparationRequest,
  OrganizationRegistryClaimPreparationResult,
  OrganizationRegistryClaimRequest,
  OrganizationRegistryClaimResult,
  OrganizationRegistryConfigurationRequest,
  OrganizationRegistryConfigurationResult,
  OrganizationRegistryConflictResolutionRequest,
  OrganizationRegistryConflictResolutionResult,
  OrganizationRegistryMutationRequest,
  OrganizationRegistryMutationResult,
  OrganizationRegistryReadResult,
  OrganizationRegistryCachedOrganizationsResult,
  OrganizationRegistryRecordDetailsRequest,
  OrganizationRegistryRecordDetailsResult,
  OrganizationRegistryRecordSyncStatusResult,
  OrganizationRegistrySavedRecordReviewResult,
  OrganizationRegistrySavedRecordResolutionRequest,
  OrganizationRegistrySavedRecordResolutionResult,
  OrganizationRegistrySyncHealthResult,
  OrganizationRegistrySyncResult,
  OrganizationRegistryChangedEvent,
} from '../shared/org-registry-sync';
import type {
  DeepSharePublishRequest,
  DeepSharePublishResult,
  DeepShareSelectionRequest,
  DeepSharePreflightResult,
} from '../shared/deep-share-ipc';
import type { WorkspaceSyncStatus } from '../shared/cloud-sync-status';
import type {
  BenchlingMigrationDiscardResult,
  BenchlingMigrationImportLocalBundleRequest,
  BenchlingMigrationImportLocalBundleResult,
  BenchlingMigrationHistoryDetailView,
  BenchlingMigrationHistorySummaryView,
  BenchlingMigrationAddLinkedItemExportsRequest,
  BenchlingMigrationAddLinkedItemExportsResult,
  BenchlingMigrationAppendWorkspaceExportsRequest,
  BenchlingMigrationAppendWorkspaceExportsResult,
  BenchlingMigrationResolveImportDecisionRequest,
  BenchlingMigrationResolveImportDecisionResult,
  BenchlingMigrationOpenLinkedItemRecoveryLocationRequest,
  BenchlingMigrationOpenLinkedItemRecoveryLocationResult,
  BenchlingMigrationProgressEvent,
  BenchlingMigrationProgressSubscriptionStatus,
  BenchlingMigrationReportView,
  BenchlingMigrationResolveProviderReferenceRequest,
  BenchlingMigrationResolveProviderReferenceResult,
  BenchlingMigrationSurveyImportDestinationsRequest,
  BenchlingMigrationImportDestinationSurveyView,
  BenchlingMigrationRunView,
  BenchlingMigrationUnlockResult,
} from '../shared/benchling-migration-ipc';
import type {
  ExternalProviderSourceRequest,
  ExternalProviderSourceResult,
} from '../shared/benchling-migration-raw-source';
import type {
  MigrationRenderValidationRequest,
  MigrationRenderValidationResponse,
} from '../shared/benchling-migration-render-validation';
import type {
  LimsApplyImportBatchInput,
  LimsApplyImportBatchResult,
  LimsAttachGenomeHypothesisInput,
  LimsAttachGenomeHypothesisResult,
  LimsAttachVerifiedGenomeInput,
  LimsAttachVerifiedGenomeResult,
  LimsDefineSchemaInput,
  LimsEntity,
  LimsLink,
  LimsLinkEntitiesInput,
  LimsReplaceOutgoingRelationshipsInput,
  LimsReplaceOutgoingRelationshipsResult,
  LimsPrimerUnionRow,
  LimsQueryRegistrySummariesInput,
  LimsRecordStrainParentGenomeInput,
  LimsRecordStrainParentGenomeResult,
  LimsRefineSchemaInput,
  LimsBackfillRegistryIdsInput,
  LimsBackfillRegistryIdsResult,
  LimsIdScheme,
  LimsSetIdSchemeInput,
  LimsRegistryPreview,
  LimsRegistryPreviewInput,
  LimsRecordRelationshipTargetQuery,
  LimsRecordRelationshipTargetPage,
  LimsRegistrySummaryPage,
  LimsRegistrationBadgeCandidate,
  LimsRegistrationBadgeInput,
  LimsSeedDemoDatasetInput,
  LimsSeedDemoDatasetResult,
  LimsSeedMockDemoInput,
  LimsSeedMockDemoResult,
  LimsSeedPracticeDemoInput,
  LimsSeedPracticeDemoResult,
  LimsSeedStarterRegistryInput,
  LimsSeedStarterRegistryResult,
  LimsResetRegistryResult,
  LimsStrainGenomeSummariesInput,
  LimsStrainGenomeSummariesResult,
  LimsStrainGenomeSummary,
  LimsStrainGenomeSummaryInput,
  LimsTelemetryInput,
  LimsUndoImportBatchInput,
  LimsUndoImportBatchResult,
  LimsPendingRef,
  LimsConfirmPendingRefInput,
  LimsRejectPendingRefCandidateInput,
  LimsPendingRefActionInput,
  LimsEntityActionInput,
  LimsRevertEntityResult,
  LimsEntityHistoryInput,
  LimsEntityHistoryEntry,
  LimsAuditRow,
  LimsSchemaRow,
} from '../shared/lims';
import type {
  AgentAuthEnvelopeShape,
  AgentAuthOptionsShape,
  AgentAuthResultShape,
  AgentCliPathOverridesShape,
  AgentProviderProbeShape,
  AgentQueryOptionsShape,
  AgentQueryResultShape,
  AgentSdkDetectionShape,
  AgentSessionEventEnvelopeShape,
  AgentSessionRecordShape,
  AgentSessionRunResultShape,
  AgentSessionStartRequestShape,
  AgentScheduleCancelResultShape,
  AgentSessionCancelResultShape,
  AgentScheduleRecordShape,
  AgentTraceEnvelopeShape,
  AgentTransport,
} from '../shared/agent-runtime-ipc';
import type {
  RendererAgentBridgeCancelPayload,
  RendererAgentBridgePayload,
  RendererToolCallResponseShape,
} from '../shared/agent-tools-ipc';
import type {
  ConversationLedgerAppendInputShape,
  ConversationLedgerAppendResultShape,
  ConversationLedgerUnlinkResultShape,
} from '../shared/conversation-ledger-ipc';
import type {
  DesktopScientificDocumentCancelRequest,
  DesktopScientificDocumentReadRequest,
  DesktopScientificDocumentReadResult,
} from '../shared/scientific-document-ipc';

export type * from '../shared/agent-runtime-ipc';
export type * from '../shared/agent-capability-controls';

export interface PlatformBridge {
  entityDiscovery: import('../shared/ipc/contract').ClientOf<
    typeof import('../shared/ipc/entity-discovery.contract').entityDiscoveryContract
  >;
  notebook: {
    migrateLegacyProjectFiles(request: {
      workspaceRoot: string;
    }): Promise<import('../shared/notebook-document').NotebookLegacyProjectMigrationResult>;
    resolveResourceReference?(
      request: import('../shared/project-resource-reference').ResolveNotebookResourceReferenceRequest
    ): Promise<import('../shared/project-resource-reference').ResolvedProjectResourceReference>;
    inspectConflict?(
      documentId: string
    ): Promise<import('../shared/notebook-conflict').NotebookConflictComparison>;
    resolveConflict?(
      request: import('../shared/notebook-conflict').ResolveNotebookConflictRequest
    ): Promise<import('../shared/notebook-conflict').NotebookConflictResolution>;
    onMarkdownAdoptionFailed?(
      listener: (issue: import('../shared/markdown-notebook').MarkdownNotebookAdoptionIssue) => void
    ): () => void;
    adoptMarkdown?(
      request: import('../shared/markdown-notebook').MarkdownNotebookAdoptionRequest
    ): Promise<import('../shared/markdown-notebook').MarkdownNotebookAdoption | null>;
    onMarkdownAdopted?(
      listener: (result: import('../shared/markdown-notebook').MarkdownNotebookAdoption) => void
    ): () => void;
    create(request: NativeNotebookCreateRequest): Promise<NativeNotebookCreateResult>;
    completeLegacyDraftMigration(pendingIds: readonly string[]): Promise<void>;
    execute(request: NativeNotebookRequest): Promise<NotebookDocumentSnapshot>;
    onChanged(listener: (snapshot: NotebookDocumentSnapshot) => void): () => void;
  };
  administration: {
    execute(request: AdministrationRequest): Promise<AdministrationResult>;
    onChanged(listener: (event: AdministrationEvent) => void): () => void;
  };
  hostedAi: import('../shared/ipc/hosted-allowance.contract').HostedAllowancePort;
  terminal?: import('../shared/terminal-port').TerminalPort;
  startup: ShellReadinessBridge;
  sequenceWheel?: import('../shared/sequence-wheel-ownership').SequenceWheelBridge;
  runtime: {
    getProfile(): RuntimeProfile;
    getProvenance(): Promise<RuntimeProvenance>;
    sampleMemoryPressure(): Promise<MemoryPressureSnapshot>;
    sampleResourcePressure(): Promise<ResourcePressureSnapshot>;
    onMemoryPressureChanged(callback: (snapshot: MemoryPressureSnapshot) => void): () => void;
    forceMemoryPressure(level: MemoryPressureLevel | null): Promise<MemoryPressureSnapshot>;
  };
  molecularCatalog: import('../shared/molecular-catalog').MolecularCatalogAPI;
  molecularData: import('../shared/molecular-data-ipc').MolecularDataAPI;
  scientificDocuments: {
    read(
      request: DesktopScientificDocumentReadRequest
    ): Promise<DesktopScientificDocumentReadResult>;
    cancelRead(request: DesktopScientificDocumentCancelRequest): Promise<void>;
  };
  entityNavigation: ClientOf<typeof entityNavigationContract> & {
    onOpen(callback: (targets: EntityNavigationTarget[]) => void): () => void;
  };
  workTasks: import('../shared/ipc/contract').ClientOf<
    typeof import('../shared/ipc/work-tasks.contract').workTasksContract
  >;
  scientificObjects: import('../shared/ipc/contract').ClientOf<
    typeof import('../shared/ipc/scientific-objects.contract').scientificObjectsContract
  >;
  fileAssociations: {
    takePendingActivations(): Promise<FileActivationDelivery[]>;
    materializeQuickLookPackage(
      request: MaterializeQuickLookPackageRequest
    ): Promise<QuickLookPackageReceipt>;
    prepareQuickLookPackage(request: PrepareQuickLookPackageRequest): Promise<boolean>;
    promoteQuickLookPackage(
      request: PromoteQuickLookPackageRequest
    ): Promise<PromoteQuickLookPackageResult>;
    onOpenFiles(callback: (deliveries: FileActivationDelivery[]) => void): () => void;
    queryHandlers(): Promise<FileAssociationHandlerStatus[]>;
    requestDefault(familyId: FileAssociationFamilyId): Promise<FileAssociationDefaultRequestResult>;
  };
  db: ArtifactDatabase &
    import('../shared/ipc/contract').ClientOf<
      typeof import('../shared/ipc/db.contract').dbContract
    > & {
      select<T>(sql: string, params?: SqliteIpcValue[]): Promise<T>;
      readMountedCatalogSearchRows?: import('../shared/workspace-search-catalog').MountedCatalogSearchReader;
      createChatTurnWithUserMessage?(input: CreateChatTurnWithUserMessageRequest): Promise<void>;
      commitChatTurnTerminalState?(
        input: CommitChatTurnTerminalStateRequest
      ): Promise<CommitChatTurnTerminalStateResult>;
      deleteConversation?(id: string): Promise<void>;
      deleteMessage?(id: string): Promise<void>;

      allocatePrimerCatalogNumber(
        workspaceId?: number,
        workspaceRoot?: string,
        mutationToken?: string
      ): Promise<string>;
    };
  importReview: {
    call(request: ImportReviewRequest): Promise<ImportReviewInspection>;
    snapshot(id: string): Promise<ImportReviewDocument>;
    onChanged(listener: (event: ImportReviewChanged) => void): () => void;
  };
  lims: ArtifactRegistryIO & {
    readCommittedPrimerSource(
      request: import('../shared/primer-artifact-revision').PrimerArtifactRevisionStateRequest
    ): Promise<string | null>;
    readPrimerArtifactRevisionState(
      request: import('../shared/primer-artifact-revision').PrimerArtifactRevisionStateRequest
    ): Promise<import('../shared/primer-artifact-revision').PrimerArtifactRevisionState>;
    revisePrimerArtifact(
      request: import('../shared/primer-artifact-revision').PrimerArtifactRevisionCommand
    ): Promise<import('../shared/primer-artifact-revision').PrimerArtifactRevisionResult>;
    resumePrimerArtifactPublication(
      request: import('../shared/primer-artifact-revision').PrimerArtifactPublicationResumeRequest
    ): Promise<import('../shared/primer-artifact-revision').PrimerArtifactRevisionResult>;

    reviewClassification(entityId: string): Promise<OligoClassificationReview>;
    applyClassification(
      input: ApplyOligoClassificationRequest
    ): Promise<ApplyOligoClassificationResult>;
    ensureSeeded(mutationToken?: string): Promise<void>;
    defineSchema(input: LimsDefineSchemaInput): Promise<LimsSchemaRow>;
    refineSchema(input: LimsRefineSchemaInput): Promise<LimsSchemaRow>;

    reconstructLegacyAcceptedPlasmid(
      input: import('../shared/legacy-accepted-plasmid-reconstruction').LegacyAcceptedPlasmidReconstructionInput,
      mutationToken?: string
    ): Promise<
      import('../shared/legacy-accepted-plasmid-reconstruction').LegacyAcceptedPlasmidReconstructionResult
    >;
    upgradeLegacyEntityArtifact(
      input: import('../shared/legacy-registry-artifact-upgrade').LegacyRegistryArtifactUpgradeInput,
      mutationToken: string
    ): Promise<
      import('../shared/legacy-registry-artifact-upgrade').LegacyRegistryArtifactUpgradeResult
    >;

    revertEntity(input: LimsEntityActionInput): Promise<LimsRevertEntityResult>;
    archiveEntity(input: LimsEntityActionInput, mutationToken?: string): Promise<LimsEntity>;

    getEntityHistory(input: LimsEntityHistoryInput): Promise<LimsEntityHistoryEntry[]>;
    linkEntities(input: LimsLinkEntitiesInput, mutationToken?: string): Promise<LimsLink>;
    replaceOutgoingRelationships(
      input: LimsReplaceOutgoingRelationshipsInput,
      mutationToken?: string
    ): Promise<LimsReplaceOutgoingRelationshipsResult>;

    countEntitiesByKind(): Promise<Record<string, number>>;
    applyImportBatch(
      input: LimsApplyImportBatchInput,
      mutationToken?: string
    ): Promise<LimsApplyImportBatchResult>;
    undoImportBatch(input: LimsUndoImportBatchInput): Promise<LimsUndoImportBatchResult>;
    pendingRefs(): Promise<LimsPendingRef[]>;
    confirmPendingRef(input: LimsConfirmPendingRefInput): Promise<void>;
    rejectPendingRefCandidate(input: LimsRejectPendingRefCandidateInput): Promise<void>;
    dismissPendingRef(input: LimsPendingRefActionInput): Promise<void>;
    restorePendingRef(input: LimsPendingRefActionInput): Promise<void>;
    getRegistrationBadgeCandidates(
      input: LimsRegistrationBadgeInput
    ): Promise<LimsRegistrationBadgeCandidate[]>;
    getAllPrimers(): Promise<LimsPrimerUnionRow[]>;
    queryRegistrySummaries(
      input?: LimsQueryRegistrySummariesInput
    ): Promise<LimsRegistrySummaryPage>;
    getRegistryPreview(input: LimsRegistryPreviewInput): Promise<LimsRegistryPreview>;
    queryRecordRelationshipTargets(
      input: LimsRecordRelationshipTargetQuery
    ): Promise<LimsRecordRelationshipTargetPage>;
    getIdSchemes(): Promise<LimsIdScheme[]>;

    setIdScheme(input: LimsSetIdSchemeInput): Promise<LimsIdScheme>;
    backfillRegistryIds(
      input?: LimsBackfillRegistryIdsInput
    ): Promise<LimsBackfillRegistryIdsResult>;
    getStrainGenomeSummaries(
      input: LimsStrainGenomeSummariesInput
    ): Promise<LimsStrainGenomeSummariesResult>;
    seedDemoDataset(input?: LimsSeedDemoDatasetInput): Promise<LimsSeedDemoDatasetResult>;
    seedMockDemo(input?: LimsSeedMockDemoInput): Promise<LimsSeedMockDemoResult>;
    seedPracticeDemo(input?: LimsSeedPracticeDemoInput): Promise<LimsSeedPracticeDemoResult>;
    seedStarterRegistry(
      input?: LimsSeedStarterRegistryInput
    ): Promise<LimsSeedStarterRegistryResult>;
    resetRegistry(): Promise<LimsResetRegistryResult>;
    recordStrainParentGenome(
      input: LimsRecordStrainParentGenomeInput
    ): Promise<LimsRecordStrainParentGenomeResult>;
    attachGenomeHypothesis(
      input: LimsAttachGenomeHypothesisInput
    ): Promise<LimsAttachGenomeHypothesisResult>;
    attachVerifiedGenome(
      input: LimsAttachVerifiedGenomeInput
    ): Promise<LimsAttachVerifiedGenomeResult>;
    getStrainGenomeSummary(input: LimsStrainGenomeSummaryInput): Promise<LimsStrainGenomeSummary>;
    logTelemetry(input: LimsTelemetryInput): Promise<LimsAuditRow>;
  };
  fs: ArtifactFiles & {
    listDirtyDocuments(): Promise<import('../shared/native-document-drafts').NativeDirtyDocument[]>;
    settleDirtyDocuments(
      request: import('../shared/native-dirty-documents').NativeDirtySettlementRequest
    ): Promise<import('../shared/native-dirty-documents').NativeDirtySettlementResult>;
    onDirtyDocumentsChanged(listener: () => void): () => void;
    sequenceDocument(request: SequenceDocumentRequest): Promise<SequenceDocumentSnapshot>;
    isSequenceDocumentAvailable(documentId: string): Promise<boolean>;
    retainLegacySequenceDraft(draft: LegacySequenceDraft): Promise<LegacySequenceDraftRetention>;
    completeLegacySequenceDraftMigration(pendingIds: readonly string[]): Promise<void>;
    subscribeSequenceDocuments(listener: (snapshot: SequenceDocumentSnapshot) => void): () => void;
    onFileDocumentFlush(listener: (request: FileDocumentClientFlush) => void): () => void;
    acknowledgeFileDocumentFlush(ack: FileDocumentClientFlushAck): Promise<boolean>;
    completeLegacyFileDraftMigration(pendingPaths: readonly string[]): Promise<void>;
    retainLegacyFileDraft(draft: LegacyFileDraft): Promise<LegacyFileDraftRetention>;
    assertFileDocumentsClean(path: string): Promise<void>;
    fileDocument(request: FileDocumentRequest): Promise<FileDocumentSnapshot>;
    tableDocument(
      command: import('../shared/table-document-command').TableDocumentCommand
    ): Promise<import('../shared/table-document-command').TableDocumentCommandResult>;
    subscribeFileDocuments(listener: (snapshot: FileDocumentSnapshot) => void): () => void;
    beginWorkspaceMutation(
      workspaceRoot: string,
      parentToken?: string,
      waitForAvailability?: boolean
    ): Promise<string>;
    endWorkspaceMutation(token: string): Promise<void>;
    canonicalPath(path: string): Promise<string>;

    readAdmittedTextFile(input: AdmittedTextFileReadRequest): Promise<string>;
    readTextFileSlice(path: string, maxBytes: number): Promise<{ text: string; bytesRead: number }>;

    readFileBounded(path: string, maxBytes: number): Promise<Uint8Array>;

    writeTextFile(
      path: string,
      content: string,
      options?: { append?: boolean },
      mutationToken?: string
    ): Promise<void>;
    appendProjectMemoryEvent?(input: AppendProjectMemoryEventInput): Promise<ProjectMemorySnapshot>;
    writeTextFileAtomic(input: TextFileAtomicWriteInput): Promise<void>;
    saveSequenceDocument(input: SequenceDocumentSaveInput): Promise<SequenceDocumentSaveResult>;
    commitSequenceDocumentHistory(
      input: SequenceDocumentHistoryInput
    ): Promise<SequenceDocumentHistoryResult>;
    publishSequenceMetadataRevision(
      input: SequenceMetadataRevisionRequest
    ): Promise<SequenceMetadataRevisionResult>;
    recoverLegacySequenceMetadataTransaction(
      packageRoot: string,
      mutationToken?: string
    ): Promise<void>;
    publishAcceptedAssemblyRevision(
      input: AcceptedAssemblyRevisionPublicationRequest
    ): Promise<AcceptedAssemblyRevisionPublicationResult>;
    publishSequenceUserAttachmentMutation(
      input: SequenceUserAttachmentMutationRequest
    ): Promise<SequenceUserAttachmentMutationResult>;
    previewSequenceRestore(
      input: SequenceRestorePreviewRequest
    ): Promise<SequenceRestorePreviewResult>;
    applySequenceRestore(input: SequenceRestoreApplyRequest): Promise<SequenceRestoreApplyResult>;
    publishSequenceAlignmentHistory(input: PublishSequenceAlignmentHistoryRequest): Promise<string>;
    prepareSequenceEvidenceRun(
      input: PrepareSequenceEvidenceRunRequest
    ): Promise<PrepareSequenceEvidenceRunResult>;
    activateSequenceEvidenceRun(input: ActivateSequenceEvidenceRunRequest): Promise<void>;
    completeSequenceEvidenceRun(
      input: CompleteSequenceEvidenceRunRequest
    ): Promise<CompleteSequenceEvidenceRunResult>;
    failSequenceEvidenceRun(input: FailSequenceEvidenceRunRequest): Promise<void>;
    appendSequenceEvidenceState(
      input: AppendSequenceEvidenceStateRequest
    ): Promise<AppendSequenceEvidenceStateResult>;

    publishNotebookPackageV2InMain?(
      input: SerializablePublishNotebookPackageInput
    ): Promise<PublishNotebookPackageResult>;
    migrateNotebookPackageAtPathInMain?(
      input: MigrateNotebookPackageAtPathInput
    ): Promise<PublishNotebookPackageResult | null>;
    prepareNotebookPackageRenameInMain?(
      input: Omit<PrepareNotebookPackageRenameInput, 'now'>
    ): Promise<void>;
    recoverNotebookPackageRenameIfNeededInMain?(
      input: RecoverNotebookPackageRenameInput
    ): Promise<PublishNotebookPackageResult | null>;

    contentHash(input: { workspaceRoot: string; workspaceRelativePath: string }): Promise<string>;
    resolveInlineReferenceTarget(
      input: ResolveInlineReferenceTargetRequest
    ): Promise<ResolveInlineReferenceTargetResult>;
    resolveProjectResourceReference?(
      reference: string | import('../shared/project-resource-reference').ProjectResourceReference
    ): Promise<import('../shared/project-resource-reference').ResolvedProjectResourceReference>;

    mkdir(path: string, options?: { recursive?: boolean }, mutationToken?: string): Promise<void>;

    rename(oldPath: string, newPath: string, mutationToken?: string): Promise<void>;
    packageSequenceFile?(
      filePath: string,
      options?: { overwritePackageRoot?: string; requireConverted?: boolean }
    ): Promise<{
      productPath: string;
      packageRoots: string[];
      converted: boolean;
      skippedReason: string | null;
    }>;
    createPackageScratch?(
      packageRoot: string,
      mutationToken?: string
    ): Promise<PackageScratchLeaseSet>;
    removePackageScratch?(cleanupToken: string): Promise<void>;
    renamePackageScratchMember?(
      cleanupToken: string,
      oldPath: string,
      newPath: string
    ): Promise<void>;
    move(sourcePath: string, destinationDir: string): Promise<{ destPath: string }>;
    watchFile(path: string): Promise<void>;
    unwatchFile(path: string): Promise<void>;
  };
  pdf?: {
    extractStructured(
      request: import('../shared/pdf-extraction').StructuredPdfExtractionRequest
    ): Promise<import('../shared/pdf-extraction').StructuredPdfExtractionResult>;
  };
  dialog: {
    open(options: {
      directory?: boolean;
      fileOrDirectory?: boolean;
      multiple?: boolean;
      title?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<string | string[] | null>;
    authorizeLocalIndexedTrack(
      request: import('../shared/local-indexed-track-authority').LocalIndexedTrackAuthorityRequest
    ): Promise<import('../shared/local-indexed-track-authority').LocalIndexedTrackAuthorityReceipt>;
    save(options: {
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<string | null>;
  };
  remoteHosts?: RemoteHostsPort;
  looseSequenceFiles?: import('../shared/ipc/loose-sequence-files.contract').LooseSequenceFilesPort;
  thirdPartyNotices?: import('../shared/ipc/third-party-notices.contract').ThirdPartyNoticesPort;
  remoteGenomics?: {
    listEndpoints(): Promise<RemoteEndpointProfileV1[]>;
    renameEndpoint(
      endpointId: string,
      displayName: string
    ): Promise<RemoteEndpointProfileV1 | null>;
    forgetEndpoint(endpointId: string): Promise<boolean>;
    listStatuses(): Promise<RemoteGenomicsRuntimeStatusV1[]>;
    openExplorer(request: { requestId: string; target: string }): Promise<RemoteExplorerSessionV1>;
    listRemoteDirectory(sessionId: string, path: string): Promise<RemoteDirectoryListingV1>;
    closeExplorer(sessionId: string): Promise<boolean>;
    subscribeExplorerClosed(callback: (event: RemoteExplorerClosedEventV1) => void): () => void;
    cancelExplorerOpen(requestId: string): Promise<boolean>;
    respondAuthPrompt(promptId: string, answer: string | null): Promise<boolean>;
    subscribeAuthPrompt(callback: (prompt: RemoteSshAuthPromptV1) => void): () => void;
    subscribeAuthPromptClosed(callback: (promptId: string) => void): () => void;
    connectAlignment(
      request: RemoteAlignmentConnectRequestV1
    ): Promise<RemoteAlignmentMaterializationV1>;
    connectSignal(request: RemoteSignalConnectRequestV1): Promise<RemoteSignalMaterializationV1>;
    cancelConnect(requestId: string): Promise<boolean>;
    disconnectSession(sessionId: string): Promise<void>;
    retryEndpoint(endpointIdOrTarget: string): Promise<boolean>;
    subscribeStatus(callback: (event: RemoteGenomicsRuntimeStatusEventV1) => void): () => void;
  };
  path: {
    appDataDir(): Promise<string>;
    referenceAssetCacheRoot(): Promise<string>;
    referenceAssetPublicationRoot(): Promise<string>;
    projectRoot(): Promise<string | null>;
  };
  trackViewCommands: ClientOf<
    typeof import('../shared/ipc/track-view-commands.contract').trackViewCommandsContract
  >;
  trackViews: TrackViewsBridge & {
    command(
      request: import('@waypoint/domain-services').TrackViewCommand
    ): Promise<import('@waypoint/domain-services').TrackViewCommandResult>;
  };
  molecularDocuments: MolecularDocumentsBridge;
  comparisonSources: ClientOf<
    typeof import('../shared/ipc/comparison-sources.contract').comparisonSourcesContract
  >;
  contactSources: ClientOf<
    typeof import('../shared/ipc/contact-sources.contract').contactSourcesContract
  >;
  sequenceDataLayers: ClientOf<
    typeof import('../shared/ipc/sequence-data-layers.contract').sequenceDataLayersContract
  >;
  trackStore: TrackStoreBridge;
  referenceAssets: ReferenceAssetsBridge;
  workspace: OriginalProjectPort & {
    resolveProjectRoot(request: ResolveProjectRootRequest): Promise<ResolvedProjectRoot>;
    rootStatus(): Promise<import('../shared/workspace-root-recovery').WorkspaceRootStatus[]>;
    relinkRoot(
      request: import('../shared/workspace-root-recovery').RelinkWorkspaceRootRequest
    ): Promise<import('../shared/workspace-root-recovery').RelinkWorkspaceRootResult>;
    createSampleInstance(
      request: CreateSampleWorkspaceInstanceRequest
    ): Promise<SampleWorkspaceInstanceResult>;
    importManaged(request: ImportManagedWorkspaceRequest): Promise<ImportManagedWorkspaceResult>;
    recoverLegacyPrimerLibrary(): Promise<
      import('../shared/legacy-primer-library-recovery').LegacyPrimerLibraryRecoveryResult
    >;
    createEmptyWorkspace(request: CreateEmptyWorkspaceRequest): Promise<CreateEmptyWorkspaceResult>;
    getOriginalDefaultProject(): Promise<OriginalDefaultProjectResolution>;
    identifyOriginalDefaultProject(
      request: IdentifyOriginalDefaultProjectRequest
    ): Promise<OriginalDefaultProjectResolution>;

    importFile(request: ImportFileRequest): Promise<ImportFileResult>;
    relocateEntityFile(request: RelocateEntityFileInput): Promise<RelocateEntityFileResult>;
    relinkMovedEntityFile(request: RelocateEntityFileInput): Promise<RelocateEntityFileResult>;
    importFileFromContent(request: ImportContentRequest): Promise<ImportFileResult>;
    importSequenceFromContent(
      request: ImportSequenceContentRequest
    ): Promise<ImportSequenceContentResult>;
    importFolder(request: { targetRoot: string; sourcePath: string }): Promise<ImportFileResult>;
    previewImportDedup(request: {
      sourcePaths: string[];
      targetRoot: string;
    }): Promise<import('../shared/import-dedup').DedupPreviewItem[]>;
    previewSequenceImport(
      request: SequenceImportPreviewRequest
    ): Promise<SequenceImportPreviewResult>;
    importFileAsNewWorkspace(request: {
      sourcePath: string;
    }): Promise<ImportManagedWorkspaceResult>;
    registerImportedSequence(
      request: RegisterImportedSequenceRequest
    ): Promise<RegisterImportedSequenceResult>;
    registerImportedSequenceFromContent(
      request: RegisterImportedSequenceFromContentRequest
    ): Promise<RegisterImportedSequenceResult>;
    getPathForFile(file: File): string;
    purgeTrashed(request: { repoUuid: string }): Promise<PurgeTrashedWorkspaceResult>;
    transitionLifecycle(
      request: ManagedWorkspaceLifecycleRequest
    ): Promise<ManagedWorkspaceLifecycleResult>;
    rename(request: ManagedWorkspaceRenameRequest): Promise<ManagedWorkspaceRenameResult>;
    indexManagedHead(request: { repoPath: string }): Promise<ManagedHeadIndex>;
    indexManagedCatalogHead(
      request: ManagedCatalogHeadIndexRequest
    ): Promise<ManagedCatalogHeadIndex>;
    discoverArtifacts(
      request: WorkspaceArtifactDiscoveryRequest
    ): Promise<WorkspaceArtifactDiscoveryResult>;
    migrateLegacyProjectFiles?(request: {
      repoPath: string;
      mutationToken?: string;
    }): Promise<import('../shared/workspace-git-types').WorkspaceEntityMigrationResult>;
    onMigrationCandidatesChanged?(callback: (event: { workspaceRoot: string }) => void): () => void;
    listChildren(request: WorkspaceListChildrenRequest): Promise<WorkspaceListChildrenResult>;
    reconcileNativeRecords(request: NativeCatalogRecordReconcileRequest): Promise<number>;
    setDocumentCommandRoots(request: NativeDocumentWorkspaceRootsRequest): Promise<boolean>;
    resolveRegisteredProject?(
      reference: string
    ): Promise<import('../shared/agent-project-scope').AuthorizedProjectFolder | null>;
    listRegisteredProjects?(): Promise<
      import('../shared/agent-project-scope').AuthorizedProjectFolder[]
    >;
    onImportProgress(callback: (event: ImportProgressEvent) => void): () => void;
  };
  shell: {
    savedFileSource(request:import('../shared/saved-file-source-command').SavedFileSourceRequest):Promise<import('../shared/saved-file-source-command').SavedFileSourceResult>;
    projectHistory(
      request: import('../shared/project-history').ProjectHistoryRequest
    ): Promise<import('../shared/project-history').ProjectHistoryResult>;
    onProjectHistoryChanged(callback: (workspaceRoot: string) => void): () => void;
    fileTrash(
      request: import('../shared/workspace-file-trash').WorkspaceFileTrashRequest
    ): Promise<import('../shared/workspace-file-trash').WorkspaceFileTrashResult>;
    revealItemInDir(path: string): Promise<void>;
    trashItem(path: string, mutationToken?: string): Promise<void>;
    execute(
      program: string,
      args: string[],
      cwd: string,
      mutationToken?: string
    ): Promise<{ stdout: string; stderr: string; code: number }>;
    readGitHead(filePath: string, requestId: string): Promise<string | null>;
    cancelGitRead(requestId: string, closeGestureToken?: string): Promise<boolean>;
  };
  googleSheets: import('../shared/ipc/google-sheets.contract').GoogleSheetsPort;
  clipboard: {
    writeText(text: string): Promise<void>;
  };
  genome: {
    open(source: GenomeOpenSource): Promise<GenomeSessionShell>;
    closeSession(sessionId: string): Promise<GenomeSessionReleaseResult>;
    upgradeSessionCapabilities(
      sessionId: string,
      source: GenomeOpenSource
    ): Promise<GenomeSessionShell>;
    getAssemblyOverview(request: AssemblyOverviewRequest): Promise<AssemblyOverviewResult>;
    readAssemblyOverviewTexture(
      request: AssemblyTextureReadRequest
    ): Promise<AssemblyOverviewTextureReadResult | null>;
    readAssemblyAnnotationRasterV2(
      request: AssemblyAnnotationRasterReadRequestV2
    ): Promise<AssemblyAnnotationRasterReadResultV2 | null>;
    prepareAssemblyAnnotationAppearanceV1(
      request: import('../shared/indexed-genome').AssemblyAnnotationAppearancePrepareRequestV1
    ): Promise<import('../shared/indexed-genome').AssemblyAnnotationAppearancePrepareResultV1>;
    readAssemblyCompiledBroadRasterManifestV1(
      request: AssemblyCompiledBroadRasterManifestRequestV1
    ): Promise<AssemblyCompiledBroadRasterManifestResultV1 | null>;
    readAssemblyCompiledBroadRasterCellsV1(
      request: AssemblyCompiledBroadRasterCellsRequestV1
    ): Promise<AssemblyCompiledBroadRasterCellsResultV1>;
    writeAssemblyOverviewTexture(
      request: AssemblyTextureWriteRequest
    ): Promise<AssemblyTextureWriteResult | null>;
    readAssemblyAnnotationScene(
      request: AssemblyAnnotationSceneReadRequest,
      options?: {
        signal?: AbortSignal;
        retainedAssetGeneration?: AssemblyReferenceAssetGenerationV1 | null;
        retainedInteractionOwnerKey?: string | null;
      }
    ): Promise<AssemblyAnnotationSceneReadResult | null>;
    readAssemblyAnnotationSceneDetailV1(
      request: AssemblyAnnotationSceneDetailReadRequestV1,
      options?: { signal?: AbortSignal }
    ): Promise<AssemblyAnnotationSceneDetailReadResultV1 | null>;
    readAssemblyCompiledBroadInteractionV1(
      request: AssemblyAnnotationSceneReadRequest,
      options?: { signal?: AbortSignal }
    ): Promise<AssemblyCompiledBroadInteractionHitResultV1 | null>;
    queryAssemblyAnnotationSearch(
      request: AssemblyAnnotationSearchQueryRequestV1,
      options?: { signal?: AbortSignal }
    ): Promise<AssemblyAnnotationSearchQueryResultV1 | null>;
    cancelAssemblyAnnotationSearch(
      request: AssemblyAnnotationSearchCancelRequestV1
    ): Promise<boolean>;
    queryAssemblyProteinSearch(
      request: AssemblyProteinSearchQueryRequestV1,
      options?: { signal?: AbortSignal }
    ): Promise<AssemblyProteinSearchQueryResultV1 | null>;
    cancelAssemblyProteinSearch(request: AssemblyProteinSearchCancelRequestV1): Promise<boolean>;
    getTrustedAssemblyAnnotationScene(
      result: AssemblyAnnotationSceneReadResult
    ): TrustedAssemblyAnnotationSceneV4 | null;
    readAssemblyAnnotationProductSetInventoryV1(
      request: AssemblyAnnotationProductSetInventoryReadRequestV1
    ): Promise<AssemblyAnnotationProductSetInventoryReadResultV1>;
    writeAssemblyAnnotationScene(
      request: AssemblyAnnotationSceneWriteRequest
    ): Promise<AssemblyAnnotationSceneWriteResult | null>;
    readAssemblyOverviewFeatures(
      request: AssemblyFeaturesReadRequest
    ): Promise<AssemblyOverviewFeaturesReadResult | null>;
    writeAssemblyOverviewFeatures(
      request: AssemblyFeaturesWriteRequest
    ): Promise<AssemblyFeaturesWriteResult | null>;
    init(manifest: IndexedGenomeManifest): Promise<GenomeDataInitResult>;
    getTrackTile(
      sessionId: string,
      request: GenomeTileRequest,
      requestId?: string
    ): Promise<GenomeTrackTile>;
    getAnnotationTile(
      sessionId: string,
      request: GenomeAnnotationTileRequest,
      requestId?: string
    ): Promise<GenomeTrackTile>;
    getDebugSnapshot(sessionId: string): Promise<GenomeDebugSnapshot>;
    getSession(sessionId: string): Promise<GenomeSessionShell>;
    cancelRequest(sessionId: string, requestId: string): Promise<GenomeCancelRequestResult>;
    getFeatureDetails(
      sessionId: string,
      request: GenomeFeatureDetailsRequest,
      requestId?: string
    ): Promise<GenomeFeatureDetails>;
    getFeatureDetailsByManifest(
      manifest: IndexedGenomeManifest,
      request: GenomeFeatureDetailsRequest
    ): Promise<GenomeFeatureDetails>;
    getSequenceWindow(
      sessionId: string,
      request: GenomeSequenceWindowRequest,
      requestId?: string
    ): Promise<GenomeSequenceWindow>;
    getSequence(
      manifest: IndexedGenomeManifest,
      chrom: string,
      start: number,
      end: number
    ): Promise<string>;
    getFeatures(
      manifest: IndexedGenomeManifest,
      chrom: string,
      start: number,
      end: number,
      zoomLevel: number
    ): Promise<GenomeFeature[]>;
    searchSequence(
      manifest: IndexedGenomeManifest,
      chrom: string,
      motif: string,
      opts: GenomeSearchOptions | undefined,
      control: GenomeSearchRequestControlV1
    ): Promise<GenomeSearchHit[]>;
    searchAssemblySequence(
      request: AssemblySequenceSearchRequestV1,
      options?: { signal?: AbortSignal }
    ): Promise<AssemblySequenceSearchResultV1>;
    cancelSequenceSearch(request: GenomeSearchRequestIdentityV1): Promise<boolean>;
  };
  window: {
    showMenu(
      menuId: import('../shared/window-menu').WindowsMenuId,
      position: import('../shared/window-menu').WindowMenuPosition
    ): Promise<void>;
    setTitleBarTheme(dark: boolean): Promise<void>;
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    unmaximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    setSize(width: number, height: number): Promise<void>;
    setPosition(x: number, y: number): Promise<void>;
    getSize(): Promise<{ width: number; height: number }>;
    getPosition(): Promise<{ x: number; y: number }>;
    setZoomLevel(level: number): Promise<import('../shared/window-zoom').WindowZoomResult>;
  };
  on<C extends GenericMainSendChannel>(
    channel: C,
    callback: (...args: MainSendArguments<C>) => void
  ): () => void;
  agentTools: {
    onCall(callback: (payload: RendererAgentBridgePayload) => void): () => void;
    onCancel(callback: (payload: RendererAgentBridgeCancelPayload) => void): () => void;
    respond(requestId: string, response: RendererToolCallResponseShape): void;
  };
  agentConfirm: {
    onRequest(callback: (payload: DestructiveFileConfirmRequest) => void): () => void;
    onCancel(callback: (requestId: string) => void): () => void;
    respond(requestId: string, response: DestructiveFileConfirmResponse): void;
    onUserInputRequest(callback: (payload: AgentUserInputRequest) => void): () => void;
    onUserInputCancel(callback: (requestId: string) => void): () => void;
    respondUserInput(requestId: string, response: AgentUserInputResponse): void;
  };
  largeFileImportDialog: {
    onRequest(callback: (payload: LargeFileImportDialogRequest) => void): () => void;
    onCancel(callback: (requestId: string) => void): () => void;
    respond(requestId: string, response: LargeFileImportDialogResponse): void;
  };
  app: {
    reportDirtyState(state: DirtyWorkState): void;
    saveAllDone(requestId: string, result?: SaveAllResult): void;
  };
  update: {
    install(expectedVersion?: string): Promise<UpdateInstallResult>;
    retry(): Promise<void>;
    checkManual(): Promise<void>;
    simulate?(...args: UpdateSimulationArguments): Promise<void>;
  };
  keyring: {
    hasPassword(service: string, name: string): Promise<boolean>;
    getPassword(service: string, name: string): Promise<string | null>;
    setPassword(service: string, name: string, password: string): Promise<void>;
    deletePassword(service: string, name: string): Promise<void>;
  };
  genomeCredentials: {
    save(input: GenomeSourceCredentialInput): Promise<GenomeSourceCredentialSummary>;
    status(authRef: string): Promise<GenomeSourceCredentialStatus>;
    prepare(authRef: string): Promise<GenomeSourceCredentialSummary>;
    remove(authRef: string): Promise<GenomeSourceCredentialRemovalResult>;
  };
  workspaceMutations: WorkspaceRendererMutationEvents;
  compute: {
    recoverLegacyResult(
      id: string
    ): Promise<import('../shared/compute-jobs-ipc').ComputeRecoveryResult>;
    listProviders(): Promise<ComputeProviderSummary[]>;
    installManifest(manifestJson: string): Promise<ComputeManifestInstallResult>;
    removeCustomProvider(providerId: string): Promise<ComputeManifestRemoveResult>;
    connect(providerId: string, secret: string): Promise<ComputeConnectResult>;
    test(providerId: string): Promise<ComputeConnectResult>;
    disconnect(providerId: string): Promise<ComputeDisconnectResult>;
    recordJobIntent(input: ComputeJobIntentInput): Promise<ComputeJobIntentReceipt>;
    markJobSubmitted(id: string, remoteId: string): Promise<ComputeJobRecord | null>;
    markJobFailed(id: string, error: string): Promise<ComputeJobRecord | null>;
    markJobSubmissionUnknown(id: string, error: string): Promise<ComputeJobRecord | null>;
    markJobCanceled(id: string, providerState: string): Promise<ComputeJobRecord | null>;
    markJobImported(
      id: string,
      paths: string[],
      details?: ComputeImportDetails | null
    ): Promise<ComputeJobRecord | null>;
    listJobs(options?: ComputeJobsListOptions): Promise<ComputeJobRecord[]>;
    listJobsSnapshot(options?: ComputeJobsSnapshotOptions): Promise<ComputeJobsSnapshot>;
    findJob(providerId: string, remoteId: string): Promise<ComputeJobRecord | null>;
  };
  cloudSync: ScientificRecoveryPort & {
    backupWorkspace(request: CloudSyncWorkspaceRequest): Promise<CloudSyncBackupResult>;
    shareWorkspace(request: CloudSyncWorkspaceRequest): Promise<CloudSyncShareResult>;
    listSnapshots(): Promise<CloudSyncSnapshotSummary[]>;
    restoreSnapshot(snapshotId?: string): Promise<CloudSyncRestoreResult>;
    getStatus(workspaceUuid: string): Promise<WorkspaceSyncStatus>;
    subscribeStatus(
      workspaceUuid: string,
      callback: (event: WorkspaceSyncStatusEvent) => void
    ): () => void;
    onOrganizationRegistryChanged(
      callback: (event: OrganizationRegistryChangedEvent) => void
    ): () => void;
    onReplicaLifecycle(
      callback: (event: WorkspaceSyncReplicaLifecycleEvent) => void | Promise<void>
    ): () => void;
    setEnabled(
      workspaceUuid: string,
      enabled: boolean,
      options?: WorkspaceSyncEnableOptions
    ): Promise<WorkspaceSyncSetEnabledResult>;
    listOrganizations(): Promise<WorkspaceSyncOrganizationsResult>;
    createOrganization(
      request: WorkspaceSyncCreateOrganizationRequest
    ): Promise<WorkspaceSyncCreateOrganizationResult>;
    updateOrganization(
      orgId: string,
      request: WorkspaceSyncUpdateOrganizationRequest
    ): Promise<WorkspaceSyncUpdateOrganizationResult>;
    deleteOrganization(orgId: string): Promise<WorkspaceSyncDeleteOrganizationResult>;
    listOrganizationDirectory(orgId: string): Promise<WorkspaceSyncOrgDirectoryResult>;
    getOrganizationProvisioningStatus(
      orgId: string
    ): Promise<WorkspaceSyncOrganizationProvisioningStatusResult>;
    openOrganizationProvisioningPortal(
      orgId: string
    ): Promise<WorkspaceSyncOpenOrganizationProvisioningPortalResult>;
    setOrganizationProvisioningGroupRole(
      orgId: string,
      request: WorkspaceSyncSetOrganizationProvisioningGroupRoleRequest
    ): Promise<WorkspaceSyncSetOrganizationProvisioningGroupRoleResult>;
    listOrganizationAudit(
      orgId: string,
      type?: string
    ): Promise<WorkspaceSyncOrganizationAuditResult>;
    inviteOrganizationMember(
      orgId: string,
      request: WorkspaceSyncOrgInviteRequest
    ): Promise<WorkspaceSyncOrgInviteResult>;
    resendOrganizationInvite(
      orgId: string,
      inviteId: string
    ): Promise<WorkspaceSyncOrgInviteResult>;
    revokeOrganizationInvite(
      orgId: string,
      inviteId: string
    ): Promise<WorkspaceSyncRevokeInviteResult>;
    changeOrganizationMemberRole(
      orgId: string,
      accountId: string,
      request: { roleId: WorkspaceSyncOrgRole }
    ): Promise<WorkspaceSyncOrgMemberMutationResult>;
    removeOrganizationMember(
      orgId: string,
      accountId: string
    ): Promise<WorkspaceSyncOrgMemberMutationResult>;
    transferOrganizationOwnership(
      orgId: string,
      accountId: string
    ): Promise<WorkspaceSyncTransferOrganizationOwnershipResult>;
    prepareOrganizationRegistryClaim(
      orgId: string,
      request: OrganizationRegistryClaimPreparationRequest
    ): Promise<OrganizationRegistryClaimPreparationResult>;
    claimOrganizationRegistryEntity(
      orgId: string,
      request: OrganizationRegistryClaimRequest
    ): Promise<OrganizationRegistryClaimResult>;
    getOrganizationRegistryRecordSyncStatus(
      entityId: string
    ): Promise<OrganizationRegistryRecordSyncStatusResult>;
    getOrganizationRegistrySavedRecordReview(
      orgId: string,
      entityId: string
    ): Promise<OrganizationRegistrySavedRecordReviewResult>;
    resolveOrganizationRegistrySavedRecord(
      orgId: string,
      request: OrganizationRegistrySavedRecordResolutionRequest
    ): Promise<OrganizationRegistrySavedRecordResolutionResult>;
    listCachedOrganizationRegistries(): Promise<OrganizationRegistryCachedOrganizationsResult>;
    getOrganizationRegistry(orgId: string): Promise<OrganizationRegistryReadResult>;
    getOrganizationRegistryRecordDetails(
      orgId: string,
      request: OrganizationRegistryRecordDetailsRequest
    ): Promise<OrganizationRegistryRecordDetailsResult>;
    syncOrganizationRegistry(orgId: string): Promise<OrganizationRegistrySyncResult>;
    mutateOrganizationRegistry(
      orgId: string,
      request: OrganizationRegistryMutationRequest
    ): Promise<OrganizationRegistryMutationResult>;
    configureOrganizationRegistry(
      orgId: string,
      request: OrganizationRegistryConfigurationRequest
    ): Promise<OrganizationRegistryConfigurationResult>;
    getOrganizationRegistrySyncHealth(orgId: string): Promise<OrganizationRegistrySyncHealthResult>;
    getOrganizationDeletionImpact(orgId: string): Promise<OrganizationDeletionImpactResult>;
    resolveOrganizationRegistryConflict(
      orgId: string,
      request: OrganizationRegistryConflictResolutionRequest
    ): Promise<OrganizationRegistryConflictResolutionResult>;
    listAccess(workspaceUuid: string): Promise<WorkspaceSyncAccessListingResult>;
    setAccess(
      workspaceUuid: string,
      request: WorkspaceSyncSetAccessRequest
    ): Promise<WorkspaceSyncSetAccessResult>;
    inviteCollaborator(
      workspaceUuid: string,
      request: WorkspaceSyncInviteRequest
    ): Promise<WorkspaceSyncInviteResult>;
    revokeInvite(workspaceUuid: string, inviteId: string): Promise<WorkspaceSyncRevokeInviteResult>;
    resendInvite(workspaceUuid: string, inviteId: string): Promise<WorkspaceSyncInviteResult>;
    reconcile(workspaceUuid: string): Promise<WorkspaceSyncReconcileResult>;
    getMergeConflict(workspaceUuid: string): Promise<WorkspaceSyncMergeConflictResult>;
    resolveMergeConflict(
      workspaceUuid: string,
      request: WorkspaceSyncResolveMergeRequest
    ): Promise<WorkspaceSyncReconcileResult>;
    forceSync(workspaceUuid: string): Promise<WorkspaceSyncForceSyncResult>;
    copyShareLink(workspaceUuid: string): Promise<WorkspaceSyncCopyShareLinkResult>;
    listSyncedProjects(): Promise<WorkspaceSyncProjectSummary[]>;
    openSyncedProject(remoteWorkspaceId: string): Promise<WorkspaceSyncOpenProjectResult>;
    resolveConflict(
      workspaceUuid: string,
      resolution: WorkspaceSyncConflictResolution
    ): Promise<WorkspaceSyncResolveConflictResult>;
    deleteCloudCopy(workspaceUuid: string): Promise<WorkspaceSyncDeleteCloudCopyResult>;
    updateSelection(
      workspaceUuid: string,
      request: WorkspaceSyncSelectionUpdate,
      options?: WorkspaceSyncEnableOptions
    ): Promise<WorkspaceSyncUploadPreviewResult>;
    previewUpload(
      workspaceUuid: string,
      options?: WorkspaceSyncEnableOptions
    ): Promise<WorkspaceSyncUploadPreviewResult>;
    preflightDeepShare(request: DeepShareSelectionRequest): Promise<DeepSharePreflightResult>;
    publishDeepShare(request: DeepSharePublishRequest): Promise<DeepSharePublishResult>;
    cancelDeepShare(): Promise<{ ok: true }>;
  };
  benchlingMigration: {
    getActiveRun(): Promise<BenchlingMigrationRunView | null>;
    resolveProviderReference(
      request: BenchlingMigrationResolveProviderReferenceRequest
    ): Promise<BenchlingMigrationResolveProviderReferenceResult>;
    surveyImportDestinations(
      request: BenchlingMigrationSurveyImportDestinationsRequest
    ): Promise<BenchlingMigrationImportDestinationSurveyView>;
    getHistory(): Promise<BenchlingMigrationHistorySummaryView[]>;
    getHistoryDetail(runId: string): Promise<BenchlingMigrationHistoryDetailView>;
    viewExternalSource(
      request: ExternalProviderSourceRequest
    ): Promise<ExternalProviderSourceResult>;
    importLocalBundle(
      request?: BenchlingMigrationImportLocalBundleRequest
    ): Promise<BenchlingMigrationImportLocalBundleResult>;
    addLinkedItemExports(
      request: BenchlingMigrationAddLinkedItemExportsRequest
    ): Promise<BenchlingMigrationAddLinkedItemExportsResult>;
    appendWorkspaceExports(
      request: BenchlingMigrationAppendWorkspaceExportsRequest
    ): Promise<BenchlingMigrationAppendWorkspaceExportsResult>;
    resolveImportDecision(
      request: BenchlingMigrationResolveImportDecisionRequest
    ): Promise<BenchlingMigrationResolveImportDecisionResult>;
    openLinkedItemRecoveryLocation(
      request: BenchlingMigrationOpenLinkedItemRecoveryLocationRequest
    ): Promise<BenchlingMigrationOpenLinkedItemRecoveryLocationResult>;
    start(runId: string): Promise<BenchlingMigrationRunView>;
    pause(runId: string): Promise<BenchlingMigrationRunView>;
    resume(runId: string): Promise<BenchlingMigrationRunView>;
    cancelPreserved(runId: string): Promise<BenchlingMigrationRunView>;
    startOverPreserved(runId: string): Promise<BenchlingMigrationRunView>;
    getReport(runId: string): Promise<BenchlingMigrationReportView | null>;
    unlock(runId: string): Promise<BenchlingMigrationUnlockResult>;
    discard(runId: string): Promise<BenchlingMigrationDiscardResult>;
    subscribeProgress(
      runId: string,
      callback: (event: BenchlingMigrationProgressEvent) => void,
      onStatus?: (status: BenchlingMigrationProgressSubscriptionStatus) => void
    ): () => void;
    onRenderValidationRequest(
      callback: (request: MigrationRenderValidationRequest) => void
    ): () => void;
    respondRenderValidation(requestId: string, response: MigrationRenderValidationResponse): void;
  };
  agentCapabilities: {
    discover(request: AgentCapabilityDiscoveryRequest): Promise<AgentCapabilitySnapshot>;
    resolve(selection: AgentCapabilitySelection): Promise<AgentCapabilitySelectionResult>;
    inspectSkill(request: AgentSkillInspectionRequest): Promise<AgentSkillInspectionResult>;
    forkConversation(request: AgentConversationForkRequest): Promise<AgentConversationForkResult>;
    listManaged(
      request: AgentManagedExtensionsListRequest
    ): Promise<AgentManagedExtensionsSnapshot>;
    saveCommand(request: AgentManagedCommandSaveRequest): Promise<AgentCapabilityMutationResult>;
    saveSkill(request: AgentManagedSkillSaveRequest): Promise<AgentCapabilityMutationResult>;
    importSkill(request: AgentManagedSkillImportRequest): Promise<AgentCapabilityMutationResult>;
    setSkillEnabled(
      request: AgentManagedSkillEnabledRequest
    ): Promise<AgentCapabilityMutationResult>;
    setProviderSkillEnabled(
      request: AgentProviderSkillEnabledRequest
    ): Promise<AgentCapabilityMutationResult>;
    listSkillPacks(): Promise<AgentSkillPackSummary[]>;
    browseSkillPack(
      request: AgentSkillCatalogBrowseRequest
    ): Promise<AgentSkillCatalogBrowseResult>;
    reviewCatalogSkill(
      request: AgentSkillCatalogReviewRequest
    ): Promise<AgentSkillCatalogReviewResult>;
    installCatalogSkill(
      request: AgentSkillCatalogInstallRequest
    ): Promise<AgentSkillCatalogInstallResult>;
    removeSkill(
      request: AgentCapabilityRecordRemovalRequest
    ): Promise<AgentCapabilityMutationResult>;
    removeCommand(
      request: AgentCapabilityRecordRemovalRequest
    ): Promise<AgentCapabilityMutationResult>;
    saveMemory(request: AgentManagedMemorySaveRequest): Promise<AgentCapabilityMutationResult>;
    removeMemory(
      request: AgentCapabilityRecordRemovalRequest
    ): Promise<AgentCapabilityMutationResult>;
    resetProviderMemory(
      request: AgentProviderMemoryResetRequest
    ): Promise<AgentCapabilityMutationResult>;
    inspectProviderPlugin(
      request: AgentProviderPluginManagementRequest
    ): Promise<AgentProviderPluginInspectionResult>;
    installProviderPlugin(
      request: AgentProviderPluginManagementRequest
    ): Promise<AgentCapabilityMutationResult>;
    removeProviderPlugin(
      request: AgentProviderPluginRemovalRequest
    ): Promise<AgentCapabilityMutationResult>;
  };

  agentAttachments: {
    capture(request: AgentAttachmentCaptureRequest): Promise<AgentAttachmentCaptureResult>;
    read(request: AgentAttachmentReadRequest): Promise<AgentAttachmentReadResult>;
  };

  agentSdk: {
    detect(pathOverrides?: AgentCliPathOverridesShape): Promise<AgentSdkDetectionShape>;
    getHelperLifecycleSnapshot(): Promise<AgentHelperLifecycleSnapshot>;
    getExternalMcpRegistration(): Promise<ExternalMcpRegistrationSnapshot>;
    refreshExternalMcpRegistration(): Promise<ExternalMcpRegistrationSnapshot>;
    getMcpHttpStatus(): Promise<McpHttpStatus>;
    setMcpHttp(settings: McpHttpSettings): Promise<McpHttpStatus>;
    probeMatrix(): Promise<AgentProviderProbeShape[]>;
    onTraceEvent(callback: (payload: AgentTraceEnvelopeShape) => void): () => void;
    onAuthEvent(callback: (payload: AgentAuthEnvelopeShape) => void): () => void;
    cancelQuery(queryId: string): Promise<{ ok: boolean; cancelled: boolean; error?: string }>;
    authenticate(
      transport: AgentTransport,
      options?: AgentAuthOptionsShape
    ): Promise<AgentAuthResultShape>;
    query(
      transport: AgentTransport,
      prompt: string,
      options?: AgentQueryOptionsShape
    ): Promise<AgentQueryResultShape>;
  };
  agentSession: {
    onEvent(callback: (payload: AgentSessionEventEnvelopeShape) => void): () => void;
    start(request: AgentSessionStartRequestShape): Promise<AgentSessionRunResultShape>;
    cancel(sessionId: string): Promise<AgentSessionCancelResultShape>;
    get(sessionId: string): Promise<AgentSessionRecordShape | null>;
    listSchedules(): Promise<AgentScheduleRecordShape[]>;
    cancelSchedule(scheduleId: string): Promise<AgentScheduleCancelResultShape>;
    listAlwaysAllowRules(): Promise<
      import('../shared/agent-runtime-ipc').AgentAlwaysAllowRuleShape[]
    >;
    setAlwaysAllowRuleEnabled(
      key: string,
      enabled: boolean
    ): Promise<import('../shared/agent-runtime-ipc').AgentAlwaysAllowRuleShape[]>;
    removeAlwaysAllowRule(
      key: string
    ): Promise<import('../shared/agent-runtime-ipc').AgentAlwaysAllowRuleShape[]>;
    permissionCatalog(): Promise<import('../shared/agent-permissions').AgentPermissionCatalog>;
  };
  conversationLedger: {
    appendEvent(
      input: ConversationLedgerAppendInputShape
    ): Promise<ConversationLedgerAppendResultShape>;
    unlinkConversation(conversationId: string): Promise<ConversationLedgerUnlinkResultShape>;
  };
  config: {
    getApiUrl(): Promise<string>;
    getSidecarStatus(): Promise<string>;
    restartSidecar(): Promise<string>;
  };
  feedback: import('../shared/ipc/feedback.contract').FeedbackPort & {
    report(input: AgentFeedbackInput): Promise<AgentFeedbackResult>;
  };
  internalFixtures: {
    retainTrack(request: { relativePath: string }): Promise<{ path: string }>;
    recoverTrack(request: {
      relativePath: string;
      previousPath: string;
    }): Promise<{ path: string | null }>;
    materialize(
      request: InternalAssemblyFixtureMaterializeRequest
    ): Promise<InternalAssemblyFixtureMaterializeResult>;
    status(
      request: InternalAssemblyFixtureStatusRequest
    ): Promise<InternalAssemblyFixtureStatusResult>;
    registerScenarioFiles(
      request: import('../shared/internal-fixtures').RegisterScenarioFixtureFilesRequest
    ): Promise<{ manifestPath: string }>;
  };
  analytics: {
    getRuntimeConfig(): Promise<AnalyticsRuntimeConfig | null>;
    getOptIn(): Promise<boolean>;
    persistConsent(enabled: boolean): Promise<void>;
    syncContext(context: AnalyticsIdentityContext): Promise<AnalyticsIdentitySyncResult>;
    enqueueWorkflowEvent?(request: RendererWorkflowTelemetryRequest): Promise<boolean>;
    writeTableNotebookReceipt?(
      request: import('../shared/table-notebook-observation').TableNotebookReceiptMutation
    ): Promise<boolean>;
    setConsent(enabled: boolean): Promise<void>;
  };
  convertFileSrc(filePath: string): Promise<string>;
}
