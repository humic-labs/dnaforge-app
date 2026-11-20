import { entityDiscoveryContract } from '../shared/ipc/entity-discovery.contract';
import { notebookContract } from '../shared/ipc/notebook.contract';
import { importReviewContract } from '../shared/ipc/import-review.contract';
import { administrationContract } from '../shared/ipc/administration.contract';
import { primerArtifactContract } from '../shared/ipc/primer-artifact.contract';
import { sequenceAlignmentHistoryContract } from '../shared/ipc/sequence-alignment-history.contract';
import { trackViewCommandsContract } from '../shared/ipc/track-view-commands.contract';
import { sequenceDataLayersContract } from '../shared/ipc/sequence-data-layers.contract';
import { contactSourcesContract } from '../shared/ipc/contact-sources.contract';
import { comparisonSourcesContract } from '../shared/ipc/comparison-sources.contract';
import { originalProjectContract } from '../shared/ipc/original-project.contract';
import { organizationRegistryContract } from '../shared/ipc/organization-registry.contract';

import { molecularDataContract } from '../shared/ipc/molecular-data.contract';
import { scientificRecoveryContract } from '../shared/ipc/scientific-recovery.contract';
import { workTasksContract } from '../shared/ipc/work-tasks.contract';
import { scientificObjectsContract } from '../shared/ipc/scientific-objects.contract';
import { agentFeedbackContract } from '../shared/ipc/agent-feedback.contract';
import type { HostedAiBridge } from '../shared/hosted-ai-bridge';
import type {
  GenomeSearchRequestControlV1,
  PlatformBridge,
  TrustedAssemblyAnnotationSceneV4,
} from './types';
import { createReferenceAssetsPlatformBridge } from './reference-assets';
import { forwardGroup, type ClientOf } from '../shared/ipc/contract';
import {
  packMolecularDocument,
  packedMolecularDocumentByteLength,
  unpackMolecularDocument,
} from '../shared/molecular-document';
import { assertMolecularDocumentSize } from '../shared/molecular-storage';
import { entityNavigationContract } from '../shared/ipc/entity-navigation.contract';
import {
  agentAttachmentsContract,
  agentCapabilitiesContract,
  agentConfirmContract,
  appDirtyStateContract,
  agentSdkContract,
  agentSdkMcpHttpListenerContract,
  benchlingMigrationContract,
  clipboardContract,
  googleSheetsContract,
  cloudSyncBackupContract,
  cloudSyncContract,
  cloudSyncDeepShareContract,
  computeContract,
  configContract,
  conversationLedgerContract,
  dbContract,
  dialogContract,
  fileAssociationsContract,
  fsContract,
  fsInlineReferenceTargetContract,
  genomeCredentialsContract,
  hostedAllowanceContract,
  internalFixturesContract,
  keyringContract,
  largeFileImportDialogContract,
  limsContract,
  looseSequenceFilesContract,
  molecularCatalogContract,
  molecularDocumentsContract,
  pathContract,
  pdfContract,
  remoteGenomicsContract,
  remoteHostsContract,
  runtimeContract,
  runtimeMemoryPressureOverrideContract,
  scientificDocumentsContract,
  shellContract,
  startupContract,
  terminalContract,
  thirdPartyNoticesContract,
  updateContract,
  windowContract,
  workspaceBrowserContract,
  workspaceContract,
  workspaceNativeDocumentsContract,
  workspaceRelocateContract,
  workspaceSamplesContract,
} from '../shared/ipc/contracts';
import {
  TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4,
  scopeTrustedPartitionedTranscriptRendererAdmissionV4,
  unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4,
} from '@waypoint/genome-renderer/internal/trusted-annotation-scene-transport';
import type { PartitionedTranscriptSceneRoleSidecarV1 } from '@waypoint/genome-renderer/pure';
import { shouldEnableTestBridge } from '../lib/test-bridge-gate';
import {
  ASSEMBLY_ANNOTATION_SCENE_RESOURCE_HOST,
  ASSEMBLY_ANNOTATION_SCENE_RESOURCE_SCHEME,
  ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
  ASSEMBLY_COMPILED_BROAD_INTERACTION_IPC_V1,
  assemblyAnnotationSceneGenomeIdentityV1,
  assemblyAnnotationSceneInteractionOwnerKeyV3,
  assemblyAnnotationSceneScopeMatchesChromosomes,
  type AssemblyAnnotationSceneReadRequest,
  type AssemblyAnnotationSceneReadResult,
  type AssemblyAnnotationSceneDetailReadResultV1,
  type AssemblyAnnotationSceneDetailReadRequestV1,
  type AssemblyAnnotationSceneDetailWireReadResultV1,
  type AssemblyAnnotationSceneColorRolesWireV1,
  type AssemblyAnnotationSceneResourceCapability,
  type AssemblyReferenceAssetGenerationV1,
  type AssemblyAnnotationSceneWireReadResult,
  type AssemblyCompiledBroadInteractionHitResultV1,
  type AssemblyCompiledBroadInteractionWireHitResultV1,
  type AssemblyAnnotationSearchCancelRequestV1,
  type AssemblyAnnotationSearchQueryRequestV1,
  type AssemblyAnnotationSearchQueryResultV1,
  type AssemblyProteinSearchCancelRequestV1,
  type AssemblyProteinSearchQueryRequestV1,
  type AssemblyProteinSearchQueryResultV1,
  type AssemblySequenceSearchRequestV1,
  type AssemblySequenceSearchResultV1,
  type GenomeSearchHit,
  type GenomeSearchOptions,
  type IndexedGenomeManifest,
} from '../shared/indexed-genome';

declare global {
  interface Window {
    electronAPI: Omit<PlatformBridge, 'molecularDocuments'> & {
      molecularDocuments: ClientOf<typeof molecularDocumentsContract>;
      notebook: ClientOf<typeof notebookContract>;
      workspace: ClientOf<typeof workspaceNativeDocumentsContract> &
        ClientOf<typeof workspaceContract>;
      hostedAi: HostedAiBridge;
      fs: ClientOf<typeof fsContract> & ClientOf<typeof fsInlineReferenceTargetContract>;
    };
    __waypointTestAgentSession?: Partial<PlatformBridge['agentSession']>;
  }
}

const api = () => window.electronAPI;
const trustedAssemblyAnnotationScenes = new WeakMap<object, TrustedAssemblyAnnotationSceneV4>();
type TrustedAnnotationSceneHit = Extract<AssemblyAnnotationSceneReadResult, { status: 'hit' }>;

