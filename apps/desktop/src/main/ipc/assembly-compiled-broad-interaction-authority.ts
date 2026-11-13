import type { AssemblyAnnotationSceneReadRequest } from '../../shared/indexed-genome';
import type { PortablePreparedReferenceCompiledBroadInteractionHitV1 } from '../reference-assets/portable-prepared-reference-view-authority';
import type {
  PortablePreparedReferenceSceneAdmissionWorkerJobV1,
  PortablePreparedReferenceSceneAdmissionWorkerResultV1,
} from '../reference-assets/portable-prepared-reference-scene-admission-worker-job';
import { portablePreparedReferenceSceneAdmissionWorkerContractV1 } from '../reference-assets/portable-prepared-reference-scene-admission-worker-job';
import type { AssemblyAnnotationSceneCacheIndexReadResult } from './assembly-overview-texture-cache';

type CompactInteractionHit = PortablePreparedReferenceCompiledBroadInteractionHitV1;
type SceneIndexHit = Extract<AssemblyAnnotationSceneCacheIndexReadResult, { status: 'hit' }>;

export type AssemblyCompiledBroadInteractionReadModeV1 =
  | 'portable-only'
  | 'local-only'
  | 'portable-then-local';

export interface AssemblyCompiledBroadInteractionAuthorityDepsV1 {
  readonly readPortable: (
    input: AssemblyAnnotationSceneReadRequest
  ) => Promise<CompactInteractionHit | null>;
  readonly readLocalSceneIndex: (
    input: AssemblyAnnotationSceneReadRequest
  ) => Promise<AssemblyAnnotationSceneCacheIndexReadResult | null>;
  readonly projectLocalScene: (
    job: PortablePreparedReferenceSceneAdmissionWorkerJobV1
  ) => Promise<PortablePreparedReferenceSceneAdmissionWorkerResultV1>;
  readonly resolveRealPath: (path: string) => Promise<string>;
  readonly persistLocalProjection: (
    input: AssemblyAnnotationSceneReadRequest,
    projection: Extract<
      PortablePreparedReferenceSceneAdmissionWorkerResultV1,
      { projection: 'compiled-broad-interaction' }
    >
  ) => Promise<boolean>;
}

function localProjectionKey(index: SceneIndexHit): string {
  return JSON.stringify([
    'assembly-compiled-broad-interaction-local-projection.v1',
    index.scenePath,
    index.fingerprint,
    index.sourceBuildFingerprint,
    index.payloadSha256,
    index.manifest.integrity.contractSha256,
    index.manifest.datasetContract,
  ]);
}

function sameLocalScene(left: SceneIndexHit, right: SceneIndexHit): boolean {
  return localProjectionKey(left) === localProjectionKey(right);
}

export class AssemblyCompiledBroadInteractionAuthorityV1 {
  readonly #deps: AssemblyCompiledBroadInteractionAuthorityDepsV1;
  readonly #localAdmissionTasks = new Map<
    string,
    Promise<PortablePreparedReferenceSceneAdmissionWorkerResultV1>
  >();

  constructor(deps: AssemblyCompiledBroadInteractionAuthorityDepsV1) {
    this.#deps = deps;
  }

