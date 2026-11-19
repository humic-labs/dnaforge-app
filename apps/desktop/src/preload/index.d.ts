import { entityDiscoveryContract } from '../shared/ipc/entity-discovery.contract';
import { primerArtifactContract } from '../shared/ipc/primer-artifact.contract';
import { sequenceAlignmentHistoryContract } from '../shared/ipc/sequence-alignment-history.contract';
import { originalProjectContract } from '../shared/ipc/original-project.contract';
import { organizationRegistryContract } from '../shared/ipc/organization-registry.contract';
import type { molecularDataContract } from '../shared/ipc/molecular-data.contract';
import type { ScientificRecoveryPort } from '../shared/ipc/scientific-recovery.contract';
import type { LooseSequenceFilesPort } from '../shared/ipc/loose-sequence-files.contract';
import type { FeedbackPort } from '../shared/ipc/feedback.contract';
import type { HostedAllowancePort } from '../shared/ipc/hosted-allowance.contract';
import type { ClientOf } from '../shared/ipc/contract';
import type { administrationContract } from '../shared/ipc/administration.contract';
import type { importReviewContract } from '../shared/ipc/import-review.contract';
import type { notebookContract } from '../shared/ipc/notebook.contract';
import type { analyticsContract } from '../shared/ipc/analytics.contract';
import type { molecularCatalogContract } from '../shared/ipc/molecular-catalog.contract';
import type { configContract } from '../shared/ipc/config.contract';
import type { startupContract } from '../shared/ipc/startup.contract';
import type { updateContract } from '../shared/ipc/update.contract';
import type { keyringContract } from '../shared/ipc/keyring.contract';
import type { limsContract } from '../shared/ipc/lims.contract';
import type { scientificDocumentsContract } from '../shared/ipc/scientific-documents.contract';
import type { RemoteHostsPort } from '../shared/remote-hosts';
import type { RemoteGenomicsRuntimeStatusEventV1 } from '../shared/remote-genomics-ipc';
import type { GenericMainSendChannel, MainSendArguments } from '../shared/ipc-contract';
import type { SqliteIpcValue } from '../shared/sqlite-ipc';
import type { WorkspaceRendererMutationEvents } from '../shared/workspace-renderer-mutation';
import type { ThirdPartyNoticesPort } from '../shared/ipc/third-party-notices.contract';
import type { UpdateSimulationArguments } from '../shared/update-ipc';
import type { ProteinExperimentWorkersApi } from '../shared/protein-experiment-workers';
import type {
  AgentAuthOptionsShape,
  AgentAuthResultShape,
  AgentCancelQueryResultShape,
  AgentCliPathOverridesShape,
  AgentMcpServerLaunchShape,
  AgentProviderProbeShape,
  AgentQueryOptionsShape,
  AgentQueryResultShape,
  AgentSdkDetectionShape,
  AgentTransport,
} from '../shared/agent-runtime-ipc';
import type {
  RendererResourceReadResponseShape,
  RendererToolCallResponseShape,
} from '../shared/agent-tools-ipc';
import type {
  AgentUserInputResponse,
  DestructiveFileConfirmResponse,
} from '../shared/agent-confirm-types';
import type { LargeFileImportDialogResponse } from '../shared/large-file-import-dialog';
import type { PackageScratchLeaseSet } from '../shared/package-scratch-capability';
import type { GitReadLifecycleSnapshot } from '../shared/git-read-ipc';
import type { AgentHelperLifecycleSnapshot } from '../shared/agent-helper-lifecycle';
import type { ExternalMcpRegistrationSnapshot } from '../shared/external-mcp-registration';
import type {
  CommitChatTurnTerminalStateRequest,
  CommitChatTurnTerminalStateResult,
  CreateChatTurnWithUserMessageRequest,
} from '../shared/chat-turn-ipc';
import type { RuntimeProfile, RuntimeProvenance } from '../shared/runtime-profile';
import type {
  AssemblyAnnotationRasterReadRequestV2,
  AssemblyAnnotationRasterReadResultV2,
  AssemblyCompiledBroadRasterCellsRequestV1,
  AssemblyCompiledBroadRasterCellsResultV1,
  AssemblyCompiledBroadRasterManifestRequestV1,
  AssemblyCompiledBroadRasterManifestResultV1,
  AssemblyCompiledBroadInteractionWireHitResultV1,
  AssemblyOverviewRequest,
  AssemblyOverviewResult,
  AssemblyOverviewTextureReadResult,
  AssemblyTextureReadRequest,
  AssemblyTextureWriteRequest,
  AssemblyTextureWriteResult,
  AssemblyAnnotationProductSetInventoryReadRequestV1,
  AssemblyAnnotationProductSetInventoryReadResultV1,
  AssemblyReferenceAssetGenerationV1,
  AssemblyAnnotationSceneDetailReadRequestV1,
  AssemblyAnnotationSceneDetailWireReadResultV1,
  AssemblyAnnotationSceneReadRequest,
  AssemblyAnnotationSceneWireReadResult,
  AssemblyAnnotationSearchCancelRequestV1,
  AssemblyAnnotationSearchQueryRequestV1,
  AssemblyAnnotationSearchQueryResultV1,
  AssemblyProteinSearchCancelRequestV1,
  AssemblyProteinSearchQueryRequestV1,
  AssemblyProteinSearchQueryResultV1,
  AssemblySequenceSearchRequestV1,
  AssemblySequenceSearchResultV1,
  GenomeSearchRequestIdentityV1,
  AssemblyAnnotationSceneWriteRequest,
  AssemblyAnnotationSceneWriteResult,
  AssemblyFeaturesReadRequest,
  AssemblyOverviewFeaturesReadResult,
  AssemblyFeaturesWriteRequest,
  AssemblyFeaturesWriteResult,
} from '../shared/indexed-genome';
import type {
  WorkspaceBinaryFileAtomicWriteInput,
  WorkspaceTextFileAtomicWriteInput,
  WorkspaceTextFileAtomicWriteResult,
} from '../shared/workspace-file-atomic';
import type {
  MigrateNotebookPackageAtPathInput,
  PrepareNotebookPackageRenameInput,
  PublishNotebookPackageResult,
  RecoverNotebookPackageRenameInput,
  SerializablePublishNotebookPackageInput,
} from '../shared/notebook-package-ipc';
import type {
  HostedAiToolObservationRequest,
  HostedAiToolObservationResult,
  HostedAiToolClaimRequest,
  HostedAiToolClaimCompleteRequest,
  HostedAiToolClaimCancelRequest,
  HostedAiToolClaimResult,
  HostedAiWorkflowTerminalRequest,
  HostedAiWorkflowTerminalResult,
  HostedAiGenerationRequest,
  HostedAiGenerationResult,
  HostedAiRawTraceDeletionResult,
  HostedAiRouteAvailabilityResult,
  HostedAiWorkflowAuthorityResult,
  HostedAiStreamStartRequest,
  HostedAiStreamStartResult,
  HostedAiStreamCancelResult,
  HostedAiStreamEventEnvelope,
  HostedAiContributionGateRequest,
  HostedAiContributionGateResult,
  HostedAiTurnBindingRequest,
  HostedAiTurnBindingResult,
  HostedAiTurnBindingReleaseResult,
  HostedAiNativeToolRequest,
  HostedAiNativeToolResult,
  HostedAiNativeToolCancelResult,
} from '../shared/hosted-ai-gateway-ipc';
import type {
  WorkspaceSyncHistoryOptions,
  WorkspaceSyncVersionHistory,
  WorkspaceSyncReplicaLifecycleEvent,
  WorkspaceSyncStatusEvent,
} from '../shared/workspace-sync-ipc';
import type {
  BenchlingMigrationProgressEvent,
  BenchlingMigrationProgressSubscriptionStatus,
} from '../shared/benchling-migration-ipc';
import type {
  MigrationRenderValidationRequest,
  MigrationRenderValidationResponse,
} from '../shared/benchling-migration-render-validation';
import type { TrackStoreBridge } from '../shared/track-store';
import type { TrackViewsBridge } from '../shared/track-view';
import type { MolecularDocumentsBridge } from '../shared/molecular-document';
import type { ReferenceAssetsBridge } from './reference-assets';
import type {
  LimsApplyImportBatchInput,
  LimsApplyImportBatchResult,
  LimsAttachGenomeHypothesisInput,
  LimsAttachGenomeHypothesisResult,
  LimsAttachVerifiedGenomeInput,
  LimsAttachVerifiedGenomeResult,
  LimsDefineSchemaInput,
  LimsEntityActionInput,
  LimsEntityHistoryEntry,
  LimsEntityHistoryInput,
  LimsIdScheme,
  LimsLink,
  LimsLinkEntitiesInput,
  LimsReplaceOutgoingRelationshipsInput,
  LimsReplaceOutgoingRelationshipsResult,
  LimsPrimerUnionRow,
  LimsRecordStrainParentGenomeInput,
  LimsRecordStrainParentGenomeResult,
  LimsRefineSchemaInput,
  LimsRegistryPreview,
  LimsRegistryPreviewInput,
  LimsRegisterEntityInput,
  LimsRegistrationBadgeCandidate,
  LimsRegistrationBadgeInput,
  LimsRevertEntityResult,
  LimsSetIdSchemeInput,
  LimsStrainGenomeSummariesInput,
  LimsStrainGenomeSummariesResult,
  LimsStrainGenomeSummary,
  LimsStrainGenomeSummaryInput,
  LimsTelemetryInput,
  LimsAuditRow,
  LimsSchemaRow,
  LimsUndoImportBatchInput,
  LimsUndoImportBatchResult,
  LimsUpdateEntityInput,
} from '../shared/lims';

