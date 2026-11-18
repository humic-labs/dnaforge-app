import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { CompiledBroadSurfaceManifestV2 } from '@waypoint/genome-renderer/pure';

import {
  COMPILED_BROAD_RASTER_MANIFEST_FILE_V1,
  openCompiledBroadRasterArtifactV1,
  type CompiledBroadRasterCellAddressV1,
  type CompiledBroadRasterCellPayloadV1,
  type CompiledBroadRasterCellRecordV1,
  type CompiledBroadRasterArtifactReaderV1,
} from '../ipc/compiled-broad-raster-artifact';
import type {
  HostedReferenceCatalogDefinitionV1,
  HostedReferenceFirstViewPackAssetV1,
  HostedReferenceFullTierShardsAssetV1,
} from './hosted-reference-catalog';
import {
  HostedReferenceTransportError,
  isRetryableHostedReferenceTransportError,
  requestHostedReferenceAsset,
  resolveHostedReferenceAssetUrl,
  type HostedReferenceFetch,
} from './hosted-reference-transport';
import {
  parsePortablePreparedReferenceBundleV1,
  portablePreparedReferenceContentObjectKeyV1,
  portablePreparedReferenceObjectsForTierV1,
  type PortablePreparedReferenceBundleV1,
  type PortablePreparedReferenceObjectV1,
  type PortablePreparedReferenceReadinessTierV1,
} from './portable-prepared-reference-bundle';
import {
  admitPortablePreparedReferenceFirstViewPackDescriptorV1,
  parsePortablePreparedReferenceFirstViewPackV1,
} from './portable-prepared-reference-first-view-pack';
import {
  admitPortablePreparedReferenceFullTierShardsDescriptorV1,
  parsePortablePreparedReferenceFullTierShardV1,
  portablePreparedReferenceFullTierShardPlanV1,
} from './portable-prepared-reference-full-tier-shards';
import {
  hostedObjectSatisfiedByBgzfFastaMigration,
  isUncompressedPreparedFastaIndexInstallPath,
  isUncompressedPreparedFastaInstallPath,
  migrateUncompressedFastaBundle,
  type BgzfFastaMigrationResult,
  type MigrateUncompressedFastaBundleInput,
} from './bgzf-fasta-migration';
import {
  REFERENCE_PREPARATION_PIPELINE_REVISION,
  REFERENCE_PREPARATION_PIPELINE_REVISION_V2,
  REFERENCE_PREPARATION_PIPELINE_REVISION_V3,
} from './reference-preparation-manifest';

const DEFAULT_CONCURRENCY = 6;
const MAX_CONCURRENCY = 16;
const MAX_CONTENT_OBJECT_DOWNLOAD_ATTEMPTS = 7;
const CONTENT_OBJECT_RETRY_BASE_DELAY_MS = 1_000;
const CONTENT_OBJECT_RETRY_MAX_DELAY_MS = 30_000;
const OBJECT_CACHE_DIRECTORY = '.portable-reference-objects';
const VERIFIED_OBJECT_RECEIPT_V1 = 'dnaforge-verified-content-object.v1';
const PREPARED_REFERENCE_TIER_ADMISSION_V2 =
  'dnaforge-portable-prepared-reference-tier-admission.v2';
const PACKED_FIRST_VIEW_ADMISSION_V1 = 'dnaforge-packed-first-view-admission.v1';
const PACKED_FULL_TIER_ADMISSION_V1 = 'dnaforge-packed-full-tier-admission.v1';
const inFlightObjects = new Map<string, Promise<ContentObjectResult>>();
const inFlightRasterMaterializations = new Map<string, Promise<void>>();
const inFlightFirstViewGenerations = new Map<
  string,
  Promise<PackedFirstViewMaterialization | null>
>();
const inFlightFullTierGenerations = new Map<
  string,
  Promise<PackedFullTierMaterialization | null>
>();
const SUPPORTED_REFERENCE_PREPARATION_PIPELINE_REVISIONS = new Set<number>([
  REFERENCE_PREPARATION_PIPELINE_REVISION,
  REFERENCE_PREPARATION_PIPELINE_REVISION_V2,
  REFERENCE_PREPARATION_PIPELINE_REVISION_V3,
]);

export interface PortablePreparedReferenceHydrationProgress {
  readonly phase: 'manifest' | 'transport' | 'expanding' | 'objects' | 'materializing' | 'ready';
  readonly completedBytes: number;
  readonly totalBytes: number;
  readonly completedObjects: number;
  readonly totalObjects: number;
  readonly reusedObjects: number;
}

export interface PortablePreparedReferenceHydrationResult {
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly generationRoot: string;
  readonly hydratedTiers: readonly PortablePreparedReferenceReadinessTierV1[];
  readonly objectPaths: ReadonlyMap<string, string>;
}

export interface PortablePreparedReferenceHydrator {
  inspectCached(input: {
    readonly definition: HostedReferenceCatalogDefinitionV1;
    readonly tiers: readonly PortablePreparedReferenceReadinessTierV1[];
  }): Promise<PortablePreparedReferenceHydrationResult | null>;
  hydrate(input: {
    readonly definition: HostedReferenceCatalogDefinitionV1;
    readonly tiers: readonly PortablePreparedReferenceReadinessTierV1[];
    readonly includeCachedTiers?: readonly PortablePreparedReferenceReadinessTierV1[];
    readonly reuseSequenceFrom?: PortablePreparedReferenceHydrationResult;
    readonly onProgress?: (progress: PortablePreparedReferenceHydrationProgress) => void;
  }): Promise<PortablePreparedReferenceHydrationResult>;
  hydrateBroadRasterCells(input: {
    readonly definition: HostedReferenceCatalogDefinitionV1;
    readonly hydration: PortablePreparedReferenceHydrationResult;
    readonly manifestObjectId: string;
    readonly expectedSurfaceManifestFingerprint: string;
    readonly admittedReader?: CompiledBroadRasterArtifactReaderV1;
    readonly addresses: readonly CompiledBroadRasterCellAddressV1[];
    readonly onProgress?: (progress: PortablePreparedReferenceHydrationProgress) => void;
  }): Promise<readonly CompiledBroadRasterCellPayloadV1[]>;
}

export interface PortablePreparedReferenceHydratorInstrumentation {
  readonly onPayloadHashRead?: (path: string) => void;
  readonly onIndividualObjectMaterialization?: (path: string) => void;
  readonly onPackedFirstViewGenerationCommit?: (input: {
    readonly generationRoot: string;
    readonly memberCount: number;
  }) => void;
  readonly onContentObjectTransfer?: (event: PortablePreparedReferenceTransferEvent) => void;
}

export interface PortablePreparedReferenceTransferEvent {
  readonly referenceId: string;
  readonly objectKey: string;
  readonly objectSha256: string;
  readonly attempt: number;
  readonly resumedFromBytes: number;
  readonly bytesTransferred: number;
  readonly expectedBytes: number;
  readonly responseStatus: number | null;
  readonly contentRange: string | null;
  readonly elapsedMs: number;
  readonly outcome: 'cache-hit' | 'success' | 'retryable-failure' | 'terminal-failure';
  readonly errorClass: 'abort' | 'transport' | 'type-error' | 'error' | 'unknown' | null;
}

function parseHostedBundle(
  bytes: Buffer,
  definition: HostedReferenceCatalogDefinitionV1
): PortablePreparedReferenceBundleV1 {
  const bundle = parsePortablePreparedReferenceBundleV1(
    JSON.parse(bytes.toString('utf8')) as unknown,
    {
      assemblyId: definition.id,
      assetCacheKey: definition.id,
      assemblyLengthBp: definition.contigs.reduce((total, contig) => total + contig.lengthBp, 0),
      contigCount: definition.contigs.length,
      source: {
        fastaSha256: definition.sources.fasta.sha256,
        gffSha256: definition.sources.annotations.sha256,
      },
    }
  );
  if (
    !SUPPORTED_REFERENCE_PREPARATION_PIPELINE_REVISIONS.has(
      bundle.assembly.preparationPipelineRevision
    )
  ) {
    throw new Error(
      'portable prepared reference bundle pipeline revision is incompatible with this client.'
    );
  }
  return bundle;
}