const retainedTrustedAssemblyAnnotationScenes = new Map<string, TrustedAnnotationSceneHit>();
const retainedTrustedAssemblyAnnotationScenesByOwner = new Map<string, TrustedAnnotationSceneHit>();
const MAX_RETAINED_TRUSTED_ASSEMBLY_ANNOTATION_SCENES = 4;

export function resetRetainedTrustedAssemblyAnnotationScenesForTest(): void {
  retainedTrustedAssemblyAnnotationScenes.clear();
  retainedTrustedAssemblyAnnotationScenesByOwner.clear();
}

async function notifyNativePackageChange<T>(
  packageRoot: string,
  publication: Promise<T>
): Promise<T> {
  const result = await publication;
  window.dispatchEvent(
    new CustomEvent('waypoint:workspace-files-changed', { detail: { path: packageRoot } })
  );
  return result;
}

function isExactAnnotationSceneResourceUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === `${ASSEMBLY_ANNOTATION_SCENE_RESOURCE_SCHEME}:` &&
      url.hostname === ASSEMBLY_ANNOTATION_SCENE_RESOURCE_HOST &&
      url.username === '' &&
      url.password === '' &&
      url.port === '' &&
      url.search === '' &&
      url.hash === '' &&
      /^\/[A-Za-z0-9_-]{43}$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

interface AnnotationSceneWireMaterializationDeps {
  now?: () => number;
  fetchResource?: typeof fetch;
}

export type AnnotationSceneResourceMaterializationErrorCode =
  | 'invalid-capability'
  | 'invalid-response'
  | 'payload-length-mismatch'
  | 'resource-fetch-failed'
  | 'trusted-admission-failed';

export class AnnotationSceneResourceMaterializationError extends Error {
  readonly code: AnnotationSceneResourceMaterializationErrorCode;

  constructor(code: AnnotationSceneResourceMaterializationErrorCode, message: string) {
    super(message);
    this.name = 'AnnotationSceneResourceMaterializationError';
    this.code = code;
  }
}

export async function materializeAssemblyAnnotationSceneWireResult(
  wire: AssemblyAnnotationSceneWireReadResult | null,
  options?: { signal?: AbortSignal },
  deps: AnnotationSceneWireMaterializationDeps = {}
): Promise<AssemblyAnnotationSceneReadResult | null> {
  if (!wire || wire.status === 'miss') return wire;
  const payload = await materializeAssemblyAnnotationResourcePayload(
    wire,
    wire.manifest.integrity.payloadSha256,
    options,
    deps
  );
  const { resource: _resource, colorRoles: colorRolesWire, ...metadata } = wire;
  const colorRoles = colorRolesWire
    ? await materializeAssemblyAnnotationSceneColorRolesV1(wire, colorRolesWire, options, deps)
    : undefined;
  return { ...metadata, payload, ...(colorRoles ? { colorRoles } : {}) };
}

async function materializeAssemblyAnnotationSceneColorRolesV1(
  scene: { fingerprint: string; sourceBuildFingerprint: string },
  wire: AssemblyAnnotationSceneColorRolesWireV1,
  options: { signal?: AbortSignal } | undefined,
  deps: AnnotationSceneWireMaterializationDeps
): Promise<PartitionedTranscriptSceneRoleSidecarV1 | undefined> {
  try {
    const bytes = await materializeAssemblyAnnotationResourcePayload(
      {
        byteCount: wire.expandedCount + wire.canonicalCount,
        fingerprint: scene.fingerprint,
        sourceBuildFingerprint: scene.sourceBuildFingerprint,
        resource: wire.resource,
      },
      wire.resource.payloadSha256,
      options,
      deps
    );
    if (bytes.byteLength !== wire.expandedCount + wire.canonicalCount) return undefined;
    return {
      roleTable: [...wire.roleTable],
      expandedRoleIndices: bytes.subarray(0, wire.expandedCount),
      canonicalRoleIndices: bytes.subarray(wire.expandedCount),
    };
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    return undefined;
  }
}

export async function materializeAssemblyCompiledBroadInteractionWireResultV1(
  wire: AssemblyCompiledBroadInteractionWireHitResultV1 | null,
  options?: { signal?: AbortSignal },
  deps: AnnotationSceneWireMaterializationDeps = {}
): Promise<AssemblyCompiledBroadInteractionHitResultV1 | null> {
  if (!wire) return null;
  if (
    wire.contract !== ASSEMBLY_COMPILED_BROAD_INTERACTION_IPC_V1 ||
    (wire.authorityKind !== 'portable' && wire.authorityKind !== 'local') ||
    (wire.origin !== 'durable-hit' && wire.origin !== 'prepared-after-miss') ||
    wire.sourceScene.byteCount !== wire.manifest.sourceScene.byteLength ||
    wire.sourceScene.payloadSha256 !== wire.manifest.sourceScene.payloadSha256 ||
    wire.sourceScene.contractSha256 !== wire.manifest.sourceScene.contractSha256
  ) {
    throw new AnnotationSceneResourceMaterializationError(
      'invalid-capability',
      'The compact annotation interaction did not match its admitted parent scene.'
    );
  }
  const payload = await materializeAssemblyAnnotationResourcePayload(
    wire,
    wire.manifest.integrity.payloadSha256,
    options,
    deps
  );
  const { resource: _resource, ...metadata } = wire;
  return { ...metadata, payload };
}

