import {
  annotationRoleSidecarDescriptorMatchesSceneV1,
  encodeAnnotationRoleSidecarV1,
  type AssemblyAnnotationRoleSidecarDiskDescriptorV1,
} from './assembly-annotation-role-sidecar';
import { createHash } from 'crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises';
import {
  isPrebuiltAnnotationRasterLaneProjectionV1,
  isPrebuiltAnnotationRasterPresentationReceiptV1,
  assertPartitionedTranscriptSceneRangeCatalogV1,
  buildPartitionedTranscriptSceneRangeCatalogV1,
  validateCompiledBroadAnnotationInteractionBinaryV1,
  validatePartitionedTranscriptSceneBinaryV4,
} from '@waypoint/genome-renderer/pure';
import type {
  AnnotationSceneDatasetContractV1,
  CompiledBroadAnnotationInteractionBinaryManifestV1,
  PartitionedTranscriptSceneBinaryManifestV4,
  PartitionedTranscriptSceneRangeCatalogV1,
  PrebuiltAnnotationRasterLaneProjectionV1,
} from '@waypoint/genome-renderer/pure';
import {
  ASSEMBLY_ANNOTATION_RASTER_LANE_COMPLETE_SOURCE_V1,
  ASSEMBLY_ANNOTATION_RASTER_MANIFEST_V2,
  ASSEMBLY_ANNOTATION_RASTER_PROJECTION_ARTIFACT_V1,
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  assemblyAnnotationRasterLaneProjectionV1,
  assemblyAnnotationRasterSemanticReceiptV1,
  assemblyAnnotationRasterVariantKeyV2,
  assemblyAnnotationSceneScopeForRequest,
  assemblyAnnotationSceneScopeMatchesChromosomes,
  isAssemblyAnnotationRasterVariantV2,
  type AssemblyAnnotationRasterManifestV2,
  type AssemblyAnnotationRasterLaneCompleteSourceV1,
  type AssemblyAnnotationRasterReadRequestV2,
  type AssemblyAnnotationRasterReadResultV2,
  type AssemblyAnnotationRasterVariantV2,
  type AssemblyAnnotationSceneHitResult,
  type AssemblyAnnotationSceneMissResult,
  type AssemblyAnnotationSceneReadRequest,
  type AssemblyAnnotationSceneReadResult,
  type AssemblyAnnotationSceneWriteRequest,
  type AssemblyAnnotationSceneWriteResult,
  type AssemblyAnnotationSceneArtifactContract,
  type AssemblyAnnotationRuntimePolicy,
  type AssemblyAnnotationSceneScopeContract,
  type AssemblyOverviewChromInput,
  type AssemblyOverviewTextureLayout as AssemblyTextureLayout,
  type AssemblyOverviewTextureManifest as AssemblyTextureManifest,
  type AssemblyOverviewTextureReadResult as AssemblyTextureReadResult,
} from '../../shared/indexed-genome';
import { ANNOTATION_TRACK_IDENTITY_CONTRACT_TOKEN } from '../../features/sequence/annotation-layer-identity';
import { TRANSCRIPT_RESOLUTION_CONTRACT_TOKEN } from '../../features/sequence/components/spliced-feature-resolver';
import { joinPath } from '../../features/sequence/indexed-genome-paths';
import { sha256BoundedNodeV1 } from './bounded-binary-sha256';
import {
  ASSEMBLY_ANNOTATION_SCENE_CACHE_VERSION,
  ASSEMBLY_ANNOTATION_SCENE_LEGACY_COMPILER_CONTRACT,
  ASSEMBLY_TEXTURE_PLACEMENT_ALGORITHM,
  annotationSceneCompilerContractFingerprint,
  datasetContractsAreWellFormed,
  sceneArtifactIsWellFormed,
  scopeIsWellFormed,
} from '../../shared/annotation-scene-compiler-contract';
export {
  ASSEMBLY_ANNOTATION_SCENE_CACHE_VERSION,
  ASSEMBLY_ANNOTATION_SCENE_LEGACY_COMPILER_CONTRACT,
  ASSEMBLY_TEXTURE_PLACEMENT_ALGORITHM,
  annotationSceneCompilerContractFingerprint,
};

export type { AssemblyTextureLayout, AssemblyTextureManifest, AssemblyTextureReadResult };

export interface AssemblyAnnotationSceneCacheResourceHit extends Omit<
  AssemblyAnnotationSceneHitResult,
  'payload'
> {
  scenePath: string;
  payloadSha256: string;
  validatedPayload: Uint8Array;
  detailRangeCatalog?: PartitionedTranscriptSceneRangeCatalogV1;
}

export interface AssemblyAnnotationSceneCacheIndexHit extends Omit<
  AssemblyAnnotationSceneHitResult,
  'payload'
> {
  scenePath: string;
  payloadSha256: string;
  placementFingerprint: string;
  detailRangeCatalog?: PartitionedTranscriptSceneRangeCatalogV1;
  compiledBroadInteraction?: AssemblyCompiledBroadInteractionCacheIndexV1;
  roleSidecar?: AssemblyAnnotationRoleSidecarCacheIndexV1;
}

export interface AssemblyAnnotationRoleSidecarCacheIndexV1 {
  payloadPath: string;
  byteCount: number;
  payloadSha256: string;
  roleTable: AssemblyAnnotationRoleSidecarDiskDescriptorV1['roleTable'];
  expandedCount: number;
  canonicalCount: number;
}

export interface AssemblyCompiledBroadInteractionCacheIndexV1 {
  payloadPath: string;
  byteCount: number;
  payloadSha256: string;
  manifest: CompiledBroadAnnotationInteractionBinaryManifestV1;
}

export type AssemblyAnnotationSceneCacheIndexReadResult =
  | AssemblyAnnotationSceneMissResult
  | AssemblyAnnotationSceneCacheIndexHit;

export type AssemblyAnnotationSceneCacheResourceReadResult =
  | AssemblyAnnotationSceneMissResult
  | AssemblyAnnotationSceneCacheResourceHit;

interface AssemblyAnnotationSceneCacheInternalHit extends AssemblyAnnotationSceneCacheIndexHit {
  payload: Uint8Array;
}

type AssemblyAnnotationSceneCacheInternalReadResult =
  | AssemblyAnnotationSceneMissResult
  | AssemblyAnnotationSceneCacheInternalHit;

export const ASSEMBLY_TEXTURE_CACHE_VERSION = 1;

export const ASSEMBLY_OVERVIEW_CACHE_CONTRACT_TOKEN = [
  'indexed-linear-annotation-visual-contract-v2-runtime-texture-presenter-deleted',
  'resolved-transcript-v2-full-layer-overview-v2',
  TRANSCRIPT_RESOLUTION_CONTRACT_TOKEN,
  ANNOTATION_TRACK_IDENTITY_CONTRACT_TOKEN,
  'genome-wide-texture-readpixels-flipY-v1',
  'annotation-physical-placement-v1',
].join('|');

export interface AssemblyTextureCacheDeps {
  assertSafePath: (filePath: string) => Promise<void>;
  statSource?: (filePath: string) => Promise<{ size: number; mtimeMs: number; ctimeMs?: number }>;
  readFileImpl?: (filePath: string) => Promise<Buffer>;
  writeFileImpl?: (filePath: string, data: Buffer | string) => Promise<void>;
  renameImpl?: (fromPath: string, toPath: string) => Promise<void>;
  unlinkImpl?: (filePath: string) => Promise<void>;
  mkdirImpl?: (dir: string) => Promise<void>;
  readdirImpl?: (dir: string) => Promise<string[]>;
  statCacheFile?: (filePath: string) => Promise<{ mtimeMs: number; size?: number }>;
  cacheContractToken?: string;
  workspaceRoot?: string | null;
  sourceBuildFingerprint?: string | null;
}

const defaultStat: NonNullable<AssemblyTextureCacheDeps['statSource']> = (p) => stat(p);
const defaultRead: NonNullable<AssemblyTextureCacheDeps['readFileImpl']> = (p) => readFile(p);
const defaultWrite: NonNullable<AssemblyTextureCacheDeps['writeFileImpl']> = (p, d) =>
  writeFile(p, d);
const defaultRename: NonNullable<AssemblyTextureCacheDeps['renameImpl']> = (from, to) =>
  rename(from, to);
const defaultUnlink: NonNullable<AssemblyTextureCacheDeps['unlinkImpl']> = (path) => unlink(path);
const defaultReaddir: NonNullable<AssemblyTextureCacheDeps['readdirImpl']> = (d) => readdir(d);
const defaultStatCacheFile: NonNullable<AssemblyTextureCacheDeps['statCacheFile']> = (p) => stat(p);
const defaultMkdir: NonNullable<AssemblyTextureCacheDeps['mkdirImpl']> = async (d) => {
  await mkdir(d, { recursive: true });
};

function cacheContractToken(deps: Pick<AssemblyTextureCacheDeps, 'cacheContractToken'>): string {
  const token = deps.cacheContractToken?.trim();
  return token && token.length > 0 ? token : ASSEMBLY_OVERVIEW_CACHE_CONTRACT_TOKEN;
}

function sourceBuildFingerprint(
  deps: Pick<AssemblyTextureCacheDeps, 'sourceBuildFingerprint'>
): string {
  const fingerprint = deps.sourceBuildFingerprint?.trim();
  return fingerprint && fingerprint.length > 0 ? fingerprint : 'unknown-source-build';
}

function assemblyTexturePlacement(chromosomes: readonly AssemblyOverviewChromInput[]): {
  signature: string;
  totalLength: number;
} | null {
  if (!Array.isArray(chromosomes) || chromosomes.length === 0) return null;
  let startBp = 0;
  const placements: string[] = [];
  for (let index = 0; index < chromosomes.length; index += 1) {
    const chromosome = chromosomes[index];
    if (!chromosome?.chrom || !Number.isSafeInteger(chromosome.length) || chromosome.length <= 0) {
      return null;
    }
    const endBp = startBp + chromosome.length;
    if (!Number.isSafeInteger(endBp)) return null;
    placements.push(`${index}|${chromosome.chrom}|${startBp}|${endBp}|${chromosome.length}`);
    startBp = endBp;
  }
  return {
    signature: [
      `placement:${ASSEMBLY_TEXTURE_PLACEMENT_ALGORITHM}`,
      `total:${startBp}`,
      ...placements,
    ].join('\n'),
    totalLength: startBp,
  };
}

function normalizedFingerprintPath(sourcePath: string, workspaceRoot?: string | null): string {
  const source = sourcePath.trim().replace(/\\/g, '/');
  const root = workspaceRoot?.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && source === root) return 'workspace:.';
  if (root && source.startsWith(`${root}/`)) return `workspace:${source.slice(root.length + 1)}`;
  return `absolute:${source}`;
}

function textureCacheDir(workspaceRoot: string): string {
  return joinPath(workspaceRoot, '.waypoint', 'genome-index', 'assembly-overview');
}

function texturePngPath(workspaceRoot: string, assemblyId: string, fingerprint: string): string {
  return joinPath(textureCacheDir(workspaceRoot), `${assemblyId}-${fingerprint}.png`);
}