export function createPortablePreparedReferenceHydrator(input: {
  readonly cacheRoot: string;
  readonly assetBaseUrl: URL;
  readonly fetchAsset?: HostedReferenceFetch;
  readonly concurrency?: number;
  readonly instrumentation?: PortablePreparedReferenceHydratorInstrumentation;
  readonly indexerBinary?: string;
  readonly migrateUncompressedFasta?: (
    input: MigrateUncompressedFastaBundleInput
  ) => Promise<BgzfFastaMigrationResult>;
}): PortablePreparedReferenceHydrator {
  const configuredCacheRoot = resolve(input.cacheRoot);
  const fetchAsset = input.fetchAsset ?? globalThis.fetch;
  const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY;
  const instrumentation = input.instrumentation;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(
      `Portable reference hydration concurrency must be between 1 and ${MAX_CONCURRENCY}.`
    );
  }
  const transferScheduler = createContentObjectTransferScheduler(concurrency);
  const indexerBinary = input.indexerBinary;
  const migrateUncompressedFasta = input.migrateUncompressedFasta ?? migrateUncompressedFastaBundle;
  const migrateHostedUncompressedFasta = Boolean(
    input.migrateUncompressedFasta || input.indexerBinary
  );

  const inspectCached: PortablePreparedReferenceHydrator['inspectCached'] = async ({
    definition,
    tiers,
  }) => {
    try {
      const manifestAdmission = definition.preparedBundle?.manifest;
      if (
        !manifestAdmission ||
        manifestAdmission.relativePath !==
          portablePreparedReferenceContentObjectKeyV1(manifestAdmission.sha256)
      )
        return null;
      await requirePlainDirectory(configuredCacheRoot, 'Portable reference cache root');
      const cacheRoot = await realpath(configuredCacheRoot);
      const manifestPath = contentObjectCachePath(cacheRoot, manifestAdmission.sha256);
      await assertOwnedPathAncestry(cacheRoot, manifestPath, 'Portable cached manifest');
      const before = await stableRegularFileStat(manifestPath);
      if (
        !before ||
        BigInt(before.size) !== BigInt(manifestAdmission.byteLength) ||
        !(await verifiedReceiptMatches(manifestPath, manifestAdmission, before))
      )
        return null;
      const bytes = await readFile(manifestPath);
      const after = await stableRegularFileStat(manifestPath);
      if (!after || !sameStableStat(before, after)) return null;
      const bundle = parseHostedBundle(bytes, definition);
      const generationRoot = portableGenerationRoot(cacheRoot, bundle);
      const uniqueTiers = [...new Set(tiers)];
      const objectsByTier = new Map(
        uniqueTiers.map((tier) => [tier, portablePreparedReferenceObjectsForTierV1(bundle, tier)])
      );
      const objectPaths = new Map<string, string>();
      const tierIsCovered = (tier: PortablePreparedReferenceReadinessTierV1) =>
        objectsByTier.get(tier)?.every(({ id }) => objectPaths.has(id)) === true;
      for (const tier of ['search', 'detail', 'view', 'shell'] as const) {
        if (!objectsByTier.has(tier) || tierIsCovered(tier)) continue;
        const admission = await admitExistingTierGeneration({
          ownershipRoot: cacheRoot,
          generationRoot,
          bundleManifestSha256: manifestAdmission.sha256,
          bundle,
          tier,
          concurrency,
        });
        if (admission) for (const [id, path] of admission) objectPaths.set(id, path);
      }
      const hydratedTiers = uniqueTiers.filter(tierIsCovered);
      if (hydratedTiers.length === 0) return null;
      return { bundle, generationRoot, hydratedTiers, objectPaths };
    } catch {
      return null;
    }
  };

  return {
    inspectCached,
    async hydrate({ definition, tiers, includeCachedTiers, reuseSequenceFrom, onProgress }) {
      if (tiers.length > 0 && includeCachedTiers?.length) {
        const cached = await inspectCached({
          definition,
          tiers: [...tiers, ...includeCachedTiers],
        });
        if (
          cached &&
          tierObjectUnion(cached.bundle, tiers).every(({ id }) => cached.objectPaths.has(id))
        ) {
          return { ...cached, hydratedTiers: [...new Set([...tiers, ...cached.hydratedTiers])] };
        }
      }
      const cacheRoot = await ensureCanonicalOwnedCacheRoot(configuredCacheRoot);
      if (!definition.preparedBundle) {
        throw new Error(`Hosted reference ${definition.id} has no prepared bundle.`);
      }
      const uniqueTiers = [...new Set(tiers)];
      if (uniqueTiers.length === 0) {
        throw new Error('Portable reference hydration requires at least one readiness tier.');
      }
      const manifestAdmission = definition.preparedBundle.manifest;
      const expectedManifestKey = portablePreparedReferenceContentObjectKeyV1(
        manifestAdmission.sha256
      );
      if (manifestAdmission.relativePath !== expectedManifestKey) {
        throw new Error('Prepared bundle manifest is not at its canonical content-addressed key.');
      }

      const abortController = new AbortController();
      const manifest = await ensureContentObject({
        referenceId: definition.id,
        cacheRoot,
        assetBaseUrl: input.assetBaseUrl,
        fetchAsset,
        signal: abortController.signal,
        object: {
          objectKey: manifestAdmission.relativePath,
          sha256: manifestAdmission.sha256,
          byteLength: manifestAdmission.byteLength,
        },
        label: `${definition.name} prepared bundle manifest`,
        onDownloadedBytes: () => undefined,
        instrumentation,
        transferScheduler,
      });
      onProgress?.({
        phase: 'manifest',
        completedBytes: manifestAdmission.byteLength,
        totalBytes: manifestAdmission.byteLength,
        completedObjects: 1,
        totalObjects: 1,
        reusedObjects: manifest.reused ? 1 : 0,
      });

      const bundle = parseHostedBundle(await readFile(manifest.path), definition);

      const objects = tierObjectUnion(bundle, uniqueTiers);
      const generationRoot = portableGenerationRoot(cacheRoot, bundle);
      await assertOwnedPathAncestry(cacheRoot, generationRoot, 'Portable bundle generation');
      const admittedTierPaths = new Map<string, string>();
      const annotationOnly =
        reuseSequenceFrom !== undefined &&
        reuseSequenceFrom.bundle.bundleFingerprint !== bundle.bundleFingerprint &&
        reuseSequenceFrom.bundle.assembly.source.fastaSha256 === bundle.assembly.source.fastaSha256;
      if (annotationOnly) {
        const previousByDigest = new Map(
          reuseSequenceFrom.bundle.objects
            .filter((object) => object.role === 'fasta' || object.role === 'fasta-index')
            .map((object) => [`${object.role}:${object.sha256}:${object.byteLength}`, object])
        );
        for (const object of objects.filter(
          (candidate) => candidate.role === 'fasta' || candidate.role === 'fasta-index'
        )) {
          const previous = previousByDigest.get(
            `${object.role}:${object.sha256}:${object.byteLength}`
          );
          const previousPath = previous && reuseSequenceFrom.objectPaths.get(previous.id);
          if (!previousPath || !(await admitVerifiedFile(previousPath, object, instrumentation))) {
            throw new Error(
              `Annotation-only update cannot reuse the admitted sequence object ${object.id}.`
            );
          }
          const destinationPath = resolve(generationRoot, object.installPath);
          assertAtOrBelow(generationRoot, destinationPath, 'Reused sequence object');
          await ensureOwnedDirectoryTree(
            cacheRoot,
            dirname(destinationPath),
            'Reused sequence directory'
          );
          if (!(await admitVerifiedFile(destinationPath, object, instrumentation))) {
            const before = await stableRegularFileStat(previousPath);
            const temporaryPath = `${destinationPath}.${randomUUID()}.tmp`;
            try {
              try {
                await copyFile(previousPath, temporaryPath, fsConstants.COPYFILE_FICLONE_FORCE);
              } catch {
                await copyFile(previousPath, temporaryPath);
              }
              const after = await stableRegularFileStat(previousPath);
              if (!before || !after || !sameStableStat(before, after))
                throw new Error('Reused sequence changed during materialization.');
              await rename(temporaryPath, destinationPath);
              await sealVerifiedFile(destinationPath, object);
            } finally {
              await rm(temporaryPath, { force: true });
            }
          }
          admittedTierPaths.set(object.id, destinationPath);
        }
      }
      await Promise.all(
        uniqueTiers.map(async (tier) => {
          const admitted = await admitExistingTierGeneration({
            ownershipRoot: cacheRoot,
            generationRoot,
            bundleManifestSha256: manifestAdmission.sha256,
            bundle,
            tier,
            concurrency,
          });
          if (!admitted) return;
          for (const [id, path] of admitted) admittedTierPaths.set(id, path);
        })
      );
      if (objects.every(({ id }) => admittedTierPaths.has(id))) {
        const totalBytes = objects.reduce((total, object) => total + object.byteLength, 0);
        onProgress?.({
          phase: 'ready',
          completedBytes: totalBytes,
          totalBytes,
          completedObjects: objects.length,
          totalObjects: objects.length,
          reusedObjects: objects.length,
        });
        return {
          bundle,
          generationRoot,
          hydratedTiers: Object.freeze(uniqueTiers),
          objectPaths: admittedTierPaths,
        };
      }
      const packedFirstView = annotationOnly
        ? null
        : await tryMaterializeFirstViewPack({
            cacheRoot,
            assetBaseUrl: input.assetBaseUrl,
            fetchAsset,
            signal: abortController.signal,
            definition,
            bundleManifestSha256: manifestAdmission.sha256,
            bundle,
            requestedObjects: objects,
            concurrency,
            transferScheduler,
            instrumentation,
            onProgress,
          });
      const packedFullTier = annotationOnly
        ? null
        : await tryMaterializeFullTierShards({
            cacheRoot,
            assetBaseUrl: input.assetBaseUrl,
            fetchAsset,
            signal: abortController.signal,
            definition,
            bundleManifestSha256: manifestAdmission.sha256,
            bundle,
            requestedObjects: objects,
            concurrency,
            transferScheduler,
            instrumentation,
            onProgress,
          });
      const totalBytes = objects.reduce((total, object) => total + object.byteLength, 0);
      const packedObjectIds = new Set([
        ...admittedTierPaths.keys(),
        ...(packedFirstView?.objectPaths.keys() ?? []),
      ]);
      const packedFullTierObjectIds = new Set(packedFullTier?.objectPaths.keys() ?? []);
      const migratedObjectIds = new Set<string>();
      await Promise.all(
        objects.map(async (object) => {
          if (
            await hostedObjectSatisfiedByBgzfFastaMigration({
              generationRoot,
              object,
            })
          ) {
            migratedObjectIds.add(object.id);
          }
        })
      );
      const objectsRequiringDownload = objects.filter(
        ({ id }) =>
          !packedObjectIds.has(id) && !packedFullTierObjectIds.has(id) && !migratedObjectIds.has(id)
      );
      const objectsRequiringMaterialization = objects.filter(
        ({ id }) =>
          !packedObjectIds.has(id) && !packedFullTierObjectIds.has(id) && !migratedObjectIds.has(id)
      );
      const completedObjectIds = new Set([...packedObjectIds, ...packedFullTierObjectIds]);
      let completedBytes = objects
        .filter(({ id }) => completedObjectIds.has(id))
        .reduce((total, object) => total + object.byteLength, 0);
      let completedObjects = completedObjectIds.size;
      const reusedObjectIds = new Set(admittedTierPaths.keys());
      if (packedFirstView?.reused) {
        for (const id of packedFirstView.objectPaths.keys()) reusedObjectIds.add(id);
      }
      if (packedFullTier?.reused) {
        for (const id of packedFullTier.objectPaths.keys()) reusedObjectIds.add(id);
      }
      let reusedObjects = reusedObjectIds.size;
      const emitObjectsProgress = (): void =>
        onProgress?.({
          phase: 'objects',
          completedBytes,
          totalBytes,
          completedObjects,
          totalObjects: objects.length,
          reusedObjects,
        });
      emitObjectsProgress();

      const objectCachePaths = new Map<string, string>();
      try {
        await runBounded(objectsRequiringDownload, concurrency, async (object) => {
          const result = await ensureContentObject({
            referenceId: definition.id,
            cacheRoot,
            assetBaseUrl: input.assetBaseUrl,
            fetchAsset,
            signal: abortController.signal,
            object,
            label: `${definition.name} prepared object ${object.id}`,
            onDownloadedBytes(bytes) {
              completedBytes += bytes;
              emitObjectsProgress();
            },
            instrumentation,
            transferScheduler,
          });
          if (result.reused) {
            completedBytes += object.byteLength;
            reusedObjects += 1;
          }
          completedObjects += 1;
          objectCachePaths.set(object.id, result.path);
          emitObjectsProgress();
        });
      } catch (error) {
        abortController.abort();
        throw error;
      }

      onProgress?.({
        phase: 'materializing',
        completedBytes: totalBytes,
        totalBytes,
        completedObjects,
        totalObjects: objects.length,
        reusedObjects,
      });
      const installedPaths = new Map([
        ...admittedTierPaths,
        ...(packedFirstView?.objectPaths ?? []),
        ...(packedFullTier?.objectPaths ?? []),
      ]);
      await runBounded(objectsRequiringMaterialization, concurrency, async (object) => {
        const cachedPath = objectCachePaths.get(object.id);
        if (!cachedPath) throw new Error(`Portable object ${object.id} was not hydrated.`);
        const destinationPath = resolve(generationRoot, object.installPath);
        assertAtOrBelow(generationRoot, destinationPath, 'Portable object installation');
        await materializeObject(cacheRoot, cachedPath, destinationPath, object, instrumentation);
        installedPaths.set(object.id, destinationPath);
      });
      await publishTierMarkers(
        cacheRoot,
        generationRoot,
        manifestAdmission.sha256,
        bundle,
        uniqueTiers,
        concurrency
      );
      if (migrateHostedUncompressedFasta && !annotationOnly) {
        await migrateHostedUncompressedFastaObjects({
          cacheRoot,
          generationRoot,
          objects,
          indexerBinary,
          migrateUncompressedFasta,
        });
      }
      onProgress?.({
        phase: 'ready',
        completedBytes: totalBytes,
        totalBytes,
        completedObjects: objects.length,
        totalObjects: objects.length,
        reusedObjects,
      });
      return {
        bundle,
        generationRoot,
        hydratedTiers: Object.freeze(uniqueTiers),
        objectPaths: installedPaths,
      };
    },

    async hydrateBroadRasterCells({
      definition,
      hydration,
      manifestObjectId,
      expectedSurfaceManifestFingerprint,
      admittedReader,
      addresses,
      onProgress,
    }) {
      const cacheRoot = await ensureCanonicalOwnedCacheRoot(configuredCacheRoot);
      if (hydration.bundle.assembly.id !== definition.id) {
        throw new Error('Portable broad-raster hydration does not match the hosted catalog.');
      }
      const manifestObject = hydration.bundle.objects.find(
        (object) => object.id === manifestObjectId
      );
      if (!manifestObject || manifestObject.role !== 'broad-raster-manifest') {
        throw new Error(
          `Portable bundle object ${manifestObjectId} is not a broad-raster manifest.`
        );
      }
      const manifestPath = hydration.objectPaths.get(manifestObject.id);
      if (!manifestPath || basename(manifestPath) !== COMPILED_BROAD_RASTER_MANIFEST_FILE_V1) {
        throw new Error(
          'Portable broad-raster manifest is not materialized at its canonical path.'
        );
      }
      const artifactDirectory = dirname(manifestPath);
      await requireOwnedDirectory(
        cacheRoot,
        artifactDirectory,
        'Portable broad-raster artifact directory'
      );
      const reader =
        admittedReader ??
        (await openCompiledBroadRasterArtifactV1({
          artifactDirectory,
          expectedSurfaceManifestFingerprint,
        }));
      if (
        reader.manifest.surfaceManifest.manifestFingerprint !== expectedSurfaceManifestFingerprint
      ) {
        throw new Error(
          'Portable broad-raster admitted reader does not match the requested surface.'
        );
      }
      const records = recordsForAddresses(
        reader.manifest.surfaceManifest,
        reader.manifest.cells,
        addresses
      );
      const occupied = records.filter(
        (
          record
        ): record is CompiledBroadRasterCellRecordV1 & {
          encodedSha256: string;
          fileName: string;
        } => record.occupancy === 'rgba8' && Boolean(record.encodedSha256 && record.fileName)
      );
      const totalBytes = occupied.reduce((total, record) => total + record.encodedByteLength, 0);
      let completedBytes = 0;
      let completedObjects = 0;
      let reusedObjects = 0;
      const report = (): void =>
        onProgress?.({
          phase: 'objects',
          completedBytes,
          totalBytes,
          completedObjects,
          totalObjects: occupied.length,
          reusedObjects,
        });
      report();
      const abortController = new AbortController();
      try {
        await runBounded(occupied, concurrency, async (record) => {
          const identity = {
            objectKey: portablePreparedReferenceContentObjectKeyV1(record.encodedSha256),
            sha256: record.encodedSha256,
            byteLength: record.encodedByteLength,
          };
          const cached = await ensureContentObject({
            referenceId: definition.id,
            cacheRoot,
            assetBaseUrl: input.assetBaseUrl,
            fetchAsset,
            signal: abortController.signal,
            object: identity,
            label: `${definition.name} broad-raster cell ${record.cellId}`,
            onDownloadedBytes(bytes) {
              completedBytes += bytes;
              report();
            },
            instrumentation,
            transferScheduler,
          });
          if (cached.reused) {
            completedBytes += record.encodedByteLength;
            reusedObjects += 1;
          }
          const destinationPath = resolve(artifactDirectory, record.fileName);
          assertAtOrBelow(artifactDirectory, destinationPath, 'Portable broad-raster cell');
          const materializationKey = JSON.stringify([
            destinationPath,
            identity.sha256,
            identity.byteLength,
          ]);
          let materialization = inFlightRasterMaterializations.get(materializationKey);
          if (!materialization) {
            materialization = materializeIdentity(
              cacheRoot,
              cached.path,
              destinationPath,
              identity,
              record.cellId,
              instrumentation
            ).finally(() => inFlightRasterMaterializations.delete(materializationKey));
            inFlightRasterMaterializations.set(materializationKey, materialization);
          }
          await materialization;
          completedObjects += 1;
          report();
        });
      } catch (error) {
        abortController.abort();
        throw error;
      }
      const payloads = await reader.readCells(addresses);
      onProgress?.({
        phase: 'ready',
        completedBytes: totalBytes,
        totalBytes,
        completedObjects: occupied.length,
        totalObjects: occupied.length,
        reusedObjects,
      });
      return payloads;
    },
  };
}

