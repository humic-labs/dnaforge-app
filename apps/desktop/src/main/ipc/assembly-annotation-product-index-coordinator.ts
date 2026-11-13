import { referencePreparationTiming } from '../reference-assets/reference-prep-timing';
import type {
  AssemblyAnnotationProductIndexResultV1,
  AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import type { AssemblyAnnotationSceneCacheIndexReadResult } from './assembly-overview-texture-cache';
import type { ExpandedAnnotationScenePreparationOutcome } from './assembly-expanded-annotation-scene-orchestrator';
import type { AssemblyCompiledBroadRasterSceneHitV1 } from './assembly-compiled-broad-raster-orchestrator';
import type { AssemblyCompiledBroadRasterWorkerResultV1 } from './assembly-compiled-broad-raster-worker-job';
import type { AssemblySearchIndexReadinessV1 } from './assembly-search-index-readiness';

const MAX_QUEUED_PRODUCT_IDENTITIES = 16;
type AssemblyAnnotationProductIndexScheduleResultV1 =
  | Readonly<{ status: 'scheduled' }>
  | Readonly<{ status: 'coalesced' }>
  | Readonly<{ status: 'rejected'; reason: 'queue-full' }>;

export interface AssemblyAnnotationProductIndexCoordinatorDepsV1 {
  readonly readScene: (
    request: AssemblyAnnotationSceneReadRequest
  ) => Promise<AssemblyAnnotationSceneCacheIndexReadResult | null>;
  readonly prepareScene: (
    request: AssemblyAnnotationSceneReadRequest,
    miss: Extract<AssemblyAnnotationSceneCacheIndexReadResult, { status: 'miss' }>
  ) => Promise<ExpandedAnnotationScenePreparationOutcome>;
  readonly prepareSceneSet?: (
    entries: readonly Readonly<{
      request: AssemblyAnnotationSceneReadRequest;
      miss: Extract<AssemblyAnnotationSceneCacheIndexReadResult, { status: 'miss' }>;
    }>[]
  ) => Promise<readonly ExpandedAnnotationScenePreparationOutcome[]>;
  readonly prepareBroadCompanion: (
    hit: AssemblyCompiledBroadRasterSceneHitV1
  ) => Promise<AssemblyCompiledBroadRasterWorkerResultV1>;
  readonly prepareSearchIndexes?: (
    request: AssemblyAnnotationSceneReadRequest
  ) => Promise<AssemblySearchIndexReadinessV1>;
  readonly commitProductSet?: (
    input: AssemblyAnnotationProductSetCommitInputV1
  ) => Promise<Readonly<{ inventoryFingerprint: string }>>;
  readonly reportFailure?: (error: Error, request: AssemblyAnnotationSceneReadRequest) => void;
}

export interface AssemblyAnnotationProductSetCommitProductV1 {
  readonly trackType: string;
  readonly artifactStatus: 'already-present' | 'published';
  readonly sourceFingerprint: string;
  readonly surfaceManifestFingerprint: string;
  readonly catalogFingerprint: string;
}

export interface AssemblyAnnotationProductSetCommitInputV1 {
  readonly assemblyId: string;
  readonly workspaceRoot: string;
  readonly themeMode: 'light' | 'dark';
  readonly datasetContract: AssemblyAnnotationSceneReadRequest['datasetContract'];
  readonly scope: AssemblyAnnotationSceneReadRequest['scope'];
  readonly chromosomes: AssemblyAnnotationSceneReadRequest['chromosomes'];
  readonly products: readonly AssemblyAnnotationProductSetCommitProductV1[];
  readonly searchIndexes: AssemblySearchIndexReadinessV1;
}

export interface AssemblyAnnotationProductSetReadyV1 {
  readonly status: 'ready';
  readonly inventoryFingerprint: string;
  readonly trackTypes: readonly string[];
}

type AssemblyAnnotationSceneIndexHitV1 = Extract<
  AssemblyAnnotationSceneCacheIndexReadResult,
  { status: 'hit' }
>;

interface AssemblyAnnotationExactSceneReceiptV1 {
  readonly sourceFingerprint: string;
  readonly sourceBuildFingerprint: string;
  readonly scenePath: string;
  readonly byteCount: number;
  readonly payloadSha256: string;
  readonly contractSha256: string;
}

interface PreparedAssemblyAnnotationProductV1 {
  readonly product: AssemblyAnnotationProductSetCommitProductV1;
  readonly exactSceneReceipt: AssemblyAnnotationExactSceneReceiptV1;
}

export class AssemblyAnnotationProductIndexCoordinatorV1 {
  private readonly deps: AssemblyAnnotationProductIndexCoordinatorDepsV1;
  private readonly inFlight = new Map<string, Promise<AssemblyAnnotationProductIndexReadyV1>>();
  private queueTail: Promise<void> = Promise.resolve();

  constructor(deps: AssemblyAnnotationProductIndexCoordinatorDepsV1) {
    this.deps = deps;
  }

  schedule(
    request: AssemblyAnnotationSceneReadRequest
  ): AssemblyAnnotationProductIndexScheduleResultV1 {
    const key = productIdentity(request);
    if (this.inFlight.has(key)) return { status: 'coalesced' };
    if (this.inFlight.size >= MAX_QUEUED_PRODUCT_IDENTITIES) {
      return { status: 'rejected', reason: 'queue-full' };
    }

    void this.prepare(request).catch((error: unknown) => {
      this.deps.reportFailure?.(normalizeError(error), request);
    });
    return { status: 'scheduled' };
  }

  async prepare(
    request: AssemblyAnnotationSceneReadRequest
  ): Promise<AssemblyAnnotationProductIndexReadyV1> {
    const key = productIdentity(request);
    const incumbent = this.inFlight.get(key);
    if (incumbent) return incumbent;
    if (this.inFlight.size >= MAX_QUEUED_PRODUCT_IDENTITIES) {
      throw new AssemblyAnnotationProductIndexQueueFullError();
    }
    const task = this.queueTail
      .catch(() => undefined)
      .then(() => this.prepareExactProduct(request));
    this.inFlight.set(key, task);
    this.queueTail = task.then(
      () => undefined,
      () => undefined
    );
    void task.then(
      () => {
        if (this.inFlight.get(key) === task) this.inFlight.delete(key);
      },
      () => {
        if (this.inFlight.get(key) === task) this.inFlight.delete(key);
      }
    );
    return task;
  }

  async prepareSet(
    requests: readonly AssemblyAnnotationSceneReadRequest[]
  ): Promise<AssemblyAnnotationProductSetReadyV1> {
    const ordered = validateAndOrderProductSetRequests(requests);
    if (!this.deps.commitProductSet) {
      throw new Error('Assembly annotation product-set commit dependency is unavailable.');
    }
    if (!this.deps.prepareSearchIndexes) {
      throw new Error('Assembly search-index readiness dependency is unavailable.');
    }
    const commitProductSet = this.deps.commitProductSet;
    const prepareSearchIndexes = this.deps.prepareSearchIndexes;
    const task = this.queueTail
      .catch(() => undefined)
      .then(async () => {
        const first = ordered[0];
        const timing = referencePreparationTiming(
          `products[${first.artifact.themeMode}; ${ordered.length} tracks: ${ordered
            .map((request) => request.artifact.trackType)
            .join(',')
            .slice(0, 200)}]`
        );
        timing('start');
        const [searchOutcome, productsOutcome] = await Promise.allSettled([
          prepareSearchIndexes(first).then((result) => {
            timing('search-indexes');
            return result;
          }),
          this.prepareExactProductSet(ordered).then((result) => {
            timing('scenes-and-broad-rasters');
            return result;
          }),
        ]);
        if (searchOutcome.status === 'rejected') throw searchOutcome.reason;
        if (productsOutcome.status === 'rejected') throw productsOutcome.reason;
        const initialSearchIndexes = searchOutcome.value;
        const preparedProducts = productsOutcome.value;
        const finalSearchIndexes = await prepareSearchIndexes(first);
        timing('search-indexes-recheck');
        if (!searchIndexReadinessEqual(initialSearchIndexes, finalSearchIndexes)) {
          throw new Error(
            'Assembly annotation product-set search-index receipts changed before commit.'
          );
        }
        await this.revalidateExactProductSet(ordered, preparedProducts);
        timing('revalidate-scenes');
        const products = preparedProducts.map(({ product }) => product);
        const committed = await commitProductSet({
          assemblyId: first.assemblyId,
          workspaceRoot: first.workspaceRoot,
          themeMode: first.artifact.themeMode,
          datasetContract: first.datasetContract,
          scope: first.scope,
          chromosomes: first.chromosomes,
          products,
          searchIndexes: finalSearchIndexes,
        });
        return {
          status: 'ready' as const,
          inventoryFingerprint: committed.inventoryFingerprint,
          trackTypes: products.map((product) => product.trackType),
        };
      });
    this.queueTail = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  async waitForIdleForTests(): Promise<void> {
    await this.queueTail.catch(() => undefined);
  }

  private async prepareExactProduct(
    request: AssemblyAnnotationSceneReadRequest
  ): Promise<AssemblyAnnotationProductIndexReadyV1> {
    let probe = await this.deps.readScene(request);
    if (!probe) throw new Error('Assembly annotation product request could not be validated.');
    if (probe.status === 'miss') {
      const prepared = await this.deps.prepareScene(request, probe);
      if (prepared.status !== 'committed') {
        throw new Error(`Assembly annotation scene preparation ended ${prepared.status}.`);
      }
      probe = await this.deps.readScene(request);
      if (!probe || probe.status !== 'hit') {
        throw new Error('Committed assembly annotation scene was not readable on exact re-probe.');
      }
    }

    const broad = await this.deps.prepareBroadCompanion({
      request,
      sourceFingerprint: probe.fingerprint,
      scenePath: probe.scenePath,
      sceneManifest: probe.manifest,
      payloadSha256: probe.payloadSha256,
    });
    return {
      status: 'ready',
      artifactStatus: broad.status,
      sourceFingerprint: broad.sourceFingerprint,
      surfaceManifestFingerprint: broad.surfaceManifestFingerprint,
      catalogFingerprint: broad.catalogFingerprint,
    };
  }

  private async prepareExactProductSet(
    ordered: readonly AssemblyAnnotationSceneReadRequest[]
  ): Promise<PreparedAssemblyAnnotationProductV1[]> {
    const probes = new Map<string, AssemblyAnnotationSceneCacheIndexReadResult>();
    const fusedBroadCompanions = new Map<string, AssemblyCompiledBroadRasterWorkerResultV1>();
    const cold: Array<{
      request: AssemblyAnnotationSceneReadRequest;
      miss: Extract<AssemblyAnnotationSceneCacheIndexReadResult, { status: 'miss' }>;
    }> = [];
    const timing = referencePreparationTiming(
      `product-set[${ordered[0]?.artifact.themeMode ?? 'unknown'}]`
    );
    const initialProbes = await Promise.all(ordered.map((request) => this.deps.readScene(request)));
    timing('probes');
    ordered.forEach((request, index) => {
      const probe = initialProbes[index];
      if (!probe) throw new Error('Assembly annotation product request could not be validated.');
      probes.set(request.artifact.trackType, probe);
      if (probe.status === 'miss') cold.push({ request, miss: probe });
    });

    if (cold.length > 0) {
      if (this.deps.prepareSceneSet) {
        const outcomes = await this.deps.prepareSceneSet(cold);
        timing('scene-set');
        if (
          outcomes.length !== cold.length ||
          outcomes.some((outcome) => outcome.status !== 'committed')
        ) {
          const failed = cold
            .map(({ request }, index) => ({
              trackType: request.artifact.trackType,
              outcome: outcomes[index] ?? null,
            }))
            .filter(({ outcome }) => outcome?.status !== 'committed');
          throw new Error(
            `Assembly annotation scene-set preparation did not commit every track: ${JSON.stringify(failed)}`
          );
        }
        for (let index = 0; index < cold.length; index += 1) {
          const outcome = outcomes[index];
          if (outcome.status === 'committed' && outcome.broadCompanion) {
            fusedBroadCompanions.set(
              cold[index].request.artifact.trackType,
              outcome.broadCompanion
            );
          }
        }
      } else {
        for (const { request, miss } of cold) {
          const outcome = await this.deps.prepareScene(request, miss);
          if (outcome.status !== 'committed') {
            throw new Error(`Assembly annotation scene preparation ended ${outcome.status}.`);
          }
        }
      }
      const reprobes = await Promise.all(cold.map(({ request }) => this.deps.readScene(request)));
      cold.forEach(({ request }, index) => {
        const reprobe = reprobes[index];
        if (!reprobe || reprobe.status !== 'hit') {
          throw new Error(
            'Committed assembly annotation scene was not readable on exact re-probe.'
          );
        }
        probes.set(request.artifact.trackType, reprobe);
      });
    }

    const products: PreparedAssemblyAnnotationProductV1[] = [];
    for (const request of ordered) {
      const hit = probes.get(request.artifact.trackType);
      if (!hit || hit.status !== 'hit') {
        throw new Error('Assembly annotation product set lost a validated scene hit.');
      }
      const broad =
        fusedBroadCompanions.get(request.artifact.trackType) ??
        (await this.deps.prepareBroadCompanion({
          request,
          sourceFingerprint: hit.fingerprint,
          scenePath: hit.scenePath,
          sceneManifest: hit.manifest,
          payloadSha256: hit.payloadSha256,
        }));
      if (broad.sourceFingerprint !== hit.fingerprint) {
        throw new Error(
          'Assembly annotation product-set broad companion source receipt did not match its exact scene.'
        );
      }
      products.push({
        product: {
          trackType: request.artifact.trackType,
          artifactStatus: broad.status,
          sourceFingerprint: broad.sourceFingerprint,
          surfaceManifestFingerprint: broad.surfaceManifestFingerprint,
          catalogFingerprint: broad.catalogFingerprint,
        },
        exactSceneReceipt: exactSceneReceipt(hit),
      });
    }
    return products;
  }

  private async revalidateExactProductSet(
    ordered: readonly AssemblyAnnotationSceneReadRequest[],
    prepared: readonly PreparedAssemblyAnnotationProductV1[]
  ): Promise<void> {
    const expectedByTrack = new Map(
      prepared.map((entry) => [entry.product.trackType, entry.exactSceneReceipt])
    );
    const finalProbes: Array<{
      trackType: string;
      probe: AssemblyAnnotationSceneCacheIndexReadResult | null;
    }> = await Promise.all(
      ordered.map(async (request) => ({
        trackType: request.artifact.trackType,
        probe: await this.deps.readScene(request),
      }))
    );

    for (const { trackType, probe } of finalProbes) {
      const expected = expectedByTrack.get(trackType);
      if (!expected || !probe || probe.status !== 'hit') {
        throw new Error(
          'Assembly annotation product-set exact scene lost readiness before commit.'
        );
      }
      if (!exactSceneReceiptsEqual(expected, exactSceneReceipt(probe))) {
        throw new Error(
          'Assembly annotation product-set exact scene receipt changed before commit.'
        );
      }
    }
  }
}

type AssemblyAnnotationProductIndexReadyV1 = Extract<
  AssemblyAnnotationProductIndexResultV1,
  { status: 'ready' }
>;

export class AssemblyAnnotationProductIndexQueueFullError extends Error {
  constructor() {
    super('Assembly annotation product queue is at capacity.');
    this.name = 'AssemblyAnnotationProductIndexQueueFullError';
  }
}

function productIdentity(request: AssemblyAnnotationSceneReadRequest): string {
  return JSON.stringify({
    workspaceRoot: request.workspaceRoot,
    assemblyId: request.assemblyId,
    chromosomes: request.chromosomes,
    scope: request.scope,
    datasetContract: request.datasetContract,
    artifact: request.artifact,
  });
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function exactSceneReceipt(
  hit: AssemblyAnnotationSceneIndexHitV1
): AssemblyAnnotationExactSceneReceiptV1 {
  return {
    sourceFingerprint: hit.fingerprint,
    sourceBuildFingerprint: hit.sourceBuildFingerprint,
    scenePath: hit.scenePath,
    byteCount: hit.byteCount,
    payloadSha256: hit.payloadSha256,
    contractSha256: hit.manifest.integrity.contractSha256,
  };
}

function exactSceneReceiptsEqual(
  left: AssemblyAnnotationExactSceneReceiptV1,
  right: AssemblyAnnotationExactSceneReceiptV1
): boolean {
  return (
    left.sourceFingerprint === right.sourceFingerprint &&
    left.sourceBuildFingerprint === right.sourceBuildFingerprint &&
    left.scenePath === right.scenePath &&
    left.byteCount === right.byteCount &&
    left.payloadSha256 === right.payloadSha256 &&
    left.contractSha256 === right.contractSha256
  );
}

function searchIndexReadinessEqual(
  left: AssemblySearchIndexReadinessV1,
  right: AssemblySearchIndexReadinessV1
): boolean {
  return (
    searchArtifactReceiptsEqual(left.annotationSearch, right.annotationSearch) &&
    searchArtifactReceiptsEqual(left.proteinSearch, right.proteinSearch)
  );
}

function searchArtifactReceiptsEqual(
  left: AssemblySearchIndexReadinessV1['annotationSearch'],
  right: AssemblySearchIndexReadinessV1['annotationSearch']
): boolean {
  return (
    left.fingerprint === right.fingerprint &&
    left.byteCount === right.byteCount &&
    left.payloadSha256 === right.payloadSha256 &&
    left.contractSha256 === right.contractSha256 &&
    left.schema === right.schema &&
    left.contractToken === right.contractToken
  );
}

function validateAndOrderProductSetRequests(
  requests: readonly AssemblyAnnotationSceneReadRequest[]
): AssemblyAnnotationSceneReadRequest[] {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('Assembly annotation product set requires a nonempty inventory.');
  }
  const ordered = [...requests].sort((left, right) =>
    left.artifact.trackType.localeCompare(right.artifact.trackType)
  );
  const reference = productSetIdentity(ordered[0]);
  const seen = new Set<string>();
  for (const request of ordered) {
    const trackType = request.artifact.trackType.trim();
    if (!trackType) throw new Error('Assembly annotation product set contains an empty track.');
    if (seen.has(trackType)) {
      throw new Error(`Assembly annotation product set contains duplicate track ${trackType}.`);
    }
    seen.add(trackType);
    if (productSetIdentity(request) !== reference) {
      throw new Error('Assembly annotation products must describe the same complete assembly.');
    }
  }
  return ordered;
}

function productSetIdentity(request: AssemblyAnnotationSceneReadRequest): string {
  const { artifactKey: _artifactKey, trackType: _trackType, ...sharedArtifact } = request.artifact;
  return JSON.stringify({
    workspaceRoot: request.workspaceRoot,
    assemblyId: request.assemblyId,
    chromosomes: request.chromosomes,
    scope: request.scope,
    datasetContract: request.datasetContract,
    artifact: sharedArtifact,
  });
}
