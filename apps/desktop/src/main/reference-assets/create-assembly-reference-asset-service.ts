import type {
  AssemblyAnnotationSceneReadRequest,
  AssemblyAnnotationSearchPrepareResult,
  AssemblyProteinSearchPrepareResult,
} from '../../shared/indexed-genome';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1 } from '../../shared/indexed-genome';
import { deriveAssemblyPrepackedAnnotationSceneDescriptor } from '../../features/sequence/assembly-annotation-product-descriptor';
import {
  readAssemblyAnnotationSearchCacheIndex,
  readAssemblyAnnotationSearchCacheResource,
  migrateLegacyAssemblyAnnotationSearchCacheIndexV1,
} from '../ipc/assembly-annotation-search-cache';
import { prepareAssemblyAnnotationSearchOnMiss } from '../ipc/assembly-annotation-search-orchestrator';
import { AssemblyCompiledBroadRasterPreparationOrchestratorV1 } from '../ipc/assembly-compiled-broad-raster-orchestrator';
import type {
  AssemblyCompiledBroadRasterWorkerJobV1,
  AssemblyCompiledBroadRasterWorkerResultV1,
} from '../ipc/assembly-compiled-broad-raster-worker-job';
import { openAssemblyCompiledBroadRasterCatalogV1 } from '../ipc/assembly-compiled-broad-raster-catalog';
import { AssemblyAnnotationProductIndexCoordinatorV1 } from '../ipc/assembly-annotation-product-index-coordinator';
import {
  readAssemblyAnnotationProductSetManifestV2,
  writeAssemblyAnnotationProductSetManifestV2,
  type AssemblyAnnotationProductSetManifestV2,
} from '../ipc/assembly-annotation-product-set-manifest';
import {
  readAssemblyAnnotationSceneTrackInventory,
  prepareAssemblyAnnotationSceneOnMiss,
  prepareAssemblyAnnotationSceneSetOnMiss,
} from '../ipc/assembly-expanded-annotation-scene-orchestrator';
import type {
  ExpandedAnnotationSceneInventoryWorkerResult,
  ExpandedAnnotationSceneWorkerJob,
  ExpandedAnnotationSceneWorkerResult,
  ExpandedAnnotationSceneWorkerSetJob,
  ExpandedAnnotationSceneWorkerSetResult,
} from '../ipc/assembly-expanded-annotation-scene-compiler';
import {
  readAssemblyAnnotationSceneCacheIndex,
  readAssemblyAnnotationSceneCacheResource,
} from '../ipc/assembly-overview-texture-cache';
import {
  readAssemblyProteinSearchCacheIndex,
  readAssemblyProteinSearchCacheResource,
} from '../ipc/assembly-protein-search-cache';
import type {
  AssemblyProteinSearchWorkerJob,
  AssemblyProteinSearchWorkerResult,
} from '../ipc/assembly-protein-search-build';
import { prepareAssemblyProteinSearchOnMiss } from '../ipc/assembly-protein-search-orchestrator';
import type {
  AssemblyAnnotationSearchWorkerJob,
  AssemblyAnnotationSearchWorkerResult,
} from '../ipc/assembly-annotation-search-compiler';
import {
  AssemblySearchIndexReadinessCoordinatorV1,
  type AssemblySearchArtifactReceiptV1,
} from '../ipc/assembly-search-index-readiness';
import {
  createSearchBuildPairingV1,
  type SearchBuildPairingV1,
} from '../ipc/assembly-search-build-pairing';
import {
  AssemblyReferenceAssetServiceV1,
  type AssemblyReferenceAssetInspectionV1,
} from './assembly-reference-asset-service';
import { referencePreparationTiming } from './reference-prep-timing';
import type { IndexedSourceQuartet } from './portable-source-quartet-verification';

