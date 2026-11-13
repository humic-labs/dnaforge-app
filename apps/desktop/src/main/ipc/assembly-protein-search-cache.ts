import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';

import {
  PREPACKED_PROTEIN_SEARCH_CONTRACT_TOKEN,
  PREPACKED_PROTEIN_SEARCH_INDEX_V1,
  unpackPrepackedProteinSearchIndexV1,
  type PrepackedProteinSearchIndexManifestV1,
} from '@waypoint/genome-data';

import { joinPath } from '../../features/sequence/indexed-genome-paths';
import type { AssemblyAnnotationSceneReadRequest } from '../../shared/indexed-genome';
import {
  assemblyAnnotationSearchPlacement,
  payloadIdentityFromFileStat,
  payloadIdentityMatchesFileStat,
  type AssemblyAnnotationSearchPayloadFileStatV2,
  type AssemblyAnnotationSearchPayloadIdentityV2,
  type AssemblyAnnotationSearchSourceContinuityEntryV1,
} from './assembly-annotation-search-cache';
import { sha256BoundedNodeV1 } from './bounded-binary-sha256';
import {
  ASSEMBLY_PROTEIN_SEARCH_COMPILER_SEMANTICS_V2,
  ASSEMBLY_PROTEIN_SEARCH_MAX_QUARANTINE_DIAGNOSTICS_V1,
  type ProteinSearchCompilerWorkV1,
  type ProteinSearchIsoformQuarantineReasonV1,
} from './assembly-protein-search-compiler';
import {
  resolveAssemblyProteinSearchSourceRevisionV1,
  type AssemblyProteinSearchSourceDeps,
} from './assembly-protein-search-source';

export const ASSEMBLY_PROTEIN_SEARCH_CACHE_V1 = 'assembly-protein-search-cache.v1' as const;

export interface AssemblyProteinSearchCacheMiss {
  status: 'miss';
  fingerprint: string;
}

export interface AssemblyProteinSearchCacheIndexHit {
  status: 'hit';
  fingerprint: string;
  byteCount: number;
  work: ProteinSearchCompilerWorkV1;
  manifest: PrepackedProteinSearchIndexManifestV1;
  payloadPath: string;
  payloadSha256: string;
  payloadIdentity: AssemblyAnnotationSearchPayloadIdentityV2;
  sourceContinuity: readonly AssemblyAnnotationSearchSourceContinuityEntryV1[];
}

export type AssemblyProteinSearchCacheIndexReadResult =
  | AssemblyProteinSearchCacheMiss
  | AssemblyProteinSearchCacheIndexHit;

export interface AssemblyProteinSearchCacheResourceHit extends AssemblyProteinSearchCacheIndexHit {
  validatedPayload: Uint8Array;
}

export type AssemblyProteinSearchCacheResourceReadResult =
  | AssemblyProteinSearchCacheMiss
  | AssemblyProteinSearchCacheResourceHit;

export interface AssemblyProteinSearchCacheWriteInput {
  request: AssemblyAnnotationSceneReadRequest;
  expectedSourceFingerprint: string;
  manifest: PrepackedProteinSearchIndexManifestV1;
  payload: Uint8Array | ArrayBuffer;
  work: ProteinSearchCompilerWorkV1;
}

export interface AssemblyProteinSearchCacheWriteResult {
  fingerprint: string;
  byteCount: number;
  manifestPath: string;
  payloadPath: string;
  payloadIdentity: AssemblyAnnotationSearchPayloadIdentityV2;
}

interface SourceStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs?: number;
}

export interface AssemblyProteinSearchCacheDeps {
  readonly assertSafePath: (path: string) => Promise<void>;
  readonly statSource?: (path: string) => Promise<SourceStat>;
  readonly statPayload?: (path: string) => Promise<AssemblyAnnotationSearchPayloadFileStatV2>;
  readonly readFileImpl?: typeof readFile;
  readonly writeFileImpl?: typeof writeFile;
  readonly renameImpl?: typeof rename;
  readonly unlinkImpl?: typeof unlink;
  readonly mkdirImpl?: typeof mkdir;
}

interface AssemblyProteinSearchDiskManifestV1 {
  version: typeof ASSEMBLY_PROTEIN_SEARCH_CACHE_V1;
  assemblyId: string;
  fingerprint: string;
  companionKey: string;
  placementSignature: string;
  payloadFile: string;
  payloadIdentity: AssemblyAnnotationSearchPayloadIdentityV2;
  byteCount: number;
  searchManifest: PrepackedProteinSearchIndexManifestV1;
  compilerSemantics: typeof ASSEMBLY_PROTEIN_SEARCH_COMPILER_SEMANTICS_V2;
  work: ProteinSearchCompilerWorkV1;
}