function textureManifestPath(
  workspaceRoot: string,
  assemblyId: string,
  fingerprint: string
): string {
  return joinPath(textureCacheDir(workspaceRoot), `${assemblyId}-${fingerprint}.json`);
}

const ASSEMBLY_ANNOTATION_SCENE_SOURCE_FINGERPRINT_CONTRACT =
  'assembly-annotation-scene-source-fingerprint.content-identity.v2';
export const ASSEMBLY_ANNOTATION_SCENE_COMPILER_CONTRACT = [
  ASSEMBLY_ANNOTATION_SCENE_LEGACY_COMPILER_CONTRACT,
  ANNOTATION_TRACK_IDENTITY_CONTRACT_TOKEN,
].join('|');

function annotationScenePath(
  workspaceRoot: string,
  assemblyId: string,
  fingerprint: string,
  companionKey: string,
  payloadSha256: string
): string {
  return joinPath(
    textureCacheDir(workspaceRoot),
    `${assemblyId}-${fingerprint}-${companionKey}-${payloadSha256}.annotation-scene.v6.bin`
  );
}

function annotationSceneManifestPath(
  workspaceRoot: string,
  assemblyId: string,
  fingerprint: string,
  companionKey: string
): string {
  return joinPath(
    textureCacheDir(workspaceRoot),
    `${assemblyId}-${fingerprint}-${companionKey}.annotation-scene.v6.json`
  );
}

export function compiledBroadInteractionFileName(
  assemblyId: string,
  fingerprint: string,
  companionKey: string,
  sourcePayloadSha256: string,
  compactPayloadSha256: string
): string {
  const identitySha256 = createHash('sha256')
    .update(
      JSON.stringify([
        assemblyId,
        fingerprint,
        companionKey,
        sourcePayloadSha256,
        compactPayloadSha256,
      ])
    )
    .digest('hex');
  return `${identitySha256}.compiled-broad-interaction.v1.bin`;
}

function legacyCompiledBroadInteractionFileName(
  assemblyId: string,
  fingerprint: string,
  companionKey: string,
  sourcePayloadSha256: string,
  compactPayloadSha256: string
): string {
  return `${assemblyId}-${fingerprint}-${companionKey}-${sourcePayloadSha256}-${compactPayloadSha256}.compiled-broad-interaction.v1.bin`;
}

function compiledBroadInteractionPath(
  workspaceRoot: string,
  assemblyId: string,
  fingerprint: string,
  companionKey: string,
  sourcePayloadSha256: string,
  compactPayloadSha256: string
): string {
  return joinPath(
    textureCacheDir(workspaceRoot),
    compiledBroadInteractionFileName(
      assemblyId,
      fingerprint,
      companionKey,
      sourcePayloadSha256,
      compactPayloadSha256
    )
  );
}

interface AssemblyCompiledBroadInteractionDiskDescriptorV1 {
  version: 1;
  file: string;
  byteCount: number;
  payloadSha256: string;
  manifest: CompiledBroadAnnotationInteractionBinaryManifestV1;
}

interface AssemblyAnnotationSceneDiskManifestV6 {
  version: 6;
  assemblyId: string;
  fingerprint: string;
  companionKey: string;
  compilerContractFingerprint: string;
  placementSignature: string;
  sceneFile: string;
  byteCount: number;
  scope: AssemblyAnnotationSceneScopeContract;
  artifact: AssemblyAnnotationSceneArtifactContract;
  sceneManifest: PartitionedTranscriptSceneBinaryManifestV4;
  detailRangeCatalog?: PartitionedTranscriptSceneRangeCatalogV1;
  compiledBroadInteraction?: AssemblyCompiledBroadInteractionDiskDescriptorV1;
  roleSidecar?: AssemblyAnnotationRoleSidecarDiskDescriptorV1;
}

function annotationSceneCompanionKey(
  dataset: AnnotationSceneDatasetContractV1,
  artifact: AssemblyAnnotationSceneArtifactContract,
  scope: AssemblyAnnotationSceneScopeContract
): string | null {
  return annotationSceneCompilerContractFingerprint(dataset, artifact, scope)?.slice(0, 20) ?? null;
}

export function assemblyCompiledBroadRasterArtifactDirectory(input: {
  readonly request: AssemblyAnnotationSceneReadRequest;
  readonly sourceFingerprint: string;
  readonly surfaceManifestFingerprint: string;
}): string | null {
  const request = input.request;
  const companionKey = annotationSceneCompanionKey(
    request.datasetContract,
    request.artifact,
    request.scope
  );
  if (
    !request.assemblyId ||
    !request.workspaceRoot ||
    !companionKey ||
    !/^[0-9a-f]{24}$/.test(input.sourceFingerprint) ||
    !/^[0-9a-f]{64}$/.test(input.surfaceManifestFingerprint)
  ) {
    return null;
  }
  return joinPath(
    textureCacheDir(request.workspaceRoot),
    `${request.assemblyId}-${input.sourceFingerprint}-${companionKey}-${input.surfaceManifestFingerprint}.broad-raster.v1`
  );
}

export async function computeAssemblyAnnotationSceneSourceFingerprint(
  input: Pick<
    AssemblyAnnotationSceneReadRequest,
    'chromosomes' | 'workspaceRoot' | 'scope' | 'datasetContract'
  >,
  deps: AssemblyTextureCacheDeps
): Promise<string | null> {
  const chromosomes = input.chromosomes;
  if (!assemblyAnnotationSceneScopeMatchesChromosomes(input.scope, chromosomes)) return null;
  if (!datasetContractsAreWellFormed(input.datasetContract)) return null;
  if (!Array.isArray(chromosomes) || chromosomes.length === 0) return null;
  const placement = assemblyTexturePlacement(chromosomes);
  if (!placement) return null;
  const statFn = deps.statSource ?? defaultStat;
  const placements: Array<{ index: number; startBp: number; sourcePath: string }> = [];
  let startBp = 0;
  for (let index = 0; index < chromosomes.length; index += 1) {
    const sourcePath = chromosomes[index].sourcePath?.trim() ?? '';
    if (sourcePath) placements.push({ index, startBp, sourcePath });
    startBp += chromosomes[index].length;
  }
  const annotationSourceCount = placements.length;
  let signatures: string[];
  try {
    signatures = await Promise.all(
      placements.map(async ({ index, startBp: chromosomeStartBp, sourcePath }) => {
        const chromosome = chromosomes[index];
        await deps.assertSafePath(sourcePath);
        const sourceStat = await statFn(sourcePath);
        return [
          index,
          chromosome.chrom,
          chromosomeStartBp,
          chromosomeStartBp + chromosome.length,
          chromosome.length,
          normalizedFingerprintPath(sourcePath, input.workspaceRoot),
          sourceStat.size,
        ].join('|');
      })
    );
  } catch {
    return null;
  }
  if (annotationSourceCount === 0) return null;
  return createHash('sha256')
    .update(
      [
        ASSEMBLY_ANNOTATION_SCENE_SOURCE_FINGERPRINT_CONTRACT,
        [
          input.datasetContract.datasetId,
          input.datasetContract.datasetVersion,
          input.datasetContract.sourceSha256,
        ].join('|'),
        placement.signature,
        signatures.join('\n'),
      ].join('\n')
    )
    .digest('hex')
    .slice(0, 24);
}

export async function computeAssemblyTextureFingerprint(
  chromosomes: readonly AssemblyOverviewChromInput[],
  deps: AssemblyTextureCacheDeps
): Promise<string | null> {
  if (!Array.isArray(chromosomes) || chromosomes.length === 0) return null;
  const placement = assemblyTexturePlacement(chromosomes);
  if (!placement) return null;
  const statFn = deps.statSource ?? defaultStat;
  const contractToken = cacheContractToken(deps);
  const buildFingerprint = sourceBuildFingerprint(deps);
  const signatures: string[] = [];
  let startBp = 0;
  let annotationSourceCount = 0;
  for (let index = 0; index < chromosomes.length; index += 1) {
    const c = chromosomes[index];
    try {
      const endBp = startBp + c.length;
      const sourcePath = c.sourcePath?.trim() ?? '';
      if (!sourcePath) {
        startBp = endBp;
        continue;
      }
      annotationSourceCount += 1;
      await deps.assertSafePath(sourcePath);
      const st = await statFn(sourcePath);
      const sourceKey = normalizedFingerprintPath(sourcePath, deps.workspaceRoot);
      signatures.push(
        [
          index,
          c.chrom,
          startBp,
          endBp,
          c.length,
          sourceKey,
          st.size,
          st.mtimeMs,
          st.ctimeMs ?? 'na',
        ].join('|')
      );
      startBp = endBp;
    } catch {
      return null;
    }
  }
  if (annotationSourceCount === 0) return null;
  return createHash('sha256')
    .update(
      [
        `v${ASSEMBLY_TEXTURE_CACHE_VERSION}`,
        `contract:${contractToken}`,
        `build:${buildFingerprint}`,
        placement.signature,
        signatures.join('\n'),
      ].join('\n')
    )
    .digest('hex')
    .slice(0, 24);
}

export async function readAssemblyOverviewTextureCache(
  input: {
    assemblyId: string;
    chromosomes: readonly AssemblyOverviewChromInput[];
    workspaceRoot: string;
  },
  deps: AssemblyTextureCacheDeps
): Promise<AssemblyTextureReadResult | null> {
  try {
    if (!input?.assemblyId || !input?.workspaceRoot) return null;
    const fingerprint = await computeAssemblyTextureFingerprint(input.chromosomes, {
      ...deps,
      workspaceRoot: input.workspaceRoot,
    });
    if (!fingerprint) return null;
    const contractToken = cacheContractToken(deps);
    const buildFingerprint = sourceBuildFingerprint(deps);
    const placement = assemblyTexturePlacement(input.chromosomes);
    if (!placement) return null;
    const exact = await readAssemblyOverviewTextureCacheEntry(
      {
        assemblyId: input.assemblyId,
        workspaceRoot: input.workspaceRoot,
        fingerprint,
        contractToken,
        sourceBuildFingerprint: buildFingerprint,
        placement,
      },
      deps
    );
    if (exact) return exact;
    return await readCompatibleBuildFingerprintAlias(input, deps, {
      contractToken,
      placement,
    });
  } catch {
    return null;
  }
}

