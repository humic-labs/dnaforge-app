import { createHash } from 'crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'fs/promises';

import {
  PREPACKED_ANNOTATION_SEARCH_CONTRACT_TOKEN,
  PREPACKED_ANNOTATION_SEARCH_INDEX_V1,
  openRangeReadablePrepackedAnnotationSearchIndexV1,
  packPrepackedAnnotationSearchIndexV1,
  validatePrepackedAnnotationSearchIndexV1,
  type IndexableAnnotationSearchFeatureV1,
  type PackedPrepackedAnnotationSearchIndexV1,
  type PrepackedAnnotationSearchIndexManifestV1,
  type PrepackedAnnotationSearchPackProgressV1,
} from '@waypoint/genome-data';

import { joinPath } from '../../features/sequence/indexed-genome-paths';
import {
  ANNOTATION_TRACK_IDENTITY_CONTRACT_TOKEN,
  ANNOTATION_TRACK_IDENTITY_PREVIOUS_CONTRACT_TOKENS,
} from '../../features/sequence/annotation-layer-identity';
import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  ASSEMBLY_ANNOTATION_SEARCH_TRACK_TYPE,
  assemblyAnnotationSceneScopeMatchesChromosomes,
  type AssemblyAnnotationSceneReadRequest,
  type AssemblyOverviewChromInput,
} from '../../shared/indexed-genome';
import type { AssemblyTextureCacheDeps } from './assembly-overview-texture-cache';
import { sha256BoundedNodeV1 } from './bounded-binary-sha256';

export const ASSEMBLY_ANNOTATION_SEARCH_CACHE_V1 = 'assembly-annotation-search-cache.v1' as const;
export const ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2 = 'assembly-annotation-search-cache.v2' as const;
export const ASSEMBLY_ANNOTATION_SEARCH_LEGACY_COMPILER_SEMANTICS_V2 =
  'assembly-annotation-search-compiler-semantics.v2:explicit-manifest-quartet' as const;
export const ASSEMBLY_ANNOTATION_SEARCH_COMPILER_SEMANTICS_V2 =
  `${ASSEMBLY_ANNOTATION_SEARCH_LEGACY_COMPILER_SEMANTICS_V2}|${ANNOTATION_TRACK_IDENTITY_CONTRACT_TOKEN}` as const;
export const ASSEMBLY_ANNOTATION_SEARCH_PREVIOUS_COMPILER_SEMANTICS_V2: readonly string[] =
  ANNOTATION_TRACK_IDENTITY_PREVIOUS_CONTRACT_TOKENS.map(
    (token) => `${ASSEMBLY_ANNOTATION_SEARCH_LEGACY_COMPILER_SEMANTICS_V2}|${token}`
  );

export interface AssemblyAnnotationSearchPayloadFileStatV2 {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly ino: bigint;
  readonly dev: bigint;
}

export interface AssemblyAnnotationSearchPayloadIdentityV2 {
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly ino: string;
  readonly dev: string;
}

export interface AssemblyAnnotationSearchSourceContinuityEntryV1 {
  readonly sourcePath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number | null;
}

