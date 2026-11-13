import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

import type {
  HostedReferenceFullTierShardAssetV1,
  HostedReferenceFullTierShardsAssetV1,
} from './hosted-reference-catalog';
import {
  portablePreparedReferenceContentObjectKeyV1,
  portablePreparedReferenceObjectsForTierV1,
  type PortablePreparedReferenceBundleV1,
  type PortablePreparedReferenceObjectV1,
} from './portable-prepared-reference-bundle';

export const PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARD_FORMAT_V1 =
  'dnaforge-portable-prepared-reference-full-tier-shard.br.v1' as const;
export const PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARD_CONTRACT_V1 =
  'dnaforge-portable-prepared-reference-full-tier-shard.v1' as const;
export const PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARDS_CONTRACT_V1 =
  'dnaforge-portable-prepared-reference-full-tier-shards.v1' as const;
export const PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARD_TIERS_V1 = ['detail', 'search'] as const;

export const MAX_FULL_TIER_SHARD_COMPRESSED_BYTES_V1 = 32 * 1024 * 1024;
export const MAX_FULL_TIER_SHARD_UNCOMPRESSED_BYTES_V1 = 32 * 1024 * 1024;
export const MAX_FULL_TIER_SHARD_MEMBER_PAYLOAD_BYTES_V1 = 31 * 1024 * 1024;
export const MAX_FULL_TIER_SHARD_HEADER_BYTES_V1 = 512 * 1024;
export const MAX_FULL_TIER_SHARD_MEMBERS_V1 = 512;
export const MAX_FULL_TIER_SHARDS_V1 = 4_096;

const FRAME_MAGIC = Buffer.from('DF-FTS1\n', 'ascii');
const FRAME_LENGTH_BYTES = 8;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface FullTierShardMemberIdentityV1 {
  readonly id: string;
  readonly sha256: string;
  readonly byteLength: number;
}

interface FullTierShardHeaderV1 {
  readonly contract: typeof PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARD_CONTRACT_V1;
  readonly bundleManifestSha256: string;
  readonly bundleFingerprint: string;
  readonly shardIndex: number;
  readonly shardCount: number;
  readonly rosterSha256: string;
  readonly members: readonly FullTierShardMemberIdentityV1[];
}

export interface PortablePreparedReferenceFullTierShardPlanV1 {
  readonly roster: readonly PortablePreparedReferenceObjectV1[];
  readonly rosterSha256: string;
  readonly shards: readonly Readonly<{
    shardIndex: number;
    objects: readonly PortablePreparedReferenceObjectV1[];
  }>[];
  readonly individualObjects: readonly PortablePreparedReferenceObjectV1[];
}

export interface BuiltPortablePreparedReferenceFullTierShardV1 {
  readonly bytes: Buffer;
  readonly descriptor: HostedReferenceFullTierShardAssetV1;
}

export interface ParsedPortablePreparedReferenceFullTierShardMemberV1 {
  readonly object: PortablePreparedReferenceObjectV1;
  readonly bytes: Buffer;
}

export function portablePreparedReferenceFullTierShardPlanV1(
  bundle: PortablePreparedReferenceBundleV1
): PortablePreparedReferenceFullTierShardPlanV1 {
  const viewObjectIds = new Set(
    portablePreparedReferenceObjectsForTierV1(bundle, 'view').map(({ id }) => id)
  );
  const seen = new Set<string>();
  const roster: PortablePreparedReferenceObjectV1[] = [];
  for (const tier of PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARD_TIERS_V1) {
    for (const object of portablePreparedReferenceObjectsForTierV1(bundle, tier)) {
      if (viewObjectIds.has(object.id) || seen.has(object.id)) continue;
      seen.add(object.id);
      roster.push(object);
    }
  }
  if (roster.length === 0) {
    throw new Error('Full-tier shard roster must contain detail or search objects.');
  }

  const shards: Array<{
    shardIndex: number;
    objects: readonly PortablePreparedReferenceObjectV1[];
  }> = [];
  const individualObjects: PortablePreparedReferenceObjectV1[] = [];
  let pending: PortablePreparedReferenceObjectV1[] = [];
  let pendingBytes = 0;
  const flush = (): void => {
    if (pending.length === 0) return;
    shards.push(
      Object.freeze({
        shardIndex: shards.length,
        objects: Object.freeze(pending),
      })
    );
    pending = [];
    pendingBytes = 0;
  };

  for (const object of roster) {
    const framedBytes = object.byteLength + FRAME_LENGTH_BYTES;
    if (framedBytes > MAX_FULL_TIER_SHARD_MEMBER_PAYLOAD_BYTES_V1) {
      flush();
      individualObjects.push(object);
      continue;
    }
    if (
      pending.length >= MAX_FULL_TIER_SHARD_MEMBERS_V1 ||
      pendingBytes + framedBytes > MAX_FULL_TIER_SHARD_MEMBER_PAYLOAD_BYTES_V1
    ) {
      flush();
    }
    pending.push(object);
    pendingBytes += framedBytes;
  }
  flush();
  if (shards.length > MAX_FULL_TIER_SHARDS_V1) {
    throw new Error('Full-tier shard count exceeds its admitted bound.');
  }
  return Object.freeze({
    roster: Object.freeze(roster),
    rosterSha256: rosterSha256(roster.map(memberIdentity)),
    shards: Object.freeze(shards),
    individualObjects: Object.freeze(individualObjects),
  });
}

