import { canonicalize } from './canonical-json';
import { hashCanonicalRecord } from './hash';
import type { CanonicalJson, ResourcePath, ResourceStateHash, Result } from './identity';
import { brandValidated } from './identity';
import type { BlobRef } from './hash';
import { parseResourcePath, pathCollisionKey } from './path';
import type { CanonicalMap, ResourceMemberInput, ResourceState, ResourceStateInput } from './types';
import { isCanonicalRecordWithinByteLimit } from './record-budgets';
import { isValidCanonicalText } from './unicode';

export type ResourceStateError =
  | { readonly kind: 'invalid-field'; readonly field: string }
  | { readonly kind: 'invalid-blob' }
  | { readonly kind: 'duplicate-member-id'; readonly memberId: string }
  | {
      readonly kind: 'member-path-conflict';
      readonly paths: readonly [ResourcePath, ResourcePath];
    }
  | { readonly kind: 'invalid-material-metadata' };

export interface ResourceMemberRecord {
  readonly memberId: ResourceMemberInput['memberId'];
  readonly relativePath: ResourcePath;
  readonly mediaType: string;
  readonly blob: BlobRef;
  readonly materialMetadata?: CanonicalMap;
}

export type ResourceStateRecord =
  | {
      readonly hash: ResourceStateHash;
      readonly canonicalJson: CanonicalJson;
      readonly layout: 'file';
      readonly resourceKind: string;
      readonly mediaType: string;
      readonly blob: BlobRef;
      readonly materialMetadata?: CanonicalMap;
    }
  | {
      readonly hash: ResourceStateHash;
      readonly canonicalJson: CanonicalJson;
      readonly layout: 'directory';
      readonly resourceKind: string;
      readonly format: string;
      readonly members: readonly ResourceMemberRecord[];
      readonly materialMetadata?: CanonicalMap;
    };

const resourceStateRecords = new WeakMap<Readonly<object>, ResourceStateRecord>();

export function defineResourceState(
  input: ResourceStateInput
): Result<ResourceState, ResourceStateError> {
  const commonError = validateTextField(input.resourceKind, 'resourceKind');
  if (commonError) return { ok: false, error: commonError };
  if (!isCanonicalMap(input.materialMetadata)) {
    return { ok: false, error: { kind: 'invalid-material-metadata' } };
  }

  if (input.layout === 'file') {
    const mediaTypeError = validateTextField(input.mediaType, 'mediaType');
    if (mediaTypeError) return { ok: false, error: mediaTypeError };
    if (!isBlobRef(input.blob)) return { ok: false, error: { kind: 'invalid-blob' } };
    return defineValidatedState({
      layout: 'file',
      resourceKind: input.resourceKind,
      mediaType: input.mediaType,
      blob: normalizeBlobRef(input.blob),
      ...(input.materialMetadata === undefined ? {} : { materialMetadata: input.materialMetadata }),
    });
  }

  const formatError = validateTextField(input.format, 'format');
  if (formatError) return { ok: false, error: formatError };
  const members = validateAndSortMembers(input.members);
  if (!members.ok) return members;
  return defineValidatedState({
    layout: 'directory',
    resourceKind: input.resourceKind,
    format: input.format,
    members: members.value,
    ...(input.materialMetadata === undefined ? {} : { materialMetadata: input.materialMetadata }),
  });
}

export function getResourceStateRecord(state: ResourceState): ResourceStateRecord | undefined {
  return resourceStateRecords.get(state);
}

function defineValidatedState(
  body:
    | Omit<Extract<ResourceStateRecord, { readonly layout: 'file' }>, 'hash' | 'canonicalJson'>
    | Omit<Extract<ResourceStateRecord, { readonly layout: 'directory' }>, 'hash' | 'canonicalJson'>
): Result<ResourceState, ResourceStateError> {
  const canonical = canonicalize({ formatVersion: 1, ...body });
  if (!canonical.ok || !isCanonicalRecordWithinByteLimit('resource-state', canonical.value)) {
    return { ok: false, error: { kind: 'invalid-material-metadata' } };
  }
  const record = Object.freeze({
    ...body,
    hash: hashCanonicalRecord('resource-state', canonical.value),
    canonicalJson: canonical.value,
  }) as ResourceStateRecord;
  const state = brandValidated<Readonly<object>, 'ResourceState'>(
    Object.freeze({ hash: record.hash })
  );
  resourceStateRecords.set(state, record);
  return { ok: true, value: state };
}