interface ContentObjectIdentity {
  readonly objectKey: string;
  readonly sha256: string;
  readonly byteLength: number;
}

interface ContentObjectResult {
  readonly path: string;
  readonly reused: boolean;
}

interface ContentObjectTransferScheduler {
  run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T>;
}

interface PackedFirstViewMaterialization {
  readonly generationRoot: string;
  readonly objectPaths: ReadonlyMap<string, string>;
  readonly reused: boolean;
}

interface PackedFullTierMaterialization {
  readonly generationRoot: string;
  readonly objectPaths: ReadonlyMap<string, string>;
  readonly reused: boolean;
}

type PackedFirstViewMemberIdentity = Readonly<{
  object: PortablePreparedReferenceObjectV1;
}>;

async function tryMaterializeFullTierShards(input: {
  readonly cacheRoot: string;
  readonly assetBaseUrl: URL;
  readonly fetchAsset: HostedReferenceFetch;
  readonly signal: AbortSignal;
  readonly definition: HostedReferenceCatalogDefinitionV1;
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly requestedObjects: readonly PortablePreparedReferenceObjectV1[];
  readonly concurrency: number;
  readonly transferScheduler: ContentObjectTransferScheduler;
  readonly instrumentation?: PortablePreparedReferenceHydratorInstrumentation;
  readonly onProgress?: (progress: PortablePreparedReferenceHydrationProgress) => void;
}): Promise<PackedFullTierMaterialization | null> {
  const candidate = input.definition.preparedBundle?.fullTierShards;
  if (!candidate) return null;
  const requestedIds = new Set(input.requestedObjects.map(({ id }) => id));
  const plan = portablePreparedReferenceFullTierShardPlanV1(input.bundle);

  let descriptor: HostedReferenceFullTierShardsAssetV1;
  try {
    descriptor = admitPortablePreparedReferenceFullTierShardsDescriptorV1({
      descriptor: candidate,
      bundleManifestSha256: input.bundleManifestSha256,
      bundle: input.bundle,
    });
  } catch {
    return null;
  }

  const members = plan.shards.flatMap(({ objects }) => objects).map((object) => ({ object }));
  if (members.length === 0) return null;
  const generationRoot = portableGenerationRoot(input.cacheRoot, input.bundle);
  await assertOwnedPathAncestry(input.cacheRoot, generationRoot, 'Packed full-tier generation');
  const existingPaths = await admitExistingPackedFullTierGeneration({
    ownershipRoot: input.cacheRoot,
    generationRoot,
    bundleManifestSha256: input.bundleManifestSha256,
    bundle: input.bundle,
    descriptor,
    members,
    concurrency: input.concurrency,
    instrumentation: input.instrumentation,
  });
  if (existingPaths) {
    const requestedPaths = new Map([...existingPaths].filter(([id]) => requestedIds.has(id)));
    const expandedTotalBytes = members.reduce((total, { object }) => total + object.byteLength, 0);
    input.onProgress?.({
      phase: 'expanding',
      completedBytes: expandedTotalBytes,
      totalBytes: expandedTotalBytes,
      completedObjects: members.length,
      totalObjects: members.length,
      reusedObjects: members.length,
    });
    return { generationRoot, objectPaths: requestedPaths, reused: true };
  }
  if (!plan.roster.every(({ id }) => requestedIds.has(id))) return null;
  if (!(await pathExists(generationRoot))) {
    return null;
  }
  return materializePackedFullTierGeneration({
    ...input,
    descriptor,
    members,
  });
}

function materializePackedFullTierGeneration(input: {
  readonly cacheRoot: string;
  readonly assetBaseUrl: URL;
  readonly fetchAsset: HostedReferenceFetch;
  readonly signal: AbortSignal;
  readonly definition: HostedReferenceCatalogDefinitionV1;
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly descriptor: HostedReferenceFullTierShardsAssetV1;
  readonly members: readonly PackedFirstViewMemberIdentity[];
  readonly concurrency: number;
  readonly transferScheduler: ContentObjectTransferScheduler;
  readonly instrumentation?: PortablePreparedReferenceHydratorInstrumentation;
  readonly onProgress?: (progress: PortablePreparedReferenceHydrationProgress) => void;
}): Promise<PackedFullTierMaterialization | null> {
  const generationRoot = portableGenerationRoot(input.cacheRoot, input.bundle);
  const pending = inFlightFullTierGenerations.get(generationRoot);
  if (pending) return pending.then((result) => (result ? { ...result, reused: true } : null));
  const created = materializePackedFullTierGenerationExclusive(input, generationRoot).finally(
    () => {
      if (inFlightFullTierGenerations.get(generationRoot) === created) {
        inFlightFullTierGenerations.delete(generationRoot);
      }
    }
  );
  inFlightFullTierGenerations.set(generationRoot, created);
  return created;
}

