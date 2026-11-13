import {
  MAX_SEQUENCE_WINDOW_BASES,
  sequenceWindowRequestIssue,
} from '../../shared/genome-sequence-window';
import { compiledBroadRasterCellToWireV1 } from '../../shared/compiled-broad-raster-wire';
import { IndexedGenomeDataSource } from '@waypoint/genome-data';
import { UserMessageError, toUserMessage } from '@waypoint/user-messages';
import {
  createAnnotationViewportTile,
  validateAnnotationViewportTileRequest,
} from '../../shared/genome-annotation-tiles';
import {
  packPartitionedTranscriptSceneDetailPacketV1,
  slicePartitionedTranscriptSceneDetailRolesV1,
  validateCompiledBroadAnnotationInteractionBinaryV1,
  type PartitionedTranscriptSceneRoleSidecarV1,
} from '@waypoint/genome-renderer/pure';

import { ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN } from '../../features/sequence/annotation-layer-identity';
import {
  admitAnnotationRoleSidecarPayloadV1,
  annotationRoleSidecarDescriptorMatchesSceneV1,
} from '../../shared/assembly-annotation-role-sidecar';
import {
  openCompiledBroadRasterArtifactV1,
  type CompiledBroadRasterArtifactReaderV1,
} from '../../shared/compiled-broad-raster-artifact-reader';
import { buildAssemblyCompiledBroadRasterCatalogReceiptV1 } from '../../shared/compiled-broad-raster-catalog-receipt';
import {
  createGenomeSessionShell,
  updateGenomeSessionShellFromTabState,
} from '../../shared/genome-session-shell';
import type { HostedReferenceBrowserCatalogDefinitionV1 } from '../../shared/hosted-reference-browser-catalog';
import {
  ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  ASSEMBLY_COMPILED_BROAD_INTERACTION_IPC_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1,
  ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
  isAssemblyCompiledBroadRasterSingleCellBatchV1,
  type AssemblyAnnotationProductSetInventoryReadRequestV1,
  type AssemblyAnnotationProductSetInventoryReadResultV1,
  type AssemblyAnnotationSceneDetailReadRequestV1,
  type AssemblyAnnotationSceneDetailReadResultV1,
  type AssemblyAnnotationSceneReadRequest,
  type AssemblyAnnotationSceneReadResult,
  type AssemblyCompiledBroadInteractionHitResultV1,
  type AssemblyCompiledBroadRasterCatalogCapabilityV1,
  type AssemblyCompiledBroadRasterCellsRequestV1,
  type AssemblyCompiledBroadRasterCellsResultV1,
  type AssemblyCompiledBroadRasterManifestRequestV1,
  type AssemblyCompiledBroadRasterManifestResultV1,
  type GenomeOpenSource,
  type GenomeTileRequest,
  type GenomeTrackTile,
  type GenomeSequenceWindow,
  type GenomeSequenceWindowRequest,
  type GenomeSessionReleaseResult,
  type GenomeSessionShell,
  type IndexedGenomeManifest,
} from '../../shared/indexed-genome';
import {
  parsePortablePreparedReferenceBundleV1,
  type PortablePreparedReferenceBundleV1,
  type PortablePreparedReferenceObjectV1,
} from '../../shared/portable-reference/portable-prepared-reference-bundle';
import {
  assertPortableCatalogThemeRosterCoherence,
  parsePortablePreparedReferenceViewCatalogV1,
  type PortablePreparedReferenceViewCatalogEntryV1,
  type PortablePreparedReferenceViewCatalogV1,
} from '../../shared/portable-reference/portable-prepared-reference-view-catalog';
import {
  assertPortableFullThemeProductCoherenceV1,
  assertPortableProductViewReceiptsV1,
  parsePortableProductSetV1,
  portableAssetGenerationsByThemeV1,
  portableLocalCompactInteractionManifestV1,
  portablePlacementFingerprintV1,
  portableProductDatasetVersionV1,
  portableProductMatchesPreparedDefinitionV1,
  portableRequestMatchesProductV1,
  portableViewKeyV1,
  resealPortableSceneDiskManifestV1,
  type LocallyResealedPortableSceneManifestV1,
  type PortableAnnotationProductSetV2,
  type PortableSceneDiskManifestV1,
} from '../../shared/portable-reference/portable-view-admission';
import {
  parsePreparedReferenceDefinition,
  preparedReferenceAssemblyEntry,
  type PreparedReferenceDefinition,
} from '../../shared/portable-reference/prepared-reference-definition';
import type {
  HostedReferenceCatalogEntryV1,
  PreparedReferenceAssemblyEntryV1,
  ReferenceAssetGetHostedPreparationStatusRequestV1,
  ReferenceAssetHostedPreparationStatusV1,
  ReferenceAssetInstallHostedRequestV1,
  ReferenceAssetInstallHostedResultV1,
} from '../../shared/reference-assets-ipc';
import { sha256Hex } from '../../shared/sha256-sync';
import { HostedCapabilityError } from '../errors';
import {
  preparedReferenceObjectKeyV1,
  webCryptoSha256Hex,
  type PreparedReferenceObjectRefV1,
  type PreparedReferenceObjectStoreV1,
} from './object-store';