const SOURCE_FINGERPRINT = /^[0-9a-f]{24}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CACHE_READ_ATTEMPTS = 3;
const publicationQueues = new Map<string, Promise<void>>();
const defaultStatPayload: NonNullable<AssemblyProteinSearchCacheDeps['statPayload']> = (path) =>
  stat(path, { bigint: true });

export async function readAssemblyProteinSearchCacheIndex(
  request: AssemblyAnnotationSceneReadRequest,
  deps: AssemblyProteinSearchCacheDeps
): Promise<AssemblyProteinSearchCacheIndexReadResult | null> {
  try {
    const placement = assemblyAnnotationSearchPlacement(request.chromosomes);
    if (!placement) return null;
    for (let attempt = 0; attempt < CACHE_READ_ATTEMPTS; attempt += 1) {
      const revision = await sourceRevision(request, deps);
      if (!revision) return null;
      const companionKey = proteinCompanionKey(request, revision.fingerprint);
      try {
        const disk = JSON.parse(
          (
            await (deps.readFileImpl ?? readFile)(
              proteinManifestPath(request.workspaceRoot, companionKey)
            )
          ).toString('utf8')
        ) as unknown;
        if (
          !diskManifestMatchesRequest(disk, request, placement, revision.fingerprint, companionKey)
        ) {
          return miss(revision.fingerprint);
        }
        const payloadPath = proteinPayloadPath(
          request.workspaceRoot,
          disk.searchManifest.integrity.payloadSha256
        );
        await deps.assertSafePath(payloadPath);
        if (
          !payloadIdentityMatchesFileStat(
            disk.payloadIdentity,
            await (deps.statPayload ?? defaultStatPayload)(payloadPath)
          )
        ) {
          return miss(revision.fingerprint);
        }
        const finalRevision = await sourceRevision(request, deps);
        if (!finalRevision) return null;
        if (finalRevision.fingerprint !== revision.fingerprint) continue;
        return {
          status: 'hit',
          fingerprint: revision.fingerprint,
          byteCount: disk.byteCount,
          work: disk.work,
          manifest: disk.searchManifest,
          payloadPath,
          payloadSha256: disk.searchManifest.integrity.payloadSha256,
          payloadIdentity: disk.payloadIdentity,
          sourceContinuity: finalRevision.sourceContinuity,
        };
      } catch {
        const finalRevision = await sourceRevision(request, deps);
        if (!finalRevision) return null;
        if (finalRevision.fingerprint !== revision.fingerprint) continue;
        return miss(revision.fingerprint);
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function readAssemblyProteinSearchCacheResource(
  request: AssemblyAnnotationSceneReadRequest,
  deps: AssemblyProteinSearchCacheDeps,
  options: { readonly signal?: AbortSignal } = {}
): Promise<AssemblyProteinSearchCacheResourceReadResult | null> {
  for (let attempt = 0; attempt < CACHE_READ_ATTEMPTS; attempt += 1) {
    options.signal?.throwIfAborted();
    const indexed = await readAssemblyProteinSearchCacheIndex(request, deps);
    options.signal?.throwIfAborted();
    if (!indexed || indexed.status === 'miss') return indexed;
    try {
      const disk = deps.readFileImpl
        ? await deps.readFileImpl(indexed.payloadPath)
        : await readFile(
            indexed.payloadPath,
            options.signal ? { signal: options.signal } : undefined
          );
      options.signal?.throwIfAborted();
      if (disk.byteLength !== indexed.byteCount) throw new Error('protein payload size changed');
      const payload = new Uint8Array(disk.byteLength);
      payload.set(disk);
      await unpackPrepackedProteinSearchIndexV1(indexed.manifest, payload, (bytes) =>
        sha256BoundedNodeV1(bytes, options)
      );
      options.signal?.throwIfAborted();
      if (
        !payloadIdentityMatchesFileStat(
          indexed.payloadIdentity,
          await (deps.statPayload ?? defaultStatPayload)(indexed.payloadPath)
        )
      ) {
        throw new Error('protein payload identity changed during validation');
      }
      const finalRevision = await sourceRevision(request, deps);
      if (finalRevision?.fingerprint !== indexed.fingerprint) continue;
      return {
        ...indexed,
        sourceContinuity: finalRevision.sourceContinuity,
        validatedPayload: payload,
      };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const finalRevision = await sourceRevision(request, deps);
      if (finalRevision?.fingerprint === indexed.fingerprint) {
        return miss(indexed.fingerprint);
      }
    }
  }
  return null;
}

export async function writeAssemblyProteinSearchCache(
  input: AssemblyProteinSearchCacheWriteInput,
  deps: AssemblyProteinSearchCacheDeps
): Promise<AssemblyProteinSearchCacheWriteResult | null> {
  try {
    if (!SOURCE_FINGERPRINT.test(input.expectedSourceFingerprint)) return null;
    const placement = assemblyAnnotationSearchPlacement(input.request.chromosomes);
    const payload = copyPayload(input.payload);
    if (!placement || !payload) return null;
    if (!isProteinSearchCompilerWorkV1(input.work, input.manifest.featureCount)) return null;
    await unpackPrepackedProteinSearchIndexV1(input.manifest, payload, sha256BoundedNodeV1);
    if (
      !manifestMatchesRequest(
        input.manifest,
        input.request,
        placement,
        input.expectedSourceFingerprint,
        payload.byteLength
      ) ||
      (await sourceRevision(input.request, deps))?.fingerprint !== input.expectedSourceFingerprint
    ) {
      return null;
    }

    const companionKey = proteinCompanionKey(input.request, input.expectedSourceFingerprint);
    const manifestPath = proteinManifestPath(input.request.workspaceRoot, companionKey);
    const payloadPath = proteinPayloadPath(
      input.request.workspaceRoot,
      input.manifest.integrity.payloadSha256
    );
    const payloadFile = proteinPayloadFile(input.manifest.integrity.payloadSha256);
    return await withPublicationLock(manifestPath, async () => {
      if (
        (await sourceRevision(input.request, deps))?.fingerprint !== input.expectedSourceFingerprint
      ) {
        return null;
      }
      const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const temporaryPayloadPath = `${payloadPath}.tmp-${token}`;
      const temporaryManifestPath = `${manifestPath}.tmp-${token}`;
      const write = deps.writeFileImpl ?? writeFile;
      const move = deps.renameImpl ?? rename;
      const remove = deps.unlinkImpl ?? unlink;
      let temporaryPayloadExists = false;
      let temporaryManifestExists = false;
      await (deps.mkdirImpl ?? mkdir)(proteinCacheDir(input.request.workspaceRoot), {
        recursive: true,
      });
      try {
        await write(
          temporaryPayloadPath,
          Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
        );
        temporaryPayloadExists = true;
        if (
          (await sourceRevision(input.request, deps))?.fingerprint !==
          input.expectedSourceFingerprint
        ) {
          return null;
        }
        await move(temporaryPayloadPath, payloadPath);
        temporaryPayloadExists = false;
        const payloadIdentity = payloadIdentityFromFileStat(
          await (deps.statPayload ?? defaultStatPayload)(payloadPath)
        );
        if (!payloadIdentity || payloadIdentity.size !== String(payload.byteLength)) {
          throw new Error('protein payload identity is invalid');
        }
        const disk: AssemblyProteinSearchDiskManifestV1 = {
          version: ASSEMBLY_PROTEIN_SEARCH_CACHE_V1,
          assemblyId: input.request.assemblyId,
          fingerprint: input.expectedSourceFingerprint,
          companionKey,
          placementSignature: placement.placementSignature,
          payloadFile,
          payloadIdentity,
          byteCount: payload.byteLength,
          searchManifest: input.manifest,
          compilerSemantics: ASSEMBLY_PROTEIN_SEARCH_COMPILER_SEMANTICS_V2,
          work: input.work,
        };
        await write(temporaryManifestPath, JSON.stringify(disk, null, 2));
        temporaryManifestExists = true;
        if (
          (await sourceRevision(input.request, deps))?.fingerprint !==
          input.expectedSourceFingerprint
        ) {
          return null;
        }
        await move(temporaryManifestPath, manifestPath);
        temporaryManifestExists = false;
        return {
          fingerprint: input.expectedSourceFingerprint,
          byteCount: payload.byteLength,
          manifestPath,
          payloadPath,
          payloadIdentity,
        };
      } finally {
        if (temporaryPayloadExists) {
          await remove(temporaryPayloadPath).catch(() => undefined);
        }
        if (temporaryManifestExists) {
          await remove(temporaryManifestPath).catch(() => undefined);
        }
      }
    });
  } catch {
    return null;
  }
}

function proteinCacheDir(workspaceRoot: string): string {
  return joinPath(workspaceRoot, '.waypoint', 'genome-index', 'assembly-overview');
}

function proteinManifestPath(workspaceRoot: string, companionKey: string): string {
  return joinPath(proteinCacheDir(workspaceRoot), `protein-search-${companionKey}.v1.json`);
}

function proteinPayloadFile(payloadSha256: string): string {
  return `protein-search-${payloadSha256}.v1.bin`;
}

function proteinPayloadPath(workspaceRoot: string, payloadSha256: string): string {
  return joinPath(proteinCacheDir(workspaceRoot), proteinPayloadFile(payloadSha256));
}

function proteinCompanionKey(
  request: AssemblyAnnotationSceneReadRequest,
  fingerprint: string
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        ASSEMBLY_PROTEIN_SEARCH_CACHE_V1,
        PREPACKED_PROTEIN_SEARCH_INDEX_V1,
        PREPACKED_PROTEIN_SEARCH_CONTRACT_TOKEN,
        ASSEMBLY_PROTEIN_SEARCH_COMPILER_SEMANTICS_V2,
        request.assemblyId,
        request.datasetContract,
        fingerprint,
      ])
    )
    .digest('hex');
}

function manifestMatchesRequest(
  manifest: PrepackedProteinSearchIndexManifestV1 | null | undefined,
  request: AssemblyAnnotationSceneReadRequest,
  placement: NonNullable<ReturnType<typeof assemblyAnnotationSearchPlacement>>,
  fingerprint: string,
  byteCount: number
): manifest is PrepackedProteinSearchIndexManifestV1 {
  return Boolean(
    manifest &&
    manifest.schema === PREPACKED_PROTEIN_SEARCH_INDEX_V1 &&
    manifest.searchContract?.contractToken === PREPACKED_PROTEIN_SEARCH_CONTRACT_TOKEN &&
    manifest.datasetContract?.datasetId === request.datasetContract.datasetId &&
    manifest.datasetContract.datasetVersion === request.datasetContract.datasetVersion &&
    manifest.datasetContract.sourceSha256 === request.datasetContract.sourceSha256 &&
    manifest.assemblyContract?.assemblyId === request.assemblyId &&
    manifest.assemblyContract.assemblyLengthBp === placement.assemblyLengthBp &&
    manifest.assemblyContract.placementSignature === placement.placementSignature &&
    manifest.assemblyContract.sourceFingerprint === fingerprint &&
    manifest.byteLength === byteCount &&
    Number.isSafeInteger(manifest.featureCount) &&
    manifest.featureCount >= 0 &&
    manifest.integrity?.algorithm === 'sha256' &&
    SHA256_HEX.test(manifest.integrity.payloadSha256 ?? '') &&
    SHA256_HEX.test(manifest.integrity.contractSha256 ?? '')
  );
}

function diskManifestMatchesRequest(
  value: unknown,
  request: AssemblyAnnotationSceneReadRequest,
  placement: NonNullable<ReturnType<typeof assemblyAnnotationSearchPlacement>>,
  fingerprint: string,
  companionKey: string
): value is AssemblyProteinSearchDiskManifestV1 {
  if (!value || typeof value !== 'object') return false;
  const disk = value as Partial<AssemblyProteinSearchDiskManifestV1>;
  const payloadSha256 = disk.searchManifest?.integrity?.payloadSha256;
  return Boolean(
    disk.version === ASSEMBLY_PROTEIN_SEARCH_CACHE_V1 &&
    disk.compilerSemantics === ASSEMBLY_PROTEIN_SEARCH_COMPILER_SEMANTICS_V2 &&
    disk.assemblyId === request.assemblyId &&
    disk.fingerprint === fingerprint &&
    disk.companionKey === companionKey &&
    disk.placementSignature === placement.placementSignature &&
    typeof disk.byteCount === 'number' &&
    Number.isSafeInteger(disk.byteCount) &&
    disk.byteCount >= 0 &&
    typeof payloadSha256 === 'string' &&
    disk.payloadFile === proteinPayloadFile(payloadSha256) &&
    disk.payloadIdentity &&
    disk.payloadIdentity.size === String(disk.byteCount) &&
    isProteinSearchCompilerWorkV1(disk.work, disk.searchManifest?.featureCount) &&
    manifestMatchesRequest(disk.searchManifest, request, placement, fingerprint, disk.byteCount)
  );
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

function copyPayload(payload: Uint8Array | ArrayBuffer): Uint8Array | null {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload.slice(0));
  if (!(payload instanceof Uint8Array)) return null;
  const copy = new Uint8Array(payload.byteLength);
  copy.set(payload);
  return copy;
}

function miss(fingerprint: string): AssemblyProteinSearchCacheMiss {
  return { status: 'miss', fingerprint };
}

async function sourceRevision(
  request: AssemblyAnnotationSceneReadRequest,
  deps: AssemblyProteinSearchCacheDeps
) {
  const sourceDeps: AssemblyProteinSearchSourceDeps = {
    assertSafePath: deps.assertSafePath,
    ...(deps.statSource ? { statImpl: deps.statSource } : {}),
  };
  return resolveAssemblyProteinSearchSourceRevisionV1(request, sourceDeps);
}

async function withPublicationLock<T>(manifestPath: string, publish: () => Promise<T>): Promise<T> {
  const previous = publicationQueues.get(manifestPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.catch(() => undefined).then(() => gate);
  publicationQueues.set(manifestPath, tail);
  await previous.catch(() => undefined);
  try {
    return await publish();
  } finally {
    release();
    if (publicationQueues.get(manifestPath) === tail) publicationQueues.delete(manifestPath);
  }
}