export interface IndexedGenomeManifest {
  chrom: string;
  fastaPath: string;
  faiPath: string;
  gziPath?: string | null;
  gffPath?: string | null;
  tbiPath?: string | null;
  length?: number;
  circular?: boolean;
  workspaceRootPaths?: string[];
}

export interface GenomeFeature {
  chrom: string;
  source: string;
  type: string;
  start: number;
  end: number;
  score: string | null;
  strand: '+' | '-' | '.';
  phase: string | null;
  attributes: Record<string, string[]>;
  raw: string;
  fileOffset?: number;
}

export interface GenomeFeatureDetailsRequest {
  chrom: string;
  start: number;
  end: number;
  featureId?: string;
  maxWindowBp?: number;
}

export interface GenomeFeatureDetails {
  chrom: string;
  featureId?: string;
  feature: GenomeFeature | null;
  relatedFeatures: GenomeFeature[];
  sourceRecordCount: number;
  window: {
    start: number;
    end: number;
  };
  truncated: boolean;
}

export interface GenomeSearchHit {
  chrom: string;
  start: number;
  end: number;
  strand: 'forward' | 'reverse';
  motif: string;
}

export interface GenomeSearchOptions {
  start?: number;
  end?: number;
  chunkSize?: number;
  maxResults?: number;
  reverseComplement?: boolean;
  caseSensitive?: boolean;
  validateIupacDna?: boolean;
}