async function readCompatibleBuildFingerprintAlias(
  input: {
    assemblyId: string;
    chromosomes: readonly AssemblyOverviewChromInput[];
    workspaceRoot: string;
  },
  deps: AssemblyTextureCacheDeps,
  context: {
    contractToken: string;
    placement: { signature: string; totalLength: number };
  }
): Promise<AssemblyTextureReadResult | null> {
  try {
    const dir = textureCacheDir(input.workspaceRoot);
    const names = await (deps.readdirImpl ?? defaultReaddir)(dir);
    const candidateNames = names
      .filter((name) => name.startsWith(`${input.assemblyId}-`) && name.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b));
    const candidates = await Promise.all(
      candidateNames.map(async (name) => {
        const path = joinPath(dir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = (await (deps.statCacheFile ?? defaultStatCacheFile)(path)).mtimeMs;
        } catch {}
        return { name, path, mtimeMs };
      })
    );
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    const readFn = deps.readFileImpl ?? defaultRead;
    for (const candidate of candidates) {
      let manifest: AssemblyTextureManifest;
      try {
        manifest = JSON.parse((await readFn(candidate.path)).toString('utf-8'));
      } catch {
        continue;
      }
      if (
        manifest.assemblyId !== input.assemblyId ||
        manifest.version !== ASSEMBLY_TEXTURE_CACHE_VERSION ||
        manifest.cacheContractToken !== context.contractToken ||
        typeof manifest.sourceBuildFingerprint !== 'string' ||
        manifest.sourceBuildFingerprint.trim().length === 0 ||
        manifest.placementSignature !== context.placement.signature ||
        !layoutIsValidForPlacement(manifest, context.placement.totalLength)
      ) {
        continue;
      }
      const candidateFingerprint = await computeAssemblyTextureFingerprint(input.chromosomes, {
        ...deps,
        workspaceRoot: input.workspaceRoot,
        sourceBuildFingerprint: manifest.sourceBuildFingerprint,
      });
      if (!candidateFingerprint || candidateFingerprint !== manifest.fingerprint) continue;
      const hit = await readAssemblyOverviewTextureCacheEntry(
        {
          assemblyId: input.assemblyId,
          workspaceRoot: input.workspaceRoot,
          fingerprint: manifest.fingerprint,
          contractToken: context.contractToken,
          sourceBuildFingerprint: manifest.sourceBuildFingerprint,
          placement: context.placement,
        },
        deps
      );
      if (hit) return hit;
    }
  } catch {
    return null;
  }
  return null;
}

async function readAssemblyOverviewTextureCacheEntry(
  input: {
    assemblyId: string;
    workspaceRoot: string;
    fingerprint: string;
    contractToken: string;
    sourceBuildFingerprint: string;
    placement: { signature: string; totalLength: number };
  },
  deps: Pick<AssemblyTextureCacheDeps, 'readFileImpl'>
): Promise<AssemblyTextureReadResult | null> {
  try {
    const readFn = deps.readFileImpl ?? defaultRead;
    const manifestRaw = await readFn(
      textureManifestPath(input.workspaceRoot, input.assemblyId, input.fingerprint)
    );
    const manifest = JSON.parse(manifestRaw.toString('utf-8')) as AssemblyTextureManifest;
    if (
      manifest.assemblyId !== input.assemblyId ||
      manifest.fingerprint !== input.fingerprint ||
      manifest.version !== ASSEMBLY_TEXTURE_CACHE_VERSION ||
      manifest.cacheContractToken !== input.contractToken ||
      manifest.sourceBuildFingerprint !== input.sourceBuildFingerprint ||
      manifest.placementSignature !== input.placement.signature ||
      manifest.textureFile !== `${input.assemblyId}-${input.fingerprint}.png` ||
      !layoutIsValidForPlacement(manifest, input.placement.totalLength)
    ) {
      return null;
    }
    const png = await readFn(
      texturePngPath(input.workspaceRoot, input.assemblyId, input.fingerprint)
    );
    if (!png || png.length === 0) return null;
    if (!pngMatchesLayout(png, manifest)) return null;
    return { pngBase64: png.toString('base64'), manifest };
  } catch {
    return null;
  }
}

interface AssemblyAnnotationRasterDiskManifestV2 extends AssemblyTextureLayout {
  version: 2;
  assemblyId: string;
  fingerprint: string;
  cacheContractToken: string;
  sourceBuildFingerprint: string;
  placementSignature: string;
  rasterVariantKey: string;
  rasterVariant: AssemblyAnnotationRasterVariantV2;
  textureFile: string;
  annotationTrackBaseOffsetPx: 0;
  laneProjection?: PrebuiltAnnotationRasterLaneProjectionV1;
  projectionContract?: typeof ASSEMBLY_ANNOTATION_RASTER_PROJECTION_ARTIFACT_V1;
  projectionArtifactKey?: string;
  sourceArtifact?: AssemblyAnnotationRasterLaneCompleteSourceV1;
  textureSha256?: string;
  textureByteLength?: number;
}

export function assemblyAnnotationRasterFileNamesV2(input: {
  assemblyId: string;
  fingerprint: string;
  rasterVariantKey: string;
  laneProjection: PrebuiltAnnotationRasterLaneProjectionV1 | null;
}): { manifestFile: string; textureFile: string } | null {
  if (
    !safeCacheIdentityPart(input.assemblyId) ||
    !/^[0-9a-f]{24}$/.test(input.fingerprint) ||
    typeof input.rasterVariantKey !== 'string' ||
    input.rasterVariantKey.length === 0 ||
    (input.laneProjection !== null &&
      !isPrebuiltAnnotationRasterLaneProjectionV1(input.laneProjection))
  ) {
    return null;
  }
  const variantDigest = createHash('sha256')
    .update(input.rasterVariantKey)
    .digest('hex')
    .slice(0, 20);
  const projectionSuffix =
    input.laneProjection === null
      ? ''
      : `-${createHash('sha256')
          .update(
            framedCacheKey([
              input.laneProjection.contract,
              String(input.laneProjection.laneLimit),
              String(input.laneProjection.sourceHeightPx),
              String(input.laneProjection.sourceSpineOffsetPx),
              String(input.laneProjection.sourceMaxAnnotationLane),
              String(input.laneProjection.presentedHeightPx),
              String(input.laneProjection.presentedSpineOffsetPx),
            ])
          )
          .digest('hex')
          .slice(0, 20)}`;
  const stem = `${input.assemblyId}-${input.fingerprint}-${variantDigest}${projectionSuffix}.annotation-raster.v2`;
  return { manifestFile: `${stem}.json`, textureFile: `${stem}.png` };
}

export async function computeAssemblyAnnotationRasterCacheFingerprintV2(
  chromosomes: readonly AssemblyOverviewChromInput[],
  identity: {
    workspaceRoot: string;
    cacheContractToken: string;
    sourceBuildFingerprint: string;
  },
  deps: AssemblyTextureCacheDeps
): Promise<string | null> {
  if (
    !identity.workspaceRoot ||
    !identity.cacheContractToken ||
    !/^[0-9a-f]{64}$/.test(identity.sourceBuildFingerprint) ||
    !assemblyRasterChromosomesAreWellFormed(chromosomes)
  ) {
    return null;
  }
  const placement = assemblyTexturePlacement(chromosomes);
  if (!placement) return null;
  const statFn = deps.statSource ?? defaultStat;
  const signatures: string[] = [];
  let startBp = 0;
  let annotationSourceCount = 0;
  for (let index = 0; index < chromosomes.length; index += 1) {
    const chromosome = chromosomes[index];
    try {
      const endBp = startBp + chromosome.length;
      const sourcePath = chromosome.sourcePath?.trim() ?? '';
      if (!sourcePath) {
        startBp = endBp;
        continue;
      }
      annotationSourceCount += 1;
      await deps.assertSafePath(sourcePath);
      const sourceStat = await statFn(sourcePath);
      signatures.push(
        [
          index,
          chromosome.chrom,
          startBp,
          endBp,
          chromosome.length,
          normalizedFingerprintPath(sourcePath, identity.workspaceRoot),
          sourceStat.size,
          sourceStat.mtimeMs,
          sourceStat.ctimeMs ?? 'na',
        ].join('|')
      );
      startBp = endBp;
    } catch {
      return null;
    }
  }
  if (annotationSourceCount === 0) return null;
  return createHash('sha256')
    .update(
      [
        `v${ASSEMBLY_ANNOTATION_RASTER_MANIFEST_V2}`,
        `contract:${identity.cacheContractToken}`,
        `build:${identity.sourceBuildFingerprint}`,
        placement.signature,
        signatures.join('\n'),
      ].join('\n')
    )
    .digest('hex')
    .slice(0, 24);
}

export async function readAssemblyAnnotationRasterCacheV2(
  input: AssemblyAnnotationRasterReadRequestV2,
  deps: AssemblyTextureCacheDeps
): Promise<AssemblyAnnotationRasterReadResultV2 | null> {
  try {
    if (!assemblyAnnotationRasterRequestIsWellFormed(input)) return null;
    const placement = assemblyTexturePlacement(input.chromosomes);
    if (!placement) return null;
    const scope = assemblyAnnotationSceneScopeForRequest('complete-assembly', input.chromosomes);
    const placementFingerprint = `ap1:${createHash('sha256')
      .update(placement.signature)
      .digest('hex')
      .slice(0, 24)}`;
    const expectedContractToken = cacheContractToken(deps);
    const dir = textureCacheDir(input.workspaceRoot);
    const readFn = deps.readFileImpl ?? defaultRead;
    const names = await (deps.readdirImpl ?? defaultReaddir)(dir);
    const candidates = await annotationRasterSourceCandidates(names, dir, input.assemblyId, deps);

    for (const candidate of candidates) {
      let diskValue: unknown;
      try {
        diskValue = JSON.parse((await readFn(candidate.path)).toString('utf-8'));
      } catch {
        continue;
      }
      const sourceManifest = await validateAnnotationRasterSourceManifestV2(
        diskValue,
        candidate.name,
        input,
        placement,
        expectedContractToken,
        deps
      );
      if (!sourceManifest) continue;

      const sourceFingerprint = await computeAssemblyAnnotationSceneSourceFingerprint(
        {
          chromosomes: input.chromosomes,
          workspaceRoot: input.workspaceRoot,
          scope,
          datasetContract: input.datasetContract,
        },
        deps
      );
      if (!sourceFingerprint) return null;
      const sourceProjection = assemblyAnnotationRasterLaneProjectionV1({
        laneLimit: null,
        sourceHeightPx: sourceManifest.heightPx,
        sourceSpineOffsetPx: sourceManifest.spineOffsetPx,
        sourceMaxAnnotationLane: sourceManifest.maxAnnotationLane,
      });
      if (!isPrebuiltAnnotationRasterLaneProjectionV1(sourceProjection)) return null;

      let presentedManifest = sourceManifest;
      let laneProjection = sourceProjection;
      let png: Buffer;
      if (input.laneLimit !== null) {
        laneProjection = assemblyAnnotationRasterLaneProjectionV1({
          laneLimit: input.laneLimit,
          sourceHeightPx: sourceManifest.heightPx,
          sourceSpineOffsetPx: sourceManifest.spineOffsetPx,
          sourceMaxAnnotationLane: sourceManifest.maxAnnotationLane,
        });
        if (!isPrebuiltAnnotationRasterLaneProjectionV1(laneProjection)) return null;
        const derivedNames = assemblyAnnotationRasterFileNamesV2({
          assemblyId: input.assemblyId,
          fingerprint: sourceManifest.fingerprint,
          rasterVariantKey: sourceManifest.rasterVariantKey,
          laneProjection,
        });
        if (!derivedNames) return null;
        let derivedValue: unknown;
        let sourcePng: Buffer;
        let derivedPng: Buffer;
        try {
          derivedValue = JSON.parse(
            (await readFn(joinPath(dir, derivedNames.manifestFile))).toString('utf-8')
          );
          [sourcePng, derivedPng] = await Promise.all([
            readFn(joinPath(dir, sourceManifest.textureFile)),
            readFn(joinPath(dir, derivedNames.textureFile)),
          ]);
        } catch {
          continue;
        }
        const derived = validateAnnotationRasterDerivedManifestV2(
          derivedValue,
          candidate.name,
          derivedNames,
          sourceManifest,
          sourcePng,
          derivedPng,
          laneProjection
        );
        if (!derived) continue;
        presentedManifest = derived;
        png = derivedPng;
      } else {
        const sourceNames = assemblyAnnotationRasterFileNamesV2({
          assemblyId: input.assemblyId,
          fingerprint: sourceManifest.fingerprint,
          rasterVariantKey: sourceManifest.rasterVariantKey,
          laneProjection: null,
        });
        if (!sourceNames || sourceManifest.textureFile !== sourceNames.textureFile) continue;
        png = await readFn(joinPath(dir, sourceNames.textureFile));
        if (!pngMatchesLayout(png, sourceManifest)) continue;
      }

      const finalSourceFingerprint = await computeAssemblyAnnotationSceneSourceFingerprint(
        {
          chromosomes: input.chromosomes,
          workspaceRoot: input.workspaceRoot,
          scope,
          datasetContract: input.datasetContract,
        },
        deps
      );
      const finalCacheFingerprint = await computeAssemblyAnnotationRasterCacheFingerprintV2(
        input.chromosomes,
        {
          workspaceRoot: input.workspaceRoot,
          cacheContractToken: sourceManifest.cacheContractToken,
          sourceBuildFingerprint: sourceManifest.sourceBuildFingerprint,
        },
        deps
      );
      if (
        finalSourceFingerprint !== sourceFingerprint ||
        finalCacheFingerprint !== sourceManifest.fingerprint
      ) {
        continue;
      }

      const semanticReceipt = assemblyAnnotationRasterSemanticReceiptV1({
        genomeIdentity: input.genomeIdentity,
        genomeLengthBp: placement.totalLength,
        sourceFingerprint,
        placementFingerprint,
        rasterVariant: sourceManifest.rasterVariant,
        layerTypes: sourceManifest.layerTypes,
        maxAnnotationLane: sourceManifest.maxAnnotationLane,
        maxCdsLane: sourceManifest.maxCdsLane,
      });
      if (!isPrebuiltAnnotationRasterPresentationReceiptV1(semanticReceipt)) return null;
      const manifest: AssemblyAnnotationRasterManifestV2 = {
        ...presentedManifest,
        sourceFingerprint,
        placementFingerprint,
        semanticReceipt,
        laneProjection,
      };
      return { pngBase64: png.toString('base64'), manifest };
    }
  } catch {
    return null;
  }
  return null;
}