async function materializePackedFullTierGenerationExclusive(
  input: Parameters<typeof materializePackedFullTierGeneration>[0],
  generationRoot: string
): Promise<PackedFullTierMaterialization | null> {
  const existingPaths = await admitExistingPackedFullTierGeneration({
    ownershipRoot: input.cacheRoot,
    generationRoot,
    bundleManifestSha256: input.bundleManifestSha256,
    bundle: input.bundle,
    descriptor: input.descriptor,
    members: input.members,
    concurrency: input.concurrency,
    instrumentation: input.instrumentation,
  });
  if (existingPaths) return { generationRoot, objectPaths: existingPaths, reused: true };
  if (!(await pathExists(generationRoot))) return null;
  await requireOwnedDirectory(input.cacheRoot, generationRoot, 'Packed full-tier generation');

  const generationParent = dirname(generationRoot);
  const stagingRoot = join(
    generationParent,
    `.${input.bundle.bundleFingerprint}.${randomUUID()}.full-tier-staging`
  );
  assertAtOrBelow(generationParent, stagingRoot, 'Packed full-tier staging generation');
  await ensureOwnedDirectoryTree(
    input.cacheRoot,
    generationParent,
    'Packed full-tier generation parent'
  );
  await mkdir(stagingRoot, { mode: 0o700 });
  try {
    const totalTransportBytes = input.descriptor.shards.reduce(
      (total, shard) => total + shard.byteLength,
      0
    );
    const totalExpandedBytes = input.members.reduce(
      (total, { object }) => total + object.byteLength,
      0
    );
    let transportedBytes = 0;
    let transportedShards = 0;
    let reusedShards = 0;
    let expandedBytes = 0;
    let expandedObjects = 0;
    const emitTransportProgress = (): void =>
      input.onProgress?.({
        phase: 'transport',
        completedBytes: transportedBytes,
        totalBytes: totalTransportBytes,
        completedObjects: transportedShards,
        totalObjects: input.descriptor.shards.length,
        reusedObjects: reusedShards,
      });
    const emitExpansionProgress = (): void =>
      input.onProgress?.({
        phase: 'expanding',
        completedBytes: expandedBytes,
        totalBytes: totalExpandedBytes,
        completedObjects: expandedObjects,
        totalObjects: input.members.length,
        reusedObjects: 0,
      });
    emitTransportProgress();

    let failure: unknown;
    await runBounded(input.descriptor.shards, Math.min(2, input.concurrency), async (shard) => {
      if (failure) return;
      try {
        let downloadedForShard = 0;
        const packed = await ensureContentObject({
          referenceId: input.definition.id,
          cacheRoot: input.cacheRoot,
          assetBaseUrl: input.assetBaseUrl,
          fetchAsset: input.fetchAsset,
          signal: input.signal,
          object: {
            objectKey: shard.relativePath,
            sha256: shard.sha256,
            byteLength: shard.byteLength,
          },
          label: `${input.definition.name} full-tier transport shard ${shard.shardIndex + 1}/${shard.shardCount}`,
          onDownloadedBytes(bytes) {
            downloadedForShard += bytes;
            transportedBytes += bytes;
            emitTransportProgress();
          },
          instrumentation: input.instrumentation,
          transferScheduler: input.transferScheduler,
        });
        transportedBytes += shard.byteLength - downloadedForShard;
        if (packed.reused) reusedShards += 1;
        transportedShards += 1;
        emitTransportProgress();
        const parsed = parsePortablePreparedReferenceFullTierShardV1({
          collection: input.descriptor,
          descriptor: shard,
          bundleManifestSha256: input.bundleManifestSha256,
          bundle: input.bundle,
          shardBytes: await readFile(packed.path),
        });
        await runBounded(parsed, input.concurrency, async ({ object, bytes }) => {
          const destinationPath = resolve(stagingRoot, object.installPath);
          assertAtOrBelow(stagingRoot, destinationPath, 'Packed full-tier member staging');
          await ensureOwnedDirectoryTree(
            input.cacheRoot,
            dirname(destinationPath),
            'Packed full-tier member staging'
          );
          await writeFile(destinationPath, bytes, { flag: 'wx', mode: 0o444 });
          expandedBytes += object.byteLength;
          expandedObjects += 1;
          emitExpansionProgress();
        });
      } catch (error) {
        failure ??= error;
      }
    });
    if (failure) {
      if (
        input.signal.aborted ||
        isPackCancellation(failure) ||
        isLocalPackResourceFailure(failure)
      ) {
        throw failure;
      }
      return null;
    }

    await ensureOwnedDirectoryTree(
      input.cacheRoot,
      join(generationRoot, '.readiness'),
      'Packed full-tier readiness markers'
    );
    await Promise.all([
      rm(packedFullTierAdmissionPath(generationRoot), { force: true }),
      rm(join(generationRoot, '.readiness', 'detail.v1.json'), { force: true }),
      rm(join(generationRoot, '.readiness', 'search.v1.json'), { force: true }),
      rm(tierAdmissionPath(generationRoot, 'detail'), { force: true }),
      rm(tierAdmissionPath(generationRoot, 'search'), { force: true }),
    ]);
    await runBounded(input.members, input.concurrency, async ({ object }) => {
      const stagedPath = resolve(stagingRoot, object.installPath);
      const destinationPath = resolve(generationRoot, object.installPath);
      assertAtOrBelow(stagingRoot, stagedPath, 'Packed full-tier staged member');
      assertAtOrBelow(generationRoot, destinationPath, 'Packed full-tier member installation');
      await ensureOwnedDirectoryTree(
        input.cacheRoot,
        dirname(destinationPath),
        'Packed full-tier member installation'
      );
      await removeVerifiedFile(destinationPath);
      await rename(stagedPath, destinationPath);
    });
    const memberStats = await packedMemberStats(input.cacheRoot, generationRoot, input.members);
    await writePackedFullTierAdmission({
      ownershipRoot: input.cacheRoot,
      generationRoot,
      bundleManifestSha256: input.bundleManifestSha256,
      bundle: input.bundle,
      descriptor: input.descriptor,
      members: input.members,
      memberStats,
    });
    return {
      generationRoot,
      objectPaths: packedMemberPaths(generationRoot, input.members),
      reused: false,
    };
  } finally {
    await assertOwnedPathAncestry(input.cacheRoot, stagingRoot, 'Packed full-tier staging cleanup');
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function tryMaterializeFirstViewPack(input: {
  readonly cacheRoot: string;
  readonly assetBaseUrl: URL;
  readonly fetchAsset: HostedReferenceFetch;
  readonly signal: AbortSignal;
  readonly definition: HostedReferenceCatalogDefinitionV1;
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly requestedObjects: readonly PortablePreparedReferenceObjectV1[];
  readonly concurrency: number;
  readonly transferScheduler: ContentObjectTransferScheduler;
  readonly instrumentation?: PortablePreparedReferenceHydratorInstrumentation;
  readonly onProgress?: (progress: PortablePreparedReferenceHydrationProgress) => void;
}): Promise<PackedFirstViewMaterialization | null> {
  const candidate = input.definition.preparedBundle?.firstViewPack;
  if (!candidate) return null;
  const requestedIds = new Set(input.requestedObjects.map(({ id }) => id));
  const firstViewObjects = portablePreparedReferenceObjectsForTierV1(input.bundle, 'view');
  if (!firstViewObjects.every(({ id }) => requestedIds.has(id))) return null;
  let descriptor: HostedReferenceFirstViewPackAssetV1;
  try {
    descriptor = admitPortablePreparedReferenceFirstViewPackDescriptorV1({
      descriptor: candidate,
      bundleManifestSha256: input.bundleManifestSha256,
      bundle: input.bundle,
    });
  } catch {
    return null;
  }

  const identityMembers = firstViewObjects.map((object) => ({ object }));
  const generationRoot = portableGenerationRoot(input.cacheRoot, input.bundle);
  await assertOwnedPathAncestry(input.cacheRoot, generationRoot, 'Packed first-view generation');
  const existingPaths = await admitExistingPackedFirstViewGeneration({
    ownershipRoot: input.cacheRoot,
    generationRoot,
    bundleManifestSha256: input.bundleManifestSha256,
    bundle: input.bundle,
    descriptor,
    members: identityMembers,
    concurrency: input.concurrency,
  });
  if (existingPaths) {
    const expandedTotalBytes = firstViewObjects.reduce(
      (total, object) => total + object.byteLength,
      0
    );
    input.onProgress?.({
      phase: 'expanding',
      completedBytes: expandedTotalBytes,
      totalBytes: expandedTotalBytes,
      completedObjects: firstViewObjects.length,
      totalObjects: firstViewObjects.length,
      reusedObjects: firstViewObjects.length,
    });
    return { generationRoot, objectPaths: existingPaths, reused: true };
  }

  let members: ReturnType<typeof parsePortablePreparedReferenceFirstViewPackV1>;
  try {
    let transportedBytes = 0;
    let transportReused = 0;
    const emitTransportProgress = (): void =>
      input.onProgress?.({
        phase: 'transport',
        completedBytes: transportedBytes,
        totalBytes: descriptor.byteLength,
        completedObjects: transportedBytes === descriptor.byteLength ? 1 : 0,
        totalObjects: 1,
        reusedObjects: transportReused,
      });
    emitTransportProgress();
    const packed = await ensureContentObject({
      referenceId: input.definition.id,
      cacheRoot: input.cacheRoot,
      assetBaseUrl: input.assetBaseUrl,
      fetchAsset: input.fetchAsset,
      signal: input.signal,
      object: {
        objectKey: descriptor.relativePath,
        sha256: descriptor.sha256,
        byteLength: descriptor.byteLength,
      },
      label: `${input.definition.name} first-view transport pack`,
      onDownloadedBytes(bytes) {
        transportedBytes += bytes;
        emitTransportProgress();
      },
      instrumentation: input.instrumentation,
      transferScheduler: input.transferScheduler,
    });
    if (packed.reused) {
      transportedBytes = descriptor.byteLength;
      transportReused = 1;
    }
    emitTransportProgress();
    members = parsePortablePreparedReferenceFirstViewPackV1({
      descriptor,
      bundleManifestSha256: input.bundleManifestSha256,
      bundle: input.bundle,
      packBytes: await readFile(packed.path),
    });
  } catch (error) {
    if (input.signal.aborted || isPackCancellation(error) || isLocalPackResourceFailure(error)) {
      throw error;
    }
    return null;
  }

  const expandedTotalBytes = members.reduce((total, { object }) => total + object.byteLength, 0);
  const emitExpansionProgress = (): void =>
    input.onProgress?.({
      phase: 'expanding',
      completedBytes: 0,
      totalBytes: expandedTotalBytes,
      completedObjects: 0,
      totalObjects: members.length,
      reusedObjects: 0,
    });
  emitExpansionProgress();

  const materialized = await materializePackedFirstViewGeneration({
    cacheRoot: input.cacheRoot,
    bundleManifestSha256: input.bundleManifestSha256,
    bundle: input.bundle,
    descriptor,
    members,
    concurrency: input.concurrency,
    instrumentation: input.instrumentation,
  });
  if (!materialized) return null;
  input.onProgress?.({
    phase: 'expanding',
    completedBytes: expandedTotalBytes,
    totalBytes: expandedTotalBytes,
    completedObjects: members.length,
    totalObjects: members.length,
    reusedObjects: materialized.reused ? members.length : 0,
  });
  return materialized;
}

function materializePackedFirstViewGeneration(input: {
  readonly cacheRoot: string;
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly descriptor: HostedReferenceFirstViewPackAssetV1;
  readonly members: ReturnType<typeof parsePortablePreparedReferenceFirstViewPackV1>;
  readonly concurrency: number;
  readonly instrumentation?: PortablePreparedReferenceHydratorInstrumentation;
}): Promise<PackedFirstViewMaterialization | null> {
  const generationRoot = portableGenerationRoot(input.cacheRoot, input.bundle);
  const pending = inFlightFirstViewGenerations.get(generationRoot);
  if (pending) {
    return pending.then((result) => (result ? { ...result, reused: true } : null));
  }
  const created = materializePackedFirstViewGenerationExclusive(input, generationRoot).finally(
    () => {
      if (inFlightFirstViewGenerations.get(generationRoot) === created) {
        inFlightFirstViewGenerations.delete(generationRoot);
      }
    }
  );
  inFlightFirstViewGenerations.set(generationRoot, created);
  return created;
}

async function materializePackedFirstViewGenerationExclusive(
  input: {
    readonly cacheRoot: string;
    readonly bundleManifestSha256: string;
    readonly bundle: PortablePreparedReferenceBundleV1;
    readonly descriptor: HostedReferenceFirstViewPackAssetV1;
    readonly members: ReturnType<typeof parsePortablePreparedReferenceFirstViewPackV1>;
    readonly concurrency: number;
    readonly instrumentation?: PortablePreparedReferenceHydratorInstrumentation;
  },
  generationRoot: string
): Promise<PackedFirstViewMaterialization | null> {
  const existingPaths = await admitExistingPackedFirstViewGeneration({
    ownershipRoot: input.cacheRoot,
    generationRoot,
    bundleManifestSha256: input.bundleManifestSha256,
    bundle: input.bundle,
    descriptor: input.descriptor,
    members: input.members,
    concurrency: input.concurrency,
    instrumentation: input.instrumentation,
  });
  if (existingPaths) {
    return { generationRoot, objectPaths: existingPaths, reused: true };
  }
  if (await pathExists(generationRoot)) {
    return null;
  }

  const generationParent = dirname(generationRoot);
  await ensureOwnedDirectoryTree(
    input.cacheRoot,
    generationParent,
    'Packed first-view generation parent'
  );
  const stagingRoot = join(
    generationParent,
    `.${input.bundle.bundleFingerprint}.${randomUUID()}.first-view-staging`
  );
  assertAtOrBelow(generationParent, stagingRoot, 'Packed first-view staging generation');
  await mkdir(stagingRoot, { mode: 0o700 });
  try {
    await runBounded(input.members, input.concurrency, async ({ object, bytes }) => {
      const destinationPath = resolve(stagingRoot, object.installPath);
      assertAtOrBelow(stagingRoot, destinationPath, 'Packed first-view member installation');
      await ensureOwnedDirectoryTree(
        input.cacheRoot,
        dirname(destinationPath),
        'Packed first-view member installation'
      );
      await writeFile(destinationPath, bytes, { flag: 'wx', mode: 0o444 });
    });
    await publishTierMarkers(
      input.cacheRoot,
      stagingRoot,
      input.bundleManifestSha256,
      input.bundle,
      ['shell', 'view'],
      input.concurrency
    );
    const memberStats = await packedMemberStats(input.cacheRoot, stagingRoot, input.members);
    await writePackedFirstViewAdmission({
      ownershipRoot: input.cacheRoot,
      stagingRoot,
      bundleManifestSha256: input.bundleManifestSha256,
      bundle: input.bundle,
      descriptor: input.descriptor,
      members: input.members,
      memberStats,
    });
    try {
      await assertOwnedPathAncestry(
        input.cacheRoot,
        generationRoot,
        'Packed first-view generation commit'
      );
      await rename(stagingRoot, generationRoot);
    } catch (error) {
      const racedPaths = await admitExistingPackedFirstViewGeneration({
        ownershipRoot: input.cacheRoot,
        generationRoot,
        bundleManifestSha256: input.bundleManifestSha256,
        bundle: input.bundle,
        descriptor: input.descriptor,
        members: input.members,
        concurrency: input.concurrency,
        instrumentation: input.instrumentation,
      });
      if (racedPaths) {
        return { generationRoot, objectPaths: racedPaths, reused: true };
      }
      throw error;
    }
    await syncDirectoryRename(generationParent);
    input.instrumentation?.onPackedFirstViewGenerationCommit?.({
      generationRoot,
      memberCount: input.members.length,
    });
    return {
      generationRoot,
      objectPaths: packedMemberPaths(generationRoot, input.members),
      reused: false,
    };
  } finally {
    await assertOwnedPathAncestry(
      input.cacheRoot,
      stagingRoot,
      'Packed first-view staging cleanup'
    );
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function admitExistingPackedFirstViewGeneration(input: {
  readonly ownershipRoot: string;
  readonly generationRoot: string;
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly descriptor: HostedReferenceFirstViewPackAssetV1;
  readonly members: readonly PackedFirstViewMemberIdentity[];
  readonly concurrency: number;
  readonly instrumentation?: PortablePreparedReferenceHydratorInstrumentation;
}): Promise<ReadonlyMap<string, string> | null> {
  let admittedStats: ReadonlyMap<string, StableStatIdentity>;
  let parsed: unknown;
  const admissionPath = packedFirstViewAdmissionPath(input.generationRoot);
  await assertOwnedPathAncestry(input.ownershipRoot, admissionPath, 'Packed first-view admission');
  try {
    parsed = JSON.parse(await readFile(admissionPath, 'utf8')) as unknown;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  try {
    admittedStats = parsePackedFirstViewAdmission(parsed, input);
  } catch {
    return null;
  }

  const paths = packedMemberPaths(input.generationRoot, input.members);
  let valid = true;
  await runBounded(input.members, input.concurrency, async ({ object }) => {
    if (!valid) return;
    const path = paths.get(object.id);
    if (!path) {
      valid = false;
      return;
    }
    await assertOwnedPathAncestry(
      input.ownershipRoot,
      path,
      `Packed first-view member ${object.id}`
    );
    const statIdentity = await stableRegularFileStat(path);
    const admittedStat = admittedStats.get(object.id);
    if (
      !statIdentity ||
      !admittedStat ||
      BigInt(statIdentity.size) !== BigInt(object.byteLength) ||
      !sameStableStat(admittedStat, statIdentity)
    ) {
      valid = false;
    }
  });
  return valid ? paths : null;
}

function packedMemberPaths(
  generationRoot: string,
  members: readonly PackedFirstViewMemberIdentity[]
): ReadonlyMap<string, string> {
  return new Map(
    members.map(({ object }) => {
      const destinationPath = resolve(generationRoot, object.installPath);
      assertAtOrBelow(generationRoot, destinationPath, 'Packed first-view member');
      return [object.id, destinationPath] as const;
    })
  );
}

async function packedMemberStats(
  ownershipRoot: string,
  generationRoot: string,
  members: readonly PackedFirstViewMemberIdentity[]
): Promise<ReadonlyMap<string, StableStatIdentity>> {
  const paths = packedMemberPaths(generationRoot, members);
  const stats = new Map<string, StableStatIdentity>();
  for (const { object } of members) {
    const path = paths.get(object.id);
    if (path) {
      await assertOwnedPathAncestry(ownershipRoot, path, `Packed member ${object.id}`);
    }
    const statIdentity = path ? await stableRegularFileStat(path) : null;
    if (!statIdentity || BigInt(statIdentity.size) !== BigInt(object.byteLength)) {
      throw new Error(`Packed first-view member ${object.id} changed before atomic admission.`);
    }
    stats.set(object.id, statIdentity);
  }
  return stats;
}

function packedFirstViewAdmission(input: {
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly descriptor: HostedReferenceFirstViewPackAssetV1;
  readonly members: readonly PackedFirstViewMemberIdentity[];
  readonly memberStats: ReadonlyMap<string, StableStatIdentity>;
}): object {
  return {
    contract: PACKED_FIRST_VIEW_ADMISSION_V1,
    bundleManifestSha256: input.bundleManifestSha256,
    bundleFingerprint: input.bundle.bundleFingerprint,
    packSha256: input.descriptor.sha256,
    rosterSha256: input.descriptor.rosterSha256,
    members: input.members.map(({ object }) => ({
      id: object.id,
      sha256: object.sha256,
      byteLength: object.byteLength,
      installPath: object.installPath,
      stat: input.memberStats.get(object.id),
    })),
  };
}

function parsePackedFirstViewAdmission(
  value: unknown,
  expected: {
    readonly bundleManifestSha256: string;
    readonly bundle: PortablePreparedReferenceBundleV1;
    readonly descriptor: HostedReferenceFirstViewPackAssetV1;
    readonly members: readonly PackedFirstViewMemberIdentity[];
  }
): ReadonlyMap<string, StableStatIdentity> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Packed first-view admission is not an object.');
  }
  const admission = value as Record<string, unknown>;
  if (
    Object.keys(admission).sort().join(',') !==
      'bundleFingerprint,bundleManifestSha256,contract,members,packSha256,rosterSha256' ||
    admission.contract !== PACKED_FIRST_VIEW_ADMISSION_V1 ||
    admission.bundleManifestSha256 !== expected.bundleManifestSha256 ||
    admission.bundleFingerprint !== expected.bundle.bundleFingerprint ||
    admission.packSha256 !== expected.descriptor.sha256 ||
    admission.rosterSha256 !== expected.descriptor.rosterSha256 ||
    !Array.isArray(admission.members) ||
    admission.members.length !== expected.members.length
  ) {
    throw new Error('Packed first-view admission identity does not match.');
  }
  const stats = new Map<string, StableStatIdentity>();
  for (const [index, { object }] of expected.members.entries()) {
    const valueAtIndex = admission.members[index];
    if (!valueAtIndex || typeof valueAtIndex !== 'object' || Array.isArray(valueAtIndex)) {
      throw new Error('Packed first-view admission member is invalid.');
    }
    const member = valueAtIndex as Record<string, unknown>;
    if (
      Object.keys(member).sort().join(',') !== 'byteLength,id,installPath,sha256,stat' ||
      member.id !== object.id ||
      member.sha256 !== object.sha256 ||
      member.byteLength !== object.byteLength ||
      member.installPath !== object.installPath
    ) {
      throw new Error('Packed first-view admission member identity does not match.');
    }
    const statIdentity = parseStableStatIdentity(member.stat);
    stats.set(object.id, statIdentity);
  }
  return stats;
}

function parseStableStatIdentity(value: unknown): StableStatIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Packed first-view admission stat identity is invalid.');
  }
  const stat = value as Record<string, unknown>;
  if (
    Object.keys(stat).sort().join(',') !== 'ctimeNs,device,inode,mode,mtimeNs,size' ||
    !['device', 'inode', 'size', 'mode', 'mtimeNs', 'ctimeNs'].every(
      (key) => typeof stat[key] === 'string' && /^[0-9]+$/.test(stat[key] as string)
    )
  ) {
    throw new Error('Packed first-view admission stat identity is invalid.');
  }
  return {
    device: stat.device as string,
    inode: stat.inode as string,
    size: stat.size as string,
    mode: stat.mode as string,
    mtimeNs: stat.mtimeNs as string,
    ctimeNs: stat.ctimeNs as string,
  };
}

async function writePackedFirstViewAdmission(input: {
  readonly ownershipRoot: string;
  readonly stagingRoot: string;
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly descriptor: HostedReferenceFirstViewPackAssetV1;
  readonly members: readonly PackedFirstViewMemberIdentity[];
  readonly memberStats: ReadonlyMap<string, StableStatIdentity>;
}): Promise<void> {
  const path = packedFirstViewAdmissionPath(input.stagingRoot);
  await ensureOwnedDirectoryTree(
    input.ownershipRoot,
    dirname(path),
    'Packed first-view admission directory'
  );
  await assertOwnedPathAncestry(input.ownershipRoot, path, 'Packed first-view admission');
  const handle = await open(path, 'wx', 0o600);
  try {
    await writeFileHandleCompletely(
      handle,
      Buffer.from(`${JSON.stringify(packedFirstViewAdmission(input))}\n`)
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function packedFirstViewAdmissionPath(generationRoot: string): string {
  return join(generationRoot, '.readiness', 'first-view-pack-admission.v1.json');
}

async function admitExistingPackedFullTierGeneration(input: {
  readonly ownershipRoot: string;
  readonly generationRoot: string;
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly descriptor: HostedReferenceFullTierShardsAssetV1;
  readonly members: readonly PackedFirstViewMemberIdentity[];
  readonly concurrency: number;
  readonly instrumentation?: PortablePreparedReferenceHydratorInstrumentation;
}): Promise<ReadonlyMap<string, string> | null> {
  let admittedStats: ReadonlyMap<string, StableStatIdentity>;
  let parsed: unknown;
  const admissionPath = packedFullTierAdmissionPath(input.generationRoot);
  await assertOwnedPathAncestry(input.ownershipRoot, admissionPath, 'Packed full-tier admission');
  try {
    parsed = JSON.parse(await readFile(admissionPath, 'utf8')) as unknown;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  try {
    admittedStats = parsePackedFullTierAdmission(parsed, input);
  } catch {
    return null;
  }
  const paths = packedMemberPaths(input.generationRoot, input.members);
  let valid = true;
  await runBounded(input.members, input.concurrency, async ({ object }) => {
    if (!valid) return;
    const path = paths.get(object.id);
    if (path) {
      await assertOwnedPathAncestry(
        input.ownershipRoot,
        path,
        `Packed full-tier member ${object.id}`
      );
    }
    const statIdentity = path ? await stableRegularFileStat(path) : null;
    const admittedStat = admittedStats.get(object.id);
    if (
      !statIdentity ||
      !admittedStat ||
      BigInt(statIdentity.size) !== BigInt(object.byteLength) ||
      !sameStableStat(admittedStat, statIdentity)
    ) {
      valid = false;
    }
  });
  return valid ? paths : null;
}

function packedFullTierAdmission(input: {
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly descriptor: HostedReferenceFullTierShardsAssetV1;
  readonly members: readonly PackedFirstViewMemberIdentity[];
  readonly memberStats: ReadonlyMap<string, StableStatIdentity>;
}): object {
  return {
    contract: PACKED_FULL_TIER_ADMISSION_V1,
    bundleManifestSha256: input.bundleManifestSha256,
    bundleFingerprint: input.bundle.bundleFingerprint,
    rosterSha256: input.descriptor.rosterSha256,
    individualObjectIds: input.descriptor.individualObjectIds,
    shards: input.descriptor.shards.map((shard) => ({
      shardIndex: shard.shardIndex,
      sha256: shard.sha256,
      rosterSha256: shard.rosterSha256,
      memberCount: shard.memberCount,
    })),
    members: input.members.map(({ object }) => ({
      id: object.id,
      sha256: object.sha256,
      byteLength: object.byteLength,
      installPath: object.installPath,
      stat: input.memberStats.get(object.id),
    })),
  };
}

function parsePackedFullTierAdmission(
  value: unknown,
  expected: {
    readonly bundleManifestSha256: string;
    readonly bundle: PortablePreparedReferenceBundleV1;
    readonly descriptor: HostedReferenceFullTierShardsAssetV1;
    readonly members: readonly PackedFirstViewMemberIdentity[];
  }
): ReadonlyMap<string, StableStatIdentity> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Packed full-tier admission is not an object.');
  }
  const admission = value as Record<string, unknown>;
  if (
    Object.keys(admission).sort().join(',') !==
      'bundleFingerprint,bundleManifestSha256,contract,individualObjectIds,members,rosterSha256,shards' ||
    admission.contract !== PACKED_FULL_TIER_ADMISSION_V1 ||
    admission.bundleManifestSha256 !== expected.bundleManifestSha256 ||
    admission.bundleFingerprint !== expected.bundle.bundleFingerprint ||
    admission.rosterSha256 !== expected.descriptor.rosterSha256 ||
    !Array.isArray(admission.individualObjectIds) ||
    admission.individualObjectIds.length !== expected.descriptor.individualObjectIds.length ||
    !admission.individualObjectIds.every(
      (id, index) => id === expected.descriptor.individualObjectIds[index]
    ) ||
    !Array.isArray(admission.shards) ||
    admission.shards.length !== expected.descriptor.shards.length ||
    !Array.isArray(admission.members) ||
    admission.members.length !== expected.members.length
  ) {
    throw new Error('Packed full-tier admission identity does not match.');
  }
  for (const [index, descriptor] of expected.descriptor.shards.entries()) {
    const valueAtIndex = admission.shards[index];
    if (!valueAtIndex || typeof valueAtIndex !== 'object' || Array.isArray(valueAtIndex)) {
      throw new Error('Packed full-tier admission shard is invalid.');
    }
    const shard = valueAtIndex as Record<string, unknown>;
    if (
      Object.keys(shard).sort().join(',') !== 'memberCount,rosterSha256,sha256,shardIndex' ||
      shard.shardIndex !== descriptor.shardIndex ||
      shard.sha256 !== descriptor.sha256 ||
      shard.rosterSha256 !== descriptor.rosterSha256 ||
      shard.memberCount !== descriptor.memberCount
    ) {
      throw new Error('Packed full-tier admission shard identity does not match.');
    }
  }
  const stats = new Map<string, StableStatIdentity>();
  for (const [index, { object }] of expected.members.entries()) {
    const valueAtIndex = admission.members[index];
    if (!valueAtIndex || typeof valueAtIndex !== 'object' || Array.isArray(valueAtIndex)) {
      throw new Error('Packed full-tier admission member is invalid.');
    }
    const member = valueAtIndex as Record<string, unknown>;
    if (
      Object.keys(member).sort().join(',') !== 'byteLength,id,installPath,sha256,stat' ||
      member.id !== object.id ||
      member.sha256 !== object.sha256 ||
      member.byteLength !== object.byteLength ||
      member.installPath !== object.installPath
    ) {
      throw new Error('Packed full-tier admission member identity does not match.');
    }
    stats.set(object.id, parseStableStatIdentity(member.stat));
  }
  return stats;
}

async function writePackedFullTierAdmission(input: {
  readonly ownershipRoot: string;
  readonly generationRoot: string;
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly descriptor: HostedReferenceFullTierShardsAssetV1;
  readonly members: readonly PackedFirstViewMemberIdentity[];
  readonly memberStats: ReadonlyMap<string, StableStatIdentity>;
}): Promise<void> {
  const path = packedFullTierAdmissionPath(input.generationRoot);
  await ensureOwnedDirectoryTree(
    input.ownershipRoot,
    dirname(path),
    'Packed full-tier admission directory'
  );
  await assertOwnedPathAncestry(input.ownershipRoot, path, 'Packed full-tier admission');
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await assertOwnedPathAncestry(
    input.ownershipRoot,
    temporaryPath,
    'Packed full-tier temporary admission'
  );
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await writeFileHandleCompletely(
      handle,
      Buffer.from(`${JSON.stringify(packedFullTierAdmission(input))}\n`)
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function packedFullTierAdmissionPath(generationRoot: string): string {
  return join(generationRoot, '.readiness', 'full-tier-shards-admission.v1.json');
}

async function migrateHostedUncompressedFastaObjects(input: {
  readonly cacheRoot: string;
  readonly generationRoot: string;
  readonly objects: readonly PortablePreparedReferenceObjectV1[];
  readonly indexerBinary?: string;
  readonly migrateUncompressedFasta: (
    input: MigrateUncompressedFastaBundleInput
  ) => Promise<BgzfFastaMigrationResult>;
}): Promise<void> {
  for (const object of input.objects) {
    if (object.role !== 'fasta' || !isUncompressedPreparedFastaInstallPath(object.installPath)) {
      continue;
    }
    const fastaPath = resolve(input.generationRoot, object.installPath);
    assertAtOrBelow(input.generationRoot, fastaPath, 'Hosted FASTA migration');
    if (!(await pathExists(fastaPath))) continue;
    try {
      await input.migrateUncompressedFasta({
        uncompressedFastaPath: fastaPath,
        indexerBinary: input.indexerBinary,
      });
    } catch {
      continue;
    }
    await removeVerifiedFile(contentObjectCachePath(input.cacheRoot, object.sha256));
    const indexObject = input.objects.find(
      (candidate) =>
        candidate.role === 'fasta-index' &&
        isUncompressedPreparedFastaIndexInstallPath(candidate.installPath) &&
        dirname(candidate.installPath) === dirname(object.installPath)
    );
    if (indexObject) {
      await removeVerifiedFile(contentObjectCachePath(input.cacheRoot, indexObject.sha256));
    }
  }
}

function portableGenerationRoot(
  cacheRoot: string,
  bundle: PortablePreparedReferenceBundleV1
): string {
  const generationRoot = resolve(
    cacheRoot,
    bundle.assembly.assetCacheKey,
    'generations',
    bundle.bundleFingerprint
  );
  assertAtOrBelow(cacheRoot, generationRoot, 'Portable bundle generation');
  return generationRoot;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function syncDirectoryRename(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const LOCAL_PACK_RESOURCE_ERROR_CODES = new Set([
  'EACCES',
  'EDQUOT',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOTDIR',
  'ENOSPC',
  'EPERM',
  'EROFS',
]);

function isLocalPackResourceFailure(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && LOCAL_PACK_RESOURCE_ERROR_CODES.has(candidate.code)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function isPackCancellation(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

interface MutableTransferAttempt {
  responseStatus: number | null;
  contentRange: string | null;
  resumedFromBytes: number;
  bytesTransferred: number;
}

function transferErrorClass(error: unknown): PortablePreparedReferenceTransferEvent['errorClass'] {
  if (isPackCancellation(error)) return 'abort';
  if (error instanceof HostedReferenceTransportError) return error.kind;
  if (error instanceof TypeError) return 'type-error';
  if (error instanceof Error) return 'error';
  return 'unknown';
}

function emitTransferEvent(
  input: Parameters<typeof ensureContentObject>[0],
  attempt: number,
  startedAt: number,
  telemetry: MutableTransferAttempt,
  result: Pick<PortablePreparedReferenceTransferEvent, 'outcome' | 'errorClass'>
): void {
  try {
    input.instrumentation?.onContentObjectTransfer?.({
      referenceId: input.referenceId,
      objectKey: input.object.objectKey,
      objectSha256: input.object.sha256,
      attempt,
      resumedFromBytes: telemetry.resumedFromBytes,
      bytesTransferred: telemetry.bytesTransferred,
      expectedBytes: input.object.byteLength,
      responseStatus: telemetry.responseStatus,
      contentRange: telemetry.contentRange,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      ...result,
    });
  } catch {}
}

function createContentObjectTransferScheduler(concurrency: number): ContentObjectTransferScheduler {
  let active = 0;
  const pending: Array<() => void> = [];
  const drain = (): void => {
    while (active < concurrency) {
      const start = pending.shift();
      if (!start) return;
      start();
    }
  };
  return {
    run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
      if (signal.aborted) return Promise.reject(contentObjectTransferCancellation());
      return new Promise<T>((resolvePromise, rejectPromise) => {
        let started = false;
        const start = (): void => {
          started = true;
          signal.removeEventListener('abort', cancelPending);
          if (signal.aborted) {
            rejectPromise(contentObjectTransferCancellation());
            return;
          }
          active += 1;
          void Promise.resolve()
            .then(operation)
            .then(resolvePromise, rejectPromise)
            .finally(() => {
              active -= 1;
              drain();
            });
        };
        const cancelPending = (): void => {
          if (started) return;
          const index = pending.indexOf(start);
          if (index >= 0) pending.splice(index, 1);
          rejectPromise(contentObjectTransferCancellation());
        };
        signal.addEventListener('abort', cancelPending, { once: true });
        pending.push(start);
        drain();
      });
    },
  };
}

function contentObjectTransferCancellation(): Error {
  const error = new Error('Portable content-object transfer was cancelled.');
  error.name = 'AbortError';
  return error;
}

function waitForContentObjectRetry(failedAttempt: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(contentObjectTransferCancellation());
  const delayMs = Math.min(
    CONTENT_OBJECT_RETRY_BASE_DELAY_MS * 2 ** (failedAttempt - 1),
    CONTENT_OBJECT_RETRY_MAX_DELAY_MS
  );
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancelDelay);
      resolvePromise();
    }, delayMs);
    const cancelDelay = (): void => {
      clearTimeout(timer);
      rejectPromise(contentObjectTransferCancellation());
    };
    signal.addEventListener('abort', cancelDelay, { once: true });
  });
}

function ensureContentObject(input: {
  readonly referenceId: string;
  readonly cacheRoot: string;
  readonly assetBaseUrl: URL;
  readonly fetchAsset: HostedReferenceFetch;
  readonly signal: AbortSignal;
  readonly object: ContentObjectIdentity;
  readonly label: string;
  readonly onDownloadedBytes: (bytes: number) => void;
  readonly instrumentation?: PortablePreparedReferenceHydratorInstrumentation;
  readonly transferScheduler: ContentObjectTransferScheduler;
}): Promise<ContentObjectResult> {
  const cachePath = contentObjectCachePath(input.cacheRoot, input.object.sha256);
  const pending = inFlightObjects.get(cachePath);
  if (pending) {
    return pending.then((result) => ({ ...result, reused: true }));
  }
  const created = ensureContentObjectWithRetries(input, cachePath).finally(() => {
    if (inFlightObjects.get(cachePath) === created) inFlightObjects.delete(cachePath);
  });
  inFlightObjects.set(cachePath, created);
  return created;
}

async function ensureContentObjectWithRetries(
  input: Parameters<typeof ensureContentObject>[0],
  cachePath: string
): Promise<ContentObjectResult> {
  for (let attempt = 1; attempt <= MAX_CONTENT_OBJECT_DOWNLOAD_ATTEMPTS; attempt += 1) {
    const telemetry: MutableTransferAttempt = {
      responseStatus: null,
      contentRange: null,
      resumedFromBytes: 0,
      bytesTransferred: 0,
    };
    const startedAt = Date.now();
    try {
      const result = await input.transferScheduler.run(input.signal, () =>
        ensureContentObjectExclusive(input, cachePath, attempt > 1, telemetry)
      );
      emitTransferEvent(input, attempt, startedAt, telemetry, {
        outcome: result.reused ? 'cache-hit' : 'success',
        errorClass: null,
      });
      return result;
    } catch (error) {
      if (error instanceof HostedReferenceTransportError) {
        if (error.responseStatus !== null) telemetry.responseStatus = error.responseStatus;
        if (error.contentRange !== null) telemetry.contentRange = error.contentRange;
      }
      const retryable =
        !input.signal.aborted &&
        isRetryableHostedReferenceTransportError(error) &&
        attempt < MAX_CONTENT_OBJECT_DOWNLOAD_ATTEMPTS;
      emitTransferEvent(input, attempt, startedAt, telemetry, {
        outcome: retryable ? 'retryable-failure' : 'terminal-failure',
        errorClass: transferErrorClass(error),
      });
      if (!retryable) {
        throw error;
      }
      await waitForContentObjectRetry(attempt, input.signal);
    }
  }
  throw new Error('Portable content-object retry loop terminated without a result.');
}

async function ensureContentObjectExclusive(
  input: {
    readonly referenceId: string;
    readonly cacheRoot: string;
    readonly assetBaseUrl: URL;
    readonly fetchAsset: HostedReferenceFetch;
    readonly signal: AbortSignal;
    readonly object: ContentObjectIdentity;
    readonly label: string;
    readonly onDownloadedBytes: (bytes: number) => void;
    readonly instrumentation?: PortablePreparedReferenceHydratorInstrumentation;
  },
  cachePath: string,
  requireResumedRange = false,
  telemetry: MutableTransferAttempt
): Promise<ContentObjectResult> {
  const expectedKey = portablePreparedReferenceContentObjectKeyV1(input.object.sha256);
  if (input.object.objectKey !== expectedKey) {
    throw new Error(`Portable object key must be ${expectedKey}.`);
  }
  await ensureOwnedDirectoryTree(
    input.cacheRoot,
    dirname(cachePath),
    'Portable content object cache'
  );
  if (await admitVerifiedFile(cachePath, input.object, input.instrumentation)) {
    return { path: cachePath, reused: true };
  }
  await removeVerifiedFile(cachePath);
  const partialPath = `${cachePath}.partial`;
  let partialBytes = await resumablePartialLength(partialPath, input.object.byteLength);
  telemetry.resumedFromBytes = partialBytes;
  let hash = createHash('sha256');
  if (partialBytes > 0) {
    await hashFile(partialPath, hash, input.instrumentation);
    if (partialBytes === input.object.byteLength) {
      if (hash.digest('hex') === input.object.sha256) {
        await rename(partialPath, cachePath);
        await sealVerifiedFile(cachePath, input.object);
        return { path: cachePath, reused: true };
      }
      await rm(partialPath, { force: true });
      partialBytes = 0;
      hash = createHash('sha256');
    }
  }

  const url = resolveHostedReferenceAssetUrl(input.assetBaseUrl, input.object.objectKey);
  const response = await requestHostedReferenceAsset({
    url,
    label: input.label,
    fetchAsset: input.fetchAsset,
    signal: input.signal,
    rangeStart: partialBytes > 0 ? partialBytes : undefined,
  });
  telemetry.responseStatus = response.status;
  telemetry.contentRange = response.headers.get('content-range');
  if (partialBytes > 0 && response.status === 200) {
    if (requireResumedRange) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Hosted ${input.label} did not honor the required retry range at byte ${partialBytes}.`
      );
    }
    await rm(partialPath, { force: true });
    partialBytes = 0;
    hash = createHash('sha256');
  } else if (partialBytes > 0) {
    requireValidContentRange(response, partialBytes, input.object.byteLength, input.label);
  }
  if (!response.ok || (response.status !== 200 && response.status !== 206)) {
    throw new Error(`Could not download hosted ${input.label}: HTTP ${response.status}.`);
  }
  if (!response.body) {
    throw new Error(`Could not download hosted ${input.label}: response body was empty.`);
  }

  const destination = await open(partialPath, partialBytes > 0 ? 'a' : 'w', 0o600);
  let byteLength = partialBytes;
  let discardPartial = false;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (input.signal.aborted) {
        throw new HostedReferenceTransportError(
          `Could not download hosted ${input.label}: download was cancelled.`,
          { retryable: false, kind: 'abort' }
        );
      }
      const chunk = Buffer.from(value);
      telemetry.bytesTransferred += chunk.byteLength;
      byteLength += chunk.byteLength;
      if (byteLength > input.object.byteLength) {
        discardPartial = true;
        throw new Error(`${input.label} exceeds its admitted byte length.`);
      }
      hash.update(chunk);
      await writeFileHandleCompletely(destination, chunk);
      input.onDownloadedBytes(chunk.byteLength);
    }
    await destination.sync();
  } catch (error) {
    if (discardPartial) {
      await destination.close();
      await rm(partialPath, { force: true });
      throw error;
    }
    throw error;
  } finally {
    reader.releaseLock();
    if (!discardPartial) await destination.close();
  }
  if (byteLength !== input.object.byteLength) {
    throw new HostedReferenceTransportError(
      `${input.label} download ended after ${byteLength} of ${input.object.byteLength} admitted bytes.`,
      { retryable: true }
    );
  }
  if (hash.digest('hex') !== input.object.sha256) {
    await rm(partialPath, { force: true });
    throw new Error(`${input.label} checksum does not match its admission record.`);
  }
  await rename(partialPath, cachePath);
  await sealVerifiedFile(cachePath, input.object);
  return { path: cachePath, reused: false };
}

function tierObjectUnion(
  bundle: PortablePreparedReferenceBundleV1,
  tiers: readonly PortablePreparedReferenceReadinessTierV1[]
): PortablePreparedReferenceObjectV1[] {
  const seen = new Set<string>();
  const objects: PortablePreparedReferenceObjectV1[] = [];
  for (const tier of tiers) {
    for (const object of portablePreparedReferenceObjectsForTierV1(bundle, tier)) {
      if (seen.has(object.id)) continue;
      seen.add(object.id);
      objects.push(object);
    }
  }
  return objects;
}

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        await worker(values[index] as T);
      }
    })
  );
}

function contentObjectCachePath(cacheRoot: string, sha256: string): string {
  const path = resolve(cacheRoot, OBJECT_CACHE_DIRECTORY, 'sha256', sha256.slice(0, 2), sha256);
  assertAtOrBelow(cacheRoot, path, 'Portable content object cache');
  return path;
}

async function resumablePartialLength(path: string, maximum: number): Promise<number> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximum) {
      await rm(path, { force: true });
      return 0;
    }
    return metadata.size;
  } catch {
    return 0;
  }
}

interface VerifiedObjectReceiptV1 {
  readonly contract: typeof VERIFIED_OBJECT_RECEIPT_V1;
  readonly sha256: string;
  readonly byteLength: number;
  readonly stat: StableStatIdentity;
}

interface StableStatIdentity {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly mode: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

async function admitVerifiedFile(
  path: string,
  identity: Pick<ContentObjectIdentity, 'sha256' | 'byteLength'>,
  instrumentation?: PortablePreparedReferenceHydratorInstrumentation
): Promise<boolean> {
  const statIdentity = await stableRegularFileStat(path);
  if (!statIdentity || BigInt(statIdentity.size) !== BigInt(identity.byteLength)) return false;
  if (await verifiedReceiptMatches(path, identity, statIdentity)) return true;
  if ((await sha256File(path, instrumentation)) !== identity.sha256) return false;
  await sealVerifiedFile(path, identity);
  return true;
}

async function verifiedReceiptMatches(
  path: string,
  identity: Pick<ContentObjectIdentity, 'sha256' | 'byteLength'>,
  statIdentity: StableStatIdentity
): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(verifiedReceiptPath(path), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const receipt = parsed as Record<string, unknown>;
    return (
      Object.keys(receipt).sort().join(',') === 'byteLength,contract,sha256,stat' &&
      receipt.contract === VERIFIED_OBJECT_RECEIPT_V1 &&
      receipt.sha256 === identity.sha256 &&
      receipt.byteLength === identity.byteLength &&
      sameStableStat(receipt.stat, statIdentity)
    );
  } catch {
    return false;
  }
}

async function sealVerifiedFile(
  path: string,
  identity: Pick<ContentObjectIdentity, 'sha256' | 'byteLength'>
): Promise<void> {
  await chmod(path, 0o444);
  const statIdentity = await stableRegularFileStat(path);
  if (!statIdentity || BigInt(statIdentity.size) !== BigInt(identity.byteLength)) {
    throw new Error('Verified portable object changed before its receipt was committed.');
  }
  await writeVerifiedReceipt(path, identity, statIdentity);
}

async function sealHardLinkedPair(
  cachePath: string,
  destinationPath: string,
  identity: Pick<ContentObjectIdentity, 'sha256' | 'byteLength'>
): Promise<void> {
  await chmod(cachePath, 0o444);
  const [cacheStat, destinationStat] = await Promise.all([
    stableRegularFileStat(cachePath),
    stableRegularFileStat(destinationPath),
  ]);
  if (
    !cacheStat ||
    !destinationStat ||
    cacheStat.device !== destinationStat.device ||
    cacheStat.inode !== destinationStat.inode ||
    cacheStat.size !== destinationStat.size ||
    BigInt(cacheStat.size) !== BigInt(identity.byteLength)
  ) {
    throw new Error('Portable hard-link materialization lost its shared object identity.');
  }
  await Promise.all([
    writeVerifiedReceipt(cachePath, identity, cacheStat),
    writeVerifiedReceipt(destinationPath, identity, destinationStat),
  ]);
}

async function writeVerifiedReceipt(
  path: string,
  identity: Pick<ContentObjectIdentity, 'sha256' | 'byteLength'>,
  statIdentity: StableStatIdentity
): Promise<void> {
  const receipt: VerifiedObjectReceiptV1 = {
    contract: VERIFIED_OBJECT_RECEIPT_V1,
    sha256: identity.sha256,
    byteLength: identity.byteLength,
    stat: statIdentity,
  };
  const receiptPath = verifiedReceiptPath(path);
  const temporaryPath = `${receiptPath}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await writeFileHandleCompletely(handle, Buffer.from(`${JSON.stringify(receipt)}\n`));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, receiptPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function removeVerifiedFile(path: string): Promise<void> {
  await Promise.all([rm(path, { force: true }), rm(verifiedReceiptPath(path), { force: true })]);
}

function verifiedReceiptPath(path: string): string {
  return `${path}.verified.v1.json`;
}

async function stableRegularFileStat(path: string): Promise<StableStatIdentity | null> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    return {
      device: metadata.dev.toString(),
      inode: metadata.ino.toString(),
      size: metadata.size.toString(),
      mode: metadata.mode.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
      ctimeNs: metadata.ctimeNs.toString(),
    };
  } catch {
    return null;
  }
}

function sameStableStat(value: unknown, expected: StableStatIdentity): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stat = value as Record<string, unknown>;
  return (
    Object.keys(stat).sort().join(',') === 'ctimeNs,device,inode,mode,mtimeNs,size' &&
    stat.device === expected.device &&
    stat.inode === expected.inode &&
    stat.size === expected.size &&
    stat.mode === expected.mode &&
    stat.mtimeNs === expected.mtimeNs &&
    stat.ctimeNs === expected.ctimeNs
  );
}

async function sameInode(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([
    stableRegularFileStat(left),
    stableRegularFileStat(right),
  ]);
  return Boolean(
    leftStat &&
    rightStat &&
    leftStat.device === rightStat.device &&
    leftStat.inode === rightStat.inode &&
    leftStat.size === rightStat.size
  );
}

async function sha256File(
  path: string,
  instrumentation?: PortablePreparedReferenceHydratorInstrumentation
): Promise<string> {
  const hash = createHash('sha256');
  await hashFile(path, hash, instrumentation);
  return hash.digest('hex');
}

async function hashFile(
  path: string,
  hash: ReturnType<typeof createHash>,
  instrumentation?: PortablePreparedReferenceHydratorInstrumentation
): Promise<void> {
  instrumentation?.onPayloadHashRead?.(path);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
}

export async function writeFileHandleCompletely(
  handle: Pick<FileHandle, 'write'>,
  bytes: Uint8Array
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) {
      throw new Error('Portable object write made no forward progress.');
    }
    offset += bytesWritten;
  }
}