export type BrotliDecompressV1 = (
  bytes: Uint8Array,
  maxOutputLength: number
) => Promise<Uint8Array>;

export interface BrowserPreparedReferencesOptionsV1 {
  readonly store: PreparedReferenceObjectStoreV1;
  readonly definitions: readonly HostedReferenceBrowserCatalogDefinitionV1[];
  readonly cacheRoot: string;
  readonly publicationRoot: string;
  readonly brotliDecompress: BrotliDecompressV1;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

interface BrowserPortableAdmissionV1 {
  readonly definition: HostedReferenceBrowserCatalogDefinitionV1;
  readonly store: PreparedReferenceObjectStoreV1;
  readonly familyRoot: string;
  readonly generationRoot: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly objectsById: ReadonlyMap<string, PortablePreparedReferenceObjectV1>;
  readonly objectsByPath: ReadonlyMap<string, PortablePreparedReferenceObjectV1>;
  readonly catalog: PortablePreparedReferenceViewCatalogV1;
  readonly entriesByView: ReadonlyMap<string, PortablePreparedReferenceViewCatalogEntryV1>;
  readonly prepared: PreparedReferenceDefinition;
  readonly productsByTheme: ReadonlyMap<'dark' | 'light', PortableAnnotationProductSetV2>;
  readonly entry: PreparedReferenceAssemblyEntryV1;
  readonly publicationPointer: string;
}

interface BroadRasterOpeningV1 {
  readonly catalogCapability: AssemblyCompiledBroadRasterCatalogCapabilityV1;
  readonly reader: CompiledBroadRasterArtifactReaderV1;
}

const PUBLICATION_POINTER_FILE = 'current-reference-assets.v1.json';
const PORTABLE_ANNOTATION_SEARCH_MANIFEST_V1 = 'dnaforge-portable-annotation-search-manifest.v1';
const MAX_BROAD_RASTER_OPENINGS = 1_024;

export class BrowserPreparedReferencesV1 {
  readonly #store: PreparedReferenceObjectStoreV1;
  readonly #definitions: Map<string, HostedReferenceBrowserCatalogDefinitionV1>;
  readonly #addedStores = new Map<string, PreparedReferenceObjectStoreV1>();
  readonly #cacheRoot: string;
  readonly #publicationRoot: string;
  readonly #brotliDecompress: BrotliDecompressV1;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #admissions = new Map<string, Promise<BrowserPortableAdmissionV1>>();
  readonly #settled = new Map<string, BrowserPortableAdmissionV1>();
  readonly #sessions = new Map<string, GenomeSessionShell>();
  readonly #dataSources = new Map<string, IndexedGenomeDataSource>();
  readonly #rasterOpenings = new Map<string, BroadRasterOpeningV1>();
  readonly #roleSidecars = new Map<
    string,
    Promise<PartitionedTranscriptSceneRoleSidecarV1 | null>
  >();

  constructor(options: BrowserPreparedReferencesOptionsV1) {
    this.#store = options.store;
    this.#definitions = new Map(
      options.definitions.map((definition) => [definition.listing.id, definition])
    );
    this.#cacheRoot = trimTrailingSlash(options.cacheRoot);
    this.#publicationRoot = trimTrailingSlash(options.publicationRoot);
    this.#brotliDecompress = options.brotliDecompress;
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? (() => crypto.randomUUID());
  }

  addDefinition(
    definition: HostedReferenceBrowserCatalogDefinitionV1,
    store: PreparedReferenceObjectStoreV1
  ): void {
    const id = definition.listing.id;
    const current = this.#definitions.get(id);
    if (current && !this.#addedStores.has(id)) {
      throw new Error(`Reference ${id} is already in the hosted catalog.`);
    }
    if (current?.manifest.sha256 !== definition.manifest.sha256) {
      this.#admissions.delete(id);
      this.#settled.delete(id);
    }
    this.#definitions.set(id, definition);
    this.#addedStores.set(id, store);
  }