export interface AssemblyAnnotationSearchPayloadFileV2 {
  stat(): Promise<AssemblyAnnotationSearchPayloadFileStatV2>;
  read(
    buffer: Uint8Array,
    byteOffset: number,
    byteLength: number,
    position: number
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface AssemblyAnnotationSearchCacheDeps extends AssemblyTextureCacheDeps {
  statSearchPayload?: (filePath: string) => Promise<AssemblyAnnotationSearchPayloadFileStatV2>;
  openSearchPayload?: (filePath: string) => Promise<AssemblyAnnotationSearchPayloadFileV2>;
}

export interface AssemblyAnnotationSearchCacheMiss {
  status: 'miss';
  fingerprint: string;
}

export interface AssemblyAnnotationSearchCacheIndexHit {
  status: 'hit';
  fingerprint: string;
  byteCount: number;
  manifest: PrepackedAnnotationSearchIndexManifestV1;
  payloadPath: string;
  payloadSha256: string;
  payloadIdentity: AssemblyAnnotationSearchPayloadIdentityV2;
  sourceContinuity: readonly AssemblyAnnotationSearchSourceContinuityEntryV1[];
}

type AssemblyAnnotationSearchUnsealedIndexHit = Omit<
  AssemblyAnnotationSearchCacheIndexHit,
  'sourceContinuity'
>;

export interface AssemblyAnnotationSearchCacheResourceHit extends AssemblyAnnotationSearchCacheIndexHit {
  validatedPayload: Uint8Array;
}

export type AssemblyAnnotationSearchCacheIndexReadResult =
  | AssemblyAnnotationSearchCacheMiss
  | AssemblyAnnotationSearchCacheIndexHit;

export type AssemblyAnnotationSearchCacheResourceReadResult =
  | AssemblyAnnotationSearchCacheMiss
  | AssemblyAnnotationSearchCacheResourceHit;

export interface AssemblyAnnotationSearchCacheWriteInput {
  request: AssemblyAnnotationSceneReadRequest;
  expectedSourceFingerprint: string;
  manifest: PrepackedAnnotationSearchIndexManifestV1;
  payload: Uint8Array | ArrayBuffer;
}

export interface AssemblyAnnotationSearchCacheWriteResult {
  fingerprint: string;
  byteCount: number;
  manifestPath: string;
  payloadPath: string;
  payloadIdentity: AssemblyAnnotationSearchPayloadIdentityV2;
}

const ASSEMBLY_ANNOTATION_SEARCH_PACKED_PAYLOAD = Symbol(
  'assembly-annotation-search-packed-payload'
);

interface AssemblyAnnotationSearchPackedPayloadV1 extends PackedPrepackedAnnotationSearchIndexV1 {
  readonly [ASSEMBLY_ANNOTATION_SEARCH_PACKED_PAYLOAD]: true;
}

interface AssemblyAnnotationSearchDiskManifestV2 {
  version: typeof ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2;
  compilerSemantics: typeof ASSEMBLY_ANNOTATION_SEARCH_COMPILER_SEMANTICS_V2;
  assemblyId: string;
  fingerprint: string;
  companionKey: string;
  placementSignature: string;
  payloadFile: string;
  payloadIdentity: AssemblyAnnotationSearchPayloadIdentityV2;
  byteCount: number;
  searchManifest: PrepackedAnnotationSearchIndexManifestV1;
}

interface AssemblyAnnotationSearchDiskManifestV1 {
  version: typeof ASSEMBLY_ANNOTATION_SEARCH_CACHE_V1;
  assemblyId: string;
  fingerprint: string;
  companionKey: string;
  placementSignature: string;
  payloadFile: string;
  byteCount: number;
  searchManifest: PrepackedAnnotationSearchIndexManifestV1;
}

export interface AssemblyAnnotationSearchPlacement {
  placementSignature: string;
  assemblyLengthBp: number;
}

const SOURCE_FINGERPRINT = /^[0-9a-f]{24}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CACHE_READ_ATTEMPTS = 3;
const MIGRATION_HASH_CHUNK_BYTES = 4 * 1024 * 1024;
const MIGRATION_YIELD_BYTES = 16 * 1024 * 1024;
const ASSEMBLY_ANNOTATION_SEARCH_SOURCE_REVISION_V2 =
  'assembly-annotation-search-source-revision.v2:explicit-manifest-quartet' as const;

const defaultRead: NonNullable<AssemblyTextureCacheDeps['readFileImpl']> = (path) => readFile(path);
const defaultWrite: NonNullable<AssemblyTextureCacheDeps['writeFileImpl']> = (path, data) =>
  writeFile(path, data);
const defaultRename: NonNullable<AssemblyTextureCacheDeps['renameImpl']> = (from, to) =>
  rename(from, to);
const defaultUnlink: NonNullable<AssemblyTextureCacheDeps['unlinkImpl']> = (path) => unlink(path);
const defaultStatSearchPayload: NonNullable<
  AssemblyAnnotationSearchCacheDeps['statSearchPayload']
> = (path) => stat(path, { bigint: true });
const defaultOpenSearchPayload: NonNullable<
  AssemblyAnnotationSearchCacheDeps['openSearchPayload']
> = async (path) => {
  const file = await open(path, 'r');
  return {
    stat: () => file.stat({ bigint: true }),
    read: (buffer, byteOffset, byteLength, position) =>
      file.read(buffer, byteOffset, byteLength, position),
    close: () => file.close(),
  };
};
const defaultStatSearchSource: NonNullable<AssemblyTextureCacheDeps['statSource']> = (path) =>
  stat(path);
const defaultMkdir: NonNullable<AssemblyTextureCacheDeps['mkdirImpl']> = async (dir) => {
  await mkdir(dir, { recursive: true });
};

function searchCacheDir(workspaceRoot: string): string {
  return joinPath(workspaceRoot, '.waypoint', 'genome-index', 'assembly-overview');
}

export function assemblyAnnotationSearchPlacement(
  chromosomes: readonly AssemblyOverviewChromInput[]
): AssemblyAnnotationSearchPlacement | null {
  if (!Array.isArray(chromosomes)) return null;
  const names = new Set<string>();
  const rows: Array<readonly [number, string, number, number, number]> = [];
  let startBp = 0;
  for (let index = 0; index < chromosomes.length; index += 1) {
    const chromosome = chromosomes[index];
    if (
      !chromosome?.chrom ||
      names.has(chromosome.chrom) ||
      !Number.isSafeInteger(chromosome.length) ||
      chromosome.length <= 0
    ) {
      return null;
    }
    const endBp = startBp + chromosome.length;
    if (!Number.isSafeInteger(endBp)) return null;
    names.add(chromosome.chrom);
    rows.push([index, chromosome.chrom, startBp, endBp, chromosome.length]);
    startBp = endBp;
  }
  if (rows.length === 0) return null;
  return {
    placementSignature: JSON.stringify(['ordered-linear-assembly-placement-v1', startBp, rows]),
    assemblyLengthBp: startBp,
  };
}

function exactOrderedAssemblyPlacement(
  request: Pick<AssemblyAnnotationSceneReadRequest, 'chromosomes' | 'scope'>
): AssemblyAnnotationSearchPlacement | null {
  if (!assemblyAnnotationSceneScopeMatchesChromosomes(request.scope, request.chromosomes)) {
    return null;
  }
  return assemblyAnnotationSearchPlacement(request.chromosomes);
}

function datasetContractIsWellFormed(
  dataset: AssemblyAnnotationSceneReadRequest['datasetContract'] | null | undefined
): boolean {
  return Boolean(
    dataset?.datasetId?.trim() &&
    dataset.datasetVersion?.trim() &&
    SHA256_HEX.test(dataset.sourceSha256 ?? '')
  );
}

function requestIsWellFormed(request: AssemblyAnnotationSceneReadRequest): boolean {
  return Boolean(
    request?.ipcContractVersion === ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT &&
    request.assemblyId?.trim() &&
    request.workspaceRoot?.trim() &&
    datasetContractIsWellFormed(request.datasetContract) &&
    exactOrderedAssemblyPlacement(request)
  );
}

function datasetContractsEqual(
  left: PrepackedAnnotationSearchIndexManifestV1['datasetContract'] | null | undefined,
  right: AssemblyAnnotationSceneReadRequest['datasetContract']
): boolean {
  return Boolean(
    left &&
    left.datasetId === right.datasetId &&
    left.datasetVersion === right.datasetVersion &&
    left.sourceSha256 === right.sourceSha256
  );
}

function searchCompanionKeyForVersion(
  cacheVersion:
    | typeof ASSEMBLY_ANNOTATION_SEARCH_CACHE_V1
    | typeof ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2,
  request: AssemblyAnnotationSceneReadRequest,
  placement: AssemblyAnnotationSearchPlacement,
  sourceFingerprint: string
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        cacheVersion,
        PREPACKED_ANNOTATION_SEARCH_INDEX_V1,
        PREPACKED_ANNOTATION_SEARCH_CONTRACT_TOKEN,
        ASSEMBLY_ANNOTATION_SEARCH_COMPILER_SEMANTICS_V2,
        request.assemblyId,
        placement.assemblyLengthBp,
        placement.placementSignature,
        sourceFingerprint,
        request.datasetContract.datasetId,
        request.datasetContract.datasetVersion,
        request.datasetContract.sourceSha256,
        ASSEMBLY_ANNOTATION_SEARCH_TRACK_TYPE,
      ])
    )
    .digest('hex');
}