async function annotationRasterSourceCandidates(
  names: readonly string[],
  dir: string,
  assemblyId: string,
  deps: AssemblyTextureCacheDeps
): Promise<Array<{ name: string; path: string; mtimeMs: number }>> {
  const candidates = await Promise.all(
    names
      .filter(
        (name) => name.startsWith(`${assemblyId}-`) && name.endsWith('.annotation-raster.v2.json')
      )
      .map(async (name) => {
        const path = joinPath(dir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = (await (deps.statCacheFile ?? defaultStatCacheFile)(path)).mtimeMs;
        } catch {}
        return { name, path, mtimeMs };
      })
  );
  return candidates.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name)
  );
}

async function validateAnnotationRasterSourceManifestV2(
  value: unknown,
  manifestFile: string,
  request: AssemblyAnnotationRasterReadRequestV2,
  placement: { signature: string; totalLength: number },
  expectedContractToken: string,
  deps: AssemblyTextureCacheDeps
): Promise<AssemblyAnnotationRasterDiskManifestV2 | null> {
  if (!isExactObjectWithFields(value, ANNOTATION_RASTER_SOURCE_MANIFEST_FIELDS_V2)) return null;
  const manifest = value as unknown as AssemblyAnnotationRasterDiskManifestV2;
  if (
    manifest.version !== ASSEMBLY_ANNOTATION_RASTER_MANIFEST_V2 ||
    manifest.assemblyId !== request.assemblyId ||
    !/^[0-9a-f]{24}$/.test(manifest.fingerprint) ||
    manifest.cacheContractToken !== expectedContractToken ||
    !/^[0-9a-f]{64}$/.test(manifest.sourceBuildFingerprint) ||
    manifest.placementSignature !== placement.signature ||
    !isAssemblyAnnotationRasterVariantV2(manifest.rasterVariant) ||
    manifest.rasterVariant.trackType !== request.trackType ||
    manifest.rasterVariant.isoformMode !== request.isoformMode ||
    manifest.rasterVariant.themeMode !== request.themeMode ||
    assemblyAnnotationRasterVariantKeyV2(manifest.rasterVariant) !== manifest.rasterVariantKey ||
    !annotationRasterSourceLayoutIsValid(manifest, placement.totalLength)
  ) {
    return null;
  }
  const expectedNames = assemblyAnnotationRasterFileNamesV2({
    assemblyId: request.assemblyId,
    fingerprint: manifest.fingerprint,
    rasterVariantKey: manifest.rasterVariantKey,
    laneProjection: null,
  });
  if (
    !expectedNames ||
    manifestFile !== expectedNames.manifestFile ||
    manifest.textureFile !== expectedNames.textureFile
  ) {
    return null;
  }
  const fingerprint = await computeAssemblyAnnotationRasterCacheFingerprintV2(
    request.chromosomes,
    {
      workspaceRoot: request.workspaceRoot,
      cacheContractToken: manifest.cacheContractToken,
      sourceBuildFingerprint: manifest.sourceBuildFingerprint,
    },
    deps
  );
  return fingerprint === manifest.fingerprint ? manifest : null;
}

function validateAnnotationRasterDerivedManifestV2(
  value: unknown,
  sourceManifestFile: string,
  expectedNames: { manifestFile: string; textureFile: string },
  source: AssemblyAnnotationRasterDiskManifestV2,
  sourcePng: Buffer,
  derivedPng: Buffer,
  projection: PrebuiltAnnotationRasterLaneProjectionV1
): AssemblyAnnotationRasterDiskManifestV2 | null {
  return validateAssemblyAnnotationRasterProjectionArtifactV2({
    sourceManifestFile,
    sourceManifest: source,
    sourceTextureBytes: sourcePng,
    projectionManifestFile: expectedNames.manifestFile,
    projectionManifest: value,
    projectionTextureBytes: derivedPng,
    expectedLaneProjection: projection,
  })
    ? (value as AssemblyAnnotationRasterDiskManifestV2)
    : null;
}

type AnnotationRasterFileNamesV2 = {
  manifestFile: string;
  textureFile: string;
};

function isValidAnnotationRasterSourceIdentity(
  source: AssemblyAnnotationRasterDiskManifestV2,
  projectionLane: unknown,
  expectedLaneProjection?: PrebuiltAnnotationRasterLaneProjectionV1
): projectionLane is PrebuiltAnnotationRasterLaneProjectionV1 {
  return (
    source.version === ASSEMBLY_ANNOTATION_RASTER_MANIFEST_V2 &&
    Boolean(safeCacheIdentityPart(source.assemblyId)) &&
    /^[0-9a-f]{24}$/.test(source.fingerprint) &&
    typeof source.cacheContractToken === 'string' &&
    source.cacheContractToken.length > 0 &&
    /^[0-9a-f]{64}$/.test(source.sourceBuildFingerprint) &&
    typeof source.placementSignature === 'string' &&
    source.placementSignature.length > 0 &&
    isAssemblyAnnotationRasterVariantV2(source.rasterVariant) &&
    assemblyAnnotationRasterVariantKeyV2(source.rasterVariant) === source.rasterVariantKey &&
    annotationRasterSourceLayoutIsValid(source, source.genomeLength) &&
    isPrebuiltAnnotationRasterLaneProjectionV1(projectionLane) &&
    (expectedLaneProjection === undefined ||
      sameLaneProjection(projectionLane, expectedLaneProjection))
  );
}

function isValidAnnotationRasterProjectionManifestMatch(args: {
  source: AssemblyAnnotationRasterDiskManifestV2;
  manifest: AssemblyAnnotationRasterDiskManifestV2;
  projection: PrebuiltAnnotationRasterLaneProjectionV1;
  sourceNames: AnnotationRasterFileNamesV2;
  projectionNames: AnnotationRasterFileNamesV2;
  sourceManifestFile: string;
  projectionManifestFile: string;
}): boolean {
  const { source, manifest, projection, sourceNames, projectionNames } = args;
  return (
    args.sourceManifestFile === sourceNames.manifestFile &&
    source.textureFile === sourceNames.textureFile &&
    args.projectionManifestFile === projectionNames.manifestFile &&
    manifest.textureFile === projectionNames.textureFile &&
    manifest.version === source.version &&
    manifest.assemblyId === source.assemblyId &&
    manifest.fingerprint === source.fingerprint &&
    manifest.cacheContractToken === source.cacheContractToken &&
    manifest.sourceBuildFingerprint === source.sourceBuildFingerprint &&
    manifest.placementSignature === source.placementSignature &&
    manifest.rasterVariantKey === source.rasterVariantKey &&
    canonicalJsonV1(manifest.rasterVariant) === canonicalJsonV1(source.rasterVariant) &&
    manifest.widthPx === source.widthPx &&
    manifest.heightPx === projection.presentedHeightPx &&
    manifest.resolution === source.resolution &&
    manifest.spineOffsetPx === projection.presentedSpineOffsetPx &&
    manifest.annotationTrackBaseOffsetPx === source.annotationTrackBaseOffsetPx &&
    manifest.genomeLength === source.genomeLength &&
    manifest.maxAnnotationLane === source.maxAnnotationLane &&
    manifest.maxCdsLane === source.maxCdsLane &&
    sameExactStringArray(manifest.layerTypes, source.layerTypes) &&
    manifest.projectionContract === ASSEMBLY_ANNOTATION_RASTER_PROJECTION_ARTIFACT_V1 &&
    /^[0-9a-f]{64}$/.test(manifest.projectionArtifactKey ?? '') &&
    isExactObjectWithFields(
      manifest.sourceArtifact,
      ANNOTATION_RASTER_LANE_COMPLETE_SOURCE_FIELDS_V1
    ) &&
    /^[0-9a-f]{64}$/.test(manifest.textureSha256 ?? '') &&
    Number.isSafeInteger(manifest.textureByteLength) &&
    (manifest.textureByteLength as number) > 0
  );
}

