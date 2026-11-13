/**
 * Generated from the typed preload API. Do not edit by hand.
 *
 * Regenerate deliberately with
 * `node scripts/generate-ipc-invoke-contract.mjs --write`, then review the diff.
 */
export interface InvokeEntry<Args extends unknown[], Result> {
  args: Args;
  result: Result;
}

export interface InvokeContract {
  "agentSdk:authenticate": InvokeEntry<[transport: import("./agent-runtime-ipc").AgentTransport, options?: import("./agent-runtime-ipc").AgentAuthOptionsShape], import("./agent-runtime-ipc").AgentAuthResultShape>;
  "agentSdk:cancelQuery": InvokeEntry<[queryId: string], import("./agent-runtime-ipc").AgentCancelQueryResultShape>;
  "agentSdk:detect": InvokeEntry<[pathOverrides?: Partial<Record<import("./agent-runtime-ipc").AgentTransport, string>>], import("./agent-runtime-ipc").AgentSdkDetectionShape>;
  "agentSdk:getExternalMcpRegistration": InvokeEntry<[], import("./external-mcp-registration").ExternalMcpRegistrationSnapshot>;
  "agentSdk:getHelperLifecycleSnapshot": InvokeEntry<[], import("./agent-helper-lifecycle").AgentHelperLifecycleSnapshot>;
  "agentSdk:getMcpBridgeLaunchForTest": InvokeEntry<[], import("./agent-runtime-ipc").AgentMcpServerLaunchShape>;
  "agentSdk:probeMatrix": InvokeEntry<[], import("./agent-runtime-ipc").AgentProviderProbeShape[]>;
  "agentSdk:query": InvokeEntry<[transport: import("./agent-runtime-ipc").AgentTransport, prompt: string, options?: import("./agent-runtime-ipc").AgentQueryOptionsShape], import("./agent-runtime-ipc").AgentQueryResultShape>;
  "agentSdk:refreshExternalMcpRegistration": InvokeEntry<[], import("./external-mcp-registration").ExternalMcpRegistrationSnapshot>;
  "analytics:setOptIn": InvokeEntry<[enabled: boolean], void>;
  "benchlingMigration:subscribeProgress": InvokeEntry<[arg1: { runId: string; subscriptionId: string; }], { ok: true; subscriptionId: string; }>;
  "benchlingMigration:unsubscribeProgress": InvokeEntry<[subscriptionId: string], { ok: true; }>;
  "cloudSync:listWorkspaceHistory": InvokeEntry<[remoteWorkspaceId: string, options?: import("./workspace-sync-ipc").WorkspaceSyncHistoryOptions], import("./workspace-sync-ipc").WorkspaceSyncVersionHistory>;
  "cloudSync:subscribeStatus": InvokeEntry<[arg1: { workspaceUuid: string; subscriptionId: string; }], { ok: boolean; subscriptionId: string }>;
  "cloudSync:unsubscribeStatus": InvokeEntry<[subscriptionId: string], { ok: boolean }>;
  "db:commitChatTurnTerminalState": InvokeEntry<[input: import("./chat-turn-ipc").CommitChatTurnTerminalStateRequest], import("./chat-turn-ipc").CommitChatTurnTerminalStateResult>;
  "db:createChatTurnWithUserMessage": InvokeEntry<[input: import("./chat-turn-ipc").CreateChatTurnWithUserMessageRequest], void>;
  "db:deleteConversation": InvokeEntry<[id: string], void>;
  "db:deleteMessage": InvokeEntry<[id: string], void>;
  "db:select": InvokeEntry<[sql: string, params?: import("./sqlite-ipc").SqliteIpcValue[]], import("./sqlite-ipc").SqliteIpcRow[]>;
  "fs:convertFileSrc": InvokeEntry<[filePath: string], string>;
  "fs:createPackageScratch": InvokeEntry<[packageRoot: string, mutationToken?: string], Readonly<{ staging: Readonly<{ path: string; cleanupToken: string; }>; previous: Readonly<{ path: string; cleanupToken: string; }>; }>>;
  "fs:migrateNotebookPackageAtPath": InvokeEntry<[input: import("./notebook-package-ipc").MigrateNotebookPackageAtPathInput], import("./notebook-package-ipc").PublishNotebookPackageResult | null>;
  "fs:packageSequenceFile": InvokeEntry<[filePath: string, options?: { overwritePackageRoot?: string; requireConverted?: boolean; }], { productPath: string; packageRoots: string[]; converted: boolean; skippedReason: string | null; }>;
  "fs:prepareNotebookPackageRename": InvokeEntry<[input: Omit<import("./notebook-package-ipc").PrepareNotebookPackageRenameInput, "now">], void>;
  "fs:publishNotebookPackageV2": InvokeEntry<[input: import("./notebook-package-ipc").SerializablePublishNotebookPackageInput], import("./notebook-package-ipc").PublishNotebookPackageResult>;
  "fs:recoverNotebookPackageRenameIfNeeded": InvokeEntry<[input: import("./notebook-package-ipc").RecoverNotebookPackageRenameInput], import("./notebook-package-ipc").PublishNotebookPackageResult | null>;
  "fs:removePackageScratch": InvokeEntry<[cleanupToken: string], void>;
  "fs:renamePackageScratchMember": InvokeEntry<[cleanupToken: string, oldPath: string, newPath: string], void>;
  "fs:writeWorkspaceBinaryFileAtomic": InvokeEntry<[input: import("./workspace-file-atomic").WorkspaceBinaryFileAtomicWriteInput], import("./workspace-file-atomic").WorkspaceTextFileAtomicWriteResponse>;
  "fs:writeWorkspaceTextFileAtomic": InvokeEntry<[input: import("./workspace-file-atomic").WorkspaceTextFileAtomicWriteInput], import("./workspace-file-atomic").WorkspaceTextFileAtomicWriteResponse>;
  "genome:cancelAssemblyAnnotationSearch": InvokeEntry<[input: import("./indexed-genome").AssemblyAnnotationSearchCancelRequestV1], boolean>;
  "genome:cancelAssemblyProteinSearch": InvokeEntry<[input: import("./indexed-genome").AssemblyProteinSearchCancelRequestV1], boolean>;
  "genome:cancelRequest": InvokeEntry<[sessionId: string, requestId: string], import("./indexed-genome").GenomeCancelRequestResult>;
  "genome:cancelSequenceSearch": InvokeEntry<[request: import("./indexed-genome").GenomeSearchRequestIdentityV1], boolean>;
  "genome:closeSession": InvokeEntry<[sessionId: string], import("./indexed-genome").GenomeSessionReleaseResult>;
  "genome:getAnnotationTile": InvokeEntry<[sessionId: string, request: import("./indexed-genome").GenomeAnnotationTileRequest, requestId?: string], import("./indexed-genome").GenomeTrackTile>;
  "genome:getAssemblyOverview": InvokeEntry<[input: import("./indexed-genome").AssemblyOverviewRequest], import("./indexed-genome").AssemblyOverviewResult>;
  "genome:getDebugSnapshot": InvokeEntry<[sessionId: string], import("./indexed-genome").GenomeDebugSnapshot>;
  "genome:getFeatureDetails": InvokeEntry<[sessionId: string, request: import("./indexed-genome").GenomeFeatureDetailsRequest, requestId?: string], import("./indexed-genome").GenomeFeatureDetails>;
  "genome:getFeatureDetailsByManifest": InvokeEntry<[manifest: import("./indexed-genome").IndexedGenomeManifest, request: import("./indexed-genome").GenomeFeatureDetailsRequest], import("./indexed-genome").GenomeFeatureDetails>;
  "genome:getFeatures": InvokeEntry<[manifest: import("./indexed-genome").IndexedGenomeManifest, chrom: string, start: number, end: number, zoomLevel: number], import("./indexed-genome").GenomeFeature[]>;
  "genome:getSequence": InvokeEntry<[manifest: import("./indexed-genome").IndexedGenomeManifest, chrom: string, start: number, end: number], string>;
  "genome:getSequenceWindow": InvokeEntry<[sessionId: string, request: import("./indexed-genome").GenomeSequenceWindowRequest, requestId?: string], import("./indexed-genome").GenomeSequenceWindow>;
  "genome:getSession": InvokeEntry<[sessionId: string], import("./indexed-genome").GenomeSessionShell>;
  "genome:getTrackTile": InvokeEntry<[sessionId: string, request: import("./indexed-genome").GenomeTileRequest, requestId?: string], import("./indexed-genome").GenomeTrackTile>;
  "genome:init": InvokeEntry<[manifest: import("./indexed-genome").IndexedGenomeManifest], { length: number; }>;
  "genome:open": InvokeEntry<[source: import("./indexed-genome").GenomeOpenSource], import("./indexed-genome").GenomeSessionShell>;
  "genome:queryAssemblyAnnotationSearch": InvokeEntry<[input: import("./indexed-genome").AssemblyAnnotationSearchQueryRequestV1], import("./indexed-genome").AssemblyAnnotationSearchQueryResultV1 | null>;
  "genome:queryAssemblyProteinSearch": InvokeEntry<[input: import("./indexed-genome").AssemblyProteinSearchQueryRequestV1], import("./indexed-genome").AssemblyProteinSearchQueryResultV1 | null>;
  "genome:readAssemblyAnnotationProductSetInventoryV1": InvokeEntry<[input: import("./indexed-genome").AssemblyAnnotationProductSetInventoryReadRequestV1], import("./indexed-genome").AssemblyAnnotationProductSetInventoryReadResultV1>;
  "genome:readAssemblyAnnotationRasterV2": InvokeEntry<[input: import("./indexed-genome").AssemblyAnnotationRasterReadRequestV2], import("./indexed-genome").AssemblyAnnotationRasterReadResultV2 | null>;
  "genome:readAssemblyAnnotationScene": InvokeEntry<[input: import("./indexed-genome").AssemblyAnnotationSceneReadRequest], import("./indexed-genome").AssemblyAnnotationSceneWireReadResult | null>;
  "genome:readAssemblyAnnotationSceneDetailV1": InvokeEntry<[input: import("./indexed-genome").AssemblyAnnotationSceneDetailReadRequestV1], import("./indexed-genome").AssemblyAnnotationSceneDetailWireReadResultV1 | null>;
  "genome:readAssemblyCompiledBroadInteractionV1": InvokeEntry<[input: import("./indexed-genome").AssemblyAnnotationSceneReadRequest], import("./indexed-genome").AssemblyCompiledBroadInteractionWireHitResultV1 | null>;
  "genome:readAssemblyCompiledBroadRasterCellsV1": InvokeEntry<[input: import("./indexed-genome").AssemblyCompiledBroadRasterCellsRequestV1], import("./indexed-genome").AssemblyCompiledBroadRasterCellsResultV1>;
  "genome:readAssemblyCompiledBroadRasterManifestV1": InvokeEntry<[input: import("./indexed-genome").AssemblyCompiledBroadRasterManifestRequestV1], import("./indexed-genome").AssemblyCompiledBroadRasterManifestResultV1 | null>;
  "genome:readAssemblyOverviewFeatures": InvokeEntry<[input: import("./indexed-genome").AssemblyFeaturesReadRequest], import("./indexed-genome").AssemblyOverviewFeaturesReadResult | null>;
  "genome:readAssemblyOverviewTexture": InvokeEntry<[input: import("./indexed-genome").AssemblyTextureReadRequest], import("./indexed-genome").AssemblyOverviewTextureReadResult | null>;
  "genome:searchAssemblySequence": InvokeEntry<[request: import("./indexed-genome").AssemblySequenceSearchRequestV1], import("./indexed-genome").AssemblySequenceSearchResultV1>;
  "genome:searchSequence": InvokeEntry<[manifest: import("./indexed-genome").IndexedGenomeManifest, chrom: string, motif: string, opts: import("./indexed-genome").GenomeSearchOptions | undefined, control: import("./indexed-genome").GenomeSearchRequestIdentityV1], import("./indexed-genome").GenomeSearchHit[]>;
  "genome:upgradeSessionCapabilities": InvokeEntry<[sessionId: string, source: import("./indexed-genome").GenomeOpenSource], import("./indexed-genome").GenomeSessionShell>;
  "genome:writeAssemblyAnnotationScene": InvokeEntry<[input: import("./indexed-genome").AssemblyAnnotationSceneWriteRequest], import("./indexed-genome").AssemblyAnnotationSceneWriteResult | null>;
  "genome:writeAssemblyOverviewFeatures": InvokeEntry<[input: import("./indexed-genome").AssemblyFeaturesWriteRequest], import("./indexed-genome").AssemblyFeaturesWriteResult | null>;
  "genome:writeAssemblyOverviewTexture": InvokeEntry<[input: import("./indexed-genome").AssemblyTextureWriteRequest], import("./indexed-genome").AssemblyTextureWriteResult | null>;
  "hostedAi:cancelNativeTool": InvokeEntry<[operationId: string], import("./hosted-ai-gateway-ipc").HostedAiNativeToolCancelResult>;
  "hostedAi:cancelStream": InvokeEntry<[clientRequestId: string], import("./hosted-ai-gateway-ipc").HostedAiStreamCancelResult>;
  "hostedAi:cancelToolClaim": InvokeEntry<[request: import("./hosted-ai-gateway-ipc").HostedAiToolClaimCancelRequest], import("./hosted-ai-gateway-ipc").HostedAiToolClaimResult>;
  "hostedAi:cancelWorkflow": InvokeEntry<[request: import("./hosted-ai-gateway-ipc").HostedAiWorkflowTerminalRequest], import("./hosted-ai-gateway-ipc").HostedAiWorkflowTerminalResult>;
  "hostedAi:claimTool": InvokeEntry<[request: import("./hosted-ai-gateway-ipc").HostedAiToolClaimRequest], import("./hosted-ai-gateway-ipc").HostedAiToolClaimResult>;
  "hostedAi:completeToolClaim": InvokeEntry<[request: import("./hosted-ai-gateway-ipc").HostedAiToolClaimCompleteRequest], import("./hosted-ai-gateway-ipc").HostedAiToolClaimResult>;
  "hostedAi:executeNativeTool": InvokeEntry<[request: import("./hosted-ai-gateway-ipc").HostedAiNativeToolRequest], import("./hosted-ai-gateway-ipc").HostedAiNativeToolResult>;
  "hostedAi:getRouteAvailability": InvokeEntry<[], import("./hosted-ai-gateway-ipc").HostedAiRouteAvailabilityResult>;
  "hostedAi:getWorkflowAuthority": InvokeEntry<[], import("./hosted-ai-gateway-ipc").HostedAiWorkflowAuthorityResult>;
  "hostedAi:prepareContribution": InvokeEntry<[request: import("./hosted-ai-gateway-ipc").HostedAiContributionGateRequest], import("./hosted-ai-gateway-ipc").HostedAiContributionGateResult>;
  "hostedAi:recordToolObservation": InvokeEntry<[request: import("./hosted-ai-gateway-ipc").HostedAiToolObservationRequest], import("./hosted-ai-gateway-ipc").HostedAiToolObservationResult>;
  "hostedAi:releaseTurnBinding": InvokeEntry<[request: import("./hosted-ai-gateway-ipc").HostedAiTurnBindingRequest], import("./hosted-ai-gateway-ipc").HostedAiTurnBindingReleaseResult>;
  "hostedAi:requestRawTraceDeletion": InvokeEntry<[], import("./hosted-ai-gateway-ipc").HostedAiRawTraceDeletionResult>;
  "hostedAi:startStream": InvokeEntry<[request: import("./hosted-ai-gateway-ipc").HostedAiStreamStartRequest], import("./hosted-ai-gateway-ipc").HostedAiStreamStartResult>;
  "hostedAi:validateTurnBinding": InvokeEntry<[request: import("./hosted-ai-gateway-ipc").HostedAiTurnBindingRequest], import("./hosted-ai-gateway-ipc").HostedAiTurnBindingResult>;
  "referenceAssets:getHostedPreparationStatus": InvokeEntry<[request: import("./reference-assets-ipc").ReferenceAssetGetHostedPreparationStatusRequestV1], import("./reference-assets-ipc").ReferenceAssetHostedPreparationStatusV1 | null>;
  "referenceAssets:getLocalPreparationStatus": InvokeEntry<[request: import("./reference-assets-ipc").ReferenceAssetGetLocalPreparationStatusRequestV1], import("./reference-assets-ipc").ReferenceAssetLocalPreparationStatusV1 | null>;
  "referenceAssets:importHubGenome": InvokeEntry<[request: import("./reference-assets-ipc").ReferenceAssetImportHubGenomeRequestV1], import("./reference-assets-ipc").ReferenceAssetImportHubGenomeResultV1>;
  "referenceAssets:importLocal": InvokeEntry<[request: import("./reference-assets-ipc").ReferenceAssetImportLocalRequestV1], import("./reference-assets-ipc").ReferenceAssetImportLocalResultV1>;
  "referenceAssets:installHosted": InvokeEntry<[request: import("./reference-assets-ipc").ReferenceAssetInstallHostedRequestV1], import("./reference-assets-ipc").ReferenceAssetInstallHostedResultV1>;
  "referenceAssets:listHosted": InvokeEntry<[], readonly import("./reference-assets-ipc").HostedReferenceCatalogEntryV1[]>;
  "referenceAssets:listLocal": InvokeEntry<[], readonly import("./reference-assets-ipc").PreparedReferenceAssemblyEntryV1[]>;
  "referenceAssets:retryLocal": InvokeEntry<[request: import("./reference-assets-ipc").ReferenceAssetRetryLocalRequestV1], import("./reference-assets-ipc").ReferenceAssetRetryLocalResultV1>;
  "referenceAssets:setOpenVersions": InvokeEntry<[versions: readonly import("./reference-assets-ipc").OpenReferenceVersionV1[]], void>;
  "remoteGenomics:subscribeStatus": InvokeEntry<[subscriptionId: string], import("./remote-genomics-ipc").RemoteGenomicsStatusSubscriptionV1>;
  "remoteGenomics:unsubscribeStatus": InvokeEntry<[subscriptionId: string], void>;
  "runtime:getProvenance": InvokeEntry<[], import("./runtime-profile").RuntimeProvenance>;
  "shell:getGitReadLifecycleSnapshot": InvokeEntry<[], import("./git-read-ipc").GitReadLifecycleSnapshot>;
  "terminal:focus": InvokeEntry<[id: string | null], void>;
  "terminal:paste": InvokeEntry<[id: string, warnMultiline: boolean], string>;
  "trackStore:listAssemblies": InvokeEntry<[], readonly string[]>;
  "trackStore:listTracks": InvokeEntry<[accession: string], readonly import("./track-store").TrackListing[]>;
  "trackStore:readMeta": InvokeEntry<[ref: import("./track-store").TrackRef], { schema: "dnaforge.track-meta.v1"; track: string; version: string; assembly: { accession: string; lengthBp: number; aliases?: string[] | undefined; }; file: { name: string; format: "gff3" | "bed" | "bigwig" | "bam"; sha256: string; byteLength: number; }; residency: { kind: "managed"; } | { path: string; kind: "linked"; } | { kind: "remote"; url: string; }; kinds: string[]; label: string; evidence: string; license: { attribution: string; name?: string | undefined; spdx?: string | undefined; evidenceUrl?: string | undefined; note?: string | undefined; }; url?: string | undefined; citation?: string | undefined; doi?: string | undefined; datasetVersion?: string | undefined; liftedFrom?: string | undefined; provenance?: { producedBy?: { tool: string; version?: string | undefined; command?: string | undefined; } | undefined; inputs?: { path?: string | undefined; sha256?: string | undefined; url?: string | undefined; note?: string | undefined; bytes?: number | undefined; }[] | undefined; derivedFrom?: string[] | undefined; notes?: string[] | undefined; } | undefined; }>;
  "trackStore:readTrackFile": InvokeEntry<[ref: import("./track-store").TrackRef], import("./track-store").TrackFileText>;
  "trackStore:refresh": InvokeEntry<[], { seeded: number; }>;
  "trackStore:root": InvokeEntry<[], string>;
  "trackViews:list": InvokeEntry<[], import("./track-view").TrackViewList>;
  "trackViews:locations": InvokeEntry<[], { defaultDirectory: string; homeDirectory: string; }>;
  "trackViews:read": InvokeEntry<[id: string], import("./track-view").SavedTrackView>;
  "trackViews:save": InvokeEntry<[request: import("./track-view").SaveTrackViewRequest], import("./track-view").SavedTrackView>;
  "update:simulate": InvokeEntry<import("./update-ipc").UpdateSimulationArguments, void>;
}