export interface AssemblyReferenceAssetRuntimeV1 {
  readonly prepareSourceAnnotationAliases?: import('../ipc/assembly-annotation-product-index-coordinator').AssemblyAnnotationProductIndexCoordinatorDepsV1['prepareSourceAnnotationAliases'];
  readonly assertSafePath: (path: string) => Promise<void>;
  readonly sourceBuildFingerprint: string;
  readonly verifyPublishedSourceQuartet?: (
    chrom: string,
    paths: IndexedSourceQuartet
  ) => Promise<boolean>;
  readonly ensureSourceSummaries: (request: AssemblyAnnotationSceneReadRequest) => Promise<void>;
  readonly compileScene?: (
    job: ExpandedAnnotationSceneWorkerJob,
    options?: { signal?: AbortSignal }
  ) => Promise<ExpandedAnnotationSceneWorkerResult>;
  readonly compileSceneSet?: (
    job: ExpandedAnnotationSceneWorkerSetJob,
    options?: { signal?: AbortSignal }
  ) => Promise<ExpandedAnnotationSceneWorkerSetResult>;
  readonly readTrackInventory?: (
    job: ExpandedAnnotationSceneWorkerJob,
    options?: { signal?: AbortSignal }
  ) => Promise<ExpandedAnnotationSceneInventoryWorkerResult>;
  readonly compileBroadRaster?: (
    job: AssemblyCompiledBroadRasterWorkerJobV1,
    options?: { signal?: AbortSignal }
  ) => Promise<AssemblyCompiledBroadRasterWorkerResultV1>;
  readonly compileAnnotationSearch?: (
    job: AssemblyAnnotationSearchWorkerJob,
    options?: { signal?: AbortSignal }
  ) => Promise<AssemblyAnnotationSearchWorkerResult>;
  readonly compileProteinSearch?: (
    job: AssemblyProteinSearchWorkerJob,
    options?: { signal?: AbortSignal }
  ) => Promise<AssemblyProteinSearchWorkerResult>;
  readonly onSearchPublication?: (request: AssemblyAnnotationSceneReadRequest) => void;
  readonly searchReadiness?: AssemblySearchIndexReadinessCoordinatorV1;
  readonly trackInventories?: Map<
    string,
    Promise<Awaited<ReturnType<typeof readAssemblyAnnotationSceneTrackInventory>>>
  >;
  readonly onFailure?: (error: Error, request: AssemblyAnnotationSceneReadRequest) => void;
}

export interface AssemblyReferenceAssetAuthoritiesV1 {
  readonly service: AssemblyReferenceAssetServiceV1;
  readonly productIndex: AssemblyAnnotationProductIndexCoordinatorV1;
  readonly broadRasterPreparation: AssemblyCompiledBroadRasterPreparationOrchestratorV1;
  readonly searchReadiness: AssemblySearchIndexReadinessCoordinatorV1;
}