function isValidAnnotationRasterProjectionHashes(args: {
  source: AssemblyAnnotationRasterDiskManifestV2;
  manifest: AssemblyAnnotationRasterDiskManifestV2;
  sourceArtifact: AssemblyAnnotationRasterLaneCompleteSourceV1;
  sourceNames: AnnotationRasterFileNamesV2;
  sourceTextureBytes: Buffer;
  projectionTextureBytes: Buffer;
}): boolean {
  const sourceTextureSha256 = sha256Hex(args.sourceTextureBytes);
  const projectionTextureSha256 = sha256Hex(args.projectionTextureBytes);
  const { source, manifest, sourceArtifact, sourceNames } = args;
  return (
    sourceArtifact.contract === ASSEMBLY_ANNOTATION_RASTER_LANE_COMPLETE_SOURCE_V1 &&
    sourceArtifact.manifestFile === sourceNames.manifestFile &&
    sourceArtifact.manifestSha256 === sha256Hex(canonicalJsonV1(source)) &&
    sourceArtifact.textureFile === sourceNames.textureFile &&
    sourceArtifact.textureSha256 === sourceTextureSha256 &&
    sourceArtifact.textureByteLength === args.sourceTextureBytes.byteLength &&
    sourceArtifact.fingerprint === source.fingerprint &&
    sourceArtifact.sourceBuildFingerprint === source.sourceBuildFingerprint &&
    sourceArtifact.placementSignatureSha256 === sha256Hex(source.placementSignature) &&
    sourceArtifact.rasterVariantKey === source.rasterVariantKey &&
    manifest.textureSha256 === projectionTextureSha256 &&
    manifest.textureByteLength === args.projectionTextureBytes.byteLength &&
    pngMatchesLayout(args.sourceTextureBytes, source) &&
    pngMatchesLayout(args.projectionTextureBytes, manifest)
  );
}

export function validateAssemblyAnnotationRasterProjectionArtifactV2(input: {
  sourceManifestFile: string;
  sourceManifest: unknown;
  sourceTextureBytes: Buffer;
  projectionManifestFile: string;
  projectionManifest: unknown;
  projectionTextureBytes: Buffer;
  expectedLaneProjection?: PrebuiltAnnotationRasterLaneProjectionV1;
}): boolean {
  const sourceValue = input.sourceManifest;
  const projectionValue = input.projectionManifest;
  if (
    !isExactObjectWithFields(sourceValue, ANNOTATION_RASTER_SOURCE_MANIFEST_FIELDS_V2) ||
    !isExactObjectWithFields(projectionValue, ANNOTATION_RASTER_DERIVED_MANIFEST_FIELDS_V2)
  ) {
    return false;
  }
  const source = sourceValue as unknown as AssemblyAnnotationRasterDiskManifestV2;
  const manifest = projectionValue as unknown as AssemblyAnnotationRasterDiskManifestV2;
  const projectionLane = manifest.laneProjection;
  if (
    !isValidAnnotationRasterSourceIdentity(source, projectionLane, input.expectedLaneProjection)
  ) {
    return false;
  }
  const sourceNames = assemblyAnnotationRasterFileNamesV2({
    assemblyId: source.assemblyId,
    fingerprint: source.fingerprint,
    rasterVariantKey: source.rasterVariantKey,
    laneProjection: null,
  });
  const projectionNames = assemblyAnnotationRasterFileNamesV2({
    assemblyId: source.assemblyId,
    fingerprint: source.fingerprint,
    rasterVariantKey: source.rasterVariantKey,
    laneProjection: projectionLane,
  });
  if (
    !sourceNames ||
    !projectionNames ||
    !isValidAnnotationRasterProjectionManifestMatch({
      source,
      manifest,
      projection: projectionLane,
      sourceNames,
      projectionNames,
      sourceManifestFile: input.sourceManifestFile,
      projectionManifestFile: input.projectionManifestFile,
    })
  ) {
    return false;
  }
  const sourceArtifact = manifest.sourceArtifact as AssemblyAnnotationRasterLaneCompleteSourceV1;
  if (
    !isValidAnnotationRasterProjectionHashes({
      source,
      manifest,
      sourceArtifact,
      sourceNames,
      sourceTextureBytes: input.sourceTextureBytes,
      projectionTextureBytes: input.projectionTextureBytes,
    })
  ) {
    return false;
  }
  const projectionIdentity = {
    contract: ASSEMBLY_ANNOTATION_RASTER_PROJECTION_ARTIFACT_V1,
    sourceArtifact,
    laneProjection: projectionLane,
    widthPx: manifest.widthPx,
    heightPx: manifest.heightPx,
    resolution: manifest.resolution,
    spineOffsetPx: manifest.spineOffsetPx,
    textureSha256: manifest.textureSha256,
    textureByteLength: manifest.textureByteLength,
  };
  return manifest.projectionArtifactKey === sha256Hex(canonicalJsonV1(projectionIdentity));
}

function annotationRasterSourceLayoutIsValid(
  manifest: AssemblyAnnotationRasterDiskManifestV2,
  placementTotalLength: number
): boolean {
  return (
    Number.isSafeInteger(manifest.widthPx) &&
    manifest.widthPx > 0 &&
    Number.isSafeInteger(manifest.heightPx) &&
    manifest.heightPx > 0 &&
    Number.isSafeInteger(manifest.resolution) &&
    manifest.resolution > 0 &&
    Number.isSafeInteger(manifest.maxAnnotationLane) &&
    manifest.maxAnnotationLane >= 0 &&
    manifest.heightPx === (manifest.maxAnnotationLane + 1) * 16 &&
    manifest.spineOffsetPx === manifest.heightPx - 1 &&
    manifest.annotationTrackBaseOffsetPx === 0 &&
    manifest.genomeLength === placementTotalLength &&
    manifest.maxCdsLane === -1 &&
    sameExactStringArray(manifest.layerTypes, ['mRNA'])
  );
}

function assemblyAnnotationRasterRequestIsWellFormed(
  input: AssemblyAnnotationRasterReadRequestV2 | null | undefined
): input is AssemblyAnnotationRasterReadRequestV2 {
  return Boolean(
    input &&
    safeCacheIdentityPart(input.assemblyId) &&
    typeof input.workspaceRoot === 'string' &&
    input.workspaceRoot.trim().length > 0 &&
    input.trackType === 'mRNA' &&
    datasetContractsAreWellFormed(input.datasetContract) &&
    input.genomeIdentity ===
      `assembly-annotation-source-sha256.v1:${input.datasetContract.sourceSha256}` &&
    (input.isoformMode === 'canonical' || input.isoformMode === 'expanded') &&
    (input.themeMode === 'light' || input.themeMode === 'dark') &&
    (input.laneLimit === null ||
      (Number.isSafeInteger(input.laneLimit) && (input.laneLimit as number) > 0)) &&
    assemblyRasterChromosomesAreWellFormed(input.chromosomes)
  );
}

function assemblyRasterChromosomesAreWellFormed(
  chromosomes: readonly AssemblyOverviewChromInput[]
): boolean {
  if (!Array.isArray(chromosomes) || chromosomes.length === 0) return false;
  const names = new Set<string>();
  let total = 0;
  for (const chromosome of chromosomes) {
    if (
      typeof chromosome?.chrom !== 'string' ||
      chromosome.chrom.trim().length === 0 ||
      chromosome.chrom !== chromosome.chrom.trim() ||
      names.has(chromosome.chrom) ||
      !Number.isSafeInteger(chromosome.length) ||
      chromosome.length <= 0
    ) {
      return false;
    }
    names.add(chromosome.chrom);
    total += chromosome.length;
    if (!Number.isSafeInteger(total)) return false;
  }
  return true;
}

function sameLaneProjection(
  left: unknown,
  right: PrebuiltAnnotationRasterLaneProjectionV1
): boolean {
  return (
    isPrebuiltAnnotationRasterLaneProjectionV1(left) &&
    left.contract === right.contract &&
    left.laneLimit === right.laneLimit &&
    left.sourceHeightPx === right.sourceHeightPx &&
    left.sourceSpineOffsetPx === right.sourceSpineOffsetPx &&
    left.sourceMaxAnnotationLane === right.sourceMaxAnnotationLane &&
    left.presentedHeightPx === right.presentedHeightPx &&
    left.presentedSpineOffsetPx === right.presentedSpineOffsetPx
  );
}

function sameExactStringArray(left: unknown, right: readonly string[]): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function safeCacheIdentityPart(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value);
}

function framedCacheKey(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}

function canonicalJsonV1(value: unknown): string {
  return JSON.stringify(canonicalizeJsonV1(value));
}

function canonicalizeJsonV1(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJsonV1);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonicalizeJsonV1(record[key])])
  );
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isExactObjectWithFields(value: unknown, fields: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(record, field))
  );
}

const ANNOTATION_RASTER_SOURCE_MANIFEST_FIELDS_V2 = [
  'version',
  'assemblyId',
  'fingerprint',
  'cacheContractToken',
  'sourceBuildFingerprint',
  'placementSignature',
  'rasterVariantKey',
  'rasterVariant',
  'textureFile',
  'widthPx',
  'heightPx',
  'resolution',
  'spineOffsetPx',
  'annotationTrackBaseOffsetPx',
  'genomeLength',
  'maxAnnotationLane',
  'maxCdsLane',
  'layerTypes',
] as const;

const ANNOTATION_RASTER_DERIVED_MANIFEST_FIELDS_V2 = [
  ...ANNOTATION_RASTER_SOURCE_MANIFEST_FIELDS_V2,
  'projectionContract',
  'projectionArtifactKey',
  'sourceArtifact',
  'laneProjection',
  'textureSha256',
  'textureByteLength',
] as const;

const ANNOTATION_RASTER_LANE_COMPLETE_SOURCE_FIELDS_V1 = [
  'contract',
  'manifestFile',
  'manifestSha256',
  'textureFile',
  'textureSha256',
  'textureByteLength',
  'fingerprint',
  'sourceBuildFingerprint',
  'placementSignatureSha256',
  'rasterVariantKey',
] as const;

export async function writeAssemblyOverviewTextureCache(
  input: {
    assemblyId: string;
    chromosomes: readonly AssemblyOverviewChromInput[];
    workspaceRoot: string;
    pngBase64: string;
    layout: AssemblyTextureLayout;
  },
  deps: AssemblyTextureCacheDeps
): Promise<{ fingerprint: string; pngPath: string; manifestPath: string } | null> {
  try {
    if (!input?.assemblyId || !input?.workspaceRoot || !input?.pngBase64) return null;
    const fingerprint = await computeAssemblyTextureFingerprint(input.chromosomes, {
      ...deps,
      workspaceRoot: input.workspaceRoot,
    });
    if (!fingerprint) return null;
    const contractToken = cacheContractToken(deps);
    const buildFingerprint = sourceBuildFingerprint(deps);
    const placement = assemblyTexturePlacement(input.chromosomes);
    if (!placement) return null;
    const png = Buffer.from(input.pngBase64, 'base64');
    if (!layoutIsValidForPlacement(input.layout, placement.totalLength)) return null;
    if (!pngMatchesLayout(png, input.layout)) return null;
    const dir = textureCacheDir(input.workspaceRoot);
    await (deps.mkdirImpl ?? defaultMkdir)(dir);
    const pngPath = texturePngPath(input.workspaceRoot, input.assemblyId, fingerprint);
    const manifestPath = textureManifestPath(input.workspaceRoot, input.assemblyId, fingerprint);
    const writeFn = deps.writeFileImpl ?? defaultWrite;
    const manifest: AssemblyTextureManifest = {
      version: ASSEMBLY_TEXTURE_CACHE_VERSION,
      assemblyId: input.assemblyId,
      fingerprint,
      cacheContractToken: contractToken,
      sourceBuildFingerprint: buildFingerprint,
      placementSignature: placement.signature,
      textureFile: `${input.assemblyId}-${fingerprint}.png`,
      widthPx: input.layout.widthPx,
      heightPx: input.layout.heightPx,
      resolution: input.layout.resolution,
      spineOffsetPx: input.layout.spineOffsetPx,
      genomeLength: input.layout.genomeLength,
      maxAnnotationLane: Math.trunc(input.layout.maxAnnotationLane),
      maxCdsLane: Math.trunc(input.layout.maxCdsLane),
      layerTypes: normalizedLayerTypes(input.layout.layerTypes),
    };
    await writeFn(pngPath, png);
    await writeFn(manifestPath, JSON.stringify(manifest, null, 2));
    return { fingerprint, pngPath, manifestPath };
  } catch {
    return null;
  }
}

