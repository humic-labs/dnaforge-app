import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

import type { HostedReferenceFirstViewPackAssetV1 } from './hosted-reference-catalog';
import {
  portablePreparedReferenceContentObjectKeyV1,
  portablePreparedReferenceObjectsForTierV1,
  type PortablePreparedReferenceBundleV1,
  type PortablePreparedReferenceObjectV1,
} from './portable-prepared-reference-bundle';

export const PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_FORMAT_V1 =
  'dnaforge-portable-prepared-reference-first-view-pack.br.v1' as const;
export const PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_CONTRACT_V1 =
  'dnaforge-portable-prepared-reference-first-view-pack.v1' as const;
export const PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_TIERS_V1 = ['shell', 'view'] as const;

export const MAX_FIRST_VIEW_PACK_COMPRESSED_BYTES_V1 = 16 * 1024 * 1024;
export const MAX_FIRST_VIEW_PACK_UNCOMPRESSED_BYTES_V1 = 192 * 1024 * 1024;
export const MAX_FIRST_VIEW_PACK_HEADER_BYTES_V1 = 512 * 1024;
export const MAX_FIRST_VIEW_PACK_MEMBERS_V1 = 1_024;

export class PortablePreparedReferenceFirstViewPackCapacityError extends Error {
  readonly name = 'PortablePreparedReferenceFirstViewPackCapacityError';
}

const FRAME_MAGIC = Buffer.from('DF-FVP1\n', 'ascii');
const FRAME_LENGTH_BYTES = 8;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface FirstViewPackMemberIdentityV1 {
  readonly id: string;
  readonly sha256: string;
  readonly byteLength: number;
}

interface FirstViewPackHeaderV1 {
  readonly contract: typeof PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_CONTRACT_V1;
  readonly bundleManifestSha256: string;
  readonly bundleFingerprint: string;
  readonly tiers: typeof PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_TIERS_V1;
  readonly rosterSha256: string;
  readonly members: readonly FirstViewPackMemberIdentityV1[];
}

export interface BuiltPortablePreparedReferenceFirstViewPackV1 {
  readonly bytes: Buffer;
  readonly format: typeof PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_FORMAT_V1;
  readonly bundleManifestSha256: string;
  readonly bundleFingerprint: string;
  readonly tiers: typeof PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_TIERS_V1;
  readonly rosterSha256: string;
  readonly memberCount: number;
  readonly uncompressedByteLength: number;
}

export interface ParsedPortablePreparedReferenceFirstViewPackMemberV1 {
  readonly object: PortablePreparedReferenceObjectV1;
  readonly bytes: Buffer;
}