export function createAssemblyReferenceAssetAuthoritiesV1(
  runtime: AssemblyReferenceAssetRuntimeV1
): AssemblyReferenceAssetAuthoritiesV1 {
  const cacheDeps = {
    assertSafePath: runtime.assertSafePath,
    sourceBuildFingerprint: runtime.sourceBuildFingerprint,
  };
  const searchReadiness =
    runtime.searchReadiness ?? createAssemblySearchIndexReadinessCoordinatorV1(runtime);
  const prepareSearchIndexes = async (request: AssemblyAnnotationSceneReadRequest) => {
    const result = await searchReadiness.ensure(request);
    runtime.onSearchPublication?.(request);
    return result;
  };

  const broadRasterPreparation = new AssemblyCompiledBroadRasterPreparationOrchestratorV1({
    assertSafePath: runtime.assertSafePath,
    ...(runtime.compileBroadRaster ? { prepareInWorker: runtime.compileBroadRaster } : {}),
    reportFailure: (error, hit) => runtime.onFailure?.(error, hit.request),
  });

  const productIndex = new AssemblyAnnotationProductIndexCoordinatorV1({
    ...(runtime.prepareSourceAnnotationAliases
      ? { prepareSourceAnnotationAliases: runtime.prepareSourceAnnotationAliases }
      : {}),
    readScene: (request) => readAssemblyAnnotationSceneCacheIndex(request, cacheDeps),
    prepareScene: (request, miss) =>
      prepareAssemblyAnnotationSceneOnMiss(request, miss, {
        assertSafePath: runtime.assertSafePath,
        runtimeSourceBuildFingerprint: runtime.sourceBuildFingerprint,
        ...(runtime.compileScene ? { compileInWorker: runtime.compileScene } : {}),
      }),
    prepareSceneSet: (entries) =>
      prepareAssemblyAnnotationSceneSetOnMiss(entries, {
        assertSafePath: runtime.assertSafePath,
        runtimeSourceBuildFingerprint: runtime.sourceBuildFingerprint,
        ...(runtime.compileSceneSet ? { compileSetInWorker: runtime.compileSceneSet } : {}),
      }),
    prepareBroadCompanion: (hit) => broadRasterPreparation.ensureSceneHit(hit),
    prepareSearchIndexes,
    commitProductSet: (input) =>
      writeAssemblyAnnotationProductSetManifestV2(input, {
        assertSafePath: runtime.assertSafePath,
      }),
    reportFailure: runtime.onFailure,
  });

  const service = new AssemblyReferenceAssetServiceV1({
    inspectSourceInputs: (request) => inspectIndexedSourceQuartets(request, runtime),
    readSceneIndex: (request) => readAssemblyAnnotationSceneCacheIndex(request, cacheDeps),
    readProductSetManifest: (request, sourceFingerprint) =>
      readAssemblyAnnotationProductSetManifestV2(
        { seedRequest: request, sourceFingerprint },
        { assertSafePath: runtime.assertSafePath }
      ),
    inspectProductSet: (request, manifest) =>
      inspectCommittedProductSet(request, manifest, runtime, false),
    verifyProductSet: (request, manifest) =>
      inspectCommittedProductSet(request, manifest, runtime, true),
    ensureSourceSummaries: runtime.ensureSourceSummaries,
    discoverProductRequests: async (request, revision) => {
      const discover = () =>
        readAssemblyAnnotationSceneTrackInventory(request, revision, {
          assertSafePath: runtime.assertSafePath,
          runtimeSourceBuildFingerprint: runtime.sourceBuildFingerprint,
          ...(runtime.readTrackInventory ? { inventoryInWorker: runtime.readTrackInventory } : {}),
        });
      const inventoryKey = JSON.stringify([
        request.workspaceRoot,
        request.assemblyId,
        revision.fingerprint,
        revision.sourceBuildFingerprint,
      ]);
      let pending = runtime.trackInventories?.get(inventoryKey);
      if (!pending) {
        pending = discover();
        runtime.trackInventories?.set(inventoryKey, pending);
        pending.catch(() => runtime.trackInventories?.delete(inventoryKey));
      }
      const inventory = await pending;
      if (inventory.status !== 'ready' || inventory.trackTypes.length === 0) {
        throw new Error(
          'Annotation track inventory is unavailable after source-summary preparation.'
        );
      }
      return Promise.all(
        inventory.trackTypes.map((trackType) => productRequestForTrack(request, trackType))
      );
    },
    prepareProductSet: async (requests) => {
      await productIndex.prepareSet(requests);
    },
  });

  return { service, productIndex, broadRasterPreparation, searchReadiness };
}

