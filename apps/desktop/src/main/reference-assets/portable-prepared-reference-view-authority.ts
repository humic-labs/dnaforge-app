import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
  PREPACKED_ANNOTATION_SEARCH_CONTRACT_TOKEN,
  PREPACKED_ANNOTATION_SEARCH_INDEX_V1,
  PREPACKED_PROTEIN_SEARCH_CONTRACT_TOKEN,
  PREPACKED_PROTEIN_SEARCH_INDEX_V1,
  type PrepackedAnnotationSearchIndexManifestV1,
  type PrepackedProteinSearchIndexManifestV1,
} from '@waypoint/genome-data';
import {
  assertPartitionedTranscriptSceneRangeCatalogV1,
  validatePartitionedTranscriptSceneBinaryV4,
  type CompiledBroadAnnotationInteractionBinaryManifestV1,
  type PartitionedTranscriptSceneRangeCatalogV1,
} from '@waypoint/genome-renderer/pure';

import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
  type AssemblyAnnotationSceneArtifactContract,
  type AssemblyAnnotationProductSetInventoryReadRequestV1,
  type AssemblyAnnotationProductSetInventoryReadResultV1,
  type AssemblyAnnotationSceneReadRequest,
  type AssemblyAnnotationSceneScopeContract,
  type AssemblyCompiledBroadRasterManifestRequestV1,
  type AssemblyReferenceAssetGenerationByThemeV1,
} from '../../shared/indexed-genome';
import {
  assemblyCompiledBroadRasterReaderRevisionKeyV1,
  type AssemblyCompiledBroadRasterCatalogOpeningV1,
} from '../ipc/assembly-compiled-broad-raster-catalog';
import { openCompiledBroadRasterArtifactV1 } from '../ipc/compiled-broad-raster-artifact';
import {
  ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2,
  ASSEMBLY_ANNOTATION_SEARCH_COMPILER_SEMANTICS_V2,
  ASSEMBLY_ANNOTATION_SEARCH_LEGACY_COMPILER_SEMANTICS_V2,
  ASSEMBLY_ANNOTATION_SEARCH_PREVIOUS_COMPILER_SEMANTICS_V2,
  payloadIdentityFromFileStat,
  resolveAssemblyAnnotationSearchSourceRevisionV2,
  type AssemblyAnnotationSearchCacheIndexHit,
  type AssemblyAnnotationSearchPayloadIdentityV2,
} from '../ipc/assembly-annotation-search-cache';
import {
  ASSEMBLY_PROTEIN_SEARCH_CACHE_V1,
  type AssemblyProteinSearchCacheIndexHit,
} from '../ipc/assembly-protein-search-cache';
import {
  ASSEMBLY_PROTEIN_SEARCH_COMPILER_SEMANTICS_V2,
  ASSEMBLY_PROTEIN_SEARCH_LEGACY_COMPILER_SEMANTICS_V2,
  ASSEMBLY_PROTEIN_SEARCH_MAX_QUARANTINE_DIAGNOSTICS_V1,
  ASSEMBLY_PROTEIN_SEARCH_PREVIOUS_COMPILER_SEMANTICS_V2,
  type ProteinSearchCompilerWorkV1,
  type ProteinSearchIsoformQuarantineReasonV1,
} from '../ipc/assembly-protein-search-compiler';
import { resolveAssemblyProteinSearchSourceRevisionV1 } from '../ipc/assembly-protein-search-source';
import { type AssemblyAnnotationProductSetManifestV2 } from '../ipc/assembly-annotation-product-set-manifest';
import {
  type AssemblyAnnotationRoleSidecarCacheIndexV1,
  type AssemblyAnnotationSceneCacheIndexHit,
  type AssemblyAnnotationSceneCacheResourceHit,
} from '../ipc/assembly-overview-texture-cache';
import { annotationRoleSidecarDescriptorMatchesSceneV1 } from '../ipc/assembly-annotation-role-sidecar';
import {
  ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN,
  TRANSCRIPT_GLYPH_INTERNAL_LAYER_TYPES,
} from '../../features/sequence/annotation-layer-identity';
import type { HostedReferenceCatalogDefinitionV1 } from './hosted-reference-catalog';
import type {
  PortablePreparedReferenceHydrationResult,
  PortablePreparedReferenceHydrator,
} from './portable-prepared-reference-hydrator';
import type { PortablePreparedReferenceObjectV1 } from './portable-prepared-reference-bundle';
import { admitPortablePreparedReferenceSceneInDedicatedWorkerV1 } from './portable-prepared-reference-scene-admission-worker-client';
import {
  portablePreparedReferenceSceneAdmissionWorkerContractV1,
  runPortablePreparedReferenceSceneAdmissionWorkerJobV1,
  type PortablePreparedReferenceSceneAdmissionWorkerJobV1,
  type PortablePreparedReferenceSceneAdmissionWorkerResultV1,
} from './portable-prepared-reference-scene-admission-worker-job';
import { admitPortablePreparedReferenceSearchInDedicatedWorkerV1 } from './portable-prepared-reference-search-admission-worker-client';
import {
  assertPortableSearchResultIdentity,
  portablePreparedReferenceSearchAdmissionWorkerContractV1,
  type PortablePreparedReferenceSearchAdmissionWorkerJobV1,
} from './portable-prepared-reference-search-admission-worker-job';
import {
  assertPortableCatalogThemeRosterCoherence,
  parsePortablePreparedReferenceViewCatalogV1,
  type PortablePreparedReferenceViewCatalogEntryV1,
  type PortablePreparedReferenceViewCatalogV1,
} from './portable-prepared-reference-view-catalog';
export { assertPortableCatalogThemeRosterCoherence } from './portable-prepared-reference-view-catalog';
import {
  assertPortableFullThemeProductCoherenceV1,
  assertPortableProductViewReceiptsV1,
  parsePortableProductSetV1,
  portableAssetGenerationsByThemeV1,
  portableDatasetContractMatchesV1,
  portableLocalCompactInteractionManifestV1,
  portablePlacementFingerprintV1,
  portableProductDatasetVersionV1,
  portableProductMatchesPreparedDefinitionV1,
  portableRequestMatchesProductV1,
  portableSamePublishedDatasetContractV1,
  portableViewKeyV1,
  resealPortableSceneDiskManifestV1,
  type LocallyResealedPortableSceneManifestV1,
  type PortableSceneDiskManifestV1,
} from '../../shared/portable-reference/portable-view-admission';

export {
  portableAssetGenerationsByThemeV1,
  portableProductDatasetVersionV1,
  assertPortableFullThemeProductCoherenceV1 as assertPortableFullThemeProductCoherence,
  portableDatasetContractMatchesV1 as portableDatasetContractMatches,
};
import {
  parsePreparedReferenceDefinition,
  type PreparedReferenceDefinition,
} from './reference-preparation-manifest';
import {
  readPortablePreparedReferenceViewAdmissionReceiptV1,
  writePortablePreparedReferenceViewAdmissionReceiptV1,
  type PortablePreparedReferenceViewAdmissionReceiptInputV1,
} from './portable-prepared-reference-view-admission-receipt';

const PORTABLE_ANNOTATION_SEARCH_MANIFEST_V1 =
  'dnaforge-portable-annotation-search-manifest.v1' as const;
const PORTABLE_PROTEIN_SEARCH_MANIFEST_V1 = 'dnaforge-portable-protein-search-manifest.v1' as const;
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_FINGERPRINT = /^[0-9a-f]{24}$/;
const PORTABLE_DERIVED_SCENE_COMPANIONS_V1 =
  'dnaforge-portable-derived-scene-companions.v1' as const;
const PORTABLE_DERIVED_SCENE_COMPANION_DIRECTORY = '.derived-scene-companions.v1';

interface PortableDerivedSceneCompanionsDiskV1 {
  readonly contract: typeof PORTABLE_DERIVED_SCENE_COMPANIONS_V1;
  readonly bundleFingerprint: string;
  readonly sourceScene: Readonly<{
    byteLength: number;
    payloadSha256: string;
    contractSha256: string;
  }>;
  readonly compact: Readonly<{
    file: string;
    byteCount: number;
    payloadSha256: string;
    manifest: CompiledBroadAnnotationInteractionBinaryManifestV1;
  }>;
  readonly rangeCatalog: PartitionedTranscriptSceneRangeCatalogV1;
}

interface PortableViewAdmission {
  readonly definition: HostedReferenceCatalogDefinitionV1;
  readonly familyRoot: string;
  readonly hydration: PortablePreparedReferenceHydrationResult;
  readonly hydrator: PortablePreparedReferenceHydrator;
  readonly catalog: PortablePreparedReferenceViewCatalogV1;
  readonly entriesByView: ReadonlyMap<string, PortablePreparedReferenceViewCatalogEntryV1>;
  readonly prepared?: PreparedReferenceDefinition;
  readonly annotationProducts?: PortableAnnotationProductsAdmission;
  readonly search?: PortableSearchAdmission;
}

interface PortableAnnotationProductsAdmission {
  readonly productsByTheme: ReadonlyMap<'dark' | 'light', AssemblyAnnotationProductSetManifestV2>;
}