export interface GenomeDataInitResult {
  length: number;
}

export type GenomeTrackState =
  | 'source_accepted'
  | 'metadata_pending'
  | 'coordinate_ready'
  | 'index_required'
  | 'building_cache'
  | 'validation_pending'
  | 'ready'
  | 'degraded'
  | 'error';

export type GenomeTileState =
  | 'missing'
  | 'queued'
  | 'loading'
  | 'building_summary'
  | 'retained'
  | 'ready'
  | 'empty'
  | 'stale'
  | 'error';

export type GenomeTileFidelity = 'summary' | 'exact' | 'best_available';
export type GenomeValidationState = 'unvalidated' | 'metadata_match' | 'strong_match' | 'mismatch';
export type GenomeAnnotationFeatureModel = 'raw-gff3' | 'resolved-transcript-v2';
export type GenomeTileCacheState = 'none' | 'hit' | 'miss' | 'written';
export type GenomeAssemblyCapabilityReadiness = 'pending' | 'ready';

import type {
  GenomeOpenIntent,
  GenomeOpenSource,
  GenomeSessionShell,
  GenomeTrackDescriptor,
} from '../shared/indexed-genome';
import type { computeContract } from '../shared/ipc/compute.contract';
import type { genomeCredentialsContract } from '../shared/ipc/genome-credentials.contract';
import type { pathContract } from '../shared/ipc/path.contract';
import type { entityNavigationContract } from '../shared/ipc/entity-navigation.contract';
import type { dialogContract } from '../shared/ipc/dialog.contract';
import type { googleSheetsContract } from '../shared/ipc/google-sheets.contract';
import type { clipboardContract } from '../shared/ipc/clipboard.contract';
import type { windowContract } from '../shared/ipc/window.contract';
import type { agentCapabilitiesContract } from '../shared/ipc/agent-capabilities.contract';
import type { agentAttachmentsContract } from '../shared/ipc/agent-attachments.contract';
import type { conversationLedgerContract } from '../shared/ipc/conversation-ledger.contract';
import type { remoteGenomicsContract } from '../shared/ipc/remote-genomics.contract';
import type { fileAssociationsContract } from '../shared/ipc/file-associations.contract';
import type { agentSessionContract } from '../shared/ipc/agent-session.contract';
import type { dbContract } from '../shared/ipc/db.contract';
import type { shellContract } from '../shared/ipc/shell.contract';
import type { cloudSyncBackupContract } from '../shared/ipc/cloud-sync-backup.contract';
import type { cloudSyncContract } from '../shared/ipc/cloud-sync.contract';
import type { cloudSyncDeepShareContract } from '../shared/ipc/cloud-sync-deep-share.contract';
import type { fsContract } from '../shared/ipc/fs.contract';
import type { fsInlineReferenceTargetContract } from '../shared/ipc/fs-inline-reference-target.contract';
import type { workspaceSamplesContract } from '../shared/ipc/workspace-samples.contract';
import type { workspaceContract } from '../shared/ipc/workspace.contract';
import type { workspaceRelocateContract } from '../shared/ipc/workspace-relocate.contract';
import type { workspaceBrowserContract } from '../shared/ipc/workspace-browser.contract';
import type { authContract } from '../shared/ipc/auth.contract';
import type { tracingContract } from '../shared/ipc/tracing.contract';
import type { agentToolsContract } from '../shared/ipc/agent-tools.contract';
import type { agentSdkContract } from '../shared/ipc/agent-sdk.contract';
import type { runtimeContract } from '../shared/ipc/runtime.contract';
import type { runtimeMemoryPressureOverrideContract } from '../shared/ipc/runtime-memory-pressure-override.contract';
import type { pdfContract } from '../shared/ipc/pdf.contract';
import type { benchlingMigrationContract } from '../shared/ipc/benchling-migration.contract';
import type { agentConfirmContract } from '../shared/ipc/agent-confirm.contract';
import type { largeFileImportDialogContract } from '../shared/ipc/large-file-import-dialog.contract';
import type { hostedCodexContract } from '../shared/ipc/hosted-codex.contract';
import type { internalFixturesContract } from '../shared/ipc/internal-fixtures.contract';
import type { workspaceNativeDocumentsContract } from '../shared/ipc/workspace-native-documents.contract';
import type { agentSdkMcpHttpListenerContract } from '../shared/ipc/agent-sdk-mcp-http-listener.contract';
export type { GenomeOpenIntent, GenomeOpenSource, GenomeSessionShell, GenomeTrackDescriptor };