export function buildPortablePreparedReferenceFullTierShardV1(input: {
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly shardIndex: number;
  readonly memberBytes: ReadonlyMap<string, Uint8Array>;
}): BuiltPortablePreparedReferenceFullTierShardV1 {
  requireSha256(input.bundleManifestSha256, 'full-tier shard bundle manifest SHA-256');
  const plan = portablePreparedReferenceFullTierShardPlanV1(input.bundle);
  const planned = plan.shards[input.shardIndex];
  if (!planned) throw new Error(`Full-tier shard index ${input.shardIndex} is unavailable.`);
  const identities = planned.objects.map(memberIdentity);
  const shardRosterSha256 = rosterSha256(identities);
  const header: FullTierShardHeaderV1 = {
    contract: PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARD_CONTRACT_V1,
    bundleManifestSha256: input.bundleManifestSha256,
    bundleFingerprint: input.bundle.bundleFingerprint,
    shardIndex: planned.shardIndex,
    shardCount: plan.shards.length,
    rosterSha256: shardRosterSha256,
    members: identities,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  if (headerBytes.byteLength > MAX_FULL_TIER_SHARD_HEADER_BYTES_V1) {
    throw new Error('Full-tier shard header exceeds its bounded byte length.');
  }
  const headerLength = Buffer.allocUnsafe(4);
  headerLength.writeUInt32BE(headerBytes.byteLength);
  const chunks: Buffer[] = [FRAME_MAGIC, headerLength, headerBytes];
  let uncompressedByteLength =
    FRAME_MAGIC.byteLength + headerLength.byteLength + headerBytes.byteLength;
  for (const object of planned.objects) {
    const source = input.memberBytes.get(object.id);
    if (!source) throw new Error(`Full-tier shard member "${object.id}" has no bytes.`);
    const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    verifyMemberBytes(object, bytes);
    const length = Buffer.allocUnsafe(FRAME_LENGTH_BYTES);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    chunks.push(length, bytes);
    uncompressedByteLength += length.byteLength + bytes.byteLength;
  }
  if (uncompressedByteLength > MAX_FULL_TIER_SHARD_UNCOMPRESSED_BYTES_V1) {
    throw new Error('Full-tier shard exceeds its bounded uncompressed byte length.');
  }
  const frame = Buffer.concat(chunks, uncompressedByteLength);
  const bytes = brotliCompressSync(frame, {
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
      [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: frame.byteLength,
    },
  });
  if (bytes.byteLength > MAX_FULL_TIER_SHARD_COMPRESSED_BYTES_V1) {
    throw new Error('Full-tier shard exceeds its bounded compressed byte length.');
  }
  const sha256 = sha256Bytes(bytes);
  return Object.freeze({
    bytes,
    descriptor: Object.freeze({
      format: PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARD_FORMAT_V1,
      relativePath: portablePreparedReferenceContentObjectKeyV1(sha256),
      sha256,
      byteLength: bytes.byteLength,
      bundleManifestSha256: input.bundleManifestSha256,
      bundleFingerprint: input.bundle.bundleFingerprint,
      shardIndex: planned.shardIndex,
      shardCount: plan.shards.length,
      rosterSha256: shardRosterSha256,
      memberCount: planned.objects.length,
      uncompressedByteLength,
    }),
  });
}

export function buildPortablePreparedReferenceFullTierShardsDescriptorV1(input: {
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly shards: readonly HostedReferenceFullTierShardAssetV1[];
}): HostedReferenceFullTierShardsAssetV1 {
  const plan = portablePreparedReferenceFullTierShardPlanV1(input.bundle);
  return admitPortablePreparedReferenceFullTierShardsDescriptorV1({
    descriptor: {
      contract: PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARDS_CONTRACT_V1,
      bundleManifestSha256: input.bundleManifestSha256,
      bundleFingerprint: input.bundle.bundleFingerprint,
      tiers: PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARD_TIERS_V1,
      rosterSha256: plan.rosterSha256,
      memberCount: plan.roster.length,
      individualObjectIds: plan.individualObjects.map(({ id }) => id),
      shards: input.shards,
    },
    bundleManifestSha256: input.bundleManifestSha256,
    bundle: input.bundle,
  });
}

export function admitPortablePreparedReferenceFullTierShardsDescriptorV1(input: {
  readonly descriptor: HostedReferenceFullTierShardsAssetV1;
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
}): HostedReferenceFullTierShardsAssetV1 {
  const descriptor = parseCollectionDescriptor(input.descriptor);
  if (
    descriptor.bundleManifestSha256 !== input.bundleManifestSha256 ||
    descriptor.bundleFingerprint !== input.bundle.bundleFingerprint
  ) {
    throw new Error('Full-tier shards do not bind the exact admitted bundle.');
  }
  const plan = portablePreparedReferenceFullTierShardPlanV1(input.bundle);
  if (
    descriptor.rosterSha256 !== plan.rosterSha256 ||
    descriptor.memberCount !== plan.roster.length
  ) {
    throw new Error('Full-tier shard collection roster does not match the admitted bundle.');
  }
  const expectedIndividuals = plan.individualObjects.map(({ id }) => id);
  if (!sameStrings(descriptor.individualObjectIds, expectedIndividuals)) {
    throw new Error('Full-tier shard individual-object fallback roster is invalid.');
  }
  if (descriptor.shards.length !== plan.shards.length) {
    throw new Error('Full-tier shard collection count does not match its deterministic plan.');
  }
  for (const [index, shard] of descriptor.shards.entries()) {
    const planned = plan.shards[index]!;
    const expectedRosterSha256 = rosterSha256(planned.objects.map(memberIdentity));
    if (
      shard.bundleManifestSha256 !== input.bundleManifestSha256 ||
      shard.bundleFingerprint !== input.bundle.bundleFingerprint ||
      shard.shardIndex !== index ||
      shard.shardCount !== plan.shards.length ||
      shard.memberCount !== planned.objects.length ||
      shard.rosterSha256 !== expectedRosterSha256
    ) {
      throw new Error(`Full-tier shard ${index} does not match its deterministic member roster.`);
    }
  }
  return descriptor;
}

export function parsePortablePreparedReferenceFullTierShardV1(input: {
  readonly collection: HostedReferenceFullTierShardsAssetV1;
  readonly descriptor: HostedReferenceFullTierShardAssetV1;
  readonly bundleManifestSha256: string;
  readonly bundle: PortablePreparedReferenceBundleV1;
  readonly shardBytes: Uint8Array;
}): readonly ParsedPortablePreparedReferenceFullTierShardMemberV1[] {
  const collection = admitPortablePreparedReferenceFullTierShardsDescriptorV1({
    descriptor: input.collection,
    bundleManifestSha256: input.bundleManifestSha256,
    bundle: input.bundle,
  });
  const descriptor = collection.shards[input.descriptor.shardIndex];
  if (!descriptor || !sameShardDescriptor(descriptor, input.descriptor)) {
    throw new Error('Full-tier shard descriptor is not in its admitted collection.');
  }
  const shardBytes = Buffer.from(
    input.shardBytes.buffer,
    input.shardBytes.byteOffset,
    input.shardBytes.byteLength
  );
  if (shardBytes.byteLength !== descriptor.byteLength) {
    throw new Error('Full-tier shard byte length does not match its catalog descriptor.');
  }
  if (sha256Bytes(shardBytes) !== descriptor.sha256) {
    throw new Error('Full-tier shard checksum does not match its catalog descriptor.');
  }
  let frame: Buffer;
  try {
    frame = brotliDecompressSync(shardBytes, {
      maxOutputLength: descriptor.uncompressedByteLength,
    });
  } catch {
    throw new Error('Full-tier shard Brotli frame could not be expanded within its bound.');
  }
  if (frame.byteLength !== descriptor.uncompressedByteLength) {
    throw new Error('Full-tier shard expanded byte length does not match its descriptor.');
  }
  if (
    frame.byteLength < FRAME_MAGIC.byteLength + 4 ||
    !frame.subarray(0, FRAME_MAGIC.byteLength).equals(FRAME_MAGIC)
  ) {
    throw new Error('Full-tier shard frame magic is invalid.');
  }
  const headerLength = frame.readUInt32BE(FRAME_MAGIC.byteLength);
  if (headerLength <= 0 || headerLength > MAX_FULL_TIER_SHARD_HEADER_BYTES_V1) {
    throw new Error('Full-tier shard header length is invalid.');
  }
  let cursor = FRAME_MAGIC.byteLength + 4;
  const headerEnd = cursor + headerLength;
  if (headerEnd > frame.byteLength) throw new Error('Full-tier shard header is truncated.');
  let headerValue: unknown;
  try {
    headerValue = JSON.parse(frame.subarray(cursor, headerEnd).toString('utf8')) as unknown;
  } catch {
    throw new Error('Full-tier shard header is not valid JSON.');
  }
  const header = parseHeader(headerValue);
  cursor = headerEnd;

  const plan = portablePreparedReferenceFullTierShardPlanV1(input.bundle);
  const planned = plan.shards[descriptor.shardIndex]!;
  const identities = planned.objects.map(memberIdentity);
  assertHeaderAdmission({
    header,
    descriptor,
    bundleManifestSha256: input.bundleManifestSha256,
    bundleFingerprint: input.bundle.bundleFingerprint,
    identities,
  });

  const parsed: ParsedPortablePreparedReferenceFullTierShardMemberV1[] = [];
  for (const [index, object] of planned.objects.entries()) {
    if (cursor + FRAME_LENGTH_BYTES > frame.byteLength) {
      throw new Error(`Full-tier shard member "${object.id}" length frame is truncated.`);
    }
    const framedLength = frame.readBigUInt64BE(cursor);
    cursor += FRAME_LENGTH_BYTES;
    if (framedLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Full-tier shard member "${object.id}" length is unsafe.`);
    }
    if (Number(framedLength) !== object.byteLength) {
      throw new Error(`Full-tier shard member "${object.id}" length frame does not match.`);
    }
    const end = cursor + object.byteLength;
    if (end > frame.byteLength) {
      throw new Error(`Full-tier shard member "${object.id}" bytes are truncated.`);
    }
    const bytes = frame.subarray(cursor, end);
    cursor = end;
    verifyMemberBytes(object, bytes);
    if (header.members[index]?.id !== object.id) {
      throw new Error('Full-tier shard member order does not match its header.');
    }
    parsed.push(Object.freeze({ object, bytes }));
  }
  if (cursor !== frame.byteLength) {
    throw new Error('Full-tier shard has trailing or unknown member bytes.');
  }
  return Object.freeze(parsed);
}

function parseCollectionDescriptor(
  value: HostedReferenceFullTierShardsAssetV1
): HostedReferenceFullTierShardsAssetV1 {
  const descriptor = requireRecord(value, 'full-tier shard collection descriptor');
  assertOnlyKeys(
    descriptor,
    [
      'contract',
      'bundleManifestSha256',
      'bundleFingerprint',
      'tiers',
      'rosterSha256',
      'memberCount',
      'individualObjectIds',
      'shards',
    ],
    'full-tier shard collection descriptor'
  );
  if (descriptor.contract !== PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARDS_CONTRACT_V1) {
    throw new Error('Full-tier shard collection contract is unsupported.');
  }
  if (
    !Array.isArray(descriptor.tiers) ||
    descriptor.tiers.length !== 2 ||
    descriptor.tiers[0] !== 'detail' ||
    descriptor.tiers[1] !== 'search'
  ) {
    throw new Error('Full-tier shard collection tiers are invalid.');
  }
  if (!Array.isArray(descriptor.individualObjectIds)) {
    throw new Error('Full-tier shard individual-object roster must be an array.');
  }
  const individualObjectIds = descriptor.individualObjectIds.map((id, index) =>
    requireSafeId(id, `full-tier shard individualObjectIds[${index}]`)
  );
  if (new Set(individualObjectIds).size !== individualObjectIds.length) {
    throw new Error('Full-tier shard individual-object roster contains duplicates.');
  }
  if (!Array.isArray(descriptor.shards) || descriptor.shards.length > MAX_FULL_TIER_SHARDS_V1) {
    throw new Error('Full-tier shard collection count is invalid.');
  }
  const shards = descriptor.shards.map((shard, index) => parseShardDescriptor(shard, index));
  return Object.freeze({
    contract: PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARDS_CONTRACT_V1,
    bundleManifestSha256: requireSha256(
      descriptor.bundleManifestSha256,
      'full-tier shard collection bundleManifestSha256'
    ),
    bundleFingerprint: requireSha256(
      descriptor.bundleFingerprint,
      'full-tier shard collection bundleFingerprint'
    ),
    tiers: PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARD_TIERS_V1,
    rosterSha256: requireSha256(descriptor.rosterSha256, 'full-tier shard collection rosterSha256'),
    memberCount: requirePositiveInteger(
      descriptor.memberCount,
      'full-tier shard collection memberCount'
    ),
    individualObjectIds: Object.freeze(individualObjectIds),
    shards: Object.freeze(shards),
  });
}

function parseShardDescriptor(value: unknown, index: number): HostedReferenceFullTierShardAssetV1 {
  const label = `full-tier shard descriptor[${index}]`;
  const descriptor = requireRecord(value, label);
  assertOnlyKeys(
    descriptor,
    [
      'format',
      'relativePath',
      'sha256',
      'byteLength',
      'bundleManifestSha256',
      'bundleFingerprint',
      'shardIndex',
      'shardCount',
      'rosterSha256',
      'memberCount',
      'uncompressedByteLength',
    ],
    label
  );
  if (descriptor.format !== PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARD_FORMAT_V1) {
    throw new Error(`${label} format is unsupported.`);
  }
  const sha256 = requireSha256(descriptor.sha256, `${label}.sha256`);
  const relativePath = requireText(descriptor.relativePath, `${label}.relativePath`);
  if (relativePath !== portablePreparedReferenceContentObjectKeyV1(sha256)) {
    throw new Error(`${label} is not at its canonical content-addressed key.`);
  }
  const byteLength = requirePositiveInteger(descriptor.byteLength, `${label}.byteLength`);
  if (byteLength > MAX_FULL_TIER_SHARD_COMPRESSED_BYTES_V1) {
    throw new Error(`${label} compressed byte length exceeds its bound.`);
  }
  const memberCount = requirePositiveInteger(descriptor.memberCount, `${label}.memberCount`);
  if (memberCount > MAX_FULL_TIER_SHARD_MEMBERS_V1) {
    throw new Error(`${label} member count exceeds its bound.`);
  }
  const uncompressedByteLength = requirePositiveInteger(
    descriptor.uncompressedByteLength,
    `${label}.uncompressedByteLength`
  );
  if (uncompressedByteLength > MAX_FULL_TIER_SHARD_UNCOMPRESSED_BYTES_V1) {
    throw new Error(`${label} expanded byte length exceeds its bound.`);
  }
  return Object.freeze({
    format: PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARD_FORMAT_V1,
    relativePath,
    sha256,
    byteLength,
    bundleManifestSha256: requireSha256(
      descriptor.bundleManifestSha256,
      `${label}.bundleManifestSha256`
    ),
    bundleFingerprint: requireSha256(descriptor.bundleFingerprint, `${label}.bundleFingerprint`),
    shardIndex: requireNonNegativeInteger(descriptor.shardIndex, `${label}.shardIndex`),
    shardCount: requirePositiveInteger(descriptor.shardCount, `${label}.shardCount`),
    rosterSha256: requireSha256(descriptor.rosterSha256, `${label}.rosterSha256`),
    memberCount,
    uncompressedByteLength,
  });
}

function parseHeader(value: unknown): FullTierShardHeaderV1 {
  const header = requireRecord(value, 'full-tier shard header');
  assertOnlyKeys(
    header,
    [
      'contract',
      'bundleManifestSha256',
      'bundleFingerprint',
      'shardIndex',
      'shardCount',
      'rosterSha256',
      'members',
    ],
    'full-tier shard header'
  );
  if (header.contract !== PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARD_CONTRACT_V1) {
    throw new Error('Full-tier shard header contract is unsupported.');
  }
  if (
    !Array.isArray(header.members) ||
    header.members.length === 0 ||
    header.members.length > MAX_FULL_TIER_SHARD_MEMBERS_V1
  ) {
    throw new Error('Full-tier shard header member count is invalid.');
  }
  const seen = new Set<string>();
  const members = header.members.map((value, index) => {
    const member = requireRecord(value, `full-tier shard header.members[${index}]`);
    assertOnlyKeys(
      member,
      ['id', 'sha256', 'byteLength'],
      `full-tier shard header.members[${index}]`
    );
    const id = requireSafeId(member.id, `full-tier shard header.members[${index}].id`);
    if (seen.has(id)) throw new Error(`Full-tier shard contains duplicate member "${id}".`);
    seen.add(id);
    return Object.freeze({
      id,
      sha256: requireSha256(member.sha256, `full-tier shard header.members[${index}].sha256`),
      byteLength: requirePositiveInteger(
        member.byteLength,
        `full-tier shard header.members[${index}].byteLength`
      ),
    });
  });
  return Object.freeze({
    contract: PORTABLE_PREPARED_REFERENCE_FULL_TIER_SHARD_CONTRACT_V1,
    bundleManifestSha256: requireSha256(
      header.bundleManifestSha256,
      'full-tier shard header.bundleManifestSha256'
    ),
    bundleFingerprint: requireSha256(
      header.bundleFingerprint,
      'full-tier shard header.bundleFingerprint'
    ),
    shardIndex: requireNonNegativeInteger(header.shardIndex, 'full-tier shard header.shardIndex'),
    shardCount: requirePositiveInteger(header.shardCount, 'full-tier shard header.shardCount'),
    rosterSha256: requireSha256(header.rosterSha256, 'full-tier shard header.rosterSha256'),
    members: Object.freeze(members),
  });
}

function assertHeaderAdmission(input: {
  readonly header: FullTierShardHeaderV1;
  readonly descriptor: HostedReferenceFullTierShardAssetV1;
  readonly bundleManifestSha256: string;
  readonly bundleFingerprint: string;
  readonly identities: readonly FullTierShardMemberIdentityV1[];
}): void {
  if (
    input.header.bundleManifestSha256 !== input.bundleManifestSha256 ||
    input.header.bundleManifestSha256 !== input.descriptor.bundleManifestSha256 ||
    input.header.bundleFingerprint !== input.bundleFingerprint ||
    input.header.bundleFingerprint !== input.descriptor.bundleFingerprint ||
    input.header.shardIndex !== input.descriptor.shardIndex ||
    input.header.shardCount !== input.descriptor.shardCount ||
    input.header.rosterSha256 !== input.descriptor.rosterSha256 ||
    input.header.members.length !== input.descriptor.memberCount
  ) {
    throw new Error('Full-tier shard header does not match its admitted descriptor.');
  }
  for (const [index, expected] of input.identities.entries()) {
    const member = input.header.members[index];
    if (
      !member ||
      member.id !== expected.id ||
      member.sha256 !== expected.sha256 ||
      member.byteLength !== expected.byteLength
    ) {
      throw new Error('Full-tier shard has an unknown, missing, or reordered member.');
    }
  }
  if (rosterSha256(input.header.members) !== input.header.rosterSha256) {
    throw new Error('Full-tier shard header roster checksum is invalid.');
  }
}

function memberIdentity(object: PortablePreparedReferenceObjectV1): FullTierShardMemberIdentityV1 {
  return { id: object.id, sha256: object.sha256, byteLength: object.byteLength };
}

function rosterSha256(members: readonly FullTierShardMemberIdentityV1[]): string {
  return createHash('sha256').update(JSON.stringify(members)).digest('hex');
}

function verifyMemberBytes(object: PortablePreparedReferenceObjectV1, bytes: Uint8Array): void {
  if (bytes.byteLength !== object.byteLength) {
    throw new Error(`Full-tier shard member "${object.id}" byte length does not match.`);
  }
  if (sha256Bytes(bytes) !== object.sha256) {
    throw new Error(`Full-tier shard member "${object.id}" checksum does not match.`);
  }
}

function sameShardDescriptor(
  left: HostedReferenceFullTierShardAssetV1,
  right: HostedReferenceFullTierShardAssetV1
): boolean {
  return (
    left.format === right.format &&
    left.relativePath === right.relativePath &&
    left.sha256 === right.sha256 &&
    left.byteLength === right.byteLength &&
    left.bundleManifestSha256 === right.bundleManifestSha256 &&
    left.bundleFingerprint === right.bundleFingerprint &&
    left.shardIndex === right.shardIndex &&
    left.shardCount === right.shardCount &&
    left.rosterSha256 === right.rosterSha256 &&
    left.memberCount === right.memberCount &&
    left.uncompressedByteLength === right.uncompressedByteLength
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
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
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be text.`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
}