interface PortableSearchAdmission {
  readonly annotationSearch: Omit<AssemblyAnnotationSearchCacheIndexHit, 'sourceContinuity'>;
  readonly proteinSearch: Omit<AssemblyProteinSearchCacheIndexHit, 'sourceContinuity'>;
}

export interface PortablePreparedReferenceCompiledBroadInteractionHitV1 {
  readonly status: 'hit';
  readonly authorityKind: 'portable' | 'local';
  readonly origin: 'durable-hit' | 'prepared-after-miss';
  readonly ipcContractVersion: typeof ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT;
  readonly fingerprint: string;
  readonly sourceBuildFingerprint: string;
  readonly scope: AssemblyAnnotationSceneScopeContract;
  readonly artifact: AssemblyAnnotationSceneArtifactContract;
  readonly sourceScene: Readonly<{
    byteCount: number;
    payloadSha256: string;
    contractSha256: string;
  }>;
  readonly byteCount: number;
  readonly payloadSha256: string;
  readonly manifest: CompiledBroadAnnotationInteractionBinaryManifestV1;
  readonly validatedPayload: Uint8Array;
}

export interface PortablePreparedReferenceViewAdmissionProjectionV1 {
  readonly trackTypes: readonly string[];
  readonly datasetVersion?: string;
  readonly assetGenerationsByTheme?: AssemblyReferenceAssetGenerationByThemeV1;
  readonly searchReady?: boolean;
}

function portableViewProjection(
  catalog: PortablePreparedReferenceViewCatalogV1,
  annotationProducts: PortableAnnotationProductsAdmission | undefined,
  search: PortableSearchAdmission | undefined
): PortablePreparedReferenceViewAdmissionProjectionV1 {
  const trackTypes = Object.freeze(
    [...new Set(catalog.entries.map((entry) => entry.trackType))].sort((left, right) =>
      left.localeCompare(right)
    )
  );
  if (!annotationProducts) return Object.freeze({ trackTypes });
  return Object.freeze({
    trackTypes,
    datasetVersion: portableProductDatasetVersionV1(annotationProducts.productsByTheme),
    assetGenerationsByTheme: portableAssetGenerationsByThemeV1(annotationProducts.productsByTheme),
    searchReady: Boolean(search),
  });
}

export class PortablePreparedReferenceViewAuthorityV1 {
  readonly #admissions = new Map<string, PortableViewAdmission>();
  readonly #retainedAdmissions = new Map<string, PortableViewAdmission[]>();