export interface GenomeTileRequest {
  trackId: string;
  chrom: string;
  start: number;
  end: number;
  lod: number;
  generation: number;
  fidelity: GenomeTileFidelity;
  byteBudget?: number;
}

export type GenomeAnnotationTileRequest = GenomeTileRequest & {
  trackId: string;
};

export interface GenomeSequenceWindowRequest {
  chrom: string;
  start: number;
  end: number;
  generation: number;
}

export interface GenomeSequenceWindow {
  sessionId: string;
  requestId: string;
  chrom: string;
  start: number;
  end: number;
  generation: number;
  validationState: GenomeValidationState;
  byteCount: number;
  bases: string;
}

export interface GenomeSequenceTilePayload {
  type: 'sequence';
  startBp: number;
  endBp: number;
  bases: string;
}

export interface GenomeAnnotationGlyphPayloadItem {
  id: string;
  type: string;
  trackId?: string;
  trackLane?: number;
  trackLaneCapacity?: number;
  label: string;
  startBp: number;
  endBp: number;
  strand: '+' | '-' | '.';
  lane: number;
  color: number;
  exons?: ReadonlyArray<{ start: number; end: number }>;
  cds?: ReadonlyArray<{ start: number; end: number }>;
  transcriptId?: string;
  qualifiers?: Record<string, string | undefined>;
}

export type GenomeAnnotationCompactGlyphPayloadBase = [
  id: string,
  type: string,
  label: string,
  startBp: number,
  endBp: number,
  strand: '+' | '-' | '.',
  lane: number,
];

export type GenomeAnnotationCompactGlyphPayloadItem =
  | GenomeAnnotationCompactGlyphPayloadBase
  | [...GenomeAnnotationCompactGlyphPayloadBase, trackId: string]
  | [...GenomeAnnotationCompactGlyphPayloadBase, trackId: string, trackLane: number]
  | [
      ...GenomeAnnotationCompactGlyphPayloadBase,
      trackId: string,
      trackLane: number,
      trackLaneCapacity: number,
    ];

