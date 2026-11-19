import { randomUUID } from 'node:crypto';

import type { CompiledBroadSurfaceManifestV2 } from '@waypoint/genome-renderer/pure';

import {
  ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
  buildAssemblyCompiledBroadRasterSurfaceManifestV1,
  type AssemblyCompiledBroadRasterCatalogCapabilityV1,
  type AssemblyCompiledBroadRasterCatalogReceiptV1,
  type AssemblyCompiledBroadRasterManifestRequestV1,
} from '../../shared/indexed-genome';
import {
  assemblyCompiledBroadRasterArtifactDirectory,
  readAssemblyAnnotationSceneCacheIndex,
  type AssemblyAnnotationSceneCacheIndexHit,
  type AssemblyTextureCacheDeps,
} from './assembly-overview-texture-cache';
import { buildAssemblyCompiledBroadRasterCatalogReceiptV1 } from '../../shared/compiled-broad-raster-catalog-receipt';
import {
  openCompiledBroadRasterArtifactV1,
  type CompiledBroadRasterArtifactReaderV1,
} from './compiled-broad-raster-artifact';

const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_FINGERPRINT = /^[0-9a-f]{24}$/;
const PLACEMENT_FINGERPRINT = /^ap1:[0-9a-f]{24}$/;
const DEFAULT_MAX_OPENINGS = 1_024;

export interface AssemblyCompiledBroadRasterSceneIdentityV1 extends Pick<
  AssemblyAnnotationSceneCacheIndexHit,
  'fingerprint' | 'placementFingerprint' | 'payloadSha256' | 'sourceBuildFingerprint' | 'artifact'
> {
  readonly manifest: Pick<AssemblyAnnotationSceneCacheIndexHit['manifest'], 'integrity'>;
}

export interface AssemblyCompiledBroadRasterCatalogOpeningV1 {
  readonly request: AssemblyCompiledBroadRasterManifestRequestV1;
  readonly sceneIndex: AssemblyCompiledBroadRasterSceneIdentityV1;
  readonly surfaceManifest: CompiledBroadSurfaceManifestV2;
  readonly artifactDirectory: string;
  readonly readerRevisionKey: string;
  readonly reader: CompiledBroadRasterArtifactReaderV1;
  readonly readCells?: CompiledBroadRasterArtifactReaderV1['readCells'];
}

export interface AssemblyCompiledBroadRasterCatalogOpenDepsV1 {
  readonly assertSafePath: (path: string) => Promise<void>;
  readonly sourceBuildFingerprint: string;
  readonly readSceneIndex?: typeof readAssemblyAnnotationSceneCacheIndex;
  readonly buildSurfaceManifest?: typeof buildAssemblyCompiledBroadRasterSurfaceManifestV1;
  readonly artifactDirectory?: typeof assemblyCompiledBroadRasterArtifactDirectory;
  readonly openArtifact?: typeof openCompiledBroadRasterArtifactV1;
  readonly readerCache?: Map<string, Promise<CompiledBroadRasterArtifactReaderV1>>;
  readonly maximumReaderCacheEntries?: number;
  readonly sceneCacheDeps?: Partial<AssemblyTextureCacheDeps>;
}

