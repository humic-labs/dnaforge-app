const BRIDGE_GLOBAL = '__dna708ColdStartReloadBridge';
const FULL_ASSEMBLY_BP = 3_088_269_832;
const FULL_ASSEMBLY_PRESET = 'assembly-grch38-local-hg002-80x';
const TRACK_ID = 'pileup-genomewide-grch38';
const EXACT_RASTER_OWNER = 'compiled-broad-raster-surface';
const PREPACKED_VECTOR_OWNER = 'prepacked-partitioned-vector-surface';
const COVERAGE_GPU_ATLAS_OWNER = 'coverage-gpu-atlas-fill';
const COVERAGE_GPU_ATLAS_SHADER = 'coverage-gpu-atlas-fill-fragment';
const PERMANENT_COVERAGE_ATLAS_MIN_SPAN_BP = 150_000_000;
const MAIN_IPC_HEARTBEAT_WARMUP_COUNT = 3;
const MAIN_IPC_HEARTBEAT_WARMUP_INTERVAL_MS = 50;
const MAIN_IPC_HEARTBEAT_STEADY_INTERVAL_MS = 250;
const MAIN_IPC_HEARTBEAT_TIMEOUT_MS = 250;
const PREBUILT_RASTER_PLACEMENT_FINGERPRINT = /^ap1:[0-9a-f]{24}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SCENE_FINGERPRINT_HEX = /^[0-9a-f]{24}$/;
const ASSEMBLY_ANNOTATION_SOURCE_IDENTITY = /^assembly-annotation-source-sha256[.]v1:[0-9a-f]{64}$/;

type UnknownRecord = Record<string, unknown>;

type ColdGestureOperationSnapshot = {
  contract?: unknown;
  rendererGeneration?: unknown;
  operationEpoch?: unknown;
  contentOperationEpoch?: unknown;
  completedFrameEpoch?: unknown;
  presentedFrameEpoch?: unknown;
  presentedContentOperationEpoch?: unknown;
  counts?: UnknownRecord;
  lastEpochs?: UnknownRecord;
};

type ColdGestureTrackSnapshot = UnknownRecord & {
  requestedTrackId?: unknown;
  trackFound?: unknown;
  diagnosticsSupported?: unknown;
};

type ColdGestureAnnotationSnapshot = UnknownRecord & {
  contract?: unknown;
  genomeIdentity?: unknown;
  genomeLengthBp?: unknown;
};

type ColdGestureRendererSnapshot = {
  contract?: unknown;
  supported?: unknown;
  genomeIdentity?: unknown;
  genomeLengthBp?: unknown;
  viewportStartBp?: unknown;
  viewportEndBp?: unknown;
  operation?: ColdGestureOperationSnapshot | null;
  track?: ColdGestureTrackSnapshot | null;
  annotation?: ColdGestureAnnotationSnapshot | null;
};

type ActiveWebGLColdGestureSnapshot = {
  contract?: unknown;
  verdict?: unknown;
  requestedTrackId?: unknown;
  instanceId?: unknown;
  instanceCreatedAt?: unknown;
  registeredInstanceCount?: unknown;
  frameCount?: unknown;
  registryGenomeIdentity?: unknown;
  registryGenomeLengthBp?: unknown;
  renderer?: ColdGestureRendererSnapshot | null;
};

type TileEnginePublishedFeedReceiptV1 = {
  contract?: unknown;
  trackId?: unknown;
  publisherEpoch?: unknown;
  sourceKey?: unknown;
  publicationSequence?: unknown;
  publishedAt?: unknown;
  currentRange?: unknown;
  feedViewRange?: unknown;
  coverageGpuAtlasAuthorityKey?: unknown;
  coverageGpuAtlasSourceIdentity?: unknown;
  coverageGpuAtlasAssemblyFingerprint?: unknown;
  coverageGpuAtlasStatistic?: unknown;
  coverageGpuAtlasPayloadRevision?: unknown;
  coverageGpuAtlasBaseBinSizeBp?: unknown;
  coverageMemoMaterializeCount?: unknown;
  coverageMemoRevisionChangeCount?: unknown;
  exactCoverageRecordScanCount?: unknown;
  exactCoverageGeneration?: unknown;
};

type BridgeWindow = Window & {
  __webglExposeForTests?: boolean;
  __webglColdGestureSnapshot?: (trackId: string) => ActiveWebGLColdGestureSnapshot;
  __indexedGenomeViewerDebug?: {
    instanceId?: unknown;
    sessionId?: unknown;
    compiledAnnotationResidentReadiness?: UnknownRecord;
  };
  __tileEngineDriver?: { built?: number };
  __tileEngineDebug?: () => Record<string, UnknownRecord>;
  __tileEngineFeed?: UnknownRecord;
  __tileEnginePublishedFeedSnapshot?: (trackId: string) => TileEnginePublishedFeedReceiptV1 | null;
  __dna708PrepackedSceneReadiness?: UnknownRecord;
  __dna708FullAssemblyInteractionReadiness?: UnknownRecord;
  __dna708ColdStartReloadBridge?: Dna708bColdStartReloadBridge;
};

type PresentedGenomeSessionAdmission = {
  sessionId: string;
  presentationReady: boolean;
  annotationReady: boolean;
  searchReady: boolean;
};

function presentedGenomeSessionAdmission(
  target: BridgeWindow
): PresentedGenomeSessionAdmission | null {
  const roots = target.document?.querySelectorAll?.('[data-testid="indexed-genome-tab"]');
  if (!roots || roots.length !== 1) return null;
  const root = roots[0];
  const sessionId = root.getAttribute('data-session-id');
  const debugSessionId = target.__indexedGenomeViewerDebug?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId !== debugSessionId) {
    return null;
  }
  const openReady = root.getAttribute('data-session-open-ready');
  const annotationReadiness = root.getAttribute(
    'data-session-assembly-annotation-products-readiness'
  );
  const searchReadiness = root.getAttribute('data-session-assembly-search-readiness');
  const terminalCapability = (value: string | null) =>
    value === 'ready' || value === 'not-applicable';
  return {
    sessionId,
    presentationReady: openReady === 'true',
    annotationReady: terminalCapability(annotationReadiness),
    searchReady: terminalCapability(searchReadiness),
  };
}

export type ColdStartReloadLifecycle = {
  reloadRequestedAt: number;
  reloadGenerationBefore: number;
  reloadGenerationAfter: number;
  rendererGenerationBefore: number;
  rendererGenerationAfter: number;
  driverGenerationBefore: number;
  driverGenerationAfter: number;
  rendererReadyAt: number;
  driverReadyAt: number;
  sceneReadyAt: number;
  initialFullGenomeFrameAt: number;
  initialFrameSpanBp: number;
  initialAnnotationOwner: string;
  initialAnnotationOwnerCount: number;
  initialAnnotationPackCount: number;
  initialAnnotationBuildCount: number;
  initialWebglInstanceId: string;
  initialWebglInstanceCreatedAt: number;
  initialReadinessRunGeneration: string;
  initialAnnotationOwnerKey: string;
  initialAnnotationOwnerGeneration: number;
  initialAnnotationCacheStatus: 'loaded-hit' | 'loaded-built';
  initialAnnotationCacheOrigin: 'hit' | 'built';
  initialAnnotationCacheState: 'hit' | 'miss' | 'error';
  initialAnnotationCacheLifecycleOrigin: 'durable-hit' | 'prepared-after-miss';
  initialAnnotationSourceIdentity: string;
  initialAnnotationArtifactKey: string;
  initialAnnotationArtifactPayloadBytes: number;
  initialRendererGeneration: number;
  initialRendererOperationEpoch: number;
  initialRendererContentOperationEpoch: number;
  initialRendererCompletedFrameEpoch: number;
  initialRendererPresentedFrameEpoch: number;
  initialRendererPresentedContentOperationEpoch: number;
  initialRendererLoadGenomeCount: number;
  initialRendererAnnotationSnapshotAttemptCount: number;
  initialRendererAnnotationSnapshotApplyCount: number;
  initialRendererPrepackedLoadCount: number;
  initialRendererPrepackedPrepareCount: number;
  initialRendererPrepackedActivateCount: number;
  initialRendererPrepackedPolicyUpdateCount: number;
  initialRendererPrepackedRetireCount: number;
  initialRendererContentChangedFrameCount: number;
  initialRendererCameraOnlyFrameCount: number;
  initialAnnotationRequestedLayerM_RNAOnly: true;
  initialAnnotationMetadataTrackType: 'mRNA';
  initialAnnotationRuntimeIsoformMode: 'canonical';
  initialAnnotationRuntimeLaneLimit: number;
  initialAnnotationPolicyGeneration: number;
  initialAnnotationSceneFingerprint: string;
  initialAnnotationSourceFingerprint: string;
  initialAnnotationPlacementFingerprint: string;
  initialAnnotationRasterArtifactKey: string;
  initialMainIpcHeartbeatSessionId: string;
  initialMainIpcHeartbeatCount: number;
  initialMainIpcHeartbeatMaxMs: number;
  initialMainIpcHeartbeatLastMs: number;
  initialMainIpcHeartbeatTimeoutCount: 0;
  initialAnnotationCapabilityReady: boolean;
  initialSearchReady: boolean;
  initialCoverageProof: 'gpu-atlas-resource-submitted';
  initialCoverageOwner: 'coverage-gpu-atlas-fill';
  initialCoverageAuthorityKey: string;
  initialCoverageShaderProgramName: 'coverage-gpu-atlas-fill-fragment';
  initialCoverageShaderProgramKey: number;
  initialCoverageShaderProgramCompiled: true;
  initialCoverageShaderProgramLinked: true;
  initialCoverageShaderTextureResourceBound: true;
  initialCoverageTextureResourceUid: number;
  initialCoverageShaderTextureResourceUid: number;
  initialCoverageTextureResourceCreateCount: 1;
  initialCoverageGpuTextureResourceCreateCount: 1;
  initialCoverageGpuTextureUploadCount: 1;
  initialCoverageGpuTextureUploadComplete: true;
  initialCoverageGeometryBuildCount: 1;
  initialCoverageCameraUniformUpdateCount: number;
  initialCoverageBaseBinSizeBp: number;
  initialCoveragePublisherEpoch: string;
  initialCoveragePublisherSourceKey: string;
  initialCoveragePublicationSequence: number;
  initialCoveragePublishedAt: number;
  initialCoverageMemoMaterializeCount: number;
  initialCoverageMemoRevisionChangeCount: number;
  initialExactCoverageRecordScanCount: number;
  initialExactCoverageGeneration: number;
  initialLegacyCoverageSamplePassCount: number;
  initialLegacyCoverageGeometryBuildCount: number;
  initialLegacyCoverageBufferUploadCount: number;
};