  releaseGeneration(generationRoot: string): void {
    for (const [key, admissions] of this.#retainedAdmissions) {
      this.#retainedAdmissions.set(
        key,
        admissions.filter((admission) => admission.hydration.generationRoot !== generationRoot)
      );
    }
    this.#sceneAdmissionTasks.clear();
  }

  #admissionForRequest(
    request: AssemblyAnnotationSceneReadRequest
  ): PortableViewAdmission | undefined {
    const key = admissionKey(request.workspaceRoot, request.assemblyId);
    const current = this.#admissions.get(key);
    const candidates = [current, ...(this.#retainedAdmissions.get(key) ?? [])].filter(
      (admission): admission is PortableViewAdmission => !!admission
    );
    return candidates.find((admission) => {
      const product = admission.annotationProducts?.productsByTheme.get(request.artifact.themeMode);
      if (product) return requestMatchesPortableProduct(request, admission, product);
      const entry = admission.entriesByView.get(
        portableViewKeyV1(request.artifact.themeMode, request.artifact.trackType)
      );
      return entry?.sceneArtifactKey === request.artifact.artifactKey;
    });
  }

  #hasAdmission(admission: PortableViewAdmission): boolean {
    const key = admissionKey(admission.familyRoot, admission.catalog.assemblyId);
    return (
      this.#admissions.get(key) === admission ||
      (this.#retainedAdmissions.get(key) ?? []).includes(admission)
    );
  }

  readonly #sceneAdmissionTasks = new Map<
    string,
    Promise<PortablePreparedReferenceSceneAdmissionWorkerResultV1>
  >();
  readonly #admitScene: (
    job: PortablePreparedReferenceSceneAdmissionWorkerJobV1
  ) => Promise<PortablePreparedReferenceSceneAdmissionWorkerResultV1>;
  readonly #admitSearch: (
    job: PortablePreparedReferenceSearchAdmissionWorkerJobV1
  ) => Promise<unknown>;

  constructor(
    input: {
      readonly validateScene?: typeof validatePartitionedTranscriptSceneBinaryV4;
      readonly admitScene?: (
        job: PortablePreparedReferenceSceneAdmissionWorkerJobV1
      ) => Promise<PortablePreparedReferenceSceneAdmissionWorkerResultV1>;
      readonly admitSearch?: (
        job: PortablePreparedReferenceSearchAdmissionWorkerJobV1
      ) => Promise<unknown>;
    } = {}
  ) {
    this.#admitScene =
      input.admitScene ??
      (input.validateScene
        ? (job) =>
            runPortablePreparedReferenceSceneAdmissionWorkerJobV1(job, {
              validateScene: input.validateScene,
            })
        : admitPortablePreparedReferenceSceneInDedicatedWorkerV1);
    this.#admitSearch =
      input.admitSearch ?? admitPortablePreparedReferenceSearchInDedicatedWorkerV1;
  }

  async admit(input: {
    readonly definition: HostedReferenceCatalogDefinitionV1;
    readonly familyRoot: string;
    readonly hydration: PortablePreparedReferenceHydrationResult;
    readonly hydrator: PortablePreparedReferenceHydrator;
    readonly runtimeSourceFingerprint: string;
  }): Promise<PortablePreparedReferenceViewAdmissionProjectionV1> {
    const admissionStartedAt = Date.now();
    if (
      (!input.hydration.hydratedTiers.includes('view') &&
        !input.hydration.hydratedTiers.includes('detail')) ||
      input.hydration.bundle.assembly.id !== input.definition.id
    ) {
      throw new Error('Portable prepared-reference view admission is incomplete.');
    }
    const catalogObjects = input.hydration.bundle.objects.filter(
      (object) => object.role === 'view-catalog'
    );
    if (catalogObjects.length !== 1) {
      throw new Error('Portable prepared-reference bundle must contain exactly one view catalog.');
    }
    const catalogPath = input.hydration.objectPaths.get(catalogObjects[0].id);
    if (!catalogPath) throw new Error('Portable prepared-reference view catalog is not hydrated.');
    const catalog = parsePortablePreparedReferenceViewCatalogV1(
      JSON.parse(await readFile(catalogPath, 'utf8')) as unknown,
      input.hydration.bundle
    );
    assertPortableCatalogThemeRosterCoherence(catalog);
    const entriesByView = new Map(
      catalog.entries.map((entry) => [portableViewKeyV1(entry.themeMode, entry.trackType), entry])
    );
    const familyRoot = resolve(input.familyRoot);
    const priorAdmission = this.#admissions.get(admissionKey(familyRoot, input.definition.id));
    if (
      priorAdmission &&
      priorAdmission.hydration.bundle.bundleFingerprint !== input.hydration.bundle.bundleFingerprint
    ) {
      const key = admissionKey(familyRoot, input.definition.id);
      const retained = this.#retainedAdmissions.get(key) ?? [];
      this.#retainedAdmissions.set(key, [
        ...retained.filter(
          (admission) =>
            admission.hydration.bundle.bundleFingerprint !==
            priorAdmission.hydration.bundle.bundleFingerprint
        ),
        priorAdmission,
      ]);
    }
    const hasDetailHydration = input.hydration.hydratedTiers.includes('detail');
    const hasSearchHydration = input.hydration.hydratedTiers.includes('search');
    if (
      !hasDetailHydration &&
      priorAdmission?.annotationProducts &&
      priorAdmission.prepared &&
      priorAdmission.hydration.bundle.bundleFingerprint === input.hydration.bundle.bundleFingerprint
    ) {
      return portableViewProjection(
        priorAdmission.catalog,
        priorAdmission.annotationProducts,
        priorAdmission.search
      );
    }
    let prepared: PreparedReferenceDefinition | undefined;
    let annotationProducts: PortableAnnotationProductsAdmission | undefined;
    let search: PortableSearchAdmission | undefined;
    let durableSearchAdmission = false;
    if (hasDetailHydration) {
      const productObjects = input.hydration.bundle.objects.filter(
        (object) => object.role === 'annotation-product-set-manifest'
      );
      if (productObjects.length > 2) {
        throw new Error('Portable prepared-reference product theme family is incomplete.');
      }
      if (productObjects.length === 0) {
        if (hasSearchHydration) {
          throw new Error('Portable search admission requires annotation product identity.');
        }
      } else {
        const definitionObjects = input.hydration.bundle.objects.filter(
          (object) => object.role === 'prepared-reference-definition'
        );
        if (definitionObjects.length !== 1) {
          throw new Error(
            'Portable prepared-reference bundle must contain exactly one definition.'
          );
        }
        const definitionPath = input.hydration.objectPaths.get(definitionObjects[0].id);
        if (!definitionPath) {
          throw new Error('Portable prepared-reference definition is not hydrated.');
        }
        prepared = parsePreparedReferenceDefinition(
          JSON.parse(await readFile(definitionPath, 'utf8')) as unknown,
          input.definition.id
        );
        annotationProducts = await admitPortableAnnotationProducts({
          definition: input.definition,
          hydration: input.hydration,
          catalog,
          entriesByView,
          prepared,
        });
        if (hasSearchHydration) {
          const receiptInput = portableViewAdmissionReceiptInput(input);
          durableSearchAdmission =
            (await readPortablePreparedReferenceViewAdmissionReceiptV1(receiptInput)).status ===
            'hit';
          search = await admitPortableSearchProducts({
            definition: input.definition,
            hydration: input.hydration,
            catalog,
            annotationProducts,
            admitSearch: this.#admitSearch,
            skipPayloadAdmission: durableSearchAdmission,
          });
          if (
            durableSearchAdmission &&
            (await readPortablePreparedReferenceViewAdmissionReceiptV1(receiptInput)).status !==
              'hit'
          ) {
            durableSearchAdmission = false;
            search = await admitPortableSearchProducts({
              definition: input.definition,
              hydration: input.hydration,
              catalog,
              annotationProducts,
              admitSearch: this.#admitSearch,
              skipPayloadAdmission: false,
            });
          }
          if (!durableSearchAdmission) {
            try {
              await writePortablePreparedReferenceViewAdmissionReceiptV1(receiptInput);
            } catch (error) {
              console.warn(
                `[portable-reference-admission] ${JSON.stringify({
                  assemblyId: input.definition.id,
                  outcome: 'receipt-write-failed',
                  detail: error instanceof Error ? error.message : String(error),
                })}`
              );
            }
          }
        } else if (
          priorAdmission?.search &&
          priorAdmission.hydration.bundle.bundleFingerprint ===
            input.hydration.bundle.bundleFingerprint
        ) {
          search = priorAdmission.search;
        }
      }
    }
    this.#admissions.set(
      admissionKey(input.familyRoot, input.definition.id),
      Object.freeze({
        definition: input.definition,
        familyRoot,
        hydration: input.hydration,
        hydrator: input.hydrator,
        catalog,
        entriesByView,
        ...(prepared ? { prepared } : {}),
        ...(annotationProducts ? { annotationProducts } : {}),
        ...(search ? { search } : {}),
      })
    );
    if (hasSearchHydration && search) {
      console.info(
        `[portable-reference-admission] ${JSON.stringify({
          assemblyId: input.definition.id,
          mode: durableSearchAdmission ? 'durable-receipt' : 'full-worker-admission',
          elapsedMs: Date.now() - admissionStartedAt,
        })}`
      );
    }
    return portableViewProjection(catalog, annotationProducts, search);
  }

  async readProductInventory(
    input: AssemblyAnnotationProductSetInventoryReadRequestV1
  ): Promise<AssemblyAnnotationProductSetInventoryReadResultV1> {
    const seed = input?.seedProduct;
    if (!seed || seed.ipcContractVersion !== ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT) {
      return { status: 'unavailable' };
    }
    const admission = this.#admissionForRequest(seed);
    const product = admission?.annotationProducts?.productsByTheme.get(seed.artifact.themeMode);
    if (!admission || !product || !requestMatchesPortableProduct(seed, admission, product)) {
      return { status: 'unavailable' };
    }
    return Object.freeze({
      status: 'ready',
      sourceFingerprint: product.sourceFingerprint,
      inventoryFingerprint: product.inventoryFingerprint,
      trackTypes: Object.freeze([...product.trackTypes]),
    });
  }

  async readAnnotationSearchIndex(
    input: AssemblyAnnotationSceneReadRequest
  ): Promise<AssemblyAnnotationSearchCacheIndexHit | null> {
    const admission = this.#admissionForRequest(input);
    const product = admission?.annotationProducts?.productsByTheme.get(input.artifact.themeMode);
    if (
      !admission?.search ||
      !product ||
      !requestMatchesPortableProduct(input, admission, product)
    ) {
      return null;
    }
    const revision = await resolveAssemblyAnnotationSearchSourceRevisionV2(input, {
      assertSafePath: (path) => assertPortableSourcePath(path, admission),
    });
    if (!revision) return null;
    return Object.freeze({
      ...admission.search.annotationSearch,
      sourceContinuity: Object.freeze([...revision.sourceContinuity]),
    });
  }

  async readProteinSearchIndex(
    input: AssemblyAnnotationSceneReadRequest
  ): Promise<AssemblyProteinSearchCacheIndexHit | null> {
    const admission = this.#admissionForRequest(input);
    const product = admission?.annotationProducts?.productsByTheme.get(input.artifact.themeMode);
    if (
      !admission?.search ||
      !product ||
      !requestMatchesPortableProduct(input, admission, product)
    ) {
      return null;
    }
    const revision = await resolveAssemblyProteinSearchSourceRevisionV1(input, {
      assertSafePath: (path) => assertPortableSourcePath(path, admission),
    });
    if (!revision) return null;
    return Object.freeze({
      ...admission.search.proteinSearch,
      sourceContinuity: Object.freeze([...revision.sourceContinuity]),
    });
  }

  async open(
    input: AssemblyCompiledBroadRasterManifestRequestV1
  ): Promise<AssemblyCompiledBroadRasterCatalogOpeningV1 | null> {
    if (input?.contract !== ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1 || !input.scene) return null;
    const admission = this.#admissionForRequest(input.scene);
    if (!admission || resolve(input.scene.workspaceRoot) !== admission.familyRoot) return null;
    const artifact = input.scene.artifact;
    const entry = admission.entriesByView.get(
      portableViewKeyV1(artifact.themeMode, artifact.trackType)
    );
    if (
      !entry ||
      entry.sceneArtifactKey !== artifact.artifactKey ||
      entry.placementFingerprint !== portablePlacementFingerprintV1(input.scene.scope.placements)
    ) {
      return null;
    }
    const manifestPath = admission.hydration.objectPaths.get(entry.broadManifestObjectId);
    if (!manifestPath) return null;
    const reader = await openCompiledBroadRasterArtifactV1({
      artifactDirectory: dirname(manifestPath),
      expectedSurfaceManifestFingerprint: entry.surfaceManifestFingerprint,
    });
    if (
      reader.manifest.catalogFingerprint !== entry.catalogFingerprint ||
      reader.manifest.surfaceManifest.trackId !== entry.trackType ||
      reader.manifest.surfaceManifest.manifestFingerprint !== entry.surfaceManifestFingerprint
    ) {
      return null;
    }
    const sceneContractSha256 = entry.sceneContractSha256;
    const sceneSourceBuildFingerprint = entry.sceneCompilerContractFingerprint;
    const readerRevisionKey = assemblyCompiledBroadRasterReaderRevisionKeyV1({
      workspaceRoot: admission.familyRoot,
      sourceFingerprint: entry.sourceFingerprint,
      placementFingerprint: entry.placementFingerprint,
      scenePayloadSha256: entry.scenePayloadSha256,
      sceneContractSha256,
      sceneSourceBuildFingerprint,
      surfaceManifestFingerprint: entry.surfaceManifestFingerprint,
      artifactDirectory: dirname(manifestPath),
    });
    if (!readerRevisionKey) return null;
    const opening: AssemblyCompiledBroadRasterCatalogOpeningV1 = {
      request: input,
      sceneIndex: Object.freeze({
        fingerprint: entry.sourceFingerprint,
        placementFingerprint: entry.placementFingerprint,
        payloadSha256: entry.scenePayloadSha256,
        sourceBuildFingerprint: sceneSourceBuildFingerprint,
        artifact: { ...artifact },
        manifest: {
          integrity: {
            algorithm: 'sha256' as const,
            payloadSha256: entry.scenePayloadSha256,
            contractSha256: sceneContractSha256,
          },
        },
      }),
      surfaceManifest: reader.manifest.surfaceManifest,
      artifactDirectory: dirname(manifestPath),
      readerRevisionKey,
      reader,
      readCells: (addresses) =>
        admission.hydrator.hydrateBroadRasterCells({
          definition: admission.definition,
          hydration: admission.hydration,
          manifestObjectId: entry.broadManifestObjectId,
          expectedSurfaceManifestFingerprint: entry.surfaceManifestFingerprint,
          admittedReader: reader,
          addresses,
        }),
    };
    return Object.freeze(opening);
  }

  async readScene(
    input: AssemblyAnnotationSceneReadRequest
  ): Promise<AssemblyAnnotationSceneCacheResourceHit | null> {
    const exact = await this.#admitExactScene(input, 'full-scene');
    if (!exact || 'projection' in exact.admittedScene) return null;
    const { admission, entry, localScene, scenePath, admittedScene } = exact;
    const { disk } = localScene;
    const roleSidecar = await portableRoleSidecarIndex(admission, localScene, input.assemblyId);
    return Object.freeze({
      ...(roleSidecar ? { roleSidecar } : {}),
      status: 'hit',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: entry.sourceFingerprint,
      sourceBuildFingerprint: localScene.compilerContractFingerprint,
      scope: disk.scope,
      artifact: disk.artifact,
      byteCount: disk.byteCount,
      manifest: localScene.manifest,
      scenePath,
      payloadSha256: entry.scenePayloadSha256,
      validatedPayload: admittedScene.validatedPayload,
    });
  }

  async readSceneIndex(
    input: AssemblyAnnotationSceneReadRequest
  ): Promise<AssemblyAnnotationSceneCacheIndexHit | null> {
    const exact = await this.#resolveExactScene(input);
    if (!exact) return null;
    const { admission, entry, localScene, authorizedPayloadRealPath } = exact;
    const derived =
      localScene.detailRangeCatalog || entry.compiledBroadInteractionPayloadObjectId
        ? null
        : await this.#prepareLegacySceneCompanions(input);
    const detailRangeCatalog = localScene.detailRangeCatalog ?? derived?.rangeCatalog ?? null;
    const roleSidecar = await portableRoleSidecarIndex(admission, localScene, input.assemblyId);
    return Object.freeze({
      ...(roleSidecar ? { roleSidecar } : {}),
      status: 'hit',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: entry.sourceFingerprint,
      sourceBuildFingerprint: localScene.compilerContractFingerprint,
      scope: localScene.disk.scope,
      artifact: localScene.disk.artifact,
      byteCount: localScene.disk.byteCount,
      manifest: localScene.manifest,
      scenePath: authorizedPayloadRealPath,
      payloadSha256: entry.scenePayloadSha256,
      placementFingerprint: entry.placementFingerprint,
      ...(detailRangeCatalog ? { detailRangeCatalog } : {}),
    });
  }

  async readCompiledBroadInteraction(
    input: AssemblyAnnotationSceneReadRequest
  ): Promise<PortablePreparedReferenceCompiledBroadInteractionHitV1 | null> {
    const persisted = await this.#admitPersistedCompiledBroadInteraction(input);
    if (persisted) {
      const { entry, localScene, admitted } = persisted;
      return Object.freeze({
        status: 'hit',
        authorityKind: 'portable',
        origin: 'durable-hit',
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        fingerprint: entry.sourceFingerprint,
        sourceBuildFingerprint: localScene.compilerContractFingerprint,
        scope: localScene.disk.scope,
        artifact: localScene.disk.artifact,
        sourceScene: Object.freeze({
          byteCount: localScene.disk.byteCount,
          payloadSha256: localScene.manifest.integrity.payloadSha256,
          contractSha256: localScene.manifest.integrity.contractSha256,
        }),
        byteCount: admitted.byteCount,
        payloadSha256: admitted.payloadSha256,
        manifest: admitted.manifest,
        validatedPayload: admitted.validatedPayload,
      });
    }
    const declaredAdmission = this.#admissionForRequest(input);
    const declaredEntry = declaredAdmission?.entriesByView.get(
      portableViewKeyV1(input.artifact.themeMode, input.artifact.trackType)
    );
    if (declaredEntry?.compiledBroadInteractionPayloadObjectId) return null;
    const derived = await this.#prepareLegacySceneCompanions(input);
    if (!derived) return null;
    const { entry, localScene, compact } = derived;
    return Object.freeze({
      status: 'hit',
      authorityKind: 'portable',
      origin: derived.origin,
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: entry.sourceFingerprint,
      sourceBuildFingerprint: localScene.compilerContractFingerprint,
      scope: localScene.disk.scope,
      artifact: localScene.disk.artifact,
      sourceScene: Object.freeze({
        byteCount: localScene.disk.byteCount,
        payloadSha256: localScene.manifest.integrity.payloadSha256,
        contractSha256: localScene.manifest.integrity.contractSha256,
      }),
      byteCount: compact.byteCount,
      payloadSha256: compact.payloadSha256,
      manifest: compact.manifest,
      validatedPayload: compact.validatedPayload,
    });
  }

  async #prepareLegacySceneCompanions(input: AssemblyAnnotationSceneReadRequest): Promise<{
    entry: PortablePreparedReferenceViewCatalogEntryV1;
    localScene: LocallyResealedPortableSceneManifest;
    compact: Extract<
      PortablePreparedReferenceSceneAdmissionWorkerResultV1,
      { projection: 'compiled-broad-interaction' | 'persisted-compiled-broad-interaction' }
    >;
    rangeCatalog: PartitionedTranscriptSceneRangeCatalogV1;
    origin: 'durable-hit' | 'prepared-after-miss';
  } | null> {
    const durable = await this.#admitPersistedLegacySceneCompanions(input);
    if (durable) return { ...durable, origin: 'durable-hit' };

    const exact = await this.#admitExactScene(input, 'compiled-broad-interaction');
    if (
      !exact ||
      !('projection' in exact.admittedScene) ||
      exact.admittedScene.projection !== 'compiled-broad-interaction'
    ) {
      return null;
    }
    const { admission, entry, localScene, admittedScene } = exact;
    if (
      admittedScene.sourceByteCount !== localScene.disk.byteCount ||
      admittedScene.sourcePayloadSha256 !== entry.scenePayloadSha256 ||
      admittedScene.manifest.sourceScene.contractSha256 !==
        localScene.manifest.integrity.contractSha256
    ) {
      return null;
    }
    assertPartitionedTranscriptSceneRangeCatalogV1(admittedScene.rangeCatalog, localScene.manifest);
    try {
      await this.#persistLegacySceneCompanions({
        admission,
        entry,
        localScene,
        compact: admittedScene,
      });
    } catch (error) {
      console.error('[portable-prepared-reference-derived-companions] persist failed', {
        assemblyId: input.assemblyId,
        trackType: input.artifact.trackType,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
    return {
      entry,
      localScene,
      compact: admittedScene,
      rangeCatalog: admittedScene.rangeCatalog,
      origin: 'prepared-after-miss',
    };
  }

  async #admitPersistedLegacySceneCompanions(input: AssemblyAnnotationSceneReadRequest): Promise<{
    entry: PortablePreparedReferenceViewCatalogEntryV1;
    localScene: LocallyResealedPortableSceneManifest;
    compact: Extract<
      PortablePreparedReferenceSceneAdmissionWorkerResultV1,
      { projection: 'persisted-compiled-broad-interaction' }
    >;
    rangeCatalog: PartitionedTranscriptSceneRangeCatalogV1;
  } | null> {
    const exact = await this.#resolveExactScene(input);
    if (!exact) return null;
    const { admission, entry, localScene } = exact;
    if (entry.compiledBroadInteractionPayloadObjectId) return null;
    const sceneManifestPath = admission.hydration.objectPaths.get(entry.sceneManifestObjectId);
    if (!sceneManifestPath) return null;
    const paths = portableDerivedSceneCompanionPaths({
      sceneManifestPath,
      bundleFingerprint: admission.hydration.bundle.bundleFingerprint,
      entry,
      localContractSha256: localScene.manifest.integrity.contractSha256,
    });
    try {
      const disk = JSON.parse(
        await readFile(paths.manifestPath, 'utf8')
      ) as PortableDerivedSceneCompanionsDiskV1;
      const compactFile = portableDerivedCompactFileName(paths.stem, disk.compact?.payloadSha256);
      if (
        disk.contract !== PORTABLE_DERIVED_SCENE_COMPANIONS_V1 ||
        disk.bundleFingerprint !== admission.hydration.bundle.bundleFingerprint ||
        disk.sourceScene?.byteLength !== localScene.disk.byteCount ||
        disk.sourceScene?.payloadSha256 !== entry.scenePayloadSha256 ||
        disk.sourceScene?.contractSha256 !== localScene.manifest.integrity.contractSha256 ||
        !SHA256.test(String(disk.compact?.payloadSha256)) ||
        disk.compact?.manifest?.integrity?.payloadSha256 !== disk.compact.payloadSha256 ||
        disk.compact?.manifest?.sourceScene?.byteLength !== localScene.disk.byteCount ||
        disk.compact?.manifest?.sourceScene?.payloadSha256 !== entry.scenePayloadSha256 ||
        disk.compact?.manifest?.sourceScene?.contractSha256 !==
          localScene.manifest.integrity.contractSha256 ||
        disk.compact?.file !== compactFile ||
        basename(disk.compact.file) !== disk.compact.file
      ) {
        return null;
      }
      assertPartitionedTranscriptSceneRangeCatalogV1(disk.rangeCatalog, localScene.manifest);
      const compactPath = join(paths.directory, compactFile);
      const compactStat = await stat(compactPath);
      if (compactStat.size !== disk.compact.byteCount) return null;
      const authorizedPayloadRealPath = await realpath(compactPath);
      const authorizedDirectoryRealPath = await realpath(paths.directory);
      if (dirname(authorizedPayloadRealPath) !== authorizedDirectoryRealPath) return null;
      const taskKey = [
        input.workspaceRoot,
        admission.hydration.bundle.bundleFingerprint,
        authorizedPayloadRealPath,
        disk.compact.payloadSha256,
        entry.scenePayloadSha256,
        localScene.manifest.integrity.contractSha256,
        'legacy-derived-compiled-broad-interaction',
      ].join('\u0000');
      let task = this.#sceneAdmissionTasks.get(taskKey);
      if (!task) {
        task = this.#admitScene({
          contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
          payloadPath: compactPath,
          authorizedPayloadRealPath,
          projection: 'admit-persisted-compiled-broad-interaction',
          manifest: disk.compact.manifest,
          expectedPayloadSha256: disk.compact.payloadSha256,
        });
        this.#sceneAdmissionTasks.set(taskKey, task);
        void task.catch(() => {
          if (this.#sceneAdmissionTasks.get(taskKey) === task) {
            this.#sceneAdmissionTasks.delete(taskKey);
          }
        });
      }
      const compact = await task;
      if (
        !('projection' in compact) ||
        compact.projection !== 'persisted-compiled-broad-interaction' ||
        compact.byteCount !== disk.compact.byteCount ||
        compact.payloadSha256 !== disk.compact.payloadSha256 ||
        this.#admissionForRequest(input) !== admission
      ) {
        return null;
      }
      return { entry, localScene, compact, rangeCatalog: disk.rangeCatalog };
    } catch {
      return null;
    }
  }

  async #persistLegacySceneCompanions(input: {
    admission: PortableViewAdmission;
    entry: PortablePreparedReferenceViewCatalogEntryV1;
    localScene: LocallyResealedPortableSceneManifest;
    compact: Extract<
      PortablePreparedReferenceSceneAdmissionWorkerResultV1,
      { projection: 'compiled-broad-interaction' }
    >;
  }): Promise<void> {
    const sceneManifestPath = input.admission.hydration.objectPaths.get(
      input.entry.sceneManifestObjectId
    );
    if (!sceneManifestPath) {
      throw new Error('Portable scene companion commit lost its parent manifest.');
    }
    const paths = portableDerivedSceneCompanionPaths({
      sceneManifestPath,
      bundleFingerprint: input.admission.hydration.bundle.bundleFingerprint,
      entry: input.entry,
      localContractSha256: input.localScene.manifest.integrity.contractSha256,
    });
    const compactFile = portableDerivedCompactFileName(paths.stem, input.compact.payloadSha256);
    const compactPath = join(paths.directory, compactFile);
    const disk: PortableDerivedSceneCompanionsDiskV1 = Object.freeze({
      contract: PORTABLE_DERIVED_SCENE_COMPANIONS_V1,
      bundleFingerprint: input.admission.hydration.bundle.bundleFingerprint,
      sourceScene: Object.freeze({
        byteLength: input.localScene.disk.byteCount,
        payloadSha256: input.entry.scenePayloadSha256,
        contractSha256: input.localScene.manifest.integrity.contractSha256,
      }),
      compact: Object.freeze({
        file: compactFile,
        byteCount: input.compact.byteCount,
        payloadSha256: input.compact.payloadSha256,
        manifest: input.compact.manifest,
      }),
      rangeCatalog: input.compact.rangeCatalog,
    });
    await mkdir(paths.directory, { recursive: true });
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tempCompactPath = `${compactPath}.tmp-${token}`;
    const tempManifestPath = `${paths.manifestPath}.tmp-${token}`;
    try {
      await writeFile(
        tempCompactPath,
        Buffer.from(
          input.compact.validatedPayload.buffer,
          input.compact.validatedPayload.byteOffset,
          input.compact.validatedPayload.byteLength
        )
      );
      await writeFile(tempManifestPath, `${JSON.stringify(disk)}\n`, 'utf8');
      if (!this.#hasAdmission(input.admission)) {
        throw new Error('Portable scene companion commit lost its admitted generation.');
      }
      await rename(tempCompactPath, compactPath);
      await rename(tempManifestPath, paths.manifestPath);
    } finally {
      await Promise.all([
        unlink(tempCompactPath).catch(() => undefined),
        unlink(tempManifestPath).catch(() => undefined),
      ]);
    }
  }

  async #admitPersistedCompiledBroadInteraction(
    input: AssemblyAnnotationSceneReadRequest
  ): Promise<{
    entry: PortablePreparedReferenceViewCatalogEntryV1;
    localScene: LocallyResealedPortableSceneManifest;
    admitted: Extract<
      PortablePreparedReferenceSceneAdmissionWorkerResultV1,
      { projection: 'persisted-compiled-broad-interaction' }
    >;
  } | null> {
    if (input?.ipcContractVersion !== ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT) return null;
    const admission = this.#admissionForRequest(input);
    if (!admission || resolve(input.workspaceRoot) !== admission.familyRoot) return null;
    const entry = admission.entriesByView.get(
      portableViewKeyV1(input.artifact.themeMode, input.artifact.trackType)
    );
    if (
      !entry?.compiledBroadInteractionPayloadObjectId ||
      !entry.compiledBroadInteractionPayloadSha256 ||
      !entry.compiledBroadInteractionManifest ||
      entry.sceneArtifactKey !== input.artifact.artifactKey ||
      entry.placementFingerprint !== portablePlacementFingerprintV1(input.scope.placements)
    ) {
      return null;
    }
    const sceneManifestPath = admission.hydration.objectPaths.get(entry.sceneManifestObjectId);
    const compactPath = admission.hydration.objectPaths.get(
      entry.compiledBroadInteractionPayloadObjectId
    );
    if (!sceneManifestPath || !compactPath) return null;
    try {
      const localScene = await readLocallyResealedPortableSceneManifest({
        manifestPath: sceneManifestPath,
        request: input,
        entry,
        legacyLayerIdentityContract:
          admission.definition.preparedBundle?.legacyLayerIdentityContract,
      });
      if (!localScene) return null;
      const localCompactManifest = portableLocalCompactInteractionManifestV1(entry, localScene);
      if (!localCompactManifest) return null;
      const authorizedPayloadRealPath = await realpath(compactPath);
      const taskKey = [
        input.workspaceRoot,
        admission.hydration.bundle.bundleFingerprint,
        authorizedPayloadRealPath,
        entry.compiledBroadInteractionPayloadSha256,
        localScene.manifest.integrity.payloadSha256,
        localScene.manifest.integrity.contractSha256,
        'persisted-compiled-broad-interaction',
      ].join('\u0000');
      let task = this.#sceneAdmissionTasks.get(taskKey);
      if (!task) {
        task = this.#admitScene({
          contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
          payloadPath: compactPath,
          authorizedPayloadRealPath,
          projection: 'admit-persisted-compiled-broad-interaction',
          manifest: localCompactManifest,
          expectedPayloadSha256: entry.compiledBroadInteractionPayloadSha256,
        });
        this.#sceneAdmissionTasks.set(taskKey, task);
        void task.catch(() => {
          if (this.#sceneAdmissionTasks.get(taskKey) === task) {
            this.#sceneAdmissionTasks.delete(taskKey);
          }
        });
      }
      const admitted = await task;
      if (
        !('projection' in admitted) ||
        admitted.projection !== 'persisted-compiled-broad-interaction' ||
        admitted.payloadSha256 !== entry.compiledBroadInteractionPayloadSha256 ||
        admitted.manifest.sourceScene.payloadSha256 !==
          localScene.manifest.integrity.payloadSha256 ||
        admitted.manifest.sourceScene.contractSha256 !==
          localScene.manifest.integrity.contractSha256 ||
        this.#admissionForRequest(input) !== admission
      ) {
        return null;
      }
      return { entry, localScene, admitted };
    } catch (error) {
      console.error('[portable-prepared-reference-compact-interaction] admission failed', {
        assemblyId: input.assemblyId,
        trackType: input.artifact.trackType,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      return null;
    }
  }

  async #admitExactScene(
    input: AssemblyAnnotationSceneReadRequest,
    projection: 'full-scene' | 'compiled-broad-interaction'
  ): Promise<{
    admission: PortableViewAdmission;
    entry: PortablePreparedReferenceViewCatalogEntryV1;
    localScene: NonNullable<Awaited<ReturnType<typeof readLocallyResealedPortableSceneManifest>>>;
    scenePath: string;
    admittedScene: PortablePreparedReferenceSceneAdmissionWorkerResultV1;
  } | null> {
    const exact = await this.#resolveExactScene(input);
    if (!exact) return null;
    const { admission, entry, localScene, scenePath, authorizedPayloadRealPath } = exact;
    try {
      const { disk } = localScene;
      const admissionTaskKey = [
        input.workspaceRoot,
        admission.hydration.bundle.bundleFingerprint,
        authorizedPayloadRealPath,
        entry.scenePayloadSha256,
        projection,
        ...(projection === 'compiled-broad-interaction'
          ? [
              localScene.manifest.integrity.contractSha256,
              localScene.manifest.datasetContract.datasetId,
              localScene.manifest.datasetContract.datasetVersion,
              localScene.manifest.datasetContract.sourceSha256,
            ]
          : []),
      ].join('\u0000');
      let admissionTask = this.#sceneAdmissionTasks.get(admissionTaskKey);
      if (!admissionTask) {
        admissionTask = this.#admitScene({
          contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
          payloadPath: scenePath,
          authorizedPayloadRealPath,
          manifest: localScene.publishedManifest,
          expectedPayloadSha256: entry.scenePayloadSha256,
          projection,
          ...(projection === 'compiled-broad-interaction'
            ? {
                projectionDatasetContract: localScene.manifest.datasetContract,
                expectedProjectionContractSha256: localScene.manifest.integrity.contractSha256,
              }
            : {}),
        });
        this.#sceneAdmissionTasks.set(admissionTaskKey, admissionTask);
        void admissionTask.catch(() => {
          if (this.#sceneAdmissionTasks.get(admissionTaskKey) === admissionTask) {
            this.#sceneAdmissionTasks.delete(admissionTaskKey);
          }
        });
      }
      const admittedScene = await admissionTask;
      if (projection === 'full-scene') {
        if (
          'projection' in admittedScene ||
          admittedScene.byteCount !== disk.byteCount ||
          admittedScene.payloadSha256 !== entry.scenePayloadSha256
        ) {
          return null;
        }
      } else if (
        !('projection' in admittedScene) ||
        admittedScene.projection !== 'compiled-broad-interaction' ||
        admittedScene.sourceByteCount !== disk.byteCount ||
        admittedScene.sourcePayloadSha256 !== entry.scenePayloadSha256
      ) {
        return null;
      }
      return {
        admission,
        entry,
        localScene,
        scenePath,
        admittedScene,
      };
    } catch (error) {
      console.error('[portable-prepared-reference-scene] admission failed', {
        assemblyId: input.assemblyId,
        trackType: input.artifact.trackType,
        projection,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      return null;
    }
  }

  async #resolveExactScene(input: AssemblyAnnotationSceneReadRequest): Promise<{
    admission: PortableViewAdmission;
    entry: PortablePreparedReferenceViewCatalogEntryV1;
    localScene: LocallyResealedPortableSceneManifest;
    scenePath: string;
    authorizedPayloadRealPath: string;
  } | null> {
    if (input?.ipcContractVersion !== ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT) return null;
    const admission = this.#admissionForRequest(input);
    if (!admission || resolve(input.workspaceRoot) !== admission.familyRoot) return null;
    const entry = admission.entriesByView.get(
      portableViewKeyV1(input.artifact.themeMode, input.artifact.trackType)
    );
    if (
      !entry ||
      entry.sceneArtifactKey !== input.artifact.artifactKey ||
      entry.placementFingerprint !== portablePlacementFingerprintV1(input.scope.placements)
    ) {
      return null;
    }
    const manifestPath = admission.hydration.objectPaths.get(entry.sceneManifestObjectId);
    const scenePath = admission.hydration.objectPaths.get(entry.scenePayloadObjectId);
    if (!manifestPath || !scenePath) return null;
    try {
      const localScene = await readLocallyResealedPortableSceneManifest({
        manifestPath,
        request: input,
        entry,
        legacyLayerIdentityContract:
          admission.definition.preparedBundle?.legacyLayerIdentityContract,
      });
      if (!localScene) return null;
      const authorizedPayloadRealPath = await realpath(scenePath);
      const payloadStat = await stat(authorizedPayloadRealPath);
      if (!payloadStat.isFile() || payloadStat.size !== localScene.disk.byteCount) return null;
      return { admission, entry, localScene, scenePath, authorizedPayloadRealPath };
    } catch {
      return null;
    }
  }

  clearForTest(): void {
    this.#admissions.clear();
    this.#sceneAdmissionTasks.clear();
  }
}