export async function inspectIndexedSourceQuartets(
  request: AssemblyAnnotationSceneReadRequest,
  runtime: Pick<AssemblyReferenceAssetRuntimeV1, 'assertSafePath' | 'verifyPublishedSourceQuartet'>
): Promise<AssemblyReferenceAssetInspectionV1> {
  for (let index = 0; index < request.chromosomes.length; index += 1) {
    if (request.scope.placements[index]?.annotationCoverage !== 'sourced') continue;
    const chromosome = request.chromosomes[index];
    const { fastaPath, faiPath, gffPath, tbiPath } = chromosome.manifest ?? {};
    if (!fastaPath?.trim() || !faiPath?.trim() || !gffPath?.trim() || !tbiPath?.trim()) {
      return stale(`${chromosome.chrom} does not declare a complete indexed source quartet.`);
    }
    const paths: IndexedSourceQuartet = [fastaPath, faiPath, gffPath, tbiPath];
    const metadata = [];
    for (const path of paths) {
      try {
        await runtime.assertSafePath(path);
        const entry = await stat(path);
        if (!entry.isFile() || entry.size <= 0) {
          return stale(`${chromosome.chrom} source index is empty: ${path}`);
        }
        metadata.push(entry);
      } catch {
        return stale(`${chromosome.chrom} source index is missing: ${path}`);
      }
    }
    if (metadata[1].mtimeMs < metadata[0].mtimeMs || metadata[3].mtimeMs < metadata[2].mtimeMs) {
      if (!(await runtime.verifyPublishedSourceQuartet?.(chromosome.chrom, paths))) {
        return stale(`${chromosome.chrom} source index predates its source file.`);
      }
    }
    if (!(await isBgzfFile(paths[2]))) {
      return stale(`${chromosome.chrom} annotation source is gzip, not random-access BGZF.`);
    }
  }
  return { status: 'ready' };
}