export async function materializeAssemblyAnnotationSceneDetailWireResultV1(
  request: AssemblyAnnotationSceneDetailReadRequestV1,
  wire: AssemblyAnnotationSceneDetailWireReadResultV1 | null,
  options?: { signal?: AbortSignal },
  deps: AnnotationSceneWireMaterializationDeps = {}
): Promise<AssemblyAnnotationSceneDetailReadResultV1 | null> {
  if (!wire) return null;
  const artifactMatches = (
    Object.keys(request.source.artifact) as Array<keyof typeof request.source.artifact>
  ).every((key) => wire.artifact[key] === request.source.artifact[key]);
  const sourceMatches =
    artifactMatches &&
    assemblyAnnotationSceneScopeMatchesChromosomes(wire.scope, request.source.chromosomes) &&
    wire.scope.kind === request.source.scope.kind &&
    !wire.scope.placements.some((placement, index) => {
      const expected = request.source.scope.placements[index];
      return (
        placement.chrom !== expected?.chrom ||
        placement.length !== expected?.length ||
        placement.annotationCoverage !== expected?.annotationCoverage
      );
    });
  if (wire.status === 'unavailable') {
    if (
      request.contract !== ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1 ||
      wire.contract !== ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1 ||
      wire.reason !== 'range-catalog-unavailable' ||
      !sourceMatches
    ) {
      throw new AnnotationSceneResourceMaterializationError(
        'invalid-capability',
        'The annotation detail capability result did not match its exact source request.'
      );
    }
    return wire;
  }
  if (
    request.contract !== ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1 ||
    wire.contract !== ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1 ||
    wire.status !== 'hit' ||
    wire.manifest.requestedRange.startBp !== request.startBp ||
    wire.manifest.requestedRange.endBp !== request.endBp ||
    wire.manifest.assemblyLengthBp !==
      request.source.chromosomes.reduce((sum, chromosome) => sum + chromosome.length, 0) ||
    wire.manifest.partitionSpanBp !== request.source.artifact.partitionSpanBp ||
    !sourceMatches ||
    wire.byteCount !== wire.manifest.byteLength
  ) {
    throw new AnnotationSceneResourceMaterializationError(
      'invalid-capability',
      'The bounded annotation detail did not match its exact source request.'
    );
  }
  const payload = await materializeAssemblyAnnotationResourcePayload(
    wire,
    wire.manifest.integrity.payloadSha256,
    options,
    deps
  );
  const { resource: _resource, ...metadata } = wire;
  return { ...metadata, payload };
}

async function materializeAssemblyAnnotationResourcePayload(
  wire: {
    byteCount: number;
    fingerprint: string;
    sourceBuildFingerprint: string;
    resource: AssemblyAnnotationSceneResourceCapability;
  },
  expectedPayloadSha256: string,
  options: { signal?: AbortSignal } | undefined,
  deps: AnnotationSceneWireMaterializationDeps
): Promise<Uint8Array> {
  const resource = wire.resource;
  if (shouldEnableTestBridge(import.meta.env)) {
    const observedAtMs = (deps.now ?? Date.now)();
    console.log(
      '[annotation-resource-lifecycle]',
      JSON.stringify({
        phase: 'received',
        fingerprint: wire.fingerprint,
        byteCount: wire.byteCount,
        observedAtMs,
        expiresAtMs: resource.expiresAtMs,
        expired: observedAtMs >= resource.expiresAtMs,
        byteCountMatches: resource.byteCount === wire.byteCount,
        payloadSha256Matches: resource.payloadSha256 === expectedPayloadSha256,
        urlMatches: isExactAnnotationSceneResourceUrl(resource.url),
      })
    );
  }
  if (
    resource.byteCount !== wire.byteCount ||
    resource.payloadSha256 !== expectedPayloadSha256 ||
    (deps.now ?? Date.now)() >= resource.expiresAtMs ||
    !isExactAnnotationSceneResourceUrl(resource.url)
  ) {
    throw new AnnotationSceneResourceMaterializationError(
      'invalid-capability',
      'The annotation resource carried an invalid or expired capability.'
    );
  }
  try {
    const response = await (deps.fetchResource ?? fetch)(resource.url, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: options?.signal,
    });
    if (
      !response.ok ||
      response.headers.get('content-length') !== String(wire.byteCount) ||
      response.headers.get('x-waypoint-scene-sha256') !== resource.payloadSha256 ||
      response.headers.get('x-waypoint-scene-fingerprint') !== wire.fingerprint ||
      response.headers.get('x-waypoint-scene-compiler-fingerprint') !== wire.sourceBuildFingerprint
    ) {
      throw new AnnotationSceneResourceMaterializationError(
        'invalid-response',
        'The annotation resource response did not match its validated metadata.'
      );
    }
    const ownedBuffer = await response.arrayBuffer();
    if (ownedBuffer.byteLength !== wire.byteCount) {
      throw new AnnotationSceneResourceMaterializationError(
        'payload-length-mismatch',
        'The annotation resource payload length did not match its validated metadata.'
      );
    }
    return new Uint8Array(ownedBuffer);
  } catch (error) {
    if (
      options?.signal?.aborted ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      throw error;
    }
    if (error instanceof AnnotationSceneResourceMaterializationError) throw error;
    throw new AnnotationSceneResourceMaterializationError(
      'resource-fetch-failed',
      'The annotation resource could not be fetched after admission.'
    );
  }
}

async function readAssemblyAnnotationScene(
  request: AssemblyAnnotationSceneReadRequest,
  options?: {
    signal?: AbortSignal;
    retainedAssetGeneration?: AssemblyReferenceAssetGenerationV1 | null;
    retainedInteractionOwnerKey?: string | null;
  }
): Promise<AssemblyAnnotationSceneReadResult | null> {
  options?.signal?.throwIfAborted();
  const requestIdentity = retainedTrustedAssemblyAnnotationSceneRequestKey(request);
  const retainedOwnerKey = options?.retainedInteractionOwnerKey?.trim() || null;
  const retainedByOwner = retainedOwnerKey
    ? retainedTrustedAssemblyAnnotationScenesByOwner.get(
        retainedTrustedAssemblyAnnotationSceneOwnerKey(requestIdentity, retainedOwnerKey)
      )
    : null;
  if (retainedByOwner) {
    return retainedByOwner;
  }
  const retainedKey = retainedTrustedAssemblyAnnotationSceneKey(
    request,
    options?.retainedAssetGeneration ?? null
  );
  const retained = retainedKey ? retainedTrustedAssemblyAnnotationScenes.get(retainedKey) : null;
  if (retained) {
    retainedTrustedAssemblyAnnotationScenes.delete(retainedKey!);
    retainedTrustedAssemblyAnnotationScenes.set(retainedKey!, retained);
    return retained;
  }
  const wire = (await api().genome.readAssemblyAnnotationScene(
    request
  )) as AssemblyAnnotationSceneWireReadResult | null;
  const result = await materializeAssemblyAnnotationSceneWireResult(wire, options);
  if (!wire || wire.status !== 'hit' || !result || result.status !== 'hit') return result;
  try {
    const trusted = admitTrustedAssemblyAnnotationScene(request, result);
    if (!trusted) {
      throw new AnnotationSceneResourceMaterializationError(
        'trusted-admission-failed',
        'The annotation scene payload failed renderer admission after a validated cache hit.'
      );
    }
    trustedAssemblyAnnotationScenes.set(result, trusted);
    if (retainedKey) rememberRetainedTrustedAssemblyAnnotationScene(retainedKey, result);
    rememberRetainedTrustedAssemblyAnnotationSceneOwner(requestIdentity, result);
    return result;
  } catch (error) {
    if (error instanceof AnnotationSceneResourceMaterializationError) throw error;
    throw new AnnotationSceneResourceMaterializationError(
      'trusted-admission-failed',
      'The annotation scene payload failed renderer admission after a validated cache hit.'
    );
  }
}