async function portableRoleSidecarIndex(
  admission: PortableViewAdmission,
  localScene: LocallyResealedPortableSceneManifest,
  assemblyId: string
): Promise<AssemblyAnnotationRoleSidecarCacheIndexV1 | undefined> {
  const descriptor = localScene.disk.roleSidecar;
  if (!descriptor) return undefined;
  try {
    if (
      !annotationRoleSidecarDescriptorMatchesSceneV1(descriptor, localScene.publishedManifest, {
        assemblyId,
        fingerprint: localScene.disk.fingerprint,
        companionKey: String(localScene.disk.companionKey),
      })
    ) {
      return undefined;
    }
    const object = admission.hydration.bundle.objects.find(
      (candidate) =>
        candidate.role === 'annotation-role-sidecar' &&
        basename(candidate.installPath) === descriptor.file &&
        candidate.sha256 === descriptor.payloadSha256 &&
        candidate.byteLength === descriptor.byteCount
    );
    const hydratedPath = object ? admission.hydration.objectPaths.get(object.id) : undefined;
    if (!hydratedPath) return undefined;
    const payloadPath = await realpath(hydratedPath);
    if ((await stat(payloadPath)).size !== descriptor.byteCount) return undefined;
    return {
      payloadPath,
      byteCount: descriptor.byteCount,
      payloadSha256: descriptor.payloadSha256,
      roleTable: [...descriptor.roleTable],
      expandedCount: descriptor.expandedCount,
      canonicalCount: descriptor.canonicalCount,
    };
  } catch {
    return undefined;
  }
}

