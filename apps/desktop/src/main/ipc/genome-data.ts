import { join } from 'node:path';
import { resealPartitionedTranscriptSceneBinaryDatasetContractV4 } from '@waypoint/genome-renderer/pure';
import { expandedAnnotationSceneAuthorizedInputPaths } from './assembly-expanded-annotation-scene-compiler';
import {
  assemblyAnnotationAppearanceArtifactDirectoryV1,
  prepareAssemblyAnnotationAppearanceV1,
} from './assembly-annotation-appearance-command';
import {
  MAX_SEQUENCE_WINDOW_BASES,
  sequenceWindowRequestIssue,
} from '../../shared/genome-sequence-window';
import {
  createAnnotationViewportTile,
  createFeatureTrackTile,
  estimateFeatureBytes,
  validateAnnotationViewportTileRequest,
} from '../../shared/genome-annotation-tiles';
import { compiledBroadRasterCellToWireV1 } from '../../shared/compiled-broad-raster-wire';
import { mainIpc, sendRendererIpc } from '../../shared/ipc-contract';
import { app, type WebContents } from 'electron';
import { readFile, realpath, stat } from 'fs/promises';
import type {
  GenomeDataSource,
  GenomeFeature,
  IndexedGenomeManifest,
  SearchHit as GenomeSearchHit,
} from '@waypoint/genome-data';
import { isInvalidGenomeSequenceError } from '@waypoint/genome-data';
import type {
  AssemblyAnnotationSceneColorRolesWireV1,
  GenomeAnnotationTileRequest,
  GenomeCancelRequestResult,
  GenomeDebugSnapshot,
  GenomeDebugRequestKind,
  GenomeDebugRequestTrace,
  GenomeFeatureDetails,
  GenomeFeatureDetailsRequest,
  GenomeOpenSource,
  GenomeSequenceWindow,
  GenomeSequenceWindowRequest,
  GenomeSessionUpdate,
  GenomeSessionShell,
  GenomeSessionReleaseResult,
  GenomeTileRequest,
  GenomeTrackDescriptor,
  GenomeTrackTile,
  AssemblyAnnotationRasterReadRequestV2,
  AssemblyCompiledBroadRasterArtifactRequestV1,
  AssemblyCompiledBroadRasterCatalogCapabilityV1,
  AssemblyCompiledBroadRasterCellsRequestV1,
  AssemblyCompiledBroadRasterCellsResultV1,
  AssemblyCompiledBroadRasterManifestRequestV1,
  AssemblyAnnotationAppearancePrepareRequestV1,
  AssemblyCompiledBroadInteractionWireHitResultV1,
  AssemblyAnnotationSceneDetailReadRequestV1,
  AssemblyAnnotationSceneDetailWireReadResultV1,
  AssemblyAnnotationSceneReadRequest,
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
  AssemblyAnnotationProductSetInventoryReadRequestV1,
  AssemblyAnnotationProductSetInventoryReadResultV1,
} from '../../shared/indexed-genome';
import {
  ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
  ASSEMBLY_COMPILED_BROAD_INTERACTION_IPC_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_MAX_CELLS_PER_IPC_RESPONSE_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
  GENOME_ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET,
  GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP,
  INDEXED_GENOME_INVALID_SEQUENCE_ERROR_CODE,
  INDEXED_GENOME_SOURCE_UNAVAILABLE_ERROR_CODE,
  isAssemblyCompiledBroadRasterSingleCellBatchV1,
  sameAssemblyReferenceAssetGenerationV1,
} from '../../shared/indexed-genome';
import {
  createDebugSnapshot,
  createGenomeSessionShell,
  createPlaceholderTrackTile,
  markGenomeSessionShellError,
  markGenomeSessionTrackError,
  updateGenomeSessionShellFromTabState,
  type GenomeSessionDebugDiagnostics,
} from './genome-session';
import {
  UnknownGenomeTrackError,
  emptyAnnotationTileForSequenceOnlySession,
  resolveGenomeTrackRoute,
  type GenomeTrackRoute,
} from './genome-track-routing';
import {
  createPendingIndexedGenomeTabState,
  prepareIndexedGenomeSession,
} from './indexed-genome-session-prep';
import {
  GenomeSessionAdmission,
  createGenomeSessionRequestId,
  beginGenomeSessionRequest,
  bindGenomeSessionRequestToPhysicalLifecycle,
  cancelGenomeSessionRequest,
  closeGenomeSessionOwner,
  closeGenomeSessionsForRenderer,
  genomeSessionOwnedByRenderer,
  replaceGenomeSessionIfOwned,
} from './genome-session-lifecycle';
import { withoutSessionReadinessDemotion } from '../../shared/genome-session-readiness';
import { GenomeRendererLifecycle } from './genome-renderer-lifecycle';
import { GenomeSourceLifecycle } from './genome-source-lifecycle';
import {
  getCachedOrStartAnnotationOverviewTileBuild,
  isCacheableAnnotationOverviewRequest,
} from './genome-overview-tile-cache';
import {
  annotationOverviewMayBeBuiltAtRuntime,
  readAnnotationOverviewForSession,
} from './reference-annotation-overview-reader';
import {
  allMissResult,
  readAssemblyOverviewCaches,
  type AssemblyOverviewChromInput,
} from './assembly-overview-cache';
import {
  readAssemblyAnnotationRasterCacheV2,
  readAssemblyOverviewTextureCache,
  readAssemblyAnnotationSceneCacheIndex,
  writeAssemblyOverviewTextureCache,
  readAssemblyAnnotationSceneCacheResource,
  writeAssemblyAnnotationSceneCache,
  writeAssemblyCompiledBroadInteractionCache,
  type AssemblyTextureLayout,
} from './assembly-overview-texture-cache';
import {
  CompiledBroadRasterArtifactError,
  type CompiledBroadRasterArtifactReaderV1,
} from './compiled-broad-raster-artifact';
import {
  AssemblyCompiledBroadRasterCatalogCapabilityRegistryV1,
  openAssemblyCompiledBroadRasterCatalogV1,
} from './assembly-compiled-broad-raster-catalog';
import { type AssemblyCompiledBroadRasterRepairRequestOutcomeV1 } from './assembly-compiled-broad-raster-orchestrator';
import { invalidateResidentAssemblySearchAuthorities } from './assembly-search-authority-invalidation';
import {
  assertGenomeOpenIntent,
  assertStandaloneReferenceSearchWriteAllowed,
  prepareGenomeSessionSearchReadiness,
  type GenomeSessionSearchReadinessDeps,
} from './genome-session-search-readiness';
import { assemblyAnnotationSceneResourceRegistry } from './assembly-annotation-scene-resource';
import { admitAnnotationRoleSidecarPayloadV1 } from './assembly-annotation-role-sidecar';
import type { AssemblyAnnotationRoleSidecarCacheIndexV1 } from './assembly-overview-texture-cache';
import type { PartitionedTranscriptSceneRoleSidecarV1 } from '@waypoint/genome-renderer/pure';
import { readAssemblyAnnotationSceneDetailPacketV1 } from './assembly-annotation-scene-detail-packet';
import { AssemblyCompiledBroadInteractionAuthorityV1 } from './assembly-compiled-broad-interaction-authority';
import { assemblyAnnotationSearchAuthority } from './assembly-annotation-search-authority';
import { readAssemblyAnnotationSearchCacheIndex } from './assembly-annotation-search-cache';
import {
  assemblyAnnotationSearchQueryLifecycle,
  assemblyProteinSearchQueryLifecycle,
  genomeSearchQueryLifecycle,
} from './assembly-annotation-search-query-lifecycle';
import { assemblyProteinSearchAuthority } from './assembly-protein-search-authority';
import { readAssemblyProteinSearchCacheIndex } from './assembly-protein-search-cache';
import { isFullAssemblyAnnotationSceneRequest } from './assembly-expanded-annotation-scene-orchestrator';
import { admitPortablePreparedReferenceSceneInDedicatedWorkerV1 } from '../reference-assets/portable-prepared-reference-scene-admission-worker-client';
import {
  readAssemblyOverviewFeaturesCache,
  writeAssemblyOverviewFeaturesCache,
  type CachedOverviewFeaturesByChrom,
} from './assembly-overview-features-cache';
import {
  assertLegacyGetFeatureDetailsRequestAllowed,
  assertLegacyGetFeaturesRequestAllowed,
  isBoundedAssemblyAnnotationSearchCancelRequest,
  isBoundedAssemblyAnnotationSearchQueryRequest,
  isBoundedAssemblyProteinSearchCancelRequest,
  isBoundedAssemblyProteinSearchQueryRequest,
  isBoundedAssemblySequenceSearchRequest,
  isBoundedGenomeSearchRequestIdentity,
  isBoundedGenomeSequenceSearchRequest,
} from './genome-data-request-guards';
import {
  ASSEMBLY_SEQUENCE_SEARCH_MAX_CONCURRENCY,
  searchAssemblySequence,
} from './assembly-sequence-search';
import {
  GenomeDataWorkerThreadSource,
  getGenomeDataWorkerThreadStats,
  type GenomeDataWorkerPhysicalRequestLifecycle,
  type GenomeDataWorkerRequestOptions,
} from './genome-data-worker-thread-client';
import {
  closeFailedGenomeDataWorkerThreadSources,
  createGenomeDataWorkerThreadSource,
} from './genome-data-worker-thread-factory';
import { assertSafePath } from './path-allowlist';
import { assertIndexedGenomeWorkspaceAuthority } from './indexed-genome-workspace-authority';
import { createAssemblyReferenceAssetAuthoritiesV1 } from '../reference-assets/create-assembly-reference-asset-service';
import { resolveReferenceAssetCacheRoot } from '../reference-assets/reference-asset-cache-root';
import {
  assertReferenceAssetRuntimeWriteAllowed,
  isPreparedReferenceAssetPath,
} from '../reference-assets/reference-asset-runtime-boundary';
import { portablePreparedReferenceViewAuthorityV1 } from '../reference-assets/portable-prepared-reference-view-authority';

interface GenomeSearchOptions {
  start?: number;
  end?: number;
  chunkSize?: number;
  maxResults?: number;
  reverseComplement?: boolean;
  caseSensitive?: boolean;
  validateIupacDna?: boolean;
}

const compiledBroadRasterReaders = new Map<string, Promise<CompiledBroadRasterArtifactReaderV1>>();
const MAX_COMPILED_BROAD_RASTER_READER_CACHE = 8;
const compiledBroadRasterCatalogCapabilities =
  new AssemblyCompiledBroadRasterCatalogCapabilityRegistryV1();

function currentReferenceAssetCacheRoot(): string {
  return resolveReferenceAssetCacheRoot({
    appDataRoot: app.getPath('appData'),
    env: process.env,
  });
}

function assertViewerRuntimeWriteAllowed(candidatePath: string): void {
  assertReferenceAssetRuntimeWriteAllowed({
    referenceAssetCacheRoot: currentReferenceAssetCacheRoot(),
    candidatePath,
  });
}

function isPreparedReferenceRuntimePath(candidatePath: string): boolean {
  return isPreparedReferenceAssetPath({
    referenceAssetCacheRoot: currentReferenceAssetCacheRoot(),
    candidatePath,
  });
}

async function admitSafePath(filePath: string): Promise<void> {
  await assertSafePath(filePath);
}