export function buildPortablePreparedReferenceFirstViewPackV1(input: {
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly memberBytes: ReadonlyMap<string, Uint8Array>;
}): BuiltPortablePreparedReferenceFirstViewPackV1 {
  requireSha256(input.bundleManifestSha256, 'first-view pack bundle manifest SHA-256');
  const objects = firstViewObjects(input.bundle);
  const identities = objects.map(memberIdentity);
  const rosterSha256 = portablePreparedReferenceFirstViewRosterSha256V1(identities);
  const header: FirstViewPackHeaderV1 = {
    contract: PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_CONTRACT_V1,
    bundleManifestSha256: input.bundleManifestSha256,
    bundleFingerprint: input.bundle.bundleFingerprint,
    tiers: PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_TIERS_V1,
    rosterSha256,
    members: identities,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  if (headerBytes.byteLength > MAX_FIRST_VIEW_PACK_HEADER_BYTES_V1) {
    throw new PortablePreparedReferenceFirstViewPackCapacityError(
      'First-view pack header exceeds its bounded byte length.'
    );
  }
  const headerLength = Buffer.allocUnsafe(4);
  headerLength.writeUInt32BE(headerBytes.byteLength);
  const chunks: Buffer[] = [FRAME_MAGIC, headerLength, headerBytes];
  let uncompressedByteLength =
    FRAME_MAGIC.byteLength + headerLength.byteLength + headerBytes.byteLength;
  for (const object of objects) {
    const source = input.memberBytes.get(object.id);
    if (!source) throw new Error(`First-view pack member "${object.id}" has no bytes.`);
    const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    verifyMemberBytes(object, bytes);
    const length = Buffer.allocUnsafe(FRAME_LENGTH_BYTES);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    chunks.push(length, bytes);
    uncompressedByteLength += length.byteLength + bytes.byteLength;
    if (uncompressedByteLength > MAX_FIRST_VIEW_PACK_UNCOMPRESSED_BYTES_V1) {
      throw new PortablePreparedReferenceFirstViewPackCapacityError(
        'First-view pack exceeds its bounded uncompressed byte length.'
      );
    }
  }
  const frame = Buffer.concat(chunks, uncompressedByteLength);
  const bytes = brotliCompressSync(frame, {
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
      [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: frame.byteLength,
    },
  });
  if (bytes.byteLength > MAX_FIRST_VIEW_PACK_COMPRESSED_BYTES_V1) {
    throw new PortablePreparedReferenceFirstViewPackCapacityError(
      'First-view pack exceeds its bounded compressed byte length.'
    );
  }
  return Object.freeze({
    bytes,
    format: PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_FORMAT_V1,
    bundleManifestSha256: input.bundleManifestSha256,
    bundleFingerprint: input.bundle.bundleFingerprint,
    tiers: PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_TIERS_V1,
    rosterSha256,
    memberCount: objects.length,
    uncompressedByteLength,
  });
}

export function parsePortablePreparedReferenceFirstViewPackV1(input: {
  readonly descriptor: HostedReferenceFirstViewPackAssetV1;
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly packBytes: Uint8Array;
}): readonly ParsedPortablePreparedReferenceFirstViewPackMemberV1[] {
  const descriptor = admitPortablePreparedReferenceFirstViewPackDescriptorV1({
    descriptor: input.descriptor,
    bundleManifestSha256: input.bundleManifestSha256,
    bundle: input.bundle,
  });
  const packBytes = Buffer.from(
    input.packBytes.buffer,
    input.packBytes.byteOffset,
    input.packBytes.byteLength
  );
  if (packBytes.byteLength !== descriptor.byteLength) {
    throw new Error('First-view pack byte length does not match its catalog descriptor.');
  }
  if (sha256Bytes(packBytes) !== descriptor.sha256) {
    throw new Error('First-view pack checksum does not match its catalog descriptor.');
  }
  const objects = firstViewObjects(input.bundle);
  const identities = objects.map(memberIdentity);

  let frame: Buffer;
  try {
    frame = brotliDecompressSync(packBytes, {
      maxOutputLength: descriptor.uncompressedByteLength,
    });
  } catch {
    throw new Error('First-view pack Brotli frame could not be expanded within its bound.');
  }
  if (frame.byteLength !== descriptor.uncompressedByteLength) {
    throw new Error('First-view pack expanded byte length does not match its descriptor.');
  }
  if (
    frame.byteLength < FRAME_MAGIC.byteLength + 4 ||
    !frame.subarray(0, FRAME_MAGIC.byteLength).equals(FRAME_MAGIC)
  ) {
    throw new Error('First-view pack frame magic is invalid.');
  }
  const headerLength = frame.readUInt32BE(FRAME_MAGIC.byteLength);
  if (headerLength <= 0 || headerLength > MAX_FIRST_VIEW_PACK_HEADER_BYTES_V1) {
    throw new Error('First-view pack header length is invalid.');
  }
  let cursor = FRAME_MAGIC.byteLength + 4;
  const headerEnd = cursor + headerLength;
  if (headerEnd > frame.byteLength) throw new Error('First-view pack header is truncated.');
  let headerValue: unknown;
  try {
    headerValue = JSON.parse(frame.subarray(cursor, headerEnd).toString('utf8')) as unknown;
  } catch {
    throw new Error('First-view pack header is not valid JSON.');
  }
  const header = parseHeader(headerValue);
  cursor = headerEnd;
  assertHeaderAdmission({
    header,
    descriptor,
    bundleManifestSha256: input.bundleManifestSha256,
    bundleFingerprint: input.bundle.bundleFingerprint,
    identities,
  });

  const parsed: ParsedPortablePreparedReferenceFirstViewPackMemberV1[] = [];
  for (const [index, object] of objects.entries()) {
    if (cursor + FRAME_LENGTH_BYTES > frame.byteLength) {
      throw new Error(`First-view pack member "${object.id}" length frame is truncated.`);
    }
    const framedLength = frame.readBigUInt64BE(cursor);
    cursor += FRAME_LENGTH_BYTES;
    if (framedLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`First-view pack member "${object.id}" length is unsafe.`);
    }
    if (Number(framedLength) !== object.byteLength) {
      throw new Error(`First-view pack member "${object.id}" length frame does not match.`);
    }
    const end = cursor + object.byteLength;
    if (end > frame.byteLength) {
      throw new Error(`First-view pack member "${object.id}" bytes are truncated.`);
    }
    const bytes = frame.subarray(cursor, end);
    cursor = end;
    verifyMemberBytes(object, bytes);
    if (header.members[index]?.id !== object.id) {
      throw new Error('First-view pack member order does not match its header.');
    }
    parsed.push(Object.freeze({ object, bytes }));
  }
  if (cursor !== frame.byteLength) {
    throw new Error('First-view pack has trailing or unknown member bytes.');
  }
  return Object.freeze(parsed);
}