function requireValidContentRange(
  response: Response,
  start: number,
  total: number,
  label: string
): void {
  const contentRange = response.headers.get('content-range');
  const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(contentRange ?? '');
  if (
    response.status !== 206 ||
    !match ||
    Number(match[1]) !== start ||
    Number(match[2]) !== total - 1 ||
    Number(match[3]) !== total
  ) {
    throw new Error(`Hosted ${label} returned an invalid resume range.`);
  }
}

async function materializeObject(
  ownershipRoot: string,
  cachePath: string,
  destinationPath: string,
  object: PortablePreparedReferenceObjectV1,
  instrumentation?: PortablePreparedReferenceHydratorInstrumentation
): Promise<void> {
  return materializeIdentity(
    ownershipRoot,
    cachePath,
    destinationPath,
    object,
    object.id,
    instrumentation
  );
}

async function materializeIdentity(
  ownershipRoot: string,
  cachePath: string,
  destinationPath: string,
  identity: Pick<ContentObjectIdentity, 'sha256' | 'byteLength'>,
  label: string,
  instrumentation?: PortablePreparedReferenceHydratorInstrumentation
): Promise<void> {
  await ensureOwnedDirectoryTree(
    ownershipRoot,
    dirname(destinationPath),
    `Portable object ${label} destination`
  );
  await assertOwnedPathAncestry(
    ownershipRoot,
    destinationPath,
    `Portable object ${label} destination`
  );
  const destinationStat = await stableRegularFileStat(destinationPath);
  if (
    destinationStat &&
    BigInt(destinationStat.size) === BigInt(identity.byteLength) &&
    (await verifiedReceiptMatches(destinationPath, identity, destinationStat))
  ) {
    return;
  }
  if (await sameInode(cachePath, destinationPath)) {
    await sealHardLinkedPair(cachePath, destinationPath, identity);
    return;
  }
  if (await admitVerifiedFile(destinationPath, identity, instrumentation)) return;

  instrumentation?.onIndividualObjectMaterialization?.(destinationPath);
  await removeVerifiedFile(destinationPath);
  const temporaryPath = `${destinationPath}.${randomUUID()}.tmp`;
  let hardLinked = false;
  try {
    try {
      await link(cachePath, temporaryPath);
      hardLinked = true;
    } catch {
      try {
        await copyFile(cachePath, temporaryPath, fsConstants.COPYFILE_FICLONE_FORCE);
      } catch {
        await copyFile(cachePath, temporaryPath);
      }
    }
    if (hardLinked) {
      if (!(await sameInode(cachePath, temporaryPath))) {
        throw new Error(`Portable object ${label} hard-link identity changed.`);
      }
    } else if (!(await admitVerifiedFile(temporaryPath, identity, instrumentation))) {
      throw new Error(`Portable object ${label} changed during clone/copy materialization.`);
    }
    await rename(temporaryPath, destinationPath);
    if (hardLinked) {
      await sealHardLinkedPair(cachePath, destinationPath, identity);
    } else {
      await sealVerifiedFile(destinationPath, identity);
    }
  } finally {
    await Promise.all([
      rm(temporaryPath, { force: true }),
      rm(verifiedReceiptPath(temporaryPath), { force: true }),
    ]);
  }
}