async function admitPortableAnnotationProducts(input: {
  readonly definition: HostedReferenceCatalogDefinitionV1;
  readonly hydration: PortablePreparedReferenceHydrationResult;
  readonly catalog: PortablePreparedReferenceViewCatalogV1;
  readonly entriesByView: ReadonlyMap<string, PortablePreparedReferenceViewCatalogEntryV1>;
  readonly prepared: PreparedReferenceDefinition;
}): Promise<PortableAnnotationProductsAdmission> {
  const productObjects = input.hydration.bundle.objects.filter(
    (object) => object.role === 'annotation-product-set-manifest'
  );
  if (productObjects.length !== 1 && productObjects.length !== 2) {
    throw new Error('Portable prepared-reference bundle must contain the light product set.');
  }
  const productsByTheme = new Map<'dark' | 'light', AssemblyAnnotationProductSetManifestV2>();
  for (const object of productObjects) {
    const value = await readAuthenticatedJsonObject(input.hydration, object);
    const product = parsePortableProductSetV1(
      value,
      input.catalog.sourceFingerprint
    ) as AssemblyAnnotationProductSetManifestV2;
    if (
      productsByTheme.has(product.themeMode) ||
      !portableProductMatchesPreparedDefinitionV1(product, input.prepared)
    ) {
      throw new Error('Portable prepared-reference product inventory is ambiguous.');
    }
    assertPortableProductViewReceiptsV1(product, input.entriesByView);
    productsByTheme.set(product.themeMode, product);
  }
  if (!productsByTheme.has('light')) {
    throw new Error('Portable prepared-reference product themes are incomplete.');
  }
  assertPortableFullThemeProductCoherenceV1(input.catalog, productsByTheme);

  return Object.freeze({ productsByTheme });
}