export function admitPortablePreparedReferenceFirstViewPackDescriptorV1(input: {
  readonly descriptor: HostedReferenceFirstViewPackAssetV1;
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
}): HostedReferenceFirstViewPackAssetV1 {
  const descriptor = parseDescriptor(input.descriptor);
  if (descriptor.bundleManifestSha256 !== input.bundleManifestSha256) {
    throw new Error('First-view pack does not match the admitted bundle manifest SHA-256.');
  }
  if (descriptor.bundleFingerprint !== input.bundle.bundleFingerprint) {
    throw new Error('First-view pack does not match the admitted bundle fingerprint.');
  }
  const objects = firstViewObjects(input.bundle);
  const expectedRosterSha256 = portablePreparedReferenceFirstViewRosterSha256V1(
    objects.map(memberIdentity)
  );
  if (
    descriptor.memberCount !== objects.length ||
    descriptor.rosterSha256 !== expectedRosterSha256
  ) {
    throw new Error('First-view pack roster does not match the admitted shell + view closure.');
  }
  return descriptor;
}

export function portablePreparedReferenceFirstViewRosterSha256V1(
  members: readonly FirstViewPackMemberIdentityV1[]
): string {
  return createHash('sha256').update(JSON.stringify(members)).digest('hex');
}

function firstViewObjects(
  bundle: PortablePreparedReferenceBundleV1
): readonly PortablePreparedReferenceObjectV1[] {
  const objects = portablePreparedReferenceObjectsForTierV1(bundle, 'view');
  if (objects.length <= 0) {
    throw new Error('First-view pack member count is outside its admitted bound.');
  }
  if (objects.length > MAX_FIRST_VIEW_PACK_MEMBERS_V1) {
    throw new PortablePreparedReferenceFirstViewPackCapacityError(
      'First-view pack member count is outside its admitted bound.'
    );
  }
  return objects;
}

function memberIdentity(object: PortablePreparedReferenceObjectV1): FirstViewPackMemberIdentityV1 {
  return {
    id: object.id,
    sha256: object.sha256,
    byteLength: object.byteLength,
  };
}

function parseDescriptor(
  value: HostedReferenceFirstViewPackAssetV1
): HostedReferenceFirstViewPackAssetV1 {
  const descriptor = requireRecord(value, 'first-view pack descriptor');
  assertOnlyKeys(
    descriptor,
    [
      'format',
      'relativePath',
      'sha256',
      'byteLength',
      'bundleManifestSha256',
      'bundleFingerprint',
      'tiers',
      'rosterSha256',
      'memberCount',
      'uncompressedByteLength',
    ],
    'first-view pack descriptor'
  );
  if (descriptor.format !== PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_FORMAT_V1) {
    throw new Error('First-view pack format is unsupported.');
  }
  const sha256 = requireSha256(descriptor.sha256, 'first-view pack descriptor.sha256');
  const relativePath = requireText(
    descriptor.relativePath,
    'first-view pack descriptor.relativePath'
  );
  if (relativePath !== portablePreparedReferenceContentObjectKeyV1(sha256)) {
    throw new Error('First-view pack is not at its canonical content-addressed key.');
  }
  const byteLength = requirePositiveInteger(
    descriptor.byteLength,
    'first-view pack descriptor.byteLength'
  );
  if (byteLength > MAX_FIRST_VIEW_PACK_COMPRESSED_BYTES_V1) {
    throw new Error('First-view pack compressed byte length exceeds its bound.');
  }
  const memberCount = requirePositiveInteger(
    descriptor.memberCount,
    'first-view pack descriptor.memberCount'
  );
  if (memberCount > MAX_FIRST_VIEW_PACK_MEMBERS_V1) {
    throw new Error('First-view pack member count exceeds its bound.');
  }
  const uncompressedByteLength = requirePositiveInteger(
    descriptor.uncompressedByteLength,
    'first-view pack descriptor.uncompressedByteLength'
  );
  if (uncompressedByteLength > MAX_FIRST_VIEW_PACK_UNCOMPRESSED_BYTES_V1) {
    throw new Error('First-view pack expanded byte length exceeds its bound.');
  }
  if (
    !Array.isArray(descriptor.tiers) ||
    descriptor.tiers.length !== 2 ||
    descriptor.tiers[0] !== 'shell' ||
    descriptor.tiers[1] !== 'view'
  ) {
    throw new Error('First-view pack tiers must be the exact shell + view roster.');
  }
  return Object.freeze({
    format: PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_FORMAT_V1,
    relativePath,
    sha256,
    byteLength,
    bundleManifestSha256: requireSha256(
      descriptor.bundleManifestSha256,
      'first-view pack descriptor.bundleManifestSha256'
    ),
    bundleFingerprint: requireSha256(
      descriptor.bundleFingerprint,
      'first-view pack descriptor.bundleFingerprint'
    ),
    tiers: PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_TIERS_V1,
    rosterSha256: requireSha256(descriptor.rosterSha256, 'first-view pack descriptor.rosterSha256'),
    memberCount,
    uncompressedByteLength,
  });
}