async function isBgzfFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    return headerContainsBgzfExtraField(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function headerContainsBgzfExtraField(header: Uint8Array): boolean {
  if (
    header.byteLength < 18 ||
    header[0] !== 0x1f ||
    header[1] !== 0x8b ||
    (header[3] & 0x04) === 0
  ) {
    return false;
  }
  const extraLength = header[10] | (header[11] << 8);
  const end = Math.min(header.byteLength, 12 + extraLength);
  for (let offset = 12; offset + 4 <= end; ) {
    const length = header[offset + 2] | (header[offset + 3] << 8);
    if (header[offset] === 0x42 && header[offset + 1] === 0x43 && length === 2) return true;
    offset += 4 + length;
  }
  return false;
}

async function inspectCommittedProductSet(
  seed: AssemblyAnnotationSceneReadRequest,
  manifest: AssemblyAnnotationProductSetManifestV2,
  runtime: AssemblyReferenceAssetRuntimeV1,
  deep: boolean
): Promise<AssemblyReferenceAssetInspectionV1> {
  const products = [...manifest.products].sort((left, right) =>
    left.trackType.localeCompare(right.trackType)
  );
  if (
    products.length === 0 ||
    products.length !== manifest.trackTypes.length ||
    products.some((product, index) => product.trackType !== manifest.trackTypes[index])
  ) {
    return stale('Product-set track inventory does not match its committed products.');
  }

  const timing = deep
    ? referencePreparationTiming(`verify[${seed.artifact.themeMode}]`)
    : () => undefined;
  const inspectProduct = async (
    product: (typeof products)[number]
  ): Promise<AssemblyReferenceAssetInspectionV1 | null> => {
    const request = await productRequestForTrack(seed, product.trackType);
    const scene = deep
      ? await readAssemblyAnnotationSceneCacheResource(request, {
          assertSafePath: runtime.assertSafePath,
          sourceBuildFingerprint: runtime.sourceBuildFingerprint,
        })
      : await readAssemblyAnnotationSceneCacheIndex(request, {
          assertSafePath: runtime.assertSafePath,
          sourceBuildFingerprint: runtime.sourceBuildFingerprint,
        });
    if (
      !scene ||
      scene.status !== 'hit' ||
      scene.fingerprint !== product.sourceFingerprint ||
      scene.fingerprint !== manifest.sourceFingerprint
    ) {
      return stale(`${product.trackType} exact scene is missing or stale.`);
    }
    const opening = await openAssemblyCompiledBroadRasterCatalogV1(
      { contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1, scene: request },
      {
        assertSafePath: runtime.assertSafePath,
        sourceBuildFingerprint: runtime.sourceBuildFingerprint,
      }
    ).catch(() => null);
    if (
      !opening ||
      opening.surfaceManifest.manifestFingerprint !== product.surfaceManifestFingerprint ||
      opening.reader.manifest.catalogFingerprint !== product.catalogFingerprint
    ) {
      return stale(`${product.trackType} broad raster catalog is missing or stale.`);
    }
    if (deep) {
      const cells = opening.reader.manifest.cells;
      for (let offset = 0; offset < cells.length; offset += 64) {
        await opening.reader.readCells(
          cells.slice(offset, offset + 64).map((cell) => ({
            isoformMode: cell.isoformMode,
            level: cell.level,
            tileX: cell.tileX,
            laneSlabIndex: cell.laneSlabIndex,
          }))
        );
      }
    } else {
      const occupiedCells = opening.reader.manifest.cells.filter((cell) => cell.fileName !== null);
      for (let offset = 0; offset < occupiedCells.length; offset += 64) {
        const batch = occupiedCells.slice(offset, offset + 64);
        const ready = await Promise.all(
          batch.map(async (cell) => {
            const payloadPath = join(opening.artifactDirectory, cell.fileName!);
            try {
              await runtime.assertSafePath(payloadPath);
              const metadata = await stat(payloadPath);
              return metadata.isFile() && metadata.size === cell.encodedByteLength;
            } catch {
              return false;
            }
          })
        );
        if (ready.some((present) => !present)) {
          return stale(`${product.trackType} broad raster payload is missing or stale.`);
        }
      }
    }
    return null;
  };
  const concurrency = deep ? 1 : 8;
  const outcomes: (AssemblyReferenceAssetInspectionV1 | null)[] = new Array(products.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, products.length) }, async () => {
      for (let index = next++; index < products.length; index = next++) {
        outcomes[index] = await inspectProduct(products[index]);
      }
    })
  );
  const failed = outcomes.find((outcome) => outcome !== null);
  if (failed) return failed;

  timing('scenes-and-broad-rasters');
  const [annotationSearch, proteinSearch] = deep
    ? await Promise.all([
        readAssemblyAnnotationSearchCacheResource(seed, {
          assertSafePath: runtime.assertSafePath,
        }),
        readAssemblyProteinSearchCacheResource(seed, {
          assertSafePath: runtime.assertSafePath,
        }),
      ])
    : await Promise.all([
        readAssemblyAnnotationSearchCacheIndex(seed, {
          assertSafePath: runtime.assertSafePath,
        }),
        readAssemblyProteinSearchCacheIndex(seed, {
          assertSafePath: runtime.assertSafePath,
        }),
      ]);
  if (
    !searchProbeMatchesReceipt(annotationSearch, manifest.searchIndexes.annotationSearch) ||
    !searchProbeMatchesReceipt(proteinSearch, manifest.searchIndexes.proteinSearch)
  ) {
    return stale('Annotation or protein search index is missing or stale.');
  }
  timing('search-indexes');
  return { status: 'ready' };
}

async function productRequestForTrack(
  seed: AssemblyAnnotationSceneReadRequest,
  trackType: string
): Promise<AssemblyAnnotationSceneReadRequest> {
  const descriptor = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
    request: {
      assemblyId: seed.assemblyId,
      workspaceRoot: seed.workspaceRoot,
      chromosomes: seed.chromosomes,
      scope: seed.scope,
    },
    themeMode: seed.artifact.themeMode,
    policy: {
      trackType,
      isoformMode: seed.requestedPolicy.isoformMode,
      laneLimit: seed.requestedPolicy.laneLimit,
    },
  });
  return descriptor.request;
}