function searchCompanionKey(
  request: AssemblyAnnotationSceneReadRequest,
  placement: AssemblyAnnotationSearchPlacement,
  sourceFingerprint: string
): string {
  return searchCompanionKeyForVersion(
    ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2,
    request,
    placement,
    sourceFingerprint
  );
}

function manifestPathForVersion(
  workspaceRoot: string,
  companionKey: string,
  cacheVersion:
    | typeof ASSEMBLY_ANNOTATION_SEARCH_CACHE_V1
    | typeof ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2
): string {
  const suffix = cacheVersion === ASSEMBLY_ANNOTATION_SEARCH_CACHE_V1 ? 'v1' : 'v2';
  return joinPath(
    searchCacheDir(workspaceRoot),
    `annotation-search-${companionKey}.${suffix}.json`
  );
}

function manifestPathFor(workspaceRoot: string, companionKey: string): string {
  return manifestPathForVersion(workspaceRoot, companionKey, ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2);
}

function payloadFileFor(payloadSha256: string): string {
  return `annotation-search-${payloadSha256}.v1.bin`;
}

function payloadPathFor(workspaceRoot: string, payloadSha256: string): string {
  return joinPath(searchCacheDir(workspaceRoot), payloadFileFor(payloadSha256));
}

function manifestMatchesRequest(
  manifest: PrepackedAnnotationSearchIndexManifestV1 | null | undefined,
  request: AssemblyAnnotationSceneReadRequest,
  placement: AssemblyAnnotationSearchPlacement,
  sourceFingerprint: string,
  byteCount: number
): manifest is PrepackedAnnotationSearchIndexManifestV1 {
  return Boolean(
    manifest &&
    manifest.schema === PREPACKED_ANNOTATION_SEARCH_INDEX_V1 &&
    datasetContractsEqual(manifest.datasetContract, request.datasetContract) &&
    manifest.assemblyContract?.assemblyId === request.assemblyId &&
    manifest.assemblyContract.assemblyLengthBp === placement.assemblyLengthBp &&
    manifest.assemblyContract.placementSignature === placement.placementSignature &&
    manifest.assemblyContract.sourceFingerprint === sourceFingerprint &&
    manifest.trackType === ASSEMBLY_ANNOTATION_SEARCH_TRACK_TYPE &&
    Number.isSafeInteger(manifest.featureCount) &&
    manifest.featureCount >= 0 &&
    Number.isSafeInteger(manifest.byteLength) &&
    manifest.byteLength === byteCount &&
    manifest.integrity?.algorithm === 'sha256' &&
    SHA256_HEX.test(manifest.integrity.payloadSha256 ?? '') &&
    SHA256_HEX.test(manifest.integrity.contractSha256 ?? '')
  );
}

function diskManifestMatchesRequest(
  value: unknown,
  request: AssemblyAnnotationSceneReadRequest,
  placement: AssemblyAnnotationSearchPlacement,
  sourceFingerprint: string,
  companionKey: string
): value is AssemblyAnnotationSearchDiskManifestV2 {
  if (!value || typeof value !== 'object') return false;
  const disk = value as Partial<AssemblyAnnotationSearchDiskManifestV2>;
  const payloadSha256 = disk.searchManifest?.integrity?.payloadSha256;
  return Boolean(
    disk.version === ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2 &&
    disk.compilerSemantics === ASSEMBLY_ANNOTATION_SEARCH_COMPILER_SEMANTICS_V2 &&
    disk.assemblyId === request.assemblyId &&
    disk.fingerprint === sourceFingerprint &&
    disk.companionKey === companionKey &&
    disk.placementSignature === placement.placementSignature &&
    Number.isSafeInteger(disk.byteCount) &&
    typeof disk.byteCount === 'number' &&
    disk.byteCount >= 0 &&
    typeof payloadSha256 === 'string' &&
    disk.payloadFile === payloadFileFor(payloadSha256) &&
    payloadIdentityIsWellFormed(disk.payloadIdentity) &&
    disk.payloadIdentity.size === String(disk.byteCount) &&
    manifestMatchesRequest(
      disk.searchManifest,
      request,
      placement,
      sourceFingerprint,
      disk.byteCount
    )
  );
}