function parseHeader(value: unknown): FirstViewPackHeaderV1 {
  const header = requireRecord(value, 'first-view pack header');
  assertOnlyKeys(
    header,
    ['contract', 'bundleManifestSha256', 'bundleFingerprint', 'tiers', 'rosterSha256', 'members'],
    'first-view pack header'
  );
  if (header.contract !== PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_CONTRACT_V1) {
    throw new Error('First-view pack header contract is unsupported.');
  }
  if (
    !Array.isArray(header.tiers) ||
    header.tiers.length !== 2 ||
    header.tiers[0] !== 'shell' ||
    header.tiers[1] !== 'view'
  ) {
    throw new Error('First-view pack header tiers are invalid.');
  }
  if (
    !Array.isArray(header.members) ||
    header.members.length <= 0 ||
    header.members.length > MAX_FIRST_VIEW_PACK_MEMBERS_V1
  ) {
    throw new Error('First-view pack header member count is invalid.');
  }
  const seen = new Set<string>();
  const members = header.members.map((value, index) => {
    const member = requireRecord(value, `first-view pack header.members[${index}]`);
    assertOnlyKeys(
      member,
      ['id', 'sha256', 'byteLength'],
      `first-view pack header.members[${index}]`
    );
    const id = requireSafeId(member.id, `first-view pack header.members[${index}].id`);
    if (seen.has(id)) throw new Error(`First-view pack contains duplicate member "${id}".`);
    seen.add(id);
    return Object.freeze({
      id,
      sha256: requireSha256(member.sha256, `first-view pack header.members[${index}].sha256`),
      byteLength: requirePositiveInteger(
        member.byteLength,
        `first-view pack header.members[${index}].byteLength`
      ),
    });
  });
  return Object.freeze({
    contract: PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_CONTRACT_V1,
    bundleManifestSha256: requireSha256(
      header.bundleManifestSha256,
      'first-view pack header.bundleManifestSha256'
    ),
    bundleFingerprint: requireSha256(
      header.bundleFingerprint,
      'first-view pack header.bundleFingerprint'
    ),
    tiers: PORTABLE_PREPARED_REFERENCE_FIRST_VIEW_PACK_TIERS_V1,
    rosterSha256: requireSha256(header.rosterSha256, 'first-view pack header.rosterSha256'),
    members: Object.freeze(members),
  });
}

function assertHeaderAdmission(input: {
  readonly header: FirstViewPackHeaderV1;
  readonly descriptor: HostedReferenceFirstViewPackAssetV1;
  readonly bundleManifestSha256: string;
  readonly bundleFingerprint: string;
  readonly identities: readonly FirstViewPackMemberIdentityV1[];
}): void {
  if (
    input.header.bundleManifestSha256 !== input.bundleManifestSha256 ||
    input.header.bundleManifestSha256 !== input.descriptor.bundleManifestSha256 ||
    input.header.bundleFingerprint !== input.bundleFingerprint ||
    input.header.bundleFingerprint !== input.descriptor.bundleFingerprint ||
    input.header.rosterSha256 !== input.descriptor.rosterSha256 ||
    input.header.members.length !== input.descriptor.memberCount
  ) {
    throw new Error('First-view pack header does not match its admitted descriptor.');
  }
  for (const [index, expected] of input.identities.entries()) {
    const member = input.header.members[index];
    if (
      !member ||
      member.id !== expected.id ||
      member.sha256 !== expected.sha256 ||
      member.byteLength !== expected.byteLength
    ) {
      throw new Error('First-view pack has an unknown, missing, or reordered member.');
    }
  }
  if (
    portablePreparedReferenceFirstViewRosterSha256V1(input.header.members) !==
    input.header.rosterSha256
  ) {
    throw new Error('First-view pack header roster checksum is invalid.');
  }
}

function verifyMemberBytes(object: PortablePreparedReferenceObjectV1, bytes: Uint8Array): void {
  if (bytes.byteLength !== object.byteLength) {
    throw new Error(`First-view pack member "${object.id}" byte length does not match.`);
  }
  if (sha256Bytes(bytes) !== object.sha256) {
    throw new Error(`First-view pack member "${object.id}" checksum does not match.`);
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const expected = [...keys].sort().join(',');
  if (Object.keys(value).sort().join(',') !== expected) {
    throw new Error(`${label} fields are invalid.`);
  }
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireSafeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || value === '.' || value === '..') {
    throw new Error(`${label} is not a safe logical ID.`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be text.`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value as number;
}