async function admitPortableSearchProducts(input: {
  readonly definition: HostedReferenceCatalogDefinitionV1;
  readonly hydration: PortablePreparedReferenceHydrationResult;
  readonly catalog: PortablePreparedReferenceViewCatalogV1;
  readonly annotationProducts: PortableAnnotationProductsAdmission;
  readonly admitSearch: (
    job: PortablePreparedReferenceSearchAdmissionWorkerJobV1
  ) => Promise<unknown>;
  readonly skipPayloadAdmission: boolean;
}): Promise<PortableSearchAdmission> {
  const { productsByTheme } = input.annotationProducts;

  const allowLegacyLayerIdentity =
    input.definition.preparedBundle?.legacyLayerIdentityContract ===
    ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN;
  const admittedAnnotationTrackIds = new Set([
    ...productsByTheme.get('light')!.trackTypes,
    ...TRANSCRIPT_GLYPH_INTERNAL_LAYER_TYPES,
  ]);
  const annotationSearch = await admitPortableAnnotationSearch(
    input.hydration,
    input.catalog,
    allowLegacyLayerIdentity,
    admittedAnnotationTrackIds,
    input.admitSearch,
    input.skipPayloadAdmission
  );
  const proteinSearch = await admitPortableProteinSearch(
    input.hydration,
    input.catalog,
    allowLegacyLayerIdentity,
    admittedAnnotationTrackIds,
    input.admitSearch,
    input.skipPayloadAdmission
  );
  for (const product of productsByTheme.values()) {
    if (
      !searchReceiptMatches(
        product.searchIndexes.annotationSearch,
        annotationSearch,
        PREPACKED_ANNOTATION_SEARCH_CONTRACT_TOKEN
      ) ||
      !searchReceiptMatches(
        product.searchIndexes.proteinSearch,
        proteinSearch,
        PREPACKED_PROTEIN_SEARCH_CONTRACT_TOKEN
      )
    ) {
      throw new Error('Portable prepared-reference search receipt does not match its product set.');
    }
  }
  if (
    !portableSamePublishedDatasetContractV1(
      annotationSearch.manifest.datasetContract,
      proteinSearch.manifest.datasetContract
    ) ||
    !portableSamePublishedDatasetContractV1(
      annotationSearch.manifest.datasetContract,
      productsByTheme.get('light')!.datasetContract
    )
  ) {
    throw new Error('Portable prepared-reference products do not share one dataset contract.');
  }

  return Object.freeze({
    annotationSearch,
    proteinSearch,
  });
}