function legacyDiskManifestMatchesRequest(
  value: unknown,
  request: AssemblyAnnotationSceneReadRequest,
  placement: AssemblyAnnotationSearchPlacement,
  sourceFingerprint: string,
  companionKey: string
): value is AssemblyAnnotationSearchDiskManifestV1 {
  if (!value || typeof value !== 'object') return false;
  const disk = value as Partial<AssemblyAnnotationSearchDiskManifestV1>;
  const payloadSha256 = disk.searchManifest?.integrity?.payloadSha256;
  return Boolean(
    disk.version === ASSEMBLY_ANNOTATION_SEARCH_CACHE_V1 &&
    disk.assemblyId === request.assemblyId &&
    disk.fingerprint === sourceFingerprint &&
    disk.companionKey === companionKey &&
    disk.placementSignature === placement.placementSignature &&
    Number.isSafeInteger(disk.byteCount) &&
    typeof disk.byteCount === 'number' &&
    disk.byteCount >= 0 &&
    typeof payloadSha256 === 'string' &&
    disk.payloadFile === payloadFileFor(payloadSha256) &&
    manifestMatchesRequest(
      disk.searchManifest,
      request,
      placement,
      sourceFingerprint,
      disk.byteCount
    )
  );
}

async function currentSourceFingerprint(
  request: AssemblyAnnotationSceneReadRequest,
  deps: AssemblyAnnotationSearchCacheDeps
): Promise<string | null> {
  return (
    (await resolveAssemblyAnnotationSearchSourceRevisionV2(request, deps))?.fingerprint ?? null
  );
}

async function currentSourceFingerprintWithContinuity(
  request: AssemblyAnnotationSceneReadRequest,
  deps: AssemblyAnnotationSearchCacheDeps
): Promise<{
  fingerprint: string;
  sourceContinuity: readonly AssemblyAnnotationSearchSourceContinuityEntryV1[];
} | null> {
  return resolveAssemblyAnnotationSearchSourceRevisionV2(request, deps);
}

export async function resolveAssemblyAnnotationSearchSourceRevisionV2(
  request: AssemblyAnnotationSceneReadRequest,
  deps: AssemblyAnnotationSearchCacheDeps
): Promise<{
  fingerprint: string;
  sourceContinuity: readonly AssemblyAnnotationSearchSourceContinuityEntryV1[];
} | null> {
  if (!requestIsWellFormed(request)) return null;
  const observations = new Map<string, AssemblyAnnotationSearchSourceContinuityEntryV1>();
  const statSource = deps.statSource ?? defaultStatSearchSource;
  const manifests: Array<readonly [string, number, string, string, string, string]> = [];
  try {
    for (let index = 0; index < request.chromosomes.length; index += 1) {
      if (request.scope.placements[index]?.annotationCoverage !== 'sourced') continue;
      const chromosome = request.chromosomes[index];
      const manifest = chromosome.manifest;
      const sourcePath = chromosome.sourcePath?.trim();
      if (
        !sourcePath ||
        !manifest ||
        manifest.chrom !== chromosome.chrom ||
        (manifest.length !== undefined && manifest.length !== chromosome.length) ||
        !manifest.fastaPath?.trim() ||
        !manifest.faiPath?.trim() ||
        !manifest.gffPath?.trim() ||
        !manifest.tbiPath?.trim() ||
        manifest.gffPath !== sourcePath
      ) {
        return null;
      }
      const paths = [
        manifest.fastaPath,
        manifest.faiPath,
        manifest.gffPath,
        manifest.tbiPath,
      ] as const;
      manifests.push([chromosome.chrom, chromosome.length, ...paths]);
      for (const path of paths) {
        if (observations.has(path)) continue;
        await deps.assertSafePath(path);
        const observed = await statSource(path);
        observations.set(path, {
          sourcePath: path,
          size: observed.size,
          mtimeMs: observed.mtimeMs,
          ctimeMs: observed.ctimeMs ?? null,
        });
      }
    }
  } catch {
    return null;
  }
  if (manifests.length === 0) return null;
  const sourceContinuity = [...observations.values()].sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath)
  );
  const placement = exactOrderedAssemblyPlacement(request);
  if (!placement) return null;
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        ASSEMBLY_ANNOTATION_SEARCH_SOURCE_REVISION_V2,
        request.assemblyId,
        placement.assemblyLengthBp,
        placement.placementSignature,
        request.datasetContract,
        manifests,
        sourceContinuity.map((entry) => [
          entry.sourcePath,
          entry.size,
          entry.mtimeMs,
          entry.ctimeMs,
        ]),
      ])
    )
    .digest('hex')
    .slice(0, 24);
  return { fingerprint, sourceContinuity };
}

function miss(sourceFingerprint: string): AssemblyAnnotationSearchCacheMiss {
  return { status: 'miss', fingerprint: sourceFingerprint };
}

async function readExactV2IndexHit(
  request: AssemblyAnnotationSceneReadRequest,
  placement: AssemblyAnnotationSearchPlacement,
  sourceFingerprint: string,
  companionKey: string,
  deps: AssemblyAnnotationSearchCacheDeps
): Promise<AssemblyAnnotationSearchUnsealedIndexHit | null> {
  const diskValue = JSON.parse(
    (
      await (deps.readFileImpl ?? defaultRead)(manifestPathFor(request.workspaceRoot, companionKey))
    ).toString('utf-8')
  ) as unknown;
  if (!diskManifestMatchesRequest(diskValue, request, placement, sourceFingerprint, companionKey)) {
    return null;
  }
  const payloadPath = payloadPathFor(
    request.workspaceRoot,
    diskValue.searchManifest.integrity.payloadSha256
  );
  if (
    !payloadIdentityMatchesFileStat(
      diskValue.payloadIdentity,
      await (deps.statSearchPayload ?? defaultStatSearchPayload)(payloadPath)
    )
  ) {
    return null;
  }
  return {
    status: 'hit',
    fingerprint: sourceFingerprint,
    byteCount: diskValue.byteCount,
    manifest: diskValue.searchManifest,
    payloadPath,
    payloadSha256: diskValue.searchManifest.integrity.payloadSha256,
    payloadIdentity: diskValue.payloadIdentity,
  };
}