export type GenomeAnnotationCompactGlyphGeometryPayloadItem =
  | [id: string, exonRanges: number[]]
  | [id: string, exonRanges: number[], cdsRanges: number[]]
  | [id: string, exonRanges: number[], cdsRanges: number[], transcriptId: string];

export interface GenomeAnnotationGlyphPayload {
  type: 'annotation-glyphs';
  featureModel: GenomeAnnotationFeatureModel;
  glyphs: GenomeAnnotationGlyphPayloadItem[];
  compactGlyphs?: GenomeAnnotationCompactGlyphPayloadItem[];
  compactGeometry?: GenomeAnnotationCompactGlyphGeometryPayloadItem[];
  styleByType?: Record<string, { color: number }>;
  laneBounds?: {
    maxAnnotationLane: number;
    maxCdsLane: number;
  };
  droppedCount: number;
  typeFilteredCount: number;
}

export type GenomeTrackTilePayload = GenomeSequenceTilePayload | GenomeAnnotationGlyphPayload;

export interface GenomeTrackTile {
  sessionId: string;
  requestId: string;
  trackId: string;
  chrom: string;
  start: number;
  end: number;
  generation: number;
  state: GenomeTileState;
  fidelity: GenomeTileFidelity;
  validationState: GenomeValidationState;
  byteCount: number;
  recordCount: number;
  sourceRecordCount?: number;
  layerTypes?: string[];
  featureModel?: GenomeAnnotationFeatureModel;
  cacheState?: GenomeTileCacheState;
  payload?: GenomeTrackTilePayload;
  features?: GenomeFeature[];
  message?: string;
}

export type GenomeDebugRequestKind =
  | 'open'
  | 'session_update'
  | 'track_tile'
  | 'annotation_tile'
  | 'sequence_window'
  | 'feature_details'
  | 'overview_build';
export type GenomeDebugRequestStatus = 'started' | 'completed' | 'error' | 'cancelled';

export interface GenomeCancelRequestResult {
  sessionId: string;
  requestId: string;
  cancelled: boolean;
}

export interface GenomeDebugOpenTimings {
  acceptedAt: number;
  shellCreatedAt: number;
  shellReturnedAt?: number;
  coordinateReadyAt?: number;
  readyAt?: number;
  errorAt?: number;
  elapsedToShellMs?: number;
  elapsedToCoordinateReadyMs?: number;
  elapsedToReadyMs?: number;
  status: 'source_accepted' | 'metadata_pending' | 'coordinate_ready' | 'ready' | 'error';
}

export interface GenomeDebugBudgets {
  maxSequenceWindowBases: number;
  maxAnnotationViewportTileBases: number;
  maxAnnotationViewportTileBytes: number;
}

export interface GenomeDebugQueues {
  pendingRequests: number;
  recentRequestCount: number;
  workerCount: number;
}

export interface GenomeDebugSourceIndexes {
  fastaPath?: string;
  faiPath?: string;
  gffPath?: string | null;
  tbiPath?: string | null;
}

export interface GenomeDebugRequestTrace {
  traceId: string;
  requestId: string;
  kind: GenomeDebugRequestKind;
  status: GenomeDebugRequestStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  trackId?: string;
  chrom?: string;
  start?: number;
  end?: number;
  lod?: number;
  generation?: number;
  fidelity?: GenomeTileFidelity;
  byteBudget?: number;
  tileKey?: string;
  tileState?: GenomeTileState;
  validationState?: GenomeValidationState;
  cacheState?: GenomeTileCacheState;
  byteCount?: number;
  recordCount?: number;
  sourceRecordCount?: number;
  milestonesMs?: Record<string, number>;
}

export interface GenomeDebugSnapshot {
  sessionId: string;
  sourceFingerprint: string;
  sourcePath: string;
  sourcePathRedacted: string;
  chrom: string;
  coordinateReady: boolean;
  validationState: GenomeValidationState;
  openedAt: number;
  trackStates: Array<Pick<GenomeTrackDescriptor, 'id' | 'kind' | 'state' | 'userState'>>;
  sourceIndexes?: GenomeDebugSourceIndexes;
  open: GenomeDebugOpenTimings;
  budgets: GenomeDebugBudgets;
  queues: GenomeDebugQueues;
  recentRequests: GenomeDebugRequestTrace[];
}