async function admitPortableAnnotationSearch(
  hydration: PortablePreparedReferenceHydrationResult,
  catalog: PortablePreparedReferenceViewCatalogV1,
  allowLegacySearchSemantics: boolean,
  admittedAnnotationTrackIds: ReadonlySet<string>,
  admitSearch: (job: PortablePreparedReferenceSearchAdmissionWorkerJobV1) => Promise<unknown>,
  skipPayloadAdmission: boolean
): Promise<Omit<AssemblyAnnotationSearchCacheIndexHit, 'sourceContinuity'>> {
  const manifestObject = uniqueHydratedObject(hydration, 'annotation-search-manifest');
  const payloadObject = uniqueHydratedObject(hydration, 'annotation-search-payload');
  const value = record(
    await readAuthenticatedJsonObject(hydration, manifestObject.object),
    'portable annotation search manifest'
  );
  onlyKeys(
    value,
    [
      'contract',
      'sourceManifestVersion',
      'sourceFingerprint',
      'version',
      'compilerSemantics',
      'assemblyId',
      'fingerprint',
      'companionKey',
      'placementSignature',
      'payloadFile',
      'byteCount',
      'searchManifest',
    ],
    'portable annotation search manifest'
  );
  const manifest = value.searchManifest as PrepackedAnnotationSearchIndexManifestV1;
  if (
    value.contract !== PORTABLE_ANNOTATION_SEARCH_MANIFEST_V1 ||
    manifestObject.object.contractToken !== PORTABLE_ANNOTATION_SEARCH_MANIFEST_V1 ||
    value.sourceManifestVersion !== ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2 ||
    value.version !== ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2 ||
    !portableCompilerSemanticsIsAdmitted(
      value.compilerSemantics,
      ASSEMBLY_ANNOTATION_SEARCH_COMPILER_SEMANTICS_V2,
      ASSEMBLY_ANNOTATION_SEARCH_LEGACY_COMPILER_SEMANTICS_V2,
      allowLegacySearchSemantics,
      ASSEMBLY_ANNOTATION_SEARCH_PREVIOUS_COMPILER_SEMANTICS_V2
    ) ||
    value.assemblyId !== hydration.bundle.assembly.id ||
    value.sourceFingerprint !== catalog.sourceFingerprint ||
    !SOURCE_FINGERPRINT.test(String(value.fingerprint)) ||
    !SHA256.test(String(value.companionKey)) ||
    basename(manifestObject.object.installPath) !==
      `annotation-search-${String(value.companionKey)}.v2.json` ||
    value.payloadFile !== basename(payloadObject.object.installPath) ||
    value.byteCount !== payloadObject.object.byteLength ||
    payloadObject.object.contractToken !== PREPACKED_ANNOTATION_SEARCH_CONTRACT_TOKEN ||
    manifest?.schema !== PREPACKED_ANNOTATION_SEARCH_INDEX_V1 ||
    manifest.searchContract?.contractToken !== PREPACKED_ANNOTATION_SEARCH_CONTRACT_TOKEN ||
    manifest.assemblyContract?.assemblyId !== hydration.bundle.assembly.id ||
    manifest.assemblyContract.assemblyLengthBp !== hydration.bundle.assembly.assemblyLengthBp ||
    manifest.assemblyContract.placementSignature !== value.placementSignature ||
    manifest.assemblyContract.sourceFingerprint !== value.fingerprint ||
    manifest.byteLength !== value.byteCount ||
    manifest.integrity?.payloadSha256 !== payloadObject.object.sha256
  ) {
    throw new Error('Portable annotation search manifest identity is invalid.');
  }
  if (!skipPayloadAdmission) {
    await admitSearch({
      contract: portablePreparedReferenceSearchAdmissionWorkerContractV1(),
      kind: 'annotation',
      payloadPath: payloadObject.path,
      authorizedPayloadRealPath: await realpath(payloadObject.path),
      manifest,
      admittedAnnotationTrackIds: [...admittedAnnotationTrackIds],
    });
  }
  const payloadIdentity = await localPayloadIdentity(payloadObject.path, payloadObject.object);
  return Object.freeze({
    status: 'hit',
    fingerprint: String(value.fingerprint),
    byteCount: payloadObject.object.byteLength,
    manifest,
    payloadPath: payloadObject.path,
    payloadSha256: payloadObject.object.sha256,
    payloadIdentity,
  });
}

async function admitPortableProteinSearch(
  hydration: PortablePreparedReferenceHydrationResult,
  catalog: PortablePreparedReferenceViewCatalogV1,
  allowLegacySearchSemantics: boolean,
  admittedAnnotationTrackIds: ReadonlySet<string>,
  admitSearch: (job: PortablePreparedReferenceSearchAdmissionWorkerJobV1) => Promise<unknown>,
  skipPayloadAdmission: boolean
): Promise<Omit<AssemblyProteinSearchCacheIndexHit, 'sourceContinuity'>> {
  const manifestObject = uniqueHydratedObject(hydration, 'protein-search-manifest');
  const payloadObject = uniqueHydratedObject(hydration, 'protein-search-payload');
  const value = record(
    await readAuthenticatedJsonObject(hydration, manifestObject.object),
    'portable protein search manifest'
  );
  onlyKeys(
    value,
    [
      'contract',
      'sourceManifestVersion',
      'sourceFingerprint',
      'version',
      'assemblyId',
      'fingerprint',
      'companionKey',
      'placementSignature',
      'payloadFile',
      'byteCount',
      'searchManifest',
      'compilerSemantics',
      'work',
    ],
    'portable protein search manifest'
  );
  const manifest = value.searchManifest as PrepackedProteinSearchIndexManifestV1;
  if (
    value.contract !== PORTABLE_PROTEIN_SEARCH_MANIFEST_V1 ||
    manifestObject.object.contractToken !== PORTABLE_PROTEIN_SEARCH_MANIFEST_V1 ||
    value.sourceManifestVersion !== ASSEMBLY_PROTEIN_SEARCH_CACHE_V1 ||
    value.version !== ASSEMBLY_PROTEIN_SEARCH_CACHE_V1 ||
    !portableCompilerSemanticsIsAdmitted(
      value.compilerSemantics,
      ASSEMBLY_PROTEIN_SEARCH_COMPILER_SEMANTICS_V2,
      ASSEMBLY_PROTEIN_SEARCH_LEGACY_COMPILER_SEMANTICS_V2,
      allowLegacySearchSemantics,
      ASSEMBLY_PROTEIN_SEARCH_PREVIOUS_COMPILER_SEMANTICS_V2
    ) ||
    value.assemblyId !== hydration.bundle.assembly.id ||
    value.sourceFingerprint !== catalog.sourceFingerprint ||
    !SOURCE_FINGERPRINT.test(String(value.fingerprint)) ||
    !SHA256.test(String(value.companionKey)) ||
    basename(manifestObject.object.installPath) !==
      `protein-search-${String(value.companionKey)}.v1.json` ||
    value.payloadFile !== basename(payloadObject.object.installPath) ||
    value.byteCount !== payloadObject.object.byteLength ||
    payloadObject.object.contractToken !== PREPACKED_PROTEIN_SEARCH_CONTRACT_TOKEN ||
    manifest?.schema !== PREPACKED_PROTEIN_SEARCH_INDEX_V1 ||
    manifest.searchContract?.contractToken !== PREPACKED_PROTEIN_SEARCH_CONTRACT_TOKEN ||
    manifest.assemblyContract?.assemblyId !== hydration.bundle.assembly.id ||
    manifest.assemblyContract.assemblyLengthBp !== hydration.bundle.assembly.assemblyLengthBp ||
    manifest.assemblyContract.placementSignature !== value.placementSignature ||
    manifest.assemblyContract.sourceFingerprint !== value.fingerprint ||
    manifest.byteLength !== value.byteCount ||
    manifest.integrity?.payloadSha256 !== payloadObject.object.sha256 ||
    !isProteinSearchCompilerWorkV1(value.work, manifest.featureCount)
  ) {
    throw new Error('Portable protein search manifest identity is invalid.');
  }
  if (!skipPayloadAdmission) {
    await admitSearch({
      contract: portablePreparedReferenceSearchAdmissionWorkerContractV1(),
      kind: 'protein',
      payloadPath: payloadObject.path,
      authorizedPayloadRealPath: await realpath(payloadObject.path),
      manifest,
      admittedAnnotationTrackIds: [...admittedAnnotationTrackIds],
    });
  }
  const payloadIdentity = await localPayloadIdentity(payloadObject.path, payloadObject.object);
  return Object.freeze({
    status: 'hit',
    fingerprint: String(value.fingerprint),
    byteCount: payloadObject.object.byteLength,
    work: value.work as ProteinSearchCompilerWorkV1,
    manifest,
    payloadPath: payloadObject.path,
    payloadSha256: payloadObject.object.sha256,
    payloadIdentity,
  });
}

export function portableCompilerSemanticsIsAdmitted(
  observed: unknown,
  current: string,
  legacy: string,
  allowLegacy: boolean,
  previous: readonly string[] = []
): boolean {
  return (
    observed === current ||
    previous.some((value) => observed === value) ||
    (allowLegacy && observed === legacy)
  );
}

export { assertPortableSearchResultIdentity };

async function localPayloadIdentity(
  path: string,
  object: PortablePreparedReferenceObjectV1
): Promise<AssemblyAnnotationSearchPayloadIdentityV2> {
  const identity = payloadIdentityFromFileStat(await stat(path, { bigint: true }));
  if (!identity || identity.size !== String(object.byteLength)) {
    throw new Error(`Portable search payload identity is invalid: ${object.id}`);
  }
  return identity;
}

function searchReceiptMatches(
  value: unknown,
  hit:
    | Omit<AssemblyAnnotationSearchCacheIndexHit, 'sourceContinuity'>
    | Omit<AssemblyProteinSearchCacheIndexHit, 'sourceContinuity'>,
  contractToken: string
): boolean {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  return (
    receipt.fingerprint === hit.fingerprint &&
    receipt.byteCount === hit.byteCount &&
    receipt.payloadSha256 === hit.payloadSha256 &&
    receipt.contractSha256 === hit.manifest.integrity.contractSha256 &&
    receipt.schema === hit.manifest.schema &&
    receipt.contractToken === contractToken
  );
}