  async read(
    input: AssemblyAnnotationSceneReadRequest,
    mode: AssemblyCompiledBroadInteractionReadModeV1 = 'portable-then-local'
  ): Promise<CompactInteractionHit | null> {
    if (mode !== 'local-only') {
      const portable = await this.#deps.readPortable(input);
      if (portable || mode === 'portable-only') return portable;
    }

    const indexed = await this.#deps.readLocalSceneIndex(input);
    if (!indexed || indexed.status !== 'hit') return null;
    const compact = indexed.compiledBroadInteraction;
    if (compact) {
      const authorizedPayloadRealPath = await this.#deps.resolveRealPath(compact.payloadPath);
      const key = JSON.stringify([
        'assembly-compiled-broad-interaction-persisted-admission.v1',
        compact.payloadPath,
        compact.payloadSha256,
        indexed.payloadSha256,
        indexed.manifest.integrity.contractSha256,
      ]);
      let task = this.#localAdmissionTasks.get(key);
      if (!task) {
        task = this.#deps.projectLocalScene({
          contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
          payloadPath: compact.payloadPath,
          authorizedPayloadRealPath,
          projection: 'admit-persisted-compiled-broad-interaction',
          manifest: compact.manifest,
          expectedPayloadSha256: compact.payloadSha256,
        });
        this.#localAdmissionTasks.set(key, task);
        void task.catch(() => {
          if (this.#localAdmissionTasks.get(key) === task) {
            this.#localAdmissionTasks.delete(key);
          }
        });
      }
      const admitted = await task;
      if (
        !('projection' in admitted) ||
        admitted.projection !== 'persisted-compiled-broad-interaction' ||
        admitted.byteCount !== compact.byteCount ||
        admitted.payloadSha256 !== compact.payloadSha256 ||
        admitted.manifest.sourceScene.payloadSha256 !== indexed.payloadSha256 ||
        admitted.manifest.sourceScene.contractSha256 !==
          indexed.manifest.integrity.contractSha256 ||
        admitted.manifest.sourceScene.byteLength !== indexed.byteCount
      ) {
        return null;
      }
      const current = await this.#deps.readLocalSceneIndex(input);
      if (
        !current ||
        current.status !== 'hit' ||
        !sameLocalScene(indexed, current) ||
        current.compiledBroadInteraction?.payloadPath !== compact.payloadPath ||
        current.compiledBroadInteraction.payloadSha256 !== compact.payloadSha256
      ) {
        return null;
      }
      return Object.freeze({
        status: 'hit',
        authorityKind: 'local',
        origin: 'durable-hit',
        ipcContractVersion: indexed.ipcContractVersion,
        fingerprint: indexed.fingerprint,
        sourceBuildFingerprint: indexed.sourceBuildFingerprint,
        scope: indexed.scope,
        artifact: indexed.artifact,
        sourceScene: Object.freeze({
          byteCount: indexed.byteCount,
          payloadSha256: indexed.payloadSha256,
          contractSha256: indexed.manifest.integrity.contractSha256,
        }),
        byteCount: admitted.byteCount,
        payloadSha256: admitted.payloadSha256,
        manifest: admitted.manifest,
        validatedPayload: admitted.validatedPayload,
      });
    }
    const authorizedPayloadRealPath = await this.#deps.resolveRealPath(indexed.scenePath);
    const key = localProjectionKey(indexed);
    let task = this.#localAdmissionTasks.get(key);
    if (!task) {
      task = this.#deps.projectLocalScene({
        contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
        payloadPath: indexed.scenePath,
        authorizedPayloadRealPath,
        manifest: indexed.manifest,
        expectedPayloadSha256: indexed.payloadSha256,
        projection: 'compiled-broad-interaction',
        projectionDatasetContract: indexed.manifest.datasetContract,
        expectedProjectionContractSha256: indexed.manifest.integrity.contractSha256,
      });
      this.#localAdmissionTasks.set(key, task);
      void task.catch(() => {
        if (this.#localAdmissionTasks.get(key) === task) {
          this.#localAdmissionTasks.delete(key);
        }
      });
    }

    const projected = await task;
    if (
      !('projection' in projected) ||
      projected.projection !== 'compiled-broad-interaction' ||
      projected.sourceByteCount !== indexed.byteCount ||
      projected.sourcePayloadSha256 !== indexed.payloadSha256 ||
      projected.manifest.sourceScene.contractSha256 !== indexed.manifest.integrity.contractSha256
    ) {
      return null;
    }

    const current = await this.#deps.readLocalSceneIndex(input);
    if (!current || current.status !== 'hit' || !sameLocalScene(indexed, current)) return null;

    await this.#deps.persistLocalProjection(input, projected);

    return Object.freeze({
      status: 'hit',
      authorityKind: 'local',
      origin: 'prepared-after-miss',
      ipcContractVersion: indexed.ipcContractVersion,
      fingerprint: indexed.fingerprint,
      sourceBuildFingerprint: indexed.sourceBuildFingerprint,
      scope: indexed.scope,
      artifact: indexed.artifact,
      sourceScene: Object.freeze({
        byteCount: projected.sourceByteCount,
        payloadSha256: projected.sourcePayloadSha256,
        contractSha256: projected.manifest.sourceScene.contractSha256,
      }),
      byteCount: projected.byteCount,
      payloadSha256: projected.payloadSha256,
      manifest: projected.manifest,
      validatedPayload: projected.validatedPayload,
    });
  }

  clearForTest(): void {
    this.#localAdmissionTasks.clear();
  }
}