function recordsForAddresses(
  surfaceManifest: CompiledBroadSurfaceManifestV2,
  records: readonly CompiledBroadRasterCellRecordV1[],
  addresses: readonly CompiledBroadRasterCellAddressV1[]
): CompiledBroadRasterCellRecordV1[] {
  const byAddress = new Map(
    records.map((record) => [
      `${record.isoformMode}:${record.level}:${record.tileX}:${record.laneSlabIndex}`,
      record,
    ])
  );
  return addresses.map((address) => {
    const addressKey = `${address.isoformMode}:${address.level}:${address.tileX}:${address.laneSlabIndex}`;
    const record = byAddress.get(addressKey);
    if (!record) {
      throw new Error(
        `Portable broad-raster manifest has no cell for ${surfaceManifest.trackId}:${addressKey}.`
      );
    }
    return record;
  });
}

async function publishTierMarkers(
  ownershipRoot: string,
  generationRoot: string,
  bundleManifestSha256: string,
  bundle: PortablePreparedReferenceBundleV1,
  tiers: readonly PortablePreparedReferenceReadinessTierV1[],
  concurrency: number
): Promise<void> {
  const markerRoot = join(generationRoot, '.readiness');
  await ensureOwnedDirectoryTree(ownershipRoot, markerRoot, 'Portable readiness marker directory');
  for (const tier of tiers) {
    const objects = portablePreparedReferenceObjectsForTierV1(bundle, tier);
    const paths = objects.map((object) => resolve(generationRoot, object.installPath));
    if (
      !(await assertOwnedFileSetAncestry(
        ownershipRoot,
        paths,
        `Portable ${tier} readiness members`,
        concurrency
      ))
    ) {
      throw new Error(`Portable ${tier} readiness member ancestry disappeared before admission.`);
    }
    const memberStats = new Map<string, StableStatIdentity>();
    await runBounded(objects, concurrency, async (object) => {
      const path = resolve(generationRoot, object.installPath);
      assertAtOrBelow(generationRoot, path, `Portable ${tier} readiness member`);
      const statIdentity = await stableRegularFileStat(path);
      if (!statIdentity || BigInt(statIdentity.size) !== BigInt(object.byteLength)) {
        throw new Error(
          `Portable ${tier} member ${object.id} changed before atomic tier admission.`
        );
      }
      memberStats.set(object.id, statIdentity);
    });
    const markerPath = tierAdmissionPath(generationRoot, tier);
    const temporaryPath = `${markerPath}.${randomUUID()}.tmp`;
    await assertOwnedPathAncestry(ownershipRoot, markerPath, `Portable ${tier} readiness marker`);
    await assertOwnedPathAncestry(
      ownershipRoot,
      temporaryPath,
      `Portable ${tier} temporary readiness marker`
    );
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await writeFileHandleCompletely(
          handle,
          Buffer.from(
            `${JSON.stringify({
              contract: PREPARED_REFERENCE_TIER_ADMISSION_V2,
              bundleManifestSha256,
              bundleFingerprint: bundle.bundleFingerprint,
              tier,
              members: objects.map((object) => ({
                id: object.id,
                sha256: object.sha256,
                byteLength: object.byteLength,
                installPath: object.installPath,
                stat: memberStats.get(object.id),
              })),
            })}\n`
          )
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, markerPath);
      await syncDirectoryRename(markerRoot);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

async function admitExistingTierGeneration(input: {
  readonly ownershipRoot: string;
  readonly generationRoot: string;
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly tier: PortablePreparedReferenceReadinessTierV1;
  readonly concurrency: number;
}): Promise<ReadonlyMap<string, string> | null> {
  const markerPath = tierAdmissionPath(input.generationRoot, input.tier);
  await assertOwnedPathAncestry(
    input.ownershipRoot,
    markerPath,
    `Portable ${input.tier} tier admission`
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(markerPath, 'utf8')) as unknown;
  } catch (error) {
    if (
      (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') ||
      error instanceof SyntaxError
    ) {
      return null;
    }
    throw error;
  }
  const objects = portablePreparedReferenceObjectsForTierV1(input.bundle, input.tier);
  let admittedStats: ReadonlyMap<string, StableStatIdentity>;
  try {
    admittedStats = parseTierAdmission(parsed, {
      bundleManifestSha256: input.bundleManifestSha256,
      bundle: input.bundle,
      tier: input.tier,
      objects,
    });
  } catch {
    return null;
  }
  const paths = new Map<string, string>();
  for (const object of objects) {
    const path = resolve(input.generationRoot, object.installPath);
    assertAtOrBelow(input.generationRoot, path, `Portable ${input.tier} tier member`);
    paths.set(object.id, path);
  }
  if (
    !(await assertOwnedFileSetAncestry(
      input.ownershipRoot,
      [...paths.values()],
      `Portable ${input.tier} tier members`,
      input.concurrency
    ))
  ) {
    return null;
  }
  let valid = true;
  await runBounded(objects, input.concurrency, async (object) => {
    if (!valid) return;
    if (
      await hostedObjectSatisfiedByBgzfFastaMigration({
        generationRoot: input.generationRoot,
        object,
      })
    ) {
      return;
    }
    const path = paths.get(object.id)!;
    const statIdentity = await stableRegularFileStat(path);
    const admittedStat = admittedStats.get(object.id);
    if (
      !statIdentity ||
      !admittedStat ||
      BigInt(statIdentity.size) !== BigInt(object.byteLength) ||
      !sameStableStat(admittedStat, statIdentity)
    ) {
      valid = false;
    }
  });
  return valid ? paths : null;
}

function parseTierAdmission(
  value: unknown,
  expected: {
    readonly bundleManifestSha256: string;
    readonly bundle: PortablePreparedReferenceBundleV1;
    readonly tier: PortablePreparedReferenceReadinessTierV1;
    readonly objects: readonly PortablePreparedReferenceObjectV1[];
  }
): ReadonlyMap<string, StableStatIdentity> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Portable tier admission is not an object.');
  }
  const admission = value as Record<string, unknown>;
  if (
    Object.keys(admission).sort().join(',') !==
      'bundleFingerprint,bundleManifestSha256,contract,members,tier' ||
    admission.contract !== PREPARED_REFERENCE_TIER_ADMISSION_V2 ||
    admission.bundleManifestSha256 !== expected.bundleManifestSha256 ||
    admission.bundleFingerprint !== expected.bundle.bundleFingerprint ||
    admission.tier !== expected.tier ||
    !Array.isArray(admission.members) ||
    admission.members.length !== expected.objects.length
  ) {
    throw new Error('Portable tier admission identity does not match.');
  }
  const stats = new Map<string, StableStatIdentity>();
  for (const [index, object] of expected.objects.entries()) {
    const valueAtIndex = admission.members[index];
    if (!valueAtIndex || typeof valueAtIndex !== 'object' || Array.isArray(valueAtIndex)) {
      throw new Error('Portable tier admission member is invalid.');
    }
    const member = valueAtIndex as Record<string, unknown>;
    if (
      Object.keys(member).sort().join(',') !== 'byteLength,id,installPath,sha256,stat' ||
      member.id !== object.id ||
      member.sha256 !== object.sha256 ||
      member.byteLength !== object.byteLength ||
      member.installPath !== object.installPath
    ) {
      throw new Error('Portable tier admission member identity does not match.');
    }
    stats.set(object.id, parseStableStatIdentity(member.stat));
  }
  return stats;
}