export async function readAssemblyAnnotationSceneCacheIndex(
  input: AssemblyAnnotationSceneReadRequest,
  deps: AssemblyTextureCacheDeps
): Promise<AssemblyAnnotationSceneCacheIndexReadResult | null> {
  if (
    input?.ipcContractVersion !== ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT ||
    !input?.assemblyId ||
    !input?.workspaceRoot ||
    !runtimePolicyIsWellFormed(input.requestedPolicy)
  ) {
    return null;
  }
  const placement = assemblyTexturePlacement(input.chromosomes);
  if (!placement) return null;
  const placementFingerprint = `ap1:${createHash('sha256')
    .update(placement.signature)
    .digest('hex')
    .slice(0, 24)}`;
  const compilerContractFingerprint = annotationSceneCompilerContractFingerprint(
    input.datasetContract,
    input.artifact,
    input.scope
  );
  if (!compilerContractFingerprint) return null;
  const companionKey = annotationSceneCompanionKey(
    input.datasetContract,
    input.artifact,
    input.scope
  );
  if (!companionKey) return null;
  const readFn = deps.readFileImpl ?? defaultRead;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fingerprint = await computeAssemblyAnnotationSceneSourceFingerprint(input, deps);
    if (!fingerprint) return null;
    const miss: AssemblyAnnotationSceneMissResult = {
      status: 'miss',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint,
      sourceBuildFingerprint: compilerContractFingerprint,
    };
    try {
      const diskManifest = JSON.parse(
        (
          await readFn(
            annotationSceneManifestPath(
              input.workspaceRoot,
              input.assemblyId,
              fingerprint,
              companionKey
            )
          )
        ).toString('utf-8')
      ) as AssemblyAnnotationSceneDiskManifestV6;
      const payloadSha256 = diskManifest.sceneManifest?.integrity?.payloadSha256;
      const expectedSceneFile =
        typeof payloadSha256 === 'string' && /^[0-9a-f]{64}$/.test(payloadSha256)
          ? `${input.assemblyId}-${fingerprint}-${companionKey}-${payloadSha256}.annotation-scene.v6.bin`
          : null;
      if (
        diskManifest.version !== ASSEMBLY_ANNOTATION_SCENE_CACHE_VERSION ||
        diskManifest.assemblyId !== input.assemblyId ||
        diskManifest.fingerprint !== fingerprint ||
        diskManifest.companionKey !== companionKey ||
        diskManifest.compilerContractFingerprint !== compilerContractFingerprint ||
        diskManifest.placementSignature !== placement.signature ||
        expectedSceneFile === null ||
        diskManifest.sceneFile !== expectedSceneFile ||
        !sceneArtifactsEqual(diskManifest.artifact, input.artifact) ||
        !Number.isSafeInteger(diskManifest.byteCount) ||
        diskManifest.byteCount < 0 ||
        diskManifest.sceneManifest?.byteLength !== diskManifest.byteCount ||
        !scopeContractsEqual(diskManifest.scope, input.scope) ||
        !datasetContractsEqual(
          diskManifest.sceneManifest?.datasetContract,
          input.datasetContract
        ) ||
        diskManifest.sceneManifest?.assemblyContract?.assemblyId !== input.assemblyId ||
        diskManifest.sceneManifest?.assemblyContract?.assemblyLengthBp !== placement.totalLength ||
        diskManifest.sceneManifest?.partitionSpanBp !== input.artifact.partitionSpanBp
      ) {
        if (
          await annotationSceneRevisionMatches(
            input,
            deps,
            fingerprint,
            compilerContractFingerprint
          )
        ) {
          return miss;
        }
        continue;
      }
      if (diskManifest.detailRangeCatalog) {
        assertPartitionedTranscriptSceneRangeCatalogV1(
          diskManifest.detailRangeCatalog,
          diskManifest.sceneManifest
        );
      }

      const scenePath = annotationScenePath(
        input.workspaceRoot,
        input.assemblyId,
        fingerprint,
        companionKey,
        payloadSha256
      );
      const sceneStat = await (deps.statCacheFile ?? defaultStatCacheFile)(scenePath);
      if (!Number.isSafeInteger(sceneStat.size) || sceneStat.size !== diskManifest.byteCount) {
        if (
          await annotationSceneRevisionMatches(
            input,
            deps,
            fingerprint,
            compilerContractFingerprint
          )
        ) {
          return miss;
        }
        continue;
      }
      const finalRevisionMatches = await annotationSceneRevisionMatches(
        input,
        deps,
        fingerprint,
        compilerContractFingerprint
      );
      if (!finalRevisionMatches) {
        continue;
      }
      const compiledBroadInteraction = await readCompiledBroadInteractionIndex({
        descriptor: diskManifest.compiledBroadInteraction,
        sceneManifest: diskManifest.sceneManifest,
        workspaceRoot: input.workspaceRoot,
        assemblyId: input.assemblyId,
        fingerprint,
        companionKey,
        deps,
      });
      const roleSidecar = await readAnnotationRoleSidecarIndex({
        descriptor: diskManifest.roleSidecar,
        sceneManifest: diskManifest.sceneManifest,
        workspaceRoot: input.workspaceRoot,
        identity: { assemblyId: input.assemblyId, fingerprint, companionKey },
        deps,
      });
      return {
        status: 'hit',
        ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
        fingerprint,
        sourceBuildFingerprint: compilerContractFingerprint,
        scope: diskManifest.scope,
        artifact: diskManifest.artifact,
        byteCount: diskManifest.byteCount,
        manifest: diskManifest.sceneManifest,
        scenePath,
        payloadSha256,
        placementFingerprint,
        ...(diskManifest.detailRangeCatalog
          ? { detailRangeCatalog: diskManifest.detailRangeCatalog }
          : {}),
        ...(compiledBroadInteraction ? { compiledBroadInteraction } : {}),
        ...(roleSidecar ? { roleSidecar } : {}),
      };
    } catch {
      if (
        await annotationSceneRevisionMatches(input, deps, fingerprint, compilerContractFingerprint)
      ) {
        return miss;
      }
    }
  }
  return null;
}

async function readCompiledBroadInteractionIndex(input: {
  descriptor: AssemblyCompiledBroadInteractionDiskDescriptorV1 | undefined;
  sceneManifest: PartitionedTranscriptSceneBinaryManifestV4;
  workspaceRoot: string;
  assemblyId: string;
  fingerprint: string;
  companionKey: string;
  deps: AssemblyTextureCacheDeps;
}): Promise<AssemblyCompiledBroadInteractionCacheIndexV1 | undefined> {
  const { descriptor, sceneManifest } = input;
  if (!descriptor) return undefined;
  try {
    const compactManifest = descriptor.manifest;
    const payloadSha256 = compactManifest?.integrity?.payloadSha256;
    const expectedFiles =
      typeof payloadSha256 === 'string' && /^[0-9a-f]{64}$/.test(payloadSha256)
        ? new Set([
            compiledBroadInteractionFileName(
              input.assemblyId,
              input.fingerprint,
              input.companionKey,
              sceneManifest.integrity.payloadSha256,
              payloadSha256
            ),
            legacyCompiledBroadInteractionFileName(
              input.assemblyId,
              input.fingerprint,
              input.companionKey,
              sceneManifest.integrity.payloadSha256,
              payloadSha256
            ),
          ])
        : null;
    if (
      descriptor.version !== 1 ||
      expectedFiles === null ||
      !expectedFiles.has(descriptor.file) ||
      descriptor.payloadSha256 !== payloadSha256 ||
      descriptor.byteCount !== compactManifest.byteLength ||
      !Number.isSafeInteger(descriptor.byteCount) ||
      descriptor.byteCount < 0 ||
      compactManifest.sourceScene?.schema !== sceneManifest.schema ||
      compactManifest.sourceScene?.payloadSha256 !== sceneManifest.integrity.payloadSha256 ||
      compactManifest.sourceScene?.contractSha256 !== sceneManifest.integrity.contractSha256 ||
      compactManifest.sourceScene?.byteLength !== sceneManifest.byteLength ||
      !datasetContractsEqual(compactManifest.datasetContract, sceneManifest.datasetContract) ||
      compactManifest.assemblyContract?.assemblyId !== sceneManifest.assemblyContract.assemblyId ||
      compactManifest.assemblyContract?.assemblyLengthBp !==
        sceneManifest.assemblyContract.assemblyLengthBp
    ) {
      return undefined;
    }
    const payloadPath = joinPath(textureCacheDir(input.workspaceRoot), descriptor.file);
    const payloadStat = await (input.deps.statCacheFile ?? defaultStatCacheFile)(payloadPath);
    if (!Number.isSafeInteger(payloadStat.size) || payloadStat.size !== descriptor.byteCount) {
      return undefined;
    }
    return {
      payloadPath,
      byteCount: descriptor.byteCount,
      payloadSha256,
      manifest: compactManifest,
    };
  } catch {
    return undefined;
  }
}

async function readAnnotationRoleSidecarIndex(input: {
  descriptor: AssemblyAnnotationRoleSidecarDiskDescriptorV1 | undefined;
  sceneManifest: PartitionedTranscriptSceneBinaryManifestV4;
  workspaceRoot: string;
  identity: { assemblyId: string; fingerprint: string; companionKey: string };
  deps: AssemblyTextureCacheDeps;
}): Promise<AssemblyAnnotationRoleSidecarCacheIndexV1 | undefined> {
  const { descriptor } = input;
  if (!descriptor) return undefined;
  try {
    if (
      !annotationRoleSidecarDescriptorMatchesSceneV1(
        descriptor,
        input.sceneManifest,
        input.identity
      )
    ) {
      return undefined;
    }
    const payloadPath = joinPath(textureCacheDir(input.workspaceRoot), descriptor.file);
    const payloadStat = await (input.deps.statCacheFile ?? defaultStatCacheFile)(payloadPath);
    if (payloadStat.size !== descriptor.byteCount) return undefined;
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

async function readAssemblyAnnotationSceneCacheInternal(
  input: AssemblyAnnotationSceneReadRequest,
  deps: AssemblyTextureCacheDeps
): Promise<AssemblyAnnotationSceneCacheInternalReadResult | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const indexed = await readAssemblyAnnotationSceneCacheIndex(input, deps);
    if (!indexed || indexed.status === 'miss') return indexed;
    try {
      const diskBytes = await (deps.readFileImpl ?? defaultRead)(indexed.scenePath);
      if (diskBytes.byteLength !== indexed.byteCount) throw new Error('scene byte count changed');
      await validatePartitionedTranscriptSceneBinaryV4(
        indexed.manifest,
        diskBytes,
        sha256BoundedNodeV1
      );
      if (indexed.manifest.byteLength !== indexed.byteCount) {
        throw new Error('scene manifest byte count changed');
      }
      if (
        !(await annotationSceneRevisionMatches(
          input,
          deps,
          indexed.fingerprint,
          indexed.sourceBuildFingerprint
        ))
      ) {
        continue;
      }
      return { ...indexed, payload: diskBytes };
    } catch {
      if (
        await annotationSceneRevisionMatches(
          input,
          deps,
          indexed.fingerprint,
          indexed.sourceBuildFingerprint
        )
      ) {
        return {
          status: 'miss',
          ipcContractVersion: indexed.ipcContractVersion,
          fingerprint: indexed.fingerprint,
          sourceBuildFingerprint: indexed.sourceBuildFingerprint,
        };
      }
    }
  }
  return null;
}

