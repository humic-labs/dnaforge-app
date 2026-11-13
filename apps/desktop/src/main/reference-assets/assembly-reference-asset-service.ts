import type {
  AssemblyAnnotationSceneReadRequest,
  AssemblyReferenceAssetGenerationV1,
} from '../../shared/indexed-genome';
import {
  ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
  isAssemblyReferenceAssetGenerationV1,
  sameAssemblyReferenceAssetGenerationV1,
} from '../../shared/indexed-genome';
import type { AssemblyAnnotationSceneCacheIndexReadResult } from '../ipc/assembly-overview-texture-cache';
import type { AssemblyAnnotationProductSetManifestV2 } from '../ipc/assembly-annotation-product-set-manifest';

export type AssemblyReferenceAssetRefreshReasonV1 =
  | 'source-unavailable'
  | 'source-index-missing'
  | 'seed-scene-missing'
  | 'product-set-missing'
  | 'generation-mismatch'
  | 'child-artifact-missing'
  | 'verification-failed';

export type AssemblyReferenceAssetProgressPhaseV1 =
  | 'checking'
  | 'preparing-source-summaries'
  | 'discovering-annotation-tracks'
  | 'preparing-products'
  | 'verifying';

export interface AssemblyReferenceAssetRequestV1 {
  readonly seedProduct: AssemblyAnnotationSceneReadRequest;
  readonly onProgress?: (phase: AssemblyReferenceAssetProgressPhaseV1) => void;
}

export type AssemblyReferenceAssetStatusV1 =
  | Readonly<{
      status: 'ready';
      generation: AssemblyReferenceAssetGenerationV1;
      trackTypes: readonly string[];
    }>
  | Readonly<{
      status: 'needs-refresh';
      reason: AssemblyReferenceAssetRefreshReasonV1;
      message?: string;
      sourceFingerprint?: string;
    }>;

export type AssemblyReferenceAssetInspectionV1 =
  | Readonly<{ status: 'ready' }>
  | Readonly<{ status: 'stale'; message: string }>;

export interface AssemblyReferenceAssetServiceDepsV1 {
  readonly inspectSourceInputs: (
    request: AssemblyAnnotationSceneReadRequest
  ) => Promise<AssemblyReferenceAssetInspectionV1>;
  readonly readSceneIndex: (
    request: AssemblyAnnotationSceneReadRequest
  ) => Promise<AssemblyAnnotationSceneCacheIndexReadResult | null>;
  readonly readProductSetManifest: (
    request: AssemblyAnnotationSceneReadRequest,
    sourceFingerprint: string
  ) => Promise<AssemblyAnnotationProductSetManifestV2 | null>;
  readonly inspectProductSet: (
    request: AssemblyAnnotationSceneReadRequest,
    manifest: AssemblyAnnotationProductSetManifestV2
  ) => Promise<AssemblyReferenceAssetInspectionV1>;
  readonly verifyProductSet: (
    request: AssemblyAnnotationSceneReadRequest,
    manifest: AssemblyAnnotationProductSetManifestV2
  ) => Promise<AssemblyReferenceAssetInspectionV1>;
  readonly ensureSourceSummaries: (request: AssemblyAnnotationSceneReadRequest) => Promise<void>;
  readonly discoverProductRequests: (
    request: AssemblyAnnotationSceneReadRequest,
    revision: AssemblyAnnotationSceneCacheIndexReadResult
  ) => Promise<readonly AssemblyAnnotationSceneReadRequest[]>;
  readonly prepareProductSet: (
    requests: readonly AssemblyAnnotationSceneReadRequest[]
  ) => Promise<void>;
}

export class AssemblyReferenceAssetServiceV1 {
  readonly #deps: AssemblyReferenceAssetServiceDepsV1;
  readonly #inFlight = new Map<string, Promise<AssemblyReferenceAssetStatusV1>>();

  constructor(deps: AssemblyReferenceAssetServiceDepsV1) {
    this.#deps = deps;
  }

  async status(request: AssemblyReferenceAssetRequestV1): Promise<AssemblyReferenceAssetStatusV1> {
    request.onProgress?.('checking');
    const expected = request.seedProduct.expectedAssetGeneration;
    if (expected) return this.#statusForPublishedGeneration(request.seedProduct, expected);
    return this.#status(request.seedProduct);
  }