export async function openAssemblyCompiledBroadRasterCatalogV1(
  input: AssemblyCompiledBroadRasterManifestRequestV1,
  deps: AssemblyCompiledBroadRasterCatalogOpenDepsV1
): Promise<AssemblyCompiledBroadRasterCatalogOpeningV1 | null> {
  if (
    input?.contract !== ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1 ||
    !input.scene ||
    typeof deps?.sourceBuildFingerprint !== 'string' ||
    deps.sourceBuildFingerprint.length === 0
  ) {
    return null;
  }
  await deps.assertSafePath(input.scene.workspaceRoot);
  const readSceneIndex = deps.readSceneIndex ?? readAssemblyAnnotationSceneCacheIndex;
  const indexed = await readSceneIndex(input.scene, {
    ...deps.sceneCacheDeps,
    assertSafePath: deps.assertSafePath,
    sourceBuildFingerprint: deps.sourceBuildFingerprint,
  });
  if (!indexed || indexed.status !== 'hit') return null;
  if (
    !SOURCE_FINGERPRINT.test(indexed.fingerprint) ||
    !PLACEMENT_FINGERPRINT.test(indexed.placementFingerprint) ||
    indexed.payloadSha256 !== indexed.manifest.integrity.payloadSha256
  ) {
    return null;
  }
  const buildSurfaceManifest =
    deps.buildSurfaceManifest ?? buildAssemblyCompiledBroadRasterSurfaceManifestV1;
  const surfaceManifest = await buildSurfaceManifest({
    sceneManifest: indexed.manifest,
    artifact: indexed.artifact,
    appearance: input.appearance,
  });
  const artifactDirectory = (
    deps.artifactDirectory ?? assemblyCompiledBroadRasterArtifactDirectory
  )({
    request: input.scene,
    sourceFingerprint: indexed.fingerprint,
    surfaceManifestFingerprint: surfaceManifest.manifestFingerprint,
  });
  if (!artifactDirectory) return null;
  await deps.assertSafePath(artifactDirectory);

  const readerRevisionKey = assemblyCompiledBroadRasterReaderRevisionKeyV1({
    workspaceRoot: input.scene.workspaceRoot,
    sourceFingerprint: indexed.fingerprint,
    placementFingerprint: indexed.placementFingerprint,
    scenePayloadSha256: indexed.payloadSha256,
    sceneContractSha256: indexed.manifest.integrity.contractSha256,
    sceneSourceBuildFingerprint: indexed.sourceBuildFingerprint,
    surfaceManifestFingerprint: surfaceManifest.manifestFingerprint,
    artifactDirectory,
  });
  if (!readerRevisionKey) return null;
  const openArtifact = deps.openArtifact ?? openCompiledBroadRasterArtifactV1;
  const cache = deps.readerCache;
  let pending = cache?.get(readerRevisionKey);
  if (!pending) {
    pending = openArtifact({
      artifactDirectory,
      expectedSurfaceManifestFingerprint: surfaceManifest.manifestFingerprint,
    });
    if (cache) {
      cache.set(readerRevisionKey, pending);
      pending.catch(() => {
        if (cache.get(readerRevisionKey) === pending) cache.delete(readerRevisionKey);
      });
      const maximum = Math.max(1, deps.maximumReaderCacheEntries ?? 8);
      while (cache.size > maximum) {
        const oldest = cache.keys().next().value as string | undefined;
        if (!oldest || oldest === readerRevisionKey) break;
        cache.delete(oldest);
      }
    }
  }
  const reader = await pending;
  if (
    reader.manifest.surfaceManifest.manifestFingerprint !== surfaceManifest.manifestFingerprint ||
    reader.manifest.surfaceManifest.artifactKey !== surfaceManifest.artifactKey ||
    reader.manifest.surfaceManifest.trackId !== surfaceManifest.trackId
  ) {
    if (cache?.get(readerRevisionKey) === pending) cache.delete(readerRevisionKey);
    return null;
  }
  return Object.freeze({
    request: input,
    sceneIndex: indexed,
    surfaceManifest,
    artifactDirectory,
    readerRevisionKey,
    reader,
  });
}

export function assemblyCompiledBroadRasterReaderRevisionKeyV1(input: {
  readonly workspaceRoot: string;
  readonly sourceFingerprint: string;
  readonly placementFingerprint: string;
  readonly scenePayloadSha256: string;
  readonly sceneContractSha256: string;
  readonly sceneSourceBuildFingerprint: string;
  readonly surfaceManifestFingerprint: string;
  readonly artifactDirectory: string;
}): string | null {
  if (
    typeof input.workspaceRoot !== 'string' ||
    input.workspaceRoot.length === 0 ||
    !SOURCE_FINGERPRINT.test(input.sourceFingerprint) ||
    !PLACEMENT_FINGERPRINT.test(input.placementFingerprint) ||
    !SHA256.test(input.scenePayloadSha256) ||
    !SHA256.test(input.sceneContractSha256) ||
    !SHA256.test(input.sceneSourceBuildFingerprint) ||
    !SHA256.test(input.surfaceManifestFingerprint) ||
    typeof input.artifactDirectory !== 'string' ||
    input.artifactDirectory.length === 0
  ) {
    return null;
  }
  return [
    'assembly-compiled-broad-raster-reader-revision.v1',
    input.workspaceRoot,
    input.sourceFingerprint,
    input.placementFingerprint,
    input.scenePayloadSha256,
    input.sceneContractSha256,
    input.sceneSourceBuildFingerprint,
    input.surfaceManifestFingerprint,
    input.artifactDirectory,
  ].join('\n');
}