const {
  service: assemblyReferenceAssets,
  productIndex: assemblyAnnotationProductIndex,
  broadRasterPreparation: compiledBroadRasterPreparation,
  searchReadiness: assemblySearchReadiness,
} = createAssemblyReferenceAssetAuthoritiesV1({
  assertSafePath: admitSafePath,
  sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
  prepareSourceAnnotationAliases: async (hit) => {
    const authority = await assemblyAnnotationGenerationAuthorityV1(hit.request);
    if (authority === 'mismatch') throw new Error('Annotation source generation changed.');
    const verify = async () => {
      if (authority === 'portable')
        await portablePreparedReferenceViewAuthorityV1.assertRetainedAnnotationSources(hit.request);
      const current = await readAdmittedAnnotationSceneIndexV1(hit.request);
      if (
        !current ||
        current.payloadSha256 !== hit.payloadSha256 ||
        current.manifest.integrity.contractSha256 !== hit.sceneManifest.integrity.contractSha256
      )
        throw new Error('Retained annotation scene changed.');
    };
    await verify();
    const authorizedSourceRealPaths = await Promise.all(
      expandedAnnotationSceneAuthorizedInputPaths(hit.request).map(async (inputPath) => {
        await admitSafePath(inputPath);
        return { inputPath, realPath: await realpath(inputPath) };
      })
    );
    const { compileRetainedSourceAnnotationAliasesInDedicatedWorkerV1 } =
      await import('./assembly-expanded-annotation-scene-worker-factory');
    const aliases = await compileRetainedSourceAnnotationAliasesInDedicatedWorkerV1(
      {
        request: hit.request,
        authorizedMiss: {
          status: 'miss',
          ipcContractVersion: hit.request.ipcContractVersion,
          fingerprint: hit.sourceFingerprint,
          sourceBuildFingerprint: hit.sceneManifest.integrity.contractSha256,
        },
        runtimeSourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
        authorizedSourceRealPaths,
      },
      hit.payloadSha256
    );
    await verify();
    return aliases;
  },
  ensureSourceSummaries: async () => {
    throw new Error('Reference-asset refresh is not available through viewer runtime IPC.');
  },
  onSearchPublication: invalidateResidentAssemblySearchAuthorities,
  onFailure: (error, request) => {
    console.error('[assembly-reference-assets] background preparation failed', {
      assemblyId: request.assemblyId,
      themeMode: request.artifact.themeMode,
      trackType: request.artifact.trackType,
      error: `${error.name}: ${error.message}`,
    });
  },
});

function annotationAppearanceCacheRootV1(): string {
  return join(app.getPath('userData'), 'annotation-appearances.v1');
}

async function readAdmittedAnnotationSceneIndexV1(input: AssemblyAnnotationSceneReadRequest) {
  const authority = await assemblyAnnotationGenerationAuthorityV1(input);
  if (authority === 'mismatch') return null;
  const readLocal = async () => {
    const result = await readAssemblyAnnotationSceneCacheIndex(input, {
      assertSafePath: admitSafePath,
      sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
    });
    return result?.status === 'hit' ? result : null;
  };
  return authority === 'portable'
    ? portablePreparedReferenceViewAuthorityV1.readSceneIndex(input)
    : authority === 'local'
      ? readLocal()
      : ((await portablePreparedReferenceViewAuthorityV1.readSceneIndex(input)) ?? readLocal());
}

async function readAnnotationAppearanceSceneIndexV1(input: AssemblyAnnotationSceneReadRequest) {
  const scene = await readAdmittedAnnotationSceneIndexV1(input);
  if (!scene || scene.manifest.sourceAnnotationAliases) return scene;
  const binding = await assemblyAnnotationProductIndex.readSourceAnnotationAliases({
    request: input,
    sourceFingerprint: scene.fingerprint,
    scenePath: scene.scenePath,
    sceneManifest: scene.manifest,
    payloadSha256: scene.payloadSha256,
  });
  if (!binding) return scene;
  const manifest = await resealPartitionedTranscriptSceneBinaryDatasetContractV4(
    { ...scene.manifest, sourceAnnotationAliases: binding.aliases },
    scene.manifest.datasetContract
  );
  return { ...scene, manifest };
}

function genomeSessionSearchReadinessDeps(): GenomeSessionSearchReadinessDeps {
  return {
    ensureImportedReferenceSearchIndexes: async (source, options) => {
      const readiness = await assemblySearchReadiness.ensure(source, options);
      return { annotationFeatureCount: readiness.annotationSearch.featureCount };
    },
    verifyPreparedReferenceSearchIndexes: async (source, options) => {
      options?.signal?.throwIfAborted();
      const [annotation, protein] = await Promise.all([
        portablePreparedReferenceViewAuthorityV1.readAnnotationSearchIndex(source),
        portablePreparedReferenceViewAuthorityV1.readProteinSearchIndex(source),
      ]);
      options?.signal?.throwIfAborted();
      if (annotation?.status === 'hit' && protein?.status === 'hit') {
        return { annotationFeatureCount: annotation.manifest.featureCount };
      }
      const readiness = await assemblySearchReadiness.verifyPrepared(source, options);
      return { annotationFeatureCount: readiness.annotationSearch.featureCount };
    },
    verifyReferenceAssetGeneration: async (source, expected, options) => {
      options?.signal?.throwIfAborted();
      const portable = await portablePreparedReferenceViewAuthorityV1.readProductInventory({
        seedProduct: source,
      });
      options?.signal?.throwIfAborted();
      if (
        portable.status === 'ready' &&
        portable.sourceFingerprint === expected.sourceFingerprint &&
        portable.inventoryFingerprint === expected.inventoryFingerprint &&
        source.artifact.themeMode === expected.themeMode
      ) {
        return;
      }
      const admitted = await assemblyReferenceAssets.status({
        seedProduct: { ...source, expectedAssetGeneration: expected },
      });
      options?.signal?.throwIfAborted();
      if (
        admitted.status !== 'ready' ||
        !sameAssemblyReferenceAssetGenerationV1(admitted.generation, expected)
      ) {
        throw new Error('Prepared reference asset generation changed during capability admission.');
      }
    },
  };
}

const assemblyCompiledBroadInteractionAuthorityV1 = new AssemblyCompiledBroadInteractionAuthorityV1(
  {
    readPortable: (input) =>
      portablePreparedReferenceViewAuthorityV1.readCompiledBroadInteraction(input),
    readLocalSceneIndex: (input) =>
      readAssemblyAnnotationSceneCacheIndex(input, {
        assertSafePath: admitSafePath,
        sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
      }),
    projectLocalScene: admitPortablePreparedReferenceSceneInDedicatedWorkerV1,
    resolveRealPath: realpath,
    persistLocalProjection: (input, projection) =>
      writeAssemblyCompiledBroadInteractionCache(
        input,
        {
          manifest: projection.manifest,
          payload: projection.validatedPayload,
          detailRangeCatalog: projection.rangeCatalog,
        },
        {
          assertSafePath: admitSafePath,
          sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
        }
      ),
  }
);

type AssemblyAnnotationGenerationAuthorityV1 = 'unbound' | 'portable' | 'local' | 'mismatch';

async function assemblyAnnotationGenerationAuthorityV1(
  input: AssemblyAnnotationSceneReadRequest
): Promise<AssemblyAnnotationGenerationAuthorityV1> {
  const expected = input.expectedAssetGeneration;
  if (!expected) return 'unbound';
  const portable = await portablePreparedReferenceViewAuthorityV1.readProductInventory({
    seedProduct: input,
  });
  if (portable.status === 'ready') {
    return sameAssemblyReferenceAssetGenerationV1(
      {
        contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
        sourceFingerprint: portable.sourceFingerprint,
        inventoryFingerprint: portable.inventoryFingerprint,
        themeMode: input.artifact.themeMode,
      },
      expected
    )
      ? 'portable'
      : 'mismatch';
  }
  const admitted = await assemblyReferenceAssets.status({ seedProduct: input });
  return admitted.status === 'ready' &&
    sameAssemblyReferenceAssetGenerationV1(admitted.generation, expected)
    ? 'local'
    : 'mismatch';
}

function isRepairableCompiledBroadRasterFailure(
  error: unknown
): error is CompiledBroadRasterArtifactError {
  return (
    error instanceof CompiledBroadRasterArtifactError &&
    (error.code === 'artifact-not-found' ||
      error.code === 'invalid-manifest' ||
      error.code === 'integrity-mismatch')
  );
}

function compiledBroadRasterCellsUnavailable(
  reason: Extract<AssemblyCompiledBroadRasterCellsResultV1, { status: 'unavailable' }>['reason']
): AssemblyCompiledBroadRasterCellsResultV1 {
  return {
    contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
    status: 'unavailable',
    reason,
  };
}

function compiledBroadRasterCellsRepairState(
  catalogCapability: AssemblyCompiledBroadRasterCatalogCapabilityV1,
  reason: Extract<AssemblyCompiledBroadRasterCellsResultV1, { status: 'repairing' }>['reason'],
  outcome: AssemblyCompiledBroadRasterRepairRequestOutcomeV1
): AssemblyCompiledBroadRasterCellsResultV1 {
  if (outcome.status === 'unavailable') {
    return compiledBroadRasterCellsUnavailable(outcome.reason);
  }
  return {
    contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
    status: 'repairing',
    reason,
    catalogCapability,
    retryAfterMs: outcome.retryAfterMs,
  };
}

type GenomeDataSourceHandle = GenomeDataSource & {
  buildAnnotationOverview(
    input: Parameters<GenomeDataWorkerThreadSource['buildAnnotationOverview']>[0]
  ): ReturnType<GenomeDataWorkerThreadSource['buildAnnotationOverview']>;
  getSequence(
    chrom: string,
    start: number,
    end: number,
    options?: GenomeDataWorkerRequestOptions
  ): Promise<string>;
  getFeatures(
    chrom: string,
    start: number,
    end: number,
    zoomLevel: number,
    options?: GenomeDataWorkerRequestOptions
  ): Promise<GenomeFeature[]>;
  getFeatureDetails(
    request: GenomeFeatureDetailsRequest,
    options?: GenomeDataWorkerRequestOptions
  ): Promise<GenomeFeatureDetails>;
  searchSequenceWithPhysicalLifecycle(
    chrom: string,
    motif: string,
    options?: Parameters<GenomeDataWorkerThreadSource['searchSequenceWithPhysicalLifecycle']>[2]
  ): ReturnType<GenomeDataWorkerThreadSource['searchSequenceWithPhysicalLifecycle']>;
  close(): Promise<void>;
};

const MAX_OPEN_SOURCES = 8;
const sourceLifecycle = new GenomeSourceLifecycle<GenomeDataSourceHandle>(MAX_OPEN_SOURCES);
const assemblySequenceSearchSourceLifecycle = new GenomeSourceLifecycle<GenomeDataSourceHandle>(
  ASSEMBLY_SEQUENCE_SEARCH_MAX_CONCURRENCY
);
const sessions = new Map<string, GenomeSessionShell>();
const sessionDiagnostics = new Map<string, GenomeSessionDebugDiagnostics>();
const sessionOwners = new Map<string, number>();
const activeRequests = new Map<string, AbortController>();
const sessionPreparations = new Map<string, AbortController>();
const genomeSessionAdmission = new GenomeSessionAdmission();
const referenceSessionPaths = new Map<string, readonly string[]>();
export function activeGenomeReferencePaths(): readonly string[] {
  for (const [id, session] of sessions)
    referenceSessionPaths.set(id, [
      session.sourcePath,
      ...(session.manifest
        ? [session.manifest.fastaPath, session.manifest.gffPath].filter(
            (path): path is string => !!path
          )
        : []),
    ]);
  for (const id of referenceSessionPaths.keys()) {
    if (!sessions.has(id) && ![...activeRequests.keys()].some((key) => key.startsWith(`${id}:`)))
      referenceSessionPaths.delete(id);
  }
  return [...referenceSessionPaths.values()].flat();
}
const sessionLifecycleStores = {
  sessions,
  diagnostics: sessionDiagnostics,
  owners: sessionOwners,
  activeRequests,
  preparations: sessionPreparations,
};
const genomeRendererLifecycle = new GenomeRendererLifecycle((ownerId) => {
  activeGenomeReferencePaths();
  closeGenomeSessionsForRenderer(sessionLifecycleStores, ownerId);
  assemblyAnnotationSearchQueryLifecycle.cancelWebContents(ownerId);
  assemblyProteinSearchQueryLifecycle.cancelWebContents(ownerId);
  genomeSearchQueryLifecycle.cancelWebContents(ownerId);
  assemblyAnnotationSceneResourceRegistry.releaseOwner(ownerId);
  compiledBroadRasterCatalogCapabilities.releaseOwner(ownerId);
});
const MAX_RECENT_DEBUG_REQUESTS = 80;
const ASSEMBLY_SEQUENCE_SEARCH_BLOCK_SIZE = 1024 * 1024;
const ASSEMBLY_SEQUENCE_SEARCH_CHUNK_SIZE = 16 * 1024 * 1024;
let nextTraceOrdinal = 1;
let nextAssemblySequenceSearchSourceOrdinal = 1;

function requireOwnedGenomeSession(
  webContents: WebContents,
  sessionId: string
): GenomeSessionShell {
  const session = genomeSessionOwnedByRenderer(sessionLifecycleStores, sessionId, webContents.id);
  if (!session) throw new Error(`[genome] Unknown session: ${sessionId}`);
  return session;
}

function createRequestCancelledError(): Error {
  const err = new Error('Genome data request cancelled.');
  err.name = 'AbortError';
  return err;
}