export type Dna708bColdStartReloadBridge = {
  readonly schemaVersion: 1;
  readonly recordsReloadGeneration: true;
  readonly recordsRendererGeneration: true;
  readonly recordsDriverGeneration: true;
  readonly recordsReadinessTimestamps: true;
  readonly recordsMainIpcResponsiveness: true;
  readonly recordsCoverageAtlasResourceSubmission: true;
  readonly recordsQualifiedCoverageBaselines: true;
  readonly recordsO1Qualification: true;
  beginColdReload(options: {
    scheduleSha256?: string;
    genomeLength: number;
    targetSpanBp?: number;
    variant?: string;
    requireInitialFullGenomeFrame?: boolean;
    coherenceWarmupMs?: number;
    requireDurableCacheHit?: boolean;
  }): Promise<ColdStartReloadLifecycle>;
};

export type ColdStartReloadBridgeRuntime = {
  target: BridgeWindow;
  closeAllTabs: () => void;
  resetColdCaches?: () => void | Promise<void>;
  applyPreset: (presetId: string) => Promise<void>;
  mainIpcHeartbeat: (sessionId: string) => Promise<unknown>;
  getAppliedPresetId?: () => string | null;
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
  setFailureTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearFailureTimeout?: (id: ReturnType<typeof setTimeout>) => void;
  setMainIpcHeartbeatTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearMainIpcHeartbeatTimeout?: (id: ReturnType<typeof setTimeout>) => void;
  timeoutMs?: number;
};

type QualifiedFrame = {
  instanceId: string;
  instanceCreatedAt: number;
  runGeneration: string;
  ownerKey: string;
  ownerGeneration: number;
  qualificationKey: string;
  frameCount: number;
  spanBp: number;
  owner: string;
  ownerCount: number;
  packCount: number;
  buildCount: number;
  coverage: QualifiedCoverageAtlas;
  publishedFeed: QualifiedPublishedFeed;
  cacheStatus: 'loaded-hit' | 'loaded-built';
  cacheOrigin: 'hit' | 'built';
  cacheState: 'hit' | 'miss' | 'error';
  cacheLifecycleOrigin: 'durable-hit' | 'prepared-after-miss';
  sourceIdentity: string;
  artifactKey: string;
  payloadBytes: number;
  operation: QualifiedRendererOperation;
  annotationPolicy: QualifiedAnnotationPolicy;
};

type QualifiedRendererOperation = {
  rendererGeneration: number;
  operationEpoch: number;
  contentOperationEpoch: number;
  completedFrameEpoch: number;
  presentedFrameEpoch: number;
  presentedContentOperationEpoch: number;
  loadGenomeCount: number;
  annotationSnapshotAttemptCount: number;
  annotationSnapshotApplyCount: number;
  prepackedLoadCount: number;
  prepackedPrepareCount: number;
  prepackedActivateCount: number;
  prepackedPolicyUpdateCount: number;
  prepackedRetireCount: number;
  contentChangedFrameCount: number;
  cameraOnlyFrameCount: number;
};

type QualifiedAnnotationPolicy = {
  requestedLayerM_RNAOnly: true;
  metadataTrackType: 'mRNA';
  runtimeIsoformMode: 'canonical';
  runtimeLaneLimit: number;
  policyGeneration: number;
  sceneFingerprint: string;
  sourceFingerprint: string;
  placementFingerprint: string;
  rasterArtifactKey: string;
};

type QualifiedAnnotationReadiness = Pick<
  QualifiedFrame,
  | 'runGeneration'
  | 'ownerKey'
  | 'ownerGeneration'
  | 'cacheStatus'
  | 'cacheOrigin'
  | 'cacheState'
  | 'cacheLifecycleOrigin'
  | 'sourceIdentity'
  | 'artifactKey'
  | 'payloadBytes'
> & { authorityKey: string };

type QualifiedPublishedFeed = {
  publisherEpoch: string;
  sourceKey: string;
  publicationSequence: number;
  publishedAt: number;
  coverageMemoMaterializeCount: number;
  coverageMemoRevisionChangeCount: number;
  exactCoverageRecordScanCount: number;
  exactCoverageGeneration: number;
};

type QualifiedCoverageAtlas = {
  proof: 'gpu-atlas-resource-submitted';
  owner: 'coverage-gpu-atlas-fill';
  authorityKey: string;
  shaderProgramName: 'coverage-gpu-atlas-fill-fragment';
  shaderProgramKey: number;
  shaderProgramLinked: true;
  textureResourceUid: number;
  shaderTextureResourceUid: number;
  textureResourceCreateCount: 1;
  gpuTextureResourceCreateCount: 1;
  gpuTextureUploadCount: 1;
  gpuTextureUploadComplete: true;
  geometryBuildCount: 1;
  cameraUniformUpdateCount: number;
  baseBinSizeBp: number;
  legacySamplePassCount: number;
  legacyGeometryBuildCount: number;
  legacyBufferUploadCount: number;
};