type CatalogCapabilityEntry = Readonly<{
  ownerId: number;
  catalogReceipt: AssemblyCompiledBroadRasterCatalogReceiptV1;
  catalogCapability: AssemblyCompiledBroadRasterCatalogCapabilityV1;
  opening: AssemblyCompiledBroadRasterCatalogOpeningV1;
}>;

export class AssemblyCompiledBroadRasterCatalogCapabilityRegistryV1 {
  readonly #entries = new Map<string, CatalogCapabilityEntry>();
  readonly #maximumOpenings: number;
  readonly #idFactory: () => string;

  constructor(input: { maximumOpenings?: number; idFactory?: () => string } = {}) {
    this.#maximumOpenings = Math.max(1, input.maximumOpenings ?? DEFAULT_MAX_OPENINGS);
    this.#idFactory = input.idFactory ?? randomUUID;
  }

  issue(
    ownerId: number,
    opening: AssemblyCompiledBroadRasterCatalogOpeningV1
  ): Readonly<{
    catalogReceipt: AssemblyCompiledBroadRasterCatalogReceiptV1;
    catalogCapability: AssemblyCompiledBroadRasterCatalogCapabilityV1;
  }> | null {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return null;
    const catalogReceipt = buildAssemblyCompiledBroadRasterCatalogReceiptV1(opening);
    if (!catalogReceipt) return null;
    const openingId = this.#idFactory();
    if (typeof openingId !== 'string' || openingId.length < 16 || this.#entries.has(openingId)) {
      return null;
    }
    const catalogCapability: AssemblyCompiledBroadRasterCatalogCapabilityV1 = Object.freeze({
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1,
      openingId,
      catalogReceiptSha256: catalogReceipt.receiptSha256,
      catalogFingerprint: catalogReceipt.catalogFingerprint,
      surfaceManifestFingerprint: catalogReceipt.surfaceManifestFingerprint,
    });
    this.#entries.set(
      openingId,
      Object.freeze({ ownerId, catalogReceipt, catalogCapability, opening })
    );
    while (this.#entries.size > this.#maximumOpenings) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest || oldest === openingId) break;
      this.#entries.delete(oldest);
    }
    return Object.freeze({ catalogReceipt, catalogCapability });
  }

  resolve(
    ownerId: number,
    capability: AssemblyCompiledBroadRasterCatalogCapabilityV1
  ): CatalogCapabilityEntry | null {
    if (
      capability?.contract !== ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1 ||
      !Number.isSafeInteger(ownerId) ||
      ownerId <= 0
    ) {
      return null;
    }
    const entry = this.#entries.get(capability.openingId);
    if (
      !entry ||
      entry.ownerId !== ownerId ||
      entry.catalogCapability.catalogReceiptSha256 !== capability.catalogReceiptSha256 ||
      entry.catalogCapability.catalogFingerprint !== capability.catalogFingerprint ||
      entry.catalogCapability.surfaceManifestFingerprint !== capability.surfaceManifestFingerprint
    ) {
      return null;
    }
    return entry;
  }

  invalidate(capability: AssemblyCompiledBroadRasterCatalogCapabilityV1): void {
    if (capability?.contract === ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1) {
      this.#entries.delete(capability.openingId);
    }
  }

  releaseOwner(ownerId: number): void {
    for (const [openingId, entry] of this.#entries) {
      if (entry.ownerId === ownerId) this.#entries.delete(openingId);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}