async function readExactPayloadRange(
  file: AssemblyAnnotationSearchPayloadFileV2,
  byteOffset: number,
  byteLength: number
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < 0 ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > MIGRATION_HASH_CHUNK_BYTES
  ) {
    throw new Error('annotation search migration payload range exceeds the bounded reader');
  }
  const bytes = new Uint8Array(byteLength);
  let readOffset = 0;
  while (readOffset < byteLength) {
    const result = await file.read(
      bytes,
      readOffset,
      byteLength - readOffset,
      byteOffset + readOffset
    );
    if (!Number.isInteger(result.bytesRead) || result.bytesRead <= 0) {
      throw new Error('annotation search migration payload range read was incomplete');
    }
    readOffset += result.bytesRead;
  }
  return bytes;
}

async function authenticateLegacyPayload(
  file: AssemblyAnnotationSearchPayloadFileV2,
  disk: AssemblyAnnotationSearchDiskManifestV1
): Promise<AssemblyAnnotationSearchPayloadIdentityV2> {
  const before = payloadIdentityFromFileStat(await file.stat());
  if (!before || before.size !== String(disk.byteCount)) {
    throw new Error('annotation search migration payload identity is invalid');
  }

  const hash = createHash('sha256');
  const chunk = new Uint8Array(Math.min(MIGRATION_HASH_CHUNK_BYTES, disk.byteCount));
  let offset = 0;
  let bytesSinceYield = 0;
  while (offset < disk.byteCount) {
    const byteLength = Math.min(chunk.byteLength, disk.byteCount - offset);
    let chunkOffset = 0;
    while (chunkOffset < byteLength) {
      const result = await file.read(
        chunk,
        chunkOffset,
        byteLength - chunkOffset,
        offset + chunkOffset
      );
      if (!Number.isInteger(result.bytesRead) || result.bytesRead <= 0) {
        throw new Error('annotation search migration payload hash read was incomplete');
      }
      chunkOffset += result.bytesRead;
    }
    hash.update(Buffer.from(chunk.buffer, chunk.byteOffset, byteLength));
    offset += byteLength;
    bytesSinceYield += byteLength;
    if (bytesSinceYield >= MIGRATION_YIELD_BYTES && offset < disk.byteCount) {
      bytesSinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  if (hash.digest('hex') !== disk.searchManifest.integrity.payloadSha256) {
    throw new Error('annotation search migration payload sha256 mismatch');
  }

  await openRangeReadablePrepackedAnnotationSearchIndexV1(disk.searchManifest, {
    byteLength: disk.byteCount,
    read: (byteOffset, byteLength) => readExactPayloadRange(file, byteOffset, byteLength),
  });
  if (!payloadIdentityMatchesFileStat(before, await file.stat())) {
    throw new Error('annotation search migration payload changed during validation');
  }
  return before;
}

async function migrateLegacyV1Index(
  request: AssemblyAnnotationSceneReadRequest,
  placement: AssemblyAnnotationSearchPlacement,
  sourceFingerprint: string,
  v2CompanionKey: string,
  deps: AssemblyAnnotationSearchCacheDeps
): Promise<AssemblyAnnotationSearchUnsealedIndexHit | null> {
  const v2ManifestPath = manifestPathFor(request.workspaceRoot, v2CompanionKey);
  return withSearchPublicationLock(v2ManifestPath, async () => {
    try {
      const existing = await readExactV2IndexHit(
        request,
        placement,
        sourceFingerprint,
        v2CompanionKey,
        deps
      );
      if (existing) return existing;
    } catch {}
    if ((await currentSourceFingerprint(request, deps)) !== sourceFingerprint) return null;

    const v1CompanionKey = searchCompanionKeyForVersion(
      ASSEMBLY_ANNOTATION_SEARCH_CACHE_V1,
      request,
      placement,
      sourceFingerprint
    );
    const v1ManifestPath = manifestPathForVersion(
      request.workspaceRoot,
      v1CompanionKey,
      ASSEMBLY_ANNOTATION_SEARCH_CACHE_V1
    );
    const diskValue = JSON.parse(
      (await (deps.readFileImpl ?? defaultRead)(v1ManifestPath)).toString('utf-8')
    ) as unknown;
    if (
      !legacyDiskManifestMatchesRequest(
        diskValue,
        request,
        placement,
        sourceFingerprint,
        v1CompanionKey
      )
    ) {
      return null;
    }

    const payloadPath = payloadPathFor(
      request.workspaceRoot,
      diskValue.searchManifest.integrity.payloadSha256
    );
    const file = await (deps.openSearchPayload ?? defaultOpenSearchPayload)(payloadPath);
    let payloadIdentity: AssemblyAnnotationSearchPayloadIdentityV2;
    try {
      payloadIdentity = await authenticateLegacyPayload(file, diskValue);
    } finally {
      await file.close().catch(() => undefined);
    }
    if (
      !payloadIdentityMatchesFileStat(
        payloadIdentity,
        await (deps.statSearchPayload ?? defaultStatSearchPayload)(payloadPath)
      ) ||
      (await currentSourceFingerprint(request, deps)) !== sourceFingerprint
    ) {
      return null;
    }

    const diskManifest: AssemblyAnnotationSearchDiskManifestV2 = {
      version: ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2,
      compilerSemantics: ASSEMBLY_ANNOTATION_SEARCH_COMPILER_SEMANTICS_V2,
      assemblyId: request.assemblyId,
      fingerprint: sourceFingerprint,
      companionKey: v2CompanionKey,
      placementSignature: placement.placementSignature,
      payloadFile: diskValue.payloadFile,
      payloadIdentity,
      byteCount: diskValue.byteCount,
      searchManifest: diskValue.searchManifest,
    };
    const tempToken = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tempManifestPath = `${v2ManifestPath}.tmp-${tempToken}`;
    const writeFn = deps.writeFileImpl ?? defaultWrite;
    const renameFn = deps.renameImpl ?? defaultRename;
    const unlinkFn = deps.unlinkImpl ?? defaultUnlink;
    let tempManifestExists = false;
    await (deps.mkdirImpl ?? defaultMkdir)(searchCacheDir(request.workspaceRoot));
    try {
      await writeFn(tempManifestPath, JSON.stringify(diskManifest, null, 2));
      tempManifestExists = true;
      if (
        (await currentSourceFingerprint(request, deps)) !== sourceFingerprint ||
        !payloadIdentityMatchesFileStat(
          payloadIdentity,
          await (deps.statSearchPayload ?? defaultStatSearchPayload)(payloadPath)
        )
      ) {
        return null;
      }
      await renameFn(tempManifestPath, v2ManifestPath);
      tempManifestExists = false;
      return {
        status: 'hit',
        fingerprint: sourceFingerprint,
        byteCount: diskValue.byteCount,
        manifest: diskValue.searchManifest,
        payloadPath,
        payloadSha256: diskValue.searchManifest.integrity.payloadSha256,
        payloadIdentity,
      };
    } finally {
      if (tempManifestExists) await unlinkFn(tempManifestPath).catch(() => undefined);
    }
  });
}

export async function migrateLegacyAssemblyAnnotationSearchCacheIndexV1(
  request: AssemblyAnnotationSceneReadRequest,
  deps: AssemblyAnnotationSearchCacheDeps
): Promise<AssemblyAnnotationSearchCacheIndexReadResult | null> {
  try {
    if (!requestIsWellFormed(request)) return null;
    const placement = exactOrderedAssemblyPlacement(request);
    if (!placement) return null;
    for (let attempt = 0; attempt < CACHE_READ_ATTEMPTS; attempt += 1) {
      const sourceFingerprint = await currentSourceFingerprint(request, deps);
      if (!sourceFingerprint) return null;
      const companionKey = searchCompanionKey(request, placement, sourceFingerprint);
      try {
        const hit = await migrateLegacyV1Index(
          request,
          placement,
          sourceFingerprint,
          companionKey,
          deps
        );
        const finalSource = await currentSourceFingerprintWithContinuity(request, deps);
        if (finalSource?.fingerprint !== sourceFingerprint) continue;
        return hit
          ? { ...hit, sourceContinuity: finalSource.sourceContinuity }
          : miss(sourceFingerprint);
      } catch {
        if ((await currentSourceFingerprint(request, deps)) === sourceFingerprint) {
          return miss(sourceFingerprint);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function readAssemblyAnnotationSearchCacheIndex(
  request: AssemblyAnnotationSceneReadRequest,
  deps: AssemblyAnnotationSearchCacheDeps
): Promise<AssemblyAnnotationSearchCacheIndexReadResult | null> {
  try {
    if (!requestIsWellFormed(request)) return null;
    const placement = exactOrderedAssemblyPlacement(request);
    if (!placement) return null;
    for (let attempt = 0; attempt < CACHE_READ_ATTEMPTS; attempt += 1) {
      const sourceFingerprint = await currentSourceFingerprint(request, deps);
      if (!sourceFingerprint) return null;
      const companionKey = searchCompanionKey(request, placement, sourceFingerprint);
      try {
        let hit: AssemblyAnnotationSearchUnsealedIndexHit | null;
        try {
          hit = await readExactV2IndexHit(
            request,
            placement,
            sourceFingerprint,
            companionKey,
            deps
          );
        } catch {
          hit = null;
        }
        const finalSource = await currentSourceFingerprintWithContinuity(request, deps);
        if (finalSource?.fingerprint !== sourceFingerprint) continue;
        return hit
          ? { ...hit, sourceContinuity: finalSource.sourceContinuity }
          : miss(sourceFingerprint);
      } catch {
        if ((await currentSourceFingerprint(request, deps)) === sourceFingerprint) {
          return miss(sourceFingerprint);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function readAssemblyAnnotationSearchCacheResource(
  request: AssemblyAnnotationSceneReadRequest,
  deps: AssemblyAnnotationSearchCacheDeps,
  options: { readonly signal?: AbortSignal } = {}
): Promise<AssemblyAnnotationSearchCacheResourceReadResult | null> {
  for (let attempt = 0; attempt < CACHE_READ_ATTEMPTS; attempt += 1) {
    options.signal?.throwIfAborted();
    const indexed = await readAssemblyAnnotationSearchCacheIndex(request, deps);
    options.signal?.throwIfAborted();
    if (!indexed || indexed.status === 'miss') return indexed;
    try {
      const diskBytes = deps.readFileImpl
        ? await deps.readFileImpl(indexed.payloadPath)
        : await readFile(
            indexed.payloadPath,
            options.signal ? { signal: options.signal } : undefined
          );
      options.signal?.throwIfAborted();
      if (diskBytes.byteLength !== indexed.byteCount) {
        throw new Error('annotation search payload byte count changed');
      }
      const payload = new Uint8Array(diskBytes.byteLength);
      payload.set(diskBytes);
      await validatePrepackedAnnotationSearchIndexV1(indexed.manifest, payload, (bytes) =>
        sha256BoundedNodeV1(bytes, options)
      );
      options.signal?.throwIfAborted();
      const finalPayloadStat = await (deps.statSearchPayload ?? defaultStatSearchPayload)(
        indexed.payloadPath
      );
      if (!payloadIdentityMatchesFileStat(indexed.payloadIdentity, finalPayloadStat)) {
        throw new Error('annotation search payload identity changed during validation');
      }
      const finalSourceFingerprint = await currentSourceFingerprint(request, deps);
      if (finalSourceFingerprint !== indexed.fingerprint) continue;
      return { ...indexed, validatedPayload: payload };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if ((await currentSourceFingerprint(request, deps)) === indexed.fingerprint) {
        return miss(indexed.fingerprint);
      }
    }
  }
  return null;
}

const searchPublicationQueues = new Map<string, Promise<void>>();

async function withSearchPublicationLock<T>(
  manifestPath: string,
  publish: () => Promise<T>
): Promise<T> {
  const previous = searchPublicationQueues.get(manifestPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.catch(() => undefined).then(() => gate);
  searchPublicationQueues.set(manifestPath, tail);
  await previous.catch(() => undefined);
  try {
    return await publish();
  } finally {
    release();
    if (searchPublicationQueues.get(manifestPath) === tail) {
      searchPublicationQueues.delete(manifestPath);
    }
  }
}

export async function writeAssemblyAnnotationSearchCache(
  input: AssemblyAnnotationSearchCacheWriteInput,
  deps: AssemblyAnnotationSearchCacheDeps
): Promise<AssemblyAnnotationSearchCacheWriteResult | null> {
  try {
    const { request } = input;
    if (
      !requestIsWellFormed(request) ||
      !SOURCE_FINGERPRINT.test(input.expectedSourceFingerprint)
    ) {
      return null;
    }
    const placement = exactOrderedAssemblyPlacement(request);
    const payload = copyWirePayload(input.payload);
    if (!placement || !payload) return null;

    await validatePrepackedAnnotationSearchIndexV1(input.manifest, payload, sha256BoundedNodeV1);
    return await publishValidatedAssemblyAnnotationSearchCache(
      {
        request,
        expectedSourceFingerprint: input.expectedSourceFingerprint,
        manifest: input.manifest,
        payload,
        placement,
      },
      deps
    );
  } catch {
    return null;
  }
}

export async function packAssemblyAnnotationSearchCachePayload(input: {
  readonly request: AssemblyAnnotationSceneReadRequest;
  readonly expectedSourceFingerprint: string;
  readonly features: ReadonlyArray<IndexableAnnotationSearchFeatureV1>;
  readonly onProgress?: (progress: PrepackedAnnotationSearchPackProgressV1) => void;
}): Promise<AssemblyAnnotationSearchPackedPayloadV1 | null> {
  const placement = exactOrderedAssemblyPlacement(input.request);
  if (
    !requestIsWellFormed(input.request) ||
    !SOURCE_FINGERPRINT.test(input.expectedSourceFingerprint) ||
    !placement
  ) {
    return null;
  }
  const packed = await packPrepackedAnnotationSearchIndexV1({
    datasetContract: input.request.datasetContract,
    assemblyContract: {
      assemblyId: input.request.assemblyId,
      assemblyLengthBp: placement.assemblyLengthBp,
      placementSignature: placement.placementSignature,
      sourceFingerprint: input.expectedSourceFingerprint,
    },
    trackType: ASSEMBLY_ANNOTATION_SEARCH_TRACK_TYPE,
    features: input.features,
    payloadSha256: sha256BoundedNodeV1,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
  return Object.assign(packed, {
    [ASSEMBLY_ANNOTATION_SEARCH_PACKED_PAYLOAD]: true as const,
  });
}

export async function writePackedAssemblyAnnotationSearchCache(
  input: {
    readonly request: AssemblyAnnotationSceneReadRequest;
    readonly expectedSourceFingerprint: string;
    readonly packed: AssemblyAnnotationSearchPackedPayloadV1;
  },
  deps: AssemblyAnnotationSearchCacheDeps
): Promise<AssemblyAnnotationSearchCacheWriteResult | null> {
  try {
    const placement = exactOrderedAssemblyPlacement(input.request);
    if (
      !requestIsWellFormed(input.request) ||
      !SOURCE_FINGERPRINT.test(input.expectedSourceFingerprint) ||
      !placement ||
      input.packed?.[ASSEMBLY_ANNOTATION_SEARCH_PACKED_PAYLOAD] !== true
    ) {
      return null;
    }
    return await publishValidatedAssemblyAnnotationSearchCache(
      {
        request: input.request,
        expectedSourceFingerprint: input.expectedSourceFingerprint,
        manifest: input.packed.manifest,
        payload: input.packed.payload,
        placement,
      },
      deps
    );
  } catch {
    return null;
  }
}

async function publishValidatedAssemblyAnnotationSearchCache(
  input: {
    readonly request: AssemblyAnnotationSceneReadRequest;
    readonly expectedSourceFingerprint: string;
    readonly manifest: PrepackedAnnotationSearchIndexManifestV1;
    readonly payload: Uint8Array;
    readonly placement: AssemblyAnnotationSearchPlacement;
  },
  deps: AssemblyAnnotationSearchCacheDeps
): Promise<AssemblyAnnotationSearchCacheWriteResult | null> {
  const { request, payload, placement } = input;
  if (
    !manifestMatchesRequest(
      input.manifest,
      request,
      placement,
      input.expectedSourceFingerprint,
      payload.byteLength
    ) ||
    (await currentSourceFingerprint(request, deps)) !== input.expectedSourceFingerprint
  ) {
    return null;
  }

  const sourceFingerprint = input.expectedSourceFingerprint;
  const companionKey = searchCompanionKey(request, placement, sourceFingerprint);
  const manifestPath = manifestPathFor(request.workspaceRoot, companionKey);
  const payloadSha256 = input.manifest.integrity.payloadSha256;
  const payloadPath = payloadPathFor(request.workspaceRoot, payloadSha256);
  const payloadFile = payloadFileFor(payloadSha256);
  const dir = searchCacheDir(request.workspaceRoot);

  return withSearchPublicationLock(manifestPath, async () => {
    if ((await currentSourceFingerprint(request, deps)) !== sourceFingerprint) return null;
    const tempToken = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tempPayloadPath = `${payloadPath}.tmp-${tempToken}`;
    const tempManifestPath = `${manifestPath}.tmp-${tempToken}`;
    const writeFn = deps.writeFileImpl ?? defaultWrite;
    const renameFn = deps.renameImpl ?? defaultRename;
    const unlinkFn = deps.unlinkImpl ?? defaultUnlink;
    let tempPayloadExists = false;
    let tempManifestExists = false;

    await (deps.mkdirImpl ?? defaultMkdir)(dir);
    try {
      await writeFn(
        tempPayloadPath,
        Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
      );
      tempPayloadExists = true;
      if ((await currentSourceFingerprint(request, deps)) !== sourceFingerprint) return null;

      await renameFn(tempPayloadPath, payloadPath);
      tempPayloadExists = false;
      const payloadIdentity = payloadIdentityFromFileStat(
        await (deps.statSearchPayload ?? defaultStatSearchPayload)(payloadPath)
      );
      if (!payloadIdentity || payloadIdentity.size !== String(payload.byteLength)) {
        throw new Error('annotation search published payload identity is invalid');
      }
      const diskManifest: AssemblyAnnotationSearchDiskManifestV2 = {
        version: ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2,
        compilerSemantics: ASSEMBLY_ANNOTATION_SEARCH_COMPILER_SEMANTICS_V2,
        assemblyId: request.assemblyId,
        fingerprint: sourceFingerprint,
        companionKey,
        placementSignature: placement.placementSignature,
        payloadFile,
        payloadIdentity,
        byteCount: payload.byteLength,
        searchManifest: input.manifest,
      };
      await writeFn(tempManifestPath, JSON.stringify(diskManifest, null, 2));
      tempManifestExists = true;
      if ((await currentSourceFingerprint(request, deps)) !== sourceFingerprint) return null;
      await renameFn(tempManifestPath, manifestPath);
      tempManifestExists = false;
      return {
        fingerprint: sourceFingerprint,
        byteCount: payload.byteLength,
        manifestPath,
        payloadPath,
        payloadIdentity,
      };
    } finally {
      if (tempPayloadExists) await unlinkFn(tempPayloadPath).catch(() => undefined);
      if (tempManifestExists) await unlinkFn(tempManifestPath).catch(() => undefined);
    }
  });
}

export function payloadIdentityFromFileStat(
  fileStat: AssemblyAnnotationSearchPayloadFileStatV2
): AssemblyAnnotationSearchPayloadIdentityV2 | null {
  if (
    !fileStat ||
    typeof fileStat.size !== 'bigint' ||
    typeof fileStat.mtimeNs !== 'bigint' ||
    typeof fileStat.ctimeNs !== 'bigint' ||
    typeof fileStat.ino !== 'bigint' ||
    typeof fileStat.dev !== 'bigint' ||
    fileStat.size < 0n ||
    fileStat.ino < 0n ||
    fileStat.dev < 0n
  ) {
    return null;
  }
  return {
    size: fileStat.size.toString(),
    mtimeNs: fileStat.mtimeNs.toString(),
    ctimeNs: fileStat.ctimeNs.toString(),
    ino: fileStat.ino.toString(),
    dev: fileStat.dev.toString(),
  };
}

export function payloadIdentityMatchesFileStat(
  identity: AssemblyAnnotationSearchPayloadIdentityV2,
  fileStat: AssemblyAnnotationSearchPayloadFileStatV2
): boolean {
  const observed = payloadIdentityFromFileStat(fileStat);
  return observed !== null && payloadIdentitiesEqual(identity, observed);
}

export function payloadIdentitiesEqual(
  left: AssemblyAnnotationSearchPayloadIdentityV2,
  right: AssemblyAnnotationSearchPayloadIdentityV2
): boolean {
  return (
    payloadIdentityIsWellFormed(left) &&
    payloadIdentityIsWellFormed(right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.ino === right.ino &&
    left.dev === right.dev
  );
}

function payloadIdentityIsWellFormed(
  value: AssemblyAnnotationSearchPayloadIdentityV2 | null | undefined
): value is AssemblyAnnotationSearchPayloadIdentityV2 {
  const unsignedInteger = /^(0|[1-9][0-9]*)$/;
  const signedInteger = /^-?(0|[1-9][0-9]*)$/;
  return Boolean(
    value &&
    unsignedInteger.test(value.size) &&
    signedInteger.test(value.mtimeNs) &&
    signedInteger.test(value.ctimeNs) &&
    unsignedInteger.test(value.ino) &&
    unsignedInteger.test(value.dev)
  );
}

function copyWirePayload(payload: Uint8Array | ArrayBuffer): Uint8Array | null {
  if (!(payload instanceof ArrayBuffer) && !(payload instanceof Uint8Array)) return null;
  const source = payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}
