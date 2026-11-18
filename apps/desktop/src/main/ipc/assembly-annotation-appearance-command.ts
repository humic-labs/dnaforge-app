import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  compileAnnotationDataAppearanceV1,
  resealPartitionedTranscriptSceneBinaryDatasetContractV4,
  type SourceAnnotationAliasBindingV1,
} from '@waypoint/genome-renderer/pure';
import {
  ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
  buildAssemblyCompiledBroadRasterSurfaceManifestV1,
  type AssemblyAnnotationAppearancePrepareRequestV1,
  type AssemblyAnnotationAppearancePrepareResultV1,
  type AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import type { AssemblyAnnotationSceneCacheIndexHit } from './assembly-overview-texture-cache';
import type { AssemblyCompiledBroadRasterPreparationOrchestratorV1 } from './assembly-compiled-broad-raster-orchestrator';

export function assemblyAnnotationAppearanceArtifactDirectoryV1(input: {
  readonly cacheRoot: string;
  readonly request: AssemblyAnnotationSceneReadRequest;
  readonly sourceFingerprint: string;
  readonly surfaceManifestFingerprint: string;
}): string {
  const source = createHash('sha256')
    .update(
      JSON.stringify([
        input.request.workspaceRoot,
        input.request.datasetContract,
        input.request.scope,
        input.request.expectedAssetGeneration ?? null,
      ])
    )
    .digest('hex');
  return join(
    input.cacheRoot,
    `${input.sourceFingerprint}-${source}-${input.surfaceManifestFingerprint}.broad-raster.v1`
  );
}

export async function prepareAssemblyAnnotationAppearanceV1(
  input: AssemblyAnnotationAppearancePrepareRequestV1,
  deps: {
    readonly cacheRoot: string;
    readonly readSceneIndex: (
      request: AssemblyAnnotationSceneReadRequest
    ) => Promise<AssemblyAnnotationSceneCacheIndexHit | null>;
    readonly assertSafePath: (path: string) => Promise<void>;
    readonly preparation: AssemblyCompiledBroadRasterPreparationOrchestratorV1;
    readonly prepareSourceAliases: (
      scene: AssemblyAnnotationSceneCacheIndexHit
    ) => Promise<SourceAnnotationAliasBindingV1>;
  }
): Promise<AssemblyAnnotationAppearancePrepareResultV1> {
  if (
    input?.contract !== ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1 ||
    !input.scene ||
    !input.appearance
  ) {
    return { status: 'unavailable', reason: 'invalid-request' };
  }
  try {
    const appearance = await compileAnnotationDataAppearanceV1(input.appearance);
    if (appearance.fingerprint !== input.appearance.fingerprint)
      return { status: 'unavailable', reason: 'invalid-request' };
    const scene = await deps.readSceneIndex(input.scene);
    if (!scene) return { status: 'unavailable', reason: 'source-unavailable' };
    const sourceBinding = scene.manifest.sourceAnnotationAliases
      ? Object.freeze({
          payloadSha256: scene.payloadSha256,
          contractSha256: scene.manifest.integrity.contractSha256,
          aliases: scene.manifest.sourceAnnotationAliases,
        })
      : await deps.prepareSourceAliases(scene).catch(() => null);
    if (!sourceBinding) return { status: 'unavailable', reason: 'source-aliases-unavailable' };
    if (
      sourceBinding.payloadSha256 !== scene.payloadSha256 ||
      sourceBinding.contractSha256 !== scene.manifest.integrity.contractSha256
    )
      return { status: 'unavailable', reason: 'generation-mismatch' };
    const sceneManifest = scene.manifest.sourceAnnotationAliases
      ? scene.manifest
      : await resealPartitionedTranscriptSceneBinaryDatasetContractV4(
          { ...scene.manifest, sourceAnnotationAliases: sourceBinding.aliases },
          scene.manifest.datasetContract
        );
    const surface = await buildAssemblyCompiledBroadRasterSurfaceManifestV1({
      sceneManifest,
      artifact: scene.artifact,
      appearance,
    });
    const artifactDirectory = assemblyAnnotationAppearanceArtifactDirectoryV1({
      cacheRoot: deps.cacheRoot,
      request: input.scene,
      sourceFingerprint: scene.fingerprint,
      surfaceManifestFingerprint: surface.manifestFingerprint,
    });
    if (!input.prepareAliasesOnly) {
      await deps.assertSafePath(artifactDirectory);
      await deps.preparation.ensureSceneHit({
        request: input.scene,
        appearance,
        artifactDirectory,
        sourceFingerprint: scene.fingerprint,
        scenePath: scene.scenePath,
        sceneManifest,
        payloadSha256: scene.payloadSha256,
      });
    }
    const current = await deps.readSceneIndex(input.scene);
    if (
      !current ||
      current.fingerprint !== scene.fingerprint ||
      current.payloadSha256 !== scene.payloadSha256 ||
      current.manifest.integrity.contractSha256 !== scene.manifest.integrity.contractSha256
    ) {
      return { status: 'unavailable', reason: 'generation-mismatch' };
    }
    return {
      status: 'ready',
      appearanceFingerprint: appearance.fingerprint,
      sourcePayloadSha256: scene.payloadSha256,
      sourceContractSha256: scene.manifest.integrity.contractSha256,
      surfaceManifestFingerprint: input.prepareAliasesOnly ? null : surface.manifestFingerprint,
      sourceBinding,
    };
  } catch {
    return { status: 'unavailable', reason: 'preparation-failed' };
  }
}