function isRequestCancelledError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function throwIfRequestCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw createRequestCancelledError();
}
async function assertManifestSafe(manifest: IndexedGenomeManifest): Promise<void> {
  if (typeof manifest.chrom !== 'string' || manifest.chrom.trim().length === 0) {
    throw new Error('[genome] manifest.chrom is required');
  }
  await assertSafePath(manifest.fastaPath, { requireAbsolute: true, errorPrefix: 'genome' });
  await assertSafePath(manifest.faiPath, { requireAbsolute: true, errorPrefix: 'genome' });
  const gziPath =
    manifest.gziPath ??
    (manifest.fastaPath.toLowerCase().endsWith('.gz') ? `${manifest.fastaPath}.gzi` : null);
  if (gziPath) {
    await assertSafePath(gziPath, { requireAbsolute: true, errorPrefix: 'genome' });
  }
  if (manifest.gffPath) {
    await assertSafePath(manifest.gffPath, { requireAbsolute: true, errorPrefix: 'genome' });
  }
  if (manifest.tbiPath) {
    await assertSafePath(manifest.tbiPath, { requireAbsolute: true, errorPrefix: 'genome' });
  }
  await assertIndexedGenomeWorkspaceAuthority(manifest);
}

async function assertManifestFilesPresent(
  manifest: IndexedGenomeManifest,
  paths: Array<keyof Pick<IndexedGenomeManifest, 'fastaPath' | 'faiPath' | 'gffPath' | 'tbiPath'>>
): Promise<void> {
  await assertManifestSafe(manifest);
  for (const key of paths) {
    const path = manifest[key];
    if (!path) {
      throw new Error(`[genome] Indexed genome manifest is missing ${key}.`);
    }
    try {
      await stat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `${INDEXED_GENOME_SOURCE_UNAVAILABLE_ERROR_CODE}: indexed genome file missing (${key}).`
        );
      }
      throw err;
    }
  }
  if (manifest.fastaPath.toLowerCase().endsWith('.gz')) {
    const gziPath = manifest.gziPath ?? `${manifest.fastaPath}.gzi`;
    try {
      await stat(gziPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `${INDEXED_GENOME_SOURCE_UNAVAILABLE_ERROR_CODE}: indexed genome file missing (gziPath).`
        );
      }
      throw err;
    }
  }
}

function keyForManifest(manifest: IndexedGenomeManifest): string {
  return JSON.stringify({
    chrom: manifest.chrom,
    fastaPath: manifest.fastaPath,
    faiPath: manifest.faiPath,
    gziPath: manifest.gziPath ?? null,
    gffPath: manifest.gffPath ?? null,
    tbiPath: manifest.tbiPath ?? null,
    workspaceRootPaths: manifest.workspaceRootPaths ?? null,
  });
}

async function withSource<Result>(
  manifest: IndexedGenomeManifest,
  use: (source: GenomeDataSourceHandle) => Promise<Result>,
  signal?: AbortSignal
): Promise<Result> {
  signal?.throwIfAborted();
  await assertManifestSafe(manifest);
  signal?.throwIfAborted();
  const key = keyForManifest(manifest);
  return sourceLifecycle.withSource(
    key,
    (preparationSignal) =>
      createGenomeDataWorkerThreadSource(manifest, undefined, { signal: preparationSignal }),
    use,
    signal
  );
}

function debugBudgets(): GenomeDebugSnapshot['budgets'] {
  return {
    maxSequenceWindowBases: MAX_SEQUENCE_WINDOW_BASES,
    maxAnnotationViewportTileBases: GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP,
    maxAnnotationViewportTileBytes: GENOME_ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET,
  };
}

function nextTraceId(kind: GenomeDebugRequestKind): string {
  return `${kind}-${Date.now().toString(36)}-${nextTraceOrdinal++}`;
}

function getOrCreateDiagnostics(session: GenomeSessionShell): GenomeSessionDebugDiagnostics {
  const existing = sessionDiagnostics.get(session.sessionId);
  if (existing) {
    existing.budgets ??= debugBudgets();
    existing.recentRequests ??= [];
    existing.pendingRequests ??= 0;
    existing.workerCount = getGenomeDataWorkerThreadStats().activeWorkers;
    return existing;
  }
  const diagnostics: GenomeSessionDebugDiagnostics = {
    openAcceptedAt: session.openedAt,
    pendingRequests: 0,
    workerCount: getGenomeDataWorkerThreadStats().activeWorkers,
    budgets: debugBudgets(),
    recentRequests: [],
  };
  if (!sessions.has(session.sessionId)) return diagnostics;
  sessionDiagnostics.set(session.sessionId, diagnostics);
  return diagnostics;
}

function pushRecentRequest(
  session: GenomeSessionShell,
  trace: GenomeDebugRequestTrace
): GenomeDebugRequestTrace {
  const diagnostics = getOrCreateDiagnostics(session);
  const requests = diagnostics.recentRequests ?? [];
  requests.push(trace);
  diagnostics.recentRequests = requests.slice(-MAX_RECENT_DEBUG_REQUESTS);
  return trace;
}

function replaceRecentRequest(session: GenomeSessionShell, trace: GenomeDebugRequestTrace): void {
  const diagnostics = getOrCreateDiagnostics(session);
  const requests = diagnostics.recentRequests ?? [];
  const existingIndex = requests.findIndex((request) => request.traceId === trace.traceId);
  if (existingIndex >= 0) {
    requests[existingIndex] = trace;
    diagnostics.recentRequests = requests;
  } else {
    pushRecentRequest(session, trace);
  }
}

function beginDebugRequest(
  session: GenomeSessionShell,
  trace: Omit<GenomeDebugRequestTrace, 'traceId' | 'status' | 'startedAt'>
): GenomeDebugRequestTrace {
  const diagnostics = getOrCreateDiagnostics(session);
  diagnostics.pendingRequests = (diagnostics.pendingRequests ?? 0) + 1;
  return pushRecentRequest(session, {
    ...trace,
    traceId: nextTraceId(trace.kind),
    status: 'started',
    startedAt: Date.now(),
  });
}

function finishDebugRequest(
  session: GenomeSessionShell,
  trace: GenomeDebugRequestTrace,
  patch: Partial<GenomeDebugRequestTrace> = {}
): void {
  const diagnostics = getOrCreateDiagnostics(session);
  diagnostics.pendingRequests = Math.max(0, (diagnostics.pendingRequests ?? 0) - 1);
  const completedAt = Date.now();
  replaceRecentRequest(session, {
    ...trace,
    ...patch,
    status: patch.status ?? 'completed',
    completedAt,
    durationMs: Math.max(0, completedAt - trace.startedAt),
  });
}

function markDebugRequestMilestone(
  session: GenomeSessionShell,
  trace: GenomeDebugRequestTrace,
  name: string
): void {
  trace.milestonesMs = {
    ...(trace.milestonesMs ?? {}),
    [name]: Math.max(0, Date.now() - trace.startedAt),
  };
  replaceRecentRequest(session, {
    ...trace,
  });
}

function failDebugRequest(
  session: GenomeSessionShell,
  trace: GenomeDebugRequestTrace,
  err: unknown
): void {
  finishDebugRequest(session, trace, {
    status: 'error',
    error: err instanceof Error ? err.message : String(err),
  });
}

function cancelDebugRequest(session: GenomeSessionShell, trace: GenomeDebugRequestTrace): void {
  finishDebugRequest(session, trace, {
    status: 'cancelled',
    error: 'Genome data request cancelled.',
  });
}

function updateSessionDiagnostics(
  session: GenomeSessionShell,
  patch: Partial<GenomeSessionDebugDiagnostics>
): void {
  const diagnostics = getOrCreateDiagnostics(session);
  Object.assign(diagnostics, patch);
}

function recordSessionUpdateTrace(
  session: GenomeSessionShell,
  phase: GenomeDebugSnapshot['open']['status'],
  error?: string
): void {
  pushRecentRequest(session, {
    traceId: nextTraceId('session_update'),
    requestId: `${session.sessionId}:${phase}`,
    kind: 'session_update',
    status: error ? 'error' : 'completed',
    startedAt: Date.now(),
    completedAt: Date.now(),
    durationMs: 0,
    chrom: session.chrom,
    validationState: session.validationState,
    error,
  });
}

function traceFieldsForTileRequest(
  session: GenomeSessionShell,
  request: GenomeTileRequest,
  requestId: string,
  kind: GenomeDebugRequestKind
): Omit<GenomeDebugRequestTrace, 'traceId' | 'status' | 'startedAt'> {
  return {
    requestId,
    kind,
    trackId: request.trackId,
    chrom: request.chrom,
    start: Number.isFinite(request.start) ? request.start : undefined,
    end: Number.isFinite(request.end) ? request.end : undefined,
    lod: Number.isFinite(request.lod) ? request.lod : undefined,
    generation: Number.isFinite(request.generation) ? request.generation : undefined,
    fidelity: request.fidelity,
    byteBudget: request.byteBudget,
    tileKey: [
      session.sourceFingerprint,
      request.trackId,
      request.chrom,
      `lod:${request.lod}`,
      `${request.start}-${request.end}`,
      request.annotationOwner
        ? `owner:${request.annotationOwner.start}-${request.annotationOwner.end}`
        : 'owner:none',
      request.fidelity,
      `g:${request.generation}`,
    ].join('/'),
  };
}

function traceFieldsForSequenceRequest(
  session: GenomeSessionShell,
  request: GenomeSequenceWindowRequest,
  requestId: string
): Omit<GenomeDebugRequestTrace, 'traceId' | 'status' | 'startedAt'> {
  return {
    requestId,
    kind: 'sequence_window',
    trackId: `${request.chrom}:sequence`,
    chrom: request.chrom,
    start: Number.isFinite(request.start) ? request.start : undefined,
    end: Number.isFinite(request.end) ? request.end : undefined,
    generation: Number.isFinite(request.generation) ? request.generation : undefined,
    fidelity: 'exact',
    byteBudget: MAX_SEQUENCE_WINDOW_BASES,
    tileKey: [
      session.sourceFingerprint,
      `${request.chrom}:sequence`,
      request.chrom,
      `${request.start}-${request.end}`,
      `g:${request.generation}`,
    ].join('/'),
  };
}

function traceFieldsForFeatureDetailsRequest(
  session: GenomeSessionShell,
  request: GenomeFeatureDetailsRequest,
  requestId: string
): Omit<GenomeDebugRequestTrace, 'traceId' | 'status' | 'startedAt'> {
  return {
    requestId,
    kind: 'feature_details',
    trackId: `${request.chrom}:annotations`,
    chrom: request.chrom,
    start: Number.isFinite(request.start) ? request.start : undefined,
    end: Number.isFinite(request.end) ? request.end : undefined,
    fidelity: 'exact',
    tileKey: [
      session.sourceFingerprint,
      `${request.chrom}:annotations`,
      request.chrom,
      `${request.start}-${request.end}`,
      request.featureId ?? 'feature-at-range',
      'details',
    ].join('/'),
  };
}