export async function readAssemblyAnnotationSceneCache(
  input: AssemblyAnnotationSceneReadRequest,
  deps: AssemblyTextureCacheDeps
): Promise<AssemblyAnnotationSceneReadResult | null> {
  const result = await readAssemblyAnnotationSceneCacheInternal(input, deps);
  if (!result || result.status === 'miss') return result;
  const { scenePath: _scenePath, payloadSha256: _payloadSha256, payload, ...metadata } = result;
  return { ...metadata, payload: copyToPlainUint8Array(payload) };
}

export async function readAssemblyAnnotationSceneCacheResource(
  input: AssemblyAnnotationSceneReadRequest,
  deps: AssemblyTextureCacheDeps
): Promise<AssemblyAnnotationSceneCacheResourceReadResult | null> {
  const result = await readAssemblyAnnotationSceneCacheInternal(input, deps);
  if (!result || result.status === 'miss') return result;
  const { payload, ...resource } = result;
  return { ...resource, validatedPayload: payload };
}

function sameAnnotationSceneIndex(
  left: AssemblyAnnotationSceneCacheIndexHit,
  right: AssemblyAnnotationSceneCacheIndexHit
): boolean {
  return (
    left.scenePath === right.scenePath &&
    left.fingerprint === right.fingerprint &&
    left.sourceBuildFingerprint === right.sourceBuildFingerprint &&
    left.payloadSha256 === right.payloadSha256 &&
    left.manifest.integrity.contractSha256 === right.manifest.integrity.contractSha256
  );
}

export async function writeAssemblyCompiledBroadInteractionCache(
  input: AssemblyAnnotationSceneReadRequest,
  projection: {
    manifest: CompiledBroadAnnotationInteractionBinaryManifestV1;
    payload: Uint8Array | ArrayBuffer;
    detailRangeCatalog?: PartitionedTranscriptSceneRangeCatalogV1;
  },
  deps: AssemblyTextureCacheDeps
): Promise<boolean> {
  try {
    const payload = normalizeWirePayload(projection.payload);
    if (!payload) return false;
    await validateCompiledBroadAnnotationInteractionBinaryV1(
      projection.manifest,
      payload,
      sha256BoundedNodeV1
    );
    const indexed = await readAssemblyAnnotationSceneCacheIndex(input, deps);
    if (!indexed || indexed.status !== 'hit') return false;
    if (
      projection.manifest.sourceScene.schema !== indexed.manifest.schema ||
      projection.manifest.sourceScene.payloadSha256 !== indexed.payloadSha256 ||
      projection.manifest.sourceScene.contractSha256 !==
        indexed.manifest.integrity.contractSha256 ||
      projection.manifest.sourceScene.byteLength !== indexed.byteCount ||
      !datasetContractsEqual(
        projection.manifest.datasetContract,
        indexed.manifest.datasetContract
      ) ||
      projection.manifest.assemblyContract.assemblyId !==
        indexed.manifest.assemblyContract.assemblyId ||
      projection.manifest.assemblyContract.assemblyLengthBp !==
        indexed.manifest.assemblyContract.assemblyLengthBp
    ) {
      return false;
    }
    const companionKey = annotationSceneCompanionKey(
      input.datasetContract,
      input.artifact,
      input.scope
    );
    if (!companionKey) return false;
    const manifestPath = annotationSceneManifestPath(
      input.workspaceRoot,
      input.assemblyId,
      indexed.fingerprint,
      companionKey
    );
    return await withAnnotationScenePublicationLock(manifestPath, async () => {
      const locked = await readAssemblyAnnotationSceneCacheIndex(input, deps);
      if (!locked || locked.status !== 'hit' || !sameAnnotationSceneIndex(indexed, locked)) {
        return false;
      }
      const diskManifest = JSON.parse(
        (await (deps.readFileImpl ?? defaultRead)(manifestPath)).toString('utf8')
      ) as AssemblyAnnotationSceneDiskManifestV6;
      if (
        diskManifest.sceneManifest?.integrity?.payloadSha256 !== indexed.payloadSha256 ||
        diskManifest.sceneManifest?.integrity?.contractSha256 !==
          indexed.manifest.integrity.contractSha256 ||
        diskManifest.sceneFile !==
          `${input.assemblyId}-${indexed.fingerprint}-${companionKey}-${indexed.payloadSha256}.annotation-scene.v6.bin`
      ) {
        return false;
      }
      const compactSha = projection.manifest.integrity.payloadSha256;
      const compactFile = compiledBroadInteractionFileName(
        input.assemblyId,
        indexed.fingerprint,
        companionKey,
        indexed.payloadSha256,
        compactSha
      );
      const compactPath = compiledBroadInteractionPath(
        input.workspaceRoot,
        input.assemblyId,
        indexed.fingerprint,
        companionKey,
        indexed.payloadSha256,
        compactSha
      );
      diskManifest.compiledBroadInteraction = {
        version: 1,
        file: compactFile,
        byteCount: payload.byteLength,
        payloadSha256: compactSha,
        manifest: projection.manifest,
      };
      if (projection.detailRangeCatalog) {
        assertPartitionedTranscriptSceneRangeCatalogV1(
          projection.detailRangeCatalog,
          indexed.manifest
        );
        diskManifest.detailRangeCatalog = projection.detailRangeCatalog;
      }
      const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const tempCompactPath = `${compactPath}.tmp-${token}`;
      const tempManifestPath = `${manifestPath}.tmp-${token}`;
      const writeFn = deps.writeFileImpl ?? defaultWrite;
      const renameFn = deps.renameImpl ?? defaultRename;
      const unlinkFn = deps.unlinkImpl ?? defaultUnlink;
      let compactTempExists = false;
      let manifestTempExists = false;
      try {
        await writeFn(
          tempCompactPath,
          Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
        );
        compactTempExists = true;
        await writeFn(tempManifestPath, JSON.stringify(diskManifest, null, 2));
        manifestTempExists = true;
        const beforeCommit = await readAssemblyAnnotationSceneCacheIndex(input, deps);
        if (
          !beforeCommit ||
          beforeCommit.status !== 'hit' ||
          !sameAnnotationSceneIndex(indexed, beforeCommit)
        ) {
          return false;
        }
        await renameFn(tempCompactPath, compactPath);
        compactTempExists = false;
        const finalParent = await readAssemblyAnnotationSceneCacheIndex(input, deps);
        if (
          !finalParent ||
          finalParent.status !== 'hit' ||
          !sameAnnotationSceneIndex(indexed, finalParent)
        ) {
          return false;
        }
        await renameFn(tempManifestPath, manifestPath);
        manifestTempExists = false;
        return true;
      } finally {
        if (compactTempExists) await unlinkFn(tempCompactPath).catch(() => undefined);
        if (manifestTempExists) await unlinkFn(tempManifestPath).catch(() => undefined);
      }
    });
  } catch {
    return false;
  }
}

async function annotationSceneRevisionMatches(
  input: AssemblyAnnotationSceneReadRequest,
  deps: AssemblyTextureCacheDeps,
  expectedFingerprint: string,
  expectedCompilerContractFingerprint: string
): Promise<boolean> {
  if (
    annotationSceneCompilerContractFingerprint(
      input.datasetContract,
      input.artifact,
      input.scope
    ) !== expectedCompilerContractFingerprint
  ) {
    return false;
  }
  const current = await computeAssemblyAnnotationSceneSourceFingerprint(input, deps);
  return current === expectedFingerprint;
}

const annotationScenePublicationQueues = new Map<string, Promise<void>>();

async function withAnnotationScenePublicationLock<T>(
  path: string,
  publish: () => Promise<T>
): Promise<T> {
  const previous = annotationScenePublicationQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.catch(() => undefined).then(() => gate);
  annotationScenePublicationQueues.set(path, tail);
  await previous.catch(() => undefined);
  try {
    return await publish();
  } finally {
    release();
    if (annotationScenePublicationQueues.get(path) === tail) {
      annotationScenePublicationQueues.delete(path);
    }
  }
}