function validateAndSortMembers(
  input: readonly ResourceMemberInput[]
): Result<readonly ResourceMemberRecord[], ResourceStateError> {
  const seenIds = new Set<string>();
  const records: ResourceMemberRecord[] = [];
  for (const member of input) {
    if (seenIds.has(member.memberId)) {
      return {
        ok: false,
        error: { kind: 'duplicate-member-id', memberId: member.memberId },
      };
    }
    seenIds.add(member.memberId);
    const relativePath = parseResourcePath(member.relativePath);
    if (!relativePath.ok) {
      return { ok: false, error: { kind: 'invalid-field', field: 'members.relativePath' } };
    }
    const mediaTypeError = validateTextField(member.mediaType, 'members.mediaType');
    if (mediaTypeError) return { ok: false, error: mediaTypeError };
    if (!isBlobRef(member.blob)) return { ok: false, error: { kind: 'invalid-blob' } };
    if (!isCanonicalMap(member.materialMetadata)) {
      return { ok: false, error: { kind: 'invalid-material-metadata' } };
    }
    records.push(
      Object.freeze({
        memberId: member.memberId,
        relativePath: relativePath.value,
        mediaType: member.mediaType,
        blob: normalizeBlobRef(member.blob),
        ...(member.materialMetadata === undefined
          ? {}
          : { materialMetadata: member.materialMetadata }),
      })
    );
  }

  const keyedPaths = records
    .map((record) => ({ record, key: pathCollisionKey(record.relativePath) }))
    .sort((left, right) => deterministicCompare(left.key, right.key));
  const firstByPathKey = new Map<string, ResourceMemberRecord>();
  for (const candidate of keyedPaths) {
    const exact = firstByPathKey.get(candidate.key);
    if (exact) {
      return {
        ok: false,
        error: {
          kind: 'member-path-conflict',
          paths: [exact.relativePath, candidate.record.relativePath],
        },
      };
    }
    let separatorIndex = candidate.key.indexOf('/');
    while (separatorIndex >= 0) {
      const ancestor = firstByPathKey.get(candidate.key.slice(0, separatorIndex));
      if (ancestor) {
        return {
          ok: false,
          error: {
            kind: 'member-path-conflict',
            paths: [ancestor.relativePath, candidate.record.relativePath],
          },
        };
      }
      separatorIndex = candidate.key.indexOf('/', separatorIndex + 1);
    }
    firstByPathKey.set(candidate.key, candidate.record);
  }

  return {
    ok: true,
    value: Object.freeze(
      [...records].sort((left, right) => {
        const idOrder = deterministicCompare(left.memberId, right.memberId);
        return idOrder === 0
          ? deterministicCompare(left.relativePath, right.relativePath)
          : idOrder;
      })
    ),
  };
}

function validateTextField(value: string, field: string): ResourceStateError | null {
  if (!isValidCanonicalText(value)) {
    return { kind: 'invalid-field', field };
  }
  return null;
}

function isBlobRef(value: unknown): value is BlobRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    'hash' in value &&
    typeof value.hash === 'string' &&
    /^sha256:[0-9a-f]{64}$/u.test(value.hash) &&
    'byteLength' in value &&
    typeof value.byteLength === 'number' &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength >= 0
  );
}

function normalizeBlobRef(value: BlobRef): BlobRef {
  return Object.freeze({ hash: value.hash, byteLength: value.byteLength });
}

function isCanonicalMap(value: CanonicalMap | undefined): boolean {
  return value === undefined || canonicalize(value).ok;
}

function deterministicCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