  listHosted(): HostedReferenceCatalogEntryV1[] {
    return [...this.#definitions.values()]
      .filter((definition) => !this.#addedStores.has(definition.listing.id))
      .map((definition) => ({
        ...definition.listing,
        cacheStatus: 'cached',
      }));
  }

  async installHosted(
    request: ReferenceAssetInstallHostedRequestV1
  ): Promise<ReferenceAssetInstallHostedResultV1> {
    const admission = await this.#admit(request.catalogId);
    return { status: 'ready', entry: admission.entry };
  }

  async getHostedPreparationStatus(
    request: ReferenceAssetGetHostedPreparationStatusRequestV1
  ): Promise<ReferenceAssetHostedPreparationStatusV1 | null> {
    if (!this.#definitions.has(request.catalogId)) {
      throw new Error(`Unknown hosted reference catalog ID: ${request.catalogId}`);
    }
    const admission = this.#settled.get(request.catalogId);
    if (!admission) return null;
    return {
      catalogId: request.catalogId,
      themeMode: request.themeMode,
      status: 'annotation-ready',
      phase: 'detail-ready',
      label: `${admission.definition.listing.name} is ready`,
      updatedAtMs: this.#now(),
      capabilityGenerationId: admission.bundle.bundleFingerprint,
      entry: admission.entry,
    };
  }

  ownsPath(path: string): boolean {
    return path.startsWith(`${this.#cacheRoot}/`) || path.startsWith(`${this.#publicationRoot}/`);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.#resolvePath(path)) !== null;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const resolved = await this.#resolvePath(path);
    if (!resolved) throw new HostedCapabilityError(`fs.readFile:${path}`);
    if (typeof resolved === 'string') return new TextEncoder().encode(resolved);
    return this.#storeForObject(resolved).readVerified(objectRef(resolved));
  }

  async stat(path: string): Promise<{ size: number; isFile: boolean; isDirectory: boolean }> {
    const resolved = await this.#resolvePath(path);
    if (!resolved) throw new HostedCapabilityError(`fs.stat:${path}`);
    const size =
      typeof resolved === 'string'
        ? new TextEncoder().encode(resolved).byteLength
        : resolved.byteLength;
    return { size, isFile: true, isDirectory: false };
  }

  async open(source: GenomeOpenSource): Promise<GenomeSessionShell> {
    const intent = source?.intent;
    if (intent?.kind !== 'reference-assembly' && intent?.kind !== 'internal-assembly-segment') {
      throw new HostedCapabilityError('genome.open');
    }
    const manifest = source.manifest;
    if (!manifest) throw new HostedCapabilityError('genome.open');
    const fasta = await this.#requireObject(manifest.fastaPath);
    const shell = createGenomeSessionShell({
      source,
      resolvedSourcePath: source.sourcePath,
      stat: { size: fasta.byteLength, mtimeMs: 0 },
      now: this.#now(),
    });
    const length =
      manifest.length ?? (await this.#dataSource(manifest).getChromosomeLength(manifest.chrom));
    const annotationFeatureCount =
      intent.kind === 'reference-assembly' && intent.searchReadiness !== 'not-applicable'
        ? await this.#annotationFeatureCount(manifest.fastaPath).catch(() => null)
        : null;
    const ready: GenomeSessionShell = {
      ...updateGenomeSessionShellFromTabState({
        session: shell,
        tabState: {
          sourcePath: source.sourcePath,
          sourceExt: source.sourceExt ?? '',
          sourceSizeBytes: fasta.byteLength,
          chrom: manifest.chrom,
          manifest: { ...manifest, length },
          metadata: { length, circular: manifest.circular ?? false },
        },
      }),
      openReady: true,
      ...(intent.kind === 'reference-assembly'
        ? {
            assemblyAnnotationProductsReadiness: intent.annotationProductsReadiness,
            assemblySearchReadiness:
              intent.searchReadiness === 'not-applicable'
                ? ('not-applicable' as const)
                : ('pending' as const),
            ...(annotationFeatureCount === null
              ? {}
              : { assemblyAnnotationFeatureCount: annotationFeatureCount }),
          }
        : {}),
    };
    this.#sessions.set(ready.sessionId, ready);
    return ready;
  }

  async getSession(sessionId: string): Promise<GenomeSessionShell> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`[genome] Unknown session: ${sessionId}`);
    return session;
  }

  async getAnnotationTile(
    sessionId: string,
    request: GenomeTileRequest,
    requestId = `annotation-tile-${this.#randomId()}`
  ): Promise<GenomeTrackTile> {
    const session = await this.getSession(sessionId);
    const manifest = session.manifest;
    if (
      !manifest?.gffPath ||
      !manifest.tbiPath ||
      !session.tracks.some((track) => track.id === request?.trackId && track.kind === 'annotation')
    ) {
      throw new UserMessageError('tracks.unavailable');
    }
    try {
      validateAnnotationViewportTileRequest(session, request);
      const features = await this.#dataSource(manifest).getFeatures(
        request.chrom,
        request.start,
        request.end,
        request.lod
      );
      const tile = createAnnotationViewportTile({ session, request, requestId, features });
      if (!tile.message) return tile;
      console.warn('[hosted-reference] Annotation tile diagnostic', {
        requestId,
        message: tile.message,
        byteCount: tile.byteCount,
      });
      return { ...tile, message: toUserMessage(tile.message, 'tracks.loadFailed') };
    } catch (cause) {
      throw new UserMessageError('tracks.loadFailed', { cause });
    }
  }

  async upgradeSessionCapabilities(
    sessionId: string,
    source: GenomeOpenSource
  ): Promise<GenomeSessionShell> {
    const session = await this.getSession(sessionId);
    if (source?.intent?.kind !== 'reference-assembly') return session;
    const upgraded: GenomeSessionShell = {
      ...session,
      assemblyAnnotationProductsReadiness: source.intent.annotationProductsReadiness,
      ...(source.intent.assetGeneration
        ? { assemblyAssetGeneration: source.intent.assetGeneration }
        : {}),
    };
    this.#sessions.set(sessionId, upgraded);
    return upgraded;
  }