export interface ElectronAPI {
  administration: ClientOf<typeof administrationContract>;
  importReview: ClientOf<typeof importReviewContract>;
  entityDiscovery: ClientOf<typeof entityDiscoveryContract>;
  notebook: ClientOf<typeof notebookContract>;
  terminal: import('../shared/terminal-port').TerminalPort;
  startup: ClientOf<typeof startupContract>;
  platform: NodeJS.Platform;
  sequenceWheel: import('../shared/sequence-wheel-ownership').SequenceWheelBridge;
  runtime: ClientOf<typeof runtimeContract> &
    ClientOf<typeof runtimeMemoryPressureOverrideContract> & {
      getProfile(): RuntimeProfile;
      getProvenance(): Promise<RuntimeProvenance>;
    };
  molecularCatalog: ClientOf<typeof molecularCatalogContract>;
  molecularData: ClientOf<typeof molecularDataContract>;
  scientificDocuments: ClientOf<typeof scientificDocumentsContract>;
  entityNavigation: ClientOf<typeof entityNavigationContract>;
  workTasks: ClientOf<typeof import('../shared/ipc/work-tasks.contract').workTasksContract>;
  scientificObjects: ClientOf<
    typeof import('../shared/ipc/scientific-objects.contract').scientificObjectsContract
  >;
  fileAssociations: ClientOf<typeof fileAssociationsContract>;

  db: ClientOf<typeof dbContract> & {
    select<T>(sql: string, params?: SqliteIpcValue[]): Promise<T>;
    createChatTurnWithUserMessage(input: CreateChatTurnWithUserMessageRequest): Promise<void>;
    commitChatTurnTerminalState(
      input: CommitChatTurnTerminalStateRequest
    ): Promise<CommitChatTurnTerminalStateResult>;
    deleteConversation(id: string): Promise<void>;
    deleteMessage(id: string): Promise<void>;
  };

  lims: ClientOf<typeof limsContract> & ClientOf<typeof primerArtifactContract>;