async function readAssemblyCompiledBroadInteractionV1(
  request: AssemblyAnnotationSceneReadRequest,
  options?: { signal?: AbortSignal }
): Promise<AssemblyCompiledBroadInteractionHitResultV1 | null> {
  options?.signal?.throwIfAborted();
  const wire = (await api().genome.readAssemblyCompiledBroadInteractionV1(
    request
  )) as AssemblyCompiledBroadInteractionWireHitResultV1 | null;
  return materializeAssemblyCompiledBroadInteractionWireResultV1(wire, options);
}

async function readAssemblyAnnotationSceneDetailV1(
  request: AssemblyAnnotationSceneDetailReadRequestV1,
  options?: { signal?: AbortSignal }
): Promise<AssemblyAnnotationSceneDetailReadResultV1 | null> {
  options?.signal?.throwIfAborted();
  const wire = (await api().genome.readAssemblyAnnotationSceneDetailV1(
    request
  )) as AssemblyAnnotationSceneDetailWireReadResultV1 | null;
  return materializeAssemblyAnnotationSceneDetailWireResultV1(request, wire, options);
}

function retainedTrustedAssemblyAnnotationSceneKey(
  request: AssemblyAnnotationSceneReadRequest,
  rendererGeneration: AssemblyReferenceAssetGenerationV1 | null
): string | null {
  const generation = request.expectedAssetGeneration ?? rendererGeneration;
  if (!generation || generation.themeMode !== request.artifact.themeMode) return null;
  if (
    request.expectedAssetGeneration &&
    rendererGeneration &&
    (request.expectedAssetGeneration.contract !== rendererGeneration.contract ||
      request.expectedAssetGeneration.sourceFingerprint !== rendererGeneration.sourceFingerprint ||
      request.expectedAssetGeneration.inventoryFingerprint !==
        rendererGeneration.inventoryFingerprint ||
      request.expectedAssetGeneration.themeMode !== rendererGeneration.themeMode)
  ) {
    return null;
  }
  return [
    'retained-trusted-assembly-annotation-scene.v1',
    generation.contract,
    generation.sourceFingerprint,
    generation.inventoryFingerprint,
    generation.themeMode,
    retainedTrustedAssemblyAnnotationSceneRequestKey(request),
  ].join('\n');
}

function retainedTrustedAssemblyAnnotationSceneRequestKey(
  request: AssemblyAnnotationSceneReadRequest
): string {
  return [
    'retained-trusted-assembly-annotation-scene-request.v1',
    request.ipcContractVersion,
    request.assemblyId,
    request.workspaceRoot,
    request.datasetContract.datasetId,
    request.datasetContract.datasetVersion,
    request.datasetContract.sourceSha256,
    ...Object.keys(request.artifact)
      .sort()
      .map((key) => `${key}:${String(request.artifact[key as keyof typeof request.artifact])}`),
    request.scope.kind,
    ...request.scope.placements.map(
      (placement, index) =>
        `${index}|${placement.chrom}|${placement.length}|${placement.annotationCoverage}`
    ),
    ...request.chromosomes.map(
      (chromosome, index) =>
        `${index}|${chromosome.chrom}|${chromosome.length}|${chromosome.sourcePath ?? ''}`
    ),
  ].join('\n');
}

function retainedTrustedAssemblyAnnotationSceneOwnerKey(
  requestIdentity: string,
  ownerKey: string
): string {
  return ['retained-trusted-assembly-annotation-scene-owner.v1', requestIdentity, ownerKey].join(
    '\n'
  );
}

function rememberRetainedTrustedAssemblyAnnotationSceneOwner(
  requestIdentity: string,
  result: TrustedAnnotationSceneHit
): void {
  const ownerKey = assemblyAnnotationSceneInteractionOwnerKeyV3({
    sourceFingerprint: result.fingerprint,
    scenePayloadSha256: result.manifest.integrity.payloadSha256,
    sceneArtifactKey: result.artifact.artifactKey,
  });
  if (!ownerKey) return;
  const retainedKey = retainedTrustedAssemblyAnnotationSceneOwnerKey(requestIdentity, ownerKey);
  retainedTrustedAssemblyAnnotationScenesByOwner.delete(retainedKey);
  retainedTrustedAssemblyAnnotationScenesByOwner.set(retainedKey, result);
  while (
    retainedTrustedAssemblyAnnotationScenesByOwner.size >
    MAX_RETAINED_TRUSTED_ASSEMBLY_ANNOTATION_SCENES
  ) {
    const oldest = retainedTrustedAssemblyAnnotationScenesByOwner.keys().next().value as
      | string
      | undefined;
    if (!oldest) break;
    retainedTrustedAssemblyAnnotationScenesByOwner.delete(oldest);
  }
}

function rememberRetainedTrustedAssemblyAnnotationScene(
  key: string,
  result: TrustedAnnotationSceneHit
): void {
  retainedTrustedAssemblyAnnotationScenes.delete(key);
  retainedTrustedAssemblyAnnotationScenes.set(key, result);
  while (
    retainedTrustedAssemblyAnnotationScenes.size > MAX_RETAINED_TRUSTED_ASSEMBLY_ANNOTATION_SCENES
  ) {
    const oldest = retainedTrustedAssemblyAnnotationScenes.keys().next().value as
      | string
      | undefined;
    if (!oldest) break;
    retainedTrustedAssemblyAnnotationScenes.delete(oldest);
  }
}