  async #statusForPublishedGeneration(
    request: AssemblyAnnotationSceneReadRequest,
    expected: AssemblyReferenceAssetGenerationV1
  ): Promise<AssemblyReferenceAssetStatusV1> {
    if (
      !isAssemblyReferenceAssetGenerationV1(expected) ||
      expected.themeMode !== request.artifact.themeMode
    ) {
      return refreshNeeded('generation-mismatch');
    }
    const manifest = await this.#deps.readProductSetManifest(request, expected.sourceFingerprint);
    if (!manifest) {
      return refreshNeeded('product-set-missing', undefined, expected.sourceFingerprint);
    }
    const admitted = statusFromManifest(manifest);
    if (!sameAssemblyReferenceAssetGenerationV1(admitted.generation, expected)) {
      return refreshNeeded(
        'generation-mismatch',
        'The published reference generation does not match its atomic product-set commit.',
        manifest.sourceFingerprint
      );
    }
    return admitted;
  }

  async verify(request: AssemblyReferenceAssetRequestV1): Promise<AssemblyReferenceAssetStatusV1> {
    request.onProgress?.('checking');
    const admitted = await this.#status(request.seedProduct);
    if (admitted.status !== 'ready') return admitted;
    const revision = await this.#deps.readSceneIndex(request.seedProduct);
    if (!revision) return refreshNeeded('source-unavailable');
    const manifest = await this.#deps.readProductSetManifest(
      request.seedProduct,
      revision.fingerprint
    );
    if (!manifest) {
      return refreshNeeded('product-set-missing', undefined, revision.fingerprint);
    }
    request.onProgress?.('verifying');
    const verified = await this.#deps.verifyProductSet(request.seedProduct, manifest);
    if (verified.status !== 'ready') {
      return refreshNeeded('verification-failed', verified.message, revision.fingerprint);
    }
    return statusFromManifest(manifest);
  }

  ensure(request: AssemblyReferenceAssetRequestV1): Promise<AssemblyReferenceAssetStatusV1> {
    const key = referenceAssetIdentity(request.seedProduct);
    const incumbent = this.#inFlight.get(key);
    if (incumbent) return incumbent;
    const task = this.#ensure(request).finally(() => {
      if (this.#inFlight.get(key) === task) this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, task);
    return task;
  }

  async #ensure(request: AssemblyReferenceAssetRequestV1): Promise<AssemblyReferenceAssetStatusV1> {
    request.onProgress?.('checking');
    const current = await this.#status(request.seedProduct);
    if (current.status === 'ready') return current;

    request.onProgress?.('preparing-source-summaries');
    await this.#deps.ensureSourceSummaries(request.seedProduct);
    const revision = await this.#deps.readSceneIndex(request.seedProduct);
    if (!revision) return refreshNeeded('source-unavailable');

    request.onProgress?.('discovering-annotation-tracks');
    const products = await this.#deps.discoverProductRequests(request.seedProduct, revision);
    if (products.length === 0) {
      return refreshNeeded(
        'verification-failed',
        'The source produced an empty annotation-track inventory.',
        revision.fingerprint
      );
    }

    request.onProgress?.('preparing-products');
    await this.#deps.prepareProductSet(products);
    request.onProgress?.('verifying');
    return this.#statusOfFreshCommit(request.seedProduct);
  }

  async #statusOfFreshCommit(
    request: AssemblyAnnotationSceneReadRequest
  ): Promise<AssemblyReferenceAssetStatusV1> {
    const sourceInputs = await this.#deps.inspectSourceInputs(request);
    if (sourceInputs.status !== 'ready') {
      return refreshNeeded('source-index-missing', sourceInputs.message);
    }
    const revision = await this.#deps.readSceneIndex(request);
    if (!revision) return refreshNeeded('source-unavailable');
    const manifest = await this.#deps.readProductSetManifest(request, revision.fingerprint);
    if (!manifest) {
      return refreshNeeded('product-set-missing', undefined, revision.fingerprint);
    }
    return statusFromManifest(manifest);
  }

  async #status(
    request: AssemblyAnnotationSceneReadRequest
  ): Promise<AssemblyReferenceAssetStatusV1> {
    const sourceInputs = await this.#deps.inspectSourceInputs(request);
    if (sourceInputs.status !== 'ready') {
      return refreshNeeded('source-index-missing', sourceInputs.message);
    }
    const revision = await this.#deps.readSceneIndex(request);
    if (!revision) return refreshNeeded('source-unavailable');
    const manifest = await this.#deps.readProductSetManifest(request, revision.fingerprint);
    if (!manifest) {
      return refreshNeeded(
        revision.status === 'hit' ? 'product-set-missing' : 'seed-scene-missing',
        undefined,
        revision.fingerprint
      );
    }
    const inspection = await this.#deps.inspectProductSet(request, manifest);
    if (inspection.status !== 'ready') {
      return refreshNeeded('child-artifact-missing', inspection.message, revision.fingerprint);
    }
    return statusFromManifest(manifest);
  }
}

function statusFromManifest(
  manifest: AssemblyAnnotationProductSetManifestV2
): Extract<AssemblyReferenceAssetStatusV1, { status: 'ready' }> {
  return {
    status: 'ready',
    generation: {
      contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
      sourceFingerprint: manifest.sourceFingerprint,
      inventoryFingerprint: manifest.inventoryFingerprint,
      themeMode: manifest.themeMode,
    },
    trackTypes: manifest.trackTypes,
  };
}

function refreshNeeded(
  reason: AssemblyReferenceAssetRefreshReasonV1,
  message?: string,
  sourceFingerprint?: string
): Extract<AssemblyReferenceAssetStatusV1, { status: 'needs-refresh' }> {
  return {
    status: 'needs-refresh',
    reason,
    ...(message ? { message } : {}),
    ...(sourceFingerprint ? { sourceFingerprint } : {}),
  };
}

function referenceAssetIdentity(request: AssemblyAnnotationSceneReadRequest): string {
  return JSON.stringify({
    workspaceRoot: request.workspaceRoot,
    assemblyId: request.assemblyId,
    datasetContract: request.datasetContract,
    chromosomes: request.chromosomes,
    scope: request.scope,
    themeMode: request.artifact.themeMode,
  });
}
