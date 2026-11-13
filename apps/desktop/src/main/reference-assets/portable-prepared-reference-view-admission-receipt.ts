import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  PREPACKED_ANNOTATION_SEARCH_INDEX_V1,
  PREPACKED_PROTEIN_SEARCH_INDEX_V1,
} from '@waypoint/genome-data';

import {
  payloadIdentityFromFileStat,
  type AssemblyAnnotationSearchPayloadIdentityV2,
} from '../ipc/assembly-annotation-search-cache';

const PORTABLE_PREPARED_REFERENCE_VIEW_ADMISSION_RECEIPT_V1 =
  'dnaforge-portable-prepared-reference-view-admission-receipt.v1' as const;
const SHA256 = /^[0-9a-f]{64}$/;

export const PORTABLE_PREPARED_REFERENCE_VIEW_ADMISSION_RULES_V1 = [
  'portable-view-admission-rules.v1',
  PREPACKED_ANNOTATION_SEARCH_INDEX_V1,
  PREPACKED_PROTEIN_SEARCH_INDEX_V1,
].join('|');

export const PORTABLE_PREPARED_REFERENCE_VIEW_ADMISSION_RECEIPT_FILE_V1 =
  'portable-view-admission.v1.json' as const;

export interface PortablePreparedReferenceViewAdmissionPayloadV1 {
  readonly kind: 'annotation' | 'protein';
  readonly objectId: string;
  readonly installPath: string;
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface PortablePreparedReferenceViewAdmissionReceiptInputV1 {
  readonly generationRoot: string;
  readonly assemblyId: string;
  readonly bundleFingerprint: string;
  readonly runtimeSourceFingerprint: string;
  readonly payloads: readonly PortablePreparedReferenceViewAdmissionPayloadV1[];
}

export type PortablePreparedReferenceViewAdmissionReceiptProbeV1 =
  | Readonly<{ status: 'hit' }>
  | Readonly<{ status: 'miss'; reason: string }>;

interface PortablePreparedReferenceViewAdmissionReceiptBodyV1 {
  readonly contract: typeof PORTABLE_PREPARED_REFERENCE_VIEW_ADMISSION_RECEIPT_V1;
  readonly assemblyId: string;
  readonly bundleFingerprint: string;
  readonly runtimeSourceFingerprint: string;
  readonly payloads: readonly Readonly<{
    kind: 'annotation' | 'protein';
    objectId: string;
    installPath: string;
    byteLength: number;
    sha256: string;
    fileIdentity: AssemblyAnnotationSearchPayloadIdentityV2;
  }>[];
}

interface PortablePreparedReferenceViewAdmissionReceiptDiskV1 extends PortablePreparedReferenceViewAdmissionReceiptBodyV1 {
  readonly seal: Readonly<{
    algorithm: 'sha256';
    digest: string;
  }>;
}

export async function writePortablePreparedReferenceViewAdmissionReceiptV1(
  input: PortablePreparedReferenceViewAdmissionReceiptInputV1
): Promise<void> {
  const body = await receiptBody(input);
  const receipt: PortablePreparedReferenceViewAdmissionReceiptDiskV1 = {
    ...body,
    seal: { algorithm: 'sha256', digest: receiptBodyDigest(body) },
  };
  const receiptPath = await receiptPathForWrite(input.generationRoot);
  const temporaryPath = `${receiptPath}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, receiptPath);
    const directory = await open(dirname(receiptPath), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function readPortablePreparedReferenceViewAdmissionReceiptV1(
  input: PortablePreparedReferenceViewAdmissionReceiptInputV1
): Promise<PortablePreparedReferenceViewAdmissionReceiptProbeV1> {
  try {
    const expected = await receiptBody(input);
    const receiptPath = join(
      await realpath(resolve(input.generationRoot)),
      '.readiness',
      PORTABLE_PREPARED_REFERENCE_VIEW_ADMISSION_RECEIPT_FILE_V1
    );
    const parsed = JSON.parse(await readFile(receiptPath, 'utf8')) as unknown;
    if (!isReceipt(parsed)) return { status: 'miss', reason: 'receipt-invalid' };
    const { seal, ...body } = parsed;
    if (seal.digest !== receiptBodyDigest(body)) {
      return { status: 'miss', reason: 'receipt-seal-mismatch' };
    }
    if (JSON.stringify(body) !== JSON.stringify(expected)) {
      return { status: 'miss', reason: 'receipt-identity-mismatch' };
    }
    return { status: 'hit' };
  } catch {
    return { status: 'miss', reason: 'receipt-unavailable' };
  }
}

async function receiptBody(
  input: PortablePreparedReferenceViewAdmissionReceiptInputV1
): Promise<PortablePreparedReferenceViewAdmissionReceiptBodyV1> {
  validateEnvelope(input);
  const canonicalGenerationRoot = await realpath(resolve(input.generationRoot));
  const payloads = [...input.payloads]
    .sort((left, right) => left.kind.localeCompare(right.kind))
    .map(async (payload) => {
      const expectedPath = resolve(canonicalGenerationRoot, payload.installPath);
      assertAtOrBelow(canonicalGenerationRoot, expectedPath);
      const metadata = await lstat(payload.path, { bigint: true });
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error('Portable view-admission payload is not a regular file.');
      }
      const canonicalPayloadPath = await realpath(payload.path);
      if (canonicalPayloadPath !== expectedPath || metadata.size !== BigInt(payload.byteLength)) {
        throw new Error('Portable view-admission payload identity changed.');
      }
      const fileIdentity = payloadIdentityFromFileStat(metadata);
      if (!fileIdentity) throw new Error('Portable view-admission payload stat is invalid.');
      return {
        kind: payload.kind,
        objectId: payload.objectId,
        installPath: payload.installPath,
        byteLength: payload.byteLength,
        sha256: payload.sha256,
        fileIdentity,
      };
    });
  return {
    contract: PORTABLE_PREPARED_REFERENCE_VIEW_ADMISSION_RECEIPT_V1,
    assemblyId: input.assemblyId,
    bundleFingerprint: input.bundleFingerprint,
    runtimeSourceFingerprint: input.runtimeSourceFingerprint,
    payloads: await Promise.all(payloads),
  };
}

function validateEnvelope(input: PortablePreparedReferenceViewAdmissionReceiptInputV1): void {
  const kinds = input.payloads
    .map(({ kind }) => kind)
    .sort()
    .join(',');
  if (
    !input.assemblyId ||
    !SHA256.test(input.bundleFingerprint) ||
    !input.runtimeSourceFingerprint ||
    input.runtimeSourceFingerprint.length > 512 ||
    kinds !== 'annotation,protein' ||
    input.payloads.some(
      (payload) =>
        !payload.objectId ||
        !payload.installPath ||
        isAbsolute(payload.installPath) ||
        !Number.isSafeInteger(payload.byteLength) ||
        payload.byteLength < 0 ||
        !SHA256.test(payload.sha256)
    )
  ) {
    throw new Error('Portable view-admission receipt input is invalid.');
  }
}

function isReceipt(value: unknown): value is PortablePreparedReferenceViewAdmissionReceiptDiskV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (
    Object.keys(receipt).sort().join(',') !==
      'assemblyId,bundleFingerprint,contract,payloads,runtimeSourceFingerprint,seal' ||
    receipt.contract !== PORTABLE_PREPARED_REFERENCE_VIEW_ADMISSION_RECEIPT_V1 ||
    typeof receipt.assemblyId !== 'string' ||
    !SHA256.test(String(receipt.bundleFingerprint)) ||
    typeof receipt.runtimeSourceFingerprint !== 'string' ||
    !Array.isArray(receipt.payloads) ||
    receipt.payloads.length !== 2
  ) {
    return false;
  }
  if (
    receipt.payloads.some((payload) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return true;
      const member = payload as Record<string, unknown>;
      return (
        Object.keys(member).sort().join(',') !==
          'byteLength,fileIdentity,installPath,kind,objectId,sha256' ||
        (member.kind !== 'annotation' && member.kind !== 'protein') ||
        typeof member.objectId !== 'string' ||
        typeof member.installPath !== 'string' ||
        !Number.isSafeInteger(member.byteLength) ||
        !SHA256.test(String(member.sha256)) ||
        !isPayloadIdentity(member.fileIdentity)
      );
    })
  ) {
    return false;
  }
  const seal = receipt.seal;
  return Boolean(
    seal &&
    typeof seal === 'object' &&
    !Array.isArray(seal) &&
    Object.keys(seal).sort().join(',') === 'algorithm,digest' &&
    (seal as Record<string, unknown>).algorithm === 'sha256' &&
    SHA256.test(String((seal as Record<string, unknown>).digest))
  );
}

function isPayloadIdentity(value: unknown): value is AssemblyAnnotationSearchPayloadIdentityV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return (
    Object.keys(identity).sort().join(',') === 'ctimeNs,dev,ino,mtimeNs,size' &&
    Object.values(identity).every((entry) => typeof entry === 'string' && /^\d+$/u.test(entry))
  );
}

function receiptBodyDigest(body: PortablePreparedReferenceViewAdmissionReceiptBodyV1): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

async function receiptPathForWrite(generationRoot: string): Promise<string> {
  const root = await realpath(resolve(generationRoot));
  const readiness = join(root, '.readiness');
  await mkdir(readiness, { recursive: true, mode: 0o700 });
  if ((await realpath(readiness)) !== readiness) {
    throw new Error('Portable view-admission receipt directory is not canonical.');
  }
  return join(readiness, PORTABLE_PREPARED_REFERENCE_VIEW_ADMISSION_RECEIPT_FILE_V1);
}

function assertAtOrBelow(root: string, path: string): void {
  const relativePath = relative(root, path);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('Portable view-admission payload escapes its generation.');
  }
}