async function readAuthenticatedJsonObject(
  hydration: PortablePreparedReferenceHydrationResult,
  object: PortablePreparedReferenceObjectV1
): Promise<unknown> {
  const path = canonicalHydratedObjectPath(hydration, object);
  const bytes = await readFile(path);
  if (
    bytes.byteLength !== object.byteLength ||
    createHash('sha256').update(bytes).digest('hex') !== object.sha256
  ) {
    throw new Error(`Portable prepared-reference object changed after hydration: ${object.id}`);
  }
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

function uniqueHydratedObject(
  hydration: PortablePreparedReferenceHydrationResult,
  role: PortablePreparedReferenceObjectV1['role']
): Readonly<{ object: PortablePreparedReferenceObjectV1; path: string }> {
  const objects = hydration.bundle.objects.filter((object) => object.role === role);
  if (objects.length !== 1) {
    throw new Error(`Portable prepared-reference bundle has no unique ${role}.`);
  }
  return { object: objects[0], path: canonicalHydratedObjectPath(hydration, objects[0]) };
}

function portableViewAdmissionReceiptInput(input: {
  readonly definition: HostedReferenceCatalogDefinitionV1;
  readonly hydration: PortablePreparedReferenceHydrationResult;
  readonly runtimeSourceFingerprint: string;
}): PortablePreparedReferenceViewAdmissionReceiptInputV1 {
  const annotation = uniqueHydratedObject(input.hydration, 'annotation-search-payload');
  const protein = uniqueHydratedObject(input.hydration, 'protein-search-payload');
  return {
    generationRoot: input.hydration.generationRoot,
    assemblyId: input.definition.id,
    bundleFingerprint: input.hydration.bundle.bundleFingerprint,
    runtimeSourceFingerprint: input.runtimeSourceFingerprint,
    payloads: [
      {
        kind: 'annotation',
        objectId: annotation.object.id,
        installPath: annotation.object.installPath,
        path: annotation.path,
        byteLength: annotation.object.byteLength,
        sha256: annotation.object.sha256,
      },
      {
        kind: 'protein',
        objectId: protein.object.id,
        installPath: protein.object.installPath,
        path: protein.path,
        byteLength: protein.object.byteLength,
        sha256: protein.object.sha256,
      },
    ],
  };
}

function canonicalHydratedObjectPath(
  hydration: PortablePreparedReferenceHydrationResult,
  object: PortablePreparedReferenceObjectV1
): string {
  const path = hydration.objectPaths.get(object.id);
  const expected = resolve(hydration.generationRoot, object.installPath);
  if (!path || resolve(path) !== expected) {
    throw new Error(`Portable prepared-reference object is not in its generation: ${object.id}`);
  }
  return expected;
}

function requestMatchesPortableProduct(
  request: AssemblyAnnotationSceneReadRequest,
  admission: PortableViewAdmission,
  product: AssemblyAnnotationProductSetManifestV2
): boolean {
  return portableRequestMatchesProductV1(
    request,
    {
      prepared: admission.prepared,
      familyRoot: admission.familyRoot,
      generationRoot: admission.hydration.generationRoot,
    },
    product,
    resolve
  );
}

async function assertPortableSourcePath(
  path: string,
  admission: PortableViewAdmission
): Promise<void> {
  if (!admission.prepared) {
    throw new Error('Portable search source definition is unavailable.');
  }
  const candidate = resolve(path);
  const allowed = admission.prepared.members.some((member) =>
    [
      member.manifest.fastaPath,
      member.manifest.faiPath,
      member.manifest.gffPath,
      member.manifest.tbiPath,
    ]
      .filter((relativePath): relativePath is string => typeof relativePath === 'string')
      .some(
        (relativePath) => resolve(admission.hydration.generationRoot, relativePath) === candidate
      )
  );
  if (!allowed) throw new Error('Portable search source path is outside its admitted generation.');
}

const PROTEIN_SEARCH_QUARANTINE_REASONS_V1: ReadonlySet<ProteinSearchIsoformQuarantineReasonV1> =
  new Set([
    'unknown-strand',
    'invalid-cds-bounds',
    'overlapping-cds-segments',
    'invalid-genetic-code',
    'conflicting-genetic-codes',
    'unsupported-genetic-code',
    'invalid-leading-frame',
    'invalid-source-translation',
    'source-translation-exceeds-cds',
    'empty-derived-translation',
    'fasta-read-length-mismatch',
  ]);

function isProteinSearchCompilerWorkV1(
  value: unknown,
  featureCount: unknown
): value is ProteinSearchCompilerWorkV1 {
  if (!value || typeof value !== 'object') return false;
  const work = value as Partial<ProteinSearchCompilerWorkV1>;
  if (
    !isNonnegativeSafeInteger(featureCount) ||
    !isNonnegativeSafeInteger(work.transcriptCount) ||
    !isNonnegativeSafeInteger(work.sourceTranslationCount) ||
    !isNonnegativeSafeInteger(work.derivedTranslationCount) ||
    !isNonnegativeSafeInteger(work.skippedEmptyTranslationCount) ||
    !isNonnegativeSafeInteger(work.quarantinedIsoformCount) ||
    !Array.isArray(work.quarantinedIsoforms) ||
    work.quarantinedIsoforms.length > ASSEMBLY_PROTEIN_SEARCH_MAX_QUARANTINE_DIAGNOSTICS_V1 ||
    typeof work.quarantineDiagnosticsTruncated !== 'boolean' ||
    work.sourceTranslationCount + work.derivedTranslationCount !== featureCount ||
    work.transcriptCount !== featureCount + work.quarantinedIsoformCount ||
    work.skippedEmptyTranslationCount > work.quarantinedIsoformCount ||
    work.quarantinedIsoforms.length !==
      Math.min(
        work.quarantinedIsoformCount,
        ASSEMBLY_PROTEIN_SEARCH_MAX_QUARANTINE_DIAGNOSTICS_V1
      ) ||
    work.quarantineDiagnosticsTruncated !==
      work.quarantinedIsoformCount > ASSEMBLY_PROTEIN_SEARCH_MAX_QUARANTINE_DIAGNOSTICS_V1
  ) {
    return false;
  }
  return work.quarantinedIsoforms.every((diagnostic) => {
    if (!diagnostic || typeof diagnostic !== 'object') return false;
    const candidate = diagnostic as Partial<
      ProteinSearchCompilerWorkV1['quarantinedIsoforms'][number]
    >;
    return (
      typeof candidate.chrom === 'string' &&
      candidate.chrom.length > 0 &&
      typeof candidate.source === 'string' &&
      candidate.source.length > 0 &&
      typeof candidate.isoformId === 'string' &&
      candidate.isoformId.length > 0 &&
      typeof candidate.reason === 'string' &&
      PROTEIN_SEARCH_QUARANTINE_REASONS_V1.has(
        candidate.reason as ProteinSearchIsoformQuarantineReasonV1
      )
    );
  });
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error(`${label} fields are invalid.`);
  }
}

function portableDerivedSceneCompanionPaths(input: {
  sceneManifestPath: string;
  bundleFingerprint: string;
  entry: PortablePreparedReferenceViewCatalogEntryV1;
  localContractSha256: string;
}): Readonly<{ directory: string; stem: string; manifestPath: string }> {
  const directory = join(
    dirname(input.sceneManifestPath),
    PORTABLE_DERIVED_SCENE_COMPANION_DIRECTORY
  );
  const stem = createHash('sha256')
    .update(
      [
        PORTABLE_DERIVED_SCENE_COMPANIONS_V1,
        input.bundleFingerprint,
        input.entry.scenePayloadSha256,
        input.localContractSha256,
      ].join('\u0000')
    )
    .digest('hex');
  return Object.freeze({
    directory,
    stem,
    manifestPath: join(directory, `${stem}.json`),
  });
}

function portableDerivedCompactFileName(stem: string, payloadSha256: unknown): string {
  return SHA256.test(String(payloadSha256))
    ? `${stem}-${String(payloadSha256)}.compiled-broad-interaction.v1.bin`
    : '';
}

export const portablePreparedReferenceViewAuthorityV1 =
  new PortablePreparedReferenceViewAuthorityV1();

function admissionKey(familyRoot: string, assemblyId: string): string {
  return `${resolve(familyRoot)}\0${assemblyId}`;
}

type LocallyResealedPortableSceneManifest = LocallyResealedPortableSceneManifestV1;

async function readLocallyResealedPortableSceneManifest(input: {
  readonly manifestPath: string;
  readonly request: AssemblyAnnotationSceneReadRequest;
  readonly entry: PortablePreparedReferenceViewCatalogEntryV1;
  readonly legacyLayerIdentityContract?: typeof ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN;
}): Promise<LocallyResealedPortableSceneManifest | null> {
  try {
    return await resealPortableSceneDiskManifestV1({
      disk: JSON.parse(await readFile(input.manifestPath, 'utf8')) as PortableSceneDiskManifestV1,
      request: input.request,
      entry: input.entry,
      legacyLayerIdentityContract: input.legacyLayerIdentityContract,
    });
  } catch {
    return null;
  }
}