export async function writeAssemblyAnnotationSceneCache(
  input: AssemblyAnnotationSceneWriteRequest,
  deps: AssemblyTextureCacheDeps
): Promise<AssemblyAnnotationSceneWriteResult | null> {
  try {
    if (
      input?.ipcContractVersion !== ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT ||
      !input?.assemblyId ||
      !input?.workspaceRoot ||
      !runtimePolicyIsWellFormed(input.requestedPolicy)
    ) {
      return null;
    }
    const payload = normalizeWirePayload(input.payload);
    if (!payload) return null;
    await validatePartitionedTranscriptSceneBinaryV4(input.manifest, payload, sha256BoundedNodeV1);
    let compiledBroadInteraction:
      | {
          manifest: CompiledBroadAnnotationInteractionBinaryManifestV1;
          payload: Uint8Array;
        }
      | undefined;
    if (input.compiledBroadInteraction) {
      const compactPayload = normalizeWirePayload(input.compiledBroadInteraction.payload);
      if (!compactPayload) return null;
      await validateCompiledBroadAnnotationInteractionBinaryV1(
        input.compiledBroadInteraction.manifest,
        compactPayload,
        sha256BoundedNodeV1
      );
      const compactManifest = input.compiledBroadInteraction.manifest;
      if (
        compactManifest.sourceScene.schema !== input.manifest.schema ||
        compactManifest.sourceScene.payloadSha256 !== input.manifest.integrity.payloadSha256 ||
        compactManifest.sourceScene.contractSha256 !== input.manifest.integrity.contractSha256 ||
        compactManifest.sourceScene.byteLength !== input.manifest.byteLength ||
        !datasetContractsEqual(compactManifest.datasetContract, input.manifest.datasetContract) ||
        compactManifest.assemblyContract.assemblyId !==
          input.manifest.assemblyContract.assemblyId ||
        compactManifest.assemblyContract.assemblyLengthBp !==
          input.manifest.assemblyContract.assemblyLengthBp
      ) {
        return null;
      }
      compiledBroadInteraction = { manifest: compactManifest, payload: compactPayload };
    }

    if (
      !/^[0-9a-f]{24}$/.test(input.expectedSourceFingerprint) ||
      typeof input.expectedSourceBuildFingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(input.expectedSourceBuildFingerprint)
    ) {
      return null;
    }
    const fingerprint = input.expectedSourceFingerprint;
    const compilerContractFingerprint = annotationSceneCompilerContractFingerprint(
      input.datasetContract,
      input.artifact,
      input.scope
    );
    if (
      compilerContractFingerprint !== input.expectedSourceBuildFingerprint ||
      !(await annotationSceneRevisionMatches(input, deps, fingerprint, compilerContractFingerprint))
    ) {
      return null;
    }
    const placement = assemblyTexturePlacement(input.chromosomes);
    if (!placement) return null;
    const companionKey = annotationSceneCompanionKey(
      input.datasetContract,
      input.artifact,
      input.scope
    );
    if (!companionKey) return null;
    const roleSidecar = input.roleSidecar
      ? encodeAnnotationRoleSidecarV1(input.roleSidecar, input.manifest, {
          assemblyId: input.assemblyId,
          fingerprint,
          companionKey,
        })
      : null;
    if (input.roleSidecar && !roleSidecar) return null;
    if (
      !datasetContractsEqual(input.manifest.datasetContract, input.datasetContract) ||
      input.manifest.assemblyContract.assemblyId !== input.assemblyId ||
      input.manifest.assemblyContract.assemblyLengthBp !== placement.totalLength ||
      input.manifest.partitionSpanBp !== input.artifact.partitionSpanBp ||
      input.manifest.byteLength !== payload.byteLength
    ) {
      return null;
    }
    const detailRangeCatalog = await buildPartitionedTranscriptSceneRangeCatalogV1(
      input.manifest,
      payload,
      sha256BoundedNodeV1
    );

    const dir = textureCacheDir(input.workspaceRoot);
    const payloadSha256 = input.manifest.integrity.payloadSha256;
    const scenePath = annotationScenePath(
      input.workspaceRoot,
      input.assemblyId,
      fingerprint,
      companionKey,
      payloadSha256
    );
    const manifestPath = annotationSceneManifestPath(
      input.workspaceRoot,
      input.assemblyId,
      fingerprint,
      companionKey
    );
    const sceneFile = `${input.assemblyId}-${fingerprint}-${companionKey}-${payloadSha256}.annotation-scene.v6.bin`;
    const compactPayloadSha256 = compiledBroadInteraction?.manifest.integrity.payloadSha256;
    const compactFile = compactPayloadSha256
      ? compiledBroadInteractionFileName(
          input.assemblyId,
          fingerprint,
          companionKey,
          payloadSha256,
          compactPayloadSha256
        )
      : null;
    const compactPath = compactPayloadSha256
      ? compiledBroadInteractionPath(
          input.workspaceRoot,
          input.assemblyId,
          fingerprint,
          companionKey,
          payloadSha256,
          compactPayloadSha256
        )
      : null;
    return await withAnnotationScenePublicationLock(manifestPath, async () => {
      if (
        !(await annotationSceneRevisionMatches(
          input,
          deps,
          fingerprint,
          compilerContractFingerprint
        ))
      ) {
        return null;
      }
      const tempToken = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const tempScenePath = `${scenePath}.tmp-${tempToken}`;
      const tempManifestPath = `${manifestPath}.tmp-${tempToken}`;
      const tempCompactPath = compactPath ? `${compactPath}.tmp-${tempToken}` : null;
      const rolePath = roleSidecar ? joinPath(dir, roleSidecar.descriptor.file) : null;
      const tempRolePath = rolePath ? `${rolePath}.tmp-${tempToken}` : null;
      const diskManifest: AssemblyAnnotationSceneDiskManifestV6 = {
        version: ASSEMBLY_ANNOTATION_SCENE_CACHE_VERSION,
        assemblyId: input.assemblyId,
        fingerprint,
        companionKey,
        compilerContractFingerprint,
        placementSignature: placement.signature,
        sceneFile,
        byteCount: payload.byteLength,
        scope: {
          kind: input.scope.kind,
          placements: input.scope.placements.map((placement) => ({ ...placement })),
        },
        artifact: { ...input.artifact },
        sceneManifest: input.manifest,
        detailRangeCatalog,
        ...(compiledBroadInteraction && compactFile
          ? {
              compiledBroadInteraction: {
                version: 1,
                file: compactFile,
                byteCount: compiledBroadInteraction.payload.byteLength,
                payloadSha256: compiledBroadInteraction.manifest.integrity.payloadSha256,
                manifest: compiledBroadInteraction.manifest,
              },
            }
          : {}),
        ...(roleSidecar ? { roleSidecar: roleSidecar.descriptor } : {}),
      };

      await (deps.mkdirImpl ?? defaultMkdir)(dir);
      const writeFn = deps.writeFileImpl ?? defaultWrite;
      const renameFn = deps.renameImpl ?? defaultRename;
      const unlinkFn = deps.unlinkImpl ?? defaultUnlink;
      let tempSceneExists = false;
      let tempManifestExists = false;
      let tempCompactExists = false;
      let tempRoleExists = false;
      try {
        await writeFn(
          tempScenePath,
          Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
        );
        tempSceneExists = true;
        if (compiledBroadInteraction && tempCompactPath) {
          await writeFn(
            tempCompactPath,
            Buffer.from(
              compiledBroadInteraction.payload.buffer,
              compiledBroadInteraction.payload.byteOffset,
              compiledBroadInteraction.payload.byteLength
            )
          );
          tempCompactExists = true;
        }
        if (roleSidecar && tempRolePath) {
          await writeFn(
            tempRolePath,
            Buffer.from(
              roleSidecar.payload.buffer,
              roleSidecar.payload.byteOffset,
              roleSidecar.payload.byteLength
            )
          );
          tempRoleExists = true;
        }
        await writeFn(tempManifestPath, JSON.stringify(diskManifest, null, 2));
        tempManifestExists = true;
        if (
          !(await annotationSceneRevisionMatches(
            input,
            deps,
            fingerprint,
            compilerContractFingerprint
          ))
        ) {
          return null;
        }
        await renameFn(tempScenePath, scenePath);
        tempSceneExists = false;
        if (tempCompactPath && compactPath) {
          await renameFn(tempCompactPath, compactPath);
          tempCompactExists = false;
        }
        if (tempRolePath && rolePath) {
          await renameFn(tempRolePath, rolePath);
          tempRoleExists = false;
        }
        if (
          !(await annotationSceneRevisionMatches(
            input,
            deps,
            fingerprint,
            compilerContractFingerprint
          ))
        ) {
          return null;
        }
        await renameFn(tempManifestPath, manifestPath);
        tempManifestExists = false;
        return { fingerprint, byteCount: payload.byteLength, scenePath, manifestPath };
      } finally {
        if (tempSceneExists) await unlinkFn(tempScenePath).catch(() => undefined);
        if (tempCompactExists && tempCompactPath) {
          await unlinkFn(tempCompactPath).catch(() => undefined);
        }
        if (tempRoleExists && tempRolePath) {
          await unlinkFn(tempRolePath).catch(() => undefined);
        }
        if (tempManifestExists) await unlinkFn(tempManifestPath).catch(() => undefined);
      }
    });
  } catch {
    return null;
  }
}

function normalizeWirePayload(payload: Uint8Array | ArrayBuffer): Uint8Array | null {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload) && payload instanceof Uint8Array) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  return null;
}

function copyToPlainUint8Array(bytes: Uint8Array): Uint8Array {
  const result = new Uint8Array(bytes.byteLength);
  result.set(bytes);
  return result;
}

function datasetContractsEqual(
  left: AnnotationSceneDatasetContractV1 | null | undefined,
  right: AnnotationSceneDatasetContractV1 | null | undefined
): boolean {
  return (
    datasetContractsAreWellFormed(left) &&
    datasetContractsAreWellFormed(right) &&
    left?.datasetId === right?.datasetId &&
    left?.datasetVersion === right?.datasetVersion &&
    left?.sourceSha256 === right?.sourceSha256
  );
}

function scopeContractsEqual(
  left: AssemblyAnnotationSceneScopeContract | null | undefined,
  right: AssemblyAnnotationSceneScopeContract | null | undefined
): boolean {
  return (
    scopeIsWellFormed(left) &&
    scopeIsWellFormed(right) &&
    left.kind === right.kind &&
    left.placements.length === right.placements.length &&
    left.placements.every((placement, index) => {
      const other = right.placements[index];
      return (
        placement.chrom === other?.chrom &&
        placement.length === other?.length &&
        placement.annotationCoverage === other?.annotationCoverage
      );
    })
  );
}

function runtimePolicyIsWellFormed(
  policy: AssemblyAnnotationRuntimePolicy | null | undefined
): policy is AssemblyAnnotationRuntimePolicy {
  return Boolean(
    policy &&
    (policy.isoformMode === 'canonical' || policy.isoformMode === 'expanded') &&
    (policy.laneLimit === null ||
      (Number.isSafeInteger(policy.laneLimit) && (policy.laneLimit as number) > 0))
  );
}

function sceneArtifactsEqual(
  left: AssemblyAnnotationSceneArtifactContract | null | undefined,
  right: AssemblyAnnotationSceneArtifactContract | null | undefined
): boolean {
  return (
    sceneArtifactIsWellFormed(left) &&
    sceneArtifactIsWellFormed(right) &&
    left.artifactKey === right.artifactKey &&
    left.themeMode === right.themeMode &&
    left.trackType === right.trackType &&
    left.partitionSpanBp === right.partitionSpanBp &&
    left.annotationBarHeightPx === right.annotationBarHeightPx &&
    left.laneAlgorithmToken === right.laneAlgorithmToken &&
    left.mapperContractToken === right.mapperContractToken &&
    left.geometryContractToken === right.geometryContractToken &&
    left.interactionContractToken === right.interactionContractToken
  );
}

function layoutIsValidForPlacement(
  layout: AssemblyTextureLayout,
  placementTotalLength: number
): boolean {
  return (
    Number.isFinite(layout.widthPx) &&
    layout.widthPx > 0 &&
    Number.isFinite(layout.heightPx) &&
    layout.heightPx > 0 &&
    Number.isFinite(layout.resolution) &&
    layout.resolution > 0 &&
    Number.isFinite(layout.spineOffsetPx) &&
    Number.isFinite(layout.genomeLength) &&
    layout.genomeLength === placementTotalLength &&
    Number.isInteger(layout.maxAnnotationLane) &&
    layout.maxAnnotationLane >= -1 &&
    Number.isInteger(layout.maxCdsLane) &&
    layout.maxCdsLane >= -1 &&
    normalizedLayerTypes(layout.layerTypes).length > 0
  );
}

function normalizedLayerTypes(layerTypes: readonly string[] | undefined): string[] {
  return [...new Set((layerTypes ?? []).map((type) => type.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function pngMatchesLayout(png: Buffer, layout: AssemblyTextureLayout): boolean {
  const dimensions = readPngDimensions(png);
  if (!dimensions) return false;
  return (
    dimensions.width === Math.round(layout.widthPx * layout.resolution) &&
    dimensions.height === Math.round(layout.heightPx * layout.resolution)
  );
}

function readPngDimensions(png: Buffer): { width: number; height: number } | null {
  if (!Buffer.isBuffer(png) || png.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (png[i] !== signature[i]) return null;
  }
  if (png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') {
    return null;
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}