function safeInteger(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(value) ? (value as number) : fallback;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseCoverageAtlasAuthorityKey(value: unknown): readonly string[] | null {
  if (typeof value !== 'string') return null;
  try {
    const tuple = JSON.parse(value);
    return Array.isArray(tuple) &&
      tuple.length === 5 &&
      tuple[0] === 'coverage-gpu-atlas.v1' &&
      tuple.every((part) => typeof part === 'string' && part.length > 0)
      ? tuple
      : null;
  } catch {
    return null;
  }
}

function parseDurableSceneOwnerKey(value: unknown): {
  ownerKey: string;
  fingerprint: string;
  artifactKey: string;
} | null {
  if (typeof value !== 'string') return null;
  const lines = value.split('\n');
  if (lines.length !== 4) return null;
  const [schema, fingerprint, payloadSha256, artifactKey] = lines;
  if (
    schema === 'annotation-scene-owner.v3' &&
    SCENE_FINGERPRINT_HEX.test(fingerprint) &&
    SHA256_HEX.test(payloadSha256) &&
    artifactKey.length > 0 &&
    !/[\r\n]/.test(artifactKey)
  ) {
    return { ownerKey: value, fingerprint, artifactKey };
  }
  return null;
}

function qualifiedFullGenomeAnnotationOwner(
  annotation: ColdGestureAnnotationSnapshot | null
): string | null {
  if (
    !annotation ||
    annotation.contract !== 'annotation-overlay-cold-gesture-snapshot.v1' ||
    annotation.presentationVisible !== true ||
    annotation.requestedLayerM_RNAOnly !== true ||
    annotation.soleOwnerCount !== 1 ||
    annotation.soleOwnerRole !== 'exact' ||
    annotation.soleOwnerCoverageComplete !== true ||
    annotation.soleOwnerContractValid !== true ||
    annotation.runtimeGenomeWideTextureVisible !== false
  ) {
    return null;
  }

  if (annotation.soleOwnerId === EXACT_RASTER_OWNER) {
    return annotation.prebuiltRasterLoaded === true &&
      annotation.prebuiltRasterVisible === true &&
      annotation.prebuiltRasterEligible === true &&
      annotation.prebuiltRasterContractMatch === true &&
      annotation.prebuiltRasterSourceMatch === true &&
      annotation.prebuiltRasterPlacementMatch === true &&
      annotation.prebuiltRasterArtifactM_RNAOnly === true &&
      typeof annotation.prebuiltRasterSourceFingerprint === 'string' &&
      SCENE_FINGERPRINT_HEX.test(annotation.prebuiltRasterSourceFingerprint) &&
      typeof annotation.prebuiltRasterPlacementFingerprint === 'string' &&
      PREBUILT_RASTER_PLACEMENT_FINGERPRINT.test(annotation.prebuiltRasterPlacementFingerprint) &&
      positiveSafeInteger(annotation.prebuiltRasterCompositeCount)
      ? EXACT_RASTER_OWNER
      : null;
  }
  if (
    annotation.soleOwnerId !== PREPACKED_VECTOR_OWNER ||
    annotation.prebuiltRasterVisible === true
  ) {
    return null;
  }
  if (
    annotation.prepackedLoaded !== true ||
    annotation.prepackedGpuPrepared !== true ||
    annotation.prepackedStatus !== 'eligible' ||
    annotation.prepackedMetadataTrackType !== 'mRNA' ||
    !positiveSafeInteger(annotation.prepackedSubmittedPartitionCount) ||
    !positiveSafeInteger(annotation.prepackedSubmittedInstanceCount) ||
    annotation.prepackedSceneVisiblePartitionCount !==
      annotation.prepackedSubmittedPartitionCount ||
    annotation.prepackedSceneVisibleInstanceCount !== annotation.prepackedSubmittedInstanceCount
  ) {
    return null;
  }
  return PREPACKED_VECTOR_OWNER;
}

function qualifiedCoverageAtlasResourceSubmission(
  diagnostic: UnknownRecord | null
): QualifiedCoverageAtlas | null {
  const alpha = Number(diagnostic?.renderedReadDensityAlpha);
  const authorityKey = diagnostic?.coverageGpuAtlasAuthorityKey;
  const authorityTuple = parseCoverageAtlasAuthorityKey(authorityKey);
  const programKey = diagnostic?.coverageGpuAtlasShaderProgramKey;
  const textureUid = diagnostic?.coverageGpuAtlasTextureResourceUid;
  const shaderTextureUid = diagnostic?.coverageGpuAtlasShaderTextureResourceUid;
  if (
    !diagnostic ||
    !Number.isFinite(alpha) ||
    alpha <= 0 ||
    diagnostic.coverageGpuAtlasActive !== true ||
    authorityTuple === null ||
    diagnostic.coverageGpuAtlasRenderOwner !== COVERAGE_GPU_ATLAS_OWNER ||
    diagnostic.coverageGpuAtlasShaderProgramName !== COVERAGE_GPU_ATLAS_SHADER ||
    diagnostic.coverageGpuAtlasShaderProgramCompiled !== true ||
    !nonnegativeSafeInteger(programKey) ||
    diagnostic.coverageGpuAtlasShaderTextureResourceBound !== true ||
    !nonnegativeSafeInteger(textureUid) ||
    !nonnegativeSafeInteger(shaderTextureUid) ||
    textureUid !== shaderTextureUid ||
    diagnostic.coverageGpuAtlasTextureResourceCreateCount !== 1 ||
    diagnostic.coverageGpuAtlasGpuTextureResourceCreateCount !== 1 ||
    diagnostic.coverageGpuAtlasGpuTextureUploadCount !== 1 ||
    diagnostic.coverageGpuAtlasGpuTextureUploadComplete !== true ||
    diagnostic.coverageGpuAtlasGeometryBuildCount !== 1 ||
    !positiveSafeInteger(diagnostic.coverageGpuAtlasCameraUniformUpdateCount) ||
    !positiveSafeInteger(diagnostic.coverageGpuAtlasBaseBinSizeBp) ||
    !nonnegativeSafeInteger(diagnostic.coverageSamplePassCount) ||
    !nonnegativeSafeInteger(diagnostic.coverageGeometryBuildCount) ||
    !nonnegativeSafeInteger(diagnostic.coverageBufferUploadCount) ||
    diagnostic.densityRowsMeshVisible === true ||
    Number(diagnostic.coverageSignalNonzeroBinCount ?? 0) !== 0 ||
    diagnostic.coverageLodLevel != null ||
    diagnostic.coverageLodTargetLevel != null
  ) {
    return null;
  }
  return {
    proof: 'gpu-atlas-resource-submitted',
    owner: COVERAGE_GPU_ATLAS_OWNER,
    authorityKey: authorityKey as string,
    shaderProgramName: COVERAGE_GPU_ATLAS_SHADER,
    shaderProgramKey: programKey,
    shaderProgramLinked: true,
    textureResourceUid: textureUid,
    shaderTextureResourceUid: shaderTextureUid,
    textureResourceCreateCount: 1,
    gpuTextureResourceCreateCount: 1,
    gpuTextureUploadCount: 1,
    gpuTextureUploadComplete: true,
    geometryBuildCount: 1,
    cameraUniformUpdateCount: diagnostic.coverageGpuAtlasCameraUniformUpdateCount as number,
    baseBinSizeBp: diagnostic.coverageGpuAtlasBaseBinSizeBp as number,
    legacySamplePassCount: diagnostic.coverageSamplePassCount as number,
    legacyGeometryBuildCount: diagnostic.coverageGeometryBuildCount as number,
    legacyBufferUploadCount: diagnostic.coverageBufferUploadCount as number,
  };
}

function coverageAtlasRejectionReason(diagnostic: UnknownRecord | null): string {
  if (!diagnostic) return 'coverage-diagnostic-missing';
  if (diagnostic.coverageGpuAtlasActive !== true) {
    return [
      'coverage-atlas-inactive',
      `trackType=${String(diagnostic.trackType ?? 'missing')}`,
      `legacyMesh=${String(diagnostic.densityRowsMeshVisible ?? 'missing')}`,
      `legacyLod=${String(diagnostic.coverageLodLevel ?? 'missing')}`,
    ].join(':');
  }
  if (diagnostic.coverageGpuAtlasShaderProgramCompiled !== true) {
    return 'coverage-atlas-shader-not-compiled';
  }
  if (diagnostic.coverageGpuAtlasShaderTextureResourceBound !== true) {
    return 'coverage-atlas-texture-not-bound';
  }
  if (
    diagnostic.coverageGpuAtlasTextureResourceUid !==
    diagnostic.coverageGpuAtlasShaderTextureResourceUid
  ) {
    return 'coverage-atlas-texture-identity-mismatch';
  }
  if (diagnostic.densityRowsMeshVisible === true) {
    return 'coverage-atlas-legacy-mesh-simultaneously-visible';
  }
  return 'coverage-atlas-resource-contract-invalid';
}

function timeoutRejectionContext(target: BridgeWindow, rejection: string): string {
  if (!rejection.startsWith('coverage-')) return rejection;
  try {
    const engine = target.__tileEngineDebug?.()?.[TRACK_ID];
    const corridor = engine?.coverageCorridorFloor as UnknownRecord | undefined;
    if (!corridor) return rejection;
    const failure = String(corridor.failureReason ?? 'none').replace(/\s+/g, '_');
    return (
      `${rejection}:corridorFloorState=${String(corridor.state ?? 'missing')}` +
      `:corridorFloorFailure=${failure}`
    );
  } catch (error) {
    return `${rejection}:timeout-diagnostic-threw=${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function qualifiedPublishedFeed(
  target: BridgeWindow,
  coverage: QualifiedCoverageAtlas,
  expectedGenomeLength: number,
  reloadRequestedAt: number
): QualifiedPublishedFeed | null {
  const receipt = target.__tileEnginePublishedFeedSnapshot?.(TRACK_ID) ?? null;
  const authorityTuple = parseCoverageAtlasAuthorityKey(coverage.authorityKey);
  const currentRange = receipt?.currentRange as UnknownRecord | null;
  const feedViewRange = receipt?.feedViewRange as UnknownRecord | null;
  const fullToleranceBp = Math.ceil(expectedGenomeLength * 0.005);
  const rangeIsFullAssembly = (range: UnknownRecord | null) => {
    const start = Number(range?.start);
    const end = Number(range?.end);
    return (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      Math.abs(start) <= fullToleranceBp &&
      Math.abs(end - expectedGenomeLength) <= fullToleranceBp
    );
  };
  if (
    !receipt ||
    receipt.contract !== 'tile-engine-published-feed-receipt.v1' ||
    receipt.trackId !== TRACK_ID ||
    typeof receipt.publisherEpoch !== 'string' ||
    receipt.publisherEpoch.length === 0 ||
    /[\r\n]/.test(receipt.publisherEpoch) ||
    typeof receipt.sourceKey !== 'string' ||
    receipt.sourceKey.length === 0 ||
    /[\r\n]/.test(receipt.sourceKey) ||
    !positiveSafeInteger(receipt.publicationSequence) ||
    !Number.isFinite(Number(receipt.publishedAt)) ||
    Number(receipt.publishedAt) < reloadRequestedAt ||
    !rangeIsFullAssembly(currentRange) ||
    !rangeIsFullAssembly(feedViewRange) ||
    authorityTuple === null ||
    receipt.coverageGpuAtlasAuthorityKey !== coverage.authorityKey ||
    receipt.coverageGpuAtlasSourceIdentity !== authorityTuple[1] ||
    receipt.coverageGpuAtlasAssemblyFingerprint !== authorityTuple[2] ||
    receipt.coverageGpuAtlasStatistic !== authorityTuple[3] ||
    receipt.coverageGpuAtlasPayloadRevision !== authorityTuple[4] ||
    receipt.coverageGpuAtlasBaseBinSizeBp !== coverage.baseBinSizeBp ||
    !nonnegativeSafeInteger(receipt.coverageMemoMaterializeCount) ||
    !nonnegativeSafeInteger(receipt.coverageMemoRevisionChangeCount) ||
    !nonnegativeSafeInteger(receipt.exactCoverageRecordScanCount) ||
    !nonnegativeSafeInteger(receipt.exactCoverageGeneration)
  ) {
    return null;
  }
  return {
    publisherEpoch: receipt.publisherEpoch,
    sourceKey: receipt.sourceKey,
    publicationSequence: receipt.publicationSequence,
    publishedAt: receipt.publishedAt as number,
    coverageMemoMaterializeCount: receipt.coverageMemoMaterializeCount,
    coverageMemoRevisionChangeCount: receipt.coverageMemoRevisionChangeCount,
    exactCoverageRecordScanCount: receipt.exactCoverageRecordScanCount,
    exactCoverageGeneration: receipt.exactCoverageGeneration,
  };
}

const OPERATION_COUNTER_KEYS = [
  'loadGenome',
  'annotationSnapshotAttempt',
  'annotationSnapshotApply',
  'prepackedLoad',
  'prepackedPrepare',
  'prepackedActivate',
  'prepackedPolicyUpdate',
  'prepackedRetire',
  'contentChangedFrame',
  'cameraOnlyFrame',
] as const;

function qualifiedRendererOperation(
  operation: ColdGestureOperationSnapshot | null | undefined
): QualifiedRendererOperation | null {
  if (
    !operation ||
    operation.contract !== 'pixi-linear-renderer-operation-snapshot.v1' ||
    !positiveSafeInteger(operation.rendererGeneration) ||
    !positiveSafeInteger(operation.operationEpoch) ||
    !nonnegativeSafeInteger(operation.contentOperationEpoch) ||
    !positiveSafeInteger(operation.completedFrameEpoch) ||
    !positiveSafeInteger(operation.presentedFrameEpoch) ||
    !nonnegativeSafeInteger(operation.presentedContentOperationEpoch) ||
    operation.presentedFrameEpoch !== operation.completedFrameEpoch ||
    operation.presentedContentOperationEpoch !== operation.contentOperationEpoch ||
    !operation.counts ||
    !operation.lastEpochs ||
    OPERATION_COUNTER_KEYS.some(
      (key) =>
        !nonnegativeSafeInteger(operation.counts?.[key]) ||
        !nonnegativeSafeInteger(operation.lastEpochs?.[key])
    ) ||
    operation.counts.loadGenome !== 1 ||
    operation.counts.contentChangedFrame === 0
  ) {
    return null;
  }
  return {
    rendererGeneration: operation.rendererGeneration,
    operationEpoch: operation.operationEpoch,
    contentOperationEpoch: operation.contentOperationEpoch,
    completedFrameEpoch: operation.completedFrameEpoch,
    presentedFrameEpoch: operation.presentedFrameEpoch,
    presentedContentOperationEpoch: operation.presentedContentOperationEpoch,
    loadGenomeCount: operation.counts.loadGenome as number,
    annotationSnapshotAttemptCount: operation.counts.annotationSnapshotAttempt as number,
    annotationSnapshotApplyCount: operation.counts.annotationSnapshotApply as number,
    prepackedLoadCount: operation.counts.prepackedLoad as number,
    prepackedPrepareCount: operation.counts.prepackedPrepare as number,
    prepackedActivateCount: operation.counts.prepackedActivate as number,
    prepackedPolicyUpdateCount: operation.counts.prepackedPolicyUpdate as number,
    prepackedRetireCount: operation.counts.prepackedRetire as number,
    contentChangedFrameCount: operation.counts.contentChangedFrame as number,
    cameraOnlyFrameCount: operation.counts.cameraOnlyFrame as number,
  };
}

function qualifiedAnnotationPolicy(
  annotation: ColdGestureAnnotationSnapshot,
  presentationOwner: string,
  readiness: QualifiedAnnotationReadiness
): QualifiedAnnotationPolicy | null {
  const parsedOwner = parseDurableSceneOwnerKey(annotation.activeOwnerKey);
  const sourceFingerprint = annotation.activeSourceFingerprint;
  const placementFingerprint = annotation.activePlacementFingerprint;
  const artifactKey = annotation.activeArtifactKey;
  if (
    parsedOwner === null ||
    parsedOwner.ownerKey !== readiness.ownerKey ||
    annotation.activeOwnerGeneration !== readiness.ownerGeneration ||
    parsedOwner.artifactKey !== artifactKey ||
    artifactKey !== readiness.artifactKey ||
    annotation.activeSourceIdentity !== readiness.sourceIdentity ||
    annotation.activeTrackType !== 'mRNA' ||
    annotation.activeRuntimeIsoformMode !== 'canonical' ||
    !positiveSafeInteger(annotation.activeRuntimeLaneLimit) ||
    !positiveSafeInteger(annotation.activePolicyGeneration) ||
    typeof sourceFingerprint !== 'string' ||
    !SCENE_FINGERPRINT_HEX.test(sourceFingerprint) ||
    typeof placementFingerprint !== 'string' ||
    !PREBUILT_RASTER_PLACEMENT_FINGERPRINT.test(placementFingerprint) ||
    parsedOwner.fingerprint !== sourceFingerprint ||
    typeof artifactKey !== 'string' ||
    artifactKey.length === 0 ||
    (presentationOwner === EXACT_RASTER_OWNER &&
      (annotation.prebuiltRasterSourceFingerprint !== sourceFingerprint ||
        annotation.prebuiltRasterPlacementFingerprint !== placementFingerprint))
  ) {
    return null;
  }
  return {
    requestedLayerM_RNAOnly: true,
    metadataTrackType: 'mRNA',
    runtimeIsoformMode: 'canonical',
    runtimeLaneLimit: annotation.activeRuntimeLaneLimit,
    policyGeneration: annotation.activePolicyGeneration,
    sceneFingerprint: parsedOwner.fingerprint,
    sourceFingerprint,
    placementFingerprint,
    rasterArtifactKey: artifactKey,
  };
}

function qualifiedCompiledResidentReadiness(
  target: BridgeWindow,
  annotation: ColdGestureAnnotationSnapshot,
  registryGenomeIdentity: string,
  reloadRequestedAt: number,
  requireDurableCacheHit: boolean
): QualifiedAnnotationReadiness | null {
  const debug = target.__indexedGenomeViewerDebug;
  const receipt = debug?.compiledAnnotationResidentReadiness;
  const selectedTrackTypes = receipt?.selectedTrackTypes;
  const tracks = receipt?.tracks;
  const track = Array.isArray(tracks) && tracks.length === 1 ? (tracks[0] as UnknownRecord) : null;
  const runGeneration = debug?.instanceId;
  const rosterGeneration = annotation.compiledBroadInteractionResidentGeneration;
  const ownerKey = annotation.compiledBroadRasterProvenancePrepackedOwnerKey;
  const artifactKey = annotation.compiledBroadRasterProvenancePrepackedArtifactKey;
  const cacheOrigin = track?.compactInteractionOrigin;
  const cacheCompletedAt = Number(track?.compactInteractionCompletedAt);
  const payloadBytes = track?.compactInteractionPayloadBytes;
  const sourceIdentity = annotation.genomeIdentity;
  const readinessScopeKey = receipt?.readinessScopeKey;
  if (
    receipt?.contract !== 'compiled-annotation-resident-readiness.v1' ||
    receipt.selectedBroadSetInteractive !== true ||
    !Array.isArray(selectedTrackTypes) ||
    selectedTrackTypes.length !== 1 ||
    selectedTrackTypes[0] !== 'mRNA' ||
    !track ||
    track.trackType !== 'mRNA' ||
    typeof readinessScopeKey !== 'string' ||
    readinessScopeKey.length === 0 ||
    track.ownerReadinessScopeKey !== readinessScopeKey ||
    track.readiness !== 'ready' ||
    track.readinessRendererMatchesCurrent !== true ||
    typeof track.targetIdentityKey !== 'string' ||
    track.targetIdentityKey.length === 0 ||
    track.readinessTargetIdentityKey !== track.targetIdentityKey ||
    track.interactionOwnerKey !== ownerKey ||
    track.interactionCacheStatus !== 'not-applicable' ||
    track.interactionPayloadBytes !== null ||
    track.compactInteractionStatus !== 'loaded' ||
    track.compactInteractionOwnerKey !== ownerKey ||
    track.compactInteractionAuthorityPresent !== true ||
    track.compactInteractionGenomeLengthBp !== annotation.genomeLengthBp ||
    (cacheOrigin !== 'durable-hit' && cacheOrigin !== 'prepared-after-miss') ||
    (requireDurableCacheHit && cacheOrigin !== 'durable-hit') ||
    !Number.isFinite(cacheCompletedAt) ||
    cacheCompletedAt < reloadRequestedAt ||
    typeof runGeneration !== 'string' ||
    runGeneration.length === 0 ||
    typeof ownerKey !== 'string' ||
    ownerKey.length === 0 ||
    annotation.compiledBroadRasterProvenancePrepackedOwnerKey !== ownerKey ||
    typeof artifactKey !== 'string' ||
    artifactKey.length === 0 ||
    annotation.compiledBroadRasterProvenancePrepackedArtifactKey !== artifactKey ||
    typeof sourceIdentity !== 'string' ||
    !ASSEMBLY_ANNOTATION_SOURCE_IDENTITY.test(sourceIdentity) ||
    sourceIdentity !== registryGenomeIdentity ||
    annotation.genomeIdentity !== sourceIdentity ||
    !positiveSafeInteger(payloadBytes) ||
    !positiveSafeInteger(rosterGeneration) ||
    annotation.requestedLayerM_RNAOnly !== true ||
    annotation.compiledBroadRasterLoaded !== true ||
    annotation.compiledBroadRasterVisible !== true ||
    annotation.compiledBroadRasterProvenanceValid !== true ||
    annotation.compiledBroadRasterHoldingLastGood !== false ||
    annotation.compiledBroadInteractionRequestedOwnerPresent !== true
  ) {
    return null;
  }

  return {
    runGeneration,
    ownerKey,
    ownerGeneration: rosterGeneration as number,
    authorityKey: JSON.stringify([
      'compiled-compact-roster.v1',
      readinessScopeKey,
      rosterGeneration,
      ownerKey,
      artifactKey,
      cacheCompletedAt,
    ]),
    cacheStatus: cacheOrigin === 'durable-hit' ? 'loaded-hit' : 'loaded-built',
    cacheOrigin: cacheOrigin === 'durable-hit' ? 'hit' : 'built',
    cacheState: cacheOrigin === 'durable-hit' ? 'hit' : 'miss',
    cacheLifecycleOrigin: cacheOrigin,
    sourceIdentity,
    artifactKey,
    payloadBytes: payloadBytes as number,
  };
}

function qualifiedLegacyActiveOwnerReadiness(
  target: BridgeWindow,
  annotation: ColdGestureAnnotationSnapshot,
  instanceId: string,
  instanceCreatedAt: number,
  registryGenomeIdentity: string,
  expectedGenomeLength: number,
  reloadRequestedAt: number,
  requireDurableCacheHit: boolean
): QualifiedAnnotationReadiness | null {
  const parsedOwnerKey = parseDurableSceneOwnerKey(annotation.prepackedOwnerKey);
  if (
    parsedOwnerKey === null ||
    !positiveSafeInteger(annotation.prepackedOwnerGeneration) ||
    annotation.prepackedLoaded !== true ||
    annotation.prepackedGpuPrepared !== true ||
    annotation.prepackedStatus !== 'eligible' ||
    annotation.prepackedMetadataGenomeLengthBp !== expectedGenomeLength ||
    typeof annotation.prepackedMetadataGenomeIdentity !== 'string' ||
    !ASSEMBLY_ANNOTATION_SOURCE_IDENTITY.test(annotation.prepackedMetadataGenomeIdentity) ||
    annotation.prepackedMetadataGenomeIdentity !== registryGenomeIdentity ||
    annotation.prepackedMetadataArtifactKey !== parsedOwnerKey.artifactKey
  ) {
    return null;
  }

  const readiness = target.__dna708PrepackedSceneReadiness;
  const interactionReadiness = target.__dna708FullAssemblyInteractionReadiness;
  const readinessStatus = readiness?.status;
  const readinessLoadedAt = Number(readiness?.loadedAt);
  const readinessOrigin = readiness?.origin;
  const readinessCacheState = readiness?.cacheState;
  const readinessCacheLifecycleOrigin = readiness?.cacheOrigin;
  const readinessSourceIdentity = readiness?.sourceIdentity;
  const readinessArtifactKey = readiness?.artifactKey;
  const readinessPayloadBytes = readiness?.payloadBytes;
  const builtWriteCompletedAt = Number(readiness?.writeCompletedAt);
  const runGeneration = target.__indexedGenomeViewerDebug?.instanceId;
  if (
    (readinessStatus !== 'loaded-hit' && readinessStatus !== 'loaded-built') ||
    (requireDurableCacheHit && readinessStatus !== 'loaded-hit') ||
    !Number.isFinite(readinessLoadedAt) ||
    readinessLoadedAt < reloadRequestedAt ||
    typeof readinessSourceIdentity !== 'string' ||
    !ASSEMBLY_ANNOTATION_SOURCE_IDENTITY.test(readinessSourceIdentity) ||
    readinessSourceIdentity !== annotation.prepackedMetadataGenomeIdentity ||
    typeof readinessArtifactKey !== 'string' ||
    readinessArtifactKey !== parsedOwnerKey.artifactKey ||
    readinessArtifactKey !== annotation.prepackedMetadataArtifactKey ||
    !positiveSafeInteger(readinessPayloadBytes) ||
    (readinessStatus === 'loaded-hit' &&
      (readinessOrigin !== 'hit' ||
        readinessCacheState !== 'hit' ||
        readinessCacheLifecycleOrigin !== 'durable-hit')) ||
    (readinessStatus === 'loaded-built' &&
      (readinessOrigin !== 'built' ||
        (readinessCacheState !== 'miss' && readinessCacheState !== 'error') ||
        readinessCacheLifecycleOrigin !== 'prepared-after-miss' ||
        !Number.isFinite(builtWriteCompletedAt) ||
        builtWriteCompletedAt < reloadRequestedAt ||
        builtWriteCompletedAt > readinessLoadedAt)) ||
    typeof runGeneration !== 'string' ||
    runGeneration.length === 0 ||
    readiness?.runGeneration !== runGeneration ||
    readiness?.webglInstanceId !== instanceId ||
    readiness?.webglInstanceCreatedAt !== instanceCreatedAt ||
    readiness?.ownerKey !== parsedOwnerKey.ownerKey ||
    readiness?.ownerGeneration !== annotation.prepackedOwnerGeneration ||
    readiness?.ownerLoaded !== true ||
    readiness?.ownerGpuPrepared !== true
  ) {
    return null;
  }
  if (
    interactionReadiness?.ready !== true ||
    interactionReadiness?.runGeneration !== runGeneration ||
    interactionReadiness?.webglInstanceId !== instanceId ||
    interactionReadiness?.webglInstanceCreatedAt !== instanceCreatedAt ||
    interactionReadiness?.ownerKey !== parsedOwnerKey.ownerKey ||
    interactionReadiness?.ownerGeneration !== annotation.prepackedOwnerGeneration ||
    !Number.isFinite(Number(interactionReadiness?.readyAt)) ||
    Number(interactionReadiness?.readyAt) < reloadRequestedAt ||
    typeof interactionReadiness?.sceneKey !== 'string' ||
    interactionReadiness.sceneKey.length === 0 ||
    interactionReadiness.sceneKey !== readiness?.sceneKey
  ) {
    return null;
  }

  return {
    runGeneration,
    ownerKey: parsedOwnerKey.ownerKey,
    ownerGeneration: annotation.prepackedOwnerGeneration as number,
    authorityKey: JSON.stringify([
      'active-prepacked-owner.v1',
      parsedOwnerKey.ownerKey,
      annotation.prepackedOwnerGeneration,
      readiness?.sceneKey,
    ]),
    cacheStatus: readinessStatus,
    cacheOrigin: readinessOrigin as 'hit' | 'built',
    cacheState: readinessCacheState as 'hit' | 'miss' | 'error',
    cacheLifecycleOrigin: readinessCacheLifecycleOrigin as 'durable-hit' | 'prepared-after-miss',
    sourceIdentity: readinessSourceIdentity,
    artifactKey: readinessArtifactKey,
    payloadBytes: readinessPayloadBytes as number,
  };
}

function qualifyFirstFrame(
  target: BridgeWindow,
  activeSnapshot: ActiveWebGLColdGestureSnapshot | null,
  oldInstanceIds: ReadonlySet<string>,
  expectedGenomeLength: number,
  reloadRequestedAt: number,
  requireDurableCacheHit: boolean,
  onRejected?: (reason: string) => void
): QualifiedFrame | null {
  const reject = (reason: string): null => {
    onRejected?.(reason);
    return null;
  };
  const renderer = activeSnapshot?.renderer;
  const annotation = renderer?.annotation ?? null;
  const diagnostic = renderer?.track ?? null;
  const operation = qualifiedRendererOperation(renderer?.operation);
  const instanceId = activeSnapshot?.instanceId;
  const instanceCreatedAt = activeSnapshot?.instanceCreatedAt;
  const registryGenomeIdentity = activeSnapshot?.registryGenomeIdentity;
  if (
    !activeSnapshot ||
    activeSnapshot.contract !== 'active-webgl-cold-gesture-snapshot.v1' ||
    activeSnapshot.verdict !== 'exactly-one' ||
    activeSnapshot.requestedTrackId !== TRACK_ID ||
    activeSnapshot.registeredInstanceCount !== 1 ||
    typeof instanceId !== 'string' ||
    instanceId.length === 0 ||
    oldInstanceIds.has(instanceId) ||
    !Number.isFinite(Number(instanceCreatedAt)) ||
    !positiveSafeInteger(activeSnapshot.frameCount) ||
    typeof registryGenomeIdentity !== 'string' ||
    registryGenomeIdentity.length === 0 ||
    activeSnapshot.registryGenomeLengthBp !== expectedGenomeLength ||
    !renderer ||
    renderer.contract !== 'pixi-linear-renderer-cold-gesture-snapshot.v1' ||
    renderer.supported !== true ||
    renderer.genomeIdentity !== registryGenomeIdentity ||
    renderer.genomeLengthBp !== expectedGenomeLength ||
    operation === null ||
    !diagnostic ||
    diagnostic.requestedTrackId !== TRACK_ID ||
    diagnostic.trackFound !== true ||
    diagnostic.diagnosticsSupported !== true ||
    diagnostic.trackType !== 'pileup-genomewide' ||
    !annotation ||
    annotation.contract !== 'annotation-overlay-cold-gesture-snapshot.v1' ||
    annotation.genomeIdentity !== registryGenomeIdentity ||
    annotation.genomeLengthBp !== expectedGenomeLength
  ) {
    return reject(
      `active-renderer-contract-invalid:verdict=${String(activeSnapshot?.verdict ?? 'missing')}` +
        `:trackType=${String(diagnostic?.trackType ?? 'missing')}`
    );
  }

  const start = Number(renderer.viewportStartBp);
  const end = Number(renderer.viewportEndBp);
  const spanBp = end - start;
  const fullToleranceBp = Math.ceil(expectedGenomeLength * 0.005);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    diagnostic.rendererViewportStartBp !== start ||
    diagnostic.rendererViewportEndBp !== end ||
    Math.abs(start) > fullToleranceBp ||
    Math.abs(end - expectedGenomeLength) > fullToleranceBp ||
    Math.abs(spanBp - expectedGenomeLength) > fullToleranceBp
  ) {
    return reject('full-assembly-viewport-not-presented');
  }

  if (spanBp < PERMANENT_COVERAGE_ATLAS_MIN_SPAN_BP) {
    return reject(`full-assembly-span-too-small:${spanBp}`);
  }
  const coverage = qualifiedCoverageAtlasResourceSubmission(diagnostic);
  if (coverage === null) return reject(coverageAtlasRejectionReason(diagnostic));
  const publishedFeed = qualifiedPublishedFeed(
    target,
    coverage,
    expectedGenomeLength,
    reloadRequestedAt
  );
  if (publishedFeed === null) return reject('coverage-published-feed-not-current');
  const annotationReadiness =
    qualifiedCompiledResidentReadiness(
      target,
      annotation,
      registryGenomeIdentity,
      reloadRequestedAt,
      requireDurableCacheHit
    ) ??
    qualifiedLegacyActiveOwnerReadiness(
      target,
      annotation,
      instanceId,
      instanceCreatedAt as number,
      registryGenomeIdentity,
      expectedGenomeLength,
      reloadRequestedAt,
      requireDurableCacheHit
    );
  if (annotationReadiness === null) return reject('annotation-resident-readiness-not-qualified');

  const packCount = annotation.retainedLinearDataBuilds;
  const buildCount = annotation.retainedLinearTranscriptBuilds;
  const presentationOwner = qualifiedFullGenomeAnnotationOwner(annotation);
  if (
    presentationOwner === null ||
    !Number.isSafeInteger(packCount) ||
    !Number.isSafeInteger(buildCount) ||
    packCount !== 0 ||
    buildCount !== 0
  ) {
    return reject(
      `annotation-presentation-not-qualified:owner=${String(annotation.soleOwnerId ?? 'missing')}` +
        `:packCount=${String(packCount)}:buildCount=${String(buildCount)}`
    );
  }
  const annotationPolicy = qualifiedAnnotationPolicy(
    annotation,
    presentationOwner,
    annotationReadiness
  );
  if (annotationPolicy === null) {
    return reject('annotation-active-policy-not-qualified');
  }

  return {
    instanceId,
    instanceCreatedAt: instanceCreatedAt as number,
    runGeneration: annotationReadiness.runGeneration,
    ownerKey: annotationReadiness.ownerKey,
    ownerGeneration: annotationReadiness.ownerGeneration,
    qualificationKey: [
      instanceId,
      instanceCreatedAt,
      registryGenomeIdentity,
      operation.rendererGeneration,
      operation.contentOperationEpoch,
      annotationReadiness.authorityKey,
      presentationOwner,
      coverage.authorityKey,
      coverage.shaderProgramKey,
      coverage.textureResourceUid,
      publishedFeed.publisherEpoch,
      publishedFeed.sourceKey,
      publishedFeed.coverageMemoMaterializeCount,
      publishedFeed.coverageMemoRevisionChangeCount,
      publishedFeed.exactCoverageRecordScanCount,
      publishedFeed.exactCoverageGeneration,
    ].join('\n'),
    frameCount: activeSnapshot.frameCount as number,
    spanBp,
    owner: presentationOwner,
    ownerCount: 1,
    packCount: packCount as number,
    buildCount: buildCount as number,
    coverage,
    publishedFeed,
    cacheStatus: annotationReadiness.cacheStatus,
    cacheOrigin: annotationReadiness.cacheOrigin,
    cacheState: annotationReadiness.cacheState,
    cacheLifecycleOrigin: annotationReadiness.cacheLifecycleOrigin,
    sourceIdentity: annotationReadiness.sourceIdentity,
    artifactKey: annotationReadiness.artifactKey,
    payloadBytes: annotationReadiness.payloadBytes,
    operation,
    annotationPolicy,
  };
}

export function createDna708bColdStartReloadBridge(
  runtime: ColdStartReloadBridgeRuntime
): Dna708bColdStartReloadBridge {
  const target = runtime.target;
  const now = runtime.now ?? (() => performance.now());
  const requestFrame =
    runtime.requestFrame ?? ((callback) => target.requestAnimationFrame(callback));
  const cancelFrame = runtime.cancelFrame ?? ((id) => target.cancelAnimationFrame(id));
  const setFailureTimeout =
    runtime.setFailureTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const clearFailureTimeout = runtime.clearFailureTimeout ?? ((id) => clearTimeout(id));
  const setMainIpcHeartbeatTimeout =
    runtime.setMainIpcHeartbeatTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const clearMainIpcHeartbeatTimeout =
    runtime.clearMainIpcHeartbeatTimeout ?? ((id) => clearTimeout(id));
  const timeoutMs = runtime.timeoutMs ?? 120_000;

  let reloadGeneration = 0;
  let rendererGeneration = 0;
  let activeRun = false;

  const bridge: Dna708bColdStartReloadBridge = {
    schemaVersion: 1,
    recordsReloadGeneration: true,
    recordsRendererGeneration: true,
    recordsDriverGeneration: true,
    recordsReadinessTimestamps: true,
    recordsMainIpcResponsiveness: true,
    recordsCoverageAtlasResourceSubmission: true,
    recordsQualifiedCoverageBaselines: true,
    recordsO1Qualification: true,
    async beginColdReload(options) {
      if (activeRun) throw new Error('dna708b-cold-start-reload-already-running');
      if (
        options?.genomeLength !== FULL_ASSEMBLY_BP ||
        options?.requireInitialFullGenomeFrame !== true ||
        options?.coherenceWarmupMs !== 0
      ) {
        throw new Error('dna708b-cold-start-reload-contract-invalid');
      }
      activeRun = true;
      const reloadRequestedAt = now();
      const reloadGenerationBefore = reloadGeneration;
      const reloadGenerationAfter = ++reloadGeneration;
      const rendererGenerationBefore = rendererGeneration;
      const driverGenerationBefore = safeInteger(target.__tileEngineDriver?.built);
      const initialSnapshot = target.__webglColdGestureSnapshot?.(TRACK_ID) ?? null;
      if (
        !initialSnapshot ||
        initialSnapshot.contract !== 'active-webgl-cold-gesture-snapshot.v1' ||
        initialSnapshot.requestedTrackId !== TRACK_ID ||
        !nonnegativeSafeInteger(initialSnapshot.registeredInstanceCount) ||
        initialSnapshot.registeredInstanceCount > 1
      ) {
        throw new Error('dna708b-cold-start-initial-registry-ambiguous');
      }
      const oldInstanceIds = new Set<string>();
      if (typeof initialSnapshot.instanceId === 'string') {
        oldInstanceIds.add(initialSnapshot.instanceId);
      }

      let frameId: number | null = null;
      let failureTimer: ReturnType<typeof setTimeout> | null = null;
      const nextFrame = () =>
        new Promise<void>((resolve) => {
          frameId = requestFrame(() => {
            frameId = null;
            resolve();
          });
        });

      try {
        await Promise.race([
          (async () => {
            target.__webglExposeForTests = true;
            if (runtime.resetColdCaches) await runtime.resetColdCaches();
            runtime.closeAllTabs();
            while (activeRun) {
              const resetSnapshot = target.__webglColdGestureSnapshot?.(TRACK_ID) ?? null;
              if (
                resetSnapshot?.contract === 'active-webgl-cold-gesture-snapshot.v1' &&
                resetSnapshot.requestedTrackId === TRACK_ID &&
                resetSnapshot.verdict === 'none' &&
                resetSnapshot.registeredInstanceCount === 0
              ) {
                break;
              }
              await nextFrame();
            }

            await runtime.applyPreset(FULL_ASSEMBLY_PRESET);
            if (
              runtime.getAppliedPresetId &&
              runtime.getAppliedPresetId() !== FULL_ASSEMBLY_PRESET
            ) {
              throw new Error('dna708b-cold-start-preset-not-applied');
            }
          })(),
          new Promise<never>((_resolve, reject) => {
            failureTimer = setFailureTimeout(
              () => reject(new Error('dna708b-cold-start-reset-timeout')),
              timeoutMs
            );
          }),
        ]);
        if (failureTimer != null) clearFailureTimeout(failureTimer);
        failureTimer = null;

        return await new Promise<ColdStartReloadLifecycle>((resolve, reject) => {
          let rendererReadyAt: number | null = null;
          let driverReadyAt: number | null = null;
          let sceneReadyAt: number | null = null;
          let candidate: QualifiedFrame | null = null;
          let lastQualificationRejection = 'readiness-poll-never-ran';
          let settled = false;
          let mainIpcHeartbeatInFlight = false;
          let mainIpcHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
          let mainIpcHeartbeatToken = 0;
          let mainIpcHeartbeatSessionId: string | null = null;
          let mainIpcHeartbeatSessionPresentationReady = false;
          let mainIpcHeartbeatSessionAnnotationReady = false;
          let mainIpcHeartbeatSessionSearchReady = false;
          let mainIpcHeartbeatCount = 0;
          let mainIpcHeartbeatMaxMs = 0;
          let mainIpcHeartbeatLastMs = 0;
          let mainIpcHeartbeatLastStartedAt = Number.NEGATIVE_INFINITY;

          const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            if (frameId != null) cancelFrame(frameId);
            frameId = null;
            if (failureTimer != null) clearFailureTimeout(failureTimer);
            failureTimer = null;
            mainIpcHeartbeatToken += 1;
            if (mainIpcHeartbeatTimer != null) {
              clearMainIpcHeartbeatTimeout(mainIpcHeartbeatTimer);
            }
            mainIpcHeartbeatTimer = null;
            mainIpcHeartbeatInFlight = false;
            callback();
          };
          const fail = (error: Error) => finish(() => reject(error));
          const beginMainIpcHeartbeatSession = (admission: PresentedGenomeSessionAdmission) => {
            mainIpcHeartbeatToken += 1;
            if (mainIpcHeartbeatTimer != null) {
              clearMainIpcHeartbeatTimeout(mainIpcHeartbeatTimer);
            }
            mainIpcHeartbeatTimer = null;
            mainIpcHeartbeatInFlight = false;
            mainIpcHeartbeatSessionId = admission.sessionId;
            mainIpcHeartbeatSessionPresentationReady = admission.presentationReady;
            mainIpcHeartbeatSessionAnnotationReady = admission.annotationReady;
            mainIpcHeartbeatSessionSearchReady = admission.searchReady;
            mainIpcHeartbeatCount = 0;
            mainIpcHeartbeatMaxMs = 0;
            mainIpcHeartbeatLastMs = 0;
            mainIpcHeartbeatLastStartedAt = Number.NEGATIVE_INFINITY;
          };
          const maybeStartMainIpcHeartbeat = (observedAt: number) => {
            if (settled || mainIpcHeartbeatInFlight || rendererReadyAt == null) return;
            const admission = presentedGenomeSessionAdmission(target);
            if (admission === null) return;
            if (mainIpcHeartbeatSessionId === null) {
              beginMainIpcHeartbeatSession(admission);
            } else if (mainIpcHeartbeatSessionId !== admission.sessionId) {
              beginMainIpcHeartbeatSession(admission);
            } else if (mainIpcHeartbeatSessionPresentationReady && !admission.presentationReady) {
              fail(
                new Error(
                  `dna708b-main-ipc-heartbeat-presentation-readiness-regressed:${admission.sessionId}`
                )
              );
              return;
            } else {
              if (admission.presentationReady) {
                mainIpcHeartbeatSessionPresentationReady = true;
              }
              if (admission.annotationReady) mainIpcHeartbeatSessionAnnotationReady = true;
              if (admission.searchReady) mainIpcHeartbeatSessionSearchReady = true;
            }
            const sessionId = admission.sessionId;
            const intervalMs =
              mainIpcHeartbeatCount < MAIN_IPC_HEARTBEAT_WARMUP_COUNT
                ? MAIN_IPC_HEARTBEAT_WARMUP_INTERVAL_MS
                : MAIN_IPC_HEARTBEAT_STEADY_INTERVAL_MS;
            if (observedAt - mainIpcHeartbeatLastStartedAt < intervalMs) return;

            mainIpcHeartbeatSessionId = sessionId;
            mainIpcHeartbeatInFlight = true;
            mainIpcHeartbeatLastStartedAt = observedAt;
            const heartbeatToken = ++mainIpcHeartbeatToken;
            mainIpcHeartbeatTimer = setMainIpcHeartbeatTimeout(() => {
              if (settled || heartbeatToken !== mainIpcHeartbeatToken) return;
              mainIpcHeartbeatTimer = null;
              fail(
                new Error(
                  `dna708b-main-ipc-heartbeat-timeout:session=${sessionId}:timeoutMs=${MAIN_IPC_HEARTBEAT_TIMEOUT_MS}`
                )
              );
            }, MAIN_IPC_HEARTBEAT_TIMEOUT_MS);
            void runtime.mainIpcHeartbeat(sessionId).then(
              () => {
                if (settled || heartbeatToken !== mainIpcHeartbeatToken) return;
                if (mainIpcHeartbeatTimer != null) {
                  clearMainIpcHeartbeatTimeout(mainIpcHeartbeatTimer);
                }
                mainIpcHeartbeatTimer = null;
                mainIpcHeartbeatInFlight = false;
                const durationMs = Math.max(0, now() - observedAt);
                mainIpcHeartbeatCount += 1;
                mainIpcHeartbeatLastMs = durationMs;
                mainIpcHeartbeatMaxMs = Math.max(mainIpcHeartbeatMaxMs, durationMs);
              },
              (cause) => {
                if (settled || heartbeatToken !== mainIpcHeartbeatToken) return;
                if (mainIpcHeartbeatTimer != null) {
                  clearMainIpcHeartbeatTimeout(mainIpcHeartbeatTimer);
                }
                mainIpcHeartbeatTimer = null;
                mainIpcHeartbeatInFlight = false;
                fail(
                  new Error(
                    `dna708b-main-ipc-heartbeat-rejected:session=${sessionId}:cause=${
                      cause instanceof Error ? cause.message : String(cause)
                    }`
                  )
                );
              }
            );
          };
          failureTimer = setFailureTimeout(
            () =>
              fail(
                new Error(
                  `dna708b-cold-start-readiness-timeout:${timeoutRejectionContext(
                    target,
                    lastQualificationRejection
                  )}`
                )
              ),
            timeoutMs
          );

          const poll = () => {
            if (settled) return;
            const observedAt = now();
            const driverGeneration = safeInteger(target.__tileEngineDriver?.built);
            const activeSnapshot = target.__webglColdGestureSnapshot?.(TRACK_ID) ?? null;
            if (
              activeSnapshot?.contract === 'active-webgl-cold-gesture-snapshot.v1' &&
              activeSnapshot.verdict === 'exactly-one' &&
              activeSnapshot.requestedTrackId === TRACK_ID &&
              activeSnapshot.registeredInstanceCount === 1 &&
              typeof activeSnapshot.instanceId === 'string' &&
              !oldInstanceIds.has(activeSnapshot.instanceId) &&
              rendererReadyAt == null
            ) {
              rendererReadyAt = observedAt;
            }
            if (driverGeneration > driverGenerationBefore && driverReadyAt == null) {
              driverReadyAt = observedAt;
            }
            maybeStartMainIpcHeartbeat(observedAt);
            if (settled) return;

            let qualified: QualifiedFrame | null = null;
            try {
              qualified = qualifyFirstFrame(
                target,
                activeSnapshot,
                oldInstanceIds,
                options.genomeLength,
                reloadRequestedAt,
                options.requireDurableCacheHit === true,
                (reason) => {
                  lastQualificationRejection = reason;
                }
              );
            } catch (error) {
              qualified = null;
              lastQualificationRejection = `qualification-threw:${
                error instanceof Error ? error.message : String(error)
              }`;
            }
            if (qualified && rendererReadyAt != null && driverReadyAt != null) {
              if (candidate == null || candidate.qualificationKey !== qualified.qualificationKey) {
                lastQualificationRejection =
                  candidate == null
                    ? 'awaiting-consecutive-qualified-frame'
                    : 'qualified-authority-changed-before-consecutive-frame';
                candidate = qualified;
                sceneReadyAt = observedAt;
              } else if (
                qualified.frameCount >= candidate.frameCount &&
                mainIpcHeartbeatSessionPresentationReady &&
                mainIpcHeartbeatCount >= MAIN_IPC_HEARTBEAT_WARMUP_COUNT &&
                !mainIpcHeartbeatInFlight &&
                mainIpcHeartbeatSessionId != null
              ) {
                const rendererGenerationAfter = rendererGenerationBefore + 1;
                rendererGeneration = rendererGenerationAfter;
                const initial = qualified;
                const readyRendererAt = rendererReadyAt;
                const readyDriverAt = driverReadyAt;
                const heartbeatSessionId = mainIpcHeartbeatSessionId;
                finish(() =>
                  resolve({
                    reloadRequestedAt,
                    reloadGenerationBefore,
                    reloadGenerationAfter,
                    rendererGenerationBefore,
                    rendererGenerationAfter,
                    driverGenerationBefore,
                    driverGenerationAfter: driverGeneration,
                    rendererReadyAt: readyRendererAt,
                    driverReadyAt: readyDriverAt,
                    sceneReadyAt: sceneReadyAt ?? observedAt,
                    initialFullGenomeFrameAt: observedAt,
                    initialFrameSpanBp: initial.spanBp,
                    initialAnnotationOwner: initial.owner,
                    initialAnnotationOwnerCount: initial.ownerCount,
                    initialAnnotationPackCount: initial.packCount,
                    initialAnnotationBuildCount: initial.buildCount,
                    initialWebglInstanceId: initial.instanceId,
                    initialWebglInstanceCreatedAt: initial.instanceCreatedAt,
                    initialReadinessRunGeneration: initial.runGeneration,
                    initialAnnotationOwnerKey: initial.ownerKey,
                    initialAnnotationOwnerGeneration: initial.ownerGeneration,
                    initialAnnotationCacheStatus: initial.cacheStatus,
                    initialAnnotationCacheOrigin: initial.cacheOrigin,
                    initialAnnotationCacheState: initial.cacheState,
                    initialAnnotationCacheLifecycleOrigin: initial.cacheLifecycleOrigin,
                    initialAnnotationSourceIdentity: initial.sourceIdentity,
                    initialAnnotationArtifactKey: initial.artifactKey,
                    initialAnnotationArtifactPayloadBytes: initial.payloadBytes,
                    initialRendererGeneration: initial.operation.rendererGeneration,
                    initialRendererOperationEpoch: initial.operation.operationEpoch,
                    initialRendererContentOperationEpoch: initial.operation.contentOperationEpoch,
                    initialRendererCompletedFrameEpoch: initial.operation.completedFrameEpoch,
                    initialRendererPresentedFrameEpoch: initial.operation.presentedFrameEpoch,
                    initialRendererPresentedContentOperationEpoch:
                      initial.operation.presentedContentOperationEpoch,
                    initialRendererLoadGenomeCount: initial.operation.loadGenomeCount,
                    initialRendererAnnotationSnapshotAttemptCount:
                      initial.operation.annotationSnapshotAttemptCount,
                    initialRendererAnnotationSnapshotApplyCount:
                      initial.operation.annotationSnapshotApplyCount,
                    initialRendererPrepackedLoadCount: initial.operation.prepackedLoadCount,
                    initialRendererPrepackedPrepareCount: initial.operation.prepackedPrepareCount,
                    initialRendererPrepackedActivateCount: initial.operation.prepackedActivateCount,
                    initialRendererPrepackedPolicyUpdateCount:
                      initial.operation.prepackedPolicyUpdateCount,
                    initialRendererPrepackedRetireCount: initial.operation.prepackedRetireCount,
                    initialRendererContentChangedFrameCount:
                      initial.operation.contentChangedFrameCount,
                    initialRendererCameraOnlyFrameCount: initial.operation.cameraOnlyFrameCount,
                    initialAnnotationRequestedLayerM_RNAOnly:
                      initial.annotationPolicy.requestedLayerM_RNAOnly,
                    initialAnnotationMetadataTrackType: initial.annotationPolicy.metadataTrackType,
                    initialAnnotationRuntimeIsoformMode:
                      initial.annotationPolicy.runtimeIsoformMode,
                    initialAnnotationRuntimeLaneLimit: initial.annotationPolicy.runtimeLaneLimit,
                    initialAnnotationPolicyGeneration: initial.annotationPolicy.policyGeneration,
                    initialAnnotationSceneFingerprint: initial.annotationPolicy.sceneFingerprint,
                    initialAnnotationSourceFingerprint: initial.annotationPolicy.sourceFingerprint,
                    initialAnnotationPlacementFingerprint:
                      initial.annotationPolicy.placementFingerprint,
                    initialAnnotationRasterArtifactKey: initial.annotationPolicy.rasterArtifactKey,
                    initialMainIpcHeartbeatSessionId: heartbeatSessionId,
                    initialMainIpcHeartbeatCount: mainIpcHeartbeatCount,
                    initialMainIpcHeartbeatMaxMs: mainIpcHeartbeatMaxMs,
                    initialMainIpcHeartbeatLastMs: mainIpcHeartbeatLastMs,
                    initialMainIpcHeartbeatTimeoutCount: 0,
                    initialAnnotationCapabilityReady: mainIpcHeartbeatSessionAnnotationReady,
                    initialSearchReady: mainIpcHeartbeatSessionSearchReady,
                    initialCoverageProof: initial.coverage.proof,
                    initialCoverageOwner: initial.coverage.owner,
                    initialCoverageAuthorityKey: initial.coverage.authorityKey,
                    initialCoverageShaderProgramName: initial.coverage.shaderProgramName,
                    initialCoverageShaderProgramKey: initial.coverage.shaderProgramKey,
                    initialCoverageShaderProgramCompiled: true,
                    initialCoverageShaderProgramLinked: initial.coverage.shaderProgramLinked,
                    initialCoverageShaderTextureResourceBound: true,
                    initialCoverageTextureResourceUid: initial.coverage.textureResourceUid,
                    initialCoverageShaderTextureResourceUid:
                      initial.coverage.shaderTextureResourceUid,
                    initialCoverageTextureResourceCreateCount:
                      initial.coverage.textureResourceCreateCount,
                    initialCoverageGpuTextureResourceCreateCount:
                      initial.coverage.gpuTextureResourceCreateCount,
                    initialCoverageGpuTextureUploadCount: initial.coverage.gpuTextureUploadCount,
                    initialCoverageGpuTextureUploadComplete:
                      initial.coverage.gpuTextureUploadComplete,
                    initialCoverageGeometryBuildCount: initial.coverage.geometryBuildCount,
                    initialCoverageCameraUniformUpdateCount:
                      initial.coverage.cameraUniformUpdateCount,
                    initialCoverageBaseBinSizeBp: initial.coverage.baseBinSizeBp,
                    initialCoveragePublisherEpoch: initial.publishedFeed.publisherEpoch,
                    initialCoveragePublisherSourceKey: initial.publishedFeed.sourceKey,
                    initialCoveragePublicationSequence: initial.publishedFeed.publicationSequence,
                    initialCoveragePublishedAt: initial.publishedFeed.publishedAt,
                    initialCoverageMemoMaterializeCount:
                      initial.publishedFeed.coverageMemoMaterializeCount,
                    initialCoverageMemoRevisionChangeCount:
                      initial.publishedFeed.coverageMemoRevisionChangeCount,
                    initialExactCoverageRecordScanCount:
                      initial.publishedFeed.exactCoverageRecordScanCount,
                    initialExactCoverageGeneration: initial.publishedFeed.exactCoverageGeneration,
                    initialLegacyCoverageSamplePassCount: initial.coverage.legacySamplePassCount,
                    initialLegacyCoverageGeometryBuildCount:
                      initial.coverage.legacyGeometryBuildCount,
                    initialLegacyCoverageBufferUploadCount:
                      initial.coverage.legacyBufferUploadCount,
                  })
                );
                return;
              } else {
                lastQualificationRejection = !mainIpcHeartbeatSessionPresentationReady
                  ? 'awaiting-presentation-session-admission'
                  : mainIpcHeartbeatCount < MAIN_IPC_HEARTBEAT_WARMUP_COUNT ||
                      mainIpcHeartbeatInFlight
                    ? 'awaiting-main-ipc-heartbeat'
                    : qualified.frameCount < candidate.frameCount
                      ? 'presented-frame-count-regressed'
                      : 'awaiting-consecutive-qualified-observation';
              }
            } else {
              if (qualified) {
                lastQualificationRejection =
                  `renderer-or-driver-generation-not-ready:renderer=${String(rendererReadyAt != null)}` +
                  `:driver=${String(driverReadyAt != null)}`;
              }
              candidate = null;
              sceneReadyAt = null;
            }
            frameId = requestFrame(poll);
          };
          frameId = requestFrame(poll);
        });
      } finally {
        if (frameId != null) cancelFrame(frameId);
        if (failureTimer != null) clearFailureTimeout(failureTimer);
        activeRun = false;
      }
    },
  };
  return bridge;
}

export function installDna708bColdStartReloadBridge(
  runtime: Omit<ColdStartReloadBridgeRuntime, 'target'> & { target?: BridgeWindow }
): Dna708bColdStartReloadBridge {
  const target = runtime.target ?? (window as BridgeWindow);
  if (
    target.__dna708ColdStartReloadBridge?.schemaVersion === 1 &&
    target.__dna708ColdStartReloadBridge.recordsMainIpcResponsiveness === true &&
    target.__dna708ColdStartReloadBridge.recordsCoverageAtlasResourceSubmission === true &&
    target.__dna708ColdStartReloadBridge.recordsQualifiedCoverageBaselines === true &&
    target.__dna708ColdStartReloadBridge.recordsO1Qualification === true
  ) {
    return target.__dna708ColdStartReloadBridge;
  }
  const bridge = createDna708bColdStartReloadBridge({ ...runtime, target });
  target[BRIDGE_GLOBAL as '__dna708ColdStartReloadBridge'] = bridge;
  return bridge;
}