function tierAdmissionPath(
  generationRoot: string,
  tier: PortablePreparedReferenceReadinessTierV1
): string {
  return join(generationRoot, '.readiness', `${tier}.v2.json`);
}

async function ensureCanonicalOwnedCacheRoot(configuredRoot: string): Promise<string> {
  let existingAncestor = resolve(configuredRoot);
  const missingSegments: string[] = [];

  for (;;) {
    try {
      const metadata = await lstat(existingAncestor);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('Portable reference cache root ancestry is not a plain directory.');
      }
      let canonicalRoot = await realpath(existingAncestor);
      for (const segment of missingSegments) {
        const next = join(canonicalRoot, segment);
        try {
          await mkdir(next, { mode: 0o700 });
        } catch (error) {
          if (!hasErrorCode(error, 'EEXIST')) throw error;
        }
        const created = await lstat(next);
        if (created.isSymbolicLink() || !created.isDirectory()) {
          throw new Error('Portable reference cache root ancestry is not a plain directory.');
        }
        canonicalRoot = next;
      }
      return canonicalRoot;
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new Error('Portable reference cache root has no existing directory ancestor.');
      }
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

async function ensureOwnedDirectoryTree(
  ownershipRoot: string,
  directory: string,
  label: string
): Promise<void> {
  const root = resolve(ownershipRoot);
  const target = resolve(directory);
  assertAtOrBelow(root, target, label);
  await requirePlainDirectory(root, `${label} root`);
  const relativePath = relative(root, target);
  if (relativePath === '') return;

  let cursor = root;
  for (const segment of relativePath.split(sep)) {
    cursor = join(cursor, segment);
    try {
      await mkdir(cursor, { mode: 0o700 });
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
    await requirePlainDirectory(cursor, label);
  }
}

async function assertOwnedPathAncestry(
  ownershipRoot: string,
  candidate: string,
  label: string
): Promise<void> {
  const root = resolve(ownershipRoot);
  const target = resolve(candidate);
  assertAtOrBelow(root, target, label);
  await requirePlainDirectory(root, `${label} root`);
  const relativePath = relative(root, target);
  if (relativePath === '') return;

  const segments = relativePath.split(sep);
  let cursor = root;
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment);
    let metadata;
    try {
      metadata = await lstat(cursor);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} traverses a symbolic link outside its owned cache ancestry.`);
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw new Error(`${label} traverses a non-directory cache ancestor.`);
    }
  }
}

async function assertOwnedFileSetAncestry(
  ownershipRoot: string,
  candidates: readonly string[],
  label: string,
  concurrency: number
): Promise<boolean> {
  const root = resolve(ownershipRoot);
  await requirePlainDirectory(root, `${label} root`);
  const directories = new Set<string>();
  for (const candidate of candidates) {
    const target = resolve(candidate);
    assertAtOrBelow(root, target, label);
    const relativeDirectory = relative(root, dirname(target));
    if (relativeDirectory === '') continue;
    let cursor = root;
    for (const segment of relativeDirectory.split(sep)) {
      cursor = join(cursor, segment);
      directories.add(cursor);
    }
  }

  let complete = true;
  await runBounded([...directories], concurrency, async (directory) => {
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        complete = false;
        return;
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} traverses a symbolic link outside its owned cache ancestry.`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`${label} traverses a non-directory cache ancestor.`);
    }
  });
  return complete;
}

async function requireOwnedDirectory(
  ownershipRoot: string,
  directory: string,
  label: string
): Promise<void> {
  await assertOwnedPathAncestry(ownershipRoot, directory, label);
  await requirePlainDirectory(directory, label);
}

async function requirePlainDirectory(directory: string, label: string): Promise<void> {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} is not a plain directory.`);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function assertAtOrBelow(root: string, candidate: string, label: string): void {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (
    relativePath !== '' &&
    (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`))
  ) {
    throw new Error(`${label} escaped its owned root.`);
  }
}