function searchProbeMatchesReceipt(
  probe:
    | Awaited<ReturnType<typeof readAssemblyAnnotationSearchCacheIndex>>
    | Awaited<ReturnType<typeof readAssemblyAnnotationSearchCacheResource>>
    | Awaited<ReturnType<typeof readAssemblyProteinSearchCacheIndex>>
    | Awaited<ReturnType<typeof readAssemblyProteinSearchCacheResource>>,
  receipt: AssemblySearchArtifactReceiptV1
): boolean {
  return Boolean(
    probe &&
    probe.status === 'hit' &&
    probe.fingerprint === receipt.fingerprint &&
    probe.byteCount === receipt.byteCount &&
    probe.payloadSha256 === receipt.payloadSha256 &&
    probe.manifest.integrity.contractSha256 === receipt.contractSha256 &&
    probe.manifest.schema === receipt.schema &&
    probe.manifest.searchContract.contractToken === receipt.contractToken
  );
}

function stale(message: string): AssemblyReferenceAssetInspectionV1 {
  return { status: 'stale', message };
}

export function createAssemblySearchIndexReadinessCoordinatorV1(
  runtime: Pick<
    AssemblyReferenceAssetRuntimeV1,
    'assertSafePath' | 'compileAnnotationSearch' | 'compileProteinSearch'
  >
): AssemblySearchIndexReadinessCoordinatorV1 {
  return new AssemblySearchIndexReadinessCoordinatorV1({
    ...(runtime.compileAnnotationSearch || runtime.compileProteinSearch
      ? {}
      : { createSearchBuildPairing: createDedicatedWorkerSearchBuildPairing }),
    readAnnotationSearch: (source, options) =>
      readAssemblyAnnotationSearchCacheResource(
        source,
        {
          assertSafePath: runtime.assertSafePath,
        },
        options
      ),
    readAnnotationRevision: (source) =>
      readAssemblyAnnotationSearchCacheIndex(source, {
        assertSafePath: runtime.assertSafePath,
      }),
    migrateLegacyAnnotationSearch: (source) =>
      migrateLegacyAssemblyAnnotationSearchCacheIndexV1(source, {
        assertSafePath: runtime.assertSafePath,
      }),
    prepareAnnotationSearch: (
      source,
      miss,
      options
    ): Promise<AssemblyAnnotationSearchPrepareResult> =>
      prepareAssemblyAnnotationSearchOnMiss(
        source,
        miss,
        {
          assertSafePath: runtime.assertSafePath,
          ...(options?.searchBuildPairing
            ? { compileInWorker: options.searchBuildPairing.annotation }
            : runtime.compileAnnotationSearch
              ? { compileInWorker: runtime.compileAnnotationSearch }
              : {}),
        },
        options
      ),
    readProteinSearch: (source, options) =>
      readAssemblyProteinSearchCacheResource(
        source,
        {
          assertSafePath: runtime.assertSafePath,
        },
        options
      ),
    readProteinRevision: (source) =>
      readAssemblyProteinSearchCacheIndex(source, {
        assertSafePath: runtime.assertSafePath,
      }),
    prepareProteinSearch: (source, miss, options): Promise<AssemblyProteinSearchPrepareResult> =>
      prepareAssemblyProteinSearchOnMiss(
        source,
        miss,
        {
          assertSafePath: runtime.assertSafePath,
          ...(options?.searchBuildPairing
            ? { compileInWorker: options.searchBuildPairing.protein }
            : runtime.compileProteinSearch
              ? { compileInWorker: runtime.compileProteinSearch }
              : {}),
        },
        options
      ),
  });
}

function createDedicatedWorkerSearchBuildPairing(): SearchBuildPairingV1 {
  const factory = () => import('../ipc/assembly-expanded-annotation-scene-worker-factory');
  return createSearchBuildPairingV1({
    annotation: async (job, options) =>
      (await factory()).compileAssemblyAnnotationSearchInDedicatedWorker(job, options),
    protein: async (job, options) =>
      (await factory()).compileAssemblyProteinSearchInDedicatedWorker(job, options),
    both: async (job, options) =>
      (await factory()).compileAssemblySearchesInDedicatedWorker(job, options),
  });
}