async function upgradeGenomeSessionCapabilities(input: {
  webContents: WebContents;
  sessionId: string;
  source: GenomeOpenSource;
}): Promise<GenomeSessionShell> {
  const rendererGeneration = genomeRendererLifecycle.register(input.webContents);
  genomeRendererLifecycle.assertCurrent(input.webContents, rendererGeneration);
  const current = sessions.get(input.sessionId);
  if (!current || sessionOwners.get(input.sessionId) !== input.webContents.id) {
    throw new Error(`[genome] Unknown session: ${input.sessionId}`);
  }
  assertGenomeOpenIntent(input.source);
  if (
    !current.openReady ||
    current.preparedReferenceReadOnly !== true ||
    input.source.intent.kind !== 'reference-assembly' ||
    !input.source.manifest
  ) {
    throw new Error('[genome] Session capability upgrade requires an open prepared assembly.');
  }
  const intent = input.source.intent;
  const generation = intent.assetGeneration;
  const searchSource = intent.searchSource;
  const requestsAnnotationUpgrade = intent.annotationProductsReadiness === 'ready';
  const requestsSearchUpgrade = intent.searchReadiness === 'ready';
  if (!requestsAnnotationUpgrade && !requestsSearchUpgrade) return current;
  if (requestsSearchUpgrade && !requestsAnnotationUpgrade) {
    throw new Error('[genome] Search cannot precede annotation capability admission.');
  }
  if (!generation || !searchSource) {
    throw new Error('[genome] Session capability upgrade lacks exact generation authority.');
  }
  if (
    current.assemblyAssetGeneration &&
    !sameAssemblyReferenceAssetGenerationV1(current.assemblyAssetGeneration, generation)
  ) {
    throw new Error('[genome] Session capability upgrade changed the admitted generation.');
  }

  sessionPreparations.get(current.sessionId)?.abort();
  const capabilityController = new AbortController();
  sessionPreparations.set(current.sessionId, capabilityController);
  try {
    const assertUpgradeOwnerCurrent = (): void => {
      capabilityController.signal.throwIfAborted();
      genomeRendererLifecycle.assertCurrent(input.webContents, rendererGeneration);
      if (
        sessions.get(current.sessionId) !== current ||
        sessionOwners.get(current.sessionId) !== input.webContents.id
      ) {
        const error = new Error('[genome] Session closed during capability upgrade.');
        error.name = 'AbortError';
        throw error;
      }
    };
    assertUpgradeOwnerCurrent();
    await assertSafePath(input.source.sourcePath);
    assertUpgradeOwnerCurrent();
    if (input.source.workspaceRoot) await assertSafePath(input.source.workspaceRoot);
    assertUpgradeOwnerCurrent();
    await assertManifestSafe(input.source.manifest);
    assertUpgradeOwnerCurrent();
    const [currentSourcePath, requestedSourcePath] = await Promise.all([
      realpath(current.sourcePath),
      realpath(input.source.sourcePath),
    ]);
    assertUpgradeOwnerCurrent();
    if (
      currentSourcePath !== requestedSourcePath ||
      current.chrom !== (input.source.chrom ?? input.source.manifest.chrom) ||
      !sameIndexedGenomeManifest(current.manifest, input.source.manifest)
    ) {
      throw new Error('[genome] Session capability upgrade changed the opened source identity.');
    }

    assertUpgradeOwnerCurrent();
    const searchReadiness = await prepareGenomeSessionSearchReadiness({
      source: input.source,
      referenceAssetCacheRoot: currentReferenceAssetCacheRoot(),
      deps: genomeSessionSearchReadinessDeps(),
      signal: capabilityController.signal,
    });
    assertUpgradeOwnerCurrent();
    if (requestsSearchUpgrade && searchReadiness.status !== 'ready') {
      throw new Error('[genome] Session search capability is not ready for this generation.');
    }

    const shell: GenomeSessionShell = {
      ...current,
      assemblyAssetGeneration: generation,
      assemblyAnnotationProductsReadiness: 'ready',
      assemblySearchReadiness:
        current.assemblySearchReadiness === 'ready' || searchReadiness.status === 'ready'
          ? 'ready'
          : (current.assemblySearchReadiness ?? 'pending'),
      ...(searchReadiness.status === 'ready'
        ? {
            assemblySearchSource: searchReadiness.source,
            assemblyAnnotationFeatureCount: searchReadiness.annotationFeatureCount,
          }
        : {}),
    };
    if (!replaceGenomeSessionIfOwned(sessions, shell.sessionId, shell)) return shell;
    recordSessionUpdateTrace(shell, 'ready');
    sendGenomeSessionUpdate(input.webContents, {
      sessionId: shell.sessionId,
      shell,
      prepareStatus: 'ready',
      prepareLoadPhase: 'opening',
      reusedExistingIndex: true,
    });
    return shell;
  } finally {
    if (sessionPreparations.get(current.sessionId) === capabilityController) {
      sessionPreparations.delete(current.sessionId);
    }
  }
}

function sameIndexedGenomeManifest(
  left: IndexedGenomeManifest | undefined,
  right: IndexedGenomeManifest
): boolean {
  return Boolean(
    left &&
    left.chrom === right.chrom &&
    left.fastaPath === right.fastaPath &&
    left.faiPath === right.faiPath &&
    (left.gffPath ?? null) === (right.gffPath ?? null) &&
    (left.tbiPath ?? null) === (right.tbiPath ?? null) &&
    (left.length ?? null) === (right.length ?? null) &&
    (left.circular ?? null) === (right.circular ?? null)
  );
}