  fs: ClientOf<typeof sequenceAlignmentHistoryContract> &
    ClientOf<typeof fsContract> &
    ClientOf<typeof fsInlineReferenceTargetContract> & {
      writeWorkspaceBinaryFileAtomic(
        input: WorkspaceBinaryFileAtomicWriteInput
      ): Promise<WorkspaceTextFileAtomicWriteResult>;
      writeWorkspaceTextFileAtomic(
        input: WorkspaceTextFileAtomicWriteInput
      ): Promise<WorkspaceTextFileAtomicWriteResult>;
      publishNotebookPackageV2InMain(
        input: SerializablePublishNotebookPackageInput
      ): Promise<PublishNotebookPackageResult>;
      migrateNotebookPackageAtPathInMain(
        input: MigrateNotebookPackageAtPathInput
      ): Promise<PublishNotebookPackageResult | null>;
      prepareNotebookPackageRenameInMain(
        input: Omit<PrepareNotebookPackageRenameInput, 'now'>
      ): Promise<void>;
      recoverNotebookPackageRenameIfNeededInMain(
        input: RecoverNotebookPackageRenameInput
      ): Promise<PublishNotebookPackageResult | null>;
      packageSequenceFile?(
        filePath: string,
        options?: { overwritePackageRoot?: string }
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
    };

  pdf: ClientOf<typeof pdfContract>;

  dialog: ClientOf<typeof dialogContract>;

  remoteHosts: RemoteHostsPort;
  feedback: FeedbackPort &
    ClientOf<typeof import('../shared/ipc/agent-feedback.contract').agentFeedbackContract>;
  looseSequenceFiles: LooseSequenceFilesPort;
  remoteGenomics: ClientOf<typeof remoteGenomicsContract> & {
    subscribeStatus(callback: (event: RemoteGenomicsRuntimeStatusEventV1) => void): () => void;
  };

  path: ClientOf<typeof pathContract>;

  trackViewCommands: ClientOf<
    typeof import('../shared/ipc/track-view-commands.contract').trackViewCommandsContract
  >;
  trackViews: TrackViewsBridge;
  comparisonSources: ClientOf<
    typeof import('../shared/ipc/comparison-sources.contract').comparisonSourcesContract
  >;
  contactSources: ClientOf<
    typeof import('../shared/ipc/contact-sources.contract').contactSourcesContract
  >;
  sequenceDataLayers: ClientOf<
    typeof import('../shared/ipc/sequence-data-layers.contract').sequenceDataLayersContract
  >;
  molecularDocuments: MolecularDocumentsBridge;
  trackStore: TrackStoreBridge;
  referenceAssets: ReferenceAssetsBridge;

  workspace: ClientOf<typeof originalProjectContract> &
    ClientOf<typeof workspaceBrowserContract> &
    ClientOf<typeof workspaceRelocateContract> &
    ClientOf<typeof workspaceSamplesContract> &
    ClientOf<typeof workspaceContract> &
    ClientOf<typeof workspaceNativeDocumentsContract> & {
      getPathForFile(file: File): string;
    };

  thirdPartyNotices: ThirdPartyNoticesPort;

  tracing: ClientOf<typeof tracingContract>;

  shell: ClientOf<typeof shellContract> & {
    getGitReadLifecycleSnapshot(): Promise<GitReadLifecycleSnapshot>;
  };

  clipboard: ClientOf<typeof clipboardContract>;
  googleSheets: ClientOf<typeof googleSheetsContract>;

  genome: {
    open(source: GenomeOpenSource): Promise<GenomeSessionShell>;
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
      request: AssemblyAnnotationSceneReadRequest
    ): Promise<AssemblyAnnotationSceneWireReadResult | null>;
    readAssemblyAnnotationSceneDetailV1(
      request: AssemblyAnnotationSceneDetailReadRequestV1
    ): Promise<AssemblyAnnotationSceneDetailWireReadResultV1 | null>;
    readAssemblyCompiledBroadInteractionV1(
      request: AssemblyAnnotationSceneReadRequest
    ): Promise<AssemblyCompiledBroadInteractionWireHitResultV1 | null>;
    queryAssemblyAnnotationSearch(
      request: AssemblyAnnotationSearchQueryRequestV1
    ): Promise<AssemblyAnnotationSearchQueryResultV1 | null>;
    cancelAssemblyAnnotationSearch(
      request: AssemblyAnnotationSearchCancelRequestV1
    ): Promise<boolean>;
    queryAssemblyProteinSearch(
      request: AssemblyProteinSearchQueryRequestV1
    ): Promise<AssemblyProteinSearchQueryResultV1 | null>;
    cancelAssemblyProteinSearch(request: AssemblyProteinSearchCancelRequestV1): Promise<boolean>;
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
      control: GenomeSearchRequestIdentityV1
    ): Promise<GenomeSearchHit[]>;
    searchAssemblySequence(
      request: AssemblySequenceSearchRequestV1
    ): Promise<AssemblySequenceSearchResultV1>;
    cancelSequenceSearch(request: GenomeSearchRequestIdentityV1): Promise<boolean>;
  };

  window: ClientOf<typeof windowContract>;

  on<C extends GenericMainSendChannel>(
    channel: C,
    callback: (...args: MainSendArguments<C>) => void
  ): () => void;

  proteinExperimentWorkers: ProteinExperimentWorkersApi;

  agentTools: ClientOf<typeof agentToolsContract> & {
    respond(requestId: string, response: RendererToolCallResponseShape): void;
    respondResource(requestId: string, response: RendererResourceReadResponseShape): void;
  };

  agentConfirm: ClientOf<typeof agentConfirmContract> & {
    respond(requestId: string, response: DestructiveFileConfirmResponse): void;
    respondUserInput(requestId: string, response: AgentUserInputResponse): void;
  };

  largeFileImportDialog: ClientOf<typeof largeFileImportDialogContract> & {
    respond(requestId: string, response: LargeFileImportDialogResponse): void;
  };

  keyring: ClientOf<typeof keyringContract>;

  genomeCredentials: ClientOf<typeof genomeCredentialsContract>;

  compute: ClientOf<typeof computeContract>;

  auth: ClientOf<typeof authContract>;

  hostedAi: HostedAllowancePort & {
    prepareContribution(
      request: HostedAiContributionGateRequest
    ): Promise<HostedAiContributionGateResult>;
    validateTurnBinding(request: HostedAiTurnBindingRequest): Promise<HostedAiTurnBindingResult>;
    releaseTurnBinding(
      request: HostedAiTurnBindingRequest
    ): Promise<HostedAiTurnBindingReleaseResult>;
    startStream(request: HostedAiStreamStartRequest): Promise<HostedAiStreamStartResult>;
    cancelStream(clientRequestId: string): Promise<HostedAiStreamCancelResult>;
    onStreamEvent(callback: (envelope: HostedAiStreamEventEnvelope) => void): () => void;
    recordToolObservation(
      request: HostedAiToolObservationRequest
    ): Promise<HostedAiToolObservationResult>;
    claimTool(request: HostedAiToolClaimRequest): Promise<HostedAiToolClaimResult>;
    completeToolClaim(request: HostedAiToolClaimCompleteRequest): Promise<HostedAiToolClaimResult>;
    cancelToolClaim(request: HostedAiToolClaimCancelRequest): Promise<HostedAiToolClaimResult>;
    cancelWorkflow(
      request: HostedAiWorkflowTerminalRequest
    ): Promise<HostedAiWorkflowTerminalResult>;
    executeNativeTool(request: HostedAiNativeToolRequest): Promise<HostedAiNativeToolResult>;
    cancelNativeTool(operationId: string): Promise<HostedAiNativeToolCancelResult>;
    getWorkflowAuthority(): Promise<HostedAiWorkflowAuthorityResult>;
    getRouteAvailability(): Promise<HostedAiRouteAvailabilityResult>;
    requestRawTraceDeletion(): Promise<HostedAiRawTraceDeletionResult>;
  };

  hostedCodex: ClientOf<typeof hostedCodexContract>;

  workspaceMutations: WorkspaceRendererMutationEvents;
  cloudSync: ClientOf<typeof organizationRegistryContract> &
    ScientificRecoveryPort &
    ClientOf<typeof cloudSyncBackupContract> &
    ClientOf<typeof cloudSyncDeepShareContract> &
    ClientOf<typeof cloudSyncContract> & {
      subscribeStatus(
        workspaceUuid: string,
        callback: (event: WorkspaceSyncStatusEvent) => void
      ): () => void;
      onReplicaLifecycle(
        callback: (event: WorkspaceSyncReplicaLifecycleEvent) => void | Promise<void>
      ): () => void;
      listWorkspaceHistory(
        remoteWorkspaceId: string,
        options?: WorkspaceSyncHistoryOptions
      ): Promise<WorkspaceSyncVersionHistory>;
    };

  benchlingMigration: ClientOf<typeof benchlingMigrationContract> & {
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

  agentCapabilities: ClientOf<typeof agentCapabilitiesContract>;

  agentAttachments: ClientOf<typeof agentAttachmentsContract>;

  agentSdk: ClientOf<typeof agentSdkContract> &
    ClientOf<typeof agentSdkMcpHttpListenerContract> & {
      detect(pathOverrides?: AgentCliPathOverridesShape): Promise<AgentSdkDetectionShape>;
      getHelperLifecycleSnapshot(): Promise<AgentHelperLifecycleSnapshot>;
      getExternalMcpRegistration(): Promise<ExternalMcpRegistrationSnapshot>;
      refreshExternalMcpRegistration(): Promise<ExternalMcpRegistrationSnapshot>;
      probeMatrix(): Promise<AgentProviderProbeShape[]>;
      cancelQuery(queryId: string): Promise<AgentCancelQueryResultShape>;
      authenticate(
        transport: AgentTransport,
        options?: AgentAuthOptionsShape
      ): Promise<AgentAuthResultShape>;
      query(
        transport: AgentTransport,
        prompt: string,
        options?: AgentQueryOptionsShape
      ): Promise<AgentQueryResultShape>;
      getMcpBridgeLaunchForTest?(): Promise<AgentMcpServerLaunchShape>;
    };

  agentSession: ClientOf<typeof agentSessionContract>;

  conversationLedger: ClientOf<typeof conversationLedgerContract>;

  update: ClientOf<typeof updateContract> & {
    simulate?(...args: UpdateSimulationArguments): Promise<void>;
  };

  config: ClientOf<typeof configContract>;

  analytics: ClientOf<typeof analyticsContract>;

  reportRendererError(payload: {
    errorClass: string;
    source: 'error' | 'unhandledrejection';
  }): void;

  sendBreadcrumbs(lines: string[]): void;

  convertFileSrc(filePath: string): Promise<string>;

  internalFixtures: ClientOf<typeof internalFixturesContract>;

  getPathForFile(file: File): string;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