  async closeSession(sessionId: string): Promise<GenomeSessionReleaseResult> {
    const released = this.#sessions.delete(sessionId);
    return { released, activeSessionCount: this.#sessions.size, cancelledRequestCount: 0 };
  }

  async getSequenceWindow(
    sessionId: string,
    request: GenomeSequenceWindowRequest,
    requestId = `sequence-window-${this.#randomId()}`
  ): Promise<GenomeSequenceWindow> {
    const session = await this.getSession(sessionId);
    const manifest = session.manifest;
    if (!manifest) throw new Error(`[genome] Session has no indexed FASTA manifest: ${sessionId}`);
    if (!request || typeof request.chrom !== 'string') {
      throw new Error('[genome] Invalid sequence window request.');
    }
    const issue = sequenceWindowRequestIssue(request);
    if (issue && issue !== 'too-large') {
      throw new Error('[genome] Invalid sequence window request.');
    }
    if (issue === 'too-large') {
      throw new Error(`[genome] Sequence window exceeds ${MAX_SEQUENCE_WINDOW_BASES} bp.`);
    }
    const length = session.length ?? manifest.length;
    if (typeof length === 'number' && request.end > length) {
      throw new Error(`[genome] Sequence window exceeds chromosome length ${length}.`);
    }
    if (request.chrom !== session.chrom && request.chrom !== manifest.chrom) {
      throw new Error('[genome] Sequence window chrom mismatch.');
    }
    const bases = await this.#dataSource(manifest).getSequence(
      request.chrom,
      request.start,
      request.end
    );
    return {
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
  }

  async readAssemblyAnnotationProductSetInventoryV1(
    request: AssemblyAnnotationProductSetInventoryReadRequestV1
  ): Promise<AssemblyAnnotationProductSetInventoryReadResultV1> {
    const seed = request?.seedProduct;
    if (!seed || seed.ipcContractVersion !== ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT) {
      return { status: 'unavailable' };
    }
    const admission = this.#admissionForRequest(seed);
    const product = admission?.productsByTheme.get(seed.artifact.themeMode);
    if (!admission || !product || !this.#requestMatchesProduct(seed, admission, product)) {
      return { status: 'unavailable' };
    }
    return {
      status: 'ready',
      sourceFingerprint: product.sourceFingerprint,
      inventoryFingerprint: product.inventoryFingerprint,
      trackTypes: [...product.trackTypes],
    };
  }

  async readAssemblyCompiledBroadRasterManifestV1(
    request: AssemblyCompiledBroadRasterManifestRequestV1
  ): Promise<AssemblyCompiledBroadRasterManifestResultV1 | null> {
    try {
      if (request?.contract !== ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1 || !request.scene) {
        return null;
      }
      const exact = this.#exactEntry(request.scene);
      if (!exact) return null;
      const { admission, entry } = exact;
      const broadManifest = admission.objectsById.get(entry.broadManifestObjectId);
      if (!broadManifest) return null;
      const manifestPath = `${admission.generationRoot}/${broadManifest.installPath}`;
      const artifactDirectory = manifestPath.slice(0, manifestPath.lastIndexOf('/'));
      const reader = await openCompiledBroadRasterArtifactV1(
        { artifactDirectory, expectedSurfaceManifestFingerprint: entry.surfaceManifestFingerprint },
        {
          readFile: async (path, maxBytes) => {
            if (path === manifestPath)
              return admission.store.readVerified(objectRef(broadManifest));
            const cell = /\/cells\/([0-9a-f]{64})\.rgba\.br$/.exec(path);
            if (!cell || !path.startsWith(`${artifactDirectory}/cells/`)) {
              throw new Error(`Unknown broad raster path ${path}`);
            }
            return admission.store.readVerified({
              objectKey: preparedReferenceObjectKeyV1(cell[1]),
              sha256: cell[1],
              byteLength: maxBytes,
            });
          },
          sha256Hex: webCryptoSha256Hex,
          brotliDecompress: this.#brotliDecompress,
        }
      );
      if (
        reader.manifest.catalogFingerprint !== entry.catalogFingerprint ||
        reader.manifest.surfaceManifest.trackId !== entry.trackType ||
        reader.manifest.surfaceManifest.manifestFingerprint !== entry.surfaceManifestFingerprint
      ) {
        return null;
      }
      const catalogReceipt = buildAssemblyCompiledBroadRasterCatalogReceiptV1({
        request,
        sceneIndex: {
          fingerprint: entry.sourceFingerprint,
          placementFingerprint: entry.placementFingerprint,
          payloadSha256: entry.scenePayloadSha256,
          sourceBuildFingerprint: entry.sceneCompilerContractFingerprint,
          artifact: { ...request.scene.artifact },
          manifest: { integrity: { contractSha256: entry.sceneContractSha256 } },
        },
        surfaceManifest: reader.manifest.surfaceManifest,
        reader,
      });
      if (!catalogReceipt) return null;
      const catalogCapability: AssemblyCompiledBroadRasterCatalogCapabilityV1 = Object.freeze({
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_CATALOG_CAPABILITY_V1,
        openingId: this.#randomId(),
        catalogReceiptSha256: catalogReceipt.receiptSha256,
        catalogFingerprint: catalogReceipt.catalogFingerprint,
        surfaceManifestFingerprint: catalogReceipt.surfaceManifestFingerprint,
      });
      this.#rasterOpenings.set(catalogCapability.openingId, { catalogCapability, reader });
      while (this.#rasterOpenings.size > MAX_BROAD_RASTER_OPENINGS) {
        const oldest = this.#rasterOpenings.keys().next().value as string | undefined;
        if (!oldest || oldest === catalogCapability.openingId) break;
        this.#rasterOpenings.delete(oldest);
      }
      return {
        contract: reader.manifest.contract,
        catalogReceipt,
        catalogCapability,
        surfaceManifest: reader.manifest.surfaceManifest,
      };
    } catch (error) {
      console.error('[hosted-reference] broad raster manifest failed', error);
      return null;
    }
  }

  async readAssemblyCompiledBroadRasterCellsV1(
    request: AssemblyCompiledBroadRasterCellsRequestV1
  ): Promise<AssemblyCompiledBroadRasterCellsResultV1> {
    const unavailable = (
      reason: 'invalid-request' | 'catalog-stale' | 'artifact-io-failure'
    ): AssemblyCompiledBroadRasterCellsResultV1 => ({
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
      status: 'unavailable',
      reason,
    });
    if (
      request?.contract !== ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1 ||
      !request.catalogCapability ||
      !isAssemblyCompiledBroadRasterSingleCellBatchV1(request.addresses)
    ) {
      return unavailable('invalid-request');
    }
    const opening = this.#rasterOpenings.get(request.catalogCapability.openingId);
    if (
      !opening ||
      opening.catalogCapability.catalogReceiptSha256 !==
        request.catalogCapability.catalogReceiptSha256 ||
      opening.catalogCapability.catalogFingerprint !==
        request.catalogCapability.catalogFingerprint ||
      opening.catalogCapability.surfaceManifestFingerprint !==
        request.catalogCapability.surfaceManifestFingerprint
    ) {
      return unavailable('catalog-stale');
    }
    try {
      const cells = await opening.reader.readCells(request.addresses);
      const wireCells = cells.map(compiledBroadRasterCellToWireV1);
      return {
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
        status: 'ready',
        catalogCapability: opening.catalogCapability,
        cells: wireCells,
      };
    } catch (error) {
      console.error('[hosted-reference] broad raster cells failed', error);
      return unavailable('artifact-io-failure');
    }
  }

  async readAssemblyCompiledBroadInteractionV1(
    request: AssemblyAnnotationSceneReadRequest,
    options?: { signal?: AbortSignal }
  ): Promise<AssemblyCompiledBroadInteractionHitResultV1 | null> {
    try {
      const exact = await this.#exactScene(request, options?.signal);
      if (!exact) return null;
      const { admission, entry, localScene } = exact;
      if (
        !entry.compiledBroadInteractionPayloadObjectId ||
        !entry.compiledBroadInteractionPayloadSha256
      ) {
        return null;
      }
      const compactObject = admission.objectsById.get(
        entry.compiledBroadInteractionPayloadObjectId
      );
      const manifest = portableLocalCompactInteractionManifestV1(entry, localScene);
      if (!compactObject || !manifest) return null;
      const payload = await admission.store.readVerified(objectRef(compactObject), options?.signal);
      await validateCompiledBroadAnnotationInteractionBinaryV1(
        manifest,
        payload,
        webCryptoSha256Hex
      );
      if (manifest.integrity.payloadSha256 !== entry.compiledBroadInteractionPayloadSha256)
        return null;
      return {
        contract: ASSEMBLY_COMPILED_BROAD_INTERACTION_IPC_V1,
        status: 'hit',
        authorityKind: 'portable',
        origin: 'durable-hit',
        fingerprint: entry.sourceFingerprint,
        sourceBuildFingerprint: localScene.compilerContractFingerprint,
        scope: localScene.disk.scope,
        artifact: localScene.disk.artifact,
        sourceScene: {
          byteCount: localScene.disk.byteCount,
          payloadSha256: localScene.manifest.integrity.payloadSha256,
          contractSha256: localScene.manifest.integrity.contractSha256,
        },
        byteCount: payload.byteLength,
        manifest,
        payload,
      };
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      console.error('[hosted-reference] compact interaction failed', error);
      return null;
    }
  }

  async readAssemblyAnnotationSceneDetailV1(
    request: AssemblyAnnotationSceneDetailReadRequestV1,
    options?: { signal?: AbortSignal }
  ): Promise<AssemblyAnnotationSceneDetailReadResultV1 | null> {
    try {
      if (
        request?.contract !== ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1 ||
        !request.source ||
        !Number.isSafeInteger(request.startBp) ||
        !Number.isSafeInteger(request.endBp) ||
        request.startBp < 0 ||
        request.endBp <= request.startBp
      ) {
        return null;
      }
      const exact = await this.#exactScene(request.source, options?.signal);
      if (!exact) return null;
      const { admission, entry, localScene, sceneObject } = exact;
      if (request.endBp > localScene.manifest.assemblyContract.assemblyLengthBp) return null;
      const rangeCatalog = localScene.detailRangeCatalog;
      if (!rangeCatalog) {
        return {
          contract: ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
          status: 'unavailable',
          reason: 'range-catalog-unavailable',
          fingerprint: entry.sourceFingerprint,
          sourceBuildFingerprint: localScene.compilerContractFingerprint,
          scope: localScene.disk.scope,
          artifact: localScene.disk.artifact,
        };
      }
      const packet = await packPartitionedTranscriptSceneDetailPacketV1({
        sourceManifest: localScene.manifest,
        rangeCatalog,
        startBp: request.startBp,
        endBp: request.endBp,
        readRange: (range) =>
          admission.store.readRange(
            objectRef(sceneObject),
            range.byteOffset,
            range.byteLength,
            options?.signal
          ),
        payloadSha256: webCryptoSha256Hex,
      });
      const parentRoles = await this.#roleSidecar(admission, localScene, request.source.assemblyId);
      const colorRoles = parentRoles
        ? slicePartitionedTranscriptSceneDetailRolesV1(
            rangeCatalog,
            packet.manifest.selectedPartitionIndices,
            parentRoles
          )
        : null;
      return {
        contract: ASSEMBLY_ANNOTATION_SCENE_DETAIL_IPC_V1,
        status: 'hit',
        fingerprint: entry.sourceFingerprint,
        sourceBuildFingerprint: localScene.compilerContractFingerprint,
        scope: localScene.disk.scope,
        artifact: localScene.disk.artifact,
        byteCount: packet.payload.byteLength,
        manifest: packet.manifest,
        payload: packet.payload,
        ...(colorRoles ? { colorRoles } : {}),
      };
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      console.error('[hosted-reference] annotation detail failed', error);
      return null;
    }
  }

  async readAssemblyAnnotationScene(
    request: AssemblyAnnotationSceneReadRequest,
    options?: { signal?: AbortSignal }
  ): Promise<AssemblyAnnotationSceneReadResult | null> {
    try {
      const exact = await this.#exactScene(request, options?.signal);
      if (!exact) return null;
      const { admission, entry, localScene, sceneObject } = exact;
      const payload = await admission.store.readVerified(objectRef(sceneObject), options?.signal);
      const colorRoles = await this.#roleSidecar(admission, localScene, request.assemblyId);
      return {
        status: 'hit',
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        fingerprint: entry.sourceFingerprint,
        sourceBuildFingerprint: localScene.compilerContractFingerprint,
        scope: localScene.disk.scope,
        artifact: localScene.disk.artifact,
        byteCount: localScene.disk.byteCount,
        manifest: localScene.manifest,
        payload,
        ...(colorRoles ? { colorRoles } : {}),
      };
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      console.error('[hosted-reference] annotation scene failed', error);
      return null;
    }
  }

  #admit(catalogId: string): Promise<BrowserPortableAdmissionV1> {
    const existing = this.#admissions.get(catalogId);
    if (existing) return existing;
    const definition = this.#definitions.get(catalogId);
    if (!definition) {
      return Promise.reject(new Error(`Unknown hosted reference catalog ID: ${catalogId}`));
    }
    const task = this.#admitUncached(definition).then((admission) => {
      this.#settled.set(catalogId, admission);
      return admission;
    });
    this.#admissions.set(catalogId, task);
    task.catch(() => {
      if (this.#admissions.get(catalogId) === task) this.#admissions.delete(catalogId);
    });
    return task;
  }

  async #admitUncached(
    definition: HostedReferenceBrowserCatalogDefinitionV1
  ): Promise<BrowserPortableAdmissionV1> {
    const id = definition.listing.id;
    const store = this.#addedStores.get(id) ?? this.#store;
    const bundle = parsePortablePreparedReferenceBundleV1(
      await store.readVerifiedJson({
        objectKey: definition.manifest.relativePath,
        sha256: definition.manifest.sha256,
        byteLength: definition.manifest.byteLength,
      }),
      {
        assemblyId: id,
        assetCacheKey: id,
        assemblyLengthBp: definition.listing.lengthBp,
        contigCount: definition.listing.contigCount,
      }
    );
    const familyRoot = `${this.#cacheRoot}/${id}`;
    const generationRoot = `${familyRoot}/generations/${bundle.bundleFingerprint}`;
    const objectsById = new Map(bundle.objects.map((object) => [object.id, object]));
    const objectsByPath = new Map(
      bundle.objects.map((object) => [`${generationRoot}/${object.installPath}`, object])
    );
    const single = (role: PortablePreparedReferenceObjectV1['role']) => {
      const matches = bundle.objects.filter((object) => object.role === role);
      if (matches.length !== 1) {
        throw new Error(`Portable prepared-reference bundle must contain exactly one ${role}.`);
      }
      return matches[0];
    };
    const [catalogValue, definitionValue] = await Promise.all([
      store.readVerifiedJson(objectRef(single('view-catalog'))),
      store.readVerifiedJson(objectRef(single('prepared-reference-definition'))),
    ]);
    const catalog = parsePortablePreparedReferenceViewCatalogV1(catalogValue, bundle);
    assertPortableCatalogThemeRosterCoherence(catalog);
    const entriesByView = new Map(
      catalog.entries.map((entry) => [portableViewKeyV1(entry.themeMode, entry.trackType), entry])
    );
    const prepared = parsePreparedReferenceDefinition(definitionValue, id);
    const productObjects = bundle.objects.filter(
      (object) => object.role === 'annotation-product-set-manifest'
    );
    if (productObjects.length !== 1 && productObjects.length !== 2) {
      throw new Error('Portable prepared-reference bundle must contain the light product set.');
    }
    const productsByTheme = new Map<'dark' | 'light', PortableAnnotationProductSetV2>();
    for (const object of productObjects) {
      const product = parsePortableProductSetV1(
        await store.readVerifiedJson(objectRef(object)),
        catalog.sourceFingerprint
      );
      if (
        productsByTheme.has(product.themeMode) ||
        !portableProductMatchesPreparedDefinitionV1(product, prepared)
      ) {
        throw new Error('Portable prepared-reference product inventory is ambiguous.');
      }
      assertPortableProductViewReceiptsV1(product, entriesByView);
      productsByTheme.set(product.themeMode, product);
    }
    assertPortableFullThemeProductCoherenceV1(catalog, productsByTheme);
    const preparedEntry = preparedReferenceAssemblyEntry(prepared);
    const entry: PreparedReferenceAssemblyEntryV1 = {
      ...preparedEntry,
      members: preparedEntry.members.map((member, index) => {
        const { cytobandId: _cachedCytobandId, ...rest } = member;
        const cytobandId = definition.contigs[index]?.cytobandId;
        return { ...rest, ...(cytobandId ? { cytobandId } : {}) };
      }),
      portableView: {
        generationRoot,
        bundleFingerprint: bundle.bundleFingerprint,
        trackTypes: [...new Set(catalog.entries.map((entry) => entry.trackType))].sort(
          (left, right) => left.localeCompare(right)
        ),
        datasetVersion: portableProductDatasetVersionV1(productsByTheme),
        assetGenerationsByTheme: portableAssetGenerationsByThemeV1(productsByTheme),
        searchReady: false,
      },
    };
    const publicationPointer = `${JSON.stringify(
      {
        contract: 'reference-asset-publication.v1',
        assetCacheKey: id,
        publicationId: bundle.bundleFingerprint,
        sourceMaterializationFingerprint: sha256Hex(
          JSON.stringify({ assetCacheKey: id, bundleFingerprint: bundle.bundleFingerprint })
        ),
        publishedAtMs: Math.max(1, this.#now()),
      },
      null,
      2
    )}\n`;
    return {
      definition,
      store,
      familyRoot,
      generationRoot,
      bundle,
      objectsById,
      objectsByPath,
      catalog,
      entriesByView,
      prepared,
      productsByTheme,
      entry,
      publicationPointer,
    };
  }

  async #resolvePath(path: string): Promise<PortablePreparedReferenceObjectV1 | string | null> {
    const normalized = normalizePosix(path);
    for (const root of [this.#publicationRoot, this.#cacheRoot]) {
      if (!normalized.startsWith(`${root}/`)) continue;
      const [key, ...rest] = normalized.slice(root.length + 1).split('/');
      if (!key || !this.#definitions.has(key)) return null;
      const admission = await this.#admit(key).catch(() => null);
      if (!admission) return null;
      if (rest.length === 1 && rest[0] === PUBLICATION_POINTER_FILE) {
        return admission.publicationPointer;
      }
      if (root !== this.#cacheRoot) return null;
      return admission.objectsByPath.get(normalized) ?? null;
    }
    return null;
  }

  async #requireObject(
    path: string | null | undefined
  ): Promise<PortablePreparedReferenceObjectV1> {
    const resolved = path ? await this.#resolvePath(path) : null;
    if (!resolved || typeof resolved === 'string') {
      throw new Error(`Prepared reference file is not published: ${path ?? '(missing)'}`);
    }
    return resolved;
  }

  #dataSource(manifest: IndexedGenomeManifest): IndexedGenomeDataSource {
    const key = `${manifest.fastaPath}\0${manifest.faiPath}\0${manifest.gziPath ?? ''}\0${manifest.gffPath ?? ''}\0${manifest.tbiPath ?? ''}`;
    let source = this.#dataSources.get(key);
    if (!source) {
      source = new IndexedGenomeDataSource(manifest, {
        openFile: (path) => {
          const object = this.#objectForPath(path);
          if (!object) throw new Error(`Prepared reference file is not published: ${path}`);
          return this.#storeForObject(object).openRange(objectRef(object));
        },
      });
      this.#dataSources.set(key, source);
    }
    return source;
  }

  #storeForObject(object: PortablePreparedReferenceObjectV1): PreparedReferenceObjectStoreV1 {
    for (const admission of this.#settled.values()) {
      if (admission.bundle.objects.includes(object)) return admission.store;
    }
    return this.#store;
  }

  async #annotationFeatureCount(fastaPath: string): Promise<number | null> {
    const normalized = normalizePosix(fastaPath);
    const admission = [...this.#settled.values()].find(({ objectsByPath }) =>
      objectsByPath.has(normalized)
    );
    const object = admission?.bundle.objects.find(
      ({ role }) => role === 'annotation-search-manifest'
    );
    if (!admission || object?.contractToken !== PORTABLE_ANNOTATION_SEARCH_MANIFEST_V1) {
      return null;
    }
    const value = (await admission.store.readVerifiedJson(objectRef(object))) as {
      contract?: unknown;
      assemblyId?: unknown;
      sourceFingerprint?: unknown;
      searchManifest?: { featureCount?: unknown };
    } | null;
    const featureCount = value?.searchManifest?.featureCount;
    if (
      value?.contract !== PORTABLE_ANNOTATION_SEARCH_MANIFEST_V1 ||
      value.assemblyId !== admission.bundle.assembly.id ||
      value.sourceFingerprint !== admission.catalog.sourceFingerprint ||
      typeof featureCount !== 'number' ||
      !Number.isSafeInteger(featureCount) ||
      featureCount < 0
    ) {
      return null;
    }
    return featureCount;
  }

  #objectForPath(path: string): PortablePreparedReferenceObjectV1 | null {
    const normalized = normalizePosix(path);
    for (const admission of this.#settled.values()) {
      const object = admission.objectsByPath.get(normalized);
      if (object) return object;
    }
    return null;
  }

  #admissionForRequest(
    request: AssemblyAnnotationSceneReadRequest
  ): BrowserPortableAdmissionV1 | null {
    const admission = this.#settled.get(request?.assemblyId);
    if (!admission || normalizePosix(request.workspaceRoot) !== admission.familyRoot) return null;
    const expected = request.expectedAssetGeneration;
    const product = admission.productsByTheme.get(request.artifact.themeMode);
    if (
      expected &&
      (!product ||
        expected.sourceFingerprint !== product.sourceFingerprint ||
        expected.inventoryFingerprint !== product.inventoryFingerprint ||
        expected.themeMode !== product.themeMode)
    ) {
      return null;
    }
    return admission;
  }

  #requestMatchesProduct(
    request: AssemblyAnnotationSceneReadRequest,
    admission: BrowserPortableAdmissionV1,
    product: PortableAnnotationProductSetV2
  ): boolean {
    return portableRequestMatchesProductV1(
      request,
      {
        prepared: admission.prepared,
        familyRoot: admission.familyRoot,
        generationRoot: admission.generationRoot,
      },
      product,
      (...segments) => normalizePosix(segments.filter(Boolean).join('/'))
    );
  }

  #exactEntry(request: AssemblyAnnotationSceneReadRequest): {
    admission: BrowserPortableAdmissionV1;
    entry: PortablePreparedReferenceViewCatalogEntryV1;
  } | null {
    if (request?.ipcContractVersion !== ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT) return null;
    const admission = this.#admissionForRequest(request);
    if (!admission) return null;
    const entry = admission.entriesByView.get(
      portableViewKeyV1(request.artifact.themeMode, request.artifact.trackType)
    );
    if (
      !entry ||
      entry.sceneArtifactKey !== request.artifact.artifactKey ||
      entry.placementFingerprint !== portablePlacementFingerprintV1(request.scope.placements)
    ) {
      return null;
    }
    return { admission, entry };
  }

  async #exactScene(
    request: AssemblyAnnotationSceneReadRequest,
    signal?: AbortSignal
  ): Promise<{
    admission: BrowserPortableAdmissionV1;
    entry: PortablePreparedReferenceViewCatalogEntryV1;
    localScene: LocallyResealedPortableSceneManifestV1;
    sceneObject: PortablePreparedReferenceObjectV1;
  } | null> {
    const exact = this.#exactEntry(request);
    if (!exact) return null;
    const { admission, entry } = exact;
    const manifestObject = admission.objectsById.get(entry.sceneManifestObjectId);
    const sceneObject = admission.objectsById.get(entry.scenePayloadObjectId);
    if (!manifestObject || !sceneObject) return null;
    const localScene = await resealPortableSceneDiskManifestV1({
      disk: (await admission.store.readVerifiedJson(
        objectRef(manifestObject),
        signal
      )) as PortableSceneDiskManifestV1,
      request,
      entry,
      ...(admission.definition.legacyLayerIdentityContract ===
      ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN
        ? {
            legacyLayerIdentityContract:
              ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN,
          }
        : {}),
    });
    if (!localScene || sceneObject.byteLength !== localScene.disk.byteCount) return null;
    return { admission, entry, localScene, sceneObject };
  }

  #roleSidecar(
    admission: BrowserPortableAdmissionV1,
    localScene: LocallyResealedPortableSceneManifestV1,
    assemblyId: string
  ): Promise<PartitionedTranscriptSceneRoleSidecarV1 | null> {
    const descriptor = localScene.disk.roleSidecar;
    if (
      !descriptor ||
      !annotationRoleSidecarDescriptorMatchesSceneV1(descriptor, localScene.publishedManifest, {
        assemblyId,
        fingerprint: localScene.disk.fingerprint,
        companionKey: String(localScene.disk.companionKey),
      })
    ) {
      return Promise.resolve(null);
    }
    const object = admission.bundle.objects.find(
      (candidate) =>
        candidate.role === 'annotation-role-sidecar' &&
        candidate.installPath.slice(candidate.installPath.lastIndexOf('/') + 1) ===
          descriptor.file &&
        candidate.sha256 === descriptor.payloadSha256 &&
        candidate.byteLength === descriptor.byteCount
    );
    if (!object) return Promise.resolve(null);
    let pending = this.#roleSidecars.get(object.sha256);
    if (!pending) {
      pending = admission.store
        .readVerified(objectRef(object))
        .then((bytes) => admitAnnotationRoleSidecarPayloadV1(descriptor, bytes))
        .catch(() => null);
      this.#roleSidecars.set(object.sha256, pending);
    }
    return pending;
  }
}

function objectRef(object: PortablePreparedReferenceObjectV1): PreparedReferenceObjectRefV1 {
  return { objectKey: object.objectKey, sha256: object.sha256, byteLength: object.byteLength };
}

function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

function normalizePosix(path: string): string {
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${absolute ? '/' : ''}${parts.join('/')}`;
}