export function registerGenomeDataHandlers(): void {
  mainIpc.handle('genome:open', async (_event, source: GenomeOpenSource) => {
    const acceptedAt = Date.now();
    const webContents = _event.sender;
    const rendererGeneration = genomeRendererLifecycle.register(webContents);
    genomeRendererLifecycle.assertCurrent(webContents, rendererGeneration);
    assertGenomeOpenIntent(source);
    const releaseSessionAdmission = genomeSessionAdmission.begin(
      sessionLifecycleStores,
      webContents.id
    );
    try {
      await assertSafePath(source.sourcePath);
      genomeRendererLifecycle.assertCurrent(webContents, rendererGeneration);
      if (source.workspaceRoot) await assertSafePath(source.workspaceRoot);
      genomeRendererLifecycle.assertCurrent(webContents, rendererGeneration);
      if (source.manifest) await assertManifestSafe(source.manifest);
      genomeRendererLifecycle.assertCurrent(webContents, rendererGeneration);
      const [resolvedSourcePath, sourceStat] = await Promise.all([
        realpath(source.sourcePath),
        stat(source.sourcePath),
      ]);
      genomeRendererLifecycle.assertCurrent(webContents, rendererGeneration);
      await assertStandaloneReferenceSearchWriteAllowed({
        referenceAssetCacheRoot: currentReferenceAssetCacheRoot(),
        source: { ...source, sourcePath: resolvedSourcePath },
      });
      genomeRendererLifecycle.assertCurrent(webContents, rendererGeneration);
      const shell = createGenomeSessionShell({
        source,
        resolvedSourcePath,
        stat: {
          size: sourceStat.size,
          mtimeMs: sourceStat.mtimeMs,
          ctimeMs: sourceStat.ctimeMs,
          ino: sourceStat.ino,
          dev: sourceStat.dev,
        },
      });
      releaseSessionAdmission();
      sessions.set(shell.sessionId, shell);
      sessionOwners.set(shell.sessionId, webContents.id);
      sessionDiagnostics.set(shell.sessionId, {
        openAcceptedAt: acceptedAt,
        shellReturnedAt: Date.now(),
        pendingRequests: 0,
        workerCount: getGenomeDataWorkerThreadStats().activeWorkers,
        budgets: debugBudgets(),
        recentRequests: [
          {
            traceId: nextTraceId('open'),
            requestId: shell.sessionId,
            kind: 'open',
            status: 'completed',
            startedAt: acceptedAt,
            completedAt: Date.now(),
            durationMs: Math.max(0, Date.now() - acceptedAt),
            chrom: shell.chrom,
            byteCount: 0,
          },
        ],
      });
      const workspaceRoot = source.workspaceRoot;
      if (workspaceRoot) {
        const statForPrep = {
          size: sourceStat.size,
          mtimeMs: sourceStat.mtimeMs,
          ctimeMs: sourceStat.ctimeMs,
          ino: sourceStat.ino,
          dev: sourceStat.dev,
        };
        setTimeout(() => {
          void prepareGenomeSessionInBackground({
            webContents,
            source,
            shell,
            stat: statForPrep,
            workspaceRoot,
          });
        }, 0);
      }
      return shell;
    } finally {
      releaseSessionAdmission();
    }
  });

  mainIpc.handle(
    'genome:upgradeSessionCapabilities',
    async (_event, sessionId: string, source: GenomeOpenSource): Promise<GenomeSessionShell> =>
      upgradeGenomeSessionCapabilities({
        webContents: _event.sender,
        sessionId,
        source,
      })
  );

  mainIpc.handle(
    'genome:getAssemblyOverview',
    async (_event, input: { chromosomes: AssemblyOverviewChromInput[]; workspaceRoot: string }) => {
      if (!Array.isArray(input?.chromosomes)) return { byChrom: {}, hits: 0, misses: 0 };
      try {
        await assertSafePath(input.workspaceRoot);
      } catch {
        return allMissResult(input.chromosomes);
      }
      return readAssemblyOverviewCaches(input, { assertSafePath: admitSafePath });
    }
  );

  mainIpc.handle(
    'genome:readAssemblyOverviewTexture',
    async (
      _event,
      input: {
        assemblyId: string;
        chromosomes: AssemblyOverviewChromInput[];
        workspaceRoot: string;
      }
    ) => {
      try {
        return await readAssemblyOverviewTextureCache(input, {
          assertSafePath: admitSafePath,
          sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
        });
      } catch {
        return null;
      }
    }
  );

  mainIpc.handle(
    'genome:readAssemblyAnnotationRasterV2',
    async (_event, input: AssemblyAnnotationRasterReadRequestV2) => {
      try {
        return await readAssemblyAnnotationRasterCacheV2(input, {
          assertSafePath: admitSafePath,
          sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
        });
      } catch {
        return null;
      }
    }
  );

  mainIpc.handle(
    'genome:prepareAssemblyAnnotationAppearanceV1',
    async (event, input: AssemblyAnnotationAppearancePrepareRequestV1) => {
      const rendererGeneration = genomeRendererLifecycle.register(event.sender);
      const result = await prepareAssemblyAnnotationAppearanceV1(input, {
        cacheRoot: annotationAppearanceCacheRootV1(),
        readSceneIndex: readAdmittedAnnotationSceneIndexV1,
        prepareSourceAliases: (scene) =>
          assemblyAnnotationProductIndex.prepareSourceAnnotationAliases({
            request: input.scene,
            sourceFingerprint: scene.fingerprint,
            scenePath: scene.scenePath,
            sceneManifest: scene.manifest,
            payloadSha256: scene.payloadSha256,
          }),
        assertSafePath: admitSafePath,
        preparation: compiledBroadRasterPreparation,
      });
      genomeRendererLifecycle.assertCurrent(event.sender, rendererGeneration);
      return result;
    }
  );

  mainIpc.handle(
    'genome:readAssemblyCompiledBroadRasterManifestV1',
    async (event, input: AssemblyCompiledBroadRasterManifestRequestV1) => {
      try {
        const rendererGeneration = genomeRendererLifecycle.register(event.sender);
        const generationAuthority = await assemblyAnnotationGenerationAuthorityV1(input.scene);
        if (generationAuthority === 'mismatch') return null;
        const openLocal = () =>
          openAssemblyCompiledBroadRasterCatalogV1(input, {
            assertSafePath: admitSafePath,
            sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
            readerCache: compiledBroadRasterReaders,
            maximumReaderCacheEntries: MAX_COMPILED_BROAD_RASTER_READER_CACHE,
          });
        const opening = input.appearance
          ? await openAssemblyCompiledBroadRasterCatalogV1(input, {
              assertSafePath: admitSafePath,
              sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
              readSceneIndex: async (request) => readAnnotationAppearanceSceneIndexV1(request),
              artifactDirectory: (address) =>
                assemblyAnnotationAppearanceArtifactDirectoryV1({
                  ...address,
                  cacheRoot: annotationAppearanceCacheRootV1(),
                }),
              readerCache: compiledBroadRasterReaders,
              maximumReaderCacheEntries: MAX_COMPILED_BROAD_RASTER_READER_CACHE,
            })
          : generationAuthority === 'portable'
            ? await portablePreparedReferenceViewAuthorityV1.open(input)
            : generationAuthority === 'local'
              ? await openLocal()
              : ((await portablePreparedReferenceViewAuthorityV1.open(input)) ??
                (await openLocal()));
        if (!opening) return null;
        genomeRendererLifecycle.assertCurrent(event.sender, rendererGeneration);
        const issued = compiledBroadRasterCatalogCapabilities.issue(event.sender.id, opening);
        if (!issued) return null;
        return {
          contract: opening.reader.manifest.contract,
          catalogReceipt: issued.catalogReceipt,
          catalogCapability: issued.catalogCapability,
          surfaceManifest: opening.surfaceManifest,
        };
      } catch {
        return null;
      }
    }
  );

  mainIpc.handle(
    'genome:readAssemblyCompiledBroadRasterCellsV1',
    async (event, input: AssemblyCompiledBroadRasterCellsRequestV1) => {
      let admitted: ReturnType<AssemblyCompiledBroadRasterCatalogCapabilityRegistryV1['resolve']> =
        null;
      try {
        if (
          input?.contract !== ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1 ||
          !input.catalogCapability ||
          !isAssemblyCompiledBroadRasterSingleCellBatchV1(input?.addresses)
        ) {
          return compiledBroadRasterCellsUnavailable('invalid-request');
        }
        admitted = compiledBroadRasterCatalogCapabilities.resolve(
          event.sender.id,
          input.catalogCapability
        );
        if (!admitted) return compiledBroadRasterCellsUnavailable('catalog-stale');
        const cells = admitted.opening.readCells
          ? await admitted.opening.readCells(input.addresses)
          : await admitted.opening.reader.readCells(input.addresses);
        if (cells.length !== ASSEMBLY_COMPILED_BROAD_RASTER_MAX_CELLS_PER_IPC_RESPONSE_V1) {
          return compiledBroadRasterCellsUnavailable('artifact-io-failure');
        }
        const wireCells = cells.map(compiledBroadRasterCellToWireV1);
        return {
          contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
          status: 'ready' as const,
          catalogCapability: admitted.catalogCapability,
          cells: wireCells,
        };
      } catch (error) {
        if (admitted && isRepairableCompiledBroadRasterFailure(error)) {
          compiledBroadRasterCatalogCapabilities.invalidate(admitted.catalogCapability);
          compiledBroadRasterReaders.delete(admitted.opening.readerRevisionKey);
          const repairInput: AssemblyCompiledBroadRasterArtifactRequestV1 = {
            ...admitted.opening.request,
            surfaceManifestFingerprint: admitted.opening.surfaceManifest.manifestFingerprint,
          };
          if (
            !repairInput.appearance &&
            isPreparedReferenceRuntimePath(repairInput.scene.workspaceRoot)
          ) {
            return compiledBroadRasterCellsUnavailable('artifact-io-failure');
          }
          return compiledBroadRasterCellsRepairState(
            admitted.catalogCapability,
            error.code === 'artifact-not-found' ? 'artifact-missing' : 'artifact-corrupt',
            compiledBroadRasterPreparation.repairKnownCorruptArtifact(repairInput)
          );
        }
        if (error instanceof CompiledBroadRasterArtifactError && error.code === 'invalid-request') {
          return compiledBroadRasterCellsUnavailable('invalid-request');
        }
        return compiledBroadRasterCellsUnavailable('artifact-io-failure');
      }
    }
  );

  mainIpc.handle(
    'genome:readAssemblyAnnotationProductSetInventoryV1',
    async (
      _event,
      input: AssemblyAnnotationProductSetInventoryReadRequestV1
    ): Promise<AssemblyAnnotationProductSetInventoryReadResultV1> => {
      const seed = input?.seedProduct;
      if (
        !seed ||
        seed.ipcContractVersion !== ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT ||
        !isFullAssemblyAnnotationSceneRequest(seed)
      ) {
        return { status: 'unavailable' };
      }
      try {
        const portable = await portablePreparedReferenceViewAuthorityV1.readProductInventory(input);
        if (portable.status === 'ready') return portable;
        const status = await assemblyReferenceAssets.status({ seedProduct: seed });
        if (status.status === 'ready') {
          return {
            status: 'ready',
            sourceFingerprint: status.generation.sourceFingerprint,
            inventoryFingerprint: status.generation.inventoryFingerprint,
            trackTypes: status.trackTypes,
          };
        }
        return { status: 'unavailable' };
      } catch {
        return { status: 'unavailable' };
      }
    }
  );

  mainIpc.handle(
    'genome:writeAssemblyOverviewTexture',
    async (
      _event,
      input: {
        assemblyId: string;
        chromosomes: AssemblyOverviewChromInput[];
        workspaceRoot: string;
        pngBase64: string;
        layout: AssemblyTextureLayout;
      }
    ) => {
      try {
        assertViewerRuntimeWriteAllowed(input.workspaceRoot);
        return await writeAssemblyOverviewTextureCache(input, {
          assertSafePath: admitSafePath,
          sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
        });
      } catch {
        return null;
      }
    }
  );

  mainIpc.handle(
    'genome:readAssemblyAnnotationScene',
    async (event, input: AssemblyAnnotationSceneReadRequest) => {
      try {
        const rendererGeneration = genomeRendererLifecycle.register(event.sender);
        const generationAuthority = await assemblyAnnotationGenerationAuthorityV1(input);
        if (generationAuthority === 'mismatch') return null;
        await assertSafePath(input.workspaceRoot);
        const readLocal = () =>
          readAssemblyAnnotationSceneCacheResource(input, {
            assertSafePath: admitSafePath,
            sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
          });
        const cached =
          generationAuthority === 'portable'
            ? await portablePreparedReferenceViewAuthorityV1.readScene(input)
            : generationAuthority === 'local'
              ? await readLocal()
              : ((await portablePreparedReferenceViewAuthorityV1.readScene(input)) ??
                (await readLocal()));
        if (!cached || cached.status === 'miss') return cached;
        await assertSafePath(cached.scenePath);
        genomeRendererLifecycle.assertCurrent(event.sender, rendererGeneration);
        const {
          scenePath: _scenePath,
          payloadSha256,
          validatedPayload,
          roleSidecar,
          colorRoles: _inMemoryRoles,
          ...metadata
        } = cached as typeof cached & { roleSidecar?: AssemblyAnnotationRoleSidecarCacheIndexV1 };
        const resource = assemblyAnnotationSceneResourceRegistry.issue({
          validatedPayload,
          byteCount: metadata.byteCount,
          payloadSha256,
          fingerprint: metadata.fingerprint,
          sourceBuildFingerprint: metadata.sourceBuildFingerprint,
          ownerId: event.sender.id,
        });
        const colorRoles = roleSidecar
          ? await issueAnnotationSceneColorRoles(roleSidecar, metadata, event.sender.id)
          : undefined;
        return { ...metadata, resource, ...(colorRoles ? { colorRoles } : {}) };
      } catch (error) {
        console.error('[assembly-annotation-scene] read failed', {
          assemblyId: typeof input?.assemblyId === 'string' ? input.assemblyId : 'invalid-request',
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        return null;
      }
    }
  );

  mainIpc.handle(
    'genome:readAssemblyAnnotationSceneDetailV1',
    async (
      event,
      input: AssemblyAnnotationSceneDetailReadRequestV1
    ): Promise<AssemblyAnnotationSceneDetailWireReadResultV1 | null> => {
      try {
        const rendererGeneration = genomeRendererLifecycle.register(event.sender);
        if (input?.contract !== ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1) return null;
        const generationAuthority = await assemblyAnnotationGenerationAuthorityV1(input.source);
        if (generationAuthority === 'mismatch') return null;
        await assertSafePath(input.source.workspaceRoot);
        const detail = await readAssemblyAnnotationSceneDetailPacketV1(input, {
          readIndex: async (request) => {
            const readLocal = () =>
              readAssemblyAnnotationSceneCacheIndex(request, {
                assertSafePath: admitSafePath,
                sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
              });
            if (generationAuthority === 'portable') {
              return portablePreparedReferenceViewAuthorityV1.readSceneIndex(request);
            }
            if (generationAuthority === 'local') return readLocal();
            return (
              (await portablePreparedReferenceViewAuthorityV1.readSceneIndex(request)) ??
              readLocal()
            );
          },
          authorizePath: admitSafePath,
          readRoleSidecar: readAdmittedAnnotationRoleSidecar,
        });
        if (!detail) return null;
        if (detail.status === 'unavailable') {
          return Object.freeze({
            contract: ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
            ...detail,
          });
        }
        genomeRendererLifecycle.assertCurrent(event.sender, rendererGeneration);
        const resource = assemblyAnnotationSceneResourceRegistry.issue({
          validatedPayload: detail.packet.payload,
          byteCount: detail.packet.payload.byteLength,
          payloadSha256: detail.packet.manifest.integrity.payloadSha256,
          fingerprint: detail.fingerprint,
          sourceBuildFingerprint: detail.sourceBuildFingerprint,
          ownerId: event.sender.id,
        });
        return Object.freeze({
          contract: ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
          status: 'hit',
          fingerprint: detail.fingerprint,
          sourceBuildFingerprint: detail.sourceBuildFingerprint,
          scope: detail.scope,
          artifact: detail.artifact,
          byteCount: detail.packet.payload.byteLength,
          manifest: detail.packet.manifest,
          resource,
          ...(detail.colorRoles ? { colorRoles: detail.colorRoles } : {}),
        });
      } catch (error) {
        console.error('[assembly-annotation-scene-detail] read failed', {
          assemblyId:
            typeof input?.source?.assemblyId === 'string'
              ? input.source.assemblyId
              : 'invalid-request',
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        return null;
      }
    }
  );

  mainIpc.handle(
    'genome:readAssemblyCompiledBroadInteractionV1',
    async (
      event,
      input: AssemblyAnnotationSceneReadRequest
    ): Promise<AssemblyCompiledBroadInteractionWireHitResultV1 | null> => {
      try {
        const rendererGeneration = genomeRendererLifecycle.register(event.sender);
        const generationAuthority = await assemblyAnnotationGenerationAuthorityV1(input);
        if (generationAuthority === 'mismatch') return null;
        await assertSafePath(input.workspaceRoot);
        const compact = await assemblyCompiledBroadInteractionAuthorityV1.read(
          input,
          generationAuthority === 'portable'
            ? 'portable-only'
            : generationAuthority === 'local'
              ? 'local-only'
              : 'portable-then-local'
        );
        if (!compact) return null;
        genomeRendererLifecycle.assertCurrent(event.sender, rendererGeneration);
        const {
          validatedPayload,
          payloadSha256,
          ipcContractVersion: _sceneIpcContract,
          ...metadata
        } = compact;
        const resource = assemblyAnnotationSceneResourceRegistry.issue({
          validatedPayload,
          byteCount: metadata.byteCount,
          payloadSha256,
          fingerprint: metadata.fingerprint,
          sourceBuildFingerprint: metadata.sourceBuildFingerprint,
          ownerId: event.sender.id,
        });
        return Object.freeze({
          ...metadata,
          contract: ASSEMBLY_COMPILED_BROAD_INTERACTION_IPC_V1,
          resource,
        });
      } catch (error) {
        console.error('[assembly-compiled-broad-interaction] read failed', {
          assemblyId: typeof input?.assemblyId === 'string' ? input.assemblyId : 'invalid-request',
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        return null;
      }
    }
  );

  mainIpc.handle(
    'genome:queryAssemblyAnnotationSearch',
    async (
      event,
      input: AssemblyAnnotationSearchQueryRequestV1
    ): Promise<AssemblyAnnotationSearchQueryResultV1 | null> => {
      try {
        if (!isBoundedAssemblyAnnotationSearchQueryRequest(input)) return null;
        genomeRendererLifecycle.register(event.sender);
        const lease = assemblyAnnotationSearchQueryLifecycle.begin(
          event.sender.id,
          input.clientId,
          input.requestId
        );
        try {
          await assertSafePath(input.source.workspaceRoot);
          return await assemblyAnnotationSearchAuthority.query(
            input.source,
            input.query,
            input.limit,
            lease.signal,
            {
              assertSafePath: admitSafePath,
              readCacheIndex: async (source, deps) =>
                (await portablePreparedReferenceViewAuthorityV1.readAnnotationSearchIndex(
                  source
                )) ?? readAssemblyAnnotationSearchCacheIndex(source, deps),
            }
          );
        } finally {
          lease.complete();
        }
      } catch {
        return null;
      }
    }
  );

  mainIpc.handle(
    'genome:cancelAssemblyAnnotationSearch',
    (event, input: AssemblyAnnotationSearchCancelRequestV1): boolean => {
      if (!isBoundedAssemblyAnnotationSearchCancelRequest(input)) return false;
      return assemblyAnnotationSearchQueryLifecycle.cancel(
        event.sender.id,
        input.clientId,
        input.requestId
      );
    }
  );

  mainIpc.handle(
    'genome:queryAssemblyProteinSearch',
    async (
      event,
      input: AssemblyProteinSearchQueryRequestV1
    ): Promise<AssemblyProteinSearchQueryResultV1 | null> => {
      try {
        if (!isBoundedAssemblyProteinSearchQueryRequest(input)) return null;
        genomeRendererLifecycle.register(event.sender);
        const lease = assemblyProteinSearchQueryLifecycle.begin(
          event.sender.id,
          input.clientId,
          input.requestId
        );
        try {
          await assertSafePath(input.source.workspaceRoot);
          return await assemblyProteinSearchAuthority.query(
            input.source,
            input.query,
            input.limit,
            lease.signal,
            {
              assertSafePath: admitSafePath,
              readCacheIndex: async (source, deps) =>
                (await portablePreparedReferenceViewAuthorityV1.readProteinSearchIndex(source)) ??
                readAssemblyProteinSearchCacheIndex(source, deps),
            }
          );
        } finally {
          lease.complete();
        }
      } catch {
        return null;
      }
    }
  );

  mainIpc.handle(
    'genome:cancelAssemblyProteinSearch',
    (event, input: AssemblyProteinSearchCancelRequestV1): boolean => {
      if (!isBoundedAssemblyProteinSearchCancelRequest(input)) return false;
      return assemblyProteinSearchQueryLifecycle.cancel(
        event.sender.id,
        input.clientId,
        input.requestId
      );
    }
  );

  mainIpc.handle(
    'genome:writeAssemblyAnnotationScene',
    async (_event, input: AssemblyAnnotationSceneWriteRequest) => {
      try {
        assertViewerRuntimeWriteAllowed(input.workspaceRoot);
        return await writeAssemblyAnnotationSceneCache(input, {
          assertSafePath: admitSafePath,
          sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
        });
      } catch {
        return null;
      }
    }
  );

  mainIpc.handle(
    'genome:readAssemblyOverviewFeatures',
    async (
      _event,
      input: {
        assemblyId: string;
        chromosomes: AssemblyOverviewChromInput[];
        workspaceRoot: string;
        mode: string;
      }
    ) => {
      try {
        return await readAssemblyOverviewFeaturesCache(input, { assertSafePath: admitSafePath });
      } catch {
        return null;
      }
    }
  );

  mainIpc.handle(
    'genome:writeAssemblyOverviewFeatures',
    async (
      _event,
      input: {
        assemblyId: string;
        chromosomes: AssemblyOverviewChromInput[];
        workspaceRoot: string;
        mode: string;
        byChrom: CachedOverviewFeaturesByChrom;
      }
    ) => {
      try {
        assertViewerRuntimeWriteAllowed(input.workspaceRoot);
        return await writeAssemblyOverviewFeaturesCache(input, { assertSafePath: admitSafePath });
      } catch {
        return null;
      }
    }
  );

  mainIpc.handle(
    'genome:getTrackTile',
    async (
      _event,
      sessionId: string,
      request: GenomeTileRequest,
      requestId = createGenomeSessionRequestId('tile')
    ): Promise<GenomeTrackTile> =>
      getGenomeTrackTile(
        requireOwnedGenomeSession(_event.sender, sessionId),
        request,
        requestId,
        _event.sender
      )
  );

  mainIpc.handle(
    'genome:getAnnotationTile',
    async (
      _event,
      sessionId: string,
      request: GenomeAnnotationTileRequest,
      requestId = createGenomeSessionRequestId('annotation-tile')
    ): Promise<GenomeTrackTile> => {
      const session = requireOwnedGenomeSession(_event.sender, sessionId);
      if (!request.trackId.endsWith(':annotations')) {
        throw new Error(
          `[genome] getAnnotationTile requires an annotation track: ${request.trackId}`
        );
      }
      return (
        emptyAnnotationTileForSequenceOnlySession({ session, request, requestId }) ??
        getGenomeTrackTile(session, request, requestId, _event.sender)
      );
    }
  );

  mainIpc.handle(
    'genome:getDebugSnapshot',
    async (_event, sessionId: string): Promise<GenomeDebugSnapshot> => {
      const session = requireOwnedGenomeSession(_event.sender, sessionId);
      return createDebugSnapshot(session, getOrCreateDiagnostics(session), {
        homeDir: app.getPath('home'),
      });
    }
  );

  mainIpc.handle(
    'genome:getSession',
    async (_event, sessionId: string): Promise<GenomeSessionShell> => {
      const session = requireOwnedGenomeSession(_event.sender, sessionId);
      updateSessionDiagnostics(session, {
        workerCount: getGenomeDataWorkerThreadStats().activeWorkers,
      });
      return session;
    }
  );

  mainIpc.handle(
    'genome:cancelRequest',
    async (_event, sessionId: string, requestId: string): Promise<GenomeCancelRequestResult> => {
      requireOwnedGenomeSession(_event.sender, sessionId);
      if (typeof requestId !== 'string' || requestId.trim().length === 0) {
        throw new Error('[genome] cancelRequest requires a request id.');
      }
      return {
        sessionId,
        requestId,
        cancelled: cancelGenomeSessionRequest(sessionLifecycleStores, sessionId, requestId),
      };
    }
  );

  mainIpc.handle(
    'genome:getFeatureDetails',
    async (
      _event,
      sessionId: string,
      request: GenomeFeatureDetailsRequest,
      requestId = createGenomeSessionRequestId('feature-details')
    ): Promise<GenomeFeatureDetails> =>
      getGenomeFeatureDetails(
        requireOwnedGenomeSession(_event.sender, sessionId),
        request,
        requestId,
        _event.sender
      )
  );

  mainIpc.handle(
    'genome:getFeatureDetailsByManifest',
    async (
      _event,
      manifest: IndexedGenomeManifest,
      request: GenomeFeatureDetailsRequest
    ): Promise<GenomeFeatureDetails> => {
      assertLegacyGetFeatureDetailsRequestAllowed({ manifest, request });
      await assertManifestFilesPresent(manifest, ['fastaPath', 'faiPath', 'gffPath', 'tbiPath']);
      return withSource(manifest, (source) => source.getFeatureDetails(request));
    }
  );

  mainIpc.handle(
    'genome:getSequenceWindow',
    async (
      _event,
      sessionId: string,
      request: GenomeSequenceWindowRequest,
      requestId = createGenomeSessionRequestId('sequence-window')
    ): Promise<GenomeSequenceWindow> =>
      getGenomeSequenceWindow(
        requireOwnedGenomeSession(_event.sender, sessionId),
        request,
        requestId,
        _event.sender
      )
  );

  mainIpc.handle('genome:init', async (_event, manifest: IndexedGenomeManifest) => {
    return withSource(manifest, async (source) => ({
      length: await source.getChromosomeLength(manifest.chrom),
    }));
  });

  mainIpc.handle(
    'genome:getSequence',
    async (
      _event,
      manifest: IndexedGenomeManifest,
      chrom: string,
      start: number,
      end: number
    ): Promise<string> => {
      return withSource(manifest, (source) => source.getSequence(chrom, start, end));
    }
  );

  mainIpc.handle(
    'genome:getFeatures',
    async (
      _event,
      manifest: IndexedGenomeManifest,
      chrom: string,
      start: number,
      end: number,
      zoomLevel: number
    ): Promise<GenomeFeature[]> => {
      assertLegacyGetFeaturesRequestAllowed({ manifest, chrom, start, end, zoomLevel });
      return withSource(manifest, (source) => source.getFeatures(chrom, start, end, zoomLevel));
    }
  );

  mainIpc.handle(
    'genome:searchSequence',
    async (
      event,
      manifest: IndexedGenomeManifest,
      chrom: string,
      motif: string,
      opts: GenomeSearchOptions = {},
      control: GenomeSearchRequestIdentityV1
    ): Promise<GenomeSearchHit[]> => {
      if (!isBoundedGenomeSequenceSearchRequest({ manifest, chrom, motif, opts, control })) {
        throw new Error('[genome] Invalid or unbounded sequence search request.');
      }
      genomeRendererLifecycle.register(event.sender);
      const lease = genomeSearchQueryLifecycle.begin(
        event.sender.id,
        control.clientId,
        control.requestId
      );
      try {
        lease.signal.throwIfAborted();
        const hits = await withSource(
          manifest,
          async (source) => {
            lease.signal.throwIfAborted();
            const matches: GenomeSearchHit[] = [];
            for await (const hit of source.searchSequenceWithPhysicalLifecycle(chrom, motif, {
              ...opts,
              signal: lease.signal,
              physicalLifecycle: lease.physicalLifecycle,
            })) {
              lease.signal.throwIfAborted();
              matches.push(hit);
            }
            return matches;
          },
          lease.signal
        );
        lease.signal.throwIfAborted();
        return hits;
      } catch (error) {
        if (isInvalidGenomeSequenceError(error)) {
          throw new Error(
            `${INDEXED_GENOME_INVALID_SEQUENCE_ERROR_CODE}: indexed FASTA sequence validation failed.`
          );
        }
        throw error;
      } finally {
        lease.complete();
      }
    }
  );

  mainIpc.handle(
    'genome:searchAssemblySequence',
    async (
      event,
      request: AssemblySequenceSearchRequestV1
    ): Promise<AssemblySequenceSearchResultV1> => {
      if (!isBoundedAssemblySequenceSearchRequest(request)) {
        throw new Error('[genome] Invalid or unbounded assembly sequence search request.');
      }
      genomeRendererLifecycle.register(event.sender);
      const lease = genomeSearchQueryLifecycle.begin(
        event.sender.id,
        request.clientId,
        request.requestId
      );
      try {
        lease.signal.throwIfAborted();
        return await searchAssemblySequence(request, {
          signal: lease.signal,
          withSource: async (chromosome, use) => {
            await assertManifestSafe(chromosome.manifest);
            const sourceKey = `assembly-sequence-search:${nextAssemblySequenceSearchSourceOrdinal}`;
            nextAssemblySequenceSearchSourceOrdinal += 1;
            return assemblySequenceSearchSourceLifecycle.withEphemeralSource(
              sourceKey,
              (signal) =>
                createGenomeDataWorkerThreadSource(
                  chromosome.manifest,
                  {
                    sequenceBlockSize: ASSEMBLY_SEQUENCE_SEARCH_BLOCK_SIZE,
                    searchChunkSize: ASSEMBLY_SEQUENCE_SEARCH_CHUNK_SIZE,
                    sequenceCacheEntries: 2,
                    checkFileMtimeOnRead: false,
                  },
                  { signal }
                ),
              use,
              lease.signal
            );
          },
        });
      } finally {
        lease.complete();
      }
    }
  );

  mainIpc.handle(
    'genome:cancelSequenceSearch',
    (event, request: GenomeSearchRequestIdentityV1): boolean => {
      if (!isBoundedGenomeSearchRequestIdentity(request)) return false;
      return genomeSearchQueryLifecycle.cancel(
        event.sender.id,
        request.clientId,
        request.requestId
      );
    }
  );

  mainIpc.handle('genome:closeSession', (_event, sessionId: string): GenomeSessionReleaseResult => {
    if (typeof sessionId !== 'string' || !/^genome-[a-z0-9]+-[1-9][0-9]*$/.test(sessionId)) {
      return {
        released: false,
        activeSessionCount: sessions.size,
        cancelledRequestCount: 0,
      };
    }
    if (sessionOwners.get(sessionId) !== _event.sender.id) {
      return {
        released: false,
        activeSessionCount: sessions.size,
        cancelledRequestCount: 0,
      };
    }
    activeGenomeReferencePaths();
    const released = closeGenomeSessionOwner(sessionLifecycleStores, sessionId);
    return {
      released: released.sessionRemoved,
      activeSessionCount: released.activeSessionCount,
      cancelledRequestCount: released.requestsCancelled,
    };
  });
}

async function prepareGenomeSessionInBackground(input: {
  webContents: WebContents;
  source: GenomeOpenSource;
  shell: GenomeSessionShell;
  stat: {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    ino?: number;
    dev?: number;
  };
  workspaceRoot: string;
}): Promise<void> {
  let shell = input.shell;
  const initialPhase = input.source.manifest ? 'opening' : 'indexing';
  if (!sessions.has(shell.sessionId)) return;
  sessionPreparations.get(shell.sessionId)?.abort();
  const preparationController = new AbortController();
  sessionPreparations.set(shell.sessionId, preparationController);

  try {
    const prepared = await prepareIndexedGenomeSession({
      source: input.source,
      stat: input.stat,
      workspaceRoot: input.workspaceRoot,
      signal: preparationController.signal,
      loadChromosomeLength: async (manifest, physicalSignal) =>
        withSource(
          manifest,
          (source) => source.getChromosomeLength(manifest.chrom),
          physicalSignal
        ),
      onProgress: ({ tabState, reusedExistingIndex }) => {
        if (preparationController.signal.aborted) return;
        shell = withoutSessionReadinessDemotion(
          sessions.get(shell.sessionId),
          updateGenomeSessionShellFromTabState({ session: shell, tabState })
        );
        if (!replaceGenomeSessionIfOwned(sessions, shell.sessionId, shell)) return;
        if (shell.coordinateReady) {
          const diagnostics = getOrCreateDiagnostics(shell);
          diagnostics.coordinateReadyAt ??= Date.now();
        }
        recordSessionUpdateTrace(
          shell,
          shell.coordinateReady ? 'coordinate_ready' : 'metadata_pending'
        );
        sendGenomeSessionUpdate(input.webContents, {
          sessionId: shell.sessionId,
          shell,
          prepareStatus: 'preparing',
          prepareLoadPhase: 'indexing',
          tabState,
          reusedExistingIndex,
        });
      },
    });
    if (preparationController.signal.aborted || !sessions.has(shell.sessionId)) return;

    let readyPublicationRecorded = false;
    const publishReadySession = (
      searchReadiness:
        | { readonly status: 'not-required' | 'not-applicable' | 'pending' }
        | {
            readonly status: 'ready';
            readonly source: AssemblyAnnotationSceneReadRequest;
            readonly annotationFeatureCount: number;
          }
    ): void => {
      shell = {
        ...updateGenomeSessionShellFromTabState({
          session: shell,
          tabState: prepared.tabState,
        }),
        openReady: true,
        ...(input.source.intent.kind === 'reference-assembly'
          ? {
              assemblyAnnotationProductsReadiness: input.source.intent.annotationProductsReadiness,
              assemblySearchReadiness:
                searchReadiness.status === 'ready'
                  ? ('ready' as const)
                  : searchReadiness.status === 'not-applicable'
                    ? ('not-applicable' as const)
                    : ('pending' as const),
            }
          : {}),
        ...(searchReadiness.status === 'ready'
          ? {
              assemblySearchSource: searchReadiness.source,
              assemblyAnnotationFeatureCount: searchReadiness.annotationFeatureCount,
            }
          : {}),
      };
      shell = withoutSessionReadinessDemotion(sessions.get(shell.sessionId), shell);
      if (!replaceGenomeSessionIfOwned(sessions, shell.sessionId, shell)) return;
      if (!readyPublicationRecorded) {
        updateSessionDiagnostics(shell, {
          coordinateReadyAt: shell.coordinateReady
            ? (getOrCreateDiagnostics(shell).coordinateReadyAt ?? Date.now())
            : undefined,
          readyAt: Date.now(),
        });
        readyPublicationRecorded = true;
      }
      recordSessionUpdateTrace(shell, 'ready');
      sendGenomeSessionUpdate(input.webContents, {
        sessionId: shell.sessionId,
        shell,
        prepareStatus: 'ready',
        prepareLoadPhase: prepared.reusedExistingIndex ? 'opening' : 'indexing',
        tabState: prepared.tabState,
        reusedExistingIndex: prepared.reusedExistingIndex,
      });
    };

    publishReadySession(
      input.source.intent.kind === 'reference-assembly' &&
        input.source.intent.searchReadiness === 'not-applicable'
        ? { status: 'not-applicable' }
        : input.source.intent.kind === 'internal-assembly-segment'
          ? { status: 'not-required' }
          : { status: 'pending' }
    );
    if (preparationController.signal.aborted || !sessions.has(shell.sessionId)) return;
    if (
      input.source.intent.kind !== 'reference-assembly' &&
      annotationOverviewMayBeBuiltAtRuntime(shell)
    ) {
      startBackgroundAnnotationOverviewBuild(shell);
    }
    let searchReadiness;
    try {
      searchReadiness = await prepareGenomeSessionSearchReadiness({
        source: input.source,
        preparedTabState: prepared.tabState,
        referenceAssetCacheRoot: currentReferenceAssetCacheRoot(),
        deps: genomeSessionSearchReadinessDeps(),
        signal: preparationController.signal,
      });
    } catch (error) {
      if (preparationController.signal.aborted || !sessions.has(shell.sessionId)) return;
      sendGenomeSessionUpdate(input.webContents, {
        sessionId: shell.sessionId,
        shell,
        prepareStatus: 'ready',
        prepareLoadPhase: prepared.reusedExistingIndex ? 'opening' : 'indexing',
        tabState: prepared.tabState,
        reusedExistingIndex: prepared.reusedExistingIndex,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (preparationController.signal.aborted || !sessions.has(shell.sessionId)) return;
    publishReadySession(searchReadiness);
  } catch (err) {
    if (preparationController.signal.aborted || !sessions.has(shell.sessionId)) return;
    const message = err instanceof Error ? err.message : 'Failed to prepare indexed genome';
    const tabState = createPendingIndexedGenomeTabState({
      source: input.source,
      stat: input.stat,
      workspaceRoot: input.workspaceRoot,
      error: message,
    });
    shell = markGenomeSessionShellError({
      session: updateGenomeSessionShellFromTabState({ session: shell, tabState }),
      message,
    });
    if (!replaceGenomeSessionIfOwned(sessions, shell.sessionId, shell)) return;
    updateSessionDiagnostics(shell, { errorAt: Date.now() });
    recordSessionUpdateTrace(shell, 'error', message);
    sendGenomeSessionUpdate(input.webContents, {
      sessionId: shell.sessionId,
      shell,
      prepareStatus: 'error',
      prepareLoadPhase: initialPhase,
      tabState,
      reusedExistingIndex: false,
      error: message,
    });
  } finally {
    if (sessionPreparations.get(shell.sessionId) === preparationController) {
      sessionPreparations.delete(shell.sessionId);
    }
  }
}

function sendGenomeSessionUpdate(webContents: WebContents, update: GenomeSessionUpdate): void {
  if (webContents.isDestroyed() || !sessions.has(update.sessionId)) return;
  sendRendererIpc(webContents, 'genome:sessionUpdated', update);
}

function surfaceTrackRequestError(input: {
  webContents?: WebContents;
  session: GenomeSessionShell;
  kind: GenomeTrackDescriptor['kind'];
  message: string;
}): void {
  const shell = markGenomeSessionTrackError({
    session: input.session,
    kind: input.kind,
    message: input.message,
  });
  if (!replaceGenomeSessionIfOwned(sessions, shell.sessionId, shell)) return;
  if (!input.webContents) return;
  sendGenomeSessionUpdate(input.webContents, {
    sessionId: shell.sessionId,
    shell,
    prepareStatus: 'ready',
    prepareLoadPhase: 'opening',
    error: input.message,
  });
}

async function getGenomeTrackTile(
  session: GenomeSessionShell,
  request: GenomeTileRequest,
  requestId: string,
  webContents?: WebContents
): Promise<GenomeTrackTile> {
  const sessionId = session.sessionId;
  let route: GenomeTrackRoute;
  try {
    route = resolveGenomeTrackRoute({ session, request });
  } catch (err) {
    if (err instanceof UnknownGenomeTrackError) {
      const trace = beginDebugRequest(
        session,
        traceFieldsForTileRequest(session, request, requestId, 'track_tile')
      );
      failDebugRequest(session, trace, err);
    }
    throw err;
  }
  const controller = beginGenomeSessionRequest(sessionLifecycleStores, sessionId, requestId);
  const requestBinding = bindGenomeSessionRequestToPhysicalLifecycle(
    sessionLifecycleStores,
    sessionId,
    requestId,
    controller
  );
  const trace = beginDebugRequest(
    session,
    traceFieldsForTileRequest(session, request, requestId, route.traceKind)
  );
  try {
    throwIfRequestCancelled(controller.signal);
    markDebugRequestMilestone(session, trace, 'after-cancel-controller');
    const tile =
      route.kind === 'annotation' && session.manifest
        ? await getAnnotationTrackTile({
            session,
            request,
            requestId,
            signal: controller.signal,
            physicalLifecycle: requestBinding.physicalLifecycle,
            track: route.track,
            onMilestone: (name) => markDebugRequestMilestone(session, trace, name),
          })
        : createPlaceholderTrackTile({ session, request, requestId, track: route.track });
    throwIfRequestCancelled(controller.signal);
    markDebugRequestMilestone(session, trace, 'after-tile-created');
    finishDebugRequest(session, trace, {
      tileState: tile.state,
      fidelity: tile.fidelity,
      validationState: tile.validationState,
      cacheState: tile.cacheState,
      byteCount: tile.byteCount,
      recordCount: tile.recordCount,
      sourceRecordCount: tile.sourceRecordCount,
    });
    return tile;
  } catch (err) {
    if (isRequestCancelledError(err)) {
      cancelDebugRequest(session, trace);
      return createCancelledTrackTile({ session, request, requestId });
    }
    failDebugRequest(session, trace, err);
    surfaceTrackRequestError({
      webContents,
      session,
      kind: route.track.kind,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    requestBinding.finishLogical();
  }
}

async function getGenomeSequenceWindow(
  session: GenomeSessionShell,
  request: GenomeSequenceWindowRequest,
  requestId: string,
  webContents?: WebContents
): Promise<GenomeSequenceWindow> {
  const sessionId = session.sessionId;
  const controller = beginGenomeSessionRequest(sessionLifecycleStores, sessionId, requestId);
  const requestBinding = bindGenomeSessionRequestToPhysicalLifecycle(
    sessionLifecycleStores,
    sessionId,
    requestId,
    controller
  );
  const trace = beginDebugRequest(
    session,
    traceFieldsForSequenceRequest(session, request, requestId)
  );
  try {
    throwIfRequestCancelled(controller.signal);
    const manifest = session.manifest;
    if (!manifest) {
      throw new Error(`[genome] Session has no indexed FASTA manifest: ${sessionId}`);
    }
    if (!request || typeof request.chrom !== 'string' || request.chrom.trim().length === 0) {
      throw new Error('[genome] Sequence window chrom is required.');
    }
    switch (sequenceWindowRequestIssue(request)) {
      case 'start-end-not-finite':
        throw new Error('[genome] Sequence window start/end must be finite.');
      case 'generation-not-finite':
        throw new Error('[genome] Sequence window generation must be finite.');
      case 'invalid-range':
        throw new Error(`[genome] Invalid sequence window range: ${request.start}-${request.end}`);
      case 'too-large':
        throw new Error(
          `[genome] Sequence window exceeds ${MAX_SEQUENCE_WINDOW_BASES} bp: ${request.start}-${request.end}`
        );
    }
    const length = session.length ?? manifest.length;
    if (typeof length === 'number' && Number.isFinite(length) && request.end > length) {
      throw new Error(
        `[genome] Sequence window exceeds chromosome length ${length}: ${request.start}-${request.end}`
      );
    }
    if (request.chrom !== session.chrom && request.chrom !== manifest.chrom) {
      throw new Error(
        `[genome] Sequence window chrom mismatch: request=${request.chrom} session=${session.chrom}`
      );
    }
    await assertManifestFilesPresent(manifest, ['fastaPath', 'faiPath']);
    markDebugRequestMilestone(session, trace, 'after-manifest-files');
    throwIfRequestCancelled(controller.signal);
    const bases = await withSource(
      manifest,
      async (source) => {
        markDebugRequestMilestone(session, trace, 'after-source');
        return source.getSequence(request.chrom, request.start, request.end, {
          signal: controller.signal,
          physicalLifecycle: requestBinding.physicalLifecycle,
        });
      },
      controller.signal
    );
    markDebugRequestMilestone(session, trace, 'after-source-getSequence');
    throwIfRequestCancelled(controller.signal);
    const window = {
      sessionId,
      requestId,
      chrom: request.chrom,
      start: request.start,
      end: request.start + bases.length,
      generation: request.generation,
      validationState: session.validationState,
      byteCount: bases.length,
      bases,
    };
    finishDebugRequest(session, trace, {
      validationState: window.validationState,
      byteCount: window.byteCount,
      recordCount: 1,
    });
    return window;
  } catch (err) {
    if (isRequestCancelledError(err)) {
      cancelDebugRequest(session, trace);
      return createCancelledSequenceWindow({ session, request, requestId });
    }
    failDebugRequest(session, trace, err);
    surfaceTrackRequestError({
      webContents,
      session,
      kind: 'sequence',
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    requestBinding.finishLogical();
  }
}

async function getGenomeFeatureDetails(
  session: GenomeSessionShell,
  request: GenomeFeatureDetailsRequest,
  requestId: string,
  webContents?: WebContents
): Promise<GenomeFeatureDetails> {
  const sessionId = session.sessionId;
  const controller = beginGenomeSessionRequest(sessionLifecycleStores, sessionId, requestId);
  const requestBinding = bindGenomeSessionRequestToPhysicalLifecycle(
    sessionLifecycleStores,
    sessionId,
    requestId,
    controller
  );
  const trace = beginDebugRequest(
    session,
    traceFieldsForFeatureDetailsRequest(session, request, requestId)
  );
  try {
    throwIfRequestCancelled(controller.signal);
    validateFeatureDetailsRequest(session, request);
    const manifest = session.manifest;
    if (!manifest?.gffPath || !manifest.tbiPath) {
      const empty = {
        chrom: request.chrom,
        ...(request.featureId ? { featureId: request.featureId } : {}),
        feature: null,
        relatedFeatures: [],
        sourceRecordCount: 0,
        window: { start: request.start, end: request.end },
        truncated: false,
      };
      finishDebugRequest(session, trace, {
        validationState: session.validationState,
        byteCount: 0,
        recordCount: 0,
        sourceRecordCount: 0,
      });
      return empty;
    }
    await assertManifestFilesPresent(manifest, ['fastaPath', 'faiPath', 'gffPath', 'tbiPath']);
    throwIfRequestCancelled(controller.signal);
    const details = await withSource(
      manifest,
      (source) =>
        source.getFeatureDetails(request, {
          signal: controller.signal,
          physicalLifecycle: requestBinding.physicalLifecycle,
        }),
      controller.signal
    );
    throwIfRequestCancelled(controller.signal);
    finishDebugRequest(session, trace, {
      validationState: session.validationState,
      byteCount: estimateFeatureBytes(details.relatedFeatures),
      recordCount: details.relatedFeatures.length,
      sourceRecordCount: details.sourceRecordCount,
    });
    return details;
  } catch (err) {
    if (isRequestCancelledError(err)) {
      cancelDebugRequest(session, trace);
      return createCancelledFeatureDetails(request);
    }
    failDebugRequest(session, trace, err);
    surfaceTrackRequestError({
      webContents,
      session,
      kind: 'annotation',
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    requestBinding.finishLogical();
  }
}

async function getAnnotationTrackTile(input: {
  session: GenomeSessionShell;
  request: GenomeTileRequest;
  requestId: string;
  signal: AbortSignal;
  physicalLifecycle: GenomeDataWorkerPhysicalRequestLifecycle;
  track: GenomeTrackDescriptor;
  onMilestone?: (name: string) => void;
}): Promise<GenomeTrackTile> {
  const manifest = input.session.manifest;
  if (!manifest) {
    return createPlaceholderTrackTile({
      session: input.session,
      request: input.request,
      requestId: input.requestId,
      track: input.track,
    });
  }

  if (isCacheableAnnotationOverviewRequest(manifest, input.request)) {
    await assertManifestFilesPresent(manifest, ['fastaPath', 'faiPath', 'gffPath', 'tbiPath']);
    input.onMilestone?.('after-manifest-files');
    throwIfRequestCancelled(input.signal);
    const overview = await readAnnotationOverviewForSession({
      session: input.session,
      manifest,
      buildOverviewTile: async () =>
        withSource(manifest, (source) => {
          input.onMilestone?.('after-source');
          return source.buildAnnotationOverview({
            chrom: input.request.chrom,
            start: input.request.start,
            end: input.request.end,
            zoomLevel: input.request.lod,
          });
        }),
    });
    input.onMilestone?.('after-overview-cache-or-build');
    if (overview.status === 'building') {
      input.physicalLifecycle.started();
      void overview.completion.then(
        () => input.physicalLifecycle.settled(),
        () => input.physicalLifecycle.settled()
      );
      throwIfRequestCancelled(input.signal);
      return createBuildingSummaryTile(input);
    }

    throwIfRequestCancelled(input.signal);
    return createFeatureTrackTile({
      session: input.session,
      request: input.request,
      requestId: input.requestId,
      features: overview.result.features,
      featureModel: overview.result.featureModel,
      cacheState: overview.result.cacheState,
      sourceRecordCount: overview.result.sourceRecordCount,
      sourceRepresentationComplete: overview.result.sourceRepresentationComplete,
      layerTypes: overview.result.layerTypes,
    });
  }

  validateAnnotationViewportTileRequest(input.session, input.request);
  await assertManifestFilesPresent(manifest, ['fastaPath', 'faiPath', 'gffPath', 'tbiPath']);
  input.onMilestone?.('after-manifest-files');
  throwIfRequestCancelled(input.signal);
  const features = await withSource(
    manifest,
    (source) => {
      input.onMilestone?.('after-source');
      return source.getFeatures(
        input.request.chrom,
        input.request.start,
        input.request.end,
        input.request.lod,
        { signal: input.signal, physicalLifecycle: input.physicalLifecycle }
      );
    },
    input.signal
  );
  input.onMilestone?.('after-source-getFeatures');
  throwIfRequestCancelled(input.signal);
  return createAnnotationViewportTile({
    session: input.session,
    request: input.request,
    requestId: input.requestId,
    features,
    onMilestone: input.onMilestone,
  });
}

function validateFeatureDetailsRequest(
  session: GenomeSessionShell,
  request: GenomeFeatureDetailsRequest
): void {
  if (!request || typeof request.chrom !== 'string' || request.chrom.trim().length === 0) {
    throw new Error('[genome] Feature details chrom is required.');
  }
  if (!Number.isFinite(request.start) || !Number.isFinite(request.end)) {
    throw new Error('[genome] Feature details start/end must be finite.');
  }
  if (request.start < 0 || request.end < request.start) {
    throw new Error(`[genome] Invalid feature details range: ${request.start}-${request.end}`);
  }
  const maxWindowBp = request.maxWindowBp ?? 500_000;
  if (!Number.isFinite(maxWindowBp) || maxWindowBp <= 0 || maxWindowBp > 2_000_000) {
    throw new Error('[genome] Feature details maxWindowBp must be 1-2000000.');
  }
  const length = session.length ?? session.manifest?.length;
  if (typeof length === 'number' && Number.isFinite(length) && request.end > length) {
    throw new Error(
      `[genome] Feature details range exceeds chromosome length ${length}: ${request.start}-${request.end}`
    );
  }
  if (request.chrom !== session.chrom && request.chrom !== session.manifest?.chrom) {
    throw new Error(
      `[genome] Feature details chrom mismatch: request=${request.chrom} session=${session.chrom}`
    );
  }
}

function startBackgroundAnnotationOverviewBuild(session: GenomeSessionShell): void {
  const manifest = session.manifest;
  const length = session.length ?? manifest?.length;
  if (!manifest || !length) return;

  const request: GenomeTileRequest = {
    trackId: `${manifest.chrom}:annotations`,
    chrom: manifest.chrom,
    start: 0,
    end: length,
    lod: 0,
    generation: 0,
    fidelity: 'summary',
    byteBudget: 1024 * 1024,
  };
  if (!isCacheableAnnotationOverviewRequest(manifest, request)) return;

  const trace = beginDebugRequest(session, {
    ...traceFieldsForTileRequest(
      session,
      request,
      `overview-build-${Date.now().toString(36)}`,
      'overview_build'
    ),
    kind: 'overview_build',
  });
  void getCachedOrStartAnnotationOverviewTileBuild({
    manifest,
    buildOverviewTile: async () =>
      withSource(manifest, (source) =>
        source.buildAnnotationOverview({
          chrom: request.chrom,
          start: request.start,
          end: request.end,
          zoomLevel: request.lod,
        })
      ),
  })
    .then((overview) => {
      const result = overview.status === 'cached' ? overview.result : null;
      finishDebugRequest(session, trace, {
        tileState: result ? 'ready' : 'building_summary',
        fidelity: result ? 'summary' : 'best_available',
        validationState: session.validationState,
        cacheState: result?.cacheState ?? 'miss',
        byteCount: result ? estimateFeatureBytes(result.features) : 0,
        recordCount: result?.features.length ?? 0,
        sourceRecordCount: result?.sourceRecordCount,
      });
    })
    .catch((err) => {
      failDebugRequest(session, trace, err);
      console.warn('[genome] Annotation overview summary build failed', err);
    });
}

function createBuildingSummaryTile(input: {
  session: GenomeSessionShell;
  request: GenomeTileRequest;
  requestId: string;
}): GenomeTrackTile {
  return {
    sessionId: input.session.sessionId,
    requestId: input.requestId,
    trackId: input.request.trackId,
    chrom: input.request.chrom,
    start: input.request.start,
    end: input.request.end,
    generation: input.request.generation,
    state: 'building_summary',
    fidelity: 'best_available',
    validationState: input.session.validationState,
    byteCount: 0,
    recordCount: 0,
    cacheState: 'miss',
    ...(input.request.laneEpoch !== undefined ? { laneEpoch: input.request.laneEpoch } : {}),
    message: 'Annotation summary is building in the background.',
  };
}

function createCancelledTrackTile(input: {
  session: GenomeSessionShell;
  request: GenomeTileRequest;
  requestId: string;
}): GenomeTrackTile {
  return {
    sessionId: input.session.sessionId,
    requestId: input.requestId,
    trackId: input.request.trackId,
    chrom: input.request.chrom,
    start: input.request.start,
    end: input.request.end,
    generation: input.request.generation,
    state: 'stale',
    fidelity: input.request.fidelity,
    validationState: input.session.validationState,
    ...(input.request.laneEpoch !== undefined ? { laneEpoch: input.request.laneEpoch } : {}),
    byteCount: 0,
    recordCount: 0,
    cacheState: 'none',
    message: 'Request was cancelled by a newer viewport.',
  };
}

function createCancelledSequenceWindow(input: {
  session: GenomeSessionShell;
  request: GenomeSequenceWindowRequest;
  requestId: string;
}): GenomeSequenceWindow {
  return {
    sessionId: input.session.sessionId,
    requestId: input.requestId,
    chrom: input.request.chrom,
    start: input.request.start,
    end: input.request.start,
    generation: input.request.generation,
    validationState: input.session.validationState,
    byteCount: 0,
    bases: '',
  };
}

function createCancelledFeatureDetails(request: GenomeFeatureDetailsRequest): GenomeFeatureDetails {
  return {
    chrom: request.chrom,
    ...(request.featureId ? { featureId: request.featureId } : {}),
    feature: null,
    relatedFeatures: [],
    sourceRecordCount: 0,
    window: { start: request.start, end: request.end },
    truncated: false,
  };
}

export async function closeGenomeDataSourcesForTests(): Promise<void> {
  sessions.clear();
  sessionDiagnostics.clear();
  for (const controller of activeRequests.values()) {
    controller.abort();
  }
  activeRequests.clear();
  const lifecycleCleanup = await Promise.allSettled([
    sourceLifecycle.closeAll(),
    assemblySequenceSearchSourceLifecycle.closeAll(),
  ]);
  const factoryCleanup = await Promise.allSettled([closeFailedGenomeDataWorkerThreadSources()]);
  const failures = [...lifecycleCleanup, ...factoryCleanup].flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more genome data sources failed to close.');
  }
}

const admittedAnnotationRoleSidecars = new Map<
  string,
  Promise<PartitionedTranscriptSceneRoleSidecarV1 | null>
>();
const ADMITTED_ANNOTATION_ROLE_SIDECAR_LIMIT = 4;

function readAdmittedAnnotationRoleSidecar(
  index: AssemblyAnnotationRoleSidecarCacheIndexV1
): Promise<PartitionedTranscriptSceneRoleSidecarV1 | null> {
  let pending = admittedAnnotationRoleSidecars.get(index.payloadSha256);
  if (pending) {
    admittedAnnotationRoleSidecars.delete(index.payloadSha256);
  } else {
    pending = (async () => {
      try {
        await admitSafePath(index.payloadPath);
        const bytes = new Uint8Array(await readFile(index.payloadPath));
        return admitAnnotationRoleSidecarPayloadV1(index, bytes);
      } catch {
        return null;
      }
    })();
  }
  admittedAnnotationRoleSidecars.set(index.payloadSha256, pending);
  while (admittedAnnotationRoleSidecars.size > ADMITTED_ANNOTATION_ROLE_SIDECAR_LIMIT) {
    admittedAnnotationRoleSidecars.delete(admittedAnnotationRoleSidecars.keys().next().value!);
  }
  return pending;
}

async function issueAnnotationSceneColorRoles(
  index: AssemblyAnnotationRoleSidecarCacheIndexV1,
  scene: { fingerprint: string; sourceBuildFingerprint: string },
  ownerId: number
): Promise<AssemblyAnnotationSceneColorRolesWireV1 | undefined> {
  try {
    await admitSafePath(index.payloadPath);
    const bytes = new Uint8Array(await readFile(index.payloadPath));
    const admitted = admitAnnotationRoleSidecarPayloadV1(index, bytes);
    if (!admitted) return undefined;
    return {
      roleTable: [...admitted.roleTable],
      expandedCount: index.expandedCount,
      canonicalCount: index.canonicalCount,
      resource: assemblyAnnotationSceneResourceRegistry.issue({
        validatedPayload: bytes,
        byteCount: bytes.byteLength,
        payloadSha256: index.payloadSha256,
        fingerprint: scene.fingerprint,
        sourceBuildFingerprint: scene.sourceBuildFingerprint,
        ownerId,
      }),
    };
  } catch {
    return undefined;
  }
}