async function queryAssemblyAnnotationSearch(
  request: AssemblyAnnotationSearchQueryRequestV1,
  options?: { signal?: AbortSignal }
): Promise<AssemblyAnnotationSearchQueryResultV1 | null> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  const cancelRequest: AssemblyAnnotationSearchCancelRequestV1 = {
    clientId: request.clientId,
    requestId: request.requestId,
  };
  const onAbort = () => {
    void Promise.resolve(api().genome.cancelAssemblyAnnotationSearch(cancelRequest)).catch(
      () => undefined
    );
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await api().genome.queryAssemblyAnnotationSearch(request);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function cancelAssemblyAnnotationSearch(
  request: AssemblyAnnotationSearchCancelRequestV1
): Promise<boolean> {
  return api().genome.cancelAssemblyAnnotationSearch(request);
}

async function queryAssemblyProteinSearch(
  request: AssemblyProteinSearchQueryRequestV1,
  options?: { signal?: AbortSignal }
): Promise<AssemblyProteinSearchQueryResultV1 | null> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  const cancelRequest: AssemblyProteinSearchCancelRequestV1 = {
    clientId: request.clientId,
    requestId: request.requestId,
  };
  const onAbort = () => {
    void Promise.resolve(api().genome.cancelAssemblyProteinSearch(cancelRequest)).catch(
      () => undefined
    );
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await api().genome.queryAssemblyProteinSearch(request);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function cancelAssemblyProteinSearch(
  request: AssemblyProteinSearchCancelRequestV1
): Promise<boolean> {
  return api().genome.cancelAssemblyProteinSearch(request);
}

async function searchSequence(
  manifest: IndexedGenomeManifest,
  chrom: string,
  motif: string,
  opts: GenomeSearchOptions | undefined,
  control: GenomeSearchRequestControlV1
): Promise<GenomeSearchHit[]> {
  const { signal, clientId, requestId } = control;
  signal?.throwIfAborted();
  const serializableControl = { clientId, requestId };
  const onAbort = () => {
    void Promise.resolve(api().genome.cancelSequenceSearch(serializableControl)).catch(
      () => undefined
    );
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await api().genome.searchSequence(
      manifest,
      chrom,
      motif,
      opts,
      serializableControl
    );
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function searchAssemblySequence(
  request: AssemblySequenceSearchRequestV1,
  options?: { signal?: AbortSignal }
): Promise<AssemblySequenceSearchResultV1> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  const cancelRequest = {
    clientId: request.clientId,
    requestId: request.requestId,
  };
  const onAbort = () => {
    void Promise.resolve(api().genome.cancelSequenceSearch(cancelRequest)).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await api().genome.searchAssemblySequence(request);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function getTrustedAssemblyAnnotationScene(
  result: AssemblyAnnotationSceneReadResult
): TrustedAssemblyAnnotationSceneV4 | null {
  return trustedAssemblyAnnotationScenes.get(result) ?? null;
}

function admitTrustedAssemblyAnnotationScene(
  request: AssemblyAnnotationSceneReadRequest,
  result: Extract<AssemblyAnnotationSceneReadResult, { status: 'hit' }>
): TrustedAssemblyAnnotationSceneV4 | null {
  const artifactMatches = (
    Object.keys(request.artifact) as Array<keyof typeof request.artifact>
  ).every((key) => result.artifact[key] === request.artifact[key]);
  const assemblyLengthBp = request.chromosomes.reduce(
    (sum, chromosome) => sum + chromosome.length,
    0
  );
  if (
    !artifactMatches ||
    !/^[0-9a-f]{24}$/.test(result.fingerprint) ||
    !assemblyAnnotationSceneScopeMatchesChromosomes(result.scope, request.chromosomes) ||
    result.scope.kind !== request.scope.kind ||
    result.scope.placements.some((placement, index) => {
      const expected = request.scope.placements[index];
      return (
        placement.chrom !== expected?.chrom ||
        placement.length !== expected?.length ||
        placement.annotationCoverage !== expected?.annotationCoverage
      );
    }) ||
    result.manifest.datasetContract.datasetId !== request.datasetContract.datasetId ||
    result.manifest.datasetContract.datasetVersion !== request.datasetContract.datasetVersion ||
    result.manifest.datasetContract.sourceSha256 !== request.datasetContract.sourceSha256 ||
    result.manifest.assemblyContract.assemblyId !== request.assemblyId ||
    result.manifest.assemblyContract.assemblyLengthBp !== assemblyLengthBp
  ) {
    return null;
  }
  const decoded = unpackTrustedMainValidatedPartitionedTranscriptSceneBinaryV4(
    result.manifest,
    result.payload,
    TRUSTED_MAIN_PARTITIONED_TRANSCRIPT_SCENE_VALIDATION_V4
  );
  const ownerKey = assemblyAnnotationSceneInteractionOwnerKeyV3({
    sourceFingerprint: result.fingerprint,
    scenePayloadSha256: result.manifest.integrity.payloadSha256,
    sceneArtifactKey: request.artifact.artifactKey,
  });
  const genomeIdentity = assemblyAnnotationSceneGenomeIdentityV1(request);
  if (!ownerKey || !genomeIdentity) return null;
  const loadIdentity = {
    ownerKey,
    sceneContractSha256: result.manifest.integrity.contractSha256,
    genomeIdentity,
    genomeLengthBp: assemblyLengthBp,
    partitionSpanBp: request.artifact.partitionSpanBp,
    artifactKey: request.artifact.artifactKey,
    themeMode: request.artifact.themeMode,
    trackType: request.artifact.trackType,
    annotationBarHeightPx: request.artifact.annotationBarHeightPx,
    laneAlgorithmToken: request.artifact.laneAlgorithmToken,
    mapperContractToken: request.artifact.mapperContractToken,
    geometryContractToken: request.artifact.geometryContractToken,
    interactionContractToken: request.artifact.interactionContractToken,
  } as const;
  const scoped = scopeTrustedPartitionedTranscriptRendererAdmissionV4(
    decoded.rendererAdmissionCapability,
    {
      provenance: decoded.rendererAdmissionProvenance,
      scene: decoded.scene,
      families: decoded.families,
      featureFamilyIndices: decoded.featureFamilyIndices,
      interactionIndex: decoded.interactionIndex,
      policyProjection: decoded.policyProjection,
      submissionBank: decoded.submissionBank,
      submissionFineIndices: decoded.submissionFineIndices,
    },
    loadIdentity
  );
  const colorRoles = colorRolesFitBanks(result.colorRoles, decoded.submissionBank)
    ? result.colorRoles
    : undefined;
  return {
    ...decoded,
    rendererAdmissionCapability: scoped.capability,
    rendererAdmissionLoadIdentity: scoped.loadIdentity,
    ...(colorRoles ? { colorRoles } : {}),
  };
}

function colorRolesFitBanks(
  roles: PartitionedTranscriptSceneRoleSidecarV1 | undefined,
  bank: TrustedAssemblyAnnotationSceneV4['submissionBank']
): roles is PartitionedTranscriptSceneRoleSidecarV1 {
  if (!roles || !bank) return false;
  const tableLength = roles.roleTable.length;
  const fits = (indices: Uint8Array, records: number) =>
    indices.length === records && indices.every((index) => index < tableLength);
  return (
    tableLength > 0 &&
    fits(roles.expandedRoleIndices, bank.expanded.featureIndices.length) &&
    fits(roles.canonicalRoleIndices, bank.canonical.featureIndices.length)
  );
}

function testAgentSessionBridge(): Partial<PlatformBridge['agentSession']> | null {
  if (!shouldEnableTestBridge(import.meta.env)) return null;
  return window.__waypointTestAgentSession ?? null;
}

export const electronBridge: PlatformBridge = {
  hostedAi: forwardGroup(hostedAllowanceContract, () => api().hostedAi),
  runtime: {
    ...forwardGroup(runtimeContract, () => api().runtime),
    ...forwardGroup(runtimeMemoryPressureOverrideContract, () => api().runtime),
    getProfile: () => api().runtime.getProfile(),
    getProvenance: () => api().runtime.getProvenance(),
  },
  molecularCatalog: forwardGroup(molecularCatalogContract, () => api().molecularCatalog),
  molecularData: forwardGroup(molecularDataContract, () => api().molecularData),
  scientificDocuments: {
    ...forwardGroup(scientificDocumentsContract, () => api().scientificDocuments),
  },
  entityNavigation: forwardGroup(entityNavigationContract, () => api().entityNavigation),
  workTasks: forwardGroup(workTasksContract, () => api().workTasks),
  scientificObjects: forwardGroup(scientificObjectsContract, () => api().scientificObjects),
  fileAssociations: forwardGroup(fileAssociationsContract, () => api().fileAssociations),
  db: {
    ...forwardGroup(dbContract, () => api().db),
    select: (sql, params) => api().db.select(sql, params),
    createChatTurnWithUserMessage: (input) => {
      const create = api().db.createChatTurnWithUserMessage;
      if (typeof create !== 'function') {
        throw new Error('Electron preload did not expose atomic chat-turn creation.');
      }
      return create(input);
    },
    commitChatTurnTerminalState: (input) => {
      const commit = api().db.commitChatTurnTerminalState;
      if (typeof commit !== 'function') {
        throw new Error('Electron preload did not expose atomic terminal chat-turn persistence.');
      }
      return commit(input);
    },
    deleteConversation: (id) => {
      const remove = api().db.deleteConversation;
      if (typeof remove !== 'function') {
        throw new Error('Electron preload did not expose atomic conversation deletion.');
      }
      return remove(id);
    },
    deleteMessage: (id) => {
      const remove = api().db.deleteMessage;
      if (typeof remove !== 'function') {
        throw new Error('Electron preload did not expose atomic message deletion.');
      }
      return remove(id);
    },
  },
  importReview: forwardGroup(importReviewContract, () => api().importReview),
  entityDiscovery: forwardGroup(entityDiscoveryContract, () => api().entityDiscovery),
  notebook: forwardGroup(notebookContract, () => api().notebook),
  administration: forwardGroup(administrationContract, () => api().administration),
  lims: {
    ...forwardGroup(limsContract, () => api().lims),
    ...forwardGroup(primerArtifactContract, () => api().lims),
  },

  fs: {
    ...forwardGroup(sequenceAlignmentHistoryContract, () => api().fs),
    ...forwardGroup(fsContract, () => api().fs),
    ...forwardGroup(fsInlineReferenceTargetContract, () => api().fs),
    publishSequenceUserAttachmentMutation: (input) =>
      notifyNativePackageChange(
        input.packageRoot,
        api().fs.publishSequenceUserAttachmentMutation(input)
      ),
    applySequenceRestore: (input) =>
      notifyNativePackageChange(input.packageRoot, api().fs.applySequenceRestore(input)),
    prepareSequenceEvidenceRun: (input) =>
      notifyNativePackageChange(input.packageRoot, api().fs.prepareSequenceEvidenceRun(input)),
    activateSequenceEvidenceRun: (input) =>
      notifyNativePackageChange(input.packageRoot, api().fs.activateSequenceEvidenceRun(input)),
    completeSequenceEvidenceRun: (input) =>
      notifyNativePackageChange(input.packageRoot, api().fs.completeSequenceEvidenceRun(input)),
    failSequenceEvidenceRun: (input) =>
      notifyNativePackageChange(input.packageRoot, api().fs.failSequenceEvidenceRun(input)),
    appendSequenceEvidenceState: (input) =>
      notifyNativePackageChange(input.packageRoot, api().fs.appendSequenceEvidenceState(input)),
    writeWorkspaceBinaryFileAtomic: (input) => api().fs.writeWorkspaceBinaryFileAtomic(input),
    writeWorkspaceTextFileAtomic: (input) => api().fs.writeWorkspaceTextFileAtomic(input),
    publishNotebookPackageV2InMain: (input) => api().fs.publishNotebookPackageV2InMain!(input),
    migrateNotebookPackageAtPathInMain: (input) =>
      api().fs.migrateNotebookPackageAtPathInMain!(input),
    prepareNotebookPackageRenameInMain: (input) =>
      api().fs.prepareNotebookPackageRenameInMain!(input),
    recoverNotebookPackageRenameIfNeededInMain: (input) =>
      api().fs.recoverNotebookPackageRenameIfNeededInMain!(input),
    packageSequenceFile: (filePath, options) => api().fs.packageSequenceFile!(filePath, options),
    createPackageScratch: (packageRoot, mutationToken) => {
      const create = api().fs.createPackageScratch;
      if (!create) throw new Error('Package scratch capability creation is unavailable.');
      return create(packageRoot, mutationToken);
    },
    removePackageScratch: (cleanupToken) => {
      const remove = api().fs.removePackageScratch;
      if (!remove) throw new Error('Package scratch capability cleanup is unavailable.');
      return remove(cleanupToken);
    },
    renamePackageScratchMember: (cleanupToken, oldPath, newPath) => {
      const renameMember = api().fs.renamePackageScratchMember;
      if (!renameMember) throw new Error('Package scratch member rename is unavailable.');
      return renameMember(cleanupToken, oldPath, newPath);
    },
  },
  pdf: forwardGroup(pdfContract, () => api().pdf!),
  dialog: forwardGroup(dialogContract, () => api().dialog),
  terminal: {
    ...forwardGroup(terminalContract, () => api().terminal!),
    focus: (id) => api().terminal!.focus?.(id) ?? Promise.resolve(),
    paste: (id, warnMultiline) => api().terminal!.paste(id, warnMultiline),
  },
  remoteHosts: forwardGroup(remoteHostsContract, () => api().remoteHosts),
  looseSequenceFiles: forwardGroup(looseSequenceFilesContract, () => api().looseSequenceFiles),
  thirdPartyNotices: forwardGroup(thirdPartyNoticesContract, () => api().thirdPartyNotices),
  remoteGenomics: {
    ...forwardGroup(remoteGenomicsContract, () => api().remoteGenomics!),
    subscribeStatus: (callback) => api().remoteGenomics!.subscribeStatus(callback),
  },
  path: forwardGroup(pathContract, () => api().path),
  trackViewCommands: forwardGroup(trackViewCommandsContract, () => api().trackViewCommands),
  sequenceDataLayers: forwardGroup(sequenceDataLayersContract, () => api().sequenceDataLayers),
  contactSources: forwardGroup(contactSourcesContract, () => api().contactSources),
  comparisonSources: forwardGroup(comparisonSourcesContract, () => api().comparisonSources),
  trackViews: {
    command: (request) => api().trackViewCommands.run(request),
    locations: () => api().trackViews.locations(),
    list: () => api().trackViews.list(),
    read: (id) => api().trackViews.read(id),
    save: (request) => api().trackViews.save(request),
  },
  molecularDocuments: {
    ...forwardGroup(molecularDocumentsContract, () => api().molecularDocuments),
    read: async (request) => {
      const saved = await api().molecularDocuments.read(request);
      return { ...saved, document: unpackMolecularDocument(saved.document) };
    },
    save: async (request) => {
      const document = packMolecularDocument(request.document);
      assertMolecularDocumentSize(packedMolecularDocumentByteLength(document));
      const saved = await api().molecularDocuments.save({ ...request, document });
      return { ...saved, document: unpackMolecularDocument(saved.document) };
    },
  },
  trackStore: {
    root: () => api().trackStore.root(),
    listAssemblies: () => api().trackStore.listAssemblies(),
    listTracks: (accession) => api().trackStore.listTracks(accession),
    readMeta: (ref) => api().trackStore.readMeta(ref),
    readTrackFile: (ref) => api().trackStore.readTrackFile(ref),
    refresh: () => api().trackStore.refresh(),
  },
  referenceAssets: createReferenceAssetsPlatformBridge(() => api().referenceAssets),
  workspace: {
    ...forwardGroup(originalProjectContract, () => api().workspace),
    ...forwardGroup(workspaceNativeDocumentsContract, () => api().workspace),
    ...forwardGroup(workspaceSamplesContract, () => api().workspace),
    ...forwardGroup(workspaceContract, () => api().workspace),
    ...forwardGroup(workspaceRelocateContract, () => api().workspace),
    ...forwardGroup(workspaceBrowserContract, () => api().workspace),
    getPathForFile: (file) => api().workspace.getPathForFile(file),
  },
  shell: forwardGroup(shellContract, () => api().shell),
  clipboard: forwardGroup(clipboardContract, () => api().clipboard),
  googleSheets: forwardGroup(googleSheetsContract, () => api().googleSheets),
  genome: {
    open: (source) => api().genome.open(source),
    closeSession: (sessionId) => api().genome.closeSession(sessionId),
    upgradeSessionCapabilities: (sessionId, source) =>
      api().genome.upgradeSessionCapabilities(sessionId, source),
    getAssemblyOverview: (request) => api().genome.getAssemblyOverview(request),
    readAssemblyOverviewTexture: (request) => api().genome.readAssemblyOverviewTexture(request),
    readAssemblyAnnotationRasterV2: (request) =>
      api().genome.readAssemblyAnnotationRasterV2(request),
    prepareAssemblyAnnotationAppearanceV1: (request) =>
      api().genome.prepareAssemblyAnnotationAppearanceV1(request),
    readAssemblyCompiledBroadRasterManifestV1: (request) =>
      api().genome.readAssemblyCompiledBroadRasterManifestV1(request),
    readAssemblyCompiledBroadRasterCellsV1: (request) =>
      api().genome.readAssemblyCompiledBroadRasterCellsV1(request),
    writeAssemblyOverviewTexture: (request) => api().genome.writeAssemblyOverviewTexture(request),
    readAssemblyAnnotationScene,
    readAssemblyAnnotationSceneDetailV1,
    readAssemblyCompiledBroadInteractionV1,
    queryAssemblyAnnotationSearch,
    cancelAssemblyAnnotationSearch,
    queryAssemblyProteinSearch,
    cancelAssemblyProteinSearch,
    getTrustedAssemblyAnnotationScene,
    readAssemblyAnnotationProductSetInventoryV1: (request) =>
      api().genome.readAssemblyAnnotationProductSetInventoryV1(request),
    writeAssemblyAnnotationScene: (request) => api().genome.writeAssemblyAnnotationScene(request),
    readAssemblyOverviewFeatures: (request) => api().genome.readAssemblyOverviewFeatures(request),
    writeAssemblyOverviewFeatures: (request) => api().genome.writeAssemblyOverviewFeatures(request),
    init: (manifest) => api().genome.init(manifest),
    getTrackTile: (sessionId, request, requestId) =>
      api().genome.getTrackTile(sessionId, request, requestId),
    getAnnotationTile: (sessionId, request, requestId) =>
      api().genome.getAnnotationTile(sessionId, request, requestId),
    getDebugSnapshot: (sessionId) => api().genome.getDebugSnapshot(sessionId),
    getSession: (sessionId) => api().genome.getSession(sessionId),
    cancelRequest: (sessionId, requestId) => api().genome.cancelRequest(sessionId, requestId),
    getFeatureDetails: (sessionId, request, requestId) =>
      api().genome.getFeatureDetails(sessionId, request, requestId),
    getFeatureDetailsByManifest: (manifest, request) =>
      api().genome.getFeatureDetailsByManifest(manifest, request),
    getSequenceWindow: (sessionId, request, requestId) =>
      api().genome.getSequenceWindow(sessionId, request, requestId),
    getSequence: (manifest, chrom, start, end) =>
      api().genome.getSequence(manifest, chrom, start, end),
    getFeatures: (manifest, chrom, start, end, zoomLevel) =>
      api().genome.getFeatures(manifest, chrom, start, end, zoomLevel),
    searchSequence,
    searchAssemblySequence,
    cancelSequenceSearch: (request) => api().genome.cancelSequenceSearch(request),
  },
  window: forwardGroup(windowContract, () => api().window),
  on: (channel, callback) => api().on(channel, callback),
  agentTools: {
    onCall: (callback) => api().agentTools.onCall(callback),
    onCancel: (callback) => api().agentTools.onCancel(callback),
    respond: (requestId, response) => api().agentTools.respond(requestId, response),
  },
  agentConfirm: {
    ...forwardGroup(agentConfirmContract, () => api().agentConfirm),
    respond: (requestId, response) => api().agentConfirm.respond(requestId, response),
    respondUserInput: (requestId, response) =>
      api().agentConfirm.respondUserInput(requestId, response),
  },
  largeFileImportDialog: {
    ...forwardGroup(largeFileImportDialogContract, () => api().largeFileImportDialog),
    respond: (requestId, response) => api().largeFileImportDialog.respond(requestId, response),
  },
  startup: forwardGroup(startupContract, () => api().startup),
  app: {
    ...forwardGroup(appDirtyStateContract, () => api().app),
    saveAllDone: (requestId, result) => api().app.saveAllDone(requestId, result),
  },
  update: {
    ...forwardGroup(updateContract, () => api().update),
    simulate: (...args) => api().update.simulate?.(...args) ?? Promise.resolve(),
  },
  keyring: {
    ...forwardGroup(keyringContract, () => api().keyring),
  },
  genomeCredentials: forwardGroup(genomeCredentialsContract, () => api().genomeCredentials),
  workspaceMutations: {
    onLifecycle: (callback) => api().workspaceMutations.onLifecycle(callback),
  },
  compute: forwardGroup(computeContract, () => api().compute),
  cloudSync: {
    ...forwardGroup(organizationRegistryContract, () => api().cloudSync),
    ...forwardGroup(scientificRecoveryContract, () => api().cloudSync),
    ...forwardGroup(cloudSyncBackupContract, () => api().cloudSync),
    ...forwardGroup(cloudSyncContract, () => api().cloudSync),
    ...forwardGroup(cloudSyncDeepShareContract, () => api().cloudSync),
    subscribeStatus: (workspaceUuid, callback) =>
      api().cloudSync.subscribeStatus(workspaceUuid, callback),
    onReplicaLifecycle: (callback) => api().cloudSync.onReplicaLifecycle(callback),
  },
  benchlingMigration: {
    ...forwardGroup(benchlingMigrationContract, () => api().benchlingMigration),
    subscribeProgress: (runId, callback, onStatus) =>
      api().benchlingMigration.subscribeProgress(runId, callback, onStatus),
    onRenderValidationRequest: (callback) =>
      api().benchlingMigration.onRenderValidationRequest(callback),
    respondRenderValidation: (requestId, response) =>
      api().benchlingMigration.respondRenderValidation(requestId, response),
  },
  agentSdk: {
    ...forwardGroup(agentSdkMcpHttpListenerContract, () => api().agentSdk),
    ...forwardGroup(agentSdkContract, () => api().agentSdk),
    detect: (pathOverrides) => api().agentSdk.detect(pathOverrides),
    getHelperLifecycleSnapshot: () => api().agentSdk.getHelperLifecycleSnapshot(),
    getExternalMcpRegistration: () => api().agentSdk.getExternalMcpRegistration(),
    refreshExternalMcpRegistration: () => api().agentSdk.refreshExternalMcpRegistration(),
    probeMatrix: () => api().agentSdk.probeMatrix(),
    cancelQuery: (queryId) => api().agentSdk.cancelQuery(queryId),
    authenticate: (transport, options) => api().agentSdk.authenticate(transport, options),
    query: (transport, prompt, options) => api().agentSdk.query(transport, prompt, options),
  },
  agentCapabilities: forwardGroup(agentCapabilitiesContract, () => api().agentCapabilities),
  agentAttachments: forwardGroup(agentAttachmentsContract, () => api().agentAttachments),
  agentSession: {
    onEvent: (callback) =>
      testAgentSessionBridge()?.onEvent?.(callback) ?? api().agentSession.onEvent(callback),
    start: (request) =>
      testAgentSessionBridge()?.start?.(request) ?? api().agentSession.start(request),
    cancel: (sessionId) =>
      testAgentSessionBridge()?.cancel?.(sessionId) ?? api().agentSession.cancel(sessionId),
    get: (sessionId) =>
      testAgentSessionBridge()?.get?.(sessionId) ?? api().agentSession.get(sessionId),
    listSchedules: () =>
      testAgentSessionBridge()?.listSchedules?.() ?? api().agentSession.listSchedules(),
    cancelSchedule: (scheduleId) =>
      testAgentSessionBridge()?.cancelSchedule?.(scheduleId) ??
      api().agentSession.cancelSchedule(scheduleId),
    listAlwaysAllowRules: () => api().agentSession.listAlwaysAllowRules(),
    setAlwaysAllowRuleEnabled: (key, enabled) =>
      api().agentSession.setAlwaysAllowRuleEnabled(key, enabled),
    removeAlwaysAllowRule: (key) => api().agentSession.removeAlwaysAllowRule(key),
    permissionCatalog: () => api().agentSession.permissionCatalog(),
  },
  conversationLedger: forwardGroup(conversationLedgerContract, () => api().conversationLedger),
  config: {
    ...forwardGroup(configContract, () => api().config),
  },
  feedback: {
    ...forwardGroup(agentFeedbackContract, () => api().feedback),
    send: (payload) => api().feedback.send(payload),
    cancel: (id) => api().feedback.cancel(id),
  },
  internalFixtures: forwardGroup(internalFixturesContract, () => api().internalFixtures),
  analytics: {
    getRuntimeConfig: () => api().analytics.getRuntimeConfig(),
    getOptIn: () => api().analytics.getOptIn(),
    persistConsent: (enabled) => api().analytics.persistConsent(enabled),
    syncContext: (context) => api().analytics.syncContext(context),
    enqueueWorkflowEvent: (request) =>
      api().analytics.enqueueWorkflowEvent?.(request) ?? Promise.resolve(false),
    writeTableNotebookReceipt: (request) =>
      api().analytics.writeTableNotebookReceipt?.(request) ?? Promise.resolve(false),
    setConsent: (enabled) => api().analytics.setConsent(enabled),
  },
  convertFileSrc: (filePath) => api().convertFileSrc(filePath),
};
